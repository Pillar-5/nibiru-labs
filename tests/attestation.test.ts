import { describe, expect, it } from "vitest";
import { ethers } from "ethers";
import {
  STATUS_CODE,
  contentHash,
  encodeRecordCall,
  pairId,
  toRecord,
} from "../src/attestation.ts";
import type { Snapshot } from "../src/monitor.ts";
import type { Sample } from "../src/analysis/integrity.ts";

const sample: Sample = {
  pair: "ueth:uusd",
  chainId: 6911,
  oracleRate: 2740.92,
  referenceUsd: 2741.5,
  deviationBps: -2.12,
  oracleAgeSeconds: 2,
  status: "ok",
  reason: "ok",
  oracleQueriedAt: "2026-01-01T00:00:00.000Z",
  oracleBlock: 9701496,
  oracleUpdateBlockHeight: 9701495n,
  oracleUpdateBlockTimestampMs: 1790685672000n,
  collectedAt: "2026-01-01T00:00:00.000Z",
};

const snapshot: Snapshot = {
  network: "Nibiru Testnet-2",
  chainId: 6911,
  block: 9701496,
  collectedAt: "2026-01-01T00:00:00.000Z",
  samples: [sample],
  notes: [],
};

describe("pairId", () => {
  it("is the keccak256 of the utf8 pair string", () => {
    expect(pairId("ueth:uusd")).toBe(ethers.keccak256(ethers.toUtf8Bytes("ueth:uusd")));
  });
});

describe("toRecord", () => {
  it("encodes prices as fixed-point 1e8 and maps status codes", () => {
    const rec = toRecord(snapshot, sample);
    expect(rec.oracleRateFixed8).toBe(274092000000n);
    expect(rec.referenceFixed8).toBe(274150000000n);
    expect(rec.deviationBps).toBe(-2n);
    expect(rec.status).toBe(STATUS_CODE.ok);
    expect(rec.oracleUpdateBlock).toBe(9701495n);
    expect(rec.collectedAtUnix).toBe(Math.floor(Date.parse(snapshot.collectedAt) / 1000));
    expect(rec.oracleBlock).toBe(9701496);
  });
  it("maps null rates to the zero sentinel the contract rejects", () => {
    const rec = toRecord(snapshot, { ...sample, oracleRate: null, deviationBps: null });
    expect(rec.oracleRateFixed8).toBe(0n);
    expect(rec.deviationBps).toBe(0n);
  });
});

describe("contentHash", () => {
  it("is stable for identical content", () => {
    expect(contentHash(toRecord(snapshot, sample))).toBe(
      contentHash(toRecord(snapshot, sample)),
    );
  });
  it("changes when any encoded field changes", () => {
    const a = toRecord(snapshot, sample);
    const b = { ...a, deviationBps: a.deviationBps + 1n };
    expect(contentHash(a)).not.toBe(contentHash(b));
  });
  it("matches the Solidity-side abi.encode layout", () => {
    const rec = toRecord(snapshot, sample);
    const manual = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "uint64", "uint64", "int64", "uint8", "uint64", "uint32", "uint32"],
        [
          rec.pair,
          rec.oracleRateFixed8,
          rec.referenceFixed8,
          rec.deviationBps,
          rec.status,
          rec.oracleUpdateBlock,
          rec.collectedAtUnix,
          rec.oracleBlock,
        ],
      ),
    );
    expect(contentHash(rec)).toBe(manual);
  });
});

describe("encodeRecordCall", () => {
  it("produces the record(...) selector", () => {
    const { selector, args } = encodeRecordCall(toRecord(snapshot, sample));
    expect(selector).toBe(
      new ethers.Interface(["function record(bytes32,string,uint64,uint64,int64,uint8,uint64,uint32,uint32)"])
        .getFunction("record")!.selector,
    );
    expect(args[0]).toBe(pairId("ueth:uusd"));
    expect(args[1]).toBe("ueth:uusd");
  });
});
