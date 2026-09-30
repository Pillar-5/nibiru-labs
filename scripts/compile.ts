/**
 * Compile contracts with the solc npm package and write artifacts to
 * artifacts/. Avoids a Hardhat/Foundry dependency for a single-contract
 * project while still producing standard {abi, bytecode} artifacts.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import solcModule from "solc";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const solc: any = (solcModule as any).default ?? solcModule;

function compile(): void {
  const source = readFileSync(join(root, "contracts/OracleAttestationRegistry.sol"), "utf8");

  const input = {
    language: "Solidity",
    sources: { "OracleAttestationRegistry.sol": { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // Nibiru Testnet-2's EVM interpreter rejects Cancun opcodes: an eth_call
      // against bytecode containing MCOPY fails with "invalid opcode: MCOPY".
      // Solidity 0.8.25+ emits MCOPY in its memory-copy routine, which is
      // reached when ABI-encoding struct returns. Pinning the EVM target to
      // "shanghai" (pre-Cancun) keeps deployed bytecode executable on Nibiru.
      // Verified against the live node: see docs/research.md.
      evmVersion: "shanghai",
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object"],
        },
      },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));

  for (const err of output.errors ?? []) {
    if (err.severity === "error") {
      console.error(err.formattedMessage);
      process.exit(1);
    } else {
      console.warn(err.formattedMessage);
    }
  }

  const contract =
    output.contracts?.["OracleAttestationRegistry.sol"]?.["OracleAttestationRegistry"];
  if (!contract) {
    console.error("compilation produced no OracleAttestationRegistry output");
    process.exit(1);
  }

  const artifactDir = join(root, "artifacts");
  mkdirSync(artifactDir, { recursive: true });

  const artifact = {
    name: "OracleAttestationRegistry",
    compiler: { version: solc.version() },
    abi: contract.abi,
    bytecode: "0x" + contract.evm.bytecode.object,
  };
  const out = join(artifactDir, "OracleAttestationRegistry.json");
  writeFileSync(out, JSON.stringify(artifact, null, 2), "utf8");
  // Consumers (and this repository's committed artifacts/) use the bare ABI
  // file, so it is regenerated alongside the full artifact instead of being
  // left stale by the compile step.
  const abiOut = join(artifactDir, "OracleAttestationRegistry.abi.json");
  writeFileSync(abiOut, JSON.stringify(contract.abi, null, 2) + "\n", "utf8");
  console.log(`compiled OracleAttestationRegistry -> ${out}`);
  console.log(`wrote ABI -> ${abiOut}`);
}

compile();
