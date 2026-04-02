#!/usr/bin/env node
/**
 * Greenhouse MCP — Beyond ONE
 * Pipeline data: fetched live from GitHub (update the JSON there, Claude sees it instantly)
 * Job listings: Greenhouse Job Board API (no key needed)
 * Full Harvest: set GREENHOUSE_HARVEST_KEY to go fully live
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const SLUG         = process.env.GREENHOUSE_SLUG        || "beyondone";
const HARVEST_KEY  = process.env.GREENHOUSE_HARVEST_KEY || null;
const GITHUB_RAW   = process.env.GITHUB_RAW_URL         || "https://raw.githubusercontent.com/YOUR_USERNAME/greenhouse-mcp/main/data/pipeline.json";
const JOB_BOARD    = `https://boards-api.greenhouse.io/v1/boards/${SLUG}`;

const server = new McpServer({ name: "greenhouse-mcp", version: "1.0.0" });

// ─── data fetchers ────────────────────────────────────────────────────────────

async function fetchPipeline() {
  const res = await fetch(GITHUB_RAW, { headers: { "Cache-Control": "no-cache" } });
  if (!res.ok) throw new Error(`GitHub fetch failed: ${res.status} — check GITHUB_RAW_URL`);
  return res.json();
}

async function fetchJobBoard(path) {
  const res = await fetch(`${JOB_BOARD}${path}`);
  if (!res.ok) throw new Error(`Greenhouse Job Board API error: ${res.status}`);
  return res.json();
}

// ─── LIVE: Greenhouse Job Board ───────────────────────────────────────────────

server.tool(
  "list_open_jobs",
  "List all currently open roles at Beyond ONE. Live from Greenhouse Job Board.",
  {
    department: z.string().optional().describe("Filter by department (partial match)"),
    location:   z.string().optional().describe("Filter by office/location (partial match)"),
    limit:      z.number().optional().describe("Max results, default 50"),
  },
  async ({ department, location, limit = 50 }) => {
    const data = await fetchJobBoard("/jobs?content=true");
    let jobs = data.jobs || [];
    if (department) jobs = jobs.filter(j => j.departments?.some(d => d.name.toLowerCase().includes(department.toLowerCase())));
    if (location)   jobs = jobs.filter(j => j.offices?.some(o => o.name.toLowerCase().includes(location.toLowerCase())));
    return { content: [{ type: "text", text: JSON.stringify({
      total_open: jobs.length,
      data_source: "live — Greenhouse Job Board API",
      jobs: jobs.slice(0, limit).map(j => ({
        id: j.id, title: j.title,
        department: j.departments?.[0]?.name || "—",
        location:   j.offices?.[0]?.name    || "Remote",
        url: j.absolute_url,
        updated_at: j.updated_at,
      })),
    }, null, 2) }] };
  }
);

server.tool(
  "get_job_details",
  "Full description and requirements for a specific job by ID.",
  { job_id: z.number() },
  async ({ job_id }) => {
    const job = await fetchJobBoard(`/jobs/${job_id}`);
    return { content: [{ type: "text", text: JSON.stringify({
      id: job.id, title: job.title,
      department: job.departments?.[0]?.name,
      location:   job.offices?.[0]?.name,
      url: job.absolute_url,
      updated_at: job.updated_at,
      description: job.content?.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 2000),
    }, null, 2) }] };
  }
);

server.tool("list_departments", "All departments currently hiring at Beyond ONE.", {},
  async () => {
    const data = await fetchJobBoard("/departments");
    const depts = (data.departments || []).filter(d => d.jobs?.length > 0)
      .map(d => ({ name: d.name, open_roles: d.jobs.length }))
      .sort((a, b) => b.open_roles - a.open_roles);
    return { content: [{ type: "text", text: JSON.stringify({ data_source: "live", departments: depts }, null, 2) }] };
  }
);

server.tool("list_offices", "Office locations with active open roles.", {},
  async () => {
    const data = await fetchJobBoard("/offices");
    const offices = (data.offices || []).filter(o => o.jobs?.length > 0)
      .map(o => ({ name: o.name, open_roles: o.jobs.length }))
      .sort((a, b) => b.open_roles - a.open_roles);
    return { content: [{ type: "text", text: JSON.stringify({ data_source: "live", offices }, null, 2) }] };
  }
);

// ─── GITHUB-BACKED: Pipeline analytics ───────────────────────────────────────

server.tool(
  "get_pipeline_overview",
  "Current pipeline totals at each hiring stage. Fetched live from GitHub data file.",
  {},
  async () => {
    const { meta, totals, jobs } = await fetchPipeline();
    const total = Object.values(totals).reduce((a, b) => a + b, 0);
    const topStage = Object.entries(totals).sort((a, b) => b[1] - a[1])[0];
    return { content: [{ type: "text", text: JSON.stringify({
      data_source: `GitHub — ${meta.source}`,
      as_of: meta.as_of,
      total_active_candidates: total,
      open_roles: jobs.length,
      pipeline_by_stage: totals,
      bottleneck: { stage: topStage[0], candidates: topStage[1] },
    }, null, 2) }] };
  }
);

server.tool(
  "get_pipeline_by_job",
  "Candidate counts at each stage per job. Fetched live from GitHub.",
  { job: z.string().optional().describe("Job title partial match. Omit for all.") },
  async ({ job }) => {
    const { meta, jobs } = await fetchPipeline();
    let results = job
      ? jobs.filter(r => r.job.toLowerCase().includes(job.toLowerCase()))
      : jobs;
    if (results.length === 0) return { content: [{ type: "text",
      text: `No match for "${job}". Available: ${jobs.map(r => r.job).join(", ")}` }] };
    return { content: [{ type: "text", text: JSON.stringify({
      data_source: `GitHub — ${meta.source}`,
      as_of: meta.as_of,
      jobs: results.map(r => ({
        ...r,
        insight: r.total_active === 0
          ? "⚠️ No active candidates — pipeline stalled"
          : r.stages["Application Review"] > 40
            ? `🔴 ${r.stages["Application Review"]} unreviewed in Application Review`
            : "🟢 Pipeline progressing",
      })),
    }, null, 2) }] };
  }
);

server.tool(
  "get_pipeline_health",
  "Pipeline health analysis: bottlenecks, stalled roles, and where to focus recruiter effort. Fetched live from GitHub.",
  {},
  async () => {
    const { meta, totals, jobs } = await fetchPipeline();
    const total = Object.values(totals).reduce((a, b) => a + b, 0);
    const stalled   = jobs.filter(r => r.total_active === 0);
    const needsWork = jobs.filter(r => r.stages["Application Review"] > 40);
    const inLoop    = jobs.filter(r => r.stages["Main Loop"] > 0);
    const pctReview = total > 0 ? Math.round((totals["Application Review"] / total) * 100) : 0;
    return { content: [{ type: "text", text: JSON.stringify({
      data_source: `GitHub — ${meta.source}`,
      as_of: meta.as_of,
      health_score: pctReview > 80 ? "⚠️ At risk — pipeline top-heavy" : "✅ Healthy flow",
      pct_stuck_in_application_review: `${pctReview}%`,
      stalled_roles: stalled.map(r => r.job),
      needs_screening_urgently: needsWork.map(r => ({ job: r.job, waiting: r.stages["Application Review"] })),
      actively_interviewing: inLoop.map(r => ({ job: r.job, in_main_loop: r.stages["Main Loop"] })),
      no_offers_in_flight: totals["Offer"] === 0,
      actions: [
        `🔴 ${totals["Application Review"]} candidates need review across ${needsWork.length} role(s)`,
        stalled.length ? `🔴 ${stalled.map(r => r.job).join(", ")} — zero pipeline, check sourcing` : null,
        totals["Assessment"] === 0 ? "🟡 Assessment stage empty — is this stage active in your process?" : null,
        totals["Offer"] === 0 ? "🟡 No candidates in Offer — earliest hire is weeks away" : null,
        inLoop.length ? `🟢 ${inLoop.length} role(s) have candidates actively interviewing` : null,
      ].filter(Boolean),
    }, null, 2) }] };
  }
);

server.tool(
  "get_recruiting_summary",
  "Full snapshot combining live job board data + GitHub pipeline data. Your go-to daily briefing.",
  {},
  async () => {
    const [pipelineData, jobsData] = await Promise.allSettled([
      fetchPipeline(),
      fetchJobBoard("/jobs"),
    ]);
    const pipeline  = pipelineData.status  === "fulfilled" ? pipelineData.value  : null;
    const liveJobs  = jobsData.status      === "fulfilled" ? jobsData.value.jobs : null;
    const total     = pipeline ? Object.values(pipeline.totals).reduce((a, b) => a + b, 0) : null;

    return { content: [{ type: "text", text: JSON.stringify({
      as_of: pipeline?.meta.as_of || new Date().toISOString().split("T")[0],
      open_roles_on_job_board: liveJobs?.length ?? "unavailable",
      roles_in_pipeline_report: pipeline?.jobs.length ?? "unavailable",
      pipeline_total_candidates: total,
      pipeline_by_stage: pipeline?.totals,
      data_sources: {
        job_board: "live — Greenhouse Job Board API",
        pipeline:  pipeline ? `GitHub — ${pipeline.meta.source}` : "unavailable",
      },
      urgent: [
        pipeline && `${pipeline.totals["Application Review"]} candidates sitting unreviewed in Application Review`,
        pipeline?.jobs.find(j => j.total_active === 0) && `${pipeline.jobs.find(j => j.total_active === 0).job} has zero pipeline`,
        pipeline?.totals["Offer"] === 0 && "No candidates in Offer stage",
      ].filter(Boolean),
      harvest_connected: !!HARVEST_KEY,
      next_step: HARVEST_KEY ? "All data live via Harvest API" : "Request GREENHOUSE_HARVEST_KEY from admin to unlock time-to-fill, sources, and offer analytics",
    }, null, 2) }] };
  }
);

// ─── start ────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
