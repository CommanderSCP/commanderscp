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
