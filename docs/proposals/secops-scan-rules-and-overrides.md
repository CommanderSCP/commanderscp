# SecOps scan-result rules, vendor acceptance, and overrides

**Status:** v0.1 Draft — **proposed, pending review.** Owner decisions of 2026-08-17 are recorded in §3 and are settled; everything else is proposal.
**Relates to:** [ADR-0016](../adr/0016-scoped-scan-requirement-policies.md) (the six-tier tightening chain this extends), [ADR-0013](../adr/0013-supply-chain-scan-sbom-manifest.md) (scan as a boundary-authorization gate), [ADR-0020](../adr/0020-first-class-commander-scanning.md) (**whose "adds no way to loosen" invariant this proposal contradicts — resolved by the new [ADR-0033](../adr/0033-scan-exclusions-and-overrides.md), see §9**), [ADR-0032](../adr/0032-dependency-subscriptions.md) (the dependency inventory this reads), [ADR-0003](../adr/0003-internal-egress-for-execution-systems.md) (the declaration-grants-nothing pattern §6 copies), [ADR-0024](../adr/0024-decision-and-audit-retention.md) (the retention class §7's new table needs).

---

## 1. What the owner asked for

Five parts, verbatim in substance:

1. SecOps sets scan-result rules and config (e.g. "0 highs to pass") determining whether a scan passes and a change may proceed.
2. Rules settable from the Commander level all the way down to a component.
3. Vendor dependencies should be considered a pass.
4. Detect the latest a vendor offers, since Continuous Dependency Upgrades already does this.
5. Components supply info (e.g. "no egress") that automatically sets overrides where relevant; and component, service and assembly owners can raise override *requests* beyond those.

## 2. What already exists (grounded — do not overstate)

**Parts 1 and 2 are shipped.** ADR-0016 / M17.5 resolve a `scanThreshold` across six tiers — platform → trust domain (partition) → org → containment domain → service → component — as a per-severity MIN (`mergeScanThresholds`, [scan-requirements.ts:164](../../apps/server/src/governance/scan-requirements.ts)), threaded to `scan-result-control` through `buildControlContext`. "0 highs at Commander, tightened at a service" works today. Four qualifications:

- **(a) The commander's own promotion scan ignores every tier below `trust_domain`.** `promotion-scan-step.ts:350` passes `firedPolicies: []`, with a comment admitting it. Org/service/component ceilings bind on the lifecycle gate and are silently absent on the managed scan.
- **(b) `assembly` has no tier.** It is a real shipped object type (drizzle/0055; `CONTAINER_TYPES = ["service","assembly"]`), but `tierForObjectType` falls it through to `component`, so an assembly-anchored ceiling *enforces* correctly and *misreports* its tier — breaking ADR-0016 §5. **Folded into M22.0**, not spun off — see the D6 note below.
- **(c) There is no SecOps identity.** No security-specific permission exists; above-org floors use a shared `x-scp-operator-token`, org-and-below needs `policy:write` (Administrator/Owner only). There is also **no way to grant a role at all** — `role_binding:write` is declared and nothing checks it.
- **(d) A `scanThreshold` policy that names no scan control in `requireControls` does nothing, silently.** `resolveEffectiveScanThreshold` is reached only inside `if (allControlIds.length > 0)`. This is the default outcome for a first-time SecOps author, not an error.

**Part 4 is built and reusable.** `dependency_lines.latest_version` / `latest_digest` / `latest_observed_at` are persisted by `recordDependencyLineHead`, refreshed on every poll (including no-op restatements), and readable at gate time as one indexed row with **no egress** — which is what makes this air-gap-safe.

**Parts 3 and 5 are absent, and part 3 is blocked on something upstream of itself.**

## 3. Owner decisions (2026-08-17) — settled

| # | Decision |
|---|---|
| D1 | **"Vendor dependency accepted" = we are on the latest version *of a major version*. No exceptions unless an override is created and approved.** |
| D2 | Component-declared info **encodes the override directly** (recommendation to have SecOps author the mapping was considered and declined). |
| D3 | Approver standing = **the tier that set the rule**. A platform floor is waivable only at platform. |
| D4 | An approved override is a **standing grant per (component × finding), with an expiry**. |
| D5 | **Administrator serves as SecOps for now**; a least-privilege security role comes later. |
| D6 | Adjacent defects found during the census are **spun off**, not folded in — with the D8 exception: a defect M22 *structurally depends on* is folded in. Two qualify: the control-run cache (D8, explicit) and the **`assembly` tier/approval-scope fix**, since assembly-tier ceilings and assembly-scoped approvals are both load-bearing for D3. The other four census defects are spun off as filed. |
| D7 | **The GATE is decoupled from automation; the vendor-pass DATA stays coupled.** Every component is scanned and gated regardless of dependency automation. The vendor-pass needs ingested manifests and a polled line head, so it is available only to automation-enabled components; everyone else upgrades manually, and only *unfixable* findings need an override. **No widening of ingestion or polling** — the original "ingestion only for enabled components/services" requirement stands unreversed. (Resolved 2026-08-17 after two conversations used "decoupled" for two different things — see §10.) |
| D8 | The **control-run cache fix is folded into M22 as a blocking prerequisite**, ahead of the override work. D4's expiry must bind on day one. |
| D9 | Exclusions and approved overrides **federate fully** as ordinary federated objects (summary-only was recommended and declined; cost recorded in ADR-0033). |
| D10 | Scan-finding retention **splits by evidentiary role**: an *excluded* finding is accepted-risk evidence (ADR-0024 class **E**); an ordinary finding is telemetry (class **O**). |
| D11 | The first build slice is **all nine increments** (M22). |

D1 is a happy convergence: "latest *within the major line*" is exactly `dependency_lines`' identity `(org_id, ecosystem, coordinate, major)`. The security rule and the inventory's key are the same shape, arrived at independently.

## 4. The blocker: a scan verdict is four integers

This is the finding that determines the whole design.

`parseTrivyResult` ([promotion-scan-step.ts:698](../../apps/server/src/federation/promotion-scan-step.ts)) walks `Results[].Vulnerabilities[]` and reads **`.Severity` and nothing else**. `VulnerabilityID`, `PkgName`, `InstalledVersion`, `FixedVersion`, `PkgIdentifier.PURL` and `Results[].Class` are all present in the document and are all discarded. The raw document is then deleted (`rm(scratch, {recursive: true})`, :652-654) or never stored. `ScanEvidenceSchema` persists `severityCounts` — four integers — and there is no findings table anywhere in 65 migrations.

Every one of parts 3, 4 and 5 is a rule **about a finding**. No finding survives. So per-finding attribution is the unblocker, and everything else queues behind it.

Three things make this cheaper than it sounds, and one makes it more dangerous:

- The data is **already in hand at parse time** — `trivy image --format json` emits the full native result, offline, `--network none`. This is a *persist* decision, not a scanning decision. Charter principles 1 and 5 are untouched.
- **The parser can be shared.** An earlier draft asserted "a plugin cannot import `@scp/schemas`" and built a duplicated-parser design around it. That is **false**: `@scp/plugin-scan-result-control` already declares `@scp/schemas` as a dependency. The shared-parser route is available and is the correct one.
- **There is a third verdict producer, and it structurally cannot carry this.** `parseOscapResult` ([:797](../../apps/server/src/federation/promotion-scan-step.ts)) counts failed XCCDF rule-results into the *same* `ScanSeverityCounts`. XCCDF rule-results have no package name, no purl, no `FixedVersion`, no `Class` — and XCCDF has no `critical` severity at all, so `critical` is vacuously 0. **An OpenSCAP verdict can never be excluded from**, and any code that assumes "findings exist" is a fail-open there. See §8.

## 5. The design in one sentence

> Keep ADR-0016's ceiling exactly as it is — a MIN that only ever tightens — and add a **second, separately-authorized dimension**: per-finding **exclusions**, applied **before counting**, whose algebra is a **monotone AND down the tier chain**, so a loosening at any depth requires admission from every tier above it.

### 5.1 Why before counting, not after comparing

A loosening could act in two places: exclude findings from the counts, or turn a `fail` verdict into a `pass`. The second is a waiver on the verdict — coarse, it hides *which* finding was tolerated, and because the E6 export gate identifies a scan outcome purely by shape (`status === "pass"` + evidence parses + digest matches), a verdict-level waiver would be **invisible at the federation boundary** where evidence is frozen into a bundle. Exclusion-before-counting leaves `mergeScanThresholds` untouched, keeps "0 highs" meaning exactly what SecOps wrote, and yields per-finding explainability for free.

### 5.2 Where the loosening is, stated plainly

This is the security-critical part, and it runs opposite to everything ADR-0016 built.

- **Tightening** stays a per-severity MIN over an unordered set — commutative, associative, tie-safe. Untouched.
- **Loosening** gets the opposite guard: an exclusion **class** has effect at tier T only if **every tier from platform down to T has admitted that class**. That is a monotone AND — also commutative, also tie-safe — so ADR-0016 §4's order-independence survives intact and the two dimensions never interact.
- **Default admission is empty at every tier.** With nothing authored, behaviour is byte-identical to today.
- **A matcher miss yields no exclusion.** This is the opposite sign from the group-scope fail-open ADR-0016 §2a had to fix: for a loosening, a miss must fail *safe*.
- **A component-declared fact never creates an exclusion by itself** — see §6.

## 6. Component-declared info (D2), built as safely as the decision allows

The owner chose direct encoding over SecOps-authored mapping. The privilege-escalation seam was raised before the decision and is real: a component's `properties`/`labels` are writable at plain `object:write` **scoped at that component** — the component owner — while SecOps authority is `policy:write`, carried only by Administrator/Owner. So the beneficiary of a declaration is also its author, at the weaker permission.

That decision is settled and this proposal implements it. What it does *not* require is that the declaration be unbounded, so three guards ride along, none of which contradict D2:

1. **Tier admission still applies.** A declaration encodes an override; whether that class of override has effect at this tier is still the monotone AND of §5.2. A tier can decline to admit component-declared overrides beneath its ceiling. The component authors the override; it does not author its own admission.
2. **Declared facts are recorded verbatim in evidence and in the Decision.** An auditor reads *"passed because component X asserted `egress: none` under admission Y"*, never just *"passed"*. Charter principle 6.
3. **Never key on `labels`.** They are tenant-writable, unvalidated (no schema, no reserved namespace) and are already a live evasion path for selector-scoped policies — spun off as its own task. Declarations go in a typed `property_schema`, following the typed-but-**open** pattern of drizzle/0043 and 0051: a closed enum would wedge federation, because `import-repo.ts`'s `object_upsert` branch Ajv-validates with no `try/catch` and one rejection aborts a peer's entire signed bundle. Use `z.strictObject` on the *request body* instead.

There is a residual hazard D2 cannot remove: the declaration is read live at gate time from a tenant-writable bag and is not pinned to the artifact, so it can be flipped for the duration of a gate and flipped back. §7 Increment 5 pins the declared value into evidence at evaluation time so the flip is at least *visible* after the fact.

## 7. Increments

Each names **what calls it** — this repo's dominant defect is a component built, tested directly, and never wired in.

**Increment 0 — make the Decision explain the rule.** *(No behaviour change. Prerequisite.)* Today the gate Decision's `inputContext` carries only counts of policies; the resolved threshold and its contributors go **only** into `control_runs.evidence`. ADR-0016 §5's promise is honoured in evidence and broken in the Decision an operator resolves by `decision_id`. Put the effective threshold and contributors into the Decision *before* any exception can hide inside it. **Calls it:** `evaluateGovernanceGate`'s return, written by `reconcile.ts`, `campaign-reconcile.ts` and `transition.ts` — live the moment it is added. **Trap:** `restatesDecision` canonicalises key order but *preserves array order*, and `matchPoliciesForTargets` returns insertion order — so sort deterministically and carry no timestamps, or write-suppression breaks and the 1.44 GB/day Decision flood returns. Includes the `assembly` tier fix (see the D6 note in §3).

**Increment 1 — per-finding attribution.** Emit findings `{vulnerabilityId, pkgName, installedVersion, fixedVersion, class, target, severity, purlAsEmitted}` from a **shared parser** in `@scp/schemas`, imported by both the plugin and the server (§4 — the plugin already depends on it). `severityCounts` becomes derived from findings, preserving today's per-entry counting so operator-visible numbers do not move. Persist a bounded projection in `scan_findings`. **Calls it:** `scan-result-control/src/index.ts:354` and `promotion-scan-step.ts:630`. **Installation proof:** delete the finding emission from one parser and watch a shared conformance test die. **Wire shape:** `severityCounts` stays required and unchanged; add `effectiveSeverityCounts?`, `exclusions?`, `exclusionSetHash?` as new **optional** siblings — never `.default()`, never widen a required field to nullable (oasdiff ERR).

**Increment 2 — the exclusion dimension.** A `scanExclusion` policy effect plus instance-tier admission rows, resolved by a new pure `resolveEffectiveScanExclusions` beside `mergeScanThresholds`. **Calls it:** `buildControlContext` from **both** construction sites — the prewarm run is the one that gets cached — **and** `promotion-scan-step.ts:350`, whose `firedPolicies: []` must be fixed here or the commander path diverges from the lifecycle gate at exactly the boundary where evidence is frozen. That fix is **not a one-liner**: that site has no CEL sandbox and no CEL context. Migration must restate the whole policy `property_schema` (the 0029→0062 pattern) and should close `additionalProperties: false` on all four effect kinds at once, as 0062's own header says is owed — today `{"scanTreshold": {...}}` writes cleanly and contributes nothing, with no warning.

**Increment 3 — "no fix available" as an exclusion class.** Pure data over Increment 1's fields (`fixedVersion` absent). No inventory join.

**Increment 4 — D1: "on the latest of our major line".** Predicate is per-ecosystem: version compare for language ecosystems; **`latest_digest` for `oci`**, because the OCI index reports *tags* and a tag is not an identity — two images can agree on `latest` by tag and differ by bytes. **Non-negotiable air-gap rules:** single indexed row read, no egress; **NULL `latest_version` does not qualify** ("not observed" is never "up to date" — the column's own docblock says so); `latest_observed_at` older than a bound derived from `SCP_DEPENDENCY_VERSION_POLL_INTERVAL_SECONDS` (not hardcoded) does not qualify; no inventory row does not qualify. Design against ADR-0032 **§7c clause 3** — the normative role-guard that makes the *third-party version poll* commander-only and fail-closed on an undeclared `SCP_FEDERATION_ROLE`. Note §4a clause 7 goes the other way for *ingestion*, so do not generalise one into the other.

**Increment 5 — component-declared facts.** Per §6.

**Increment 6 — the override request.** A governance-managed graph object type (charter 2), status in `properties`, transitions writing a Decision **plus a hash-chained audit event per act** — copying the `freeze.override` shape (mandatory non-empty reason, high-severity event) and **not** the approvals shape, which writes no audit event on a vote. Time-bounding is a **read-time SQL window** in the resolver, never a status column a job flips: there is no sweeper anywhere in this tree. **Must-do:** register in `GOVERNANCE_MANAGED_OBJECT_TYPE_IDS` — that set exists because the generic `/objects/{type}` endpoint and the IaC apply path both once skipped governance entirely — and note **a third write path, federation import**, which that set's own docblock does not enumerate. `approval_requests` cannot be reused (change-keyed `NOT NULL`, two-state, engine-materialized only). `owners-of` cannot decide who may raise a request: it walks `domain_id` only and never joins `contains`, so it does not return a component's assembly's or service's owner.

**D3 needs no new authority model.** Measured and confirmed end-to-end: `policy-resolve.ts:271-279` records an `objectRef` hit when the ref is anywhere on the target's containment chain; `policy-scope-authz.ts` requires `policy:write` only *at-or-above that object* for a bounded `objectRef`; and `authz/resolve.ts`'s `scopeExpandCte` expands **upward**, so a binding at an assembly satisfies a check at any component beneath it while a component binding never reaches its service. "This assembly and below, at assembly-level authority" is expressible **today**. (Hypothesis contributed by the Continuous Dependency Upgrades session; verified here.)

**Increment 7 — the actuator.** *The increment this project most reliably forgets.* Without it, every grant is inert on any change whose gate already ran. Evidence carries `exclusionSetHash`; the reconcile prewarm re-resolves, hashes, and passes `force: true` on mismatch — `ensureControlRuns` does not currently even **accept** a `force` parameter — only the singular `ensureControlRun` does — so widening that input type is part of the work, not just forwarding. **Installation proof:** grant an exclusion *after* a change has already failed its gate, assert it subsequently passes, then delete the force-forwarding and watch that test die.

**Increment 8 — parity.** `GET /components/{idOrUrn}/scan-requirements` returning the resolved ceiling, its contributors and admitted exclusion classes, writing **no** Decision. Then SDK → CLI → IaC → UI. Also: refuse at authoring time a `scanThreshold`/`scanExclusion` policy naming no scan control in `requireControls`, or §2(d) remains the default SecOps experience.

## 8. Adversarial findings this design must answer

Three independent lenses attacked the shape. The blocking ones and their answers:

| Finding | Answer |
|---|---|
| **The actuator is scoped to `validating` only.** `prewarmGovernanceForChange` has **two** non-test callers and neither reaches a post-accept gate (`reconcile.ts:562` sweeps only `["validating"]`; `dependencies/bump-gate.ts:406` prewarms one bump change that is never advanced), and `latestControlRun` is keyed on `(orgId, changeObjectId, controlObjectId)` — **not** gateKind, **not** gateRef. One run made during `validating` satisfies the accept edge *and every wave boundary including production*, for the change's life. A 7-day grant can authorise a production wave three weeks later. | Increment 7 is necessary but **not sufficient**. The cache key must include gate identity, and re-evaluation must reach post-accept gates. This is the single largest correctness risk in the feature. |
| **Redefining `severityCounts` post-exclusion subverts every existing CEL condition** authored against it. | `severityCounts` keeps meaning *what the scanner found*. Exclusions produce a **new** `effectiveSeverityCounts`, and only the threshold comparison uses it. CEL conditions on raw counts keep their meaning and stay stricter — a divergence, but a safe-signed one, and documented. |
| **Unioning exclusions across `targetObjectIds` inverts multi-target safety** — a clause admitted for one target would leak to its siblings. | Exclusions resolve **per target**, never unioned across the target set. The MIN may union because tightening is safe under union; a loosening is not. |
| **Reusing `ceilingContributorKeys` inherits its condition-error union**, which is fail-*closed* for a ceiling and fail-*open* for an exclusion. | A contributor whose CEL condition errors **contributes no exclusion**. The two dimensions need opposite error handling; they must not share this helper. |
| **OpenSCAP is a third verdict producer** that structurally cannot carry per-finding fields. | Exclusions never apply to an OpenSCAP verdict. Explicit, tested, and stated in evidence — not left to "there were no findings to exclude." |
| **E6 and the promotion scan accept *any* passing `control_runs` row**, never the latest — so revocation and expiry are inert at the boundary. | Spun off as its own task; **Increment 6's expiry is not trustworthy until it lands.** Stated here as a dependency rather than assumed away. |
| **Increment 0's `APPROVAL_SCOPE_KEYWORDS` change is a loosening for existing data.** | Handled in the spun-off assembly task, which requires an estate query before shipping. |
| **`scan_findings` is the highest-cardinality table in the system**, introduced with no ADR-0024 evidentiary class or retention window. | Must not ship without one. Per-scan caps are explicitly insufficient per ADR-0024 §D0. If the persisted set is truncated, **refuse all exclusions for that scan** — you cannot except what you did not record. |
| **The force-on-hash-change actuator is unbounded**, and the exclusion set is time-dependent, so a clause on an expiry boundary re-runs the control every tick. | Hash must be computed over the *resolved set*, not over inputs including timestamps. This is the 1.44 GB/day pattern in a new place. |

## 9. This contradicts ADR-0020, and that must be faced

ADR-0020 states as a **preserved invariant** that the promotion scan step "adds no way to loosen" E6. The exclusion dimension is exactly a way to loosen it. ADR-0016 is therefore the *wrong and insufficient* ADR to amend: this needs a new ADR that supersedes that invariant explicitly, with ADR-0020 amended to point at it. Quietly extending ADR-0016 would leave two Accepted documents contradicting each other — a failure mode this project has hit before.

## 10. Coverage: the gate is decoupled from automation, the vendor-pass data is not (D7)

**Resolved 2026-08-17, after two conversations used the word "decoupled" for two different things and reached opposite conclusions. Recorded in full because the near-miss is the useful part.**

### 10.1 The two senses

- **The GATE.** Every component is scanned and gated regardless of whether dependency automation is enabled. Nobody escapes a scan by not opting in. This was never in question.
- **The DATA.** The vendor-pass (D1: "on the latest of our major line") can only be *evaluated* where SCP has ingested the component's manifests and polled the line's head. Both happen only for automation-enabled components.

An earlier draft of this section recorded a decision to widen **the data**, and argued the enablement gate on ingestion had been over-applied — that the gate-1 flip guards a repository-**write** credential class, ingestion is a read, so the gate was misplaced. **That argument was wrong**, and the correction came from the session present for the original specification: *"ingestion only for enabled components/services"* was an original, explicit requirement, not a consequence of the credential-class reasoning.

### 10.2 The resolution

**The gate is decoupled from automation. The data stays coupled.** No widening of ingestion or polling. The original requirement stands unreversed. A component without dependency automation gets scanned, gets gated, and gets no vendor-pass — its engineer upgrades manually until the finding clears.

**Why that is coherent rather than merely cheaper.** An earlier objection here claimed the coupling would produce an override queue on day one. That was overstated. A *fixable* finding disappears when the engineer upgrades — no override needed, no queue. Only a genuinely **unfixable** finding on an unenabled component reaches the override path, which is a far smaller set than "every unevaluable dependency".

### 10.3 What the vendor-pass actually reaches — three classes, not one

An earlier draft of this section claimed OS packages and transitive dependencies "can never earn a vendor-pass," because the inventory holds only directly declared manifest dependencies. **That was wrong for the largest class**, and the correction matters more than the coverage question it was written under.

**OS packages come from the base image, and the base image IS a tracked dependency line.** `packages/dependency-manifests/src/dockerfile.ts` parses every `FROM` that names a real image into a declared image dependency — its module doc calls this "the owner's headline case: a component builds `FROM alpine:1.0`, Alpine publishes `1.1`, and the subscription rewrites that one line." Those lines are ecosystem `oci`, with heads resolved by `@scp/plugin-dependency-index-oci`.

So D1's logic applies to them directly: **if the component is on the latest of its base image's major line, there is nothing more the team can do about an OS-package CVE**, and the finding earns a vendor-pass — attributed to the *image line*, not to the individual package.

| Finding class | Trivy signal | Attributable to | Vendor-pass reachable? |
|---|---|---|---|
| OS package | `Class = os-pkgs` | the **base image** line (Dockerfile `FROM`) | **Yes** — via the image line's head |
| Direct declared dependency | `Class = lang-pkgs`, matches a manifest line | its own line | **Yes** |
| Transitive dependency | `Class = lang-pkgs`, no manifest line | nothing | **No** — falls through to the ceiling, the no-fix-available class (§7 Increment 3), or an override |

Only the third class is genuinely unreachable, and it is unreachable for a defensible reason: a transitive dependency *is* fixable, by moving the direct parent that pulls it. The rule declining to excuse it is the rule working.

**Two consequences for the `oci` arm.** The head is a *tag*, and a tag is not an identity — so this comparison uses `latest_digest`, not `latest_version`. And `dockerfile.ts` records an `ARG`-interpolated `FROM` as `unresolved`, a bare `FROM alpine` as `unpinned`, and a digest-only `FROM alpine@sha256:…` as `pinned` **with no comparable `version`** — none of the three gives a version on a known major line, so none qualifies: absent never means up to date.

### 10.3a Blast radius: a scan blocks one component's progression

A scan covers everything inside an artifact, but a failing verdict stops **only that component from moving forward** — not its service, not its siblings. The enforcement unit is the component even though the scan subject is an image.

That is why §5.2's exclusions resolve **per target and are never unioned across a target set** (ADR-0033 §3). For a *ceiling* a union is safe, because more contributors can only tighten. For an *exclusion* a union would let a clause admitted for one component leak to its siblings — widening a loosening past the blast radius the gate itself has.

### 10.4 Granularity, verified

A scan's subject is an **artifact digest**, not a component: `ScanSubject` carries `digest`/`pullRef`, and `ScanEvidence` records `artifactDigest`/`expectedDigest`/`digestMatch`. The gate context threads `targetObjectIds`. The **inventory** is component-scoped — `component_dependencies` keyed `(orgId, componentObjectId, lineId, manifestPath)` — and enablement is per component.

So the vendor-pass chain is **finding → package → dependency line → component**, and the component is where enablement and the rule meet. The scan being artifact-subjected and the inventory being component-scoped is not a mismatch; it is the join the rule walks.

### 10.5 Process note — why this nearly shipped wrong

Two sessions relayed the same decision to the owner within an hour and got opposite answers, because each framed it differently: one emphasised that the rule is otherwise unenforceable, the other that it reverses a stated requirement. Neither framing was dishonest and both answers were real. What caught it was the standing rule to **confirm every relayed decision with the owner directly, regardless of size**. Had either session treated its own relay as authoritative, an argued-for reversal of an explicit requirement would have entered an Accepted document.

## 11. Charter check

1. **Coordinate not execute** — nothing new is executed; the managed scan gains no capability.
2. **Graph-native** — rules and grants are policy effects and graph objects. One new table, a bounded derived-observation projection, justified on drizzle/0061's four measured tests and deliberately not journaled.
3. **API-first parity** — Increment 8; the read/preview endpoint is what SecOps needs to verify their own rules.
4. **PostgreSQL only** — no new stateful dependency.
5. **Air-gap first** — no new runtime egress. Trivy already runs `--offline-scan --skip-db-update --network none`; the latest-version read is a local indexed row. D7's resolution introduces no egress at all — no widening of ingestion or polling means no new outbound reach — so there is no principle-5 exception here.
6. **Explainability** — Increment 0 puts the rule into the Decision *before* any exception can hide inside it, and every applied exclusion names its clause, its admitting tier, its authority and its expiry.

## 12. UI handoff

UI work belongs to the UI session, whose base is the unmerged `claude/ui-review-worktree-efc42b` (~110 commits ahead of main, contains main, carries the substrate-facet `property_schema` precedent). **Do not target main.** Nothing here should be built before Increment 1 lands, because until then there are no findings to render.

Four surfaces, in dependency order:

1. **Cheapest first win, available today:** the Control runs card on `/changes/$id` already renders scan evidence into a raw-JSON `<pre>`. The resolved threshold, its contributing tiers and (later) the exclusion list are all sitting there unrendered. Turning that into a real panel needs no server change.
2. **"Why did this pass/fail?"** — per-finding table with, for each excluded finding, the clause that excluded it, the tier that admitted it, the authority behind it and its expiry. This is charter principle 6 made visible and is the feature's main operator surface.
3. **Rule authoring and preview** — consuming `GET /components/{idOrUrn}/scan-requirements` (Increment 8). Must show the *resolved* ceiling and every contributing tier, because "I authored a rule and cannot tell whether it applies" is today's default SecOps experience (§2(d)). Note the endpoint deliberately writes no Decision, so it is safe to poll; `POST /policy-evaluate` is **not** — it writes a Decision per call with no suppression.
4. **Override request lifecycle** — raise, approve/deny, revoke, and an expiry that is visibly a read-time window rather than a status flag.

Two constraints worth stating up front: the tier enum widening (`assembly`) is an oasdiff response-enum change, so the SDK regenerates; and an override's expiry must never be rendered from a stored status column, because none exists by design.

## 13. Attribution

The dependency-inventory grounding, the poll-coverage and ingestion-gate measurements, the OCI tag-vs-digest correction, the restatement-pin placement, and the `scope.objectRef` hypothesis that dissolved the authority question were contributed by the Continuous Dependency Upgrades session and verified here.
