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

/** M9.3 in-app federation mTLS. See docs/federation.md §297. */

/** SAN URI scheme. See docs/federation.md §298. */
export const FEDERATION_SAN_URI_PREFIX = "urn:scp:domain:";

/** Constructs the SAN URI value a peer's client certificate should carry for `domainId` — used by
 *  operator tooling/docs to build the cert signing request; the inverse of
 *  `parsePeerDomainIdFromSanUri`. */
export function federationPeerSanUri(domainId: string): string {
  return `${FEDERATION_SAN_URI_PREFIX}${domainId}`;
}

/** Parses Node's `subjectaltname` string. See docs/federation.md §299. */
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
    /** Set only when in-app mTLS is on and verified. See docs/federation.md §300. */
    mtlsPeerDomainId?: string;
  }
}

/** The per-route mTLS gate. See docs/federation.md §301. */
export async function enforceFederationMtls(deps: AppDeps, request: FastifyRequest): Promise<void> {
  const mtlsConfig = deps.config.federationServerMtls;
  if (!mtlsConfig) return; // Not configured — existing bearer+RBAC-only behavior, unchanged.

  // `app.ts` only constructs this listener as `https` when `federationServerMtls` is set, so
  // EVERY connection reaching this function is a TLS socket — the cast is safe, not a guess.
  const socket = request.raw.socket as unknown as TLSSocket;

  // Gate 1 (CA trust AND revocation — both, per the same flag). See docs/federation.md §302.
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

  // Gate 3 (registered-peer mapping). See docs/federation.md §303.
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

/** ADR-0001 §5's SHOULD binding. See docs/federation.md §304. */
export async function recordImportExporterBindingAdvisory(
  tx: TenantTx,
  params: { orgId: string; mtlsPeerDomainId: string | undefined; exporterDomainId: string },
  // Loosely typed (rather than importing Fastify's own logger type) to accept `request.log`
  // (pino, whose `.warn` is overloaded `(msg)` / `(obj, msg)`) without fighting TS overload
  // assignability — this function only ever calls the `(obj, msg)` form.
  log: { warn: (...args: [obj: Record<string, unknown>, msg: string]) => void }
): Promise<void> {
  if (!params.mtlsPeerDomainId) return; // mTLS not enforced on this request — nothing to bind.
  if (params.mtlsPeerDomainId === params.exporterDomainId) return;

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
