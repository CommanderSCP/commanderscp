import { ScpClient } from "@scp/sdk";
import { loadCredentials } from "./config-store.js";

export const DEFAULT_BASE_URL = process.env.SCP_API_URL ?? "http://localhost:8080/api/v1";

/** Resolves the base URL for `scp login`. See docs/cli.md §105. */
export async function resolveLoginBaseUrl(flagBaseUrl?: string): Promise<string> {
  if (flagBaseUrl) return flagBaseUrl;
  if (process.env.SCP_API_URL) return process.env.SCP_API_URL;
  const stored = await loadCredentials();
  if (stored?.baseUrl) return stored.baseUrl;
  return DEFAULT_BASE_URL;
}

/** Builds an authenticated client from stored `scp login` credentials, honoring `--base-url`. */
export async function clientFromStoredCredentials(opts: { baseUrl?: string }): Promise<ScpClient> {
  const stored = await loadCredentials();
  if (!stored) {
    throw new Error("Not logged in — run `scp login` first.");
  }
  return new ScpClient({ baseUrl: opts.baseUrl ?? stored.baseUrl, token: stored.token });
}
