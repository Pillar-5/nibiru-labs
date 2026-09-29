/**
 * Integrity analysis for oracle readings.
 *
 * A sample is the combination of an on-chain oracle reading and, when
 * available, an independent reference quote. The analysis computes two
 * integrity signals:
 *
 *  1. Deviation  -- how far the on-chain rate sits from the independent
 *     reference, in basis points. Catches price-manipulation or broken-feed
 *     conditions.
 *  2. Staleness  -- how old the oracle value is relative to the block that
 *     produced it, in seconds. Catches a feed that stopped updating even if
 *     its last value was correct.
 *
 * Severity is assigned with explicit, configurable thresholds so the same
 * methodology can be reused on any network.
 */

import type { OracleReading } from "../oracle/precompile.ts";
import type { ReferenceQuote } from "../oracle/reference.ts";

export type IntegrityStatus = "ok" | "warning" | "critical" | "stale" | "unavailable";

export interface Sample {
  pair: string;
  chainId: number;
  /** oracle exchange rate (base per quote) read from the precompile */
  oracleRate: number | null;
  /** independent reference spot price in USD (for `:uusd` pairs) */
  referenceUsd: number | null;
  /** signed relative deviation, oracle vs reference, in basis points */
  deviationBps: number | null;
  /** oracle value age in seconds (queried_at - update_block_timestamp) */
  oracleAgeSeconds: number | null;
  status: IntegrityStatus;
  /** human-readable explanation of the status decision */
  reason: string;
  oracleQueriedAt: string;
  oracleBlock: number | null;
  oracleUpdateBlockHeight: bigint | null;
  oracleUpdateBlockTimestampMs: bigint | null;
  reference?: ReferenceQuote;
  collectedAt: string;
}

export function deviationBps(oracleValue: number, referenceValue: number): number {
  if (!Number.isFinite(referenceValue) || referenceValue === 0) {
    throw new Error("reference value must be a non-zero finite number");
  }
  return ((oracleValue - referenceValue) / referenceValue) * 10_000;
}

export function oracleAgeSeconds(
  reading: Pick<OracleReading, "updateBlockTimestampMs" | "queriedAt">,
): number {
  const updateMs = Number(reading.updateBlockTimestampMs);
  const queriedMs = new Date(reading.queriedAt).getTime();
  if (!Number.isFinite(updateMs) || updateMs <= 0) return Infinity;
  return Math.max(0, (queriedMs - updateMs) / 1000);
}

export interface Thresholds {
  maxOracleAgeSeconds: number;
  deviationWarnBps: number;
  deviationCriticalBps: number;
}


/** Classify one oracle reading against an optional reference quote. */
export function analyze(
  pair: string,
  chainId: number,
  reading: OracleReading | null,
  reference: ReferenceQuote | null,
  thresholds: Thresholds,
): Sample {
  const collectedAt = new Date().toISOString();

  if (!reading) {
    return {
      pair,
      chainId,
      oracleRate: null,
      referenceUsd: reference?.usd ?? null,
      deviationBps: null,
      oracleAgeSeconds: null,
      status: "unavailable",
      reason: "oracle precompile did not return a value for this pair",
      oracleQueriedAt: collectedAt,
      oracleBlock: null,
      oracleUpdateBlockHeight: null,
      oracleUpdateBlockTimestampMs: null,
      reference: reference ?? undefined,
      collectedAt,
    };
  }

  const age = oracleAgeSeconds(reading);
  const dev = reference ? deviationBps(reading.rate, reference.usd) : null;

  let status: IntegrityStatus = "ok";
  let reason = `oracle rate ${reading.rate} within ${thresholds.deviationWarnBps} bps of reference`;
  if (!reference) {
    reason = "no independent reference available; reporting freshness only";
  } else if (dev !== null && Math.abs(dev) >= thresholds.deviationCriticalBps) {
    status = "critical";
    reason = `deviation ${dev.toFixed(1)} bps >= critical threshold ${thresholds.deviationCriticalBps} bps`;
  } else if (dev !== null && Math.abs(dev) >= thresholds.deviationWarnBps) {
    status = "warning";
    reason = `deviation ${dev.toFixed(1)} bps >= warning threshold ${thresholds.deviationWarnBps} bps`;
  }

  // Staleness outranks a merely "ok" price but yields to a price breach.
  if (age > thresholds.maxOracleAgeSeconds && (status === "ok" || status === "warning")) {
    status = "stale";
    reason = `oracle value age ${age.toFixed(0)}s > max age ${thresholds.maxOracleAgeSeconds}s`;
  }

  return {
    pair,
    chainId,
    oracleRate: reading.rate,
    referenceUsd: reference?.usd ?? null,
    deviationBps: dev,
    oracleAgeSeconds: age,
    status,
    reason,
    oracleQueriedAt: reading.queriedAt,
    oracleBlock: reading.queriedAtBlock,
    oracleUpdateBlockHeight: reading.updateBlockHeight,
    oracleUpdateBlockTimestampMs: reading.updateBlockTimestampMs,
    reference: reference ?? undefined,
    collectedAt,
  };
}

export interface Summary {
  total: number;
  ok: number;
  warning: number;
  critical: number;
  stale: number;
  unavailable: number;
  /** absolute-deviation mean over samples that had a reference (in bps) */
  meanAbsoluteDeviationBps: number | null;
  /** population standard deviation of absolute deviations (bps) */
  stddevAbsoluteDeviationBps: number | null;
  /** worst observed absolute deviation (bps) */
  maxAbsoluteDeviationBps: number | null;
  /** number of samples whose absolute deviation exceeded the warn threshold */
  breaches: number;
}

export function summarize(samples: Sample[], thresholds: Thresholds): Summary {
  const abs = samples
    .filter((s) => s.deviationBps !== null)
    .map((s) => Math.abs(s.deviationBps as number));

  const count = (status: IntegrityStatus) => samples.filter((s) => s.status === status).length;

  let mean: number | null = null;
  let stddev: number | null = null;
  let max: number | null = null;
  if (abs.length > 0) {
    mean = abs.reduce((a, b) => a + b, 0) / abs.length;
    max = Math.max(...abs);
    stddev = Math.sqrt(abs.reduce((a, b) => a + (b - mean!) ** 2, 0) / abs.length);
  }

  return {
    total: samples.length,
    ok: count("ok"),
    warning: count("warning"),
    critical: count("critical"),
    stale: count("stale"),
    unavailable: count("unavailable"),
    meanAbsoluteDeviationBps: mean,
    stddevAbsoluteDeviationBps: stddev,
    maxAbsoluteDeviationBps: max,
    breaches: abs.filter((d) => d >= thresholds.deviationWarnBps).length,
  };
}
