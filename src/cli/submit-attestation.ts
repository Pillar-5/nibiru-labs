/**
 * Anchor the latest monitoring snapshot on-chain via
 * OracleAttestationRegistry. This is the only component that signs
 * transactions, and it keeps the stages separate:
 *
 *   read chain   -> collectSnapshot (monitor.ts)
 *   prepare tx   -> encodeRecordCall (attestation.ts)
 *   check        -> gas-spending guard + explicit confirmation below
 *   broadcast    -> contract.record(...)
 *
 * Guards:
 *  - NIBIRU_PRIVATE_KEY is only ever read from the local environment. It is
 *    never printed, logged, or included in any error message.
 *  - MAX_GAS_SPEND_NIBI caps the projected native-coin cost per run.
 *  - MAX_ATTESTATIONS_PER_RUN caps how many reports one invocation submits.
 *  - The chain id returned by the node must match the configured chain id,
 *    so a misconfigured RPC cannot point signing at an unexpected network.
 *  - Confirmation (ATTEST_AUTO_CONFIRM=1) is required for non-interactive use.
 *
 * Prefer a dedicated low-value testnet account for ATTESTER_ADDRESS.
 */
import "dotenv/config";
import { ethers } from "ethers";
import { loadConfig } from "../config.ts";
import { readSnapshots } from "../store.ts";
import { encodeRecordCall, contentHash, toRecord } from "../attestation.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const privateKey = process.env.NIBIRU_PRIVATE_KEY;
  const registryAddress = process.env.ATTESTATION_REGISTRY;
  if (!privateKey) {
    console.error("NIBIRU_PRIVATE_KEY is not set; attestation requires a local signing key.");
    process.exit(1);
  }
  if (!registryAddress) {
    console.error("ATTESTATION_REGISTRY is not set; deploy the registry first (npm run contract:deploy).");
    process.exit(1);
  }

  const snapshots = await readSnapshots(config.stateFile);
  if (snapshots.length === 0) {
    console.error(`no snapshots in ${config.stateFile}; run npm run monitor:once first.`);
    process.exit(1);
  }
  const snapshot = snapshots[snapshots.length - 1];
  const attestable = snapshot.samples.filter(
    (s) => s.oracleRate !== null && s.oracleRate > 0 && s.oracleUpdateBlockHeight !== null,
  );
  if (attestable.length === 0) {
    console.error("the latest snapshot has no attestable samples (no successful oracle reads).");
    process.exit(1);
  }

  const maxPerRun = Number.parseInt(process.env.MAX_ATTESTATIONS_PER_RUN ?? "4", 10);
  const selected = attestable.slice(0, Math.max(0, maxPerRun));

  const provider = new ethers.JsonRpcProvider(config.network.rpcUrl, config.network.chainId);
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== config.network.chainId) {
    console.error(
      `node reported chainId ${network.chainId} but config expects ${config.network.chainId}; refusing to sign.`,
    );
    process.exit(1);
  }
  const wallet = new ethers.Wallet(privateKey, provider);
  const balance = await provider.getBalance(await wallet.getAddress());

  const registry = new ethers.Interface([
    "function record(bytes32,string,uint64,uint64,int64,uint8,uint64,uint32,uint32)",
    "function owner() view returns (address)",
    "function isKnownContentHash(bytes32) view returns (bool)",
  ]);
  const rawOwner = (await provider.call({ to: registryAddress, data: registry.getFunction("owner")!.selector })) as string;
  const onChainOwner = ethers.AbiCoder.defaultAbiCoder().decode(["address"], rawOwner)[0] as string;
  if (onChainOwner.toLowerCase() !== (await wallet.getAddress()).toLowerCase()) {
    console.error(
      `signer ${await wallet.getAddress()} is not the registry owner (${onChainOwner}); only the owner submits attestations.`,
    );
    process.exit(1);
  }

  const fee = await provider.getFeeData();
  let gasPrice = fee.gasPrice ?? fee.maxFeePerGas ?? 0n;
  // Testnet-2 nodes may report a zero gas price while charging a minimum; use
  // the observed chain minimum as the guard's floor so the cost estimate holds.
  if (gasPrice === 0n) {
    const raw = await provider.send("eth_gasPrice", []);
    gasPrice = BigInt(raw) || 1_000_000_000_000n; // 1000 gwei floor
  }

  console.log(`registry:     ${registryAddress}`);
  console.log(`network:      ${config.network.name} chainId ${config.network.chainId}`);
  console.log(`signer:       ${await wallet.getAddress()}`);
  console.log(`balance:      ${ethers.formatEther(balance)} ${config.network.nativeCurrency.symbol}`);
  console.log(`snapshot:     ${snapshot.collectedAt} block=${snapshot.block} samples=${selected.length}`);

  const perTxCap = ethers.parseEther(process.env.MAX_GAS_SPEND_NIBI ?? "0.05");
  const txGas = 200_000n; // conservative per-report estimate
  const projectedTotal = gasPrice * txGas * BigInt(selected.length);
  const projected = ethers.formatEther(projectedTotal);
  console.log(`projected gas cost: ${projected} ${config.network.nativeCurrency.symbol}`);
  if (projectedTotal > perTxCap) {
    console.error(`refusing: projected cost exceeds MAX_GAS_SPEND_NIBI=${process.env.MAX_GAS_SPEND_NIBI ?? "0.05"}`);
    process.exit(1);
  }
  if (projectedTotal > balance) {
    console.error("refusing: balance cannot cover projected gas.");
    process.exit(1);
  }

  if (process.env.ATTEST_AUTO_CONFIRM !== "1") {
    console.error("set ATTEST_AUTO_CONFIRM=1 to confirm submitting attestations on-chain.");
    process.exit(1);
  }

  // Send strictly sequentially with explicit nonces. The chain's "latest"
  // nonce counter can lag block confirmations by one, so combine both tags,
  // and on an "invalid nonce" rejection adopt the nonce the chain expects.
  const addr = await wallet.getAddress();
  const nextNonce = async (): Promise<number> => {
    const [latest, pending] = await Promise.all([
      provider.getTransactionCount(addr, "latest"),
      provider.getTransactionCount(addr, "pending"),
    ]);
    return Math.max(latest, pending);
  };
  let nonce = await nextNonce();
  for (const sample of selected) {
    const record = toRecord(snapshot, sample);
    const encoded = encodeRecordCall(record);
    const hash = contentHash(record);
    // Skip reports already anchored on-chain (duplicate content guard), so
    // re-running after a partial submission resumes where it stopped.
    const knownData = registry.encodeFunctionData("isKnownContentHash", [hash]);
    const knownResult = await provider.call({ to: registryAddress, data: knownData });
    if (ethers.AbiCoder.defaultAbiCoder().decode(["bool"], knownResult)[0]) {
      console.log(`skipped     ${sample.pair} (content hash ${hash.slice(0, 10)}... already on-chain)`);
      continue;
    }
    const tx = await registry.encodeFunctionData("record", encoded.args);
    let receipt;
    for (let attempt = 0; ; attempt++) {
      try {
        receipt = await wallet.sendTransaction({ to: registryAddress, data: tx, nonce: nonce++ });
        break;
      } catch (e) {
        const m = /invalid nonce; got (\d+), expected (\d+) or higher/.exec(String(e));
        if (m && attempt < 3) {
          nonce = Number.parseInt(m[2], 10);
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        throw e;
      }
    }
    console.log(`submitted ${sample.pair} hash=${hash.slice(0, 10)}... tx=${receipt!.hash}`);
    const done = await receipt!.wait();
    if (done?.status !== 1) {
      console.error(`reverted: ${sample.pair} tx ${receipt!.hash}`);
      process.exit(1);
    }
    // resync after confirmation in case the account had queued transactions
    nonce = await nextNonce();
    console.log(`confirmed   ${sample.pair} block=${done.blockNumber} gas=${done.gasUsed}`);
    console.log(`verify: ${config.network.explorerUrl}/tx/${receipt!.hash}`);
  }
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  // Defensive: drop any line that looks like a private key before printing.
  console.error(msg.replace(/0x[0-9a-fA-F]{64}/g, "0x[redacted]"));
  process.exit(1);
});
