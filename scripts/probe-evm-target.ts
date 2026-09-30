/**
 * Determine which EVM opcode targets a Nibiru network actually executes, for the
 * contract compiled in this repository.
 *
 * Why this exists: Solidity >= 0.8.25 emits MCOPY (Cancun, opcode 0x5E) in its
 * memory-copy routine, which is reached when ABI-encoding a struct return. If a
 * network's interpreter does not implement Cancun, a default-target build
 * reverts there while a build pinned to `shanghai` works. This script compiles
 * the same source twice, deploys both builds, and calls one function that
 * returns a struct (`lookup`) and one that does not (`owner`).
 *
 * It writes to the chain, so it needs a local signing key (NIBIRU_PRIVATE_KEY)
 * and the same spending guard the other write paths use. Read the results in the
 * printed summary; docs/research.md records a run of this script.
 *
 *   npm run contract:probe-target
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import solcModule from "solc";
import { loadConfig } from "../src/config.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const solc: any = (solcModule as any).default ?? solcModule;

const TARGETS = ["shanghai", "cancun"] as const;

function compile(evmVersion: string): { abi: any[]; bytecode: string } {
  const source = readFileSync(join(root, "contracts/OracleAttestationRegistry.sol"), "utf8");
  const output = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: "Solidity",
        sources: { "OracleAttestationRegistry.sol": { content: source } },
        settings: {
          optimizer: { enabled: true, runs: 200 },
          evmVersion,
          outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
        },
      }),
    ),
  );
  const contract = output.contracts?.["OracleAttestationRegistry.sol"]?.["OracleAttestationRegistry"];
  if (!contract?.evm?.bytecode?.object) {
    throw new Error(`compilation for evmVersion=${evmVersion} produced no bytecode`);
  }
  return { abi: contract.abi, bytecode: "0x" + contract.evm.bytecode.object };
}


async function main(): Promise<void> {
  const config = loadConfig();
  const privateKey = process.env.NIBIRU_PRIVATE_KEY;
  if (!privateKey) {
    console.error(
      "NIBIRU_PRIVATE_KEY is not set; this probe deploys contracts and needs a local signing key.",
    );
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(config.network.rpcUrl, config.network.chainId);
  const wallet = new ethers.Wallet(privateKey, provider);
  const address = await wallet.getAddress();
  const balance = await provider.getBalance(address);
  const node = await provider.getNetwork();
  if (Number(node.chainId) !== config.network.chainId) {
    console.error(`node reported chainId ${node.chainId} but config expects ${config.network.chainId}; refusing.`);
    process.exit(1);
  }

  console.log(`network:  ${config.network.name} (chainId ${config.network.chainId})`);
  console.log(`rpc:      ${config.network.rpcUrl}`);
  console.log(`account:  ${address}`);
  console.log(`balance:  ${ethers.formatEther(balance)} ${config.network.nativeCurrency.symbol}`);
  console.log(`solc:     ${solc.version()}\n`);

  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas ?? 1_000_000_000_000n;
  const maxSpend = ethers.parseEther(process.env.MAX_GAS_SPEND_NIBI ?? "0.05");

  const iface = new ethers.Interface([
    "function owner() view returns (address)",
    "function lookup(string pair) view returns (bool found, tuple(string pair,uint64 oracleRateFixed8,uint64 referenceFixed8,int64 deviationBps,uint8 status,uint64 oracleUpdateBlock,uint32 collectedAtUnix,uint32 oracleBlock,bytes32 contentHash) attestation)",
  ]);

  const results: Array<Record<string, string>> = [];
  for (const evmVersion of TARGETS) {
    const { abi, bytecode } = compile(evmVersion);
    const factory = new ethers.ContractFactory(abi, bytecode, wallet);
    const deployData = (await factory.getDeployTransaction()).data;
    let gas = 3_000_000n;
    try {
      gas = ((await provider.estimateGas({ from: address, data: deployData })) * 130n) / 100n;
    } catch {
      /* keep the conservative ceiling */
    }
    const projected = gasPrice * gas;
    console.log(`evmVersion=${evmVersion} projected deploy cost ${ethers.formatEther(projected)}`);
    if (projected > maxSpend) {
      console.error(`refusing: projected cost exceeds MAX_GAS_SPEND_NIBI=${ethers.formatEther(maxSpend)}`);
      process.exit(1);
    }

    const contract = await factory.deploy();
    const tx = contract.deploymentTransaction()!;
    const receipt = await tx.wait();
    const deployed = await contract.getAddress();
    console.log(`  deployed ${deployed} in tx ${tx.hash} (gas ${receipt?.gasUsed})`);

    // Raw eth_call (not ethers' provider.call) so the node's own error text is
    // reported, e.g. "invalid opcode: MCOPY", instead of ethers' generic
    // "missing revert data".
    const call = async (data: string): Promise<string> => {
      const res = await fetch(config.network.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [{ to: deployed, data }, "latest"],
        }),
      });
      const json = (await res.json()) as { result?: string; error?: { message?: string } };
      if (json.error) return `REVERT ${json.error.message}`;
      return `ok ${json.result?.slice(0, 18)}...`;
    };

    results.push({
      evmVersion,
      deployed,
      tx: tx.hash,
      owner: await call(iface.getFunction("owner")!.selector),
      lookup: await call(iface.encodeFunctionData("lookup", ["ueth:uusd"])),
    });
    console.log();
  }

  console.log("summary (struct-returning lookup is the discriminator):");
  for (const r of results) {
    console.log(`  ${r.evmVersion.padEnd(8)} lookup=${r.lookup}`);
    console.log(`  ${"".padEnd(8)} owner =${r.owner}`);
    console.log(`  ${"".padEnd(8)} tx    = ${config.network.explorerUrl}/tx/${r.tx}`);
  }
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  // Defensive: never echo anything shaped like a private key.
  console.error(msg.replace(/0x[0-9a-fA-F]{64}/g, "0x[redacted]"));
  process.exit(1);
});
