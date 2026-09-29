/**
 * Sample collection: reads every configured pair from the Nibiru oracle
 * precompile, fetches the matching independent reference quotes, and runs the
 * integrity analysis over each pair. This is the product's data pipeline --
 * one call produces one monitoring snapshot.
 */

import { loadConfig, type AppConfig } from "./config.ts";
import { OracleReader, type OracleReading } from "./oracle/precompile.ts";
import {
  baseDenom,
  binanceProvider,
  coingeckoProvider,
  coinbaseProvider,
  fetchReferences,
  krakenProvider,
  type ReferenceProvider,
  type ReferenceQuote,
} from "./oracle/reference.ts";
import { analyze, type Sample } from "./analysis/integrity.ts";

const PROVIDER_REGISTRY: Record<string, ReferenceProvider> = {
  coinbase: coinbaseProvider,
  kraken: krakenProvider,
  binance: binanceProvider,
};

export interface Snapshot {
  network: string;
  chainId: number;
  /** EVM block the oracle reads were anchored to */
  block: number;
  collectedAt: string;
  samples: Sample[];
  /** non-fatal problems encountered while collecting (e.g. reference outage) */
  notes: string[];
}

export async function collectSnapshot(config: AppConfig = loadConfig()): Promise<Snapshot> {
  const reader = new OracleReader(
    config.network.rpcUrl,
    config.oracle.precompile,
    config.network.chainId,
  );
  const notes: string[] = [];

  // Oracle readings, one per configured pair. A revert on one pair (e.g. the
  // uusd base pair itself, which the oracle module rejects as an unsupported
  // legacy symbol) is recorded and does not abort the snapshot.
  const readings = new Map<string, OracleReading | null>();
  for (const pair of config.oracle.pairs) {
    try {
      readings.set(pair, await reader.readPair(pair));
    } catch (e) {
      readings.set(pair, null);
      notes.push(`oracle read failed for ${pair}: ${(e as Error).message}`);
    }
  }

  // Independent reference quotes for the pairs that have a symbol mapping.
  const denomsWithSymbols = config.oracle.pairs
    .map((p) => baseDenom(p))
    .filter((d) => config.reference.symbols[d]);
  let quotes: Record<string, ReferenceQuote> = {};
  if (denomsWithSymbols.length > 0) {
    const providers = config.reference.providers.map((name) => {
      if (name === "coingecko") return coingeckoProvider(config.reference.coingeckoApiKey);
      const provider = PROVIDER_REGISTRY[name];
      if (!provider) throw new Error(`unknown reference provider "${name}"`);
      return provider;
    });
    const fetched = await fetchReferences(denomsWithSymbols, {
      providers,
      symbols: config.reference.symbols,
    });
    quotes = fetched.quotes;
    notes.push(...fetched.notes);
  }

  const block = await reader.blockNumber().catch(() => 0);

  const samples: Sample[] = [];
  for (const pair of config.oracle.pairs) {
    const reading = readings.get(pair) ?? null;
    const denom = baseDenom(pair);
    const quote = quotes[denom] ?? null;
    samples.push(
      analyze(pair, config.network.chainId, reading, quote, config.thresholds),
    );
  }

  const anchor = samples.find((s) => s.oracleBlock !== null);
  return {
    network: config.network.name,
    chainId: config.network.chainId,
    block: anchor?.oracleBlock ?? block,
    collectedAt: new Date().toISOString(),
    samples,
    notes,
  };
}
