/**
 * Read-only verification of the on-chain attestation registry.
 *
 * Reads the deployed OracleAttestationRegistry through the configured network
 * and prints the latest anchored integrity report for each monitored pair.
 * Requires no wallet and no secrets: it only needs NIBIRU_NETWORK (or RPC
 * overrides) and ATTESTATION_REGISTRY (or data/deployment.json from a local
 * deploy). Use it to confirm what the chain records independently of this
 * repository's local store.
 *
 *   npm run contract:verify
 */
import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { loadConfig } from "../src/config.ts";
import { STATUS_NAME } from "../src/attestation.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

function registryAddress(): string {
  const fromEnv = process.env.ATTESTATION_REGISTRY?.trim();
  if (fromEnv) return fromEnv;
  const path = join(root, "data/deployment.json");
  if (existsSync(path)) {
    const deployments = JSON.parse(readFileSync(path, "utf8"));
    const config = loadConfig();
    const record = deployments[String(config.network.chainId)];
    if (record?.address) return record.address;
  }
  console.error(
    "No registry address. Set ATTESTATION_REGISTRY in .env or deploy the registry (npm run contract:deploy).",
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const address = registryAddress();
  const artifact = JSON.parse(
    readFileSync(join(root, "artifacts/OracleAttestationRegistry.json"), "utf8"),
  );
  const provider = new ethers.JsonRpcProvider(config.network.rpcUrl, config.network.chainId);
  const registry = new ethers.Contract(address, artifact.abi, provider);

  console.log(`network:  ${config.network.name} (chainId ${config.network.chainId})`);
  console.log(`rpc:      ${config.network.rpcUrl}`);
  console.log(`registry: ${address}`);
  console.log(`explorer: ${config.network.explorerUrl}/address/${address}\n`);

  console.log(`owner: ${await registry.owner()}`);

  const pairs: string[] = config.oracle.pairs;
  console.log(`\nlatest anchored report per monitored pair (${pairs.length} pairs):`);
  for (const pair of pairs) {
    const [found, a] = await registry.lookup(pair);
    if (!found) {
      console.log(`  ${pair.padEnd(11)} (no report on chain yet)`);
      continue;
    }
    const rate = Number(a.oracleRateFixed8) / 1e8;
    const ref = Number(a.referenceFixed8) / 1e8;
    const collected = new Date(Number(a.collectedAtUnix) * 1000).toISOString();
    const reports = await registry.reportCount(ethers.id(pair));
    console.log(
      `  ${pair.padEnd(11)} status=${STATUS_NAME[a.status] ?? a.status} oracle=${rate} reference=${ref} dev=${a.deviationBps}bps oracleBlock=${a.oracleBlock} reports=${reports} collected=${collected}`,
    );
    console.log(`  ${"".padEnd(11)} contentHash=${a.contentHash}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
