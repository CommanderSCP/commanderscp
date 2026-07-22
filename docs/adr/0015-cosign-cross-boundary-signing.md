# ADR-0015: cosign end-to-end for all cross-boundary artifacts + the promotion manifest (a second, supply-chain signature layer)

**Status:** Accepted (owner-decided 2026-07-19) — **factually corrected 2026-07-20**: cosign is **not vendored today** (it is an operator-supplied prerequisite on `PATH`, unpinned in CI), the vendoring cost is real and applies to the declined Hybrid too (so it never differentiated the options — see Alternatives), the **SBOM is executor-signed, not commander-signed** (§5), and the verify hop **splits** into metadata-only manifest/set verification at bundle import vs. per-artifact verification where the bytes land (§6).
**Context doc:** [docs/proposals/promotion-and-execution-model.md](../proposals/promotion-and-execution-model.md)
**Relates to:** [ADR-0013](0013-supply-chain-scan-sbom-manifest.md) (scan + SBOM + signed manifest — this ADR supplies the signing mechanism); [ADR-0011](0011-universal-outpost-validation.md) (universal pre-deploy validation — the verify hop); [ADR-0012](0012-registry-consolidation.md) (Gitea OCI registry cosign signs against); [ADR-0016](0016-scoped-scan-requirement-policies.md) (the sibling scan-requirement gate); DESIGN.md §2 (Technology Stack — the *Signing / integrity* row) and §13 (Federation — the config channel that distributes the cosign pubkey)

## Context

ADR-0013 settled *that* cross-boundary artifacts and a promotion manifest are signed, and that every hop verifies signature + manifest match. It did **not** correctly settle *with what* — it asserted "cosign already exists (M4/M6/M8)". That is factually wrong and is corrected here and in ADR-0013:

- **cosign today is release-only, and it is *not vendored*.** The only cosign in the tree is `deploy/airgap/src/cosign.ts`, which signs the air-gap *release* bundle (per-image digests + `CHECKSUMS.txt` via `cosign sign-blob`). What is **proven** there is the **keyful/offline flag behaviour** — `--tlog-upload=false` + `--insecure-ignore-tlog=true`, **no Fulcio, no Rekor**. What is **not** true is that the binary ships with us: `deploy/airgap/src/cosign.ts` invokes `cosign` **from `PATH`**; `deploy/airgap/README.md:51` requires **cosign 2.x on PATH**; `BUILD_AND_TEST.md:35` lists it as a documented **prerequisite**; CI installs it via `sigstore/cosign-installer`, **deliberately unpinned**; and `deploy/helm-bundled/vendor/` contains only argo + gitea. So cosign is **already used on the release path (operator-supplied on PATH, unpinned by design)** — not vendored. There is **zero** cosign in `apps/server` or `packages`.
- **SCP's runtime signing is Ed25519, not cosign.** M4/M6/M8 built Ed25519 via `node:crypto`: governance attestations (`governance/attestation.ts` — `signAttestation`/`verifyAttestation`) and the federation journal (`federation-journal.ts` — `signJournalRowHash`, `signBundleChecksum`, `verifyBundleSignature`; import verify in `import-repo.ts` is Ed25519 sig + hash-chain, fail-closed).
- The `PromotionBundle` (`packages/schemas/src/federation.ts`) carries `artifactDigests: z.array(z.string())` — **flat strings**, no per-artifact type and no signature reference. The whole bundle is Ed25519-signed (`signBundleChecksum`), but individual artifacts carry no independently-verifiable supply-chain signature.

The owner needs cross-boundary artifacts to be verifiable by **standard, external supply-chain tooling** (`cosign verify` / `cosign verify-blob`, admission controllers such as policy-controller/Kyverno), not only by SCP's internal Ed25519 check. That is the driver for this decision.

## Decision

Adopt **cosign as a second, supply-chain signature layer**, end-to-end, over **all** cross-boundary artifact types **and** the SCP promotion manifest. Ed25519 is **not** migrated or replaced.

### 1. Two complementary signature layers (explicit split — no federation-signing migration)

| Layer | Purpose | Scope | Mechanism | Status |
|---|---|---|---|---|
| **Ed25519 (transport)** | Federation **transport** integrity + authorization | Bundle envelope + checksum, journal hash-chain, mTLS, approval/governance attestations | `node:crypto` Ed25519 (`federation-journal.ts`, `governance/attestation.ts`) | **Unchanged** (built M4/M6/M8) |
| **cosign (supply-chain)** | External, standard-tool **artifact provenance** | Every cross-boundary artifact (all types) **+** the SCP promotion manifest | cosign binary, keyful/offline (**must be vendored + pinned at M17.3** — it is not vendored today) | **New (this ADR, lands M17.3/M17.4)** |

Stating the split explicitly is deliberate: there is **no risky migration of federation signing**. The bundle envelope, journal, and attestations stay Ed25519 exactly as built; cosign is purely *additive* on the artifact-provenance axis.

### 2. Artifact-set model — typed artifacts replace flat digest strings

Evolve the promotion payload from `artifactDigests: string[]` to a typed set:

```
artifacts: [
  { type: 'oci'  | 'blob', digest: 'sha256:...', signatureRef },
  ...
]
```

- **`type: 'oci'`** (container images) → verified with `cosign verify` against the **registry-attached** signature (the cosign signature stored alongside the image in the OCI registry, ADR-0012 Gitea).
- **`type: 'blob'`** (rpm / deb / npm / config bundle / infra plan / **SBOM**) → verified with `cosign verify-blob` against a **detached** signature. The **SBOM is a blob artifact like any other**: it is a build-time output of the executor's Trivy pass, so its `signatureRef` carries the **origin (executor)** signature — SCP does not sign it (§5).
- **`signatureRef`** carries the **origin (executor) signature** — the one the build system produced at source. It is a reference (registry ref for OCI, detached-sig locator for blobs), not the artifact bytes; bundles stay metadata-only (ADR-0009).

The SCP **promotion manifest** enumerates exactly this authorized artifact set and gets **its own** cosign signature (SCP's authorization attestation over the digests — the analogue of Ed25519-signing a journal row). Origin-artifact signatures and the SCP-manifest signature are distinct: SCP never re-signs origin artifacts (see §5).

### 3. Implementation — a pinned, vendored cosign binary (net-new), keyful/offline, shared module

- A **cosign binary** is invoked **in-process** (subprocess), reusing the proven `deploy/airgap/src/cosign.ts` keyful/offline pattern: `--tlog-upload=false`, no Fulcio/Rekor, no network. cosign is **already used on the release path (operator-supplied on PATH, unpinned by design)**, so the **flag behaviour** is proven — but the binary itself is **not vendored today**. M17.3 must **vendor a pinned, verified cosign binary** into the SCP runtime image *and* the air-gap bundle (see Consequences).
- **`sigstore-js` was considered and not chosen** — it pulls a heavier dependency tree and would be a second, divergent cosign implementation from the release path; a single vendored binary keeps one proven offline behavior.
- Factor a **shared signing/verify module** that both the **source sign** path (M17.3) and **every verify hop** (M17.4) call, so sign and verify cannot drift. The module also owns key loading/distribution (§4). This module is the generalization of the release wrapper, lifted so the server can call it.

### 4. Key management + public-key distribution

- SCP's **cosign keypair** lives in the secrets vault (`secrets/crypto.ts`) or `instance_keys`, alongside (not replacing) the Ed25519 keys.
- The cosign **public key** is distributed to retrans/outposts over the **existing federation-config channel** (self-repo / status-repo). This is **net-new**: there is no cosign-pubkey field today — add one to the federation config schema.
- Verifiers use the distributed pubkey **offline** — no network key fetch, no keyless/OIDC identity resolution. This is what makes cross-hop verification air-gap-workable.

### 5. Coordinate-not-execute boundary (charter principle 1)

- The **executor** (e.g. an Argo Workflows cosign step) signs **the artifact(s) *and* the build-time SBOM** **at build**, in the build system, with the build system's credentials. The SBOM is an output of the executor's Trivy pass, so it is an origin artifact like any other. SCP does not run that step.
- **SCP verifies** origin signatures — a **gate control**, sibling of the M17.1 scan control ([ADR-0013](0013-supply-chain-scan-sbom-manifest.md); scoped pass-criteria per [ADR-0016](0016-scoped-scan-requirement-policies.md)) — and **signs its own promotion manifest** (an authorization attestation over the digests, exactly as it Ed25519-signs journals).
- **SCP never `cosign sign`s an origin artifact — including the SBOM.** It verifies what the executor produced and vouches (over its own manifest) for the set it authorizes to cross. Signing its own authorization record is coordination, not execution — identical in kind to the existing Ed25519 journal signing.

### 6. Verify at every hop (ADR-0011 / ADR-0013)

The verify hop **splits in two**, because federation bundles are **metadata-only** (ADR-0009, reaffirmed in §2): the artifact **bytes** and the OCI registry are simply not present at bundle import, so a per-artifact `cosign verify` cannot happen there.

- **(a) Manifest-signature + arrived-set-equality verification — at bundle import (`import-repo.ts`).** A fail-closed step **after** the existing Ed25519 gate that (i) `cosign verify-blob`s **the SCP promotion manifest** against the distributed pubkey and (ii) asserts the arrived artifact-**set** (the typed `artifacts[]` entries: digests + `signatureRef`s) **exactly equals** the manifest's authorized set — nothing added or substituted. This is entirely **metadata-only** and genuinely doable in `import-repo.ts`.
- **(b) Per-artifact `cosign verify` / `verify-blob` — at the point the bytes land** in the outpost's local Gitea/registry, against each artifact's **origin** `signatureRef` and the distributed pubkey. This hop **depended on the then-unresolved artifact-BYTES transport channel** — `docs/proposals/outpost-local-artifact-infra.md` called this "the honest open gap." *(Since resolved: [ADR-0019](0019-artifact-byte-channel.md) designs the per-tier byte channel; M17.4(b) shipped as the pre-deploy byte verify, #108.)*

Retrans was naming-only/unbuilt when this was written; M17.4 lands the **outpost-side** verify (ties to M15.2) and, where retrans exists, the CDS-boundary verify. Retrans-as-a-real-component is its own work — now scheduled as the M15.5(c) validate-then-relay ([ADR-0019](0019-artifact-byte-channel.md)), whose VALIDATE step reuses this ADR's verify machinery.

## Charter alignment

- **Coordinate-not-execute (principle 1):** OK — the executor builds and signs at origin; SCP verifies origin sigs and signs only its own manifest (§5).
- **PostgreSQL-only required dependency (principle 4):** OK — cosign is a **vendored binary/library, not a service**. Any Fulcio / Rekor / external-KMS variant is **rejected** (it would add a required network service and break air-gap). Keys live in the existing vault/`instance_keys`.
- **Air-gap first (principle 5):** OK **at a real, previously-unacknowledged cost.** The *behaviour* is air-gap-clean — keyful `--tlog-upload=false` (precedent: `deploy/airgap`), pubkey via federation config, verification fully offline, no transparency-log or network fetch. But moving cosign onto a **runtime** sign+verify path means M17.3 must **vendor a pinned, verified cosign binary into the SCP runtime image and the air-gap bundle, on every outpost that verifies** — cosign is a documented operator prerequisite on PATH today, and CI installs it deliberately unpinned. Pinning must also be reconciled with `deploy/airgap/src/cosign.ts`'s intentionally **version-adaptive flag probing**. See Consequences.
- **Graph-native / explainability (principles 2, 6):** verify verdicts are gate Controls and persist Decisions like every other gate.

## Alternatives considered

- **Hybrid: Ed25519 manifest + cosign-verify images only (declined).** Keep signing the promotion manifest with the existing Ed25519 machinery and only *verify* cosign signatures on OCI images. **Rationale for choosing end-to-end cosign instead:** uniform, external verifiability by standard tooling and admission controllers across **all** artifact types **and** the manifest — a downstream consumer (or an outpost's admission controller) can `cosign verify` everything with one toolchain and one pubkey, without also implementing SCP's Ed25519 manifest check. **Cost accepted:** the worker **sign** path gains a dependency on a **vendored, pinned** cosign binary that does not exist today (cosign is an operator prerequisite on PATH, unpinned).
  **Honest correction (2026-07-20):** an earlier version of this ADR claimed the binary was already vendored and that this small cost "is what tipped the decision away from the Hybrid." Both halves were wrong. The binary is not vendored; and the vendoring cost **applies to the declined Hybrid too** — the Hybrid still `cosign verify`s OCI images at every hop, and **verification needs the binary either way**. So vendoring never differentiated the options. **The real differentiator is standard-tooling interop:** end-to-end cosign lets any downstream consumer or admission controller verify *every* artifact type **and** the manifest with one toolchain and one pubkey; the Hybrid would force them to also implement SCP's Ed25519 manifest check.
- **`sigstore-js` instead of the vendored binary (declined).** Heavier dependency tree and a second cosign implementation diverging from the release path; see §3.
- **Migrate federation transport signing to cosign (declined).** Unnecessary and risky — the Ed25519 journal/hash-chain/mTLS layer works and is orthogonal to artifact provenance. The two-layer split (§1) keeps transport untouched.
- **Keyless (Fulcio/Rekor) cosign (rejected).** Requires network transparency-log/identity services — incompatible with air-gap and the PostgreSQL-only principle.

## Consequences

**Positive**
- One standard toolchain (`cosign verify` / `verify-blob`) verifies every cross-boundary artifact and the manifest, internally and by external admission controllers, fully offline.
- No federation-signing migration: Ed25519 transport is untouched; cosign is additive on a separate axis.
- Typed artifact-set replaces opaque digest strings, enabling per-artifact, per-type verification.

**Costs / honesty**
- **cosign must be vendored — this is net-new work, not a free reuse.** Today cosign is an operator-supplied prerequisite on `PATH` (`deploy/airgap/README.md:51`, `BUILD_AND_TEST.md:35`), installed in CI **unpinned** by design (`sigstore/cosign-installer`), and absent from `deploy/helm-bundled/vendor/`. A **runtime** sign+verify path means M17.3 must vendor a **pinned, checksum-verified** cosign binary into (i) the SCP runtime image and (ii) the air-gap bundle, **on every outpost that verifies** — and must reconcile that pinning with `deploy/airgap/src/cosign.ts`'s deliberately **version-adaptive flag probing** (a pinned binary makes probing dead weight; keeping probing weakens the pin's guarantee). Pick one and state it at M17.3.
- **This cost was never a differentiator.** It applies equally to the declined Hybrid, which also verifies with cosign. Recorded so the decision rationale is not re-derived from a false premise (see Alternatives).
- `PromotionBundle` schema changes (`artifactDigests: string[]` → typed `artifacts[]`) and the federation config gains a cosign-pubkey field — additive schema work, codegen re-run.
- Cross-hop verify is only fully realized at the outpost first (M15.2 ties); retrans-boundary verify waits on retrans being built.
- **The verify hop is split and only half of it is unblocked** (§6). Manifest-signature + arrived-set-equality verification is metadata-only and lands in `import-repo.ts`; **per-artifact** `cosign verify` must happen where the bytes land, and that depended on the **then-unresolved artifact-bytes transport channel** (`docs/proposals/outpost-local-artifact-infra.md` — "the honest open gap"). *(Since resolved: the byte channel is designed per tier in [ADR-0019](0019-artifact-byte-channel.md), and M17.4(b) shipped the per-artifact pre-deploy byte verify, #108.)*
