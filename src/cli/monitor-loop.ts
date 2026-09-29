/**
 * Continuously collect monitoring snapshots at a fixed interval.
 * Read-only with respect to the chain: signing/attestation is a separate,
 * explicit step (see submit-attestation.ts).
 */
import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig } from "../config.ts";
import { collectSnapshot } from "../monitor.ts";
import { appendSnapshot } from "../store.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const intervalMs = Number.parseInt(process.env.MONITOR_INTERVAL_MS ?? "60000", 10);
  if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
    console.error("MONITOR_INTERVAL_MS must be an integer >= 1000");
    process.exit(1);
  }
  console.log(`monitoring ${config.network.name} every ${intervalMs}ms -> ${config.stateFile}`);

  // One signal stops the loop cleanly.
  let stopping = false;
  process.on("SIGINT", () => {
    stopping = true;
    console.log("\nstopping after current iteration...");
  });

  while (!stopping) {
    const started = Date.now();
    try {
      const snapshot = await collectSnapshot(config);
      await appendSnapshot(config.stateFile, snapshot);
      const bad = snapshot.samples.filter(
        (s) => s.status === "critical" || s.status === "warning" || s.status === "stale",
      );
      const flag = bad.length > 0 ? `ALERT ${bad.map((b) => b.pair + ":" + b.status).join(" ")}` : "ok";
      console.log(`${snapshot.collectedAt} block=${snapshot.block} ${flag}`);
    } catch (e) {
      console.error(`iteration failed: ${(e as Error).message}`);
    }
    const elapsed = Date.now() - started;
    await sleep(Math.max(0, intervalMs - elapsed));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
