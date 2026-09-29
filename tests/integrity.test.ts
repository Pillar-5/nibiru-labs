import { describe, expect, it } from "vitest";
import {
  analyze,
  deviationBps,
  oracleAgeSeconds,
  summarize,
  type Thresholds,
} from "../src/analysis/integrity.ts";
import type { OracleReading } from "../src/oracle/precompile.ts";
import type { ReferenceQuote } from "../src/oracle/reference.ts";

const thresholds: Thresholds = {
  maxOracleAgeSeconds: 60,
  deviationWarnBps: 50,
  deviationCriticalBps: 200,
};

function reading(overrides: Partial<OracleReading> = {}): OracleReading {
  const tsMs = 1_700_000_000_000n;
  return {
    pair: "ueth:uusd",
    rawRate: 3000_00000000n,
    rate: 3000,
    updateBlockTimestampMs: tsMs,
    updateBlockHeight: 42n,
    queriedAtBlock: 43,
    queriedAt: new Date(Number(tsMs)).toISOString(),
    chainId: 6911,
    ...overrides,
  };
}

function quote(usd: number): ReferenceQuote {
  return {
    denom: "ueth",
    symbol: "ETH",
    usd,
    source: "coinbase",
    retrievedAt: "2026-01-01T00:00:00.000Z",
    upstreamLastUpdate: "2026-01-01T00:00:00.000Z",
  };
}

describe("deviationBps", () => {
  it("is zero when oracle matches reference", () => {
    expect(deviationBps(3000, 3000)).toBe(0);
  });
  it("signs oracle-high positive", () => {
    expect(deviationBps(3030, 3000)).toBeCloseTo(100, 6);
  });
  it("signs oracle-low negative", () => {
    expect(deviationBps(2970, 3000)).toBeCloseTo(-100, 6);
  });
  it("rejects non-finite or zero reference", () => {
    expect(() => deviationBps(1, 0)).toThrow();
    expect(() => deviationBps(1, NaN)).toThrow();
  });
});

describe("oracleAgeSeconds", () => {
  it("is zero when queried in the update block instant", () => {
    expect(oracleAgeSeconds(reading())).toBe(0);
  });
  it("grows with the difference between query and update", () => {
    expect(oracleAgeSeconds({ updateBlockTimestampMs: 1000n, queriedAt: new Date(9000).toISOString() }))
      .toBe(8);
  });
  it("never goes negative for clock skew", () => {
    expect(oracleAgeSeconds({ updateBlockTimestampMs: 9999n, queriedAt: new Date(1000).toISOString() }))
      .toBe(0);
  });
  it("returns Infinity for a missing update timestamp", () => {
    expect(oracleAgeSeconds({ updateBlockTimestampMs: 0n, queriedAt: new Date(1000).toISOString() }))
      .toBe(Infinity);
  });
});

describe("analyze", () => {
  it("passes a fresh, matched feed", () => {
    const s = analyze("ueth:uusd", 6911, reading(), quote(3000), thresholds);
    expect(s.status).toBe("ok");
    expect(s.deviationBps).toBeCloseTo(0, 6);
  });
  it("flags warning at the warn threshold", () => {
    const s = analyze("ueth:uusd", 6911, reading({ rate: 3030 }), quote(3000), thresholds);
    expect(s.status).toBe("warning");
    expect(s.deviationBps).toBeCloseTo(100, 6);
  });
  it("flags critical at the critical threshold", () => {
    const s = analyze("ueth:uusd", 6911, reading({ rate: 3060 }), quote(3000), thresholds);
    expect(s.status).toBe("critical");
    expect(s.deviationBps).toBeCloseTo(200, 6);
  });
  it("treats negative deviations symmetrically", () => {
    const s = analyze("ueth:uusd", 6911, reading({ rate: 2940 }), quote(3000), thresholds);
    expect(s.status).toBe("critical");
    expect(s.deviationBps).toBeCloseTo(-200, 6);
  });
  it("flags stale when the oracle stopped updating", () => {
    const old = new Date(1_700_000_000_000 + 300_000).toISOString();
    const s = analyze("ueth:uusd", 6911, reading({ queriedAt: old }), quote(3000), thresholds);
    expect(s.status).toBe("stale");
  });
  it("keeps a price breach outranking staleness", () => {
    const old = new Date(1_700_000_000_000 + 300_000).toISOString();
    const s = analyze("ueth:uusd", 6911, reading({ rate: 3600, queriedAt: old }), quote(3000), thresholds);
    expect(s.status).toBe("critical");
  });
  it("reports unavailable when the precompile reverts", () => {
    const s = analyze("uusd:uusd", 6911, null, null, thresholds);
    expect(s.status).toBe("unavailable");
    expect(s.reason).toMatch(/did not return/);
  });
});

describe("summarize", () => {
  const samples = [
    analyze("a:uusd", 6911, reading({ pair: "a:uusd", rate: 3000 }), quote(3000), thresholds),
    analyze("b:uusd", 6911, reading({ pair: "b:uusd", rate: 3030 }), quote(3000), thresholds),
    analyze("c:uusd", 6911, reading({ pair: "c:uusd", rate: 2970 }), quote(3000), thresholds),
    analyze("d:uusd", 6911, null, null, thresholds),
  ];
  const summary = summarize(samples, thresholds);
  it("counts statuses", () => {
    expect(summary.total).toBe(4);
    expect(summary.ok).toBe(1);
    expect(summary.warning).toBe(2);
    expect(summary.unavailable).toBe(1);
  });
  it("computes deviation statistics over referenced samples only", () => {
    expect(summary.meanAbsoluteDeviationBps).toBeCloseTo(66.6667, 3);
    expect(summary.maxAbsoluteDeviationBps).toBeCloseTo(100, 6);
    expect(summary.breaches).toBe(2);
  });
});
