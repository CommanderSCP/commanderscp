# ADR-0033: Scan exclusions — a separately-authorized loosening dimension, admitted top-down

**Status:** Proposed (owner decisions D1–D11 taken 2026-08-17; the mechanism below is proposal pending review)
**Context doc:** [docs/proposals/secops-scan-rules-and-overrides.md](../proposals/secops-scan-rules-and-overrides.md)
**Relates to:** [ADR-0016](0016-scoped-scan-requirement-policies.md) (the tightening MIN this sits beside, unchanged); [ADR-0013](0013-supply-chain-scan-sbom-manifest.md) (scan as a boundary-authorization gate); [ADR-0032](0032-dependency-subscriptions.md) (the dependency inventory D1's rule reads); [ADR-0003](0003-internal-egress-for-execution-systems.md) (declaration-grants-nothing, the pattern §6 copies); [ADR-0024](0024-decision-and-audit-retention.md) (the evidentiary classes §7 assigns); [ADR-0031](0031-domain-local-objects-never-federate.md) (locality is opt-in — `domain_local NOT NULL DEFAULT false` — so D9 selects the existing default rather than overriding anything); charter principles 2, 4, 5, 6.
**Supersedes:** the *"adds no way to loosen"* invariant asserted in [ADR-0020](0020-first-class-commander-scanning.md) — see §9. **ADR-0020 is amended to point here.**

## Context

ADR-0016 made scan pass-criteria **scoped and tightening-only**: a per-severity MIN over a six-tier chain where a child may only ever lower a ceiling. That was the right shape for a ceiling and it is not changed by this ADR.

The owner has now asked for the opposite direction — findings that should **not** count:

1. **Vendor dependencies as a pass** (D1: we are on the latest of that major line).
2. **Component-declared facts** (e.g. "no egress") that set overrides.
3. **Override requests** raised by component, service and assembly owners.

Every one of these is a rule **about an individual finding**. That is the problem.

### What exists today (grounded — do not overstate)

1. **A scan verdict is four integers.** `parseTrivyResult` (`apps/server/src/federation/promotion-scan-step.ts:698`) walks `Results[].Vulnerabilities[]` and reads **`.Severity` and nothing else**. `VulnerabilityID`, `PkgName`, `InstalledVersion`, `FixedVersion`, `PkgIdentifier.PURL` and `Results[].Class` are all present in the document and all discarded. The raw document is then deleted (`:652-654`) or never stored. `ScanEvidenceSchema` persists `severityCounts` and no findings. **No finding survives to be excluded.**
2. **The data is already in hand at parse time.** `apps/runner-scan/run.sh:218-226` runs `trivy image --format json --skip-db-update --offline-scan` with `--network none`. This is a **persist** decision, not a scanning decision: charter principles 1 and 5 are untouched, and no new egress is introduced.
3. **The parse must not be duplicated.** An earlier draft asserted "a plugin cannot import `@scp/schemas`" and designed a duplicated parser with a cross-boundary conformance test. **That is false** — `@scp/plugin-scan-result-control` already declares `@scp/schemas` as a dependency. The parse is shared.
4. **There is a THIRD verdict producer that structurally cannot carry findings.** `parseOscapResult` (`:797`) counts failed XCCDF rule-results into the same `ScanSeverityCounts`. XCCDF rule-results have no package, no purl, no `FixedVersion`, no `Class`, and XCCDF emits no `critical` at all. Any code assuming "findings exist wherever a verdict exists" is fail-open there.
5. **A control outcome is cached without gate identity.** `latestControlRun` is keyed `(orgId, changeObjectId, controlObjectId)` — not `gateKind`, not `gateRef` — and `prewarmGovernanceForChange` has **two** non-test callers and neither reaches a post-accept gate — `reconcile.ts:562` sweeps only `validating`, and `dependencies/bump-gate.ts:406` prewarms one bump change (controls only, `materializeApprovals: false`) that is deliberately never advanced. So one run made during validation satisfies the accept edge **and every later wave boundary, including production**. No production call site passes `force` — and `ensureControlRuns` does not **accept** a `force` parameter at all (`control-runner.ts:185-196` takes `{orgId, changeObjectId, controlObjectIds, gateKind, gateRef, context}`); only the singular `ensureControlRun` declares it. Widening the plural signature is therefore part of the work, not just forwarding a value through it.

## Decision

Keep ADR-0016's ceiling exactly as it is, and add a **second, separately-authorized dimension**: per-finding **exclusions**, applied **before counting**, admitted **top-down**.

### 1. Two dimensions, two algebras, deliberately non-interacting

| | Tightening (ADR-0016, unchanged) | Loosening (this ADR) |
|---|---|---|
| Object | a severity **ceiling** | a set of **exclusion clauses** |
| Algebra | per-severity **MIN** over an unordered set | **monotone AND** down the tier chain |
| Direction | a child may only lower | a clause has effect at tier T only if **every tier from platform down to T admits its class** |
| Default | absent contributes nothing | admission is **empty at every tier** |
| On a matcher miss | contributes nothing (safe) | **yields no exclusion** (safe) |

Both are commutative and associative, so **ADR-0016 §4's order-independence survives** — which matters for the documented containment-domain-vs-service tie (`containment.ts:207-219`), where "most specific wins" would be undefined. The two dimensions never touch: exclusions change *what is counted*, the ceiling changes *what the count is compared against*.

**With nothing authored, behaviour is byte-identical to today.**

### 2. Exclusion before counting, never a waiver on the verdict

A loosening could act in two places. Turning a `fail` into a `pass` was rejected: it is coarse, it hides *which* finding was tolerated, and because the E6 export gate identifies a scan outcome purely by shape (`status === "pass"` + evidence parses + digest matches), a verdict-level waiver would be **invisible at the federation boundary** where evidence is frozen into a bundle.

Exclusion-before-counting leaves `mergeScanThresholds` untouched, keeps "0 highs" meaning exactly what SecOps wrote, and yields per-finding explainability for free.

**`severityCounts` keeps meaning what the scanner found.** Redefining it post-exclusion would silently subvert every existing CEL condition authored against it. A **new** `effectiveSeverityCounts` carries the post-exclusion number, and only the threshold comparison uses it. CEL conditions on raw counts keep their meaning and stay stricter — a divergence, but safe-signed, and documented rather than discovered.

### 3. Exclusions resolve PER TARGET, never unioned across the target set

`resolveEffectiveScanThreshold` walks every target's containment chain and merges. For a **ceiling** a union is safe: more contributors can only tighten. For an **exclusion** a union is an inversion — a clause admitted for one target would leak to its siblings, which is silent cross-component scope creep. Exclusions are resolved per target and never merged across targets.

**This matches the gate's own blast radius.** A scan covers everything inside an artifact, but a failing verdict stops **only that component from moving forward** — not its service, not its siblings. The enforcement unit is the component even though the scan subject is an image digest. A unioned exclusion would therefore widen a *loosening* past the reach of the *blocking* it loosens, which is precisely the asymmetry that makes union safe in one dimension and unsafe in the other.

### 4. An unevaluable condition contributes NO exclusion

`ceilingContributorKeys` deliberately re-admits contributors whose CEL condition **errored**, at every enforcement level, because dropping a ceiling converts a fail into a pass. For an exclusion the sign is reversed: admitting a clause whose condition could not be evaluated *is* the fail-open. The two dimensions therefore need **opposite** error handling and **must not share that helper**.

### 5. The tier chain gains `assembly`

`assembly` is a shipped builtin (drizzle/0055; `CONTAINER_TYPES = ["service","assembly"]`; legal chain `service → assembly → component`) added *after* ADR-0016. `tierForObjectType` falls it through to `component`, so an assembly-anchored ceiling enforces correctly and **misreports its tier** — breaking ADR-0016 §5's promise and repeating, at a rung added later, the provenance-label defect §2a already paid to fix once. `ScanRequirementTierSchema` and `tierForObjectType` gain `assembly`; so does `APPROVAL_SCOPE_KEYWORDS`, where its absence makes `requireApprovals: {scope: "assembly"}` a permanently unsatisfiable required approval.

**Measured 2026-08-17 during M22.0: widening it is NOT a contract change.** `ScanRequirementTierSchema` does not reach the wire — the only tier enum in `openapi.v1.json` is the **two-value** `platform | trust_domain` of the instance floor route, and a contribution's six-tier label travels inside `control_runs.evidence`, which is stored as free-form JSON. `pnpm gen` produces a zero-byte diff and there is no oasdiff gate to predict. (An earlier draft of this document asserted the opposite; it was never checked against the generated spec.)

### 6. Component-declared facts (D2) — the declaration is bounded, not trusted

The owner chose direct encoding over a SecOps-authored mapping. The escalation seam was raised before the decision and is real: a component's `properties`/`labels` are writable at plain `object:write` **scoped at that component** — the component owner — while SecOps authority is `policy:write`, held only by Administrator/Owner. **The beneficiary of a declaration is also its author, at the weaker permission.**

That is settled. Three guards ride along, none of which contradict it:

1. **Tier admission still applies.** The component authors the override; it does not author its own *admission*. A tier can decline to admit component-declared overrides beneath its ceiling.
2. **The declared value is recorded verbatim** in evidence and in the Decision, so an auditor reads *"passed because component X asserted `egress: none` under admission Y"*, never *"passed"*.
3. **Never key on `labels`.** They are tenant-writable, unvalidated (no schema, no reserved namespace), and are already a live evasion path for selector-scoped policies — tracked separately. Declarations live in a typed `property_schema`, following the **typed-but-open** pattern of drizzle/0043 and 0051: a closed enum would wedge federation, because `import-repo.ts`'s `object_upsert` branch Ajv-validates with no `try/catch` and one rejection aborts a peer's entire signed bundle. Use `z.strictObject` on the **request body** instead.

**Residual hazard, accepted:** the declaration is read live at gate time from a tenant-writable bag and is not pinned to the artifact, so it can be flipped for the duration of a gate and flipped back. Pinning the declared value into evidence makes the flip *visible after the fact*; it does not prevent it.

### 6a. The override request — a standing, expiring grant, approved at the tier that set the rule (D3, D4)

**Shape (D4).** An approved override is a **standing grant per (component × finding), carrying an expiry** — not a per-change act. A per-change act was considered and rejected: for a genuinely unfixable finding it would have to be re-raised on every release, forever.

**Approver standing (D3): the tier that set the rule.** A platform-set floor is waivable only at platform; an assembly-set ceiling is waivable at assembly. Escalation is then self-evident — you cannot waive a constraint stricter than your own authority.

**This needs no new authority model, which is why D3 is affordable.** Verified end to end:
- `policy-resolve.ts:271-279` records an `objectRef` hit when the ref is **anywhere on the target's containment chain**, so a policy naming an assembly reaches every component beneath it.
- `policy-scope-authz.ts` requires `policy:write` **at-or-above that object** for a *bounded* `objectRef` — the org-root bar applies only to unscoped, selector and group scopes.
- `authz/resolve.ts`'s `scopeExpandCte` expands **upward**, so a binding at an assembly satisfies a check at any component beneath it, while a component binding never reaches its service or its siblings.

Composed, "this assembly and below, at assembly-level authority" is expressible today. What has no representation is a *broad* scope bounded to a subtree — and D3 does not need one, because naming the tier's object concretely **is** the bounded case.

**The named tier is a CLAIM, not a grant of standing** (correction, 2026-08-18 — the first implementation of D3 got this backwards). The three bullets above are all true and, on their own, enforce nothing: `tierObjectId` is written by the **requester**, and because `scopeExpandCte` expands *upward*, naming a **lower** object strictly **widens** the set of principals whose `policy:write` binding satisfies the approve check. A component owner could therefore name their own service, approve their own waiver at it, and drop a CRITICAL finding out of the count against a platform-set `maxCritical: 0` — with the audit trail truthfully recording *"under authority of `<service>`"*. D3's escalation guard was self-selected by the party seeking the waiver.

**The approver-standing tier is therefore DERIVED, and the claim is only ever validated against it:**

- **At the gate (decisive).** The resolver places `tierObjectId` on the *target's own* containment chain and reads its tier from that placement — an object that is not an ancestor is refused outright, never defaulted to `component`. That tier must be **at or above** the most senior tier in `EffectiveScanThreshold.contributors`, the provenance ADR-0016 §5 and M22.0 recorded so a block could name the tier that bound it. The bar is **every** contributing tier, not the binding one: excluding a finding lowers the *count*, which loosens every ceiling on that severity at once.
- **At the doors.** Raise and approve both require the named object to be on the component's chain (re-derived at approve, because a grant can arrive through IaC or federation without passing the raise route), and approve additionally refuses while an instance floor outranks the derived tier.

**Two consequences, stated rather than discovered.** *An instance floor makes grants inert:* `platform`/`trust_domain` floors are authored with the deployment operator token, no graph object maps to those rungs, so while such a floor is set no tenant-approved grant clears the bar. That is D3 read literally, and the approve route says so at the door instead of letting an operator sign a waiver that tolerates nothing. *With no tier-set ceiling the bar is **`org`**, never `component`:* an earlier revision of this ADR said the opposite — "no bar … there is no constraint stricter than the requester's own authority to escalate past, and the control falls back to its per-binding `config.threshold`" — and named its own counter-example in that final clause. **`config.threshold` is a constraint**, authored at the *control object's* scope (`PUT /controls/{id}/binding`, guarded by `policy:write` at the control), which is nowhere on the component's containment chain; and when neither a policy nor the binding config decides a severity the scan plugin does not stop enforcing, it applies its shipped fail-closed `maxCritical`/`maxHigh` = 0. Since exclusions are applied *before* the counts are compared, a bar of `component` let a service-scoped `policy:write` holder raise and approve a waiver against a ceiling they had no standing to author. The bar therefore never falls below `org` — the most senior rung a *tenant* can author at (owner decision, 2026-08-18). Deriving the bar fully instead, by injecting the binding config and the 0/0 default as synthetic contributors, was costed and rejected: it makes every grant inert wherever nothing was authored, which kills the feature. **What the floor does not close, stated rather than discovered:** an `org`-tier approver can still waive a `config.threshold` authored at control scope. Separately, **the raiser may not be the approver** — `decide` refuses an approval whose `requestedByActorId` is the deciding subject (approve only; deny and revoke stay free, because taking a waiver back must never be harder than making one). Every applied and every **refused** grant, with the bar it was measured against, lands in the gate Decision (charter principle 6).

**Expiry is a read-time SQL window, never a status column a job flips** — there is no sweeper in this tree and no `boss.schedule` usage to build one on. And an expiry is only as trustworthy as the re-evaluation that enforces it, which is why D8 folds the control-run cache fix in ahead of this (§10).

**A grant is DECIDED at exactly one door.** Governance-managed membership maps the IaC plan/apply path to `policy:write` at the target domain — which a routine domain-scoped policy author holds — and the registered `property_schema` must stay open (an Ajv rejection on the import path aborts a peer's whole signed bundle, §6 guard 3). Those two facts together let a manifest mint an **already-approved** grant with no tier check, no Decision, no hash-chained audit event and no future-expiry validation. The permission mapping was never the defence: `status` other than `requested`, and the four fields `expiresAt`/`decidedByActorId`/`decidedAt`/`decisionReason`, are refused at the `graph/objects-repo.ts` choke point every local write door funnels through (create **and** update), and explicitly in `federation/handfill-repo.ts`, which wears the import flag with no channel to wedge. Raising a `requested` grant stays open through every door — it authorizes nothing. Federation import keeps the §8 exemption: under D9 an approved grant legitimately arrives over the journal, having been decided at the authoring instance where these checks ran.

### 7. Retention (D10) — split by evidentiary role

`scan_findings` would otherwise be the highest-cardinality table in the system. Under ADR-0024 §D1 retention is by **evidentiary class, never a global TTL**, and findings do not all have the same role:

- An **excluded** finding is **accepted-risk evidence** — it explains a live verdict and records what an operator chose to tolerate. **Class E** (evidentiary, floored): retained at least as long as its subject is live, then the long configurable window.
- An **ordinary** finding is **telemetry** — bookkeeping about what a scanner saw. **Class O**: short configurable window.

This bounds the table by what actually needs explaining. ADR-0024 §D0 applies unchanged: retention does not license write amplification, and a per-scan cap is **not** a retention story.

**If the persisted finding set is ever truncated, refuse every exclusion for that scan.** You cannot except what you did not record.

### 7a. Storage and tenancy — one exception, one ordinary table

Two new pieces of storage, with deliberately different tenancy:

- **Instance-tier exclusion admissions** (the `platform` and `trust_domain` rungs of §1's AND) are **instance-scoped with no `org_id`**, sharing the shape and access semantics of ADR-0016 §3's `scan_requirement_floors`: **operator-write / tenant-read**, holding no per-tenant rows and therefore exposing no cross-tenant visibility. This is the **same** documented exception to the DESIGN §4.2 `org_id NOT NULL` invariant, for the same reason — an admission is an operator statement about the deployment, not tenant data. It is a second instance of that exception, not a second kind of exception.
- **`scan_findings`** is **ordinary tenant-scoped data under RLS**, with `org_id NOT NULL` like everything else. It is **not** a tenancy exception. Its only novelty is retention (§7), and even that follows ADR-0024 §D1's existing per-row class assignment rather than extending it.

Org-and-below admissions are ordinary policy data on the existing resolver and need no storage at all (charter principle 2).

**The instance rungs need a WRITER, and this was nearly shipped without one (correction, 2026-08-18).** Storage is not a surface. `buildScanExclusionTargetInputs` seeds every target's `representedTiers` with `platform` and `trust_domain` *unconditionally*, and `tierForObjectType` structurally cannot return either — it maps graph object types, and `containmentChain` is org-rooted. So **no policy at any tier can ever contribute those two admissions**: their only source is the table, and the table is `GRANT SELECT` / `REVOKE INSERT,UPDATE,DELETE` for the request-serving role. Until M22.9 the only writers in the tree were `INSERT` statements inside the integration suite. Every exclusion class §1–§6a defines was therefore **inert on any real deployment** while forty-odd tests were green, because the tests substituted an admin-pool write for the missing surface. The measured lesson generalises past this feature: *when a mandatory precondition can only be created by the test harness, a green suite is evidence about the harness.*

So the instance rungs get the **operator-token twin of `routes/instance-scan-floors.ts`**: `GET /api/v1/instance/scan-exclusion-admissions` (tenant-read, inside the ordinary tenant transaction under the table's RLS — no gate path touches a privileged connection) and `PUT /api/v1/instance/scan-exclusion-admissions/{tier}` (operator token, over a short-lived admin connection; the surface is **closed** when `SCP_OPERATOR_TOKEN` is unset). Then SDK -> CLI (`scp scan-exclusion-admissions list|set`), the same parity chain instance scan floors and scanner assignments already follow; instance-scoped operator configuration has no IaC or UI representation on this deployment, exactly as those two do not.

**The PUT is a whole-set REPLACE for one `(tier, origin)`, and `classes: []` is the withdrawal.** An additive verb would make *withdrawal* the harder operation on a **loosening** dimension — an operator who believes they have narrowed an admission but whose request only ever adds leaves the loosening in force with no error anywhere. That is also why there is no `DELETE` verb: a second verb meaning "replace with nothing" would be a second way to say one thing.

**The org-and-below rungs get nothing new, deliberately.** `org`, `containment_domain`, `service`, `assembly` and `component` admit through the already-shipped `scanExclusion` policy effect (`{"scanExclusion": {"admit": [...]}}`), written over the ordinary policy door, validated by 0074's `property_schema` and gathered per target by the same resolver loop. A second admission surface for those five tiers would be two constructions of one rule.

**An admission is PER-INSTANCE and never federates, while the clause it gates DOES.** `scan_exclusion_admissions` is a plain instance-scoped table with no `org_id` and no graph object behind it, and `JournalEntryKindSchema` admits exactly nine kinds — none of which is a bespoke row (the fact 0051 and drizzle/0075 both turn on). So an admission structurally *cannot* cross a federation boundary: the `origin: 'federated'` value its CHECK constraint and its PUT both accept has **no writer anywhere in the tree**, exactly as ADR-0016 §3's `scan_requirement_floors` has none. The `policy` object carrying a `scanExclusion` clause is the opposite — an ordinary graph object that travels on the `policy_upsert` kind. **One half of an exclusion federates and the other half cannot.** Any instance that *evaluates* the exclusion dimension therefore needs its own `PUT /api/v1/instance/scan-exclusion-admissions/{tier}` with its own `SCP_OPERATOR_TOKEN`; an admitted class never arrives alongside the clause that needs it.

**Today that is exactly one instance — and that is a decision, not a property of the design (recorded 2026-08-18).** Under D5 (2026-07-23; carried in `governance/scan-requirements.ts`'s `readInstanceScanFloors` note and restated in §8) outposts and retrans never evaluate scan policy at all — they validate the commander's signature, not requirements. The asymmetry is therefore **dormant**, not live: no outpost blocks a change for a missing admission, because no outpost resolves this dimension. A review round proposed the live reading — an outpost blocking with a Decision naming no missing admission while the commander's Decision for the same change shows `appliedCount: 1` — and that scenario is **not reachable** under D5. It is written down as unreachable rather than dropped, because the *mechanism* it identified is real and only D5 keeps it inert. The moment a second **evaluating** instance exists — the multi-commander distribution the floors' dormant `origin: 'federated'` rows already reserve — the clause federates to it, the admission does not, and that instance's gate stays closed until an operator repeats the PUT there. Fail-CLOSED by §1's monotone AND, so the cost is surprise, never exposure.

### 8. Federation (D9) — grants federate fully

Exclusion grants and approved overrides federate as ordinary federated objects. Summary-only (the outpost learns *that* an exclusion applied and under whose authority, while grants stay commander-local) was recommended and **declined**.

**The accepted cost, recorded so it is reversible.** A list of accepted risks is a map of known, deliberately-tolerated weaknesses — which CVEs we carry and where. Federating it fully distributes that map into every domain that receives the journal, including lower-trust ones, and the person raising a request cannot opt out. ADR-0031's default is that domain-local objects never federate; `objects.domain_local` remains the mechanism if the owner later wants a per-grant or per-domain restriction, and no design here forecloses it.

**This does not make an outpost evaluate scan policy.** ADR-0020's separation stands: outposts validate the commander's signature, not requirements. Federating a grant makes it *visible*, not *authoritative*.

### 9. What this supersedes in ADR-0020

ADR-0020 asserts as a preserved invariant that the promotion scan step **"adds no way to loosen"** E6. This ADR adds exactly such a way, deliberately and with owner approval. That invariant is **superseded**, not reinterpreted.

Recording it as a supersession rather than quietly extending ADR-0016 is the point: two Accepted documents asserting opposite things about the same boundary is a failure mode this project has hit before, and a reader who finds only ADR-0020's sentence would be entitled to treat an exclusion as a bug.

**ADR-0020 must be amended in the same change** to carry a pointer here. An ADR that supersedes a clause without the superseded clause knowing about it is half a fix.

### 10. The actuator, and why it is a blocking prerequisite (D8)

Without re-evaluation, **every grant is inert on any change whose gate has already run** — a signal with no lever. Evidence carries an `exclusionSetHash`; the reconcile prewarm re-resolves, hashes, and passes `force: true` on mismatch. `ensureControlRuns` does not currently forward `force`, so forwarding it is part of the work.

**That is necessary and not sufficient** (Context 5). While the cache is keyed without gate identity and only `validating` changes are prewarmed, a 7-day grant resolved during validation still authorises a production wave three weeks later. **D8 folds that fix into M22 ahead of the override work**, so an expiry binds on the day it ships rather than after a follow-up nobody schedules.

**Installation proof, not a unit test:** grant an exclusion *after* a change has already failed its gate, assert it subsequently passes; then delete the force-forwarding and require that test to die.

### 11. Charter alignment

- **1 (coordinate, not execute):** nothing new is executed; the managed scan gains no capability.
- **2 (graph-native):** rules and grants are policy effects and graph objects. One new table, a bounded derived-observation projection, justified on drizzle/0061's four measured tests.
- **4 (PostgreSQL only):** no new stateful dependency.
- **5 (air-gap):** no new runtime egress. Trivy already runs offline with `--network none`; D1's latest-version read is a local indexed row.
- **6 (explainability):** the effective threshold and its contributors enter the **Decision** (not just `control_runs.evidence`) *before* any exception can hide inside it, and every applied exclusion names its clause, admitting tier, authority and expiry.

## Alternatives considered

- **A waiver on the verdict (`fail` → `pass`).** Rejected — §2: coarse, hides the tolerated finding, invisible at the E6 boundary.
- **Raising the ceiling instead of excluding findings.** Rejected: expressed as a raised ceiling a loosening breaks the MIN's commutativity and reintroduces exactly the undefined-at-a-tie behaviour ADR-0016 §4 exists to avoid; expressed as "contribute nothing" it does nothing, because absent is never read as 0.
- **Reusing `approval_requests` for override requests.** Rejected: change-keyed (`change_object_id NOT NULL`), two-state (`pending|satisfied` — no deny, no expire, no revoke), engine-materialized with no create API. It cannot express a standing grant. The `freeze.override` act is the shape to copy (mandatory reason, high-severity audit event per use); the approvals path is **not** — a vote writes no audit event today, and that gap must not be inherited.
- **A status column flipped by a sweeper for expiry.** Rejected: there is no sweeper anywhere in this tree and no `boss.schedule` usage to build one on. Expiry is a **read-time SQL window** in the resolver, following `freezes-repo.ts:84-96`.
- **Widening ingestion/polling coverage so the vendor-pass is universally evaluable.** Considered at length and **not taken** — see the context doc §10. The gate is decoupled from automation; the data is not.
- **Deriving "vendor" from the dependency inventory.** Rejected: inventory identity is `(ecosystem, coordinate, major)` with the coordinate stored deliberately **un-normalised**, while Trivy emits a normalised purl; and the inventory holds **direct declared** dependencies only. Vendor-ness is read off the **finding** (`Results[].Class`, `PkgName`); the inventory join is needed only for D1's "on latest" test.

## Consequences

**Positive**
- A loosening that cannot be granted by anyone the tiers above have not admitted, with order-independence preserved and the default a no-op.
- Per-finding explainability: a Decision can finally say *which* finding was tolerated, under whose authority, until when.
- `severityCounts` keeps its meaning, so no existing CEL condition changes behaviour.

**Costs / honesty**
- **The vendor-pass reaches two of three finding classes, not one.** OS packages are attributable to the **base image** line (`dockerfile.ts` parses every real `FROM` into a declared `oci` dependency), so being on the latest of that line earns them a pass exactly as D1 intends. Direct declared dependencies earn it via their own line. **Transitive language dependencies have no line and cannot** — defensibly, since a transitive is fixable by moving the direct parent that pulls it. The `oci` arm compares `latest_digest`, never the tag. `dockerfile.ts` records an `ARG`-interpolated `FROM` as `unresolved`, a bare `FROM alpine` as `unpinned`, and a digest-only `FROM alpine@sha256:…` as `pinned` **with no comparable `version`** — none of the three yields a version on a known major line, so none qualifies.
- **A component owner can author an override they benefit from**, at a weaker permission than the one that authored the constraint (§6). Bounded by tier admission and made visible in the Decision; not prevented.
- **Accepted-risk detail is distributed to every federated domain** (§8).
- `scan_findings` is a new high-cardinality table. Its two-class split is **not** a new retention shape: ADR-0024 §D1 already assigns classes **per row, not per table**, and `decisions` itself already splits across all three (P when cited or pinned, E while current for its subject, O when uncited and superseded). This table follows that precedent rather than extending it.
- **OpenSCAP verdicts can never be excluded from** (Context 4). Explicit and tested, not left to "there were no findings to exclude".
- The E6 export gate accepting *any* passing `control_runs` row — never the latest — is tracked separately, and **an override's expiry is not trustworthy at that boundary until it lands**.
