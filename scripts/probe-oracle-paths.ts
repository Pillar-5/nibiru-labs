/**
 * Probe every documented oracle read path on the configured Nibiru network and
 * print what actually answers. Read-only: no wallet, no transactions.
 *
 * Nibiru exposes the native oracle to the EVM in two shapes from the same
 * precompile address:
 *
 *   1. queryExchangeRate(string)            -> (uint256 rate18, uint64 tsMs, uint64 height)
 *   2. chainLinkLatestRoundData(string)     -> (uint80 roundId, int256 answer, ...)
 *
 * Nibiru's docs additionally list standalone "ChainLink Aggregator" contracts
 * (8 decimals) for some feed symbols. Whether those addresses hold code depends
 * on the network, so this script reports `eth_getCode` per address as well as
 * whether the call answers. Run it on both networks to see the difference:
 *
 *   NIBIRU_NETWORK=testnet-2 npm run oracle:probe
 *   NIBIRU_NETWORK=mainnet  npm run oracle:probe
 *
 * Findings recorded with this script are documented in docs/research.md.
 */
import "dotenv/config";
import { ethers } from "ethers";
import { loadConfig } from "../src/config.ts";
import { OracleReader } from "../src/oracle/precompile.ts";

/** Aggregator addresses published in the Nibiru docs (mainnet addresses). */
const DOCUMENTED_AGGREGATORS: Record<string, string> = {
  "ueth:uusd": "0x63b8426F71C3eDbF15A55EeA4915625892Ea9A4c",
  "unibi:uusd": "0xb15F7a4b9AD2db05D91f06df9eA7D56EBe8e6B27",
  "ubtc:uusd": "0xc8FD30cA96B6D120Fc7646108E11c13E8bb128Eb",
  "uusdc:uusd": "0xBecDA6de445178B3D45aa710F5fB09F72E3e1340",
  "uusdt:uusd": "0x86C6814Aa44fA22f7B9e0FCEC6F9de6012F322f8",
};

const AGGREGATOR_IFACE = new ethers.Interface([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
]);

interface RpcResult {
  result?: string;
  error?: { message?: string };
}

async function rpc(url: string, method: string, params: unknown[]): Promise<RpcResult> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await res.json()) as RpcResult;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const { rpcUrl, chainId, name } = config.network;
  const reader = new OracleReader(rpcUrl, config.oracle.precompile, chainId);

  console.log(`network:   ${name} (chainId ${chainId})`);
  console.log(`rpc:       ${rpcUrl}`);
  console.log(`precompile:${config.oracle.precompile}`);
  console.log(`block:     ${await reader.blockNumber()}\n`);

  for (const pair of config.oracle.pairs) {
    console.log(pair);
    try {
      const r = await reader.readPair(pair);
      console.log(
        `  queryExchangeRate          ok  rate18=${r.rate} updateBlock=${r.updateBlockHeight} age_s=${(
          (Date.now() - Number(r.updateBlockTimestampMs)) / 1000
        ).toFixed(0)}`,
      );
    } catch (e) {
      console.log(`  queryExchangeRate          FAIL ${(e as Error).message}`);
    }
    try {
      const c = await reader.readChainLinkRound(pair);
      console.log(
        `  chainLinkLatestRoundData   ok  answer18=${ethers.formatUnits(c.answer, 18)} round=${c.roundId} updatedAt=${new Date(
          Number(c.updatedAt) * 1000,
        ).toISOString()}`,
      );
    } catch (e) {
      console.log(`  chainLinkLatestRoundData   FAIL ${(e as Error).message}`);
    }

    const aggregator = DOCUMENTED_AGGREGATORS[pair];
    if (!aggregator) {
      console.log("  documented aggregator      (none published for this pair)");
      console.log();
      continue;
    }
    const code = await rpc(rpcUrl, "eth_getCode", [aggregator, "latest"]);
    const byteLength = code.result ? (code.result.length - 2) / 2 : 0;
    if (byteLength === 0) {
      console.log(`  documented aggregator      ${aggregator} has no code on this network`);
      console.log();
      continue;
    }
    const decimals = await rpc(rpcUrl, "eth_call", [
      { to: aggregator, data: AGGREGATOR_IFACE.getFunction("decimals")!.selector },
      "latest",
    ]);
    const description = await rpc(rpcUrl, "eth_call", [
      { to: aggregator, data: AGGREGATOR_IFACE.getFunction("description")!.selector },
      "latest",
    ]);
    const round = await rpc(rpcUrl, "eth_call", [
      { to: aggregator, data: AGGREGATOR_IFACE.getFunction("latestRoundData")!.selector },
      "latest",
    ]);
    const dec = decimals.result
      ? ethers.AbiCoder.defaultAbiCoder().decode(["uint8"], decimals.result)[0]
      : "?";
    const desc = description.result
      ? ethers.AbiCoder.defaultAbiCoder().decode(["string"], description.result)[0]
      : "?";
    if (round.result) {
      const d = ethers.AbiCoder.defaultAbiCoder().decode(
        ["uint80", "int256", "uint256", "uint256", "uint80"],
        round.result,
      );
      console.log(
        `  documented aggregator      ${aggregator} code=${byteLength}b decimals=${dec} latestRoundData ok answer=${
          d[1]
        } updatedAt=${new Date(Number(d[3]) * 1000).toISOString()} "${desc}"`,
      );
    } else {
      console.log(`  documented aggregator      ${aggregator} latestRoundData FAIL ${round.error?.message}`);
    }
    console.log();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
