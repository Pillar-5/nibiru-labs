/**
 * Append-only JSONL storage for monitoring snapshots.
 *
 * JSONL keeps the store human-readable, greppable and diffable, and lets any
 * external analyst reproduce the analysis without this codebase:
 *
 *   jq -s 'map(.samples[]) | map(select(.deviationBps != null)) | length' data/state.jsonl
 *
 * Bigint fields are serialized as decimal strings.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Snapshot } from "./monitor.ts";

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  return value;
}

function revive(_key: string, value: unknown): unknown {
  return value;
}

export async function appendSnapshot(file: string, snapshot: Snapshot): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(snapshot, replacer) + "\n", "utf8");
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
    .map((line) => JSON.parse(line, revive) as Snapshot);
}
