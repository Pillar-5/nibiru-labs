/**
 * Read-only HTTP API over the local snapshot store, for the dashboard.
 * Serves real collected data only; it never fabricates values.
 *
 * The server binds to localhost by default (API_HOST) and only echoes CORS
 * headers for local browser origins, because everything it serves is local
 * monitoring output for a local dashboard.
 */
import "dotenv/config";
import express from "express";
import cors from "cors";
import { loadConfig } from "../config.ts";
import { jsonReplacer, readSnapshots } from "../store.ts";
import { summarize } from "../analysis/integrity.ts";

const config = loadConfig();
const app = express();
app.use(
  cors({
    origin: [/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/],
  }),
);

/** Bigint-safe JSON response (snapshots carry bigint block numbers). */
function sendJson(res: express.Response, body: unknown): void {
  res.type("application/json").send(JSON.stringify(body, jsonReplacer));
}

app.get("/api/health", (_req, res) => {
  sendJson(res, { ok: true, network: config.network.name, chainId: config.network.chainId });
});

app.get("/api/status", async (_req, res) => {
  const snapshots = await readSnapshots(config.stateFile);
  const latest = snapshots[snapshots.length - 1];
  if (!latest) {
    sendJson(res, { snapshots: 0, latest: null, summary: null });
    return;
  }
  sendJson(res, {
    snapshots: snapshots.length,
    latest,
    summary: summarize(latest.samples, config.thresholds),
    thresholds: config.thresholds,
  });
});

app.get("/api/history", async (req, res) => {
  const limit = Number.parseInt(String(req.query.limit ?? "500"), 10);
  const pair = req.query.pair ? String(req.query.pair) : undefined;
  const snapshots = await readSnapshots(config.stateFile);
  const points = snapshots
    .flatMap((s) => s.samples.filter((x) => !pair || x.pair === pair).map((x) => ({
      collectedAt: s.collectedAt,
      block: s.block,
      pair: x.pair,
      oracleRate: x.oracleRate,
      referenceUsd: x.referenceUsd,
      deviationBps: x.deviationBps,
      oracleAgeSeconds: x.oracleAgeSeconds,
      status: x.status,
    })))
    .slice(-Math.max(1, Math.min(5000, Number.isFinite(limit) ? limit : 500)));
  sendJson(res, { points });
});

app.listen(config.apiPort, config.apiHost, () => {
  console.log(`api listening on http://${config.apiHost}:${config.apiPort} (store: ${config.stateFile})`);
});
