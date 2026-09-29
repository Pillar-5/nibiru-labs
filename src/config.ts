import "dotenv/config";

/** Built-in network presets. Override any field with NIBIRU_* env vars. */
export const NETWORK_PRESETS = {
  "testnet-2": {
    name: "Nibiru Testnet-2",
    rpcUrl: "https://evm-rpc.testnet-2.nibiru.fi",
    chainId: 6911,
    explorerUrl: "https://testnet.nibiscan.io",
    nativeCurrency: { name: "NIBI", symbol: "NIBI", decimals: 18 },
  },
  mainnet: {
    name: "Nibiru Mainnet",
    rpcUrl: "https://evm-rpc.nibiru.fi",
    chainId: 6900,
    explorerUrl: "https://nibiscan.io",
    nativeCurrency: { name: "NIBI", symbol: "NIBI", decimals: 18 },
  },
} as const;

export type NetworkName = keyof typeof NETWORK_PRESETS;

export interface NetworkConfig {
  name: string;
  rpcUrl: string;
  chainId: number;
  explorerUrl: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
}

export interface Thresholds {
  maxOracleAgeSeconds: number;
  deviationWarnBps: number;
  deviationCriticalBps: number;
}

export interface OracleConfig {
  precompile: string;
  /** Pairs in oracle-module format, e.g. "unibi:uusd" */
  pairs: string[];
}

export interface ReferenceConfig {
  /** base denom -> canonical market symbol (e.g. ueth -> ETH) */
  symbols: Record<string, string>;
  /** provider order, e.g. "coinbase,kraken,binance,coingecko" */
  providers: string[];
  /** optional CoinGecko demo key to raise rate limits */
  coingeckoApiKey?: string;
}

export interface AppConfig {
  network: NetworkConfig;
  oracle: OracleConfig;
  reference: ReferenceConfig;
  thresholds: Thresholds;
  stateFile: string;
  apiPort: number;
}

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable ${name}`);
  }
  return v;
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`Environment variable ${name} is not an integer`);
  return n;
}

/** Parse "unibi:uusd,ueth:uusd" into an array of pairs. */
export function parsePairs(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Parse "ueth=ethereum,ubtc=bitcoin" into a denom -> id map. */
export function parseIdMap(raw: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const entry of raw.split(",")) {
    const t = entry.trim();
    if (!t) continue;
    const idx = t.indexOf("=");
    if (idx <= 0) throw new Error(`Invalid id mapping entry: "${entry}" (expected denom=id)`);
    map[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
  }
  return map;
}

export function loadConfig(): AppConfig {
  const networkName = env("NIBIRU_NETWORK", "testnet-2") as NetworkName;
  const preset = NETWORK_PRESETS[networkName];
  if (!preset && !(process.env.NIBIRU_RPC_URL && process.env.NIBIRU_CHAIN_ID)) {
    throw new Error(
      `Unknown NIBIRU_NETWORK "${networkName}". Use one of ${Object.keys(NETWORK_PRESETS).join(", ")} or set NIBIRU_RPC_URL and NIBIRU_CHAIN_ID.`,
    );
  }
  const base: NetworkConfig = preset
    ? { ...preset }
    : {
        name: "custom",
        rpcUrl: "",
        chainId: 0,
        explorerUrl: "",
        nativeCurrency: { name: "NIBI", symbol: "NIBI", decimals: 18 },
      };

  const network: NetworkConfig = {
    name: process.env.NIBIRU_NETWORK_NAME ?? base.name,
    rpcUrl: env("NIBIRU_RPC_URL", base.rpcUrl),
    chainId: envInt("NIBIRU_CHAIN_ID", base.chainId),
    explorerUrl: env("NIBIRU_EXPLORER_URL", base.explorerUrl),
    nativeCurrency: base.nativeCurrency,
  };

  return {
    network,
    oracle: {
      precompile: env("NIBIRU_ORACLE_PRECOMPILE", "0x0000000000000000000000000000000000000801"),
      pairs: parsePairs(env("NIBIRU_ORACLE_PAIRS", "unibi:uusd,ueth:uusd,ubtc:uusd,uusdc:uusd")),
    },
    reference: {
      symbols: parseIdMap(env("REFERENCE_SYMBOLS", "unibi=NIBI,ueth=ETH,ubtc=BTC,uusdc=USDC")),
      providers: env("REFERENCE_PROVIDERS", "coinbase,kraken,binance,coingecko")
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean),
      coingeckoApiKey: process.env.COINGECKO_API_KEY || undefined,
    },
    thresholds: {
      maxOracleAgeSeconds: envInt("MAX_ORACLE_AGE_SECONDS", 60),
      deviationWarnBps: envInt("DEVIATION_WARN_BPS", 50),
      deviationCriticalBps: envInt("DEVIATION_CRITICAL_BPS", 200),
    },
    stateFile: env("STATE_FILE", "data/state.jsonl"),
    apiPort: envInt("API_PORT", 8787),
  };
}
