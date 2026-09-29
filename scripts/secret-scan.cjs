// Local-only scan: ensure no private key or PEM secret is present in files
// that would be committed. Skips node_modules, dist, .git, images, and .env
// itself (which is gitignored and expected to hold the local key).
//
// The key to search for is read from the local .env (NIBIRU_PRIVATE_KEY) so it
// is never duplicated inside this committed script.
const fs = require("fs");
const path = require("path");

let KEY = process.env.NIBIRU_PRIVATE_KEY || "";
if (!KEY) {
  try {
    const env = fs.readFileSync(".env", "utf8");
    const m = env.match(/^NIBIRU_PRIVATE_KEY=([0-9a-fA-F]{64})/m);
    if (m) KEY = m[1];
  } catch {
    /* no local .env: nothing to match against */
  }
}

const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);
const SELF = path.basename(__filename);
const hits = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(p);
      continue;
    }
    if (entry.name === ".env" || entry.name === SELF) continue; // gitignored / self
    let buf;
    try {
      buf = fs.readFileSync(p);
    } catch {
      continue;
    }
    const text = buf.toString("latin1");
    const upper = text.toUpperCase();
    if (
      (KEY && upper.includes(KEY.toUpperCase())) ||
      text.includes("BEGIN RSA PRIVATE KEY") ||
      text.includes("BEGIN EC PRIVATE KEY") ||
      text.includes("BEGIN PRIVATE KEY")
    ) {
      hits.push(p);
    }
  }
}

walk(".");
console.log("secret hits outside .env:", hits.length);
for (const h of hits) console.log(h);
process.exit(hits.length ? 1 : 0);

