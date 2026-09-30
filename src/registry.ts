/**
 * Registry address resolution shared by the write path (attest:submit) and the
 * read-back path (contract:verify).
 *
 * Order: ATTESTATION_REGISTRY from the environment, then the record written by
 * scripts/deploy.ts in data/deployment.json for the configured chain id. That
 * way a fresh deploy is usable immediately, and an explicit override still wins
 * (for example to read a registry deployed by someone else).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "./config.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const DEPLOYMENTS_FILE = join(root, "data/deployment.json");

export interface DeploymentRecord {
  network: string;
  chainId: number;
  address: string;
  txHash?: string;
  deployedAt?: string;
}

/** All deployment records, keyed by chain id, or {} when the file is absent. */
export function readDeployments(): Record<string, DeploymentRecord> {
  if (!existsSync(DEPLOYMENTS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(DEPLOYMENTS_FILE, "utf8"));
  } catch (e) {
    throw new Error(`${DEPLOYMENTS_FILE} is not valid JSON: ${(e as Error).message}`);
  }
}

/**
 * Resolve the registry address for the configured network, or throw with an
 * actionable message when neither source provides one.
 */
export function resolveRegistryAddress(config: AppConfig): string {
  const fromEnv = process.env.ATTESTATION_REGISTRY?.trim();
  if (fromEnv) return fromEnv;
  const record = readDeployments()[String(config.network.chainId)];
  if (record?.address) return record.address;
  throw new Error(
    `No registry address for chainId ${config.network.chainId}. Set ATTESTATION_REGISTRY in .env, ` +
      `or deploy the registry on this network (npm run contract:deploy).`,
  );
}
