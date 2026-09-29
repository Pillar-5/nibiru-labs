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
          out[symbol] = {
            usd,
            lastTradeIso: typeof j?.data?.time === "string" ? j.data.time : nowIso(),
          };
        }
      } catch {
        /* symbol not listed; leave unresolved for the next provider */
      }
    }
    if (Object.keys(out).length === 0) throw new ReferenceUnavailableError("coinbase returned no quotes");
    return out;
  },
};

const KRAKEN_PAIR: Record<string, string> = {
  BTC: "XBTUSD",
  ETH: "ETHUSD",
  USDC: "USDCUSD",
  // NIBI: not listed on Kraken; falls through to CoinGecko`n
};

/** Result keys come back as "XETHZUSD"/"ETHUSD" etc.; match them back to symbols. */
function krakenMatchKey(symbol: string): string {
  const pair = KRAKEN_PAIR[symbol] ?? `${symbol}USD`;
  // Kraken returns the queried pair name, or an XXBTZUSD-style alias.
  return pair.replace("XBT", "XXBT").replace("USD", "ZUSD");
}

export const krakenProvider: ReferenceProvider = {
  name: "kraken",
  async fetch(symbols) {
    const known = symbols.filter((s) => KRAKEN_PAIR[s]); if (known.length === 0) throw new ReferenceUnavailableError("no kraken-listed symbols requested"); const pairs = known.map((s) => KRAKEN_PAIR[s]);
    const url = `https://api.kraken.com/0/public/Ticker?pair=${pairs.join(",")}`;
    const j = await getJson(url);
    if (!j?.result) {
      throw new ReferenceUnavailableError(`kraken error: ${JSON.stringify(j?.error ?? "no result")}`);
    }
    const out: Record<string, ReferenceHit> = {};
    const resultKeys = Object.keys(j.result);
    for (const symbol of symbols) {
      const wanted = KRAKEN_PAIR[symbol] ?? `${symbol}USD`;
      const key =
        resultKeys.find((k) => k === wanted || k === krakenMatchKey(symbol)) ??
        resultKeys.find((k) => k.endsWith(wanted));
      const entry = key ? j.result[key] : undefined;
      const last = Number.parseFloat(entry?.c?.[0]);
      const timeSec = Number(entry?.t?.[0]);
      if (Number.isFinite(last) && last > 0) {
        out[symbol] = {
          usd: last,
          lastTradeIso:
            Number.isFinite(timeSec) && timeSec > 0 ? new Date(timeSec * 1000).toISOString() : nowIso(),
        };
      }
    }
    if (Object.keys(out).length === 0) throw new ReferenceUnavailableError("kraken returned no quotes");
    return out;
  },
};

export const binanceProvider: ReferenceProvider = {
  name: "binance",
  async fetch(symbols) {
    const list = symbols.map((s) => `${s}USDT`);
    const url = `https://data-api.binance.vision/api/v3/ticker/price?symbols=${encodeURIComponent(
      JSON.stringify(list),
    )}`;
    const j = await getJson(url);
    if (!Array.isArray(j)) throw new ReferenceUnavailableError("unexpected binance response shape");
    const out: Record<string, ReferenceHit> = {};
    for (const entry of j) {
      const pairSymbol = String(entry?.symbol ?? "");
      const canonical = symbols.find((s) => pairSymbol === `${s}USDT`);
      const usd = Number.parseFloat(entry?.price);
      if (canonical && Number.isFinite(usd) && usd > 0) {
        out[canonical] = { usd, note: "USDT-quoted (not USD)" };
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
        quotes[denom] = {
          denom,
          symbol,
          usd: hit.usd,
          source: provider.name,
          retrievedAt: nowIso(),
          upstreamLastUpdate: hit.lastTradeIso ?? nowIso(),
          note: hit.note,
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
