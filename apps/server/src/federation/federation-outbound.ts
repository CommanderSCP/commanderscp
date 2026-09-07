import { readFileSync } from "node:fs";
import { Agent as UndiciAgent, fetch as undiciFetch } from "undici";
import type { SyncBundle, FederationResyncRequest, FederationResyncResponse } from "@scp/schemas";

/** M14.0 — the PER-PEER mTLS OUTBOUND DIALER. See docs/federation.md §124. */

export interface FederationClientMtls {
  cert: string;
  key: string;
  ca?: string;
}

/** Reads this instance's own client-cert material. See docs/federation.md §125. */
export function resolveFederationClientMtls(
  env: NodeJS.ProcessEnv = process.env
): FederationClientMtls | undefined {
  const certFile = env.SCP_FEDERATION_MTLS_CERT_FILE;
  const keyFile = env.SCP_FEDERATION_MTLS_KEY_FILE;
  const caFile = env.SCP_FEDERATION_MTLS_CA_FILE;
  if (!certFile && !keyFile) return undefined;
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

/** A non-2xx from a federation call, with its parsed problem. See docs/federation.md §126. */
export class FederationExportRefused extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    readonly detail: string
  ) {
    super(`federation exports pull failed: ${detail} (status ${status})`);
    this.name = "FederationExportRefused";
  }
}

export interface FederationDialResult {
  status: number;
  body: unknown;
}

/** The outbound dial itself. See docs/federation.md §127. */
export async function federationDialJson(opts: {
  url: string;
  body: unknown;
  bearer?: string;
  mtls?: FederationClientMtls;
  requireMtls: boolean;
  /** M14.4 (S8) — optional bounded deadline in ms. Omitted keeps undici's default (300s), which is
   *  right for a PULL (a large signed bundle over a slow link must not be cut off); the POKE passes
   *  a short one — see {@link sendPokeToPeer}. */
  timeoutMs?: number;
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
      ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
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
    // Tear the connection. See docs/federation.md §128.
    await dispatcher?.destroy().catch(() => undefined);
  }
}

/** Posts to a commander peer and returns the bundle verbatim. See docs/federation.md §129. */
export async function pullSyncBundleFromCommander(opts: {
  baseUrl: string;
  selfDomainId: string;
  sinceSequence: number;
  /** DIVERGENCE RAIL 2 (§7.2) — the puller's applied-row anchor at `sinceSequence`, sent ONLY by a
   *  full-scope receiver that holds a real anchor. The exporter compares it against its own journal
   *  at that height and refuses `journal_divergence` on mismatch. Omitted (undefined) → not sent. */
  lastAppliedRowHash?: string;
  bearer?: string;
  mtls?: FederationClientMtls;
}): Promise<SyncBundle> {
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/api/v1/federation/exports`;
  const requireMtls = federationPeerRequiresMtls(opts.baseUrl);
  const result = await federationDialJson({
    url,
    body: {
      peer: opts.selfDomainId,
      sinceSequence: opts.sinceSequence,
      ...(opts.lastAppliedRowHash !== undefined
        ? { lastAppliedRowHash: opts.lastAppliedRowHash }
        : {})
    },
    bearer: opts.bearer,
    mtls: opts.mtls,
    requireMtls
  });
  if (result.status < 200 || result.status >= 300) {
    const body =
      result.body && typeof result.body === "object"
        ? (result.body as { detail?: unknown; type?: unknown })
        : {};
    const detail = "detail" in body ? String(body.detail) : `HTTP ${result.status}`;
    const type = typeof body.type === "string" ? body.type : "about:blank";
    throw new FederationExportRefused(result.status, type, detail);
  }
  return result.body as SyncBundle;
}

/** Resync: the importer dials the exporter, signed. See docs/federation.md §130. */
export async function dialResync(opts: {
  baseUrl: string;
  body: FederationResyncRequest;
  bearer?: string;
  mtls?: FederationClientMtls;
}): Promise<FederationResyncResponse> {
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/api/v1/federation/resync`;
  const requireMtls = federationPeerRequiresMtls(opts.baseUrl);
  const result = await federationDialJson({
    url,
    body: opts.body,
    bearer: opts.bearer,
    mtls: opts.mtls,
    requireMtls
  });
  if (result.status < 200 || result.status >= 300) {
    const body =
      result.body && typeof result.body === "object"
        ? (result.body as { detail?: unknown; type?: unknown })
        : {};
    const detail = "detail" in body ? String(body.detail) : `HTTP ${result.status}`;
    const type = typeof body.type === "string" ? body.type : "about:blank";
    throw new FederationExportRefused(result.status, type, detail);
  }
  return result.body as FederationResyncResponse;
}

/** Sends one contentless poke to a peer. See docs/federation.md §131. */
/** M14.4 (S8) — the poke's bounded deadline (ms). See docs/federation.md §132. */
export const FEDERATION_POKE_TIMEOUT_MS = 5_000;

export async function sendPokeToPeer(opts: {
  baseUrl: string;
  bearer?: string;
  mtls?: FederationClientMtls;
  /** Test seam / tuning; defaults to {@link FEDERATION_POKE_TIMEOUT_MS}. */
  timeoutMs?: number;
}): Promise<{ status: number }> {
  if (!federationPeerRequiresMtls(opts.baseUrl)) {
    throw new FederationDialRefused(
      `federation poke: '${opts.baseUrl}' is not an https/mTLS endpoint — a poke authenticates the caller ` +
        "as the enrolled commander via its client certificate, so refusing to poke over an unauthenticated " +
        "transport (fail-closed)"
    );
  }
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/api/v1/federation/poke`;
  const result = await federationDialJson({
    url,
    body: {}, // CONTENTLESS — carries zero data; the endpoint never reads it (ADR-0009 no-DATA invariant).
    bearer: opts.bearer,
    mtls: opts.mtls,
    // CONSTANT true — never scheme-derived (see the fail-closed note above).
    requireMtls: true,
    // BOUNDED: one black-holing peer must never stall the whole sequential poke round.
    timeoutMs: opts.timeoutMs ?? FEDERATION_POKE_TIMEOUT_MS
  });
  return { status: result.status };
}
