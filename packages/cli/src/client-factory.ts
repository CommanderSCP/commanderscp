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

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * True when `envUrl` is safe to trust as an override for `storedUrl`'s session token.
 *
 * #422 re-verify, SHOULD-FIX 3 — measured live (a probe that records whether a request carrying
 * the Bearer token ever reaches a listener): the earlier hostname-only check let TWO real leaks
 * through. (a) a same-host, different-PORT env var was accepted even for a non-loopback host — a
 * different port is frequently a DIFFERENT process/service, not the same server on a new
 * ephemeral port, so that's only safe for loopback (the `scp install`/drill port-forward case this
 * exists for). (b) an `https` stored session accepted an `http` env override on the SAME host — a
 * cleartext downgrade that sends the token unencrypted even though the operator logged in over
 * TLS. Both are closed here: the SCHEME must always match exactly (no exception, ever — this is
 * what stops the downgrade), the HOST must always match exactly, and the PORT may differ ONLY when
 * the host is loopback.
 */
function trustedOverride(envUrl: string, storedUrl: string): boolean {
  let env: URL;
  let stored: URL;
  try {
    env = new URL(envUrl);
    stored = new URL(storedUrl);
  } catch {
    return false;
  }
  if (env.protocol !== stored.protocol) return false;
  if (env.hostname !== stored.hostname) return false;
  if (env.port === stored.port) return true;
  return LOOPBACK_HOSTNAMES.has(env.hostname);
}

/**
 * Builds an authenticated client from stored `scp login` credentials. Precedence: `--base-url` >
 * `$SCP_API_URL` (a `trustedOverride` of the saved session only) > the saved config.
 *
 * #422 adversarial review, SHOULD-FIX 5 (an M28-class hole): earlier this precedence honoured
 * `$SCP_API_URL` unconditionally, so ANY process that could set an environment variable — not
 * just the port-forward drill this was built for — silently decided where the stored session
 * TOKEN got sent. An ambient env var is not consent; only an explicit `--base-url` flag (a
 * decision made in the same command line as the call it applies to) or a `trustedOverride` origin
 * is. A `scp install`/drill port-forward legitimately reopens on a new ephemeral PORT each run
 * (found while writing scripts/scp-install-kind-drill.sh — `scp install`'s own port-forward closes
 * when it exits) — that keeps working via `trustedOverride`'s loopback exception. #422 re-verify,
 * SHOULD-FIX 3: that exception covers ONLY the port — a different HOST, a different SCHEME, or an
 * `https`→`http` downgrade (even on loopback) all now refuse; the caller must pass `--base-url`
 * explicitly to confirm any of those is intentional.
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
    if (!trustedOverride(envUrl, stored.baseUrl)) {
      throw new Error(
        `$SCP_API_URL ("${envUrl}") is not a trusted override for the logged-in session's saved ` +
          `URL ("${stored.baseUrl}") — refusing to send the stored session token there on an ` +
          `ambient env var alone (scheme and host must match exactly; a port difference is only ` +
          `trusted for loopback; a scheme downgrade is never trusted). Pass --base-url "${envUrl}" ` +
          `explicitly if this is intentional.`
      );
    }
    return new ScpClient({ baseUrl: envUrl, token: stored.token });
  }
  return new ScpClient({ baseUrl: stored.baseUrl, token: stored.token });
}
