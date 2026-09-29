import { useEffect, useMemo, useState } from "react";

interface Sample {
  pair: string;
  oracleRate: number | null;
  referenceUsd: number | null;
  deviationBps: number | null;
  oracleAgeSeconds: number | null;
  status: "ok" | "warning" | "critical" | "stale" | "unavailable";
  reason: string;
  oracleUpdateBlockHeight: string | null;
}

interface Snapshot {
  network: string;
  chainId: number;
  block: number;
  collectedAt: string;
  samples: Sample[];
  notes: string[];
}

interface StatusResponse {
  snapshots: number;
  latest: Snapshot | null;
  summary: {
    total: number;
    ok: number;
    warning: number;
    critical: number;
    stale: number;
    unavailable: number;
    meanAbsoluteDeviationBps: number | null;
    stddevAbsoluteDeviationBps: number | null;
    maxAbsoluteDeviationBps: number | null;
    breaches: number;
  } | null;
  thresholds: {
    maxOracleAgeSeconds: number;
    deviationWarnBps: number;
    deviationCriticalBps: number;
  };
}

interface Point {
  collectedAt: string;
  block: number;
  pair: string;
  deviationBps: number | null;
  status: string;
}

const COLORS: Record<string, string> = {
  ok: "#1f8f4d",
  warning: "#c98a00",
  critical: "#c0392b",
  stale: "#7a5cc0",
  unavailable: "#8a8f98",
};

const STATUS_LABEL: Record<string, string> = {
  ok: "OK",
  warning: "WARNING",
  critical: "CRITICAL",
  stale: "STALE",
  unavailable: "UNAVAILABLE",
};

function Badge({ status }: { status: string }) {
  return (
    <span
      style={{
        background: COLORS[status] ?? "#8a8f98",
        color: "#fff",
        padding: "2px 8px",
        borderRadius: 10,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 0.4,
      }}
    >
      {STATUS_LABEL[status] ?? status.toUpperCase()}
    </span>
  );
}

function fmt(n: number | null | undefined, digits = 4): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

function DeviationChart({ points, pair }: { points: Point[]; pair: string }) {
  const series = points.filter((p) => p.pair === pair && p.deviationBps !== null);
  if (series.length < 2) {
    return <p className="muted">Collect at least two samples for this pair to see a deviation history.</p>;
  }
  const w = 900;
  const h = 180;
  const pad = 6;
  const values = series.map((p) => p.deviationBps as number);
  const min = Math.min(...values, -1);
  const max = Math.max(...values, 1);
  const span = max - min || 1;
  const x = (i: number) => pad + (i / (series.length - 1)) * (w - 2 * pad);
  const y = (v: number) => h - pad - ((v - min) / span) * (h - 2 * pad);
  const d = series
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.deviationBps as number).toFixed(1)}`)
    .join(" ");
  const zeroY = y(0);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height: "auto", background: "#fbfbfd", borderRadius: 8 }}>
      <line x1={pad} y1={zeroY} x2={w - pad} y2={zeroY} stroke="#c8cdd4" strokeDasharray="4 4" />
      <path d={d} fill="none" stroke="#2f6fdd" strokeWidth={1.6} />
      {series.map((p, i) => (
        <circle key={`${p.collectedAt}-${i}`} cx={x(i)} cy={y(p.deviationBps as number)} r={2.6} fill={COLORS[p.status] ?? "#2f6fdd"} />
      ))}
    </svg>
  );
}

export function App() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [points, setPoints] = useState<Point[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [s, h] = await Promise.all([
          fetch("/api/status").then((r) => r.json()),
          fetch("/api/history?limit=1000").then((r) => r.json()),
        ]);
        if (!cancelled) {
          setStatus(s as StatusResponse);
          setPoints((h.points ?? []) as Point[]);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    };
    load();
    const t = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const latest = status?.latest ?? null;
  const summary = status?.summary ?? null;
  const pairs = useMemo(() => (latest ? latest.samples.map((s) => s.pair) : []), [latest]);
  // Default the chart to the first pair that actually has an independent
  // reference, so the deviation history is populated on load rather than
  // opening on a freshness-only pair.
  const defaultPair = useMemo(() => {
    if (!latest) return null;
    return (
      latest.samples.find((s) => s.referenceUsd !== null)?.pair ??
      latest.samples[0]?.pair ??
      null
    );
  }, [latest]);
  const chartPair = selected && pairs.includes(selected) ? selected : defaultPair;

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 980, margin: "0 auto", padding: 24, color: "#1c2024" }}>
      <header style={{ marginBottom: 8 }}>
        <h1 style={{ margin: 0, fontSize: 26 }}>NibiWatch</h1>
        <p className="muted" style={{ margin: "4px 0 16px" }}>
          Integrity monitoring for the Nibiru native price oracle: on-chain rates vs independent
          reference prices, anchored on-chain.
        </p>
      </header>

      {error && (
        <p style={{ color: "#c0392b" }}>
          API unavailable ({error}). Start the API with <code>npm run api</code> and collect data
          with <code>npm run monitor:once</code>.
        </p>
      )}

      {latest ? (
        <>
          <section style={{ display: "flex", gap: 24, flexWrap: "wrap", fontSize: 13, color: "#5a6068" }}>
            <span>network: <b>{latest.network}</b> (chainId {latest.chainId})</span>
            <span>EVM block: <b>{latest.block}</b></span>
            <span>collected: <b>{new Date(latest.collectedAt).toLocaleString()}</b></span>
            <span>stored snapshots: <b>{status?.snapshots}</b></span>
          </section>

          {latest.notes.length > 0 && (
            <ul style={{ color: "#7a5cc0", fontSize: 13 }}>
              {latest.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}

          <h2 style={{ fontSize: 17, marginTop: 24 }}>Latest integrity report</h2>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "2px solid #dfe3e8" }}>
                <th>pair</th>
                <th>oracle rate</th>
                <th>reference (USD)</th>
                <th>deviation (bps)</th>
                <th>age (s)</th>
                <th>status</th>
              </tr>
            </thead>
            <tbody>
              {latest.samples.map((s) => (
                <tr key={s.pair} style={{ borderBottom: "1px solid #eef0f3" }}>
                  <td>
                    <button onClick={() => setSelected(s.pair)} style={{ background: "none", border: "none", cursor: "pointer", color: "#2f6fdd", padding: 0, fontSize: 13, fontWeight: 600 }}>
                      {s.pair}
                    </button>
                  </td>
                  <td>{fmt(s.oracleRate, 6)}</td>
                  <td>{fmt(s.referenceUsd, 6)}</td>
                  <td>{s.deviationBps === null ? "—" : s.deviationBps.toFixed(1)}</td>
                  <td>{s.oracleAgeSeconds === null ? "—" : Math.round(s.oracleAgeSeconds)}</td>
                  <td>
                    <Badge status={s.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {summary && (
            <section style={{ marginTop: 18, fontSize: 13, display: "flex", gap: 18, flexWrap: "wrap" }}>
              <span>mean |dev|: <b>{fmt(summary.meanAbsoluteDeviationBps, 1)} bps</b></span>
              <span>stddev: <b>{fmt(summary.stddevAbsoluteDeviationBps, 1)} bps</b></span>
              <span>max |dev|: <b>{fmt(summary.maxAbsoluteDeviationBps, 1)} bps</b></span>
              <span>thresholds: warn ≥ <b>{status?.thresholds.deviationWarnBps} bps</b>, critical ≥{" "}
                <b>{status?.thresholds.deviationCriticalBps} bps</b>, stale &gt;{" "}
                <b>{status?.thresholds.maxOracleAgeSeconds} s</b></span>
              <span>threshold breaches: <b>{summary.breaches}</b></span>
            </section>
          )}

          <h2 style={{ fontSize: 17, marginTop: 24 }}>Deviation history — {chartPair}</h2>
          <DeviationChart points={points} pair={chartPair ?? ""} />
          <p className="muted" style={{ fontSize: 12 }}>
            Signed deviation of the on-chain oracle rate vs the independent exchange reference, in
            basis points. Dots are colored by the status assigned to each sample. Every sample
            references an EVM block; data comes from the local append-only store.
          </p>
        </>
      ) : !error ? (
        <p className="muted">
          No snapshots yet. Run <code>npm run monitor:once</code> to collect the first one.
        </p>
      ) : null}

      <footer style={{ marginTop: 32, fontSize: 12, color: "#8a8f98" }}>
        Read-only dashboard. Attestation writes are performed separately with an explicit
        confirmation step — see the repository README.
      </footer>
    </main>
  );
}
