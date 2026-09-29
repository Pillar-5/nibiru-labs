import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseIdMap, parsePairs, loadConfig } from "../src/config.ts";
import { appendSnapshot, readSnapshots } from "../src/store.ts";
import type { Snapshot } from "../src/monitor.ts";

describe("config parsing", () => {
  it("parses pair lists", () => {
    expect(parsePairs("unibi:uusd, ueth:uusd ,,")).toEqual(["unibi:uusd", "ueth:uusd"]);
  });
  it("parses denom=id maps", () => {
    expect(parseIdMap("ueth=ethereum,ubtc=bitcoin")).toEqual({
      ueth: "ethereum",
      ubtc: "bitcoin",
    });
  });
  it("rejects malformed id mappings", () => {
    expect(() => parseIdMap("ueth-ethereum")).toThrow(/denom=id/);
  });
  it("loads the testnet preset by default", () => {
    const saved = process.env.NIBIRU_NETWORK;
    delete process.env.NIBIRU_NETWORK;
    const c = loadConfig();
    expect(c.network.chainId).toBe(6911);
    expect(c.network.rpcUrl).toBe("https://evm-rpc.testnet-2.nibiru.fi");
    if (saved !== undefined) process.env.NIBIRU_NETWORK = saved;
  });
});

describe("snapshot store", () => {
  const snapshot: Snapshot = {
    network: "Nibiru Testnet-2",
    chainId: 6911,
    block: 123,
    collectedAt: "2026-01-01T00:00:00.000Z",
    notes: ["reference unavailable: test"],
    samples: [
      {
        pair: "unibi:uusd",
        chainId: 6911,
        oracleRate: 0.0005,
        referenceUsd: 0.0005,
        deviationBps: 0,
        oracleAgeSeconds: 1,
        status: "ok",
        reason: "ok",
        oracleQueriedAt: "2026-01-01T00:00:00.000Z",
        oracleBlock: 123,
        oracleUpdateBlockHeight: 42n,
        oracleUpdateBlockTimestampMs: 1790000000000n,
        collectedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };

  it("round-trips bigint fields as decimal strings", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "nibiru-labs-")), "state.jsonl");
    await appendSnapshot(file, snapshot);
    await appendSnapshot(file, snapshot);
    const loaded = await readSnapshots(file);
    expect(loaded).toHaveLength(2);
    expect(loaded[1].samples[0].oracleUpdateBlockHeight).toBe("42");
    const raw = readFileSync(file, "utf8");
    expect(raw.trim().split("\n")).toHaveLength(2);
  });

  it("returns an empty list when the store does not exist yet", async () => {
    expect(await readSnapshots(join(tmpdir(), "definitely-missing-" + Date.now()))).toEqual([]);
  });
});
