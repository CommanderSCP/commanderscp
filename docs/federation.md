# federation

Long-form reference for the **federation** subsystem — the rationale, hazards and open items that
used to sit inline. Each source file below carries a one-line headline at the site and points here.

> Partial: 571 of 571 multi-line comment blocks in this subsystem are here. The rest are
> still inline, pending a hand-written one-line headline.

## Files

- [`apps/server/src/federation/artifact-verify.test.ts`](#apps-server-src-federation-artifact-verify-test-ts) — §1–§3
- [`apps/server/src/federation/artifact-verify.ts`](#apps-server-src-federation-artifact-verify-ts) — §4–§19
- [`apps/server/src/federation/audit-witness-repo.ts`](#apps-server-src-federation-audit-witness-repo-ts) — §20–§20
- [`apps/server/src/federation/audit-witness.integration.test.ts`](#apps-server-src-federation-audit-witness-integration-test-ts) — §21–§21
- [`apps/server/src/federation/auto-relay.integration.test.ts`](#apps-server-src-federation-auto-relay-integration-test-ts) — §22–§33
- [`apps/server/src/federation/auto-relay.test.ts`](#apps-server-src-federation-auto-relay-test-ts) — §34–§35
- [`apps/server/src/federation/auto-relay.ts`](#apps-server-src-federation-auto-relay-ts) — §36–§47
- [`apps/server/src/federation/boundary-bundle-ref.test.ts`](#apps-server-src-federation-boundary-bundle-ref-test-ts) — §48–§48
- [`apps/server/src/federation/boundary-bundle-ref.ts`](#apps-server-src-federation-boundary-bundle-ref-ts) — §49–§52
- [`apps/server/src/federation/bundle-transfer-read-plan.integration.test.ts`](#apps-server-src-federation-bundle-transfer-read-plan-integration-test-ts) — §53–§54
- [`apps/server/src/federation/bundle-transfers-repo.ts`](#apps-server-src-federation-bundle-transfers-repo-ts) — §55–§58
- [`apps/server/src/federation/cosign-distribution.integration.test.ts`](#apps-server-src-federation-cosign-distribution-integration-test-ts) — §59–§59
- [`apps/server/src/federation/crl-parse.test.ts`](#apps-server-src-federation-crl-parse-test-ts) — §60–§60
- [`apps/server/src/federation/crl-parse.ts`](#apps-server-src-federation-crl-parse-ts) — §61–§62
- [`apps/server/src/federation/crl-reload.test.ts`](#apps-server-src-federation-crl-reload-test-ts) — §63–§63
- [`apps/server/src/federation/cursors-repo.ts`](#apps-server-src-federation-cursors-repo-ts) — §64–§71
- [`apps/server/src/federation/delivery-s3.integration.test.ts`](#apps-server-src-federation-delivery-s3-integration-test-ts) — §72–§72
- [`apps/server/src/federation/delivery-s3.ts`](#apps-server-src-federation-delivery-s3-ts) — §73–§77
- [`apps/server/src/federation/delivery-target.integration.test.ts`](#apps-server-src-federation-delivery-target-integration-test-ts) — §78–§78
- [`apps/server/src/federation/delivery-target.test.ts`](#apps-server-src-federation-delivery-target-test-ts) — §79–§82
- [`apps/server/src/federation/delivery-target.ts`](#apps-server-src-federation-delivery-target-ts) — §83–§98
- [`apps/server/src/federation/divergence-rails.integration.test.ts`](#apps-server-src-federation-divergence-rails-integration-test-ts) — §99–§99
- [`apps/server/src/federation/domain-local-inheritance.integration.test.ts`](#apps-server-src-federation-domain-local-inheritance-integration-test-ts) — §100–§100
- [`apps/server/src/federation/domain-local-invisibility.integration.test.ts`](#apps-server-src-federation-domain-local-invisibility-integration-test-ts) — §101–§105
- [`apps/server/src/federation/domain-local-rbac.integration.test.ts`](#apps-server-src-federation-domain-local-rbac-integration-test-ts) — §106–§112
- [`apps/server/src/federation/domain-local.ts`](#apps-server-src-federation-domain-local-ts) — §113–§113
- [`apps/server/src/federation/export-repo.ts`](#apps-server-src-federation-export-repo-ts) — §114–§118
- [`apps/server/src/federation/federation-member-of-exemption.integration.test.ts`](#apps-server-src-federation-federation-member-of-exemption-integration-test-ts) — §119–§121
- [`apps/server/src/federation/federation-outbound.test.ts`](#apps-server-src-federation-federation-outbound-test-ts) — §122–§123
- [`apps/server/src/federation/federation-outbound.ts`](#apps-server-src-federation-federation-outbound-ts) — §124–§132
- [`apps/server/src/federation/federation-pair-authz.integration.test.ts`](#apps-server-src-federation-federation-pair-authz-integration-test-ts) — §133–§137
- [`apps/server/src/federation/federation-poke-chain.integration.test.ts`](#apps-server-src-federation-federation-poke-chain-integration-test-ts) — §138–§138
- [`apps/server/src/federation/federation-poke.integration.test.ts`](#apps-server-src-federation-federation-poke-integration-test-ts) — §139–§144
- [`apps/server/src/federation/federation-sync-cadence.test.ts`](#apps-server-src-federation-federation-sync-cadence-test-ts) — §145–§148
- [`apps/server/src/federation/federation-sync-loop.integration.test.ts`](#apps-server-src-federation-federation-sync-loop-integration-test-ts) — §149–§153
- [`apps/server/src/federation/federation-sync-refusal-dedupe.integration.test.ts`](#apps-server-src-federation-federation-sync-refusal-dedupe-integration-test-ts) — §154–§154
- [`apps/server/src/federation/federation-sync-startup-singleton.integration.test.ts`](#apps-server-src-federation-federation-sync-startup-singleton-integration-test-ts) — §155–§157
- [`apps/server/src/federation/federation-sync.integration.test.ts`](#apps-server-src-federation-federation-sync-integration-test-ts) — §158–§161
- [`apps/server/src/federation/federation-sync.ts`](#apps-server-src-federation-federation-sync-ts) — §162–§181
- [`apps/server/src/federation/federation.integration.test.ts`](#apps-server-src-federation-federation-integration-test-ts) — §182–§216
- [`apps/server/src/federation/foreign-origin-writes.integration.test.ts`](#apps-server-src-federation-foreign-origin-writes-integration-test-ts) — §217–§225
- [`apps/server/src/federation/freeze-federation.integration.test.ts`](#apps-server-src-federation-freeze-federation-integration-test-ts) — §226–§226
- [`apps/server/src/federation/handfill-object-write-authority.integration.test.ts`](#apps-server-src-federation-handfill-object-write-authority-integration-test-ts) — §227–§232
- [`apps/server/src/federation/handfill-repo.ts`](#apps-server-src-federation-handfill-repo-ts) — §233–§245
- [`apps/server/src/federation/import-repo.ts`](#apps-server-src-federation-import-repo-ts) — §246–§275
- [`apps/server/src/federation/inbox-loop.integration.test.ts`](#apps-server-src-federation-inbox-loop-integration-test-ts) — §276–§279
- [`apps/server/src/federation/inbox-loop.test.ts`](#apps-server-src-federation-inbox-loop-test-ts) — §280–§280
- [`apps/server/src/federation/inbox-loop.ts`](#apps-server-src-federation-inbox-loop-ts) — §281–§290
- [`apps/server/src/federation/init-role-door.integration.test.ts`](#apps-server-src-federation-init-role-door-integration-test-ts) — §291–§291
- [`apps/server/src/federation/journal-repo.ts`](#apps-server-src-federation-journal-repo-ts) — §292–§294
- [`apps/server/src/federation/lost-tail-simulation.integration.test.ts`](#apps-server-src-federation-lost-tail-simulation-integration-test-ts) — §295–§295
- [`apps/server/src/federation/mtls-enforcement.test.ts`](#apps-server-src-federation-mtls-enforcement-test-ts) — §296–§296
- [`apps/server/src/federation/mtls-enforcement.ts`](#apps-server-src-federation-mtls-enforcement-ts) — §297–§304
- [`apps/server/src/federation/mtls.integration.test.ts`](#apps-server-src-federation-mtls-integration-test-ts) — §305–§308
- [`apps/server/src/federation/outpost-binding.ts`](#apps-server-src-federation-outpost-binding-ts) — §309–§312
- [`apps/server/src/federation/outpost-config-sync.integration.test.ts`](#apps-server-src-federation-outpost-config-sync-integration-test-ts) — §313–§316
- [`apps/server/src/federation/outpost-handfill-wedge.integration.test.ts`](#apps-server-src-federation-outpost-handfill-wedge-integration-test-ts) — §317–§322
- [`apps/server/src/federation/outpost-local-ui.integration.test.ts`](#apps-server-src-federation-outpost-local-ui-integration-test-ts) — §323–§323
- [`apps/server/src/federation/outpost-object.integration.test.ts`](#apps-server-src-federation-outpost-object-integration-test-ts) — §324–§328
- [`apps/server/src/federation/outposts-rbac.integration.test.ts`](#apps-server-src-federation-outposts-rbac-integration-test-ts) — §329–§329
- [`apps/server/src/federation/outposts-repo.ts`](#apps-server-src-federation-outposts-repo-ts) — §330–§341
- [`apps/server/src/federation/overlay-repo.ts`](#apps-server-src-federation-overlay-repo-ts) — §342–§349
- [`apps/server/src/federation/peer-name-identity.integration.test.ts`](#apps-server-src-federation-peer-name-identity-integration-test-ts) — §350–§351
- [`apps/server/src/federation/peer-patch.integration.test.ts`](#apps-server-src-federation-peer-patch-integration-test-ts) — §352–§354
- [`apps/server/src/federation/peers-repo.ts`](#apps-server-src-federation-peers-repo-ts) — §355–§368
- [`apps/server/src/federation/pipeline-hook-federation.integration.test.ts`](#apps-server-src-federation-pipeline-hook-federation-integration-test-ts) — §369–§371
- [`apps/server/src/federation/poke-metrics.ts`](#apps-server-src-federation-poke-metrics-ts) — §372–§373
- [`apps/server/src/federation/poke-rate-limit.ts`](#apps-server-src-federation-poke-rate-limit-ts) — §374–§374
- [`apps/server/src/federation/poke-sender.integration.test.ts`](#apps-server-src-federation-poke-sender-integration-test-ts) — §375–§376
- [`apps/server/src/federation/poke-sender.test.ts`](#apps-server-src-federation-poke-sender-test-ts) — §377–§379
- [`apps/server/src/federation/poke-sender.ts`](#apps-server-src-federation-poke-sender-ts) — §380–§384
- [`apps/server/src/federation/promotion-checksum.test.ts`](#apps-server-src-federation-promotion-checksum-test-ts) — §385–§385
- [`apps/server/src/federation/promotion-repo.ts`](#apps-server-src-federation-promotion-repo-ts) — §386–§410
- [`apps/server/src/federation/promotion-scan-step.integration.test.ts`](#apps-server-src-federation-promotion-scan-step-integration-test-ts) — §411–§422
- [`apps/server/src/federation/promotion-scan-step.test.ts`](#apps-server-src-federation-promotion-scan-step-test-ts) — §423–§428
- [`apps/server/src/federation/promotion-scan-step.ts`](#apps-server-src-federation-promotion-scan-step-ts) — §429–§453
- [`apps/server/src/federation/publish-domain-local.ts`](#apps-server-src-federation-publish-domain-local-ts) — §454–§456
- [`apps/server/src/federation/relay-builds-repo.ts`](#apps-server-src-federation-relay-builds-repo-ts) — §457–§464
- [`apps/server/src/federation/resync-repo.ts`](#apps-server-src-federation-resync-repo-ts) — §465–§467
- [`apps/server/src/federation/resync.integration.test.ts`](#apps-server-src-federation-resync-integration-test-ts) — §468–§468
- [`apps/server/src/federation/retrans-no-spa.integration.test.ts`](#apps-server-src-federation-retrans-no-spa-integration-test-ts) — §469–§469
- [`apps/server/src/federation/retrans-relay.integration.test.ts`](#apps-server-src-federation-retrans-relay-integration-test-ts) — §470–§474
- [`apps/server/src/federation/retrans-relay.ts`](#apps-server-src-federation-retrans-relay-ts) — §475–§498
- [`apps/server/src/federation/scan-db-preload.integration.test.ts`](#apps-server-src-federation-scan-db-preload-integration-test-ts) — §499–§500
- [`apps/server/src/federation/scan-evidence.test.ts`](#apps-server-src-federation-scan-evidence-test-ts) — §501–§501
- [`apps/server/src/federation/scan-evidence.ts`](#apps-server-src-federation-scan-evidence-ts) — §502–§512
- [`apps/server/src/federation/scan-exclusion-boundary-recheck.integration.test.ts`](#apps-server-src-federation-scan-exclusion-boundary-recheck-integration-test-ts) — §513–§518
- [`apps/server/src/federation/scope-filter.test.ts`](#apps-server-src-federation-scope-filter-test-ts) — §519–§521
- [`apps/server/src/federation/scope-filter.ts`](#apps-server-src-federation-scope-filter-ts) — §522–§526
- [`apps/server/src/federation/self-origin-check.integration.test.ts`](#apps-server-src-federation-self-origin-check-integration-test-ts) — §527–§527
- [`apps/server/src/federation/self-origin-check.ts`](#apps-server-src-federation-self-origin-check-ts) — §528–§532
- [`apps/server/src/federation/self-repo.ts`](#apps-server-src-federation-self-repo-ts) — §533–§534
- [`apps/server/src/federation/status-honesty.integration.test.ts`](#apps-server-src-federation-status-honesty-integration-test-ts) — §535–§536
- [`apps/server/src/federation/status-pending-export.integration.test.ts`](#apps-server-src-federation-status-pending-export-integration-test-ts) — §537–§538
- [`apps/server/src/federation/status-repo.ts`](#apps-server-src-federation-status-repo-ts) — §539–§546
- [`apps/server/src/federation/sync-scope-asymmetry.integration.test.ts`](#apps-server-src-federation-sync-scope-asymmetry-integration-test-ts) — §547–§552
- [`apps/server/src/federation/test-bundle-promotion.integration.test.ts`](#apps-server-src-federation-test-bundle-promotion-integration-test-ts) — §553–§553
- [`apps/server/src/federation/test-support/isolated-domain.ts`](#apps-server-src-federation-test-support-isolated-domain-ts) — §554–§555
- [`apps/server/src/federation/test-support/mtls-pki.ts`](#apps-server-src-federation-test-support-mtls-pki-ts) — §556–§558
- [`apps/server/src/federation/unattached-change-status-repo.ts`](#apps-server-src-federation-unattached-change-status-repo-ts) — §559–§562
- [`apps/server/src/federation/unattached-change-status.integration.test.ts`](#apps-server-src-federation-unattached-change-status-integration-test-ts) — §563–§563
- [`apps/server/src/federation/upstream-freshness.test.ts`](#apps-server-src-federation-upstream-freshness-test-ts) — §564–§566
- [`apps/server/src/federation/upstream-freshness.ts`](#apps-server-src-federation-upstream-freshness-ts) — §567–§571

## `apps/server/src/federation/artifact-verify.test.ts`

### §1. Unit wiring of the verifier's cosign-facing options

Unit wiring of `verifyAuthorizedArtifactSet`'s cosign-facing options (the @scp/cosign seam is mocked — these prove the WIRING; the live cosign behavior rides the M15.5(c)/M17.4(b) integration suites):

```text
- PER-HOST TLS scoping: the `allowInsecureRegistry` predicate form grants cosign's
  `--allow-insecure-registry` for exactly the registry host each bound ref dials — mirroring
  skopeo's per-host `--…-tls-verify=false` (SCP_RELAY_INSECURE_HOSTS) — and NEVER for an
  unlisted or hostless ref. This cannot be observed live against a Testcontainers loopback
  registry: cosign's go-containerregistry auto-downgrades loopback registry hosts to HTTP
  with or without the flag, so the negative case only shows on non-loopback hosts.
- PER-INVOCATION subprocess env: `cosignEnv` (e.g. a scratch `DOCKER_CONFIG` for credentialed
  source registries) reaches the cosign invocation as its `env` option — the multi-tenant
  alternative to a process-global `process.env` mutation, which would leak one org's registry
  auth into every concurrently spawned subprocess.
```

### §2. The BLOB byte channel, fetched for real over loopback

The BLOB byte channel, fetched for real over loopback. `resolveBlob` classifies the URL's addresses with the egress guard and then dials one of THEM — it no longer hands the hostname back to `fetch`, which would resolve it a second time and reopen the DNS-rebinding window the guard exists to close (see `plugin-host/egress-guard.ts`'s `createEgressPinRegistry`, where the pin is proven at socket level). These cases keep that rewiring honest: the bytes still arrive, an absent blob is still `null`, and an off-allowlist URL is still refused before any request.

### §3. The reader throws on a non-2xx without reading the body

The reader throws on a non-2xx without reading the body, and undici's `Agent.close()` waits for in-flight requests: a body nobody reads never finishes, so the teardown hung until the abandoned body was garbage-collected (measured on undici 7.29.0: 10/10 runs still pending after 5s with this 1 MiB response). `pre-deploy-gate` calls the verifier with no timeout of its own, so that turned a fail-closed verification error into an unbounded stall the registry's response size gets to decide. The bound below is the assertion; the test timeout is only the backstop for the "never settles" case.

## `apps/server/src/federation/artifact-verify.ts`

### §4. Per-artifact byte verification at the receiving outpost

M17.4(b) — PER-ARTIFACT BYTE VERIFICATION at the receiving outpost, a PRE-DEPLOY gate.

## Where this sits (and what it is NOT)

M17.4 has two halves. Part (a) (#106, promotion-repo.ts::verifyPromotionManifest) is the METADATA verify that runs at bundle IMPORT: it cosign-verifies the commander's self-binding manifest and asserts `bundle.artifacts` EXACTLY equals the signed `manifest.artifacts` set — so after (a), "the arrived artifact SET == the authorized SET" is already proven, and that verified set is recorded on the imported change's `sourceRef.artifacts` (with `promotionManifest`).

Part (b) — THIS module — is the complementary BYTE verify, and it deliberately canNOT run at import: a federation bundle carries no bytes (ADR-0009), the operator side-loads the artifact BYTES into the outpost's local registry AFTER the metadata import (or, commercially, the bytes are commander-registry-resident). So (b) is a PRE-DEPLOY gate: before SCP triggers the deploy executor for a promoted change, it re-reads the registry the bytes landed in and, for EACH artifact in the (a)-verified authorized set, proves the BYTES are present and their signature verifies against the exporter's distributed cosign public key. `verifyPromotionManifest` proved "these are the authorized digests"; this proves "the bytes for THOSE digests are here and authentic". Together they complete M17.4.

## Coordinate-not-execute (charter principle 1)

SCP only READS the registry to verify — `cosign verify` (OCI, registry-attached signature) and `cosign verify-blob` (blob, detached origin signature). It NEVER transports bytes between registries/domains (that is byte TRANSPORT, M15.5) and NEVER re-scans — receiver-side never-re-scan is UNCHANGED: the promotion scan step now executes once, at the commander, before signing (ADR-0020), and the export gate already enforced a passing scan per substantive artifact off that evidence — M17.1/E6. No byte-moving code lives here.

## Fail-closed

A MISSING artifact (bytes absent from the reachable registry) OR a failing/tampered/wrong-key signature makes that artifact FAIL, and any failing artifact blocks the deploy. Keyful and offline throughout (no Fulcio/Rekor) — see @scp/cosign.

### §5. ## Digest binding

## Digest binding (substitution/replay defense)

The signed promotion manifest binds `{type, digest, signatureRef}` — `location` is BUNDLE-SIDE metadata, populated when the bytes land, and is NOT covered by any signature. So `location` is hostile-controllable and must NEVER pick what gets verified: a location pointing at a DIFFERENT validly-signed artifact (same exporter key) would otherwise pass. This module therefore binds every verification to the AUTHORIZED `artifact.digest`:

```text
- OCI: the ref handed to `cosign verify` is CONSTRUCTED from the location's repository part +
  `@<artifact.digest>` — cosign then registry-verifies content-addressed bytes AT that digest.
  If the location carries a digest suffix that differs from `artifact.digest`, that is a
  substitution attempt → fail closed WITHOUT invoking cosign.
- blob: sha256 over the FETCHED bytes must equal `artifact.digest` before the detached
  signature verdict counts — validly-signed but WRONG bytes fail closed.
```

### §6. Bind a resolved OCI reference to the AUTHORIZED digest

Bind a resolved OCI reference to the AUTHORIZED digest: keep the repository (and any tag) part, force the digest to `artifact.digest`. A resolved ref whose own digest suffix disagrees with the authorized digest is a substitution attempt and fails WITHOUT invoking cosign.

Exported for the M15.5(c) retrans relay (federation/retrans-relay.ts), whose skopeo PULL step constructs its source refs with exactly this binding (ADR-0019 §2 step 2) — one implementation, shared, so the pull path and the verify path can never bind differently.

### §7. Resolves each authorized artifact to what cosign needs

Resolves each authorized artifact to the concrete thing `cosign verify` needs from the registry the bytes landed in. This is the ONLY seam that knows HOW the outpost locates bytes in ITS registry — decoupled on purpose from "verify the located bytes", because the concrete byte-landing channel (operator side-load into local Gitea vs. commander registry) is M15.5's concern. The verify logic below is registry-agnostic; it just consumes what the reader returns.

BOTH methods return `null` when the artifact's BYTES are absent from the reachable registry — a MISSING artifact, which the gate treats as fail-closed. They should NOT throw for "absent"; a thrown error is an infrastructure fault and is likewise treated fail-closed by the caller.

### §8. Whether verify may skip registry TLS, and how narrowly

Whether OCI `cosign verify` may skip registry TLS verification: a blanket boolean, or — preferred — a PER-HOST predicate over the registry `host[:port]` the ref dials (lowercased, from `ociRegistryHostOf`), so TLS-off is scoped to an explicit operator allowlist exactly the way skopeo's `--src/dest-tls-verify=false` is (e.g. the M15.5(c) relay's `SCP_RELAY_INSECURE_HOSTS`).

### §9. Extra environment for the verify subprocesses only

Extra environment variables for the cosign `verify` subprocesses ONLY (e.g. `DOCKER_CONFIG` pointing at a per-invocation scratch auth dir for credentialed source registries). Per-invocation by design — callers must never feed cosign credentials by mutating `process.env`, which would leak them into every concurrent subprocess (see `VerifyImageOptions.env` in @scp/cosign).

### §10. Verify EVERY artifact in the authorized set

Verify EVERY artifact in the authorized set — the pre-deploy gate's core. Never throws: every per-artifact failure (missing, tampered, wrong key, infra fault) is captured as `ok: false`, and the aggregate `ok` is true only when ALL artifacts verified. An EMPTY set verifies vacuously (`ok: true`) — a metadata-only promotion carrying no substantive bytes has nothing to byte-check, exactly as the export scan gate passes vacuously over zero substantive artifacts.

### §11. The production {@link ArtifactRegistryReader}

The production `ArtifactRegistryReader`: resolves artifacts from their `ArtifactRef.location` (and `signatureRef`) — the reference the receiving outpost's registry resolution populates when the bytes land (M15.5). Registry-agnostic by construction:

```text
- OCI: `location` (when set) is the fully-qualified, digest-pinned image ref in the local
  registry; absent an explicit `location`, an OCI `digest` alone does not locate a repository,
  so the artifact is UNRESOLVABLE → treated as absent (fail-closed) until the byte channel
  records where the image landed. The location's REGISTRY HOST is bundle-supplied and unsigned,
  so it is egress-guarded BEFORE cosign ever dials it: the host must appear in the
  operator-configured `SCP_ARTIFACT_OCI_REGISTRY_HOSTS` allowlist (ADR-0019 §4; fail-closed
  when unset), symmetric with the blob URL guard below — digest binding already prevents
  SUBSTITUTION, this prevents a hostile bundle picking the egress TARGET.
- blob: `location` is an HTTP(S) URL to fetch the blob bytes; `signatureRef` is an HTTP(S) URL
  to fetch the origin detached signature. A `404` (bytes not there yet) resolves to absent; a
  transport error propagates and the gate fails closed. BOTH URLs are bundle-supplied and
  unsigned, so they are SSRF-guarded before any request: they must fall under an
  operator-configured base URL (`SCP_ARTIFACT_BLOB_BASE_URLS`, fail-closed when unset), may
  never resolve to link-local/cloud-metadata or the unspecified address, redirects are refused,
  and responses are size-capped — see `assertBlobUrlAllowed`/`fetchBytes`.
```

This reads bytes only to HASH/VERIFY them (a temp buffer, never re-pushed) — a registry READ, not byte transport (M15.5). No credentials are held; the local registry is reachable to the outpost.

### §12. OCI-HOST EGRESS GUARD

OCI-HOST EGRESS GUARD (fail-closed, BEFORE cosign ever dials): the location's registry host is bundle-supplied, unsigned metadata. Digest binding (verifyOne) already prevents artifact SUBSTITUTION, but `cosign verify` still performs registry-API GETs against whatever host the location names — a blind egress channel symmetric to the blob fetch. The host must be operator-allowlisted (SCP_ARTIFACT_OCI_REGISTRY_HOSTS); throwing surfaces as a `verification error (fail-closed)` on the artifact, exactly like the blob URL guard.

### §13. SSRF GUARD (fail-closed, BEFORE any request)

SSRF GUARD (fail-closed, BEFORE any request): `location`/`signatureRef` are bundle-supplied, unsigned strings — a hostile bundle must not turn the outpost into a blind in-cluster GET client at deploy time. Both URLs must fall under an operator-CONFIGURED blob base URL (SCP_ARTIFACT_BLOB_BASE_URLS), and even then may never target link-local (cloud metadata) or the unspecified address. Throwing here surfaces as a `verification error (fail-closed)`.

### §14. Throws unless the URL falls under a configured blob base

Throws unless `url` falls under an operator-configured blob base URL (origin AND path prefix — the port matters: a same-host different-port URL is a different service). Reuses the plugin egress guard afterwards for the always-blocked classes (link-local/cloud-metadata, unspecified), DNS-resolved; loopback/private are permitted because the operator explicitly configured this base (the outpost-local registry is commonly in-cluster/private).

### §15. Defense in depth via the EXISTING plugin egress guard

Defense in depth via the EXISTING plugin egress guard: link-local (169.254/16 incl. cloud metadata, fe80::/10) and unspecified are blocked unconditionally, after DNS resolution. Empty allowlist + allowInternalPrivate=true → only those always-blocked classes apply here. The verified ADDRESSES are returned so `fetchBytes` can dial one of them rather than letting `fetch` resolve the name a second time — the classification is worth nothing if the socket asks DNS again (see `createEgressPinRegistry`). An operator-allowlisted base URL whose DNS an attacker controls is a narrow case, but it is the exact case this guard is here for.

### §16. Throws unless the registry host is on the allowlist

Throws unless the OCI ref's registry `host[:port]` matches an operator-configured allowlist entry EXACTLY (case-insensitive; no suffix/wildcard matching — a `host:port` is a specific service, exactly as the blob guard treats origins). UNSET/empty allowlist rejects every OCI location (fail-closed) — the operator opts the OCI verify egress in explicitly, symmetric with SCP_ARTIFACT_BLOB_BASE_URLS. `protected` (not private) so the M15.5(c) retrans relay's source-registry reader (retrans-relay.ts) can apply the SAME guard to its skopeo-pull refs — ADR-0019 §4: the relay's pull side uses the same two allowlists as the verify path.

### §17. Normalize a registry `host[:port]` allowlist

Normalize a registry `host[:port]` allowlist — the ONE parse shared by every comma-separated host-list configuration surface (`SCP_ARTIFACT_OCI_REGISTRY_HOSTS`, the pre-deploy gate's `SCP_ARTIFACT_INSECURE_HOSTS`, the relay's `SCP_RELAY_INSECURE_HOSTS`): entries trimmed and lowercased, empties dropped — so membership checks against `ociRegistryHostOf`'s lowercased output can never diverge between subsystems. Accepts the raw comma-separated env string or an already-split array.

### §18. The registry host an OCI reference would dial, or null

The registry `host[:port]` an OCI reference would dial, lowercased, or `null` when the ref names no explicit registry. Per the docker/OCI reference grammar the first `/`-separated component is a registry host only when it contains a `.` or a `:` or is exactly `localhost` — otherwise the ref is repo-only shorthand that an OCI client resolves against an IMPLICIT default registry, which an allowlist can never vouch for → `null` (caller fails closed).

### §19. `destroy()`, NOT `close()`

`destroy()`, NOT `close()`. `close()` waits for every in-flight request to finish, and a response whose body was never read never finishes: on undici 7.29.0 an unread body >= 64 KiB leaves `close()` pending until the abandoned body is garbage-collected — measured here as still pending after 5s on 10/10 runs with a 1 MiB body. Every exit that does NOT read the body (a non-2xx, an over-cap `content-length`, a 404 that carries one) would hang the caller instead of failing closed, and the caller is a pre-deploy gate with no timeout of its own — an attacker-visible registry response would decide how long verification stalls. `destroy()` tears the socket down unconditionally, which is what "short-lived, never pooled" meant.

## `apps/server/src/federation/audit-witness-repo.ts`

### §20. FEDERATION AUDIT WITNESS

FEDERATION AUDIT WITNESS (multi-region-instance-resilience.md §7.2.7). Records that this domain SAW a peer's audit-chain entry at a given origin sequence, from the `audit_segment` journal entries that importers used to discard. INFORMATIONAL — a witness NEVER blocks an import (import-repo.ts calls this from inside the apply loop but treats a witness as enrichment, not a gate).

Idempotent by `(org, origin, sequence)`: re-importing the same segment (an idempotent re-delivery) updates nothing and re-records nothing new. The content hash is asserted UNCHANGED on conflict — a peer that presented a DIFFERENT hash at a sequence it once witnessed would be a fork, but that is rail 4's job on the live path; here the witness is a passive detector the runbook reads later, so a conflicting re-witness simply keeps the first (earliest) observation rather than silently rewriting history.

## `apps/server/src/federation/audit-witness.integration.test.ts`

### §21. FEDERATION AUDIT WITNESS

FEDERATION AUDIT WITNESS (§7.2.7). A full-scope receiver, importing a peer's sync bundle, must persist a passive witness of that peer's audit-chain head from the `audit_segment` entries it used to discard — WITHOUT the witness ever blocking the import. This is what lets the post-failover runbook detect a truncation `scp audit verify` alone cannot see.

## `apps/server/src/federation/auto-relay.integration.test.ts`

### §22. M13.1b — the staging node's UNATTENDED ONWARD BYTE HOP

M13.1b — the staging node's UNATTENDED ONWARD BYTE HOP: THE 13.1b DoD suite (proposal §13.1, BUILD_AND_TEST.md M13.1b). Same topology-faithful harness as the M13.1a inbox suite — three REAL isolated federation domains (separate Postgres databases), real `registry:2` containers, the real cosign + skopeo binaries:

commander A ──.scpbundle──▶ retrans B ──signed byte tarball──▶ outpost C

The milestone's whole claim is "no operator command", so every case here asserts DATABASE or FILESYSTEM state — the ledger row, the Decision/audit trail, the bytes in the drop directory, `bundle_transfers` — never a log line and never "some action happened". Where a case exists to catch a specific regression, the comment says which one.

Two properties get the most weight because they are the ones that go wrong silently:

- The HIGH SIDE never builds. Both boundary nodes are `role: retrans` and both seed a ledger row at import, so the node whose BYTES ARRIVE must be stopped by the `forwarded` terminal state or it would produce a trail of fabricated refusals over a promotion that in fact crossed. - The permanent record is BOUNDED (#153). A failing change gets a finite number of verdicts and then writes NOTHING, ever — asserted as an exact row-count delta over `decisions` and `audit_events`, because "roughly stops" is how 1.44 GB/day happened in production.

### §23. The two scheduling columns the getter does not project

The two scheduling columns `getRelayBuild` does not project (the retry gate + the lease), plus the gate's SIZE measured ENTIRELY INSIDE POSTGRES (`next_attempt_at - updated_at`). The in-database subtraction is the point: comparing a DB timestamp against the test process's `Date.now()` is only as good as the clock agreement between the host and the container, so a VM whose clock runs ahead would make a "the gate is in the future" assertion pass over a backoff of zero — exactly the regression this needs to catch.

### §24. (5a) CAUSAL, NEVER DERIVED

(5a) CAUSAL, NEVER DERIVED — enabling the feature must not drain a historical backlog across the CDS. A promotion imported before the ledger existed simply has no row, and no predicate scan over `changes` may resurrect one.

### §25. (6) THE HIGH-SIDE CASE

(6) THE HIGH-SIDE CASE — the most consequential one. Both boundary nodes are `role: retrans` and both seed at import, so the node whose BYTES ARRIVE must be stopped by the `forwarded` terminal state. Without it that node enumerates a build it can never perform (its source registry is on the far side of the air gap) and buries a real crossing under fabricated refusals.

### §26. (7)+(11) REFUSAL → BACKOFF → EXHAUSTION → THE BOUND

(7)+(11) REFUSAL → BACKOFF → EXHAUSTION → THE BOUND. #153's pathology (a byte-identical block Decision restated once a tick forever, measured at 1.44 GB/day in production) is what this whole shape exists to not re-introduce, so the last assertion is EXACT: three more sweeps add zero rows to `decisions` and zero to `audit_events`.

### §27. (10) THE MANUAL EXIT

(10) THE MANUAL EXIT — `exhausted` must never be a trap needing superuser SQL. The operator's existing `POST /api/v1/federation/relay` both delivers the bytes and clears the state; this drives the route's two steps (build, then `reopenRelayBuild`) directly, since the route body is those two calls (routes/federation.ts, after the refusal check).

### §28. The claim is the atom, proven directly and deterministically

(a) THE CLAIM IS THE ATOM, proven directly and deterministically: two workers claiming the same row in concurrent transactions — the second blocks on the row lock and then re-evaluates the due predicate against the WINNER's committed row, so it comes back empty-handed rather than taking a second lease. An enumerate-then-update pair (whose read is stale by the time it writes) would hand out two.

### §29. (8) THE FENCE

(8) THE FENCE — a lease can expire mid-build, so two workers legitimately hold one change in sequence. Every release carries the `attempts` its own claim returned; a stale claimant must not clobber the winner's state, and above all must never persist "nothing crossed the boundary" about bytes that did.

### §30. (12) STRICT DROP RESOLUTION

(12) STRICT DROP RESOLUTION — the automated path must refuse a config gap the operator-invoked route 400s on, rather than falling through to the instance env and marking a build done whose bytes reached a directory the s3-expecting CDS never watches. A deferral costs no attempt: it is a config gap, not a verdict.

### §31. STRICT DROP, THE OTHER HALF

STRICT DROP, THE OTHER HALF — the topology strictness must NOT refuse.

WHY THIS CASE EXISTS, specifically. Strictness is a refusal, and a refusal that fires too widely is indistinguishable from the feature being broken: every obligation reads `deferred` forever, with no attempt, no Decision and no audit event to explain it — at a CDS, where nobody is watching a terminal. The over-refusal is not hypothetical: the first cut keyed on the RESOLVED outbound directory alone, so it flagged any peer that merely HAD no outbound dir of its own, which in the normal retrans topology is the upstream commander. This case pins the exact arrangement the milestone requires and the earlier filter killed:

```text
- an UPSTREAM peer whose deliveryTarget declares only `inDir` (the documented M13.1a inbox
  shape — the schema makes `outDir` optional precisely so a peer can be an inbox and no more),
- a DOWNSTREAM boundary peer carrying the only `outDir`,
- and NO `SCP_RELAY_OUT_DIR`, which is legitimate exactly because the boundary peer has one.
```

It asserts the tarball FILE exists, not that some outcome string says "built": the bug this catches produced a perfectly well-formed `deferred` outcome and an empty directory.

### §32. THE PAYLOAD BOUND

THE PAYLOAD BOUND — #153 arriving by SIZE instead of by row count.

The attempt cap bounds how MANY permanent rows a failing promotion leaves. It says nothing about how BIG each one is, and every ingredient of a refusal's payload comes from the imported bundle: the artifact set has no schema maximum, `ArtifactRefSchema.digest` is a bare `z.string()`, and each failure embeds skopeo's verbatim stderr. Unbounded, one imported promotion could write megabytes into `decisions` AND `audit_events` AND the sync journal — which ADR-0024 classes as never-deleted — so the bound has to be on bytes, not only rows.

The oversized artifact set is injected straight onto the already-imported change rather than built through the export path, deliberately: what is under test is the PERSISTENCE bound, i.e. what happens once a large set has legitimately arrived. Verification is not in scope here and is covered elsewhere; `buildRelayTarball` reads exactly this field as its authorized set.

### §33. ARRIVING BYTES CORRECT AN EXHAUSTED ROW

ARRIVING BYTES CORRECT AN EXHAUSTED ROW — the misconfigured-high-side recovery.

Both boundary nodes are `role: retrans` and both seed at import, so a high side with SCP_RETRANS_AUTO_RELAY mistakenly set burns its verdict budget in minutes of backoff — while the CDS transfer that will deliver the tarball can take far longer (the default claim lease is an hour precisely because multi-GB moves are slow). If `forwarded` could only correct a `pending` row, the arriving bytes would be unable to correct the record they disprove: the row would stay `exhausted`, asserting the hop never happened, on the very node that just validated and forwarded it.

## `apps/server/src/federation/auto-relay.test.ts`

### §34. M13.1b — the auto-relay's CONFIG SURFACE, unit-level

M13.1b — the auto-relay's CONFIG SURFACE, unit-level. Every knob here decides how much unattended work happens at a cross-domain boundary and how much permanent record a failing promotion leaves behind, so each assertion pins a NUMBER a mutation would move, not a shape.

DEFAULT-OFF is the load-bearing one: an instance whose operator never set `SCP_RETRANS_AUTO_RELAY=1` must NEVER create the queue, never tick, and never move a byte across the boundary.

### §35. The re-schedule matrix, the same rule applied to this loop

M13.1b — THE RE-SCHEDULE MATRIX, the M14.4 rule applied to this loop (its sibling proof for the sync loop is `federation-sync-cadence.test.ts`'s "force vs. reschedule are two flags").

WHY IT MATTERS HERE. pg-boss computes a singleton slot from `now()` AT INSERT, so a poke wake landing in a different slot than the already-pending interval tick is NOT deduped. If a poke tick re-scheduled, every poke would leave a second pending interval job and the "reliable floor" would quietly densify — at a CDS boundary, where each tick can pull GBs through skopeo. And the inverse regression is worse and completely silent: if an INTERVAL tick stopped re-scheduling, the self-rescheduling chain dies at the first tick and the boundary stalls forever with no error anywhere. Both directions have to be pinned, which is why this is a matrix and not one case.

The batch cases exist because the keying is "the batch contains a NON-POKE job", not "no poke is present": pg-boss 10.4.2 defaults `batchSize` to 1, so a mixed batch is hardening rather than a live bug — but a future `batchSize > 1` would otherwise let one poke consume the pending interval job AND suppress its re-schedule, permanently killing the chain until a process restart.

## `apps/server/src/federation/auto-relay.ts`

### §36. M13.1b — the staging node's AUTO-RELAY

M13.1b — the staging node's AUTO-RELAY (docs/proposals/airgap-cds-validate-promote.md §13.1, BUILD_AND_TEST.md M13.1b): *"when a promotion import succeeds on a `retrans`-role instance, the loop schedules `buildRelayTarball` for it."* This is the last operator-gated step of the CDS boundary walk — M14.4 shipped the poke chain unattended end to end but left hop 2's BYTES needing an operator command (its honest-scope note, owner decision D3). This module removes that command and nothing else.

## What it is NOT

Not a new trust decision, not a new verification path, not a new authority. It calls exactly the function the route calls — `retrans-relay.ts::buildRelayTarball`, whose ADR-0004 409 role arm is UNTOUCHED — so an unattended relay leaves byte-identical Decisions and hash-chained audit events to an operator-invoked one. It writes no promotion state: **the retrans never terminates a promotion** (ADR-0004), and nothing here touches `changes.state`, waves, approvals, or executors. It merges no channel artifacts: the `.scpbundle` and the byte tarball stay two separate files (ADR-0009 — metadata bundles remain byte-free). It re-signs nothing and adds no verification authority — the receiving outpost's M17.4(a)+(b) gates run exactly as before.

## The work list is CAUSAL, never derived

The sweep drives exclusively off `federation_relay_builds` (drizzle/0047), whose rows are written by the promotion import itself (`promotion-repo.ts`, same transaction, `role: retrans` only). It deliberately does NOT stand a predicate scan over `changes` for "imported + manifest + artifacts", because that description also fits every promotion the HIGH-side retrans successfully FORWARDED: that node would enumerate builds it can never perform — its source registry is on the far side of the air gap, which is the entire reason a tarball exists — and would bury a real crossing under a trail of fabricated refusals. Causal seeding also means enabling the feature never drains a historical backlog across the CDS, and `validateAndForwardRelayTarball` marking its row `forwarded` is the positive signal that this node receives the hop rather than building it.

## Opt-in, and why its own loop

DEFAULT-OFF behind `SCP_RETRANS_AUTO_RELAY=1`. Unattended byte egress across a security boundary is the most consequential automation in this system, and the codebase's shape for every unattended loop is an explicit instance-level operator enable (`SCP_INBOX_LOOP`, `SCP_FEDERATION_SYNC_LOOP`) rather than replicated config — an upstream operator must never be able to switch on byte movement at someone else's boundary. Leaving it unset keeps exactly the M14.4 posture: ingest automated, egress hand-gated. **Enable it on the retrans that can reach the SOURCE registry (the low side).** A high-side node has nothing to build; if it is enabled there anyway, the forward path's `forwarded` terminal state stops the obligation as soon as the bytes arrive.

It is its OWN pg-boss loop, not a phase of the inbox tick, for a correctness reason: a CONNECTED low-side retrans receives its promotion bundles over the M14.0 HTTP live-sync, not as files, so it may legitimately run with no inbox at all. Hanging auto-relay off `SCP_INBOX_LOOP` would make the whole feature unreachable in exactly that topology. One queue per capability is also what `main.ts` already does for reconcile / watchdog / observe / inbox / federation-sync.

## Trigger: interval floor + poke optimization (ADR-0009)

A self-rescheduling pg-boss singleton cloned from `startInboxLoop` is the RELIABLE FLOOR; `wakeAutoRelayNow` — the third leg of the M14.4 poke handler, beside the sync and inbox wakes — is the low-latency optimization. A dropped poke self-heals on the next interval tick, which is precisely ADR-0009's never-poke-only reliability model. A poke wake does NOT re-schedule (M14.4's reasoning: pg-boss computes a singleton slot at insert, so a wake landing in a different slot would leave two pending ticks).

## Bounded by construction — #153's bug class, deliberately not re-introduced

`buildRelayTarball` turns EVERY per-artifact failure into a refusal carrying a block Decision, and cannot distinguish a transient registry outage from a permanently tampered artifact. Retrying every tick would restate a block Decision once a minute forever per failing change — the exact pathology PR #153 measured at 1.44 GB/day in production, and worse here because each Decision is cited by a hash-chained audit event, which ADR-0024 classes as never-deleted. So:

```text
- a failing change gets `autoRelayMaxAttempts` VERDICTS (not claims — an evicted worker
  must not spend the budget without deciding anything), with exponential backoff, then TERMINAL
  `exhausted` and no further work;
- a Decision is written ONLY when the fenced ledger write that makes it terminal succeeded, so a
  verdict can never be re-derived and re-written on the next tick;
- the persisted failure payload is truncated at the source (`RELAY_FAILURE_DETAIL_LIMIT`), so
  the bound is on bytes as well as rows.
```

Worst case per permanently-failing change: `maxAttempts` `retrans-relay-validate` blocks + one `retrans-auto-relay` block, each with its audit event — a fixed, small, one-time cost.

The exit from `exhausted` is the operator's existing `POST /api/v1/federation/relay`, unchanged and always available: a successful manual build delivers the bytes AND clears the row (the route calls `reopenRelayBuild`), so a terminal row is never a trap needing superuser SQL.

## Zero-trust survives automation

Nothing here reads the inbox, parses a file name, or takes a byte of untrusted input: its only inputs are this instance's OWN federation role, its OWN operator env, and rows the M17.4(a)- verified import path wrote in its OWN database. The authorized artifact set is re-derived inside `buildRelayTarball` from the signed manifest on every attempt, the two egress allowlists (`SCP_ARTIFACT_OCI_REGISTRY_HOSTS` / `SCP_ARTIFACT_BLOB_BASE_URLS`) guard every dial as before, and the onward drop directory is operator config (`SCP_DELIVERY_ROOTS`-bounded when per-peer) — never anything a bundle said.

### §37. The CLAIM LEASE

The CLAIM LEASE (`SCP_RETRANS_AUTO_RELAY_LEASE_SECONDS`, default 3600 = 1 h, clamped to [60, 86400]). A claimed row is invisible to other workers until the lease expires, so N replicas produce at most one build per change per window; a process that dies mid-build lets its lease lapse and the change is reclaimed — no janitor. It should comfortably exceed the slowest realistic pull of a multi-GB artifact set: a lease that expires mid-build is survivable (every release is fenced on the claim, so the slow worker's late write is refused rather than clobbering the fast one's result) but wasteful.

### §38. One failed attempt

One failed attempt: record the verdict and schedule the next one, or go TERMINAL `exhausted`.

THE ORDER MATTERS. The ledger write happens FIRST and its row count is the gate on everything else. If it matched nothing, this worker's lease was taken over by another while the build ran — that other worker owns the outcome, and writing a Decision or audit event here would either contradict it or (worse) leave a verdict with no terminal state behind it, which the next tick would re-derive and re-write forever. So a lost claim writes NOTHING.

Exhaustion is the ONE thing an unattended sweep does that has no manual-CLI equivalent — the loop giving up — so it gets its own `retrans-auto-relay` block Decision + hash-chained audit event (charter principle 6: no unattended terminal state is explainable-by-nobody).

### §39. One org's auto-relay sweep

One org's auto-relay sweep. Exported for the integration suite (the 13.1b DoD is asserted through it); production reaches it via `runAutoRelaySweep`.

`multiTenantInstance` is threaded from the caller (which already enumerated orgs) rather than re-counted here — see the drop-resolution guard below for why it matters.

### §40. Normally unreachable in production

Normally unreachable in production: `startAutoRelayLoop` returns an inert handle and never creates the queue when the flag is unset, so nothing ticks at all. Kept as belt-and-braces for the test seam and for a live env change under a running loop — NOT as the anti-silence mechanism. The real "this hop is owed but automation is off" signal is emitted ONCE PER PROMOTION at the causal seed site (`promotion-repo.ts`), which is reachable by construction.

### §41. The onward drop is INSTANCE/PEER config, resolved ONCE per tick

The onward drop is INSTANCE/PEER config, resolved ONCE per tick — never per change, and never from anything a bundle said. `strict` because this is the AUTOMATED path: a peer configured for a provider this hop cannot deliver to (s3 — the documented 13.2b follow-on) must produce a NAMED problem, exactly as the manual route 400s on it, rather than quietly falling through to the instance env and marking a build `built` whose bytes reach a directory nobody watches.

MULTI-TENANT GUARD: `SCP_RELAY_OUT_DIR` is instance-wide while this sweep runs per org, and the tarball basename is chosen by the exporting domain (`scp-relay-<sourceChangeObjectId>.tar.gz`). On an instance hosting several orgs that would put two tenants' boundary artifacts in one namespace, where a name chosen by org B's peer can displace org A's verified bytes. The profiled deployment is single-org per boundary ("a retrans instance serves exactly one boundary/peer", retrans-relay.ts), so rather than invent a path scheme that would break every operator's CDS watcher, a multi-tenant instance FAILS CLOSED on the shared env fallback and is told to configure a per-peer deliveryTarget (which is org-scoped by construction).

### §42. PHASE 2 — THE BUILD, and NOTHING ELSE inside this try

PHASE 2 — THE BUILD, and NOTHING ELSE inside this try.

The boundary of this try is a correctness property, not tidiness. `buildRelayTarball` renames the finished tarball into the CDS intake as its LAST act, so once it returns without refusing, THE BYTES HAVE CROSSED — an operator's CDS may already have picked them up. Anything after that point is bookkeeping about an event that already happened. If the post-build ledger write were inside this try, a transient DB error there would be caught below as a *build failure*: `failed_attempts` would tick up, the next tick would rebuild and re-drop the same bytes, and on the last budgeted verdict the loop would persist a hash-chained, never-deleted `federation.relay.auto.exhausted` event asserting "nothing crossed the boundary" about a crossing that did happen. A durable audit record must never say that.

### §43. ONE BAD CHANGE NEVER BRICKS THE TICK

ONE BAD CHANGE NEVER BRICKS THE TICK (the inbox loop's containment rule). A throw here means the build did NOT complete, so nothing was published and recording a failure is the truth. A 400 is a DETERMINISTIC input problem (`buildRelayTarball`'s "no verified manifest" / "empty authorized set" refusals) — retrying it changes nothing, so it exhausts at once. Everything else (a missing/unpinned skopeo, a dead registry surfacing as a throw) gets the budget.

### §44. PHASE 3 — bookkeeping about a crossing that already happened

PHASE 3 — bookkeeping about a crossing that already happened. A failure here is NEVER a build failure: it consumes no verdict, schedules no rebuild, and writes no Decision. The row simply keeps its lease and is reclaimed when it lapses, at which point the ledger converges. The observable cost of that convergence is one rebuilt tarball with the SAME name, published atomically over the old one — which the receiver re-verifies from scratch either way (ADR-0019 §2 step 7). Losing a little work is the correct trade against a false permanent record.

### §45. Enqueue ONE immediate auto-relay tick

Enqueue ONE immediate auto-relay tick — the third leg of the M14.4 poke handler, beside `wakeFederationSyncNow` and `wakeInboxNow`. A plain `boss.send` with NO singleton (so a queued interval tick can never swallow the wake) and, like its siblings, it THROWS when the queue does not exist — the caller treats that as accepted-but-no-op.

WHY THE THIRD LEG. ADR-0009's chain is commander → low-side retrans → CDS → high-side retrans → outpost. A poke landing on the low-side retrans previously woke its inbox (so it imports the arriving `.scpbundle`) and its sync loop (so it pulls) — but hop 2, the BYTES, then waited for a human. Waking this loop is what makes the poke chain move bytes rather than only metadata.

### §46. Self-rescheduling pg-boss loop

Self-rescheduling pg-boss loop — the SAME singleton shape as `startInboxLoop`/`startObserveLoop`. Runs only under `SCP_ROLE=all|worker` (wired in `main.ts` beside the other loops) AND only when the operator explicitly enabled it (`SCP_RETRANS_AUTO_RELAY=1`); otherwise this returns an inert handle and the queue is never created, so an instance that never opted into unattended byte egress does not even have a queue to poke.

### §47. A POKE WAKE DOES NOT RE-SCHEDULE

A POKE WAKE DOES NOT RE-SCHEDULE (the M14.4 rule, verbatim): pg-boss computes a singleton slot from now() AT INSERT, so a wake landing in a different slot than the already-pending interval tick is not deduped and would leave TWO pending ticks. Keyed on "the batch contains a non-poke job" rather than "no poke present", so a batchSize>1 queue could never consume the interval job and skip its re-schedule.

## `apps/server/src/federation/boundary-bundle-ref.test.ts`

### §48. §9.4 — the pure `sourceRef` helpers under the export stamp

§9.4 — the pure `sourceRef` helpers under the export stamp. The integration test (boundary-segment.integration.test.ts scenario 7) covers the real export path; this pins the defensive edges a real export never produces on its own: a malformed stored entry, a duplicate checksum, a stamp on a non-object `sourceRef`.

MUTATION LOG (each applied ALONE, then reverted) | Mutation | Result |
| `withPromotionExport` appends without the checksum dedupe | the dedupe test FAILS (2 entries) | | `promotionExportsOf` returns malformed entries as-is (no safeParse) | the lenient test FAILS (`unparseable` 0, entries 2) | | `withoutPromotionExports` returns the input unchanged | the strip test FAILS |

## `apps/server/src/federation/boundary-bundle-ref.ts`

### §49. The per-change join between a change and its transfers

M16.1 (I1) — THE PER-CHANGE JOIN between a change and the bundle transfers that carried it.

## Why this exists

`bundle_transfers` (`schema.ts`, drizzle/0034) is a PER-HOP observational ledger: one row per `.scpbundle` this instance produced or consumed, keyed on `(org, peer, direction, kind)` with a `checksum` — and deliberately NO change/component column. The boundary segment needs the opposite cut: "which transfers carried THIS change?".

A **promotion** bundle is 1:1 with a change (`exportPromotionBundle` gathers exactly one change), and the ledger row already records that bundle's `checksum`. Correlating by checksum is the same join the inbox loop already relies on (`inbox-loop.integration.test.ts` matches a processed file to its ledger row by checksum). So the join is made by STAMPING the bundle checksum onto the change's existing JSONB `sourceRef` — no new column, no migration.

## Where the stamp is written

- EXPORT (the promoting instance, `promotion-repo.ts::exportPromotionBundle` phase 4) — appends the checksum of the bundle it just produced. Several peers ⇒ several checksums, hence a list. - IMPORT (the receiving instance, `promotion-repo.ts::applyPromotionImport`) — sets the list to exactly the checksum of the bundle the change arrived in (1:1 by construction).

## Why the exported payload is STRIPPED

The bundle's `change.sourceRef` is snapshot BEFORE the export's own stamp is written, but a RE-export of an already-exported change would otherwise carry the earlier hop's checksums into the canonical bundle string and change the Ed25519 checksum of an otherwise identical bundle. `withoutBoundaryBundleChecksums` removes the key from the exported payload so a bundle stays byte-identical to what it would have been before this key existed, forever. The exporter's own checksums are local observational bookkeeping and mean nothing on the far side anyway — the receiver stamps the checksum IT observed.

## What this is NOT

It is not authority. The journal's own sequence/hash chain is what makes replication safe; this key is read-only decoration for the boundary segment: one instance's ledger rows are its own, so no peer should ever build a segment out of another's stamp. Exactly how far that holds is stated precisely on `changes-repo.ts::stampBoundaryBundleChecksum` — the export-side stamp is genuinely un-journalled, the IMPORT-side one does ride the `change_status` payload, and the reason that leak is harmless is a property of the `change_status` import path, not of this key.

### §50. The key holding one record per export of this change

The `sourceRef` key holding one record PER EXPORT of this change: the peer it was addressed to, when, the bundle checksum (the same value `boundaryBundleChecksums[]` carries — the join key between the two lists), the SELF-BINDING promotion manifest the commander built, its detached cosign signature, and the fingerprint of the instance key that signed it.

WHY IT EXISTS. Before this key the exporter persisted NOTHING of what it signed: the manifest and `manifestSignature` were created in `exportPromotionBundle` phase 3, placed in the returned bundle, and forgotten; only the IMPORTER stored them (on the imported change). So the commander could say "exported (checksum …)" and could not say "signed WHAT, for WHOM, with WHICH key" — the Build/Scan & sign tiles' PM/sign facts had no source. Same lock, same UPDATE, same non-journalled bare write as the checksum stamp (`changes-repo.ts::stampBoundaryBundleChecksum`).

WHY THE EXPORTED PAYLOAD IS STRIPPED. Exactly the reason `withoutBoundaryBundleChecksums` exists: a re-export must stay byte-identical, and one peer's signed manifest is local bookkeeping that means nothing to another peer (which verifies the manifest it RECEIVES, as a sibling of the bundle).

### §51. The export records on a change, read defensively

The export records stamped on a change's `sourceRef`, defensively read: entries that do not parse are COUNTED (`unparseable`) rather than dropped silently or fabricated — the projection states the count in `unknownFields`. A MISSING key (`undefined`/`null`) is `[]` with `unparseable: 0`; a key that is PRESENT but not a list is one unreadable value (`unparseable: 1`) — the same honesty rule `artifact-facts.ts` applies to a malformed `sbom`: something is stored under the key, so its absence must not be claimed.

### §52. Both keys above have exactly one server-side writer

Both keys above are written by exactly one server-side writer (`changes-repo.ts:: stampBoundaryBundleChecksum`, and the promotion importer for its own received checksum), and the component pipeline RENDERS them as facts — "exported (checksum …)", "manifest signed for <peer> (key <fp>)". `proposeChange` stores a caller's `sourceRef` VERBATIM (DESIGN §8: the delivery payload is kept as-is), so without this list an org proposer could plant a stamp through `POST /changes` and the Scan & sign tile would claim a signing that never happened. The two UNTRUSTED doors refuse/strip these keys; the engine's own callers (federation import — which legitimately writes the import-side checksum — rollback, campaign fan-out) call `proposeChange` directly and are not filtered.

## `apps/server/src/federation/bundle-transfer-read-plan.integration.test.ts`

### §53. The per-peer freshness read is an index seek, not a scan

THE BOARD'S PER-PEER FRESHNESS READ IS AN INDEX SEEK, NOT A SCAN OF THE WHOLE HANDOFF LEDGER — i.e. THE TEST FOR drizzle/0041, WHICH IT NEVER HAD, AND WHICH IS WHY 0041 SHIPPED UNUSED.

`lastConfirmedSyncImportAt` runs ONCE PER PEER on every service-board render, and `bundle_transfers` is the air-gap handoff ledger — this module exposes no pruning, by design, so it only ever grows. drizzle/0041 added a partial index to make that read a single seek "no matter how deep the transfer history gets". It did not: 0041 declared the index `confirmed_at DESC`, which PostgreSQL reads as NULLS FIRST, while the read asks for `DESC NULLS LAST` — deliberately, because a NULL `confirmed_at` sorting first made the commander report "never synced" over a real sync import. Two different orderings; an index in one cannot supply the other. So the planner ignored the index entirely and did the thing 0041's header says it exists to abolish. MEASURED at 20,000 confirmed sync imports for one peer, PostgreSQL 16:

```text
  Limit -> Sort (top-N heapsort, Sort Key: confirmed_at DESC NULLS LAST)
             -> Seq Scan on bundle_transfers   rows=20000
  Buffers: shared hit=364        Execution Time: 3.675 ms
```

```text
after drizzle/0070:
  Limit -> Index Scan using bundle_transfers_org_peer_confirmed
  Buffers: shared hit=4          Execution Time: 0.014 ms
```

WHY A PLAN ASSERTION AND NOT AN OUTPUT OR LATENCY ONE. The index changes no return value — the seq-scan-and-sort finds the same row — so an output assertion is VACUOUS and would pass either way, which is exactly how this shipped: 0041 has integration coverage of what the read RETURNS, and all of it stayed green. A latency assertion would be a flake. What changed is the PLAN, so that is what this asserts, over the BUILDER the repo itself runs rather than a re-typed copy.

MUTATION-PROVEN, 2026-08-17 — AND THE FIRST ATTEMPT AT THIS TEST FAILED THAT PROOF, which is the reason the second assertion exists. Reverting drizzle/0070 to 0041's `confirmed_at DESC` and asserting only the index NAME left this suite GREEN: at this fixture's size the plan becomes `Limit -> Sort -> Index Scan using bundle_transfers_org_peer_confirmed`, so the index is still there by name, used for ACCESS while supplying none of the ordering. The same revert against the `sorts` assertion fails with `["Sort"]`, as it must.

A row-count bound of the kind the `decisions` suites carry is deliberately NOT added here: those count `pg_stat_get_xact_tuples_returned` on one table in one transaction, and this read's failure mode is a sequential scan whose cost is the ledger's whole length, which needs a fixture large enough to be slow to seed. The plan assertion catches the same regression at the same moment.

### §54. The half the index name cannot assert

AND THE HALF THE INDEX NAME CANNOT ASSERT, without which this test is vacuous. An index in the WRONG order is still usable for ACCESS — the planner reads the matching rows through it and sorts them — so it appears in the plan by name while supplying none of the ordering. That is not a hypothetical: with the index back in drizzle/0041's order this fixture plans as `Limit -> Sort -> Index Scan using bundle_transfers_org_peer_confirmed`, and the assertion above PASSES. The property the read needs is that the index supplies the ORDER, so `LIMIT 1` stops at the first row rather than the whole matching set being materialised and sorted.

## `apps/server/src/federation/bundle-transfers-repo.ts`

### §55. Bundle-transfer tracking (DESIGN.md §13)

Bundle-transfer tracking (DESIGN.md §13). Purely observational bookkeeping — never consulted for authority/idempotency decisions (the journal's own sequence/hash chain is what makes replication safe); this just gives the commander UI/CLI something to show for an air-gapped peer's outstanding handoffs.

PER-HOP AND INSERT-ONLY (doc corrected 2026-07-29, M16.1). This is NOT a lifecycle: no production path updates a row — this module exposes no update, and the only `update(bundleTransfers)` in the tree is a test fixture backdating `confirmed_at` (`coordination/service-board-staleness.integration.test.ts`). One row per `.scpbundle` an instance produced or consumed, in THAT instance's own database: `created`   — the EXPORTER, on producing a bundle (export-repo, exportPromotionBundle). `submitted` — a RETRANS only, for its onward drop (retrans-relay). `confirmed` — the RECEIVER, on a successful import (import-repo, applyPromotionImport, retrans-relay's inbound hop). CONSEQUENCE: in the commander's own database an export can only ever read `created`, so the commander may say "exported" and MUST declare the handoff unknown — see `coordination/boundary-segment.ts`. The DESIGN §13 aspiration ("confirmed when a returned bundle carries the outpost's import cursor") is UNBUILT and named there as future increment M16.4.

### §56. When a bundle from this peer was last confirmed imported

When a signed sync bundle from `peerDomainId` was last CONFIRMED as imported here — the one transport-agnostic freshness anchor this instance has, and the basis of DESIGN §13's "as of &lt;bundle/date&gt;" label.

WHY THIS AND NOT `federation_peers.lastPullSuccessAt`. That column is stamped only by the live-pull scheduler (`federation-sync.ts`), which iterates `role === "commander" && baseUrl` — so on an AIR-GAPPED instance it is NULL forever, and a freshness label derived from it would render "never synced" on an instance that imports bundles weekly. Every import path instead funnels through `importSyncBundle` → `recordBundleTransfer(direction:'import', kind:'sync', status:'confirmed')`: the live pull, `POST /v1/federation/imports` (a pushed bundle or `scp federation import`), and the unattended air-gap inbox loop alike. `status:'confirmed'` is only ever written on IMPORT rows (exports insert `'created'` and this module exposes no update), so the predicate is unambiguous.

The row also carries HOW it arrived (`transport`, drizzle/0041) — the honest source for the label's live-pull-vs-bundle distinction, which nothing else can reconstruct after the fact. NULL on pre-0041 rows and reported as such rather than guessed.

Purely observational, exactly as this module's header says — it feeds a LABEL, never an authority or idempotency decision.

PERF: runs once per peer on every service-board render. drizzle/0041's partial index `bundle_transfers_org_peer_confirmed` matches this predicate and INCLUDEs `transport`, so it is an index-only seek no matter how deep the (never-pruned, by design) transfer history gets — but only since drizzle/0070. 0041 built the index as bare `confirmed_at DESC`, which PostgreSQL reads as NULLS FIRST, while this read asks for `DESC NULLS LAST`; those are different orderings, the index was therefore INELIGIBLE, and every board render seq-scanned the whole ledger and sorted it — the exact plan 0041's header says it exists to abolish. Measured at 20,000 rows: 364 buffers and a top-N heapsort over every row, against 4 buffers for the seek. Do not "simplify" the `NULLS LAST` away to match an index; the index is what moved.

### §57. Every ledger row whose bundle checksum is one of these

M16.1 (I1) — every ledger row whose bundle checksum is one of `checksums`: the PER-CHANGE cut of this per-hop ledger, reached through the stamp `federation/boundary-bundle-ref.ts` writes onto a change's `sourceRef`. Ordered oldest-first so a caller reads the hops in the order they happened. An empty input (a change that never crossed a boundary) short-circuits to `[]` without a query.

### §58. The pending-export high-water mark for one peer

M16.2 phase A (E3) — THE PENDING-EXPORT HIGH-WATER MARK for one peer: the highest `through_sequence` over the SYNC EXPORT rows this instance has written for it, plus the identity of that bundle (its Ed25519 `checksum`) and when it was produced here.

This is the strongest statement a commander can honestly make about a peer's sync progress, and it is deliberately ONE-SIDED. `sync_cursors` records only what WE applied FROM a peer; `export-repo.ts` ships only this domain's own entries, so a return bundle cannot carry our sequences back; and this ledger has no production UPDATE path, so an export row is inserted `created` and never advances. Nothing here means "the peer applied it" — only "we put it on the wire". A field named for application at the peer would be fabrication; that is future increment M16.4's work.

`null` when this instance has never exported a sync bundle to the peer — never `0`, which a reader would take for "synced through the beginning". Ordered by `through_sequence DESC` rather than `created_at` because a later resume-from-cursor export can legitimately cover a lower range, and the question asked here is "how far have we ever exported?".

## `apps/server/src/federation/cosign-distribution.integration.test.ts`

### §59. Distribution of the cosign verification key to peers

M17.3 E5 — DISTRIBUTION of SCP's cosign VERIFICATION public key to peers so they can LATER (E6 / M17.4) verify the commander's cosign-signed promotion manifest. This increment adds NO signing and NO verification — it proves the PLUMBING:

- the LOCAL cosign public key is surfaced by `getFederationStatus`, lazily provisioned, and the PRIVATE half never appears in status or any API-facing shape; - pairing CARRIES the peer's cosign pubkey and PERSISTS it onto `federation_peer_keys`, retrievable per-peer; - ROTATION (a changed cosign pubkey) reuses the EXISTING supersede/key-window mechanic — the old cosign key is retained in its superseded window exactly as the Ed25519 key is; - the exchange is FILE-ONLY / air-gap friendly: one side's status output + the other side's pair request is sufficient, with NO new transport and no live connection; - it is ADDITIVE — an OLD pair request lacking a cosign pubkey still pairs, and never strips one.

Uses genuinely-separate-database isolated domains (test-support/isolated-domain.ts), matching federation.integration.test.ts, and a FAKE cosign generator (unique offline PEMs, no subprocess).

## `apps/server/src/federation/crl-parse.test.ts`

### §60. A hand-rolled minimal DER reader, with no dependency

M9.3 (ADR-0001) — `crl-parse.ts` is a hand-rolled minimal DER reader (no runtime dependency added, CLAUDE.md principle 5), so it gets its own direct unit coverage against REAL CRLs minted by `openssl` (not hand-crafted byte arrays) — proving it reads the exact `nextUpdate` OpenSSL itself reports (`openssl crl -noout -nextupdate`), for both a normal (future) and a deliberately expired CRL. No Postgres needed — plain `pnpm test`, not the Testcontainers integration suite.

## `apps/server/src/federation/crl-parse.ts`

### §61. Minimal, dependency-free X.509 CRL

Minimal, dependency-free X.509 CRL (`CertificateList`, RFC 5280 §5.1) reader — extracts only the `nextUpdate` field. Deliberately NOT a general ASN.1/CRL library: air-gap/self-hosting (CLAUDE.md principle 5) rules out adding a runtime dependency (e.g. `node-forge`) just to read one field out of a file an operator already controls, and Node's own `tls`/`crypto` modules expose no CRL parser at all (`crypto.X509Certificate` only covers certificates, not CRLs).

Used by `config.ts`'s `loadFederationServerMtlsConfig` to implement the ADR-0001 "stale-CRL" policy (`crlHardFailOnExpiry`): boot must know whether the configured CRL is already past its `nextUpdate` *before* deciding whether to include it in the TLS context at all — see that function's doc comment for why an EXPIRED CRL cannot simply be handed to Node's `https` server unconditionally (empirically, doing so makes EVERY cert-presenting peer fail TLS verification with `CRL_HAS_EXPIRED`, not just revoked ones — see config.ts).

ASN.1 shape walked here (fields not read are still traversed, to skip past them): CertificateList ::= SEQUENCE { tbsCertList TBSCertList, signatureAlgorithm AlgorithmIdentifier, signatureValue BIT STRING } TBSCertList ::= SEQUENCE { version INTEGER OPTIONAL,        -- present only for a v2 CRL signature AlgorithmIdentifier, issuer Name, thisUpdate Time, nextUpdate Time OPTIONAL,        -- <-- the field this module reads revokedCertificates SEQUENCE OF ... OPTIONAL, crlExtensions [0] EXPLICIT Extensions OPTIONAL } Time ::= CHOICE { utcTime UTCTime, generalTime GeneralizedTime }

### §62. The CRL's next-update timestamp, or null when omitted

Returns the CRL's `nextUpdate` timestamp, or `null` if the CRL omits it (RFC 5280 marks it OPTIONAL, though every CA in practice sets it — an absent `nextUpdate` is treated as "never stale" by the caller, matching how most TLS stacks/CA tooling behave).

Throws on anything that doesn't parse as a well-formed `CertificateList` — a corrupt/truncated CRL file is a boot-time misconfiguration (config.ts's caller), not a value to silently treat as "no expiry" (that would be a fail-OPEN bug: a garbled CRL must not look "fresh").

## `apps/server/src/federation/crl-reload.test.ts`

### §63. M9.3 (ADR-0001 §8, "CRL reload without a full restart")

M9.3 (ADR-0001 §8, "CRL reload without a full restart") — proves the actual mechanism `main.ts`'s `SIGHUP` handler relies on: `tls.Server#setSecureContext({ca, cert, key, crl})` atomically swaps in a fresh CRL for all FUTURE handshakes on an already-listening server, without restarting it.

SCOPE NOTE (called out explicitly, not silently): this test builds a raw `https.createServer` directly rather than spawning the compiled `scpd` binary and sending it a real `SIGHUP` OS signal — doing the latter would require a child-process integration test in the style of `test-support/cli-runner.ts`, a materially bigger investment for the same proof. What's verified here is the load-bearing part: that `setSecureContext` genuinely changes which certificates authenticate on the NEXT connection. `main.ts`'s `SIGHUP` wiring itself (re-running `loadFederationServerMtlsConfig` and calling this same method) is straightforward glue on top, not independently retested.

## `apps/server/src/federation/cursors-repo.ts`

### §64. Per-peer resumable sync cursors

Per-peer resumable sync cursors (DESIGN.md §13: "per-domain monotonic sequence cursors make replication idempotent and resumable"). One row per (peer domain, origin domain) this side has ever applied entries from — tracks the last sequence number AND the last applied entry's `rowHash` durably committed, so an interrupted transfer resumes from here, re-applying an already-seen sequence is a no-op, and a RESUMED import can verify true hash-chain continuity against what was actually applied last time (not just internal contiguity within one bundle — see `import-repo.ts`'s doc comment, SECURITY-SENSITIVE).

### §65. Issues the one-shot re-anchor permit for a peer's cursors

ISSUE THE ONE-SHOT RE-ANCHOR PERMIT for every cursor of `peerDomainId` that currently holds NO anchor (drizzle/0042). SECURITY-SENSITIVE — read that migration's header before changing this. (That header predates M16.2 phase A and says the column is written by "ONE function, reached by ONE route"; it is now the TWO scope-declaring operator routes listed below. An applied migration file is a historical artifact and is deliberately not edited — its hash is recorded — so this is the current statement.)

CALLED FROM EXACTLY TWO PLACES, both of which are LOCAL, AUTHENTICATED (`federation:write`) OPERATOR DECLARATIONS of this peer's own `sync_scope` — and in both the request must actually CARRY a `syncScope`, with the permit keyed off the RESULTING scope being `full` (never off the transition — see `pairPeer`'s long note for why): * `pairPeer` — `POST /v1/federation/peers` (`syncScope` is part of every pair/re-pair body); * `updatePeerTransport` — `PATCH /v1/federation/peers/{id}` (M16.2 phase A E4), gated on `input.syncScope !== undefined`. Re-applied there deliberately: the documented recovery for a wedged peer is "declare the scope `full` again", and it must work on EVERY route that can declare a scope, or the same operator action would heal the peer through one door and silently leave it wedged forever through the other. The `!== undefined` gate is what keeps the trigger as narrow as this sentence claims — without it, absent-means-preserve made a pure RENAME issue the permit (review round 4, H8), so the code was wider than every doc describing it. `sync_scope` is never carried on the wire, so no peer can induce either call; nothing in an import, relay, inbox, poke or pull path may ever call this.

The predicate is the whole safety story. Only a cursor with `last_applied_row_hash IS NULL AND last_applied_seq > 0` — an anchorless cursor left behind by this side's OWN narrow-scope verification — is permitted, and the permit records the EXACT sequence it was issued for, so it can never apply to a position the cursor has since moved to. A cursor that already holds a real anchor is untouched: there is nothing to re-anchor, and weakening it would be a real loss. `last_applied_seq` itself is deliberately NOT rewound (it is the key-rotation anchor — `maxAppliedSequenceForPeer`).

### §66. RAIL 5 pre-check (§7.2)

RAIL 5 pre-check (§7.2): would this call ACTUALLY issue a permit? Only an anchorless cursor (`last_applied_row_hash IS NULL AND last_applied_seq > 0`) is eligible. If none exists this is a no-op — an unrelated `pairPeer`/`updatePeerTransport` that merely left scope at `full` on an already-healthy peer — and it must fall straight through, NEVER refusing. Rail 5 fires only where a real permit would be issued, which is the whole false-positive story.

### §67. The rails can be undone by following the printed remedy

RAIL 5 (§7.2 — review's sharpest finding: "the rails can be undone by following the printed remedy"). The current no-anchor error message PRESCRIBES a re-anchor; so while a `journal_divergence` is STANDING for this peer, this permit — the mechanism that message points at — must be refused. Re-anchoring here would silently adopt the forked/rolled-back tail as truth; `scp federation resync` is the sanctioned recovery, and it (not this) clears the standing verdict.

### §68. The highest origin sequence this domain has applied

The highest origin sequence THIS domain has verifiably applied from `peerDomainId`, across all origin domains that peer has relayed (in practice one — a direct peer's own domain). Used as the key-rotation ANCHOR (peers-repo.ts): when a peer's key rotates, the old key is declared valid only through this sequence, and the new key from here on — the authenticated compromise-recovery boundary. `0` when nothing has ever been applied from the peer.

### §69. Advances the cursor forward only, never regressing it

Advances the cursor to `sequence`/`rowHash`, but ONLY forward — never regresses it, so an out-of-order or duplicate apply can never rewind progress already recorded (belt-and-braces on top of the entry-level idempotent-replay check the import path itself performs).

ALSO CONSUMES the one-shot re-anchor permit (drizzle/0042): any real advance clears it, so a permit covers exactly one accepted run and is re-issued only by another `pairPeer` call that again leaves this peer's `sync_scope` at `full`. Clearing it unconditionally (rather than only when `rowHash` is non-null) is what makes "one-shot" true in both directions — a receiver that is narrowed AGAIN before the permit is used advances with a null hash and must be re-permitted by a fresh `pairPeer` call at the NEW position.

### §70. §7.2.6 RESYNC ONLY

§7.2.6 RESYNC ONLY — reset a cursor to an EXACT position, forward OR backward, unlike the deliberately forward-only `advanceCursor`. A lost-tail resync must be able to rewind the cursor (typically to genesis) so the re-import re-applies the exporter's restored journal from the start; `advanceCursor`'s "never regress" ratchet is exactly what would otherwise make resync a no-op. Clears any standing re-anchor permit and the attested-tail high-water mark, because after a resync everything about this (peer, origin) is being re-established from the exporter's new truth. Called ONLY from the mutually-authorized resync path; no import/relay/poke/pull path may reach it.

### §71. DIVERGENCE RAIL 4

DIVERGENCE RAIL 4 (multi-region-instance-resilience.md §7.2) — verify the exporter's signed tail attestation against the MONOTONIC high-water mark this side holds for (peer, origin), then advance it. The attestation's SIGNATURE is verified by the caller (import-repo, which holds the peer key); this owns only the ordering contract: - `tailSequence` EQUAL to the mark but a DIFFERENT `tailRowHash` → a fork at the same height → `journal_divergence` (UNAMBIGUOUS — the exporter's tail at that exact height was re-minted); - `tailSequence` BELOW the mark, on a FRESH bundle → the exporter's live tail went backwards → `journal_divergence`; - `tailSequence` ABOVE the mark → advance (the normal, healthy case); - EQUAL and identical → idempotent no-op.

`isReplay` is the load-bearing distinction (a real bug caught in test): a legitimately OLDER bundle re-delivered (the file/CDS path can, and idempotent re-import is a hard invariant) carries a genuinely lower attestation that was TRUE when it was exported — refusing it as a "regression" would break replay. A replay is exactly a bundle whose own `throughSequence` is at or below what we have already applied; for those, the below-the-mark case is a no-op, not a refusal. A same-height hash FORK is still refused even on a replay (a legitimate replay never changes the hash at a height it once reported). Runs for BOTH full and sparse receivers, independent of how many entries the bundle applied — which is why it catches a rolled-back tail for a narrow-scope peer rails 1–3 miss. It only ever WRITES the two attested columns; `advanceCursor` owns `last_applied_*` on the same row, so whichever runs first the other's select-then-update/insert leaves it intact.

## `apps/server/src/federation/delivery-s3.integration.test.ts`

### §72. M13.2b (proposal §13.2, owner decision D3: AWS SDK v3)

M13.2b (proposal §13.2, owner decision D3: AWS SDK v3) — the s3-compatible DeliveryTarget provider, proven end-to-end against a REAL MinIO (Testcontainers), the `endpoint` override + `forcePathStyle` path every S3-compatible uses. What is proven here (the increment DoD):

```text
- an s3 delivery target ROUND-TRIPS a bundle drop: `dropDeliveryFile` puts it, `listInbox` lists
  it back (names only), `getDeliveryFile` reads the identical bytes;
- a LARGE (forced-multipart-threshold) upload exercises `@aws-sdk/lib-storage`'s MANAGED
  MULTIPART (the multipart ETag `<md5>-<numParts>` is the proof it was not a single PutObject);
- an OUT-OF-ALLOWLIST endpoint is refused at PAIR-TIME (`assertDeliveryTargetRooted`);
- an UNSET allowlist + s3 target FAILS CLOSED at resolution (never used);
- CREDENTIALS resolve from the VAULT (`delivery/<peer>/out` under the ADR-0019 §3 artifact-store
  class) and drive a real drop — never argv/logs.
```

The FILESYSTEM path is unchanged — its suite (`delivery-target.test.ts`) is green UNMODIFIED.

## `apps/server/src/federation/delivery-s3.ts`

### §73. 13.2b — the `s3-compatible` DeliveryTarget client

13.2b — the `s3-compatible` DeliveryTarget client (proposal §13.2, owner decision D3: AWS SDK v3).

The put/list/get half of the provider dispatch in `delivery-target.ts`. Isolated here so the AWS SDK import lives behind one seam (delivery-target.ts stays db-free and provider-agnostic), and so the S3 path is exercised as a unit against MinIO.

WHY the AWS SDK v3 (`@aws-sdk/client-s3` + `@aws-sdk/lib-storage`) and not a hand-rolled PutObject (owner decision D3): relay tarballs are multi-GB, and `lib-storage`'s managed MULTIPART upload is the difference between a working drop and a hand-rolled one that fails on large bodies; first-party SigV4 correctness (chunked/streaming signing edge cases) and built-in retry/backoff are exactly the surface an unattended boundary loop must not get subtly wrong. The vendoring cost is real, but the air-gap principle constrains RUNTIME NETWORK CALLS, not dependency size — the SDK is vendored at build time like everything else (charter principle 5), and S3 stays OPTIONAL (Postgres is the only required stateful dependency, principle 4). MinIO/S3-compatibles are reached via the `endpoint` override + `forcePathStyle`.

CREDENTIALS are resolved from the vault by the caller (ADR-0019 §3 artifact-store class, `deliveryTargetSecretKey`) and passed in — never read from `process.env`/argv/config, never logged.

### §74. The region an S3-compatible put/list/get signs under

The region an S3-compatible put/list/get signs under. Real AWS S3 needs the bucket's true region; MinIO and most S3-compatibles ignore it but still require a value for SigV4. Operator-overridable via `SCP_DELIVERY_S3_REGION` (default `us-east-1`). This is signing metadata, not an egress target — it never widens which endpoint/bucket is reachable (that is the `SCP_DELIVERY_S3_ENDPOINTS` allowlist's job), so it needs no allowlist.

### §75. Build a per-operation `S3Client` for one resolved location

Build a per-operation `S3Client` for one resolved location. `forcePathStyle: true` so a MinIO/ S3-compatible endpoint addresses `<endpoint>/<bucket>/<key>` (virtual-hosted-style would require per-bucket DNS the operator's CDS S3 rarely has). The client is disposable — callers `destroy()` it after the single operation (an unattended loop opens no long-lived connection pool).

### §76. PUT a channel artifact via managed multipart

PUT a channel artifact via managed multipart (`lib-storage` `Upload`). `body` may be a Buffer, string, or a stream — `Upload` chunks a large body into parts automatically, so a multi-GB relay tarball drops without a hand-rolled PutObject. `partSize` is overridable for tests that force the multipart path with a small threshold; production uses the SDK default (5 MiB minimum part).

### §77. LIST the object BASENAMES under a location's prefix

LIST the object BASENAMES under a location's prefix — names only, never full keys or paths, so the §13.1a inbox surface (and its `resolveUnderDir` traversal guard) survives across providers. Keys are paginated fully; each key has the prefix stripped, and any key naming a nested "subdirectory" (a `/` after the prefix) is skipped — the two channel artifacts are always flat objects, exactly as `listInbox`'s filesystem path lists only regular files, never subdirectories.

## `apps/server/src/federation/delivery-target.integration.test.ts`

### §78. M13.2a — the DeliveryTarget SUBSTRATE

M13.2a — the DeliveryTarget SUBSTRATE (proposal §13.2), proven at the real API surface (real Postgres, real routes — the same parity plane the SDK/CLI ride):

```text
1. PARITY — `deliveryTarget` is settable + visible through the EXISTING federation peer
   surfaces (pair/list), additive within /v1, with `cosignPublicKey`'s tri-state re-pair
   discipline: absent preserves, object sets, explicit null clears.
2. CONFIG-TIME VALIDATION — a traversal-hostile directory never enters the DB (400 at pair).
3. WRITE SEAM, PER-PEER — `deliver: true` on the sync export drops the bundle document into
   the PEER's configured outDir, even when the instance env points elsewhere.
4. WRITE SEAM, ENV FALLBACK — a peer with NO target delivers into `SCP_RELAY_OUT_DIR`
   (today's instance-level behavior; the retrans-relay suite — unmodified — is the
   byte-identical proof for the relay emission itself).
5. FAIL-CLOSED — BOTH absent refuses 400 with a problem NAMING the gap (peer + env var);
   and the relay route resolves its outbound drop the same way (per-peer config carries it
   past delivery resolution; both-absent refuses before anything else runs).
```

## `apps/server/src/federation/delivery-target.test.ts`

### §79. M13.2a — DeliveryTarget VIEW resolution

M13.2a — DeliveryTarget VIEW resolution (proposal §13.2), unit-proven per gap: per-peer beats env, env fallback is exactly today's behavior, BOTH-absent is a named fail-closed problem (never a silent default path), a hostile stored dir never resolves (and never silently falls back), and the inbox listing keeps the PR #112 traversal guard — names only.

### §80. M13.2b — the s3-compatible provider

M13.2b — the s3-compatible provider: the endpoint/bucket allowlist (ADR-0019 §4 symmetry) and the fail-closed resolution. The MinIO round-trip (put/list/get + multipart) is proven in the integration suite; these unit tests pin the ALLOWLIST predicate + the fail-closed resolution.

### §81. The one onward-drop resolution both paths share

M13.1b — `resolveOnwardDeliveryDir`, the ONE onward-drop resolution shared by the M13.1a inbox loop's validate-and-forward and the M13.1b auto-relay (the two halves of the same hop).

`strict` exists because the two callers have different tolerances for a config gap. The inbox loop is REACTIVE — a file arrived, and deferring it is visibly a stall an operator is already looking at. The auto-relay is a TIMER: falling through to the instance-wide env dir would perform the very action the operator-invoked route explicitly 400s on (`requireOutboundDir` refuses an s3 target), mark the build done, and leave the bytes in a directory the s3-expecting CDS never watches — a silent boundary misdelivery nobody is watching a terminal for.

### §82. THE REGRESSION (cd1bf1c)

THE REGRESSION (cd1bf1c): strict may only flag peers that CONFIGURED a target. A peer with no delivery target of its own is not a misconfiguration — it simply is not the boundary peer, and the normal CDS topology has exactly one of each. Flagging it refuses the drop on account of a peer that was never a candidate, which silently kills auto-relay in the standard two-peer deployment (upstream commander + downstream boundary peer, no instance env dir at all).

## `apps/server/src/federation/delivery-target.ts`

### §83. M13.2a — the DeliveryTarget substrate

M13.2a — the DeliveryTarget substrate (docs/proposals/airgap-cds-validate-promote.md §13.2).

WHERE a signed channel artifact gets dropped for — or picked up from — one peer's CDS crossing: the exact hole ADR-0019's Consequences deferred ("drop-directory vs. diode transfer varies per CDS product; the relay's contract ends at 'signed tarball out / signed tarball in'"), and nothing more. Everything past the drop (diode transfer, content inspection, the CDS product's review queue) is the org's CDS — out of scope (charter principle 1).

## Resolution (the M15.6 `buildRegionalExecutorView` discipline — validated view, per-gap `problems`, never a silent misdeploy)

`resolveDeliveryTarget(peer, config)` produces the EFFECTIVE target for one peer:

```text
1. The peer's own `deliveryTarget` (per-direction) wins when configured.
2. NO per-peer value for a direction → the instance env (`SCP_RELAY_OUT_DIR` /
   `SCP_RELAY_IN_DIR`, PR #112's `RelayConfig`) — TODAY'S behavior, byte-identical, so
   existing setups need no migration.
3. BOTH absent → that direction resolves to a named, per-gap `problem` — FAIL-CLOSED at use
   (`requireOutboundDir`/`requireInboundDir` refuse with the problem text); never a silent
   default path.
```

A stored per-peer directory is RE-validated here (absolute, traversal-free — the same predicate `DeliveryDirSchema` enforces at config time): a hostile value that somehow reached the DB is a fail-closed problem for its direction, and deliberately does NOT fall back to the env — falling back would silently mask the misconfiguration.

## Operator-root bounding (`SCP_DELIVERY_ROOTS` — the #108→#110 pattern, symmetric with ADR-0019 §4)

On a MULTI-TENANT instance, an org admin with `federation:write` supplies the per-peer dirs. An absolute + traversal-free path is NOT enough: any server-writable absolute path (another org's `SCP_RELAY_IN_DIR`, any server-user-writable location) would otherwise be a legal drop target, and `dropDeliveryFile` does `mkdir -p` + overwriting `writeFile` there as the server user — a cross-tenant / arbitrary-path write. So a per-peer directory is honored ONLY when it sits at or under one of the OPERATOR-declared roots in `SCP_DELIVERY_ROOTS` — the same shape as `SCP_ARTIFACT_OCI_REGISTRY_HOSTS` (#110): a data-supplied filesystem endpoint gated by an operator allowlist, enforced in BOTH places — refused at pair time (never stored) and re-checked fail-closed at resolution (a stored out-of-root dir is a named per-gap problem, never a silent env fallback, never used).

DEFAULT — the honest multi-tenant default: `SCP_DELIVERY_ROOTS` UNSET + any per-peer dir set/used ⇒ FAIL-CLOSED (refuse). The operator must declare the roots before any per-peer dir is honored. The ENV-FALLBACK path (`SCP_RELAY_OUT_DIR`/`SCP_RELAY_IN_DIR` — operator-owned by definition) stays EXEMPT: no per-peer dir, no roots requirement, so single-org deploys keep working with zero new config.

## The read-side surface (for the §13.1a inbox loop, stacked next)

`listInbox(peer)` returns file NAMES within the resolved inbound directory — names only, never paths: each name is round-tripped through the PR #112 `resolveUnderDir` traversal guard before it is returned, so the guard SURVIVES automation (inbox contents are untrusted data — file names are data, not commands). Consumers hand a name back to the existing import paths, which re-run `resolveUnderDir` themselves.

## Providers (13.2b — `s3-compatible` added)

`filesystem` (default) and `s3-compatible` (proposal §13.2, owner decision D3: AWS SDK v3) both ride the SAME put/list/get seams (`dropDeliveryFile`/`listInbox`/`getDeliveryFile`), PROVIDER- DISPATCHED on the resolved target's `provider`: the filesystem path is byte-identical to M13.2a, the s3 path put/list/gets via `delivery-s3.ts`. The s3 provider is OPERATOR-ALLOWLISTED exactly as directories are — the `SCP_DELIVERY_S3_ENDPOINTS` endpoint/bucket allowlist is the ADR-0019 §4 symmetry of `SCP_DELIVERY_ROOTS`, enforced at pair-time AND fail-closed at resolution (a tenant must never steer delivery to an arbitrary S3 endpoint). Its credentials live in the vault under `delivery/<peer>/<direction>` (ADR-0019 §3), resolved at use and passed to the s3 seams — never in config, never logged.

### §84. The absolute roots a delivery directory may sit under

`SCP_DELIVERY_ROOTS` — comma/colon-separated ABSOLUTE roots a per-peer delivery directory must sit at or under to be honored (the #110 `SCP_ARTIFACT_OCI_REGISTRY_HOSTS` pattern for a filesystem endpoint). Entries are trimmed, non-absolute ones dropped, and each normalized with `path.resolve` so a root written as `/data/roots/../escape` collapses to its real location. UNSET (or all-empty) ⇒ `[]` ⇒ every per-peer dir fails closed (see the module doc's DEFAULT). Accepts the raw env string or an already-split array (tests pass an array directly).

### §85. Is `dir` at or under one of `roots`?

Is `dir` at or under one of `roots`? The check is on RESOLVED path SEGMENTS, never a raw string prefix — so a sibling like `/root-evil` never matches the root `/root` (string-prefix would), and `/roots/../escape` is normalized before comparison. `roots` are already resolved by `parseDeliveryRoots`; `dir` is resolved here. Mirrors `resolveUnderDir`'s boundary test.

### §86. S3 endpoint/bucket allowlist (`SCP_DELIVERY_S3_ENDPOINTS`)

S3 endpoint/bucket allowlist (`SCP_DELIVERY_S3_ENDPOINTS`) — the ADR-0019 §4 symmetry of SCP_DELIVERY_ROOTS, but ENDPOINT+BUCKET shaped, NOT path shaped (isUnderDeliveryRoot is a filesystem prefix test and MUST NOT be reused here). An s3 `endpoint`/`bucket` is a data-supplied EGRESS target set by an org admin; without an operator allowlist a tenant could steer the unattended boundary drop to an arbitrary S3 endpoint (data-supplied egress). So — exactly as directories are bounded — an s3 target is honored ONLY when its endpoint (and bucket, when the entry pins one) is operator-allowlisted, enforced at pair-time (never stored) AND fail-closed at resolution.

### §87. Parses the allowed object-store endpoints

Parse `SCP_DELIVERY_S3_ENDPOINTS` — a COMMA/newline-separated list of allowed `endpoint` or `endpoint+bucket` entries (e.g. `https://minio.a:9000, https://minio.b:9000+bundles`). Unlike `parseDeliveryRoots`, entries are NOT colon-split: an S3 endpoint URL legitimately contains colons (`https://host:9000`), so a colon can never be an entry separator here; the endpoint↔bucket separator is `+` (per the proposal's `endpoint[+bucket]` notation). Each endpoint is normalized to its origin; unparseable entries are dropped. UNSET/all-empty ⇒ `[]` ⇒ every s3 target fails closed. Accepts the raw env string or an already-split array (tests pass an array directly).

### §88. Is `endpoint`+`bucket` allowed by `allow`?

Is `endpoint`+`bucket` allowed by `allow`? Match requires the normalized ORIGINS to be EQUAL (never a string-prefix compare — so `https://minio.evil:9000` never matches an allowlisted `https://minio.ev:9000`, and a path suffix on the configured endpoint can't sneak past) AND the entry's bucket to be either unpinned (any bucket) or exactly `bucket`. An unparseable `endpoint`, or an empty allowlist, is never allowed (fail-closed).

### §89. One direction of the resolved view

One direction of the resolved view. `dir` is the resolved FILESYSTEM directory (or `null`); the s3 location, when the provider is `s3-compatible`, lives on the parent's `outboundS3`/`inboundS3` — this shape is DELIBERATELY unchanged from M13.2a (the filesystem suite asserts it exactly). A resolved direction has `problem === null`; an unresolved one has `dir === null` + a `problem` (the text the `require*` helpers refuse with).

### §90. S3 direction resolution

S3 direction resolution (13.2b). The endpoint/bucket is the SAME for both directions (the target carries one `endpoint`+`bucket`); only the per-direction prefix differs. The allowlist gap is therefore shared: an out-of-allowlist endpoint/bucket makes BOTH directions a fail-closed problem. There is NO env fallback for an s3 target — the whole target is s3 (the env dirs are filesystem). Returns the (dir-shaped) direction PLUS the resolved `s3` location (`null` on a gap) — the direction shape stays byte-identical to filesystem so consumers keyed on it are unchanged.

### §91. The effective DeliveryTarget for `peer`

The effective DeliveryTarget for `peer` (or the env-only target when `peer` is null), with per-gap `problems` — never throws; the `require*` helpers turn a gap into a fail-closed refusal at the point of use. Dispatches on the peer target's provider: an `s3-compatible` target resolves via the endpoint/bucket allowlist (`s3Allow`), everything else (a filesystem target or the env fallback) via the directory logic. `config` defaults to the live env (`relayConfigFromEnv()`).

### §92. THE ONWARD DROP a store-and-forward hop writes into

THE ONWARD DROP a store-and-forward hop writes into: the single peer-configured OUTBOUND filesystem `deliveryTarget` if exactly one peer carries one, else the instance env (`SCP_RELAY_OUT_DIR`). Shared by the M13.1a inbox loop's validate-and-forward and the M13.1b auto-relay, which must resolve it identically — the two halves of the same hop.

FAIL-CLOSED, NEVER A SILENT DEFAULT. Every gap returns a NAMED `problem` the caller surfaces and defers on, rather than falling through to some other directory: - AMBIGUITY (several peers configure an outbound dir) is a config gap, not a coin toss — dropping bytes at the wrong boundary peer is exactly the mistake this refuses to guess at. - An `s3-compatible` peer resolves with `outbound.dir === null` (its location is `outbound.s3`) and is correctly skipped rather than mistaken for an unresolved filesystem dir: relaying a multi-GB tarball straight to s3 is the documented 13.2b follow-on (see the relay route's scope note), so an s3-only instance falls through to the env fallback or a named problem. - A per-peer dir outside `SCP_DELIVERY_ROOTS` never resolves at all (`resolveDeliveryTarget` refuses it fail-closed), so it cannot become an onward target here either.

### §93. M13.1b — for AUTOMATED callers

M13.1b — for AUTOMATED callers: refuse (named problem) rather than fall through to the instance env when a peer IS configured for delivery but with a provider this hop cannot write to. Without it the automated path would perform an action the operator-invoked route explicitly 400s on (`requireOutboundDir` refuses an s3 target), mark the build done, and put the bytes in a directory the s3-expecting CDS never watches.

### §94. Only peers with an outbound target this hop cannot write

ONLY peers that configured an OUTBOUND target this hop cannot write to. Both narrowings are load-bearing, and each was a live bug before it was added:

```text
- a peer with NO deliveryTarget at all is not a misconfiguration, it simply is not the
  boundary peer. Flagging it would refuse the whole hop on account of, typically, the
  upstream commander — in the normal two-peer retrans topology, where the DOWNSTREAM peer
  carries the only outDir and `SCP_RELAY_OUT_DIR` is legitimately unset.
- a peer whose target configures only `inDir` is the DOCUMENTED M13.1a upstream shape (the
  schema makes `outDir` optional precisely so a peer can be an inbox and nothing more).
  Keying on the resolved `outbound.dir` alone would flag it for lacking an outbound dir it
  was never meant to have, with the same effect: every build deferred forever, no attempt,
  no Decision, nothing to see.
```

What is left is the case strictness exists for: a peer that DID declare where its outbound bytes go, in a form this hop cannot write (s3 — the documented 13.2b follow-on) or that resolution refused (traversal, outside `SCP_DELIVERY_ROOTS`). Falling through to the instance-wide dir there would perform an action the manual route explicitly 400s on.

### §95. PROVIDER-AGNOSTIC outbound assertion (for route pre-checks)

PROVIDER-AGNOSTIC outbound assertion (for route pre-checks): a delivery with NO resolvable outbound location refuses fail-closed with its named per-gap problem, BEFORE any export work is done — whether the target is filesystem (no dir) or s3 (no allowlisted endpoint). Never returns a path; use `dropDeliveryFile` to actually write.

### §96. WRITE SEAM — PROVIDER-DISPATCHED

WRITE SEAM — PROVIDER-DISPATCHED: drop `contents` as `fileName` into the peer's resolved outbound location. `filesystem` = exactly the PR #112 write (mkdir -p + write, byte-identical), `fileName` riding the `resolveUnderDir` traversal guard. `s3-compatible` = a managed multipart put via `delivery-s3.ts`, `fileName` riding `deliveryObjectKey`; `s3Credentials` (vault-resolved by the caller) is REQUIRED for the s3 path — its absence is a fail-closed 400. Returns the absolute filesystem path OR the `s3://bucket/key` URI written.

### §97. READ SEAM (the §13.1a inbox surface)

READ SEAM (the §13.1a inbox surface) — PROVIDER-DISPATCHED: the file NAMES currently sitting in the peer's resolved inbound location — names only, no paths/keys, no traversal.

`filesystem` (unchanged from M13.2a): - an unresolvable inbound direction refuses fail-closed with its named problem; - only regular files are listed (subdirectories/other are ignored — the two channel artifacts are always plain files); - every returned name round-trips the `resolveUnderDir` guard (belt-and-braces); - a not-yet-created inbox lists as empty (an empty and an absent inbox are the same "nothing arrived" answer for a polling loop).

`s3-compatible` (13.2b): lists object BASENAMES under the inbound prefix via `delivery-s3.ts` (`s3Credentials` REQUIRED — its absence is a fail-closed 400); nested keys are skipped, exactly as the filesystem path skips subdirectories.

Sorted for deterministic consumption order.

### §98. CONFIG-TIME gate (the pair route)

CONFIG-TIME gate (the pair route): refuse a `deliveryTarget` whose data-supplied ENDPOINT falls outside the operator allowlist BEFORE it is ever stored — the pairing half of the #110 allowlist (`SCP_ARTIFACT_OCI_REGISTRY_HOSTS`) pattern. Throws a fail-closed 400 `badRequest`; returns cleanly when there is nothing to bound. Provider-dispatched:

```text
- `null`/`undefined` target — the tri-state CLEAR/PRESERVE cases: env fallback, nothing to bound;
- `filesystem` — each per-direction dir must sit under a `SCP_DELIVERY_ROOTS` root (schema has
  already proven it absolute + traversal-free), else refuse; UNSET roots + any dir ⇒ refuse;
- `s3-compatible` (13.2b) — the endpoint[+bucket] must be in the `SCP_DELIVERY_S3_ENDPOINTS`
  allowlist, else refuse; UNSET allowlist + s3 target ⇒ refuse (the honest fail-closed default).
```

`roots`/`s3Allow` default to the live `SCP_DELIVERY_ROOTS` / `SCP_DELIVERY_S3_ENDPOINTS`.

## `apps/server/src/federation/divergence-rails.integration.test.ts`

### §99. DIVERGENCE RAILS 1/2/4/5

DIVERGENCE RAILS 1/2/4/5 (multi-region-instance-resilience.md §7.2) — the fork/rollback detection that turns a lost tail after an async-replication failover from silent divergence into a named, fail-closed `journal_divergence`. Two GENUINELY separate databases (isolated-domain.ts), the same topology M6's own suite uses. A = commander/exporter, B = full-scope outpost/importer.

## `apps/server/src/federation/domain-local-inheritance.integration.test.ts`

### §100. Locality is inherited at create, one hop, either route

M20.5 (ADR-0031 §6a) — LOCALITY IS INHERITED AT CREATE, ONE HOP, ALONG EITHER CONTAINMENT ROUTE.

## Why this is a door census and not three happy-path cases

§6a's one-hop rule is sound only *by induction*: reading the immediate parent equals what a full ancestor walk would return **because every intermediate container was itself stamped at its own create**. The ADR names the precondition explicitly and calls it load-bearing — every create door must funnel through `createObject`'s containment-parent resolution or `createComponentInService`'s container resolution.

A door that resolves a parent by itself would produce a **shared object inside a domain-local subtree**: no error, no leak at the moment of creation, and a silent hole the next time that object is journaled. That is the M20.1 eight-door census one level up, and it is why every create door that can name a container is exercised here rather than sampled.

## The two routes, and why both are needed

`containment.ts` walks two parent routes, and an object can arrive under a container by either: - **`domain_id`** — resolved by `createObject` before the insert; - **`contains`** — the edge does not exist yet when `createObject` runs (it is written *after* the object), so `createComponentInService` reads the container and threads the flag in.

Only testing the first would leave the component path — the one an operator actually uses for "everything under this service is domain-local" — completely unguarded.

## `apps/server/src/federation/domain-local-invisibility.integration.test.ts`

### §101. M20.2 (ADR-0031) — THE COMMANDER SEES NOTHING AT ALL

M20.2 (ADR-0031) — THE COMMANDER SEES NOTHING AT ALL.

TWO GENUINELY SEPARATE POSTGRES DATABASES, because the entire claim is about what the commander's database *cannot* contain. A single-database test with two orgs would prove something weaker and would be satisfiable by RLS alone; this is the same faithful topology `boundary-segment.integration.test.ts` established, for the same reason.

## The scope this runs at is the point

`syncScope: { mode: 'full' }` on BOTH sides — the WIDEST scope there is. A narrow scope would make this test pass for the wrong reason (the entries would be filtered as out-of-mode, and the locality clause could be deleted without the test noticing). `full` is also the scope an operator widens to when data is missing, which is exactly the moment the guarantee is relied on.

## What "nothing at all" is checked to mean

Two independent assertions, because either alone is weak:

```text
1. **Nothing lands.** No row in the commander's `objects` table for the domain-local component,
   after a real signed export→import.
2. **Nothing is even shipped.** The component's id, urn and name do not appear ANYWHERE in the
   serialized bundle body. This is the assertion that distinguishes ADR-0031's guarantee from
   the weaker "the importer declines to store it" — a bundle is a file that gets written to
   disk, relayed across a CDS boundary and kept in transfer records, so an entry the receiver
   merely refuses to apply has still crossed.
```

And a **negative control in the same bundle**: an ordinary component created alongside it arrives normally. A test that proves nothing crossed is vacuous unless it also proves something did.

## Why the update and the tombstone are exercised too

The create-path stamp alone protects nothing. Without the stamp on `updateObject`'s entry, a domain-local object leaks on its SECOND write — the whole object, one revision late. Without it on the tombstone, its deletion leaks both its existence and its NAME (a urn is `urn:scp:<org>:<type>:<name>`). Each is asserted separately so a regression names which stamp went missing.

### §102. AND DRIVE A REAL STATE TRANSITION

AND DRIVE A REAL STATE TRANSITION. `proposeChange` and `transitionChange` emit `change_status` from two DIFFERENT call sites, and only the propose one is exercised by creating a change — so without this the transition skip is untested. Mutation-proven: disabling `transition.ts`'s `if (!row.domainLocal)` left this file entirely green until this step existed, which is precisely the "green for the wrong reason" failure it now closes.

### §103. Asserted on `.detail`, NOT via `.rejects.toThrow(/…/)`

Asserted on `.detail`, NOT via `.rejects.toThrow(/…/)`. A `ProblemError`'s `message` is the bare RFC 9457 title — here "Bad Request" — so a regex matched against the message passes for ANY 400 the function might throw, including the empty-targets one. This repo has already shipped exactly that vacuous assertion once (a `/checksum mismatch/` that was really matching `message === "Conflict"`), and it passed here too until the refusal's own text was checked.

### §104. The state M20.5's inheritance produces, constructed directly

The state M20.5's inheritance produces, constructed directly: `createComponentInService` authorizes `relationship:write`, and this file's isolated-domain harness has no RBAC subject — which is why every other test here builds the object and its edge through the repos. The inheritance that would normally produce this state is covered by `domain-local-inheritance.integration.test.ts`; the subject HERE is the publish refusal.

### §105. The child must have inherited provenance to mean anything

The child must have INHERITED provenance for this to mean anything. Bolting the assertion onto the ordering test above would have been VACUOUS: that child is created with `domainLocal: true` explicitly, so its provenance is null from the start and "cleared" would pass trivially. `domainId` is OMITTED, not `null`. At the REPO layer (unlike on the wire, where the doors coerce it) a literal `null` means "I AM the org root" and writes a DETACHED row — so this container would have had no route to the org root, and the child created inside it below would have been unreachable by every principal. `createObject`'s root-reachability invariant refuses that child now, which is how this fixture was found. Omitting the field asks for the org root as the parent, which is what "a top-level partition" was always meant to say.

## `apps/server/src/federation/domain-local-rbac.integration.test.ts`

### §106. Declaring an object domain-local requires the permission

M20.1 (ADR-0031 §1) — DECLARING AN OBJECT DOMAIN-LOCAL REQUIRES `federation:write`, AT EVERY DOOR.

## Why this file exists, and why it is a CENSUS rather than a handful of cases

`domainLocal` was added to `CreateObjectRequestSchema` and `UpsertObjectRequestSchema` — and it immediately appeared on **six** routes, not two, because `CreateComponentRequestSchema` and `UpsertComponentRequestSchema` **extend** those bodies and the typed-registry factory generates a create + upsert pair for every registered type. A door that accepted the field and forgot to thread it would silently drop an operator's declaration; a door that threaded it but forgot to authorize it would let `object:write` alone decide what crosses a security boundary.

Guarding routes one at a time is the incomplete-call-site-census failure this project keeps paying for (CLAUDE.md), so the coverage here is not a hand-written list. `declaringRoutes` DERIVES the set from the committed OpenAPI document — every operation whose request body admits `domainLocal` — and the drift test asserts that set is exactly what this file exercises. **Add a seventh door and this file goes red until it is covered.** That is the property worth having; the individual 403s below are what it protects.

## The actor, and the control that makes its 403s mean something

`operator` is the built-in **Operator** role at the org root: `drizzle/0002` gives it `object:write`, and `drizzle/0012` grants `federation:write` to Administrator/Owner **only**. So it can create objects and cannot declare locality — which is exactly the distinction ADR-0031 draws, and the same actor `outposts-rbac.integration.test.ts` uses for the mirror-image case.

Every 403 from `operator` is therefore about the *federation* permission specifically. The first test is the control that earns that reading: without proving this actor can create an ordinary object, the whole file would pass just as well with a token holding no permissions at all.

## The PUBLISH door tests use two DIFFERENT actors, in the opposite direction

`POST /objects/{type}/{idOrUrn}/publish` is gated on BOTH permissions, so it is exercised from both sides and `operator` can only test one of them. The `federationOnly` / `federationAndObjectWrite` pair below are org-defined roles differing in exactly `object:write`, which is what makes that 403 attributable. Their cases say so explicitly; do not read the paragraph above as covering them.

### MUTATION RUN (2026-08-25) for the publish `object:write` bar. MEASURED, not predicted.

DELETE the `object:write` `authorize` from the publish handler in `routes/objects-generic.ts` -> 1 failed | 16 passed. "403 with federation:write but NO object:write" went red on `AssertionError: ... expected 200 to be 403`, and the returned body is the proof rather than the status: `"domainLocal":false,"version":2` — a subject holding `object:write` NOWHERE had cleared the locality flag and re-versioned a live estate row, which is the whole defect. THE OTHER PUBLISH CASES STAYED GREEN, including the `federation:write` 403 — so the new bar is not what makes them pass and they are not what makes it pass.

## What is asserted at each door — three things, because a status code alone is weak

```text
1. `domainLocal: true` from `operator` → **403**, and **nothing was written** (no object exists
   at that urn afterwards). A refusal that still created the row is not a refusal.
2. The *same* request without `domainLocal` → **201**. This is what stops the file from passing
   because the route is simply broken for this actor, and it is the mutation-sensitivity that
   makes each 403 attributable to `assertMayDeclareDomainLocal` rather than to the ordinary
   `object:write` check that precedes it.
3. An admin (holding `federation:write`) sending `domainLocal: true` → **201 with
   `domainLocal === true` on the response**. Deleting the column from the INSERT, or dropping
   the field on the way through the route, turns this red — so the authorization test cannot
   pass while the feature it guards silently does nothing.
```

### §107. Every contract door whose body admits the locality field

Every `METHOD /path` in the committed contract whose request body admits `domainLocal`.

Read from the emitted document rather than from the Zod sources because the document is what the server actually validates against and what the SDK is generated from — and because a body reached through `.extend()` (the component routes) is invisible to a reader scanning for the field name. The schemas are emitted inline per operation, so a recursive walk is the honest way to find them; `$ref` is followed one hop into `components.schemas` in case that ever changes.

### §108. The PUBLISH pair

The PUBLISH pair. Two org-defined roles differing in EXACTLY ONE permission, `object:write`, so the 403 below is attributable to the bar under test and to nothing else.

Org-defined rather than built-in because no BUILT-IN role can express "federation:write without object:write": `drizzle/0012` puts `federation:write` on Administrator and Owner, and `drizzle/0002` puts `object:write` on both of those plus Operator and Approver, so every built-in holder of one holds the other. Comparing against `admin` instead would leave the 403 explainable by any of four other permissions Administrator happens to carry.

### §109. A subject holding EXACTLY `permissions` at the org root

A subject holding EXACTLY `permissions` at the org root.

Viewer is bound purely so the harness mints an auth row and a live token; `object:read` grants no write anywhere and is no part of what is under test.

### §110. Each door is accounted for by the path that authorizes it

Each door is accounted for by the code path that authorizes it. Two of these were found BY this census rather than before it: `/objects/service` and its `orgs/{org}` path-override form are LITERAL routes Fastify prefers over the parametric `/objects/{type}`, so they carry their own body schema and dropped `domainLocal` silently — the second occurrence of the exact hazard that schema's own comment already records, for `domainId`/`properties`/`labels`/ `id`/`urn`.

### §111. Undoing a boundary decision cannot be cheaper than making it

M20.4. Undoing a boundary decision cannot be cheaper than making it, so publish is gated on the same permissionS that declared locality — this case covers the `federation:write` half, and the two cases below cover the `object:write` half. Note this route takes NO body, so the census above (which reads request bodies) cannot see it — it is covered here explicitly, and this comment is why the census is a floor rather than the whole story.

### §112. THE ASYMMETRY THIS CLOSES

THE ASYMMETRY THIS CLOSES. Declaring locality costs `object:write` AND `federation:write` (every 403 above). Publishing — the INVERSE verb, which UPDATEs the estate row, bumps `version`, and sweeps the object plus its edges onto the federation journal — cost only `federation:write`. So the FederationAdmin shape ("operates the link, does not edit the estate", `federation/handfill-repo.ts`) could mutate and re-version estate rows here.

The actor differs from the one in the NEXT case in exactly one permission, so this 403 cannot be explained by anything but the `object:write` bar.

## `apps/server/src/federation/domain-local.ts`

### §113. The rule for declaring that an object never federates

ADR-0031 — the rule for **declaring** that an object never federates.

This module is the decision's home in code, the way `federation/outpost-binding.ts` is the home of ADR-0022's authority-split rule. The filtering half lives in `federation/scope-filter.ts`; the immutability half is structural in `graph/objects-repo.ts` (only the INSERT names the column).

## Why declaring locality is a `federation:write` act

`object:write` is the permission for describing your estate. `domain_local` does something categorically different: it determines whether a row's existence is ever visible outside its own security domain. ADR-0022 already drew this line for the mirror-image case — commander-declared outpost config is gated on `federation:write` specifically so the generic `/objects/{type}` door and the IaC plan-apply path cannot write a boundary-governing property with the weaker permission. The same argument applies here in the opposite direction, so it gets the same answer.

## Why this is a helper called by six doors rather than one choke point in the repo

`createObject`/`upsertObjectByUrn` take a `TenantTx` and no subject, deliberately — they are also the path the *federation importer* and internal machinery use, neither of which has an authorizing actor. Pushing an authorization check down there would mean inventing a synthetic subject for those callers, which is how an authorization check quietly becomes a no-op.

The honest structure is therefore: **authorization at the door, invariant at the repo.** The repo guarantees the property that actually matters and that no forgotten call site can break — immutability — by never naming the column in an UPDATE. This helper guarantees the weaker, per-request property, and the risk that a *new* door forgets to call it is handled the way this codebase already handles it for ADR-0022's routes: by a census test that enumerates every route whose body schema admits the field and asserts each one refuses an `object:write`-only actor (`domain-local-rbac.integration.test.ts`, mirroring `outposts-rbac.integration.test.ts`).

## Asymmetric on purpose

Only `true` is gated. Omitting the field, or sending `false`, is the overwhelmingly common case and the status quo — requiring `federation:write` to create an ordinary object would be a permission regression affecting every existing caller, to guard a value that changes nothing.

## `apps/server/src/federation/export-repo.ts`

### §114. A detected journal fork/rollback on the EXPORT path

A detected journal fork/rollback on the EXPORT path (divergence rails 1/2, §7.2). Thrown by `exportSyncBundle` and caught by the `/exports` route, which turns it into the `journal_divergence` 409 AND records the persist-on-change Decision — the two are split because the throw rolls back the export's own read transaction, so the Decision must be written in a SEPARATE committed tx (exactly as the puller's `recordSyncBlock` does). `rail` is a STABLE discriminator: it is what the Decision dedups on, so a peer stuck in divergence writes ONE Decision, not one per 60s retry as its live tail moves underneath it (the 1,440-Decisions/day amplification `recordSyncBlock` also guards).

### §115. `scp federation export`

`scp federation export` (DESIGN.md §13 file transport). Builds a signed, checksummed `.scpbundle` (a single bounded JSON document — see `packages/schemas/src/federation.ts`'s module doc for why this is deliberately NOT a tar/zip archive) covering this domain's OWN journal entries since a cursor.

SECURITY-SENSITIVE (M6 review fix — MAJOR: confidentiality). The exported bundle contains ONLY the entries in the peer's configured sync scope. Previously the FULL journal range was shipped to every peer and scope was applied only at IMPORT/apply time — so a `policies_only` / `status_only` / `custom` peer, scoped precisely FOR confidentiality, still received the complete plaintext graph on disk / in transit and could read everything. Scope is now enforced HERE, at export; import re-applies the same filter as defense-in-depth. `throughSequence` still reflects the FULL range's tail (not the last in-scope entry), so the importer's cursor advances past out-of-scope entries and never re-requests them; the scope-filtered chain is therefore SPARSE (deliberate sequence gaps), verified with `verifyJournalChain({ contiguous: false })` on import.

### §116. DIVERGENCE RAIL 1

DIVERGENCE RAIL 1 (§7.2) — the STRICT half, no new wire data: a cursor can never legitimately outrun the origin's own tail, so `since > tail.sequence` is proof this domain's journal was rolled back (a lost-tail after an async-replication failover). The `since == tail.sequence` boundary is rail 2's job (the hash comparison below). Retained rows mean a healthy cursor always sits at or below the tail.

### §117. DIVERGENCE RAIL 2

DIVERGENCE RAIL 2 (§7.2) — anchor verification, full-scope pullers only (they alone send a real `lastAppliedRowHash`): the entry THIS domain now holds at the puller's cursor height must be the one the puller anchored to. A different rowHash there means the tail was rolled back and re-minted. Fires only on a PRESENT-but-different anchor (append-only journals mean a covered height is populated); ambiguous absence never refuses.

### §118. Records the persist-on-change Decision

Records the persist-on-change Decision (+ hash-chained audit event) for an EXPORT-side journal divergence, in its OWN committed transaction — the export's read tx has already rolled back by the time this runs (the `/exports` route calls this from its catch). Mirrors the puller's `recordSyncBlock` exactly, including WHY persist-on-change matters here: a refused pull snaps the peer to the 60s cadence, so without dedup a single stuck peer would mint ~1,440 Decision+audit pairs per day (the same incident `recordSyncBlock`'s doc names). The dedup content is STABLE per `(peer, rail)` — the live tail is deliberately NOT in it, so the Decision is written once and not restated as the exporter's own tail advances underneath the standing divergence. Returns the standing Decision's id either way (charter principle 6 — a blocked response always carries one).

## `apps/server/src/federation/federation-member-of-exemption.integration.test.ts`

### §119. THE FEDERATION-IMPORT CARVE-OUT ON `member_of` IS DELIBERATE

THE FEDERATION-IMPORT CARVE-OUT ON `member_of` IS DELIBERATE — pinned in BOTH directions

`docs/authz/role-binding-door.md` §2a applies the no-escalation subset rule when a `member_of` edge is created, at `graph/relationships-repo.ts`'s `createRelationship`. It is wrapped in `if (!input.federationImport)`, and until this file existed **that condition was pinned by nothing in either direction**: delete it and no test in the tree goes red, while a peer's signed bundle carrying one membership entry starts 403ing — and `federation/import-repo.ts`'s replay branch has per-entry handling for a 400 alone, so a 403 aborts the WHOLE bundle rather than skipping one edge. A carve-out that only a comment defends is a carve-out somebody deletes while tightening a guard.

WHY THIS ENTERS AT `createRelationship` AND NOT AT `POST /federation/imports`
This repo's standing rule is to enter at the outermost layer, because a guard that agrees with itself says nothing about whether the caller invokes it. Here the outermost layer for THIS FACT is `createRelationship`: the carve-out is a branch inside that function, and `import-repo.ts`'s `relationship_upsert` case does nothing but pass `federationImport` through to it. A signed-bundle test would exercise signature verification, cursors and tail attestations — all of which have their own suites — and would reach this branch through the same one-line hand-off. What such a test would add over this one is the assertion that the importer PASSES `federationImport`, which `federation/federation.integration.test.ts` already covers for every entry kind, so it is named here rather than duplicated: **if `applyEntry`'s `relationship_upsert` branch ever stopped passing `federationImport`, this file would stay green.**

BOTH DIRECTIONS, because either alone is satisfiable by an accident:

```text
- the EXEMPT case alone passes against a guard that was deleted outright;
- the GUARDED case alone passes against a guard with no carve-out at all, which is the state
  that wedges a peer.
```

### §120. §7'S ADMINISTRATOR FLOOR TAKES THE SAME CARVE-OUT

§7'S ADMINISTRATOR FLOOR TAKES THE SAME CARVE-OUT — and it was pinned by nothing

The floor (`docs/authz/role-binding-door.md` §7) is called from TWO NEW CHOKE POINTS this increment added — `graph/relationships-repo.ts`'s `deleteRelationship` and `graph/objects-repo.ts`'s `deleteObject` — and each call is wrapped in `!input.federationImport`, byte-identically to §2a's. **Nothing would have failed if either `!input.federationImport` were dropped.** What it would do is 409 a peer's `relationship_tombstone` or `object_tombstone`, and `federation/import-repo.ts`'s replay branch has per-entry handling for a 400 alone — so that 409 aborts the peer's WHOLE signed bundle and wedges the channel until somebody edits the code. The route suite (`routes/rbac-administrative-floor.integration.test.ts`) names this gap explicitly under "NOT MUTATION-PROVEN"; this block closes it, the same way and in both directions.

WHY THE EXEMPTION IS RIGHT, not merely convenient: a replica of a principal or of a membership is the AUTHORING domain's row. This instance cannot refuse its removal without diverging from the authority that owns it, and the floor is a statement about who can administer THIS org — a question the peer's tombstone did not ask and this instance cannot answer by refusing.

THE `federationImport` HANDED IN NAMES THE **LOCAL** DOMAIN, deliberately. Both delete paths enforce single-writer authority (`existing.originDomainId !== federationImport.originDomainId` -> 409) before they reach the floor at all, so a foreign origin id would be refused for a reason that has nothing to do with §7 and the case would stop measuring the carve-out. Passing the row's own origin isolates `federationImport` as the ONE difference between the refusal and the admission — which is the whole design of a both-directions pin.

MUTATION LOG — applied ALONE, marker counted off disk with `grep -nac`, measured, reverted
8. `graph/relationships-repo.ts` — `if (existing.typeId === "member_of" && !input.federationImport)` narrowed to `if (existing.typeId === "member_of")` -> **1 failed, 3 passed.** "a REPLICATED `relationship_tombstone` that empties the floor is APPLIED, not refused". The peer's entry 409s; in production that aborts the whole signed bundle rather than skipping one edge. The GUARDED half of the same case stayed green, which is what says the carve-out is the difference and not a deleted guard. 9. `graph/objects-repo.ts` — `!input.federationImport && !removedForeignShadow` narrowed to `!removedForeignShadow` on `deleteObject`'s `touchesRoleAuthority` probe -> **1 failed, 3 passed.** "a REPLICATED `object_tombstone` that empties the floor is APPLIED, not refused". The two call sites are separately measurable, so neither is covered only by the other.

NOT MUTATION-PROVEN here, and named: the `!removedForeignShadow` arm of the same expression, and the assertion that `import-repo.ts`'s `applyEntry` actually PASSES `federationImport` down to these two functions — the same limit the §2a block above states for itself.

### §121. An org whose only administrator is reached through a team

AN ORG WHOSE ONLY ADMINISTRATOR IS A LIVE, CREDENTIALED USER REACHED THROUGH A TEAM — built through the public API, exactly as `routes/rbac-administrative-floor.integration.test.ts` builds it, so the state under test is one the doors would actually have permitted.

## `apps/server/src/federation/federation-outbound.test.ts`

### §122. M14.0 unit coverage

M14.0 unit coverage — the cert-resolution + FAIL-CLOSED path (PIECE 1) and the loop's opt-in + interval (PIECE 2). No network / no DB — the mTLS round-trip and import are proven in `federation-sync.integration.test.ts`.

### §123. The pair-time poke-mode guard's decision table

M14.1 (ADR-0009) + M14.3 hardening: the pair-time poke-mode guard's decision table. The guard in `pairPeer` (peers-repo.ts) REFUSES iff the EFFECTIVE POST-WRITE state is poke-mode true against a non-mTLS effective baseUrl — it reuses `federationPeerRequiresMtls` exactly. This documents the truth table the persist-layer integration tests exercise against a real DB.

M14.3: the predicate is over the EFFECTIVE tuple, not the input transition. The two fields merge with OPPOSITE rules on re-pair (baseUrl: request wins when present; pokeMode: tri-state, EXISTING wins when absent), so the old `input.pokeMode === true` form validated a DIFFERENT tuple than the one persisted — a re-pair that downgraded baseUrl to http while OMITTING pokeMode skipped the guard and left a poke-mode peer on an unauthenticated transport.

## `apps/server/src/federation/federation-outbound.ts`

### §124. M14.0 — the PER-PEER mTLS OUTBOUND DIALER

M14.0 — the PER-PEER mTLS OUTBOUND DIALER (the load-bearing, security-critical half of the deferred federation-over-HTTP live-sync substrate the poke design optimizes; owner full-scope decision 2026-07-24).

## What was already there, and what this adds (grounding — cite before you touch this)

ADR-0001 / M9.3 built the LISTENER half: `federation/mtls-enforcement.ts`'s `enforceFederationMtls` accepts an inbound peer whose client cert is CA-trusted (+ CRL-checked), carries a `urn:scp:domain:<domainId>` SAN URI (`FEDERATION_SAN_URI_PREFIX`), and resolves to a registered `federation_peers` row for the bearer-authenticated org. `app.ts` flips the whole listener to HTTPS with `requestCert: true` only when `federationServerMtls` is set.

M8 (`plugin-host/subprocess-entry.ts`'s `loadFederationMtlsMaterial` + `host.ts`'s `spawnInstance` mTLS forwarding) built the DIALING half for the SUBPROCESS `federation-https` plugin: this instance's OWN client cert/key — an operator-provisioned, deployment-level (never tenant-suppliable) file pair whose SAN URI encodes `urn:scp:domain:<ownDomainId>` — read from `SCP_FEDERATION_MTLS_CERT_FILE` / `_KEY_FILE` (+ optional `_CA_FILE`) and presented via a per-connection undici `Agent`. That IS the "M6-deferred cert injection" the `federation-https` module header flagged — completed in M8. So cert PROVISIONING is settled and this module does NOT invent a new CA scheme: it REUSES the exact same env-file material and the exact same undici-client-cert technique.

What M14.0 adds on top: a server-side (apps/server) sibling of that dialer that the OUTPOST live-pull scheduler (`federation-sync.ts`) uses to POST `/federation/exports` to a commander peer. It exists as its own seam (rather than routing the scheduled sync through the subprocess `federation-https` pull()) for two structural reasons the subprocess path cannot satisfy: 1. **Bearer.** `enforceFederationMtls` is explicitly ADDITIVE to bearer+RBAC (ADR-0001 §5): the commander's `/exports` still runs `requireAuth`, so every pull MUST carry an `Authorization` bearer for a `federation:write` principal in the commander's org. The `federation-https` plugin's `ctx.http` has no seam to attach a per-request bearer; this dialer does. 2. **The full signed bundle.** `importSyncBundle` verifies a checksum that covers the WHOLE bundle header; the plugin's `JournalSegment` wire shape drops header fields, so a bundle reconstructed from it would fail signature verification. This dialer returns the response body VERBATIM as a `SyncBundle`, so the import path's fail-closed verification is UNCHANGED.

## Fail-closed (STRICT — the security-critical invariant)

A peer that REQUIRES mTLS with NO usable client-cert material configured → the dial REFUSES (`FederationDialRefused`), it NEVER silently falls back to plain HTTP / bearer-only. "Requires mTLS" is derived faithfully from the peer's own `baseUrl` scheme: in THIS system an `https://` federation endpoint always means client-cert-verified — `app.ts` only ever serves the federation routes over HTTPS when `federationServerMtls` is set (which always `requestCert`s), and the deployment-edge alternative (`deploy/helm` `ingress.mtls`) likewise verifies client certs. A plain `http://` peer (or one with no `baseUrl`) does NOT require mTLS and keeps the pre-existing bearer-only path working (backward-compatible; mTLS is opt-in per the current `federationServerMtls` posture).

## Key hygiene

Cert/key PEM bytes are read from files by path and handed straight to undici's connect options — never placed in argv, never logged (this module logs nothing), and the per-dial `Agent` is closed in a `finally` so the connection (and its cached TLS material) is torn down promptly after use.

### §125. Reads this instance's own client-cert material

Reads THIS instance's own client-cert material from the SAME operator-provisioned env-file paths M8 established (`SCP_FEDERATION_MTLS_CERT_FILE` / `_KEY_FILE` / optional `_CA_FILE`). `undefined` when unset (no client cert — the pre-M8 default). A HALF-configured pair (only one of cert/key) fails LOUD rather than silently degrading to "no client cert" — a false sense of transport identity is worse than an obvious error (identical reasoning to `loadFederationMtlsMaterial`).

### §126. A non-2xx from a federation call, with its parsed problem

A non-2xx response from a federation export/pull, carrying the parsed problem `type` and `status` so the caller can distinguish a VERIFIED, STANDING refusal (a `journal_divergence` 409 — divergence rails 1/2, §7.2, which the puller records as a block on ITS side too) from a transient failure (a 401/500/timeout the sweep simply retries). Before this, every non-2xx collapsed to a bare `Error` the caller could only treat as transient.

### §127. The outbound dial itself

The outbound dial itself: a single POST of a JSON `body` to `url`, optionally presenting this instance's client cert and/or a bearer. FAIL-CLOSED when `requireMtls` is set but `mtls` is absent. When `mtls` is present the request goes through a dedicated per-dial undici `Agent` (client cert on every handshake); when it is absent (an `http://` peer) it uses undici's default dispatcher. `rejectUnauthorized` is left at undici's secure default so the SERVER's own cert is validated against the system/`ca` trust store — this dialer authenticates BOTH directions.

### §128. Tear the connection

Tear the connection (and its cached TLS material) down promptly — never pooled across dials. `destroy()`, NOT `close()`: `close()` waits for in-flight requests, and a response body that is never read never finishes (undici leaves it pending until GC). The happy path reads `res.text()` above, but a mid-body abort/socket error leaves it partly read — and this teardown must not be the thing that decides how long a dial hangs. See artifact-verify.ts's `fetchBytes`, where the same `close()` was measured hanging past 5s.

### §129. Posts to a commander peer and returns the bundle verbatim

POST `/federation/exports` to a commander peer and return the signed `.scpbundle` VERBATIM as a `SyncBundle` for the import path to verify UNCHANGED. Throws on a non-2xx (the scheduler records a block Decision and continues) and refuses fail-closed via `federationDialJson` when the peer requires mTLS but no client cert is configured. `peer` is THIS domain's own identity as the commander knows it (its `federation_self.domainId`) — the `peer` selector the commander's `exportSyncBundle` resolves to scope the bundle to this outpost.

### §130. Resync: the importer dials the exporter, signed

§7.2.6 RESYNC — the IMPORTER dials the exporter's `POST /federation/resync` with a signed request and receives a signed full re-export + the exporter's generation. Same transport discipline as the pull dialer (mTLS derived from the peer's own URL scheme, per-URL timeout via `federationDialJson`).

### §131. Sends one contentless poke to a peer

M14.3 (ADR-0009, docs/proposals/outpost-poke.md §"Milestone scope") — SEND ONE CONTENTLESS POKE to a downstream peer's `POST /api/v1/federation/poke`. The commander→outpost/retrans wake signal: it says only "something is pending — come pull," carrying ZERO data (the no-DATA-commander→outpost invariant, ADR-0009 §1). All data still flows outpost→commander via the outpost's own pull.

Dials through `federationDialJson`, so it presents THIS instance's enrolled client cert (SAN `urn:scp:domain:<ownDomainId>`) — which the peer's `enforceFederationMtls` authenticates as the enrolled commander — and carries the same federation bearer the sync pull uses (the poke endpoint runs `requireAuth` too). The body is an empty object: the endpoint ignores it entirely (no request schema), so it is contentless in effect and in intent.

## FAIL-CLOSED — mTLS is UNCONDITIONAL for a poke (M14.3 hardening)

Unlike `pullSyncBundleFromCommander`, whose `requireMtls` is DERIVED from the peer's own baseUrl scheme (a plain-http peer keeps the pre-existing bearer-only path working), a poke is DEFINED as an mTLS-authenticated call (ADR-0009 §5) — it carries no signed payload of its own, so transport identity is the ONLY thing that authenticates the caller as the enrolled commander. So: - a NON-https target is REFUSED outright (`FederationDialRefused`) — deriving `requireMtls` from the target's own (operator-supplied, possibly downgraded) scheme would let an `http://` peer opt ITSELF out of mTLS and receive the federation bearer in CLEARTEXT with no mutual authentication; and - `requireMtls` is the CONSTANT `true`, so an https target with no client-cert material is refused too. Both refusals happen BEFORE any socket is opened. This is defense in depth behind `pairPeer`'s effective-state guard and `isPokeTarget`'s https requirement: even if a malformed poke-mode row somehow exists, the dial itself will not leak the credential.

Returns the peer's HTTP status. Best-effort semantics live in the CALLER (poke-sender.ts): a non-2xx or a thrown network error is logged and dropped — a failed poke is a missed latency optimization the receiver's sparse safety-net + next poll self-heals, never a retried-to-confirmation delivery and never something that blocks or fails the underlying journal append / transfer.

### §132. M14.4 (S8) — the poke's bounded deadline (ms)

M14.4 (S8) — the poke's bounded deadline (ms). `federationDialJson` otherwise inherits undici's 300s default, and the sender loops its peers SEQUENTIALLY with `await`, so ONE black-holing peer (a dropped SYN, a hung TLS handshake) could stall an org's entire poke round for five minutes. That is much worse under M14.4 than before, because the peers behind the stalled one are now on the SPARSE cadence and are relying on the poke for freshness. A poke is fire-and-forget and carries no payload, so a few seconds is generous; a timed-out poke is dropped exactly like any other best-effort failure and the receiver's safety-net heals it. Applied to the POKE dial ONLY — the pull keeps the long default, since a large signed bundle over a slow link must not be cut off.

## `apps/server/src/federation/federation-pair-authz.integration.test.ts`

### §133. Establishing a link is not the same act as operating one

`federation:pair` — ESTABLISHING A LINK IS NOT THE SAME ACT AS OPERATING ONE (owner ruling D4)

THE CHAIN. `POST /api/v1/federation/peers` took `federation:write` alone and the peer's Ed25519 `publicKey` VERBATIM from the request body (a changed value is a KEY ROTATION that supersedes the current window). `POST /api/v1/federation/imports` takes that same single permission, and `applyEntry`'s `object_upsert` branch resolves ANY registered `typeId` through `upsertObjectByUrn`. So on `federation:write` alone: pair a peer with a keypair you generated, import a bundle you signed with it, and you hold estate write authority having never held `object:write`.

WHERE THE BAR GOES, AND WHY NOT ON IMPORT. A throw on the import path wedges a legitimately paired peer's whole signed bundle, and an import from a legitimately paired peer writing what that peer sent is the federation contract working as designed. PAIRING is the link that can be gated without breaking the contract, so `federation:pair` (drizzle/0094) is demanded there — ADDED alongside the existing `federation:write` check, never substituted for it.

NOT LIVE TODAY, which is why the actor below has to be BUILT. drizzle/0012 grants `federation:write` to Administrator and Owner and to no other built-in role, and drizzle/0094 grants `federation:pair` to exactly those two — so no built-in role can express "operates the link, cannot establish one". The FederationAdmin role role-model.md §4.1 is designing is precisely that shape, and testing against the built-in role table's current accident would measure nothing.

WHAT THIS FILE ASSERTS
1. THE REFUSAL, on both halves of the ruling — a link operator cannot ADD a peer and cannot RE-KEY one — each with the "nothing was written" half read from `federation_peers` / `federation_peer_keys` directly, because a refusal that still stored the key is not a refusal. 2. THE REFUSAL IS ABOUT THIS PERMISSION. Every 403 is matched against `federation:pair` by name. A bare status assertion would be satisfied by the `federation:write` check that was already there, and would go on passing if the new bar were deleted tomorrow. 3. THE CONTROL, which is also the non-vacuity witness: the SAME actor still exports a bundle and reads status (200), and still edits a peer's TRANSPORT through the structurally keyless PATCH. That proves the actor genuinely holds `federation:write` — so the 403s above are about `federation:pair` and not about being powerless — and proves the ruling's "import, export, status, outposts, resync and poke stay on `federation:write`" survived. 4. BOTH GRANTED ROLES, measured separately: a built-in ADMINISTRATOR pairs and re-keys (201), and so does the bootstrap OWNER. Asserting one would leave the other's grant in 0094 unmeasured.

MUTATION RUN (2026-08-25). MEASURED, not predicted.
```text
M-1  DELETE the `permission: "federation:pair"` authorize block from `POST /federation/peers`
     (`routes/federation.ts`), leaving the `federation:write` one
       -> 2 failed | 4 passed. Both refusal cases went red, each with the peer row it should
          have refused printed in the failure message:
          "a link operator (federation:write, no federation:pair) cannot ADD a peer"
            AssertionError: {"id":"998ff4c4-...","name":"smuggled-998ff4c4","role":"commander",
            ...,"publicKey":"MCowBQYDK2VwAyEATzUGQ/QFZRKid4u+EvM/FwXBxoSauG9hi76kl+ZVTyc="}:
            expected 201 to be 403
          "... cannot RE-KEY an existing peer"
            AssertionError: {"id":"9573f29f-...","name":"established-9573f29f",...}:
            expected 201 to be 403
          — i.e. with the bar removed the link-only actor both admitted a brand-new peer under a
          key it generated itself AND rotated an established peer's trust anchor to one. The
          four control/grant cases stayed GREEN, which is the point of case 3: they do not
          depend on the new bar and are not what makes the refusals pass.
```

```text
M-2  NARROW drizzle/0094's grant to `name IN ('Owner')` — the migration's other half
       -> 2 failed | 4 passed, and a DIFFERENT two:
          "a built-in ADMINISTRATOR pairs and re-keys"
            AssertionError: {"status":403,"detail":"subject '01a03ab7-...' lacks
            'federation:pair' at scope '01a03ab7-...'"}: expected 403 to be 201
          "the built-in role table really does carry the new permission ..."
            AssertionError: expected [ 'Owner' ] to deeply equal [ 'Administrator', 'Owner' ]
          — so the Administrator half of the grant is measured, not assumed, and the two
          refusal cases do NOT depend on it (they stayed green: they are refused by the absent
          permission, not by a role table accident).
```

### §134. The actor under test

The actor under test: it OPERATES the link and cannot ESTABLISH one.

Built through `roles.org_id` (the org-defined-role mechanism) because no built-in role can express it — see this file's header. The `Viewer` binding exists only so the harness mints an auth row and a live token; `object:read` is no part of what is under test and grants no write anywhere. `federation:pair` is conspicuously ABSENT from the permission list, which is the whole fixture.

### §135. Non-vacuity for both cases above

Non-vacuity for both cases above: without this, every 403 there is equally explained by an actor holding nothing at all, and the file would prove nothing about `federation:pair`.

It is also the ruling's other half, asserted rather than assumed: "import, export, status, outposts, resync and poke stay on `federation:write` so the link keeps working". Over-narrowing would break a paired federation, which is a worse outcome than the hole being closed.

### §136. THE PER-FIELD SPLIT, made real

THE PER-FIELD SPLIT, made real. `PATCH /federation/peers/{id}` is transport-only — its request schema admits no key material at all — so it deliberately does NOT demand `federation:pair`: "may edit peer transport, may NOT rotate a peer's trust anchor" is now enforced at the permission layer as well as by the body's shape.

On its OWN peer, not on `establishedPeer`. This case must fail only for its own reason: run against a peer another case has attempted to re-key, the anchor assertion below would go red whenever THAT case's guard was removed, and this control would be reporting someone else's failure under a title about the link still working.

### §137. `OrgAdmin` JOINED THE SET IN drizzle/0099, BY OWNER RULING D6

`OrgAdmin` JOINED THE SET IN drizzle/0099, BY OWNER RULING D6 (2026-08-27), and this assertion is what caught the change rather than letting it land silently — which is the whole reason it enumerates the holders instead of spot-checking two names.

D6 resolved a contradiction inside role-model.md: §4.1 and D4 both granted `federation:pair` to "Administrator, Owner and OrgAdmin", while §3C's permission list — the one 0099's seed literal is copied from — omitted it. D4 governs, because it is the ruling that REASONED about this permission: establishing a trust relationship is a different act from operating one, so the role that operates the link must not decide whose signature this instance believes. That names `FederationAdmin` as the withholding, and it is the ONLY one — §3B holds `federation:write` and not this. Withholding it from OrgAdmin as well would leave an org whose only pairing principals are Owner and the D5-deprecated Administrator, i.e. unadministrable in exactly the dimension OrgAdmin exists to cover.

So the list below is three, and `FederationAdmin`'s ABSENCE from it is the load-bearing half.

## `apps/server/src/federation/federation-poke-chain.integration.test.ts`

### §138. The three-hop poke chain, over real mTLS listeners

M14.4 (test i) — THE THREE-HOP POKE CHAIN, end to end over real mTLS listeners and three genuinely separate Postgres databases: **commander → retrans → outpost** (ADR-0009 §38's hop-by-hop propagation, minus the CDS byte transport itself).

WHAT THIS PINS, and why it is the interesting case:

```text
* **The onward poke is OUTBOX-DERIVED, not a poke-in→poke-out relay.** The retrans does not
  forward the poke it received. It IMPORTS, the import writes outbox rows in the same
  transaction as the applied change, and the sender hangs off the outbox relay — so the second
  hop is CAUSALLY GATED on the retrans having actually applied something new.
* **That is what makes the chain loop-safe WITHOUT a TTL.** A replayed, byte-identical import
  applies zero entries, writes zero outbox rows, and therefore produces NO onward poke: the
  chain terminates by construction. A hop counter / TTL would have put a BYTE inside a signal
  that is contentless by definition (ADR-0009 §1) — this design needs neither.
```

Each hop's wake is observed through a recording pg-boss injected into that instance's deps, and each receiver's `last_poke_received_at` stamp (D2) is asserted from its own database.

## `apps/server/src/federation/federation-poke.integration.test.ts`

### §139. M14.2 (ADR-0009, docs/proposals/outpost-poke.md)

M14.2 (ADR-0009, docs/proposals/outpost-poke.md) — the INBOUND CONTENTLESS POKE endpoint, driven end-to-end against real Postgres + a REAL mTLS listener. The receiver is an outpost/retrans that has opted into pokes from an enrolled commander; the caller is that commander, presenting its enrolled `urn:scp:domain:<callerDomainId>` client cert exactly as M14.3's sender will.

`fastify.inject()` fakes the socket, so (like `mtls.integration.test.ts`) every case boots a real listener and drives it with `node:https`, presenting/withholding a client cert. The wake itself is asserted by injecting a recording pg-boss into `deps.boss`: an accepted poke enqueues exactly one immediate `FEDERATION_SYNC_QUEUE` tick (the pull runs on the loop's worker, never inline), and a burst coalesces to at most one. Skipped wholesale when `openssl` is unavailable.

### §140. The fail-closed transport identity needs its own receiver

The FAIL-CLOSED TRANSPORT IDENTITY case needs a SEPARATE receiver with federation-server-mTLS UNSET (plain HTTP, `enforceFederationMtls` no-ops). A bearer-only poke must be REFUSED (401) — a bearer does not prove the caller is the enrolled commander. Not gated on openssl (no certs here).

### §141. M14.4 (S6, test j) — THE AIR-GAP LEG

M14.4 (S6, test j) — THE AIR-GAP LEG. ADR-0009 §38 makes the high-side-retrans→outpost poke INSIDE the air gap REQUIRED, not optional. But an air-gapped outpost has NO `role: commander` peer with a baseUrl to dial — its content arrives as a FILE that the INBOX loop ingests. So a poke that woke only the federation-sync sweep resolved to ZERO peers and did nothing at all.

This receiver models exactly that: its only enrolled peer is the high-side RETRANS (role `retrans`, poke-mode), so the sync sweep has nothing to pull from — the tick returns an EMPTY outcome list — and the inbox tick is the only thing that can move the chain forward.

### §142. N3 — THE TWO INDEPENDENT TRY/CATCHES, ACTUALLY EXERCISED

N3 — THE TWO INDEPENDENT TRY/CATCHES, ACTUALLY EXERCISED. Every other test here injects a recording boss whose `send` always succeeds, so the isolation between the two wakes was only correct BY INSPECTION. A real split topology is precisely the case where one queue does not exist on the process serving the request, and a `boss.send` for it THROWS.

### §143. M13.1b — THE BYTE LEG. Legs 1 and 2 move METADATA

M13.1b — THE BYTE LEG. Legs 1 and 2 move METADATA: a poke landing on a retrans woke the import of the arriving `.scpbundle` and then waited for a human to run the byte hop (M14.4's honest-scope note, owner decision D3). This third leg is what makes the ADR-0009 chain move BYTES, and "a poke triggers an immediate cycle" is half of M13.1b's own DoD — so it is asserted here rather than left correct-by-inspection, exactly as the inbox leg was.

Asserted on the QUEUE the wake actually landed on, not on the response alone: `wokenRelay` is a boolean the handler sets, so a regression that dropped the `boss.send` while leaving the flag would keep the response green and move nothing.

### §144. The gate on the byte leg, proven as the inbox leg's is

The gate on the byte leg, proven the same way the inbox leg's is: an instance that never opted into unattended byte egress must not even have its queue poked. `startAutoRelayLoop` never creates that queue when the flag is unset, so a send would be pure noise — but more to the point, "a poke can reach it" is exactly the property the default-off consent denies.

## `apps/server/src/federation/federation-sync-cadence.test.ts`

### §145. Unit coverage of the cadence rules, with no database

M14.4 (ADR-0009; owner decisions D1–D4, 2026-07-24) — UNIT coverage, no database, for the scheduler mode's two PURE pieces: the sparse-interval knob and the per-peer due-gate truth table. The DB-backed behavior (the atomic claim, the reconnect leg end to end, the forced poke tick) is in `federation-sync.integration.test.ts`; this file pins the decision logic itself so a regression shows up as a failing truth-table row rather than a subtly denser poll in production.

### §146. The certificate warning is rate-limited, not once a process

M14.4 fix (N6) — the D4 cert warning is RATE-LIMITED, not once-per-process.

The warning is the ONLY operator-visible signal that this instance is silently running every poke-mode peer at the frequent cadence because its client-cert material stopped resolving. Deduped with no time window, a worker that emitted its single line at boot leaves someone debugging the divergence six hours later with nothing in the log window they are looking at. It must recur — just not once a minute per org.

### §147. Force and reschedule are two independent flags

M14.4 fix — FORCE and RESCHEDULE are TWO INDEPENDENT FLAGS, unit-pinned at the handler level.

- the STARTUP tick FORCES past the due-gate (its DB-observable half is pinned in `federation-sync-loop.integration.test.ts`) but MUST still re-schedule: it is the tick that BOOTSTRAPS the interval chain, so collapsing the two flags into one boolean either kills the loop ("forced ⇒ no re-schedule") or duplicates interval jobs ("forced ⇒ re-schedule"); - the re-schedule is keyed on "the batch contains a NON-POKE job", not on "no poke is present". pg-boss 10.4.2 defaults `batchSize` to 1 so a poke and an interval tick cannot arrive together TODAY — but with a larger batch the old rule would CONSUME the pending interval job and skip its re-schedule, permanently killing the self-rescheduling chain until process restart.

### §148. IMMEDIATE AND UNKEYED

IMMEDIATE AND UNKEYED — no startAfter, no singletonKey, no singletonSeconds, so pg-boss has no singleton slot to drop it into. This assertion was previously the exact inverse (it required `{singletonKey: "startup", singletonSeconds: 10}`), which pinned a real defect: `job_i4` counts COMPLETED jobs, so a worker restarting inside its own 10s window had this send silently dropped and came back with no pull-on-(re)connect at all. The shared "tick" key remains off limits for the separate reason the original note gave — a pending interval tick would absorb it — and unkeyed is immune to both.

## `apps/server/src/federation/federation-sync-loop.integration.test.ts`

### §149. M14.4 (test g) — THE WAKE AT THE REAL pg-boss LEVEL

M14.4 (test g) — THE WAKE AT THE REAL pg-boss LEVEL. Everything else in this milestone drives `federationSyncOrgTick` directly; this file proves the queue wiring the poke actually depends on:

```text
1. with a FUTURE-DATED interval job already pending (the loop's own self-reschedule), a
   `wakeFederationSyncNow` runs the handler within a couple of seconds — the wake is NOT
   swallowed by the pending singleton tick; and
2. that wake is a FORCED tick: it pulls a peer whose due-window has NOT elapsed. Without the
   `{reason:"poke"}` payload → `force` plumbing, the M14.4 due-gate would answer "not due for
   another 59 seconds" and the poke would silently do nothing; and
3. it leaves NO MORE THAN ONE pending interval job — a forced tick must not re-schedule, or
   poke traffic would insert extra pending ticks (pg-boss computes a singleton slot from now()
   AT INSERT) and make the "sparse" loop non-deterministically denser.
```

The observable side effect is `federation_peers.last_pull_attempt_at`, stamped by the scheduler's atomic claim. The peer's baseUrl points at a closed port, so the pull itself fails fast — this file tests the SCHEDULING, not the transport (that is `federation-sync.integration.test.ts`).

### §150. Inserts a completed job into the singleton slot

Insert a COMPLETED job in the singleton slot that a `singletonKey: "startup"` + `singletonSeconds: 10` send would target right now — i.e. the residue of a previous boot inside the same wall-clock bucket.

This must NOT block the fixed (unkeyed) send: `job_i4` is `(name, singleton_on, COALESCE(singleton_key,''))` and an unkeyed send leaves `singleton_on` NULL, which the index's `WHERE singleton_on IS NOT NULL` excludes outright.

### §151. `singleton_on` is NOT `now()`

`singleton_on` is NOT `now()` — pg-boss stores a TRUNCATED bucket. Copied verbatim from pg-boss 10.4.2 `src/plans.js`: 'epoch'::timestamp + '1 second'::interval * ("singletonSeconds" * floor(date_part('epoch', now()) / "singletonSeconds")) Seeding a bare `now()` would store an unaligned timestamp that collides with nothing, and this test would then pass against the very defect it exists to catch.

Both the CURRENT and NEXT bucket are seeded: the send happens milliseconds after this insert, so a bucket rollover in between would otherwise silently un-reproduce the collision.

### §152. The restart case the original startup tick silently lost

B1 REGRESSION — THE RESTART CASE THE ORIGINAL STARTUP TICK SILENTLY LOST.

The first test above passes trivially because a brand-new peer has `last_pull_attempt_at = NULL`, which the due-gate reads as "due now". But that column is DB state: it SURVIVES the process restart. A peer pulled moments before a rolling upgrade / OOM kill / node drain comes back NOT due, so a non-forcing startup tick pulled NOTHING and the outpost stayed stale for the rest of its window — silently disabling the pull-on-(re)connect leg of the decided reliability floor.

This pins BOTH halves of the two-flag model at the real pg-boss level: - the startup tick FORCES (the peer is attempted despite being deep inside its window), and - it still RE-SCHEDULES (exactly ONE pending interval job — the chain is bootstrapped, not killed, and not duplicated).

### §153. Occupies the slot a keyed startup send would land in

OCCUPY THE SINGLETON SLOT A KEYED STARTUP SEND WOULD LAND IN — deterministically, instead of hoping the wall clock arranges it. `clearPendingJobs()` above deletes only `state = 'created'`, and `job_i4` is `WHERE state <> 'cancelled'`, so a COMPLETED startup job from the previous boot survives the teardown and still holds `(name, singleton_on, key)`.

This is what made the bug a COIN FLIP rather than a CI quirk. The two startup sends are ~3-6s apart (the gap is dominated by pg-boss's 2s pollingInterval, since nothing notifies the worker on send) against a 10s bucket, so they collided with probability roughly 0.4-0.7 ON ANY MACHINE. Note the direction, which is the opposite of the intuitive one: a SLOWER runner lengthens the gap and makes the collision LESS likely, so "passes locally, fails in CI" was a sampling artefact and never evidence about the runner. Seeding the row makes the collision certain, so this test now fails 100% of the time against a keyed startup send and passes 100% against an unkeyed one.

## `apps/server/src/federation/federation-sync-refusal-dedupe.integration.test.ts`

### §154. U4 of the unbounded-Decision-write class

U4 of the unbounded-Decision-write class (see `coordination/decision-write-amplification.integration.test.ts` for the production measurement, `coordination/decisions-repo.ts`'s `insertDecisionIfChanged` for the shape).

`recordSyncBlock` fires for a STANDING condition — an mTLS-required peer with no usable client-cert material, or a dialer that refuses that peer — and NOTHING marks the peer already-refused. The sweep re-attempts it on the default 60 s cadence, so one misconfigured peer appended 1,440 identical Decisions AND 1,440 identical hash-chained audit events per day, indefinitely. (This deployment carries 0 of these rows only because its federation sync loop is off — `SCP_FEDERATION_SYNC_LOOP` unset.)

The refusal asserted here is the FAIL-CLOSED pre-flight one, which happens before any network I/O — so this needs no HTTPS listener and no PKI, unlike `federation-sync.integration.test.ts`'s two-domain suite that proves the refusal's semantics. This file only pins its WRITE volume.

## `apps/server/src/federation/federation-sync-startup-singleton.integration.test.ts`

### §155. §4-A4, AFTER THE SECOND CORRECTION

§4-A4, AFTER THE SECOND CORRECTION — federation-sync's startup send is UNKEYED, and the property this file pins is LIVENESS: the forced pull-on-(re)connect must ALWAYS be enqueued.

THIS FILE PREVIOUSLY ASSERTED THE OPPOSITE, and that is the whole lesson. It required two replicas starting together to collapse to exactly ONE `"startup"`-keyed job, treating cross-replica dedupe as the goal and a distinct key as the safe way to get it. The distinct key did fix the collision it was aimed at (a pending `"tick"` job absorbing the startup send — still pinned below), but `job_i4` is `WHERE state <> 'cancelled'`, so the slot is also held by COMPLETED jobs. The job a restarting worker most reliably collides with is therefore ITS OWN PREVIOUS BOOT, and a swallowed startup send means no forced pull: the loop still ticks on its interval, so nothing errors, nothing logs, and no health check fails — the outpost is simply stale for a whole window. That is the reliability floor M14.4 added this send to hold up.

It surfaced as a wall-clock-dependent CI flake (whether a restart shared a 10s bucket with the boot before it), which is why a green run on a developer's machine meant nothing. The current gate for the behaviour is `federation-sync-loop.integration.test.ts`'s RESTART case, which seeds the colliding completed row so it fails 100% of the time against a keyed send rather than by luck.

A test asserting a defect is worse than no test: it makes the fix look like the regression.

### §156. THE DELIBERATE INVERSION of this test's original assertion

THE DELIBERATE INVERSION of this test's original assertion (which demanded exactly 1). Every constraint that collapses these two also lets a completed job swallow a restart's send, and there is no window size that separates the two cases. The redundant pull is cheap and self-correcting — a tick claims work per peer and imports advance a forward-only cursor — whereas the swallowed one is silent and lasts a full interval.

### §157. OBSTACLE 2 (the bug the FIRST fix introduced)

OBSTACLE 2 (the bug the FIRST fix introduced): this worker's OWN previous boot, already completed, sitting in the bucket a `singletonKey: "startup"` + `singletonSeconds: 10` send would target. `singleton_on` is a truncated bucket, not `now()` — the expression is copied from pg-boss 10.4.2 `src/plans.js`. Both the current and next bucket are seeded so a rollover between this insert and the send below cannot quietly un-reproduce the collision.

## `apps/server/src/federation/federation-sync.integration.test.ts`

### §158. The outpost live-pull scheduler over mTLS, end to end

M14.0 — the OUTPOST LIVE-PULL SCHEDULER over mTLS, end-to-end against real Postgres + a real HTTPS listener (docs/proposals/outpost-poke.md, ADR-0009; owner full-scope decision 2026-07-24).

A commander+outpost TWO-DOMAIN round trip: the OUTPOST's `federationSyncOrgTick` dials the COMMANDER's real `POST /federation/exports` over mTLS (this instance presenting its enrolled per-domain client cert — `urn:scp:domain:<outpostDomainId>` SAN URI — which the commander's `enforceFederationMtls` accepts), pulls the signed `.scpbundle`, and imports it through the UNCHANGED verify path (Ed25519 at the sequence-anchored key window + hash chain). Then the FAIL-CLOSED proof: an mTLS-required peer with NO client cert → the dial is REFUSED with a block Decision, never a plain-HTTP fallback.

Each "domain" is a GENUINELY SEPARATE Postgres database booted as a REAL Fastify instance (the commander with a real HTTPS mTLS listener) — the two-domain topology from `federation.integration.test.ts` + the real-listener technique from `mtls.integration.test.ts`. Skipped wholesale when `openssl` is unavailable (mirrors `mtls.integration.test.ts`).

### §159. M14.4 — SCHEDULER MODE

M14.4 — SCHEDULER MODE (ADR-0009; owner decisions D1–D4, 2026-07-24). The same real two-domain mTLS harness as above, driven with a DETERMINISTIC CLOCK so a 15-minute sparse window is a millisecond of test time. Every case asserts on how many peers the tick actually PULLED (`outcomes.length`) — a peer the due-gate skipped produces no outcome at all.

### §160. Now the D4 case that was UNREACHABLE

Now the D4 case that was UNREACHABLE: the operator's paths are still set but the mounted secret was rotated away / unmounted, so `resolveFederationClientMtls` throws ENOENT. Called unguarded, that throw escaped into `runFederationSyncSweep`'s per-org catch and NO peer was pulled at ANY cadence — `last_pull_attempt_at` never advanced again, which is strictly worse than the decided behaviour (D4: "both halves of poke-mode fail the same way" — the sender goes inert, so the scheduler must degrade, not die).

### §161. The migration applies cleanly on an already-seeded database

M14.4 (l) — MIGRATION 0038 applies cleanly ON TOP OF a database already seeded at 0037, and every PRE-EXISTING peer row reads NULL for all three new columns, which the due-gate treats as DUE NOW. That NULL-is-due property is the whole reason the migration needs no backfill: an upgraded instance's very next tick pulls exactly as it did before.

Driven by migrating a scratch database with a TRUNCATED copy of the drizzle folder (journal entries <= 0037), writing a peer row against that older schema, then running the REAL folder.

## `apps/server/src/federation/federation-sync.ts`

### §162. M14.0 — the OUTPOST LIVE-PULL SCHEDULER

M14.0 — the OUTPOST LIVE-PULL SCHEDULER (docs/proposals/outpost-poke.md §"Milestone scope", ADR-0009; owner full-scope decision 2026-07-24). The deferred federation-over-HTTP live-sync substrate the poke design assumed already existed but did NOT: M6 shipped the FILE transport + the `federation-https` PLUGIN contract, but the SCHEDULED live pull (an outpost dialing its commander over mTLS on an interval to pull+import config-journal segments) and the outbound mTLS cert injection were deferred. M14.0 builds them; the later poke increments (M14.1–M14.4) optimize THIS loop's latency, they do not replace it.

## The reliability model this loop IS (decided — proposal §4, owner 2026-07-18)

The poke design's reliability floor is a SPARSE SAFETY-NET reconcile plus PULL-ON-(RE)CONNECT/ STARTUP. This loop provides BOTH backstop legs from day one: - **Pull-on-(re)connect:** the loop's first `boss.send` fires an immediate FORCED tick when the loop starts (`reason: "startup"`) — a fresh (re)connected process pulls every peer right away rather than waiting a full interval. It must FORCE past the M14.4 due-gate because that gate's state (`last_pull_attempt_at`) is a DB column that SURVIVES the restart. - **Sparse safety-net:** the self-rescheduling interval tick IS the safety net. In poll-mode it is the (configurable) frequent poll; in poke-mode (M14.4) its FREQUENT leg is disabled while startup + a sparse interval remain, so a dropped poke self-heals within a bounded window. The poke becomes a latency optimization over this reliable floor — never a single point of failure.

## Opt-in + role (mirrors `startInboxLoop`/`startObserveLoop` EXACTLY)

DEFAULT-OFF: scheduled only when `SCP_FEDERATION_SYNC_LOOP=1` AND the process runs a worker role (`SCP_ROLE=all|worker`, gated in `main.ts` beside the other loops). Without the flag this returns an inert handle and the queue is never created — an unconfigured instance does not spin. Chosen as an env var (not per-peer config) because whether THIS instance runs unattended live-pull is an instance-deployment concern, exactly like `SCP_INBOX_LOOP`. Interval: `SCP_FEDERATION_SYNC_INTERVAL_SECONDS` (default 60s, floor 5s) — a bounded cadence like the observe loop's, NOT the 1s reconcile tick.

## Per tick (per org, then every org — the `runInboxSweep` shape)

For each COMMANDER peer with a `baseUrl` (the outpost's record of its commander — what to dial): 1. **Fail-closed mTLS gate (PIECE 1).** If the peer requires mTLS (`https://` baseUrl) and this instance has no client-cert material, REFUSE the dial — a block Decision + no import, never a silent plain-HTTP/bearer-only fallback (`federation-outbound.ts`). 2. **Pull.** POST `/federation/exports` with `sinceSequence` = this side's cursor for the peer (`cursors-repo.ts`), presenting this instance's client cert + the federation bearer. 3. **Import UNCHANGED.** Feed the returned `.scpbundle` VERBATIM to `importSyncBundle` — the caller-independent fail-closed verification (checksum + Ed25519 signature at the sequence- anchored key window + hash-chain continuity from the last applied entry) is byte-for-byte the file/CLI path. Import advances the cursor in the SAME tx as it applies, so the next tick resumes from exactly what was durably applied — idempotent (a re-pulled bundle re-applies as a no-op) and resumable. 4. **Fail-closed on a bad bundle.** A 409 from the verify path (tamper/forgery/broken chain) records a block Decision and the tick CONTINUES to the next peer/org — one bad bundle never bricks the sweep, and NO existing import verification is weakened.

## M14.4 — SCHEDULER MODE (the disable-the-frequent-leg half; owner decisions D1–D4, 2026-07-24)

The tick now runs a PER-PEER DUE-GATE before pulling, so poke-mode really does disable the frequent poll rather than merely decorating it: - `resolveSparseIntervalSeconds` (D1) — the sparse cadence, an INSTANCE env var (`SCP_FEDERATION_SYNC_SPARSE_INTERVAL_SECONDS`, default 900s), resolved PER TICK. - `peerSyncCadence` / `isPeerDue` — the pure decision. A peer goes sparse only when it is pokeMode AND has ACTUALLY been poked (D2, self-proving) AND this instance has runtime client-cert material (D4) AND its last pull succeeded (the reconnect leg). Anything else keeps the frequent poll — a one-sided misconfiguration costs nothing but the polling it already did. - `claimPeerPull` (peers-repo) — an ATOMIC conditional UPDATE, so N worker replicas still make at most one pull per peer per window (an in-memory throttle would multiply the effective rate by the replica count and defeat "sparse" entirely). - `wakeFederationSyncNow` + the handler's `force` path — a poke BYPASSES the due-gate and does NOT re-schedule. Without that bypass the poke would be swallowed by the very gate it complements ("this peer isn't due for another 14 minutes") and pull nothing.

### FORCE and RESCHEDULE are TWO INDEPENDENT FLAGS (not one boolean)

The due-gate has two distinct kinds of tick that must bypass it, and they differ in the OTHER axis — whether the tick owes the loop a re-schedule:

| tick             | `reason`    | forces past the due-gate | re-schedules the interval chain |
| interval         | (none)      | no                       | YES                             | | pull-on-(re)connect | `startup` | YES                    | YES — it BOOTSTRAPS the chain   | | poke             | `poke`      | YES                      | no — it rides ALONGSIDE the chain |

The STARTUP tick must force. `last_pull_attempt_at` is a DB COLUMN, so it SURVIVES a process restart: a peer that pulled two minutes before a rolling upgrade / OOM kill / node drain comes back NON-NULL and NOT due, and a non-forcing startup tick would pull NOTHING — the outpost then stays stale for the remainder of the sparse window. Pull-on-(re)connect is an explicit leg of the decided reliability floor (proposal §4); poke-mode must not weaken it.

But it must ALSO re-schedule: the startup tick is the tick that STARTS the self-rescheduling chain. Collapsing the two flags into one boolean breaks one of them — "forced ⇒ no re-schedule" kills the loop outright, "forced ⇒ re-schedule" reintroduces the duplicate interval jobs the poke path deliberately avoids.

Still out of scope here: the `pokeMode` flag itself (M14.1, peers-repo), the contentless poke endpoint (M14.2, routes/federation.ts) and the commander poke sender (M14.3, poke-sender.ts).

### §163. M14.4 — the SPARSE cadence CEILING

M14.4 — the SPARSE cadence CEILING: 12 hours. REQUIRED, not decorative. pg-boss asserts `singletonSeconds <= archiveSeconds` (12h by default), so a "daily" sparse floor would THROW at runtime the moment such a value reached pg-boss. The cap makes an over-large operator value clamp instead of breaking the loop.

### §164. The sparse safety-net interval, in seconds

M14.4 (owner decision D1) — the SPARSE safety-net interval, in seconds, resolved from `env`.

An INSTANCE-level env var (`SCP_FEDERATION_SYNC_SPARSE_INTERVAL_SECONDS`, default 900) and deliberately NOT a per-peer column: a per-peer value on the commander's row would let a COMMANDER operator dictate a downstream instance's own polling cadence — a policy inversion — and would drag a tuning knob through the whole schema→API→SDK→CLI→UI parity chain for no gain. How often THIS instance reconciles is an instance-deployment concern, exactly like `SCP_FEDERATION_SYNC_LOOP`.

Clamped into `[frequentIntervalSeconds(env), 43200]`: a sparse interval BELOW the frequent one is meaningless (it would make "sparse" denser than "frequent"), and the ceiling is pg-boss's archive-window assertion (see `FEDERATION_SYNC_SPARSE_INTERVAL_MAX_SECONDS`).

PURE and resolved PER TICK — never an import-frozen module const.

### §165. M14.4 — the EFFECTIVE cadence for one peer

M14.4 — the EFFECTIVE cadence for one peer. A peer is on the sparse (`"poke"`) cadence ONLY when ALL of the following hold; any one of them failing keeps it on the frequent poll:

1. `pokeMode` is set for the peer (the local operator opted in); 2. **D2, SELF-PROVING SPARSE** — a poke from that peer has ACTUALLY been received at least once (`lastPokeReceivedAt`). Poke-mode is TWO independent flags on TWO instances; if the outpost's is set and the commander's is not, nothing pokes and the frequent poll would silently drop to a 15-minute staleness with no error anywhere. Requiring PROOF that pokes arrive closes that unilateral-sparse footgun: an unproven peer keeps polling, so the misconfiguration costs nothing but the poll it was already paying; 3. **D4, RUNTIME CERT MATERIAL** — this instance has outbound client-cert material. `pokeMode` is only mTLS-checked at PAIR time; if the cert material later disappears, the poke SENDER goes inert and the dialer fail-closes, so the poke path is dead while the flag still says sparse. Both halves of poke-mode must fail the same way, so no certs ⇒ frequent; 4. **the reconnect leg** — the last pull ATTEMPT succeeded. A failing peer (commander down, network partition, refused bundle) returns to the frequent cadence until ONE pull succeeds, which re-arms sparse. This is the "pull-on-(re)connect" half of the decided reliability model, expressed as a pure function of two timestamps (no counters — replica-safe).

### §166. M14.4 — THE MODE SWITCH, as a pure DB-free predicate

M14.4 — THE MODE SWITCH, as a pure DB-free predicate: is this peer due for a pull at `now`?

`true` when the peer has never been attempted (`lastPullAttemptAt === null` — deliberately "due now", so every pre-M14.4 row survives the gate untouched and drizzle/0038 needs no backfill; note this does NOT cover pull-on-(re)connect, since the column survives a restart — that leg FORCES, see `FEDERATION_SYNC_STARTUP_REASON`) or when its `effectivePullIntervalSeconds` has elapsed since the last attempt. The scheduler re-checks the same condition inside an atomic conditional UPDATE (`claimPeerPull`) so the decision is also safe across worker replicas; this predicate exists so the truth table itself is unit-testable without a database.

### §167. M14.4 (S4) — a FORCED tick

M14.4 (S4) — a FORCED tick: pull every peer of the org REGARDLESS of the due-gate. Set by the poke wake (`reason: "poke"`). Without this the poke would be swallowed by the very feature it complements: the due-gate would answer "this peer isn't due for another 14 minutes" and pull NOTHING, leaving pokes decorative while nearly every test stayed green.

### §168. The runtime client-cert probe, and why it never throws

M14.4 (owner decision D4) — the RUNTIME client-cert probe, and the reason it never throws.

`resolveFederationClientMtls` throws in TWO situations: a HALF-configured cert/key pair, and `readFileSync` failing on a configured-but-missing/unreadable file (a rotated-away or unmounted secret — `SCP_FEDERATION_MTLS_CERT_FILE`/`_KEY_FILE` still set, the file gone). Calling it unguarded from the tick made that throw escape into `runFederationSyncSweep`'s per-org catch, where it was logged as "org <id> tick failed" and NO peer was pulled at ANY cadence — `last_pull_attempt_at` never advanced again. That is strictly worse than the decided behaviour.

D4 decided the opposite: "refuse to go sparse without runtime client-cert material — mirroring the M14.3 sender's inert-without-certs rule, so BOTH HALVES of poke-mode fail the same way." The sender going inert is harmless; the scheduler going DEAD is not. So a throw here degrades to `hasClientCerts: false` — the peer drops back to the FREQUENT cadence and KEEPS BEING PULLED (an https peer's pull is then refused fail-closed with its own block Decision, exactly as designed; an http peer's pull still succeeds). Never a dead tick.

The cause is a real operational fault, so it is surfaced at WARN — but RATE-LIMITED, because this runs on every tick of every org and an unfixed missing secret would otherwise emit a log line a minute forever. Rate-limited is NOT once-ever: a long-lived worker that emitted its single line hours ago would leave an operator investigating a sparse-vs-frequent divergence today with nothing to find in the log window they are actually looking at. So the same message re-fires once per `FEDERATION_CERT_WARNING_REWARN_INTERVAL_MS` for as long as the fault persists, and a successful resolve clears the suppression so a recurrence warns immediately.

### §169. The same probe, as the single answer to that question

M14.4 fix (N5) — the SAME runtime probe, exposed as the single answer to "does this instance have usable outbound client-cert material RIGHT NOW?".

`GET /federation/status` reports `effectiveCadence` — the cadence the scheduler is ACTUALLY running each peer at — and that endpoint exists precisely so an operator can SEE a sparse-vs-frequent divergence. Computing it from the cheap presence check (`federationClientMtlsConfigured`, paths set?) made status and scheduler disagree in exactly the case D4 exists for: paths still set, the mounted secret rotated away. The scheduler falls back to the frequent cadence (and warns); the presence check says "configured", so status would have reported `poke` for a peer being polled every minute. Both sides now call THIS, so they agree by construction rather than by coincidence.

Never throws (see above), and the file reads are two small secrets — cheap enough for a per-request status call, and deliberately NOT cached, since the whole point is that the answer changes when the file underneath changes.

### §170. Records a block Decision and audit event in one transaction

Records a block Decision + hash-chained audit event for a refused/failed pull, in one tx.

PERSIST-ON-CHANGE (`coordination/decisions-repo.ts`'s `insertDecisionIfChanged`): every refusal reachable from here is a STANDING condition, not an event — an mTLS-required peer with no client-cert material configured, or a dialer that refuses that peer — and nothing anywhere marks the peer "already refused". The sweep re-attempts it on the default 60 s cadence, so before this guard a single misconfigured peer appended 1,440 identical Decisions AND 1,440 identical hash-chained audit events per day, indefinitely. The re-attempt is deliberately unchanged: it is how a rotated-in cert or a repaired peer is noticed, and the FIRST refusal — plus the first refusal with any DIFFERENT reason — is still fully recorded and audited.

The audit event is suppressed on exactly the same condition as the Decision, never independently: appending a `federation.sync.refused` event for a tick where nothing changed would make the hash-chain assert an occurrence that did not occur (and `scp audit verify` cannot be repaired afterwards by deleting rows). Same pairing `coordination/pre-deploy-gate.ts`'s idempotent pass path uses.

Returns the standing Decision's id either way — a suppressed restatement still hands the caller a resolvable `decision_id` for the peer's `refused` outcome (charter principle 6), never null.

### §171. Records a standing importer-side journal divergence

Records a STANDING importer-side journal divergence with a peer (rails 1/2/4, §7.2), under the dedicated `federation-divergence` kind so RAIL 5 (`permitCursorReanchor`) can find it precisely. Same persist-on-change + paired-audit discipline as `recordSyncBlock` (one row per stuck peer, not one per 60s retry). The block STANDS until the resync operation (§7.2.6) supersedes it — which is why the reason is kept stable and the live divergence detail rides only on the refusal, not here.

### §172. 409 = the verify path REFUSED

409 = the verify path REFUSED (checksum/signature/chain — identical to the file/CLI outcome, carrying its Decision when the path persisted one). Record a block; the sweep continues.

THIS IS THE LIVE-PULL SURFACE for `verifySegment`'s contiguity diagnostic: a pull never reaches an operator's terminal, so `err.detail` — which for a chain break is the full "compare `scp federation peers` on BOTH domains" guidance rather than a tampering alarm — is what lands in the peer's `refused` outcome AND, verbatim, in the block Decision's reason. Nothing here may summarise or truncate it.

### §173. One org's tick

One org's tick: pull from every commander peer that has a baseUrl AND is DUE.

M14.4 adds the per-peer due-gate between "which peers could I pull" and "pull it": a poll-mode peer is due once per FREQUENT interval, a proven poke-mode peer only once per SPARSE interval — so poke-mode really does disable the frequent poll instead of merely decorating it. The gate is enforced by an ATOMIC conditional claim (`claimPeerPull`), never an in-memory map, so N worker replicas still produce at most one pull per peer per window. A FORCED tick (`options.force`, the poke wake) bypasses the window entirely — see `FederationSyncOptions.force`.

### §174. Every org, one tick

Every org, one tick — mirrors `runInboxSweep`. M14.4: `options.orgId` narrows the sweep to ONE org (the poke wake, whose org comes from the CALLER'S OWN AUTHENTICATED identity — never from a request body, so the poke stays contentless and one tenant's poke can never re-time another tenant's peers).

### §175. Enqueues one immediate federation-sync tick

M14.2 (ADR-0009) — enqueue ONE immediate federation-sync tick: the contentless poke's "come pull NOW" wake. Sent with NO singleton so it always lands as a fresh immediate job (the poke endpoint's per-peer rate limiter is what bounds it to at most one pull per window — reusing the loop's own throttling `singletonKey` here would let a queued interval tick SWALLOW the wake, defeating it). The pull itself runs on the loop's worker, never inline in the request path.

THROWS when the queue does not exist — i.e. the sync loop was never started on this process (`SCP_FEDERATION_SYNC_LOOP` unset, or a pure `role=api` process). The caller treats that as "accepted-but-no-op" (proposal §"Milestone scope"): the poke is still honored, the sparse safety-net + a worker process are the reliability floor.

M14.4 (S4) — the wake now carries `{ reason: "poke", orgId }`. WHY: with the M14.4 due-gate in place, a wake indistinguishable from an interval tick would be gated by that very due-gate ("this peer isn't due for another 14 minutes") and pull NOTHING — the poke silently swallowed by the feature it complements. `reason: "poke"` makes the handler run a FORCED tick. The `orgId` is derived from the CALLER'S OWN AUTHENTICATED org at the route (`auth.orgId`), NEVER from the request body — the poke stays CONTENTLESS, and one tenant's poke cannot re-time another tenant's peers.

### §176. The `reason` a tick carries

The `reason` a tick carries. An INTERVAL tick carries none (the self-reschedule sends `{}`), so `reason === undefined` is exactly "this is a scheduled tick".

- `"poke"` — the contentless poke's wake (`wakeFederationSyncNow`): FORCES, does NOT re-schedule (it rides alongside the interval chain, which is still pending). - `"startup"` — the pull-on-(re)connect tick fired by `startFederationSyncLoop`: FORCES (see `FEDERATION_SYNC_STARTUP_REASON`) and DOES re-schedule (it bootstraps the chain).

### §177. The reconnect tick's reason, and why it is not empty

M14.4 fix — the pull-on-(re)connect tick's `reason`, and why it is not just `{}`.

The startup tick used to send `{}`, which made it an ordinary NON-forced tick, on the assumption that "a NULL `last_pull_attempt_at` reads as due, so pull-on-startup survives the due-gate". That assumption is FALSE after the first ever pull: `last_pull_attempt_at` is a DB column and SURVIVES the restart. A proven poke-mode peer whose last pull succeeded two minutes before a worker restart is NOT due, so the startup sweep pulled nothing and the outpost stayed stale for the rest of the sparse window. `reason: "startup"` forces past the gate — restoring the pull-on-(re)connect leg of the decided reliability floor, which poke-mode must not weaken.

### §178. RETIRED (M26, §4-A4's second correction)

RETIRED (M26, §4-A4's second correction) — this used to be `= 10`, the startup send's own singleton window. It is gone rather than re-tuned, and the reasoning is worth keeping because it was subtle enough to be got wrong twice:

The original note correctly established that the chain's `"tick"` key was off limits (a pending interval tick would swallow a startup send filed under it), and concluded that a DISTINCT key with a short window was therefore safe. It is not. `job_i4` counts jobs in every state except `cancelled`, so the slot is held by a COMPLETED job too — which means the thing a restart most reliably collides with is *its own previous boot*, the one case a "restart storm" window is least able to distinguish from the storm it was meant to collapse. There is no window size that separates them: shrink it and simultaneous replicas stop deduping, grow it and restarts get swallowed for longer.

The startup send is now UNKEYED (`LOOP_STARTUP_SEND_IS_UNKEYED`, events/pgboss.ts), like every other loop's. Note that simply dropping `singletonSeconds` while keeping the key would NOT have worked either — it only makes the key inert (job_i4 requires `singleton_on IS NOT NULL`), leaving code that reads as if it dedupes while doing nothing at all.

### §179. Self-rescheduling pg-boss loop

Self-rescheduling pg-boss loop — the SAME singleton shape as `startInboxLoop`/`startObserveLoop` (a `boss.work` handler that re-`send`s itself with `startAfter` + `singletonKey`). Runs only under `SCP_ROLE=all|worker` (wired in `main.ts`) AND only when the operator explicitly enabled it (`SCP_FEDERATION_SYNC_LOOP=1`) — otherwise an inert handle and the queue is never created.

The initial `boss.send(FEDERATION_SYNC_QUEUE, { reason: "startup" })` is the PULL-ON-(RE)CONNECT backstop leg: a fresh (re)connected worker pulls once immediately — FORCED past the due-gate, because the gate's state lives in a DB column that survives the restart (see `FEDERATION_SYNC_STARTUP_REASON`) — rather than waiting a full interval.

### §180. TWO INDEPENDENT FLAGS

TWO INDEPENDENT FLAGS — see the module header's table. pg-boss hands the handler a BATCH.

FORCE: a POKE job or a STARTUP job bypasses the due-gate (otherwise a poke pulls nothing, and a restart pulls nothing for any peer that had already been attempted).

RESCHEDULE: owed by every NON-POKE job. A poke rides ALONGSIDE the interval chain (its pending interval job is untouched and still fires), so re-scheduling on a poke would insert an EXTRA pending tick — pg-boss computes the singleton slot from now() AT INSERT, so a poke landing in a different slot is not deduped and poke traffic would make the "sparse" loop non-deterministically denser. A STARTUP job, by contrast, is the tick that BOOTSTRAPS the chain and MUST re-schedule.

Keying the re-schedule on "the batch contains a non-poke job" rather than on "no poke is present" is the batchSize>1 hardening: pg-boss 10.4.2 defaults batchSize to 1, so a poke and an interval tick cannot arrive together today — but if this queue ever took a larger batch, a mixed batch would CONSUME the interval job and skip its re-schedule, permanently killing the self-rescheduling chain until process restart.

### §181. PULL-ON-(RE)CONNECT: fire the first tick immediately, FORCED

PULL-ON-(RE)CONNECT: fire the first tick immediately, FORCED (see the constant's doc) — and it is this tick that bootstraps the self-rescheduling interval chain. SENT UNKEYED, so it ALWAYS inserts (LOOP_STARTUP_SEND_IS_UNKEYED, events/pgboss.ts).

This send used to carry its own `"startup"` key with a 10s window, on the reasoning that N replicas restarting together should dedupe their startup pulls among themselves while staying off the chain's `"tick"` key. That reasoning was half right — `"tick"` is indeed off limits — and half fatal: job_i4 counts COMPLETED jobs as holding the slot, so a worker that bounced inside its own 10s window had its startup send silently dropped and came back with the pull-on-(re)connect leg missing. Losing that leg is invisible: the loop still ticks on its interval, so nothing errors and nothing alerts — the outpost is just stale for a whole window, which is exactly the reliability floor this send exists to hold up.

The dedupe is deliberately given up rather than re-tuned, because no window size fixes it: any (key, bucket) pair a restart can share with its own previous boot can swallow it. Redundant startup pulls are merely wasteful — the tick claims work per peer, and imports advance a forward-only cursor, so a duplicate pull converges instead of corrupting.

## `apps/server/src/federation/federation.integration.test.ts`

### §182. M6 Federation Basics

M6 Federation Basics — Testcontainers integration coverage (BUILD_AND_TEST.md §8 M6 DoD).

Each "domain" is a GENUINELY SEPARATE Postgres DATABASE (test-support/isolated-domain.ts), within the same Testcontainers container — faithfully matching DESIGN.md §13's real topology (two federation domains are two separate SCP instances, each with its OWN database; there is no shared `objects` table between them). This also sidesteps a real structural fact this milestone surfaced: `objects.id` is a single GLOBAL primary key (not composite with `org_id`), which is completely safe within one instance's one database but would collide the moment two "domains" sharing ONE physical table tried to replicate the SAME id (exactly what federation import does by design, for single-writer authority) into each other's rows.

The real two-domain E2E (scripts/e2e-m6.sh) additionally proves this holds across two actually separate scpd+postgres COMPOSE stacks with no network path between them at all; this file covers the cryptographic/authority logic exhaustively at the integration layer, where Testcontainers makes tight iteration and adversarial tampering easy to express.

### §183. Rebuilds the outer checksum over tampered content

Rebuilds a promotion bundle's OUTER checksum/signature over tampered content, using the EXPORTING domain's real key — simulating "the exporting domain itself included a bad attestation" (a bug, or a malicious/compromised exporter), which is a DIFFERENT threat than "someone tampered with an otherwise-legitimate bundle in transit" (already covered by the sync-bundle tamper tests). Without this, mutating `bundle.approvals` post-hoc leaves the OUTER checksum stale, so `importPromotionBundle`'s bundle-level check rejects it before ever reaching the per-attestation validation this is meant to exercise.

### §184. The exploit this guards (CRITICAL review finding)

The exploit this guards (CRITICAL review finding): a legitimately-paired peer X (domainA) signs a bundle entry for a BRAND-NEW urn whose `originDomainId` claims some OTHER domain P. On the create path `createObject` writes `originDomainId` verbatim (the update-path 409 check only protects EXISTING rows), so without the fix the victim (domainB) would believe P authoritatively owns an object X actually forged — and an inflated revision would then permanently 409-block P's real future updates. A signer may only vouch for its OWN authorship.

### §185. The authorization-only subject this direct call supplies

The authorization-only subject this direct-repo call has to supply for itself. It has to be a REAL bound subject now: `assertObjectWriteAuthorityForHandFill` resolves org-root `object:write` against it, and the bare org-root OBJECT this case used to pass carries no role bindings at all, so it resolves to a default deny. `createApprover` is generically "a `user` object plus a built-in role bound at the org root" despite its name; Administrator is the role that actually holds hand-fill's two permissions (`object:write` from `drizzle/0002`, `federation:write` from `drizzle/0012`).

### §186. The subject those three refusals resolve against

M21.7 — the subject the governance-authority, policy-scope and governance-label refusals resolve, never the synthetic import actor `handFillObject` hands to the upsert. `service` is not governance-managed and carries no governance labels here, so none of those three fire; the governance cases are asserted in `governance-managed-write-doors.integration.test.ts` and `governance-label-write-doors.integration.test.ts`, and the `object:write` bar every hand-fill clears in `handfill-object-write-authority.integration.test.ts`.

### §187. A real subject holding the permission, not the root id

A REAL subject holding org-root `policy:write`, not the org-root object id this file uses as a synthetic actor elsewhere. TWO independent checks now demand that, and this one author satisfies both:

- M21.7/#244 — `createOverlay` gained the governance permission check the three type guards beside it always implied (`federation/overlay-repo.ts` — an Operator was minting live org-wide policies through this door). The refusal itself is asserted in `governance/governance-managed-write-doors.integration.test.ts`. - This PR — `createOverlay` now also runs `assertPolicyScopeWithinAuthority` for a `policy` overlay (this route was one of the two doors that check never reached), and this overlay declares no `scope`, which means org-wide: exactly the bar that check enforces.

The org-root OBJECT holds no role bindings, so the old actor is refused by both. `Administrator` carries org-root `policy:write` (`drizzle/0010_governance.sql:174-175` grants it to Administrator and Owner), and `createApprover` binds at the org root — which is the scope `assertPolicyScopeWithinAuthority` requires for an unscoped policy. This case is about overlay MECHANICS (replicated base, merged view, base never mutated); an authorized author is what lets it reach them.

### §188. M21.7 — an AUTHORIZED policy author

M21.7 — an AUTHORIZED policy author (see the overlay round-trip case above for why). The point of this case is that `policy:write` is not a licence to WEAKEN a base policy: the actor clears the new governance permission check and is still refused by `assertPolicyOverlayOnlyAddsStrictness`, with a 400 rather than a 403. Passing an unauthorized actor here would make it green off the permission refusal and prove nothing about strictness.

### §189. M25.4 — the campaign recipe a promoted change carries

M25.4 — the campaign recipe a promoted change carries (ADR-0041 §2). Nested `inputs` on purpose: a shallow bag would survive a naive `{...props}` copy that a deep-strip bug still breaks, so the fixture asks the harder question. The keys are `github`-shaped because the recipe crosses the boundary VERBATIM — no cross-provider translation happens on the promotion path either.

### §190. Proposes a change declaring a stage dependency

ADR-0028: propose the change with a declared `stageDependencies` naming a second object in domain A, to exercise the promotion-import strip. A separate object rather than the change's own target, because a self-declaration mints no `depends_on` edge and would make the fixture answer an easier question than the real one. A COMPONENT specifically: `dependsOn` is refused for anything else at propose time, since only a component can be placed and therefore only a component can ever be held against.

### §191. Insert a `trivy` scan control run for `changeId`

Insert a `trivy` scan control run for `changeId`. Defaults to the PASSING, digest-bound outcome the M17.3 E6 export gate re-checks (status pass + digestMatch + scanned digest == promoted); the overrides let a test seed a FAILED or digest-mismatched outcome to exercise the fail-closed path.

`pluginModule` NAMES THE PRODUCER, and is not fixture decoration. E6 admits a scan outcome by which control produced it (`scan-evidence.ts`), so a row with no module — which is what this helper used to write — is no longer evidence about anything. The honest fixture for "org-pipeline evidence" is the module that actually produces it. The gate's REFUSAL of the no-module and wrong-module shapes is pinned in `scan-evidence.test.ts` and by the "webhook-control cannot manufacture a crossing" case below.

### §192. THE REGRESSION THIS EXISTS TO PREVENT

THE REGRESSION THIS EXISTS TO PREVENT (S10, `enforceLocalChangeAuthority`'s doc comment): that guard refuses a change whose graph object's `originDomainId` is not this domain. It is only safe to key on `originDomainId` BECAUSE `importPromotionBundle` calls `proposeChange` FRESH in the receiver — control genuinely transfers, and the exporting domain is recorded separately as `changes.imported_from_domain`. A guard keyed on `importedFromDomain` instead would refuse B every verb on every change it ever accepted by promotion. Nothing pinned that precondition before: it was an argument in a comment, and a refactor of `importPromotionBundle` that stamped the exporter as the origin would have broken promotion acceptance silently.

### §193. 1. `requires` is STRIPPED on import

1. `requires` is STRIPPED on import (owner ruling: the commander already enforced the coupling; its promotion IS the go-ahead — re-evaluating locally would be redundant or deadlock). With zero requirements the routing guard sends the change coordinated -> executing, never `waiting` (guard behaviour pinned by coupling.integration.test.ts). 2. `provides` is PRESERVED VERBATIM — this pins promotion-repo's properties spread against a refactor: a promoted infra change must still be able to satisfy a LOCALLY-authored waiter in the receiving domain.

### §194. M25.4 / ADR-0041 §2 — THE OTHER SIDE OF THE STRIP

M25.4 / ADR-0041 §2 — THE OTHER SIDE OF THE STRIP: the keys promotion must NOT remove.

The two cases above pin what promotion DOES strip. Nothing pinned the complement, and the complement is where a campaign recipe lives. `promotion-repo.ts` destructures exactly `requires` and `stageDependencies` off `bundle.change.properties` and spreads the rest through; a future THIRD key added to that destructuring would silently take the recipe with it if it were ever mis-typed, or a refactor to an allowlist ("copy these keys") would drop it outright.

THE FAILURE IS SILENT AND GREEN, which is why it earns a test rather than a comment. The outpost's reconcile would find no recipe on the imported change, fall back to `kind: "sync"` with no parameters, dispatch each target's DEFAULT pipeline, watch every run succeed, and mark the wave `succeeded`. The commander would report a migration that reached the outpost and never happened there. There is no error anywhere on that path.

Deliberately asserted through the SAME reader the actuator uses (`resolveChangeRecipe`) and not only against the raw key — the lesson the `stageDependencies` case above records: a strip that left the value somewhere the reader no longer finds would pass a key check and fail here.

### §195. WHAT THIS PREVENTS

WHAT THIS PREVENTS. A promoted change is re-proposed LOCALLY with this domain's own origin, so reconcile's foreign-origin skip does not exclude it and the outpost really would evaluate the coupling. But `change_wave_targets`/`observed_state` are journaled by nothing and `relationship_upsert` ships only under sync scope `full`; under any narrower scope the depended-on component is not here at all, every verdict resolves to `not_placed` -> SATISFIED, and the release fires with no hold and NO RECORD — the silent fail-open ADR-0028's own Consequences call the worst available answer. Stripping defers the open federation ruling (D5) instead of shipping it.

### §196. The strip is an engine verdict, so it is EXPLAINABLE

The strip is an engine verdict, so it is EXPLAINABLE (charter principle 6) — recorded under the HOLD's own kind, so the row says which mechanism removed the declaration rather than leaving an unexplained absence. An operator reaches it by the promoted change (`scp change explain <id>`, or `scp decision list --subject-id <change-id>`) or, since ADR-0028 increment 4, without the change id at all: `scp decision list --kind stage_dependency`. That filter now exists — see `promotion-repo.ts`'s note, and `decisions-kind-filter.integration.test.ts` for its own test. The verdict below is what distinguishes THIS row from a hold under the same kind.

### §197. Re-sign the SAME attestation record but with the URN swapped

Re-sign the SAME attestation record but with the URN swapped (binding mismatch) — the per-attestation signature IS valid (genuinely produced by domain A's real key over the tampered record), isolating the `approvedObjectUrn` BINDING check specifically, independent of signature validity. The OUTER bundle is likewise re-signed by A's real key, simulating "the exporter itself attached an attestation for the wrong object" rather than in-transit tampering (already covered above).

### §198. M17.3 (E3) — the TYPED artifact set. The crux is COMPATIBILITY

M17.3 (E3) — the TYPED artifact set. The crux is COMPATIBILITY: `artifacts[]` is the rich source, `artifactDigests` its backward-compatible flat projection, and the typed set takes NO part in the Ed25519 checksum/signature (EXPAND phase). NO cosign/signing is introduced.

### §199. No tracked artifacts means undefined, not an empty array

No tracked artifacts → the top-level ENVELOPE `artifacts` field is undefined (NOT []), so it is dropped from the CHECKSUM-relevant canonical string and the envelope stays byte-identical to a v1 bundle. (M17.3 E6 adds a checksum-EXCLUDED `promotionManifest` sibling that legitimately enumerates the — here empty — artifact set, so the whole-bundle JSON is no longer the right proxy; assert the E3 invariant precisely on the checksum payload instead.)

### §200. Artifact as a first-class type, minted at the boundary

ADR-0045 — `artifact` as a first-class object type, minted at the promotion boundary. Reuses this describe's own domainA/domainB E5/E6-paired harness (`proposeApprovedChangeInA`, `exportBundleA`) rather than a new one — the promotion machinery IS the minting machinery.

### §201. M17.3 (E6) — the CAPSTONE

M17.3 (E6) — the CAPSTONE. Export HARD-REFUSES (with a decision_id) every cross-boundary promotion lacking a passing, digest-bound scan for each SUBSTANTIVE artifact (SBOM EXEMPT), and co-signs a SELF-BINDING cosign manifest (no swap vector) that is EXCLUDED from the Ed25519 checksum. SCP signs only its OWN manifest (coordinate-not-execute). Uses REAL cosign.

### §202. Locality is inert here, and the second egress is guarded

M20 (ADR-0031 §7) — DOMAIN-LOCALITY IS INERT AT E6, AND THE SECOND EGRESS IS GUARDED.

ADR-0031 §7 makes locality VISIBILITY ONLY: it grants no scan exemption, relaxes no gate, and is read by no governance path. That claim is exactly the thing ADR-0018 §1 rejected a per-artifact `dev` bit for — a bit that could be lifted onto a boundary-crossing artifact — so it needs a witness rather than a comment. ADR-0018 §4 imposed the same obligation on its own label.

Two complementary properties, and they must not be confused with each other:

```text
(a) INERTNESS. Setting or clearing `domain_local` anywhere changes NO E6 outcome. The refusal
    for a missing scan is byte-identical; a passing scan still exports.
(b) ENFORCEMENT AT THE SECOND EGRESS. A domain-local change is refused a crossing OUTRIGHT,
    under its OWN decision kind, BEFORE the scan step runs — so it is never "exempted from
    scanning", it is denied the crossing. `exportPromotionBundle` does not read the journal,
    so §2's never-journal withholding does not reach it; this is the guard that does.
```

### §203. The bypass this case closes, against a real database

THE BYPASS THIS CASE EXISTS TO CLOSE, end to end against a real database.

`control_runs.evidence` is persisted VERBATIM from whatever a bound ControlPlugin returns (`governance/control-runner.ts`: `evidence = outcome.evidence ?? {}`), and `@scp/plugin-webhook-control` returns `body.status` and `body.evidence` verbatim from an operator-configured URL. So a `webhook-control` binding pointed at an endpoint answering `{"status":"pass","evidence":{…digestMatch:true, artifactDigest:<the promoted digest>…}}` deposits exactly the row below — and while E6 identified a scan outcome by the SHAPE of its evidence, that row satisfied the boundary gate in full. A control binding is authored at `policy:write` SCOPED AT A CONTROL OBJECT (routes/governance.ts), which is strictly weaker than the operator authority that sets the instance floors ADR-0016 §3 makes tenant-unwritable precisely so a tenant cannot loosen them.

THE TWO HALVES DIFFER IN ONE FIELD. Same change shape, same digest, byte-identical evidence — only `plugin_module` differs. That is what makes this a test of the admission rule and not of something incidental about the fixture.

### §204. The gate used to accept ANY historical passing row, forever

The gate used to accept ANY historical passing row, forever: `controlOutcomes.some(...)` with no ordering. A re-scan that FAILED — new CVEs, a tightened ceiling, an expired ADR-0033 grant — did not supersede it, so an artifact stayed authorized to cross on a verdict that no longer held. Both directions are asserted, because only the pair pins "latest wins": objecting-only supersession would make every re-evaluation a one-way ratchet and leave a fixed artifact permanently blocked.

### §205. M18 (ADR-0018) — THE LEAKAGE TEST

M18 (ADR-0018) — THE LEAKAGE TEST. Domain-local dev/beta pipelines are exempt from the E6 scan gate ONLY because they never reach `exportPromotionBundle` (no peer target) — the exemption is a property of the PATH, never a per-artifact tag (ADR-0018 §1). This proves the two guarantees the ADR promises: (1) a dev-built digest that IS later promoted to a peer is REFUSED at E6 exactly like any other unscanned artifact, with a block Decision + decision_id hash-chained into the audit log in the same transaction — the "exemption" does not follow the artifact across a boundary (ADR-0018 §2); and (2) an operator-style dev/local classification label is INERT for enforcement — forging or removing it changes NO gate outcome, because `evaluatePromotionScanGate` has exactly two pure inputs (substantive artifacts + control-run scan outcomes) and reads no classification/origin field at all (ADR-0018 §4).

### §206. Stuff a plausible operator-label shape

Stuff a plausible operator-label shape (ADR-0018 §4 / ADR-0030 §2) directly onto the change's sourceRef — the most literal "forge the label onto a boundary-crossing artifact" a caller could attempt. The gate must ignore it. The REAL declared column (`source_mappings. classification`, migration 0057) is covered separately below; this case keeps the forged-shape axis, which is the one an attacker actually controls.

### §207. Byte-identical refusal reason to the UNLABELED case

Byte-identical refusal reason to the UNLABELED case — the forged label contributed nothing to the gate's evaluation.

The baseline is now PRODUCED rather than quoted. This assertion used to be `toBe(<the exact sentence>)`, which made it a test of the gate's prose: it went red on a gate change that never touched label handling, and it would have stayed green if the unlabeled case had started refusing for some *different* reason that happened to keep the same words. What the case is about is that the two refusals AGREE, so it exports the unlabeled one and compares.

### §208. Correction: an earlier version of this comment overclaimed

CORRECTION (2026-08-01): an earlier version of this comment also claimed the label "never enters the checksum payload". IT DOES — `promotionChecksumPayload` includes `change` wholesale, and the label lives in `change.sourceRef`. That was a false statement sitting next to true assertions, which is the most durable kind of wrong comment, so it is pinned here as a fact rather than deleted.

It is not a defect: ADR-0018 §4 permits DESCRIPTIVE labels, and being inside the checksum is the SAFE direction — it means a label cannot be altered in flight without invalidating the signature. Inertness is about what the GATE reads, not about what is covered by integrity protection. The two assertions above, plus the refusal case in the test before this one, are what actually establish it.

### §209. ADR-0030 §3, the clause this milestone turns on

ADR-0030 §3, the clause this milestone turns on. The previous case forges a label onto a sourceRef; this one uses the GENUINE declared surface — a `source_mappings` row with `classification: 'dev'` and `ref_pattern: 'refs/heads/dev'`, written exactly as an operator writes it — and proves E6 does not read it.

The three-way comparison is the point. Refusing once proves little on its own; what proves INERTNESS is that the refusal is BYTE-IDENTICAL with the label present, with it cleared, and with no mapping at all. If `classification` ever became a gate input, exactly one of these three would diverge.

WHAT THIS IS MUTATION-PROVEN AGAINST, precisely — because the difference matters. Making the gate honour a dev-branch ORIGIN (`sourceRef.ref` containing "dev" ⇒ pass), which is the rejected alternative in ADR-0018 and the literal reading of the branch-grants-the-exemption direction, REDS this case and nothing else in the file. That is the hazard it exists to catch.

The mapping-presence axis is weaker and is NOT claimed as mutation-proven: the change here is built directly by `proposeApprovedChangeInA` rather than correlated FROM this mapping, so the row establishes "a dev-classified mapping exists in the org" rather than "this change came from one". Closing that gap needs a correlation-driven fixture — worth doing when a classification-consuming code path exists to justify it; today none does.

### §210. Corrected later, and the correction is the interesting part

CORRECTED 2026-08-17, and the correction is the interesting part.

This case used to assert that "E6 never reads scan_requirement_floors — a completely different mechanism from the E6 boundary gate", and it stayed GREEN through the change that made that sentence false, because every fixture it exercises reports ZERO findings and zero breaches no ceiling. A test that cannot distinguish the property it names from the property it happens to exercise is a test of the fixture. What it genuinely established is the LABEL-INERTNESS half — the floor neither exempts an unscanned artifact nor blocks a clean one — and that half is unchanged and kept below, now beside the case that tells the two apart.

WHY THE GATE READS THE FLOOR NOW. The four org-and-below tiers of ADR-0016's chain are tenant-authored policy data, and `scan-result-control` will fall back to a tenant-authored per-binding `config.threshold` when the gate threads no scoped ceiling — so "the control said pass" can mean "pass against a ceiling the beneficiary wrote". The two ABOVE-org tiers are different in kind: `scan_requirement_floors` is operator-write / tenant-read precisely so no tenant can loosen it, and E6 is the operator's boundary. Those, and only those, are re-checked here. The six-tier resolution is deliberately NOT re-run (see `scan-evidence.ts`).

### §211. The exporter's own read-only re-check of scan coverage

B's E6 re-check (the exporter's OWN predicate, read-only — `evaluateScanCoverage`): `not_run` with no scan evidence at B; ONE passing, digest-bound scan of the IMAGE from an ADMITTED producer (`scan-result-control` — the module NAMES the producer, it is not fixture decoration, see `seedScanOutcome`) makes it `pass` — a re-export from B would not be refused over the SBOM blob's digest, which was never a substantive artifact.

### §212. Receiver-side verification of the signed promotion manifest

M17.4(a) / M15.2 — RECEIVER-side verification of the commander's cosign-signed promotion manifest at bundle import (the OUTPOST's universal pre-deploy validation, ADR-0011). ONE gate runs at every receiving hop; the outpost NEVER re-scans — receiver-side never-re-scan is UNCHANGED; the one scan now executes at the commander before signing, per promotion journey (ADR-0020). Fail-closed over signature + set-equality + the tie + self-binding + a downgrade defense. Part-(b) (per-artifact BYTE verify where the operator-loaded bytes land) runs later as the PRE-DEPLOY gate — see coordination/pre-deploy-gate.integration.test.ts; byte TRANSPORT itself remains M15.5.

### §213. Filtered to THIS anchor's id, not counted globally

Filtered to THIS anchor's id, not counted globally — this describe block's shared commander/outpostWithKey pair means the ordinary sync step above also carries every OTHER still-unsynced commander-minted artifact from earlier `it()`s in this suite, each of which may ALSO collide with its own already-imported anchor and adopt (correctly) — this assertion is about THIS digest's anchor specifically.

### §214. M14.1 — per-peer poke-mode flag

M14.1 — per-peer poke-mode flag (ADR-0009; proposal docs/proposals/outpost-poke.md §Config). Default-off, tri-state on re-pair (mirrors deliveryTarget), and the pair-time transport-identity guard: setting poke-mode TRUE requires an https/mTLS-capable peer baseUrl (full endpoint enforcement is M14.2 — here we prove the EARLY pair-time refusal).

### §215. The guard must validate the effective post-write state

M14.3 HARDENING — the guard must validate the EFFECTIVE POST-WRITE state, not the input transition. baseUrl and pokeMode MERGE with OPPOSITE rules on re-pair (baseUrl: request wins when present; pokeMode: tri-state, EXISTING wins when absent), so a guard keyed off `input.pokeMode === true` checked a DIFFERENT tuple than the one actually persisted.

### §216. Status must report the cadence the scheduler actually uses

M14.4 fix (N5) — `GET /federation/status` must report the cadence the SCHEDULER is actually running, in the one case where the two used to disagree.

The status endpoint was added in M14.4 precisely so an operator could SEE cadence divergence, but it derived `hasClientCerts` from the CHEAP PRESENCE CHECK (`federationClientMtlsConfigured` — are the env paths set?) while the scheduler derives it from the never-throwing RUNTIME PROBE (did the material actually READ off disk?). Those answers differ in exactly the situation owner decision D4 exists for: `SCP_FEDERATION_MTLS_CERT_FILE`/`_KEY_FILE` still set, the mounted secret rotated away. The scheduler correctly falls back to the FREQUENT cadence and warns; the endpoint reported `effectiveCadence: 'poke'` — the operator-facing view saying the exact opposite of what the process was doing. Both now call the same probe, so they agree by construction.

## `apps/server/src/federation/foreign-origin-writes.integration.test.ts`

### §217. What the server actually refuses on a foreign-origin object

M16.3 P2 (REMEASURED) — WHAT THE SERVER ACTUALLY REFUSES ON A FOREIGN-ORIGIN OBJECT.

THE DEFECT THIS FILE EXISTS TO PREVENT: the first cut of `apps/web/src/lib/replica-origin.tsx` disabled a set of UI write controls on the grounds — stated only in a source comment, never measured — that "the server refuses this write on a read-only replica regardless." For half of those controls that claim was simply FALSE: `routes/executors.ts`'s DELETE/PATCH/PUT `/executors/:idOrUrn/binding` authorize `object:write` on the target and never look at the target's `originDomainId` at all (`executor_bindings` has no `origin_domain_id` column — `db/schema.ts` — because a binding is per-org, per-target LOCAL config, not federation-replicated state). Disabling those controls broke the documented multi-region workflow (DESIGN.md §12.6, BUILD_AND_TEST.md M15.6: "a region is a deployment-target ... its per-region Argo CD is an ordinary per-region executor binding") — an outpost binding its OWN local Argo CD to a target that is commander-origin from the outpost's point of view is exactly the intended case.

So: this file MEASURES each write the SPA offers against a genuinely foreign-origin object and pins the ACTUAL response. Every `disabled`/`title` gate that survives in `apps/web/src/lib/replica-origin.tsx` and its callers cites a test HERE by name; a gate with no test here is a gate that must not exist.

PR #152 REVIEW FIX (E1), NOW SUPERSEDED BY S10 (PR #171): this block originally only measured accept/rollback against a foreign-origin change sitting in `proposed` — a state neither verb is even legal from (both answer the ordinary wrong-state 409 there, so the arms were indistinguishable from a broken fixture). E1 therefore extended the suite with a real reconcile loop (`withReconcileLoop`/`withEventRelay` below) to drive a foreign-origin change all the way to `validating` and measure accept/rollback SUCCEEDING there.

THOSE TWO TESTS NO LONGER EXIST, and the paths they measured are gone in both directions: the transition verbs are now refused on authority BEFORE any state check (so `proposed` vs `validating` no longer distinguishes them), and the reconcile engine SKIPS a foreign-origin change, so it can never reach `validating` in the first place. The reconcile loop stays enabled because the engine-skip and resume tests at the end of this file need a genuinely running engine. Do not go looking for "accept SUCCEEDS ... from 'validating'" — an earlier version of this comment pointed at it after it had been deleted.

HOW "GENUINELY FOREIGN" IS BUILT: `createObject`/`createRelationship` with a `federationImport` context — the exact, and only, code path `federation/import-repo.ts` uses to land a peer's row after signature/chain verification (`graph/objects-repo.ts`'s `FederationImportContext` doc: "the ONLY way createObject/updateObject/deleteObject will accept/preserve a foreign originDomainId"). The resulting rows are byte-identical to what a real inbound bundle produces, so the guards under test see exactly the production condition.

### §218. Positive controls: the fixture really is foreign

POSITIVE CONTROLS — the fixture really is foreign, and the single-writer guard really does bite where it exists (`graph/objects-repo.ts`'s updateObject/deleteObject). Without these two, every "the server allowed it" result below would be indistinguishable from a broken fixture.

### §219. EXECUTOR BINDINGS — `registry-detail.tsx`'s TargetBindingsCard

EXECUTOR BINDINGS — `registry-detail.tsx`'s TargetBindingsCard (Detach / Repurpose) and `plugins.tsx`'s bind form. MEASURED RESULT: the server ACCEPTS all three on a foreign-origin target. A binding is local operational config keyed by (org, target, type); it carries no origin domain and is never federation-replicated, so single-writer authority has nothing to say about it. THIS IS THE MULTI-REGION WORKFLOW (DESIGN.md §12.6) — the UI must not disable these.

### §220. COMPONENT MERGE — `registry-detail.tsx`'s MergeComponentCard

COMPONENT MERGE — `registry-detail.tsx`'s MergeComponentCard. MEASURED RESULT: the SURVIVOR's origin is irrelevant (the only writes against it are `repointExecutorBindingTarget`, an unguarded UPDATE of `executor_bindings.target_object_id`); the LOSER's origin is decisive (`mergeComponents` soft-deletes it via `deleteObject`, which IS single-writer guarded).

### §221. COMPONENT -> SERVICE

COMPONENT -> SERVICE — `registry-detail.tsx`'s ComponentServiceCard (Assign / Move). MEASURED RESULT: what decides the outcome is the ORIGIN OF THE `contains` EDGE BEING DELETED, never the origin of the component or of either service. ASSIGN (no existing edge) is a pure `createRelationship`, which stamps THIS domain as the edge's author and never consults the endpoints' origins — it succeeds on a foreign-origin component.

### §222. The change lifecycle verbs on a foreign-origin change

CHANGE LIFECYCLE — `change-detail.tsx`'s Accept / Rollback / Cancel. A `Change` has no live federation path that produces a foreign `originDomainId` today (`import-repo.ts` never creates a local `changes` state-machine row for a synced change object, and `promotion-repo.ts` calls `proposeChange` FRESH so control genuinely transfers) — so the fixture below flips the change object's `origin_domain_id` directly, which is the exact row state a future replication path would produce.

S10 (`tracked-security-followups`'s "CHANGE TRANSITIONS BYPASS THE SINGLE-WRITER GUARD"): MEASURED RESULT NOW FLIPPED. `coordination/transition.ts`'s `transitionChange` and `coordination/rollback.ts`'s `triggerRollback` — the ONLY writers of `changes.state` and the only initiators of a rollback — now check `enforceLocalChangeAuthority` FIRST, before any state-machine/gate logic, keyed on the change object's `originDomainId` (never `importedFromDomain` — see that function's doc comment). Every operator-initiated verb below is refused with a 409 + `decision_id` on a foreign-origin change, in EVERY state, including `proposed` where the un-guarded state machine would otherwise have refused for an unrelated reason (illegal edge) — the authority check masks that reason now, which is itself part of what the tests below pin.

### §223. S10 ENGINE-SIDE SKIP

S10 ENGINE-SIDE SKIP — the reconcile engine (coordination/reconcile.ts) now filters a foreign-origin change out of every advance* candidate batch BEFORE ever attempting a transition, so it SKIPS such a change rather than driving it (and rather than parking/ blocking it, which would wedge it in a Decision-flood nothing could ever resolve). Before S10 this test drove a foreign-origin change all the way to `validating` via the real reconcile loop and measured accept/rollback SUCCEEDING there — that path no longer exists BY CONSTRUCTION: `advanceProposedChanges` never even attempts the `proposed -> evaluated` edge for it, so it can never leave `proposed` at all.

### §224. The foreign-origin change was never touched by the engine

The foreign-origin change was never touched by the engine: state unchanged, and the ONLY Decision on record is `proposeChange`'s own `trigger: "propose"` one — unlike a genuine proposed->evaluated attempt, which would add a SECOND Decision on its very first tick, a skip adds nothing at all (a block/park would also have added one, just a `block`-verdict one instead — this distinguishes "skipped" from either "advanced" or "blocked").

### §225. THE WHOLE POINT OF "SKIP RATHER THAN PARK"

THE WHOLE POINT OF "SKIP RATHER THAN PARK" (S10; `enforceLocalChangeAuthority`'s doc comment: "parking would wedge a change nothing can ever resume"). The test above proves the engine does not DRIVE a foreign-origin change. On its own that is equally consistent with the engine having PARKED it — a state that looks identical from outside until someone tries to resume. This test is the other half, and it is the one that fails if a future refactor "helpfully" blocks/parks instead of filtering: authority returns to this domain, and the change advances with NO operator intervention, NO park to clear, NO re-proposal.

## `apps/server/src/federation/freeze-federation.integration.test.ts`

### §226. An org-tier freeze declared at the commander blocks below

M25.7 (owner decision D6, ADR-0043) — AN ORG-TIER FREEZE DECLARED AT THE COMMANDER BLOCKS AT THE OUTPOST. AND THE FOUR CONTROLS WITHOUT WHICH THAT SENTENCE IS CHEAP.

THIS INCREMENT RETRACTS A DELIBERATE, TESTED ABSENCE. Until 2026-08-24 no freeze could cross a boundary at all: a freeze was a projection row with no graph object, `JournalEntryKindSchema` carries nine kinds and none is freeze-shaped, `coordination/service-board-precedence.integration. test.ts` pinned the absence, and `apps/web/src/routes/outpost-configuration.tsx` explained it to operators verbatim. D6 overturns it for the ORG TIER ONLY.

Run on the real two-database harness (`test-support/isolated-domain.ts` — two separate Postgres DATABASES, because federation import preserves an object's id VERBATIM and two orgs sharing one physical `objects` table would collide on a primary key no real deployment can), through the real export -> verify -> import path, exactly as `outpost-config-sync.integration.test.ts` does for ADR-0022's `outpost` object. No new harness: the point of choosing a graph object is that there is no freeze-specific transport to test.

THE ASSERTION IS ADMISSION, NOT ROW EXISTENCE
A `freezes` row at the outpost proves replication and nothing else. What D6 asked for is that the freeze STOPS SOMETHING, so case B drives `coordination/freeze-hold.ts`'s `evaluateFreezeHolds` — the predicate `reconcile.ts`'s per-target `continue` actually reads before triggering a wave target — and asserts the replicated component is HELD, naming the commander's freeze id.

THE CONTROLS, AND WHY EACH ONE EXISTS
- CASE D — a freeze authored WITHOUT `federate` appears in NO bundle entry and produces NO row at the outpost. Without this, "it federates" is satisfied by a change that federates EVERYTHING, which is both the wrong feature and a confidentiality regression. - CASE E — a PLATFORM-tier freeze still does not federate. The sync journal is org-scoped at every layer and `instance_freezes` has no `org_id`; ADR-0040 and GLOSSARY both say so and both must stay true after this increment. - CASE C — re-importing the same bundle converges. `ON CONFLICT (id) DO UPDATE` on a key that is the ORIGIN's freeze id is the whole idempotency argument; a duplicate row would double every hold and make the second one un-liftable from anywhere. - CASE F — the outpost cannot LIFT or SHORTEN the commander's freeze, through either write verb or through the raw graph write path. A guard on `objects` alone would leave `freezes.lifted_at` — the column the window predicate actually filters on — locally writable. - CASE G — an outpost-declared `domainLocal` freeze never travels (ADR-0031).

NO FIXED SLEEPS ANYWHERE (`integration-sleep-census.test.ts` is a CI gate). Nothing here is asynchronous in the wall-clock sense: every step is a transaction this test drives itself, and the one clock-sensitive predicate (`evaluateFreezeHolds`) takes an injectable `now`.

## `apps/server/src/federation/handfill-object-write-authority.integration.test.ts`

### §227. `federation:write` IS NOT A GRAPH-WRITE PERMISSION

`federation:write` IS NOT A GRAPH-WRITE PERMISSION — THE HAND-FILL DOOR

THE PROPERTY. `federation:write` operates the federation LINK: pair a peer, export a bundle, import one, poke. `object:write` authors the ESTATE. A door that writes a graph object while demanding only the former has silently merged the two, and every role built on the split becomes a lie. `POST /api/v1/federation/hand-fill` was exactly that door: `routes/federation.ts` authorizes `{permission: 'federation:write', scopeObjectId: auth.orgId}` and nothing else, and `federation/handfill-repo.ts` then takes a free-form `typeId`, `urn`, `name`, `properties` and `labels`. Its four preceding refusals are narrow — pair-bound (`placement`), peer-bound naming a foreign domain (`outpost`), projection-bound (`freeze`), and governance-managed (`policy`, `control`, ... , which take `policy:write`) — so EVERY OTHER REGISTERED TYPE, `service` and `component` and `change` included, landed on `federation:write` alone.

THE ACTOR THAT MAKES IT LIVE, and why the M21.7 coincidence argument does not cover this. A `FederationAdmin` role holds `federation:read` + `federation:write` and DELIBERATELY withholds `object:write`, on the invariant "a federation administrator operates the link, it does not edit the estate". M21.7's sibling hole (`policy` through the same door) was latent because `federation:write` and `policy:write` both land on Administrator and Owner and nowhere else — an accident between two migrations. This one is not an accident: the role is being written to hold one permission and not the other on purpose, so a role that exists to be safe was the exploit.

MEASURED before the fix, over HTTP, with the `federationOnly` actor below: `POST /api/v1/federation/hand-fill {typeId: "service", ...}` answered **201** with a live row in `objects`, from a subject holding `object:write` NOWHERE.

WHAT THIS FILE ASSERTS
1. THE REFUSAL, over the whole reachable type set rather than over `service` alone — computed from the live `object_types` registry minus the four classes hand-fill already refuses for other reasons, so a type registered tomorrow is covered without editing this file. Per-type cases are how the sibling hole survived a green suite. 2. THE CONTROL — an actor with BOTH permissions still lands the row, so (1) is not satisfied by a hand-fill route that is broken for everyone. 3. THE SHADOW-COPY PROPERTY did not regress: the row that lands is still authored by `FEDERATION_IMPORT_ACTOR_ID` with `provenance: 'manual'` and `revision: 0`, which is the entire reconciliation mechanism (`handfill-repo.ts` module doc). The new bar is AUTHORIZATION ONLY; if a later change "tidies" it by passing the requesting subject to the upsert, the next signed bundle stops reconciling over the shadow and this case goes red. 4. NO REGRESSION in the four refusals that already existed — driven by the BOTH-permissions actor on purpose, so each one is measured to still fire on its own reason rather than being masked by the new `object:write` 403 in front of it.

MUTATION RUN (2026-08-25). MEASURED, not predicted.
```text
M-1  DELETE the `await assertObjectWriteAuthorityForHandFill(tx, input)` call from
     `handFillObject`
       -> 1 failed | 2 passed. "a FederationAdmin (federation:write, no object:write) cannot
          author estate objects through hand-fill" went red on
          `AssertionError: assembly: {"id":"01a03935-...","typeId":"assembly",...,
          "revision":0,"provenance":"manual",...}: expected 201 to be 403` — the loop's first
          type alphabetically, with the row LIVE in `objects` and stamped as a shadow copy, i.e.
          a subject holding `object:write` nowhere had authored an estate object.
          THE OTHER TWO CASES STAYED GREEN, which is the measured point of case 4: the four
          pre-existing refusals never depended on this bar, so the new bar is not what makes
          them pass and they are not what makes it pass.
```

### §228. A real paired peer, not fixture noise

A REAL, PAIRED commander peer, and it is load-bearing rather than fixture noise.

`handFillObject` runs every refusal BEFORE `getPeerByIdOrName`, so with a peer that does not exist each refusal case would still see its 403 — but the "nothing was written" half would be VACUOUS (the write was unreachable whatever the guard did) and unwiring the guard would turn the case red with a 404 about the peer rather than letting the row land. With a real peer the only thing between the request and a live row is the bar under test.

### §229. The FederationAdmin under test

The FederationAdmin under test: `federation:write` and NOTHING that writes the graph.

Built through `roles.org_id` (the org-defined-role mechanism) because no BUILT-IN role can express it — `drizzle/0012` puts `federation:write` on Administrator and Owner, and `drizzle/0002` puts `object:write` on both of those plus Operator and Approver, so every built-in holder of one holds the other. Testing against the role table's current accident would measure nothing.

Viewer is bound purely so the harness mints an auth row and a live token; `object:read` is no part of what is under test and grants no write anywhere.

### §230. Every type this door will write, computed not listed

EVERY registered type this door will actually try to write, computed rather than listed.

The four exclusions are the classes hand-fill refuses for reasons that are NOT this bar — a pair-bound `placement`, a peer-bound `outpost` naming a foreign domain, a projection-bound `freeze`, and the governance-managed set that takes `policy:write`. Including them would make the loop green on refusals that already existed, which is precisely the vacuous shape this file is written against: the 403 would be real and would say nothing about `object:write`.

### §231. Without this, a door that refuses everyone would pass

Without this the case above is satisfied by a hand-fill route that refuses everyone — which would delete DESIGN §13's reason for the feature (an air-gapped outpost with no bundle transport keying a commander-origin object in by hand).

The provenance assertions are not decoration. The bar added above is AUTHORIZATION ONLY: the row must still be written as `FEDERATION_IMPORT_ACTOR_ID` with `provenance: 'manual'` and `revision: 0`, because that is what makes ANY later real import (always `revision >= 1`, always `provenance: null`) win the single-writer comparison and reconcile over the shadow. Handing the requesting subject to `upsertObjectByUrn` instead would look like a tidy-up and would silently break reconciliation forever.

### §232. Driven by the ADMINISTRATOR

Driven by the ADMINISTRATOR — who holds `object:write` and therefore passes the new bar — on purpose. Driven by the federation-only actor these would all be green off the new 403 alone, and the file would claim coverage it does not have: the risk of adding a broad permission bar is that it MASKS the narrow refusals in front of it, turning four measured guards into one.

The `object:write` bar is ordered LAST in `handFillObject` for exactly this reason, and these three assertions are what holds that ordering in place.

## `apps/server/src/federation/handfill-repo.ts`

### §233. Hand-fill for air-gapped outposts with no transport

Hand-fill for air-gapped outposts with no bundle transport at all (DESIGN.md §13): "manually entered commander-origin objects are stored as `provenance: manual` shadow copies, flagged as unverified in API and UI, and reconciled (confirmed or replaced) the next time a signed bundle arrives."

Reconciliation happens FOR FREE through the exact same single-writer-authority machinery a real import uses (graph/objects-repo.ts): a hand-filled row is created here with `federationImport: { originDomainId: <claimed commander's id>, revision: 0, provenance: 'manual' }` — revision 0 so ANY later real import (which always carries `revision >= 1`) is guaranteed to be treated as newer and overwrite it, and `originDomainId` already matches the peer the operator claimed it came from, so the single-writer authority check in `updateObject` passes and the `provenance` column naturally clears to `null` on that overwrite (a real, cryptographically verified update always passes `provenance: null`). No separate "reconcile" code path exists because none is needed — this IS the reconciliation mechanism, just invoked implicitly by the next ordinary import.

### §234. The REAL requesting subject, for authorization only

The REAL requesting subject, for authorization only — NEVER the write's author. The row is still written as `FEDERATION_IMPORT_ACTOR_ID` with `provenance: 'manual'`, which is what makes the reconciliation above work, and what makes the row look like a replica.

Required rather than optional so a new caller has to decide. THREE authorization checks below resolve this subject, and all three are broken by a defaultable or synthetic value: `assertObjectWriteAuthorityForHandFill` (the estate-authoring bar every hand-fill clears), `assertGovernanceAuthorityForHandFill` (M21.7) and `assertMayWriteGovernanceLabels`. The synthetic import actor has no `objects` row and therefore no role bindings, so resolving IT would answer "no permission" for everyone — which reads as fail-closed and is really an authorization check that has stopped depending on who is asking, the exact shape `federation/domain-local.ts` warns about ("inventing a synthetic subject for those callers, which is how an authorization check quietly becomes a no-op", in the opposite direction). An authorization check with a defaultable subject is one rename away from a no-op.

### §235. The fifth local write door, and its own narrowing

THE FIFTH LOCAL WRITE DOOR, AND WHY IT NEEDS ITS OWN NARROWING (M16.2 phase A, review round 4).

`handFillObject` is a free-form-`typeId` write door reachable by any operator holding `federation:write` AND org-root `object:write` (`assertObjectWriteAuthorityForHandFill` below — it was `federation:write` alone until that guard landed), and it stamps `federationImport`. That flag is what makes `graph/objects-repo.ts`'s peer-binding choke point SKIP — a skip whose whole justification is "a replica's `peerDomainId` names the RECEIVING instance's own domain, which is never one of its peers". That is true of the OUTPOST-side use and FALSE of the COMMANDER-side one, where the operator supplies `properties.peerDomainId` freely. With the blanket skip, hand-fill bypassed all three clause-(4) refusals: it accepted an UNPAIRED `peerDomainId`, a `commander`-role peer (whose tier `GET /v1/federation/status` then reported), and a SECOND live `outpost` object for a peer that already had a legitimate one — which then made the commander's own `PATCH /v1/federation/outposts/{peer}` 409 forever.

THE NARROWING, and why it is a self-comparison rather than the full guard. Applying `assertOutpostPeerBinding` to every `federationImport` write is NOT safe: a genuine sync bundle can legitimately carry the `outpost` object of a DIFFERENT outpost (commander → outpost A, full scope, carrying outpost B's config), whose `peerDomainId` is not a peer of the receiver — refusing it would abort the whole bundle (the fail-closed version-skew class this same review round fixed for `additionalProperties`). So the JOURNAL path keeps the skip, and the narrowing lives HERE, at the one other `federationImport` caller: a hand-filled peer-bound object may name ONLY this instance's own `federation_self.domainId` — exactly the shape a real replica has, and the only shape the skip's justification actually covers. Anything else is a commander-side claim about one of its peers, which has a real door (`POST /v1/federation/outposts`) that enforces the binding.

CENSUS (kept filterless on purpose): `federationImport` is supplied in exactly two modules — `federation/import-repo.ts` (signature/chain-verified journal replay) and this one. There is no third.

### §236. Pair-bound types: the fifth door of that census

PAIR-BOUND TYPES — THE FIFTH DOOR OF `graph/pair-bound-types.ts`'s CENSUS (2026-08-18).

A `placement` is identified by a PAIR of objects, and every free-form-`typeId` door refuses it for the reason that file records: this door takes free-form `properties`, so it would store two unresolved, untyped UUIDs and — decisively — write NEITHER derived edge (`places`, `placed_at`), leaving an island no traversal can reach. Hand-fill was the one free-form-`typeId` door the census had not listed, and it had a SECOND hole the other four do not: a placement is CONTAINED by both endpoints it names (containment routes 3 and 4, `graph/containment.ts` `placementParentsSql`), and the depth door for that pair lives ONLY in `graph/placements-repo.ts`'s `createPlacement`, which this path never reaches. MEASURED on the pre-fix tree through the HTTP API: `POST /federation/hand-fill {typeId: "placement", properties: {componentId: <a component at hop ten>, deploymentTargetId: <root target>}}` answered 201 where `POST /placements` of the same pair answered the door's 400, and `containmentChain` of the hand-filled row then threw ADR-0037's 409 — a live placement no policy, freeze or gate could scope, readable through its one-hop `domain_id` route (hand-fill passes no `domainId`, so `createObject`'s org-root shortcut skips D1 too).

WHY REFUSE THE TYPE rather than run the pair arithmetic here: the arithmetic alone would leave the edgeless island the four sibling doors already refuse, and a hand-filled placement has no reconciliation story that needs it — a real bundle carries a placement as its own `object_upsert` PLUS `relationship_upsert` entries, so nothing an operator could key in here is a shape the next signed bundle would confirm. The `federationImport` carve-out this door wears is a statement about a CHANNEL that cannot absorb a refusal (see `handFillObject` below); this is a local operator's per-request POST, and its failure mode is one 403 to that operator.

### §237. M21.7 (ADR-0032 §6a census amendment)

M21.7 (ADR-0032 §6a census amendment) — THE `policy:write` HALF OF THE SAME PROBLEM, CLOSED BEFORE IT WAS REACHABLE RATHER THAN AFTER.

The filterless census of free-form-`typeId` write doors (recorded in `governance/governance-managed-write-doors.integration.test.ts`) found five, and this is the fifth. The other four are decided: `/objects/{type}` and `/discovery/accept` refuse the governance types outright, `POST /plans` + apply and `POST /federation/overlays` demand `policy:write`. This one demanded only `federation:write` and would have written a `policy` row for anyone holding it.

THIS ONE WAS NOT A LIVE ESCALATION, AND THAT IS EXACTLY WHY IT NEEDED CLOSING. Measured on the built-in role set: `federation:write` is granted to Administrator and Owner (`drizzle/0012_federation.sql:218-219`) and `policy:write` to Administrator and Owner (`drizzle/0010_governance.sql:174-175`) — the same two roles, and the route authorizes `federation:write` at the ORG ROOT, where an Administrator's `policy:write` also sits. So no actor reachable through today's API could use this. The safety was a COINCIDENCE between two independent grant lists in two independent migrations, held in place by nothing: `roles.org_id` exists for org-defined roles and `authz/resolve.ts` resolves permissions by list membership, so one custom role with `federation:write` and no `policy:write` turns the coincidence into the overlay hole again. The whole lesson of this milestone is that the door which is fine today because of a fact stated somewhere else is the door the next census misses.

A PERMISSION CHECK, NOT A TYPE REFUSAL — the overlay treatment, not the discovery one. Hand-fill's REASON FOR EXISTING (DESIGN §13) is an air-gapped outpost with no bundle transport keying in a commander-origin object by hand, and a commander-distributed global policy is squarely that. So `policy` must keep working here; what changes is who may do it. Bar is org-root `policy:write`, matching `federation/overlay-repo.ts`: hand-fill passes no `domainId`, so the row lands at org-root containment, and `properties` is free-form, so an unscoped policy matching every target in the org is one of the documents this admits.

`input.actorObjectId` is the REAL subject and is used for nothing else. The write below still carries `FEDERATION_IMPORT_ACTOR_ID`, which is the provenance/single-writer machinery the module doc describes, and is precisely the synthetic subject an authorization check must never be handed.

### §238. Ahead of the permission check, which is wrong for this type

M25.7 — AHEAD OF THE PERMISSION CHECK, BECAUSE FOR THIS TYPE THE PERMISSION IS THE WRONG REMEDY. A `freeze` object is the wire half of a record whose enforcement half is a `freezes` row that only `POST /api/v1/freezes` writes. Hand-filling one would federate a freeze that does not exist at THIS instance and cannot be lifted at either end — here `DELETE /v1/freezes/{id}` finds no row, and at the peer, which does rebuild the row, `lockFreezeRow` refuses because the origin domain is foreign. The `policy:write` bar below would have admitted exactly that to any holder of org-root `policy:write` + `federation:write`, neither of which is `freeze:write`.

AND HAND-FILL'S OWN REASON FOR EXISTING DOES NOT REACH THIS TYPE. DESIGN §13's case is an air-gapped outpost keying in a commander-ORIGIN object by hand so a later signed bundle reconciles over it. A freeze hand-filled that way would be `provenance: 'manual'` with no projection row until the real bundle arrives — i.e. an inert object where an operator believes they installed a block — and the reconciling bundle would build the row itself anyway. The same "nothing an operator keys in here is a shape the next bundle would confirm" argument the pair-bound refusal above records.

### §239. This permission stops being a graph-write one at this door

`federation:write` STOPS BEING A GRAPH-WRITE PERMISSION AT THIS DOOR (owner decision, option (a): "added, never substituted").

THE HOLE. `POST /v1/federation/hand-fill` authorizes exactly one thing — `{permission: 'federation:write', scopeObjectId: auth.orgId}` (`routes/federation.ts`) — and then hands this function a free-form `typeId`, `urn`, `name`, `properties` and `labels`. The four type-level refusals that precede this one are narrow by construction: `assertHandFillableType` refuses pair-bound types (`placement`) and peer-bound types naming a foreign domain, and `assertGovernanceAuthorityForHandFill` refuses projection-bound types (`freeze`) and demands `policy:write` for governance-managed ones. Everything OUTSIDE those sets — `service`, `component`, `assembly`, `deployment-target`, `change`, `campaign`, `execution-system`, and every type an operator registers tomorrow — was admitted on `federation:write` alone, with `object:write` demanded NOWHERE in the request's path. The module doc above conceded exactly this in as many words ("takes a free-form typeId and free-form properties from any `federation:write` holder"), and a conceded hazard is a signal to sweep, not evidence it was handled.

WHY IT MATTERS NOW, and why the coincidence argument that saved the `policy` half does not save this one. A `FederationAdmin` role holds `federation:read` + `federation:write` and DELIBERATELY withholds `object:write`, on the stated invariant that "a federation administrator operates the link, it does not edit the estate". That invariant was FALSE at runtime and this door was ONE of the reasons — not the only one: one POST here authored an arbitrary `service`/`component`/`change` row in the estate. Unlike M21.7's `policy:write` case — where the hole was latent because `federation:write` and `policy:write` happen to land on the same two built-in roles — this role is being written to hold one permission and not the other on purpose, so the hole is reachable by design rather than by accident.

THIS CHANGE ALONE DID NOT RESTORE THE INVARIANT — a SECOND increment did, and both halves are needed. `federation:write` used to buy a two-step chain to estate write authority that never touches this door:

```text
1. `POST /api/v1/federation/peers` authorized exactly `{permission: 'federation:write',
   scopeObjectId: auth.orgId}` (`routes/federation.ts`) and takes the peer's Ed25519 `publicKey`
   VERBATIM FROM THE REQUEST BODY — so the holder could pair a peer against a keypair they
   generated themselves, i.e. install their own trust anchor.
2. `POST /api/v1/federation/imports` authorizes the same single permission, and `applyEntry`'s
   `object_upsert` branch then resolves ANY registered `typeId` through `upsertObjectByUrn`
   (`federation/import-repo.ts`) — so a bundle signed with that keypair verifies and lands
   arbitrary rows.
```

Pair-then-import was therefore estate write authority without `object:write` and without hand-fill. The import half legitimately carries carve-outs rather than bars — a throw there aborts a peer's WHOLE signed bundle and `inbox-loop.ts` re-fetches it forever, which is the wedge the unregistered-type skip above exists to prevent — so the second bar belonged at PAIRING, and that was escalated as a separate OWNER DECISION.

RULED AND BUILT (owner ruling D4, 2026-08-25): step 1 now ALSO demands `federation:pair` (`authz/resolve.ts`, drizzle/0094, `federation/federation-pair-authz.integration.test.ts`), which FederationAdmin is written to withhold. Import, export, status, outposts, resync and poke stay on `federation:write` so an established link keeps working. With this door's `object:write` bar and that one, "a federation administrator operates the link, it does not edit the estate" is a property the system has — but it is held up by TWO guards in two files, and removing either restores the hole by a different route.

ADDED, NEVER SUBSTITUTED. `federation:write` is still required at the route and is not weakened: hand-fill remains a federation act, and this is a SECOND, INDEPENDENT bar in exactly the shape `assertGovernanceAuthorityForHandFill` uses one function up, and the shape `routes/governance.ts` uses when it demands `federation:write` ON TOP of `freeze:write` for a federating freeze.

THE SCOPE IS THE ORG ROOT, AND THAT IS THE ROW'S REAL CONTAINMENT SCOPE — not a convenience. `handFillObject` passes NO `domainId` to `upsertObjectByUrn`, so on the create branch `graph/objects-repo.ts`'s `resolveContainmentParent(tx, orgId, undefined)` returns the org root object and the row is filed there. That is the same org-root shortcut `assertHandFillableType` records above (it is why a hand-filled row skipped the domain-local D1 check), and the org root object's id IS the org id (`auth/local-auth.ts` `ensureOrgRootObject`). So `scopeObjectId: input.orgId` names the object the row is genuinely contained by.

ON THE UPDATE BRANCH the bar is deliberately still the org root, and it is the STRICTER choice rather than the convenient one. A hand-fill of an EXISTING urn passes no `domainId` either, so `upsertObjectByUrn` keeps `existing.domainId`, which a prior signed import may have placed deep in a subtree. Checking THAT scope instead would be a strict WIDENING, not a refinement: `authz/resolve.ts`'s `scope_expand` walks UPWARD ONLY, so an org-root grant already satisfies a check at every descendant, while a subtree grant satisfies nothing at the root. Narrowing to the row's own scope would therefore hand a subtree-scoped `object:write` holder a write onto a signature-verified replica sitting inside their subtree — a row every other local door refuses outright (`upsertObjectByUrn`'s read-only-replica 409, which hand-fill bypasses precisely because it stamps `federationImport`). One bar, at the root, fails closed in both branches.

AUTHORIZATION ONLY — AUTHORSHIP IS UNTOUCHED. `input.actorObjectId` is the REAL requesting subject and is what this resolves; the ROW is still written as `FEDERATION_IMPORT_ACTOR_ID` with `provenance: 'manual'`, which is the whole reconciliation mechanism the module doc describes. If a later change "tidies" that by passing `actorObjectId` to the upsert, the next signed bundle stops reconciling over the shadow. And resolving the synthetic import actor HERE would be worse than no check at all: it has no `objects` row, so it has no bindings, so this would answer "no" for everyone and read as fail-closed while having stopped depending on who is asking.

ON THE SIBLING COMMENTS IN THIS FILE that describe the door as reachable by "any `federation:write` holder": read "and org-root `object:write`" into each of them from here on. None of those guards becomes unnecessary — every one of them is about whether the DOCUMENT is admissible (an unvalidated `security` bag, a self-decided scan-override grant, a delegated dependency update, a reserved governance label), and an `object:write` holder is precisely someone entitled to author estate documents, so a document-validity refusal is exactly as load-bearing against them.

### §240. The second check this door has to run for itself

ADR-0032 §6a — THE SECOND CHECK THIS DOOR HAS TO RUN FOR ITSELF, AND IT IS THE SAME REASON AS THE FIRST.

`graph/objects-repo.ts`'s `createObject`/`updateObject` refuse a group-scoped `dependencySubscription` opt-out at the one choke point every local write door funnels through — and, like the peer-binding guard above it, they SKIP that refusal when `federationImport` is set. That skip buys one specific thing: `federation/import-repo.ts`'s `object_upsert` branch has no try/catch, so a throw on the replay path aborts a whole signed bundle rather than one entry (proposal §10 Q6). It is a statement about a CHANNEL that cannot absorb a refusal, not about the data being trustworthy.

Hand-fill stamps `federationImport` and therefore inherits that skip, and here it is unearned for exactly the reason `assertHandFillableType` documents one function up: this is a LOCAL OPERATOR ACTION, not an arriving bundle. `POST /v1/federation/hand-fill` takes a free-form `typeId` and free-form `properties` from any holder of `federation:write` plus org-root `object:write` (`assertObjectWriteAuthorityForHandFill`), there is no chain to wedge and no transport to interrupt, and the operator is right there to read the 400. Left exempt, this route would be a one-request bypass of the whole clause — the same shape as the H1 hole, one guard later.

CENSUS (kept filterless on purpose, and RE-RUN for this change, not inherited): `federationImport` is supplied in exactly two modules — `federation/import-repo.ts` and this one. There is no third. The same census is recorded at `graph/objects-repo.ts`'s two call sites; both places state it because a census written down in only one of the two modules it constrains is a census that goes stale in the other.

Runs BEFORE the peer lookup, so a refused document costs nothing and cannot depend on which peer was named.

### §241. The component-declaration guard, in the same position

M22.5 (ADR-0033 §6) — the component-declaration guard is in the SAME position as the two below: hand-fill wears the `federationImport` flag that exempts the choke point, but it is a LOCAL operator action with no bundle to wedge, so the exemption does not apply to it and the guard is called here explicitly. Skipping it would hand every `federation:write` holder a door that writes an unvalidated `security` bag onto any component.

ORDERED AHEAD of `assertGovernanceAuthorityForHandFill` on purpose (the #249/#251 pattern): this refusal is synchronous and reads only the request, while the authority check walks containment in the database. A malformed declaration is rejected without paying for the walk.

### §242. The same door, the same closing, another guard

M22.6 (ADR-0033 §6a) — the same door, the same closing, another guard. Hand-fill wears the `federationImport` flag that exempts the choke point, and the exemption's reason (a throw aborts a peer's whole signed bundle) is a statement about a CHANNEL that does not exist here. Left exempt, `POST /v1/federation/hand-fill` would let any `federation:write` holder write `{status: "approved", expiresAt: "2099-…"}` onto a grant with no tier check, no Decision and no audit event — the exact bypass the guard exists to close, one door later.

Ordered ahead of the awaited label check below (the #249/#251 pattern): this refusal is synchronous and reads only the request, while `assertMayWriteGovernanceLabels` issues a lookup for the stored row and resolves a permission.

### §243. THE GOVERNANCE-LABEL NAMESPACE

THE GOVERNANCE-LABEL NAMESPACE — the third and fourth refusals this door has to run for itself, and it is the same reason as the first two. Hand-fill wears the `federationImport` flag that exempts `graph/objects-repo.ts`'s choke point, and here that exemption is unearned: this is a free-form-`typeId`, free-form-`labels` LOCAL operator action reachable by any `federation:write` holder, with no chain to wedge and no transport to interrupt. Left exempt, one request would both plant a selector-scoped policy keyed on an ordinary label AND stamp reserved governance labels without `policy:write` — the whole guard, bypassed at the same door that already had to close two others.

The permission check runs against the REQUESTING operator, never the synthetic `FEDERATION_IMPORT_ACTOR_ID` this function passes to `upsertObjectByUrn` — see `actorObjectId`.

### §244. WHY `assertPolicyScopeWithinAuthority` IS NOT ALSO CALLED HERE

WHY `assertPolicyScopeWithinAuthority` IS NOT ALSO CALLED HERE — measured, not assumed, and the same argument `federation/overlay-repo.ts` records for the sibling door.

An earlier draft of this change added it, on the reading that hand-fill was a door the check's three-site census had missed. That was true of the tree it was written against and is no longer true of this one: `assertGovernanceAuthorityForHandFill` above (M21.7) now refuses every governance-managed `typeId` unless the REQUESTING operator holds `policy:write` AT THE ORG ROOT. That is the same bar `assertPolicyScopeWithinAuthority`'s broadest branch (unscoped / selector / group) asks for, and its narrow `objectRef` branch asks for `policy:write` at-or-above one object, which an org-root grant satisfies because `authz/resolve.ts`'s `scope_expand` walks UPWARD. So by the time control reaches here the check can no longer refuse anything — and an inert authorization guard reads as coverage while providing none, which is strictly worse than its absence.

MEASURED: with the call added, deleting it again left the door's refusal test green (it was `assertGovernanceAuthorityForHandFill` throwing all along), which is the definition of a guard proved by nothing. The door's real coverage is `governance/governance-managed-write-doors.integration.test.ts` DOOR 5.

IF THAT PREMISE CHANGES, THIS COMES BACK: the argument rests entirely on the org-root bar above being org-root and covering `policy`. Narrow `assertGovernanceAuthorityForHandFill`'s scope or its type set and the scope check is load-bearing again.

NOT ADDRESSED HERE, and reported separately: this door still authorizes the WRITE itself with `federation:write` rather than the `policy:write` that `coordination-as-code/plans-repo.ts`'s `writePermissionFor` demands for the same types. Raising that bar is a new decision with its own blast radius (an air-gapped operator hand-filling commander governance config), not the completion of an existing one, so it belongs to the owner rather than to this change.

### §245. THE ESTATE-AUTHORING BAR

THE ESTATE-AUTHORING BAR — the last thing between this request and a row, and the ONLY refusal here that does not read `typeId` at all. See `assertObjectWriteAuthorityForHandFill`.

ORDERED LAST AMONG THE REFUSALS, which is the reverse of the #249/#251 cost argument and is deliberate. Every check above names the SPECIFIC thing wrong with the document — a pair-bound type, a foreign `peerDomainId`, a projection-backed `freeze`, a governance type needing `policy:write`, a self-decided grant, a reserved label — and those are the actionable 403s. This one is the broad "you may not author estate objects at all", and in FRONT it would MASK them: `governance-managed-write-doors.integration.test.ts` DOOR 5 drives a `federation:write`-only actor and asserts the refusal detail names `policy:write`, which is the claim that the governance bar is installed here. Answering that request with an `object:write` 403 instead would leave that case green while saying nothing about the guard it exists to prove — a test passing for a reason unrelated to its claim, which is this codebase's most-repeated defect.

Still ahead of the peer lookup and the write, so a refused request costs nothing, cannot depend on which peer was named, and stores nothing.

## `apps/server/src/federation/import-repo.ts`

### §246. `scp federation import`

`scp federation import` — the receiving side of the `.scpbundle` file transport (DESIGN.md §13). SECURITY-SENSITIVE (M6 PR body flag — every check here is fail-closed by construction: an exception aborts the whole caller transaction, applying nothing):

1. Bundle-level: the payload must hash to the claimed `checksum`, and `checksum` must verify against the EXPORTING peer's Ed25519 public key (resolved at the historical point in time the bundle claims to have been exported, honoring key rotation). 2. Chain-level: every entry from `cursor+1` onward must form a contiguous, correctly-signed hash chain continuing from the LAST entry this side actually applied (`sync_cursors`' `lastAppliedRowHash` — not just internal-to-this-bundle contiguity, which alone would let an attacker splice in a fabricated sub-chain at an arbitrary cursor). `verifyJournalChain` returning `valid: false` for ANY reason rejects the ENTIRE segment — no partial-prefix application. 3. Row-level (graph/objects-repo.ts, graph/relationships-repo.ts): single-writer authority is re-checked on every individual write via `FederationImportContext` — a bundle cannot make this domain apply a write claiming authorship of an object it doesn't already know belongs to the SAME origin domain the bundle is nominally from.

Import applies through the exact same repo functions the public API's write path uses (`upsertObjectByUrn`, `createRelationship`, ...) — DESIGN §6: "a federation bundle import is literally a replay of public-API writes that converges no matter how many times it is applied." This is also why import can never bypass local RLS/RBAC/tenancy: it runs inside the SAME `withTenantTx` as any other request, under the SAME `scp_app` role, so a bundle addressed to org A can only ever write org A's rows — there is no cross-org code path here at all.

### §247. The sentinel actor id for import-authored audit events

Well-known sentinel actor id for federation-import-authored audit events — no `objects` row backs it (audit_events.actor_id carries no FK constraint, by design — schema.ts). Distinct from any real user/service-account id so `scp audit verify`/UI can recognize "this action came from a federation import," not a masquerading human actor.

Must be a value `z.string().uuid()` actually accepts: Zod's UUID regex only special-cases the literal nil UUID (all zeros — already claimed by coordination/system-actor.ts's SYSTEM_ACTOR_ID) and the literal max UUID (all f's), rejecting any other non-RFC-4122 string including "…-00000000fed0" (found live: it 500'd GET /api/v1/audit-events' response schema the moment a federation-import-authored audit event existed). Use the max UUID as federation's sentinel.

### §248. The change id a status names, only when a real UUID

The change object id a `change_status` payload names, but ONLY when it is genuinely a UUID.

Load-bearing, not defensive noise: `federation_unattached_change_status.change_object_id` is a `uuid` column, and a malformed value would make the INSERT throw and poison the whole import transaction — turning "one unrecordable enrichment entry" into "this peer's entire bundle is rejected", a strictly worse outcome than the drop this record exists to stop. Payloads are `z.record(z.string(), z.unknown())`, so nothing upstream guarantees the shape.

### §249. The `change_status` enrichment's object lookup with case (a)

The `change_status` enrichment's object lookup with case (a) — "this domain holds no replica of the object the entry names" — separated from every other failure: returns null rather than throwing, so the caller's best-effort catch covers only genuinely unexpected errors instead of collapsing the expected `status_only` shape and a real bug into one silent swallow.

### §250. Security-sensitive: single-writer authority was forgeable

SECURITY-SENSITIVE (M6 review fix — CRITICAL: single-writer authority was forgeable on CREATE). The ONLY domain a signed bundle may vouch authorship for is the domain that cryptographically SIGNED it (the verified `exporterDomainId`). M6 federation is direct-peer: there is no multi-hop relay of a third party's origin (that is the deferred reserved-fields path, DESIGN §13). So:

- The signed, hash-chained top-level `entry.originDomainId` MUST equal the exporter. A malicious but legitimately-paired peer X could otherwise sign an entry for a NEW urn claiming `originDomainId = <parent P>`; on the create path `createObject` would write that verbatim (the update-path 409 authority check only guards EXISTING rows), making the victim believe P authoritatively owns an object X forged — and an inflated `revision` would then permanently 409-block P's real future updates (a durable DoS on P's authority). - Any free-form `payload.originDomainId` (attacker-controlled) MUST be absent or equal the exporter — never trusted as the authority, never written.

Called on every entry BEFORE apply (including scope-skipped ones), so a bundle containing ANY forged-authorship entry is rejected wholesale, fail-closed.

### §251. Resolves an imported object's LOCAL containment placement

Resolves an imported object's LOCAL containment placement (`objects.domain_id`) — a genuinely separate concern from single-writer CONTENT authority (`originDomainId`), and one this milestone's own two-domain E2E surfaced the hard way: `authz/resolve.ts`'s RBAC containment walk assumes "every object's chain terminates at ITS OWN org's root" (that module's own doc comment). Preserving a foreign domain's `domainId` verbatim breaks that assumption the moment the referenced parent wasn't ALSO replicated (the common case — DESIGN §13 never requires syncing an origin domain's own root/containment objects) — the replica becomes a syntactically valid but UNREACHABLE-BY-RBAC row: no local role binding's containment walk can ever reach it, so every authorized read/write against it fails closed with 403, forever.

The fix: `domainId` is LOCAL PLACEMENT, not authority — DESIGN §13's single-writer authority governs WHO may write a row, never WHERE it displays in a domain's own containment tree. So: if the payload's claimed parent id already exists in THIS org (e.g. a nested hierarchy that WAS fully replicated, parent-first, in this same import), preserve it — the nesting is genuinely meaningful locally too. Otherwise (the common case), the replica is placed under THIS domain's OWN org root instead (`undefined` — `graph/objects-repo.ts`'s existing default), which is reachable by every role binding an operator normally holds. An explicit `null` (the origin's own object WAS its org root) is preserved as `null` only when nothing else already exists at that exact id locally, avoiding a collision with this domain's OWN, unrelated root object.

### §252. AN UNREGISTERED TYPE COSTS ONE ENTRY, NEVER THE CHANNEL

AN UNREGISTERED TYPE COSTS ONE ENTRY, NEVER THE CHANNEL (M25.7 round 2)
`createObject` calls `requireObjectType`, which 404s on a type this instance has never registered — and this branch has no try/catch, so that throw aborts the peer's ENTIRE signed bundle, every unrelated entry in it with it, and `inbox-loop.ts` re-fetches the same bundle forever. The channel wedges on the first occurrence and never recovers on its own.

THAT IS NOT HYPOTHETICAL, IT IS WHAT A ROLLING UPGRADE PRODUCES. `object_types` is a migration seed at both ends, so a NEW builtin type exists at an upgraded commander and not at an outpost that has not yet run the migration. M25.7's `freeze` (drizzle/0089) is the first type to make that reachable from an ordinary operator action — declaring a freeze — rather than from an operator registering a custom type, which is why the tolerance lands here now. 0043 (`outpost`) and 0051 (`placement`) had the same exposure and were lucky.

A PRE-CHECK, NOT A `catch`. A caught error is only safe if nothing before the throw issued failing SQL — Postgres aborts the whole transaction on a failed statement, so a `catch` here could resume onto a poisoned connection and turn a survivable skip into the abort it was meant to prevent. `getObjectType` is one PK lookup and asks the question directly.

SKIP-AND-RECORD, so the loss is visible rather than silent: the drop lands in this org's own hash-chained audit log (`scp audit list`, `GET /v1/audit-events`), the honesty surface this codebase already uses when an import discards evidence it received. One entry may be lost; the channel must not be. The recovery path is a from-genesis re-sync once the peer has the migration, which replays the entry into a now-registered type.

### §253. An artifact identity collision converges, never drops

AN ARTIFACT IDENTITY COLLISION CONVERGES BY ADOPTION, NEVER DROPS (ADR-0045 D2a)
An `artifact` object is minted OUTSIDE the ordinary sync path too — `mintArtifactObjects` (`graph/artifacts-repo.ts`), called from BOTH `exportPromotionBundle` and `importPromotionBundle` — and it is an ordinary (non-domain-local) object once minted (ADR-0045 D3), so it also journals and CAN arrive here, independently, via ordinary full-scope sync. Measured, not hypothetical: `federation.integration.test.ts`'s M17.4(a) suite reuses one peer pair and one digest across several `it()`s, and the SECOND promotion's `buildBundleToward` syncs the FIRST promotion's already-minted commander-side artifact object toward a receiver that already minted its OWN row for the same digest at the first import — two different ids, one identity, `objects_artifact_one_per_digest_type` (0095) refuses the second INSERT, and `upsertObjectByUrn` has no branch that expects it.

A PRE-CHECK, NOT A `catch`, for the identical reason the type-registration guard above is one: a failed INSERT poisons this transaction, and this switch has no try/catch around it.

ADOPT, NOT SKIP-AND-RECORD (D2a amendment — the prior behavior here, and why it changed). This collision is not an accidental one-off (0051/0043's precedent, still correct for THAT case): every promotion mints a receiver-local anchor (D2) that is GUARANTEED to collide with the exporter's own ordinary-synced copy (D3) the moment it also reaches this peer, so skip-and-record produced one `entry_dropped` audit per promotion per peer FOREVER and the receiver's own anchor never learned the shared base had arrived. Adoption keeps this receiver's existing id/urn (every local reference — this receiver's own promoted change's `sourceRef`, any `derived_from` edge — keeps resolving) and moves the row's AUTHORITY and `properties` onto the incoming, signature-verified entry; see `adoptArtifactIdentity`'s doc for the full reasoning, including why `firstPromotedChangeId` (receiver-local history) survives the adoption untouched and why a `domainLocal` anchor was considered and rejected.

### §254. THE EVIDENCE RESOLVES ITSELF

THE EVIDENCE RESOLVES ITSELF. If this domain had previously recorded unattached `change_status` for this very object (the status entry arrived before its object — routine at any scope wide enough to ship both), that ignorance is now over: the change object IS here and the board's normal replica treatment takes over. Clearing it is what stops the signal from being a ratchet — see `unattached-change-status-repo.ts`. Keyed on the object id rather than on `typeId === "change"` so it is correct even if a future entry kind carries the same id; a delete that matches nothing is a no-op. The id comes from the row that ACTUALLY landed, not from `payload.id` (which is optional on the wire).

### §255. A freeze's projection row is rebuilt here

M25.7 (owner decision D6, ADR-0043) — A FREEZE'S PROJECTION ROW IS REBUILT HERE, AND THAT IS THE WHOLE FEATURE. The object itself is inert: every reader that ENFORCES a freeze (`activeFreezesInWindow` and, through it, `freezesByTarget`, `checkFreeze`, `evaluateFreezeHolds` and the service board) queries the `freezes` table, so without this line a commander-declared freeze would replicate into the graph and still not be a freeze at the outpost — a replicated row nothing reads.

NO NEW BRANCH AND NO NEW ENTRY KIND: this rides the `object_upsert` case that already resolves any registered type through `upsertObjectByUrn` (shared with `policy_upsert`). Keyed on the type of the row that ACTUALLY LANDED rather than on `payload.typeId`, for the same reason `clearUnattachedChangeStatus` is keyed on `upserted.id`.

`rebuildFreezeProjectionFromObject` NEVER THROWS on malformed content, deliberately — this branch has no try/catch, so a throw aborts the peer's whole signed bundle and wedges the channel (the rule `governance-managed-types.ts` and ADR-0032 §6a state for this exact branch). Its docblock records the compensating control, and the round-2 correction that the FIRST version of that guarantee did not hold: it checked only "is it a non-empty string", so a non-UUID `freezeId`/`scopeObjectId` reached four `uuid` columns and raised `22P02`, which poisons the transaction — the abort it was written to prevent.

### §256. Resolved before the delete, since after it the row is gone

M25.7 — RESOLVED BEFORE THE DELETE, because after it the row is soft-deleted and the ordinary lookup filters `deleted_at IS NULL`. Only for a `freeze`, so every other type pays nothing. `payload.typeId` is the right key here (unlike the upsert branch, which keys on the row that landed): there is no landed row to read, and `deleteObject` itself matches on this same `typeId`, so a mismatch cannot delete anything for this branch to follow up on.

### §257. A TOMBSTONED FREEZE MUST STOP BLOCKING

A TOMBSTONED FREEZE MUST STOP BLOCKING (M25.7 round 2)
Soft-deleting the `objects` row is the whole job for every type whose object IS the record. A freeze's enforcement lives in `freezes`, and nothing that reads that table joins to `objects` — so without this the projection row OUTLIVED its own wire form: still returned by `activeFreezesInWindow`, still refusing every gate and per-target admission, and UNLIFTABLE, because `lockFreezeRow` refuses a local lift of a foreign-origin freeze and the declaring domain has just destroyed the object a re-snapshot would have travelled on. A commander deleting a freeze object would have frozen its outposts permanently.

A LIFT, NOT A DELETE — the row stays readable so a `freeze_admission` Decision citing it keeps resolving (M25.1's ruling for the local verb, charter principle 6).

### §258. Endpoints not yet replicated locally

Endpoints not yet replicated locally. Skipped rather than failing the whole bundle over one edge.

CORRECTED M20.3 (ADR-0031 §4). This used to say the case "should not happen for a from-genesis or contiguous-cursor import, since a relationship's origin domain always creates its endpoints first in its OWN chain". That premise was true when written and is NOT a safe thing to keep asserting: locality is now a property an endpoint can have, and an origin domain legitimately creates endpoints this side will never be shown.

As things actually stand the case still cannot arise from locality, because §4 makes an edge inherit locality from EITHER endpoint — so an edge whose endpoint is withheld is itself never journaled, and never reaches this importer. That is the reason it does not happen; the sentence above was not. A stale rationale inside a defensive catch is how the next instance hides (CLAUDE.md: a comment naming a hazard is a signal to sweep, not evidence it was handled), so if a future change ever lets a one-sided edge cross, THIS is the line that quietly absorbs it — and the skip below is then the only thing standing between a partial graph and a wedged bundle.

### §259. No try-catch around the write, and that is a correction

NO try/catch AROUND THE WRITE, and that is a correction rather than an omission. The first version wrapped it, on the reasoning that a throw wedges a peer's entire signed journal. MEASURED: catching a Postgres error inside a shared transaction does NOT un-poison it — the tx stays aborted, the catch hides the real failure, and the next statement dies with 25P02 somewhere unrelated. A swallowed DB error is strictly worse than a propagated one.

Tolerance therefore comes from VALIDATING BEFORE WRITING: every shape guard below runs before any row is touched, so a malformed or unparseable entry is skipped without the database ever seeing it. What remains after those guards is a genuine fault, and it propagates. OUTPOST-RUN PROBES — the commander's declaration of WHAT to probe, applied locally so this domain can run it. `federationImport: true` skips the journal append, or a receiver would echo the entry back to its sender and, with two peers paired both ways, loop.

TOLERANT LIKE `change_status`, and for the same stated reason: a throw mid-bundle wedges a peer's ENTIRE signed journal. A hook naming a component this domain has not replicated yet is the ordinary out-of-order case, not corruption — it is dropped and re-sent on the next sync, exactly as an unattached `change_status` is.

### §260. No try-catch around this write either, for the same reason

NO try/catch AROUND THE WRITE, and that is a correction rather than an omission. The first version wrapped it, on the reasoning that a throw wedges a peer's entire signed journal. MEASURED: catching a Postgres error inside a shared transaction does NOT un-poison it — the tx stays aborted, the catch hides the real failure, and the next statement dies with 25P02 somewhere unrelated. A swallowed DB error is strictly worse than a propagated one.

Tolerance therefore comes from VALIDATING BEFORE WRITING: every shape guard below runs before any row is touched, so a malformed or unparseable entry is skipped without the database ever seeing it. What remains after those guards is a genuine fault, and it propagates. The commander RETRACTED a probe. "Until they hear otherwise" is this entry: the outpost stops running it because the declaration is gone, not because a schedule expired.

### §261. No try-catch around this third write, for the same reason

NO try/catch AROUND THE WRITE, and that is a correction rather than an omission. The first version wrapped it, on the reasoning that a throw wedges a peer's entire signed journal. MEASURED: catching a Postgres error inside a shared transaction does NOT un-poison it — the tx stays aborted, the catch hides the real failure, and the next statement dies with 25P02 somewhere unrelated. A swallowed DB error is strictly worse than a propagated one.

Tolerance therefore comes from VALIDATING BEFORE WRITING: every shape guard below runs before any row is touched, so a malformed or unparseable entry is skipped without the database ever seeing it. What remains after those guards is a genuine fault, and it propagates. OUTPOST-RUN PROBES, THE UPWARD HALF — a probe result produced in a domain, applied at the commander so its wave gate can read it exactly as it reads local evidence.

`source: "peer_reported"` IS STAMPED HERE, NOT READ FROM THE PAYLOAD, and the entry does not carry one. A signed journal proves WHO sent the bundle; it does not make the contents true, so the receiver records what it knows rather than what the sender claimed about its own authority. `producerSubjectId` is null for the same reason — there is no local principal behind a peer's machine-produced row, and inventing one would attribute a human to it.

Tolerant like the hook cases: a throw wedges a peer's ENTIRE signed journal, and evidence naming a component this domain has not replicated is the ordinary out-of-order case.

### §262. Best-effort enrichment ONLY

Best-effort enrichment ONLY: mirrors the lifecycle state into the change's already- replicated graph object (from a corresponding object_upsert entry) for cross-domain status visibility. Never creates a LOCAL `changes` state-machine row — a synced change must never be picked up by this domain's own reconciliation loop (DESIGN §13 single-writer authority: replicas are read-only, and "read-only" here specifically means "not managed by MY engine," not just "not graph-writable"). Swallows any failure (e.g. the underlying object hasn't been replicated yet) — this entry kind is enrichment, not core graph content, so it must never abort an otherwise-valid import.

THE TWO FAILURE MODES ARE NOT THE SAME, and are no longer collapsed into one bare `catch`:

(a) NO REPLICATED OBJECT TO ATTACH TO — the normal, expected shape for a peer paired at `status_only` scope (scope-filter.ts sends `change_status` but never the change's `object_upsert`), and a transient one at wider scopes when this entry precedes the object it refers to. Note precisely what this means: this domain HAS received positive evidence that a change exists on the peer (this entry names `payload.objectId` and `payload.toState`) — it is NOT equivalent to "no change was ever proposed there". The evidence is nonetheless dropped: a `change_status` payload carries no `targets`, so nothing here can attribute it to a component, and synthesizing a graph object from it would fabricate name/targets/urn this domain was never sent.

THE EVIDENCE IS NO LONGER DROPPED. It is recorded in `federation_unattached_change_status` (drizzle/0040) — the "federation-layer store for unattached peer status" this comment used to name as missing future work. It carries the object id, the propose-time urn/name when the payload supplied them, and the last reported state, and it is DELETED by the `object_upsert` branch above the moment the change object actually lands. `coordination/service-board.ts` reads it so a board can no longer report a confident `stable` over evidence this domain literally received. Attribution stays at (peer, change) grain — per-COMPONENT would need `targets` on the wire; see the repo module's header for that owner decision. (b) ANY OTHER failure — still swallowed (enrichment must never abort a valid import), but deliberately distinguished below so (a) is not used to explain away (b).

### §263. §7.2.7 — no longer discarded

§7.2.7 — no longer discarded: persist a passive WITNESS of the exporter's audit-chain head (peer, origin, sequence, auditEventId, contentHash). INFORMATIONAL: never gates the import, never affects applied/skipped counts — the post-failover runbook reads it to detect a truncation `scp audit verify` structurally cannot see. The payload is the audit-repo's own `{auditEventId, ...}` shape; `entry.rowHash` is the hash-chain content hash for the entry.

### §264. Informational-only in a plain sync bundle (v1)

Informational-only in a plain sync bundle (v1): already hash-chained/signed on the exporting side (audit-completeness lives there); not separately persisted here. Promotion Bundles carry approval evidence through a DEDICATED, validated path instead (promotion-repo.ts's `importedApprovalEvidence` table) — that is the flow the DoD's "tampered/missing approval attestation rejects the approval as evidence" test targets.

### §265. Segment verification: strict, fail-closed, one path

SEGMENT VERIFICATION — strict, fail-closed, one path; only the DIAGNOSTIC is smart.

WHAT THIS DOES. `contiguous` is chosen from the RECEIVER's `peer.syncScope` and from nothing else. A `full` receiver demands an exactly gap-free, prev_hash-linked, cursor-continuous run (with trust-on-first-sync for the very first segment ever seen from an origin); a receiver configured narrow verifies the sparse shape it asked for. A run that does not verify is REJECTED — there is no fallback, no laxer retry, and no path by which a chain with a hole in it is applied.

WHY NOT "ACCEPT A SPARSE CHAIN FROM A NARROWER SENDER" (owner decision). It is true that a sender narrowed to `status_only`/`changes_only`/`policies_only` legitimately ships a chain full of holes, and that a `full` receiver meeting one is almost certainly looking at a config asymmetry rather than an attack. It is ALSO true that a sparse run and a maliciously thinned run are the same bytes: the bundle checksum/signature only prove the SENDER produced what arrived, so a signer (or anyone holding its key) can delete a middle entry, re-sign, and a receiver that tolerates holes will take it. Contiguity is the ONLY check that catches that, and this is the one place it is caught. So it stays absolute. The misconfiguration is fixed where it belongs — in the operator's hands, with a message that tells them exactly what to fix.

THE ANCHOR THIS SIDE ACTUALLY HOLDS (pre-M16 residual W1 — SECURITY-SENSITIVE; drizzle/0042). `cursor.rowHash === null` does NOT mean genesis. It means NO ANCHOR WAS EVER RECORDED, and there are two ways to get there, both purely local: nothing has ever been applied from this origin (`sequence === 0` — trust-on-first-sync, unchanged), or THIS side's own `sync_scope` was narrow, so the sparse path advanced the cursor to the range tail with `rowHash: null` (it does not hold that entry's hash and may never have been shown it). Folding the second case into genesis is what made a scope WIDEN a one-way ratchet: the peer's next contiguous, authentic run could not link to genesis, so every subsequent import was refused forever. The recovery is the ONE-SHOT PERMIT `cursor.reanchorFromSeq`, issued only by `pairPeer` whenever the LOCAL operator's pairing leaves this peer's `sync_scope` at `full` with an anchorless cursor (R1: keyed to the RESULTING scope and the cursor's actual state, not to a from→full transition — see peers-repo.ts) (cursors-repo.ts `permitCursorReanchor`) — never by anything a peer sends, because `sync_scope` is local config that never crosses the wire. With the permit in force the run adopts its OWN first entry as the anchor and NOTHING ELSE is relaxed: it must still start at exactly `cursor.sequence + 1`, be internally gap-free, and verify every rowHash and signature, so a re-signed run with a deleted middle entry is refused exactly as before.

THE MESSAGE IS THE FEATURE. A contiguity break (`sequence_gap` / `prev_hash_mismatch` — `JOURNAL_CONTIGUITY_BREAK_CODES`) gets `describeContiguityBreak`: an opening clause that states what the CODE actually means (the two do not mean the same thing — see `describeBreakShape`), the peer, THIS side's `sync_scope` verbatim, why a gap-free chain was expected, the state of THIS side's anchor as measured rather than as assumed, the ways a scope change legitimately produces this, and the commands to compare. It never says "tampered" — that would be a verdict, and the likeliest cause is config. It also never says the opposite: a broken chain IS what withheld or removed entries look like, and the message says so too. Every OTHER break code (`row_hash_mismatch`, `signature_invalid`, `no_public_key`, `sequence_not_increasing`, `sequence_before_start`) is a content-integrity failure and keeps the security-toned wording.

### §266. What a strict run can anchor to, measured from the cursor

What this side can actually anchor a strict run to — MEASURED from the cursor, never assumed: - `held`      a real recorded row hash for `cursor.sequence`; the strict link is checkable. - `genesis`   nothing has ever been applied from this origin (`sequence === 0`): the run really must be the start of the chain (trust-on-first-sync). - `permitted` no recorded hash at a NON-ZERO cursor, and the local operator's one-shot re-anchor permit is in force for exactly this position (drizzle/0042). - `none`      no recorded hash at a non-zero cursor and NO permit. There is nothing to link to; the run will be compared against genesis and cannot match. This is exactly the state every peer wedged by the pre-R1 bug sits in RIGHT NOW: `pairPeer` used to issue the permit only on a scope TRANSITION into `full`, so a peer whose `sync_scope` was already `full` before the fix landed (the common case — that is how it got wedged) stays in `none` until the operator re-pairs it. Since R1, `pairPeer` issues the permit whenever the RESULTING scope is `full` and the cursor is anchorless, regardless of what it changed from — so re-running the exact recovery this message prescribes (`scp federation pair <peer> --sync-scope full`, even though the row already says `full`) moves the peer to `permitted` and heals it. It is still a state to REPORT accurately, not to paper over.

### §267. THE OPENING CLAUSE MUST MATCH THE CODE

THE OPENING CLAUSE MUST MATCH THE CODE — AND THE ANCHOR THIS SIDE ACTUALLY HAS. The two contiguity codes do not mean the same thing, and neither does "we compared against an anchor" when there was no anchor to compare against: - `sequence_gap` really is "the run I was shown has holes in it" — sequences are missing. - `prev_hash_mismatch` against a HELD anchor is "this run does not link to the anchor I am holding". The run can be perfectly contiguous, gap-free and authentic and still fail this, because the anchor is THIS side's state, not the peer's. Telling that operator their peer shipped a chain with gaps sends them hunting for something that is not there. - `prev_hash_mismatch` on the run's FIRST entry with NO anchor held is a third thing entirely, and the previous wording got it flatly wrong (W2): it blamed "this side's last known-good anchor" and "the previous scope regime" when the measured cursor was `{sequence: N, rowHash: null}` and the comparison was against JOURNAL_GENESIS_HASH. There was no anchor at all. Say that, because it is the fact that determines the recovery.

### §268. THE ANCHOR CLAUSE

THE ANCHOR CLAUSE — what this side is holding, measured, and what to do about it. This is where W2's dishonesty lived: the message asserted a stale anchor from "the previous scope regime" for a cursor that had no anchor at all, and prescribed a recovery (align the scopes and re-export) that was INERT for that state.

### §269. THE DIAGNOSTIC for a contiguity break

THE DIAGNOSTIC for a contiguity break. Three things the operator cannot see from one side: what shape the arriving run actually has, what THIS side is configured to expect, and what THIS side's cursor is actually holding. Deliberately NOT a verdict in either direction — the likely causes plus what to check, and an explicit note that a genuine break looks identical, because this check is exactly where that is caught.

THE CAUSES ARE THE ONES THE PRODUCT ACTUALLY PRODUCES. (1) A sender narrower than this side ships a sparse chain (`sequence_gap`). (2) Whatever this side's anchor really is — see `describeAnchorClause`, which reads it from the cursor rather than asserting it. The withheld-after-signing clause is kept, and stays gated on "the two sides already agree and no scope changed since the last accepted import", because that is exactly the condition under which none of the benign explanations apply.

### §270. §7.2.6 RESYNC ONLY

§7.2.6 RESYNC ONLY. When true, every applied entry carries `forceOverwrite` into its `FederationImportContext`, so a stale-revision entry OVERWRITES instead of no-op'ing — how a lost-tail restore re-converges. The single-writer authority check is still enforced. Set only by the mutually-authorized resync path, which resets the cursor to genesis first (so rail 4's high-water mark, cleared by that reset, does not refuse the resync bundle as a regression).

### §271. Resume from cursor, continuous with what was applied

2. Resume-from-cursor + hash-chain verification, continuous with what was actually applied last time (not just internally contiguous within this one bundle) — EXCEPT on the very first sync ever received from this origin (cursor.sequence === 0), where there is by definition no prior state to demand exact continuity from. DESIGN.md §13 explicitly anticipates starting mid-chain here ("`scp federation export`... + optional snapshot for bootstrap"): an outpost may bootstrap from a snapshot/later cursor rather than absolute sequence 1. In that one case, trust-on-first-sync applies: verification anchors to the bundle's OWN first entry (still checking every entry's signature and the chain's INTERNAL contiguity from there) rather than demanding the impossible ("prove this is really sequence 1 forward" when it may legitimately not be). Every SUBSEQUENT sync from the same origin, once a cursor is established, is held to the strict exact-continuity check — closing the gap an attacker could otherwise exploit by claiming "this is my first sync" indefinitely to splice in an arbitrary later segment. A scope-filtered bundle (any non-`full` peer — MAJOR review fix) is SPARSE: it deliberately omits out-of-scope entries, so its sequence has gaps and each entry's `prevHash` points at an omitted predecessor this side never sees. Such a bundle is verified with `contiguous: false` (still checking every rowHash + signature + strictly-increasing sequence — only omission of in-scope entries becomes undetectable, inherent to scoping). A `full` peer keeps the strict contiguous, cursor-continuous verification with trust-on-first-sync — and keeps it: a `full` receiver meeting a narrower SENDER fails closed (owner decision), with a message that names the scope asymmetry as the likely cause instead of crying tampering (`verifySegment`).

### §272. DIVERGENCE RAIL 4

DIVERGENCE RAIL 4 (§7.2) — the exporter's SIGNED tail attestation, verified and advanced against this side's monotonic high-water mark BEFORE any entry is applied, so a rolled-back/forked tail fails the whole import closed. Runs for BOTH full and sparse receivers and even for an entry-empty bundle — which is exactly what makes it catch a lost/rolled-back tail for a narrow-scope peer that rails 1–3 are structurally blind to. The attestation rides OUTSIDE the bundle checksum (a sibling field), so its signature is verified independently here against the same peer key; an un-upgraded exporter sends none and the rail no-ops (never blocks). `isReplay` (this bundle's tail is at or below what we already applied) keeps an idempotent re-import of an older bundle from being mistaken for a live regression.

### §273. Throws a 409 on ANY failure

Throws a 409 on ANY failure — there is no accept-anyway path. The 409's `detail` is the operator-facing diagnostic and every transport carries it verbatim: `POST /v1/federation/imports` returns it as the problem detail, the live-pull scheduler records it as the peer's `refused` reason + block Decision (federation-sync.ts), and the air-gap inbox walk records it on the ledger row + block Decision for the offending file (inbox-loop.ts).

### §274. THE SECOND DROP CHOKEPOINT

THE SECOND DROP CHOKEPOINT. This receiver's OWN scope discarded a change-status entry that the sender did ship — e.g. a `policies_only` receiver. The board's scope-derived caveat already covers this case, but recording it is strictly more precise (it names WHICH change and its state, so the caveat can be conditioned on the change still being in flight rather than firing forever). Recorded only for `change_status`: no other skipped entry kind carries a lifecycle state this domain could otherwise mistake for "nothing is happening".

### §275. Advance once to the last applied entry, with its hash

Full scope: advance ONCE to the last applied entry, carrying its rowHash for next sync's continuity check. Equivalent to advancing per entry inside the loop above — the whole import runs in one atomic transaction (the caller's `withTenantTx`), so no intermediate cursor state is ever observable, and advances are monotonic within the loop — but pays one `advanceCursor` (3 statements) per import instead of one per entry (a 5000-entry bundle otherwise costs ~15,000 extra statements for no durability benefit).

## `apps/server/src/federation/inbox-loop.integration.test.ts`

### §276. M13.1a — the staging-node INBOX INGEST LOOP, end to end

M13.1a — the staging-node INBOX INGEST LOOP, end to end: THE 13.1a DoD suite (proposal §13.1, docs/proposals/airgap-cds-validate-promote.md). Same topology-faithful harness as retrans-relay.integration.test.ts — three REAL isolated federation domains, a real `registry:2` pair, the real cosign + skopeo binaries:

commander A ──.scpbundle──▶ retrans B ──signed byte tarball──▶ outpost C

Proven here, per the DoD: (1) HAPPY PATH, IDENTICAL OUTCOMES — a promotion `.scpbundle` + its relay tarball dropped into the OUTPOST's inbox are imported unattended in ONE tick (bundle before tarball), with the SAME verification outcomes as the CLI-invoked path run on an identical sibling fixture: same relay-import allow Decision (verdict + reason), same M17.4(b) pre-deploy gate PASS, bytes landed at the destination registry; the tarball hop's `bundle_transfers` row is CONFIRMED (validate-gated, D4). A sync `.scpbundle` through the inbox advances the cursor exactly like a CLI import. (2) IDEMPOTENT — a second tick over the same inbox is a no-op (ledger dedupe): no new changes, no new Decisions. (3) RETRANS VALIDATE-AND-FORWARD — the same tarball dropped at the RETRANS's inbox is validated (byte-equivalent extracted checks) and forwarded byte-identical to the onward drop WITHOUT any registry push (a configured dest repo stays EMPTY), with the confirmed inbound + submitted onward transfer rows (D4 both ways). (4) TAMPER REFUSED, LOOP CONTINUES — a tarball tampered in CDS transit is refused at the retrans with a block Decision + audit event, NO onward drop, NO confirmation; a junk file in the same tick is skipped-with-log, and the tick completes (one bad file never bricks it). The SAME tampered file refused via the loop at the outpost carries the IDENTICAL refusal reason as a direct CLI `importRelayTarball` call (zero-trust survives automation). (5) TRAVERSAL + JUNK — a traversal-shaped file name is refused outright (block Decision, file never read); a malformed `.scpbundle` is refused with the loop's own `federation-inbox-ingest` block Decision (the CLI path throws a plain 409 there — an unattended refusal must still be explainable, principle 6).

### §277. T = a CONTENT-corrupted repack (NOT re-signed)

T = a CONTENT-corrupted repack (NOT re-signed): distinct bytes that FAIL verification. The vuln being closed: a naive verify-then-copy reads the inbox tarball TWICE, so a swap of V→T between the two reads forwards T (unverified) across the boundary under an ALLOW Decision. The fix reads the inbox exactly ONCE (the ingress copy) and verifies + forwards THAT private copy — so a mid-window swap changes only the abandoned inbox file, never the crossed bytes.

### §278. The air-gap door onto the room the body parser guards

THE AIR-GAP DOOR onto the same room the HTTP body parser guards (`app.ts`; wiring test in `json-body-parser.test.ts`). A `.scpbundle` used to reach a bare `JSON.parse`, so a peer could put a `__proto__` key in a bundle and have it become an OWN property on a live object inside this process — across a CDS boundary, on removable media, which is strictly LESS trusted than an authenticated HTTP request, not more.

The A/B is the point: the SAME exported bundle is written twice, differing only by the injected key. The poisoned copy must be refused BY THE POISONING GUARD (named in the reason), and the clean copy must not be refused for that reason — otherwise this test would pass just as well against a bundle that was malformed or schema-invalid for some unrelated reason, which is the vacuous-green shape this repo keeps getting bitten by.

### §279. The containment catch reports the detail, not the status

PR #153 review Q3 — the tick's CONTAINMENT catch reports the throw's DETAIL, not its HTTP title.

Every ANTICIPATED failure inside `processInboxFile` is already caught and turned into a refuse/defer outcome with its own text (the five `err.detail ?? err.message` sites above), so the outer catch in `inboxOrgTick` is reachable only by a throw from the db seam — which is precisely the case it exists for, and the case where the text matters most because nothing else describes what went wrong. An escaping `ProblemError`'s `message` is the bare HTTP title, so `err.message` reported every such containment as "Not Found" / "Conflict" in the `deferred` outcome an operator (or `scp federation inbox status`) reads.

The fault is INJECTED at that seam, deliberately: it cannot be produced from a fixture, because every fixture-shaped failure is caught one layer down. The tick's FIRST transaction loads self+peers; everything after it belongs to per-file processing, so faulting from the second on makes exactly the per-file escape this pins — and proves the loop still contains it (it returns outcomes rather than throwing).

MUTATION-PROVEN: reverting `inbox-loop.ts`'s `describeError(err)` to `err instanceof Error ? err.message : String(err)` makes the detail assertion fail ("Not Found").

## `apps/server/src/federation/inbox-loop.test.ts`

### §280. M13.1a — the inbox loop's OPT-IN INERTNESS, asserted

M13.1a — the inbox loop's OPT-IN INERTNESS, asserted (not merely inspected). The loop is DEFAULT-OFF: an instance whose operator never set `SCP_INBOX_LOOP=1` must NEVER create the queue, register a worker, or schedule a tick — the returned handle is inert and `stop()` is a no-op. (The full ingest behaviour is proven in inbox-loop.integration.test.ts against real Postgres; this unit pins the enable gate so an unconfigured instance provably does not spin.)

## `apps/server/src/federation/inbox-loop.ts`

### §281. M13.1a — the staging-node INBOX INGEST LOOP

M13.1a — the staging-node INBOX INGEST LOOP (docs/proposals/airgap-cds-validate-promote.md §13.1): the six-step manual CDS boundary walk's steps "import what arrived", automated. An unattended pg-boss tick (cloned from `startObserveLoop`'s self-rescheduling singleton shape) lists each resolved delivery inbox and routes every NEW file to the EXISTING verify path for its kind — the loop automates only *who names the file*, never what is trusted.

## Opt-in (documented choice)

The loop is DEFAULT-OFF and runs only when BOTH hold: 1. `SCP_INBOX_LOOP=1` — the explicit operator enable. Chosen as an env var (not per-peer config) because whether THIS instance watches inboxes is an instance-deployment concern, exactly like `SCP_RELAY_IN_DIR` itself; anything else would let replicated config start unattended ingest on an instance whose operator never opted in. 2. The instance actually resolves an inbox to watch — per org, per tick, via 13.2a's `resolveDeliveryTarget` (per-peer `deliveryTarget.inDir` first, `SCP_RELAY_IN_DIR` env fallback). An enabled instance with nothing resolvable does no per-file work: the tick is one SQL round-trip per org and re-checks next tick (peers can gain inboxes at runtime without a restart). With the flag unset (the default) the loop is NEVER scheduled — an unconfigured instance does not spin.

## Role-aware routing (per file)

```text
- `*.scpbundle` → the EXISTING federation import (`importSyncBundle` /
  `importPromotionBundle`) on EVERY role — checksum + Ed25519 signature verify, journal
  replay, M17.4(a) manifest verify, exactly the CLI path (the route and this loop call the
  same repos).
- `scp-relay-*.tar.gz` → role-aware: at an OUTPOST (any non-retrans role), the EXISTING
  `importRelayTarball` (verify + push into the local registry + re-inspect); at a RETRANS,
  the push-less `validateAndForwardRelayTarball` (the §13.1 extraction — same checks, no
  registry half), dropping the byte-identical tarball to the onward DeliveryTarget.
- anything else → skipped-with-log, never a crash.
```

A multi-tenant instance runs the tick per org: a bundle addressed to a DIFFERENT org's domain is left untouched for that org's own tick (transient skip, no ledger); a tarball whose `.scpbundle` has not landed yet is likewise left for a later tick (bundles are processed before tarballs within one tick, so the common same-drop case completes in one pass).

## Dedupe ledger + quarantine posture (documented §13.1a decisions)

Processed state lives in `federation_inbox_files` (drizzle/0034) keyed on CONTENT identity (inbox dir + file name + sha256): re-processing an already-imported file is a no-op; a REPLACED file (same name, new bytes) is new work. `bundle_transfers` stays the per-hop status surface the import paths write (validate-gated, D4) — it has no file identity and a refusal writes no transfer row, so it cannot be the dedupe. Refused files are QUARANTINED-IN-PLACE: the loop never deletes or moves what an operator (or CDS product) dropped — the ledger row (+ block Decision) is what stops re-processing.

## D4 — validate-gated confirm, and zero-trust surviving automation

Confirmation always happens INSIDE the verify paths, strictly after their checks pass (`importSyncBundle` / `applyPromotionImport` / `importRelayTarball` / `validateAndForwardRelayTarball` each record their own confirmed transfer row in the same tx as their allow Decision) — the loop itself never confirms anything, so a blind confirm is structurally impossible from here. On ANY validation failure the underlying path's block Decision + hash-chained audit event stand exactly as a CLI invocation would leave them (the DoD's identical-outcomes bar); where a refusal path throws WITHOUT persisting a Decision (e.g. a sync bundle checksum mismatch — a plain 409 on the CLI too), the loop writes its own `federation-inbox-ingest` block Decision so an unattended refusal is never explainable-by- nobody (charter principle 6). One bad file never bricks the tick: every per-file outcome is caught and the loop continues.

The upstream-relay verification key for arriving tarballs is resolved from the PAIRED peer registry: the cosign public key of this org's (single) `role: retrans` peer — the same out-of-band pairing exchange that distributes every other federation key (M17.3 E5); no key material ever comes from the inbox itself. No / ambiguous retrans peers → tarballs are left unprocessed with a log (config gap, retried next tick), never a guessed key.

The poke-chain trigger IS in this file now: `wakeInboxNow` (M14.4 S6) is the AIR-GAP leg of the contentless poke — an air-gapped outpost has no `role: commander` peer to dial, so waking THIS loop is what makes the last hop real. The interval tick remains the reliable floor that wake merely optimizes.

STILL OUT OF SCOPE here (owner-decided M14 / 13.1b): only the retrans AUTO-RELAY BUILD after a promotion import — i.e. an import on the retrans automatically building + emitting the onward tarball. That hop stays operator-gated (ADR-0009 D3).

### §282. This branch reads the whole file before it can hash it

The `.scpbundle` branch below reads the WHOLE file into memory before it can hash or parse it (unlike the relay-tarball branch, which streams). Without a pre-read ceiling, a single oversized file dropped in the CDS staging dir OOMs the worker before the dedupe ledger can fire — and since the content hash is only computed AFTER the read, the file is never recorded as processed, so the self-rescheduling loop crash-loops on it. This is the same DoS the HTTP door bounds at `app.ts`'s 64 MiB `bodyLimit`; the air-gap door is documented as strictly LESS trusted, so it gets the same ceiling, enforced by `fs.stat` BEFORE the read. Env-overridable for estates with larger bundles.

### §283. Content identity for the dedupe ledger

Content identity for the dedupe ledger. For a `.scpbundle` we read the bytes ONCE and hash the SAME buffer we hand to JSON.parse (in processBundleFile) — so the ledger's content-identity matches EXACTLY the bytes that were imported, closing the separate-hash-read-vs-parse-read window. For a relay tarball (potentially multi-GB) we stream-hash the file; its verify path re-ingests the bytes into a server-controlled private copy (retrans-relay: copy-once) so a post-hash swap of the inbox file cannot change what is verified/forwarded/imported.

### §284. The poisoning-rejecting parse: this is an air-gap door

`parseJsonRejectingPrototypePoisoning`, not a bare `JSON.parse`: this is the AIR-GAP door, the second of the two places foreign bytes become objects in this process (the other is the HTTP body parser in `app.ts`), and it needs the same admission control. A `.scpbundle` arrives from a peer domain across a CDS boundary on removable media — strictly less trusted than an authenticated HTTP request, not more. A `PrototypePoisoningError` is a `SyntaxError` subclass, so the existing catch arm below already turns it into the ordinary "not parseable as a .scpbundle" file refusal, ledgered like any other malformed bundle.

### §285. 409 = the verify path REFUSED

409 = the verify path REFUSED (checksum/signature/chain/manifest — identical to the CLI's outcome, carrying its Decision when the path persisted one). Anything else (400/404 — unpaired peer, graph not yet synced, config gap; or a transient error) is deferred and retried next tick.

THIS IS THE AIR-GAP SURFACE for `import-repo.ts`'s `verifySegment` contiguity diagnostic, and the likeliest place to hit it: a deliberately scope-narrowed outpost is usually the air-gapped one, and nobody is watching a terminal when its `.scpbundle` lands. `err.detail` is passed through WHOLE — it is the "compare `scp federation peers` on BOTH domains" guidance — so it reaches the operator three ways: the ledger row's `detail`, the block Decision's reason tree, and the audit event. Never summarise it here; the ledger row is very often the only record anyone reads.

### §286. M13.2b census note: this tick sweeps FILESYSTEM inboxes only

M13.2b census note: this tick sweeps FILESYSTEM inboxes only — an s3-compatible peer resolves with `inbound.dir === null` (its location is `inbound.s3`), so the guard below correctly skips it. Sweeping an s3 inbox needs vault-cred threading + local temp-file materialization (the `listInbox`/`getDeliveryFile` s3 seams exist; wiring them into the per-file processor, which reads a local path, is a follow-on to this increment) — not a silent drop of an fs dir.

### §287. `describeError` for the same reason the five explicit

`describeError` for the same reason the five explicit `err.detail ?? err.message` sites above use it: an escaping `ProblemError`'s `message` is the bare HTTP title. This is the containment catch, so it is precisely the path where the throw was NOT anticipated and the text matters most. (Unlike the coordination sites, this `detail` is observability-only — `InboxFileOutcome` is returned, never persisted — so no Decision was being degraded here; the inconsistency was.)

PINNED BY `inbox-loop.integration.test.ts`'s Q3 case, mutation-proven. That test injects the throw at the db seam on purpose: every fixture-shaped failure is caught one layer down, which is exactly why this catch is the unanticipated-throw path.

### §288. Enqueues one immediate inbox tick, the air-gap leg

M14.4 (S6, ADR-0009 addendum) — enqueue ONE immediate inbox tick: the AIR-GAP leg of the poke. Mirrors `wakeFederationSyncNow` exactly (a plain `boss.send`, NO singleton, so a queued interval tick can never swallow the wake) and, like it, THROWS when the queue does not exist — the caller treats that as accepted-but-no-op.

WHY THIS EXISTS. ADR-0009 §38 makes the high-side-retrans→outpost poke inside an air gap REQUIRED, not optional. But an air-gapped outpost has NO `role: commander` peer with a `baseUrl` — there is nothing to dial; its content arrives as a FILE that the INBOX loop ingests. So a poke that woke only the sync sweep resolved to ZERO peers and did nothing at all. Waking the inbox loop is what makes the last hop of the chain real.

The wake carries no CONTENT: which files are waiting is discovered by the sweep itself, exactly as on an interval tick, so the poke stays contentless. It does carry `reason: "poke"` — a routing marker, not content — so the handler can tell a wake from an interval tick and, mirroring the sync loop, NOT re-schedule (see `INBOX_POKE_REASON`).

### §289. Self-rescheduling pg-boss loop

Self-rescheduling pg-boss loop — the SAME singleton shape as `startObserveLoop` (boss.work handler re-`send`s itself with `startAfter` + `singletonKey`). Runs only under `SCP_ROLE=all|worker` (wired in `main.ts` beside the other loops) AND only when the operator explicitly enabled it (`SCP_INBOX_LOOP=1`) — otherwise this returns an inert handle and the queue is never created: an unconfigured instance does not spin.

### §290. A POKE WAKE DOES NOT RE-SCHEDULE

A POKE WAKE DOES NOT RE-SCHEDULE — mirroring the federation-sync loop, and for the same reason: pg-boss computes a singleton slot from now() AT INSERT, so a wake landing in a different slot than the already-pending interval tick is not deduped and leaves TWO pending ticks. The interval job that was pending before the wake still fires on schedule, so the (deliberately NOT sparse) inbox cadence is unaffected. Keyed on "the batch contains a non-poke job" rather than "no poke present" so a batchSize>1 queue could never consume the interval job and skip its re-schedule.

## `apps/server/src/federation/init-role-door.integration.test.ts`

### §291. THE RETRANS INIT DOOR

THE RETRANS INIT DOOR (owner decision 2026-08-24) — `POST /federation/init` refuses `retrans` unless the DEPLOYMENT declares it
An org whose `federation_self.role` is `retrans` activates relay machinery and flips that org's dependencyManagement to `managedHere: false`. Correct at a CDS boundary; a stray config anywhere else. The deployment is the arbiter: `SCP_FEDERATION_ROLE=retrans` is the same install-time axis that withholds the SPA (`retrans-no-spa.integration.test.ts`), so the door keys on `config.federationRole`, not on anything a tenant can write.

BOTH ARMS ON PURPOSE (vacuous-test discipline): the refusal arm asserts the door's OWN sentence (an outcome only this check produces — a 400 from schema validation would read differently), and the acceptance arm proves the door keys on the deployment profile rather than refusing retrans everywhere. MUTATION-PROVEN (reported in the PR body): with the guard in `routes/federation.ts` deleted, the refusal arm goes RED (200 where 400 was pinned).

## `apps/server/src/federation/journal-repo.ts`

### §292. The append-only Sync Journal writer

The append-only Sync Journal writer (DESIGN.md §13 core; BUILD_AND_TEST.md §7: `federation/ journal` is one of the modules held to ≥95% branch coverage). Mirrors `audit/audit-repo.ts`'s `appendAuditEvent` shape exactly — advisory-lock-then-read-tail-then-append — but keyed by `(orgId, originDomainId)` rather than `orgId` alone, since DESIGN §13 stamps the journal `(origin_domain, sequence, content_hash)` and the chain/sequence are PER ORIGIN DOMAIN, not merely per org (in this codebase's single-domain-per-org scoping, these coincide in practice, but the locking/tail-read below is written to the general case regardless).

IMPLEMENTATION NOTE (documented in the M6 PR body as a deliberate deviation): DESIGN §13 calls the journal "outbox-derived". This writer is invoked directly from the SAME call sites that already write the outbox row and the audit event (graph/objects-repo.ts, graph/relationships-repo.ts, coordination/changes-repo.ts, coordination/transition.ts, governance/approvals-repo.ts, audit/audit-repo.ts) — in the SAME transaction — rather than by an async relay reading already-committed outbox rows back out after the fact. This preserves the "one change-capture mechanism, multiple consumers" intent (audit, outbox/SSE, and the journal all originate from the identical mutation call sites) while keeping journal writes strictly transactional with the mutation itself (no risk of the journal diverging from the outbox if a relay process crashes between reading a row and appending its journal entry) and avoiding a second cross-role read of a just-committed row inside the outbox relay's narrowly-scoped `scp_relay` transaction (events/outbox-relay.ts), which today can SELECT/UPDATE `outbox` only.

### §293. The row hash of this domain's own entry at one sequence

The `rowHash` of THIS domain's own journal entry AT one exact sequence, or `null` if no such entry exists. DIVERGENCE RAIL 2 (multi-region-instance-resilience.md §7.2): the exporter compares this against the puller's supplied `lastAppliedRowHash` at its cursor — a mismatch is proof the tail was rolled back and re-minted (a different entry now sits at the height the puller anchored to). Scoped to the own-origin journal exactly like `ownJournalTail`.

### §294. NOTE: entries RECEIVED from a peer

NOTE: entries RECEIVED from a peer (as opposed to authored locally) are never inserted into this domain's own `sync_journal` table — imports apply through the idempotent public write path (graph/objects-repo.ts et al.), and provenance is tracked via `sync_cursors` (cursors-repo.ts) alone. There is intentionally no "foreign journal mirror" table: re-verifying a peer's full history means re-exporting from that peer, exactly as any other convergent-replication system would — `sync_journal` always means "entries this domain itself authored and signed."

## `apps/server/src/federation/lost-tail-simulation.integration.test.ts`

### §295. §7.5 LOST-TAIL SIMULATION

§7.5 LOST-TAIL SIMULATION — the permanent gate that ties the divergence rails and resync together end to end. A (exporter) loses its journal tail (a rolled-back async restore): its journal is rewound below what B (a full-scope importer) has already applied. A real pull then RAIL-1-refuses (a cursor cannot outrun the origin's tail), and the resync operation converges B back onto A's restored reality. This is the flow §7.5 demands, exercised over two real databases.

## `apps/server/src/federation/mtls-enforcement.test.ts`

### §296. Pure-function coverage for the SAN URI identity scheme

Pure-function coverage for the SAN URI identity scheme (ADR-0001 — `urn:scp:domain:<domainId>`, chosen over `spiffe://` and over the certificate's CN). No DB, no TLS socket — the fail-closed behavior these guard (reject on ANY parse ambiguity) is what `mtls.integration.test.ts` proves end-to-end against a real TLS connection; this file is the fast, exhaustive edge-case sweep.

## `apps/server/src/federation/mtls-enforcement.ts`

### §297. M9.3 in-app federation mTLS

M9.3 in-app federation mTLS (ADR-0001, `docs/adr/0001-in-app-federation-mtls.md`) — a gate applied to (and ONLY to) the three federation transport routes (`routes/federation.ts`'s `POST /exports`, `/exports/promotion`, `/imports`), called explicitly at the top of each of those handlers (see `enforceFederationMtls`'s own doc comment for why this is a plain function call rather than a registered Fastify `onRequest` hook — the ADR's proposed shape), never applied globally. Layered on top of — never a replacement for — the existing bearer+RBAC (`auth/require-auth.ts`) and, for imports, Ed25519 bundle-signature verification (`federation/import-repo.ts`). When `deps.config.federationServerMtls` is unset (the default), every function here is a no-op and request handling is BYTE-FOR-BYTE what it was before M9.3.

FAIL-CLOSED by construction: every branch below either establishes a fully-verified peer identity or throws a `ProblemError` (formatted as RFC 9457 `application/problem+json` by `app.ts`'s error handler, same as every other rejection in this codebase) — there is no path that falls through to "treat as anonymous/unverified but proceed anyway".

### §298. SAN URI scheme

SAN URI scheme (owner decision, ADR-0001 "Remaining implementation-time notes"): a peer's federation domain id is encoded as a URI Subject Alternative Name of the form `urn:scp:domain:<domainId>` (a URN, RFC 8141 — not `spiffe://`, to avoid taking a dependency on SPIFFE's trust-domain/path conventions this system doesn't otherwise use). This value is what `scp federation pair`/`peers-repo.ts`'s `pairPeer` records as `federationPeers.id` — an operator issuing a peer's client certificate must encode that SAME domain id here.

### §299. Parses Node's `subjectaltname` string

Parses Node's `subjectaltname` string (e.g. `"URI:urn:scp:domain:1234...,DNS:example.com"`) and returns the domain id encoded in a `urn:scp:domain:<uuid>` SAN URI entry, or `null` if none is present / none matches the scheme / the encoded value isn't a UUID. Only the FIRST `URI:` prefix is stripped from a matching entry (not a generic colon-split) so a URN's own internal colons (`urn:scp:domain:...`) are preserved intact.

Returning `null` is a REJECT signal to every caller (fail-closed) — never treated as "no identity asserted, allow anyway".

### §300. Set only when in-app mTLS is on and verified

Set by `enforceFederationMtls` ONLY when in-app federation mTLS is enabled AND the request's client certificate was fully verified (trusted CA, not revoked, SAN URI resolves to a peer registered for the authenticated bearer token's org). `undefined` in every other case — including "mTLS disabled" — so a handler must never treat its mere presence as proof of anything beyond "this request passed the hook"; it never fails open.

### §301. The per-route mTLS gate

The per-route mTLS gate. Called as the FIRST statement in each of the three federation transport routes' handlers (`routes/federation.ts`) — matching this codebase's existing convention of running auth checks inline at the top of a handler body (`requireAuth` is likewise the first statement in every route handler) rather than as a registered Fastify lifecycle hook. (An earlier version of this used a route-level `onRequest: [...]` array, which runs technically earlier in the request lifecycle — before body parsing — but was reverted: it conflicts with this route file's Zod/`fastify-type-provider-zod` + `config.openapi` typing, as TypeScript infers the route's `ContextConfig` generic from ALL of `config`/`onRequest`/`schema` together, and a hook function typed against the DEFAULT `FastifyRequest` pulls that inference away from the `config: { openapi: {...} } }` object literal's own shape, breaking the OpenAPI metadata typing on those three routes. Calling this plain function at the top of `handler` sidesteps the generics entirely and is FUNCTIONALLY equivalent for fail-closed purposes: it still runs before `requireAuth`, `authorize`, `withTenantTx`, or any bundle-processing code — the only routes ahead of it in the pipeline are Fastify's own schema validation, which never touches application logic or the database.)

### §302. Gate 1 (CA trust AND revocation — both, per the same flag)

Gate 1 (CA trust AND revocation — both, per the same flag): `socket.authorized` is `false` for a missing certificate, a certificate not signed by the configured CA bundle, OR a certificate whose serial appears on the configured CRL (`authorizationError` distinguishes them — e.g. `UNABLE_TO_GET_ISSUER_CERT` vs `CERT_REVOKED`). Empirically confirmed (throwaway CA + a deliberately-revoked leaf cert against a real `https.createServer` with `rejectUnauthorized: false`): Node/OpenSSL's CRL checking already sets `authorized: false` with `authorizationError: "CERT_REVOKED"` for a revoked cert under this exact configuration — no separate/explicit revoked-serial-list fallback check is needed on top of this; see `mtls.integration.test.ts`'s "revoked cert is rejected" case for the proof, and `config.ts`'s `loadFederationServerMtlsConfig` doc comment for the companion finding about EXPIRED CRLs (a different failure mode, handled at config-load time, not here).

### §303. Gate 3 (registered-peer mapping)

Gate 3 (registered-peer mapping): resolves which org's peer registry to check against by running the SAME bearer/session resolution the route handler performs a moment later (`requireAuth`) — mTLS is explicitly ADDITIVE (ADR-0001 §5), never a replacement for bearer+RBAC, so there is no separate "mTLS-only" identity/session concept to invent here. If the bearer token itself is missing/invalid, this throws the identical 401 the handler would have thrown anyway, just surfaced before any peer lookup or body parsing runs.

### §304. ADR-0001 §5's SHOULD binding

ADR-0001 §5's SHOULD binding (advisory in v1, deliberately NOT a rejection): for `/imports`, compares the mTLS-verified transport peer's domain id against the bundle's own claimed `header.exporterDomainId`. A legitimate direct-peer import always has these equal; a mismatch means a certificate-holding peer relayed/replayed a bundle nominally signed by a DIFFERENT domain — not currently blocked (M9 federation is direct-peer only; multi-hop relay is explicitly out of scope, ADR-0001 §5), but always logged AND recorded as a Decision so the mismatch is explainable and so flipping this to a hard MUST later (throwing instead of recording) is a one-line code change, not a design change. No-ops when mTLS wasn't enforced on this request (`mtlsPeerDomainId` unset) — there is nothing to bind against.

## `apps/server/src/federation/mtls.integration.test.ts`

### §305. M9.3 (ADR-0001, `docs/adr/0001-in-app-federation-mtls.md`)

M9.3 (ADR-0001, `docs/adr/0001-in-app-federation-mtls.md`) — the attack-matrix integration coverage for in-app federation mTLS. `fastify.inject()` (used everywhere else in this codebase) fakes the request/response objects and never constructs a genuine `tls.TLSSocket` — there is no real `request.raw.socket.getPeerCertificate()`/`.authorized` to assert against — so every test here boots a REAL listener (`app.listen`) and drives it with `node:https`, presenting (or withholding, or mis-presenting) a client certificate exactly as a real federation peer's `federation-https` transport plugin would.

PKI material is generated FRESH per test via `openssl` (`test-support/mtls-pki.ts`) — never checked-in fixtures — since the SAN URI must encode a domain id each test only learns at runtime (a freshly-paired peer's real UUID), and the expired-CRL tests need an exact, deterministic `nextUpdate` rather than racing the wall clock. Skipped wholesale if `openssl` isn't on PATH (mirrors `crl-parse.test.ts`/`crl-reload.test.ts`).

### §306. A real HTTPS request, optionally presenting a client cert

A real HTTPS client request optionally presenting a client certificate — Node's own `https.request` (not `fetch`, which needs extra dispatcher plumbing to present a client cert through undici — see `plugin-host/subprocess-entry.ts`'s doc comment on that gotcha). The test client always sets `rejectUnauthorized: false` itself: it isn't validating the SERVER's TLS identity, only exercising how the SERVER treats what the CLIENT presents.

### §307. Sets up an org, an admin token and any paired peers

Sets up a test org + admin token + zero or more paired peers (each with a freshly-issued leaf cert whose SAN URI encodes that peer's real domain id) — using a THROWAWAY plain-HTTP server purely for setup (org/user/peer rows live in Postgres, independent of which Fastify instance wrote them, so the ACTUAL mTLS-configured server under test is booted separately, already knowing the CRL/CA it needs at construction time).

### §308. /healthz is the k8s liveness/readiness probe path

/healthz is the k8s liveness/readiness probe path — no auth, and critically NO client cert. Under `requestCert: true, rejectUnauthorized: false` the TLS handshake still completes for a certless client, and /healthz never calls the federation mTLS gate, so it must answer 200. If this failed, enabling in-app mTLS would take down every probe (and every browser/CLI client that never presents a client cert) — the whole point of `rejectUnauthorized: false`.

## `apps/server/src/federation/outpost-binding.ts`

### §309. The authority-split rule, and the choke point enforcing it

M16.2 phase A (E1) — THE AUTHORITY-SPLIT RULE, and the one choke point that enforces it.

DECISION RECORD: `docs/adr/0022-outpost-config-authority-split.md` (referenced from BUILD_AND_TEST.md's M16 entry). The ADR carries the WHY — why the journal cannot carry a peer, why the peer PATCH is structurally keyless, why trust tier and transport mode are separate fields, why the registered JSON Schema is deliberately open, and where the trust-tier vocabulary comes from (docs/GLOSSARY.md, which is authoritative for vocabulary per CLAUDE.md). What follows is the normative statement it records.

THE RULE (normative; `outpost-object.integration.test.ts` checks every clause of it)
After this increment "an outpost" exists TWICE in a commander's database, and the two halves own DISJOINT, NON-OVERLAPPING sets of facts:

(1) THE `federation_peers` ROW (+ `federation_peer_keys`) IS THE SOLE AUTHORITY FOR TRANSPORT IDENTITY AND REACHABILITY: the peer's trust-domain id, its Ed25519 signing key and cosign verification key (with their sequence-anchored windows), `base_url`, `sync_scope`, `delivery_target`, `poke_mode`, and the scheduler's per-peer timestamps. It is LOCAL and PER-SIDE: it never rides the sync journal, is never reconciled with the other side, and is operationally load-bearing (the exporter, the puller, the poke sender and every signature verification read it and nothing else). Its only write doors are `POST /v1/federation/peers` (pair/re-pair, the only door that may touch key material) and `PATCH /v1/federation/peers/{id}` (transport only, structurally keyless).

(2) THE `outpost` GRAPH OBJECT IS THE SOLE AUTHORITY FOR COMMANDER-DECLARED CONFIG ABOUT THAT OUTPOST: today `trustTier`, plus the `peerDomainId` that binds it to (1). It is commander-origin, rides `object_upsert` on the sync journal, and lands at the outpost as a READ-ONLY REPLICA (`objects-repo.ts`'s single-writer guard). Its write doors are `POST/PATCH /v1/federation/outposts…`, and — for a future IaC manifest — the plan-apply path, which resolves `federation:write` for this type rather than plain `object:write`.

(3) NEITHER MAY EXPRESS THE OTHER'S FIELDS — enforced by TWO DIFFERENT MECHANISMS ON THE TWO WRITE DOORS CLAUSE (2) NAMES, not by any structural unrepresentability of the stored object (review round 6, M2 — the previous wording of this clause claimed exactly that structural guarantee, and it was false: the IaC plan-apply door clause (2) itself names is the second door, it does NOT go through the request bodies below, and it CAN store a transport-shaped key): * THE OPERATOR-TYPING DOOR — `POST/PATCH /v1/federation/outposts…` — carries no transport field of any kind: the request bodies (`CreateOutpostConfigRequestSchema`/ `UpdateOutpostConfigRequestSchema`) are `z.strictObject`, so an unknown property (including a transport-shaped one) is REFUSED WITH 400 rather than silently stripped (review round 5, N6). This is what actually stops an OPERATOR from typing a transport field into the object; it is NOT a claim about the IaC door below. * THE IaC PLAN-APPLY DOOR does not go through those request bodies. The registered JSON Schema for `outpost` is deliberately OPEN (review round 4, H7 — read drizzle/0043's header before tightening it: that schema is journaled and validated on the RECEIVING side, so closing it would turn every future property into a fail-closed version-skew hazard that aborts whole sync bundles), so a plan-apply manifest CAN store a `baseUrl`/`trustTier`-shaped key under an `outpost` object's properties and pass validation — MEASURED (review round 6, M2), not merely possible. What stops that from being a privilege escalation is NOT unrepresentability: it is (a) the IaC door resolves the same `federation:write` an operator-typed write does (no broader grant reaches it), (b) the 1:1 peer-binding guard in clause (4) still fires against it exactly as it does against any other write, and (c) whatever lands in `properties` is INERT — every transport read (the exporter, the puller, the poke sender, every signature verification) reads ONLY the peer row, never the object's `properties`, so a smuggled `baseUrl` is stored but never consulted. * no declared-config field is REPRESENTABLE on the peer row — there IS a structural guarantee in this direction: there is no trust-tier column, and the PATCH body admits only `{name, baseUrl, syncScope, deliveryTarget, pokeMode}`. Consequence, and the shape the tests assert in BOTH directions: a config write through the operator-typing door leaves `federation_peers`/`federation_peer_keys` untouched and appends exactly one journal entry; a transport write leaves the object's `version`/`revision` untouched and appends NO journal entry at all (F1 — peer state cannot ride the journal, by construction).

(4) THE PEER ROW IS THE ANCHOR; THE BINDING IS 1:1 AND OBJECT→PEER ONLY. An `outpost` object must name an already-paired peer that holds role `outpost` (an unbound `peerDomainId` is a 400) — OR, since pipeline-substrate-registry-scan.md §10.5 (owner, 2026-08-16), THIS INSTANCE'S OWN TRUST DOMAIN (`federation_self.domainId`): THE HQ OUTPOST (formerly "co-located"; GLOSSARY, ADR-0021 D7), the "commander and outpost are one and the same" case, in which every target this instance authors is within an outpost too — accepted ONLY when `federation_self.role` is `commander` (an outpost's own record is commander-declared and arrives replicated; a locally authored one would outrank the replica in every `byAuthority` read). Those are the ONLY two accepted shapes; anything else stays fail-closed. A second object for the same domain (peer OR self) is a 409. The object never creates, mutates, or is required by the peer row — deleting nothing and blocking nothing. Federation works exactly as before for a peer that has no `outpost` object; the object only adds declared config. The self-bound record has NO peer row at all — every reader that joins a record to its peer row renders it as "this instance" (name/role from `federation_self`; `OutpostConfig.peerIsSelf`). ONE ASYMMETRY, and it is the H1 fix: on an UPDATE the 409 fires only for an AUTHORITATIVE claimant. An unverified `provenance:'manual'` shadow gets no veto over an edit to the row that actually holds authority — that veto was reachable, permanent, and had no delete door. Duplicates are removable through `POST /v1/federation/outposts/{peer}/reconcile` (`outposts-repo.ts`).

(5) TIE-BREAK, when both halves could seem to answer one question: THE PEER ROW WINS for anything about reachability. "Is this outpost air-gapped?" is derived from `base_url`/`delivery_target` on the peer row — never from `trustTier`, which is why the transport channel is deliberately NOT a trust tier (one field meaning both trust posture and reachability would mean neither). The derived field is `transportMode` on the status row, and it reports what CONFIG says (`dialable`/`air-gap`), never an observation of reachability — see `status-repo.ts`.

WHERE THIS IS ENFORCED, AND WHY HERE. Clause (4) is checked in ONE place — `graph/objects-repo.ts`'s `createObject`/`updateObject`, for LOCAL-ORIGIN writes only — rather than at each route. Guarding routes one at a time is precisely the incomplete-call-site-census failure this project keeps hitting: the free-form-`typeId` local write doors are the generic `/objects/{type}` endpoints, the IaC plan-apply path, the federation OVERLAY route, and `POST /discovery/{...}/accept`, and any future door would silently be a fifth. Sitting inside the repo write path covers all of them and everything added later.

IMPORT PATHS STAY PERMISSIVE BY CONSTRUCTION, and must: the check is skipped whenever `federationImport` is set. At the OUTPOST, the arriving replica names the outpost's OWN domain id as `peerDomainId` — which is deliberately NOT in that instance's `federation_peers` (an instance is not its own peer), so applying clause (4) to a replica would refuse every legitimate sync. A bundle can ALSO legitimately carry a THIRD domain's `outpost` object (a commander at full sync scope ships outpost B's config down to outpost A), so the skip cannot be narrowed to "names my own domain" on this path either — doing so would abort whole bundles.

THAT SKIP IS WHY HAND-FILL NEEDED ITS OWN GUARD (review round 4, H1). `handfill-repo.ts` stamps a FOREIGN origin through the same `federationImport` channel, so it inherited the skip — but unlike a journal entry its `peerDomainId` is OPERATOR-SUPPLIED and nothing has verified it, which made `POST /v1/federation/hand-fill` a fifth free-form-`typeId` local write door that bypassed all three clause-(4) refusals. It is closed AT THAT MODULE (`assertHandFillableType`), which restricts a hand-filled peer-bound object to the receiving instance's OWN domain id — the only shape a real replica has. `import-repo.ts` and `handfill-repo.ts` are the complete census of `federationImport` suppliers.

### §310. Clause four of that rule, for one local-origin write

Clause (4) of the rule above, for one local-origin `outpost` write. Throws `badRequest` when the binding is missing/unbound/wrong-role and `conflict` when another live object already claims the peer. `objectId` is the id being written — excluded from the duplicate scan so an UPDATE of an existing object never conflicts with itself.

### §311. §10.5 — THE HQ OUTPOST

§10.5 — THE HQ OUTPOST: `peerDomainId` naming THIS instance's own trust domain is the second accepted shape. There is no peer row to check a role against (an instance is not its own peer — `outpost-binding.ts` module doc, IMPORT PATHS), so the role checked is THIS instance's own (`federation_self.role`), and it must be `commander` — clause (2): an outpost's record is COMMANDER-DECLARED and arrives at the outpost as a read-only replica. Without this check an OUTPOST-role instance could author a local-origin `outpost` object for its own domain BEFORE the commander's record synced down; the replica then lands beside it (imports skip this guard, and its URN carries the commander's org prefix so nothing clashes), and `byAuthority` (local-origin first) would make the outpost's own declaration win every read of its own record while the commander's tier never converged — the inversion of ADR-0022 for exactly the record §10.5 says "arrives replicated". `outpost-config-sync.integration.test.ts` pins the refusal both before and after the replica arrives. `unset` (never `scp federation init`) is refused too: fail-closed, and the copy says which command designates the role. Accepted, it skips straight to the 1:1 scan below, which applies to it exactly as to a peer: a second self-bound object is the same 409. `ensureFederationSelf` is the ONE reader of `federation_self` (self-repo.ts) — lazily minted, so this never fails for want of an identity row.

### §312. An unverified shadow is not an authority and gets no veto

AN UNVERIFIED SHADOW IS NOT AN AUTHORITY, AND ON AN UPDATE IT GETS NO VETO (review round 4, H1). This scan used to be an unordered `LIMIT 1` applied identically to creates and updates, which is how one hand-filled `provenance:'manual'` duplicate made the commander's own `PATCH /v1/federation/outposts/{peer}` return 409 FOREVER — with no delete door anywhere in the API, an UNRECOVERABLE state reached by a supported call. On an UPDATE the question is only "does another row hold AUTHORITY for this peer?", and a hand-typed, signature-less copy does not.

A CREATE stays strict against every live claimant, shadows included: that keeps the create door from ever growing a second row, so the 1:1 invariant holds going forward. The recovery for a database that already holds one is `POST /v1/federation/outposts/{peer}/reconcile`, named in the refusal below precisely so the operator is never left guessing.

## `apps/server/src/federation/outpost-config-sync.integration.test.ts`

### §313. Prove the owner's graph-object decision actually delivers

M16.2 phase A (E2) — PROVE THE OWNER'S GRAPH-OBJECT DECISION ACTUALLY DELIVERS THE M16.2 DoD CLAUSE "editing an outpost's config writes commander-origin data the federation journal/bundle carries down".

The decision rests on a fact the journal makes unavoidable (`JournalEntryKindSchema` admits 9 entry kinds, none peer-shaped, and `peers-repo.ts` never appends one): a `federation_peers` ROW cannot travel, so commander-authored outpost config had to become a GRAPH OBJECT to ride `object_upsert`. That argument is only worth anything if the object genuinely arrives at the outpost AND is genuinely read-only there. This file proves exactly that, on the real two-domain harness (two SEPARATE Postgres databases — see `test-support/isolated-domain.ts` for why orgs-in-one-database would be the wrong model), through the real export → verify → import path:

```text
1. a commander-authored `outpost` object ARRIVES at the outpost carrying the COMMANDER's trust
   domain as `originDomainId`;
2. the outpost's own write to it is REFUSED by the EXISTING read-only-replica guard
   (`graph/objects-repo.ts`) — no second mechanism was built for this;
3. the commander remains the SINGLE WRITER: its edits keep flowing down and the outpost's
   replica converges, while the outpost never authors a revision of its own.
```

Test-only increment: it adds no production code, it verifies that the production code already composed for this works.

### §314. Asserts a repo call fails with a status and a detail

Asserts a repo call fails with a specific HTTP status AND a `detail` matching `detail`. `ProblemError.message` is only the TITLE ("Conflict"), so `rejects.toThrow(/read-only replica/)` would never match the text that actually names the guard — it lives in `.detail`.

### §315. The outpost cannot author the record for its own domain

§10.5 (review fix) — THE OUTPOST CANNOT AUTHOR THE CO-LOCATED RECORD FOR ITS OWN DOMAIN. The self shape (`peerDomainId` = this instance's own domain) is accepted ONLY when this instance's `federation_self.role` is `commander`. Runs FIRST, before any replica exists: with the guard gone, this create returns 201 and a local-origin `commercial` row exists that the commander's later replica lands BESIDE (imports skip the guard; the urns differ by org prefix) — and `byAuthority` (local-origin first) then makes the outpost's own declaration win `findOutpostConfigByPeer`, `selfOutpost` and every pipeline tile forever, while the commander's tier never converges. The second half of this pin lives after the replica arrives (below).

### §316. Forward-tolerance of the journalled type, decided early

REVIEW ROUND 4 (H7) — FORWARD-TOLERANCE OF THE JOURNALED TYPE, decided before the second property lands rather than after.

`outpost` is validated with Ajv against the REGISTERED type on the RECEIVING side, and the `object_upsert` import branch has no try/catch — so a rejected entry aborts THE WHOLE SYNC BUNDLE, not just that entry. With the first cut's `additionalProperties: false` (and a closed `trustTier` enum) that made every future addition a fail-closed version-skew hazard: the moment phase B added a second declared-config property, every outpost still on the older migration set would have wedged federation for that peer until upgraded.

This test IS the decision, in executable form. The commander writes an `outpost` object carrying BOTH an unknown property and a tier this build has never heard of — exactly what a newer commander produces — and the outpost imports the bundle WHOLE. The property-level strictness that matters is unaffected: the API request bodies still admit only the known fields and known tiers (proved in `outpost-object.integration.test.ts`), so no operator can write either of these through a route.

## `apps/server/src/federation/outpost-handfill-wedge.integration.test.ts`

### §317. The fifth local write door, and recovery from the wedge

M16.2 phase A, REVIEW ROUND 4 (H1) — THE FIFTH LOCAL WRITE DOOR, AND RECOVERY FROM THE WEDGE IT COULD CREATE.

`POST /v1/federation/hand-fill` sets `federationImport`, which made the peer-binding choke point in `graph/objects-repo.ts` SKIP — so it bypassed all three clause-(4) refusals. Measured before the fix, all HTTP 201: an UNPAIRED `peerDomainId`; a `commander`-role peer (whose tier `GET /federation/status` then reported, the exact outcome the role check exists to prevent); and a SECOND live `outpost` object for a peer that already had a legitimate one — after which the commander's own `PATCH /v1/federation/outposts/{peer}` returned 409 FOREVER with no delete door anywhere in the API.

This file pins BOTH halves, because closing a door is only half the job when the state it could reach is unrecoverable: (A) the door — `assertHandFillableType` (handfill-repo.ts) restricts a hand-filled peer-bound object to this instance's OWN `federation_self.domainId`, the only shape a real replica has; (B) THE RECOVERY — `POST /v1/federation/outposts/{peer}/reconcile` fixes a database that is ALREADY wedged. Both recovery tests build the wedge at the REPO layer on purpose: the API can no longer produce it, and a test that only proves prevention would leave every already-wedged install needing SQL. `it("RECOVERY …")` is where that is proven.

### §318. Plants the wedge the API can no longer produce

Plants the wedge the API can no longer produce: a live, FOREIGN-ORIGIN, `provenance:'manual'` `outpost` object bound to `peerDomainId`. This is byte-for-byte the row `handFillObject` used to write (same `federationImport` shape, `revision: 0`), created here through the repo because the route now refuses it — which is precisely the state an install upgraded from an older build can hold.

### §319. An order-independent witness for the status ranking

N7 (review round 5) — AN ORDER-INDEPENDENT WITNESS FOR THE STATUS RANKING.

The previous version of this test built ONE arrangement (shadow created LATER) and so pinned the ORDER, not the ranking: the lens showed it stayed GREEN with `status-repo.ts`'s `tierRank` collapsed to a constant AND `current.rank <= rank` flipped to `<`. Round 2 had already hardened the sibling RESOLUTION test after the same catch.

Backdating alone does NOT fix it, and that is worth stating: with all ranks equal, `<=` is first-wins and `<` is last-wins, so ANY SINGLE arrangement is beaten by one of the two degradations. Only building BOTH arrangements makes the assertion order-independent — `il5` must win whether the shadow is the FIRST row or the LAST one in `(created_at, id)` order, which no tie-break rule can deliver and only a real local-origin-first preference can.

### §320. Closing the verified-duplicate class while unshipped

N9 (review round 5) — CLOSING THE VERIFIED-DUPLICATE CLASS WHILE THE SURFACE IS UNSHIPPED.

A VERIFIED foreign-origin duplicate bound to one peer had NO public-API recovery: `PATCH` 409s (the binding scan's `blocking` filter exempts only `provenance='manual'`), the default reconcile refuses by design, `DELETE /api/v1/objects/outpost/{id}` is 403 by this milestone's own refusal, and IaC prune only touches stack-managed objects. NOT reachable today — in canonical hub-and-spoke no bundle a commander imports carries an `outpost` row bound to one of ITS peers — but reachable the moment two authoring domains describe one outpost (a sub-commander, or a dual-homed outpost). `?keep=` closes the class the only way that is safe: THIS DOMAIN DELETES THE ROW IT AUTHORED, which is an ordinary journaled tombstone and re-declarable. The refusal to delete a signature-verified replica is unchanged — the second test below is what keeps that half honest.

### §321. (D) THE OPTIMISTIC-CONCURRENCY PRECONDITION

(D) THE OPTIMISTIC-CONCURRENCY PRECONDITION — `?ifClaimant=<objectId>:<version>`.

Reconcile's outcome is derived from the claimant set INSIDE the write transaction, while the caller decided from a set it read earlier. Both arms of the divergence are silent 200s: * the BARE call re-derives the survivor with `byAuthority`, so a locally-authored row that appeared since the preview outranks the shadow and the operator's ENTERED VALUE IS DROPPED; * `?keep=<shadow>` instead makes that concurrent locally-authored row surplus and soft-deletes it — a JOURNALED TOMBSTONE that PROPAGATES DOWNSTREAM to the outpost. Both are pinned below as the state the precondition refuses, and the refusal is proven to write NOTHING: no removal, no adoption, no journal entry.

### §322. A second locally-authored claimant for the same peer

A SECOND LOCALLY-AUTHORED claimant for a peer that already has one — the concurrent row whose appearance is the defect. Planted through the repo for the same reason `plantShadow` is: the create door refuses it TODAY (clause (4)'s clash scan is strict on CREATE, exempting only an unverified shadow on UPDATE), so an API-built version of this state is impossible — while the state itself is reachable from an install upgraded past the older hand-fill door, and from the second-authoring-domain case `?keep=` exists to serve. What matters to the precondition is only that the row is LIVE, bound to the peer, and NOT in the token the caller previewed.

## `apps/server/src/federation/outpost-local-ui.integration.test.ts`

### §323. M16.3 P1 ("PROVE IT SERVES")

M16.3 P1 ("PROVE IT SERVES") — grounding found the one-binary outpost-local UI was ASSUMED "free by construction" and never actually verified. `app.ts` registers `@fastify/static` + the SPA catch-all UNCONDITIONALLY (`registerHealthRoutes(app, deps); app.get("/healthz", ...);` then the `webDistRoot` static registration — see `app.ts`'s module doc right above it), with no gate on this org's/instance's federation role. This suite pins that a `role: outpost` domain genuinely gets both halves of "the same one-binary UI, scoped to its local domain":

```text
1. the SPA is served at all (GET '/' returns real `text/html`, not a 404/503 stub), and
2. the outpost's OWN local-domain graph (a component that exists only here, never federated
   anywhere) round-trips through the generated SDK on that exact same running instance —
   i.e. this is not just a static file server bolted on beside a broken API.
```

Deliberately integration-level, not browser/Playwright level (BUILD_AND_TEST.md: Playwright e2e costs minutes where this costs seconds) — modeled on the `bootDomain` pattern in `federation-poke-chain.integration.test.ts`, but far simpler: no mTLS, no second domain, no federation transport at all is needed to prove "this one instance serves its own UI + API".

## `apps/server/src/federation/outpost-object.integration.test.ts`

### §324. The outpost graph object and the authority-split rule

M16.2 phase A (E1) — THE `outpost` GRAPH OBJECT AND THE AUTHORITY-SPLIT RULE, end to end through the GENERATED SDK against real Postgres.

Read `federation/outpost-binding.ts` for the rule this file checks. In one line: the `federation_peers` ROW owns transport identity/reachability, the `outpost` GRAPH OBJECT owns commander-declared config (`trustTier`) plus the `peerDomainId` binding, and NEITHER can express the other's fields. The two direction tests below are the reviewer's handle on it:

```text
* a CONFIG write appends exactly one `object_upsert` journal row and leaves `federation_peers` +
  `federation_peer_keys` byte-identical;
* a TRANSPORT write (the E4 PATCH) appends NO journal row at all and leaves the object's
  `version`/`revision` untouched.
```

Every write here goes through `ScpClient` (charter principle 3 — the UI/CLI consume only the generated SDK). Raw DB reads are used ONLY for assertions the API deliberately does not expose (journal rows, key windows), never to set up state a route could set up.

### §325. Asserts an SDK call fails with a status and a detail

Asserts an SDK call fails with a specific HTTP status AND a `detail` matching `detail` — the SDK's `Error.message` is only the problem TITLE ("Bad Request"), so asserting on the message alone would pass for any 400 and pin nothing. The status pins the CLASS of refusal; the detail pins WHICH guard fired.

### §326. EXACTLY ONE `object_upsert`

EXACTLY ONE `object_upsert` — this is the whole point of the owner's graph-object decision: outpost config rides the entry kind the importer already applies for any registered type. No new entry kind, no change to `JournalEntryKindSchema` (9 kinds, none peer-shaped), and no peer-row write pretending it will travel.

The accompanying `audit_segment` is the ordinary audit piggyback EVERY audited mutation gets (`audit/audit-repo.ts` appends one on the single call site all mutations funnel through), so the honest assertion is this exact pair, appended in this order — not "one row total".

### §327. pipeline-substrate-registry-scan.md §10.5 — THE HQ OUTPOST

pipeline-substrate-registry-scan.md §10.5 — THE HQ OUTPOST (owner, 2026-08-16). The second accepted binding shape: `peerDomainId` = THIS instance's own trust domain. Everything else stays fail-closed (the two 400s above still hold — measured in this same file), the 1:1 rule applies to self exactly as to a peer (409), and every read surface states "this instance" rather than joining to a peer row that does not exist.

MUTATION LOG (each applied ALONE, then reverted) | Mutation | Result |
| `const isSelf = false` in outpost-binding.ts | the create below FAILS 400 ("neither a paired federation peer nor…") | | drop the clash scan for self (`if (!isSelf && blocking[0])`) | the second-object case FAILS (201, not 409) | | `peerIsSelf: originIsSelf` in toOutpostConfig | passes here (both true on the commander) — pinned as DIFFERENT by outpost-config-sync's replica, where origin is foreign and peer is self | | omit `selfOutpost` from status-repo | the status case FAILS (undefined) |

### §328. Admitting only the known fields is a refusal, not a hope

N6 (review round 5) — 'THE REQUEST BODIES ADMIT ONLY THE KNOWN FIELDS' IS A REFUSAL, NOT A STRIP.

Measured before the fix: `POST /api/v1/federation/outposts` with an extra `somePhaseBProperty` answered 201 and stored `{trustTier, peerDomainId}` — zod's default object parse dropped the key. Nothing false was stored, so the honesty claim survived; but drizzle/0043, ADR-0022 and `outpost-binding.ts` all described a REFUSAL an operator never saw, and a NEWER CLIENT writing a phase-B property to an OLDER commander got a success and lost its field with no signal. That is a real hazard for a product whose premise is version skew across domains. Both bodies are now `z.strictObject`. The asymmetry with the JOURNAL is deliberate and is pinned by `outpost-config-sync.integration.test.ts`: strict at the operator's door, OPEN on the wire.

## `apps/server/src/federation/outposts-rbac.integration.test.ts`

### §329. RBAC coverage for every new federation route

M16.2 phase A, REVIEW ROUND 4 (H2) — RBAC COVERAGE FOR EVERY NEW FEDERATION ROUTE.

WHY THIS FILE EXISTS. A lens removed ALL SIX `authorize(...)` blocks from the routes this milestone added (peers GET + PATCH, outposts POST / GET-list / GET-one / PATCH) and the ENTIRE federation integration suite stayed GREEN — 24 files, 231 tests. `peer-patch.integration.test.ts`'s "G1/G2: … requires federation:write" asserted only 401 (anonymous) and 404 (unknown peer): both fire with the permission check deleted, so the title described the code and the assertions pinned nothing. "Wording, not behaviour" is this repo's second recurring bug source, and the E1 side-door refusals (`/objects/outpost` → 403, plan-apply → `federation:write`) all rest on the claim that these routes are gated on `federation:*` rather than plain `object:write`. That claim needed a witness.

TWO ACTORS, because the write and read gates are different permissions and each needs a witness that can ONLY fail on that gate:

```text
* `operator` — the built-in `Operator` role AT THE ORG ROOT. drizzle/0002 gives it `object:write`
  and `relationship:write`; drizzle/0012 adds `federation:read` to every built-in role but adds
  `federation:write` to Administrator/Owner ONLY. So it holds `object:write` and NOT
  `federation:write` — the review's exact actor — and a 403 from it on a WRITE route means precisely
  "object:write is not enough here", which is the whole argument the E1 side-door refusals make.
```

```text
* `selfScoped` — `Owner`, bound at SELF scope. It holds `federation:read` as a permission but has no
  authority AT THE ORG ROOT, which is the scope every one of these routes checks. It is the only way
  to witness the READ gate at all: no built-in role lacks `federation:read`, so an actor that fails
  on the permission alone does not exist. A 403 from it therefore proves the `authorize(...)` call
  RUNS and its `scopeObjectId` is honored — delete the block and the call returns 200.
```

MUTATION-PROVEN: deleting the `authorize(...)` block from ANY of these routes turns its case red (each route is asserted independently, so a single deletion is caught by a single named test).

## `apps/server/src/federation/outposts-repo.ts`

### §330. The commander-side write and read surface for outposts

M16.2 phase A (E1) — the commander-side write/read surface for `outpost` GRAPH OBJECTS: the commander-authored, owner-ENTERED config about one enrolled outpost, which syncs down to that outpost as a read-only replica because it is an ordinary graph object.

READ `federation/outpost-binding.ts` FIRST — it states the authority split between this object and the `federation_peers` row, and it holds the enforcement of the 1:1 peer binding (applied inside `graph/objects-repo.ts`, so EVERY local write door gets it, not just this module).

This module deliberately owns no invariant of its own beyond URN derivation: it composes `createObject`/`updateObject` so the object is journaled, audited, content-hashed and single-writer-guarded by exactly the same machinery as every other graph object (charter principle 2 — no parallel mechanism).

### §331. Projects the graph object into the API's read view

Projects the underlying graph object into the API's read view, carrying the honest-unknown declaration (`unknownFields`) the rest of this codebase already uses.

`selfDomainId` is REQUIRED (review round 4): without origin-vs-self and `provenance` on the wire, a consumer cannot tell a commander's own asserted config from an unverified hand-filled shadow claiming a foreign origin, and would render the latter as the former. `originDomainId` alone does not answer it — a reader would have to know this instance's own domain id to compare against.

### §332. Declares the config object for an already-paired peer

Declares the config object for an already-paired outpost peer — or, with `peerDomainId` = this instance's own trust domain, the HQ outpost (§10.5; accepted only when this instance's `federation_self.role` is `commander` — on an outpost that record is the commander's replica). The peer-binding guard (`assertOutpostPeerBinding`, reached through `createObject`) refuses an unbound `peerDomainId` (400), a peer whose role is not `outpost` (400), the self shape on a non-commander instance (400), and a second object for the same domain (409).

The peer lookup here is NON-throwing (`findPeerByDomainId`) and is used ONLY to default the display name. Validating the binding is the guard's job at the choke point — so an unpaired peer produces the guard's own precise 400 ("neither a paired federation peer nor…") rather than a 404 from a name lookup, and a caller that bypasses this module gets the identical refusal.

### §333. EVERY LIVE `outpost` object, RESOLVED TO ONE PER PEER

EVERY LIVE `outpost` object, RESOLVED TO ONE PER PEER — the batched read a lane-level projection wants (pipeline-substrate-registry-scan.md §10.2: "one query over live `outpost` objects"), keyed on the object's own `properties.peerDomainId` (string-guarded; an object with no string binding is skipped — it names no peer, so no target's origin can match it).

WHEN TWO ROWS CLAIM ONE PEER, this picks by `byAuthority` — the SAME rule `findOutpostConfigByPeer` applies for `GET/PATCH /v1/federation/outposts/{peer}`. It does NOT state "ambiguous": the binding is enforced 1:1 on every LOCAL create (`assertOutpostPeerBinding`, clause 4), and the duplicates a database can still hold (an unverified hand-filled shadow beside the authoritative row; a replica beside a local row) are exactly what `byAuthority` was written to rank — local origin, then verified replica, then `provenance:'manual'` shadow. A projection that said "ambiguous" where the outposts API itself resolves to one row would contradict the page the link on that projection opens; the recovery for a real duplicate is `reconcileOutpostConfig`, not a fifth state.

`trustTier` reads through `readTrustTier` — an unrecognised or absent tier is null, never defaulted (see that function).

### §334. Every live outpost bound to a peer, in a fixed order

Every LIVE `outpost` object bound to `peerDomainId`, in a TOTALLY DETERMINISTIC order.

The binding is meant to be 1:1 and `assertOutpostPeerBinding` keeps it that way going forward, but a database can still HOLD a duplicate — one left behind by the hand-fill door before it was narrowed (review round 4), or by any future write door. `(created_at, id)` makes the order total: `created_at` alone is not unique inside one transaction, and an ORDER-BY-less `LIMIT 1` (what this used to be) made `GET`/`PATCH /v1/federation/outposts/{peer}` resolve NONDETERMINISTICALLY and land on whichever copy Postgres happened to return — including a foreign-origin one, which then 409'd as a "read-only replica".

### §335. Which of several rows bound to one peer is the authority

Which of several rows bound to one peer is the AUTHORITY, most-authoritative first: 1. LOCAL-ORIGIN — this instance authored it. On a commander that is the operator's own declaration, and it must win over anything else: the commander is the single writer for outpost config in its own domain, so a foreign or hand-typed copy can never outrank it. 2. A VERIFIED REPLICA (foreign origin, `provenance` NULL) — signature/chain-checked on import. This is the authoritative row on an OUTPOST, where the commander is the author. 3. An UNVERIFIED SHADOW (`provenance = 'manual'`) — hand-typed, confirmed by nothing. Last. Ties inside a class keep the caller's deterministic `(created_at, id)` order.

### §336. THE OPTIMISTIC-CONCURRENCY PRECONDITION on the recovery door

THE OPTIMISTIC-CONCURRENCY PRECONDITION on the recovery door — `?ifClaimant=<objectId>:<version>`, one per live claimant the caller PREVIEWED, compared as an ORDER-INSENSITIVE SET against the rows read inside this transaction.

THE DEFECT IT CLOSES. Reconcile derives its outcome — which row survives, which are removed, whether the operator's hand-entered shadow is ADOPTED or DISCARDED — from the claimant set as it is at write time. A caller decides to press the button from a set it read EARLIER. When those disagree, the caller's stated intent and the server's action silently diverge, and the divergence is not visible in the 200 that comes back: * a LOCALLY-AUTHORED row that appeared since the preview outranks the shadow in `byAuthority`, so a bare "adopt this shadow" call keeps that row instead and the operator's entered value is DROPPED with no preview and no mention; * naming the shadow with `?keep=` in that same situation is not a fix, it is the OTHER failure: the concurrent locally-authored row becomes surplus and is soft-deleted, which for a row THIS domain authored is an ordinary JOURNALED TOMBSTONE that PROPAGATES DOWNSTREAM to the outpost. One arm discards the operator's input, the other propagates a delete they never saw. Neither is a refusal, so neither can be reviewed. The precondition converts both into a 412 the caller can act on, and the refusal carries the FRESH claimant list so the re-preview costs no extra round trip and opens no second window.

NOTHING IS WRITTEN ON A MISMATCH — this runs before every `deleteObject`/`updateObject` on the path, so a refusal removes nothing, adopts nothing and journals nothing.

"READ INSIDE THIS TRANSACTION" IS NOT A LOCK (R4, PR #156 residual, honesty owed by ADR-0022). `listOutpostObjectsForPeer`'s read is a plain, non-locking `SELECT` under this connection's default `READ COMMITTED` isolation — not `SELECT ... FOR UPDATE`. A claimant row inserted and COMMITTED by a concurrent transaction after this read runs is genuinely invisible to the compare below; "inside the write transaction" means "as fresh as this transaction's snapshot allows", not "serialized against every concurrent writer". That gap does not reopen the silent-divergence defect this precondition exists to close, because both write branches below are self-checking on exactly that row: the adopt-shadow path re-scans it through `outpost-binding.ts`'s single-writer guard and 409s before writing anything, and the non-adopting `?keep=` path never touches a row it did not itself read. The outcome is a correctly-refused write or a no-op either way — not a silent divergence — which is why this is a documentation fix, not a `FOR UPDATE`.

AN OMITTED TOKEN PROCEEDS UNCHECKED — exactly today's behaviour. That is forced by API additivity (`/v1` is additive-only; a required precondition would break every existing caller) and it is the right PROTOCOL default. It is NOT a licence for a client to omit it: both first-party surfaces (the UI panel and `scp federation outpost reconcile`) always send one unless the operator explicitly asks them not to.

### §337. THE RECOVERY DOOR

THE RECOVERY DOOR (review round 4) — `POST /v1/federation/outposts/{peerDomainId}/reconcile`.

WHY IT EXISTS. Before the hand-fill narrowing, `POST /v1/federation/hand-fill` could plant a second live `outpost` object for a peer that already had a legitimate one. That left the peer UNRECOVERABLE THROUGH THE API: the commander's own `PATCH /v1/federation/outposts/{peer}` 409'd forever ("already has an outpost config object" / "read-only replica"), `DELETE /api/v1/objects/outpost/{id}` is 403 by this milestone's own refusal, and no delete verb for the config existed. An unrecoverable state reachable by a supported action is the one-way-ratchet failure class this project has already paid for (PR #149), so the door is closed AND the existing wedge is made fixable — a database wedged by an older build must be repairable without SQL.

WHAT IT DOES, and nothing more: * keeps the single most authoritative row for the peer (`byAuthority`); * when NO authoritative row exists but an UNVERIFIED shadow does, ADOPTS the first shadow as this domain's own object (`unverifiedShadowOverride` — origin re-stamped, `provenance` cleared, and it journals from then on like any local object), so the operator's entered config is not thrown away; * SOFT-DELETES every remaining unverified shadow for that peer, restoring the 1:1 binding — a silent local cleanup, reported as `removedShadowObjectIds`; * with `?keep=` naming a row THIS domain authored as the survivor (N9 below), also soft-deletes any OTHER locally-authored surplus row for that peer — an ordinary JOURNALED TOMBSTONE that propagates downstream, reported SEPARATELY as `removedLocalObjectIds` so the caller cannot describe it as a shadow tidy-up (review round 6, M1 — the two cases produce different output on every surface).

WHAT IT REFUSES. A VERIFIED foreign-origin replica is never adopted and never DELETED: deleting one would make the next real import a single-writer violation and wedge that peer's sync — trading one unrecoverable state for a worse one. Two verified rows for one peer therefore stay a 409 and are reported as such, which is an honest authority conflict rather than a silent pick.

`keepObjectId` — THE VERIFIED-DUPLICATE ESCAPE (review round 5, N9). Without it, a VERIFIED foreign-origin duplicate bound to one peer had NO public-API recovery AT ALL: `PATCH` 409s (the binding scan's `blocking` filter exempts only `provenance='manual'`), the default reconcile refuses by design, `DELETE /objects/outpost/{id}` is 403, and IaC prune only touches stack-managed objects — and the refusal message named an action the API did not offer. That state is NOT reachable today (in canonical hub-and-spoke, no bundle a commander imports carries an `outpost` row bound to one of ITS peers) but becomes reachable the moment two authoring domains describe one outpost — hierarchical sub-commanders, or a dual-homed outpost. Naming the row to KEEP lets the operator resolve the authority conflict the only way that is actually safe: this domain DELETES THE ROW IT AUTHORED ITSELF, which is an ordinary local tombstone that journals normally and can be re-declared at any time. The refusal to delete a signature-verified replica is unchanged and unconditional — that half is what stops this from trading the wedge for a sync wedge.

### §338. First, before the 404 and before anything is written

FIRST — before the 404, before the `keep` 400, and before anything is written. A world that changed under the caller is a 412 on EVERY branch, including "they all vanished": answering 404 there would tell the operator to declare a fresh config when what actually happened is that the rows they were looking at are gone. 404 stays the answer for the unchecked call, which is the only branch where the resource is genuinely, and uncontroversially, absent.

### §339. 409, not 404: the peer demonstrably has configuration

409, NOT 404 (review round 5, N3). This branch fires when the peer DEMONSTRABLY HAS config — `GET /v1/federation/outposts/{peer}` answers 200 for the very same peer at the same instant — so answering 404 told a status-keyed consumer "no outpost config" and HID the authority conflict on the one door that exists to recover from it. The route's own response map already declared 409 and the schema comment already called this a "409-shaped notFound"; the code is now the shape it always described. 404 stays for the genuinely-no-rows branch above, which is the only branch where the resource really is absent. THE MESSAGE NAMES AN ACTION THE API ACTUALLY OFFERS (review round 5, N9). It previously said "resolve the authority conflict at its source" — advice, not a verb, on a door whose whole purpose is to be the verb.

### §340. Surplus removal, and when the override is passed

Surplus removal. `unverifiedShadowOverride` is passed only for a foreign shadow, which is the only row it applies to: for a LOCALLY AUTHORED row `deleteObject`'s replica check never fires, so the removal is an ordinary local tombstone that JOURNALS normally (a shadow's does not — this domain never authored it, so claiming authorship of its deletion would push a delete for a row the real authority still owns). Passing the flag for a local row would be a claim we do not need to make.

### §341. Edits the commander-origin config

Edits the commander-origin config. ABSENT MEANS PRESERVE for every field — an omitted `trustTier` never clears an asserted one, and (phase A) there is no clear-to-unknown verb at all: un-asserting a tier is a distinct, deliberate operation, and inventing it as a side effect of an omitted field is exactly how a UI silently erases an operator's assertion.

ON AN OUTPOST THIS CALL FAILS, and that is the point: the object there is a read-only replica, so `updateObject`'s existing single-writer guard raises 409 before any of this module's logic runs (proved by `outpost-config-sync.integration.test.ts`). No second mechanism was added for it.

## `apps/server/src/federation/overlay-repo.ts`

### §342. Shared-authority overlays: two domains never both write

Shared-authority overlays (DESIGN.md §13 "review decision — resolved"): "two domains never write one object... it creates an overlay — a separate object it DOES own, linked to the base via the built-in `annotates` relationship. Readers merge base + local overlay at read time; per-type overlay rules bound what may be layered — policy overlays may only ADD strictness."

`annotates` is system-managed (graph/system-managed-relationships.ts) — this is the ONLY legal creation path, exactly mirroring how `approves`/`coordinates` are locked down to their own authority-checked repo functions instead of the generic `/relationships` endpoint.

### §343. A best-effort may-only-add-strictness validator

Best-effort "may only add strictness" validator for policy overlays (DESIGN §13). Checks: (1) `enforcement`, if the overlay sets one, can't be LESS strict than the base's; (2) every control the base's effects require stays required (an overlay's own `effects` are read-time ADDITIONS, never a replacement of the base's — so an overlay is never even ABLE to drop a base requirement, but this defends against a caller who genuinely tries to represent removal via overlay properties that a naive merge might honor). Not a full policy-semantics validator — documented scope limitation for v1.

### §344. Creates a locally-owned overlay and links it to the base

Creates a new, LOCALLY-OWNED overlay object and links it to the (possibly foreign-origin, read-only replica) base object via `annotates`. The base object is never written — single- writer authority and convergent replication are preserved by construction, not by a runtime check (there is no code path here that could mutate `base` even by accident: only `createObject`, never `updateObject`, is called on it).

### §345. Overlay is a user-facing create surface

M12 P5 follow-up (owner ruling 2026-07-16): overlay is a user-facing CREATE surface (free-form `overlayTypeId`), NOT an import path — so it must not become a side door for minting an orphan `component` that bypasses create-strict. Refuse service-member types here, exactly as the generic `/objects/component` route does (shared `graph/service-member-types.ts`). A component is created only via the strict `POST /components`; overlay it afterward if genuinely needed.

### §346. ADR-0026 D2/D3, same reasoning one type further

ADR-0026 D2/D3, same reasoning one type further: a `placement` is identified by a PAIR of objects, and overlay takes free-form `overlayProperties` — so this door could mint a placement with unresolved, untyped endpoint UUIDs and, decisively, with none of the derived edges that make the pair traversable. Refuse it here exactly as `/objects/placement` does (shared `graph/pair-bound-types.ts`); declare the placement via `/api/v1/placements` and overlay it afterward if genuinely needed.

### §347. The fifth sibling, and it had to be a refusal

M25.7 — THE FIFTH SIBLING, AND IT HAD TO BE A REFUSAL RATHER THAN THE PERMISSION CHECK BELOW.

A `freeze` object is the wire half of a record whose other half is a `freezes` row, and this door cannot write that row. The governance-managed check further down would have admitted one to any holder of org-root `policy:write` — an actor who may hold `freeze:write` and `federation:write` NOWHERE — and the overlay it produced would have federated to every peer at a carrying scope, rebuilt itself into their enforcement tables, and been liftable at neither end (this instance has no `freezes` row for `DELETE /v1/freezes/{id}` to find; the peers refuse because the origin domain is foreign).

WHY THIS IS NOT THE `policy` ARGUMENT ONE TYPE OVER. That argument is DESIGN §13's canonical overlay case — locally annotating a commander-distributed global policy, which `assertPolicyOverlayOnlyAddsStrictness` exists to validate. A freeze has no strictness lattice to add to and no annotation semantics at all; its content is a window, a scope and a reason. So refusing the type here deletes no feature and leaves no validator dead, which is the test the three refusals above applied.

### §348. The fourth sibling, which the other censuses never sought

M21.7 — THE FOURTH SIBLING, AND THE ONE THE OTHER THREE CENSUSES NEVER LOOKED FOR.

The three refusals above were each written by censusing a guard that `routes/objects-generic.ts` installs. That file installs FIVE, and the FIRST of them — `assertNotGovernanceManagedObjectType` — is the one nobody carried over. Measured on the pre-fix tree: an Operator (plain `object:write` at the org root, `policy:write` nowhere) POSTed `{base:<a service>, typeId:"policy", properties:{enforcement:"required", effects:[{requireApprovals: {count:99, fromRole:"Owner", scope:"organization"}}]}}` and got 201. `governance/policy-resolve.ts` selects EVERY live `policy` row and an unscoped one matches every target, so that is an org-wide `required` policy demanding an unmeetable quorum — authored by an actor the permission split (`0010_governance.sql:174-175` grants `policy:write` to Administrator and Owner only) exists to keep out of governance entirely. Note `assertPolicyOverlayOnlyAddsStrictness` below could not have caught it: it is gated on base AND overlay both being `policy`, and the base was a service.

WHY A PERMISSION CHECK AND NOT A TYPE REFUSAL, unlike the three siblings. Those types have a stricter typed door that writes rows this one cannot, so refusing them here loses nothing. `policy` is the opposite: DESIGN §13's CANONICAL overlay case is "locally annotating a commander-distributed global policy", and `assertPolicyOverlayOnlyAddsStrictness` exists for precisely that shape. Refusing the type would delete the feature and leave that validator dead. So this door gets the treatment `coordination-as-code/plans-repo.ts`'s `writePermissionFor` already gives the same free-form-`typeId` problem: the governance types clear the GOVERNANCE bar instead.

WHY THE ORG ROOT, and why the sibling `assertPolicyScopeWithinAuthority` is NOT also called here. `createObject` below passes no `domainId`, so an overlay is ALWAYS created at org-root containment — which makes org-root `policy:write` exactly the bar `routes/typed-registries.ts` applies to the same document (`authorize(policy:write, <resolved containment>)`), not a stricter invention. And an actor who clears it clears every branch of `assertPolicyScopeWithinAuthority` by construction: its broadest branch (unscoped / selector / group) asks for org-root `policy:write`, and its narrow `objectRef` branch asks for `policy:write` at-or-above that object, which an org-root grant satisfies because `authz/resolve.ts`'s `scope_expand` walks UPWARD from the scope being checked. So calling it too would be an AUTHORIZATION check that can never refuse — an inert guard reads as coverage and is worse than none. (It has one non-authorization behaviour, a 400 when `scope.objectRef` resolves to nothing; that is validation, not a bound on reach, and a dangling ref matches no target — `governance/policy-resolve.ts` compares it against the TARGET's containment chain — so it fails safe.) If overlays ever gain a containment domain, the authorization argument stops holding and the scope check has to come back with it.

WHY IT SITS HERE AND NOT IN THE ROUTE HANDLER, given `routes/typed-registries.ts:122-133` states the opposite rule ("authorization at the door, invariant at the repo"). Read that rule's REASON, not its shape: it warns against pushing authorization down onto a function ALSO reached by the federation importer, whose `actorObjectId` is the synthetic `FEDERATION_IMPORT_ACTOR_ID` — a subject with no bindings, so the check would refuse every arriving bundle. `createOverlay` is on no such path: `POST /api/v1/federation/overlays` is its only non-test caller (censused filterless — `grep -rn createOverlay apps packages`), and journal replay goes to `federation/import-repo.ts`, never here. The hazard the rule names therefore cannot arise, and the three sibling guards directly above — plus `coordination-as-code/plans-repo.ts`, which runs this SAME `policy:write` check (`writePermissionFor`) inside the repo — put it at the altitude that covers every caller of the function rather than only today's one door. Two `federation.integration.test.ts` cases that passed the org-root OBJECT as their actor went red on this and were given real `policy:write` authors: that is the check being audible, which is the direction an authorization check may fail in.

### §349. Shallow merge: base, then each overlay in creation order

Shallow merge: base properties, then each overlay's properties applied on top in creation order (later overlays win on scalar-key conflicts; array/object sub-merging is intentionally NOT attempted — a full policy-effects merge algorithm is a UI/evaluation-layer concern, out of scope for this read helper). The `enforcement` field specifically takes the STRICTEST value seen across base + all overlays, honoring the "overlays may only add strictness" rule even when a caller's merge just naively took `overlays.at(-1)`.

## `apps/server/src/federation/peer-name-identity.integration.test.ts`

### §350. A peer name must identify a peer, and a rename is an act

M16.2 phase A, REVIEW ROUND 4 — H6 (a peer NAME must identify a peer) and H8 (a RENAME is not a sync-scope declaration). Both live on `PATCH /v1/federation/peers/{id}`, the route E4 added.

H6, MEASURED BEFORE THE FIX: `federation_peers` had no `(org_id, name)` uniqueness and `getPeerByIdOrName` resolved a non-UUID parameter by name with `LIMIT 1` and no ORDER BY. Renaming two peers to the same string both returned 200, after which `GET`/`PATCH /v1/federation/peers/{name}` resolved to whichever row Postgres returned — a TRANSPORT WRITE landing on a peer the operator did not select. Re-pairing could already collide names, so E4 did not introduce it; E4 exists so a settings form can RENAME a peer, which makes it the likely trigger, on the very route that then writes baseUrl / pokeMode / syncScope. drizzle/0045 makes the name unique; these cases pin the refusal on BOTH doors.

H8: `permitCursorReanchor` — a SECURITY-SENSITIVE one-shot permit (drizzle/0042) — fired whenever the RESULTING scope was `full`, which absent-means-preserve made true of a PATCH that only set `name`. Not exploitable (the anchorless-cursor predicate is the whole safety story and is unchanged), but the trigger was WIDER than `cursors-repo.ts` and the G8 census row both claim, and doc-vs-code drift on this exact function is what this repo keeps paying for. The permit is now gated on the request actually DECLARING a scope.

### §351. The handler used to build

The handler used to build `{ orgId, domainId: existing.id, ...request.body }` with the SPREAD LAST, so a body key named `domainId` would have overridden the RESOLVED peer id. It was safe only because fastify-type-provider-zod's validatorCompiler key-strips the body — a behaviour documented nowhere near the call site. The five transport fields are now spread explicitly, so the safety is local; this drives the attack shape through the real route to keep it that way.

## `apps/server/src/federation/peer-patch.integration.test.ts`

### §352. M16.2 phase A (E4) — `PATCH /v1/federation/peers/{id}`

M16.2 phase A (E4) — `PATCH /v1/federation/peers/{id}`: THE NARROW, STRUCTURALLY KEYLESS PEER WRITE.

WHY IT MATTERS. Before this increment the only peer write was `POST /federation/peers`, whose body REQUIRES `publicKey` and treats a different value as a KEY ROTATION: it supersedes the current key window at the applied-sequence anchor and hard-revokes the old key. A Settings form that read a peer, changed one field and re-paired would rotate that peer's trust anchor the moment it dropped or mangled the key. This suite pins both halves of the fix:

```text
(a) a PATCH leaves `federation_peer_keys` COMPLETELY UNCHANGED — no new window row, the existing
    row's `superseded_at` still NULL — and the NON-VACUITY CONTROL right beside it shows the same
    assertions DO catch a real rotation when a re-pair performs one;
(b) EVERY pair-time guard still fires on the new path. The census (G1–G11, with each guard's
    disposition) lives on `updatePeerTransport` in `peers-repo.ts`; the behavioural ones are
    exercised here.
```

### §353. The same requirement, over the whole settings-form save

M16.2 phase B (B2) — THE SAME DoD, OVER THE WHOLE SETTINGS-FORM SAVE.

The case above patches ONE field. A settings form does not: it saves every transport field the operator can see, in one request, and it is the multi-field save an implementer is tempted to build on `POST /federation/peers` ("just send the peer back") — which is the re-pair that rotates the trust anchor. So the field set the UI can actually send (`apps/web/src/routes/outpost-settings.tsx`'s `PEER_SETTINGS_PATCH_KEYS`, plus `pokeMode`, which B3's configuration card sends through this same door) is exercised here as one body, against a real database.

`deliveryTarget` is deliberately NOT in this body: `SCP_DELIVERY_ROOTS` is unset on this test server, so every per-peer directory is refused before storage — which is its own case, "GUARD G4" below. A refusal writes nothing, so it could not exercise this one anyway.

### §354. TITLE CORRECTED IN REVIEW ROUND 4

TITLE CORRECTED IN REVIEW ROUND 4 (H2). This case used to be titled "…requires federation:write" while asserting only 401 (anonymous) and 404 (unknown peer) — BOTH of which still fire with the route's `authorize(...)` block deleted, so the title described the code and the assertions pinned nothing. The permission gate is now witnessed for real, on THIS route and the five others this milestone added, by `outposts-rbac.integration.test.ts` (an `object:write` actor without `federation:write`, mutation-proven route by route). What is left here is what this file can honestly claim: authentication, and that a PATCH never conjures a peer row.

## `apps/server/src/federation/peers-repo.ts`

### §355. Peer pairing + the peer public-key registry

Peer pairing + the peer public-key registry (DESIGN.md §13). Pairing itself is always initiated from THIS side dialing/registering the other — never the reverse (§13 outpost-initiated-only; for air-gapped peers, an out-of-band exchange of each side's `scp federation status` output). This module only persists the result; it does not perform any network handshake itself (that's `packages/plugins/federation-https`'s job for the connected-mTLS case).

### §356. The scheduler's per-peer due state, or null

M14.4 (ADR-0009, drizzle/0038) — the scheduler's per-peer due-state, ISO-8601 or `null` ("never"). `lastPullAttemptAt` is stamped by the conditional claim (every attempt, success or not); `lastPullSuccessAt` only by an `imported` outcome; `lastPokeReceivedAt` by the M14.2 poke handler when it ACCEPTS a poke from this peer. See `isPeerDue` for how the three combine into the frequent/sparse decision, and drizzle/0038 for why NULL is deliberately "due now".

### §357. The peer's CURRENT cosign VERIFICATION public key

The peer's CURRENT cosign VERIFICATION public key (PEM), or `null` when the peer has none registered (paired pre-E5, or never supplied one). Parallels `currentPeerPublicKey` and rides the SAME non-superseded key window as the Ed25519 key, so a cosign rotation is anchored to the same journal-sequence window (never a timestamp). This is the ONLY key M17.4(a) trusts to verify that peer's cosign-signed promotion manifests — `null` is load-bearing for the downgrade defense (a manifest-less bundle from a peer that HAS a cosign key is a downgrade; from one that has none it is genuine pre-E6 back-compat).

### §358. The public key that must verify an entry at that sequence

Resolves the public key that must verify an entry signed at origin `sequence` — the ONLY key selection permitted (SECURITY-SENSITIVE, M6 review fix — CRITICAL). A key is valid for sequence `S` iff `effectiveFromSequence < S AND (supersededAtSequence IS NULL OR S <= supersededAtSequence)`. Returns `null` (fail-closed) if no window covers `S`. Because rotation anchors the old key's `supersededAtSequence` to the highest sequence this domain had already applied, and every future import applies only entries with sequence beyond that, a rotated-away/compromised key can never verify content that will ever be applied — never by a self-declared timestamp.

### §359. M14.1 (ADR-0009) — per-peer poke-mode

M14.1 (ADR-0009) — per-peer poke-mode. Tri-state on re-pair, mirroring `deliveryTarget`'s additive discipline (a boolean has no null state, so: `undefined` = field absent = PRESERVE the current value; `true`/`false` = SET). An EFFECTIVE (post-write) `true` requires an https/mTLS-capable EFFECTIVE `baseUrl` — the pair-time guard (see `pairPeer`) checks the merged tuple, so a re-pair can neither set poke-mode true on a non-https peer NOR downgrade the baseUrl of a peer whose poke-mode stays true.

### §360. The reserved governance label namespace, applied here too

THE RESERVED GOVERNANCE LABEL NAMESPACE, applied to the OTHER label-keyed decision in the tree (governance/governance-labels.ts). Keyed off the DECLARED scope, never the effective one, so an already-stored `custom` selector is grandfathered until someone edits it — the same grandfathering ADR-0032 §6a's guard accepted, and for the same reason: a refusal that fires on a request which declared nothing is a refusal nobody can act on.

### §361. M14.1 pair-time guard

M14.1 pair-time guard (ADR-0009; the fail-closed transport-identity invariant). Poke-mode TRUE requires an https/mTLS-capable peer baseUrl — the poke must authenticate the caller as the enrolled commander (ADR-0001), which only the mTLS transport does. This is the EARLY guard (the pair refuses); full enforcement (the outpost's poke endpoint refusing) is M14.2.

M14.3 HARDENING — the guard validates the EFFECTIVE POST-WRITE STATE, not the input transition. The two fields MERGE with OPPOSITE rules below (baseUrl: request wins when present; pokeMode: tri-state, EXISTING wins when absent), so keying the guard off `input.pokeMode === true` checked a DIFFERENT tuple than the one actually persisted. The hole: a re-pair that sets `baseUrl: 'http://…'` while OMITTING pokeMode skipped the guard entirely and left an `{http baseUrl, pokeMode: true}` row — which the sender would then dial with the federation bearer in cleartext (scheme-derived `requireMtls` never fires for http). Computing the effective tuple makes `pokeMode=true` on a non-https baseUrl UNREPRESENTABLE through EVERY path: explicit true on http, explicit true with no baseUrl, an omitted pokeMode that preserves true while downgrading the baseUrl, and a re-pair that preserves both. `pokeMode=false` (effective) is always allowed.

### §362. ── THE RE-ANCHOR ON `full`

── THE RE-ANCHOR ON `full` (pre-M16 residual W1; drizzle/0042; R1 fix). SECURITY-SENSITIVE.

This side's own `sync_scope` for a peer being (or ending up) `full` is a SUPPORTED configuration state that used to wedge that peer permanently the first time it happened: while narrow, this side verified the peer's sparse chain and advanced its cursor with `last_applied_row_hash = NULL` (correct — it never held the range tail's hash). The strict path then sat in front of an ANCHORLESS cursor, whose absent hash `verifyJournalChain` reads as JOURNAL_GENESIS_HASH, so the peer's next run — contiguous, gap-free, authentic — could not link, and every subsequent import was refused forever. The prescribed recovery ("align both sync_scope values, re-export") was inert.

ORIGINALLY THIS WAS GATED ON THE TRANSITION (`previousScope.mode !== "full" && syncScope.mode === "full"`), which issues the permit exactly once, at the moment of the widen. That missed the ONLY population that actually existed: every peer already wedged by the pre-fix bug already has `sync_scope.mode === "full"` (the operator widened it with the OLD code, before this fix existed) and an anchorless cursor — so there is no transition left to catch, and the message's own prescribed recovery (re-pair with `--sync-scope full`) was a no-op transition-wise and issued nothing. THE FIX: key issuance off the RESULTING scope and the cursor's actual state, not off what it changed FROM. `permitCursorReanchor` itself already only touches a cursor that is anchorless (`last_applied_row_hash IS NULL AND last_applied_seq > 0` — see cursors-repo.ts), so calling it on every `pairPeer` that leaves this peer at `full` is safe and idempotent: a peer that is already strictly anchored has nothing for the predicate to match, and re-declaring the SAME `full` scope on an already-wedged peer now heals it, exactly as the refusal message says.

A scope of `full` being set is a LOCAL, AUTHENTICATED OPERATOR ACTION on config that is never carried on the wire and never reconciled, so it is the one signal it is legitimate to key a re-anchor off. ANCHORING OFF WIRE DATA — e.g. adopting the row hash of whatever entry the bundle claims sits at the cursor — would be an anchor chosen by the sender, which is precisely the splice this cursor exists to prevent. Nothing a peer sends reaches this function: `pairPeer` has exactly one caller, `POST /v1/federation/peers`, behind `federation:write`.

ONLY TO `full`. `full` is the only mode that demands a contiguous, anchored chain, so it is the only resulting scope that can strand an anchorless cursor. Narrowing needs no permit (sparse verification never consults the anchor) and gets none. `permitCursorReanchor` additionally refuses to touch any cursor that DOES hold a real anchor — see cursors-repo.ts.

### §363. SECURITY-SENSITIVE (M6 review fix — CRITICAL)

SECURITY-SENSITIVE (M6 review fix — CRITICAL): anchor the rotation to the AUTHENTICATED journal sequence, not a timestamp. The old key legitimately signed everything this domain has already applied from the peer (its cursor high-water mark); the new key takes over from there. Every future import applies only entries beyond the cursor, so the old key is hard-revoked for all content that will ever be applied — no timestamp fallback an attacker could backdate. The cosign key rides the SAME window, so the OLD cosign key is retained in its superseded window exactly as the Ed25519 key is (fully reconstructible history for both).

### §364. M16.2 phase A (E4) — `PATCH /v1/federation/peers/{id}`

M16.2 phase A (E4) — `PATCH /v1/federation/peers/{id}`: the NARROW, TRANSPORT-ONLY peer write.

SECURITY-CRITICAL, AND THE WHOLE REASON IT EXISTS. `pairPeer` is a re-pair: `publicKey` is REQUIRED in its body, a DIFFERENT value is a KEY ROTATION that supersedes the current key window and hard-revokes the old key at the applied-sequence anchor, and `name`/`role` are overwritten unconditionally. A Settings form built on it rotates a peer's TRUST ANCHOR the first time it drops or mangles the key. This function touches `federation_peers` ONLY — there is no reference to `federationPeerKeys` anywhere in its body, and its input type has no field that could carry key material — so no call, however malformed, can open, close or supersede a key window.

PAIR-TIME GUARD CENSUS — every validation `POST /federation/peers` performs, and how this path accounts for it. A new write door that silently skips the old door's checks is the bypass class this project has already been bitten by, so each one is listed and dispositioned, not assumed.
G1 requireAuth ....................... RE-APPLIED (route handler, identical call), and WITNESSED: `peer-patch.integration.test.ts` asserts 401 for an anonymous call. G2 authorize `federation:write` @ org . RE-APPLIED (route handler, identical call), and WITNESSED BY BEHAVIOUR since review round 4 (H2): `outposts-rbac.integration.test.ts` drives this route with an actor holding `object:write` but NOT `federation:write` and asserts 403 + an unchanged row — mutation-proven by deleting this route's `authorize` block. Before that, the census row was true of the code and UNPROVEN by the suite: every `authorize` block in this milestone could be deleted with the whole federation suite still green. G3 self-pair refusal ("cannot pair this domain with itself") .... N/A BY CONSTRUCTION: this route resolves an EXISTING `federation_peers` row and never inserts. An instance is never its own peer (`initFederationSelf` writes `federation_self`, not a peer row), so the id cannot resolve to self — an attempt 404s at `getPeerByIdOrName` before this function is reached. G4 `assertDeliveryTargetRooted` (SCP_DELIVERY_ROOTS / SCP_DELIVERY_S3_ENDPOINTS allowlists) ..................................... RE-APPLIED at the route, the same call pairing makes, so an out-of-root drop directory or an un-allowlisted S3 endpoint is refused before storage. G5 body schema validation (name length, `baseUrl` is a URL, `syncScope` union, `deliveryTarget` strict union incl. absolute traversal-free dirs / relative traversal-free prefixes / bare bucket, `pokeMode` boolean) ......... RE-APPLIED: `UpdateFederationPeerRequestSchema` reuses the very same `SyncScopeSchema`/`DeliveryTargetSchema` members and the same `z.string().url()`. G6 `trustDomainIdFromWire` boundary .... N/A: no wire domain id is accepted here. The brand comes from the RESOLVED existing row, which is stronger than validating an input. G7 M14.1/M14.3 poke-mode ⇒ https/mTLS baseUrl guard, over the EFFECTIVE POST-WRITE TUPLE ..................................... RE-APPLIED BELOW, and it MUST be: this route's fields merge with exactly the same opposite rules the re-pair path has (baseUrl: request wins when present; pokeMode: existing wins when absent), so keying it off the request alone would check a different tuple than the one persisted — the M14.3 hole verbatim. All four shapes stay unrepresentable: explicit poke on http, explicit poke with no baseUrl at all, an omitted pokeMode that preserves `true` while downgrading baseUrl to http, and a no-op patch on an already-bad row. G8 `permitCursorReanchor` when the request DECLARES a syncScope whose RESULT is `full` ..................................... RE-APPLIED BELOW. Widening a peer to `full` through this route must heal an anchorless cursor exactly as widening it through a re-pair does; otherwise the documented recovery ("set the scope to full") would work on one route and silently wedge the peer forever on the other. NARROWED in review round 4 (H8) by `input.syncScope !== undefined`: with absent-means-preserve, a PATCH that only set `name` also resolved to `full` and issued the permit, so a RENAME fired a scope-declaration guard. See the call site for the full note. G9 key-window rotation/superseding ..... DELIBERATELY ABSENT — the point of this route. No key material is representable in the input, and no `federationPeerKeys` write exists here, so the capability is structurally missing rather than conditionally skipped. G10 tri-state PRESERVE semantics for `deliveryTarget`/`pokeMode`/`cosignPublicKey` ..................................... RE-APPLIED for the two transport fields (absent preserves; `deliveryTarget: null` clears). `cosignPublicKey` is key material — see G9 — and is preserved untouched because nothing here writes the key window at all. G11 unconditional `name`/`role` overwrite .... INTENTIONALLY NARROWED: `name` is patched only when supplied, and `role` is NOT patchable at all. A peer's federation role is an identity-level assertion made at pairing (it decides whether this side pulls FROM or exports TO the peer, and which validation the boundary applies); a settings form must not be able to flip it. Changing a role remains a deliberate re-pair. G12 `(org_id, name)` UNIQUENESS .... NEW in review round 4 (H6), and it had to be, because this route is the reason `name` is patchable at all. `getPeerByIdOrName` resolves a non-UUID identifier BY NAME, so two peers sharing a name made a TRANSPORT WRITE land on an arbitrary one of them. Enforced in the DATABASE (drizzle/0045, with a self-healing backfill) rather than per-route, and surfaced here as a 409 instead of a 500.

### §365. Re-applied, but only when this call declares a scope

G8, re-applied — but ONLY when this call actually DECLARES a scope (review round 4, H8). Keyed off the RESULTING scope, never the transition, for exactly the reasons `pairPeer`'s long note gives: `permitCursorReanchor` only touches a cursor that is genuinely anchorless, so re-declaring `full` heals an already-wedged peer and is safe and idempotent.

`input.syncScope !== undefined` is the part that was missing, and it is a DOC-VS-CODE fix, not a security one. Absent-means-preserve meant a PATCH that only set `name` still resolved to `full` and still issued the permit — so a RENAME fired a one-shot re-anchor permit, while `cursors-repo.ts` and the G8 census row both describe the two call sites as "operator DECLARATIONS of this peer's own sync_scope". A rename is not a scope declaration. Nothing was exploitable (the anchorless-cursor predicate is the whole safety story and is unchanged), but a guard whose trigger is WIDER than every document describing it is the defect class this repo has now fixed several times — including `permitCursorReanchor`'s own header, rewritten once already for exactly this kind of drift.

### §366. `federationPeers.id` is a `uuid` column

`federationPeers.id` is a `uuid` column — comparing it against a non-UUID string (a plain peer NAME) is a Postgres type error, not merely a non-match, so the id branch of the OR is only included when `idOrName` actually parses as a UUID (mirrors `graph/objects-repo.ts`'s `idOrUrnCondition` convention for the identical id-or-friendly-name ergonomic). BOUNDARY (ADR-0021 D4): `idOrName` is an operator-supplied identifier that may be either a trust-domain id or a human peer name. The `isUuid` branch is exactly where it has been established to be the former, so that is where the brand is asserted.

### §367. Claims one peer's pull slot for the window, atomically

M14.4 (ADR-0009) — CLAIM one peer's pull slot for the current window, ATOMICALLY.

A single conditional `UPDATE … RETURNING`: the row's `last_pull_attempt_at` is advanced to `now` ONLY if it is NULL (never attempted — deliberately "due now", drizzle/0038) or older than `now - intervalSeconds`. Returns `true` when THIS caller won the slot, `false` when the peer was already claimed inside the window.

WHY A CONDITIONAL UPDATE AND NOT AN IN-MEMORY MAP (load-bearing): the scheduler runs on every worker replica. An in-process throttle would let N replicas each pull the same peer per window, multiplying the effective poll rate by the replica count and defeating "sparse" exactly where it matters most. Postgres row-locking during the UPDATE makes the claim mutually exclusive across replicas, processes, and restarts, with no new coordination primitive (charter principle 4).

`force` (the poke path, S4) SKIPS the window predicate but still stamps the attempt — a poke-woken tick must never be swallowed by the very due-gate the poke complements.

The threshold is computed from the CALLER's `now` rather than the database's `now()` purely so the scheduler can be driven by a deterministic test clock; the mutual exclusion comes from the atomic UPDATE, not from the clock source (two replicas with slightly skewed clocks still cannot both win the same row).

### §368. Stamps that this peer's poke was accepted

M14.4 (owner decision D2 — SELF-PROVING SPARSE) — stamp that this peer's poke was ACCEPTED. The M14.2 poke handler calls this after its consent + rate-limit gates pass. Until a peer has stamped at least once, the scheduler keeps it on the FREQUENT cadence no matter what the local `poke_mode` flag says: an outpost must never go sparse on the strength of its own flag alone (the commander's half may never have been enabled — silent staleness with no error anywhere).

## `apps/server/src/federation/pipeline-hook-federation.integration.test.ts`

### §369. OUTPOST-RUN PROBES, THE DOWNWARD HALF

OUTPOST-RUN PROBES, THE DOWNWARD HALF — a hook declared at the commander REACHES the outpost that will run it, and a retraction removes it there.

WHY THIS EXISTS
Probes cannot run at the commander: it does not reach into a domain, and the digest-pinned test bundle lives in the DOMAIN's own Gitea (D23). So the outpost runs them, which requires the declaration to travel — and `pipeline_hooks` federated nowhere. A filterless census of `apps/server/src/federation` for `pipeline_hooks` returned nothing before this change.

The journal is the transport rather than the graph because a hook row is deliberately a SIDE TABLE whose ownership derives from `component_object_id` (migration 0096's header, which explicitly declines a `managed_by_stack` column). Making hooks graph objects to ride `object_upsert` for free would reverse that decision to dodge a process step.

WHAT IS ASSERTED, AND WHY EACH IS NOT THE OBVIOUS ONE
```text
- THE ROW AT THE OUTPOST (case 1), not "the bundle contained an entry". An entry that exports
  and then fails to apply is the shape this whole session has been finding: emitted, carried,
  and installed nowhere.
- NO ECHO (case 2). The receiver must not re-journal what it was told, or two peers paired both
  ways loop forever. Asserted by exporting FROM the outpost afterwards and finding nothing —
  the only check that distinguishes "did not echo" from "echoed and we did not look".
- A RETRACTION REMOVES IT (case 3). "Until they hear otherwise" is the tombstone; without it a
  probe deleted at the commander keeps running in the domain forever.
- A MALFORMED ENTRY IS DROPPED, NOT THROWN (case 4). A throw mid-bundle wedges a peer's ENTIRE
  signed journal — the failure mode `import-repo.ts` warns about repeatedly. This is the case
  that makes the tolerance real rather than intended.
```

### §370. WHAT I SET OUT TO TEST AND WHAT IS ACTUALLY TRUE

WHAT I SET OUT TO TEST AND WHAT IS ACTUALLY TRUE — recorded because the difference matters. The intent was to prove the import's malformed-payload branch drops one bad entry without wedging the bundle (the failure `import-repo.ts` warns about throughout). It cannot be reached that way: mutating an entry invalidates the bundle's signature, and import REFUSES the whole thing with 409 before any payload is parsed. Measured, not assumed.

That is the stronger property, so it is what this asserts. The malformed-payload branch remains as defence in depth for an entry a peer produces legitimately but this version cannot understand — a downgrade, or a future kind — and it is deliberately NOT reachable by tampering, which the signature already covers.

### §371. PROVENANCE IS STAMPED BY THE RECEIVER

PROVENANCE IS STAMPED BY THE RECEIVER. The outpost recorded this as `executor_observed`; the commander records what IT knows — that a peer reported it. Asserting the source is what makes that rule testable rather than aspirational: a receiver that trusted the payload would show `executor_observed` here and be claiming the commander observed a run in someone else's domain.

## `apps/server/src/federation/poke-metrics.ts`

### §372. Process-local counters for the inbound poke path

M14.4 (S7) — process-local counters for the INBOUND poke path, so the split-topology hole is DETECTABLE rather than a silent one-line log.

THE HOLE: a poke is honored by whatever process serves the HTTPS request. If that process is a pure `role=api` replica (or one where the sync/inbox loops are disabled), there is no job queue to enqueue the wake on — the poke returns `202 {accepted:true, woken:false}` and NOTHING pulls. That is by design ("accepted-but-no-op"; the sparse safety-net is the reliability floor), but a deployment where it happens on EVERY poke has effectively lost poke-mode while every dashboard still says the endpoint is healthy. A counter plus a WARN makes "my pokes are accepted and do nothing" visible without inventing a metrics backend (charter principle 4 — no new dependency).

Deliberately in-process and unexported to any scrape endpoint: the values ride the structured warn log (`notWoken` is included on every warn) and are readable by tests. If/when an instance-level metrics surface lands, this is the single place to hang it off.

### §373. A test seam stood here with zero callers, and was removed

A `resetPokeWakeStats()` "test seam" stood here with ZERO callers, including tests. Removed as part of the census that fixed the id-keyed property-schema validator cache: an exported reset/invalidate function with no caller is the exact tell that let that bug survive a green suite for its whole life, because it reads as a guard that exists. These counters need no reset — they are monotonic and nothing derives a verdict from them — so the honest state is no seam. Should a test ever need one, add it back WITH the caller in the same commit.

## `apps/server/src/federation/poke-rate-limit.ts`

### §374. The inbound federation poke rate limit

M14.2 (ADR-0009, docs/proposals/outpost-poke.md §"Design principles" 5) — the inbound federation poke's PER-PEER token bucket.

The poke is contentless and idempotent: N pokes in a window must trigger AT MOST ONE pull (the pull drains everything pending regardless of how many pokes prompted it), so a spoofed or replayed burst can do no more than one authorized pull's worth of work — no dedupe ledger is needed, just a fixed low cap that drops the excess with a 429. This is a deliberately simple in-memory bucket, NOT a durable/clustered limiter: the worst case a slipped-through extra poke can cause is one more (already-authorized, idempotent) pull, so per-process state is sufficient and the charter's PostgreSQL-only-required-dependency invariant is untouched (no new stateful service).

Default cap is 1 with a short refill window: the first poke from a peer consumes the token and wakes the pull; further pokes from that peer within the window are dropped (429) until the window refills. Keyed per `(org, peer)` so one noisy commander can never starve another's pokes.

## `apps/server/src/federation/poke-sender.integration.test.ts`

### §375. The commander poke sender, end to end over real mTLS

M14.3 — the COMMANDER POKE SENDER, end-to-end against real Postgres + a real mTLS listener (docs/proposals/outpost-poke.md §"Milestone scope", ADR-0009).

A commander (the SENDER, presenting its enrolled `urn:scp:domain:<commanderDomainId>` client cert) pokes an outpost (the RECEIVER, running a real HTTPS mTLS listener with the M14.2 poke endpoint and receiver-side pokeMode=true for the commander). The wake is asserted by injecting a RECORDING pg-boss into the outpost's deps: an accepted poke enqueues exactly one immediate `FEDERATION_SYNC_QUEUE` tick (the pull runs on the loop's worker, never inline).

Proves: (1) a poke-mode outpost peer IS poked over mTLS; (2) a pokeMode=false peer is NOT; (3) an unreachable peer fails best-effort — no throw, no escalation, the live peer still poked; (4) coalescing — multiple signals in one window collapse to at most one poke. Skipped wholesale when `openssl` is unavailable (mirrors the M14.0/M14.2 mTLS suites).

### §376. `pairPeer`'s effective-state guard makes {pokeMode

`pairPeer`'s effective-state guard makes {pokeMode: true, http baseUrl} unrepresentable, so the only way to get such a row is to bypass the repo entirely (a hand-edited DB, or a row predating the guard). The SENDER must not depend on the row being well-formed: dialing it would put `Authorization: Bearer <federation bearer>` on the wire in CLEARTEXT with no mutual auth (scheme-derived requireMtls never fires for http). Write the bad row by raw UPDATE and prove the sender skips it entirely — it is not even in the outcome set, and NOTHING is dialed.

## `apps/server/src/federation/poke-sender.test.ts`

### §377. Unit coverage for the poke sender's pure pieces

M14.3 unit coverage for the commander poke SENDER's pure pieces: the poke-target gate (pokeMode + downstream-role + baseUrl), the fail-closed contentless dial, and the send-side coalesce bucket. The two-domain network round trip is in `poke-sender.integration.test.ts`.

### §378. The credential-leak regression

The credential-leak regression: `requireMtls` used to be DERIVED from the target's own scheme, so a plain-http poke target opted ITSELF out of mTLS and would have received `Authorization: Bearer <federation bearer>` in CLEARTEXT with no mutual authentication. It is now the CONSTANT true plus an outright non-https refusal. Proven against a REAL http listener: it must never see a single request.

### §379. UNREADABLE mTLS MATERIAL DISABLES THE SENDER

UNREADABLE mTLS MATERIAL DISABLES THE SENDER — the log and the behavior have to agree.

`resolveFederationClientMtls` throws when the two env paths are set but the files cannot be read (or only one is set). The sender caught that, logged "inert", and then computed `active` as `Boolean(mtls) || federationClientMtlsConfigured(env)` — and that second disjunct is a pure presence check over exactly the paths that are set in this case. So it stayed ACTIVE: a peer scan (a DB query) per org per outbox batch, and a fail-closed refusal per peer per coalesce window, forever, while the operator had been told it was doing nothing.

The db is a Proxy that RECORDS every property access, so "did not scan peers" is measured rather than inferred from an absent log line — the round's own catch swallows anything thrown inside it, which is exactly how the active-after-failure sender stayed invisible.

## `apps/server/src/federation/poke-sender.ts`

### §380. The commander-side poke sender

M14.3 (ADR-0009, docs/proposals/outpost-poke.md §"Milestone scope") — the COMMANDER POKE SENDER.

The OTHER half of poke-mode: M14.2 built the inbound endpoint an outpost exposes; this is the commander sending the contentless wake to it. When this instance produces something a downstream peer should pull (a config-journal append — every graph/coordination mutation writes one in the SAME tx that writes the outbox row, journal-repo.ts), a poke-mode peer is nudged to pull NOW instead of waiting for its interval, and best-effort so.

## The trigger is OUTBOX-DERIVED (DESIGN §5/§8) — no new event source

The sender does NOT invent a feed. It hangs off the EXISTING transactional-outbox relay (events/outbox-relay.ts): after the relay commits a batch, it hands the sender the distinct org ids that just produced events (`onEventsRelayed`), post-commit and fire-and-forget — NEVER in the mutation's own transaction. Any outbox activity for an org means that commander mutated something (and thus appended journal entries a peer would pull), so the sender pokes that org's poke-mode downstream peers. A pull is idempotent and drains everything pending, so an occasional poke that finds nothing new is a harmless no-op — the deliberately-sparse over-poke this design accepts (Simplicity first). The per-peer coalescer bounds it to at most one poke per window.

## Best-effort, NOT reliable (the DECIDED model — proposal §4, owner 2026-07-18)

A poke is FIRE-AND-FORGET. A failed/refused/timed-out poke is logged at debug and dropped — it is NOT retried-to-confirmation and it NEVER blocks or fails the underlying journal append / transfer (which already committed; this runs off the relay, after the fact). The receiver's sparse safety-net reconcile + next poll/reconnect self-heals a missed poke within a bounded window. This is a latency optimization over a reliable floor, never a delivery guarantee. (Reliable poke-delivery / retry-until-pull-confirmed was considered and REJECTED.)

## Opt-in / default-off (SCOPE 5)

Inert unless BOTH hold: (a) the peer is `pokeMode=true` AND a downstream role (outpost/retrans) AND its `baseUrl` is an https/mTLS-capable endpoint — see `isPokeTarget`; a poll-mode peer is never poked, and a `commander`-role (UPSTREAM) peer is never poked (the shared `pokeMode` column means "I accept pokes from it" on that side, not "I poke it" — filtering by role keeps an outpost from poking its own commander). And (b) this instance has outbound client-cert material (`SCP_FEDERATION_MTLS_CERT_FILE`/`_KEY_FILE`); without it the whole sender is inert and the fail-closed dialer would refuse anyway.

## Fail-closed at THREE layers (M14.3 hardening) — the poke is always mutually authenticated

A poke carries no signed payload of its own, so the mTLS transport is the ONLY thing proving the caller is the enrolled commander (ADR-0009 §5). Three independent layers enforce that, so no single bad row or wrong merge can put the federation bearer on the wire in cleartext: 1. `pairPeer`'s pair-time guard checks the EFFECTIVE post-write `(pokeMode, baseUrl)` tuple, making `pokeMode=true` on a non-https baseUrl unrepresentable through every write path; 2. `isPokeTarget` independently requires an https baseUrl, so a malformed row is SKIPPED rather than dialed; and 3. `sendPokeToPeer` refuses a non-https target outright and passes `requireMtls: true` as a CONSTANT (never scheme-derived), so the dial refuses before any socket is opened.

## Coalesce / rate-limit (SCOPE 4 — be a good citizen)

The receiver is already idempotent + rate-limited, but the sender does not spam it: a per-`(org, peer)` token bucket (the SAME `PokeRateLimiter` the receiver uses, capacity 1) collapses multiple pending signals in one short window into at most one poke. Mirrors the send window to the receiver's `SCP_FEDERATION_POKE_MIN_INTERVAL_SECONDS` knob so the two sides are symmetric.

### §381. Is this peer a poke TARGET for the sender?

Is this peer a poke TARGET for the sender? True iff it is a DOWNSTREAM peer (outpost/retrans) that has opted into pokes (`pokeMode`), has a `baseUrl` to dial, AND that baseUrl is an https/mTLS-capable endpoint. A `commander`-role peer is UPSTREAM and is never poked (see the module header on the shared `pokeMode` column's per-side meaning).

## Why the https requirement is part of the TARGET TEST (fail-closed, defense in depth)

`pokeMode=true` MEANS "mTLS-capable peer": the poke has to authenticate the caller as the enrolled commander (ADR-0009 §5), and only the mTLS transport carries that identity. `pairPeer`'s effective-state guard makes `pokeMode=true` on a non-https baseUrl UNREPRESENTABLE, but the sender must not DEPEND on the row being well-formed: a non-https poke-mode row (a hand-edited DB, a row predating the guard) must be SKIPPED like a poll-mode peer rather than dialed. Dialing it would put the federation bearer on the wire in CLEARTEXT with no mutual authentication — the scheme-derived `requireMtls` never fires for an `http://` URL, so nothing downstream would have refused it.

### §382. Poke every poke-mode downstream peer of ONE org, best-effort

Poke every poke-mode downstream peer of ONE org, best-effort. NEVER throws — each peer's outcome (sent / coalesced / fail-closed refused / transient error) is captured and returned so one bad or unreachable peer never affects another, and nothing propagates back to the outbox relay. When `ctx.limiter` is supplied, a peer whose bucket is empty this window is `coalesced` (not dialed).

### §383. Builds the sender wired into the outbox relay

Builds the commander poke sender wired into the outbox relay in main.ts (worker/all role only). INERT unless outbound client-cert material is present AND readable — `onEventsRelayed` is then a no-op (no peer scan, no dial), and material that is configured but unreadable says so at `console.error`. Otherwise each distinct org that produced outbox events triggers a best-effort, coalesced poke round to that org's poke-mode downstream peers, off the relay's post-commit path.

### §384. Resolve outbound client-cert material ONCE

Resolve outbound client-cert material ONCE (not per outbox batch — it reads files). `null` from opts means "explicitly none"; a half-configured or unreadable pair throws in `resolveFederationClientMtls` — for this best-effort optimization we swallow that into INERT rather than crash boot (the sync loop / dialer surface the misconfig loudly elsewhere).

THE THROW PATH DISABLES THE SENDER, and it has to say so itself. `federationClientMtlsConfigured` is a pure presence check over the two env paths, which is exactly what is TRUE when resolution threw (paths set, material unreadable) — so ORing it in left `active` true after a failure that had just logged "inert". The sender then scanned peers and produced a fail-closed refusal per peer per coalesce window forever, while the boot log said it was doing nothing.

## `apps/server/src/federation/promotion-checksum.test.ts`

### §385. M17.3 (E3) CHECKSUM-INVARIANCE unit test

M17.3 (E3) CHECKSUM-INVARIANCE unit test — the crux of the EXPAND phase: the TYPED `artifacts[]` set is EXCLUDED from the Ed25519 checksum, so adding it to a bundle must not change the checksum by a single byte. This pins that the checksum payload is exactly `{header, change, controlOutcomes, approvals, artifactDigests}` and never `artifacts`, and that `artifactDigests` (which IS in the payload) stays fully sensitive to tampering (fail-closed).

## `apps/server/src/federation/promotion-repo.ts`

### §386. Promotion bundles, and their grafted semantics

Promotion Bundles (DESIGN.md §13 "federated change promotion" — grafted semantics). A change promoted toward another domain exports as change + provenance + control outcomes + artifact digests + per-approval Ed25519 attestations; the importing domain instantiates its OWN LOCAL Change (`imported_from_domain` set) which must still pass LOCAL policies/controls/approvals — imported approvals are attached as read-only EVIDENCE, never local authority (never inserted into `approval_votes`/`approval_requests`, which is what quorum-checking gates actually read).

SECURITY-SENSITIVE (M6 PR body flag — attestation validation must bind approver identity + exactly what was approved, and reject on ANY mismatch): `importPromotionBundle` validates EVERY approval attestation against the EXPORTING domain's OWN registered public key (not merely the key embedded in the attestation itself — `signAttestation`'s output is self-consistent by construction, so checking only that would let an attacker forge an "approval" by signing with their own throwaway key and simply mislabeling its origin). A mismatch — wrong signer, wrong key, or `approvedObjectUrn` not matching the change actually being imported — marks that specific approval `verified: false` (rejected as evidence) WITHOUT aborting the whole import: the local Change still lands in `proposed` and must earn its own LOCAL approvals regardless.

### §387. The exact field set the bundle checksum is computed over

The EXACT field set the promotion bundle's Ed25519 checksum is computed over — the SINGLE source of that list, shared by export and import so the two can never drift (checksum covers the HEADER too — M6 review fix). M17.3 (E3): `artifacts` is DELIBERATELY NOT in this list, so adding the typed artifact set to a bundle does not change its checksum or signature; a bundle with `artifacts` present hashes byte-identically to a v1 bundle without it. `computeBundleChecksum` canonicalizes by sorting keys deeply, so the field order here does not affect the result.

### §388. M17.3 (E6) — the outcome of an export

M17.3 (E6) — the outcome of an export. On success the caller sends `bundle`; on a scan-gate REFUSAL the caller turns `{ refused: true }` into a 409 carrying `decisionId` (like every other blocked response — DESIGN.md §6/§10.4). The refusal is FAIL-CLOSED: the Decision has ALREADY been persisted (committed) by the time this returns, so `decisionId` resolves.

### §389. M17.3 (E6) EXPORT SCAN GATE

M17.3 (E6) EXPORT SCAN GATE — the boundary re-check (defense in depth). For EACH SUBSTANTIVE artifact (everything in `artifacts[]` EXCEPT `type: "blob"` — the SBOM is the scan's OUTPUT, not a scanned input, so it is EXEMPT) there MUST exist a CURRENT, digest-bound, floor-satisfying scan outcome from an ADMITTED PRODUCER, judged under the scan-exclusion set that is in force NOW. This is UNIVERSAL and fail-closed: a MISSING scan refuses exactly like a FAILED one, whether or not a scan-requirement policy was ever bound. This NEVER runs a scan (coordinate-not-execute) — it only re-verifies an outcome an execution system already produced.

THE RULE ITSELF LIVES IN `scan-evidence.ts`, shared with the promotion scan step's short-circuit. Its module doc records the four properties that changed here and why each was an authorization defect: a scan outcome was identified by the SHAPE of its evidence (which `webhook-control` echoes verbatim from an operator-configured URL, so a tenant could manufacture one), any HISTORICAL passing row satisfied the gate forever, the gate applied no threshold of its own, and (M22.9) a passing row kept authorizing crossings under an exclusion set that had since been withdrawn.

Takes the RAW `control_runs` rows, not the bundle's `controlOutcomes` projection. The projection drops `plugin_module`, `control_object_id` and `created_at` — which are exactly producer identity and recency — and it is IN the Ed25519 checksum payload (`promotionChecksumPayload`), so widening it to carry them would change every bundle's checksum and break verification at every peer. The gate reads the rows; the bundle keeps its shape byte-for-byte.

### §390. Export a bundle, hard-gating on scans and co-signing it

Export a Promotion Bundle, HARD-GATING on scans at the boundary and CO-SIGNING a self-binding manifest (M17.3 E6). Takes a `Db` (not a single `TenantTx`) because it spans two transaction phases around an out-of-transaction cosign subprocess — the same "never hold a pooled connection open across a cosign subprocess" invariant `cosign-keys.ts`/E5 already honor: 1. Resolve the org's cosign keypair (may KEYGEN-subprocess on first use) OUTSIDE any tx. 2. tx: gather change/evidence/artifacts + run the scan gate. On refusal, persist a `block` Decision + audit event and RETURN the refusal (the tx COMMITS, so `decisionId` survives). 3. Cosign-sign the manifest OUTSIDE any tx (materialize key → sign-blob → scrub, in @scp/cosign). 4. tx: Ed25519-checksum + sign the (manifest-EXCLUDED) envelope, record the transfer, return.

### §391. Phase 1.2 — A DOMAIN-LOCAL CHANGE IS NEVER PROMOTED

Phase 1.2 — A DOMAIN-LOCAL CHANGE IS NEVER PROMOTED (M20.4, ADR-0031 §5).

THIS IS A SECOND EGRESS, and the reason it needs its own guard. ADR-0031's withholding works by never allocating journal sequences (§2), which covers the SYNC path completely — but a promotion bundle is not built from the journal. `exportPromotionBundle` reads the change directly, names a peer explicitly, and would happily carry a domain-local change's urn, name, properties and target list across a boundary. The sync guarantee simply does not reach here.

Refused rather than filtered, because a promotion is an operator naming a destination: silently exporting nothing would look like success. The refusal is also NOT a scan verdict and must never be read as one — it fires BEFORE the scan step, so a domain-local change is not "exempted from scanning", it is refused a crossing outright. That ordering is the point (ADR-0031 §7): locality never becomes an input to E6, in either direction.

ADR-0018's standing invariant made concrete: "if a future feature adds another cross-boundary egress, it must carry the same gate." This one did, and this is that check.

### §392. Phase 1.5 — THE COMMANDER'S PROMOTION SCAN STEP

Phase 1.5 — THE COMMANDER'S PROMOTION SCAN STEP (ADR-0020, proposal §13.3), BEFORE the E6 gate so its managed evidence exists when the gate reads. It deposits digest-bound managed-scan `control_runs` rows for every substantive artifact NOT already covered by org-pipeline evidence; the UNCHANGED gate below then consumes them. `scanRunner === null` disables the step (the legacy, org-pipeline-only path the pre-13.3a tests exercise); undefined ⇒ the default server-side skopeo-pull + `scp-managed-scan` runner (itself inert, producing no evidence, when managed scanning is not enabled — so a boundary export then still refuses fail-closed). Runs OUTSIDE any tx (it pulls bytes + launches containers — the subprocess invariant this function already honors).

### §393. Builds the typed artifact set from the change's refs

M17.3 (E3): build the TYPED artifact set from the change's tracked refs, then project the flat `artifactDigests` FROM it. `artifacts` is the rich source; `artifactDigests` is the backward- compatible flattening an older outpost reads. The OCI digest(s) are carried VERBATIM (identical to the pre-E3 projection); the SBOM travels as a `blob` entry. The reader is SHARED with the component pipeline's artifact projection (`coordination/artifact-facts.ts`, §9.3) so the digests the bundle carries and the digests the tile shows are read the same way from the same keys.

### §394. M17.3 (E6) EXPORT SCAN GATE

M17.3 (E6) EXPORT SCAN GATE — HARD-REFUSE, fail-closed. The SBOM (`type: "blob"`) is EXEMPT (it is the scan's output). EDGE CASE: a promotion carrying NO substantive artifact has nothing to scan, so the gate passes VACUOUSLY — a metadata-only promotion (config/policy-only, no oci/rpm/deb/npm/config/infra content) still exports (and still carries a signed manifest over an empty artifact set). "Every substantive artifact is scanned" is trivially true of zero. THE SUBSTANTIVE SET IS NOT FILTERED HERE — `substantiveArtifactsOf` is the ONE definition, shared with the component pipeline tile's read-only re-run of this same gate. It excludes the SBOM blob (the scan's output) and the change's DECLARED test bundle (D23: signature-verified per hop, never scanned — scan stays image-only per M13). See that function's doc for why the bundle exclusion is keyed on the digest the change declared rather than on a type or a name.

### §395. The exclusion set in force right now, resolved by this gate

M22.9 (ADR-0033 §10) — THE EXCLUSION SET IN FORCE RIGHT NOW, resolved BY THIS GATE.

Not taken from the scan step that just ran, and that is the whole point. A boundary check whose input is handed to it by the step it exists to double-check goes inert exactly when the step does — and this call site already has a switch that does that (`scanRunner: null` skips the step entirely, and a default runner is inert whenever managed scanning is off). The gate reads the graph itself, so the crossing is held to the set an operator can see, whatever ran before.

Only when there is something to gate: a metadata-only promotion passes the gate vacuously, so paying for a policy resolution there would buy nothing and would put a CEL evaluation on the one export path that never had one.

### §396. WHICH of the five narrowings refused, machine-readably

WHICH of the five narrowings refused, machine-readably. A reader of this Decision has to be able to tell "nothing scanned this" from "something scanned it and failed" from "the outcome came from a control that is not a scanner" from "it passed under a waiver that has since expired" without parsing prose — the prose is for the human, this is for the query (charter principle 6).

### §397. The local boundary stamp is stripped from the wire payload

M16.1 (I1): the LOCAL boundary-checksum stamp is stripped from the wire payload, so a re-export of an already-exported change produces a byte-identical canonical bundle string (and hence the same Ed25519 checksum) as it would have before this key existed. The exporter's ledger checksums are meaningless on the far side — the receiver stamps its own. §9.4: the SAME holds for `promotionExports[]` (what this exporter signed for OTHER peers) — local bookkeeping, stripped for the same byte-identity reason.

### §398. M16.1 (I1) — the per-change join

M16.1 (I1) — the per-change join. Written in the SAME tx as the ledger row it points at, so the two can never disagree. NOTE the honesty consequence recorded in `boundary-segment.ts`: this row is and stays `created` on THIS instance (the ledger is INSERT-only and every `submitted`/`confirmed` row is written by a LATER hop's own instance), so the boundary segment may say "exported" here and must call the handoff unknown.

§9.4 (pipeline-substrate-registry-scan.md) — AND WHAT WAS SIGNED. Under the SAME row lock and in the SAME UPDATE, the record of this export: peer, when, the checksum (the join to the ledger row above), the manifest, its cosign signature (phase 3, outside any tx — persisted here in the tx that already exists), and the fingerprint of the key that signed it. Before this the exporter kept nothing of what it signed; only the importer did.

### §399. Mint artifact objects here, and only here on the export side

ADR-0045 D2 — MINT ARTIFACT OBJECTS HERE, and only here on the export side: the manifest is SIGNED (phase 3, above) and the boundary stamp naming it is written in this same statement's transaction, so this call fires exactly when the commander's attestation is real. Reads the signed manifest's own artifact set (not `artifactSet` from phase 2) so the minted identities are provably the ones the signature covers — the SAME set, not a second read of it.

### §400. Receiver-side verification of the self-binding manifest

M17.4(a) / M15.2 — the RECEIVER-side verification of the commander's cosign-signed SELF-BINDING promotion manifest (the send-side counterpart is `buildPromotionManifest` + the E6 export gate). This is the outpost's universal pre-deploy validation (ADR-0011): ONE implementation runs at EVERY receiving hop — a commander importing from a peer, or (M15.2) an outpost verifying a commander-promoted artifact BEFORE deploy. The outpost NEVER re-scans — receiver-side never-re-scan is UNCHANGED (ADR-0013/ADR-0015 §6a); the one scan now executes at the commander, before signing, per promotion journey (ADR-0020) — this gate re-verifies the signed metadata, it does not re-run any scan.

Metadata-only + coordinate-not-execute: it checks digests/signatures/identity, never artifact BYTES (those are absent from a federation bundle — ADR-0009). Per-artifact `cosign verify` of each artifact's ORIGIN `signatureRef` is part-(b), DEFERRED to M15.5 (the unresolved artifact-bytes channel — ADR-0015 §6b, the "honest open gap"): it needs the bytes at the outpost's Gitea/registry and is NOT half-built here.

FAIL-CLOSED over five properties, in order: 1. SIGNATURE — `cosign verify-blob canonicalStringify(manifest)` against the EXPORTER peer's registered cosign pubkey (E5) must return true (the EXACT bytes phase-3 of export signed). 2. SET-EQUALITY — `bundle.artifacts` (typed, `undefined`→`[]`) EXACTLY equals `manifest.artifacts` as a MULTISET over `{type,digest,signatureRef}` (equal cardinality + membership; no add/substitute). Manifest entries carry no `location`/`format`, so only those three fields are compared. This is the ONLY thing protecting `bundle.artifacts` — it is EXCLUDED from the Ed25519 checksum (E3), so nothing else binds it. 3. THE TIE — `bundle.artifactDigests` (which IS in the Ed25519 checksum) EQUALS `manifest.artifacts.map(a => a.digest)` as a multiset. This binds the cosign-anchored set to the Ed25519-anchored set so neither can be tampered independently of the other. 4. SELF-BINDING — the manifest's `sourceChangeObjectId`/`exporterDomainId`/`peerDomainId`/ `changeUrn` each equal the bundle's, blocking a manifest lifted from a different bundle. 5. BACK-COMPAT + DOWNGRADE DEFENSE — absent manifest AND the peer has NO cosign key => ACCEPT (a genuine pre-E5/E6 Ed25519-only bundle). Absent manifest BUT the peer HAS a cosign key => DOWNGRADE ATTACK => FAIL-CLOSED (an attacker stripped the manifest to dodge this gate). A PRESENT manifest is ALWAYS verified — including when no cosign key is registered, which then fails closed (present but unverifiable).

Pure of the DB and of any transaction: the ONLY side effect is the `verifyBlob` cosign SUBPROCESS (step 1), which is exactly why `importPromotionBundle` calls this OUTSIDE its apply tx (the codebase forbids holding a pooled connection across a cosign subprocess — see `exportPromotionBundle`).

### §401. Import a Promotion Bundle

Import a Promotion Bundle. Takes a `Db` (not a single `TenantTx`) because M17.4(a)'s manifest verification runs a cosign `verify-blob` SUBPROCESS, and the codebase forbids holding a pooled connection open across a cosign subprocess (`exportPromotionBundle` splits phases for exactly this reason). Three phases around the out-of-tx subprocess: 1. tx: address-to-self + resolve exporter peer + Ed25519 checksum/signature gate + resolve the peer's cosign pubkey. (No cosign subprocess yet — pure DB.) 2. NO tx: M17.4(a) `verifyPromotionManifest` — the cosign subprocess + set/tie/self-binding/ downgrade checks. On failure, persist a `block` Decision + hash-chained audit event in a fresh tx and throw a 409 carrying `decision_id` (mirrors the export gate — DESIGN §6/§10.4). 3. tx: apply — propose the local Change, attach approval evidence, record the transfer.

### §402. 1. Bundle-level checksum + signature

1. Bundle-level checksum + signature — fail closed, exactly like a sync bundle. Checksum covers the header (M6 review fix — CRITICAL). A promotion bundle carries no journal sequence to anchor key selection to, so it is verified against the peer's CURRENT (non-superseded) key — NEVER a timestamp-selected key (that was the `bundle.header.exportedAt` / `evidence.record.timestamp` backdating vector). A rotated-away key is hard-revoked for promotion: a bundle it signed no longer verifies once the peer has rotated. `artifacts` (M17.3 E3) is EXCLUDED from this recompute exactly as it is at export — the typed set never participates in checksum/signature verification in the EXPAND phase.

### §403. Phase two: manifest verification, outside any transaction

Phase 2 — M17.4(a) / M15.2 manifest verification, OUTSIDE any tx (cosign `verify-blob` subprocess). This is metadata-only (digests/signatures/identity) and complete without artifact BYTES: it proves "these are the authorized digests" and records the verified `artifacts[]` set on the imported change's `sourceRef`. M17.4(b) is the complementary BYTE verify — per-artifact `cosign verify` of each authorized artifact at the outpost's local registry where the bytes land — and it deliberately runs LATER, as a PRE-DEPLOY GATE (coordination/pre-deploy-gate.ts), NOT here: a federation bundle carries no bytes (ADR-0009) and the operator side-loads them AFTER this metadata import. Byte TRANSPORT itself remains M15.5.

### §404. M12 P4B (owner ruling, coupled-pipelines.md §8 Q2)

M12 P4B (owner ruling, coupled-pipelines.md §8 Q2): STRIP `requires` on promotion. The COMMANDER is the single coordination point — it held the software release in `waiting` until its infra prerequisite reached `validating` there, and its promotion of this bundle IS the go-ahead. Re- evaluating the coupling locally in the receiving outpost would either be redundant (the commander already enforced it) or DEADLOCK (an outpost whose infra is commander-driven has no local infra change to satisfy the key). `provides` is preserved — a promoted infra change should still be able to satisfy a LOCALLY-authored outpost waiter.

ADR-0028: STRIP `stageDependencies` too, on the SAME precedent and for a sharper reason — what it replaces is not redundancy but a SILENT FAIL-OPEN. A promoted change is re-proposed LOCALLY with this domain's own origin, so reconcile's foreign-origin skip does not exclude it and the outpost really does evaluate the coupling. But `change_wave_targets` and `observed_state` are journaled by nothing, and `relationship_upsert` ships only under sync scope `full`; under `policies_only`/`changes_only`/`status_only` the depended-on component is not present here at all, so every verdict resolves to `not_placed` -> SATISFIED and the release fires with no hold and no record. ADR-0028's own Consequences call that the worst available answer.

Stripping defers D5 (federation ruling, still open) cleanly instead of shipping that fail-open: the commander held the trigger until the coupling was satisfied THERE, and its promotion of this bundle is the go-ahead. When D5 lands, this is the seam that changes.

### §405. ADR-0045 D2 — MINT ARTIFACT OBJECTS HERE

ADR-0045 D2 — MINT ARTIFACT OBJECTS HERE: `applyPromotionImport` runs ONLY after `importPromotionBundle`'s phase 2 `verifyPromotionManifest` returned `ok: true` — signature AND, when a manifest is present, SET-EQUALITY (`bundle.artifacts` proven to equal the cosign-signed `manifest.artifacts` multiset) AND the tie back to the Ed25519-checksummed `artifactDigests`. `bundle.artifacts` is therefore this receiver's own attested anchor for "this digest arrived here" — absent (`undefined`) only for a pre-E3 bundle, in which case there is nothing typed to mint from and none is minted (never fabricated from the untyped flat `artifactDigests` alone, which carries no `type`). `firstPromotedChangeId` names THIS domain's own newly-proposed change (`change.id`, just above) — the receiver's local anchor, not the exporter's.

### §406. M12 P4B §8 Q2, the AUDIT half of the strip above

M12 P4B §8 Q2, the AUDIT half of the strip above: when the bundle's change actually CARRIED a `requires` that was stripped, the strip itself is an engine verdict (charter principle 6 — every engine verdict persists a Decision with its inputs) and must not be invisible. Written in the SAME transaction as the import, with the stripped requirements pinned VERBATIM in the Decision inputs, so an outpost operator asking "why didn't this coupled release wait here?" gets a durable, queryable answer rather than an absence. No Decision when nothing was stripped — the common uncoupled promotion stays byte-identical.

### §407. ADR-0028, the AUDIT half of the `stageDependencies` strip

ADR-0028, the AUDIT half of the `stageDependencies` strip. Same rule, same reason: a coupling that vanishes with no record is the exact failure this feature exists to prevent, so the strip is a persisted verdict rather than a deletion. Recorded under the hold's OWN kind, so the row says which mechanism removed the declaration rather than leaving an unexplained absence.

HOW AN OPERATOR ACTUALLY FINDS IT. By the promoted change — `scp change explain <id>` or `scp decision list --subject-id <change-id>` — and, since ADR-0028 increment 4, WITHOUT the change id: `scp decision list --kind stage_dependency`. Two earlier versions of this comment were each wrong in the opposite direction: the first promised that filter before it existed (worse than a missing feature, because it read as a working answer to "what happened to my coupling here?" for exactly the person who does not have the change id), and the second recorded its absence. The filter now exists — `DecisionListQuerySchema.kind`, `listDecisions`'s `kind` condition, `--kind` on the CLI, and drizzle/0056's index so it is a probe rather than a table scan.

WHAT THE FILTER STILL WILL NOT DO IS TELL YOU WHICH THING HAPPENED. This row and the hold share the kind and differ only in verdict: `allow` here (stripped, enforced upstream), `hold` in `reconcile.ts` (a trigger withheld). On an outpost the newest `stage_dependency` row of an imported change is therefore THIS one, whatever the change is doing locally — read the verdict, and for "is it held right now" read `explain`'s `stageDependencyStatus`, which re-evaluates the predicate live rather than believing any persisted row.

Nothing stripped, nothing written.

### §408. Validate against the peer's CURRENT registered key

Validate against the peer's CURRENT registered key — never the attestation's own embedded `publicKey` (self-consistent by construction, so trusting it would let an attacker sign an "approval" with a throwaway key and mislabel its origin) and never a key selected by the signer-chosen `evidence.record.timestamp` (the backdating vector — M6 review fix, CRITICAL). An approval signed by a since-rotated key is marked verified:false (non-fatal — the local change must earn its OWN approvals regardless), preserving compromise recovery.

### §409. M13.1b — THE CAUSAL SEED for the unattended onward BYTE hop

M13.1b — THE CAUSAL SEED for the unattended onward BYTE hop (proposal §13.1: "when a promotion import succeeds on a `retrans`-role instance, the loop schedules `buildRelayTarball` for it"). Written HERE, in the import's own transaction, rather than derived later by a predicate scan over `changes`: "an imported change carrying a verified manifest with artifacts" is equally true of every promotion the HIGH-side retrans successfully forwarded, so a scan would enumerate builds that node can never perform — its source registry is on the far side of the air gap, which is the entire reason the tarball exists — and bury a real crossing under fabricated refusals. Seeding on the causal event means a node that RECEIVES bytes has nothing seeded, and it also means flipping the feature on never drains a historical backlog across the CDS.

Gated to `role: retrans` because only that role may relay at all (ADR-0004; `buildRelayTarball` hard-refuses 409 elsewhere) and to a NON-EMPTY typed artifact set because a metadata-only promotion has no bytes to move. The seed is idempotent (ON CONFLICT DO NOTHING), so a replayed bundle can never resurrect a terminal row or reset a backoff. It creates an obligation, never a permission: whether it is ever acted on is `SCP_RETRANS_AUTO_RELAY`'s call, and every trust decision is still re-derived from the signed manifest inside `buildRelayTarball`.

### §410. The stall signal, reachable by construction and sent once

THE STALL SIGNAL, at the one place it is reachable by construction and emitted exactly ONCE PER PROMOTION rather than once per tick. When automation is off, this hop is owed and nothing will move it — at a CDS nobody is watching a terminal, so say so here, naming the command that does move it. (The sweep cannot carry this message: with the flag unset its loop is never started, so any warning inside it is unreachable in production.)

## `apps/server/src/federation/promotion-scan-step.integration.test.ts`

### §411. The commander's promotion scan step, end to end

M13.3a — THE E6 END-TO-END for the commander's promotion scan step (ADR-0020, proposal §13.3 DoD). This is the integration proof the 13.3a DoD demands: "an ephemeral runner at the commander scans a subject artifact pulled by digest over the allowlisted channel, `--network none` otherwise; the emitted evidence parses via `ScanEvidenceSchema`, lands commander-resident, and the UNMODIFIED M17.5/E6 machinery consumes it — a pipeline-less promotion scans → evaluates → signs → exports end-to-end with zero gate-code changes; valid org-pipeline evidence short-circuits the managed run (both ingresses proven); scanner selection follows the registry rows by artifact type, and an unassigned type with no evidence still refuses at E6."

REAL vs INJECTED, and WHY. The two scan-substantive verdicts run the REAL `scp-runner-scan` container end-to-end through the DEFAULT server runner (`scanRunner` undefined ⇒ `createServerManagedScanRunner`) — the production path — against REAL subject images pushed to a real `registry:2`: (a) CLEAN  — `alpine:3.20` (0 vulnerabilities in the baked DB) → real Trivy → PASS → E6 exports. (b) DIRTY  — `debian:11`   (6 CRITICAL / 19 HIGH in the baked DB) → real Trivy exceeds the fail-closed 0/0 threshold → FAIL → E6 refuses with a `decision_id`. These two carry the container/pull/network proofs: the SERVER pulls the subject BY DIGEST over the `SCP_ARTIFACT_OCI_REGISTRY_HOSTS`-allowlisted skopeo channel, docker-cp's the OCI layout INTO a `--network none` runner, and the deposited `control_runs` evidence is digest-bound (`artifactDigest` == the promoted digest, `digestMatch: true`) under the well-known managed-scan control id — exactly the row the unchanged E6 gate reads.

M13.3b adds the second managed-scan METHOD end-to-end through the same DEFAULT server runner, with the runner image built ONCE (shared beforeAll — one oscap clean-pass + one oscap threshold-fail, no rebuild loop): (f) debian:11 vs ssg-debian11 `standard` scans clean → digest-bound `scanner:openscap` evidence → E6 exports; (g) oraclelinux:8 vs ssg-ol8 `standard` yields ≥1 HIGH-severity failed rule → status fail → E6 refuses with a decision_id. The `rpm` executor Type is assigned `openscap` in the instance scanner registry (registry-driven method selection), and `managedScanServerSettings().networkMode` is asserted `none` (the offline oscap scan succeeding under it is the --network none proof).

13.3a's MACHINE-IMAGE arm adds the third managed-scan METHOD end-to-end through the same DEFAULT server runner: (h) a clean ext4 disk image (alpine rootfs) scans clean via a real `trivy vm` → digest-bound `scanner: trivy-vm` evidence → E6 exports; (i) a vulnerable disk image (debian:11 rootfs) breaches the fail-closed 0/0 threshold → status fail → E6 refuses with a decision_id. The `infrastructure` executor Type resolves to `trivy-vm` in the seeded registry (drizzle/0048), so method selection is registry-driven here too. (j) closes the DoD's remaining clause: a promotion that crosses NO boundary schedules NO scan, proven against the same artifact that (i) refuses.

The three WIRING verdicts inject a `ManagedScanRunner` (the seam the step exposes precisely so these branches are hermetic and DB-drift-free): short-circuit (spy asserted NOT invoked), fail-closed unassigned type (spy asserted NOT invoked), and the `digestMatch: false` evidence branch (which the real runner can never reach — it refuses to even emit a report when the pulled layout digest != the promoted digest, so only an injected report can drive the gate's digest-mismatch refusal). Each drives the SAME deposit → E6-consumption path as (a)/(b).

Build the runner image ONCE (beforeAll). Needs a reachable Docker daemon + network for the subject pulls (the same integration tier that builds `scp-runner-iac` and pulls `registry:2`/postgres); excluded from `pnpm test`, run via `pnpm test:integration`.

### §412. Where the subject fixtures below are pulled from

Where the subject fixtures below are PULLED FROM (charter principle 5: "Everything, CI included, must run offline"; working convention: "Tests never touch the internet").

These subjects reach the registry through `skopeo copy`, and skopeo talks to the registry directly — it never consults the local Docker image store — so the local re-tag that keeps Testcontainers off Docker Hub is invisible to it. Left as a literal `docker.io/library`, the `beforeAll` below was a live, unauthenticated Docker Hub pull on the REQUIRED integration gate: on 2026-08-15 it answered 502 and the whole suite aborted with ZERO individual test failures, which reads as a mystery rather than an outage.

CI exports this (see `scripts/ci-mirror.sh seed`) pointing at the GHCR mirror of exactly the digests `tools/ci-mirror/images.list` pins. Unset — a developer's machine — it is upstream Docker Hub, which is what keeps this suite runnable from a fresh clone with no GHCR credentials.

### §413. --- OpenSCAP subjects

--- OpenSCAP subjects (M13.3b — the second managed-scan method) --------------------------------- Calibrated against the runner image's PINNED, content-addressed SSG content (oscap 1.4.0 / scap-security-guide 0.1.74 — tools/openscap/pin.env, installed from the frozen Fedora GA release repo, NOT the floating updates repo) using OSCAP_PROBE_ROOT over the runner-extracted image rootfs. The mapping folds XCCDF high→high / medium→medium / low→low, critical stays 0 (XCCDF has none), unknown/unset fold away: OSCAP CLEAN — debian:11 vs ssg-debian11 `anssi_np_nt28_minimal`: ZERO high/critical failed rules (only low/medium fail, which are unbounded) → within the fail-closed 0/0 (high) default → PASS. (Under SSG 0.1.74 the heavier `standard` profile carries one high-severity fail on debian:11, so the clean case uses the ANSSI *minimal* profile — the lightest baseline the pinned datastream ships — which is high-clean.) OSCAP DIRTY — oraclelinux:8 vs ssg-ol8 `standard`: ≥1 HIGH-severity fail (rpm-DB-checkable package rules evaluate offline) → breaches maxHigh=0 → FAIL.

### §414. --- MACHINE-IMAGE subjects

--- MACHINE-IMAGE subjects (13.3a — the `trivy-vm` arm, owner decision D2) -----------------------

A machine image is a DISK, not a layer stack, so these subjects are built rather than pulled: an ext4 filesystem image carrying the OS release files + package DB that `trivy vm` reads. Built ROOTLESSLY with `mke2fs -d` (populate-from-directory — no mount, no loop device, no privileged container), so this runs on an ordinary CI worker. No partition table is written: `trivy vm` accepts a bare filesystem image as well as an MBR/GPT-partitioned disk, and skipping the partition table drops a `sfdisk`/`util-linux` dependency the base images do not all carry.

Calibrated against the runner image's PINNED, baked Trivy DB, exactly like the container cases: MACHINE-IMAGE CLEAN — an alpine:3.20 rootfs: 0 findings -> within the fail-closed 0/0 -> PASS. MACHINE-IMAGE DIRTY — a debian:11 rootfs: 6 CRITICAL / 22 HIGH -> breaches 0/0 -> FAIL. The DIRTY case is the one that matters most for this arm: `trivy vm` emits a result document whose `Metadata` carries NO image digest and whose `ArtifactName` is a file path, so a parser that quietly found nothing would report all-zero counts and masquerade as clean. A subject with KNOWN non-zero findings is what makes the clean case's zeros meaningful.

These three stay BARE TAGS, unlike the skopeo sources above, and deliberately: they are consumed by `docker create`, which resolves a tag against the local image store first. CI pre-seeds those exact tags from the GHCR mirror (`scripts/ci-mirror.sh seed`), so the daemon finds them locally and never pulls — a registry prefix here would defeat that, not improve it. Both forms are pinned by the same digests in `tools/ci-mirror/images.list`.

### §415. LEVER 1: resolve the runner image ONCE

LEVER 1: resolve the runner image ONCE (PULL the pre-built content-hash GHCR image in CI via SCP_RUNNER_SCAN_IMAGE_REF, else legacy-builder BUILD it locally as a dev fallback), and start the postgres-domain + a registry:2, in parallel. The DOCKER_BUILDKIT=0 legacy-builder reasoning (the single-daemon net=none session wedge, PR #126 — now scoped to the local fallback only) lives in resolveRunnerImage — same build path, just no longer paid on every CI run.

### §416. Assigns the scan method to that Type for this domain

Assign the `openscap` method to the `rpm` executor Type for THIS domain's instance-scoped scanner registry (default seed is `rpm -> [trivy]`). Instance-scoped `scanner_assignments` is SELECT-only for the runtime role, so the write runs over the domain's SUPERUSER admin connection — the same path routes/scanner-assignments.ts uses in production. `image` stays `trivy` (the trivy cases below are untouched); `configuration` stays `[]` (the fail-closed case).

### §417. Package a disk as an OCI ARTIFACT

Package a disk as an OCI ARTIFACT — form (1) of `run.sh`'s declared machine-image packaging convention: one layer descriptor that IS the disk, carrying the SCP machine-image mediaType — and push it into the local registry. Returns the manifest digest.

The layout is hand-authored rather than produced by a packaging tool because that is exactly what the convention is: nothing in the pull path is special-cased for machine images, so the SERVER pulls this with the same allowlisted `skopeo copy` it uses for a container image. The digest is computed from the manifest bytes we author (content-addressing, not a tool's word for it) and PROVEN by the round-trip: the server re-reads the landed layout's digest and refuses the scan unless it equals the promoted digest.

### §418. (d2) RUNNER FAILURE IS DIAGNOSABLE

(d2) RUNNER FAILURE IS DIAGNOSABLE — a genuine `{ ok: false }` (dispatch error, not "no scanner assigned") deposits NO evidence, exactly as (d), but records WHY as an audit event instead of a bare silent `continue`. `promotion-scan-step.ts`'s Phase B used to discard `result.reason` entirely: an operator reading a "no passing digest-bound evidence" refusal had no way to tell a genuine scan failure apart from "the runner never even ran".

### §419. (f) OPENSCAP CLEAN

(f) OPENSCAP CLEAN — real oscap scan at the commander passes the profile → digest-bound `scanner: openscap` evidence → E6 exports. The `rpm` type resolves to `openscap` (seeded above), so this exercises registry-driven scanner selection AND the second method end-to-end through the DEFAULT server runner (real skopeo pull + real scp-runner-scan).

### §420. (h) MACHINE IMAGE, CLEAN

(h) MACHINE IMAGE, CLEAN — the 13.3a `trivy-vm` arm end-to-end through the DEFAULT server runner: a real DISK image pulled by digest over the allowlisted channel, scanned by a real `trivy vm` inside a `--network none` runner → digest-bound `scanner: trivy-vm` evidence → the UNCHANGED E6 machinery exports. The `infrastructure` executor Type resolves to `trivy-vm` in the seeded registry (drizzle/0048), so this is registry-driven selection of the machine-image method, not a hard-coded branch.

### §421. (i) MACHINE IMAGE, VULNERABLE

(i) MACHINE IMAGE, VULNERABLE — the anti-vacuity half of (h). A `trivy vm` result document differs from a `trivy image` one (no `Metadata` digest, an `ArtifactName` that is a file path), so a parser that silently matched nothing would report all-zero counts and every machine image would "scan clean". A subject with KNOWN findings proves the counts flow.

### §422. (j) NO BOUNDARY CROSSING ⇒ NO SCAN SCHEDULED

(j) NO BOUNDARY CROSSING ⇒ NO SCAN SCHEDULED (13.3a DoD, "default-permissive = adoption semantics only"). The commander's managed scan is a step of the CROSS-BOUNDARY export journey. A change that never crosses a boundary — one that runs its whole lifecycle inside the domain, `proposed -> ... -> accepted` — must schedule NO scan: no runner dispatch, no managed evidence, no Decision about scanning. Adopting SCP must not silently start scanning every in-domain release.

```text
  Non-vacuous BY CONSTRUCTION: the subject is the SAME artifact whose scan REFUSES in (i),
  managed scanning is fully enabled, and the change's type resolves to a real scanner. The
  test then EXPORTS the same change and asserts the scan does happen — so it fails both if
  scanning leaked onto the in-domain path and if the boundary path stopped scanning.
```

## `apps/server/src/federation/promotion-scan-step.test.ts`

### §423. M13.3b — parseOscapResult unit tests

M13.3b — parseOscapResult unit tests (ADR-0020 §2, proposal §13.3). The server-side distillation of an OpenSCAP XCCDF/ARF result into the four ScanSeverityCounts. Pure, no Docker — runs in the fast `pnpm test` layer. The end-to-end "real oscap → E6" proof lives in the integration suite.

The MAPPING under test (decided, ADR-0020 §2): XCCDF high→high, medium→medium, low→low; XCCDF has NO `critical` severity so `critical` stays 0 (the no-critical property); `unknown`/`info`/unset fold away. Only `fail` rule-results count. A malformed/empty document FAILS CLOSED (throws) rather than silently reporting zero findings.

### §424. SEAM 1 — DISPATCH CONTAINMENT

SEAM 1 — DISPATCH CONTAINMENT. The server decides WHICH method to hand the orchestrator; the orchestrator decides which methods it will RUN. They are separate lists in separate packages (the plugin does not depend on `@scp/schemas`), so a method added to only one of them either never runs or is dispatched into a container that exits 2. This pins the direction that matters.

### §425. SEAM 2 — THE SCANNER-DB STALENESS GATE

SEAM 2 — THE SCANNER-DB STALENESS GATE. `trivy vm` reads the SAME vulnerability DB as `trivy image`, so the M13.3b-ii staleness gate MUST fire for it. The bug this test exists to catch is precise and was live in the code before this increment: the gate was written as `method === "trivy"`, so a machine-image scan would sail past a missing/corrupt/hard-stale DB cache, scan against whatever the image happened to bake, and still deposit PASSING evidence.

Behavioural, not textual: a CONFIGURED-but-EMPTY cache dir must make the runner refuse BEFORE it pulls anything, for every Trivy-family method — and must NOT do so for OpenSCAP, which evaluates baked SSG content and has no Trivy DB to be stale.

### §426. MEDIUM (verification pass 5)

MEDIUM (verification pass 5) — THE IN-PROCESS `trigger()` HAS NO HOST AND THEREFORE NO SIGKILL

Every other managed run in the product crosses the subprocess plugin host, whose budget expiry SIGKILLs the child (`plugin-host/call-policy.ts`). `createServerManagedScanRunner` calls `plugin.trigger()` DIRECTLY, in the server process, so nothing outside the launcher bounds it. That is safe today, and it is safe by accident on both axes — see `pluginCtx`'s own doc. This makes the first axis a standing assertion rather than a comment; the second (`secretEnv: []`) is pinned by `@scp/plugin-managed-scan`'s `launcher-seam.test.ts` whole-spec `toStrictEqual`.

### §427. The whole config, so a NEW key cannot arrive unnoticed

The whole config, so a NEW key cannot arrive unnoticed: every one of these is a server-side operator setting with no binding row behind it.

M23.2 ADDED ONE, AND THIS ASSERTION IS WHY THAT WAS DELIBERATE. `runnerLauncher` is the adapter selection; it arrives here because `pluginCtx` spreads the WHOLE launcher slice (`managedRunnerSettings()`) rather than picking `dockerBinary` out of it — the alternative being a commander whose own promotion scan stays on Docker forever while every bound executor moves to Jobs, which is the exact shape of the defect `managedRunnerSettings` already exists to prevent. It is server-injected and never tenant-settable: absent from managed-scan's manifest (`additionalProperties: false`) and refused by name at the four write doors (`plugin-manifests-runner-launcher.test.ts`).

`kubernetes` is NOT here and its absence is load-bearing: `managedRunnerSettings()` omits the key entirely on a docker deployment, so nothing about Kubernetes reaches this path unless an operator selected it. `managed-runner-selection.test.ts` covers the selected shape.

### §428. With no configured timeout, it falls back to its own

With no `timeoutMs` in the config, `managed-scan` falls back to its own DEFAULT_TIMEOUT_MS — the same number its manifest publishes as the property's `default` — and hands that to `RunnerSpec.timeoutMs`. `clampRunTimeoutMs` would cap it in any case; this says the fallback never even reaches the cap, so this path's bound is an honest ten minutes rather than the ceiling of last resort, which on a path with no SIGKILL is the difference between a wedged promotion scan holding the commander for 10 minutes and holding it for an hour.

## `apps/server/src/federation/promotion-scan-step.ts`

### §429. THE COMMANDER-SIDE PROMOTION SCAN STEP

THE COMMANDER-SIDE PROMOTION SCAN STEP (ADR-0020 §1, proposal §13.3, charter's Managed Execution Exception 2026-07-23 amendment) — the crux of first-class commander scanning.

This is a step of the COMMANDER's promotion/export journey, NOT a tenant executor binding. For a change being exported it deposits, for EACH substantive artifact (the E6 `substantiveArtifacts` set — everything except `type: "blob"`), a digest-bound `control_runs` scan outcome, so that the UNCHANGED E6 gate (`evaluatePromotionScanGate`, promotion-repo.ts) then reads those rows and PASSES for a clean artifact / REFUSES for a dirty-or-unscanned one. This module writes evidence; it does not touch the gate.

PER ARTIFACT (proposal §13.3): (a) SHORT-CIRCUIT — if a covering org-pipeline (or prior managed) `control_runs` scan outcome already covers this digest, SKIP the managed run: org evidence wins, the D1 alternate ingress, and the runner is never invoked. "Covering" is not enumerated here on purpose — this list used to spell it as "status `pass` + `ScanEvidenceSchema` valid + `digestMatch` + `artifactDigest` match, the exact E6 predicate", which stopped being the whole rule the moment E6 grew producer admission, supersession, the instance floor and (M22.9) exclusion-set currency. It is ONE function, `evaluateScanCoverage` in `scan-evidence.ts`, and that module doc is where the rule is stated. (b) SCANNER SELECTION — `resolveScannersForType(the artifact's ExecutorType)` → methods. If EMPTY, NO managed evidence is produced (fail-closed: E6 will refuse — we never fabricate a pass for an unassigned type). (c) THE SERVER pulls the artifact's bytes BY DIGEST over the allowlisted skopeo channel (`SCP_ARTIFACT_OCI_REGISTRY_HOSTS`, ADR-0019 §4) into a scratch OCI layout — the runner itself gets NO network. (d) run the `scp-managed-scan` plugin per method (`--network none` ephemeral container). (e) evaluate the returned `severityCounts` against the resolved M17.5 threshold (`resolveEffectiveScanThreshold` — reused, not reimplemented) → status pass/fail. (f) DEPOSIT a `control_runs` row (`insertControlRun`) whose evidence is a valid `ScanEvidence` with `scanner = method`, `artifactDigest =` the pulled+normalized digest (which MUST equal the promoted digest for `digestMatch: true`), and the threshold provenance.

FAIL-CLOSED throughout: an unassigned type, an unavailable dispatch/runner, an unresolvable pull ref, or a scanner error all yield NO passing managed evidence — so E6 refuses (never a fabricated pass). The one scan runs once at the commander before signing (ADR-0020 §4); downstream never re-scans.

### §430. The well-known object id tagging every row this step writes

The synthetic, well-known object id tagging every `control_runs` row this step deposits — the commander's SYSTEM managed-scan control identity.

WHY a fixed synthetic id rather than a tenant-created `control` graph object: `control_runs` `control_object_id` has NO foreign key to `objects` (db/schema.ts). So the managed promotion scan step, which is a first-class step of the commander's own promotion process rather than a tenant-bound control, tags its rows with this one stable, deployment-wide synthetic id. It is org-agnostic (control_runs rows are org-scoped by `org_id`, so the same synthetic control id under different orgs never collides) and resolves to a null URN in the export's control-outcome projection (tolerated, promotion-repo.ts).

IT IS NOW LOAD-BEARING, WHICH IT WAS NOT WHEN IT WAS WRITTEN. This comment used to say the id's "purpose is to mark provenance, not to be a graph object", and that E6 "identifies a scan outcome PURELY by `ScanEvidenceSchema.safeParse(evidence)` — never by which control produced it". The second half was an accurate description of a defect: shape-identification let any control that could emit a ScanEvidence-shaped bag authorize a cross-boundary crossing. E6 now identifies an outcome by its PRODUCER, and THIS ID is half of that test (`scan-evidence.ts` `isScanEvidenceProducer`) — so the id is part of an authorization rule, and changing it changes what the boundary accepts. Defined in `scan-evidence.ts` and re-exported here so every existing import keeps resolving; the admission rule must not import the module whose behaviour it governs.

### §431. The scan methods the runner image can actually run

The `ScanMethod`s the `scp-runner-scan` image can actually run — the server-side twin of the runner shim's `case "$METHOD"` arms and the plugin's `SUPPORTED_SCAN_METHODS`. A registry row naming a method outside this set produces NO evidence (fail-closed at E6) rather than launching a container that would exit 2. Typed over `ScanMethod`, so a value that is not a real method is a compile error rather than a silent, permanent runtime refusal.

Exported so `promotion-scan-step.test.ts` can pin the containment that actually matters: every method the server DISPATCHES must be one the plugin will RUN (`SUPPORTED_SCAN_METHODS`). The plugin holds its own copy because it does not depend on `@scp/schemas`; this is the seam where the two are proven to agree.

### §432. The per-finding detail the counts were derived from

M22.1b (ADR-0033 §7) — the per-finding detail the counts were derived from, retained so it can be PERSISTED (`scan_findings`). Every rule in ADR-0033 is a rule about a finding, and until this field existed a verdict reaching the server was four integers.

ABSENT when the runner produced no per-finding material — which is the ordinary case for OpenSCAP, whose XCCDF rule-results have no package, no purl, no `FixedVersion` and no `Class`. Absence is NOT what refuses an OpenSCAP finding set, though: `persistScanFindings` refuses on the METHOD, before it looks at this field, so a runner that one day handed findings alongside `openscap` still records `unsupported` rather than quietly gaining an exclusion surface.

### §433. True when the digest already carries an acceptable outcome

True iff `digest` is already covered by an outcome E6 WILL ACCEPT — so a short-circuit here can never suppress the scan that the gate then demands.

This used to be a hand-maintained copy of the gate's predicate, documented as "the EXACT predicate E6 applies". It now CALLS the gate's predicate. Two copies of an authorization rule that must agree, kept in step by a comment, is the shape this repo's census rule exists to catch; and here the two copies had to agree for a safety reason, not a tidiness one — a short-circuit looser than the gate skips the managed scan and then refuses the export for having no scan.

### §434. --- OpenSCAP profile/datastream resolution

--- OpenSCAP profile/datastream resolution (M13.3b) ---------------------------------------------

OpenSCAP needs TWO selectors trivy does not: which SSG datastream (which OS baseline content) and which XCCDF profile within it. Both are baked into the runner image at `/usr/share/xml/scap/ssg/ content/`. Resolution precedence, most-authoritative first: 1. OPERATOR env override (SCP_MANAGED_SCAN_OPENSCAP_PROFILE / _DATASTREAM) — deployment-wide lock. 2. The artifact's own hint on the change `sourceRef` (`scanProfile` / `scanDatastream`) — the per-artifact OS baseline; inherently artifact-specific (a debian image needs ssg-debian, an OL image needs ssg-ol8). This only selects WHICH compliance baseline is asserted; it CANNOT weaken the gate — the high/critical THRESHOLD that authorizes/refuses is operator-governed (resolveEffectiveScanThreshold) and applied to the counts regardless of profile, and a nonexistent datastream fails the run CLOSED (run.sh exits non-zero → no passing evidence). 3. Built-in default (the SSG `standard` profile against the fedora datastream). (Registry-carried per-method profiles are a documented additive follow-on — the `scanner_assignments` row could grow a `profiles` map; the default+override path here is the bounded 13.3b-part-1 shape.)

### §435. The artifact's ExecutorType for scanner selection

The artifact's ExecutorType for scanner selection — the change's routing Type when valid, else `image` for an OCI subject (the M13 image-only scope, proposal §13.3 D2).

Within that scope MACHINE IMAGES ride `infrastructure` (owner decision D2), which is why the seeded registry assigns `infrastructure -> ["trivy-vm"]` (drizzle/0048). `infrastructure` is a COARSE routing key that also covers IaC-config artifacts, and those are simply out of M13's image-only scan scope: a Terraform-plan artifact routed here yields a runner failure, therefore no evidence, therefore an E6 refusal — fail-closed, and identical to the behaviour before this arm existed (a `trivy image` run on the same subject failed the same way).

### §436. THE EXCLUSION SET IN FORCE FOR A CHANGE

THE EXCLUSION SET IN FORCE FOR A CHANGE — one resolution, because the export path now has TWO consumers of the answer and a difference between them is indistinguishable from a withdrawn waiver.

The step below resolves the set to APPLY it (exclude-before-counting, phase B) and stamps `scanExclusionSetHash` onto every verdict it deposits. `promotion-repo.ts`'s E6 gate resolves it to CHECK that a cached verdict was judged under it (M22.9). If the two assembled their inputs separately — a target list read differently, a firing set resolved from a different CEL pass, a different actor — the two hashes would differ for a reason nobody authored, and EVERY export of a change carrying an exclusion would refuse `stale_exclusion_set` forever. That is the failure this function exists to make unreachable; the alternative considered was a second copy of these ~20 lines in `promotion-repo.ts`, kept in step by a comment.

`matches`/`fired` come back with the answer because the CEILING dimension resolves off the SAME firing set (below) — re-running the CEL evaluation to obtain it a second time would be both a wasted worker round-trip and a second chance for the two dimensions to disagree.

M22.2 — THE FIRING SET, FOR REAL. This used to be `firedPolicies: []`.

An empty firing set admits the instance-level floors (platform/trust_domain, always read) plus the fail-closed default, and NOTHING authored at org, containment domain, service, assembly or component. That was a documented follow-on and it was defensible while the only dimension was a TIGHTENING — the 0/0 default already refuses any Critical or High, so a missing scoped ceiling could only ever make this step stricter than the gate.

It stops being defensible the moment a LOOSENING exists. An exclusion resolved by the lifecycle gate would be invisible here, so the commander's own managed scan would count findings the gate had agreed not to count — the two paths disagreeing about the same artifact at exactly the boundary where evidence is FROZEN into a signed bundle and the E6 export gate reads it. So both dimensions resolve off the SAME firing set the gate would compute.

THIS IS A BEHAVIOUR CHANGE FOR THE CEILING TOO, and in both directions — stated rather than buried. A scoped policy that sets `maxHigh: 5` now applies here, where before this step used the 0/0 default; a scoped policy that sets `maxHigh: 0` now applies where before nothing did. Convergence with the lifecycle gate is the point: two verdicts about one artifact must not be produced under two different rules.

The sandbox is a THUNK. `new CelSandbox()` spawns its worker pool in the constructor, and `resolveFiredPolicies` calls `evaluate` only for a contributor that actually carries a `condition` — so an org whose policies have no conditions spins up no worker threads.

RESOLVED AS THE ACTOR WHO IS CROSSING THE BOUNDARY, which is a real and accepted limitation: an exclusion policy scoped to an ACTING GROUP resolves differently for the exporter than it did for the engineer whose gate run stamped the evidence, and the difference reads here as a moved set. The consequence is a refusal (or a re-scan), never a crossing — the direction a boundary check is allowed to be wrong in.

### §437. A `runner.scan()` call that itself never produced a report

A `runner.scan()` call that itself never produced a report — dispatch unavailable, an unresolvable pull ref, a launcher failure, anything `ManagedScanResult`'s `{ ok: false }` arm carries. Distinct from a `DepositRow` with `status: "fail"`: THAT is a real scan verdict (a digest mismatch or a threshold breach) and IS deposited as `control_runs` evidence. This is the opposite — no scan happened at all — and depositing it as scan EVIDENCE would misrepresent "we scanned and it failed" as "we could not scan", which `ScanEvidenceSchema`'s required `severityCounts` cannot even express honestly. Recorded as an AUDIT EVENT instead (charter principle 6), so the operator refused by E6's "no passing digest-bound evidence" can see WHY: a runner/dispatch error, not a scan that ran and found problems.

### §438. Runs the commander's promotion scan step for one change

Run the commander's promotion scan step for `changeIdOrUrn`, depositing managed-scan `control_runs` rows so the UNCHANGED E6 gate (read next by `exportPromotionBundle`) has evidence to consume. A no-op for a metadata-only promotion (no substantive artifacts) or an artifact already covered by org-pipeline evidence. Never fabricates a pass: an unassigned type, an unavailable runner, or an unresolvable pull ref simply deposit no passing evidence and E6 then refuses.

### §439. (a) SHORT-CIRCUIT — CURRENT org-pipeline

(a) SHORT-CIRCUIT — CURRENT org-pipeline (or prior managed) passing digest-bound evidence wins. "Current" is the word that changed: a superseded pass no longer suppresses the scan, and (M22.9) neither does one judged under an exclusion set that has since moved — which is why the hash is resolved ABOVE this loop rather than at the deposit below. Computed after the short-circuit it could only ever stamp what this pass believed, never re-open a pass an expired grant had paid for.

### §440. Runner/dispatch unavailable, or an unresolvable pull ref

Runner/dispatch unavailable, or an unresolvable pull ref — produce NO passing evidence (fail-closed). We deposit no CONTROL_RUN: E6 then refuses this artifact for lack of a passing, digest-bound outcome. Fabricating a pass here is exactly what the model forbids. `result.reason` is NOT discarded, though — recorded below as an audit event, so the refusal is diagnosable (a runner error, not a scan verdict) rather than a bare "no evidence" an operator cannot act on.

### §441. Caps the set to persist, one function deciding the marker

M22.1b — cap the set that will be persisted, and let ONE pure function decide the marker that goes on the evidence here and the rows that go into `scan_findings` in phase C. The marker cannot be produced by the writer, because it must be on the `control_runs` row at INSERT time while the rows need that row's id; deriving both from `scanFindingsRecordFor` is what keeps "evidence says full, the table says otherwise" unreachable.

### §442. M22.2 — EXCLUDE BEFORE COUNTING

M22.2 — EXCLUDE BEFORE COUNTING (ADR-0033 §2), through the SAME pure function the `scan-result-control` plugin uses, so the two verdict producers cannot diverge about what a clause means.

`findingsRecord` gates it, and this is where the OpenSCAP guarantee actually lands: an `openscap` verdict carries `unsupported`, so every exclusion is refused BECAUSE OF WHAT SCANNED — recorded positively in evidence — never because the finding array happened to be empty. ADR-0033's consequences list requires exactly that distinction be explicit.

### §443. The same stamp a plugin-produced verdict gets

M22.7 — the SAME stamp `control-runner.ts` puts on a plugin-produced verdict, from the same pure function, so the two verdict producers describe an exclusion set identically.

THIS COMMENT USED TO SAY "NO ACTUATOR READS IT HERE YET" — true when written, false since M22.9. Both readers now exist and both are on the export path: this step's short-circuit (`isCoveringScanOutcome`) and the E6 export gate (`promotion-repo.ts`), which is what makes ADR-0033's "an override's expiry is not trustworthy at that boundary until it lands" land. Recording the hash from M22.7 is why that fix was a comparison rather than a re-scan of history — every stamped run was already describable.

### §444. Projects the findings, in the same transaction

M22.1b (ADR-0033 §7) — project the findings the counts were derived from, in the SAME transaction as the verdict they explain. `persistScanFindings` refuses on the METHOD for a scanner family that cannot carry findings, so this call is made unconditionally: an `openscap` deposit reaching it records `unsupported` rather than being skipped here, which is the difference between a stated refusal and a silent absence.

### §445. The default production `ManagedScanRunner`

The default production `ManagedScanRunner`: the SERVER pulls the artifact BY DIGEST over the allowlisted skopeo channel into a scratch OCI layout (the runner gets no network), asserts the landed layout's digest equals the promoted digest, then runs the `scp-managed-scan` plugin (`--network none`) and parses the Trivy result into distilled counts. Returns `{ok:false}` — never throws into the export flow — when managed scanning is not enabled or the pull/scan cannot complete (fail-closed).

Credentialed source registries are a documented follow-on: this increment pulls anonymously (sufficient for the image-only M13 scope and the local-registry integration test); the relay's per-registry vault-credential machinery (retrans-relay.ts) is the model to wire in later.

### §446. M13.3b-ii — OFFLINE DB PRE-LOAD + STALENESS GATE

M13.3b-ii — OFFLINE DB PRE-LOAD + STALENESS GATE (every TRIVY-FAMILY method — `trivy` and the 13.3a machine-image arm `trivy-vm` — via `usesTrivyDb`, never OpenSCAP, which evaluates the baked SSG content that has no OCI upstream to refresh: the documented asymmetry). The predicate is deliberately NOT a `method === "trivy"` comparison: a second Trivy-family method that skipped this branch would scan against an unclassified (possibly hard-stale) DB and still emit passing evidence. When a DB cache is configured, classify it against the operator's instance staleness policy BEFORE dispatch: missing/corrupt/hard-stale FAIL CLOSED (no scan → no evidence → E6 refuses); fresh/warn scan (a warn is surfaced in the evidence). The classified cache dir is `docker cp`'d into the runner (SCP_SCAN_DB_DIR). Unset cache ⇒ the runner uses the image-baked DB (fail-closed fallback), reported as source `baked` with no staleness gate.

### §447. Method-select the parser

Method-select the parser: every TRIVY-FAMILY method (`trivy`, `trivy-vm`) emits Trivy's native result.json — a `trivy vm` run's document has the SAME Results[].Vulnerabilities[] shape, only a different subject model — while openscap emits arf.xml. BOTH distil to the four ScanSeverityCounts the unchanged M17.5/E6 machinery consumes. A malformed result throws (caught below) → {ok:false} → no passing evidence → E6 refuses (fail-closed).

### §448. The digest binding is the pull, not a self-report

THE DIGEST BINDING IS THE PULL, NOT THE SCANNER'S SELF-REPORT. We already content-addressed the subject above (`landed === req.digest`) and fed exactly that layout to the networkless runner, so the scanned artifact's MANIFEST digest is provably the promoted digest. Trivy's own identifier for an `--input` OCI-layout scan is `Metadata.ImageID` (the image CONFIG digest — a DIFFERENT sha256 than the manifest digest); a `trivy vm` result's `ArtifactName` is the in-runner DISK PATH and its `Metadata` carries no digest at all; and an oscap ARF carries no image digest either (it scanned an extracted rootfs). Trusting `parsed.scannedDigest` would therefore false-mismatch on every method. Bind to `req.digest` (the verified pull) for ALL methods; `parsed.scannedDigest` is retained only for the trivy malformed-result diagnostic path.

### §449. The one in-process caller of a managed executor's trigger

THE ONE IN-PROCESS CALLER OF A MANAGED EXECUTOR'S `trigger()`, and what makes that safe — MEDIUM (verification pass 5). Every other managed run crosses the subprocess plugin host, whose `resolveCallPolicy` budget expiry SIGKILLs the child; this one calls `plugin.trigger()` directly, INSIDE THE SERVER PROCESS, so there is no host, no budget and no SIGKILL of any kind. The only things bounding a commander-side promotion scan are the ones the launcher itself carries.

TWO FACTS MAKE THAT ACCEPTABLE, AND BOTH WERE ACCIDENTS UNTIL THEY WERE WRITTEN DOWN HERE. Each now has a NAMED test, because "it happens to be true today" is how the next edit breaks it:

1. NO TENANT `timeoutMs` REACHES THIS PATH. `config` below is built entirely from server-side operator settings — `runnerImage`, `networkMode` and `managedRunnerSettings()`'s `dockerBinary` — with no binding row anywhere in it, so `managed-scan` falls back to its own `DEFAULT_TIMEOUT_MS` (10 min) and the run is bounded by that. Even if a `timeoutMs` were added here it could not run away: `@scp/runner-launcher`'s `clampRunTimeoutMs` caps every run at `MANAGED_RUN_TIMEOUT_MAX_MS` inside `run()` itself. Pinned by "THE IN-PROCESS SCAN PATH CARRIES NO TENANT-SETTABLE BUDGET" in `promotion-scan-step.test.ts`. 2. MANAGED-SCAN CARRIES NO CREDENTIAL. Its `RunnerSpec.secretEnv` is the literal `[]`, so no transient `--env-file` is ever written on this path and there is nothing for a killed process to leak — which matters here precisely because there is no SIGKILL story to reason about. Pinned by `@scp/plugin-managed-scan`'s `launcher-seam.test.ts`, whose whole-spec `toStrictEqual` includes `secretEnv: []`.

A THIRD MANAGED PLUGIN CALLED FROM HERE WOULD INHERIT NEITHER. Route it through the plugin host rather than adding a second in-process caller.

EXPORTED FOR THE TEST ABOVE and for nothing else: fact 1 is a property of the object this builds, and a test that re-derived the object instead of reading the one the product passes would be asserting its own fixture.

### §450. Distils the scanner's result JSON into counts and a digest

Distil Trivy's native result JSON into the four ScanSeverityCounts + the digest it scanned + version. Total and defensive — a malformed/partial document degrades to zero counts (a broken scan then can't exceed a threshold on counts, but the RUNNER already failed the run for a broken scan, so this path only ever sees a real result). Mirrors scan-result-control's parsing across the plugin/server boundary (a plugin cannot import server code, and vice versa).

### §451. The counting loop that used to live here, and what it read

M22.1 — the counting loop that used to live here read `.Severity` and threw the vulnerability object away, byte-for-byte mirroring `scan-result-control`'s `countSeverities` across the plugin/server boundary. Both now derive from ONE parse in `@scp/schemas`, because ADR-0033 needs both to retain per-finding detail and two hand-synced loops is how one gets fixed and the other does not. Counts are numerically unchanged — `parseTrivyFindings` retains exactly the entries this loop counted.

### §452. --- OpenSCAP result parsing

--- OpenSCAP result parsing (server-side, M13.3b) -----------------------------------------------

Distil an OpenSCAP XCCDF/ARF result into the four ScanSeverityCounts by counting FAILED rule results by their XCCDF severity. The mapping (DECIDED — ADR-0020 §2 / proposal §13.3, recorded here normatively):

```text
XCCDF `high`   -> high
XCCDF `medium` -> medium
XCCDF `low`    -> low
(XCCDF has NO `critical` severity) -> `critical` stays 0, VACUOUSLY. Operators therefore gate
  OpenSCAP findings on `high` (the fail-closed default maxHigh=0 refuses any high-severity fail);
  a `critical` value is mapped for completeness should a datastream ever emit one, but SSG does not.
`unknown` / `info` / unset / anything else -> FOLDED AWAY (not counted), exactly as trivy's
  `UNKNOWN` severity is folded (supply-chain.ts ScanSeverityCounts doc).
```

Only `fail` rule-results count. `pass`/`notapplicable`/`notchecked`/`notselected`/`error`/`fixed` are NOT findings against the artifact (in particular an offline rootfs scan yields many `notchecked`/`notapplicable` for live-system probes — those are not fails and must not inflate counts).

FAIL-CLOSED on a malformed/empty document (proposal §13.3): a result that is not recognizably an XCCDF/ARF scan (no TestResult and no rule-result at all) THROWS rather than degrading to all-zero counts — an all-zero count on a broken scan would masquerade as a clean pass. (The runner already fails the run for a broken oscap invocation, so this path normally sees a real ARF; the throw is the belt-and-suspenders second barrier.) The caller maps the throw to {ok:false} → no evidence → E6 refuses.

### §453. M22.1b — `never`, not "empty"

M22.1b — `never`, not "empty". An XCCDF rule-result has no package, no purl, no `FixedVersion` and no `Class`, so there is no per-finding material for an exclusion to match on and no way to invent one. Typed as `never` so an attempt to populate it is a COMPILE error rather than a runtime surprise — but note the enforcement that matters is `persistScanFindings` refusing on the METHOD, which holds even for a caller that never sees this type.

## `apps/server/src/federation/publish-domain-local.ts`

### §454. M20.4 (ADR-0031 §6) — publish a domain-local object

M20.4 (ADR-0031 §6) — publish a domain-local object: it stops being domain-local, and its current state (plus the edges that can now travel) is put on the journal from this point forward.

## A verb, not a property write

`domain_local` is otherwise named by NO update statement anywhere — that structural absence is what makes locality immutable rather than merely guarded (ADR-0031 §6, and the census in `drizzle/0059_objects_domain_local.sql`). **This function is the single, deliberate exception**, and it is a verb because it does not merely set a field: it re-journals the object and sweeps its edges, and an operator must be able to see that as an action with an effect rather than as a field edit that quietly emitted a stream of entries.

## Authorization lives at the door, and it is TWO permissions

This function takes a `TenantTx` and an `actorObjectId` for AUTHORSHIP only — it authorizes nothing, the same split `federation/domain-local.ts` documents ("authorization at the door, invariant at the repo"). Its sole route, `POST /objects/{type}/{idOrUrn}/publish`, demands BOTH `object:write` and `federation:write` at the object.

BOTH, because this is both acts at once. `federation:write` matches the permission that DECLARED locality (ADR-0031 §1) — undoing a boundary decision cannot be cheaper than making it. `object:write` matches declaring's OTHER half, and it is here because of what the body below actually does: it `UPDATE`s an estate row and BUMPS `version`. On `federation:write` alone the FederationAdmin shape ("operates the link, does not edit the estate") could re-version estate rows through the inverse of a verb it was never allowed to perform. A new caller that reaches this function without both bars re-opens that.

## One-way, permanently

There is no inverse and there will not be one. Federation has no un-send: once an object's existence has reached a peer, a later claim that it is domain-local asserts a confidentiality property the system cannot deliver, so an API that accepted "un-publish" would be lying. The asymmetry is the design, not an unfinished half of it.

## Why re-journaling is enough

Journal payloads are **full-state upserts, not deltas** — the importer applies them through `upsertObjectByUrn`. So a single fresh `object_upsert` carrying the object's *current* state lands it correctly on a peer that has never seen it, with no need to replay the history it missed. The observable consequence, and it is a real one: the commander's first knowledge of a published object is its state **at publication**, not its origin. A reader must not mistake that absence of earlier revisions for a creation date. (Imported audit segments are discarded on the import path anyway, so nothing else was going to reconstruct that history either.)

## The edge sweep, and why it is `OR` not `AND`

Publishing the object alone would leave it on the peer with none of its relationships — an orphan in the receiving graph. So every live edge touching it is reconsidered under ADR-0031 §4's either-endpoint rule, which now yields a different answer for exactly those edges whose *other* endpoint was already shared. Edges to a still-domain-local neighbour stay unjournaled and are reported as `withheldRelationshipIds` — a partial sweep is the correct outcome, but a silent one would be indistinguishable from a bug.

### §455. The containment parents that are themselves still local

M20.6 (ADR-0031 §6b) — the containment parents of `objectId` that are THEMSELVES still domain-local, along both routes `graph/containment.ts` walks.

ONE HOP, deliberately, and for the same reason §6a inherits one hop: by induction an object cannot be under a domain-local ancestor without its immediate parent being domain-local too, because locality is inherited at create all the way down. Walking the full chain would answer the same question at the cost of a recursive CTE in a write path.

Returns the offending parents DESCRIBED, not merely counted — the operator's next action is "publish that container first", and a refusal that does not name it makes them go looking.

### §456. Refuse publishing out of a still-domain-local container

M20.6 (ADR-0031 §6b) — REFUSE PUBLISHING OUT OF A STILL-DOMAIN-LOCAL CONTAINER, before any write.

Publishing a child whose container stays local lands it at the commander with NO containment edge at all: the child's `object_upsert` crosses, the container's does not, and §4 withholds the edge between them. Every consumer that derives authority from containment — policy resolution, RBAC scope expansion, freeze scoping, approval scope, all walking `graph/containment.ts` — then reads it as attached to nothing.

That is not a hypothetical shape. ADR-0026 MEASURED it, reached by a different route: a placement whose chain was `[org root, placement]` silently stopped ELEVEN `required` component-scoped prod-gate policies on the live estate and made every service-scoped freeze FAIL OPEN. It was called a defect there and fixed without asking; a supported API deliberately producing it would be worse than the accident was.

The required order is publish-the-container-then-the-child, and it stays one explicit decision at a time because publishing a container does NOT publish its children — the edge sweep below re-journals only edges whose other endpoint is already shared.

## `apps/server/src/federation/relay-builds-repo.ts`

### §457. M13.1b — the AUTO-RELAY BUILD LEDGER's data access

M13.1b — the AUTO-RELAY BUILD LEDGER's data access (`federation_relay_builds`, drizzle/0047).

The scheduler state behind the staging node's unattended onward BYTE hop: which imported promotions still owe a relay tarball, which worker is building one right now, how many verdicts a failing one has produced, and which are terminally done. The loop that consumes it is `auto-relay.ts`; the causal writer that seeds it is `promotion-repo.ts`; the terminal writers are the forward path (`retrans-relay.ts`) and the manual relay route.

## The two rules this module exists to enforce

1. **THE CLAIM IS A FENCE, AND EVERY RELEASE IS FENCED BY IT.** `claimRelayBuild` is a single `INSERT … ON CONFLICT DO UPDATE … WHERE` — atomic by construction, so N worker replicas ticking together produce at most one build per change per lease window. That is only half the problem: a lease can EXPIRE while a build is still running (a multi-GB skopeo pull can outrun any default), so two workers can legitimately hold the same change in sequence. If the releases were keyed on `(org_id, change_object_id)` alone, the SLOW worker's late write would clobber the fast one's terminal state — flipping a `built` row back to `pending` (rebuilding and re-dropping bytes across the boundary) or stamping `exhausted` with a durable, hash-chained explanation that says "nothing crossed the boundary" about bytes that did. So every release carries the `attempts` value its own claim returned and is guarded on `status = 'pending' AND attempts = <that value>`; a stale claimant matches zero rows, learns it lost the lease, and writes NOTHING — no ledger change, no Decision, no audit event.

2. **A TERMINAL STATE IS TERMINAL.** `built`, `forwarded` and `exhausted` are never re-opened by a release path. Only `reopenRelayBuild` — reached exclusively from a SUCCESSFUL manual relay — moves a row out of `exhausted`, which is what keeps the operator's existing `POST /api/v1/federation/relay` the documented, sufficient exit from a boundary stall.

### §458. Causal seed, written in the import's own transaction

CAUSAL SEED — called by the promotion import, in the import's own transaction, on a `role: retrans` instance only. Idempotent: `ON CONFLICT DO NOTHING` means a replayed bundle (or a re-import after the hop already completed) can never resurrect a terminal row or reset a backoff. Returns true when a NEW row was seeded.

### §459. The DUE candidates

The DUE candidates: seeded rows whose retry gate has passed, whose lease (if any) has lapsed, and whose change is still in a state where relaying bytes is meaningful.

The `changes` join is a PK lookup, not a scan, and exists for exactly one reason: a promotion can be cancelled or rolled back AFTER it was imported and seeded, and pushing its bytes across a security boundary afterwards is never right. Those rows stay `pending` rather than being marked terminal — a cancellation is not this loop's verdict to record, and if the change is later un-cancelled the hop simply resumes.

### §460. THE ATOMIC CLAIM

THE ATOMIC CLAIM. One statement takes the row lock and re-evaluates the due predicate against the CURRENT row, which an enumerate-then-update pair cannot do (its read is stale by the time it writes). Returns the fence token, or `null` when the row was not claimable (another worker holds the lease, it is backing off, or it went terminal between enumeration and now).

`attempts` increments here, `failed_attempts` does NOT — see the migration header: a worker that claims and is then evicted must not spend the change's lifetime verdict budget.

### §461. Terminal and out-of-band: this node received the bytes

TERMINAL, out-of-band: this node RECEIVED the bytes rather than building them (the high-side retrans hop — `validateAndForwardRelayTarball` succeeded for this change). Upserts, because the high side seeds a row at import exactly like the low side does and a tarball can arrive before or after that seed.

IT MUST BE ABLE TO CORRECT AN `exhausted` ROW, not only a `pending` one. Both boundary nodes are `role: retrans` and both seed at import, so a high side with `SCP_RETRANS_AUTO_RELAY` mistakenly set burns its verdict budget in ~15 minutes of backoff — while the CDS transfer that will deliver the tarball can take far longer (the default claim lease is an hour, and it exists precisely because multi-GB moves are slow). Restricting this to `pending` left the arriving bytes unable to correct the record they disprove: the row stayed `exhausted`, asserting the hop never happened, on the very node that had just validated and forwarded it. `built` is deliberately NOT correctable here — a node that genuinely built and dropped this change's tarball is the low side, and an arriving tarball for it would be a loop, not a correction.

### §462. THE EXIT FROM `exhausted`

THE EXIT FROM `exhausted` — reached only from a SUCCESSFUL manual `POST /api/v1/federation/relay`. An operator who fixes whatever the sweep gave up on and re-drives the hop by hand has, by that act, both delivered the bytes and demonstrated the cause is gone; recording it `built` is simply the truth, and it means a terminal row is never a trap that needs superuser SQL to clear. Upserts, so a manual relay on a change with no ledger row (a commander/outpost, or a promotion imported before this milestone) records the outcome too.

### §463. The FULL row

The FULL row — every column `RelayBuildRow` omits (the two scheduling columns `nextAttemptAt`/`claimedUntil` and the two audit timestamps) PLUS everything `RelayBuildRow` already carries. A deliberately SEPARATE interface rather than a widened `RelayBuildRow`: the loop/claim/release functions above only ever needed the narrower shape, and widening it would have every one of those call sites start carrying scheduling columns whose exposure was never reviewed for them. This is the OPERATOR TRIAGE projection — `listRelayBuilds` below is its only producer.

### §464. OPERATOR READ SURFACE

OPERATOR READ SURFACE (M13.1b, owner ask) — `GET /api/v1/federation/relay-builds`: see queue depth and exhausted rows without DB surgery. Every row for this org, optionally filtered by `status`, ordered by `updated_at DESC` (most recent activity first) — this is TRIAGE, not the work queue, so the ordering is deliberately NOT `listDueRelayBuilds`'s `created_at, change_object_id` (that function and its predicate are untouched by this one).

ROLE-AGNOSTIC BY CONSTRUCTION: rows exist only on a `role: retrans` instance (seeded at promotion import there, `promotion-repo.ts`); on any other role the table is honestly empty, so this list returns an empty array rather than a 409 — matching how every other read in this codebase treats "nothing here" versus "not entitled to look".

## `apps/server/src/federation/resync-repo.ts`

### §465. Resync: the mutually authorized, one-shot recovery

§7.2.6 RESYNC — the mutually-authorized, one-shot recovery from a lost-tail journal divergence. It is the SANCTIONED alternative to re-anchoring (which rail 5 refuses while a divergence stands): the importer's operator runs `scp federation resync --peer <exporter>`; the importer signs a request the exporter verifies (the importer authorizing a forced overwrite of ITS OWN replica); the exporter records a consent Decision and returns a signed FULL re-export from genesis; the importer resets its cursor, force-overwrite-imports (bypassing the revision-staleness guard, NEVER the single-writer authority check), bumps its generation, records its Decision, and clears the standing divergence — which lifts rail 5. Both sides record; the generation stamp attributes entries to before/after the event (§7.2.6). SECURITY-SENSITIVE end to end.

### §466. Exporter side: verify the importer's signed request

EXPORTER side — verify the importer's signed resync request against its paired public key, record the exporter's CONSENT Decision (+ audit), bump the exporter's generation, and return a full signed re-export from genesis for that peer. A bad signature is a 403 (fail-closed): only the paired importer, holding its own private key, can authorize a resync of its replica.

### §467. IMPORTER side — apply an exporter's signed resync re-export

IMPORTER side — apply an exporter's signed resync re-export: reset the cursor to genesis, FORCE-OVERWRITE import (re-converging even stale-revision rows), bump this side's generation, record the importer's Decision, and CLEAR the standing divergence by writing a newer non-block `federation-divergence` Decision (so `permitCursorReanchor`'s rail-5 refusal lifts). The bundle's own signature is verified inside `importSyncBundle` against the exporter's paired key.

## `apps/server/src/federation/resync.integration.test.ts`

### §468. §7.2.6 RESYNC — the mutually-authorized recovery

§7.2.6 RESYNC — the mutually-authorized recovery. A = commander/exporter, B = full-scope outpost/importer. Proves: the signed handshake (B signs, A verifies-and-consents), the force-overwrite re-convergence (a divergent replica ahead in revision is overwritten to the exporter's reality — the whole point; a normal import would no-op), both-sides Decisions + generation bumps, the cleared standing divergence lifting rail 5, and a forged request refused.

## `apps/server/src/federation/retrans-no-spa.integration.test.ts`

### §469. A retrans must not serve the single-page application

M16.3 P3 (owner decision 2026-07-29) — "a retrans must not serve the SPA" (BUILD_AND_TEST.md M13.1 — cited by MILESTONE, not by line number, since that file shifts under every milestone that lands: the retrans deployment profile is "no local Gitea/registry, no executor coordination, no deploy machinery, no UI"). Before this suite (and the `app.ts`/ `config.ts` change it pins), SPA registration was UNCONDITIONAL — a `role: retrans` relay served the full management UI at the most sensitive point in the topology (a CDS boundary).

WHICH ROLE AXIS GOVERNS, and why (see `config.ts`'s doc comment on `ServerConfig.federationRole` for the full reasoning): this gates on `SCP_FEDERATION_ROLE` — a NEW, install-time/deployment- wide config value, distinct from BOTH: - `SCP_ROLE` (`main.ts`'s `config.role`, `api`|`worker`|`all`) — proven below to be the WRONG axis: every `SCP_ROLE` value calls `buildApp` + `app.listen` unconditionally (`main.ts`), so today EVERY process role serves the SPA regardless — `SCP_ROLE` governs which BACKGROUND LOOPS run in-process, nothing about HTTP surface. - `federation/self-repo.ts`'s `FederationSelf.role` (`self_domain.role` in the DB) — ORG-scoped (self-repo.ts's own module doc: "kept org-scoped, not instance-wide"), set lazily post- install via the federation API, and explicitly declared ADVISORY by M15.4's own guardrail (`tools/helm-verify`'s doc comment: using it for an install-time render/boot decision would be exactly the runtime/install-time FORK the owner declined to create there). It is also simply unusable here: `app.ts` registers routes ONCE at process boot, before any request (or tenant) context exists to look a per-org DB row up against.

MUTATION-PROVEN (reported in the PR body, not just asserted here): with the `app.ts` gate removed, this suite's first test goes RED (a retrans-role instance serves real HTML at `GET '/'`) — confirming the test actually exercises the gate rather than passing vacuously.

## `apps/server/src/federation/retrans-relay.integration.test.ts`

### §470. M15.5(c) — the RETRANS VALIDATE-THEN-RELAY

M15.5(c) — the RETRANS VALIDATE-THEN-RELAY (ADR-0019 §2), end to end: THE M15.5(c) DoD suite (BUILD_AND_TEST.md §8). Three REAL isolated federation domains (separate Postgres databases — the same topology-faithful harness federation.integration.test.ts uses), TWO real `registry:2` containers (source + destination), the REAL cosign and skopeo binaries.

```text
commander A ──.scpbundle──▶ retrans B ──signed byte tarball──▶ outpost C
     │  (metadata-only)          │        (the CDS crossing,        │
     └────.scpbundle (metadata, addressed to C)────────────────────┘
```

Proven here, per the DoD: (a) FULL ROUND-TRIP — A exports a cosign-manifest-signed promotion (M17.3 E6) of an OCI image (cosign-signed by A's instance key at the SOURCE registry) + an SBOM blob; B (role: retrans) imports the .scpbundle (M17.4(a) verifies), relays: skopeo-pulls BY DIGEST from the source registry, VALIDATES with the M17.4 machinery, packages + cosign-signs the OCI-layout tarball; C imports the tarball: signature + checksums + local-authorized cross-check, pushes into the DEST registry by digest + re-inspects (install.sh pattern), records where the bytes landed — and C's UNCHANGED M17.4(a)+(b) gates pass end-to-end (the (b) gate is additionally shown to FAIL-CLOSE before the bytes landed). (b) TAMPER NEVER CROSSES — an artifact signed by the WRONG key at the source refuses the relay at B (block Decision `retrans-relay-validate` + hash-chained audit event, no tarball) and NOTHING of it reaches the destination registry; a tarball TAMPERED in CDS transit refuses at C (block Decision) with nothing pushed. (c) ALLOWLIST — a source host outside `SCP_ARTIFACT_OCI_REGISTRY_HOSTS` is refused BEFORE any dial (the counting decoy server receives zero requests). (d) ROLE — a non-retrans instance refuses to run the relay (the ADR-0004 arm). (e) CREDS — the destination push credential is resolved from the EXISTING secrets vault (ADR-0019 §3 artifact-store class, per-registry key) against an AUTH-REQUIRING registry, and never appears in logs, Decisions, or audit events. (f) SOURCE CREDS + ENV ISOLATION — the SOURCE-read credential round-trip: the relay pull is refused by an auth-requiring source registry until `relay/source-read/<host>` is vaulted, then succeeds (skopeo pull AND cosign validate both authenticate via the per-invocation authfile/DOCKER_CONFIG); the password appears NOWHERE (stderr, Decisions, audit), and `process.env.DOCKER_CONFIG` is byte-identical before/during/after the run — sampled on an interval and with a CONCURRENT M17.4(b) pre-deploy verify (a different auth need) running unaffected: per-invocation subprocess env, never a process-global mutation. (g) TLS SCOPING — the validate pass grants cosign's `--allow-insecure-registry` ONLY to hosts in `SCP_RELAY_INSECURE_HOSTS` (per host, mirroring skopeo's `--…-tls-verify=false`); a plain-HTTP source NOT in the list is refused end-to-end with TLS verification on. (The cosign-side per-host wiring itself is unit-proven in artifact-verify.test.ts.)

### §471. Flags forcing the legacy signature tag scheme

Flags forcing the LEGACY `sha256-<hex>.sig` tag attach scheme (empty when this cosign knows no other scheme). Cosign v3 defaults to the OCI 1.1 referrers-FALLBACK tag (an image index) against `registry:2`, so the (a) round-trip exercises that scheme; signing ONE image with these flags makes the same suite run prove the relay's discovery finds the legacy scheme too — both storage vintages covered regardless of the ambient cosign's default.

### §472. Real signature, WRONG key

Real signature, WRONG key — a forged/substituted build — attached under the LEGACY `sha256-<hex>.sig` tag scheme (where this cosign can be told to): the relay's discovery must FIND the signature artifact under EITHER attach scheme first (the (a) round-trip already covers this cosign's default — the referrers-fallback index under cosign v3), and only THEN refuse on verification. A discovery miss would produce the wrong refusal reason.

### §473. ENV ISOLATION (the multi-tenant guarantee)

ENV ISOLATION (the multi-tenant guarantee): pin process.env.DOCKER_CONFIG to a sentinel, SAMPLE it on an interval THROUGHOUT the credentialed run, and run a CONCURRENT pre-deploy verify with a different auth need — the relay's registry auth must ride per-invocation subprocess env only. Under a process-global mutation the sampler observes the scratch config dir during the window and byte-identity fails.

### §474. (g) TLS SCOPING

(g) TLS SCOPING — `--allow-insecure-registry` only for SCP_RELAY_INSECURE_HOSTS hosts, mirroring skopeo's per-host `--…-tls-verify=false`. The cosign-side per-host WIRING is proven in artifact-verify.test.ts (unit, mocked cosign seam) — cosign's own go-containerregistry auto-downgrades LOOPBACK registry hosts to HTTP regardless of the flag, so a Testcontainers loopback registry cannot observe the negative case live. The skopeo pull path CAN, end-to-end:

## `apps/server/src/federation/retrans-relay.ts`

### §475. M15.5(c) — the RETRANS VALIDATE-THEN-RELAY

M15.5(c) — the RETRANS VALIDATE-THEN-RELAY (ADR-0019 §2), the ADR-0004 `retrans` role made real.

## What this is

A retrans-role instance sits at a CDS boundary. It RECEIVES the metadata promotion bundle (the ordinary `.scpbundle` walk — `promotion-repo.ts::importPromotionBundle`, which already runs the M17.4(a) manifest verify) and must then relay the artifact BYTES onward. This module is that byte leg, as a pipeline of proven pieces (ADR-0019 §2, steps 1–7):

```text
1. RESOLVE the authorized artifact set — the imported change's M17.4(a)-verified
   `sourceRef.artifacts` (`crossBoundaryManifestOf`, the same scoping the pre-deploy gate
   uses). The signed promotion manifest is the ONLY source of what may cross.
2. PULL each artifact's bytes from the SOURCE registry via the VENDORED skopeo
   (`resolveSkopeo` + fail-closed pin assertion, @scp/cosign) — BY DIGEST, refs constructed
   with `bindOciRefToAuthorizedDigest` (#108's binding, one shared implementation). Blob bytes
   ride the guarded blob fetch. BOTH operator allowlists are enforced on this pull path:
   `SCP_ARTIFACT_OCI_REGISTRY_HOSTS` (every OCI ref, before any dial) and
   `SCP_ARTIFACT_BLOB_BASE_URLS` (every blob URL, before any request) — ADR-0019 §4.
3. VALIDATE with the M17.4 machinery (`verifyAuthorizedArtifactSet`): per-artifact,
   digest-bound, origin-signature-verified against the EXPORTER's distributed cosign pubkey,
   keyful/offline. FAIL-CLOSED: a tampered/unauthorized/missing artifact refuses the WHOLE
   relay with a `retrans-relay-validate` block Decision + hash-chained audit event — it NEVER
   crosses the CDS. (Pulled OCI layouts are additionally digest-checked and
   layout-integrity-checked, so what is packaged is byte-for-byte what was verified —
   content addressing closes the pull/verify gap.)
4. PACKAGE a SIGNED OCI-layout tarball — the `@scp/airgap` build-bundle machinery via its
   importable seam (`checksums`/`ociLayout`; not rewritten): per-artifact OCI layouts + blob
   files + `relay-manifest.json` + `CHECKSUMS.txt`, the checksums cosign-signed with THIS
   instance's cosign key (M17.3 E4, `ensureInstanceCosignKey`).
5. RELAY the tarball across the CDS AS A FILE — out-of-band, exactly the `.scpbundle` walk's
   boundary: signed file out, signed file in. Federation bundles stay METADATA-ONLY
   (ADR-0009); this tarball is a separate channel artifact, never a bundle-format change.
6. PUSH (destination side, `importRelayTarball`): verify the tarball signature + checksums +
   that every carried artifact is in the LOCAL change's own (a)-verified authorized set, then
   push each image into the destination local Gitea and RE-INSPECT the landed digest (the
   install.sh push + re-inspect pattern) — a registry push cannot silently alter what was
   verified. Blob bytes land in an operator-served directory. The change's
   `sourceRef.artifacts[].location` is then populated with where the bytes landed — the exact
   seam `artifact-verify.ts`'s `LocationRegistryReader` documents ("populated when the bytes
   land — M15.5").
7. RECEIVER RE-VERIFIES — ZERO TRUST IN THE RELAY. The receiving outpost still runs M17.4(a)
   at import and M17.4(b) pre-deploy, unchanged and unweakened: the relay is an optimization
   of the sneakernet leg, not a verification authority.
```

## Credentials (ADR-0019 §3 — the artifact-store class)

Source-registry READ + destination-Gitea PUSH credentials are ARTIFACT-STORE credentials — registry creds, NOT credentials to infrastructure execution systems manage (charter principle 1 holds). They live in the EXISTING AES-256-GCM `secrets` vault (`secrets/secrets-repo.ts` — same vault, same envelope, same resolution seam as executor credentials), scoped PER-REGISTRY under the keys `relaySourceReadSecretKey` / `relayDestPushSecretKey`. No admin/delete grants are ever needed (read on source repos, push on destination repos). They are handed to skopeo/cosign via a mode-0600 scratch docker auth file, NEVER via argv (argv is logged) and never echoed into Decisions, audit events, or responses. The auth file reaches skopeo via explicit `--src/dest-authfile` flags and cosign via a PER-INVOCATION subprocess `DOCKER_CONFIG` env — never a `process.env` mutation, which on this multi-tenant server would leak one org's registry auth into every concurrently spawned cosign/skopeo subprocess.

## Roles

`buildRelayTarball` runs ONLY on a `role: 'retrans'` instance (`scp federation init --role retrans`) — any other role refuses (409). This activates the ADR-0004 arm that was declared-but-placeholder in `self-repo.ts`. The destination import runs on the receiving outpost (any role) — it is the outpost's own registry-load operation.

## TLS / CA (the #111 recorded decision)

The SCP runtime image carries NO CA bundle. For TLS registries the operator provides CAs via `SCP_RELAY_CERT_DIR` (passed to skopeo as `--src-cert-dir`/`--dest-cert-dir`). Plain-HTTP / self-signed in-cluster registries (the common outpost-local Gitea shape) are supported via the explicit `SCP_RELAY_INSECURE_HOSTS` allowlist (`--src/dest-tls-verify=false` for exactly those hosts) — safe here because the cosign SIGNATURE, not registry TLS, is the trust anchor (the same argument as `VerifyImageOptions.allowInsecureRegistry`). See docs/runbooks/retrans-relay.md.

### §476. Config surface (documented in docs/runbooks/retrans-relay.md)

Config surface (documented in docs/runbooks/retrans-relay.md). All operator-configured env — bundle-supplied data NEVER steers relay egress (ADR-0019 §4): the pull side is guarded by the two artifact allowlists, and the push side needs no allowlist because the destination is the relay's OWN configured registry, never bundle data.

### §477. Scoping (dated 2026-07-23, ADR-0019 §3 addendum)

Scoping (dated 2026-07-23, ADR-0019 §3 addendum): these keys are per-registry-host only, not literally per-peer. Per-peer scoping holds IMPLICITLY today because a retrans instance serves exactly one boundary/peer, so its per-host keys are per-peer in practice. A future multi-peer retrans would need the peer encoded in the key shape (e.g. `relay/source-read/<peerId>/<host>`) — a vault migration at that point, not a change needed now.

### §478. 13.2b — vault key holding the S3 DeliveryTarget credential

13.2b — vault key holding the S3 DeliveryTarget credential (`accessKeyId:secretAccessKey`) for one peer, per DIRECTION: `out` is WRITE-scoped (the outbound CDS drop), `in` is READ-scoped (the inbox). Under the ADR-0019 §3 artifact-store credential class (an S3 bucket is a passive shelf) — a target WITHIN that class, not a new class. Resolved at use via the SAME `getSecretValue` as the relay's `relay/source-read/<host>` keys; injected to the SDK client, never argv/logs/ Decisions. Per-peer scoping is EXPLICIT in the key (a retrans may serve one peer, but an s3 delivery bucket is genuinely per-peer), unlike the relay registry keys' implicit per-peer scope.

### §479. Parses the vault value into an object-store credential pair

Parse the vault value for a `deliveryTargetSecretKey` into an S3 credential pair. The value is `accessKeyId:secretAccessKey`, split on the FIRST `:` only — an AWS secret access key is base64-shaped (`[A-Za-z0-9/+]`) and never contains `:`, so the first colon is unambiguous. A value with no colon, or an empty half, is malformed → `null` (the caller fails closed on a missing/bad credential).

### §480. The registry-attached signature artifacts, as a layout

OCI: the registry-attached cosign signature artifact(s), each as an OCI layout + the tag it was stored under at the source. Cosign's storage scheme varies by version — the legacy `sha256-<hex>.sig` tag and/or the OCI-1.1 referrers-fallback `sha256-<hex>` tag — so the relay carries whichever exist(s) and re-creates the SAME tag(s) at the destination, keeping the receiving M17.4(b) `cosign verify` working regardless of the signing cosign's vintage.

### §481. Vendored skopeo execution; resolution lives elsewhere

Vendored-skopeo execution. Resolution + pin assertion live in @scp/cosign (M15.5 c1); this wrapper only adds fail-closed execution + argv-only logging (credentials ride an authfile, never argv — argv IS logged).

### §482. ASYNCHRONOUS by requirement, not by taste

ASYNCHRONOUS by requirement, not by taste (M13.1b). Until this milestone `buildRelayTarball` had exactly one non-test caller — the operator-invoked route — so a blocking `execFileSync` around a multi-GB `skopeo copy` froze one deliberate, human-initiated request. M13.1b puts the same pipeline on an unattended timer inside the shared worker process, which also hosts reconcile, watchdog, observe, inbox and federation-sync (`main.ts`): a synchronous pull there would stop the event loop — every other loop, every in-flight HTTP request on a combined `SCP_ROLE=all` process, and the SIGTERM handler that makes a rolling restart graceful — for as long as the copy takes. `execFile` keeps the subprocess semantics identical (argv only, no shell) while yielding.

### §483. Credentialed source registries

Credentialed source registries: cosign's registry reads honor DOCKER_CONFIG, skopeo takes an explicit --src-authfile — BOTH point at the same 0600 scratch config so credentials never touch argv or logs. DOCKER_CONFIG is handed to cosign as a PER-INVOCATION subprocess env (`cosignEnv` below), NEVER by mutating process.env: this is a multi-tenant server, and a process-global mutation would leak this org's registry auth into every cosign/skopeo subprocess that happens to spawn during the window (another org's concurrent relay, an M17.4(b) pre-deploy-gate verify) — and two concurrent relays would race each other's save/restore.

### §484. This particular tag scheme isn't present

This particular tag scheme isn't present (or its artifact couldn't be copied) — fine as long as SOME signature artifact lands (asserted below); the VALIDATE step still independently proves the signature verifies against the exporter's key. Recorded so the fail-closed refusal names the REAL per-tag error: an absent tag ("manifest unknown") reads very differently from a copy-tooling failure (e.g. a pre-1.16 skopeo refusing the referrers-fallback OCI index under --preserve-digests), and the refusal is all an operator gets.

### §485. ATOMIC PUBLICATION (M13.1b)

ATOMIC PUBLICATION (M13.1b). The drop directory IS the org's CDS intake, and a CDS watcher polls it. `tar czf` straight to the final name publishes a GROWING file, so a watcher can pick up a truncated tarball mid-write — latent while a human ran the relay and then walked the file over, LIVE the moment an unattended loop writes it (and doubly so if a lease expiry ever lets two builders write the same name). So the archive is written under a temp name in the SAME directory (rename is atomic only within one filesystem) and renamed into place: that rename is the single instant the file becomes visible under its channel-artifact name, whole. The temp name deliberately does NOT match `scp-relay-*.tar.gz`, so a loopback config whose drop dir doubles as an inbox can never mistake a partial for an arrival.

### §486. Fail-closed: a tampered or missing artifact never crosses

FAIL-CLOSED REFUSAL: a failing/tampered/unauthorized/missing artifact NEVER crosses — block Decision + hash-chained audit event, like every gate (charter principle 6).

BOUNDED PAYLOAD (M13.1b). Each entry embeds skopeo's verbatim stderr and the authorized artifact set has no schema-level maximum, so an unbounded join could persist a multi-megabyte `reason` + `input_context` into `decisions` AND (via `appendAuditEvent`) `audit_events` and the sync journal — tables ADR-0024 classes as never-deleted. Once this function runs on a timer that is #153's pathology arriving by size instead of by row count, so both the joined text and the persisted `failing` array are truncated to a head plus an honest total. The COMPLETE per-artifact detail still reaches the operator on the spot, via the `+ skopeo …` stderr trace and the per-attempt log line; only the permanent record is bounded.

### §487. The build hop's own row, so the byte leg is visible too

M13.1b — the BUILD hop's own `submitted` row, so the byte leg is visible on the SAME `bundle_transfers` status surface §13.1 names for the staging node and M16.1's boundary segment reads. The forward hop has always written this pair (`validateAndForwardRelayTarball` below); the build hop wrote nothing at all, so an unattended build was invisible to every surface except the logs — untenable once nobody is watching a terminal. Validate-gated by construction (D4): this transaction runs only after every artifact verified and the tarball landed. Attributed to the DOWNSTREAM peer the drop targets when the caller resolved one, else the upstream import peer — the same fallback the forward hop uses.

### §488. The decompressed-size ceiling for an untrusted tarball

Decompressed-size ceiling for an untrusted inbox relay tarball (`SCP_RELAY_MAX_DECOMPRESSED_BYTES`, default 4 GiB). `tar xzf` extracts to disk BEFORE any signature/checksum check runs, so a gzip bomb (a few KiB on the wire, terabytes decompressed) would fill the scratch volume / OOM the worker before the first trust decision — a fail-open the streamed CHECKSUMS verification cannot catch because it runs on the already-extracted files. `runTar`'s `maxBuffer` bounds only captured pipe output, not extracted files, so it is not this control.

### §489. Stream the gzip through a counting sink

Stream the gzip through a counting sink (bounded memory — chunks are counted and discarded, never buffered) and throw `RelayImportRefusal` the moment the decompressed byte total exceeds the cap, BEFORE `tar` writes anything to disk. A malformed/corrupt gzip surfaces as a pipeline error, which the caller also converges on a fail-closed refusal.

### §490. An extraction: a refactor, not a new trust decision

M13.1a EXTRACTION (proposal §13.1 — "a refactor, not a new trust decision"): the verification half of the destination import, byte-equivalent to what `importRelayTarball` always ran inline with its registry-push flow, now callable WITHOUT the push half so a `role: retrans` staging node can validate-and-forward a tarball it has no registry to push into. The checks, in order, exactly as before:

```text
1. tarball transport integrity — CHECKSUMS.txt.sig against the OPERATOR/PAIRING-provided
   relay cosign public key (never a key found inside the tarball), then every file against
   CHECKSUMS.txt;
2. relay-manifest parse + binding to THIS change's imported source change;
3. AUTHORIZATION CROSS-CHECK — every carried artifact must be in the LOCAL change's own
   M17.4(a)-verified authorized set (zero trust in the relay's own manifest);
4. per-artifact pre-push verification — OCI layout digest + integrity self-check, blob
   byte-hash equality.
```

`requireBlobLandingDir` is the ONE caller-mode difference: the destination import lands blob bytes in `config.blobOutDir` and must therefore refuse when it is unconfigured (unchanged behavior); the retrans forward never lands blobs — the tarball is forwarded whole — so the landing-dir config check does not apply there. Throws `RelayImportRefusal` on any failing check; the caller converges every refusal on one block Decision.

### §491. Phase 2 (no tx): verify EVERYTHING about the tarball, then push

Phase 2 (no tx): verify EVERYTHING about the tarball, then push. All verification (signature, checksums, authorization cross-check, per-layout digest + integrity, blob digests) completes BEFORE the first push — a tampered or unauthorized tarball pushes NOTHING. The verification itself is `extractAndVerifyRelayTarball` — extracted (M13.1a, byte-equivalent) so the retrans forward path runs the SAME checks without the push half below.

### §492. TOCTOU close (copy-once-then-operate-on-the-private-copy)

TOCTOU close (copy-once-then-operate-on-the-private-copy): input.tarballPath sits in the attacker-writable low-side inbox. Ingest its bytes into the server-controlled scratch dir EXACTLY once, then hash + verify ALL from that private copy — so the D4 confirmed-transfer checksum below describes the SAME bytes that were verified and imported, never a post-verify swap of the inbox file. After this copy `input.tarballPath` is never read again. The copy+hash live INSIDE the try so a missing/unreadable inbox path converges to the fail-closed block Decision (route → 409), not a raw throw that leaks the scratch dir.

### §493. Phase three: record where the bytes actually landed

Phase 3 (tx): record WHERE the bytes landed on the change's `sourceRef.artifacts[].location` (+ blob signatureRef URLs) — the byte-landing seam artifact-verify.ts's LocationRegistryReader documents. `location` is deliberately UNSIGNED bundle-side metadata: the M17.4(b) gate binds every verification to the manifest-signed DIGEST regardless of what location says, so this update cannot weaken the gate — it only tells it where to look.

### §494. RETRANS SIDE, INBOUND

RETRANS SIDE, INBOUND — validateAndForwardRelayTarball (M13.1a, proposal §13.1): the push-less VALIDATE-AND-FORWARD for a relay tarball ARRIVING AT a `role: retrans` staging node (the high-side hop of a double-retrans CDS crossing). A retrans has NO registry to push into (deployment profile, §13.1) — its whole job on this hop is: run the SAME verification the destination import runs (`extractAndVerifyRelayTarball`, the byte-equivalent extraction — "a refactor, not a new trust decision"), then hand the UNTOUCHED original tarball bytes to the outbound DeliveryTarget drop. It imports nothing, pushes nothing, decides nothing about the promotion (ADR-0004: retrans never terminates a promotion).

### §495. The DOWNSTREAM boundary peer this onward hop targets

The DOWNSTREAM boundary peer this onward hop targets (its federation domain id) — the loop resolves it from `resolveOnwardOutDir`'s peer match. Used ONLY to attribute the onward `export`/`submitted` `bundle_transfers` row to the peer the drop actually goes to (M16.1 per-peer surface); observational only (the ledger is never authority). Absent (env-fallback drop, no downstream peer resolvable) → falls back to the upstream import peer.

### §496. Phase 2 (no tx): the EXTRACTED verification

Phase 2 (no tx): the EXTRACTED verification — tarball signature, per-file checksums, manifest binding, authorized-set cross-check, per-artifact layout/blob integrity — with the push half absent and `requireBlobLandingDir: false` (the tarball is forwarded WHOLE; nothing lands here). Then the onward drop of the ORIGINAL file bytes. NO skopeo ever runs on this path — the retrans profile needs no registry for the forward hop.

### §497. TOCTOU close (copy-once-then-operate-on-the-private-copy)

TOCTOU close (copy-once-then-operate-on-the-private-copy): input.tarballPath sits in the attacker-writable low-side inbox. A low-side writer who SWAPS it between our verify and our forward-copy would push UNVALIDATED bytes across the boundary drop under an allow Decision — the exact zero-trust invariant this feature protects. So we ingest its bytes into the server-controlled scratch dir EXACTLY once, then hash + verify + forward-copy ALL from that private copy. After this copy `input.tarballPath` is never read again: a mid-window swap changes only the abandoned inbox file, never the bytes we verify/forward/hash. The copy+hash live INSIDE the try so a missing/unreadable inbox path converges to the fail-closed block Decision (D4), not a raw throw.

### §498. M13.1b — TERMINATE this change's auto-relay obligation

M13.1b — TERMINATE this change's auto-relay obligation. Both boundary nodes are `role: retrans` (ADR-0009 §38), so both seed a relay-build row when they import the promotion `.scpbundle`; but the node whose BYTES ARRIVE is the receiving side of the hop and must never also try to build them (its source registry is on the far side of the air gap — which is precisely why this tarball exists). Recording `forwarded` here is the causal signal that this node is that side, and it is what stops the sweep from producing a trail of fabricated refusals over a promotion that in fact crossed successfully.

## `apps/server/src/federation/scan-db-preload.integration.test.ts`

### §499. Offline database preload, staleness and operator load

M13.3b-ii — OFFLINE DB PRE-LOAD + STALENESS + OPERATOR-LOAD end-to-end (ADR-0020, proposal §13.3b).

The runner image is resolved ONCE (pulled via SCP_RUNNER_SCAN_IMAGE_REF or legacy-built), and the REAL baked Trivy DB is extracted from it into a host cache dir — a genuine, schema-correct DB with real metadata (fabricating one offline is impossible). That cache is the "server-provided pre-loaded DB dir" the scenarios exercise: (a) pre-loaded DB scan → the runner uses the copied-in DB (`--network none`, `--skip-db-update`) and produces a valid digest-bound ScanEvidence whose `scanDbSource` is the CACHE, not baked. (b) a MISSING/empty configured cache → fail-closed (no evidence → E6 refuses with a decision_id). (c) a DB past the HARD max → fail-closed; a DB past the SOFT max → scans + WARN (surfaced in evidence). (d) the operator-load path VERIFIES a cosign-signed DB blob and REFUSES a tampered / wrong-key one with NO cache write.

Staleness bounds are driven by the instance policy row (written over the domain admin connection, the production operator-write path) so the REAL baked DB — of unknown real age — lands in the intended class deterministically (huge bounds ⇒ fresh; tiny soft ⇒ warn; tiny hard ⇒ hard-fail).

### §500. The same seam, and for the same reason, as its sibling

Same seam, and for the same reason, as `promotion-scan-step.integration.test.ts` (read the long note there): this subject reaches the registry through `skopeo copy`, which never consults the local Docker image store, so the local re-tag that keeps Testcontainers off Docker Hub cannot cover it. CI exports `SCP_TEST_SUBJECT_REGISTRY` pointing at the GHCR mirror of the digest `tools/ci-mirror/images.list` pins; unset (a developer's machine) it is upstream Docker Hub.

## `apps/server/src/federation/scan-evidence.test.ts`

### §501. THE BOUNDARY SCAN-EVIDENCE RULE

THE BOUNDARY SCAN-EVIDENCE RULE — the algebra, in isolation from Postgres.

Every case here is an authorization case: `evaluateScanCoverage` is what decides whether an artifact may cross a security-domain boundary, and it is the SHARED core of the M17.3 E6 export gate and the ADR-0020 promotion scan step's short-circuit. The end-to-end proofs (a real `webhook-control` row refused at a real export, a real superseding failure) live in `federation.integration.test.ts`; this file pins the rule's edges cheaply and exhaustively.

## `apps/server/src/federation/scan-evidence.ts`

### §502. What counts as a scan outcome at the export boundary

WHAT COUNTS AS A SCAN OUTCOME AT THE FEDERATION EXPORT BOUNDARY — the single rule the M17.3 (E6) export gate (`promotion-repo.ts`) and the ADR-0020 promotion scan step's short-circuit (`promotion-scan-step.ts`) both apply.

ONE MODULE, TWO CALL SITES, ON PURPOSE. Those two predicates were written as separate copies of "status pass + `ScanEvidenceSchema` parses + digest matches", each documented as being the exact twin of the other. They were — and a rule maintained in two places with a comment promising they agree is a rule that will eventually disagree. Worse, they must agree for a *safety* reason and not merely a tidiness one: the short-circuit decides whether a managed scan RUNS, and the gate decides whether the export CROSSES. A short-circuit that is looser than the gate suppresses the scan that would have satisfied the gate; a short-circuit that is tighter re-scans an artifact that is already covered. Both call `evaluateScanCoverage`.

FOUR PROPERTIES THIS FIXES, ALL OF THEM AT A CROSS-BOUNDARY AUTHORIZATION GATE

**1. A SCAN OUTCOME IS IDENTIFIED BY ITS PRODUCER, NEVER BY THE SHAPE OF ITS EVIDENCE.** The gate used to accept ANY `control_runs` row whose jsonb evidence happened to parse as `ScanEvidenceSchema`. `control_runs.evidence` is stored VERBATIM from whatever a bound ControlPlugin returns (`governance/control-runner.ts`: `evidence = outcome.evidence ?? {}`), and `@scp/plugin-webhook-control` returns `body.evidence` verbatim from an operator-configured URL along with `body.status`. So a `webhook-control` binding pointed at a URL that answers `{"status":"pass","evidence":{…ScanEvidence-shaped…,"digestMatch":true,"artifactDigest":"<the promoted digest>"}}` manufactured a row that satisfied E6 exactly. That is a complete bypass of the boundary scan gate, authored at `policy:write` **scoped at a control object** — strictly weaker than the operator authority that sets the instance floors (ADR-0016 §3 makes `scan_requirement_floors` operator-write / tenant-read precisely so a tenant cannot loosen them).

The fix is not a stricter shape test — no shape test can work, because the shape is the payload. `control_runs.plugin_module` (migration 0064) records WHICH KIND OF CONTROL produced a run, stamped at insert from the binding that actually ran, and `MANAGED_SCAN_CONTROL_OBJECT_ID` identifies the commander's own step. Those are the two ADR-0020 §1 ingresses — the managed promotion scan step and the org-pipeline `scan-result-control` alternate — and they are the only two producers admitted here. This is the same move `dependencies/bump-actuator.ts` already made for the auto-merge grant, for the same reason, one migration earlier.

**2. THE LATEST ANSWER WINS.** The gate used to accept any HISTORICAL passing row, forever: a later failing scan of the same artifact by the same control did not supersede it. Runs are grouped by the QUESTION they answer (`questionKey`) and only the newest run of each question is consulted — every one of which must pass. An older pass therefore cannot outvote a newer fail, and (the direction that matters for ADR-0033) a newer pass DOES clear an older fail, so a re-evaluation can still unblock an export.

**3. THE OPERATOR'S FLOOR BINDS AT THE BOUNDARY.** The gate applied no threshold of its own — it accepted the producer's `status` and never looked at what that verdict was judged against. Evidence can be judged against a per-binding `config.threshold` (`scan-result-control`'s `resolveThreshold` falls back to it when the gate threads no scoped ceiling), which is tenant-authored. So the `severityCounts` of the satisfying evidence are re-checked HERE against the INSTANCE-SCOPED FLOORS (`scan_requirement_floors`, ADR-0016 §3) — and only those.

WHY ONLY THE INSTANCE FLOORS, AND NOT THE SIX-TIER RESOLUTION. The four org-and-below tiers are tenant-authored policy data: re-resolving them here would add no authority a tenant does not already hold, while paying exactly the cost ADR-0016 §4 rejected design (B) for — a second evaluation of the same criterion, producing a second, possibly-divergent verdict. The two above-org tiers are different in kind: they are the operator's statement about the deployment, unwritable by any tenant, and E6 is the operator's boundary. Checking those and stopping is the whole of the defence-in-depth this gate's own doc comment already claimed to be.

**With no floor authored — the default on every deployment — this check constrains nothing and the gate's behaviour is byte-identical to before it existed.**

**4. A VERDICT IS ONLY CURRENT WHILE THE EXCLUSION SET IT WAS JUDGED UNDER IS** (M22.9, ADR-0033 §10 — added after properties 1-3, at the boundary they left open). Property 2 makes the newest answer win, which catches a re-scan that FAILED. It does not catch the case where nothing re-ran at all: an override grant expires or is revoked, NO ROW CHANGES — expiry is a read-time window in the resolver, since ADR-0033 rejected a status-flipping sweeper — and the covering `pass` keeps authorizing crossings under a waiver that no longer exists. Both producers already stamped `evidence.exclusionSetHash` for exactly this comparison and until this check NOTHING read it on the export path: a new promotion of the same digest found the covering pass, re-scanned nothing, and `promotion-repo.ts` accepted that row into the SIGNED BUNDLE. The caller resolves the set in force NOW and passes its hash; a run judged under any other set refuses. The asymmetry around an absent hash on either side is enumerated at the check inside `evaluateScanCoverage`.

WHAT THIS IS STILL NOT
It NEVER runs a scan (charter principle 1) and it never re-counts findings: it re-verifies the existence, provenance, currency and digest-binding of an outcome an execution system already produced. And it is not a *replacement* for the lifecycle gate — it is the boundary re-check.

### §503. The well-known object id every such row carries

The synthetic, well-known object id every `control_runs` row the commander's promotion scan step deposits is tagged with. Lives HERE rather than in `promotion-scan-step.ts` (which re-exports it, so every existing import still resolves) because it is now part of the ADMISSION RULE, and the admission rule must not import the module whose short-circuit it defines.

### §504. The ControlPlugin modules whose verdict IS a scan verdict

The ControlPlugin modules whose verdict IS a scan verdict — ADR-0020 §1's "org-pipeline scan evidence remains a supported alternate ingress".

`scan-result-control` and nothing else. The other two modules a control binding can name (`control-runner.ts`'s `KNOWN_CONTROL_MODULES`) are deliberately absent and neither absence is an oversight: * `webhook-control` — "POST to an operator-configured arbitrary URL and return whatever it says". Its evidence is an unvalidated remote payload; admitting it here is the bypass this module exists to close. * `github-check` — reports a commit's Check Runs. A green CI run is not a scan verdict, carries no digest binding, and says nothing about an artifact's vulnerabilities.

Adding a module here GRANTS IT THE POWER TO AUTHORIZE A CROSS-BOUNDARY CROSSING. The bar is that the module's evidence is produced by a scanner it controls, not echoed from a caller.

### §505. The per-severity minimum across the instance floors

Per-severity MIN across the instance-scoped floor contributions (`readInstanceScanFloors`) — the `platform` and `trust_domain` rungs of ADR-0016's chain, and ONLY those. Commutative and associative like the resolver's own merge, so this is order-independent for the same reason (ADR-0016 §4).

### §506. Which question this run answers, the supersession key

WHICH QUESTION THIS RUN IS AN ANSWER TO — the key supersession is computed over.

For a BOUND control the question is the control: one binding fetches one verdict, so its newest run is its current answer. That is the same identity `latestControlRun` uses everywhere else in the system, which is why a re-run genuinely supersedes rather than accumulating.

For the COMMANDER'S STEP the control id is synthetic and MULTIPLEXES methods — one export deposits a `trivy` row and an `openscap` row under the same id — so the question is (step, method). Keying on the control alone there would make the gate ORDER-DEPENDENT in the worst possible direction: a `trivy` pass and an `openscap` fail for the same digest are written milliseconds apart, and whichever the loop happened to write second would decide the crossing. With the method in the key, both are consulted and both must pass.

A managed row always carries `evidence.scanner` (the step `ScanEvidenceSchema.parse`s before depositing, and deposits nothing when a runner fails), so the `""` fallback is unreachable for an authentic deposit and merely keeps this total.

### §507. WHICH PROMOTED DIGEST THIS RUN IS ABOUT

WHICH PROMOTED DIGEST THIS RUN IS ABOUT — read from `evidence.expectedDigest`, the field whose documented meaning is exactly "the digest the change is promoting, the value `artifactDigest` was bound against".

Read off the RAW evidence bag rather than a parsed `ScanEvidence`, deliberately: a FAILING run is frequently unparseable (`scan-result-control`'s `fail()` emits `{url, expectedDigest}` and similar partial bags), and a failure that cannot be attributed to the artifact it is about cannot supersede the stale pass it should be superseding. Attribution has to survive the failure, or property 2 only works for the runs that succeeded.

### §508. ADDITIVE ONLY. This union is a server-internal type

ADDITIVE ONLY. This union is a server-internal type: it reaches an operator through a refusal Decision's `inputContext.refusalCode`, which is `additionalProperties: {}` free-form jsonb in `tools/openapi/openapi.v1.json` (verified — no member of this union appears in that file, in `@scp/schemas`, or in `apps/web`). So a new member needs no `pnpm gen` and cannot trip the oasdiff gate; what it DOES reach is a CLI/UI rendering `code` verbatim, which is why members are added and never renamed or repurposed.

### §509. Does this digest carry a current, floor-satisfying outcome

Does `digest` carry a current, digest-bound, floor-satisfying scan outcome from an admitted producer? THE rule — see the module doc for why each of the five narrowings exists.

FAIL-CLOSED IN EVERY DIRECTION: no admitted producer, a producer whose newest answer is anything but `pass`, evidence that no longer parses, a verdict bound to a different artifact, a verdict judged under an exclusion set that is no longer in force, or counts above the operator's floor all refuse. "Absent never means passed."

### §510. The hash of the exclusion set the caller resolved

M22.9 — the hash of the exclusion set the CALLER resolved as in force right now (`scanExclusionSetHash`, `governance/scan-exclusion-actuator.ts`), or `undefined` when it resolved none. Optional so this stays byte-identical for a caller that has not opted in AND for the deployments M22.2 promised nothing to: `undefined !== undefined` is false, so nothing resolved + nothing recorded refuses nothing. Every other combination refuses — see the check.

### §511. Is this verdict still judged under the set in force now

M22.9 (ADR-0033 §10) — IS THIS VERDICT STILL JUDGED UNDER THE SET THAT IS IN FORCE NOW?

BEFORE THE FLOOR CHECK ON PURPOSE. The counts the floor reads are a product of the exclusion set (and the ADR-0033 §2 note below makes that literal once `effectiveSeverityCounts` is what gets compared), so "which set was this judged under" has to be settled before any number derived from it is believed. AFTER the digest binding, because a verdict about a different artifact is not a stale answer to this question — it is not an answer to it at all.

THE ASYMMETRY IS `scan-exclusion-actuator.ts`'s, deliberately the same expression rather than a paraphrase of it — the stamp, the re-run trigger and this gate must mean one thing by "the set changed". Five combinations, and only the first two cross: * neither side has a hash → NO REFUSAL. Nothing authored, nothing recorded: byte-identical to before this check existed, which is M22.2's promise to every untouched deployment. * both, equal            → the set has not moved; the verdict stands. * both, different        → a grant was approved, revoked, edited, or expired out of the read-time window. The verdict was judged under a set nobody is standing behind now. * caller has one, the run has none → REFUSE. A pre-M22.7 run predates stamping, and clauses ARE in force now. The honest reading is "unknown", and fail-closed is the entire point of a boundary re-check — it costs a re-scan, never an unearned crossing. * the run has one, the caller none → REFUSE. Every clause has since been withdrawn, so the verdict was judged under a strictly looser set than the one in force.

### §512. Compatibility: what the compared number must become

ADR-0033 §2 COMPATIBILITY — when per-finding exclusions land, the number compared here must become the POST-exclusion `effectiveSeverityCounts`, not `severityCounts` (which ADR-0033 deliberately keeps meaning "what the scanner found"). Reading the raw count then would make every admitted exclusion invisible at this boundary and refuse crossings the grant authorized — the mirror image of the invisibility ADR-0033 §2 rejected a verdict-level waiver for. This is the one line that changes.

## `apps/server/src/federation/scan-exclusion-boundary-recheck.integration.test.ts`

### §513. The exclusion re-check is threaded in at both call sites

M22.9 (ADR-0033 §10) — THE EXCLUSION-SET RE-CHECK IS THREADED IN AT BOTH FEDERATION CALL SITES.

`evaluateScanCoverage` gained `expectedExclusionSetHash` and a `stale_exclusion_set` refusal, and the rule itself is pinned as a pure function in `scan-evidence.test.ts`. That file cannot tell you whether either CONSUMER passes the argument, and until this file nothing could: both call sites were protected only by the parameter being a REQUIRED POSITIONAL, so omitting it is a compile error while passing the WRONG VALUE is not. This repo's dominant defect is a component built, tested green against itself, and installed nowhere.

THE TWO SITES, and they are genuinely different consumers of the same rule:

```text
1. `promotion-scan-step.ts`'s covering-run SHORT-CIRCUIT — "this artifact already has passing
   evidence, so do not spend a managed scan on it". Wrong here and a stale verdict silently
   suppresses the re-scan that would refresh it.
2. `promotion-repo.ts`'s E6 EXPORT GATE — "this artifact may cross the boundary". Wrong here and
   an expired waiver authorises a crossing.
```

WHAT THIS FILE DRIVES, AND WHAT IT DOES NOT. Every case goes through `exportPromotionBundle`, the function `routes/federation.ts`'s `POST /federation/peers/:peer/promotions/:change` calls and the one that owns both call sites — the scan step in phase 1.5 and the gate in phase 2. It is reached directly rather than over HTTP for one reason: the injected `ManagedScanRunner` is the seam the step exposes so these branches are hermetic (no Docker, no registry, no real Trivy), and no route can inject it. STILL UNPROVEN HERE, stated rather than glossed: that the ROUTE reaches this function and turns `{refused: true}` into a 409 carrying `decision_id`. That wiring is covered by `federation.integration.test.ts`, and the real-container end-to-end by `promotion-scan-step.integration.test.ts`.

THE SETUP USES THE REAL AUTHORING DOORS — the M22.9 operator admission route for the two instance rungs, `POST /policies` for the clause, and `POST /scan-override-grants` + `/approve` + `/revoke` for the grant. Nothing here writes an admission or a grant behind the API, because a fixture that plants a row the product cannot is how the exclusion dimension shipped green and inert once already.

THE REPORT IS BYTE-IDENTICAL ON EVERY PASS — a clean scan, zero findings, in every case. That is deliberate: the counts, the threshold and the digest binding are then constant across the whole file, so the ONLY thing that can move a verdict is the exclusion SET. A refusal here cannot come from anywhere else.

MUTATIONS RUN against this file (2026-08-18) — the MEASURED result of each, each applied ALONE against a passing suite and reverted by an exact inverse edit. Baseline: 4 passed. Nothing below is a prediction.

```text
M-1  `promotion-repo.ts`: pass `undefined` instead of `expectedExclusionSetHash` to
     `evaluatePromotionScanGate` (the E6 EXPORT GATE)
       -> 4 failed (B1, B2, B3, B4). Every case exports at least once under a set that is still
          in force, and under the mutation every one of those exports refuses
          `stale_exclusion_set` — including B2's SETUP export, which is why the security case
          fails here too rather than passing for the wrong reason.
M-2  `promotion-scan-step.ts`: pass `undefined` instead of `exclusionSetHash` to
     `isCoveringScanOutcome` (the covering-run SHORT-CIRCUIT)
       -> 1 failed (B3), and ONLY B3: `expected [...] to have a length of 1 but got 2`. B1 and B4
          stayed green because the mutation's cost is a redundant managed scan, not a wrong
          verdict — the re-scan re-stamps under the current set and the export still crosses. The
          `promotion-scan-step.test.ts` + `scan-evidence.test.ts` unit suites also stayed green
          (48 passed), which is the point: nothing but a call-count assertion at a real export
          can see this deletion.
```

WHY THE POSITIVE CASES ARE THE ONES THAT CATCH BOTH OMISSIONS, which is the opposite of the guess this file was written on. `undefined` is not "no check" — it is "expect NO clause to be in force". Against a run stamped with a hash, `H !== undefined` still refuses, so B2 (the security property: a moved set must not authorise the crossing) is satisfied by the mutated code too and CANNOT see either deletion. What the deletions break is the agreeing case: a run judged under the set that is still in force stops being recognised. So B1/B3/B4 — "and it still crosses / still short-circuits" — are the installation proofs, and B2 is the property they exist to protect. A file of nothing but refusal cases would have called both mutations harmless.

### §514. Cleared even though this file gets its own database

Cleared even though `vitest.integration.config.ts` gives this FILE its own database: an admission is INSTANCE-scoped, so a row left behind admits loosenings for anything that later shares a database with it — and that isolation is a property of the runner config, not of this file. Over the ADMIN connection because the request-serving `scp_app` role holds no write grant on this table (which is the whole reason the write door is an operator route).

### §515. An org with an identity, a paired peer and a component

An org with: a federation identity and a paired outpost peer to export to; a component under a service; an admitted `approved_override` clause at the org; and ONE live grant excusing a CVE on that component.

The grant is the LEVER. Revoking it moves the resolved set — and therefore its hash — while touching nothing else: same clause, same targets, same admissions, same scan report.

### §516. THE SECURITY PROPERTY

THE SECURITY PROPERTY. The run is untouched: same row, same `pass`, same clean counts, same digest binding. Only the set moved, and the boundary re-check is the only thing that can see it. `scanRunner: null` disables the step for the second export deliberately — a re-scan would refresh the stamp and hide exactly the state this case is about.

NOTE WHAT THIS CASE CANNOT DETECT, because a test that over-claims is worse than none: passing the gate `undefined` instead of the resolved hash ALSO refuses here (a stamped run never equals `undefined`). B1 is the case that sees that. This one pins the behaviour; B1 pins the wiring.

### §517. THE SHORT-CIRCUIT'S INSTALLATION PROOF

THE SHORT-CIRCUIT'S INSTALLATION PROOF. A second export of the same change, with nothing moved, must reuse the covering run — the step exists to not pay for a managed scan twice. Hand `isCoveringScanOutcome` `undefined` instead of the resolved hash and every stamped run looks stale, so this export scans again and the call count goes to 2.

The cost of that mutation is amplification rather than an unearned crossing, and the export still succeeds under it — which is precisely why this assertion is a COUNT and not a verdict.

### §518. The pair to that case: the refusal is not a wedge

B3'S PAIR, and the case that says the boundary refusal is not a wedge. `promotion-scan-step.ts` resolves the hash ABOVE the short-circuit loop for exactly this reason: computed after it, the step could only ever re-stamp what this pass already believed, and a change carrying an exclusion would refuse `stale_exclusion_set` forever with no way to clear it.

Byte-for-byte B2 with ONE substitution: the second export has the runner armed rather than disabled. Read the two together — the same revoked grant either refuses the crossing (no scanner available) or buys a fresh verdict under the current set (scanner available). Nothing in between.

## `apps/server/src/federation/scope-filter.test.ts`

### §519. A domain-local entry matches no sync scope, either way

M20.2 (ADR-0031 §3) — a domain-local entry matches NO sync scope, in either direction.

A unit test rather than an integration one because `entryMatchesScope` is a pure predicate and this is the layer where EXHAUSTIVENESS over the scope modes is cheap: the two-database end-to-end proof (bundles, signatures, cursors) belongs in the integration suite, but it can only afford to exercise one or two scopes. Both layers are needed and neither substitutes for the other — this file is what makes "no scope" a real claim rather than "not the scope we happened to test with".

### §520. Documented behaviour, not an accident, and directional

Documented behaviour, not an accident, and the direction is deliberate: the only producer of this field is `graph/objects-repo.ts`, which writes a real boolean off a NOT NULL column, so a non-boolean here means a direct database write or a code bug — not an operator declaration to be honoured. Coercing would instead make `0`, `""` and `"false"` each mean something, which is exactly the ambiguity a filter deciding what crosses a security boundary must not have.

### §521. That helper probes with a locality-free synthetic entry

That helper probes the scope with a synthetic change-shaped entry carrying no locality, and it answers a question about the PEER's configuration ("would a change object ride at this scope?"), not about any particular object. Locality is per-object, so it must not fold into that answer — a domain that declares one component local has not become change-blind, and `service-board.ts` would start reporting components as `stable` if it had.

## `apps/server/src/federation/scope-filter.ts`

### §522. Sync scope filtering

Sync scope filtering (DESIGN.md §13: "sync scope is configurable per peer: full graph / policies-only / changes-only / status-only / label-selector custom").

SECURITY-SENSITIVE (M6 review fix — MAJOR: confidentiality). Applied at BOTH export and import. `export-repo.ts` ships ONLY the in-scope entries to a scoped peer — a `policies_only` / `status_only` / `custom` peer, scoped precisely FOR confidentiality, must never receive the full plaintext graph on disk / in transit (the earlier design filtered only at import, so the complete graph was still disclosed to a peer that then simply chose not to APPLY the parts outside its scope). `importSyncBundle` re-applies this same predicate as defense-in-depth.

A scope-filtered bundle is therefore SPARSE — its sequence has deliberate gaps — so it is verified with `verifyJournalChain({ contiguous: false })` (every rowHash + signature still checked; only omission of in-scope entries is undetectable, inherent to being shown part of a chain). The importer's cursor still advances to the FULL range's `throughSequence` so out-of-scope entries are marked seen and never re-requested. A future per-scope sub-chain (using the reserved `base_revision`/`conflict` journal fields) could restore full contiguity proofs per scope without a format break; out of v1 scope. Changing a peer's scope requires a full re-sync from sequence 0 (the cursor has already advanced past entries a widened scope would now want) — documented operational boundary.

### §523. Is this entry one whose object never leaves its domain

M20.2 (ADR-0031 §2/§3) — is this journal entry one whose object never leaves its own security domain?

Exported so the two sides can be reasoned about (and tested) independently of the scope modes, and so `export-repo.ts`/`import-repo.ts` can report *why* an entry was withheld without re-deriving the rule. Never widen this to consult anything outside the entry: the whole design rests on `entryMatchesScope` staying a pure, synchronous predicate that the importer — which cannot query the sender's database — can apply to exactly the same input and reach exactly the same answer.

### §524. Domain-local entries match no scope, in either direction

M20.2 (ADR-0031 §3) — DOMAIN-LOCAL ENTRIES MATCH NO SCOPE, IN EITHER DIRECTION.

Ahead of the mode switch, and deliberately not a case inside it: this is not a narrower scope, it is a property of the ENTRY that no scope can override. `full` is the mode that proves it — the widest scope there is, and the one an operator reaches for when something is missing, so a clause reachable only from the narrow modes would leak exactly when someone widens to debug.

`=== true` rather than truthiness: the payload is `Record<string, unknown>` off the wire, and a filter deciding what crosses a security boundary must have no coercion in it. The stamp is written ONLY when true (`graph/objects-repo.ts`), so absent means false and there is no third, unknown state to resolve — which is why the column behind it is NOT NULL.

Applied at BOTH ends, like every predicate in this module: `export-repo.ts` filters here so the bytes never leave, and `import-repo.ts` re-applies it so a peer that ships one anyway — a misconfigured or downgraded sender — still has it dropped rather than applied. That symmetry is only possible because the flag rides IN the payload; resolving it by a database lookup at export time would leave the receiving side with nothing to check.

### §525. The one entry shape carrying a change's object across

The one entry shape that carries a change's GRAPH OBJECT across a peer boundary. Probed through `entryMatchesScope` itself rather than restated as a list of modes, so this predicate can never drift from the filter it describes. It deliberately carries no `labels`: under a `custom` label selector, whether any given change object rides is a per-object fact this domain cannot know in advance, so the probe answers "not guaranteed" — the conservative direction.

### §526. True when a peer at this scope sends us its own objects

True when a peer at this scope will send us the change GRAPH OBJECTS it authors — i.e. when the ABSENCE of a change object locally is a real observation rather than a filter artifact.

Read consumers need this to stay honest. `status_only` forwards `change_status` (positive evidence that changes exist on the peer) while withholding the `object_upsert` that carries the change itself; `policies_only` forwards neither; a `custom` selector may forward some and not others. Under any of those, "no change object here" means "I was not sent one", NOT "none exists" — see `coordination/service-board.ts`, which would otherwise report a component mid-release as `stable`.

Sound for the RECEIVING side specifically because `import-repo.ts` re-applies this same predicate against the RECEIVER's own `peer.syncScope` (defense in depth), so a local scope that excludes change objects excludes them regardless of what the sender chose to ship.

## `apps/server/src/federation/self-origin-check.integration.test.ts`

### §527. THE SILENT-STOP DETECTOR

THE SILENT-STOP DETECTOR (federation/self-origin-check.ts).

PR #221 made every reconcile candidate query filter on `objects.origin_domain_id = federation_self.domain_id`. That closes a real single-writer hole, but it introduces an exposure the un-filtered loops did not have: if the identity ever stops matching the origins already stamped on an org's objects, every batch returns zero rows and ALL coordination for that org stops with no error and no log line. Indistinguishable from "nothing to do" — the exact shape of the 13-day outage in `coordination/executing-batch-starvation.integration.test.ts`.

WHAT MAKES THIS SUITE NON-VACUOUS. Three of the four fixtures below are HEALTHY, and two of them (the single-domain org and the replica-holding federated org) exist specifically to fail if the predicate is widened from "none of this org's objects are mine" to "some of this org's objects are not mine". A partial mismatch IS the normal steady state of a federated estate; a check that warns on it is an alarm operators mute, which is worse than no alarm at all. The divergent fixture alone would go green under a check that simply warned about everything.

The assertions on the message deliberately pin the IDS IT MUST CARRY (org, identity, the origins actually present) rather than its prose: an operator who cannot get both sides of the mismatch out of the log line has to reverse-engineer the cause at 2am, and that is a behaviour, not wording.

## `apps/server/src/federation/self-origin-check.ts`

### §528. Has this org been orphaned from its federation identity

"HAS THIS ORG BEEN ORPHANED FROM ITS OWN FEDERATION IDENTITY?" — a read-only operational check

## The hazard

Every reconcile candidate query now filters on the org's own trust-domain id: `eq(objects.originDomainId, selfDomainId)` in `coordination/changes-repo.ts`'s `listChangeRowsInStates` and `coordination/campaign-repo.ts`'s `listActiveCampaignObjectIds`. `selfDomainId` is resolved once per tick from `federation_self.domain_id` via `self-repo.ts::ensureFederationSelf`, which MINTS a fresh `uuidv7()` whenever the row is absent.

That filter is correct — driving a peer's replica is the S10 single-writer violation, and a filter (rather than a loop-body `continue`) is the only starvation-free way to express it. But it has a failure mode the loop-body skip did not have: if `federation_self.domain_id` ever diverges from the `origin_domain_id` already stamped on this org's objects — a partial restore, an org cloned into a new database, a rebuild that recreated the `federation_self` row — then EVERY candidate query returns zero rows and all coordination for that org stops. Silently. No error, no blocked change, no log line: an empty batch is exactly what "nothing to do" looks like.

This codebase has already paid for that shape once — thirteen days of production coordination lost behind green health checks (`coordination/candidate-loop-registry.test.ts`, `coordination/executing-batch-starvation.integration.test.ts`). Hence a check that can SEE the condition, rather than waiting for someone to notice nothing has deployed in a fortnight.

## The predicate, and why it is "none" rather than "some"

`objects.origin_domain_id` records the domain that AUTHORED the row. Anything this instance creates is stamped with `federation_self.domain_id` at creation (`graph/objects-repo.ts`: `const originDomainId = input.federationImport?.originDomainId ?? self!.domainId`), and anything imported from a peer keeps the exporter's id verbatim (single-writer authority: a replica carries its author's identity, not ours). So, over an org's live objects:

| self-origin | foreign-origin | verdict                                                    |
```text
|   > 0       |      0         | healthy single-domain org.                                   |
|   > 0       |    > 0         | healthy FEDERATED org — it authors its own rows and holds     |
|             |                | replicas of its peers'. Entirely normal; MUST stay quiet.     |
|     0       |    > 0         | ORPHANED FROM ITS OWN IDENTITY — warn.                        |
|     0       |      0         | a brand-new org that has created nothing yet — nothing to     |
|             |                | diverge from. Quiet.                                          |
```

The distinguishing fact is that federation never REMOVES or REWRITES the rows the local domain authored — importing a peer's journal only ever adds replicas alongside them. Every org this instance serves was created through `auth/local-auth.ts::ensureBootstrapAdmin`, which authors an `organization` root object (and the bootstrap admin's `user` object) locally, under whatever `federation_self.domain_id` held at the time. So "not one single live object in this org was authored under my current identity" is not reachable by any legitimate federation topology, however replica-heavy: it can only mean the identity no longer matches the rows it owns.

A PARTIAL mismatch is therefore deliberately NOT a finding. An outpost that syncs a large commander catalogue can legitimately be 99% replicas; warning on that would be an alarm operators learn to mute, which is worse than no alarm (`graph/integrity-repo.ts` makes the same argument about inert findings).

## What this check is NOT

- NOT on the hot path. It runs once at boot (`main.ts`) and on demand (`GET /api/v1/doctor`, `scp doctor`). The owner rejected a per-tick empty-batch warning: it costs a query on a one-second loop and floods the log for any org that is legitimately idle. - NOT a repair. It never writes — in particular it reads `federation_self` with a plain SELECT rather than `ensureFederationSelf`, precisely because that helper MINTS a row on a miss and would turn a diagnosis into the very divergence it is diagnosing. Which side is wrong (the identity, or the objects) is an operator decision that depends on where the good backup is.

### §529. One org's finding, in one read-only pass

One org's finding, in one read-only pass (two small queries: the identity row, and a grouped tally of origins). Tenant-scoped like every other repo function, so it can serve both the instance-wide boot sweep and the per-tenant `GET /api/v1/doctor` without a second implementation.

### §530. The operator-facing text, authored once and shared

The operator-facing text, authored ONCE and shared by the boot log, `GET /api/v1/doctor` and `scp doctor`, so the three can never drift. Deliberately long: this is read at 2am by someone who has just discovered that nothing has deployed for a fortnight, and every clause below is something they would otherwise have to reverse-engineer — what is broken, why it is silent, how it happens, and why the platform refuses to fix it for them.

### §531. Every org on this instance, one finding each

Every org on this instance, one finding each — the instance-wide form used by the boot check.

Enumerates orgs exactly the way every other instance-wide sweep does (`coordination/reconcile.ts::runReconcileSweep`, `coordination/watchdog.ts`, `federation/inbox-loop.ts`): a bare `select` off `orgs` (no RLS on that table), then one `withTenantTx` per org so each org's read stays inside the same RLS boundary as production.

### §532. THE STARTUP CHECK

THE STARTUP CHECK (called from `main.ts`). Logs one loud `warn` per orphaned org and returns how many it found.

NON-FATAL by design: an operator part-way through a restore must still be able to boot the instance and finish the job — and a check that can take the platform down is a check that gets deleted. Loud-and-running is the same call `main.ts` already makes for an ephemeral secrets master key and for an expired federation CRL.

## `apps/server/src/federation/self-repo.ts`

### §533. This org's own federation domain identity

This org's own federation domain identity (DESIGN.md §13: "every domain instance... a Domain Control Plane"). SCOPING DECISION (db/schema.ts's module doc): kept org-scoped, not instance-wide, so it rides the same RLS boundary as everything the journal carries.

Created LAZILY with `role: 'unset'` the first time anything needs it — DESIGN §4.1 "every row is born federation-ready" means `objects.originDomainId` needs a real domain id from the very first object an org ever creates, well before an operator has necessarily run `scp federation init --role commander|outpost|retrans`. `role` only changes via an explicit `initFederationSelf` call (never inferred), so a domain silently defaults to none of commander/outpost/retrans — federation stays fully opt-in per DESIGN §13 ("federation enhances operation, it is never required for it").

The `retrans` arm is no longer a placeholder (M15.5(c), ADR-0019): a `role: 'retrans'` instance — and ONLY one — may run the byte relay (`retrans-relay.ts::buildRelayTarball`), the ADR-0004 validate-then-relay behavior. Role remains advisory for everything else, but the relay treats it as a hard precondition (fail-closed 409 on any other role).

### §534. `scp federation init`

`scp federation init` — explicitly designates this domain's role and (optionally) renames it. Idempotent: safe to call again to rename, but changing `role` after peers are already paired is allowed (the operator's responsibility) since role is advisory metadata for the CLI/UI, not itself an authority check — single-writer authority is enforced by `originDomainId` alone, independent of `role`.

## `apps/server/src/federation/status-honesty.integration.test.ts`

### §535. The status row's remaining honesty defects

M16.2 phase A, REVIEW ROUND 4 — THE STATUS ROW'S REMAINING HONESTY DEFECTS (H3, H4, H9a).

Each case below is a MEASURED wrong answer from the previous revision, pinned so it cannot come back:

```text
H3 — `lastSyncedBundleChecksum` (documented as "the last CONFIRMED INBOUND **sync** bundle") and
     `lastSyncedAt` were read off `listRecentTransfers(...).find(t => t.status === 'confirmed')`:
     ANY direction, ANY kind, last 5 rows. Inserting the exact row `promotion-repo.ts` writes on an
     accepted promotion (import/promotion/confirmed) made the field report that PROMOTION checksum —
     and removed `lastSyncedBundleChecksum` from `unknownFields` — for a peer no sync bundle had ever
     arrived from.
H4 — `connectivity` overclaimed in BOTH positive branches: a peer with an `http://` baseUrl AND a
     deliveryTarget read `air-gap` (a configured, dialable-in-principle topology labelled air-gapped),
     and an https peer read `connected` even having never been reached. The field is now
     `transportMode` and says only what CONFIG says.
H9a — `lastSyncExportForPeer` ordered by `through_sequence DESC`, and Postgres DESC is NULLS FIRST,
     so one export row with a NULL `through_sequence` would sort first and make the code report
     "never exported" FOREVER. Not reachable through `export-repo.ts` today, which is exactly when a
     trap is cheap to disarm — so the trap is exercised directly.
```

### §536. The trap: a matching row whose confirmation is null

The trap: a row matching the SAME predicate whose `confirmed_at` is NULL. Postgres `DESC` is NULLS FIRST, so it sorted ahead of the real row and the `!row?.confirmedAt` bail below made BOTH `lastSyncedAt` and `lastSyncedBundleChecksum` read null — "never synced" and "bundle unknown" over a real sync. `recordBundleTransfer` cannot write this shape (it stamps `confirmed_at` whenever status is confirmed), so it is inserted directly — exactly as H9a's own test does, and for the same reason: an unreachable trap is the cheapest kind to disarm, and H3 has just made two more fields depend on this ordering.

## `apps/server/src/federation/status-pending-export.integration.test.ts`

### §537. M16.2 phase A (E3) — PENDING-VS-APPLIED, HONESTLY

M16.2 phase A (E3) — PENDING-VS-APPLIED, HONESTLY.

The M16.2 Overview asks for "pending-vs-applied" for air-gapped outposts. Grounding established that the APPLIED half cannot be derived at the commander at all: `sync_cursors` records only what WE applied FROM a peer, `export-repo.ts` ships only this domain's own entries (so a return bundle cannot carry our sequences back), and `bundle_transfers` has no production UPDATE path, so an EXPORT row is inserted `created` and never advances. DESIGN §13's "confirmed when a returned bundle carries the outpost's import cursor" is UNBUILT (named future increment M16.4).

So the fields E3 adds measure PENDING-EXPORT, and this file proves they measure exactly that — most pointedly by the test that makes the OUTPOST apply the bundle and shows the COMMANDER's numbers do not move. If they did, they would be an apply signal, and their names would be lies.

Uses the two-domain harness (two separate Postgres databases) because the import side genuinely needs a second instance; `getFederationStatus` is called directly, exactly as the route does.

### §538. And there is no field NAMED for application AT THE PEER

And there is no field NAMED for application AT THE PEER — structurally, not just by convention. `appliedAtPeer` appears only as an UNKNOWN declaration.

The pre-existing `lastAppliedSequence` is deliberately not caught by this: it is the INBOUND direction — how far THIS side has applied the PEER's journal, read from our own `sync_cursors` — which is genuinely observable here. Only the outbound direction is unobservable.

## `apps/server/src/federation/status-repo.ts`

### §539. The commander's cross-domain status view

`GET /federation/status` — the commander cross-domain status view (DESIGN.md §13): every known peer, this side's own sync freshness against it, and bundle-transfer history. Bounded per §13: for an air-gapped peer this is explicitly "as of" the last confirmed transfer, never presented as live — the CLI/UI layer is responsible for rendering `lastSyncedAt` with that framing rather than this endpoint claiming a false real-time guarantee.

M16.2 phase A (E3) widens it with the fields the Outposts Overview needs, under one rule: EVERY FIELD IS NAMED FOR WHAT IT MEASURES, AND ANYTHING WITHOUT A SOURCE IS ABSENT AND DECLARED UNKNOWN (`unknownFields`, the contract `ServiceBoardRowSchema` established). See `deriveConnectivity` and `lastSyncExportForPeer` for the two derivations, and note what is NOT here: there is no "applied at the peer" field, because nothing in this instance's database can observe that.

### §540. THE CONFIGURED TRANSPORT CHANNEL

THE CONFIGURED TRANSPORT CHANNEL — a fact about CONFIG, kept strictly out of `trustTier` (owner decision: one field meaning both trust posture and reachability would mean neither) AND strictly out of OBSERVATION (review round 4: the label used to say `"connected"`, which is a claim this instance cannot derive from config at all).

- `"dialable"` — an https/mTLS-capable base URL is CONFIGURED, so this side MAY dial the peer. It does NOT say the peer has ever been reached: that is `lastPullAttemptAt`/`lastPullSuccessAt` and `effectiveCadence`, in the same row, which do reflect failure. Uses the SAME predicate the sender and the M14.1 pair-time guard use (`federationPeerRequiresMtls`), so the label can never disagree with what the transport would actually do. - `"air-gap"` — NO base URL at all, and a configured `deliveryTarget`: a file/object channel an operator (or a CDS) carries. That IS the air-gapped topology. - `null` — not honestly derivable, in TWO cases, both declared unknown: * no base URL and no delivery target — no transport configured at all, a misconfiguration rather than a posture (it is emphatically NOT "air-gapped"); * a base URL federation REFUSES to dial (plain http). A peer with `http://` plus a deliveryTarget used to read `"air-gap"` — labelling a configured, non-air-gapped topology air-gapped because its URL was rejected. Two contradictory transport statements is a misconfiguration to surface, not a posture to infer.

### §541. A runtime property, so the cadence is consulted here

D4 is a RUNTIME property of this instance, so the reported cadence must consult it here rather than assume the pair-time check still holds. It uses the SCHEDULER'S OWN never-throwing probe — not the cheap presence check — because the presence check answers "are the paths set?" while the scheduler asks "did the material actually READ?". Those diverge in exactly the case D4 exists for (paths set, secret rotated away), and this endpoint's whole job is to make cadence divergence VISIBLE, so it must not be the thing that hides it.

### §542. AUTHORITY, NOT LAST-WRITE-WINS

AUTHORITY, NOT LAST-WRITE-WINS (review round 4). This used to be a plain `Map.set` loop over the list, so with two rows bound to one peer the LAST one seen won — and a `provenance:'manual'` shadow could silently OVERRIDE the commander's own asserted tier on the Overview, a hand-typed copy beating the authority. The projection now carries `originIsSelf`/`provenance`, so the winner is chosen the same way `findOutpostConfigByPeer` chooses one: local-origin first, then a verified replica, then an unverified shadow — and the winner's provenance rides out on the row so phase B can tell them apart.

RANK FIRST, THEN READ THE WINNER'S TIER (review round 5, N4). The loop used to `continue` on a tier-less row BEFORE ranking, so the ranking only ever chose among rows that HAPPENED to carry a value — and a commander's own local-origin object that deliberately asserts NO tier lost to a hand-typed shadow that did. Measured: `/federation/status` reported `il5` / `unverified` for a peer whose `GET /v1/federation/outposts/{peer}` answered `trustTier: null, originIsSelf: true` at the same instant. ADR-0022 says the local-origin row WINS, full stop: A LOCAL-ORIGIN ROW'S SILENCE MUST SILENCE THE FIELD. Choosing the winner first and reading its tier afterwards is also exactly what `findOutpostConfigByPeer` does, which is why the two surfaces now agree by construction rather than by coincidence (`outpost-handfill-wedge` pins the agreement).

### §543. THE CORRECTLY-FILTERED INBOUND ANCHOR

THE CORRECTLY-FILTERED INBOUND ANCHOR (review round 4). `lastSyncedAt`/`lastSyncedBundleChecksum` used to be read off `listRecentTransfers(...).find(t => t.status === 'confirmed')` — ANY direction, ANY kind, over the last 5 rows. A confirmed import/PROMOTION row (exactly what `promotion-repo.ts` writes on every accepted promotion bundle) therefore satisfied it, and the field documented as "the last confirmed INBOUND SYNC bundle" reported a PROMOTION checksum for a peer no sync bundle had ever arrived from. `lastConfirmedSyncImportAt` is the helper that has always had the right predicate (`direction='import' AND kind='sync' AND status='confirmed'`) and an index shaped for it; both fields now come off that ONE row, so they cannot disagree.

### §544. No operator has asserted a tier

No operator has asserted a tier (or there is no `outpost` object for this peer at all). `trustTier` has no other source in this codebase — it is entered, never derived. An UNVERIFIED hand-filled claim is listed too: the value rides the wire for shape stability, but it is not an assertion this instance can stand behind, so a UI must render it as unknown rather than as a commander assertion (`trustTierProvenance` says which case it is).

### §545. Promised but sourceless: the health rollup has no input

PROMISED-BUT-SOURCELESS. The M16.2 Overview asks for a per-outpost "health rollup" (from observe-enrichment) and for pending-vs-APPLIED. Neither has any source in this instance's database: no health signal is replicated per peer, and `sync_cursors`/`bundle_transfers` cannot observe what a peer applied (see `lastSyncExportForPeer`). Rather than invent fields, they are ABSENT from the schema and named here, so phase B's UI renders an explicit unknown instead of reading a missing field as healthy/zero.

### §546. The live-pull freshness and the cadence actually in force

M14.4 (S7, ADR-0009) — the live-pull FRESHNESS + the cadence actually in force. These are what an operator needs to answer "is this peer sparse, and is that intentional?": * lastPullAttemptAt / lastPullSuccessAt — an attempt WITHOUT a later success is a peer in the reconnect leg (it is back on the frequent cadence until one pull succeeds); * lastPokeReceivedAt — `null` on a pokeMode peer is the UNILATERAL-SPARSE misconfiguration (this side opted in, the other side never pokes). D2 keeps it polling, and this field is how you SEE that; * effectiveCadence — the cadence the scheduler would use RIGHT NOW, not the raw flag. It reports "poll" for a pokeMode peer that has never been poked (D2), when this instance has no outbound client-cert material (D4), and while the peer's last pull failed.

## `apps/server/src/federation/sync-scope-asymmetry.integration.test.ts`

### §547. THE SENDER-NARROW / RECEIVER-`full` ASYMMETRY

THE SENDER-NARROW / RECEIVER-`full` ASYMMETRY — a misconfiguration that halts federation sync, and that used to blame TAMPERING for it.

`federation_peers.sync_scope` is per-side LOCAL config: set independently by the operator on each domain, never carried on the wire, never reconciled. The receiver's default is `full`. So the most likely field mistake in an outpost rollout — the outpost operator pairs the commander without `--sync-scope` while the commander operator narrows what it SENDS — produces a receiver demanding a gap-free chain from a sender that legitimately ships a sparse one.

THE VERDICT IS UNCHANGED AND MUST STAY UNCHANGED (owner decision): the import is REFUSED, fail-closed. A sparse run and a maliciously thinned one are the same bytes — the bundle signature only proves the SENDER produced what arrived — so contiguity is the only check that catches an entry deleted and re-signed, and this is the one place it is caught. Relaxing it to be friendlier to a misconfiguration would trade a real detection for a diagnosability win that belongs in the MESSAGE.

WHAT IS PINNED HERE, therefore, is the message and the recovery: 1. the refusal names the peer, states THIS side's `sync_scope` verbatim, explains that a narrower sender legitimately ships a sparse chain, and says what to compare — and never says "tamper"; 2. it is not a verdict either: it says a genuine break looks identical and must be investigated if the two sides already agree; 3. NOTHING is applied and the cursor does not move; 4. once the operator RE-ALIGNS the two scopes, sync resumes cleanly — in EITHER direction, and with the strict path fully intact afterwards (no one-way ratchet).

(4) IS THE ONE THAT KEEPS BREAKING, AND PHASES 5-8 ARE WHERE IT IS NAILED DOWN (pre-M16 residual W1). A receiver whose OWN scope was narrow holds a cursor with NO row hash — correct while it is narrow, because a sparse chain has no linkable tail. WIDENING that peer back to `full` used to leave the strict path comparing the peer's next, perfectly contiguous run against JOURNAL_GENESIS_HASH, which it can never equal: the peer was wedged forever, by a SUPPORTED local configuration change, and the message's prescribed recovery was inert. The fix is a ONE-SHOT re-anchor permit `pairPeer` issues whenever the RESULTING `sync_scope` is `full` and the cursor is anchorless — regardless of what the scope was before that call — keyed to a local, authenticated operator action on config that never crosses the wire, which re-anchors the next run and relaxes NOTHING else. So: 5. re-widening BOTH sides resumes sync and restores a real anchor (PHASE 5, PHASE 6); 6. and the permit does not reopen the deletion window the owner chose to keep closed: a re-signed run with a middle entry removed is refused WITH the permit in force (PHASE 5a) and after it has been consumed (PHASE 7); 7. an anchorless cursor with NO permit — a state the current code no longer leaves a `full`-scope peer in on its own (PHASE 8 forces it directly to prove the message still describes it as what it is, rather than as a stale anchor — the W2 honesty fix).

### §548. ── PHASE 5. THE OPERATOR UNDOES PHASE 4

── PHASE 5. THE OPERATOR UNDOES PHASE 4: both sides go back to `full`. This is THE WEDGE (pre-M16 residual W1). This side's cursor was advanced under the SPARSE regime and therefore carries NO row hash — it never held one, because a sparse chain has no linkable tail. The commander's next bundle is contiguous, gap-free and authentic, and used to be refused anyway (and forever after), because an absent anchor was read as genesis, which a mid-chain run can never equal. Widening is a LOCAL, AUTHENTICATED operator action, so it — and nothing that arrives on the wire — is what issues the one-shot re-anchor permit.

### §549. The message must describe the code's actual state

── PHASE 8 (W2 — THE MESSAGE MUST DESCRIBE THE CODE'S ACTUAL STATE). An anchorless cursor with NO permit is not produced by any supported operation any more, so it is FORCED here: strip the row hash and the permit directly. What is pinned is that the refusal then says what actually happened — no anchor recorded, compared against genesis — instead of blaming a "last known-good anchor" and a "previous scope regime" that do not exist.

### §550. R1 — THE ALREADY-WEDGED POPULATION

R1 — THE ALREADY-WEDGED POPULATION (pre-M16 residual W1, follow-up fix). The PHASE 5-8 tests above all get to the wedged state via a scope TRANSITION (narrow → full), because that is how the fix in e40e569 issued the re-anchor permit. But every peer the shipped W1 bug actually wedged got there BEFORE that fix existed: its `sync_scope` already reads `full` (the operator widened it with the pre-fix code — that widen is HOW it wedged) and its cursor is anchorless. There is no transition left for that peer to make: `sync_scope` already says `full`. Under the transition-gated fix, the refusal message's own prescribed recovery (`scp federation pair <peer> --sync-scope full`) was a no-op — `previousScope.mode !== "full"` is false when the row already reads `full` — so the peer stayed wedged forever, byte-identical refusal and all.

THIS SUITE constructs that exact population DIRECTLY (peer paired at `full` throughout — never narrowed, so there is genuinely no transition anywhere in this test's history — with an anchorless cursor forced in afterward, the same technique PHASE 8 above uses), then runs the prescribed recovery and asserts it actually works: the permit is issued and the peer's next run is accepted with a strictly re-anchored cursor. It also re-confirms the permit issued this way is not a hole: a re-signed bundle with a deleted middle entry is refused with the permit in force and again after it is consumed, and a run starting above cursor+1 is refused too.

### §551. THE DEFECT, MADE CONCRETE

THE DEFECT, MADE CONCRETE: under the transition-gated fix, this call is a no-op for issuance — `previousScope.mode !== "full"` is false because the row already read `full` before AND after this call — so `reanchorFromSeq` would stay `null` and the peer would remain wedged forever. R1 keys issuance off the RESULTING scope and the cursor's actual (anchorless) state instead, so the permit IS issued here.

### §552. WHAT THE STRICT CHECK BUYS, stated as tests

WHAT THE STRICT CHECK BUYS, stated as tests. Each case re-signs the bundle after mutating it, which is what makes it meaningful: an in-transit attacker cannot get this far (the bundle checksum and signature cover `{header, entries}` and are verified first), so these model the residual threat — a signer, or anyone holding its key, producing bad content.

The DELETION case is the one that decides the whole design. It is indistinguishable, byte for byte, from a legitimately scope-narrowed sender; a receiver that tolerates holes takes it. Only contiguity refuses it.

## `apps/server/src/federation/test-bundle-promotion.integration.test.ts`

### §553. D23 AT THE CROSSING

D23 AT THE CROSSING — the test bundle rides the promotion manifest as an ordinary artifact, and the ONE mint site stays one.

WHY THIS NEEDED NO SCHEMA CHANGE, MEASURED RATHER THAN ASSUMED
`PromotionManifestSchema.artifacts[]` is already `{type: "oci"|"blob", digest, signatureRef?}`. The test bundle IS an OCI artifact beside the image (D23; §14 resolution 9: "digest-native, cosign-signed like every other artifact, riding the byte channel and registry replication unchanged"), so it fits that shape as-is. Nothing was added to the wire, the manifest keeps its `manifestVersion`, and an outpost one release behind reads a manifest whose only difference is one more entry in a set it already iterates.

THE MINT SITE, AND WHY "ONE" IS AN ASSERTION ABOUT **BEFORE** AS WELL AS AFTER
ADR-0045 D2: an `artifact` object is minted at promotion export (after the manifest is cosign signed) and at promotion import (after verification passes), and NOWHERE ELSE — "a build report, an `observe()` poll, a scan run — none of these creates an artifact object", because that is what keeps the population bounded to promoted digests with no GC problem to solve later.

So the natural-looking place to mint a test bundle — the moment a build REPORTS one — is exactly the place D2 forbids. A test that only checked "an artifact object exists after export" would pass just as happily on a build that minted at report time and again at export. This file therefore pins the ABSENCE first: no artifact object for either digest exists while the change merely sits proposed, and exactly one per digest exists afterwards.

WHAT THAT ABSENCE DOES **NOT** COVER, MEASURED AND STATED. This file reaches `proposeChange` directly, so its BEFORE assertion witnesses a mint site added at the propose door, at the scan step, or anywhere else between propose and export — but NOT one added at the typed REPORT ingress, which it never calls. Mutation M-c (mint the reported bundle in `webhook-processor.ts`) was run and this file stayed GREEN while `coordination/test-bundle-capture.integration.test.ts` case 1 went red naming the digest. The single-mint-site claim is carried by the two files TOGETHER; neither is complete alone, and the measured mutation table lives on that file.

"SIGNATURE-VERIFIED PER HOP BUT NOT SCANNED" IS A COLLISION, AND IT IS TESTED AS ONE
E6 demands a current, digest-bound, floor-satisfying scan outcome for every SUBSTANTIVE artifact before it may cross. D23 rules the bundle is never scanned (scan stays image-only per M13). Riding `artifacts[]` as an `oci` entry, the bundle would be demanded a scan that by design will never exist, and every promotion of a component that reports one would refuse forever, fail-closed.

`substantiveArtifactsOf` resolves that by excluding the digest the change ITSELF DECLARED as its bundle. B2 is the control that keeps the exclusion from being a hole: an unscanned OCI digest the change did NOT declare as its bundle still refuses the export, naming that digest. Same digest value, same runner, same everything else — only the declaration moves.

Real PostgreSQL via Testcontainers in this file's OWN database (`createIsolatedDomain`); the `ManagedScanRunner` is the injected seam the scan step exposes, so no Docker, no registry and no real Trivy are involved.

## `apps/server/src/federation/test-support/isolated-domain.ts`

### §554. A genuinely SEPARATE Postgres DATABASE

A genuinely SEPARATE Postgres DATABASE (not merely a separate org row in the shared test database) within the SAME Testcontainers Postgres container — used ONLY by `federation.integration.test.ts` to model two federation "domains" faithfully.

WHY THIS EXISTS (found the hard way, via this milestone's own integration tests): every other `*.integration.test.ts` file in this codebase models multi-tenancy as multiple ORGS inside the one shared test database — correct for RLS/authz tests, since real multi-tenancy in this product IS "one database, many orgs, RLS-isolated." Federation is different: DESIGN.md §13's whole premise is that two federation domains are two SEPARATE SCP INSTANCES, each with its OWN Postgres database — there is no shared `objects` table between them in production. That matters concretely because `objects.id` is a single GLOBAL primary key (not composite with `org_id`) — completely safe within one instance's one database (a real deployment never needs two ROWS with the same id), but federation import is SPECIFICALLY DESIGNED to preserve an object's id verbatim across domains (single-writer authority: the replica in the importing domain has the SAME id as the authoritative original, just non-authoritative). Modeling "two domains" as two ORGS sharing ONE physical `objects` table therefore hits a collision no production deployment ever can: the origin domain's own row (id=X, org=A) already occupies id=X globally, so ANY attempt to replicate that same id into another org's rows in the SAME table always violates the PK — regardless of which object, not just an edge case. Two real, separate databases (this helper) eliminates the false collision entirely and is also the MORE faithful test of the real topology.

Cheap relative to a second Testcontainers container: `CREATE DATABASE` + migrate, all against the one already-running container (a few hundred ms), not a new container spin-up.

### §555. Every org gets exactly one root `organization` graph object

Every org gets exactly one root `organization` graph object (auth/local-auth.ts `ensureOrgRootObject`'s exact convention: "stable, predictable id for the org root object" — `id = orgId`). Safe here (unlike the shared-Postgres org-as-domain approach this helper replaces) because every isolated domain has its OWN physical `objects` table — no cross- domain id collision is possible. Needed so ordinary `createObject` calls that don't pass an explicit `domainId` (handFillObject, createOverlay, ...) have a root to default to.

## `apps/server/src/federation/test-support/mtls-pki.ts`

### §556. Test-only throwaway certificate and revocation generation

Test-only throwaway-CA/leaf-cert/CRL generation via the `openssl` CLI (`execFileSync`) — used by `mtls.integration.test.ts` (the M9.3 in-app federation mTLS attack matrix) and `crl-parse.test.ts`. Deliberately NOT a runtime dependency (CLAUDE.md principle 5 — air-gap/ self-hosting; no `node-forge` or similar added to `package.json`'s `dependencies`): every CI runner and dev machine already has `openssl` as a system tool, and this module is only ever imported from `*.test.ts` files.

Generates FRESH material per test run (never checked-in fixtures) specifically so a SAN URI can encode a domain id the test only learns at runtime (e.g. a freshly-paired peer's real `federation_self.domainId`), and so the CRL/expiry tests can construct exact past/future `nextUpdate` timestamps deterministically (`openssl ca -gencrl -crl_nextupdate <date>`) rather than racing the wall clock.

### §557. Creates a throwaway authority plus its database files

Creates a fresh temp dir with a throwaway self-signed CA plus the `openssl ca` database files (`index.txt`/`serial`/`crlnumber`/a minimal `ca.cnf`) needed to later revoke certs and mint a CRL from the SAME CA.

NOT counted by the original mkdtemp census (CLAUDE.md's own "incomplete call-site census" failure mode: the census only greped `*.test.ts` files for a direct `mkdtemp(` call, and every one of this function's 7 CALLERS is clean by that measure — the leak was IN THE HELPER, one level down). 501 leaked `scp-mtls-pki-*` directories were sitting on the author's machine when this was found — more than any single test-file leak in the census. `mkdtempTrackedForFileSync` (afterAll, not afterEach): callers use this in both a per-`it()` pattern (mtls.integration.test.ts, often several CAs in one test) and a `beforeAll`-shared pattern (federation-sync.integration.test.ts) — afterAll is the one lifetime that is correct under both without inspecting all 7 call sites.

### §558. Generates a CRL from `ca`'s database

Generates a CRL from `ca`'s database (i.e. reflecting every `revokeLeafCert` call so far). `nextUpdate`, if given, is an explicit ASN.1 time string (`YYYYMMDDHHMMSSZ`) — used by the expired-CRL tests to construct a deterministic PAST `nextUpdate` rather than racing the wall clock with a tiny `-crldays`.

## `apps/server/src/federation/unattached-change-status-repo.ts`

### §559. UNATTACHED PEER CHANGE STATUS

UNATTACHED PEER CHANGE STATUS (drizzle/0040) — the federation-layer store that `federation/import-repo.ts`'s `change_status` branch has named in its own comment as the missing feature ever since M6: *"Carrying it honestly needs a federation-layer store for unattached peer status."*

WHAT IT RECORDS. A `change_status` entry is POSITIVE EVIDENCE that a change exists and is moving on the peer — it names `payload.objectId` and a lifecycle state. Two import-side chokepoints drop it:

```text
(a) `no_local_replica` — the entry was admitted by this receiver's scope filter, but this
    domain holds no replica of `payload.objectId`. That is the NORMAL shape when the SENDER
    ships change status without the change's `object_upsert` (a `status_only` export), and a
    transient one at wider scopes when the status entry precedes the object it refers to.
(b) `receiver_scope` — this receiver's OWN `entryMatchesScope` discarded the entry.
```

WHY IT EXISTS: THE SENDER/RECEIVER SCOPE MISMATCH. `federation_peers.sync_scope` is purely local per-peer config. It is written by `pairPeer` and read only by export filtering, import defense-in-depth, and the board — it NEVER rides the wire, and the two sides' values are set independently by two operators and never reconciled. So a caveat derived from the RECEIVER's own scope is blind to the case where the SENDER is the narrow side: commander exports `status_only`, outpost receives at `changes_only`, and the outpost's scope predicate cheerfully says "I can see change objects" while none is ever shipped. The drop recorded HERE happens downstream of BOTH scopes, so it fires on that mismatch exactly as it fires on the receiver-scope case.

GRAIN: (peer, change object), NOT (component). Stated plainly because the limitation is load-bearing for how the board renders it. Neither `change_status` payload shape carries `targets` — propose sends `{objectId, urn, name, state, sourceKind, sourceRef, emergency, importedFromDomain, rollbackOfObjectId}`, transition sends `{objectId, fromState, toState, trigger, reason, importedFromDomain}` — and the change urn (`urn:scp:{org}:change:{slug(name)}`) encodes nothing about targets. The only entry that carries `properties.targets` across a boundary is the change's own `object_upsert`, which is precisely the entry that was withheld. So at import time this domain holds an object id and a state and nothing that resolves a component, and the board's caveat must stay BOARD-LEVEL. Widening the propose-time payload with `targets` would buy per-component attribution and is wire-safe (entry payloads are `z.record(z.string(), z.unknown())` passthrough and the rowHash canonicalizes deep-sorted, so an un-upgraded importer still verifies and simply ignores the extra key) — but it would disclose target component ids to a peer scoped precisely to withhold graph content. That is an owner decision; see drizzle/0040's header.

SELF-CLEARING. `clearUnattachedChangeStatus` runs from the `object_upsert` path, so once the change object actually lands the evidence resolves and the caveat stops firing. Combined with the upsert key that makes a from-genesis re-sync converge rather than accumulate, the mechanism can never fabricate persistent ignorance — the property that separates it from a counter.

### §560. Upsert one dropped `change_status` entry

Upsert one dropped `change_status` entry. Idempotent on (org, peer, change object): re-importing the same journal segment from genesis converges on one row rather than accumulating.

`urn`/`name` are COALESCEd, never overwritten with null — they ride only the propose payload, so a later transition entry for the same change must not erase the naming the propose gave us. `lastState` is COALESCEd for the same reason and NOT, as this said before, an overwrite: a malformed entry whose payload carries no parseable state (`import-repo.ts`'s `reportedChangeState` returns null whenever `toState`/`state` is not a string) must not blank a state we already read correctly. A real transition always carries one, so the ordinary `proposed -> accepted` reading still lands.

`dropReason` alone DOES overwrite: it is not nullable and it describes THIS entry's drop, so the latest reading is the only correct one.

### §561. Resolve the evidence for one change

Resolve the evidence for one change: the change's graph object finally landed locally, so this domain is no longer blind to it and the row must go. Called from the `object_upsert` import path.

This is the half that makes the signal honest in the OTHER direction — without it, a single out-of-order `change_status` (status entry ahead of its object, which happens at every scope wide enough to ship both) would leave a permanent row claiming an ignorance that resolved seconds later.

### §562. The board's read

The board's read: unattached evidence whose last reported state is one of `states` — i.e. changes this domain KNOWS are moving on a peer and cannot attribute to anything local.

Conditioned on state, not merely on existence, so a board does not claim ignorance forever because of one change that completed last quarter. Index-backed on `(org_id, last_state)`; `limit` bounds it because the caller only needs "is there any", plus enough rows to name the peers for an operator.

## `apps/server/src/federation/unattached-change-status.integration.test.ts`

### §563. The store semantics behind the board's blindness caveat

The STORE semantics behind the board's evidence-derived change-blindness caveat (drizzle/0040). `coordination/service-board-scope-mismatch.integration.test.ts` proves the end-to-end behaviour over two real databases; this pins the properties that make the mechanism HONEST rather than a ratchet, each of which is a way the caveat could otherwise become permanent or wrong:

1. IDEMPOTENT under replay. DESIGN §6: "a federation bundle import is literally a replay of public-API writes that converges no matter how many times it is applied." A from-genesis re-sync re-delivers the same `change_status` entries; the store must converge on one row per (peer, change), not accumulate one per import. 2. THE STATE IS THE CURRENT READING. A change that moves on to a settled state must stop matching the board's IN_FLIGHT filter — otherwise one long-completed change makes a board claim ignorance forever. 3. PROPOSE-TIME NAMING SURVIVES A TRANSITION. `urn`/`name` ride only the propose payload; a later transition entry carries neither, and must not erase them. 4. IT SELF-CLEARS. Once the change's own `object_upsert` lands, the ignorance is over and the row goes — the property that separates this from a counter that can only go up. 5. IT IS ORG-ISOLATED, like every other tenant table (DESIGN §4.2).

## `apps/server/src/federation/upstream-freshness.test.ts`

### §564. Unit coverage for the as-of reading, with no database

UNIT coverage (no database) for the "as of &lt;bundle/date&gt;" reading DESIGN.md §13 requires — the same shape `federation-sync-cadence.test.ts` gives `peerSyncCadence`/`isPeerDue`, and for the same reason: the truth table is where the dishonesty would hide, and it must be checkable without standing up two domains.

The properties that matter, each with a case below:

1. THE ANCHOR IS TRANSPORT-AGNOSTIC. A bundle that arrived by file/inbox reads as `via: "bundle"` and still carries a real timestamp — the air-gapped case, where the live-pull columns are NULL forever and a pull-derived label would say "never synced" on an instance syncing weekly. 2. THE TRANSPORT IS READ, NOT INFERRED. A live pull says `live-pull` even though the scheduler stamps `lastPullSuccessAt` BEFORE the import it triggers confirms. 3. THE THRESHOLD IS THE PEER'S OWN CADENCE, PLUS GRACE. A peer proven onto the sparse poke cadence is NOT late for being exactly as sparse as configured; and no peer is late for the ordinary overshoot every healthy cycle produces. 4. NO CADENCE ⇒ `stale: null`, NEVER `false`; NOTHING DELIVERED ⇒ `stale: true`, NEVER `false`. 5. THE LIMITING PEER IS THE OLDEST. `stale` is a per-peer verdict, never a cross-peer comparator. 6. ...AND THEREFORE STALENESS IS AN ANY-PEER PREDICATE, computed separately from the label — reading it off the label's own `stale` loses every overdue peer that is not also the oldest. 7. THE THRESHOLD IS ON THE WIRE (`staleAfterSeconds`), so no client re-derives the grace factor or mistakes the cadence for the bound.

### §565. The tick captures the instant once and passes it down

`federationSyncOrgTick` captures `now` ONCE at tick start and hands that same value to `markPeerPullSuccess`, so `lastPullSuccessAt` is always EARLIER than the `confirmed_at` the import it triggered wrote. The old attribution inferred the transport from `lastPullSuccessAt >= at` and therefore reported EVERY real live pull as a bundle import — exactly backwards. This pins the ordering that used to break it.

### §566. THE SECOND HALF OF THE SAME MISTAKE

THE SECOND HALF OF THE SAME MISTAKE. Fixing the label to be the oldest reading (above) then broke the caveat that used to be read off it: the service board derived its staleness unknown from `asOf.stale === true`, so a genuinely overdue peer that was NOT the oldest lost its caveat entirely — and the masking peer is, typically, an air-gapped one whose `stale` is `null` because no cadence applies to it. The label answers "how old is the oldest thing here"; the caveat answers "is anything late". Different questions, answered separately.

## `apps/server/src/federation/upstream-freshness.ts`

### §567. Upstream freshness: the as-of label the design requires

UPSTREAM FRESHNESS — the "as of &lt;bundle/date&gt;" label DESIGN.md §13 requires, computed for a read projection that renders another domain's data.

§13, verbatim: *"the commander UI labels air-gapped domains \"as of &lt;bundle/date&gt;\" and never presents stale data as live status"*, and *"for air-gapped outposts it is explicitly last-known-as-of the latest returned bundle"*. `GET /federation/status` already honors this (`lastSyncedAt`, rendered as `asOf` by the CLI and the federation-status route). The SERVICE BOARD did not: it renders rows whose change objects arrived over the journal and said nothing about when. The ban — "never presents stale data as live status" — is stated as a general prohibition, so it applies in the other direction too: an OUTPOST rendering a board over commander-driven changes has the identical property.

THE ANCHOR IS `bundle_transfers`, NOT `federation_peers.lastPullSuccessAt`. See `lastConfirmedSyncImportAt`: the pull columns are stamped only by the live-pull scheduler, which iterates `role === "commander" && baseUrl`, so on an air-gapped instance they are NULL forever and a label derived from them would read "never synced" on an instance that imports bundles weekly. Every import path — live pull, `POST /v1/federation/imports`, the unattended inbox loop — records a confirmed import transfer.

THE STALENESS THRESHOLD IS THE PEER'S OWN EFFECTIVE CADENCE, not a constant. `effectivePullIntervalSeconds` is the interval the scheduler would actually use for this peer right now: the frequent poll (`SCP_FEDERATION_SYNC_INTERVAL_SECONDS`, default 60s) or, for a peer genuinely on the proven sparse poke cadence, the sparse safety net (`SCP_FEDERATION_SYNC_SPARSE_INTERVAL_SECONDS`, default 900s). Using the peer's own number is what keeps a deliberately-sparse peer from being reported as late for being exactly as sparse as it was configured to be — and `FRESHNESS_GRACE_FACTOR` is what keeps it from shouting once per cycle for being normally late.

WHERE THERE IS NO CADENCE, `stale` IS `null` — NOT `false`. This instance only ever dials peers with `role === "commander"` and a `baseUrl` (§13 outpost-initiated-only). For an air-gapped peer, or for a commander looking DOWN at an outpost, no schedule exists that the data could be late against, and claiming `stale: false` would assert a freshness nobody measured — the same fabrication the board's `unknownFields` exists to prevent. `null` means "no cadence applies; read `at` and `via`", which is precisely §13's bounded air-gap contract: a label, never a live-status claim.

### §568. How much later than its cadence a peer may be

HOW MUCH LATER THAN ITS OWN CADENCE a peer may be before the label calls it stale.

The threshold cannot be the cadence verbatim. `ageSeconds` is measured from the moment the LAST import CONFIRMED, and the next one cannot land sooner than a full interval later: the due-gate (`claimPeerPull`) only admits a peer once `lastPullAttemptAt <= now - interval`, and on top of that sits the sweep's own tick granularity plus however long the dial + verify + apply takes. So a perfectly healthy peer's age passes `interval` on EVERY cycle, by construction — with the cadence used verbatim, a working 60s peer reads `stale` for part of every single minute. A label that shouts on healthy operation trains its reader to ignore it, which costs exactly the incident it exists to catch.

2 is chosen because it is the smallest factor with a MEANING rather than a feel: at `> 2 × interval`, at least one whole cadence window has come and gone producing nothing, so `stale: true` says "a cycle was missed" instead of "we are mid-cycle". A tighter factor (1.5) would still fire on a slow import; a looser one would hide a genuinely missed cycle.

### §569. Pure: one peer's freshness reading, kept database-free

PURE. One peer's freshness reading. Kept DB-free so the truth table is unit-testable, mirroring `federation-sync.ts`'s own `peerSyncCadence` / `isPeerDue`.

`ageSeconds` falls back to `pairedAt` when nothing has ever arrived: a peer paired an hour ago on a 60-second cadence with no confirmed import is genuinely overdue, and measuring from "never" as if it were age zero would hide exactly the misconfiguration this is for.

`via` IS READ FROM THE TRANSFER ROW (`transport`, drizzle/0041), not inferred. The inference it replaces — `lastPullSuccessAt >= at` — rested on the claim that the scheduler stamps the success column after the import transaction. It does not: `federationSyncOrgTick` captures `now` once at TICK START and hands that same value to `markPeerPullSuccess`, so a live pull's success stamp is always EARLIER than the `confirmed_at` its own import wrote. The predicate was false for every real live pull, and reported all of them as bundle imports — precisely backwards, and worse than saying nothing, because "as of 3 days ago via bundle" (a healthy air-gapped domain) and "as of 3 days ago via a wedged poller" (an incident) are different operator situations. A row written before 0041 reports `"unknown"`; it is never guessed.

`stale` IS NEVER `false` WHEN NOTHING HAS EVER ARRIVED. A peer inside its first cadence window with no confirmed import used to read `stale: false` — an assertion of freshness about data that does not exist. Freshness is a claim about DELIVERED data; with none delivered there is nothing fresh to report, so a scheduled peer reads `true` (and `via: "never"`, `at: null` say exactly why) until its first import lands.

### §570. The cadence inputs a read projection needs, resolved once

The cadence inputs a read projection needs, resolved once per request from live env + the runtime cert probe. `federationClientCertsUsable` is the scheduler's OWN never-throwing probe (it answers "did the material actually READ?", not "are the paths set?") — the same call `federation/status-repo.ts` already makes per request, for the same reason: a cadence report must not be the thing that hides a cadence divergence.

### §571. THE UPSTREAM BOUND for a read projection over `peers`

THE UPSTREAM BOUND for a read projection over `peers` — TWO answers, because one reading cannot carry both and conflating them is how each of the two bugs here got made.

- `label` — the LIMITING upstream, i.e. the OLDEST reading: the "as of" bound a projection may claim. `null` when `peers` is empty; a single-domain org's projection is a complete local observation and must not claim an ignorance it does not have. - `anyStale` — whether ANY peer is overdue by its OWN effective cadence. A caveat predicate, not a label. It is deliberately independent of which reading won the label.

WHY `label` IS AGE, FULL STOP. An earlier pass let `stale === true` win the label unconditionally, which meant a barely-late CONNECTED peer (61s past a 60s cadence) MASKED a genuinely ancient air-gapped one (three weeks, `stale: null` because no cadence applies to it) — the label then under-reported the board's own freshness bound by orders of magnitude, while its docstring promised the oldest. `stale` is a per-peer verdict against that peer's own schedule; it is not a comparator between peers, and using it as one inverts the ordering this exists to compute.

WHY `anyStale` HAD TO BE SPLIT OUT. Fixing the above then broke the caveat, in the exact incident the caveat exists to catch: with only the oldest reading returned, a genuinely overdue peer that is NOT the oldest lost its caveat entirely (commander, 60s cadence, an hour since its last import → `stale: true`, masked by an air-gapped peer 21 days old whose `stale` is `null` because no cadence applies to it). Staleness is an ANY-peer predicate; the oldest peer is merely the one that bounds the label. They are different questions and are now answered separately.

Callers pass only the peers whose scope can actually carry the data being rendered — a peer that structurally cannot send change objects does not bound the freshness of change objects; it is covered by the blindness caveat instead.
