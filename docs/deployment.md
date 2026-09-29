# Deployment

How to compile the contract, deploy it to a Nibiru EVM network, submit
attestations, and verify what the chain recorded. Everything here is network
configured — the same commands run against Testnet-2 or mainnet by changing one
environment variable.

## Prerequisites

- Node.js >= 20.
- A funded account on the target network for the optional deploy/attest steps.
  On Testnet-2 use the official faucet: <https://faucet.nibiru.fi>.
- The signing key lives only in your local `.env` as `NIBIRU_PRIVATE_KEY`. It is
  gitignored and never printed. Use a dedicated low-value testnet account.

Copy the example config and edit it:

```bash
cp .env.example .env
```

## Compile

```bash
npm run contract:compile
```

`scripts/compile.ts` uses the `solc` npm package (no Hardhat/Foundry needed for
a single contract) and writes `artifacts/OracleAttestationRegistry.json` with
`{ abi, bytecode }`.

Two build choices are load-bearing and were verified against the live node:

- **`evmVersion: "shanghai"`.** Nibiru Testnet-2's EVM interpreter rejects
  Cancun opcodes — an `eth_call` against bytecode containing `MCOPY` (`0x5E`)
  fails with `invalid opcode: MCOPY`. Solidity >= 0.8.25 emits `MCOPY` in its
  memory-copy routine, reached when ABI-encoding struct returns, so a default
  0.8.26 build that works elsewhere reverts on Nibiru. Pinning the EVM target
  below Cancun keeps the deployed bytecode executable.
- **Optimizer, 200 runs.** Standard size/runs tradeoff; not load-bearing.

## Deploy

```bash
npm run contract:deploy
```

`scripts/deploy.ts`:

1. Loads the network from `NIBIRU_NETWORK` (or `NIBIRU_*` overrides) and reads
   the signing key from `NIBIRU_PRIVATE_KEY`. The account address and balance are
   printed; the key never is.
2. Estimates deployment gas against the live node and adds a 30% buffer, then
   **refuses to broadcast** if the projected native-coin cost exceeds
   `MAX_GAS_SPEND_NIBI` (default 0.05). This is the spending guard.
3. Deploys `OracleAttestationRegistry`, waits for inclusion, and prints the
   address and explorer link.
4. Appends the result to `data/deployment.json`, keyed by chain id, so later
   commands find the address without pasting it.

Example Testnet-2 deployment:

| Item | Value |
| --- | --- |
| Network | Nibiru Testnet-2 (chainId 6911) |
| Registry | `0x1E35A33E51885b9b87a9a25CaB6F28797701669F` |
| Deployment tx | `0xd6e1e9c914b70ea94f0584b915afba4f8e47522497747cffabfdc06721547961` |

Explorer: append either path to `https://testnet.nibiscan.io/`:
`address/0x1E35A33E51885b9b87a9a25CaB6F28797701669F` or
`tx/0xd6e1e9c914b70ea94f0584b915afba4f8e47522497747cffabfdc06721547961`.

## Submit attestations

Anchoring writes a summary of a monitoring snapshot on chain. It is the only
write path and is deliberately gated:

```bash
npm run attest:submit
```

`scripts`/`src/cli/submit-attestation.ts` reads the latest snapshot from the
local store, encodes one `record(...)` call per pair, applies the same
`MAX_GAS_SPEND_NIBI` guard, and requires an explicit confirmation before
broadcast. It distinguishes the four stages the project always separates: **read
chain state, prepare a transaction, sign, broadcast**. See the README for the
full flow and the per-pair confirmation.

Four reports were submitted to the Testnet-2 registry (one per pair), tx hashes
listed in the README's "Example transactions" table. Each emits an
`AttestationRecorded` event carrying a `contentHash` that binds every field, so a
holder of the original snapshot can confirm the on-chain record matches.

## Verify on-chain state

```bash
npm run contract:verify
```

`scripts/verify.ts` is read-only — no wallet, no secrets. It resolves the
registry from `ATTESTATION_REGISTRY` or `data/deployment.json`, prints the owner,
and for each monitored pair prints the latest anchored report (status, oracle
rate, reference, deviation, oracle block, report count, content hash). Current
Testnet-2 state: 4 pairs, each with one report, all `status=ok`, deviations 3-4
bps. This confirms the chain contents independently of this repository's local
store, so any third party can reproduce it with just the public RPC.

## Network configuration

Everything is selected by `NIBIRU_NETWORK` (`testnet-2` | `mainnet`) with
per-field overrides (`NIBIRU_RPC_URL`, `NIBIRU_CHAIN_ID`, `NIBIRU_EXPLORER_URL`).
Built-in presets live in `src/config.ts`:

| Network | RPC | Chain ID | Explorer |
| --- | --- | --- | --- |
| Testnet-2 | `https://evm-rpc.testnet-2.nibiru.fi` | 6911 | `https://testnet.nibiscan.io` |
| Mainnet | `https://evm-rpc.nibiru.fi` | 6900 | `https://nibiscan.io` |

The oracle precompile address is identical on both networks
(`0x…0801`), and live reads were confirmed on both during development.

## Testnet -> mainnet

The read path (oracle + references) and the analysis need no change to point at
mainnet: set `NIBIRU_NETWORK=mainnet`. Read-only operation is fully supported on
mainnet today.

The write path (deploy + attest) would run against mainnet with a real funded
account, but it has only been exercised on Testnet-2. Mainnet attestation
broadcasts have not been run and are not claimed as tested; treat them as a
configuration change plus a live check you would perform yourself before relying
on them. The `shanghai` EVM pin was chosen for Testnet-2 compatibility — confirm
the target network's opcode support before deploying there.
