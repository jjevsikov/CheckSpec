/**
 * @checkspec/server
 *
 * HTTP API server — exposes @checkspec/core over REST.
 *
 * Architecture principle: this server is intentionally thin.
 * ALL test logic lives in @checkspec/core. This file only handles:
 *  - HTTP request/response serialisation
 *  - Job queuing and result storage
 *
 * The same @checkspec/core engine powers the CLI, SDK, and this server.
 *
 * ## Endpoints
 *
 *  POST /api/v1/runs          Submit a collection for async execution
 *  GET  /api/v1/runs/:id      Poll for result
 *  GET  /api/v1/runs/:id/html Download HTML report
 *  POST /api/v1/generate      AI-generate a collection from a server spec
 *  GET  /api/v1/health        Liveness probe
 *
 * ## Running locally
 *
 *  npm run build && npm start
 *  curl http://localhost:4000/api/v1/health
 */

import express from "express";
import { randomUUID } from "crypto";
import type { RunSummary } from "@checkspec/core";

// ── In-memory job store (replace with Redis / PostgreSQL in production) ───────

interface Job {
  id: string;
  status: "pending" | "running" | "done" | "failed";
  createdAt: string;
  completedAt?: string;
  summary?: RunSummary;
  htmlReport?: string;
  error?: string;
}

const jobs = new Map<string, Job>();

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT ?? 4000);
const API_ROOT = "/api/v1";

// ── Health check ──────────────────────────────────────────────────────────────

app.get(`${API_ROOT}/health`, (_req, res) => {
  res.json({
    status: "ok",
    version: "0.1.0",
    uptime: Math.floor(process.uptime()),
  });
});

// ── Submit a test run ─────────────────────────────────────────────────────────

/**
 * POST /api/v1/runs
 *
 * Body: { collection: CheckSpecCollection }
 *
 * Returns: { id, status: "pending" }
 *
 * NOTE: The actual test execution is not implemented here yet — it requires
 * spawning a sandboxed child process per job (security boundary between
 * customer server processes). This is the correct architectural seam:
 * the HTTP handler validates and enqueues; a separate worker process
 * calls TestRunner.runCollection() and writes results back.
 *
 * See: docs/architecture.md § Cloud execution model
 */
app.post(`${API_ROOT}/runs`, (req, res) => {
  const { collection } = req.body as { collection?: unknown };

  if (!collection || typeof collection !== "object") {
    res.status(400).json({ error: "Request body must include a `collection` object." });
    return;
  }

  const id = randomUUID();
  const job: Job = {
    id,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  jobs.set(id, job);

  // TODO: push to job queue (Bull/BullMQ, pg_queue, or SQS)
  //   await queue.add("run", { id, collection });

  res.status(202).json({
    id,
    status: "pending",
    pollUrl: `${API_ROOT}/runs/${id}`,
  });
});

// ── Poll for result ───────────────────────────────────────────────────────────

app.get(`${API_ROOT}/runs/:id`, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: `Run "${req.params.id}" not found.` });
    return;
  }

  const response: Record<string, unknown> = {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
  };

  if (job.completedAt) response.completedAt = job.completedAt;
  if (job.summary) response.summary = job.summary;
  if (job.error) response.error = job.error;

  res.json(response);
});

// ── Download HTML report ──────────────────────────────────────────────────────

app.get(`${API_ROOT}/runs/:id/html`, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).send("Run not found.");
    return;
  }
  if (job.status !== "done" || !job.htmlReport) {
    res.status(409).send("Report not ready yet.");
    return;
  }
  res.setHeader("Content-Type", "text/html");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="checkspec-${req.params.id}.html"`
  );
  res.send(job.htmlReport);
});

// ── List recent runs ──────────────────────────────────────────────────────────

app.get(`${API_ROOT}/runs`, (_req, res) => {
  const list = [...jobs.values()]
    .map(({ id, status, createdAt, completedAt }) => ({
      id, status, createdAt, completedAt,
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 50);

  res.json({ runs: list, total: jobs.size });
});

// ── Start server ──────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`CheckSpec API server running on http://localhost:${PORT}`);
  console.log(`Health: http://localhost:${PORT}${API_ROOT}/health`);
  console.log(`\nThis server uses the same @checkspec/core engine as the CLI.`);
  console.log(`See packages/server/src/index.ts for the full architecture notes.`);
});

export { app };
