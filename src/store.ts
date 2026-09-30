/**
 * Append-only JSONL storage for monitoring snapshots.
 *
 * JSONL keeps the store human-readable, greppable and diffable, and lets any
 * external analyst reproduce the analysis without this codebase:
 *
 *   jq -s 'map(.samples[]) | map(select(.deviationBps != null)) | length' data/state.jsonl
 *
 * On disk, bigint fields are written as decimal strings (JSON has no bigint).
 * `readSnapshots` converts them back to bigint so in-memory values match the
 * `Snapshot`/`Sample` types, and `jsonReplacer` is exported for callers that
 * need to serialize those values again (the HTTP API does).
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Snapshot } from "./monitor.ts";

/** Decimal-string fields that must be revived to bigint when reading. */
const BIGINT_FIELDS = ["oracleUpdateBlockHeight", "oracleUpdateBlockTimestampMs"];

/** JSON.stringify replacer: bigint -> decimal string. */
export function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  return value;
}

/** JSON.parse reviver: decimal strings in known bigint fields -> bigint. */
function reviver(key: string, value: unknown): unknown {
  if (typeof value === "string" && BIGINT_FIELDS.includes(key) && /^-?\d+$/.test(value)) {
    return BigInt(value);
  }
  return value;
}

export async function appendSnapshot(file: string, snapshot: Snapshot): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(snapshot, jsonReplacer) + "\n", "utf8");
}

export async function readSnapshots(file: string): Promise<Snapshot[]> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line, reviver) as Snapshot);
}
