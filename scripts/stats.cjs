// Recompute the integrity statistics for a snapshots JSONL file.
// Usage: node scripts/stats.cjs [path-to-jsonl]
// Default input: data/samples/example-snapshots.jsonl (committed dataset).
const fs = require("fs");
const path = require("path");

const file = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, "..", "data", "samples", "example-snapshots.jsonl");

const snaps = fs
  .readFileSync(file, "utf8")
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => JSON.parse(l));

console.log("file:", path.relative(process.cwd(), file) || file);
console.log("snapshots:", snaps.length);
console.log("window:", snaps[0].collectedAt, "->", snaps[snaps.length - 1].collectedAt);
const minutes =
  (new Date(snaps[snaps.length - 1].collectedAt) - new Date(snaps[0].collectedAt)) / 60000;
console.log("span_minutes:", minutes.toFixed(1));

let total = 0;
let withRef = 0;
const per = {};
const abs = [];
const breaches = { warn: 0, critical: 0, stale: 0 };

for (const s of snaps) {
  for (const x of s.samples) {
    total++;
    if (x.status === "stale") breaches.stale++;
    if (x.deviationBps === null || x.deviationBps === undefined) continue;
    withRef++;
    const p = (per[x.pair] ??= { n: 0, sum: 0, minAbs: Infinity, maxAbs: 0 });
    p.n++;
    p.sum += x.deviationBps;
    const a = Math.abs(x.deviationBps);
    p.minAbs = Math.min(p.minAbs, a);
    p.maxAbs = Math.max(p.maxAbs, a);
    abs.push(a);
    if (a >= 50) breaches.warn++;
    if (a >= 200) breaches.critical++;
  }
}

abs.sort((a, b) => a - b);
const mean = abs.reduce((a, b) => a + b, 0) / abs.length;
const variance = abs.reduce((a, b) => a + (b - mean) ** 2, 0) / abs.length;
const median = abs.length % 2 ? abs[(abs.length - 1) / 2] : (abs[abs.length / 2 - 1] + abs[abs.length / 2]) / 2;

console.log("samples:", total, "| with reference:", withRef);
for (const [pair, p] of Object.entries(per)) {
  console.log(
    `${pair}: n=${p.n} mean=${(p.sum / p.n).toFixed(2)} bps max|dev|=${p.maxAbs.toFixed(1)} bps`,
  );
}
console.log(
  "abs deviation bps -> mean",
  mean.toFixed(2),
  "median",
  median.toFixed(2),
  "stdev",
  Math.sqrt(variance).toFixed(2),
  "max",
  abs[abs.length - 1].toFixed(2),
);
console.log("status breaches (>=50 warn bps):", breaches.warn, "| >=200 critical bps:", breaches.critical, "| stale samples:", breaches.stale);
