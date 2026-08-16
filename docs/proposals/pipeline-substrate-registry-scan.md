# Proposal: what a pipeline tile must know — target substrate, the per-domain image registry, and the scan stage

**Status:** v0.2 — **owner decisions taken 2026-08-16 (§7); building all three.** Written 2026-08-14 from the owner's live review of the `checkout-api` mockup on a paired commander (:8080) + outpost (:8082); §7.1 added 2026-08-16 to reconcile the Scan-node decision with ADR-0013/0016.
**Role:** Three of the owner's five review points were not fixture omissions but **model gaps** — the pipeline view could not show them because the graph does not hold them. This proposal says what is missing, where each thing already has a design home, and what the smallest honest build is. The other two points (tab highlight, source-row visibility) were view fixes and shipped (`component-detail.tsx`).
**Relates to:** [ADR-0010](../adr/0010-outpost-local-artifact-infra.md) (a registry is an `execution-system` graph object; import Harbor/Artifactory via discovery), [ADR-0012](../adr/0012-registry-consolidation.md), [ADR-0013](../adr/0013-supply-chain-scan-sbom-manifest.md) (scan-at-source at the commander; trust, don't re-scan, downstream), [ADR-0016](../adr/0016-scoped-scan-requirement-policies.md) (`scan-result-control`, scan-requirement policies), [ADR-0026](../adr/0026-placements-and-derived-stage-names.md) (placement = component × target), [outpost-ui.md §9.3a](outpost-ui.md) (mixed-provenance inputs), GLOSSARY *deployment target* / *scan gate*, charter principles 1, 2, 6.

## 1. What the owner asked, and what the model can answer today

| Owner point (2026-08-14) | Measured state | Class |
|---|---|---|
| "Infra doesn't really show much. Is it an AWS account or hardware? If AWS, what's the account ID?" | `deployment-target` has **no registered property schema**. `field-cluster (k8s)` knows only its name; provider / account / region are free-form `properties` nothing reads. The tile cannot show what is not modelled. | **Model gap** (§2) |
| "I don't see an image repo in either commander or outpost… There should be one in each domain" | The Delivery lane draws a **Registry** node, but it is a named-empty tile ("not observed yet") because **no graph object models a registry as a place**. ADR-0010 already decided a registry is an `execution-system` — but nothing links a component's build to *which* registry, per domain, and the pipeline projection never looks one up. | **Model gap** (§3) |
| "Not seeing the scan stages in any of the pipelines (commander only)" | A scan today is a **control run at a wave gate** (`scan-result-control`, ADR-0016) — it renders as a *check inside a target tile*, never as a stage of its own. Our fixture binds no scan control, so every tile says `checks: 0`. The GLOSSARY says the scan gate applies **per crossing, not per wave**. | **Model + design gap** (§4) |

The rule that unites all three: **a pipeline tile may only show what the graph states.** Faking a registry name, an account id, or a scan stage in the fixture would give the owner a mockup that lies — precisely what this UI's honesty rules exist to prevent. So each is a small, additive graph-native change first, and a rendering second.

## 2. Target substrate — what a `deployment-target` IS

**Ask.** A target tile should say what kind of place it is and where: cloud account vs. hardware, and for a cloud target the account (and region) — the first things an operator reasons about when a deploy fails.

**Design.** Register a **property schema** on the `deployment-target` object type (the same registry mechanism every typed object uses; a migration row, no new table — charter 2). Proposed shape, all optional, all *declared*:

```
substrate:  "aws" | "gcp" | "azure" | "kubernetes" | "vm" | "bare-metal" | "other"
account:    string      — the cloud account/subscription/project id (AWS 12-digit, etc.)
region:     string      — provider region, when the substrate has one
cluster:    string      — cluster name/ARN when substrate is kubernetes-on-cloud
```

`substrate` answers "AWS or hardware"; `account` answers "which account". Rendered on the target tile as a quiet second line — `aws · 123456789012 · us-east-1` — read from properties, never inferred from the target's name (`us-east-1-prod (k8s)` is a *name*, and inferring a region from it is exactly the read-never-infer violation this repo keeps paying for).

**Why not a new object type per substrate.** Ownership, placement, bindings and the containment walk all key on `deployment-target`; splitting it fragments every consumer. A property facet on the one type is the graph-native answer (charter 2, 7).

**Fixture.** `us-east-1-prod` → `{substrate: aws, account: 210987654321, region: us-east-1, cluster: prod-eks}`; `field-cluster` → `{substrate: kubernetes, cluster: field-eks}` (an on-prem k8s, no account) — so both answers to "AWS or hardware?" are visible.

## 3. The image registry — one per domain, on the pipeline

**Ask.** `checkout-api` is image-based, so each domain's Delivery pipeline should show *the registry its image lands in* — the commander's registry at the commander, the outpost's registry at the outpost (M15's outpost-local Harbor is exactly this).

**What exists.** ADR-0010: a registry is an `execution-system` graph object (Harbor/Artifactory/ECR), importable via discovery, per instance. Executor bindings already reference an `execution-system`. What is missing is the **link from a component's build to the registry it publishes to**, and the projection reading it.

**Design (smallest honest).**
- A component's `image`-Type binding names the registry via its `executionSystemId` — that is what an image build *pushes to*. The pipeline projection resolves that system and puts its `name` + console URL on the Registry node: **"Registry — harbor-hq (registry.hq.internal)"** with the image repo path from the binding's `externalRef` (`acme/checkout-api`).
- **Per domain by construction:** bindings never federate (ADR-0031 §Context), so the outpost's `image` binding names the *outpost's* Harbor, the commander's names the commander's. Two sites, two registries, no new mechanism — the same invariant that gave us domain-specific inputs for free.
- The digest and scan verdict on that node stay "not observed yet" until Layer B observe-enrichment captures them — that copy is already honest and stays.

**Fixture.** Two `execution-system` objects of kind registry: `harbor-hq` at the commander, `harbor-field` at the outpost; an `image` binding on `checkout-api` at each, `externalRef: acme/checkout-api`. Then the Registry tile reads differently on the two sites, which is the owner's check.

## 4. The scan stage — commander only, per crossing

**Ask.** Scan stages should be visible in the pipeline, at the commander only.

**What exists, precisely.** ADR-0013: scanning exists *to authorize cross-boundary transfer* — scan-at-source at the commander; downstream hops **verify the signed manifest and do not re-scan**. ADR-0016: the mechanism is `scan-result-control`, a control run whose verdict a wave gate reads. GLOSSARY: the scan gate is evaluated **per boundary crossing, not per wave**. So today a scan is a *check on a target's entry gate*, and it renders inside the target tile.

**The design question — a stage, or a check?** The owner's phrasing ("scan stages") and the model disagree, and it matters:

- **(a) Scan as a distinct pipeline node** between Registry and the first cross-boundary wave: *"Scan (E6) — Trivy · OpenSCAP · digest-bound"*, drawn on the commander only (`maintainedBy.isSelf && role === commander`). Visually clean; but it draws ONE scan for a pipeline whose stages may cross different boundaries (a wave with a commercial target and a govcloud target has one crossing that needs the gate and one that does not — GLOSSARY's own example), so a single node is a lie in exactly the mixed case.
- **(b) Scan as a per-crossing check on the promotion arrow / target tile** — what the model does now, made *visible*: when a stage's crossing requires the scan gate, its entry gate lists **"scan (E6): pass · digest sha256:… · trivy/openscap"** as a check, and the promotion arrow into it carries the verdict colour. Honest per crossing; the commander's own site sees it on the crossings it authorizes; an outpost sees "verified at source (signed manifest)" rather than a scan of its own — which is what ADR-0013 says an outpost does.

**Recommendation: (b), with one addition** — a compact **"Scanned at source"** marker on the Registry node at the commander (the scan happens against the artifact *there*), so the operator sees *where* scanning occurs even before any crossing is attempted. That gives the owner "scan visible on the pipeline, commander only" without inventing a stage the model does not have. If the owner wants (a) anyway, it should be drawn only when *every* stage's crossing shares one verdict, and say so.

**Fixture.** Bind a `scan-result-control` at the commander's prod wave gate for `checkout-api` (ADR-0016's mechanism, already built) so the target tiles' checks show a scan row; a control run with a `pass` verdict so it is not `not_started`.

## 5. What is deliberately NOT in this proposal

- **Inferring any of it.** No region from a name, no substrate from a cluster suffix, no registry from a binding's plugin module, no scan from a Type. Each is a declared fact or a resolved object.
- **A per-outpost re-scan.** ADR-0013 forbids it by design; the outpost's pipeline says "verified at source".
- **New top-level tables.** Everything here is a property schema on an existing type, a resolved existing object, or an existing control — charter 2.

## 6. Build increments (each shippable alone)

1. **§2** — `deployment-target` property schema (migration: one registry row) + target-tile substrate line + fixture. Smallest; unblocks "AWS or hardware?".
2. **§3** — pipeline projection resolves the `image` binding's execution-system onto the Registry node + fixture (two registries). Makes "one per domain" visible.
3. **§4(b)** — scan check rendering + "scanned at source" marker + fixture control run. Commander-only by construction.
4. **§4(a)** — only if the owner rules for a stage node after seeing (b).

## 7. Owner decisions (2026-08-16)

| # | Question | Decision | Note |
|---|---|---|---|
| 1 | §2 shape | **`substrate / account / region / cluster`** as one declared facet on `deployment-target` (recommended option) | Rejected: provider-native identifier only (no policy could key on account); one object type per substrate (fragments every consumer of `deployment-target`). |
| 2 | §3 registry | **Resolve from the image executor binding's `executionSystemId`** (recommended option) | Rejected: a separate `publishes_to` relationship (second thing to keep in sync); deferring to M13. |
| 3 | §4 scan | **A distinct Scan stage node, commander only** — the owner overruled the per-crossing-check recommendation | See §7.1 for how the node stays honest in the mixed-crossing case. |
| 4 | Sequencing | **All three now**, in this round | §4 lands ahead of the full M13 mechanism; the node renders what the code holds today and says "not run" where it holds nothing. |

### 7.1 How a single Scan node stays honest

The recommendation against a node was that "one scan for a pipeline whose stages cross different boundaries" is a lie in the mixed case. On reflection the objection conflates two things ADR-0013/0016 keep separate, and separating them is what makes the owner's choice honest:

- **The scan** is one event per **artifact** — Trivy + OpenSCAP against a digest, at source (ADR-0013). There is exactly one of it per built artifact, however many boundaries that artifact later crosses. A single node describing *the scan* is therefore truthful: *what was scanned (digest), with what (tools, DB version), when, verdict, finding counts.*
- **The requirement** — *does this crossing require a passing scan, against which pass criteria* — is per crossing (ADR-0016 scoped policies, GLOSSARY per-crossing). That is a **gate check on each target tile** and stays there. The Scan node never claims a crossing is authorised; the target's entry gate does.

So the node reads **"Scan — at source · authorises cross-boundary transfer"**, and its body is the artifact-level fact set. States, all read from stored data:
- **no artifact yet** — nothing built/observed, so nothing to scan (the Registry node's "not observed yet" twin);
- **not run** — an artifact digest exists but no scan result is recorded for it;
- **pass / fail** with the recorded facts (tool, digest, counts, decision id where one exists).

**Commander only** is a read of the install-time role (`instanceRole` on `/auth/me`, the same read that shapes the site) — the node is not drawn on an outpost site at all. An outpost's Delivery lane keeps the Registry node; whether it also states "verified at source (signed manifest)" is left to §3's outpost rendering and is *not* a scan claim.

**Placement:** after Registry, before Config — the scan is of the artifact that landed in the registry; configuration is a different input class and enters after.

### 7.2 Owner refinements (2026-08-16, same session)

1. **It is "Scan & sign", not "Scan".** ADR-0013 and ADR-0015 pair them: the commander scans the artifact *and* signs it (cosign, ADR-0015) so downstream hops can verify without re-scanning. The node is one tile, **Scan & sign**, with two facts — scan verdict and signature — each read from stored data and each independently "not yet" when the code holds nothing (a scanned-but-unsigned artifact must read that way, never as "done").
2. **The Build tile also carries the SBOM and the Promotion Manifest (PM).** The build produces the artifact; the SBOM describes it; the PM is the signed set of artifacts a promotion carries (ADR-0013 §Decision). Both surface on the Build tile — present / not yet, read from stored data. *Reconciliation to record after grounding:* in the code the PM may be a **promotion-time** object (created at export), not a build-time one; if so the Build tile shows "PM: not yet — created at first cross-boundary promotion" until one exists, rather than pretending a manifest exists at build.
3. **Both tiles are clickable once complete** and open a review: Scan & sign → findings (tool, DB version, counts by severity, digest) + signature (who signed, key/identity, verified-at); Build → the SBOM and the PM. If an existing page already shows any of these (promotion detail, decision detail), link there; otherwise a focused review view is added. **Not clickable until the fact exists** — a tile with nothing to review has no affordance, so a click never lands on an empty page.

These extend §7 rows 3–4; sequencing stays "all now" and the honesty rule of §5 is unchanged: **every field on these tiles is a stored fact or is stated as absent.**

## 8. What the code holds (grounded 2026-08-16) — corrections to §1–§4

Six readers (three grounders + three refuters, plus one on sign/SBOM/PM) measured the tree. Where they overturn a premise above, this section governs.

| Topic | §1–§4 assumed | The code holds (cite) |
|---|---|---|
| Target facet | "no registered property schema" | `deployment-target` has a **registered, open** schema `{"type":"object"}` (0002:159). `properties.environment` + `properties.region` are already load-bearing (derived stage name ADR-0026 D1; M15.6 regional gate — a target with BOTH non-empty is a "declared region target" and reconcile REFUSES its deploys without a region binding, reconcile.ts:1596-1620). Ajv validates on WRITE only, at the receiving side of federation too, with no try/catch — one rejected entry aborts a whole sync bundle (0043 header). |
| Registry link | "the image binding names the registry" | The `image` binding is the **build executor** reconcile triggers (ADR-0007: Type = which pipeline is DRIVEN); a registry-kind execution-system **cannot be bound** (KNOWN_EXECUTOR_MODULES 400 at all three write doors, executor-bindings-repo.ts:86-89/417-427); execution-system **objects federate** (object_upsert, no typeId exclusion) — only **bindings** never do. An edge with a **domain-local endpoint never journals** (relationships-repo.ts:353-370). Gitea is ADR-0012's default unified registry, and the gitea module already observes packages and emits `artifactDigest` (packages/plugins/gitea/src/index.ts:346-390). |
| Signing | "the commander signs the artifact" | SCP signs **only its own promotion manifest** (cosign `signBlob`, promotion-repo.ts:429-435, `@scp/cosign` real); executors sign artifacts (ADR-0015 §5: "SCP never cosign-signs an origin artifact"). The exporter does **not persist** the manifest or signature — only `bundle_transfers.checksum` and `sourceRef.boundaryBundleChecksums[]` (per export; surfaced as `boundarySegment`). The **importer** stores `sourceRef.promotionManifest` + `manifestSignature` (promotion-repo.ts:865-870). Origin OCI artifacts get **no** `signatureRef` at export (only the SBOM blob does). |
| SBOM | "generated at build/scan" | SCP **never generates** an SBOM and stores **no bytes**: `SbomRefSchema` (format, specVersion, digest, location, mediaType, signatureRef, scanner, scannerVersion, generatedAt) at `changes.source_ref.sbom`; sole ingress is the first-party report `POST /change-sources/{kind}/report` (`ChangeReportRequest.sbom`, `.artifactDigest`); no provider webhook sets one; a malformed ref is silently dropped. No route/page renders it. |
| PM | "created at build" | Strictly **export-time**: `buildPromotionManifest` inside `exportPromotionBundle` (sole writer, promotion-repo.ts:163-185/403-411), needs a named `peerDomainId`; shape `{manifestVersion:"scp-promotion-manifest/v1", createdAt, sourceChangeObjectId, exporterDomainId, peerDomainId, changeUrn, artifacts:[{type:oci|blob, digest, signatureRef?}]}`. Never persisted at the exporter today (see §9.4). |
| Scan | "one scan per artifact at build" | Two writers of `control_runs` rows carrying `ScanEvidence`: the org-pipeline `scan-result-control` (M17.1) and the commander's **managed scan step at export** (promotion-scan-step.ts, synthetic control id `00000000-5ca4-…0001`, `gateRef {promotionScanStep, method, artifactDigest}`). Evidence is **per change**, keyed by `change_object_id`; **only severity counts** are stored (`{critical,high,medium,low}`), no CVE list; several rows per digest (one per method: trivy / trivy-vm / openscap). E6 (`evaluatePromotionScanGate`) passes if **any** digest-bound `pass` row exists for every non-blob artifact; on refusal it writes a `promotion-export-scan-gate` block Decision, on pass no Decision. Wire `ControlRun` has no gateKind/gateRef, so managed vs org-pipeline is indistinguishable on the wire. |
| Artifact identity | "no digest captured" | **Captured but never projected**: `changes.source_ref.artifact_digest` (string or string[]; also `artifactDigest`), lifted by `canonicalizeSourceRef` from report/webhook hints. The projection reads none of it — the Registry node's "not observed yet" is true of the VIEW, not the graph. No `artifact` object type, no digest column. |
| Review surfaces | — | Change detail already renders every control run's evidence JSON (change-detail.tsx:450-493, `GET /changes/:id/control-runs`, SDK `client.controlRuns`). **No** page renders an SBOM, a manifest, a signature or a verify record; **no** promotions list/detail exists. |
| Commander-only signal | — | `useAuth().user.instanceRole` (install-time `SCP_FEDERATION_ROLE`, default `commander`); readers today: router.tsx HomePage, AppShell.tsx. Distinct from `component.maintainedBy.role` (per-object origin). |
| Fixture | — | The review fixture creates targets `PUT /deployment-targets/{urn}` `{name}` only — **PUT with `properties` omitted RESETS the bag to `{}`** on an existing row (objects-repo.ts:963/991); no execution-system objects; no controls; **no in-repo outpost fixture** (the :8082 data was hand-applied + federation import). |

## 9. Build spec (v0.3, owner decisions 2026-08-16 — the two corrected asks both took the recommendation)

### 9.1 Target substrate facet
- **Migration** `UPDATE object_types SET property_schema` for `deployment-target` (0029 pattern, additive): typed **string** properties `substrate`, `account`, `region`, `cluster` — all optional, **no enum, no `additionalProperties:false`, no `required`** (journaled type; 0043/0051 precedent — a closed enum on an older receiver aborts a peer's whole sync bundle). Well-known `substrate` values (`aws|gcp|azure|kubernetes|vm|bare-metal|other`) are documented in GLOSSARY, rendered as-is, never enforced on the wire. `environment` stays undeclared (out of scope; it is a gate input).
- **Wire**: `stages[].deploymentTarget` AND `unplacedStages[].deploymentTarget` gain `substrate`, `account`, `cluster` as `z.string().nullable()` (matching `environment`/`region`; #222 measured that required additive response properties pass oasdiff). One server literal feeds both arrays (component-pipeline.ts:606-611); read with `typeof === "string"` guards. `pnpm gen`.
- **Web**: StageCard and UnplacedStageCard get a quiet `text-slate-400` line **beside** the existing hint (the test pins `deploys to`), joining only the present facet values with ` · ` (e.g. `aws · 210987654321 · us-east-1 · prod-eks`); nothing declared → no line (absence of a declaration is not an unknown observation). Never read `name`.
- **Fixture**: the six `PUT` bodies carry `properties` (PUT replaces the bag). Set `substrate/account/region/cluster`; **do not set `environment`** (would arm the M15.6 regional gate on targets with no region binding). Outpost `field-cluster` → `{substrate:"kubernetes", cluster:"field-eks"}` (on-prem, no account) via the new outpost fixture (§9.5).

### 9.2 Per-domain registry via `publishes_to`
- **Migration**: built-in relationship type `publishes_to` — from `component` to `execution-system`, cardinality `many_to_many` (the vocabulary every built-in uses, 0002:174-192; many components publish to one registry, and the "one per site" rule is a projection statement — `ambiguous` — not a DB constraint), `is_builtin=true`, `property_schema {"type":"object","properties":{"repository":{"type":"string"}}}` (open). One migration file may carry both 9.1 and 9.2 statements.
- **Objects**: a registry is an `execution-system` created **at each site as `domainLocal:true`** (kind free: `gitea` is the designed default; `harbor`/`ecr` allowed since no binding is involved), with `serverUrl` (+ optional `webUrl`). Its `publishes_to` edge from the component (edge property `repository`) never journals because one endpoint is domain-local — **one registry per domain by construction, and each site's Delivery lane shows only its own.**
- **Projection**: new optional top-level field `registry` on `ComponentPipelineResponse`: `{ state: "declared" | "ambiguous" | "none", executionSystemId, name, kind, url, repository, edgeCount }` resolved from the component's `publishes_to` edges at this site (batched — no per-stage lookup). `ambiguous` (>1 edge) is stated, not chosen. Also new optional `artifact` (see 9.3).
- **Web Registry node**: header names the registry (`hq-registry (gitea) · acme/checkout-api`, console link to `webUrl→serverUrl` base only — no guessed deep path); renders whenever `registry.state !== "none"` **or** `buildsHere` (an outpost builds nothing but its registry receives the promoted image). Body: the latest artifact digest when 9.3 has one, else "no artifact digest recorded yet". `state:"none"` → "no registry declared for this component here".

### 9.3 The artifact, the Build tile (SBOM + PM), and Scan & sign — what the projection adds
- **Which change**: the pipeline is component-scoped, every fact below is change-scoped. The projection picks **the newest change of this component whose `sourceRef` carries an artifact digest** (across all placements' currents/holds and, failing those, the newest change of the component at all); if none, `artifact: null`. It states the pick: `artifact.changeId`, `changeName`, `createdAt`.
- **`artifact`** (optional top-level): `{ changeId, changeName, digests: string[], sbom: SbomRef|null, scans: ScanRunSummary[], exportGate: "pass"|"fail"|"not_run", signing: { promotionExports: PromotionExportRecord[] , originSignatureRefs: string[] }, unknownFields: [] }` — `scans` reduces `control_runs` rows for that change whose evidence parses as `ScanEvidence` to one entry per (scanner/method, digest) keeping the newest: `{ method, scanner, scannerVersion, digest, digestMatch, status, counts:{critical,high,medium,low}, threshold?, evaluatedAt, controlRunId, managed: boolean }` (`managed` = synthetic control id — the ONE server-side discriminator; put it on the wire). `exportGate` applies E6's own predicate read-only.
- **Build tile** (commander and outpost): keeps its executor line; adds **SBOM** (`format specVersion · scanner scannerVersion · generatedAt`, link to `location` when it is a URL; else "no SBOM reported for this artifact") and **PM** (commander: newest `promotionExports[]` entry → `signed for <peer> at <exportedAt> · N artifacts`, else "not created — a promotion manifest is created at export to a peer"; outpost: the imported change's `sourceRef.promotionManifest` → `signed by <exporter> · verified at import`). **Clickable only when SBOM or PM exists** → review dialog (portal-free body exported for tests): SBOM fields verbatim; PM `manifestVersion, createdAt, exporter, peer, changeUrn, artifacts[] (type, digest, signatureRef)`, signature present/absent, key fingerprint.
- **Scan & sign tile** (commander only, `instanceRole === "commander"`, after Registry before Config; NOT drawn on an outpost): title "Scan & sign", hint "at source — authorises cross-boundary transfer (ADR-0013)". Body: scan rows (`trivy 0.5x · sha256:… · pass · C0 H2 M5 L9 · 2026-08-1x`), `exportGate` verdict labelled **"export gate (E6)"**, then **sign**: `manifest signed for <peer> <date> (key <fp>)` per export, or "not signed yet — the promotion manifest is signed at export to a peer"; plus "origin artifact signature: not recorded" unless a `signatureRef` exists. States: **no artifact yet** (artifact null) / **not run** (artifact, no scans) / rows. **Clickable only when at least one scan row or one export exists** → review dialog: scan table (all fields incl. threshold + provenance if present, digest match, DB freshness if present in evidence), export/sign table, link "raw evidence on the change" → change detail. No CVE rows anywhere (not stored).
- The per-crossing scan REQUIREMENT stays a gate check on each target tile (unchanged).

### 9.4 Persist what the commander signs (owner decision)
- At export, beside the existing `boundaryBundleChecksums[]` stamp, stamp `sourceRef.promotionExports[]` ← `{ peerDomainId, exportedAt, checksum, manifest, manifestSignature, keyFingerprint }` on the **source change**, under the same `FOR UPDATE` read-modify-write (two peers export concurrently — the existing comment explains why the lock is the only ordering). Additive key; readers of `boundaryBundleChecksums` untouched. Signature is computed outside any tx (subprocess) — the stamp happens in the later tx that already exists (where `stampBoundaryBundleChecksum` runs). Integration test: export to two peers → two entries, both signatures verify against the instance public key.

### 9.5 Fixture (both sites, idempotent)
- Commander (`seed-review-fixture.mjs`): target properties (9.1); `hq-registry` execution-system (kind gitea, `serverUrl https://registry.hq.invalid`, `webUrl`), `domainLocal:true`; `publishes_to` edge checkout-api → hq-registry `{repository:"acme/checkout-api"}`; a **first-party change report** for checkout-api (`POST /change-sources/github/report` matching `acme/checkout services/api/**`) carrying `artifactDigest` + an `sbom` reference (cyclonedx 1.5, digest, `location https://ci.acme.invalid/sbom/checkout-api.cdx.json`, scanner syft) so the Build/Registry tiles have a real artifact; and — through the **designed** M17.1 path if it is reachable from the API (a `scan-result-control` control object + policy `requireControls` at the prod wave + the verdict POST the control accepts) — one scan control run with `ScanEvidence` `pass` for that digest. If that path is not reachable without a plugin host round-trip, the fixture stops there and the tile honestly says "not run" — **no direct SQL, no invented evidence**.
- Outpost: **new `scripts/seed-outpost-fixture.mjs`** (base URL/creds args like the commander one; idempotent by GET-then-create) that (re)creates the outpost-only objects the review pair relies on and today exist only by hand: `field-cluster` target with the 9.1 facet, the three checkout-api mappings (`field/mirror-of-shared-asg-iac` mirrorOfShared, `field/checkout-network-cidr`, `field/checkout-overlays`), the placement of checkout-api on field-cluster, `field-registry` execution-system (kind gitea, `serverUrl https://registry.field.invalid`, `domainLocal:true`) and its `publishes_to` edge `{repository:"acme/checkout-api"}`.

### 9.6 Honesty + tests
- Every tile field is a stored fact or a stated absence; nothing derived from names; unknownFields used for what the projection cannot know.
- Web tests: node order with the new kind on the commander only (`['source','build','registry','scan-sign','source','wave']` vs outpost unchanged), facet line joins only present values and never reads `name`, Registry header states `declared|ambiguous|none`, Build/Scan tiles have NO click affordance when empty and DO when data exists, dialogs' bodies render the fields verbatim (portal-free bodies), grey/closed rules untouched. Server: projection integration tests for `registry` (none/declared/ambiguous, domain-local edge does not journal), `artifact` pick + scans reduction (+`managed`), facet on the wire for placed and unplaced stages, migration journal ordering, 9.4 stamp. Mutate the fixture claims (per the "vacuous tests" lesson).
- Gates: `pnpm gen` (commit codegen), `pnpm -w typecheck`, vitest (web + server unit), server integration for touched files, oasdiff prediction by diffing `tools/openapi/openapi.v1.json` (no removed/optionalised required fields).
