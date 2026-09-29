/**
 * Collect one monitoring snapshot: read the oracle, fetch reference prices,
 * analyze integrity, append to the local store, and print the report.
 */
import { loadConfig } from "../config.ts";
import { collectSnapshot } from "../monitor.ts";
import { appendSnapshot } from "../store.ts";
import { summarize } from "../analysis/integrity.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const snapshot = await collectSnapshot(config);

  console.log(`snapshot ${snapshot.collectedAt} network=${snapshot.network} block=${snapshot.block}`);
  for (const note of snapshot.notes) console.log(`note: ${note}`);
  console.log("pair         status      oracle_ref      reference_usd  dev_bps  age_s  reason");
  for (const s of snapshot.samples) {
    console.log(
      [
        s.pair.padEnd(12),
        s.status.padEnd(11),
        (s.oracleRate ?? NaN).toFixed(6).padStart(12),
        (s.referenceUsd ?? NaN).toFixed(6).padStart(13),
        (s.deviationBps === null ? "-" : s.deviationBps.toFixed(1)).padStart(8),
        (s.oracleAgeSeconds === null ? "-" : s.oracleAgeSeconds.toFixed(0)).padStart(6),
        s.reason,
      ].join("  "),
    );
  }

  const summary = summarize(snapshot.samples, config.thresholds);
  console.log(
    `summary: total=${summary.total} ok=${summary.ok} warn=${summary.warning} critical=${summary.critical} stale=${summary.stale} unavailable=${summary.unavailable} meanAbsDev_bps=${summary.meanAbsoluteDeviationBps?.toFixed(1) ?? "n/a"} breaches=${summary.breaches}`,
  );

  await appendSnapshot(config.stateFile, snapshot);
  console.log(`appended to ${config.stateFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
