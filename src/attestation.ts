/**
 * On-chain attestation encoding.
 *
 * A snapshot is summarized into a fixed-shape record and hashed with keccak256
 * over its ABI encoding. The hash is what gets written to the registry
 * contract, so anyone holding the original snapshot file can verify that the
 * on-chain record matches the off-chain report.
 *
 * Encoding fields:
 *   pair, oracleRate (bps-rounded fixed 8), referenceUsd (same),
 *   deviationBps (signed), status code, oracleUpdateBlockHeight,
 *   collectedAtUnix, oracleBlock.
 */

import { ethers } from "ethers";
import type { Sample, IntegrityStatus } from "./analysis/integrity.ts";
import type { Snapshot } from "./monitor.ts";

export const STATUS_CODE: Record<IntegrityStatus, number> = {
  ok: 0,
  warning: 1,
  critical: 2,
  stale: 3,
  unavailable: 4,
};

/** Reverse of STATUS_CODE; used when reading status codes back from the chain. */
export const STATUS_NAME: Record<number, IntegrityStatus> = Object.fromEntries(
  Object.entries(STATUS_CODE).map(([name, code]) => [code, name as IntegrityStatus]),
) as Record<number, IntegrityStatus>;

/** Fixed-8 encoding of a price: NaN/null -> 0 sentinel handled by caller. */
function fixed8(value: number | null): bigint {
  if (value === null || !Number.isFinite(value) || value < 0) return 0n;
  return BigInt(Math.round(value * 1e8));
}

function signedBps(value: number | null): bigint {
  if (value === null || !Number.isFinite(value)) return 0n;
  return BigInt(Math.round(value));
}

const ATTESTATION_TUPLE =
  "tuple(string pair,uint64 oracleRateFixed8,uint64 referenceFixed8,int64 deviationBps,uint8 status,uint64 oracleUpdateBlock,uint32 collectedAtUnix,uint32 oracleBlock,bytes32 contentHash)";

/**
 * ABI of the deployed registry. This is the single source of truth used by the
 * signing CLI and the read-back verification script; tests/contract.test.ts
 * asserts every entry still matches the solc-compiled contract.
 */
export const ATTESTATION_ABI = [
  "function record(bytes32 pairId,string pair,uint64 oracleRateFixed8,uint64 referenceFixed8,int64 deviationBps,uint8 status,uint64 oracleUpdateBlock,uint32 collectedAtUnix,uint32 oracleBlock) external",
  "event AttestationRecorded(bytes32 indexed pairId,string pair,uint64 oracleRateFixed8,uint64 referenceFixed8,int64 deviationBps,uint8 status,uint64 oracleUpdateBlock,uint32 collectedAtUnix,uint32 oracleBlock,bytes32 contentHash)",
  `function getAttestation(bytes32 pairId) view returns (${ATTESTATION_TUPLE})`,
  `function lookup(string pair) view returns (bool found, ${ATTESTATION_TUPLE} attestation)`,
  "function owner() view returns (address)",
  "function reportCount(bytes32 pairId) view returns (uint64)",
  "function isKnownContentHash(bytes32 contentHash) view returns (bool)",
  "function transferOwnership(address newOwner) external",
];

export interface AttestationRecord {
  pair: string;
  oracleRateFixed8: bigint;
  referenceFixed8: bigint;
  deviationBps: bigint;
  status: number;
  oracleUpdateBlock: bigint;
  collectedAtUnix: number;
  oracleBlock: number;
}

export function toRecord(snapshot: Snapshot, sample: Sample): AttestationRecord {
  return {
    pair: sample.pair,
    oracleRateFixed8: fixed8(sample.oracleRate),
    referenceFixed8: fixed8(sample.referenceUsd),
    deviationBps: signedBps(sample.deviationBps),
    status: STATUS_CODE[sample.status],
    oracleUpdateBlock: sample.oracleUpdateBlockHeight ?? 0n,
    collectedAtUnix: Math.floor(new Date(snapshot.collectedAt).getTime() / 1000),
    oracleBlock: snapshot.block,
  };
}

/** pairId = keccak256(pair string); contentHash binds every field. */
export function pairId(pair: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(pair));
}

export function contentHash(rec: AttestationRecord): string {
  return ethers.keccak256(
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
}

export function encodeRecordCall(rec: AttestationRecord): {
  args: unknown[];
  selector: string;
} {
  const iface = new ethers.Interface(ATTESTATION_ABI);
  const fn = iface.getFunction("record")!;
  return {
    args: [
      pairId(rec.pair),
      rec.pair,
      rec.oracleRateFixed8,
      rec.referenceFixed8,
      rec.deviationBps,
      rec.status,
      rec.oracleUpdateBlock,
      rec.collectedAtUnix,
      rec.oracleBlock,
    ],
    selector: fn.selector,
  };
}
