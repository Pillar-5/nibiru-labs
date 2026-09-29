# Research and design notes

This document records how the product direction was chosen, what was verified
against live Nibiru infrastructure, and why the architecture looks the way it
does. Everything marked **verified** was checked directly against a running
node or service from this repository's code; interpretations and inferences are
labelled as such.

## 1. What Nibiru provides (verified)

Nibiru is a Cosmos-SDK chain with a natively integrated EVM. Configuration
points used throughout this repository:

| Item | Testnet-2 | Mainnet |
| --- | --- | --- |
| EVM RPC | `https://evm-rpc.testnet-2.nibiru.fi` | `https://evm-rpc.nibiru.fi` |
| Chain ID | `6911` (verified via `eth_chainId`) | `6900` |
| Explorer | `https://testnet.nibiscan.io` | `https://nibiscan.io` |

### The oracle precompile

Nibiru ships a price oracle as chain infrastructure and exposes it to the EVM
at a precompile address. Verified by direct JSON-RPC `eth_call` against both
networks:

- Precompile address: `0x000000000000000000000000000000000000000000000801`
- Method: `queryExchangeRate(string pair)` (4-byte selector `0x6bd1902f`,
  derived with ethers v6 from the ABI signature; **verified** by successful
  decoding of live responses)
- Returns: `(uint256 exchangeRate, uint64 updateBlockTimestampMs, uint64 updateBlockHeight)`
  with `exchangeRate` in 18 fixed-point decimals

Example live responses captured during development (testnet-2, block
`9702356`, 2026-09-29):

```text
unibi:uusd   rate=0.0005      oracle_block=9702356 age_s=7
ueth:uusd    rate=2723.58     oracle_block=9702356 age_s=7
ubtc:uusd    rate=84149.90    oracle_block=9702356 age_s=7
uusdc:uusd   rate=1.00026     oracle_block=9702356 age_s=7
```

The same call shape works on mainnet (`ueth:uusd` = 2740.92 at the time of
testing), so the monitoring logic is network-independent.

### Two facts discovered by probing (verified)

These shaped the architecture and are worth knowing before building anything
on this chain:

1. **The ChainLink-style aggregator wrappers do not return round data.**
   Nibiru documents ChainLink-compatible `AggregatorV3` contracts and several
   addresses are deployed on both networks. Every call to
   `latestRoundData()` (`0xfeaf9f3c`) against the deployed wrappers on both
   Testnet-2 and mainnet returns `execution reverted`, and the equivalent
   Cosmos-LCD oracle routes return `501 Not Implemented`. The precompile above
   is the working read path.

2. **Testnet-2's EVM rejects Cancun opcodes.** Bytecode containing `MCOPY`
   (opcode `0x5E`) fails at `eth_call` with `invalid opcode: MCOPY`. Solidity
   >= 0.8.25 emits `MCOPY` from its memory-copy routine, which is reached when
   ABI-encoding a struct return value, so a default-built 0.8.26 contract
   that reads fine elsewhere reverts here. This repository compiles with
   `evmVersion: "shanghai"` for that reason (`scripts/compile.ts`), discovered
   by deploying both ways and comparing behaviour on-chain.
