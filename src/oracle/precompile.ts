import { ethers } from "ethers";

/**
 * Reads exchange rates from the Nibiru native oracle precompile.
 *
 * Nibiru exposes its on-chain oracle (the same values the oracle module
 * aggregates from validator votes, denominated in micro-stable units) to EVM
 * contracts through a precompile. EVM consumers read it with
 * `queryExchangeRate(string pair)`. This module calls the precompile directly
 * over `eth_call`, which is the exact code path an on-chain DeFi contract
 * follows when it consumes oracle prices -- so an anomaly visible here is an
 * anomaly that on-chain consumers would actually act on.
 *
 * Verified against Nibiru Testnet-2 and mainnet public RPC endpoints; the ABI
 * and precompile address are the ones published in the Nibiru docs
 * (https://docs.nibiru.fi).
 */

export const ORACLE_ABI = [
  "function queryExchangeRate(string pair) view returns (uint256 exchange_rate, uint64 update_block_timestamp_ms, uint64 update_block_height)",
];

/**
 * ChainLink-shaped read path on the same precompile. Verified on Testnet-2 and
 * mainnet: `round_id` is the oracle update block height and `answer` carries the
 * same 18-decimal value as queryExchangeRate. Note that the standalone
 * AggregatorV3 contracts published in the Nibiru docs answer with 8 decimals on
 * mainnet and are not deployed on Testnet-2 (see docs/research.md).
 */
export const ORACLE_CHAINLINK_ABI = [
  "function chainLinkLatestRoundData(string pair) view returns (uint80 round_id, int256 answer, uint256 started_at, uint256 updated_at, uint80 answered_in_round)",
];

export interface OracleReading {
  /** oracle-module pair, e.g. "unibi:uusd" */
  pair: string;
  /** raw exchange rate in 18 decimals, as returned by the precompile */
  rawRate: bigint;
  /** human-readable exchange rate (base per quote; uusd pairs ~= USD) */
  rate: number;
  /** block timestamp (ms) of the oracle vote the value came from */
  updateBlockTimestampMs: bigint;
  /** block height of the oracle vote the value came from */
  updateBlockHeight: bigint;
  /** EVM block number at which the read was performed */
  queriedAtBlock: number;
  /** UTC ISO timestamp of when this read was performed */
  queriedAt: string;
  /** chain id the read was performed against */
  chainId: number;
}

export function decodeExchangeRate(result: string): {
  exchangeRate: bigint;
  updateBlockTimestampMs: bigint;
  updateBlockHeight: bigint;
} {
  const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
    ["uint256", "uint64", "uint64"],
    result,
  );
  return {
    exchangeRate: decoded[0] as bigint,
    updateBlockTimestampMs: BigInt(decoded[1] as bigint),
    updateBlockHeight: BigInt(decoded[2] as bigint),
  };
}

export class OracleReader {
  private readonly iface = new ethers.Interface(ORACLE_ABI);

  constructor(
    private readonly rpcUrl: string,
    private readonly precompile: string,
    private readonly chainId: number,
  ) {}

  /**
   * Compute the 4-byte selector for queryExchangeRate(string) once.
   * Selector is 0x6bd1902f; asserted by tests/contract.test.ts so a silent ABI
   * edit cannot change what this client calls.
   */
  private get selector(): string {
    return this.iface.getFunction("queryExchangeRate")!.selector;
  }

  encodeCall(pair: string): string {
    return this.selector + ethers.AbiCoder.defaultAbiCoder().encode(["string"], [pair]).slice(2);
  }

  /**
   * Read one pair. Throws if the precompile reverts (unknown pair, oracle
   * module not producing data for that pair, unsupported legacy symbol...).
   */
  async readPair(pair: string): Promise<OracleReading> {
    const response = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: this.precompile, data: this.encodeCall(pair) }, "latest"],
      }),
    });
    if (!response.ok) {
      throw new Error(`RPC HTTP ${response.status} while reading ${pair}`);
    }
    const json = (await response.json()) as {
      result?: string;
      error?: { message?: string };
    };
    if (json.error) {
      throw new Error(`oracle precompile reverted for ${pair}: ${json.error.message}`);
    }
    if (!json.result) {
      throw new Error(`oracle precompile returned no data for ${pair}`);
    }
    const decoded = decodeExchangeRate(json.result);
    const blockNumberRaw = await this.blockNumber();
    return {
      pair,
      rawRate: decoded.exchangeRate,
      rate: Number(ethers.formatUnits(decoded.exchangeRate, 18)),
      updateBlockTimestampMs: decoded.updateBlockTimestampMs,
      updateBlockHeight: decoded.updateBlockHeight,
      queriedAtBlock: blockNumberRaw,
      queriedAt: new Date().toISOString(),
      chainId: this.chainId,
    };
  }

  async readAll(pairs: string[]): Promise<OracleReading[]> {
    // Sequential with small spacing keeps load on public RPC endpoints polite.
    const out: OracleReading[] = [];
    for (const pair of pairs) {
      out.push(await this.readPair(pair));
    }
    return out;
  }

  /**
   * Read the precompile's ChainLink-shaped path for one pair. Used by
   * `npm run oracle:probe` to compare the two documented read paths; the
   * monitor itself uses readPair (18-decimal rate + millisecond timestamp +
   * update block height).
   */
  async readChainLinkRound(pair: string): Promise<{
    roundId: bigint;
    answer: bigint;
    startedAt: bigint;
    updatedAt: bigint;
    answeredInRound: bigint;
  }> {
    const iface = new ethers.Interface(ORACLE_CHAINLINK_ABI);
    const data = iface.getFunction("chainLinkLatestRoundData")!.selector +
      ethers.AbiCoder.defaultAbiCoder().encode(["string"], [pair]).slice(2);
    const response = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: this.precompile, data }, "latest"],
      }),
    });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status} while reading ${pair}`);
    const json = (await response.json()) as { result?: string; error?: { message?: string } };
    if (json.error) throw new Error(`precompile reverted for ${pair}: ${json.error.message}`);
    if (!json.result) throw new Error(`precompile returned no data for ${pair}`);
    const d = ethers.AbiCoder.defaultAbiCoder().decode(
      ["uint80", "int256", "uint256", "uint256", "uint80"],
      json.result,
    );
    return {
      roundId: BigInt(d[0] as bigint),
      answer: BigInt(d[1] as bigint),
      startedAt: BigInt(d[2] as bigint),
      updatedAt: BigInt(d[3] as bigint),
      answeredInRound: BigInt(d[4] as bigint),
    };
  }

  async blockNumber(): Promise<number> {
    const response = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
    });
    const json = (await response.json()) as { result?: string };
    if (!json.result) throw new Error("could not read eth_blockNumber");
    return Number(BigInt(json.result));
  }
}
