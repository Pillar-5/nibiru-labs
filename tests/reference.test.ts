import { describe, expect, it } from "vitest";
import {
  ReferenceUnavailableError,
  fetchReferences,
  normalizeKrakenKey,
  type ReferenceHit,
  type ReferenceProvider,
} from "../src/oracle/reference.ts";

/** Provider stub: resolves the given symbols, otherwise reports unavailability. */
function provider(
  name: string,
  hits: Record<string, ReferenceHit>,
  options: { fail?: boolean } = {},
): ReferenceProvider {
  return {
    name,
    async fetch(symbols) {
      if (options.fail) throw new ReferenceUnavailableError(`${name} is down`);
      const out: Record<string, ReferenceHit> = {};
      for (const s of symbols) if (hits[s]) out[s] = hits[s];
      if (Object.keys(out).length === 0) throw new ReferenceUnavailableError(`${name} returned no quotes`);
      return out;
    },
  };
}

const symbols = { ueth: "ETH", ubtc: "BTC", unibi: "NIBI" };

describe("fetchReferences", () => {
  it("falls through providers per symbol so one outage does not blind the monitor", async () => {
    const { quotes, notes } = await fetchReferences(["ueth", "ubtc", "unibi"], {
      providers: [
        provider("first", { ETH: { usd: 3000 } }, { fail: true }),
        provider("second", { ETH: { usd: 3001 }, BTC: { usd: 90000 } }),
        provider("third", { NIBI: { usd: 0.0005 } }),
      ],
      symbols,
    });
    expect(quotes.ueth).toMatchObject({ source: "second", usd: 3001 });
    expect(quotes.ubtc).toMatchObject({ source: "second", usd: 90000 });
    expect(quotes.unibi).toMatchObject({ source: "third", usd: 0.0005 });
    expect(notes.some((n) => n.includes("first unavailable"))).toBe(true);
    expect(notes.some((n) => n.includes("no independent reference"))).toBe(false);
  });

  it("keeps the earliest provider that resolves a symbol", async () => {
    const { quotes } = await fetchReferences(["ueth"], {
      providers: [provider("first", { ETH: { usd: 3000 } }), provider("second", { ETH: { usd: 1 } })],
      symbols,
    });
    expect(quotes.ueth.source).toBe("first");
    expect(quotes.ueth.usd).toBe(3000);
  });

  it("records unresolved symbols instead of inventing a value", async () => {
    const { quotes, notes } = await fetchReferences(["ueth", "unibi"], {
      providers: [provider("only", { ETH: { usd: 3000 } })],
      symbols,
    });
    expect(quotes.unibi).toBeUndefined();
    expect(notes).toContain("no independent reference for: unibi");
  });

  it("never invents an upstream trade time, and says so in the note", async () => {
    const { quotes } = await fetchReferences(["ueth"], {
      providers: [provider("coinbase-like", { ETH: { usd: 3000 } })],
      symbols,
    });
    const q = quotes.ueth;
    expect(q.upstreamLastUpdate).toBe(q.retrievedAt);
    expect(q.note).toMatch(/no upstream trade time from coinbase-like/);
  });

  it("keeps a provider-reported trade time and merges provider notes", async () => {
    const { quotes } = await fetchReferences(["ueth"], {
      providers: [
        provider("binance-like", {
          ETH: { usd: 3000, lastTradeIso: "2026-01-01T00:00:00.000Z", note: "USDT-quoted (not USD)" },
        }),
      ],
      symbols,
    });
    expect(quotes.ueth.upstreamLastUpdate).toBe("2026-01-01T00:00:00.000Z");
    expect(quotes.ueth.note).toBe("USDT-quoted (not USD)");
  });
});

describe("normalizeKrakenKey", () => {
  it("maps Kraken's legacy response aliases back to plain pair names", () => {
    expect(normalizeKrakenKey("XETHZUSD")).toBe("ETHUSD");
    expect(normalizeKrakenKey("XXBTZUSD")).toBe("XBTUSD");
    expect(normalizeKrakenKey("USDCUSD")).toBe("USDCUSD");
  });
});
