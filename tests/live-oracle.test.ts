// Live tests hit public Nibiru endpoints. They need no wallet and no secrets.
// Run with: npm run test:live
import { describe, expect, it } from "vitest";
import { ethers } from "ethers";
import { NETWORK_PRESETS, loadConfig } from "../src/config.ts";
import { OracleReader, decodeExchangeRate } from "../src/oracle/precompile.ts";

const live = process.env.LIVE_TESTS === "1" ? describe : describe.skip;

live("Nibiru oracle precompile (live)", () => {
  for (const [name, preset] of Object.entries(NETWORK_PRESETS)) {
    it(`returns a live rate on ${name}`, async () => {
      const reader = new OracleReader(preset.rpcUrl, "0x0000000000000000000000000000000000000801", preset.chainId);
      const r = await reader.readPair("unibi:uusd");
      expect(r.rate).toBeGreaterThan(0);
      expect(r.updateBlockTimestampMs).toBeGreaterThan(0n);
      // value should be recent: the oracle updates roughly every block
      expect(Number(r.updateBlockTimestampMs)).toBeGreaterThan(Date.now() - 10 * 60 * 1000);
    }, 30_000);
  }

  it("decodes the precompile tuple layout correctly", () => {
    // Encode with the same ABI the precompile returns, then decode with our
    // decoder: a deterministic round-trip that needs no live node.
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "uint64", "uint64"],
      [500000000000000n, 1790685672000n, 886583n],
    );
    const d = decodeExchangeRate(encoded);
    expect(d.exchangeRate).toBe(500000000000000n);
    expect(d.updateBlockTimestampMs).toBe(1790685672000n);
    expect(d.updateBlockHeight).toBe(886583n);
  });

  it("surfaces reverts for pairs the oracle module cannot price", async () => {
    const config = loadConfig();
    const reader = new OracleReader(config.network.rpcUrl, config.oracle.precompile, config.network.chainId);
    await expect(reader.readPair("uusd:uusd")).rejects.toThrow(/reverted|no data/);
  }, 30_000);
});
