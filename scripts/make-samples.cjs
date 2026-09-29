// Build the committed sample dataset and print reproducible statistics.
// Usage: node scripts/make-samples.cjs
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const src = path.join(root, "data", "state.jsonl");
const outDir = path.join(root, "data", "samples");
const out = path.join(outDir, "example-snapshots.jsonl");

const raw = fs.readFileSync(src, "utf8").trim().split(/\r?\n/).filter(Boolean);
const snaps = raw.map((l) => JSON.parse(l));

// Commit the complete collected dataset, so every statistic quoted in the
// README is reproducible from committed evidence alone.
const chosen = snaps;

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(out, chosen.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");

let ref = 0;
let tot = 0;
const per = {};
const devs = [];
for (const s of snaps) {
  for (const smp of s.samples) {
    tot++;
    per[smp.pair] = (per[smp.pair] || 0) + 1;
    if (smp.referenceUsd != null) {
      ref++;
      devs.push(Math.abs(smp.deviationBps));
    }
  }
}
devs.sort((a, b) => a - b);
const mean = devs.reduce((a, b) => a + b, 0) / devs.length;
const variance = devs.reduce((a, b) => a + (b - mean) ** 2, 0) / devs.length;
const median = devs.length % 2 ? devs[(devs.length - 1) / 2] : (devs[devs.length / 2 - 1] + devs[devs.length / 2]) / 2;

console.log("committed sample snapshots:", chosen.length);
console.log("full dataset snapshots:", snaps.length);
console.log("window:", snaps[0].collectedAt, "->", snaps[snaps.length - 1].collectedAt);
console.log(
  "span_minutes:",
  ((new Date(snaps[snaps.length - 1].collectedAt) - new Date(snaps[0].collectedAt)) / 60000).toFixed(1),
);
console.log("samples:", tot, "with reference:", ref);
console.log("per-pair:", JSON.stringify(per));
console.log(
  "abs deviation bps -> mean",
  mean.toFixed(2),
  "median",
  median.toFixed(2),
  "stdev",
  Math.sqrt(variance).toFixed(2),
  "max",
  devs[devs.length - 1].toFixed(2),
);
