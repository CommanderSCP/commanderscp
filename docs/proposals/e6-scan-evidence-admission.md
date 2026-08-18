# The E6 export gate: admitting scan evidence by producer, recency, and the operator's floor

**Status:** v0.1 — **implemented in the same PR, pending review.** The behaviour changes in §4 are changes to a security boundary; §7 records what an operator must check before rolling out, and §8 the coordination with M22 / ADR-0033, which are in flight.
**Relates to:** [ADR-0020](../adr/0020-first-class-commander-scanning.md) (the promotion scan step and its two evidence ingresses — §5's "adds no way to loosen" is the invariant §3 shows was already loosenable), [ADR-0016](../adr/0016-scoped-scan-requirement-policies.md) (§3's instance-scoped floors, the only tier this gate re-checks), [ADR-0013](../adr/0013-supply-chain-scan-sbom-manifest.md) (scan as boundary authorization), [ADR-0033](../adr/0033-scan-exclusions-and-overrides.md) (`Proposed` — the *sanctioned* loosening, and the re-evaluation this fix must not break), [ADR-0032](../adr/0032-dependency-subscriptions.md) (`control_runs.plugin_module`, migration 0064, whose auto-merge grant made exactly this move one migration earlier), charter principles 1, 6, 7.

---

## 1. The gate as it stood

`evaluatePromotionScanGate` (`apps/server/src/federation/promotion-repo.ts`) authorised a cross-boundary promotion by scanning the change's `control_runs` rows and accepting **any** row that satisfied three predicates:

```ts
outcome.status === "pass"
  && ScanEvidenceSchema.safeParse(outcome.evidence).success
  && parsed.digestMatch === true
  && parsed.artifactDigest === artifact.digest
```

Everything else about the row — who produced it, when, against what ceiling — was unread. The identical predicate was hand-copied into `promotion-scan-step.ts`'s short-circuit, each copy documented as the other's exact twin.

## 2. Three defects, all verified against the code before anything was changed

The census that raised these flagged one as *possibly overstated*. It was not. Here is each claim and what was actually found.

### 2a. It never took the latest run — **confirmed**

`controlOutcomes.some(...)` with no ordering and no grouping. `listControlRunsForChange` does return `desc(createdAt)`, but `.some` accepts any element, so ordering bought nothing. A historical passing row satisfied the gate forever; a later failing scan of the same artifact by the same control did not supersede it.

This is reachable without an attacker. A wave-boundary `scan-result-control` run that fails after new CVEs are published, or after a tightened ceiling, lands a `fail` row beside the earlier `pass` — and the export still crossed on the pass. ADR-0033's own Consequences already track it: *"The E6 export gate accepting any passing `control_runs` row — never the latest — is tracked separately, and an override's expiry is not trustworthy at that boundary until it lands."*

There is a second, attacker-free instance in the same predicate: the commander's step deposits one row **per method** under one synthetic control id. With `.some`, a `trivy` **pass** satisfied the gate while an `openscap` **fail** for the same digest sat beside it. The lifecycle gate requires every required control to pass; the boundary gate required one.

### 2b. It applied no threshold of its own — **confirmed, with a qualification that changes the fix**

The gate read `status`, `digestMatch` and `artifactDigest` and nothing else. It never resolved ADR-0016's chain and never looked at `evidence.threshold` — the ceiling the verdict was actually judged against.

The qualification: `scan-result-control`'s `resolveThreshold` takes the **per-severity MIN** of the gate-threaded scoped ceiling and the per-binding `config.threshold`, so a binding config cannot loosen a *resolved* ceiling. But `buildControlContext` threads `scanThreshold` **only when some tier set one**; where no tier has, the binding's own `config.threshold` is the only ceiling, and it is tenant-authored. So "the control said pass" can mean "pass against a ceiling its beneficiary wrote", and the boundary accepted that verbatim.

### 2c. It identified a scan outcome purely by SHAPE — **confirmed, and it is a complete bypass, not merely a smell**

The chain is short and every link is in `main`:

1. `governance/control-runner.ts` stores `evidence = outcome.evidence ?? {}` — **verbatim**, whatever the bound ControlPlugin returned. No schema, no producer check.
2. `@scp/plugin-webhook-control` returns `{ status: body.status, evidence: body.evidence }` — **verbatim from an operator-configured URL**. `body.status` is validated only against the `ControlOutcomeStatus` enum; `body.evidence` is passed through untouched.
3. `ScanEvidenceSchema` is a plain `z.object`, so a payload carrying the required fields parses (and strips the rest).

So a `webhook-control` binding pointed at an endpoint answering

```json
{"status":"pass","evidence":{"scanner":"trivy","scannerVersion":"0.50.0",
  "artifactDigest":"<promoted digest>","expectedDigest":"<promoted digest>",
  "digestMatch":true,"severityCounts":{"critical":0,"high":0,"medium":0,"low":0},
  "threshold":{"maxCritical":0,"maxHigh":0}}}
```

produced a `control_runs` row that satisfied E6 in full — and, through the copied predicate, also **suppressed the managed scan** that would have produced a real verdict.

**The authority required is strictly weaker than the authority the gate protects.** A control binding is authored at `policy:write` *scoped at the control object* (`routes/governance.ts` — `authorize(..., scopeObjectId: control.id)`), and `authz/resolve.ts`'s scope expansion is upward, so a subtree-scoped `policy:write` holder qualifies. The instance-scoped floors that E6 exists to defend are, by ADR-0016 §3's explicit design, **operator-write / tenant-read** — unwritable by any tenant at any scope. A tenant could therefore not lower the floor, but could bypass the boundary that enforces it.

**Not the sanctioned loosening.** ADR-0033 §9 deliberately supersedes ADR-0020's "adds no way to loosen" for per-finding **exclusions**, admitted top-down. That mechanism is authorized, applies *before counting*, and is visible in the Decision. §2c is none of those things: it is a **verdict-level waiver by an unauthorized author** — the exact shape ADR-0033 §2 rejected, for the exact reason it gave (*"because the E6 export gate identifies a scan outcome purely by shape … a verdict-level waiver would be invisible at the federation boundary"*). ADR-0033 named the property; this fixes it.

## 3. Census — every site that reads `control_runs` to authorize something

Filterless: every reference to `control_runs` / `controlRuns` / `ControlRun` in the tree, then each read classified.

| Site | Reads for | Has the property? |
|---|---|---|
| `federation/promotion-repo.ts:evaluatePromotionScanGate` | **authorization** — a cross-boundary crossing | **yes, all three** — fixed here |
| `federation/promotion-scan-step.ts:isCoveringScanOutcome` | **authorization-adjacent** — whether a scan runs at all | **yes** (a copy of the same predicate) — fixed here, by calling the same code |
| `dependencies/bump-actuator.ts:resolveEffectiveDelivery` | **authorization** — an unattended merge into someone's default branch | **no.** It already narrows by `plugin_module`, by repository, and by the bump's own head commit, and defeats on *any* objecting run. It is the precedent this fix follows, not an instance of the defect |
| `governance/control-runner.ts:latestControlRun` / `readExistingControlOutcomes` | the lifecycle + wave gates | **takes the latest** already. Its separate defect — the cache key lacking gate identity, and `force` not being forwarded — is **owned by the concurrent M22 session** (ADR-0033 §10 / Context 5) and is deliberately untouched here |
| `routes/governance.ts`, `routes/changes.ts`, `coordination/component-pipeline.ts`, `apps/web/*` | display | not authorization |
| `promotion-repo.ts:applyPromotionImport` → `properties.importedControlOutcomes` | nothing | written on import and **read by nothing** — verified by grep. Evidence, not authority, exactly as the module doc says |

Two instances, both in the export path, both fixed. No third.

## 4. The fix

One module — `apps/server/src/federation/scan-evidence.ts` — holding the whole rule, called by both sites. Four narrowings, in order.

### 4a. Admission is by PRODUCER

A run is a scan outcome iff it came from one of ADR-0020 §1's two ingresses:

* the commander's own promotion scan step — `control_object_id = MANAGED_SCAN_CONTROL_OBJECT_ID` **and** `plugin_module IS NULL` (the step deposits under a synthetic id with no binding, so a NULL module is what an authentic deposit looks like, and a row under that id that *does* name a module did not come from the step); or
* `plugin_module = 'scan-result-control'` — the org-pipeline alternate ingress.

`webhook-control` (an unvalidated remote payload), `github-check` (a CI verdict, no digest binding), and any `NULL` module under a real control id (a pre-0064 row, or `ensureControlRun`'s missing-binding `fail`) are **not** scan outcomes.

**No stricter shape test could have worked**, because the shape *is* the payload. `control_runs.plugin_module` (migration 0064) is the only place the *kind* of question is recorded, and it is stamped at insert from the binding that actually ran — never read from the current binding, which is mutable. That column exists because `bump-actuator.ts` needed exactly this distinction for exactly this reason; this is its second consumer.

### 4b. The latest answer to each question wins

Candidate runs are those an admitted producer wrote **about this digest**, attributed by `evidence.expectedDigest` — read off the **raw** bag rather than a successful parse, because a real failure is frequently unparseable (`scan-result-control`'s `fail()` emits partial bags) and a failure that cannot be attributed cannot supersede the stale pass it should be superseding.

Candidates are grouped by the *question* they answer, and only the newest run of each group is consulted; **every** one must pass.

* For a **bound control** the question is the control. One binding fetches one verdict, so its newest run is its current answer — the same identity `latestControlRun` uses everywhere else.
* For the **commander's step** the question is *(step, method)*, because the synthetic control id multiplexes methods. Keying on the control alone would make the gate order-dependent in the worst direction: a `trivy` pass and an `openscap` fail are written milliseconds apart under the same id, and whichever landed second would decide the crossing.

Ties on `created_at` break on `id`, which is a uuidv7 and therefore monotone within a millisecond — so "latest" is total rather than dependent on the order Postgres returned equal-timestamped rows in.

**Both directions, deliberately.** A newer fail defeats an older pass *and* a newer pass clears an older fail. Objecting-only supersession was considered and rejected: it is simpler and strictly safer in isolation, but it would make every ADR-0033 grant and every fixed artifact permanently unable to unblock an export, which is precisely the actuator problem ADR-0033 §10 exists to solve.

### 4c. Digest binding, unchanged

`digestMatch === true` and `artifactDigest === <the promoted digest>` on the satisfying run. Byte-for-byte the M17.1 check that was already there.

### 4d. The operator's floor binds at the boundary

The satisfying evidence's `severityCounts` are re-checked against the merged **instance-scoped floors** (`scan_requirement_floors`, ADR-0016 §3) — a per-severity MIN over the `platform` and `trust_domain` rungs, and nothing else. Absent never means zero: a severity no floor constrains is unconstrained.

**Why not the six-tier resolution.** The four org-and-below tiers are tenant-authored policy data. Re-resolving them here would add no authority a tenant does not already hold, while paying exactly the cost ADR-0016 §4 rejected design (B) for — a second evaluation of the same criterion, producing a second and possibly divergent verdict for one artifact. The two above-org tiers are different in kind: they are the operator's statement about the deployment, tenant-unwritable by construction, and E6 is the operator's boundary. Checking those and stopping is the whole of the defence-in-depth this gate's own doc comment already claimed to be.

**Counts, not the claimed threshold.** Comparing `evidence.threshold` against the floor would be checking the producer's *claim* about how it judged; comparing `severityCounts` checks what it *found*. The second needs no trust in the producer's arithmetic.

**With no floor authored — the default — this constrains nothing.** That property is asserted directly by a test that exports the identical breaching evidence with the floor removed.

### 4e. What did not change

* **`ScanEvidenceSchema`** — untouched. No codegen, no OpenAPI diff, no oasdiff exposure.
* **The bundle's `controlOutcomes` projection** — untouched, and this is load-bearing. That projection is *inside* `promotionChecksumPayload`, so widening it to carry `plugin_module` / `created_at` would change every bundle's Ed25519 checksum and break verification at every peer. The gate reads the raw `control_runs` rows instead.
* **Charter principle 1** — nothing new is executed. The gate still only re-verifies an outcome an execution system already produced.

### 4f. Explainability (principle 6)

The refusal Decision's `inputContext` gains a machine-readable `refusalCode` — `no_scan_outcome` | `not_passing` | `malformed_evidence` | `not_digest_bound` | `below_instance_floor` — plus the per-code detail (which control, which run, which severities breached by how much, the floor in force) and, for `no_scan_outcome`, the set of `plugin_module`s that *were* present. An operator can now tell "nothing scanned this" from "something did and failed" from "something did and was not a scanner" without reading prose.

## 5. Verification

* `apps/server/src/federation/scan-evidence.test.ts` — 22 cases over the rule's algebra: the byte-perfect `webhook-control` forgery, the commander-identity claim, both directions of supersession, the same-millisecond tie-break, the order-independence of the multiplexed methods, the floor's MIN and its absent-never-zero edge.
* `federation.integration.test.ts` — `E6 PRODUCER IDENTITY` and `E6 RECENCY` prove the same two properties end to end against a real database and a real export. The producer case differs from its passing twin in **one field**, so it tests the admission rule and nothing incidental.
* **Installation proved by deletion**, four times: reverting admission to shape kills `E6 PRODUCER IDENTITY`; reverting to "any historical pass" kills `E6 RECENCY` and four unit cases; removing the floor comparison kills the instance-floor case; and stubbing the *short-circuit's* call to the shared rule kills `promotion-scan-step.integration.test.ts` case (c) — which is what proves the shared core is installed at **both** call sites rather than only the one the gate tests exercise.

### 5a. Three tests this change corrected, and why they had not caught anything

* **Five fixtures** seeded `control_runs` rows with **no `plugin_module`** — a shape no real producer writes. They stood in for org-pipeline evidence while proving the gate accepted something nothing produces.
* **Two `LABEL INERTNESS` cases** asserted the gate's exact **prose**. What they are about is that the refusals *agree with each other*; pinning the sentence made them tests of wording that went red on a change which never touched label handling. The baseline is now produced by exporting the unlabeled case.
* **The instance-floor case** asserted *"E6 never reads `scan_requirement_floors` — a completely different mechanism"* and **stayed green through the change that made that sentence false**, because every fixture it exercised reported zero findings and zero breaches no ceiling. It keeps the label-inertness half it genuinely established, and gains the case that distinguishes the two — plus the floor-removed control.

## 6. Rejected alternatives

* **A stricter evidence shape (a required `producedBy` field, a signature over the evidence).** Rejected: the evidence is the payload. Any field a legitimate producer writes, a forging producer writes too. Provenance has to come from the row, not from the bag.
* **An allowlist of control *object ids* rather than plugin modules.** Rejected: it would need operator configuration per control, and a re-pointed binding would silently change what an allowlisted id means — the retroactive re-narration migration 0064 exists to prevent.
* **A change-wide "any failing scan defeats the export" rule** (bump-actuator's asymmetry, transplanted). Attractive, and it handles unattributable failures for free. Rejected: an unattributable objecting row has no supersession key, so nothing could ever clear it — a stale `scan-result-control` binding would wedge every export of that change with no operator recourse (there is no `DELETE` on `control_runs`). Per-question latest-wins gets the same protection with a self-clearing escape.
* **Resolving the full ADR-0016 six-tier ceiling at E6.** Rejected — §4d.
* **Comparing the evidence's recorded `threshold` to the floor instead of its counts.** Rejected — §4d: it trusts the producer's arithmetic to check the producer.

## 7. Compatibility — what an operator must know before rolling out

**This tightens a security boundary. Some exports that succeeded will now refuse, and every one of them should.**

| Estate shape | Before | After |
|---|---|---|
| Managed scanning enabled; the commander's step produces the evidence | exports | **unchanged** — the step's rows are admitted by control id |
| Org-pipeline evidence produced **after** migration 0064 | exports | **unchanged** — `plugin_module` is stamped |
| Org-pipeline evidence produced **before** 0064 (`plugin_module IS NULL`) | exports | **refuses** until re-scanned. See below |
| Evidence from `webhook-control` / `github-check` | exported | **refuses** — the bypass |
| A passing row superseded by a later failing one | exported | **refuses** |
| A `trivy` pass beside an `openscap` fail for the same digest | exported | **refuses** |
| An instance floor authored, and findings that breach it | exported | **refuses** |
| **No instance floor authored** (the default) | — | **byte-identical**: §4d constrains nothing |

**The pre-0064 case is the one to plan for, and it mostly self-heals.** Migration 0064 is `main`'s newest, so essentially all evidence on any deployed instance predates it. Those rows are now unattributable and are refused — which also means the short-circuit stops honouring them, so **the commander's promotion scan step re-scans and deposits fresh, admitted evidence**, and the export proceeds. Self-healing therefore holds wherever managed scanning is enabled. Where it is not (`scanRunner: null`, or the managed path not configured), the export refuses until the org pipeline re-reports — fail-closed, and the correct direction: the alternative is crossing a security-domain boundary on evidence nobody can attribute.

The refusal is explicit about which narrowing fired (§4f), so this shows up as `no_scan_outcome` with `producersSeen: ["<no binding>"]` rather than as a mystery.

## 8. Coordination with work in flight

**M22 / `control-runner.ts` + `controls-repo.ts` are owned by another session and are untouched here.** That session is fixing the related cache defect — `latestControlRun` keyed without gate identity, and `force` not forwarded through `ensureControlRuns` (ADR-0033 §10, Context 5). The two fixes are complementary and do not overlap: theirs governs whether a control **re-runs**; this one governs which of the resulting rows **authorizes a crossing**. Neither needs the other to land first, and this change required no edit inside either file — the one type it needs (`ControlRunRow`) is satisfied structurally by a local interface.

**ADR-0033 (`Proposed`) has one named obligation on this code.** When per-finding exclusions land, §4d's comparison must read the **post-exclusion** `effectiveSeverityCounts`, not `severityCounts` — which ADR-0033 §2 deliberately keeps meaning "what the scanner found". Reading the raw count then would make every admitted exclusion invisible at this boundary and refuse crossings the grant authorized: the mirror image of the invisibility §2 rejected a verdict-level waiver for. It is **one line**, and it is marked in `scan-evidence.ts` at the exact statement. It is deliberately *not* implemented speculatively — the field does not exist yet, and `ScanEvidenceSchema` would strip it.

**ADR-0033's re-evaluation actuator depends on §4b's clearing direction.** A grant authored after a gate has already failed produces a *new* passing run; under this rule that run supersedes the failure and the export proceeds. Had supersession been objecting-only, every grant would have been inert at this boundary — which is the "signal with no lever" failure ADR-0033 §10 folds the actuator work in to avoid.

## 9. Charter alignment

* **1 (coordinate, not execute):** nothing new is executed; the gate still only re-verifies an outcome an execution system produced.
* **2 (graph-native):** no new table, no new object type, no new column. The rule reads columns that already exist.
* **4 (PostgreSQL only):** no new dependency.
* **6 (explainability):** the refusal names its narrowing, its evidence and its floor, machine-readably.
* **7 (simplicity first):** one module, two call sites that previously held two copies of the same rule; the six-tier resolution is deliberately *not* duplicated here.
