/**
 * Deploy OracleAttestationRegistry to the configured network.
 *
 * Reads the signing key only from the environment (NIBIRU_PRIVATE_KEY). The
 * key is never printed. A per-run gas-spending guard aborts the broadcast when
 * the projected native-coin cost exceeds MAX_GAS_SPEND_NIBI.
 *
 * The deployed address is printed and appended to deployment.json (gitignored
 * per-network file; see docs/deployment.md).
 */
import "dotenv/config";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { loadConfig } from "../src/config.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

async function main(): Promise<void> {
  const config = loadConfig();
  const privateKey = process.env.NIBIRU_PRIVATE_KEY;
  if (!privateKey) {
    console.error(
      "NIBIRU_PRIVATE_KEY is not set. Set it in your local .env for the deployment account (a low-value testnet account).",
    );
    process.exit(1);
  }

  const artifactPath = join(root, "artifacts/OracleAttestationRegistry.json");
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));

  const provider = new ethers.JsonRpcProvider(config.network.rpcUrl, config.network.chainId);
  const wallet = new ethers.Wallet(privateKey, provider);
  const address = await provider.getNetwork().then(() => wallet.getAddress());
  const balance = await provider.getBalance(address);

  console.log(`network:  ${config.network.name} (chainId ${config.network.chainId})`);
  console.log(`rpc:      ${config.network.rpcUrl}`);
  console.log(`account:  ${address}`);
  console.log(`balance:  ${ethers.formatEther(balance)} ${config.network.nativeCurrency.symbol}`);

  let gasPrice = await provider.getFeeData().then((f) => f.gasPrice ?? f.maxFeePerGas ?? 0n);
  // Testnet-2 nodes may report a zero gas price while charging a minimum; use
  // the observed chain minimum as the guard's floor so the cost estimate holds.
  if (gasPrice === 0n) {
    const raw = await provider.send("eth_gasPrice", []);
    gasPrice = BigInt(raw) || 1_000_000_000_000n; // 1000 gwei floor
  }
  // Estimate deployment gas against the live node instead of assuming a fixed
  // figure, then add a 30% buffer for calibration. The guard below compares
  // the buffered estimate with MAX_GAS_SPEND_NIBI.
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const deployData = (await factory.getDeployTransaction()).data;
  let deployGas: bigint;
  try {
    const raw = await provider.estimateGas({ from: address, data: deployData });
    deployGas = (raw * 130n) / 100n;
  } catch {
    deployGas = 3_000_000n; // fall back to a conservative ceiling
  }
  const projectedCost = gasPrice * deployGas;
  const maxSpend = ethers.parseEther(process.env.MAX_GAS_SPEND_NIBI ?? "0.05");
  const projected = ethers.formatEther(projectedCost);
  if (projectedCost > maxSpend) {
    console.error(
      `refusing to deploy: projected gas cost ${projected} ${config.network.nativeCurrency.symbol} exceeds MAX_GAS_SPEND_NIBI=${process.env.MAX_GAS_SPEND_NIBI ?? "0.05"}`,
    );
    process.exit(1);
  }

  console.log("deploying OracleAttestationRegistry...");
  const contract = await factory.deploy();
  console.log(`sent deployment tx ${contract.deploymentTransaction()?.hash}`);
  await contract.waitForDeployment();
  const deployed = await contract.getAddress();
  console.log(`deployed: ${deployed}`);
  console.log(`explorer: ${config.network.explorerUrl}/address/${deployed}`);

  const deploymentsPath = resolve(root, "data/deployment.json");
  const record = {
    network: config.network.name,
    chainId: config.network.chainId,
    address: deployed,
    txHash: contract.deploymentTransaction()?.hash,
    deployedAt: new Date().toISOString(),
  };
  const existing = existsSync(deploymentsPath) ? JSON.parse(readFileSync(deploymentsPath, "utf8")) : {};
  writeFileSync(
    deploymentsPath,
    JSON.stringify({ ...existing, [String(config.network.chainId)]: record }, null, 2),
    "utf8",
  );
  console.log(`recorded in ${deploymentsPath} (key ${config.network.chainId})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
