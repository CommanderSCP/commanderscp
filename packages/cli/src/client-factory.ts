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

/**
 * Builds an authenticated client from stored `scp login` credentials. Precedence: `--base-url` >
 * `$SCP_API_URL` > the saved config — the SAME order `resolveLoginBaseUrl` already uses for `scp
 * login`, extended here to every OTHER command (M29.1: found while writing
 * scripts/scp-install-kind-drill.sh — `scp install`'s own port-forward closes when it exits, so the
 * saved `baseUrl` in credentials.json is stale the moment a later `scp whoami`/`scp stack status`/…
 * runs against a fresh one at a different port; without `$SCP_API_URL` in the precedence, that
 * second call had no way to say so short of retyping `--base-url` on every command).
 */
export async function clientFromStoredCredentials(opts: { baseUrl?: string }): Promise<ScpClient> {
  const stored = await loadCredentials();
  if (!stored) {
    throw new Error("Not logged in — run `scp login` first.");
  }
  return new ScpClient({
    baseUrl: opts.baseUrl ?? process.env.SCP_API_URL ?? stored.baseUrl,
    token: stored.token
  });
}
