/**
 * Independent reference prices.
 *
 * To judge whether the on-chain oracle is behaving, the monitor compares each
 * oracle exchange rate with prices produced outside Nibiru. References are
 * fetched from public exchange endpoints -- no API keys required -- and tried
 * in a configurable order so a single provider outage or rate limit does not
 * blind the monitor.
 *
 * Every quote records its provenance (provider, retrieval time, upstream
 * trade time) so results stay auditable:
 *
 *   Coinbase spot   https://docs.cdp.coinbase.com  GET /v2/prices/{BASE}-USD/spot
 *   Kraken ticker   https://docs.kraken.com/api    GET /0/public/Ticker?pair=
 *   Binance public data mirror  https://data-api.binance.vision/api/v3/ticker/price
 *   CoinGecko       https://docs.coingecko.com/reference/simple-price
 *
 * Binance quotes are USDT-quoted; the quote stablecoin is itself oracle-priced,
 * so Binance is ordered last and flagged in quote metadata.
 *
 * Only CoinGecko reports a true upstream trade time. Coinbase's spot endpoint
 * carries no timestamp and Kraken's public ticker has none either, so for those
 * providers `upstreamLastUpdate` mirrors the retrieval time and the quote says
 * so in its note instead of implying a trade time that was never reported.
 */

export interface ReferenceQuote {
  /** Nibiru base denom this quote prices, e.g. "ueth" */
  denom: string;
  /** canonical symbol, e.g. "ETH" */
  symbol: string;
  /** spot price in USD (or USDT for the Binance provider) */
  usd: number;
  /** which provider answered */
  source: string;
  /** ISO timestamp of retrieval */
  retrievedAt: string;
  /** ISO timestamp the provider reports for the underlying trade data */
  upstreamLastUpdate: string;
  /** caveat that applies to this quote, e.g. USDT-quoted */
  note?: string;
}

export class ReferenceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReferenceUnavailableError";
  }
}

export interface ReferenceHit {
  usd: number;
  lastTradeIso?: string;
  note?: string;
}

export interface ReferenceProvider {
  readonly name: string;
  /** fetch USD quotes for canonical symbols; throws when unavailable */
  fetch(symbols: string[]): Promise<Record<string, ReferenceHit>>;
}

const nowIso = () => new Date().toISOString();

async function getJson(url: string, init?: RequestInit): Promise<any> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (e) {
    throw new ReferenceUnavailableError(`${(e as Error).message} (${url})`);
  }
  if (response.status === 429) throw new ReferenceUnavailableError(`rate limited (HTTP 429) (${url})`);
  if (!response.ok) throw new ReferenceUnavailableError(`HTTP ${response.status} (${url})`);
  return response.json();
}

export const coinbaseProvider: ReferenceProvider = {
  name: "coinbase",
  async fetch(symbols) {
    const out: Record<string, ReferenceHit> = {};
    // Coinbase spot is per-symbol; sequential requests stay within free limits.
    for (const symbol of symbols) {
      const url = `https://api.coinbase.com/v2/prices/${encodeURIComponent(symbol)}-USD/spot`;
      try {
        const j = await getJson(url);
        const usd = Number.parseFloat(j?.data?.amount);
        if (Number.isFinite(usd) && usd > 0) {
          // The /spot payload is {amount, base, currency} only: it carries no
          // timestamp, so no upstream trade time is reported for Coinbase
          // quotes (fetchReferences then mirrors the retrieval time and says
          // so in the quote note).
          out[symbol] = { usd };
        }
      } catch {
        /* symbol not listed; leave unresolved for the next provider */
      }
    }
    if (Object.keys(out).length === 0) throw new ReferenceUnavailableError("coinbase returned no quotes");
    return out;
  },
};

/**
 * Kraken's Ticker result keys use legacy aliases ("XETHZUSD" for ETHUSD,
 * "XXBTZUSD" for XBTUSD), so both the request and the response need mapping.
 */
const KRAKEN_PAIRS: Record<string, string[]> = {
  BTC: ["XBTUSD", "XXBTZUSD"],
  ETH: ["ETHUSD", "XETHZUSD"],
  USDC: ["USDCUSD"],
  // NIBI is not listed on Kraken; it falls through to later providers.
};

/** "XETHZUSD" -> "ETHUSD", "XXBTZUSD" -> "XBTUSD", "USDCUSD" -> "USDCUSD". */
export function normalizeKrakenKey(key: string): string {
  let k = key.toUpperCase();
  if (k.endsWith("ZUSD")) k = k.slice(0, -4) + "USD";
  if (k.startsWith("XX")) return "X" + k.slice(2);
  if (k.startsWith("X")) return k.slice(1);
  return k;
}

export const krakenProvider: ReferenceProvider = {
  name: "kraken",
  async fetch(symbols) {
    const known = symbols.filter((s) => KRAKEN_PAIRS[s]);
    if (known.length === 0) throw new ReferenceUnavailableError("no kraken-listed symbols requested");
    const out: Record<string, ReferenceHit> = {};
    for (const symbol of known) {
      // One request per pair, per alias. A single unsupported pair makes the
      // batched Ticker endpoint fail the whole call ("EQuery:Unknown asset
      // pair" was observed against a multi-pair request), so pairs are queried
      // individually and failures are left for the next provider.
      for (const pair of KRAKEN_PAIRS[symbol]) {
        try {
          const j = await getJson(`https://api.kraken.com/0/public/Ticker?pair=${pair}`);
          const resultKeys = Object.keys(j?.result ?? {});
          const key = resultKeys.find((k) => normalizeKrakenKey(k) === pair);
          const entry = key ? j.result[key] : undefined;
          const last = Number.parseFloat(entry?.c?.[0]);
          if (Number.isFinite(last) && last > 0) {
            // No trade timestamp: the Ticker `t` field is a trade count, not a
            // time (parsing it as one produced 1970 timestamps), so no
            // upstreamLastUpdate is reported for Kraken quotes.
            out[symbol] = { usd: last };
            break;
          }
        } catch {
          /* try the next alias for this symbol */
        }
      }
    }
    if (Object.keys(out).length === 0) throw new ReferenceUnavailableError("kraken returned no quotes");
    return out;
  },
};

export const binanceProvider: ReferenceProvider = {
  name: "binance",
  async fetch(symbols) {
    const out: Record<string, ReferenceHit> = {};
    for (const symbol of symbols) {
      // Binance USDT pairs are requested one at a time: the batched `symbols`
      // form of this endpoint answers HTTP 400 for the whole request when any
      // one symbol is unlisted (observed with NIBI), which would otherwise
      // disable this provider entirely.
      const url = `https://data-api.binance.vision/api/v3/ticker/price?symbol=${encodeURIComponent(
        `${symbol}USDT`,
      )}`;
      try {
        const j = await getJson(url);
        const usd = Number.parseFloat(j?.price);
        if (Number.isFinite(usd) && usd > 0) {
          out[symbol] = { usd, note: "USDT-quoted (not USD)" };
        }
      } catch {
        /* symbol not listed on Binance; leave it for the next provider */
      }
    }
    if (Object.keys(out).length === 0) throw new ReferenceUnavailableError("binance returned no quotes");
    return out;
  },
};

/** CoinGecko ids for canonical symbols; an optional demo key raises rate limits. */
const COINGECKO_ID: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  USDC: "usd-coin",
  NIBI: "nibiru",
};

export function coingeckoProvider(apiKey?: string): ReferenceProvider {
  return {
    name: "coingecko",
    async fetch(symbols) {
      const ids = symbols.map((s) => COINGECKO_ID[s]).filter(Boolean);
      if (ids.length === 0) throw new ReferenceUnavailableError("no coingecko id mapping for requested symbols");
      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(
        ids.join(","),
      )}&vs_currencies=usd&include_last_updated_at=true`;
      const headers: Record<string, string> = { accept: "application/json" };
      if (apiKey) headers["x-cg-demo-api-key"] = apiKey;
      const j = await getJson(url, { headers });
      const out: Record<string, ReferenceHit> = {};
      for (const symbol of symbols) {
        const id = COINGECKO_ID[symbol];
        const v = id ? j?.[id] : undefined;
        const usd = Number(v?.usd);
        if (Number.isFinite(usd) && usd > 0) {
          const ts = Number(v?.last_updated_at);
          out[symbol] = {
            usd,
            lastTradeIso: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000).toISOString() : nowIso(),
          };
        }
      }
      if (Object.keys(out).length === 0) throw new ReferenceUnavailableError("coingecko returned no quotes");
      return out;
    },
  };
}

/** Extract the base denom from an oracle pair like "ueth:uusd" -> "ueth". */
export function baseDenom(pair: string): string {
  const [base] = pair.split(":");
  if (!base) throw new Error(`invalid pair format: ${pair}`);
  return base;
}

export interface ReferenceOptions {
  /** provider order; earlier providers win for symbols they resolve */
  providers: ReferenceProvider[];
  /** base denom -> canonical symbol (e.g. ueth -> ETH) */
  symbols: Record<string, string>;
}

/**
 * Fetch reference quotes for every configured base denom, falling through the
 * provider list so partial failures per provider are tolerated. Returns quotes
 * keyed by base denom plus human-readable notes for provider failures.
 */
export async function fetchReferences(
  denoms: string[],
  options: ReferenceOptions,
): Promise<{ quotes: Record<string, ReferenceQuote>; notes: string[] }> {
  const quotes: Record<string, ReferenceQuote> = {};
  const notes: string[] = [];
  const unresolved = new Set(denoms.filter((d) => options.symbols[d]));

  for (const provider of options.providers) {
    if (unresolved.size === 0) break;
    const symbols = [...unresolved].map((d) => options.symbols[d]);
    try {
      const partial = await provider.fetch(symbols);
      for (const denom of [...unresolved]) {
        const symbol = options.symbols[denom];
        const hit = partial[symbol];
        if (!hit) continue;
        const retrievedAt = nowIso();
        // Provenance note: when a provider does not report an upstream trade
        // time, say so rather than presenting the retrieval time as one.
        const note = [
          hit.note,
          hit.lastTradeIso
            ? undefined
            : `no upstream trade time from ${provider.name}; upstreamLastUpdate mirrors retrievedAt`,
        ]
          .filter(Boolean)
          .join("; ");
        quotes[denom] = {
          denom,
          symbol,
          usd: hit.usd,
          source: provider.name,
          retrievedAt,
          upstreamLastUpdate: hit.lastTradeIso ?? retrievedAt,
          note: note.length > 0 ? note : undefined,
        };
        unresolved.delete(denom);
      }
    } catch (e) {
      notes.push(`reference ${provider.name} unavailable: ${(e as Error).message}`);
    }
  }
  if (unresolved.size > 0) {
    notes.push(`no independent reference for: ${[...unresolved].join(", ")}`);
  }
  return { quotes, notes };
}
