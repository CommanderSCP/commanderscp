import type { TLSSocket } from "node:tls";
import type { FastifyRequest } from "fastify";
import type { AppDeps } from "../types.js";
import type { TenantTx } from "../db/tenant-tx.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { forbidden, unauthorized, ProblemError } from "../errors.js";
import { getPeerByIdOrName } from "./peers-repo.js";
import { isUuid } from "../graph/objects-repo.js";
import { insertDecision } from "../coordination/decisions-repo.js";

/**
 * M9.3 in-app federation mTLS (ADR-0001, `docs/adr/0001-in-app-federation-mtls.md`) — a gate
 * applied to (and ONLY to) the three federation transport routes (`routes/federation.ts`'s
 * `POST /exports`, `/exports/promotion`, `/imports`), called explicitly at the top of each of
 * those handlers (see `enforceFederationMtls`'s own doc comment for why this is a plain function
 * call rather than a registered Fastify `onRequest` hook — the ADR's proposed shape), never
 * applied globally. Layered on top of — never a replacement for — the existing bearer+RBAC
 * (`auth/require-auth.ts`) and, for imports, Ed25519 bundle-signature verification
 * (`federation/import-repo.ts`). When `deps.config.federationServerMtls` is unset (the default),
 * every function here is a no-op and request handling is BYTE-FOR-BYTE what it was before M9.3.
 *
 * FAIL-CLOSED by construction: every branch below either establishes a fully-verified peer
 * identity or throws a `ProblemError` (formatted as RFC 9457 `application/problem+json` by
 * `app.ts`'s error handler, same as every other rejection in this codebase) — there is no path
 * that falls through to "treat as anonymous/unverified but proceed anyway".
 */

/**
 * SAN URI scheme (owner decision, ADR-0001 "Remaining implementation-time notes"): a peer's
 * federation domain id is encoded as a URI Subject Alternative Name of the form
 * `urn:scp:domain:<domainId>` (a URN, RFC 8141 — not `spiffe://`, to avoid taking a dependency on
 * SPIFFE's trust-domain/path conventions this system doesn't otherwise use). This value is what
 * `scp federation pair`/`peers-repo.ts`'s `pairPeer` records as `federationPeers.id` — an operator
 * issuing a peer's client certificate must encode that SAME domain id here.
 */
export const FEDERATION_SAN_URI_PREFIX = "urn:scp:domain:";

/** Constructs the SAN URI value a peer's client certificate should carry for `domainId` — used by
 *  operator tooling/docs to build the cert signing request; the inverse of
 *  `parsePeerDomainIdFromSanUri`. */
export function federationPeerSanUri(domainId: string): string {
  return `${FEDERATION_SAN_URI_PREFIX}${domainId}`;
}

/**
 * Parses Node's `subjectaltname` string (e.g. `"URI:urn:scp:domain:1234...,DNS:example.com"`) and
 * returns the domain id encoded in a `urn:scp:domain:<uuid>` SAN URI entry, or `null` if none is
 * present / none matches the scheme / the encoded value isn't a UUID. Only the FIRST `URI:` prefix
 * is stripped from a matching entry (not a generic colon-split) so a URN's own internal colons
 * (`urn:scp:domain:...`) are preserved intact.
 *
 * Returning `null` is a REJECT signal to every caller (fail-closed) — never treated as "no
 * identity asserted, allow anyway".
 */
export function parsePeerDomainIdFromSanUri(subjectAltName: string | undefined): string | null {
  if (!subjectAltName) return null;
  // Node joins SAN entries with ", " (comma-space) — see tls.TLSSocket.getPeerCertificate() docs.
  for (const entry of subjectAltName.split(", ")) {
    if (!entry.startsWith("URI:")) continue;
    const uri = entry.slice("URI:".length);
    if (!uri.startsWith(FEDERATION_SAN_URI_PREFIX)) continue;
    const domainId = uri.slice(FEDERATION_SAN_URI_PREFIX.length);
    if (isUuid(domainId)) return domainId;
  }
  return null;
}

declare module "fastify" {
  interface FastifyRequest {
    /**
     * Set by `enforceFederationMtls` ONLY when in-app federation mTLS is enabled AND the request's
     * client certificate was fully verified (trusted CA, not revoked, SAN URI resolves to a
     * peer registered for the authenticated bearer token's org). `undefined` in every other case
     * — including "mTLS disabled" — so a handler must never treat its mere presence as proof of
     * anything beyond "this request passed the hook"; it never fails open.
     */
    mtlsPeerDomainId?: string;
  }
}

/**
 * The per-route mTLS gate. Called as the FIRST statement in each of the three federation
 * transport routes' handlers (`routes/federation.ts`) — matching this codebase's existing
 * convention of running auth checks inline at the top of a handler body (`requireAuth` is
 * likewise the first statement in every route handler) rather than as a registered Fastify
 * lifecycle hook. (An earlier version of this used a route-level `onRequest: [...]` array, which
 * runs technically earlier in the request lifecycle — before body parsing — but was reverted: it
 * conflicts with this route file's Zod/`fastify-type-provider-zod` + `config.openapi` typing, as
 * TypeScript infers the route's `ContextConfig` generic from ALL of `config`/`onRequest`/`schema`
 * together, and a hook function typed against the DEFAULT `FastifyRequest` pulls that inference
 * away from the `config: { openapi: {...} } }` object literal's own shape, breaking the OpenAPI
 * metadata typing on those three routes. Calling this plain function at the top of `handler`
 * sidesteps the generics entirely and is FUNCTIONALLY equivalent for fail-closed purposes: it
 * still runs before `requireAuth`, `authorize`, `withTenantTx`, or any bundle-processing code —
 * the only routes ahead of it in the pipeline are Fastify's own schema validation, which never
 * touches application logic or the database.)
 */
export async function enforceFederationMtls(deps: AppDeps, request: FastifyRequest): Promise<void> {
  const mtlsConfig = deps.config.federationServerMtls;
  if (!mtlsConfig) return; // Not configured — existing bearer+RBAC-only behavior, unchanged.

  // `app.ts` only constructs this listener as `https` when `federationServerMtls` is set, so
  // EVERY connection reaching this function is a TLS socket — the cast is safe, not a guess.
  const socket = request.raw.socket as unknown as TLSSocket;

  // Gate 1 (CA trust AND revocation — both, per the same flag): `socket.authorized` is `false`
  // for a missing certificate, a certificate not signed by the configured CA bundle, OR a
  // certificate whose serial appears on the configured CRL (`authorizationError` distinguishes
  // them — e.g. `UNABLE_TO_GET_ISSUER_CERT` vs `CERT_REVOKED`). Empirically confirmed (throwaway
  // CA + a deliberately-revoked leaf cert against a real `https.createServer` with
  // `rejectUnauthorized: false`): Node/OpenSSL's CRL checking already sets `authorized: false`
  // with `authorizationError: "CERT_REVOKED"` for a revoked cert under this exact configuration
  // — no separate/explicit revoked-serial-list fallback check is needed on top of this; see
  // `mtls.integration.test.ts`'s "revoked cert is rejected" case for the proof, and
  // `config.ts`'s `loadFederationServerMtlsConfig` doc comment for the companion finding about
  // EXPIRED CRLs (a different failure mode, handled at config-load time, not here).
  if (!socket.authorized) {
    throw unauthorized(
      "federation mTLS: client certificate missing, untrusted, or revoked" +
        (socket.authorizationError ? ` (${socket.authorizationError})` : "")
    );
  }

  // Gate 2 (identity extraction): the SAN URI is the ONLY identity source trusted here — never
  // the certificate's CN (ADR-0001's "Resolved decisions": avoids CN-parsing ambiguity). Missing
  // or unparseable -> reject; there is no "authorized but anonymous" outcome.
  const peerCert = socket.getPeerCertificate();
  const domainId = parsePeerDomainIdFromSanUri(peerCert?.subjectaltname);
  if (!domainId) {
    throw unauthorized(
      "federation mTLS: client certificate is CA-trusted but carries no recognizable SAN URI " +
        `federation identity (expected a 'URI:${FEDERATION_SAN_URI_PREFIX}<domainId>' entry)`
    );
  }

  // Gate 3 (registered-peer mapping): resolves which org's peer registry to check against by
  // running the SAME bearer/session resolution the route handler performs a moment later
  // (`requireAuth`) — mTLS is explicitly ADDITIVE (ADR-0001 §5), never a replacement for
  // bearer+RBAC, so there is no separate "mTLS-only" identity/session concept to invent here. If
  // the bearer token itself is missing/invalid, this throws the identical 401 the handler would
  // have thrown anyway, just surfaced before any peer lookup or body parsing runs.
  const auth = await requireAuth(deps, request);

  let peerId: string;
  try {
    const peer = await withTenantTx(deps.db, auth.orgId, (tx) =>
      getPeerByIdOrName(tx, auth.orgId, domainId)
    );
    peerId = peer.id;
  } catch (err) {
    if (err instanceof ProblemError && err.status === 404) {
      throw forbidden(
        `federation mTLS: certificate identity '${domainId}' is not a registered federation ` +
          "peer for this org — pair it first with 'scp federation pair'"
      );
    }
    throw err; // any other failure (DB error, etc.) propagates and fails closed, never swallowed.
  }

  request.mtlsPeerDomainId = peerId;
}

/**
 * ADR-0001 §5's SHOULD binding (advisory in v1, deliberately NOT a rejection): for `/imports`,
 * compares the mTLS-verified transport peer's domain id against the bundle's own claimed
 * `header.exporterDomainId`. A legitimate direct-peer import always has these equal; a mismatch
 * means a certificate-holding peer relayed/replayed a bundle nominally signed by a DIFFERENT
 * domain — not currently blocked (M9 federation is direct-peer only; multi-hop relay is explicitly
 * out of scope, ADR-0001 §5), but always logged AND recorded as a Decision so the mismatch is
 * explainable and so flipping this to a hard MUST later (throwing instead of recording) is a
 * one-line code change, not a design change. No-ops when mTLS wasn't enforced on this request
 * (`mtlsPeerDomainId` unset) — there is nothing to bind against.
 */
export async function recordImportExporterBindingAdvisory(
  tx: TenantTx,
  params: { orgId: string; mtlsPeerDomainId: string | undefined; exporterDomainId: string },
  // Loosely typed (rather than importing Fastify's own logger type) to accept `request.log`
  // (pino, whose `.warn` is overloaded `(msg)` / `(obj, msg)`) without fighting TS overload
  // assignability — this function only ever calls the `(obj, msg)` form.
  log: { warn: (...args: [obj: Record<string, unknown>, msg: string]) => void }
): Promise<void> {
  if (!params.mtlsPeerDomainId) return; // mTLS not enforced on this request — nothing to bind.
  if (params.mtlsPeerDomainId === params.exporterDomainId) return; // the common, matching case.

  log.warn(
    { mtlsPeerDomainId: params.mtlsPeerDomainId, exporterDomainId: params.exporterDomainId },
    "federation mTLS: transport peer identity does not match the bundle's claimed exporterDomainId " +
      "(ADR-0001 SHOULD binding — advisory only in v1, request proceeds)"
  );
  // TO FLIP TO A HARD MUST LATER: replace the two calls above/below with
  // `throw forbidden(...)` — the mismatch is already fully computed at this point.
  await insertDecision(tx, {
    orgId: params.orgId,
    kind: "federation_mtls_exporter_binding",
    subjectId: params.mtlsPeerDomainId,
    verdict: "warn",
    inputContext: {
      mtlsPeerDomainId: params.mtlsPeerDomainId,
      exporterDomainId: params.exporterDomainId
    },
    reasonTree: {
      summary:
        `mTLS transport peer '${params.mtlsPeerDomainId}' presented a bundle claiming ` +
        `exporterDomainId '${params.exporterDomainId}' — these differ`,
      policy: "ADR-0001 §5: SHOULD (advisory) in v1, not MUST — recorded, not rejected"
    }
  });
}
