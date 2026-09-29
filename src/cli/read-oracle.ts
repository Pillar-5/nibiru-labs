/**
 * Print live oracle readings from the configured Nibiru network.
 * Read-only: no wallet, no private key, no transactions.
 */
import { loadConfig } from "../config.ts";
import { OracleReader } from "../oracle/precompile.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const reader = new OracleReader(
    config.network.rpcUrl,
    config.oracle.precompile,
    config.network.chainId,
  );
  console.log(`network ${config.network.name} chainId ${config.network.chainId} block ${await reader.blockNumber()}`);
  for (const pair of config.oracle.pairs) {
    try {
      const r = await reader.readPair(pair);
      console.log(
        `${pair.padEnd(12)} rate=${r.rate} oracle_block=${r.updateBlockHeight} age_s=${((Date.now() - Number(r.updateBlockTimestampMs)) / 1000).toFixed(0)}`,
      );
    } catch (e) {
      console.log(`${pair.padEnd(12)} ERROR ${(e as Error).message}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
