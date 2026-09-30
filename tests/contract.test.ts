/**
 * Contract/encoding parity tests.
 *
 * The TypeScript side encodes attestations by hand (src/attestation.ts) and the
 * verification path reads the registry by hand. These tests compile the actual
 * Solidity source with the same settings as scripts/compile.ts and assert that
 * every hand-written ABI entry, selector, event topic and ABI-encoded hash still
 * matches the contract. They are deterministic and need no network.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ethers } from "ethers";
import solcModule from "solc";
import { ATTESTATION_ABI, contentHash, encodeRecordCall, toRecord } from "../src/attestation.ts";
import { ORACLE_ABI, ORACLE_CHAINLINK_ABI } from "../src/oracle/precompile.ts";
import type { Sample } from "../src/analysis/integrity.ts";
import type { Snapshot } from "../src/monitor.ts";

const solc: any = (solcModule as any).default ?? solcModule;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function compiledAbi(): any[] {
  const source = readFileSync(join(root, "contracts/OracleAttestationRegistry.sol"), "utf8");
  const output = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: "Solidity",
        sources: { "OracleAttestationRegistry.sol": { content: source } },
        settings: {
          optimizer: { enabled: true, runs: 200 },
          evmVersion: "shanghai",
          outputSelection: { "*": { "*": ["abi"] } },
        },
      }),
    ),
  );
  const errors = (output.errors ?? []).filter((e: any) => e.severity === "error");
  expect(errors, JSON.stringify(errors)).toHaveLength(0);
  return output.contracts["OracleAttestationRegistry.sol"].OracleAttestationRegistry.abi;
}

const abi = compiledAbi();
const iface = new ethers.Interface(abi);

describe("compiled contract ABI", () => {
  it("exposes every function the TypeScript side calls", () => {
    const names = iface.fragments
      .filter((f) => f.type === "function")
      .map((f) => (f as ethers.FunctionFragment).name)
      .sort();
    expect(names).toEqual([
      "getAttestation",
      "isKnownContentHash",
      "lookup",
      "owner",
      "record",
      "reportCount",
      "transferOwnership",
    ]);
  });

  it("matches the selectors written by hand in src/attestation.ts", () => {
    const handwritten = new ethers.Interface(ATTESTATION_ABI);
    for (const fn of ["record", "getAttestation", "lookup", "owner", "reportCount", "isKnownContentHash"]) {
      expect(
        handwritten.getFunction(fn)!.selector,
        `${fn} selector differs between src/attestation.ts and the contract`,
      ).toBe(iface.getFunction(fn)!.selector);
    }
  });

  it("matches the AttestationRecorded event topic", () => {
    const handwritten = new ethers.Interface(ATTESTATION_ABI);
    expect(handwritten.getEvent("AttestationRecorded")!.topicHash).toBe(
      iface.getEvent("AttestationRecorded")!.topicHash,
    );
  });

  it("rejects a mismatched field order in the content hash", () => {
    // Guards the specific hazard: the TS hash must be keccak256(abi.encode(...))
    // over the *contract's* parameter order, not the struct declaration order.
    const recordFragment = iface.getFunction("record")!;
    const types = recordFragment.inputs.slice(1).map((i) => i.type);
    expect(types).toEqual(["string", "uint64", "uint64", "int64", "uint8", "uint64", "uint32", "uint32"]);
  });

  it("keeps the committed ABI artifact in sync with the source", () => {
    const committed = JSON.parse(
      readFileSync(join(root, "artifacts/OracleAttestationRegistry.abi.json"), "utf8"),
    );
    expect(JSON.stringify(committed)).toBe(
      JSON.stringify(abi),
    );
  });
});

describe("precompile ABI selectors", () => {
  it("uses the documented queryExchangeRate selector", () => {
    expect(new ethers.Interface(ORACLE_ABI).getFunction("queryExchangeRate")!.selector).toBe("0x6bd1902f");
  });

  it("uses the documented chainLinkLatestRoundData selector with the ChainLink tuple shape", () => {
    const fn = new ethers.Interface(ORACLE_CHAINLINK_ABI).getFunction("chainLinkLatestRoundData")!;
    expect(fn.inputs.map((i) => i.type)).toEqual(["string"]);
    expect(fn.outputs.map((o) => o.type)).toEqual(["uint80", "int256", "uint256", "uint256", "uint80"]);
  });
});

describe("content hash parity with the contract", () => {
  const sample: Sample = {
    pair: "ueth:uusd",
    chainId: 6911,
    oracleRate: 2667.16,
    referenceUsd: 2665.81,
    deviationBps: 5.07,
    oracleAgeSeconds: 3,
    status: "ok",
    reason: "ok",
    oracleQueriedAt: "2026-09-30T00:00:00.000Z",
    oracleBlock: 9713529,
    oracleUpdateBlockHeight: 9713529n,
    oracleUpdateBlockTimestampMs: 1790749304000n,
    collectedAt: "2026-09-30T00:00:00.000Z",
  };
  const snapshot: Snapshot = {
    network: "Nibiru Testnet-2",
    chainId: 6911,
    block: 9713529,
    collectedAt: "2026-09-30T00:00:00.000Z",
    samples: [sample],
    notes: [],
  };

  it("hashes the same bytes the contract hashes", () => {
    const rec = toRecord(snapshot, sample);
    const { args } = encodeRecordCall(rec);
    const types = iface.getFunction("record")!.inputs.slice(1).map((i) => i.type);
    // args = [pairId, ...record fields]; the contract hashes everything after pairId.
    const expected = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(types, args.slice(1)),
    );
    expect(contentHash(rec)).toBe(expected);
  });
});
