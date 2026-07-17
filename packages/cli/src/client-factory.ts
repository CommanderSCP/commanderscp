import { ScpClient } from "@scp/sdk";
import { loadCredentials } from "./config-store.js";

export const DEFAULT_BASE_URL = process.env.SCP_API_URL ?? "http://localhost:8080/api/v1";

/**
 * Resolves the base URL for `scp login` (both password and device flows), with precedence:
 * explicit `--base-url` flag > `SCP_API_URL` env > saved credentials.json baseUrl > localhost default.
 *
 * `login` can't use `clientFromStoredCredentials` (there's no token yet), but it should still honor
 * a baseUrl the user already has saved — so a plain `scp login` against a remote instance targets
 * that instance instead of silently hitting localhost.
 */
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
