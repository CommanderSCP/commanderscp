# ADR-0017: Ownership refinement — one outpost deployment per domain, build devolves to the originating outpost, the commander owns only the cross-boundary gate, and an outpost owns multiple regional Argo CDs per prod env

**Status:** Accepted (owner-decided 2026-07-20)
**Context doc:** [docs/proposals/promotion-and-execution-model.md](../proposals/promotion-and-execution-model.md)
**Relates to:** [ADR-0002](0002-execution-strategy.md) (three-mode execution strategy); [ADR-0004](0004-service-naming-commander-outpost-retrans.md) (commander/outpost/retrans roles); [ADR-0012](0012-registry-consolidation.md) (bundled-backend per-role allowlist — the build/event-backend rationale reconciled below); [ADR-0013](0013-supply-chain-scan-sbom-manifest.md) (scan as a boundary-authorization gate; the executor signs artifacts, the commander signs only the manifest); [ADR-0015](0015-cosign-cross-boundary-signing.md) (§5 — the coordinate-not-execute signing split); [ADR-0016](0016-scoped-scan-requirement-policies.md) (§"Known follow-up" — the per-domain-vs-per-org federation-identity question, left **open** and **deferred** here too); [ADR-0018](0018-domain-local-dev-pipelines.md) (the domain-local dev-pipeline exemption that keys on origin-domain-locality); charter principle 1 (coordinate, not execute), principle 2 (graph-native)

> **Evolution note (2026-07-23, [ADR-0020](0020-first-class-commander-scanning.md)):** §2's "the commander … does **not** run the scan" is superseded by exactly one step — the commander's cross-boundary gate role now **includes the promotion scan step** (the charter-enumerated `scp-managed-scan` runner scans at the commander before signing). Build stays devolved to the originating outpost; the commander still never runs build; the manifest-only signing pin and the E6 export gate below are unchanged.

## Context

Three ownership questions were settled with the owner on 2026-07-20. None is a new mechanism — each is a
**refinement** that tightens where an existing capability's ownership sits, and the first is a *favorable*
tightening of charter principle 1 (coordinate, not execute).

1. **Where a domain's builds run.** The master model
   ([promotion-and-execution-model.md](../proposals/promotion-and-execution-model.md) §2 and §3 step 2, as
   originally written) made **build artifacts** (image / rpm / npm) and the **shared config/infra repo**
   *commander-owned*, and ran build "on the coordinating domain's Argo Workflows (**commander for builds** +
   shared config/infra; the outpost for its own domain-specific config/infra)." That put a build lane in the
   commander's own domain.
2. **What "single outpost per domain" means.** Whether that phrase collapses federation identity to one
   per-domain identity, or is a statement about the deployment layer.
3. **How a prod environment spans regions.** Whether one outpost can own more than one Argo CD instance for a
   single prod environment — e.g. AMER **and** APAC.

Grounded facts that constrain the decision:

- The **commander cosign-signs only the promotion manifest**; the **executor** cosign-signs the artifact(s) and
  the build-time SBOM at build ([ADR-0015 §5](0015-cosign-cross-boundary-signing.md),
  [ADR-0013](0013-supply-chain-scan-sbom-manifest.md) 2026-07-20 correction). This is **already shipped**: the
  commander's manifest-signing keypair is a dedicated org-scoped RLS table (M17.3 **E4**, #101), its public key
  is distributed to peers via pairing (M17.3 **E5**, #102), and `exportPromotionBundle` cosign-signs a
  self-binding promotion manifest — signing **only its own manifest**, never an origin artifact (M17.3 **E6**,
  #103). Charter principle 1 forbids the commander building or signing origin artifacts. This ADR **pins** the
  commander's signing role to the manifest and does **not** reopen it.
- **`federation_self` is per-org**: `orgId` is the PRIMARY KEY and `domainId` is UNIQUE — a strict 1:1
  org ↔ federation-domain, because the sync journal is derived from the per-org outbox
  (`apps/server/src/db/schema.ts:940-972`). A deployment hosting **N** orgs therefore mints **N** domain
  identities. Whether that should collapse to one per-domain identity is **already recorded as OPEN** in
  [ADR-0016](0016-scoped-scan-requirement-policies.md) §"Known follow-up" — and it stays open here (§2).
- **Multiple imported/coordinated Argo CDs already work.** Each is a 1:1 executor binding resolved per target
  (`getExecutorBinding`, DESIGN §12); nothing structural blocks one outpost coordinating several. Only the
  *bundled* Argo CD model (one `scp-argocd` namespace per instance, M15.4) needs per-instance namespacing to
  run several bundled copies — out of scope here.

## Decision

### 1. One outpost **deployment** per domain (a deployment-layer statement — federation identity is untouched)

"Single outpost per domain" means **one outpost *deployment* per trust domain** — one per `commercial` /
`govcloud` / `airgap` partition — and each such deployment **hosts multiple orgs that are generally related to
each other** (e.g. a company's org family). This is a statement about the **deployment layer**: how many outpost
instances a domain runs, not how federation identity is minted.

- **Federation identity stays per-org, unchanged.** `federation_self` remains `orgId`-PK / `domainId`-UNIQUE
  (`schema.ts:940-972`). A deployment hosting N orgs continues to mint N domain identities and derive its sync
  journal from the per-org outbox. **Nothing in this ADR collapses federation identity to per-domain.**
- **The per-domain-identity collapse is considered here and explicitly DEFERRED.** Whether "multiple orgs in one
  federation domain" should become representable — one federation identity per deployment rather than per org —
  is a genuine federation-model question with its own blast radius (the journal, single-writer authority, the
  Ed25519 identity that signs journal segments). It is **already flagged OPEN** in
  [ADR-0016](0016-scoped-scan-requirement-policies.md) §"Known follow-up". It is **not resolved here** and needs
  its **own** future ADR/milestone. This ADR is careful to make no claim that federation identity is per-domain.

### 2. Build **devolves to the originating outpost**; the commander owns **only** the cross-boundary gate

The build lane moves out of the commander's domain. **Build (of any tracked artifact: image, rpm, npm, shared
config/infra, or domain-specific config/infra) runs in the *originating* outpost's Argo Workflows** — the
domain where the change originates — coordinated through the same three-mode executor interface (BYO-coordinate
by default; a domain's own bundled/imported build engine where it has one). **The commander never runs build.**

This narrows the commander's role in the supply-chain pipeline to **the cross-boundary gate only**, which is
exactly the already-shipped stages:

- **Scan-verdict consumption (M17.1).** The commander consumes the coordinated Trivy step's verdict as gate
  evidence; scoped pass-criteria per [ADR-0016](0016-scoped-scan-requirement-policies.md), M17.5. It does **not**
  run the scan (the executor's coordinated Trivy step does).
- **Manifest-only cosign-sign (M17.3 E4–E6).** The commander cosign-signs **only its own promotion manifest** —
  an authorization attestation over exactly the artifact set it is letting cross
  ([ADR-0015 §5](0015-cosign-cross-boundary-signing.md)): the signing keypair (**E4**, #101), pubkey
  distribution to peers (**E5**, #102), and the self-binding `sign-blob` of the manifest at
  `exportPromotionBundle` (**E6**, #103). **It never cosign-signs an origin artifact or the SBOM** — the
  executor did that at build; origin signatures ride untouched in `artifacts[].signatureRef`. This **pins** the
  commander to manifest-only signing; it does **not** re-open the 2026-07-20 who-signs-what correction.
- **The export gate (M17.3 E6).** The one cross-boundary egress is `exportPromotionBundle`
  (`apps/server/src/federation/promotion-repo.ts`), which **requires a federation peer**. Before signing, the
  export **re-checks** that every substantive artifact (the SBOM `blob` is the scan's output and is exempt) has a
  passing, **digest-bound** scan whose scanned digest equals the promoted digest (the M17.1 binding,
  re-verified at the boundary — defense in depth). A **missing** scan refuses exactly like a **failed** one,
  whether or not a scan-requirement policy was bound; refusal persists a block Decision + hash-chained audit
  event and surfaces `409` with `decision_id`. **The export never runs a scanner** — it re-verifies existing
  evidence at the crossing. This fail-closed export gate is the structural backstop
  [ADR-0018](0018-domain-local-dev-pipelines.md) relies on.

**Why this is a favorable tightening of principle 1.** The commander doing *less* — only consuming a verdict,
signing its own authorization record, and enforcing the export gate, never running a build — moves it strictly
further from execution. "Build in the originating outpost" is exactly "coordinate, not execute" applied to the
build lane: SCP still never runs CI itself (the outpost's Argo Workflows does — DESIGN §12), and the commander no
longer even hosts the coordinated build engine.

**Repo/byte hosting is a separate axis and is unchanged.** *Where the git/image bytes live* per trust tier
(commander-hosted repos in commercial; outpost-local Gitea in FedRAMP-High / IL5 / air-gap — [ADR-0010](0010-outpost-local-artifact-infra.md),
[ADR-0011](0011-universal-outpost-validation.md), [ADR-0012](0012-registry-consolidation.md), M15) is
orthogonal to *where build executes*. This ADR changes build **execution** ownership and the commander's
gate-only role; it does **not** change repo hosting.

**Reconciliation with the bundled-backend allowlist (ADR-0012 / M15.4).** The shipped per-role bundled-backend
matrix defaults the bundled Argo Workflows / Argo Events *build/event* backends to the **commander** role, with
the rationale "outposts don't build." Under this ADR an outpost **does** build its own originating artifacts —
today via its **own coordinated or BYO** Argo Workflows (Mode A), which needs **no** change to the bundled-backend
lint (the lint governs *bundled* backends only). Making a **bundled** Argo Workflows selectable on the outpost
role is a **noted follow-up** to the M15.4 matrix, not a prerequisite: build devolution works now through
coordinated/BYO build engines. This ADR is docs-only and changes no shipped lint value.

### 3. An outpost owns **multiple regional Argo CDs** for one prod environment (per-region deploy-target bindings)

One outpost can own **more than one Argo CD** for a **single** prod environment spanning regions — e.g. Prod
AMER **and** Prod APAC. This is expressed with the existing model, **no new object type**:

- A **region is a deploy-target**. A per-region Argo CD is an ordinary **per-region deploy-target binding** —
  each a 1:1 executor binding resolved per target (`getExecutorBinding`, DESIGN §12). This is graph-native
  (principle 2): a new regional Argo CD arrives as binding/relationship data, not a new top-level table.
- **Imported/coordinated multi-Argo CD already works today.** Nothing structural blocks one outpost coordinating
  several imported Argo CDs; each is its own 1:1 binding. What is missing is a **first-class config surface** —
  a documented **setting** by which an operator declares "this prod env has an Argo CD per region" and binds each
  region. That setting/surface + a test lands as a **small milestone** (BUILD_AND_TEST §8, M15.6). Only running
  several *bundled* Argo CDs would additionally need per-instance namespacing (M15.4) — out of scope here.

## Charter alignment

- **Coordinate, not execute (principle 1):** strengthened. The commander's role shrinks to verdict-consumption
  (M17.1) + manifest-only signing (M17.3 E4–E6) + the export gate (E6); build execution devolves to the
  originating outpost's own execution system. SCP still never runs CI itself.
- **Graph-native (principle 2):** OK — per-region Argo CD ownership is per-region deploy-target *bindings*, not a
  new top-level concept; the deployment-layer refinement adds no schema.
- **Explainability (principle 6):** unchanged — the scan verdict, the manifest signature, and the E6 export gate
  each persist their Decisions (E6 already persists a block Decision + hash-chained audit event on refusal).

## Alternatives considered

- **Collapse federation identity to per-domain now (rejected / deferred).** Tempting alongside "one outpost
  deployment per domain," but it is a distinct, higher-blast-radius federation-model change (journal derivation,
  single-writer authority, the signing identity). Left OPEN in
  [ADR-0016](0016-scoped-scan-requirement-policies.md) §"Known follow-up" and deferred to its own ADR. Choosing
  the deployment-layer reading keeps this ADR's scope honest.
- **Keep build in the commander's domain (rejected).** Hosting the coordinated build engine at the commander
  keeps it closer to execution and centralizes a lane that naturally belongs to the originating domain. Devolving
  build tightens principle 1.
- **A new "region" object type for multi-region Argo CD (rejected).** A region is already expressible as a
  deploy-target; per-region bindings need no new top-level table (principle 2). The gap is a config *setting*, not
  a data model.
- **Rewrite the M15.4 bundled-backend matrix to grant the outpost a bundled build engine (not chosen here).**
  Build devolution is satisfied by coordinated/BYO build engines today; changing the shipped lint is a separate,
  noted follow-up and would make docs contradict code if done docs-only.

## Consequences

**Positive**
- The commander's pipeline role is a clean gate: consume the scan verdict (M17.1), cosign-sign only its own
  manifest (M17.3 E4–E6), and hard-gate the export (E6) — a tighter coordinate-not-execute story.
- "One outpost deployment per domain, many related orgs" is stated at the deployment layer without perturbing
  the per-org federation identity or the sync journal.
- Multi-region prod Argo CD is a documented, first-class capability reusing per-region deploy-target bindings;
  imported/coordinated multi-Argo CD already works, so only a config surface + test remains.

**Costs / honesty**
- The per-domain-vs-per-org **federation-identity** question remains **open and deferred** (shared with
  [ADR-0016](0016-scoped-scan-requirement-policies.md)); this ADR resolves only the deployment-layer reading.
- The M15.4 **bundled-backend** matrix still carries the "outposts don't build" rationale; reconciling it so a
  **bundled** build engine may run on the outpost role is a noted follow-up (build devolution works today via
  coordinated/BYO engines, so it does not block).
- The multi-region Argo CD **setting** is not built yet — it lands as a small M15.6 config surface + test;
  the underlying per-region binding capability already exists.
- This ADR is **docs-only** and does **not** block M17.4 / M15.2 / M15.5: cross-hop verify-at-outpost is
  **actor-agnostic** (it verifies the commander-signed manifest + arrived-set equality regardless of *which*
  domain ran the build), so devolving build to the outpost changes nothing about the verify hops.
