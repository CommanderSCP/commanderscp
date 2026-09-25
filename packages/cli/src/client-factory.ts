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
 * True when `envUrl` and `storedUrl` name the same host — deliberately NOT a strict RFC 6454
 * origin (scheme+host+port) comparison, because the legitimate use case this guards (a `scp
 * install`/drill port-forward that gets torn down and reopened on a new ephemeral port) changes
 * the port every time by design. Comparing hostnames only still blocks the thing that matters: an
 * ambient `$SCP_API_URL` naming a DIFFERENT host from the one the operator actually logged into.
 */
function sameHost(envUrl: string, storedUrl: string): boolean {
  try {
    return new URL(envUrl).hostname === new URL(storedUrl).hostname;
  } catch {
    return false;
  }
}

/**
 * Builds an authenticated client from stored `scp login` credentials. Precedence: `--base-url` >
 * `$SCP_API_URL` (same host as the saved session only) > the saved config.
 *
 * #422 adversarial review, SHOULD-FIX 5 (an M28-class hole): earlier this precedence honoured
 * `$SCP_API_URL` unconditionally, so ANY process that could set an environment variable — not
 * just the port-forward drill this was built for — silently decided where the stored session
 * TOKEN got sent. An ambient env var is not consent; only an explicit `--base-url` flag (a
 * decision made in the same command line as the call it applies to) or a host that matches what
 * the operator actually logged into is. A `scp install`/drill port-forward legitimately reopens on
 * a new ephemeral PORT each run (found while writing scripts/scp-install-kind-drill.sh — `scp
 * install`'s own port-forward closes when it exits) — that keeps working via `sameHost` above,
 * which ignores port. A `$SCP_API_URL` naming a different HOST now refuses instead of silently
 * complying; the caller must pass `--base-url` explicitly to confirm that's intentional.
 */
export async function clientFromStoredCredentials(opts: { baseUrl?: string }): Promise<ScpClient> {
  const stored = await loadCredentials();
  if (!stored) {
    throw new Error("Not logged in — run `scp login` first.");
  }
  if (opts.baseUrl) {
    return new ScpClient({ baseUrl: opts.baseUrl, token: stored.token });
  }
  const envUrl = process.env.SCP_API_URL;
  if (envUrl) {
    if (!sameHost(envUrl, stored.baseUrl)) {
      throw new Error(
        `$SCP_API_URL ("${envUrl}") names a different host than the logged-in session's saved URL ` +
          `("${stored.baseUrl}") — refusing to send the stored session token there on an ambient ` +
          `env var alone. Pass --base-url "${envUrl}" explicitly if this is intentional.`
      );
    }
    return new ScpClient({ baseUrl: envUrl, token: stored.token });
  }
  return new ScpClient({ baseUrl: stored.baseUrl, token: stored.token });
}
