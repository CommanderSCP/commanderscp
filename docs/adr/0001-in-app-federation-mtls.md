# ADR-0001: In-app mTLS for federation transport endpoints

| | |
|---|---|
| **Status** | **Accepted** — owner-approved 2026-07-11 (M9.3); the three open questions resolved below |
| **Date** | 2026-07-11 |
| **Deciders** | Owner (jag8765) |
| **Relates to** | [DESIGN.md §13 (Federation)](../DESIGN.md), PROJECT_CHARTER.md (federation, air-gap principles), M8 PR #15 adversarial review MAJOR #3, [BUILD_AND_TEST.md §8 M9](../BUILD_AND_TEST.md) |

> This is the first ADR; it also establishes the `docs/adr/` convention (numbered, `NNNN-kebab-title.md`, standard Status/Context/Decision/Consequences/Alternatives sections). Per CLAUDE.md, significant decisions after design approval are recorded here; this ADR is itself the design proposal for M9.3 and is reviewed **before any code**.

## Context

**How federation transport works today** (verified against `main`):

- The `federation-https` transport plugin is **client-only** — children dial *out*; there is no server half (`packages/plugins/federation-https/src/index.ts`: `pull()` → `POST {parent}/federation/exports`, `push()` → `POST {parent}/federation/imports`). This matches the charter's **child-initiated-only** rule (GovCloud dials commercial, never the reverse).
- The endpoints a peer actually hits are three routes on the ordinary Fastify API: `POST /api/v1/federation/exports`, `.../exports/promotion`, `.../imports` (`apps/server/src/routes/federation.ts`).
- Those routes are guarded by **bearer/session auth + `federation:read`/`federation:write` RBAC** (`routes/federation.ts` → `requireAuth` + `authorize`). `requireAuth` (`apps/server/src/auth/require-auth.ts`) resolves a bearer token or session cookie only — there is **no transport-identity check**.
- **Integrity/authenticity is provided by Ed25519 journal/bundle signatures**, verified fail-closed (`apps/server/src/federation/import-repo.ts` — e.g. `throw conflict("bundle signature verification failed (rejected, fail-closed)")`). The peer's identity *for signature verification* is resolved from `bundle.header.exporterDomainId`, **not** from any TLS certificate.
- The API server **listens plain HTTP** — `main.ts` calls `app.listen` with no `https`/`requestCert` (`apps/server/src/main.ts`), and the Fastify instance is built plain in `apps/server/src/app.ts` (no `https` server options, no peer-cert hook). `main.ts` already carries an inline comment flagging in-app peer-cert verification as tracked follow-up (this is M8 adversarial-review **MAJOR #3**).
- **M8 shipped ingress-mTLS** (`deploy/helm` → `ingress.mtls`, nginx `auth-tls-verify-client: "on"`, `auth-tls-secret`) as the server-side enforcement mechanism, plus `federation.mtls` for client-cert *presentation* when a child dials out (`apps/server/src/plugin-host/subprocess-entry.ts` → `SCP_FEDERATION_MTLS_CERT_FILE`/`_KEY_FILE`/`_CA_FILE`). The Helm README/values already document that in-app server-side verification is deferred.

**The gap.** When the API server terminates TLS **itself** (direct exposure, or a TLS-passthrough proxy), nothing verifies the transport peer's identity. Bearer+RBAC authenticate an *org's token* (stealable, misconfigurable), not the peer domain; Ed25519 signatures authenticate the *bundle's signer*, not the *connection*. Transport peer identity is a distinct, defensible defense-in-depth layer, and it exists today only when nginx (ingress-mTLS) sits in front — which is nginx-specific, whole-Ingress-scoped, and unavailable in non-ingress topologies.

**Constraints carried in from the charter:**
- Federation is **child-initiated only** — the parent listens, never dials. In-app mTLS is therefore primarily a **listener** (parent-side) concern.
- **Air-gap file transport must be unaffected** — the `.scpbundle` path is HTTP-independent and must not gain a transport requirement.
- **No new required stateful dependency** (#4) — mTLS uses local CA/cert/key material, adds no service.
- **Explainability** — a blocked federation request must carry a `decision_id` / RFC 9457 body.
- **API-first parity** is not implicated — this is a transport-layer control *below* the public API; it adds no API/SDK/CLI capability.

## Decision

Add **optional, fail-closed in-app mTLS** on the three federation transport endpoints, layered on top of (never replacing) the existing controls.

1. **Server TLS with an *optional* client-cert request.** When in-app mTLS is enabled, construct the listener with `requestCert: true, rejectUnauthorized: false` (via Fastify `https` options or a `serverFactory` building an `https.Server`). Request-but-don't-reject at the TLS layer is **required** because the *same* listener also serves browsers/CLI/SDK traffic that must not present a client cert — rejection is done per-route, not at the handshake. When in-app mTLS is disabled (the default, e.g. TLS terminated at ingress), this is a no-op and `ingress.mtls` remains the enforcement point.

2. **Per-route enforcement hook, fail-closed.** An `onRequest` (or `preParsing`) hook scoped to the three federation transport routes: when in-app mTLS is enabled, require `request.raw.socket.getPeerCertificate()` to be (a) **present**, (b) **authorized by the configured federation CA bundle**, and (c) **mapped to a registered peer domain**. Any of *no cert / untrusted CA / cert-identity-not-a-known-peer* → reject with a `decision_id`-bearing RFC 9457 4xx (fail-closed). Never fall through to bearer-only when enforcement is enabled.

3. **Fail-closed on misconfiguration.** If in-app mTLS is enabled but the CA bundle (or cert/key) is missing/unreadable, the process **fails at boot** — matching the existing `oidc?` / `loadFederationMtlsMaterial` config pattern (`apps/server/src/config.ts`, `subprocess-entry.ts` both throw on partial config). Never fail-open.

4. **Cert-identity → domain mapping.** The peer cert's identity — a **SAN URI** (owner decision, 2026-07-11: standard for machine/service identity, avoids CN parsing ambiguity, and lets the URI encode the domain id unambiguously, e.g. `spiffe://…/<domainId>` or `urn:scp:domain:<domainId>`) — maps to `federationPeers.id` (= the peer's `federation_self.domainId`, `apps/server/src/db/schema.ts`). The expected identity (or the CA that signs the peer's cert) is recorded **at pairing/enrollment** (`apps/server/src/federation/peers-repo.ts` `pairPeer`), which is already child-initiated. A presented cert whose SAN URI does not resolve to a known peer is rejected.

5. **Defense-in-depth — additive, not a replacement.** A federation request must pass mTLS **AND** bearer+RBAC **AND** (for imports) Ed25519 signature verification. **Ed25519 signatures remain THE integrity/authenticity authority** — mTLS adds *transport peer identity*, not message integrity. Hardening (owner decision, 2026-07-11: **SHOULD** for v1 — advisory, not a hard requirement, keeping room for future relay/multi-hop topologies): bind the mTLS peer identity to the bundle's claimed `exporterDomainId`, rejecting a request whose transport peer ≠ the domain the bundle claims to originate from — this stops an otherwise-valid peer from relaying/replaying another domain's bundle. When the binding fails it is logged and surfaced (a Decision), not silently ignored, so a MUST can be turned on later without code change.

6. **Optionality + scope.** Default **disabled**. Only the three HTTP transport routes are gated. The air-gap **file transport** (`scp federation export/import`) is HTTP-independent and **unaffected**.

7. **Precedence vs. M8 ingress-mTLS** (two valid topologies, documented, not mutually exclusive):
   - **TLS terminated at ingress** → use `ingress.mtls` (nginx verifies at the edge); the app sees plain HTTP and cannot see the client cert, so in-app mTLS stays off.
   - **App terminates TLS** (direct exposure / TLS-passthrough proxy) → use in-app mTLS.
   - Enabling **both** is redundant-but-harmless (edge verifies, app re-verifies). The load-bearing caveat: in-app mTLS only works if the TLS connection actually reaches the app — any TLS-terminating hop in front strips the client cert.

8. **Certificate revocation via a file-based CRL (owner decision, 2026-07-11).** The listener is configured with a **CRL** (`crlFile`) alongside the CA bundle. A presented cert whose serial is on the CRL fails Node's TLS verification (`socket.authorized === false`, with an `authorizationError` such as `CERT_REVOKED`), and is rejected fail-closed by the per-route hook via the *same* `authorized === true` check that already rejects an untrusted-CA cert — so revocation needs no separate code path, only that the CRL be supplied to the TLS context. **Air-gap-first, by requirement:** the CRL is a **file** delivered out-of-band over the same channel as the CA material and `.scpbundle` files — **no OCSP and no network CRL-distribution-point fetch** (both would violate CLAUDE.md #5). It is loaded at boot and **reloadable without a full restart** (a file-watch or SIGHUP reload of the TLS context — implementation choice) so a revocation can take effect in a running air-gapped instance by dropping in a new CRL file. **Stale-CRL policy** (an air-gap tension worth calling out): a CRL past its `nextUpdate` no longer reflects revocations issued after that time, yet in a disconnected domain a CRL may *legitimately* be stale between physical deliveries. v1 proposes to **warn loudly and continue** on an expired CRL, with a config knob to **hard-fail** for higher-assurance domains that would rather reject all federation than trust a stale revocation list — never silently trust it. (This is the one genuinely air-gap-specific design tension in the feature; flagged for the implementer to get right, not to silently pick.)

**Configuration** (matching `config.ts` house style — a new optional nested block, `undefined` = disabled, partial config throws at boot): `federationServerMtls?: { caFile, certFile, keyFile, crlFile, crlHardFailOnExpiry }` from `SCP_FEDERATION_SERVER_MTLS_*` env (`…_CA_FILE`, `…_CERT_FILE`, `…_KEY_FILE`, `…_CRL_FILE`, `…_CRL_HARD_FAIL_ON_EXPIRY`), mirroring the existing client-side `SCP_FEDERATION_MTLS_*`. Helm: a `federation.serverMtls` values block rendering the env + mounting the CA/cert/key/**CRL** secret, sibling to the existing `federation.mtls` (client) and `ingress.mtls` (edge) knobs. Because CRLs rotate more often than CA roots, the CRL should be mountable/updatable independently (e.g. its own key in the secret, or a dedicated ConfigMap/Secret) so a refresh doesn't require re-rolling the CA material.

## Consequences

**Positive**
- Transport-level peer identity for federation — defense-in-depth beyond bearer+RBAC+Ed25519; closes MAJOR #3.
- Works in TLS-passthrough / direct-exposure topologies where ingress-mTLS isn't available.
- Fail-closed on both missing-cert and misconfiguration; explainable (`decision_id`).
- **Revocation that survives air-gap** — file-based CRL, no OCSP/network dependency; a revoked peer cert is rejected, and a fresh CRL can be dropped into a running disconnected instance.
- No new required stateful dependency (#4 preserved); no API/SDK/CLI surface change; air-gap file transport untouched (#5).

**Negative / cost**
- To use it, the app must terminate TLS — an operational change for k8s deploys that terminate at ingress (those keep `ingress.mtls`).
- `requestCert: true` asks *all* clients for a cert; harmless for browsers/CLI under `rejectUnauthorized: false`, but a few exotic clients/proxies mishandle a cert request — must be documented.
- Certificate/CA lifecycle + rotation become an operator burden.
- **CRL freshness** is an added operator burden in air-gap (a stale CRL between physical deliveries; the warn-vs-hard-fail-on-expiry knob is a genuine operational trade-off the operator must set per domain).
- Adds config surface + boot-time validation.

## Alternatives considered

1. **Ingress-mTLS only (M8 status quo)** — rejected as the *sole* mechanism: nginx-specific, whole-Ingress-scoped, unavailable when the app terminates TLS. **Kept** as the complementary option for ingress-termination topologies (§Decision 7).
2. **Application-layer signed peer-identity header** — rejected: reinvents mTLS, worse. Ed25519 bundle signatures already give message-level authenticity; transport peer identity is exactly what TLS client certs are for.
3. **Do nothing (bearer + RBAC + Ed25519 only)** — rejected: bearer authenticates a token, not the peer; Ed25519 authenticates the signer, not the connection. MAJOR #3 explicitly flagged the transport-identity gap.

## Resolved decisions (owner review, 2026-07-11)

- **Cert identity: SAN URI** (not CN) — encodes the domain id unambiguously; maps to `federationPeers.id`.
- **`exporterDomainId` == peer-cert binding: SHOULD** (advisory in v1, logged/surfaced when it fails so a MUST is a later config flip, not a code change).
- **Revocation: file-based CRL, in scope for v1** — air-gap-deliverable (no OCSP / no network CRL-DP), reloadable without full restart, with a warn-vs-hard-fail-on-expiry knob.

## Remaining implementation-time notes (refinements, not blockers)

- Exact **SAN URI scheme** to standardize on (`spiffe://` vs a `urn:scp:domain:<id>` form) and the precise value recorded at `pairPeer` — pick one and document it in the peer-pairing flow.
- **CRL reload mechanism** — file-watch vs SIGHUP; must atomically swap the TLS context's CRL without dropping in-flight connections.
- **Stale-CRL default** — ship `crlHardFailOnExpiry` defaulting to `false` (warn-and-continue) with the hard-fail path fully implemented and tested, so higher-assurance domains can opt in.
