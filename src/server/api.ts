/**
 * Read-only HTTP API over the local snapshot store, for the dashboard.
 * Serves real collected data only; it never fabricates values.
 */
import "dotenv/config";
import express from "express";
import cors from "cors";
import { loadConfig } from "../config.ts";
import { readSnapshots } from "../store.ts";
import { summarize } from "../analysis/integrity.ts";

const config = loadConfig();
const app = express();
app.use(cors());

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, network: config.network.name, chainId: config.network.chainId });
});

app.get("/api/status", async (_req, res) => {
  const snapshots = await readSnapshots(config.stateFile);
  const latest = snapshots[snapshots.length - 1];
  if (!latest) {
    res.json({ snapshots: 0, latest: null, summary: null });
    return;
  }
  res.json({
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
  res.json({ points });
});

app.listen(config.apiPort, () => {
  console.log(`api listening on http://127.0.0.1:${config.apiPort} (store: ${config.stateFile})`);
});
