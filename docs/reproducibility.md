# Reproducibility Guide

This guide walks an independent developer from a clean clone to reproducing
everything NibiWatch claims: live oracle reads, reference comparison, the
integrity analysis, and on-chain attestation — all using **your own** wallet
and configuration. Nothing below depends on the original author's machine or
test account.

## Prerequisites

| Requirement | Version / notes |
|---|---|
| Node.js | 20 or newer (developed on 22/24) |
| npm | ships with Node |
| Git | any recent version |
| Testnet tokens | Nibiru Testnet-2 faucet for gas (only needed for attestation writes) |

No Docker, database server, or local node is required. All blockchain access
goes over the public RPC configured in `.env`.

## 1. Clone and install

```bash
git clone https://github.com/Pillar-5/nibiru-labs.git
cd nibiru-labs
npm install
```

## 2. Configure

```bash
cp .env.example .env
```

The defaults point at Nibiru Testnet-2 with four monitored pairs and public
reference providers — enough to run everything read-only. See
`docs/deployment.md` for the full variable reference.

To write attestations you additionally set, in your local `.env`:

```bash
WALLET_PRIVATE_KEY=<your own testnet private key>
REGISTRY_ADDRESS_6911=<registry address you deployed, or the published one>
```

`.env` is gitignored; the key never needs to leave your machine. Anyone can
create a fresh testnet wallet with any EVM tooling (for example
`node -e "const{ethers}=require('ethers');console.log(ethers.Wallet.createRandom().privateKey)"`)
and fund it from the official Nibiru faucet.

## 3. Read-only reproduction (no wallet needed)

```bash
npm run oracle:read     # live rates straight from the oracle precompile
npm run monitor:once    # one snapshot: oracle vs independent reference, saved to data/state.jsonl
```

Expected output shape (values change with the market):

```
network Nibiru Testnet-2 chainId 6911 block 9704107
pair         status      oracle_ref      reference_usd  dev_bps  age_s  reason
ueth:uusd     ok            2681.160000    2679.705000       5.4       7  ...
ubtc:uusd     ok           83156.010000   83129.085000       3.2       8  ...
uusdc:uusd    ok               1.000200       1.000000       2.0       8  ...
```

If your network blocks a reference provider, the monitor falls through the
provider order and records provenance notes instead of failing.

## 4. Analysis over committed samples (fully deterministic)

```bash
node scripts/stats.cjs
```

This recomputes the deviation statistics quoted in the README from
`data/samples/example-snapshots.jsonl` — 204 committed real snapshots collected
on Testnet-2 on 2026-09-29 between 16:22Z and 23:35Z. Because the inputs are
committed, the numbers reproduce exactly on any machine: 816 pair-samples,
614 with an independent reference, mean absolute deviation 4.00 bps, median
3.90 bps, population stdev 1.49 bps, maximum 20.13 bps, zero threshold
breaches and zero stale samples.

## 5. Tests

```bash
npm test          # 30 deterministic tests; no network access required
LIVE_TESTS=1 npm test   # additionally hits the live precompile on both networks
```

Expected: `Test Files 4 passed`, `Tests 34 passed` with `LIVE_TESTS=1`. The
live tests assert only structural facts (a positive rate comes back, the
decode round-trips) so they pass regardless of market values.

## 6. Web dashboard

```bash
npm run api        # terminal 1: read-only API over the local store
npm run web:dev    # terminal 2: dashboard at http://localhost:5173
```

The dashboard renders whatever is in `data/state.jsonl`. To see the shipped
evidence without collecting data first:

```bash
copy data\samples\example-snapshots.jsonl data\state.jsonl   # Windows
# cp data/samples/example-snapshots.jsonl data/state.jsonl   # Linux/macOS
```

## 7. Contract deployment reproduction (your wallet)

```bash
npm run contract:compile   # solc 0.8.26, optimizer on -> artifacts/
npm run contract:deploy    # deploys from the address derived from your key
```

Record the printed address and tx hash; the deploy step writes
`data/deployment.json`. Then point `.env` at your deployment
(`REGISTRY_ADDRESS_<chainId>=...`) and verify the write path:

```bash
npm run monitor:once
npm run attest:submit      # prepares a batch, asks for confirmation, submits sequentially
npm run contract:verify    # reads back every anchored pair straight from the chain
```

Each attestation tx appears on Nibiscan at
`https://testnet.nibiscan.io/tx/<txHash>`; the registry address at
`https://testnet.nibiscan.io/address/<address>`.

## 8. Reproduction checklist

A fresh clone reproduces the project end to end when all of these succeed:

- [ ] `npm install` completes; `npm run typecheck` is clean
- [ ] `npm test` passes offline; `LIVE_TESTS=1 npm test` passes with network
- [ ] `npm run oracle:read` returns live rates with a fresh block number
- [ ] `npm run monitor:once` writes a snapshot; at least one pair shows a deviation
- [ ] `node scripts/stats.cjs` reproduces the README statistics from committed samples
- [ ] `npm run api` + `npm run web:dev` render the dashboard over the shipped samples
- [ ] `npm run contract:compile` produces `artifacts/OracleAttestationRegistry.json`
- [ ] (optional, funded wallet) deploy + `attest:submit` + `contract:verify` round-trip

## Notes on determinism

- The oracle precompile address is identical on Testnet-2 and mainnet, so
  read paths are network-independent.
- Deviation statistics are computed offline from stored snapshots; recomputing
  them from the committed samples never touches the network.
- The store is append-only JSONL; deleting `data/state.jsonl` simply starts a
  fresh monitoring history.
- Market-dependent outputs (prices, deviations from a fresh `monitor:once`)
  naturally differ over time — that is expected; the committed-sample path is
  the exact-reproduction path.
