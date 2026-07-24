import { readFileSync } from "node:fs";
import { Agent as UndiciAgent, fetch as undiciFetch } from "undici";
import type { SyncBundle } from "@scp/schemas";

/**
 * M14.0 — the PER-PEER mTLS OUTBOUND DIALER (the load-bearing, security-critical half of the
 * deferred federation-over-HTTP live-sync substrate the poke design optimizes; owner full-scope
 * decision 2026-07-24).
 *
 * ## What was already there, and what this adds (grounding — cite before you touch this)
 *
 * ADR-0001 / M9.3 built the LISTENER half: `federation/mtls-enforcement.ts`'s `enforceFederationMtls`
 * accepts an inbound peer whose client cert is CA-trusted (+ CRL-checked), carries a
 * `urn:scp:domain:<domainId>` SAN URI (`FEDERATION_SAN_URI_PREFIX`), and resolves to a registered
 * `federation_peers` row for the bearer-authenticated org. `app.ts` flips the whole listener to
 * HTTPS with `requestCert: true` only when `federationServerMtls` is set.
 *
 * M8 (`plugin-host/subprocess-entry.ts`'s `loadFederationMtlsMaterial` + `host.ts`'s `spawnInstance`
 * mTLS forwarding) built the DIALING half for the SUBPROCESS `federation-https` plugin: this
 * instance's OWN client cert/key — an operator-provisioned, deployment-level (never tenant-suppliable)
 * file pair whose SAN URI encodes `urn:scp:domain:<ownDomainId>` — read from `SCP_FEDERATION_MTLS_CERT_FILE`
 * / `_KEY_FILE` (+ optional `_CA_FILE`) and presented via a per-connection undici `Agent`. That IS
 * the "M6-deferred cert injection" the `federation-https` module header flagged — completed in M8.
 * So cert PROVISIONING is settled and this module does NOT invent a new CA scheme: it REUSES the
 * exact same env-file material and the exact same undici-client-cert technique.
 *
 * What M14.0 adds on top: a server-side (apps/server) sibling of that dialer that the OUTPOST
 * live-pull scheduler (`federation-sync.ts`) uses to POST `/federation/exports` to a commander peer.
 * It exists as its own seam (rather than routing the scheduled sync through the subprocess
 * `federation-https` pull()) for two structural reasons the subprocess path cannot satisfy:
 *   1. **Bearer.** `enforceFederationMtls` is explicitly ADDITIVE to bearer+RBAC (ADR-0001 §5): the
 *      commander's `/exports` still runs `requireAuth`, so every pull MUST carry an `Authorization`
 *      bearer for a `federation:write` principal in the commander's org. The `federation-https`
 *      plugin's `ctx.http` has no seam to attach a per-request bearer; this dialer does.
 *   2. **The full signed bundle.** `importSyncBundle` verifies a checksum that covers the WHOLE
 *      bundle header; the plugin's `JournalSegment` wire shape drops header fields, so a bundle
 *      reconstructed from it would fail signature verification. This dialer returns the response
 *      body VERBATIM as a `SyncBundle`, so the import path's fail-closed verification is UNCHANGED.
 *
 * ## Fail-closed (STRICT — the security-critical invariant)
 *
 * A peer that REQUIRES mTLS with NO usable client-cert material configured → the dial REFUSES
 * (`FederationDialRefused`), it NEVER silently falls back to plain HTTP / bearer-only. "Requires
 * mTLS" is derived faithfully from the peer's own `baseUrl` scheme: in THIS system an `https://`
 * federation endpoint always means client-cert-verified — `app.ts` only ever serves the federation
 * routes over HTTPS when `federationServerMtls` is set (which always `requestCert`s), and the
 * deployment-edge alternative (`deploy/helm` `ingress.mtls`) likewise verifies client certs. A
 * plain `http://` peer (or one with no `baseUrl`) does NOT require mTLS and keeps the pre-existing
 * bearer-only path working (backward-compatible; mTLS is opt-in per the current `federationServerMtls`
 * posture).
 *
 * ## Key hygiene
 *
 * Cert/key PEM bytes are read from files by path and handed straight to undici's connect options —
 * never placed in argv, never logged (this module logs nothing), and the per-dial `Agent` is closed
 * in a `finally` so the connection (and its cached TLS material) is torn down promptly after use.
 */

export interface FederationClientMtls {
  cert: string;
  key: string;
  ca?: string;
}

/**
 * Reads THIS instance's own client-cert material from the SAME operator-provisioned env-file paths
 * M8 established (`SCP_FEDERATION_MTLS_CERT_FILE` / `_KEY_FILE` / optional `_CA_FILE`). `undefined`
 * when unset (no client cert — the pre-M8 default). A HALF-configured pair (only one of cert/key)
 * fails LOUD rather than silently degrading to "no client cert" — a false sense of transport
 * identity is worse than an obvious error (identical reasoning to `loadFederationMtlsMaterial`).
 */
export function resolveFederationClientMtls(
  env: NodeJS.ProcessEnv = process.env
): FederationClientMtls | undefined {
  const certFile = env.SCP_FEDERATION_MTLS_CERT_FILE;
  const keyFile = env.SCP_FEDERATION_MTLS_KEY_FILE;
  const caFile = env.SCP_FEDERATION_MTLS_CA_FILE;
  if (!certFile && !keyFile) return undefined; // mTLS not configured for this deployment.
  if (!certFile || !keyFile) {
    throw new Error(
      "federation outbound mTLS: both SCP_FEDERATION_MTLS_CERT_FILE and SCP_FEDERATION_MTLS_KEY_FILE " +
        "must be set together (only one was provided) — refusing to dial with a half-configured client certificate"
    );
  }
  return {
    cert: readFileSync(certFile, "utf8"),
    key: readFileSync(keyFile, "utf8"),
    ca: caFile ? readFileSync(caFile, "utf8") : undefined
  };
}

/** Cheap presence check (no file reads) — is client-cert material configured for this deployment? */
export function federationClientMtlsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SCP_FEDERATION_MTLS_CERT_FILE && env.SCP_FEDERATION_MTLS_KEY_FILE);
}

/** True when dialing `baseUrl` requires presenting a client certificate — i.e. it is an `https://`
 *  federation endpoint (see the module doc for why https ⟺ mTLS-required in this system). A `null`
 *  or plain-`http://` baseUrl does not require mTLS. */
export function federationPeerRequiresMtls(baseUrl: string | null | undefined): boolean {
  return typeof baseUrl === "string" && baseUrl.toLowerCase().startsWith("https://");
}

/** Raised when a peer requires mTLS but this instance has no usable client-cert material — the dial
 *  is REFUSED fail-closed rather than falling back to an unauthenticated transport. The scheduler
 *  catches this to record a block Decision and continue. */
export class FederationDialRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FederationDialRefused";
  }
}

export interface FederationDialResult {
  status: number;
  body: unknown;
}

/**
 * The outbound dial itself: a single POST of a JSON `body` to `url`, optionally presenting this
 * instance's client cert and/or a bearer. FAIL-CLOSED when `requireMtls` is set but `mtls` is
 * absent. When `mtls` is present the request goes through a dedicated per-dial undici `Agent`
 * (client cert on every handshake); when it is absent (an `http://` peer) it uses undici's default
 * dispatcher. `rejectUnauthorized` is left at undici's secure default so the SERVER's own cert is
 * validated against the system/`ca` trust store — this dialer authenticates BOTH directions.
 */
export async function federationDialJson(opts: {
  url: string;
  body: unknown;
  bearer?: string;
  mtls?: FederationClientMtls;
  requireMtls: boolean;
}): Promise<FederationDialResult> {
  if (opts.requireMtls && !opts.mtls) {
    throw new FederationDialRefused(
      `federation outbound: '${opts.url}' requires mTLS but no client-cert material is configured ` +
        "(set SCP_FEDERATION_MTLS_CERT_FILE / _KEY_FILE) — refusing to dial without a client certificate (fail-closed)"
    );
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;

  const dispatcher = opts.mtls
    ? new UndiciAgent({
        connect: { cert: opts.mtls.cert, key: opts.mtls.key, ca: opts.mtls.ca }
      })
    : undefined;
  try {
    const res = await undiciFetch(opts.url, {
      method: "POST",
      headers,
      body: JSON.stringify(opts.body),
      redirect: "error",
      ...(dispatcher ? { dispatcher } : {})
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // non-JSON (an error page, a proxy notice) — keep the raw text for the caller's diagnostics.
    }
    return { status: res.status, body };
  } finally {
    // Tear the connection (and its cached TLS material) down promptly — never pooled across dials.
    await dispatcher?.close().catch(() => undefined);
  }
}

/**
 * POST `/federation/exports` to a commander peer and return the signed `.scpbundle` VERBATIM as a
 * `SyncBundle` for the import path to verify UNCHANGED. Throws on a non-2xx (the scheduler records a
 * block Decision and continues) and refuses fail-closed via {@link federationDialJson} when the peer
 * requires mTLS but no client cert is configured. `peer` is THIS domain's own identity as the
 * commander knows it (its `federation_self.domainId`) — the `peer` selector the commander's
 * `exportSyncBundle` resolves to scope the bundle to this outpost.
 */
export async function pullSyncBundleFromCommander(opts: {
  baseUrl: string;
  selfDomainId: string;
  sinceSequence: number;
  bearer?: string;
  mtls?: FederationClientMtls;
}): Promise<SyncBundle> {
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/api/v1/federation/exports`;
  const requireMtls = federationPeerRequiresMtls(opts.baseUrl);
  const result = await federationDialJson({
    url,
    body: { peer: opts.selfDomainId, sinceSequence: opts.sinceSequence },
    bearer: opts.bearer,
    mtls: opts.mtls,
    requireMtls
  });
  if (result.status < 200 || result.status >= 300) {
    const detail =
      result.body && typeof result.body === "object" && "detail" in result.body
        ? String((result.body as { detail?: unknown }).detail)
        : `HTTP ${result.status}`;
    throw new Error(`federation exports pull failed: ${detail} (status ${result.status})`);
  }
  return result.body as SyncBundle;
}
