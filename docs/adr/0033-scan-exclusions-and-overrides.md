# ADR-0033: Scan exclusions — a separately-authorized loosening dimension, admitted top-down

**Status:** Proposed (owner decisions D1–D11 taken 2026-08-17; the mechanism below is proposal pending review)
**Context doc:** [docs/proposals/secops-scan-rules-and-overrides.md](../proposals/secops-scan-rules-and-overrides.md)
**Relates to:** [ADR-0016](0016-scoped-scan-requirement-policies.md) (the tightening MIN this sits beside, unchanged); [ADR-0013](0013-supply-chain-scan-sbom-manifest.md) (scan as a boundary-authorization gate); [ADR-0032](0032-dependency-subscriptions.md) (the dependency inventory D1's rule reads); [ADR-0003](0003-internal-egress-for-execution-systems.md) (declaration-grants-nothing, the pattern §6 copies); [ADR-0024](0024-decision-and-audit-retention.md) (the evidentiary classes §7 assigns); [ADR-0031](0031-domain-local-objects-never-federate.md) (the federation default D9 overrides); charter principles 2, 4, 5, 6.
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
5. **A control outcome is cached without gate identity.** `latestControlRun` is keyed `(orgId, changeObjectId, controlObjectId)` — not `gateKind`, not `gateRef` — and `prewarmGovernanceForChange`'s only caller queries changes in `validating`. So one run made during validation satisfies the accept edge **and every later wave boundary, including production**. No production call site passes `force`, and `ensureControlRuns` does not forward the parameter it accepts.

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

Both are commutative and associative, so **ADR-0016 §4's order-independence survives** — which matters for the documented containment-domain-vs-service tie (`containment.ts:59-73`), where "most specific wins" would be undefined. The two dimensions never touch: exclusions change *what is counted*, the ceiling changes *what the count is compared against*.

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

**Widening the tier enum is an oasdiff response-enum change.** Predict it by diffing `tools/openapi/openapi.v1.json` in python — the binary is linux-only.

### 6. Component-declared facts (D2) — the declaration is bounded, not trusted

The owner chose direct encoding over a SecOps-authored mapping. The escalation seam was raised before the decision and is real: a component's `properties`/`labels` are writable at plain `object:write` **scoped at that component** — the component owner — while SecOps authority is `policy:write`, held only by Administrator/Owner. **The beneficiary of a declaration is also its author, at the weaker permission.**

That is settled. Three guards ride along, none of which contradict it:

1. **Tier admission still applies.** The component authors the override; it does not author its own *admission*. A tier can decline to admit component-declared overrides beneath its ceiling.
2. **The declared value is recorded verbatim** in evidence and in the Decision, so an auditor reads *"passed because component X asserted `egress: none` under admission Y"*, never *"passed"*.
3. **Never key on `labels`.** They are tenant-writable, unvalidated (no schema, no reserved namespace), and are already a live evasion path for selector-scoped policies — tracked separately. Declarations live in a typed `property_schema`, following the **typed-but-open** pattern of drizzle/0043 and 0051: a closed enum would wedge federation, because `import-repo.ts`'s `object_upsert` branch Ajv-validates with no `try/catch` and one rejection aborts a peer's entire signed bundle. Use `z.strictObject` on the **request body** instead.

**Residual hazard, accepted:** the declaration is read live at gate time from a tenant-writable bag and is not pinned to the artifact, so it can be flipped for the duration of a gate and flipped back. Pinning the declared value into evidence makes the flip *visible after the fact*; it does not prevent it.

### 7. Retention (D10) — split by evidentiary role

`scan_findings` would otherwise be the highest-cardinality table in the system. Under ADR-0024 §D1 retention is by **evidentiary class, never a global TTL**, and findings do not all have the same role:

- An **excluded** finding is **accepted-risk evidence** — it explains a live verdict and records what an operator chose to tolerate. **Class E** (evidentiary, floored): retained at least as long as its subject is live, then the long configurable window.
- An **ordinary** finding is **telemetry** — bookkeeping about what a scanner saw. **Class O**: short configurable window.

This bounds the table by what actually needs explaining. ADR-0024 §D0 applies unchanged: retention does not license write amplification, and a per-scan cap is **not** a retention story.

**If the persisted finding set is ever truncated, refuse every exclusion for that scan.** You cannot except what you did not record.

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
- **The vendor-pass reaches two of three finding classes, not one.** OS packages are attributable to the **base image** line (`dockerfile.ts` parses every real `FROM` into a declared `oci` dependency), so being on the latest of that line earns them a pass exactly as D1 intends. Direct declared dependencies earn it via their own line. **Transitive language dependencies have no line and cannot** — defensibly, since a transitive is fixable by moving the direct parent that pulls it. The `oci` arm compares `latest_digest`, never the tag; a digest-pinned or `ARG`-interpolated `FROM` is `unresolved`/`unpinned` and does not qualify.
- **A component owner can author an override they benefit from**, at a weaker permission than the one that authored the constraint (§6). Bounded by tier admission and made visible in the Decision; not prevented.
- **Accepted-risk detail is distributed to every federated domain** (§8).
- `scan_findings` is a new high-cardinality table, and its two-class retention is a new retention shape ADR-0024 does not yet describe.
- **OpenSCAP verdicts can never be excluded from** (Context 4). Explicit and tested, not left to "there were no findings to exclude".
- The E6 export gate accepting *any* passing `control_runs` row — never the latest — is tracked separately, and **an override's expiry is not trustworthy at that boundary until it lands**.
