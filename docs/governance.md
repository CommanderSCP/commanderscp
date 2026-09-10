# governance

Long-form reference for the **governance** subsystem — the rationale, hazards and open items that
used to sit inline. Each source file below carries a one-line headline at the site and points here.

> Partial: 432 of 432 multi-line comment blocks in this subsystem are here. The rest are
> still inline, pending a hand-written one-line headline.

## Files

- [`apps/server/src/governance/approvals-repo.ts`](#apps-server-src-governance-approvals-repo-ts) — §1–§5
- [`apps/server/src/governance/approves-edge-provenance.integration.test.ts`](#apps-server-src-governance-approves-edge-provenance-integration-test-ts) — §6–§6
- [`apps/server/src/governance/assembly-scope-and-decision-rule.integration.test.ts`](#apps-server-src-governance-assembly-scope-and-decision-rule-integration-test-ts) — §7–§16
- [`apps/server/src/governance/attestation.ts`](#apps-server-src-governance-attestation-ts) — §17–§18
- [`apps/server/src/governance/campaign-deadline-widening-guard.ts`](#apps-server-src-governance-campaign-deadline-widening-guard-ts) — §19–§22
- [`apps/server/src/governance/campaign-recipe-guard.ts`](#apps-server-src-governance-campaign-recipe-guard-ts) — §23–§24
- [`apps/server/src/governance/cel-sandbox.test.ts`](#apps-server-src-governance-cel-sandbox-test-ts) — §25–§29
- [`apps/server/src/governance/cel-sandbox.ts`](#apps-server-src-governance-cel-sandbox-ts) — §30–§37
- [`apps/server/src/governance/cel-worker-entry.ts`](#apps-server-src-governance-cel-worker-entry-ts) — §38–§39
- [`apps/server/src/governance/component-declaration-guard.ts`](#apps-server-src-governance-component-declaration-guard-ts) — §40–§40
- [`apps/server/src/governance/containment-dependents-drift.integration.test.ts`](#apps-server-src-governance-containment-dependents-drift-integration-test-ts) — §41–§41
- [`apps/server/src/governance/control-runner.ts`](#apps-server-src-governance-control-runner-ts) — §42–§51
- [`apps/server/src/governance/controls-repo.ts`](#apps-server-src-governance-controls-repo-ts) — §52–§56
- [`apps/server/src/governance/cosign-keys.integration.test.ts`](#apps-server-src-governance-cosign-keys-integration-test-ts) — §57–§57
- [`apps/server/src/governance/cosign-keys.ts`](#apps-server-src-governance-cosign-keys-ts) — §58–§60
- [`apps/server/src/governance/evaluate.ts`](#apps-server-src-governance-evaluate-ts) — §61–§65
- [`apps/server/src/governance/freeze-object.ts`](#apps-server-src-governance-freeze-object-ts) — §66–§74
- [`apps/server/src/governance/freeze-scope.test.ts`](#apps-server-src-governance-freeze-scope-test-ts) — §75–§77
- [`apps/server/src/governance/freeze-scope.ts`](#apps-server-src-governance-freeze-scope-ts) — §78–§85
- [`apps/server/src/governance/freezes-repo.ts`](#apps-server-src-governance-freezes-repo-ts) — §86–§99
- [`apps/server/src/governance/gate-orchestrator.ts`](#apps-server-src-governance-gate-orchestrator-ts) — §100–§139
- [`apps/server/src/governance/governance-label-write-doors.integration.test.ts`](#apps-server-src-governance-governance-label-write-doors-integration-test-ts) — §140–§144
- [`apps/server/src/governance/governance-labels.test.ts`](#apps-server-src-governance-governance-labels-test-ts) — §145–§145
- [`apps/server/src/governance/governance-labels.ts`](#apps-server-src-governance-governance-labels-ts) — §146–§151
- [`apps/server/src/governance/governance-managed-types.ts`](#apps-server-src-governance-governance-managed-types-ts) — §152–§155
- [`apps/server/src/governance/governance-managed-write-doors.integration.test.ts`](#apps-server-src-governance-governance-managed-write-doors-integration-test-ts) — §156–§190
- [`apps/server/src/governance/governance-reach.integration.test.ts`](#apps-server-src-governance-governance-reach-integration-test-ts) — §191–§194
- [`apps/server/src/governance/governance-reach.ts`](#apps-server-src-governance-governance-reach-ts) — §195–§199
- [`apps/server/src/governance/governance.integration.test.ts`](#apps-server-src-governance-governance-integration-test-ts) — §200–§232
- [`apps/server/src/governance/group-scope-ownership.integration.test.ts`](#apps-server-src-governance-group-scope-ownership-integration-test-ts) — §233–§234
- [`apps/server/src/governance/instance-freeze-admission.integration.test.ts`](#apps-server-src-governance-instance-freeze-admission-integration-test-ts) — §235–§242
- [`apps/server/src/governance/instance-freezes-repo.test.ts`](#apps-server-src-governance-instance-freezes-repo-test-ts) — §243–§243
- [`apps/server/src/governance/instance-freezes-repo.ts`](#apps-server-src-governance-instance-freezes-repo-ts) — §244–§247
- [`apps/server/src/governance/move-enforcement.integration.test.ts`](#apps-server-src-governance-move-enforcement-integration-test-ts) — §248–§252
- [`apps/server/src/governance/move-enforcement.ts`](#apps-server-src-governance-move-enforcement-ts) — §253–§258
- [`apps/server/src/governance/move-rung-write.ts`](#apps-server-src-governance-move-rung-write-ts) — §259–§262
- [`apps/server/src/governance/placement-governance.integration.test.ts`](#apps-server-src-governance-placement-governance-integration-test-ts) — §263–§266
- [`apps/server/src/governance/policy-model.ts`](#apps-server-src-governance-policy-model-ts) — §267–§272
- [`apps/server/src/governance/policy-resolve.ts`](#apps-server-src-governance-policy-resolve-ts) — §273–§279
- [`apps/server/src/governance/policy-scope-authz.ts`](#apps-server-src-governance-policy-scope-authz-ts) — §280–§280
- [`apps/server/src/governance/policy-write-gate-ordering.integration.test.ts`](#apps-server-src-governance-policy-write-gate-ordering-integration-test-ts) — §281–§281
- [`apps/server/src/governance/scan-db.test.ts`](#apps-server-src-governance-scan-db-test-ts) — §282–§282
- [`apps/server/src/governance/scan-db.ts`](#apps-server-src-governance-scan-db-ts) — §283–§286
- [`apps/server/src/governance/scan-declared-facts.test.ts`](#apps-server-src-governance-scan-declared-facts-test-ts) — §287–§288
- [`apps/server/src/governance/scan-declared-facts.ts`](#apps-server-src-governance-scan-declared-facts-ts) — §289–§292
- [`apps/server/src/governance/scan-declared-override-exclusions.integration.test.ts`](#apps-server-src-governance-scan-declared-override-exclusions-integration-test-ts) — §293–§304
- [`apps/server/src/governance/scan-exclusion-actuator.integration.test.ts`](#apps-server-src-governance-scan-exclusion-actuator-integration-test-ts) — §305–§314
- [`apps/server/src/governance/scan-exclusion-actuator.test.ts`](#apps-server-src-governance-scan-exclusion-actuator-test-ts) — §315–§315
- [`apps/server/src/governance/scan-exclusion-actuator.ts`](#apps-server-src-governance-scan-exclusion-actuator-ts) — §316–§319
- [`apps/server/src/governance/scan-exclusions.integration.test.ts`](#apps-server-src-governance-scan-exclusions-integration-test-ts) — §320–§327
- [`apps/server/src/governance/scan-findings-read.integration.test.ts`](#apps-server-src-governance-scan-findings-read-integration-test-ts) — §328–§334
- [`apps/server/src/governance/scan-findings-repo.ts`](#apps-server-src-governance-scan-findings-repo-ts) — §335–§338
- [`apps/server/src/governance/scan-findings.integration.test.ts`](#apps-server-src-governance-scan-findings-integration-test-ts) — §339–§342
- [`apps/server/src/governance/scan-override-authority.test.ts`](#apps-server-src-governance-scan-override-authority-test-ts) — §343–§346
- [`apps/server/src/governance/scan-override-grant-authoring-guard.ts`](#apps-server-src-governance-scan-override-grant-authoring-guard-ts) — §347–§347
- [`apps/server/src/governance/scan-override-grants.ts`](#apps-server-src-governance-scan-override-grants-ts) — §348–§354
- [`apps/server/src/governance/scan-override-standing.ts`](#apps-server-src-governance-scan-override-standing-ts) — §355–§357
- [`apps/server/src/governance/scan-requirements-read.integration.test.ts`](#apps-server-src-governance-scan-requirements-read-integration-test-ts) — §358–§359
- [`apps/server/src/governance/scan-requirements-read.ts`](#apps-server-src-governance-scan-requirements-read-ts) — §360–§363
- [`apps/server/src/governance/scan-requirements.test.ts`](#apps-server-src-governance-scan-requirements-test-ts) — §364–§364
- [`apps/server/src/governance/scan-requirements.ts`](#apps-server-src-governance-scan-requirements-ts) — §365–§389
- [`apps/server/src/governance/scan-rule-authoring-guard.integration.test.ts`](#apps-server-src-governance-scan-rule-authoring-guard-integration-test-ts) — §390–§390
- [`apps/server/src/governance/scan-rule-authoring-guard.ts`](#apps-server-src-governance-scan-rule-authoring-guard-ts) — §391–§394
- [`apps/server/src/governance/scan-vendor-exclusions.integration.test.ts`](#apps-server-src-governance-scan-vendor-exclusions-integration-test-ts) — §395–§401
- [`apps/server/src/governance/scan-vendor-latest.test.ts`](#apps-server-src-governance-scan-vendor-latest-test-ts) — §402–§402
- [`apps/server/src/governance/scan-vendor-latest.ts`](#apps-server-src-governance-scan-vendor-latest-ts) — §403–§411
- [`apps/server/src/governance/scanner-assignments.integration.test.ts`](#apps-server-src-governance-scanner-assignments-integration-test-ts) — §412–§412
- [`apps/server/src/governance/scanner-registry.test.ts`](#apps-server-src-governance-scanner-registry-test-ts) — §413–§413
- [`apps/server/src/governance/scanner-registry.ts`](#apps-server-src-governance-scanner-registry-ts) — §414–§415
- [`apps/server/src/governance/scoped-scan-requirements.integration.test.ts`](#apps-server-src-governance-scoped-scan-requirements-integration-test-ts) — §416–§427
- [`apps/server/src/governance/service-policy-scope.integration.test.ts`](#apps-server-src-governance-service-policy-scope-integration-test-ts) — §428–§429
- [`apps/server/src/governance/test-support/conditional-hang-cel-worker-entry.ts`](#apps-server-src-governance-test-support-conditional-hang-cel-worker-entry-ts) — §430–§430
- [`apps/server/src/governance/test-support/hanging-cel-worker-entry.ts`](#apps-server-src-governance-test-support-hanging-cel-worker-entry-ts) — §431–§431
- [`apps/server/src/governance/test-support/scan-rule-control.ts`](#apps-server-src-governance-test-support-scan-rule-control-ts) — §432–§432

## `apps/server/src/governance/approvals-repo.ts`

### §1. N-of-M approval quorum

N-of-M approval quorum (DESIGN §10.2). SECURITY-SENSITIVE surfaces (M4 PR body flag: "approval quorum integrity + N-of-M can't be forged"):

- **No double-voting**: `approval_votes`' unique `(org_id, approval_request_id, voter_object_id)` index (db/schema.ts) is the actual enforcement — `castApprovalVote` below just turns the resulting constraint violation into a clean 409 rather than a raw DB error. An application-layer "have they already voted" check would race a concurrent duplicate request; the DB constraint cannot. - **No non-member votes**: `castApprovalVote` calls `authz/resolve.ts`'s `hasRoleAtScope` BEFORE inserting anything — a subject who does not hold `fromRole` at-or-above the request's scope is rejected with 403, never silently accepted-but-uncounted. - **Attestation**: every accepted vote is Ed25519-signed at creation (`attestation.ts`) over a canonical record binding voter + approved object + decision id + timestamp — tamper-evident, independently verifiable, no external PKI (DESIGN §10.2).

### §2. Idempotent create-if-not-exists for an approval instance

Idempotent create-if-not-exists (DESIGN §10.2 "approval control instances materialize as approval tasks") — the unique `(org, change, policy, policyVersion, effectIndex)` key means calling this repeatedly for the same firing policy/effect is always safe and always returns the SAME row, even under concurrent callers (route handler + reconcile's background materialization both call this for the same requirement).

### §3. Casts one vote: (1) eligibility check

Casts one vote: (1) eligibility check (`hasRoleAtScope` — 403 if the voter doesn't hold the request's `fromRole` at-or-above its scope), (2) sign an attestation, (3) insert the vote row, relying on the DB's unique constraint to reject a genuine double-vote race as a 409 rather than silently overwriting — and (4) idempotently record the graph-visible `approves` relationship (DESIGN §10.2 "approvals are recorded as `approves` relationships") from voter -> the CHANGE object this approval request ultimately gates (upserted, since one voter may cast votes toward several approval requests on the SAME change — `approves` is a coarser, per-change signal; the `approval_votes` row is the fine-grained source of truth quorum counting actually uses).

### §4. Approvals as evidence ride the journal, so exports carry

M6 (DESIGN §13): approvals-as-evidence ride the journal so a Promotion Bundle exported later can carry this attestation, and so a peer syncing with a `full`/`changes_only` scope can see it happened, WITHOUT it ever becoming authority anywhere but here (§13 "approvals transfer as evidence, never as authority" — this entry is read-only history, never replayed as a vote). M20.3 (ADR-0031 §5) — ...but NOT for a domain-local change. This payload carries `changeUrn`, i.e. `urn:scp:<org>:change:<name>` — the change's NAME in plain text — plus its object id and the voter's identity, so an approval on a domain-local release would disclose both that the release exists and who signed off on it. The vote, the attestation and the local audit trail are all written unchanged: this withholds the evidence from PEERS, never from this domain, and the "approvals transfer as evidence, never as authority" property above is untouched — a domain-local change has no peer to carry evidence to.

### §5. This domain's minted id, the same every other site uses

ADR-0021 D4, follow-on (i) — THIS DOMAIN'S MINTED DOMAIN ID, the same value every other writer of `origin_domain_id` stamps (graph/relationships-repo.ts, graph/objects-repo.ts).

It used to write the ORG id, which is a different uuid entirely: `federation_self.domain_id` is minted per org and is not derived from `org_id`. So the edge claimed an origin domain present in no `federation_self` row, and every reader that compares provenance against `self.domainId` silently declined to act on it — the federated-delete single-writer check, and (measured beyond the original report) `graph/objects-repo.ts`'s `deleteObject` cascade, which tombstones touching edges under `eq(relationships.originDomainId, self.domainId)`. The `approves` edge missed that filter, so deleting the voter or the change left it live and dangling, permanently and locally. drizzle/0110 repairs the rows already written.

## `apps/server/src/governance/approves-edge-provenance.integration.test.ts`

### §6. THE `approves` EDGE'S FEDERATION PROVENANCE

THE `approves` EDGE'S FEDERATION PROVENANCE — the org id is not a domain id

`castApprovalVote` stamped `relationships.origin_domain_id` with the ORG id, where every other writer of that column stamps `federation_self.domain_id` — a uuid MINTED per org, unrelated to `org_id`. The edge therefore claimed an origin domain present in no `federation_self` row.

The damage is LOCAL as well as federated, which is why this file asserts the cascade and not only the column: `graph/objects-repo.ts`'s `deleteObject` tombstones touching edges under `origin_domain_id = self.domain_id`, so the `approves` edge missed the filter and survived the deletion of its own endpoint — live, dangling, forever.

Two halves, because the defect has two populations: rows written from now on (the code fix) and rows already on disk (drizzle/0110). The second is exercised by re-running the migration's own SQL against a row put back into the broken state — the file on disk is the fixture, so a future edit to that SQL is measured rather than assumed.

## `apps/server/src/governance/assembly-scope-and-decision-rule.integration.test.ts`

### §7. The two hardcoded rung lists the migration missed

M22.0 — THE TWO HARDCODED RUNG LISTS MIGRATION 0055 MISSED, AND THE DECISION THAT DID NOT EXPLAIN ITS OWN RULE (ADR-0033 §5/§11; charter principle 6).

Migration 0055 added the optional `service -> assembly -> component` rung. `containmentChain` walks it for free because it matches on the `contains` EDGE and never on the parent's TYPE — which is why 0055 shipped no resolver edit at all. But WALKING a rung is edge-generic and NAMING one is not, and two hardcoded lists were left behind:

```text
* `gate-orchestrator.ts`'s `APPROVAL_SCOPE_KEYWORDS` had no `assembly` entry, so
  `requireApprovals: {scope: "assembly"}` resolved to `null` and became a PERMANENTLY
  unsatisfiable required approval — fail-closed, but silently inexpressible, and no approval
  REQUEST was ever materialized, so no human could vote it through either. Pinned by A1/A2 here.
* `scan-requirements.ts`'s `tierForObjectType` fell `assembly` through to `component`. Pinned by
  `scoped-scan-requirements.integration.test.ts` (a2), at the real scan gate, where the ceiling
  it reports can be read back out of the persisted control-run evidence.
```

And the resolved scan ceiling went only into `control_runs.evidence`, never into the Decision an operator resolves by `decision_id`. D1/D2 pin that it is now in the Decision, and that putting it there did NOT re-open the measured 1.44 GB/day write amplification (ADR-0024 §D0) on the busiest path in the system.

WHY THIS FILE DRIVES `reconcileOrgTick` DIRECTLY
The scan ceiling reaches a Decision only from the WAVE-BOUNDARY gate: `evaluateGovernanceGate` resolves it inside its `host` condition, and the lifecycle-edge gate runs with `host: null` on the API tier. So every test here parks a change at a pending wave and ticks the reconciler by hand — "N ticks" is then exactly N (the same discipline, and the same reason, as `coordination/decision-write-amplification.integration.test.ts`), which is what makes D2's row counts mean anything at all.

ONE ORG PER TEST, deliberately: `matchPoliciesForTargets` scans every policy in the org, so an org-scoped scan floor authored by one test would silently join another test's contributor list and make D1's exhaustive tier assertion pass or fail for reasons that have nothing to do with it.

MUTATION LOG — each applied ALONE, run, watched fail, then reverted. Measured 2026-08-17.

| Mutation | Result |
| drop `assembly: "assembly"` from `APPROVAL_SCOPE_KEYWORDS` | **A1 FAILS** at the request count (`expected [] to have a length of 1`) — the pre-M22.0 defect exactly: no request row, so no vote was ever possible. A2/D1/D2 stay green | | make the keyword lookup TOTAL (`… ?? "organization"`) | **A2 FAILS** (`expected [ {…} ] to have a length of 0`) while A1 stays green — the negative control does its job: naming one more rung must not make every string a keyword | | delete the `scanThresholdForDecision(...)` spread from `inputContext` | **D1 FAILS** (`expected undefined to be defined`); D2's precondition fails with it. A1/A2 stay green | | remove the `.sort(...)` from `scanThresholdForDecision` | **D2 (b) FAILS** — persisted order came out `org, containment_domain, service, assembly, component`, i.e. verbatim authoring order. **D2 (a) did NOT fail**, exactly as this test's header predicts: the order was stably unsorted, so the rows still collapsed to one. That is why (b) exists | | `insertDecisionIfChanged` -> `insertDecision` at reconcile.ts's wave gate | **D2 (a) FAILS** — 9 new rows over 9 ticks, one per tick: the 1.44 GB/day flood, reproduced |

### §8. The guard refuses a scan-threshold rule of that shape

M22.8 — `governance/scan-rule-authoring-guard.ts` refuses a `scanThreshold` rule that requires no control. This suite creates no control and runs no plugin host, so it names a control REFERENCE rather than a bound control — the same non-uuid form the rest of this file already uses. The guard reads that as "cannot be PROVEN inert" and passes, which is its documented sign: an absent or unresolvable binding is never evidence that a document does nothing.

### §9. Walks a change to executing with wave zero still pending

Walks a change to `executing` with wave 0 still `pending`, by hand. Every edge used here is one `gates.ts` documents as always-allow (`proposed -> evaluated -> coordinated -> executing`), so the FIRST `tick()` below is the first thing that has ever evaluated this wave's gate — which is what lets D2 count rows against ticks.

### §10. A1 — `requireApprovals: {scope: "assembly"}` is SATISFIABLE

A1 — `requireApprovals: {scope: "assembly"}` is SATISFIABLE.

Before M22.0 `resolveApprovalScope` returned `null` for it, so the gate marked the approval unsatisfied and `continue`d — no request row, nothing in anyone's queue, and no possible vote. The change was parked forever behind an effect its author had legitimately expressed.

MUTATION: delete the `assembly: "assembly"` entry from `APPROVAL_SCOPE_KEYWORDS`.

### §11. A2 — THE NEGATIVE CONTROL

A2 — THE NEGATIVE CONTROL. Naming one more keyword must not make every string a keyword.

This is the arm that keeps A1 from being satisfied by a "fix" that resolves anything to something. An unknown keyword is not an object id or urn either, so it must still resolve to `null`, still block, and still materialize NOTHING.

MUTATION: make `APPROVAL_SCOPE_KEYWORDS` a total function (e.g. default the lookup to `"organization"`) and this test goes red while A1 stays green.

### §12. D1 — THE DECISION EXPLAINS THE RULE

D1 — THE DECISION EXPLAINS THE RULE (ADR-0016 §5, charter principle 6).

Until M22.0 the resolved ceiling and its contributing tiers lived ONLY in `control_runs.evidence`. An operator handed a `decision_id` could read the verdict and not the rule it was measured against. ADR-0033 then adds a way to EXCLUDE findings from that comparison — so the rule has to be in the Decision before any exception can hide inside it.

Read out of the persisted `decisions` row, never out of a hand-built merge input.

MUTATION: delete the `...(scanThresholdForDecision(effectiveScanThreshold) ?? {})` spread from `evaluateGovernanceGate`'s `inputContext`.

### §13. (a) THE EFFECTIVE CEILING

(a) THE EFFECTIVE CEILING — the per-severity MIN over all five tiers: maxCritical: org 90, component 4                  -> 4 maxHigh:     org 90, service 70, assembly 5        -> 5 maxMedium:   org 90, domain 6, service 60          -> 6 maxLow:      org 7, domain 80                      -> 7

### §14. D2 — DETERMINISM, AND THE WRITE AMPLIFICATION IT PROTECTS

D2 — DETERMINISM, AND THE WRITE AMPLIFICATION IT PROTECTS.

`restatesDecision` canonicalises object KEY order but deliberately PRESERVES array order, and `matchPoliciesForTargets` returns contributors in unordered-scan insertion order. So an unsorted `contributors` array in the Decision would defeat `insertDecisionIfChanged` and re-open the measured 1.44 GB/day flood (ADR-0024 §D0) on the busiest path in the system.

WHAT THIS TEST CAN AND CANNOT PROVE — stated plainly rather than implied:

```text
* (a) is the property that matters and it is directly asserted: N ticks over an unchanged
  parked gate append ZERO further rows.
* (a) alone, however, is NOT a reliable detector of a missing `.sort(...)`. The unordered scan
  `matchPoliciesForTargets` reads from is a seq scan over a small, never-updated table, so
  within ONE run it returns the same physical order every tick; the contributor array would be
  unsorted but STABLY unsorted, and the rows would still collapse. The order only diverges
  across a rewrite (VACUUM FULL, an UPDATE moving a row, a plan flip) — which a single test
  run cannot force.
* so (b) asserts the SORTED INVARIANT DIRECTLY, on the array the gate actually persisted. That
  is the assertion the `.sort(...)` mutation fails, deterministically: the fixture authors its
  floors in an order whose tier labels are not ascending, so "sorted" and "as matched" cannot
  coincide.
* what is NOT observable here at all: the FIXED KEY ORDER each contributor object is built
  with. `jsonb` does not preserve the author's key order (it stores keys by length, then
  bytewise), so the persisted row cannot witness it. (b) therefore rebuilds the sort key from
  the read-back values instead of comparing raw serializations. Key order still matters for
  the same reason the sort does — it is what makes the sort key content-only — but it is
  provable only in-process, not from the record.
```

MUTATIONS: remove the `.sort(...)` from `scanThresholdForDecision` -> (b) fails, (a) does not. replace `insertDecisionIfChanged` with `insertDecision`   -> (a) fails.

### §15. AUTHORING ORDER IS THE POINT

AUTHORING ORDER IS THE POINT. `matchPoliciesForTargets` yields matches in policy-row order, so these arrive as org -> containment_domain -> service -> assembly -> component. Sorted by their own serialization (which begins `{"tier":"…"`) they must come out assembly -> component -> containment_domain -> org -> service. The two orders share no prefix, so an unsorted array cannot pass for a sorted one here by luck.

### §16. (a) ZERO NEW ROWS ON EVERY SUBSEQUENT PASS

(a) ZERO NEW ROWS ON EVERY SUBSEQUENT PASS.

Stated as a bound rather than a bare count for the reason `counting-cel-sandbox.ts`'s `partitionConditionErrors` documents and measured: a CEL wall-clock miss on a loaded box makes the production code CORRECTLY write a fail-closed condition-error row, and then an ordinary row again on the next tick. Both writes are right. On a healthy run `conditionErrors` is empty and this reads exactly "not one row was appended".

## `apps/server/src/governance/attestation.ts`

### §17. Ed25519 approval attestation

Ed25519 approval attestation (DESIGN.md §10.2 "review decision": "every approval is cryptographically attested at creation — the domain instance signs (Ed25519 domain key) a canonical record binding the approver's subject id and IdP subject, the approved object's URN and content hash, the decision id, and the timestamp... SCP performs all signing and validation itself — no external PKI"). SECURITY-SENSITIVE (M4 PR body flag: "approval quorum integrity").

The signature does not, by itself, add authorization (that's `authz/resolve.ts`'s `hasRoleAtScope`, checked before a vote is even accepted — attestation.ts never gates anything). What it buys: an approval record that is tamper-evident and independently verifiable — by `scp audit verify` today, and by an importing domain validating a Promotion Bundle's approvals as evidence once federation (M6) exists (DESIGN §13) — without SCP needing to trust the `approval_votes` row's plain columns alone.

### §18. Reads the org's signing key, generating one on first use

Reads this org's signing key, generating and persisting one on first use (no migration seed — key material must never live in committed SQL). M6: org-scoped (schema.ts's updated doc comment on `instanceKeys` explains why) — every caller now supplies `orgId`, which in a real deployment is this instance's one org, but lets federation's tests model two distinct domains as two orgs with genuinely different keys. Race-safe: a duplicate-insert on concurrent first-use callers for the SAME org is resolved by re-reading rather than erroring, relying on `instance_keys_org_id_key`'s unique constraint (schema.ts) to make the loop below always converge on whichever row was inserted first.

## `apps/server/src/governance/campaign-deadline-widening-guard.ts`

### §19. Widening a campaign's deadline, and the ruling behind it

OWNER RULING 2026-08-25 (decision D1, option b-i) — WIDENING A CAMPAIGN'S DEADLINE, AT THE REPO
A write that RELEASES targets a campaign's deadline was withholding fan-out from costs the Owner-only `campaign:deadline-override` (drizzle/0088) ON TOP OF the `object:write` the writing door already demanded. Setting a first deadline and shortening an existing one are TIGHTENINGS and stay where they were.

WHY THIS IS INSTALLED AT `graph/objects-repo.ts` AND NOT ONLY AT `routes/campaigns.ts`
The ruling was first implemented at `POST /api/v1/campaigns/{id}/deadline` and nowhere else, and `governance/campaign-recipe-guard.ts`'s own census — written for the SAME property, one milestone earlier — says in as many words why that is not enough: `campaign.properties` has THREE write doors and a route-level guard is invisible to two of them.

```text
1. `POST /api/v1/campaigns/{id}/deadline` -> `coordination/campaign-repo.ts::setCampaignDeadline`
   -> `updateObject`. The one door the route-level check can see.
2. **IaC apply** -> `coordination-as-code/plans-repo.ts`'s `executePlanDiff` -> `updateObject` DIRECTLY, with a
   free-form `typeId` and free-form `properties`. `iac/plan-diff.ts` diffs `properties`
   WHOLESALE and `executePlanDiff` replaces it wholesale, so a manifest naming the campaign's
   urn with `typeId: "campaign"` and `deadline` omitted (or moved to 2099) produced EXACTLY the
   effect the route now refuses, at EXACTLY the permission it was raised above —
   `writePermissionFor("campaign")` is plain `object:write`, and the update branch's only other
   campaign check is `assertCampaignTargetsWithinAuthority`, which never reads `deadline`.
   MEASURED on the pre-guard tree through the HTTP API, not reasoned about:
   `iac/iac-campaign-deadline-widening.integration.test.ts` is the case, and deleting the call
   to this function turns it back into a 200 with the deadline gone.
3. **Federation import** -> `federation/import-repo.ts` and its operator-facing twin
   `federation/handfill-repo.ts`. EXEMPT — see below.
```

The generic `/objects/{type}` route is NOT a fourth door: `coordination/campaign-scope-authz.ts` refuses `campaign` on every write verb there. `upsertObjectByUrn` reaches `updateObject` for every ordinary update, so it is covered by the same call.

THE `federationImport` EXEMPTION — TAKEN THE SAME WAY ITS NEIGHBOURS TAKE IT
This function is called from inside `updateObject`'s existing `if (!input.federationImport)` block, so the exemption is the block's, not a private one. That is deliberate: `federation/import-repo.ts`'s `object_upsert` branch has NO try/catch, so ONE throw on that path aborts a whole signed bundle and wedges the channel until an operator intervenes. A permission refusal is the worst possible thing to put there — the importing instance has no role bindings for the EXPORTING domain's operator, so every imported campaign whose deadline moved later would wedge. A receiving domain also has no standing to referee an authority decision the AUTHORING instance already made; this is an authoring-time refusal by construction.

HAND-FILL (`federation/handfill-repo.ts`) IS THE OTHER `federationImport` SUPPLIER, and unlike the recipe/label guards it needs no separate closing call here. Checked rather than assumed: `handFillObject` passes `federationImport: { originDomainId: peer.id, ... }` — a FOREIGN domain's id — so `updateObject`'s single-writer check refuses outright (409) any attempt to hand-fill over a LOCALLY authored campaign, which is every campaign this instance's own operators can create or whose deadline this instance's reconciler enforces. What hand-fill CAN write is a shadow replica of a peer-authored campaign, and a replica's deadline is the authoring domain's business and is not locally mutable at all. So door 3 carries no local-actor bypass of this ruling.

THE UPDATE HALF ONLY, AND THAT IS THE WHOLE RULING
There is no create-side call, because a create is ALWAYS a first set — the ruling's own words — and there is no stored instant for a create to widen. `POST /campaigns` may therefore author a deadlined campaign at `object:write`, exactly as `packages/schemas/src/campaigns.ts`'s `CreateCampaignRequestSchema` says it may.

THAT HOLDS FOR `overrides[]` TOO, and it is worth spelling out because the create door IS free-form on the IaC path and CAN therefore plant a waiver: a campaign being created never withheld anything from anybody, so a `deadline` authored WITH waivers releases exactly the same set as no deadline at all — which that same actor could author at that same permission by simply omitting the key. It is not an escalation, so it is not refused. What it can do is plant a waiver attributed to someone who never granted it, which is the attribution residue named below, not a release.

DELETING THE CAMPAIGN IS NOT WIDENING AND IS NOT COVERED. Removing the campaign removes its targets, its member changes and the record along with the deadline; it is a different act with a different blast radius, governed by the delete door's own `object:write`, and folding it in here would make "clear the deadline" more expensive than "destroy the whole governance record", which is the inversion this ruling exists to remove rather than a new instance of it.

THIS IS A DELTA OVER THE STORED ROW, NOT THE ROUTE'S FLAT RULE — AND THE DIFFERENCE IS DELIBERATE
`routes/campaigns.ts`'s `widensCampaignDeadline` treats a CLEAR as escalated unconditionally, even over a campaign with no readable deadline, so that the status code cannot leak what is currently stored and so an operator has one rule to remember. That flat rule is wrong HERE and would be a catastrophe: an IaC manifest for a campaign that never had a deadline omits the key on EVERY apply, so a flat rule would demand an Owner for every routine re-apply of every deadline-less campaign in the estate.

So on the INSTANT this asks the narrower question — *does this write release targets that were actually being withheld right now?* — which makes it, on that key alone, a strict subset of the route's rule.

ON `overrides[]` IT IS NOT A SUBSET OF ANYTHING THAT ROUTE DOES, and the two must not be conflated (round 3): `SetCampaignDeadlineRequestSchema` is strict and omits the key, so `POST /campaigns/{id}/deadline` cannot express a waiver at all and has no rule about one — the delta below is this function's own, covering a free-form door that route has no view of.

WHAT HOLDS ACROSS BOTH KEYS is the property that actually matters: THIS CAN NEVER REFUSE A REQUEST A ROUTE ADMITS. `POST /campaigns/{id}/deadline` cannot carry `overrides` (400) and `setCampaignDeadline` carries the stored ones forward verbatim, so its delta is empty; and `POST /campaigns/{id}/deadline-override`, whose delta is non-empty by construction, resolved this exact permission at this exact campaign one frame earlier. The routes' own checks stay in place as the doors that produce the Decision, the audit events and the better errors. Belt and braces, in that order.

WHAT COUNTS AS A WIDENING HERE
* Nothing readable was stored (`none` or `malformed`) => NOT a widening, whatever arrives. Nothing was being withheld, so nothing can be released. `campaign-reconcile.ts` fails OPEN on a document it cannot parse, so replacing a malformed bag excuses nobody. * A readable deadline is REMOVED => widening. This is the IaC bypass in its plainest form. * A readable deadline is replaced by an UNREADABLE document => widening, and this is the half a naive "is the key still there?" test misses. `resolveCampaignDeadline` reports `malformed`, the reconciler fails open on it, and the lock stops — indistinguishable in effect from a clear, so it is priced like one. Fail-closed in the one direction where the read-time predicate is deliberately fail-open. * A readable deadline MOVES LATER => widening. Gating only the removal would leave the move as the next bypass: "drop the key" becomes "set it to 2099". * EQUAL OR EARLIER => not a widening. Compared on parsed INSTANTS, never on the ISO strings: the two renderings that actually occur differ in their milliseconds (`...T00:00:00Z` vs `...T00:00:00.000Z`, both accepted by `z.string().datetime()`) and they sort the WRONG WAY as strings, so a string compare would read an unchanged deadline as a slip and demand an Owner for a no-op re-apply. * `overrides[]` ARE READ, AS A DELTA — and this bullet is the correction of a claim this block used to make in exactly the opposite direction. It said a per-target waiver could only be minted by `POST /campaigns/{id}/deadline-override`, which already demands this exact permission at this exact scope, so there was nothing here to decide.

```text
 THAT WAS FALSE AT THE VERY DOOR THIS FUNCTION EXISTS TO CLOSE, and the refutation was MEASURED
 through the HTTP API rather than reasoned about. The `campaign` type's `property_schema` is
 `{"type":"object"}` (`drizzle/0002_rls_rbac_seed.sql`), so `validateProperties` accepts an
 arbitrary `deadline` document out of a manifest; `iac/plan-diff.ts` diffs `properties`
 WHOLESALE and `executePlanDiff` replaces it wholesale. So an Operator who keeps `at`
 BYTE-IDENTICAL — the instant test above therefore sees no widening whatever and returns —
 while adding a fully-formed `overrides` entry naming their own component gets a 200, and
 `findEffectiveDeadlineOverride` excuses that target on the next tick. Enumerating every target
 reproduces a CLEAR exactly, at exactly the permission this ruling raised the act above. The
 census that missed it looked for the SYMPTOM (`deadline.at`) rather than for the PROPERTY:
 *any edit to the stored deadline document that releases a withheld target*.
```

```text
 A DELTA, and NOT a flat "an IaC write may not carry `overrides`", for the two reasons that
 shape every other guard at this choke point. A round-tripping re-apply restates the waivers the
 row already holds, so its delta is EMPTY and it stays free — IaC re-applies an unchanged
 manifest constantly, and a flat refusal would take IaC-managed campaigns away from everyone
 below Owner the moment one waiver existed. And `/deadline-override`'s OWN write reaches this
 function, through `updateObject`, with a delta that is non-empty BY CONSTRUCTION: it must be
 admitted by HOLDING the permission rather than by being excused from the question — and it is,
 because `routes/campaigns.ts` resolved the same permission at the same campaign object one
 frame earlier. The whole cost of that route not being special-cased here is one redundant
 `hasPermission` per minted waiver, on a route driven by a human pressing a button.
```

* REMOVING A WAIVER, or SHORTENING its `until`, IS NOT A WIDENING — the opposite of `governanceLabelDelta`, where removal is the whole attack, and the divergence is stated here because the two guards sit four lines apart in `updateObject` and a reader who assumes they agree will read this one as a bug. A governance label is a MATCH KEY: deleting it makes a constraint stop applying. A waiver is a RELEASE: deleting it puts the target back under the deadline, which withholds strictly MORE. Silently re-locking a target an Owner excused has its own hazard — it is why `setCampaignDeadline` carries waivers forward across a move — but it is a tightening, not this ruling's act, and pricing it here would demand an Owner for the routine re-apply that follows a waiver's deliberate removal.

* REWRITING `reason`, `actorId` or `at` ON AN EXISTING ENTRY, leaving its reach unchanged, is likewise not priced here, and that residue is named rather than left to be discovered: it releases nobody (the same target stays excused for the same window), so it is outside this ruling, but it does let a free-form-`properties` door falsify WHO excused WHOM in a permanent record. That is an attribution defect against the `campaign.deadline.override` audit event, not an authority bypass, and it wants its own decision rather than a silent widening of this one.

NO DECISION AND NO AUDIT EVENT FROM HERE — STATED RATHER THAN LEFT TO BE DISCOVERED
A refusal here is a bare 403, like every other refusal at this choke point. The explainable record — Decision with the previous value, `loosening` label, `campaign.deadline.set` audit event — is the ROUTE's, and it is written only on the route's own successful writes. That is the same division of labour `assertMayWriteGovernanceLabels` and `assertPolicyScopeWithinAuthority` already use: the choke point makes the state unreachable, the door explains it.

### §20. How far each named target is excused, as an instant

HOW FAR EACH NAMED TARGET IS EXCUSED BY `overrides[]`, as a millisecond instant per target.

* `+Infinity` — an entry with NO `until`. `findEffectiveDeadlineOverride` treats that as "until the deadline is cleared or the target adopts", which is the common case and the widest reach there is. * `-Infinity` — an entry whose `until` no clock can hold. It waives nothing, so it must not read as an addition. SECOND BAR, UNREACHABLE TODAY, and said so rather than left implying it catches something: `until` is `z.string().datetime()`, so a value `Date.parse` cannot read makes `resolveCampaignDeadline` report the WHOLE document `malformed`, which the instant test above already prices as a widening. It is written this way because it falls out on the fail-closed side if that schema is ever loosened — exactly as `findEffectiveDeadlineOverride` writes its own comparison as `>= now` rather than `!(< now)` so that `NaN` lands as NOT effective.

THE MAXIMUM ACROSS ENTRIES FOR A TARGET, never the first one. `findEffectiveDeadlineOverride` — the only reader of this array — is a `.find()` whose predicate tests the target AND the expiry together, so with two entries for one target it excuses that target if ANY of them is live. "How far is this target excused?" is therefore the max, not the head of the list. `overrideCampaignDeadline` stores at most one entry per target and sorts them, but this array also arrives through IaC apply and federation import, where nothing dedupes it and `CampaignDeadlineSchema` puts no uniqueness constraint on it.

### §21. The targets this write adds or extends a waiver for

The targets this write ADDS a waiver for, or EXTENDS an existing waiver's reach for, sorted. Empty means no target is excused any further than the stored document already excused it — the round-tripping re-apply, and every removal or shortening.

ONE COMPARISON, DOCUMENT AGAINST DOCUMENT, AND NEVER AGAINST THE CLOCK. There is deliberately no `now` here even though `findEffectiveDeadlineOverride` has one, because a permission verdict that consults the wall clock is a verdict that changes without a write: the same manifest would be refused this morning and admitted this afternoon, and an operator could not reproduce either answer. The price is one over-refusal — moving an ALREADY-EXPIRED `until` to a later instant that is still in the past excuses nobody, yet reads as an extension — which costs an Owner for an edit on the trajectory of extending a waiver, and never admits one that releases a target.

### §22. At the campaign, matching the route it guards

AT THE CAMPAIGN, matching the route and `POST /campaigns/{id}/deadline-override`. Not the org root: `hasPermission` expands the checked scope UPWARD anyway, so this admits everyone an org-root check would AND an Owner bound at the campaign's own containment domain. Not the targets: a target-scoped check would hand one laggard's owner the power to release the whole campaign.

## `apps/server/src/governance/campaign-recipe-guard.ts`

### §23. The local author's door for a campaign's recipe

M25.4 (owner decision D3) — THE LOCAL AUTHOR'S DOOR for a campaign's coordination recipe.

WHY THIS IS INSTALLED AT `graph/objects-repo.ts` AND NOT AT `routes/campaigns.ts`
`campaign.properties` has exactly THREE write doors, and the typed route is only one of them:

```text
1. `POST /api/v1/campaigns` -> `coordination/campaign-repo.ts::proposeCampaign` -> `createObject`
2. **IaC apply** -> `iac/plans-repo.ts:1373/1396` -> `createObject` / `updateObject` DIRECTLY,
   with a free-form `typeId` and free-form `properties`. It never touches the campaign route,
   so a guard installed there is invisible to it. (`plans-repo.ts:991` records this exact class
   of miss already: "apply calls `createObject` DIRECTLY, so the route's refusal never ran
   here.")
3. **Federation import** -> `federation/import-repo.ts`'s `object_upsert` branch, and its
   operator-facing twin `federation/handfill-repo.ts`.
```

The generic `/objects/{type}` route is NOT a fourth door: `coordination/campaign-scope-authz.ts` refuses `campaign` (and `change`) on every write verb there. So the census is three, two of which a route-level guard misses — which is the precedent `governance/component-declaration-guard.ts` records from ADR-0032 §6a, where the same mistake left three doors open. `createObject` / `updateObject` is the one choke point every LOCAL write funnels through, so that is where it goes.

WHY `campaign` ONLY, AND NOT ALSO `change` — the deliberate half of the census
The recipe is READ off a member CHANGE's properties at trigger time (`coordination/reconcile.ts`), not off the campaign, so "census by property" points straight at `change` as well. It is deliberately NOT guarded here, and the reason is measured rather than aesthetic:

```text
* `federation/promotion-repo.ts::importPromotionBundle` re-proposes a promoted change LOCALLY
  via `proposeChange` -> `createObject` with **`federationImport` UNSET** (it is a locally
  authored change carrying the exporter's properties). A refusal on `change` therefore fires on
  the promotion path.
* `federation/inbox-loop.ts:552-556` DEFERS a 400 and retries it next tick — forever. So a
  promoted change whose recipe an OLDER outpost cannot parse would not fail once and surface; it
  would loop silently. That is the version-skew wedge 0043/0075 exist to prevent, arriving
  through the promotion door instead of the journal door.
```

The gap that leaves is closed at the OTHER end, fail-closed: `coordination/campaign-recipe.ts` `safeParse`s the recipe at trigger time and REFUSES the wave target — block Decision with a resolvable `decision_id`, hash-chained audit event — on a malformed one. So an unparseable recipe never silently degrades to "trigger with no parameters"; it stops, explainably, at the actuator instead of wedging a bundle at the door. Strict where a human is standing there to read the 400; loud-and-terminal where they are not.

WHAT A REFUSAL ACTUALLY PREVENTS
`{"recipie": {...}}`, or a recipe with `trigger.kind: "rollback"`, or a `parameters` bag holding `githubToken`. The first is stored happily and read at trigger time as NO recipe — every one of 47 components triggers a bare sync and the campaign goes green having coordinated nothing. The second would turn a forward migration into a restore. The third publishes a credential into 47 changes' `properties`, readable at `object:read` and carried through federation, where no later fix can un-publish it.

### §24. The same bound as the trigger-time refusal, one function

THE SAME BOUND AS THE TRIGGER-TIME REFUSAL, from the same function. Found by censusing the PROPERTY — "an unbounded string rendered from zod issues" — rather than the symptom, once the trigger-time copy was fixed; it was the second of two instances in one increment's own diff.

The CONSEQUENCE differs at the two sites and the FIX does not. This one is a 400 echoed to the caller rather than four permanent hash-chained records, so it is not an unbounded-growth vector — but 188 KB of enumerated key names serves an author no better than it serves an operator, and two renderings of one idea is how the copies that DO diverge get started.

## `apps/server/src/governance/cel-sandbox.test.ts`

### §25. Unit coverage for the sandboxed CEL evaluator

Unit coverage for the sandboxed CEL evaluator (BUILD_AND_TEST.md §8 M4 unit DoD: "the CEL sandbox genuinely blocks I/O/arbitrary code (assert a malicious expression can't escape)"). Spins up real `node:worker_threads` — no mocking of the sandbox internals, since the whole point under test is that isolation is real.

### §26. THE ERROR TEXT DEPENDS ON THE FAULT, NEVER ON THE CONTEXT

THE ERROR TEXT DEPENDS ON THE FAULT, NEVER ON THE CONTEXT (PR #153 review Q2).

cel-js serializes the WHOLE evaluation context into its identifier-resolution errors, and `governance/evaluate.ts` puts a per-evaluation `time` snapshot in that context and then persists the resulting string into every gate Decision's reason tree. Left alone, a single typo'd policy condition — a PERMANENT operator error that never self-heals — made the reason tree differ on every ~2 s reconcile tick, so `insertDecisionIfChanged` correctly wrote a new row every tick and the gate returned to ~43,200 rows/day/change: the original 1.44 GB/day incident, with the persist-on-change fix fully in place.

These two tests are the ones a cel-js version bump must break rather than silently regress: the first pins the message END TO END through a real worker (so a reworded upstream error is caught), the second pins the invariant that matters (context values, above all `time`, never appear).

### §27. Malicious-input / sandbox-escape attempts

Malicious-input / sandbox-escape attempts (BUILD_AND_TEST.md §8 M4: "assert a malicious expression can't escape"). None of these may (a) throw an uncaught exception that could crash the host process, (b) return a live Node object / function / any value that isn't plain JSON-serializable data, or (c) have any observable side effect (no way to assert "no side effect" directly, so these tests assert the SAFE failure mode: a rejected/failed evaluation that resolves to inert data, never to something callable).

### §28. The language has no construct to hang itself with

cel-js has no native sleep/loop construct to actually hang itself with (by design — CEL is not Turing-complete), so a conditional-hang worker entry forces the timeout path deterministically: it hangs ONLY on the sentinel "__HANG__" and evaluates everything else normally. That lets this prove what the old test couldn't (MINOR (b)) — after the timeout terminates+respawns the wedged worker, the SAME sandbox instance serves a subsequent call.

### §29. BOUNDED, NOT HUNG FOREVER

BOUNDED, NOT HUNG FOREVER — that is the whole claim, and the number is headroom, not a latency target. The sandbox's own `timeoutMs` here is 50ms; everything above that is worker spawn.

RAISED 2000 -> 5000 (2026-08-01). Job 4 now runs `pnpm test -- --coverage`, and v8 instrumentation makes spawning + loading a worker thread materially slower: this assertion failed on `main` at 2158ms having passed uninstrumented for months. 5000 keeps the assertion meaningful — a genuinely hung evaluation blows the 10s test timeout below, so 5s still separates "bounded" from "wedged" — while not re-litigating worker startup cost on every loaded CI box.

This is the ONLY wall-clock assertion in the unit layer (censused 2026-08-01: `packages/plugins/fake-executor` deliberately uses a fake clock for exactly this reason, and says so). `plugin-host/host.test.ts`'s `rssGrowthMb < 300` is the same PROPERTY — a resource bound now measured under instrumentation — and was checked: it has passed every run since coverage was enabled, so it is left alone rather than pre-emptively loosened.

## `apps/server/src/governance/cel-sandbox.ts`

### §30. The sandboxed CEL evaluator

The sandboxed CEL evaluator (DESIGN.md §10.1: "CEL via `cel-js` — sandboxed, no I/O, no arbitrary code"; BUILD_AND_TEST.md §8 M4 "known-tricky": "the CEL sandbox MUST NOT allow I/O, network, filesystem, process, or unbounded compute... evaluate untrusted policy expressions safely — timeout + no host bindings"). SECURITY-SENSITIVE (flagged in the M4 PR body).

Two independent layers of defense, because a synchronous single-threaded interpreter (cel-js) can't be preempted by a JS timer alone:

1. **Static pre-validation** (`checkStaticComplexity`, cheap, no thread involved): rejects obviously pathological input — over-long expressions, or nesting deep enough to risk a parser stack overflow — before it ever reaches an evaluator. This is the fast path that handles the common adversarial case (a huge or deeply-nested expression) without spending a worker round trip on it. 2. **`node:worker_threads` isolation with a hard wall-clock timeout** (`cel-worker-entry.ts`): the actual `cel-js` `evaluate()` call runs on a separate thread; this class races it against a timer and calls `worker.terminate()` if the timer wins, converting "hung forever" into a bounded failure. Because it's a SEPARATE THREAD (not just a separate call stack), terminating it doesn't just abandon a promise — it actually stops the runaway computation, which a same-thread `Promise.race` against a `setTimeout` cannot do (Node's event loop can't preempt synchronous code). Isolation also means a `cel-js` bug that crashes the worker (e.g. a genuine parser stack overflow past the static check's bound) takes down that one worker, not the request-serving process — the pool respawns it, mirroring `plugin-host/host.ts`'s crash-recovery design (same idea, far smaller surface: no JSON-RPC framing, no plugin config, just `{expression, context} -> {value | error}`).

No host bindings are ever registered (`cel-js.evaluate`'s third "custom functions" argument is never passed — see the worker entry's doc comment) — the ONLY data an expression can observe is the plain-JSON `context` object `governance/evaluate.ts` passes in, and the ONLY thing an expression can produce is a plain CEL value. There is no code path from a policy expression to `fetch`, `fs`, `child_process`, or any other capability.

### §31. The evaluation context is partly attacker-controlled

MAJOR #4: the EVALUATION CONTEXT is partly attacker-controlled — a change target's `labels` and the graph owner/dependent id arrays flow in from graph objects any writer can set. cel-js's `==`/`!=` do a deep structural compare, so a short expression like `subject.labels == {...}` over a huge/deep labels object can burn the whole timeout budget (feeding the timeout path). Bounding the serialized size AND the nesting depth of the context before it ever reaches a worker caps per-eval cost independent of the expression. Generous vs. any real policy context (DESIGN §10.1's shape is a handful of ids + a small labels map).

### §32. The library embeds the whole context in its errors

cel-js embeds the ENTIRE evaluation context, `JSON.stringify`d, in its identifier-resolution errors (`cel-js@0.3.1/dist/visitor.js:329-341`: `Identifier "x" not found in context: {…}` and `Cannot obtain "x" from non-object context: …`). Both spellings put the dump after `" context: "`, which is what this cuts at.

### §33. KEEP THE DIAGNOSIS, DROP THE CONTEXT DUMP

KEEP THE DIAGNOSIS, DROP THE CONTEXT DUMP — the error text this sandbox returns must depend only on the FAULT, never on the evaluation context.

WHY THIS IS NOT COSMETIC (measured; PR #153 review Q2). A policy whose CEL condition cannot be evaluated — a typo'd identifier, a renamed label, a field that no longer exists — is a PERMANENT operator error that never self-heals. `governance/evaluate.ts` persists this string into the reason tree twice (as `conditionError` and, for a required contributor, inside the fail-closed `conditionError` effect's `detail.error`), and the context cel-js dumps into it carries `context.time`, a fresh ISO snapshot per evaluation. So the reason tree differed on every ~2 s reconcile tick, `insertDecisionIfChanged` correctly saw a genuinely new verdict every time, and the gate went straight back to ~43,200 Decision rows/day/change — the ORIGINAL 1.44 GB/day incident, with the persist-on-change fix fully in place. Measured over 15 consecutive ticks: two consecutive 1,346-byte reason trees differing by TWO CHARACTERS, both inside the timestamp.

WHAT THE TRADE ACTUALLY IS — stated precisely, because an earlier draft of this comment claimed "nothing is lost: every Decision already stores the context verbatim in `input_context`", and that is MEASURABLY FALSE for the gate Decision this protects. `gate-orchestrator.ts` persists COUNTS and wave metadata (`matchedPolicyCount`, `effectivePolicyCount`, `firedPolicyCount`, plus the caller's `waveId`/`waveIndex`/`topologyObjectId`/`explicitGatesBound`); the CEL evaluation context built at `governance/evaluate.ts` (`change`/`subject`/`graph`/`actor`/`approvals`/ `controlOutcomes`/`time`) is persisted NOWHERE. So the dump is dropped, not relocated.

The trade is still right, for two reasons that do not depend on that false claim. First, the dump was the FLOOD: it is a per-tick-unstable restatement of inputs the Decision already summarizes, and `context.time` alone made every tick's reason tree a new statement. Second, the ACTIONABLE part survives verbatim — WHICH identifier failed to resolve, which is what an operator fixes the policy from; the values of the other fields never told them anything about a typo'd name. Dropping it also stops the whole CEL context being duplicated into `reason_tree`, which `scp change explain` and the UI render far more widely than `input_context`.

NOT A SECURITY CHANGE. The timeout, the worker isolation, the static complexity checks and the context-complexity checks are all untouched — this only rewrites the text of an already-failed evaluation's error, on the way out.

WHERE IT IS APPLIED, and why only there. The other `{ok:false}` constructions in this file are `checkContextComplexity`'s bounded messages, the two "CEL sandbox is stopped" constants, `waitForReady`'s "did not become ready within Nms", the timeout path's "timed out after Nms", and `failAllPending`'s worker-exit/stopping messages — all text THIS MODULE writes, from constants and numbers, so normalizing them would be a no-op that looked like a fix.

TWO sites forward text from elsewhere, and only one of them needs this: * `spawnWorker`'s message handler forwards the worker's `msg.error` — cel-js's own exception, caught and posted back by `cel-worker-entry.ts`. That IS the boundary the context dump crosses, and it is what this wraps. * `worker.on("error")` forwards a foreign Node worker-`error`'s `.message` into `failAllPending`, and it reaches the reason tree exactly the same way. Named here so a future reader does not skip auditing it — but it is FORWARDED-BUT-BOUNDED, not a second flood: `cel-worker-entry.ts` catches every evaluation error and posts it as `msg.error`, so cel-js text never reaches the `error` EVENT, and a worker-level failure (spawn/module/thread) carries no CEL context and is stable across ticks. Nothing to normalize; something to check if either of those two facts ever changes.

### §34. Owns a small pool of persistent evaluation workers

Owns a small pool of persistent CEL-evaluation worker threads. `evaluate()` round-robins across the pool, races the call against `timeoutMs`, and on timeout terminates+respawns that specific worker (the in-flight call resolves with `{ok:false}` rather than hanging the caller forever).

### §35. CRITICAL, and CRITICALLY ORDERED LAST

CRITICAL, and CRITICALLY ORDERED LAST: unlike timers, `Worker` handles keep the Node event loop alive by default — an idle CEL sandbox (nothing ever calls `evaluate()` again) would otherwise hang ANY process that constructed one forever, including short-lived ones that never call `stop()` explicitly (`openapi-emit.ts`, `scp` CLI subcommands that boot `buildApp` for schema purposes, a test that forgets teardown). `unref()` means this worker never by itself keeps the process alive; the process stays alive for as long as something ELSE needs it to (the Fastify listener, an in-flight `evaluate()` call's pending promise, ...), which is exactly what every other caller of this class actually wants. MUST be called AFTER `worker.on("message", ...)` is attached above, not before: Node's `Worker` re-refs its underlying message port the moment a `"message"` listener is registered on it, independent of any earlier `unref()` call — calling `unref()` before the listener existed (this function's original, buggy ordering) silently leaves the worker ref'd anyway and hangs process exit forever. Verified against real `node:worker_threads` behavior, not just reasoned about — see this commit's PR description for the reproducer.

### §36. Evaluates one CEL expression against `context`

Evaluates one CEL expression against `context`. Never throws for a bad/malicious/slow expression — those come back as `{ok:false, error}` (module doc comment: layer 1's static check throws `CelSandboxError` synchronously for pathological SHAPE before any thread is involved; that IS allowed to throw since it's a caller-input-validation failure the same as a Zod parse error, not a sandboxing concern). A worker's one-time module-load cost (tsx transform + `cel-js`/`chevrotain` import) is awaited via `waitForReady` and does NOT count against `timeoutMs` — only the actual `evaluate()` call, once dispatched, is timed.

### §37. A test-only swap stood here with zero callers

A `setSharedCelSandboxForTest()` "test-only" swap stood here with ZERO callers, including tests — every suite that wants a tuned sandbox constructs its own `CelSandbox` directly instead. Removed as part of the census that fixed the id-keyed property-schema validator cache: an exported reset/replace function with no caller is the exact tell that let that bug survive a green suite, because it reads as an installed seam. Tests that need to swap the shared instance should add it back TOGETHER WITH the caller.

## `apps/server/src/governance/cel-worker-entry.ts`

### §38. The worker-thread entry point the sandbox spawns

The `node:worker_threads` entry point `cel-sandbox.ts` spawns (BUILD_AND_TEST.md §8 M4 "known-tricky": "the CEL sandbox MUST NOT allow I/O, network, filesystem, process, or unbounded compute"). Deliberately the SMALLEST possible surface: import `cel-js`, receive `{id, expression, context}` messages, call `evaluate()`, post back the result. Nothing else.

Why this is a sandbox, concretely: - `cel-js`'s `evaluate()` parses CEL (a restricted, non-Turing-complete expression grammar — no loops, no user-defined functions, no assignment) via Chevrotain and interprets the parsed AST directly; it never calls `eval`/`new Function`/`vm` on the input string, so a CEL expression cannot become executable JavaScript no matter what text it contains — an injection attempt like `"a".constructor.constructor('return process')()` cannot spawn a Turing-complete JS execution: CEL has no way to CALL a function it might resolve with attacker-controlled code. (Note: cel-js implements member access as JS property access, so a `.constructor` traversal MAY resolve to a live JS value rather than cleanly parse-erroring — the earlier claim that "dots can't navigate JS prototype chains" was wrong. The guarantee does NOT rest on that. Two things make it safe anyway: no host function is registered to invoke, AND every result crosses back to the parent via `postMessage`'s structured clone, which STRIPS functions and other non-cloneable/live values — nothing callable can ever return to the host. The unit suite asserts exactly this: an escape attempt yields either a failed eval or an inert, JSON-serializable value, never something callable.) - The THIRD argument to `evaluate()` (a "custom functions" map) is never passed here — this process registers zero host bindings, so even a syntactically valid CEL function call (`foo()`) has nothing to invoke. No `context` value this worker is ever given exposes `http`, `fs`, `secrets`, or any other capability — callers (`governance/evaluate.ts`) only ever pass plain JSON-shaped policy-evaluation-context data (DESIGN.md §10.1). - This worker's OWN Node runtime obviously still has `require`/`fs`/`process` available to real JavaScript — but a CEL expression string can never reach real JavaScript execution in the first place (previous bullet), so that capability is unreachable from untrusted input. Running in a separate thread is defense in depth against the *bugs in cel-js itself* (a parser crash, a pathological input hanging the interpreter, a stack overflow from adversarial nesting) rather than the sole sandboxing mechanism — `cel-sandbox.ts`'s hard wall-clock timeout + `terminate()` is what actually bounds compute, since Node cannot preempt a synchronous loop any other way.

### §39. Signals to `cel-sandbox.ts` that this worker's module graph

Signals to `cel-sandbox.ts` that this worker's module graph (tsx transform + `cel-js` + `chevrotain`) has finished loading — sent once, after the message handler above is already registered so no request racing this signal can be dropped (`node:worker_threads`' `MessagePort` buffers messages sent before a listener is attached, but there is no such gap here regardless). Cold module load (tsx-transforming this file, importing chevrotain's parser generator) is the dominant cost on a freshly spawned worker — often tens to a couple hundred ms — and MUST NOT count against a single evaluation's compute-bounding timeout budget (cel-sandbox.ts only starts a call's timeout clock once it has actually dispatched to a worker that announced `ready`).

## `apps/server/src/governance/component-declaration-guard.ts`

### §40. The local author's door for a component's declarations

M22.5 (ADR-0033 §6 guard 3; owner decision D2) — THE LOCAL AUTHOR'S DOOR for a component's security declarations.

WHY THIS EXISTS SEPARATELY FROM THE REGISTERED `property_schema`
drizzle/0075 registers NO schema at all for `component` — see its §2a. An earlier revision of that migration DID narrow `component.properties.security`, and the fragment was deleted: the registry has to stay open, because `federation/import-repo.ts`'s `object_upsert` branch Ajv-validates an incoming object against the registered schema with NO try/catch, so ONE rejection aborts a peer's ENTIRE signed bundle and wedges the channel. TYPING a key is the same version-skew hazard as CLOSING a key set — a NEWER peer talking to an OLDER receiver loses its whole bundle — and `component` is among the most-federated types in the graph, which makes it the worst place to spend that risk.

SO THIS GUARD IS NOT A SECOND OPINION ALONGSIDE THE REGISTRY; IT IS THE ONLY SHAPE CHECK THAT EXISTS for a declaration bag. That raises the stakes on its call-site census rather than lowering them: a local write door that does not call it validates nothing whatsoever.

So the strictness moves HERE, to the local author's door, where a refusal costs one 400 and nobody's bundle. That is 0043's "strict at the operator's door, open on the wire" rule, and ADR-0033 §6 names `z.strictObject` on the request body as the specific mechanism.

WHY IT IS INSTALLED AT `objects-repo.ts` AND NOT IN `routes/components.ts`
BUILD_AND_TEST.md §4.4's rule, and the measured precedent right beside it: ADR-0032 §6a's authoring guard was installed at ONE typed route and a filterless census then found THREE more doors reaching `createObject` with a free-form `typeId` and free-form `properties` — IaC apply, federation hand-fill, and the federation overlay route. Installing this at the component routes would repeat that exactly, and the fourth door would miss it again. `createObject`/`updateObject` are the one choke point every LOCAL write door funnels through, so that is where it goes, sharing the `federationImport` exemption and its two-module census (`import-repo.ts` and `handfill-repo.ts`) with the guards already installed there.

WHAT A REFUSAL ACTUALLY PREVENTS — it is not a typo check
`{"declarationz": {...}}` or `{"declarations": {...}, "egress": "none"}` would otherwise be stored happily, read by the gate as NO declarations, and the component owner would believe they had declared something. For a LOOSENING that mistake is always fail-closed, so it would never show up as a security incident — it would show up as a rule that mysteriously does not fire, and the author would have no way to discover why. A refusal at the door is the only outcome that leaves nobody with a false belief.

NEVER `labels`, and that is an absolute rather than a preference: labels are tenant-writable, carry no schema, have no reserved namespace, and are already a live evasion path for selector-scoped policies (PR #247). Nothing in this file or in the gate reads them.

## `apps/server/src/governance/containment-dependents-drift.integration.test.ts`

### §41. THE FOURTH COPY OF THE DOWNWARD WALK

THE FOURTH COPY OF THE DOWNWARD WALK — found by property, not by shape (2026-08-26)

`graph/containment.ts`'s header asserted the downward direction had EXACTLY ONE definition, `containmentChildrenSql`, composed by the depth doors and by `authz/readable-scope.ts`. It was false. `countContainmentDependents` was an independent hand-typed copy of the same three arms, and `graph/objects-repo.ts`'s container-delete guard was a fifth. Both are ONE LEVEL rather than recursive, which is exactly why a census run for `WITH RECURSIVE` — or for "the downward walk" — returned two hits and concluded the claim was true. Censusing the PROPERTY ("code that enumerates the rows contained by a given row") over each route's predicate returns four.

AND THEY HAD DRIFTED, in two directions at once. This file pins both fixes, because both change what counts as a dependent and one of them changes a WRITE DOOR's refusal.

DRIFT 1 — arm 2 counted EDGES, not live children (it counted too MUCH)
The copy's route-2 sub-count read `relationships` alone and never joined the child object, while the fragment joins `child_o.deleted_at IS NULL`. So a live `contains` edge to a TOMBSTONED child counted as a dependent — contradicting the function's own first sentence, "how many LIVE objects". `deleteObject`'s cascade cannot close that gap: it refuses REPLICA edges (single-writer authority) and cannot retroactively fix rows already in a database.

The observable cost was a FALSE governance record: `recordContainerDeletionReachChange` returns early on `dependentCount === 0`, so a container whose only `contains` child was already gone still wrote a Decision and a hash-chained audit event saying "detached 1 contained object(s)".

DRIFT 2 — arm 3 compared RAW TEXT, not `uuid` (it counted too LITTLE), and so did the delete door
Measured, PostgreSQL 16:

```text
  '0191F1E2-…-AA'::uuid = '0191f1e2-…-aa'::uuid  ->  TRUE
  '0191F1E2-…-AA'       = '0191f1e2-…-aa'        ->  FALSE
```

Every id compared here comes out of a `uuid` column, hence lower-case. So a placement whose `componentId` was written as UPPER-CASE HEX was a PARENT on the way up (`placementParentsSql` casts, because it must join `objects.id`) and NOT A CHILD on the way down — the two directions disagreeing about which values count, which is the failure class the shared fragment exists to end. `containment.ts`'s INDEX NOTE had already weighed the cast against migration 0051's text index and chosen the cast; the two hand-typed copies had simply never been told.

NOT reachable through `POST /placements` — `createPlacement` resolves both endpoints and writes their own ids — so the rows are planted here with a direct `UPDATE`, the same "no API can write this, which is the hazard" exception the past-the-bound and malformed-`effect` fixtures take. The population is federation-imported and legacy rows, i.e. exactly the population `placementEndpointParentSql`'s `CASE` guard was written for.

⚠️ BEHAVIOUR CHANGE TO A WRITE DOOR, pinned by "the delete door refuses it too" below: deleting a component or deployment-target named by such a placement is now REFUSED (409) instead of answering 200 and leaving the placement live and dangling. That is the guard's stated purpose, so the fix is in its favour — but it is a refusal that did not exist yesterday and is called out rather than folded in.

MUTATION LOG — each mutation applied ALONE, run, reverted
m1  `countContainmentDependents`: restore the hand-typed three-sub-count body → RED: "a live `contains` edge to a TOMBSTONED child is not a dependent" (`expected 1 to be 0`) and "an UPPER-CASE-HEX componentId is a dependent, as it is a parent" (`expected 0 to be 1`). m2  `placementNamesObjectSql`: `(… ->> 'componentId')::uuid` -> the raw text comparison → RED: both of the upper-case-hex cases, including the delete door's 409. m3  drop the `WHERE c.child_id <> …` self-exclusion → RED: "a self-parented legacy row is not its own dependent" (`expected 1 to be 0`).

## `apps/server/src/governance/control-runner.ts`

### §42. The module is free-form at the schema layer, checked here

`control_bindings.plugin_module` is a free-form string at the schema layer (CreateControlBindingRequestSchema — z.string().min(1)), so THIS check is the only thing standing between an attacker-controlled binding and `host.start()` provisioning an arbitrary module. Deliberately just the real ControlPlugin modules — "fake-executor" is an ExecutorPlugin (subprocess-entry.ts's `loadPlugin`), not a ControlPlugin, so accepting it here would only ever produce a safe-but-confusing RPC "unknown method 'evaluate'" failure; excluding it keeps this allowlist an honest description of what a control binding can actually reach. M17.1 adds "scan-result-control" (a ControlPlugin sibling of webhook-control that turns a coordinated Trivy scan verdict into gate evidence). M10.4 adds "github-check" (a third ControlPlugin sibling: turns a GitHub Check Run/status verdict for the change's own commit into gate evidence — the concrete "CI green for digest X" wave-gate control, BUILD_AND_TEST.md §8 M10.4).

### §43. Actually RUNS a control

Actually RUNS a control (DESIGN §10.2) via the subprocess plugin host — the one piece of governance evaluation that needs `PluginHost`, and therefore only ever runs on a process that has one (the `role=worker`/`role=all` reconciliation loop — DESIGN §16's api/worker split means a pure `role=api` process has no plugin host at all). See `coordination/gates.ts`'s module doc for how the lifecycle-edge (human-route) gate avoids needing this: it only ever READS already-persisted `control_runs`, never triggers one inline.

### §44. How long a cached expired outcome is still treated fresh

M10.4 — how long a cached `"expired"` outcome is treated as still-fresh before `ensureControlRun` calls the plugin again. `"expired"` is `github-check`'s "CI has not concluded yet, please re-check later" signal: a wave gate is often asked before CI on the target commit has even started, and returning `"fail"` for that would be WRONG — `"fail"`/`"pass"`/every other status below is cached FOREVER (this function's own doc comment: "a control result is a historical fact, not continuously re-polled"), which would PERMANENTLY deadlock the wave the instant this control was ever asked before CI concluded.

Without this cooldown, exempting `"expired"` from caching entirely would re-run the plugin (and insert a new `control_runs` row) on EVERY reconcile tick — the exact unbounded-growth pattern `coordination/reconcile.ts`'s wave-gate Decision persistence already hit and fixed (`insertDecisionIfChanged`: 1.44 GB/day from a byte-identical row every ~2s tick). This bounds both the `control_runs` growth rate and the external API call rate to at most once per interval per pending change, while still eventually noticing CI concluding. Every OTHER status (`pass`/`fail`/`warning`/`skipped`/`timed_out`) is unaffected — cached forever, unchanged from M4/M17.1, since only `github-check` ever produces `"expired"`.

### §45. Ensures a run row exists for that change and control

Ensures a `control_runs` row exists for (changeObjectId, controlObjectId) — running it via its bound ControlPlugin instance if no run exists yet (or `force`, or a cached `"expired"` outcome older than `EXPIRED_RECHECK_INTERVAL_MS`). Never throws for a plugin-side failure: an unreachable/erroring binding produces a `fail` outcome (with the error captured in evidence) rather than propagating, so one bad control binding can't abort an entire gate evaluation the way an uncaught exception would.

### §46. An entry that is not even a well-formed object id

A policy's `requireControls` entry that isn't even a well-formed object id (a stale reference, a hand-authored-JSON typo — `control_bindings`/`control_runs` both key on a `uuid` column, so this could never correspond to a real binding or a real graph object either way) must fail closed exactly like "no binding configured" below, NOT reach the database with a value Postgres will reject as 22P02 (invalid input syntax for type uuid). Before this check, that raw DB error propagated out of `evaluateWaveGate` uncaught, which wedged the offending change's wave-boundary gate every reconcile tick forever (caught only by reconcile.ts's outermost per-change try/catch, which just logs and retries — the SAME crash, forever). No `control_runs` row is written here (unlike "no binding configured") — there is no valid uuid to write one under.

### §47. Take the plugin's transported findings off the evidence

M22.1b (ADR-0033 §7) — TAKE the plugin's transported findings OFF the evidence before anything persists it. A ControlPlugin has no `DATABASE_URL` and cannot write `scan_findings` itself, so `scan-result-control` hands its capped findings back on the outcome's evidence record; this is the server-side half of that seam.

THE STRIP IS NOT OPTIONAL AND IT IS NOT COSMETIC. `federation/promotion-repo.ts` projects `{controlUrn, status, evidence, detail}` for every control run and copies `evidence` VERBATIM into the signed promotion bundle. Findings left on that column would both bloat every bundle and federate accepted-risk detail that ADR-0033 §8 confines to grants — the bundle keeps counts. `takeScanFindingsFromTransport` extracts and strips in ONE call precisely so a caller cannot obtain the findings and forget the strip. It also RE-VALIDATES and re-caps the payload: the producer is a separate process and must not be able to steer what lands in the database.

Runs for EVERY control, not just scan controls: a transport key must never survive onto a persisted row, whichever plugin put it there.

### §48. Stamp the exclusion set this run was produced under

M22.7 (ADR-0033 §10) — STAMP THE EXCLUSION SET THIS RUN WAS PRODUCED UNDER, so the next evaluation can tell whether the cached outcome is still current. Written by the SERVER, from the context it actually threaded, for the same reason `findingsRecord` above is: the producer is a separate process and this is a statement about what the GATE resolved, not about what the plugin did with it.

Gated on `scanMethod` exactly like `findingsRecord`: only a scan verdict can have exclusions applied to it, and only a scan verdict is compared by `scanExclusionSetChangedForGate`. Stamping a webhook control's evidence with a hash nothing ever reads would be noise; failing to stamp a scan verdict's would make it look permanently stale and re-run it every tick.

An `openscap` verdict IS stamped, and that is deliberate: its exclusions are refused for a structural reason (`unsupported`), not because no set was in force, and leaving it unstamped would force a pointless re-scan on every set change forever.

### §49. WHAT ACTUALLY RAN, stamped on the run

WHAT ACTUALLY RAN, stamped on the run (0063). Taken from the binding THIS call resolved, not looked up later: a binding re-pointed afterwards must not be able to re-narrate what this row evidenced. Recorded even on the catch path above — a `fail` from `github-check` is still a `github-check` verdict, and dropping the module there would turn an own-check objection into an unattributable one.

### §50. Re-run every named control even if a run exists

M22.0a — re-run every named control even if a run already exists for THIS gate.

This parameter did not exist before: `ensureControlRun` (singular) had always declared `force`, but the plural entry point every production call site actually uses could not express it, so nothing in the tree could ever request a re-evaluation. That is what made the re-evaluation story a signal with no lever — ADR-0033 §10's actuator has to pass this when the resolved exclusion set no longer matches the hash recorded in the cached run's evidence, or a revoked/expired grant is never noticed.

### §51. M22.0a — the gate crossing being decided

M22.0a — the gate crossing being decided. Host-less callers (the read-only `POST /policy-evaluate` preview and the accept edge, which has no plugin host of its own) must read the run made FOR THIS CROSSING, for the same reason `ensureControlRun` now does: a run made during `validating` is not evidence that a production wave boundary was authorized.

Optional, and gate-agnostic when omitted, so a caller that genuinely wants "the newest outcome for this control on this change, wherever it came from" still has that — but every authorization path passes it.

## `apps/server/src/governance/controls-repo.ts`

### §52. Control graph objects

Control graph objects (`objects` rows of type `control`, DESIGN §10.2) are managed through the typed-registry endpoint like any other registry resource — this file only owns the TWO things the generic object model has no place for: which ControlPlugin instance a control is BOUND to (`control_bindings` — "swapping the impl changes a binding, never a policy"), and the persisted outcome history of running it (`control_runs`, referenced by Decisions).

### §53. WHICH KIND OF CONTROL PRODUCED THIS RUN

WHICH KIND OF CONTROL PRODUCED THIS RUN — the `control_bindings.plugin_module` of the binding that actually ran, stamped ON the run at insert (migration 0063).

`undefined` is the honest answer for a row no bound ControlPlugin produced: `federation/promotion-scan-step.ts` deposits rows under a synthetic control id with no binding, and `ensureControlRun` deposits a `fail` row when a binding is MISSING. A caller asking "what kind of evidence is this?" must be able to tell those apart from a real module, so the column is nullable rather than defaulted.

### §54. The module that produced this run, as recorded then

The plugin module that produced this run, as recorded WHEN IT RAN — see `InsertControlRunInput.pluginModule`.

IT IS NOT READ FROM THE BINDING AT QUERY TIME, and that is the whole reason the column exists. A binding is mutable: re-pointing one control from `webhook-control` to `github-check` would retroactively relabel every historical run of that control as "the component's own checks passed" — and `dependencies/bump-actuator.ts` grants an unattended merge on exactly that label, reading historical runs. Evidence about the past must not be re-narrated by a present-tense edit (ADR-0030 §2's "declared, never inferred"; this repo's own provenance-label lesson).

`null` on rows written before 0063, and on rows no bound plugin produced. Treated as NOT an own-check by the one caller that weighs it — the fail-closed direction, which costs a pull request rather than an unattended merge.

### §55. The most recent run of that control against the change

M22.0a (ADR-0033 §10) — the most recent run of `controlObjectId` against `changeObjectId` **FOR A SPECIFIC GATE CROSSING**.

WHY GATE IDENTITY IS PART OF THE KEY. `latestControlRun` below ignores the gate entirely, so ONE run satisfied every gate that change would ever face. The deciding run is normally the reconcile PREWARM, made while the change sits in `validating`; that single row then answered the accept edge AND every subsequent `wave_boundary` gate in every wave, including the production wave, for the rest of the change's life. A control outcome is evidence that a PARTICULAR crossing was authorized, not a permanent property of the change.

That was tolerable while a control verdict could only get *stricter* over time. It stops being tolerable with ADR-0033: an exclusion grant carries an EXPIRY, so a 7-day grant resolved during validation would otherwise still authorize a production wave three weeks after it lapsed. This is the "verify the lever, not just the signal" failure in its purest form — the grant is readable and nothing re-reads it.

THIS DOES NOT BREAK THE PREWARM -> ACCEPT-EDGE PATH, and that is not luck: prewarm writes `gateKind: "lifecycle_edge"` with `gateRef: {fromState: "validating", toState: "accepted"}` (gate-orchestrator.ts), and the accept-edge gate passes `{fromState: ctx.fromState, toState: ctx.toState}` — byte-identical for that transition. The accept gate still finds prewarm's run. What no longer matches is a WAVE boundary, whose `gateRef` is `{topologyObjectId, waveIndex}` — exactly the crossing that must be re-decided.

`gate_ref` is compared as `jsonb`, whose equality is over the normalized binary form, so key ORDER in the caller's object is irrelevant and no canonicalization is needed here.

COST, STATED PLAINLY: a change with N waves now produces up to N+1 runs per control rather than one. That is the correct semantics — each crossing is authorized on its own evidence — and for `github-check` the `EXPIRED_RECHECK_INTERVAL_MS` cooldown still bounds the external call rate.

### §56. The most recent run, regardless of which gate asked

The most recent run of `controlObjectId` against `changeObjectId`, regardless of gate.

PREFER `latestControlRunForGate` for any AUTHORIZATION decision — see its doc for why keying without the gate let one run authorize every later crossing. This gate-agnostic form remains for surfacing "what happened to this control on this change at all", where the newest outcome across every gate is the intended answer.

## `apps/server/src/governance/cosign-keys.integration.test.ts`

### §57. M17.3 E4 — SCP's cosign MANIFEST-SIGNING keypair management

M17.3 E4 — SCP's cosign MANIFEST-SIGNING keypair management (KEY MANAGEMENT ONLY; no signing of any promotion manifest, no export/gate change — those are E6). Proves the owner-decided posture: the private key lives in a DEDICATED org-scoped RLS table (`instance_cosign_keys`), generated lazily + race-safe, STRUCTURALLY unreachable by `resolveSecretRefs` (so it can never be pulled into a plugin subprocess), never returned over any API, and a real keypair that actually works.

## `apps/server/src/governance/cosign-keys.ts`

### §58. The org's cosign MANIFEST-SIGNING keypair (M17.3 E4)

The org's cosign MANIFEST-SIGNING keypair (M17.3 E4) — the cosign analogue of `governance/attestation.ts`'s `ensureInstanceKey` (Ed25519), and DELIBERATELY MODELLED ON IT: lazy first-use provisioning, race-safe convergence on one row, ORG-SCOPED + RLS-protected, no committed-SQL seed. E6 signs each org's promotion manifests with this key; E5 distributes the PUBLIC half to outposts for verification.

WHY A DEDICATED TABLE (`instance_cosign_keys`), NOT the `secrets` vault (owner decision, M17.3 grounding Area C): `secrets/secrets-repo.ts` `resolveSecretRefs` can resolve any `executor_bindings.secretRefs` entry into a `secrets` row and `plugin-host/host.ts` injects that plaintext into a plugin subprocess. A dedicated table is STRUCTURALLY unreachable by that path — `resolveSecretRefs` queries `secrets` only and has no code path here — so the SCP signing key can never be exfiltrated into a plugin (proven by cosign-keys.integration.test.ts).

KEY MANAGEMENT ONLY. This module does NOT sign any manifest and does NOT touch export/gate behaviour — those are E6. It manages the keypair and exposes accessors for E5/E6 to build on.

### §59. Reads the org's cosign keypair, generating on first use

Read this org's cosign keypair, generating and persisting one on first use (no migration seed — key material must never live in committed SQL). This IS the internal private-key accessor E6's signing path uses.

RACE-SAFE, mirroring `ensureInstanceKey`: the cosign key is generated OUTSIDE any DB transaction (never hold a tx open across the cosign subprocess), then inserted with `ON CONFLICT (org_id) DO NOTHING` and re-SELECTed, so concurrent first-use callers for the SAME org converge on whichever single row won — `instance_cosign_keys_org_id_key` (unique on org_id) guarantees at most one keypair per org.

### §60. The PUBLIC-key accessor

The PUBLIC-key accessor (E5's distribution seam). Ensures the keypair exists, then returns ONLY the non-secret half — the return type structurally omits the private key, so nothing that goes over an API can carry it.

## `apps/server/src/governance/evaluate.ts`

### §61. The policy evaluator

The policy evaluator (DESIGN.md §10.1: "Evaluation is a PURE function (context in → verdict + reason tree out), so explainability is the return value").

Split into two phases (adversarial-review CRITICAL #1a / MAJOR #3):

1. `resolveFiredPolicies` — evaluates EACH contributor's CEL condition INDEPENDENTLY (never an AND across a name-group's contributors) and unions the effects of ONLY the contributors whose own condition fired. A higher-scope required contributor that fires has its effects enforced no matter what any other same-named contributor's condition did. A REQUIRED contributor whose condition ERRORS or TIMES OUT fails CLOSED (the group fires and blocks with a Decision naming the eval failure) — never fail-open. Advisory/recommended contributors whose condition errors are annotated and skipped. This is the only place the CEL sandbox is called; it needs no control-outcome/approval data, so a gate can run this FIRST to learn what to actually run/materialize. 2. `evaluateFiredPolicies` — a PURE function over the already-resolved firing set plus a fully pre-gathered control-outcome/approval snapshot: same snapshot in ⇒ same verdict + reason tree out, always (BUILD_AND_TEST.md §8 M4's unit DoD).

`evaluateGovernance` composes the two for callers that want one call (the unit tests, the `policy-evaluate` dry-run). The gate orchestrator (governance/gate-orchestrator.ts) drives the two phases separately so the firing set determines exactly which controls run and which approval requests materialize.

### §62. Provenance only: contributors whose condition errored

PROVENANCE ONLY — every contributor whose CEL condition could not be evaluated (parse error, missing key, sandbox timeout), at EVERY enforcement level (advisory/recommended/required alike). This does NOT affect `fired`, `enforcement`, `requireControls`, `requireApprovals` or `contributingPolicyVersions`: the require*-effect semantics are unchanged (an advisory contributor that can't be evaluated still only annotates, because an advisory effect can never block anyway). It exists so consumers whose output is applied REGARDLESS of the authoring policy's enforcement level — today, `scan-requirements.ts`'s scan-threshold CEILINGS, which `scan-result-control` applies whatever enforcement authored them — can fail CLOSED on an unevaluable condition instead of silently dropping the ceiling. Precise by construction: it names ONLY the contributors that actually errored, never a sibling whose condition cleanly evaluated FALSE.

### §63. Phase one: evaluate each contributor's condition alone

Phase 1 — evaluate each contributor's condition independently (see module doc). NO control / approval data needed; the returned `requireControls`/`requireApprovals` are exactly what a gate must run/materialize. `celContext` is `buildCelContext(context)` (built once by the caller).

### §64. Phase two, pure: check fired effects against outcomes

Phase 2 — PURE: check each fired policy's effects against the gathered control-outcome / approval snapshot and produce the verdict. A required, fired, unsatisfied policy blocks; a recommended/advisory unsatisfied one only warns (DESIGN §10.1/§9.3). A required contributor's condition-eval error is an unsatisfiable synthetic effect (fail closed).

### §65. One-call composition of the two phases

One-call composition of the two phases — the unit tests and the `policy-evaluate` dry-run use this. "Pure" here means "same context snapshot ⇒ same verdict + reason tree, always, with no observable side effect" (the only async work is the deterministic, side-effect-free CEL sandbox call), exactly BUILD_AND_TEST.md §8 M4's unit DoD.

## `apps/server/src/governance/freeze-object.ts`

### §66. M25.7 — THE WIRE FORM OF A FREEZE

M25.7 — THE WIRE FORM OF A FREEZE (owner decision D6, ADR-0043)

Until this increment a freeze could not cross a security boundary at all, and that was a DELIBERATE, TESTED ABSENCE rather than a gap: `db/schema.ts`'s "M4 Governance Engine" banner said in so many words that the generic object model has no place for freezes (that banner now carries the narrowed claim — the ENFORCEMENT state still has no place there, which is why the projection table below stays; only the WIRE form became an object — and it is cited by section rather than by line for that reason), `service-board.ts` told operators that a null `activeFreeze` means "no freeze declared HERE", and `coordination/service-board-precedence.integration.test.ts` pinned it. D6 overturns that. This module is the overturn's home in code, the way `federation/domain-local.ts` is ADR-0031's and `federation/outpost-binding.ts` is ADR-0022's.

## Why an object and not a journal kind

`JournalEntryKindSchema` is a nine-literal `z.enum` that ALSO appears in the 200 response of `POST /federation/exports`. Widening it is an oasdiff `response-property-one-of-added` break — and, far worse, a FAIL-CLOSED CLIFF: `POST /federation/imports` validates the whole bundle against `SyncBundleSchema` at the ROUTE boundary, so an older peer receiving an unknown kind 400s the ENTIRE bundle, losing every unrelated entry in it and retrying forever from `inbox-loop.ts`. `import-repo.ts`'s tolerant `default: return;` is never reached. A registered object type rides the EXISTING `object_upsert` every peer already understands: zero new kind, zero enum widening, zero oasdiff exposure, zero new importer branch.

## Object PLUS projection, not object INSTEAD OF projection

The `freezes` row stays and is rebuilt at the importing instance. Everything that ENFORCES a freeze reads that table — `activeFreezesInWindow` (the single owner of the half-open window predicate), `freezesByTarget`, `checkFreeze`, `evaluateFreezeHolds`, the service board — and re-expressing the window predicate as jsonb comparisons on a hot gate path would buy nothing except a second copy of the one comparison `freezes-repo.ts`'s header exists to keep singular. So: the object is what TRAVELS, the row is what BLOCKS, and `rebuildFreezeProjectionFromObject` is the join between them. Without that rebuild this feature would ship a replicated row nothing reads.

## One authoring door

`freeze` is in BOTH of `governance-managed-types.ts`'s sets, and it needs both — the first version of this paragraph named only the first and was wrong about what that bought.

`GOVERNANCE_MANAGED_OBJECT_TYPE_IDS` makes two of the five caller-supplied-`typeId` doors refuse the type outright (`/objects/{type}`, `/discovery/accept`). Without it a holder of plain `object:write` could `POST /api/v1/objects/freeze` and mint a graph object that becomes a BLOCKING freeze at every downstream instance — an escalation across a security boundary authored with the weakest write permission in the system.

But at the other THREE doors (`POST /plans`+apply, `/federation/overlays`, `/federation/hand-fill`) that membership is an instruction to demand `policy:write` INSTEAD of `object:write` — a permission UPGRADE, not a refusal — and `policy:write` is neither of the two permissions a freeze actually requires. Measured: an actor holding `policy:write` at a narrow domain, and `freeze:write`/`federation:write` nowhere, could mint a federating freeze through any of the three, with its declared `properties.scopeObjectId` bound to nothing (that path scope-binds `policy` and `campaign` only) and with no `freezes` row here, leaving it unliftable at both ends. `PROJECTION_BOUND_OBJECT_TYPE_IDS` is what closes those three, by refusal.

`POST /api/v1/freezes` (gated on `federation:write` for the federating form) is therefore the only way a `freeze` object is ever created locally, which is also what keeps the object and its projection row in step: one door, one writer, no census to keep re-running.

## What does NOT live here

A PLATFORM-TIER FREEZE, and it cannot. `SyncJournalEntrySchema.orgId` is required, `appendJournalEntry` takes `input.orgId`, the hash chain is keyed `(orgId, originDomainId)`, and `exportSyncBundle` runs inside `withTenantTx`. `instance_freezes` (drizzle/0086) has no `org_id` and is declared by no commander. ADR-0040 and GLOSSARY's "platform-tier freeze" entry both say so and both stay true after M25.7. Org tier and below only.

### §67. Registered as a builtin type, on both sides

Registered by drizzle/0089 as a BUILTIN type, on both sides, because `object_types` is a migration seed and never journals — which is exactly what lets this ride `object_upsert` with no type-registration entry kind.

A PEER THAT HAS NOT RUN 0089 DOES NOT HAVE THE TYPE, and that case is now survivable rather than fatal. `createObject` 404s on an unregistered type and the `object_upsert` branch has no try/catch, so the first federated freeze reaching an un-upgraded peer used to abort its ENTIRE signed bundle — and `inbox-loop.ts` would retry the same bundle forever, wedging the channel on a version skew that a rolling upgrade produces by construction. `import-repo.ts` now checks registration BEFORE the write and skips-and-records the entry instead (one entry lost, channel intact; a from-genesis re-sync replays it once the peer has the migration). This paragraph is the corrected version of a claim that used to read as though the seed made the hazard impossible — it makes it impossible only once BOTH ends have run the migration.

### §68. THE SNAPSHOT THAT TRAVELS

THE SNAPSHOT THAT TRAVELS — every field `rebuildFreezeProjectionFromObject` needs to reconstitute an enforceable row, and nothing else.

`scopeObjectUrn` rides ALONGSIDE `scopeObjectId` rather than instead of it. Ids are preserved verbatim by federation import (`import-repo.ts` passes `payload.id` through), so the two normally agree — but the urn is what survives `upsertObjectByUrn`'s hand-fill reconciliation, which REPLACES a locally-generated placeholder id with the authoritative one. Carrying only the id would leave a freeze pointing at a scope that had since been re-keyed.

`liftedAt`/`liftReason` are part of the snapshot because a lift MUST reach downstream. Without them a commander could declare a freeze at an outpost and never retract it there — M25.1's "a surface with an entrance and no exit" defect rebuilt one boundary over, and worse, because the replica guard deliberately refuses the outpost a local exit.

`createdByActorId` travels for explainability only. It names an actor object that does not exist at the receiving instance, which is fine — the column has no FK, for the same reason `lifted_by_actor_id` has none.

### §69. Mints the graph object for an inserted row, and links

Mints the `freeze` graph object for an already-inserted `freezes` row and links the two.

ORDER IS ROW-THEN-OBJECT, and it has to be: the object's `properties.freezeId` IS the row's primary key, and that identity is what makes the rebuild at the far end idempotent and what keeps a `freeze_admission` Decision written at an outpost resolvable against `GET /v1/freezes/{id}` at the commander. Both statements are in the caller's transaction, so a freeze can never exist with a half-attached object.

`createObject` journals the `object_upsert` itself (`graph/objects-repo.ts`) — there is no federation-specific code on this path at all, which is the entire point of choosing an object.

### §70. Re-snapshots a federated freeze after a lift or edit

RE-SNAPSHOTS a federated freeze's object after a lift or a window edit, so the change rides the next bundle. A NO-OP for a freeze with no object — which is every freeze on a pre-M25.7 estate and every freeze authored without `federate`, so the two write verbs stay byte-identical there.

Called from the two write ROUTES rather than from `freezes-repo.ts`, and the split is the one `federation/domain-local.ts` names: the repo owns the invariant that cannot be forgotten (its `lockFreezeRow` refuses the write outright on a replica, so no door can edit a foreign freeze), this owns the per-request follow-through. Forgetting it does not corrupt anything — it leaves the downstream copy stale until the next edit — but the lift case is the one that matters, so both routes have a test.

### §71. A string property that is genuinely a UUID, or `null`

A string property that is genuinely a UUID, or `null`.

LOAD-BEARING, NOT DEFENSIVE NOISE, and the same argument `import-repo.ts`'s `recordableChangeObjectId` records for `federation_unattached_change_status.change_object_id`. Four of the columns this module writes are `uuid` — `freezes.id`, `scope_object_id`, `created_by_actor_id`, `lifted_by_actor_id` — while the properties they come from are untyped bundle-payload JSON (`z.record(z.string(), z.unknown())` on the wire, and drizzle/0089's registered schema constrains them only to non-empty strings). Handing Postgres `"not-a-uuid"` for a `uuid` column raises `22P02 invalid input syntax`, which does NOT merely fail this function: it POISONS the whole import transaction, so every subsequent statement fails, the peer's entire signed bundle is rejected, and `inbox-loop.ts` retries it forever. One malformed freeze would take the channel down.

A non-UUID is therefore treated EXACTLY like an absent value — skip, never throw — which is the ruling `rebuildFreezeProjectionFromObject`'s docblock states for every other malformed field. `isUuid` is `graph/objects-repo.ts`'s, unchanged and not re-implemented.

### §72. THE IMPORT SIDE

THE IMPORT SIDE — WHAT MAKES AN IMPORTED FREEZE ACTUALLY BLOCK
Rebuilds this instance's `freezes` projection row from an imported `freeze` object. Called from `federation/import-repo.ts`'s `object_upsert` branch, which is the branch that already resolves any registered type through `upsertObjectByUrn` (it shares it with `policy_upsert`).

WITHOUT THIS FUNCTION THE FEATURE DOES NOT EXIST. The object would replicate and sit in the graph while `activeFreezesInWindow` — and therefore `freezesByTarget`, `checkFreeze`, `evaluateFreezeHolds` and the service board — went on seeing nothing, so a commander-declared freeze would still not be a freeze at the outpost. Its deletion is the mutation the E2E test is proved non-vacuous against.

## Idempotent by primary key

`freezes.id` IS `properties.freezeId`, preserved verbatim from the origin, so a replayed bundle converges through `ON CONFLICT (id) DO UPDATE` instead of duplicating. The `WHERE object_id = …` guard on the update arm means this can only ever overwrite the row THIS object owns: a locally-authored freeze that somehow collided on id is left untouched rather than silently rewritten by a peer. drizzle/0089's partial unique index is the same invariant from the other side — a second row claiming one object is not expressible.

## IT NEVER THROWS ON MALFORMED CONTENT, AND THAT IS A RULING, NOT AN OVERSIGHT

The `object_upsert` branch has NO try/catch: a throw here aborts the peer's ENTIRE signed bundle and wedges the channel, exactly as `governance-managed-types.ts`'s header and ADR-0032 §6a record for the same branch. So a payload missing a constitutive field is SKIPPED — the object still replicates, and no projection row is built. That is a fail-open for one entry, and the compensating control is that authoring-time refusal belongs at the AUTHORING instance: the only local door that mints a `freeze` object is `POST /api/v1/freezes`, which builds these properties itself and cannot omit them, and drizzle/0089's registered schema marks them `required` so Ajv refuses a hand-assembled one at every write door. A peer that ships a malformed freeze anyway is a PAIRING problem, not a validation problem.

THE FIRST VERSION OF THIS PARAGRAPH WAS FALSE, in the direction it was written to protect against, and the correction is the reason `uuidStr` exists. "Missing" was checked with `str`, which only asks for a non-empty string — so a payload carrying `freezeId: "nope"` passed every guard here and reached the INSERT, where four `uuid` columns (`id`, `scope_object_id`, `created_by_actor_id`, `lifted_by_actor_id`) raise `22P02 invalid input syntax` and POISON the transaction. That is not one lost entry; it is the whole bundle rejected and retried forever. The constitutive fields are now read through `uuidStr`, which treats a non-UUID exactly as it treats an absent value. Note the shape of the mistake, because it is this repo's most common: the hazard was correctly named in prose and the code implementing it checked something adjacent.

## Scope resolution

The scope is resolved by URN FIRST, id second. Ids survive replication verbatim, so the two normally name the same row; the urn is what survives hand-fill reconciliation, which re-keys a placeholder id onto the authoritative one. When the urn does not resolve, the origin's raw id is stored anyway, which is the honest outcome and not a fail-open: `filterFreezesByScopes` is exact-set membership over a LOCAL containment chain, so a scope this instance has never replicated cannot be an ancestor of any local target — there is nothing here for that freeze to cover, and the row records what the commander declared rather than dropping it. The one case that IS dropped is a raw id that is not a UUID at all, because the column is `uuid` and storing it would abort the bundle (see `uuidStr`).

### §73. URN FIRST, id second

URN FIRST, id second — and the ORDER is what makes the UUID guard tolerant rather than merely strict. A locally-resolved scope contributes a real `objects.id`, so a payload whose raw `scopeObjectId` is malformed still produces an enforceable row when its urn resolves here. Only when NEITHER yields a UUID is the freeze unstorable — `freezes.scope_object_id` is a `uuid` column and there is no honest value left to put in it — and it is skipped like any other malformed entry.

### §74. THE TOMBSTONE SIDE

THE TOMBSTONE SIDE — WHAT STOPS AN IMPORTED FREEZE BLOCKING FOREVER
Lifts the projection row of a `freeze` object that a peer has tombstoned. Called from `federation/import-repo.ts`'s `object_tombstone` branch.

WITHOUT THIS THE TOMBSTONE IS A ONE-WAY DOOR IN THE WORST DIRECTION. `object_tombstone` used to soft-delete the `objects` row and stop, which is correct for every type whose object IS the record — but a freeze's enforcement lives in `freezes`, and nothing there reads `objects`. So the projection row survived its own wire form: `activeFreezesInWindow` kept returning it, every gate and per-target admission kept refusing on it, and it was UNLIFTABLE — `lockFreezeRow` refuses a local lift because the object's origin domain is foreign, and the declaring domain had already spent the only verb that reaches here (a re-snapshot needs a live object to re-snapshot). A commander deleting a freeze object would have permanently frozen its outposts.

A LIFT, NOT A DELETE, for the reason M25.1 settled for the local verb: a lift is SOFT because `gate` and `freeze_admission` Decisions cite `freeze.id` in their `inputContext` forever and that citation has to keep resolving (charter principle 6). Deleting the row would break the explanation of blocks that already happened.

ALREADY-LIFTED ROWS ARE LEFT ALONE (`lifted_at IS NULL` in the WHERE). The first lift is the one that stopped enforcement; overwriting its timestamp and its declaring domain's own reason with a later tombstone would rewrite history to no effect — the freeze is already not in force.

SCOPED TO THE ROW THIS OBJECT OWNS (`object_id = <object>`), the same guard the rebuild's update arm carries, so a tombstone can never reach a locally-authored freeze.

## `apps/server/src/governance/freeze-scope.test.ts`

### §75. The two properties this declares, measured without a db

THE TWO PROPERTIES `freeze-scope.ts` DECLARES, measured without a database.

The set-equality property needs real containment walks and lives in `coordination/freeze-admission.integration.test.ts`. What lives HERE is everything that can be measured by counting: the INERTNESS short-circuit (a claim about how many queries are issued, which no assertion on a return value can see — the function returns the same empty answer either way) and `unionFreezes`'s dedupe/ordering (pure).

THE FAKE `tx` IS THE INSTRUMENT, not a convenience. `containmentChain` is the only thing in this module that calls `tx.execute`, and the two window reads are the only things that call `tx.select` without a `.limit()`, so counting the calls distinguishes "walked nothing" from "walked and found nothing" — which is exactly the distinction the inertness claim is about and exactly the one a real database would hide.

M25.3 ADDED A THIRD AND FOURTH QUERY SHAPE and the fake counts them separately, because the whole point of the inertness property is arithmetic: the instance-tier window read (`selects`, now 2 per call) and `readStageCoordinate`'s two `.limit(1)` lookups (`coordinateReads`, which must stay 0 unless a coordinate-ADDRESSED instance freeze is live). A fake that answered both window reads from one counter would report the post-M25.3 cost as unchanged, which is the vacuous version of this test.

### §76. A transaction that answers two queries and counts them

A `tx` that answers the two queries this module can issue and counts each one.

`selects` counts `activeFreezesInWindow`'s window read; `executes` counts `containmentChain`'s recursive CTE, one per target walked. `chains` supplies the ancestor ids each successive walk reports, IN THE ORDER `freezesByTarget` walks its targets — which the loop guarantees, and which also means a fake that runs out of chains is a walk the test did not expect.

### §77. One org-wide indexed read, and no graph traversal

...and it cost ONE org-wide indexed read and not a single graph traversal. This is the assertion the 1s tick depends on: move a containment walk above the short-circuit, or fold the window read into the loop, and `executes` becomes 4. ...and it cost TWO org-wide indexed reads — one per tier, the instance one over a table that ships empty — and not a single graph traversal or coordinate lookup.

## `apps/server/src/governance/freeze-scope.ts`

### §78. PER-TARGET FREEZE RESOLUTION

PER-TARGET FREEZE RESOLUTION — the primitive M25.2's per-target wave admission is built on (docs/proposals/campaigns-rework.md §1.1(b)).

Until now the only question the freeze path could ask was "is ANY of this wave's scope frozen?": `checkFreeze` unioned every target's containment chain into one `scopeObjectIds` set and got one verdict back, so a freeze over one region parked all four. This module answers the same question one target at a time, and `unionFreezes` folds the answers back into exactly the set the whole-change semantics already consume.

TWO LOAD-BEARING PROPERTIES

1. **INERTNESS.** `activeFreezesInWindow` runs FIRST, org-wide, with no scope filter. If it returns nothing, every target comes back with `freezes: []` and NOT ONE containment chain is walked. That is not an optimisation to be traded away later: this runs for every executing change on the instance on every 1 s tick, and a containment walk is a recursive CTE per target. An org with no active freeze — which is nearly every org nearly all of the time — pays one indexed read on `freezes_org_window` and nothing else. It has its own test, and the test counts queries rather than reading the code.

2. **SET EQUALITY WITH THE OLD PATH.** `unionFreezes(await freezesByTarget(tx, org, T, now))` is set-equal to `activeFreezesForScopes(tx, org, await containmentScopeIds(tx, org, T), now)` BY CONSTRUCTION — `containmentScopeIds` is literally the union of `containmentChain` over each id, and `filterFreezesByScopes` distributes over that union. It is pinned by a test anyway, because "by construction" is a claim about two functions that can be edited independently.

WALK `containmentChain`, PER TARGET, AND NOTHING ELSE
Never a hand-rolled walk and never `[targetObjectId]` alone. `graph/containment.ts`'s header records what both shortcuts cost: three row-returning copies of one walk drifted, one kept a `domain_id`-only route, and a SERVICE-scoped freeze failed OPEN — silently, because a freeze that stops matching produces the same `allow` a freeze that never existed would. A stage-mode wave target is a PLACEMENT, whose chain reaches its component (route 3) and its deployment-target (route 4) and continues up through both; `[targetObjectId]` alone would find only a freeze declared at that exact placement, which nobody has ever authored.

READS ONLY, and takes a `TenantTx` the caller owns — the caller decides what to persist and does it in its own transaction, exactly as `coordination/stage-dependency-hold.ts` does.

### §79. ONE FREEZE IN FORCE, FROM EITHER TIER

ONE FREEZE IN FORCE, FROM EITHER TIER — the discriminated union every consumer of this module now handles (M25.3, owner decision D1).

A DISCRIMINATED UNION AND NOT A FLATTENED ROW, deliberately. The two tiers differ in the one field authorization is decided on: an org freeze carries `scopeObjectId`, the object `freeze:override` is checked at; a platform freeze has none, because object ids are per-org rows and no id names anything in a second tenant. Flattening the two into one shape with a nullable `scopeObjectId` would let `checkFreeze`, `freeze-hold.ts` and the service board each read that null and decide for themselves what it means — and the natural guesses are all wrong (the proposal §2.2 names three: an org-root scope hands every org Administrator the lift of a platform freeze, a synthetic sentinel id makes it un-overridable BY ACCIDENT, and an operator token on the request cannot exist for the case that matters because wave-boundary gates run under `SYSTEM_ACTOR_ID` with no HTTP request in scope). With a union, TypeScript REFUSES to compile a consumer that reads `scopeObjectId` without first asking which tier it is holding.

Every field the whole-change pipeline actually consumes — `id`, `name`, `endsAt`, `reason`, `atomic` — is present on BOTH arms with the same meaning, so the dedupe, the ordering, the `atomic` union and the Decision projections work across tiers with no per-tier branch at all.

### §80. Every target's covering freezes, in the order given

Every target's covering freezes, in the order the targets were given.

`now` is REQUIRED here rather than defaulted, deliberately: the two production callers (`gate-orchestrator.ts`'s `evaluateGovernanceGate` and `coordination/freeze-hold.ts`) each snapshot one instant and use it for the whole evaluation, and a default would let a caller silently evaluate two targets of one wave against two different clocks.

DUPLICATE TARGET IDS produce duplicate entries, one per occurrence, rather than being collapsed. A wave cannot hold the same target twice, so this never arises in production — and collapsing would make the result's length differ from the input's, which is precisely the shape a caller's `frozenIds.length < ctx.targetObjectIds.length` comparison must be able to trust.

### §81. PROPERTY 1 — INERTNESS

PROPERTY 1 — INERTNESS. BOTH window reads come FIRST and short-circuit the whole function together. Do not move a containment walk or a coordinate read above this line, and do not "optimise" either into the loop: two indexed queries are what make a change with nothing frozen cost nothing. M25.3 added exactly ONE query to this regime (the instance-tier window read, over a table that ships empty), and not a single graph traversal.

### §82. THE INSTANCE TIER FIRST

THE INSTANCE TIER FIRST — and the ORDER IS REPORTING, NOT SEMANTICS.
`checkFreeze`'s loop is a universal quantifier and stays order-independent (`unionFreezes` says so and must keep being true). Platform freezes are listed first only so that when a change is covered by both tiers, the reason an operator reads names the one they cannot override rather than the one they can.

### §83. THE ORG TIER

THE ORG TIER — UNION, NOT OVERRIDE. A freeze is a PREDICATE and the merge is an OR.
Note what this loop does NOT do: it never consults the instance tier before walking, and the instance tier never consults it. An org that declared nothing still gets every platform freeze (the empty org set contributes FALSE to an OR), and nothing an org can author subtracts from a platform freeze. The "floor" property lives entirely in the override rule (`instance_freezes.overridable`), never here. Contrast ADR-0016's scan floors, which merge by per-severity MIN because a threshold is a number.

### §84. The union across targets

The union across targets — deduped by freeze id, in a STABLE order (first appearance, targets in the order they were resolved).

This is what whole-change semantics consume, and `gate-orchestrator.ts`'s `checkFreeze` takes it INSTEAD of the per-target map on purpose. `checkFreeze` holds CRITICAL #2 — every active freeze individually overridden by an actor holding `freeze:override` at THAT freeze's own scope — and handing it a flat list means a per-target early return, or a `byTarget[0]` degradation, is not expressible at that call site at all. Checking only `active[0]` was a shipped bug once; the fix is structural rather than a comment asking the next reader not to reintroduce it.

Order is stable but NOT semantically meaningful: the override loop is a universal quantifier and must stay order-independent. The stability is here so a Decision built from this list cannot churn because a wave's targets came back in a different order.

### §85. IS THIS COVERING SET ELIGIBLE FOR THE D7 ROLLBACK EXEMPTION?

IS THIS COVERING SET ELIGIBLE FOR THE D7 ROLLBACK EXEMPTION? — pure, and the ONE definition both D7 seams consult (`gate-orchestrator.ts`'s `freezeExemptRollback` and `reconcile.ts`'s per-target `continue`).

D7 IS AN ORG-TIER DECISION AND A PLATFORM FREEZE IS NEVER STOOD ASIDE FOR A ROLLBACK
Owner decision D7 exempts a rollback from a freeze because holding one PINS A BROKEN RELEASE in place for the whole window, and `scp change rollback` is the documented exit. That reasoning is about a freeze the tenant's own organization declared — the org can weigh "broken release" against "change window" because it owns both sides of the trade.

It does not carry above org, and shipping it as written was a HOLE. `POST /v1/changes/{id}/ rollback` requires `object:write` at the org and nothing else: no `freeze:override`, no reason, no operator token. A tier-blind D7 therefore handed every principal who can write an object a route past the one freeze the block sentence three files away promises "no tenant role can override, however privileged" — a route CHEAPER than the override it was contrasted with, not merely equal to it. Two things cannot both be true, so this makes the sentence the true one.

`overridable` IS DELIBERATELY NOT CONSULTED HERE, and this is the sharp edge of the decision. It would read as the natural mapping — the operator has admitted tenant override, so admit the rollback too — and it is wrong, because the two are not the same act. `overridable` admits a REASONED override by an actor holding `freeze:override` AT THE ORG ROOT (two independent authorities, both required, and the reason is audited on the Decision). The rollback path checks none of that. Mapping one bit onto both would mean an operator who admitted a narrow, audited, high-privilege escape had silently also admitted an unaudited one at `object:write`. So `overridable` keeps exactly one meaning, and a platform freeze holds rollbacks in both settings.

THE OPERATOR'S REMEDY IS THE ONE THE BLOCK SENTENCE ALREADY NAMES: `PUT`/`DELETE /v1/instance/freezes/{key}` shortens or retracts the freeze, over the operator token. A platform freeze that must let emergency rollbacks through is a freeze that should not have been declared deployment-wide, or should be lifted — not one a tenant works around.

STATED CONSEQUENCE, because it is the one place D7 NARROWS: a rollback wave covered by BOTH tiers is blocked WHOLE rather than admitted for the targets only an org freeze covers. Coarse, and chosen over the finer alternative (resolve the tiers separately for a rollback and hold only the platform-covered targets) because the finer one needs a second resolution pass whose result `frozenTargets`, `partiallyFrozen` and the hold Decision would all have to agree with — a second source of truth about what is frozen, which is precisely what `freezesByTarget` exists to be the only one of. A wave containing a platform-frozen target cannot complete this window either way.

Takes the projected shape (`{ tier }`) rather than `EffectiveFreeze`, because `reconcile.ts` holds `FreezeHoldVerdict["freezes"]` — the Decision projection — and passing that through the same predicate is what makes the two seams provably one rule instead of two that agree today.

## `apps/server/src/governance/freezes-repo.ts`

### §86. Freeze windows (DESIGN §10.3)

Freeze windows (DESIGN §10.3): "a built-in policy effect with time windows and scope (org/domain/service/component)." A dedicated projection table (db/schema.ts's doc comment) — `governance/gate-orchestrator.ts`'s `checkFreeze` queries this directly rather than folding freezes into the policy-document model, since a freeze's scope/window semantics ("does this window cover this object, right now") don't need CEL at all — a freeze either covers the target or it doesn't. (`coordination/gates.ts` is the thin adapter above that orchestrator; it does not touch this file.)

### §87. M25.2 / owner decision D5 — `true` parks the WHOLE wave

M25.2 / owner decision D5 — `true` parks the WHOLE wave (pre-M25.2 behaviour), `false` (the default) admits the wave's uncovered targets and holds only the covered ones.

READ IN TWO PLACES, AND IT MUST BE BOTH: `gate-orchestrator.ts`'s `partiallyFrozen` predicate (the wave boundary) and `coordination/freeze-hold.ts`'s `evaluateFreezeHolds` (every tick of the trigger loop). The gate fires exactly ONCE, on `pending -> running`, so a gate-only reader makes `atomic` silently degrade to per-target for any freeze that opens after the wave started — which is the very case M25.2's second half exists to fix.

### §88. THE WINDOW-ORDER INVARIANT, in one place

THE WINDOW-ORDER INVARIANT, in one place — `endsAt` must be strictly after `startsAt`.

Extracted in M25.1 because `PATCH /freezes/{id}` is a SECOND writer of `ends_at` and a second copy of this comparison is exactly the drift `activeFreezesInWindow`'s header is about, one comparison over: a PATCH that admitted `endsAt <= startsAt` would leave a row `createFreeze` refuses to produce, which the half-open window predicate then reads as permanently inactive without anyone having lifted it.

Throws `badRequest`, not `notFound`. It was `notFound` before this increment — a copy-paste that would have reported a malformed window as a missing freeze to any caller that did not pre-check; the route pre-checked, so it was never observable, which is why it survived.

### §89. `getFreeze` UNDER A ROW LOCK

`getFreeze` UNDER A ROW LOCK — the read half of every read-modify-write in this file.

BOTH WRITE VERBS ARE READ-MODIFY-WRITES, and both put the value they read into a PERMANENT RECORD: `updateFreezeWindow` derives `direction` from `before.endsAt` and the route writes `endsAt: { from, to }` into a Decision, while `liftFreeze` names `before.liftedAt` in its conflict message. Under READ COMMITTED an UNLOCKED read is a stale snapshot the whole way to COMMIT: two operators PATCH one freeze, both read `endsAt = T`, A commits `T1`, B's UPDATE then blocks on the row lock, re-checks only `lifted_at IS NULL`, and writes `T2` from B's stale snapshot. B's audit record then says "from T" — a window that was never live at the moment B edited it — and, if `T < T1 < T2`, is stamped `freeze.window.extended` for an edit that actually SHORTENED the live window. That is a hash-chained governance record asserting the opposite of what happened, which principle 6 does not survive.

`FOR UPDATE` parks the second transaction AT THE READ rather than at the UPDATE, so `before` is whatever A committed and the direction and the audited `from` are both computed against the value that was actually in force. Neither edit is lost and neither is refused. Same instrument, same reason, as `coordination/transition.ts` (change rows), `graph/objects-repo.ts`'s `lockObjectRow` and `dependencies/version-poll.ts`'s declaration re-read.

NOT exported: an unlocked `getFreeze` is right for the two READ routes (`GET /freezes/{id}` and the list), and taking a write lock there would serialize readers behind an editor for nothing.

M25.7 — AND IT IS ALSO THE SINGLE-WRITER DOOR: AN OUTPOST CANNOT LIFT A COMMANDER FREEZE
The replica check lives HERE, in the read half both verbs already share, and not in `liftFreeze` and `updateFreezeWindow` separately. Two copies of one refusal is this repo's most-repeated defect (CLAUDE.md's census rule), and the asymmetric version is worse than either: a lift that is refused while a window edit is not lets an outpost push a commander's `ends_at` to a past instant and achieve the retraction it was refused, through a verb nobody thought to guard. Installed at the shared read, a third write verb inherits it without being asked to.

The AUTHORITY is `graph/objects-repo.ts`'s, unchanged and not re-implemented: the object either is or is not this domain's, exactly as `federation/outpost-config-sync.integration.test.ts` case 2 already proves for `outpost` config. What this adds is that the PROJECTION row cannot be edited around it — the guard on `objects` would otherwise protect only the wire form while `freezes.lifted_at`, the column `activeFreezesInWindow` actually filters on, stayed locally writable. The remedy at a replica is `freeze:override` at that freeze's own scope: per-change, reasoned, audited (`gate-orchestrator.ts`'s CRITICAL #2 loop) — never deletion of a protection another domain declared.

### §90. Refuses a local write to a freeze another domain owns

Refuses a local write to a freeze whose graph object is authoritatively owned by another domain.

A NO-OP FOR EVERY NON-FEDERATING FREEZE (`object_id IS NULL`), which is the default, the whole pre-M25.7 estate, and therefore every existing test: `ensureFederationSelf` is not even reached, so a single-domain instance pays nothing and behaves byte-identically.

An `object_id` that resolves to no row returns rather than throwing. It is unreachable — `scp_app` is never granted DELETE on `objects` (DESIGN §4.1), so the referent is at worst soft-deleted and the row is still selected here — and turning an unreachable state into a hard refusal would make a freeze permanently un-liftable on the strength of a condition nobody can produce or clear.

### §91. EVERY freeze in the org whose window covers `at`

EVERY freeze in the org whose window covers `at` — no scope filter at all.

THE ONLY PLACE THAT KNOWS THE WINDOW PREDICATE (`starts_at <= at < ends_at`), and that is the whole reason it is a function rather than an inlined `where`. `graph/containment.ts`'s header records what a second copy of one idea costs here specifically: three row-returning copies of the containment walk drifted, one of them kept a `domain_id`-only walk, and a service-scoped freeze failed OPEN as a result. A second copy of the *window* predicate is the same hazard one column over — the half-open boundary (`lte` on the start, `gt` on the end) is exactly the kind of detail two copies stop agreeing about, and both directions of that disagreement are silent.

Served by the `freezes_org_window` index. Returns [] for an org with no active freeze, which is the overwhelmingly common case and the one `freeze-scope.ts`'s INERTNESS property is built on: this query runs before any containment walk, so an org with nothing frozen pays one indexed read per change per tick and not a single graph traversal.

EXPIRY IS THIS PREDICATE AND NOTHING ELSE. There is no sweeper and no status column: the first tick after `ends_at` a freeze simply stops being returned here. See `scan-override-grants.ts`, which followed this file for the same reason.

M25.1 — AND `lifted_at IS NULL`, THE ONLY LIVENESS FILTER IN THE SYSTEM
A freeze can now be RETRACTED before its window closes (`liftFreeze`, `DELETE /freezes/{id}`), and that retraction is a soft one: the row stays, permanently readable by id, because two Decision writers carry `freeze.id` in their `inputContext` and a hard delete would dangle every one of them (charter principle 6).

The filter belongs HERE and nowhere else, for the same reason the window predicate does. Every consumer of "is this freeze in force" composes over this function — `activeFreezesForScopes`, `freeze-scope.ts`'s `freezesByTarget`, and through them `checkFreeze`, `evaluateFreezeHolds` and the service board's freeze resolution — so one `isNull` retires a freeze on every path at once, INCLUDING the release path: `reconcile.ts`'s per-target loop simply stops seeing a hold and `clearFreezeAdmissionHold` writes its `allow` row on the next tick, with no lift-specific code anywhere in reconcile. A second liveness filter added elsewhere would be free to disagree with this one, silently and in either direction — the shape that once made a service-scoped freeze fail OPEN (`graph/containment.ts`'s header).

The index is deliberately unchanged: `freezes_org_window` already narrows to freezes covering this instant, which is zero rows for nearly every org nearly all the time, so this is a filter over a handful of rows at most.

### §92. The window predicate itself, column-generic for reuse

M25.3 — THE WINDOW PREDICATE ITSELF, COLUMN-GENERIC, SO TWO TABLES CAN SHARE ONE COPY
`starts_at <= at < ends_at AND lifted_at IS NULL`, half-open on purpose: a freeze whose `ends_at` is exactly `at` is over.

The instance-scoped tier (drizzle/0086, `instance-freezes-repo.ts`) is a SECOND TABLE, and a second table cannot share the first's `where` clause. It could only have shared the RULE, and the choices were to write the comparison out again there or to factor it here. Everything `activeFreezesInWindow`'s docblock says about a second copy applies verbatim — the half-open boundary is exactly the detail two copies stop agreeing about, in either direction, silently, and `service-board.ts` has already hand-rolled this comparison once. So the claim above ("THE ONLY PLACE THAT KNOWS THE WINDOW PREDICATE") stays TRUE and simply moved one level down: both tiers' reads are built from this fragment, and neither spells `lte`/`gt`/`isNull` itself.

Deliberately NOT parameterised on the org filter: the org tier has one and the instance tier structurally cannot (no `org_id` column — the DESIGN §4.2 exception). Folding an optional org predicate in here would let a caller omit it by passing `undefined`, which at the ORG tier is a cross-tenant read. The caller `and()`s its own tenancy filter, where forgetting it is visible.

### §93. THE MEMBERSHIP RULE

THE MEMBERSHIP RULE — pure, no database, unit-testable on its own.

EXACT-SET MEMBERSHIP, NOT CONTAINMENT, and that contract is the dangerous half of this file: this function does no walking whatsoever, so any id the caller omits from `scopeObjectIds` is a freeze that silently does not block. Callers must build the set with `graph/containment.ts`'s `containmentScopeIds` (or, per target, `containmentChain`), which walks BOTH containment routes. A caller that hand-rolled a `domain_id`-only walk omitted the target's SERVICE, and a service-scoped freeze failed OPEN — the incident `graph/containment.ts` exists to have ended. If you give this function ids from anywhere else, walk every route first.

### §94. Freezes active RIGHT NOW

Freezes active RIGHT NOW (`at`) whose scope is one of `scopeObjectIds` — the caller passes the target's full containment chain (org/domain/service/component ids) so a freeze declared at any containment level is found regardless of which exact object the gate check is evaluating.

THE COMPOSITION of the two functions above, and byte-identical in behaviour to the single function it replaced: same half-open window, same exact-set membership, same empty-input short circuit, same order (the window query has no `ORDER BY` and the filter preserves whatever it returns — `checkFreeze`'s override loop is order-independent by construction and must stay so). Read `filterFreezesByScopes`'s warning before calling it: this function inherits every word of it, including that any omitted id is a freeze that silently does not block.

`governance/freeze-scope.ts`'s `freezesByTarget` answers the SAME question per target, and the two are set-equal by construction because `containmentScopeIds` IS the union of the per-target chains. That equality is pinned by a test; if you change either, change both.

### §95. The two write verbs that were missing

M25.1 — THE TWO WRITE VERBS THAT WERE MISSING

`/api/v1/freezes` shipped as CREATE / LIST / GET. A freeze could be declared and never retracted or shortened, which was survivable only while a freeze parked a WHOLE wave: the operator waited for `ends_at` and the release resumed. M25.2 made it unsurvivable — a far-future `ends_at` now holds a SUBSET of a wave's targets while the siblings have shipped, so a mistyped year leaves a fleet split across two versions with no API exit. The only escapes were `scp change cancel` / `scp change rollback`, which throw the RELEASE away, not the FREEZE.

BOTH VERBS TAKE `freeze:write` AT THE FREEZE'S OWN SCOPE, and — M25.9 / owner ruling D1(a-ii), 2026-08-25 — `freeze:override` ON TOP whenever the acting subject is not the freeze's `created_by_actor_id`. That second bar covers the LIFT and a window edit that SHORTENS; extending someone else's freeze ADDS protection and stays `freeze:write`, as does either verb on your own freeze. The routes enforce all of it (this file never authorizes — same split as everywhere else in the repo layer): see `assertMayRetractAnothersFreeze` in `routes/governance.ts`, which is the one place the rule is spelled, and the lift route's docblock for the reasoning.

### §96. RETRACT a freeze

RETRACT a freeze: it stops being in force immediately, whatever `ends_at` says.

A SOFT lift (drizzle/0085). The row stays and stays readable by id, because `gate-orchestrator.ts`'s freeze-block Decision carries `inputContext.freeze.id` and `reconcile.ts`'s `recordFreezeAdmissionHold` carries `inputContext.held[].freezes[].id`, both permanently. A hard delete would make `scp change explain` name an id that resolves to nothing — precisely the question ("what was this freeze that blocked me?") that charter principle 6 exists to keep answerable.

NOT EXPRESSIBLE AS `ends_at = now()`, which is why this needed a column at all: a freeze SCHEDULED for next week has `starts_at` in the future, so that assignment would produce `ends_at < starts_at` — a row violating the invariant `assertWindowOrdered` enforces on both write paths. A scheduled freeze declared by mistake is exactly the freeze someone needs to retract, so the encoding has to cover it.

IDEMPOTENT? NO — a second lift is a `conflict`, deliberately. `lifted_at`, `lifted_by_actor_id` and `lift_reason` are a single record of WHO retracted this and WHY; silently letting a second caller overwrite them would replace the operator who actually lifted it (and their reason) with whoever repeated the call, and the audit event pair would then disagree with the row. The conditional `UPDATE ... WHERE lifted_at IS NULL` makes that a race-free refusal rather than a read-then-write check.

### §97. Loaded first, so an unknown id is a 404 not a 409

Loaded first so an unknown id is a 404 rather than the 409 the no-op UPDATE below would otherwise produce, and so the caller gets the BEFORE row for its audit event and Decision. UNDER `FOR UPDATE` (`lockFreezeRow`): the conditional UPDATE below already makes a double lift a race-free REFUSAL, but the refusal's message quotes `before.liftedAt`, and an unlocked read that raced the winning lift would report "already lifted at undefined" — naming no instant and no operator, in the one message whose entire job is to say who got there first.

### §98. Which way a window edit moved, for the audit record

Which way a window edit moved, for the audit event and the Decision. A SHORTENING is a governance LOOSENING (the freeze stops protecting sooner); an EXTENSION is a TIGHTENING. Both need `freeze:write` at the freeze's own scope, and a SHORTENING additionally needs `freeze:override` when the freeze was declared by another actor (M25.9 / owner ruling D1(a-ii) — ending someone else's protection early is the same act as retracting it). An EXTENSION never does: it takes nothing from anyone the freeze covers. THIS LABEL IS THEREFORE AN AUTHORIZATION INPUT, not only a record — `routes/governance.ts`'s PATCH handler branches the second bar on it, and computes it AFTER `updateFreezeWindow` has taken the row lock, because a direction computed from an unlocked read is decidable against a window that is no longer live. Beyond that, the two directions are distinguished because "who made governance weaker, and when" is the question an audit log is read with.

`"unchanged"` IS A THIRD CASE AND NOT A ROUNDING ERROR. A comparison written as `endsAt < before.endsAt ? "shortened" : "extended"` — which is how this shipped — folds equality into the wrong arm: `PATCH { endsAt: <the value it already has> }` is an ordinary thing for a form-backed UI to send on save, and it wrote a hash-chained `freeze.window.extended` event, plus a Decision asserting an extension, with `from === to`. Nothing was extended. Refusing the call instead would be equally truthful and worse to use, so the third label is the answer: the record says what happened, and `loosening` stays false because no protection was weakened.

### §99. Move a freeze's `ends_at`, in EITHER direction

Move a freeze's `ends_at`, in EITHER direction.

SHORTENING to a past instant is left as an ordinary window edit and is NOT silently re-labelled a lift. It has the same effect on admission — the freeze leaves the half-open window and every consumer of `activeFreezesInWindow` stops seeing it on the next read — and a different record, which is the truth: the operator said "this ends sooner", not "I retract this". The distinction is not academic, because it is reversible (a later PATCH can push `ends_at` forward again and the freeze returns) where a lift is not.

`startsAt` is deliberately NOT editable. Moving the start of a window that is already open is either a no-op or a rewriting of history — "this freeze was in force from a time it was not" — and neither is a thing an operator has asked for. `endsAt` is the whole of the escape hatch M25.1 exists to provide.

REFUSED ON A LIFTED FREEZE (`conflict`). Extending one would produce a row whose `ends_at` promises protection that `lifted_at` cancels, readable either way by anyone who does not know which filter wins; the honest answer is that a retraction is final and a new freeze is one POST away.

## `apps/server/src/governance/gate-orchestrator.ts`

### §100. The orchestrator every gate check

The orchestrator every gate check (lifecycle-edge AND wave-boundary) funnels through — where freezes, policy resolution, control outcomes, and approval quorum all come together into ONE verdict. `coordination/gates.ts` (M3's seam) is the thin adapter that calls this with the (fromState/toState) or (waveIndex/topologyObjectId) framing the guarded transition function/reconcile loop already speak.

**Host-optional by design** (DESIGN §16's api/worker split — a `role=api` process has no `PluginHost`, per `control-runner.ts`'s module doc): pass `host: null` from a call site that cannot run a control inline (the lifecycle-edge gate, called from an HTTP route handler); pass a real `PluginHost` from a call site that can (the wave-boundary gate, called from `coordination/reconcile.ts`, which always has one). With `host: null`, a required control with no existing outcome is simply treated as unsatisfied (blocks) rather than attempted — never a silent pass, and never a synchronous plugin call from the request-serving tier.

### §101. Set when the caller attempts an explicit override

Set when the caller is attempting an explicit freeze override (mandatory reason — DESIGN §10.3). Every ACTIVE freeze over the change's scope must be individually overridden by an actor holding `freeze:override` at THAT freeze's own scope (CRITICAL #2). A rejected override (missing reason, or unauthorized for some active freeze) is NOT thrown — it becomes a "block" verdict so `coordination/transition.ts` writes the Decision + audit with a resolvable `decision_id`, exactly like every other block path (MAJOR #6).

### §102. This change is a rollback, so a freeze does not hold

M25.2 / owner decision D7 — this Change IS a rollback, so an active freeze does not block it. NARROW BY CONSTRUCTION: it lifts the FREEZE check and nothing else. Policies, controls and approvals are evaluated for a rollback's wave exactly as before, because a rollback can still be the wrong thing to ship and those mechanisms have humans behind them; a freeze is a calendar window, and holding a rollback behind one pins a broken release in place until it closes.

Only ever set on the `wave_boundary` path. The `lifecycle_edge` path never sees a rollback at all — `coordination/gates.ts` returns an unconditional allow for one BEFORE calling this orchestrator (DESIGN §9.4).

### §103. Per-target freeze coverage, populated only at the wave

M25.2 — per-target freeze coverage, POPULATED ONLY AT `wave_boundary`.

Present (and possibly all-empty) when the gate ran the per-target resolution; absent on the `lifecycle_edge` path, which deliberately keeps any-target-frozen => block. A non-empty `freezes` on an entry means that target is covered; the wave gate may still ALLOW, because M25.2 moved ENFORCEMENT to `coordination/reconcile.ts`'s per-target trigger loop and left only the all-frozen case as a whole-wave block.

AN INTERNAL TS TYPE, never a wire schema: no codegen, no OpenAPI surface, no oasdiff exposure. If this ever needs to reach an operator it goes through a derived read-model field computed from the standing `freeze_admission` Decision, not through this.

### §104. CRITICAL #2 / MAJOR #6

CRITICAL #2 / MAJOR #6: the change proceeds only if EVERY active freeze over its scope is INDIVIDUALLY overridden by an actor holding `freeze:override` at THAT freeze's own scope, with a non-empty reason. `activeFreezesForScopes` has no ORDER BY and can return several — checking only `active[0]` let a narrow-scope override holder slip a change past a broader freeze they had no authority over. Never throws: a rejected override (no override requested, missing reason, or unauthorized for some freeze) returns `blocked` so the caller writes a Decision + audit with a resolvable `decision_id` (the freeze-block Decision), instead of a raw `forbidden()` that rolls that record back.

### §105. The union of per-target freezes replaces the scope query

M25.2: `unionFreezes(byTarget)` REPLACES `activeFreezesForScopes(containmentScopeIds(...))`, and the two are set-equal by construction — `containmentScopeIds` IS the union of the per-target `containmentChain` walks `freezesByTarget` performs, and exact-set membership distributes over that union (`freeze-scope.ts`, pinned by a test). Both walks reach BOTH containment routes (domain_id AND the `contains` edge, plus a placement's component and deployment-target), which is what makes a freeze declared at a SERVICE block a change targeting that service's component. A domain_id-only walk here failed OPEN: membership is EXACT, so a service id absent from the set is a service-scoped freeze silently not found.

WHY THIS FUNCTION TAKES THE FLAT LIST AND NEVER THE MAP. Everything below is CRITICAL #2 — EVERY active freeze individually overridden by an actor holding `freeze:override` at THAT freeze's own scope. Checking only `active[0]` was a shipped bug. Handing this function a flat, deduped list means a per-target early return, or a `byTarget[0]` degradation, is not EXPRESSIBLE here: the per-target dimension does not exist at this call site. That is the structural preservation of the invariant, chosen deliberately over extracting the quantifier into something a caller could accidentally narrow. The loop's text below is unchanged.

### §106. M25.3 — THE PLATFORM TIER'S OVERRIDE RULING

M25.3 — THE PLATFORM TIER'S OVERRIDE RULING (proposal §2.2, owner decision D1)
AN INSTANCE-TIER FREEZE IS NOT OVERRIDABLE BY ANY TENANT ROLE, HOWEVER PRIVILEGED — not by an org-root Owner, not by anyone. It was declared by this deployment's OPERATOR, about the deployment, binding every org on it; the whole authority argument for the operator door (ADR-0033 §7a: "no RBAC permission can grant this") collapses if a tenant admin can step past it.

This branch is INSIDE the universal quantifier rather than a pass ahead of it, and that is the point: CRITICAL #2 is "EVERY active freeze individually satisfied", and `active` is now the UNION OF BOTH TIERS. A change covered by an org freeze AND a platform freeze must satisfy both, and neither tier can short-circuit the other, because there is only one loop and it returns on the first freeze it cannot satisfy. A separate "platform pass first" — which is what the proposal sketched — would have re-created the `active[0]` shape the loop exists to make inexpressible, one tier up.

### §107. WHERE `freeze:override` IS CHECKED. Org tier

WHERE `freeze:override` IS CHECKED. Org tier: the freeze's OWN scope, unchanged since CRITICAL #2 — a narrow-scope holder must not slip a change past a broader freeze. Platform tier, and only once the operator has set `overridable`: the ORG ROOT, the widest scope a tenant has, because the freeze binds the whole org and there is no narrower object it could honestly be checked at. Note the two authorities stay independent and BOTH are required — the operator admits the override by setting the bit, the tenant must still hold the permission at its root and still must supply a reason.

### §108. The object a condition should see as its subject

The object a CEL condition should see as `subject`, and whose graph facts it should read, for a given gate target (ADR-0026).

A wave target is a COMPONENT under legacy compilation and a PLACEMENT under stage-shaped compilation. `containmentChain` now walks from a placement up through its component, so every SCOPE question (policy match, freeze, approval scope, scan tiers) is answered identically for both shapes — but two things in this file read the target OBJECT rather than its chain, and they do not follow:

```text
- `subject` in the CEL context — a placement's `typeId` is `"placement"` and it carries the
  pair's labels, not the component's. `subject.typeId == "component"` or a
  `subject.labels.tier` condition would silently evaluate FALSE, so the policy stops firing and
  the gate allows. A condition that stops matching is indistinguishable, from the verdict, from
  a condition that was never meant to match.
- `graph.ownerIds` / `graph.dependentIds` — `owns` and `depends_on` edges attach to the
  component. A placement has neither, so an ownership- or blast-radius-conditioned policy sees
  an empty set and stops firing too.
```

The subject of a placement is the component it places: the software being released is the same software wherever it runs, and every one of those facts is deliberately stored once on the component (ADR-0026 §3's split table). WHERE it is being released stays visible — the gate's `targetObjectIds`, its Decision and its control context still name the placement itself, so explainability keeps the place and only the subject-shaped questions hop.

A non-placement id is returned unchanged, so this is a pure extension: legacy compilation, the lifecycle-edge gate and campaign waves (which never compile stage-shaped) all resolve to exactly what they resolved before.

### §109. Read from the PROPERTIES

Read from the PROPERTIES — the source of truth for the pair (ADR-0026 D17), the same half `binding-resolution.ts`, `plan-service.ts` and `graph/containment.ts`'s route 3 read.

The UUID SHAPE CHECK is the same guard, for the same reason, as route 3's `CASE`: journal replay calls `createObject` directly and never passes the typed `/placements` route, so a corrupt or hostile peer can ship a placement whose `componentId` is not a UUID. Returning it would hand a non-UUID straight to `graphFactsFor`'s parameterised `to_id` comparison, and Postgres throws `invalid input syntax for type uuid` — turning one bad row into an ERRORING gate for every change that touches it. This was NOT reasoned out; the malformed-pair test found it after the route-3 guard was already in place, which is the whole argument for writing that test.

### §110. Every graph fact the context carries beyond the target

Every graph fact `governance/evaluate.ts`'s context carries beyond the target itself — MVP keeps this cheap (direct `owns`/`depends_on` edges only, not transitive closures) since the named `impact-of`/`owners-of` queries already cover the deep-traversal case for humans; policy conditions needing more can call those via a future CEL custom function without a context shape change.

### §111. Scope keyword to the object type an ancestor carries

Scope-KIND keyword → the `object_types.id` an ancestor of that kind carries. `organization` is special-cased to the org root object below (whose id === orgId).

`assembly` ADDED 2026-08-17 (M22.0, ADR-0033 §5). It is a real container rung (migration 0055, `CONTAINER_TYPES = ["service","assembly"]`, legal chain `service -> assembly -> component`) that shipped AFTER this map was written. `containmentChain` walks it for free — it matches on the `contains` EDGE, never on the parent's type — but `nearestAncestorOfKind` below can only find a kind this map names, so `requireApprovals: {scope: "assembly"}` resolved to `null` and became a PERMANENTLY UNSATISFIABLE required approval: fail-closed, but silently inexpressible, and prewarm never materialized the request so no human could vote it through either.

THIS ENTRY IS A LOOSENING FOR EXISTING DATA, and is the one line in M22.0 that is not behaviour-neutral. Any `requireApprovals: {scope: "assembly"}` authored before today blocks unconditionally; afterwards it becomes satisfiable by the authored quorum. That is the author's declared intent finally taking effect rather than a regression — but an operator whose change has been parked behind an inexpressible approval will see it become approvable, so it is called out here and in the PR rather than shipped quietly.

WALKING a rung is edge-generic and free; NAMING one is not. This map and `governance/scan-requirements.ts`'s `tierForObjectType` are the two hardcoded rung lists that migration 0055 silently missed. A third container level must revisit both.

### §112. Resolves a `requireApprovals.scope` value

Resolves a `requireApprovals.scope` value (MAJOR #5). DESIGN §10.1's own example writes a scope KIND keyword (`"scope":"service"`), meaning "someone holding `fromRole` at the change target's containing object of that kind"; an author may equally pass a literal object id/urn. Returns the concrete object id the approval quorum's `hasRoleAtScope` check will run against, or `null` when the scope can't be resolved (unknown keyword, a keyword with no ancestor of that kind on the target's chain, or a literal ref that doesn't resolve) — the caller treats `null` as an UNSATISFIABLE required approval (fail closed), never a raw `::uuid` cast crash and never a pass.

`hasRoleAtScope` (authz/resolve.ts) expands the SAME two containment routes from whatever id this returns, so an Approver bound at the org root is eligible for a service-resolved scope too — the keyword picks the scope, it does not narrow who may vote to exactly-that-object bindings.

### §113. The target's containment chain, walked by BOTH routes

The target's containment chain, walked by BOTH routes (`graph/containment.ts`) — then the NEAREST ancestor carrying the requested kind. A domain_id-only walk here failed CLOSED for the `"scope":"service"` keyword DESIGN §10.1 itself gives as the example: services and components are siblings under a domain, so no ancestor of kind 'service' was ever found, the required approval became permanently unsatisfiable, and prewarm skipped materializing the request — so no human could vote it through either.

### §114. The digest the change is PROMOTING

The digest the change is PROMOTING — its own tracked artifact digest, read from the change row's `sourceRef.artifact_digest` (DESIGN §9.1's projection jsonb: `{repo, ref, commit, run_url, workspace, artifact_digest, …}`). Threaded into every control-run context as `context.artifactDigest` so a digest-binding control (scan-result-control, ADR-0013 "nothing slipped in") binds its verdict to the CHANGE's REAL artifact — not to an operator-typed value on the control binding, which the same `policy:write` author configures alongside the scan source (a tautology). When the change tracks NO digest this returns `undefined`: leave `context.artifactDigest` unset (never invent one) so the control falls back to its own operator-pinned `config.expectedDigest`, a documented degraded/override path. Best-effort — a missing change row or malformed `sourceRef` yields `undefined`, never a throw (this only ENRICHES the gate context; it must never itself turn a gate into an error).

### §115. The row-free half of {@link resolveChangeArtifactDigest}

The row-free half of `resolveChangeArtifactDigest` — the SHARED reader (`coordination/artifact-facts.ts`), the same keys in the same order the export projection and the pipeline tile read (`artifact_digest` / `artifactDigest` / the importer's `artifactDigests[]`); the FIRST non-empty digest is the one a single-digest binding uses.

EXPORTED so `coordination/pipeline-hook-gate.ts` binds its `postDeploy` / `bakeAlarms` evidence lookups to the SAME digest a control context binds to. Two readings of "which artifact is this change about" is how a gate ends up asking about different bytes than the control beside it.

### §116. M10.4 (`github-check` ControlPlugin)

M10.4 (`github-check` ControlPlugin) — the commit SHA the change originated from, threaded into every control-run context as `context.commitSha` exactly like `resolveChangeArtifactDigest` threads `context.artifactDigest`: so a commit-binding control (github-check, "CI green for THIS change's commit") binds its verdict to the change's REAL source commit, not to an operator-typed value on the control binding alone.

Unlike `artifact_digest`/`sbom`, `webhook-processor.ts`'s `canonicalizeSourceRef` lifts no canonical `commit_sha` key today — `sourceRef` is the raw delivery payload verbatim (DESIGN §8), whose shape differs per source kind. This reads the handful of field names the in-tree git providers' raw payloads actually use for the commit that triggered the change: `sha`/ `commit_sha`/`commitSha` (the flat first-party report shape), GitHub push's `after` or `head_commit.id`, and GitLab's `checkout_sha`. Best-effort, exactly like `resolveChangeArtifactDigest`: a missing/malformed field yields `undefined` (never a throw), so a control this enriches simply falls back to its own operator-pinned config.

### §117. The row-free half, and the one definition of which sha

The row-free half of `resolveChangeCommitSha`, and the ONE definition of "which commit is this change about" that reads a `source_ref`.

EXPORTED so `coordination/pipeline-hook-gate.ts` binds `postMerge` evidence to the same commit a `github-check` control binds to — `postMerge` runs before any artifact exists, so the COMMIT is its only binding (`pipeline_evidence.artifact_digest`'s column doc). The key list is pinned to what `webhook-processor.ts`'s `commitShaFromPayload` WRITES; a key one of them knows and the other does not is a gate asked about nothing.

### §118. The single control-run context shape both gate sites

The single control-run context shape both gate sites (prewarm + evaluate) build, so they agree on what a control sees. `artifactDigest` is included ONLY when the change tracks one — its absence is meaningful (the control then uses its operator-pinned fallback), so it is never keyed to `undefined`. M10.4 threads `commitSha` the same way, for `github-check`.

M17.5 (ADR-0016) threads `scanThreshold` through the SAME conditional-context mechanism, on purpose: the resolved most-restrictive-wins ceiling across the six scan-requirement tiers is another gate-computed FACT the control needs, exactly like the change's real artifact digest, and ADR-0016 §4 names this shipped pattern as the one design (A) reuses rather than inventing a second mechanism. Absent when NO tier contributes a ceiling — the control then falls back to its per-binding `config.threshold`, the unchanged M17.1 behaviour.

### §119. The resolved exclusion set, shaped for the Decision

M22.2 (ADR-0033 §11) — the resolved exclusion set, shaped for the gate's DECISION `inputContext`.

The RULE and the EXCEPTION TO IT belong in the same Decision. M22.0 put the ceiling there precisely so no exception could later hide inside evidence; landing the exclusion dimension without also landing it here would re-open that hole one increment after closing it.

This records what the gate ADMITTED, not what was ultimately APPLIED — the application happens inside the control, against findings this function has never seen, and lands in `control_runs.evidence.exclusions`. Both halves are needed: "which loosenings were in force" is a governance fact about the change, "which findings they touched" is a fact about one scan.

SAME DETERMINISM RULE AS `scanThresholdForDecision`, and for the same measured reason: `restatesDecision` canonicalises key order but PRESERVES array order, so an unsorted array defeats `insertDecisionIfChanged` and re-opens the 1.44 GB/day write amplification. The resolver already returns `clauses` sorted by content; every entry here is rebuilt with a FIXED key order and carries no timestamp, no row id, and nothing else that varies between two identical evaluations.

### §120. The facts the vendor rule was resolved against

M22.4 — the FACTS the vendor rule was resolved against, not just the clause that invoked it. "Passed because the component is on the latest of that major line" is only auditable if the Decision says WHICH lines were at their head when the gate looked; a clause alone would say that a rule was in force and nothing about what it found. Present only when a `vendor_latest` clause survived, and already content-sorted by the resolver — no timestamp and no row id, so two identical evaluations still compare equal.

### §121. M22.5 (ADR-0033 §6 guard 2) — THE DECLARED VALUE, VERBATIM

M22.5 (ADR-0033 §6 guard 2) — THE DECLARED VALUE, VERBATIM. This is the guard that makes D2's accepted escalation seam auditable: a reader of this Decision sees "component X asserted `egress: none`", not merely that a `declared_fact` clause was in force. It is also the only defence available against the residual hazard D2 cannot remove — the declaration is read live from a tenant-writable bag and can be flipped for the duration of one gate — since pinning the value here makes the flip visible after the fact.

### §122. Every applied exclusion must name its clause and tier

M22.6 (ADR-0033 §11) — every applied exclusion must name "its clause, admitting tier, AUTHORITY and EXPIRY". The clause and the admitting tier are above; the authority and the expiry are here, and they are facts about the grant rather than about the policy that admitted its class. `expiresAt` is a STORED value, so two identical evaluations still compare equal and write suppression holds.

### §123. M22.0 (ADR-0033 §11; charter principle 6)

M22.0 (ADR-0033 §11; charter principle 6) — the resolved scan ceiling, shaped for the gate's DECISION `inputContext`.

WHY THIS EXISTS. Until now the effective threshold and its contributing tiers went ONLY into `control_runs.evidence`. ADR-0016 §5 promised that "a blocked promotion can show which tier set the binding severity floor", and that promise was honoured in evidence and BROKEN in the Decision an operator actually resolves by `decision_id`. ADR-0033 adds a way to EXCLUDE findings from that comparison, so the rule has to be in the Decision BEFORE any exception can hide inside it — otherwise a verdict explains neither the rule nor the exception to it.

DETERMINISM IS LOAD-BEARING, NOT TIDINESS. `decisions-repo.ts`'s `restatesDecision` canonicalises object KEY order but deliberately PRESERVES array order, and `matchPoliciesForTargets` returns contributors in unordered-scan insertion order — which can differ between two evaluations that resolved identically. An unsorted array here would therefore defeat `insertDecisionIfChanged` and re-open the measured 1.44 GB/day Decision write amplification (ADR-0024 §D0) on the busiest path in the system. So: every entry is built with a FIXED key order and the array is sorted by its own serialization, giving a total order that depends only on content.

FOR THE SAME REASON, NOTHING HERE MAY CARRY A TIMESTAMP, a duration, a row id, or any other value that varies between two evaluations of the same inputs. If you add a field, ask first whether two identical gate evaluations would produce it identically.

### §124. Which policies fire for a change's targets, callable

M22.2 — WHICH POLICIES FIRE FOR A CHANGE'S TARGETS, as a callable, for the ONE consumer outside this file that needs it: the commander's promotion scan step.

WHY IT EXISTS. `federation/promotion-scan-step.ts` resolved its scan ceiling with `firedPolicies: []` — a hardcoded empty firing set, which admits the instance floors and NOTHING from org, containment domain, service, assembly or component. Its own comment called that a documented follow-on, and it was defensible while the only dimension was a TIGHTENING (the fail-closed 0/0 default already refuses any Critical or High). It stops being defensible the moment a LOOSENING exists: an exclusion admitted by the lifecycle gate would be invisible to the commander's managed scan, so the two paths would disagree about the same artifact at exactly the boundary where evidence is FROZEN into a signed bundle.

WHAT IT SHARES, AND WHAT IT IS NOT. Every step below is the same function `evaluateGovernanceGate` calls, in the same order — `matchPoliciesForTargets`, `resolvePolicies`, the emergency-policy substitution, `governanceSubjectOf`/`graphFactsFor`, `buildCelContext`, `resolveFiredPolicies`. Nothing is reimplemented. It is deliberately NOT a gate: it evaluates no controls, materializes no approvals, checks no freeze, and writes no Decision. It answers one question — "which contributors are in force for these targets right now" — so a non-gate consumer can resolve scan requirements against the same firing set the gate would.

THE SANDBOX IS LAZY BY CONTRACT. `resolveFiredPolicies` takes `Pick<CelSandbox, "evaluate">` and calls it ONLY for a contributor that actually carries a `condition`, so a caller may pass a thunk that constructs the shared sandbox on first use. That matters: `new CelSandbox()` spawns its worker pool EAGERLY in the constructor, and the promotion scan step must not spin up worker threads for an org whose policies carry no conditions at all.

### §125. Runs every required control without blocking or writing

Runs (never blocks, never writes a Decision) every required control a change's targets' effective policies reference, and — unless `materializeApprovals: false` — materializes every requireApprovals effect's approval request — so that by the time a HUMAN calls `POST /changes/{id}/accept` (the host-less lifecycle-edge gate, `coordination/gates.ts`'s module doc), the outcomes it needs to READ already exist. Called by `coordination/reconcile.ts` once per tick for every change sitting in `validating` (the only state a required-control-bearing policy could otherwise starve forever, since nothing else ever calls `evaluate()` for those controls). Deliberately does NOT insert a Decision on every tick — that's reserved for an actual gate verdict a transition attempt consulted (module doc's "never a silent pass" applies to CONTROL OUTCOMES, not to this warm-up's own bookkeeping) — a change sitting in `validating` for hours would otherwise pollute the Decision log with one redundant "still blocked" entry per ~1s tick.

### §126. Materialize firing policies' approval requests

Materialize firing policies' `requireApprovals` effects as approval requests. DEFAULT TRUE — the behaviour every existing caller has, and the reason this function exists for a change on its way through the lifecycle.

`dependencies/bump-gate.ts` passes FALSE, and that is not an optimisation. It runs this function for a bump change that is DELIBERATELY NEVER ADVANCED (a bump is a proposed edit to a manifest, not a deployment), so nothing will ever consult — or clear — an approval request materialized for it. Every bump would leave one permanently-pending approval task per firing policy in somebody's queue, forever. Only the CONTROLS are evidence, and only the controls are what that job needs.

### §127. Determine the FIRING set

Determine the FIRING set (each contributor's own condition, independently — evaluate.ts's `resolveFiredPolicies`), then pre-run/materialize only what firing policies actually require. Uses the SAME subject + graph facts the real gate does (graphFactsFor) so prewarm and the eventual host-less lifecycle gate agree on which conditions fired — otherwise a control the real gate needs but prewarm never ran would starve the accept gate (which only READS).

### §128. ADR-0026: a placement's SUBJECT is the component it places

ADR-0026: a placement's SUBJECT is the component it places — see `governanceSubjectOf`. Applied in prewarm as well as in the gate, not because a prewarm target is ever a placement today (it reads the change's own targets, which are always components) but because prewarm exists to make the two agree on which conditions fired; a subject resolved one way here and another way there is exactly how a control the gate needs but prewarm never ran starves the accept gate.

### §129. The exclusion dimension, through the same mechanism

M22.2 — the exclusion dimension, threaded through the SAME conditional-context mechanism.

THIS SITE IS THE ONE THAT MATTERS MOST and it is easy to miss: the prewarm's run is the one that gets CACHED and later READ by the host-less accept edge (`readExistingControlOutcomes`). Threading exclusions only at the evaluate site below would leave the accept edge consuming a verdict computed without them — the loosening would appear to work at a wave boundary and silently not exist at the edge a human actually clicks.

### §130. The actuator, at the site whose run is cached and reread

M22.7 (ADR-0033 §10) — THE ACTUATOR, at the site whose run is CACHED and later read by the host-less accept edge. Without it a grant approved after this change's controls first ran is inert on this change forever: `ensureControlRun` returns the cached outcome and the plugin is never asked again. Re-resolving is not enough on its own — the resolved set has to be able to INVALIDATE the cached verdict, which is what `force` does.

### §131. M25.2 — PER-TARGET FREEZE ADMISSION

M25.2 — PER-TARGET FREEZE ADMISSION (docs/proposals/campaigns-rework.md §1.1(c))
Resolved ONCE, per target, and consumed two ways: `checkFreeze` gets the flat union (CRITICAL #2's quantifier, structurally unable to see the per-target dimension) and `partiallyFrozen` gets the map. One resolution, so the two can never disagree about what is frozen.

### §132. Partial admission: some targets covered, some not

PARTIAL ADMISSION — some targets covered, some not, and no covering freeze declared itself `atomic`. In that case the wave gate stands aside and `coordination/reconcile.ts`'s per-target trigger loop withholds exactly the covered targets while their siblings ship. Four conjuncts, each doing work:

* `gateKind === "wave_boundary"`. `lifecycle_edge` KEEPS any-target-frozen => block, deliberately: accepting a change is ONE atomic state change of ONE `changes` row, and there is no such thing as accepting three quarters of a change. Partial admission is meaningful at a wave boundary and only there. This conjunct also covers `POST /policy-evaluate` (routes/governance.ts, `lifecycle_edge`) for free. * `frozenIds.length > 0`. Nothing frozen is not a partial freeze; `checkFreeze` allows anyway. * `frozenIds.length < targetObjectIds.length`. ALL-FROZEN STAYS A WHOLE-WAVE BLOCK — today's `gate`/`block` Decision written exactly as now, the wave stays `pending`, `started_at` stays null, and today's tick-by-tick re-evaluation lifts it when the window closes. Dropping this guard would transition a totally-frozen wave to `running` with nothing running and delete the surface an operator resolves with `scp change explain`. * no covering freeze is `atomic` (owner decision D5, drizzle/0084). One `atomic` freeze anywhere in the coverage restores the union — the incident freeze, where half-applied is worse than not-applied. The predicate is DATA-DRIVEN rather than call-site-driven, so the person with the context decides, not this file.

### §133. THE ROLLBACK EXEMPTION

THE ROLLBACK EXEMPTION (owner decision D7) — the ALL-frozen half of it. `partiallyFrozen` above only stands the gate aside when some sibling is still admissible; a rollback whose every target is frozen has no admissible sibling and would be refused here, which is precisely the case D7 is about. `evaluateLifecycleGate` has exempted rollbacks since M4 and the wave boundary never learned the same fact — an oversight, not a decision, and the one that left `scp change rollback` as the documented exit from a stuck release while a freeze closed that exit.

NARROW: it lifts the FREEZE block and nothing else. Execution continues into policy matching, controls and approvals below, all of which still apply to a rollback's wave. QUALIFIED ON `wave_boundary`, exactly like `partiallyFrozen` above, and not merely on `isRollback`. Today `isRollback` is set only by `evaluateWaveGate`, so the conjunct is inert — but `isRollback` lives on the SHARED `GateContext`, and one future caller setting it on the lifecycle path would silently lift the freeze at `validating -> accepted` AND on `POST /policy-evaluate`. `lifecycle_edge` keeps any-target-frozen => block by design (there is no such thing as accepting three quarters of a change), and D7 is a WAVE-boundary decision.

AND TIER-AWARE (M25.3 review finding 1). `rollbackExemptible` is the ONE definition of "may D7 stand this covering set aside", shared verbatim with `reconcile.ts`'s per-target seam: a PLATFORM freeze is never stood aside for a rollback. Shipped tier-blind, this conjunct handed any principal holding `object:write` (all `POST /v1/changes/{id}/rollback` requires — no `freeze:override`, no reason, no operator token) a route past the freeze `checkFreeze`'s block sentence promises "no tenant role can override, however privileged", and a CHEAPER one than the override it was contrasted with. The full reasoning, including why `overridable` is deliberately NOT consulted and what this narrows, is on `rollbackExemptible`.

### §134. Tier and match are additive, both load-bearing

M25.3: `tier` and `match` ARE ADDITIVE and both are load-bearing for principle 6. `scopeObjectId` is null for a platform freeze because that tier has no object id in any org's containment chain — `match` carries what it actually matched instead, and `tier` tells a reader WHICH SURFACE resolves `id`: `GET /v1/freezes/{id}` for `org`, `GET /v1/instance/freezes` for `platform`. Without `tier` the id in this record would resolve to a 404 on the only surface a reader would think to try.

NOTHING HERE IS DERIVED FROM A CLOCK — `endsAt` is read straight off the row, exactly as before, so a re-evaluated block is byte-identical on every tick and `insertDecisionIfChanged` suppresses it. That is ADR-0024's 1.44 GB/day contract and it survives this change unchanged.

### §135. Emergency changes follow a configured policy instead

Emergency changes follow a CONFIGURED emergency policy instead of the normal required set (DESIGN §10.3) — never a blanket bypass. If the org has configured no `emergencyPolicy: true` document, an emergency change proceeds ungated (verdict allow) but this is fully visible in the reason tree/Decision either way — "everything still audited, retrospective Decision trail produced" doesn't depend on something having blocked. VISIBLE, not silent (charter principle 6). A freeze that DID cover this wave and was stood aside is exactly the kind of thing an operator reading `scp change explain` must find, and a permit that leaves no trace is indistinguishable from a freeze that never matched.

### §136. A wave target may be a placement, whose subject differs

ADR-0026 — a wave target may be a PLACEMENT, whose subject is the component it places. The containment chain already reaches the component (graph/containment.ts route 3); these two reads go at the object itself and would otherwise see `typeId: "placement"` with no owners and no dependents, silently falsifying every subject- or ownership-conditioned policy. See `governanceSubjectOf`.

### §137. The six-tier most-restrictive-wins scan ceiling

M17.5 — the six-tier most-restrictive-wins scan ceiling, resolved from the SAME `matches` this gate already computed (ADR-0016 §4 design A), and from the FIRED set only: a contributor whose condition evaluated false contributes no ceiling, exactly as it contributes no requireControls.

M22.0 — HOISTED so it can be used TWICE: threaded to the scan control exactly as before, AND recorded in this gate's Decision below.

RESOLVED UNCONDITIONALLY, not just when a plugin host is present. The first cut of this kept it inside the `host` ternary, reasoning that this added no work to the per-tick reconcile path. The reasoning was right and the placement was wrong, and a mutation-tested suite caught it: the `validating -> accepted` edge runs with `host: null` (routes/changes.ts), so a change BLOCKED AT THE ACCEPT EDGE by a failed scan control got a Decision carrying no ceiling at all — which is precisely the operator-facing surface ADR-0016 §5's promise is about. Half-kept, on the half that matters most.

The cost objection does not survive contact with where the two paths actually run. The host-ful path (the wave-boundary gate) is the per-tick one and resolved this already, so it is unchanged. The host-less paths are the accept edge and `POST /policy-evaluate` — both driven by an API call, neither on a reconcile tick. So this buys back the promise for one resolution per accept attempt, and adds nothing to the path that produced the 1.44 GB/day incident.

### §138. M22.7 — the actuator at the EVALUATE site

M22.7 — the actuator at the EVALUATE site. This is a SECOND call site, not a duplicate: the prewarm's run authorizes the host-less accept edge, this one authorizes a wave boundary, and M22.0a keys them separately on purpose — so a wave parked for days behind a failing scan is exactly the case where a grant approved in the meantime has to take effect. Wiring only one of the two is the precise mistake M22.2's measured mutation M-2 found in the threading itself.

Resolved even when `host` is null (it costs one indexed read per accept attempt and nothing on a reconcile tick) so the `force` below is computed from the same expression on both branches; the host-less branch cannot run a control at all, so it simply never uses it.

### §139. That fallback is the partial-admission path, not defence

`?? []` IS THE PARTIAL-ADMISSION PATH, not defensiveness. `checkFreeze` returns `overrides: null` exactly when it BLOCKED, and M25.2 lets one blocked outcome through: the partially-frozen wave boundary, which falls past the block return above and evaluates policy normally. Nothing was overridden there and nothing should be audited as overridden — the wave path carries no `overrideFreeze` at all (`EvaluateWaveGateContext` has no such field and `gates.ts` passes none), so an override on this path is not merely absent, it is unreachable.

## `apps/server/src/governance/governance-label-write-doors.integration.test.ts`

### §140. THE RESERVED GOVERNANCE LABEL NAMESPACE

THE RESERVED GOVERNANCE LABEL NAMESPACE — INSTALLED, AT EVERY DOOR, AGAINST THE REAL ESCAPE

## What was broken

`governance/policy-resolve.ts`'s `scope.selector.labels` branch matched a policy against `objects.labels` on the target's containment chain. Authoring that policy required `policy:write` AT THE ORG ROOT (`policy-scope-authz.ts`, "precisely because a selector has org-wide blast radius"). Writing the labels it matched on required plain `object:write` at the object — the subject's own owner — against no schema and no reserved namespace. The subject of a constraint could therefore step out of its reach by deleting one map entry, and nothing anywhere said so.

## Why this file is HTTP-level and its unit sibling is not enough

`governance-labels.test.ts` proves the guard DECIDES correctly. It cannot prove the guard RUNS. This project's dominant defect is a component that is built, unit-tested green and never installed (CLAUDE.md), and a suite that reaches the guard directly is exactly the shape that cannot tell the two apart. So every case below drives a REAL DOOR — an HTTP request, an IaC apply, a repo function a route calls — and the guard is reached only if it is actually wired in.

MUTATION LOG — MEASURED, not predicted. Each was applied ALONE against a green suite, the run recorded, then reverted. Every entry below is the actual failure set.

1. delete `assertMayWriteGovernanceLabels` from `createObject`  → B1, B2, B3, B5, B8 2. delete it from `updateObject`                                → A3, A4, A5 3. delete it from `createRelationship`                          → B6 4. delete it from `handFillObject`                              → B7 5. delete `assertSelectorKeysAreGovernanceLabels` from `createObject` → C1, C3, C5 6. delete it from `updateObject`                                → C2 7. delete `assertSyncScopeSelectorKeys…` from `pairPeer`        → D1 8. delete it from `updatePeerTransport`                         → D2 9. compute the delta over `after`'s keys only (lose REMOVAL)    → A4, A5 10. `isGovernanceLabelKey` returns `true` for every key          → A2, B0, B4, C1, C2, C3, C4, C5, D1, D2 11. delete `assertSelectorKeysAreGovernanceLabels` from `handFillObject` → C4

A PART F WAS HERE, AND IT WAS REMOVED BECAUSE ITS MUTATIONS STOPPED KILLING ANYTHING. It added `assertPolicyScopeWithinAuthority` to `createOverlay` and `handFillObject` on the reading that the check's census had missed those two doors, and claimed mutations 9/10 (delete each call site → F1/F2 die). Re-measured after #244 merged, on this tree: - F2 FAILED outright — `assertGovernanceAuthorityForHandFill` throws FIRST, with a different message, so the case was asserting a refusal that no longer came from the guard it named. - F1 PASSED WITH THE CALL SITE DELETED. The refusal was #244's governance-managed org-root `policy:write` bar all along; F1's assertion (`/policy:write/`) matched either message. #244 closed both doors independently and more strongly, so the added calls could no longer refuse anything — see `federation/overlay-repo.ts` and `federation/handfill-repo.ts` for the argument. The doors' real coverage is `governance-managed-write-doors.integration.test.ts` DOOR 1 and DOOR 5.

THREE OF THESE ARE THE POINT, not bookkeeping: - #5 does NOT kill C4 and #11 does — which is the measured proof that hand-fill runs the selector refusal FOR ITSELF rather than inheriting the choke point it is exempt from. The same separation holds for #1 vs #4. - #9 kills A4 and A5 and nothing else: the removal case is the whole defect, and a delta written the obvious way (over `after`'s keys) leaves it wide open with 23 of 25 still green. - #10 kills the CONTROLS (A2, B0, B4). An over-broad namespace refuses ordinary estate description, which is the failure mode option (b) in the proposal was rejected for.

A5's failure under #2 and #11 is a genuine cascade, not a flake: A4's refusal is what leaves the governance label on the row for A5 to still be governed by. That coupling is deliberate — A5 asserts REACH, not a status code.

## The actor

`operator` is the built-in **Operator** role at the org root: `drizzle/0002` gives it `object:write` + `relationship:write`, and `drizzle/0010` grants `policy:write` to Administrator/Owner ONLY. It is precisely the "component's own owner" of the report. CASE B0 is the control that earns every 403 below — without it this whole file passes just as well against a token holding no permissions at all.

### §141. The refusal's detail, from an SDK or a direct call

The refusal's `detail`, from an SDK call OR a direct repo call.

A `ScpApiError`'s `message` and a `ProblemError`'s `message` are both only the RFC 9457 TITLE ("Bad Request", "Forbidden"), so `.rejects.toThrow(/…/)` against the message would pass for any refusal the server could ever produce — the "green for the wrong reason" shape this repo has paid for repeatedly. Every assertion below reads the detail instead.

### §142. The selector matches at every ancestor

The selector matches at every ancestor. A component owner clearing their own labels does not reach the service's assertion, so this must fail for the ORDINARY reason (nothing to remove) rather than accidentally succeeding at removing the wrong thing. Through the STRICT typed route: `/objects/component` refuses service-member types outright (`graph/service-member-types.ts`), so using it here would pass for the wrong reason.

### §143. Driven at the REPO, not over HTTP, and deliberately

Driven at the REPO, not over HTTP, and deliberately: `POST /federation/hand-fill` authorizes `federation:write` at the org root, which `drizzle/0012` grants only to Administrator/Owner — and those same roles hold org-root `policy:write`, so no BUILT-IN role can reach this door without also clearing the bar. The refusal exists for a custom role (the `roles` table is org-scoped and operators do define their own) and as defence in depth, and the claim under test is INSTALLATION: `handFillObject` must run the check for itself, because the choke point skips it for `federationImport`. Calling the door proves that; calling the guard would not.

### §144. The width of the skip, and why it is not trust

The width of the skip, and why it is not "imported data is trusted": `import-repo.ts`'s `object_upsert` branch has NO try/catch, so one refusal aborts a whole signed bundle and wedges that channel. A receiving domain also has no standing to referee a document its AUTHORING instance already accepted — the guard is an authoring-time refusal by construction.

Driven at the repo with `federationImport` set, because that flag — not the transport — is what the exemption is keyed on, and it is supplied by exactly two modules (`import-repo.ts` and `handfill-repo.ts`, whose unearned share of it CASE B7 closes).

## `apps/server/src/governance/governance-labels.test.ts`

### §145. The PURE halves of the reserved governance label namespace

The PURE halves of the reserved governance label namespace. The wiring — that every write door actually reaches these — is a separate file (`governance-label-write-doors.integration.test.ts`), deliberately: this repo's dominant defect is a component that is built, unit-tested green, and never installed, and a unit test that calls the guard directly cannot tell the difference.

## `apps/server/src/governance/governance-labels.ts`

### §146. THE RESERVED GOVERNANCE LABEL NAMESPACE

THE RESERVED GOVERNANCE LABEL NAMESPACE — "a description is not an assertion"

## The property this closes

A governance decision whose MATCH KEY is writable by its own SUBJECT, at a strictly weaker permission than the one that authored the constraint.

The live instance: `governance/policy-resolve.ts`'s `scope.selector.labels` branch matches a policy against `labels` on any object in the target's containment chain. Authoring that policy requires `policy:write` AT THE ORG ROOT — `policy-scope-authz.ts` deliberately demands the widest bar there is, "precisely because a selector has org-wide blast radius". Writing the labels it matches on required nothing at all: `object:write` at the object, i.e. the subject's own owner, validated by no schema (`drizzle/0002_rls_rbac_seed.sql:161` registers `policy` with `{"type":"object"}` and `labels` has no schema on ANY type), and with no reserved namespace.

So the subject of a selector-scoped policy could walk out of its reach by deleting one map entry. SecOps writes `scope: {selector: {labels: {tier: "pci"}}}` with `requireApprovals` and a strict `scanThreshold`; the component owner drops `tier` from their component's labels; every gate stops matching. No error, no audit event, no Decision — a constraint that fails to match is a constraint that does not apply, and this one fails to match silently.

## Why a reserved namespace and not the alternatives

Three shapes were considered; the reasoning is in `docs/proposals/governance-label-namespace.md` and only the conclusion is restated here, because the rejected options are the kind that get re-proposed.

- **An audit event when a label change alters which policies match** is detection, not prevention: the gate still stops firing, and the operator learns about it from a promotion that sailed through. It also costs a full policy scan plus a containment walk on the hottest write path in the system. Cheaper to build, strictly weaker, and it leaves the fail-open in place.

- **Freezing whatever label keys the org's policies happen to name** needs no new namespace and no re-keying — but it means the day SecOps authors `selector: {env: "prod"}`, every team in the org loses the ability to set `env` on anything. Governance reach would silently become a function of unrelated documents, and describing your estate would start returning 403s. The tension is irreducible: `env` is exactly the label a selector wants AND exactly the label a team must be able to set.

- **A reserved namespace** dissolves that tension by separating the two acts that were sharing one bag. `labels.tier` is a DESCRIPTION the owner makes about their own object. `labels["scp.governance/tier"]` is an ASSERTION an authority makes about it. The first stays exactly as free as it is today; only the second is out of the subject's reach, and only the second is what a constraint may key on.

This is ADR-0003's shape, one layer over: there, a graph property "is a per-system DECLARATION of intent, not a grant" and buys nothing unless an operator-set value outside tenant write reach independently agrees (`coordination/executor-bindings-repo.ts`'s `resolveInternalEgress`). Here the tenant's `tier: pci` likewise grants and relieves nothing; the operator-set `scp.governance/tier: pci` is the only thing a constraint sees.

## The bar is org-root `policy:write`, and it is the same bar as the policy itself

`assertPolicyScopeWithinAuthority` requires `policy:write` at the ORG ROOT to author a selector-scoped policy. A governance label is the other end of that same constraint, so it takes the same bar and not a weaker one. `policy:write` scoped at a component would otherwise let a component-level administrator clear the key an org-level SecOps policy matches on — the original evasion with one more permission and no more authority.

ERGONOMICS, since org-root authority sounds heavier than it is: `labelsMatch` runs over the whole CONTAINMENT CHAIN (`policy-resolve.ts`), so an operator labels a DOMAIN or a SERVICE once and every component beneath it is governed. There is no per-component labelling burden, and there is no new place to look — a governance label is an ordinary entry in an ordinary `labels` map, readable by anyone who can read the object.

## Where it is installed

At `graph/objects-repo.ts`'s `createObject`/`updateObject` and `graph/relationships-repo.ts`'s `createRelationship`/`updateRelationship` — the choke points every LOCAL write door funnels through — never per route. `routes/*.ts` alone admits `labels` on eighteen handlers, and `subscription-guard-write-doors.integration.test.ts` already records three doors (IaC apply, `POST /federation/hand-fill`, `POST /federation/overlays`) that reach `createObject` without passing through `typed-registries.ts` at all. The `federationImport` exemption and its closing at `federation/handfill-repo.ts` follow that file's precedent exactly; see the call sites.

### §147. Is this label key reserved to governance?

Is this label key reserved to governance?

A bare prefix test, deliberately — no normalisation, no case folding, no trimming. A key is either literally in the namespace or it is not, because both readers of this predicate compare label keys with `===` (`policy-resolve.ts`'s `labelsMatch`, `federation/scope-filter.ts`'s custom mode). Any fuzziness here would create a key that is reserved for the WRITE check and a different key for the MATCH — which is the evasion, rebuilt inside the guard.

### §148. The governance keys this write would add, change or remove

The governance-namespace keys this write would ADD, CHANGE **or REMOVE**, sorted.

REMOVAL IS THE ATTACK, so it is the case this must not miss: `updateObject` replaces `labels` wholesale, so "the request did not mention the key" and "the request deletes the key" are the same bytes on the wire. A delta computed over `after`'s keys alone would be blind to exactly the move this module exists to stop.

Values are compared canonically rather than by reference or `===`: labels are `jsonb`, so a value that round-trips through the database as a structurally-identical object is not the same reference, and a spurious "changed" would turn an ordinary PATCH into a 403.

### §149. Refuses a governance-label write unless the actor may

Refuses a write that would add, change or remove a governance label unless the actor holds `policy:write` at the org root. A write that leaves every governance key byte-identical performs NO permission lookup at all, which is what keeps this off the cost of the ordinary write path.

A FULL-REPLACEMENT WRITE THAT SIMPLY OMITS THE KEY IS REFUSED, not silently repaired. Merging the operator's keys back in would produce zero false positives and one very bad true negative: an operator WITH `policy:write` doing a deliberate `PUT` to REMOVE a governance label would be answered 200 and the label would still be there. Two behaviours where one will do, and the silent one is wrong for the actor who matters most. So the refusal is loud and names the exact keys — `graph/objects-repo.ts`'s own ADR-0031 §6a block makes the same call for the same reason ("both of the silent options are worse").

### §150. A policy selector may key only on governance labels

A `policy` document's `scope.selector.labels` may key ONLY on governance labels.

WITHOUT THIS HALF THE NAMESPACE IS A FEATURE, NOT A GUARD. An author who reaches for `{tier: "pci"}` — the ordinary, obvious thing, and what `docs/DESIGN.md` §10.1's own example shows — gets a policy their subjects can still walk out of, with no indication that they can. Fail-closed means the unusable state is unrepresentable rather than merely discouraged, which is the move `subscription-authoring-guard.ts` and `drizzle/0061`'s declared-producer CHECK both make.

PURE, and refusing on the DOCUMENT alone. It takes `typeId` as an argument rather than letting each caller decide, so every installation site — including the free-form-`typeId` doors — is correct by construction instead of by remembering (`subscription-authoring-guard.ts`'s reasoning, verbatim, for the same reason).

ONLY `policy`. `listPolicyCandidates` (`policy-resolve.ts`) selects `type_id = 'policy'` and nothing else, so a `scope.selector` on any other type is never resolved and carries no hazard.

`labels: {}` IS a live selector and is left alone: `labelsMatch` is an `every()` over zero entries, so it is `true` for every ancestor — an org-wide match that keys on nothing and therefore cannot be evaded by editing anything. Refusing it would be refusing the one selector shape that was never exposed.

### §151. The same rule for a peer's `custom` sync scope

The same rule for a peer's `custom` sync scope — the OTHER decision in the tree that a tenant can re-aim by editing a label, and the more serious of the two.

`federation/scope-filter.ts`'s `custom` mode decides which journal entries LEAVE this security domain, and its own header calls that out: a scoped peer is scoped "precisely FOR confidentiality". The selector is authored under `federation:write`; the labels it matches are the object's own, writable under `object:write`. So a component owner who sets `tier: gold` on their component ships it across a domain boundary to a peer that was configured never to receive it — the same property as the policy case, running in the widening direction rather than the narrowing one, and against confidentiality rather than a gate.

ENFORCED AT PEER-CONFIG AUTHORING ONLY. `entryMatchesScope` stays a pure, synchronous predicate that the importer — which cannot query the sender's database — applies to exactly the same input and reaches exactly the same answer; that symmetry is the whole basis of the defense-in-depth re-filter at import, so nothing here touches it. An already-stored `custom` scope keying on an unreserved label keeps filtering exactly as it does today until someone edits it, which is the same grandfathering ADR-0032 §6a's guard accepted.

## `apps/server/src/governance/governance-managed-types.ts`

### §152. Object types the governance subsystem owns end to end

Object types the governance subsystem owns end to end (DESIGN §10.1/§10.2): `policy` documents bind their DECLARED `properties.scope` to the author's own authority (governance/policy-scope-authz.ts, CRITICAL #1b); `control` documents are the entries a policy's `requireControls` effect can reference. Both are gated behind `policy:write` — never the generic `object:write` every other typed resource uses (routes/typed-registries.ts's `GOVERNANCE_TYPED_REGISTRY_RESOURCES`).

Single source of truth for every write path that must special-case these types instead of treating them like an ordinary graph object (security fast-follow after PR #9's adversarial review found the generic `/objects/{type}` endpoint and the IaC plan/apply path both skipped this entirely — a live governance bypass): - `routes/objects-generic.ts` refuses to create/update/delete these types at all, routing callers to the typed `/policies`/`/controls` resources instead. - `coordination-as-code/plans-repo.ts` enforces the same `policy:write` permission (and, for `policy`, the same `assertPolicyScopeWithinAuthority` scope binding) a client-controlled manifest could otherwise use to plant an org-wide policy through `POST /plans` + `.../apply`.

Adding a new governance-owned type later means updating this one set and re-checking the two call sites above — not re-auditing every write path in the codebase from scratch.

THERE IS A THIRD WRITE PATH, AND THIS DOCBLOCK DID NOT ENUMERATE IT (M22.6, ADR-0033 §8)
`federation/import-repo.ts`'s `object_upsert` branch reaches `createObject`/`updateObject` with a free-form `typeId` and free-form `properties`, and it is NOT covered by either bullet above. That is not a hole: it is a deliberate, narrow exemption whose reason is structural — that branch has NO try/catch, so a throw there aborts the peer's ENTIRE signed bundle and wedges the channel. An authoring-time refusal belongs at the AUTHORING instance; by the time a row arrives here it has already been signature- and chain-verified, and `graph/objects-repo.ts` records who authored it. The same reasoning is written out at length in `dependencies/subscription-guard-write-doors. integration.test.ts`, and its census found `federationImport` set by exactly two modules — `import-repo.ts` and `federation/handfill-repo.ts` — of which hand-fill is a LOCAL operator action with no channel to wedge and therefore does NOT get the exemption.

It is named here because the previous version of this docblock said "the two call sites above" and a reader adding a fourth governance type would have gone looking for two doors and found three. `governance-managed-write-doors.integration.test.ts` now enumerates every id in this set against every door, so the count cannot silently go stale again.

### §153. A grant is a standing, expiring authorization

M22.6 (ADR-0033 §6a) — a `scan_override_grant` is a standing, expiring authorization to TOLERATE A KNOWN VULNERABILITY. Its `properties` carry the component it excuses, the finding, the tier whose authority approved it and its expiry; a holder of plain `object:write` at that component writing any of those directly would be granting themselves the waiver they are supposed to be requesting. That is the identical shape `policy.properties.scope` has, so it gets the identical treatment: refused on the generic `/objects/{type}` endpoint, and `policy:write` (not `object:write`) through the IaC plan/apply path.

The typed routes (`routes/scan-override-grants.ts`) are the only local authoring door, and they split the permission the way D3 requires — `object:write` at the component to RAISE a request, `policy:write` at the named tier object to APPROVE, deny or revoke one.

### §154. A freeze object is the wire form of a freeze row

M25.7 (owner decision D6, ADR-0043) — a `freeze` object is the WIRE FORM of a freeze window: it rides `object_upsert` to this org's peers, and `federation/import-repo.ts` rebuilds a `freezes` projection row from it at every receiving instance, which is what makes it BLOCK there.

So a caller who can mint one through a door that takes a free-form `typeId` can stop releases in ANOTHER SECURITY DOMAIN — and, without this entry, could do it holding nothing but plain `object:write` at their own domain. That is a wider blast radius than the `policy` hole this set was created for, and it arrives with the same shape: authority carried in `properties` (`scopeObjectId`, the window, `atomic`) that no generic write door inspects.

The typed door is `POST /api/v1/freezes`, which demands `freeze:write` at the freeze's own scope and, for the federating form, `federation:write` on top — and which is also the only place that writes the object and its projection row together, so a `freeze` object minted anywhere else would federate a freeze that does not exist locally.

MEMBERSHIP HERE IS NECESSARY AND NOT SUFFICIENT, and the first version of this entry claimed otherwise ("closes all five doors at once"). It does not: of the five doors, only TWO refuse the type ({POST,PATCH,PUT,DELETE} `/objects/{type}` and `POST /discovery/accept`). The other three — `POST /plans`+apply, `POST /federation/overlays`, `POST /federation/hand-fill` — take membership as an instruction to demand `policy:write` INSTEAD of `object:write`, which is a permission UPGRADE, not a refusal. See `PROJECTION_BOUND_OBJECT_TYPE_IDS`, which is the set those three consult, and which is what actually closes them for `freeze`.

FEDERATION JOURNAL REPLAY IS STILL NOT A DOOR, for the structural reason recorded above: `import-repo.ts` is where a freeze object is SUPPOSED to arrive.

### §155. TYPES WHOSE GRAPH OBJECT IS ONLY HALF THE RECORD

TYPES WHOSE GRAPH OBJECT IS ONLY HALF THE RECORD — refused outright at every door that takes a caller-supplied `typeId`, the way `import("../graph/pair-bound-types.js")` refuses `placement`.

WHY A SECOND SET AND NOT A SECOND MEANING FOR THE FIRST. `GOVERNANCE_MANAGED_OBJECT_TYPE_IDS` answers "which permission?"; three of the five doors answer it with `policy:write` and then WRITE THE ROW. That is right for `policy` and `control` — DESIGN §13 makes "locally annotate a commander-distributed global policy" and "an air-gapped operator keys a commander-origin policy in by hand" canonical, so refusing the type would delete the feature. It is WRONG for a type whose object is meaningless on its own.

THE HOLE THIS CLOSES, MEASURED ON THE M25.7 TREE BEFORE IT EXISTED. An actor holding `policy:write` at a narrow domain — and `freeze:write` / `federation:write` NOWHERE — could `POST /plans` a manifest object of `typeId: "freeze"` and apply it. Three things then went wrong at once, and only the first is a permission problem:

```text
1. `coordination-as-code/plans-repo.ts`'s `writePermissionFor` mapped the type to `policy:write`, which the
   actor held, so the freeze's two REAL gates (`freeze:write` at its scope, `federation:write`
   on top for the federating form) were bypassed entirely — `policy:write` became a complete
   substitute for both.
2. `prepareApplyChecks` scope-binds a DECLARED `properties.*` to the actor's own authority for
   exactly two types (`policy`, `campaign`). A `freeze`'s declared `properties.scopeObjectId`
   was bound to nothing, so the narrow actor's freeze could name any scope in the org.
3. The result was UNLIFTABLE AT BOTH ENDS. Only `POST /v1/freezes` writes the object and the
   `freezes` row together, so the authoring instance got an object with no projection row and
   `DELETE /v1/freezes/{id}` 404s there; at the peer the row IS rebuilt, and `lockFreezeRow`
   refuses to lift it because its origin domain is foreign. A block nobody can retract.
```

REFUSAL LOSES NOTHING REAL, which is the test this repo applies before refusing a type at a door (`pair-bound-types.ts`'s "is it called an import path" paragraph). There is no "annotate a distributed freeze" use case — a freeze carries no strictness lattice for an overlay to add to — and none of the three doors can write the projection row anyway, so what they would produce is by construction the broken half-record above.

BEFORE ADDING A MEMBER, the question is the one that separates this set from the governance one: does a row of this type require a SECOND write, in another table, that only a typed route performs? If yes it belongs here, whatever its permission story is. `scan_override_grant` does NOT — it is wholly an object — which is why it stays governance-managed and permission-gated.

The doors that consult this set are the three that would otherwise upgrade rather than refuse: - `coordination-as-code/plans-repo.ts`'s `prepareApplyChecks` (per-entry, every non-`noop` action) - `federation/overlay-repo.ts`'s `createOverlay` - `federation/handfill-repo.ts`'s `assertGovernanceAuthorityForHandFill` The other two already refuse every governance-managed type, so a member of this set is refused there by the wider rule; `governance-managed-write-doors.integration.test.ts` drives all five with an actor holding every permission those doors ask for EXCEPT `freeze:write`, so "refused" is measured rather than assumed.

FEDERATION JOURNAL REPLAY IS NOT A DOOR HERE EITHER, and for this set the reason is doubled: `import-repo.ts`'s `object_upsert` branch is exactly where a `freeze` object is SUPPOSED to arrive, and it is the branch that then writes the projection row.

## `apps/server/src/governance/governance-managed-write-doors.integration.test.ts`

### §156. THE `policy:write` DOOR CENSUS

THE `policy:write` DOOR CENSUS — every write door that takes a CALLER-SUPPLIED `typeId`.

THE PROPERTY
`policy:write` is a DELIBERATELY SEPARATE permission from `object:write`: `0010_governance.sql` grants it to Administrator and Owner only, while Operator and Approver hold `object:write` and never `policy:write`. Two checks make that split mean something, and they are a PAIR — every door that installs one must install the other:

```text
(1) the permission itself — a `policy`/`control` write needs `policy:write`, not `object:write`
    (`governance/governance-managed-types.ts`'s `isGovernanceManagedObjectType`); and
(2) `governance/policy-scope-authz.ts`'s `assertPolicyScopeWithinAuthority` — a policy's
    DECLARED `properties.scope` is bound to the author's own authority, so a component-scoped
    author cannot publish an org-wide policy (CRITICAL #1b).
```

Any door that reaches `createObject`/`updateObject`/`upsertObjectByUrn` with a `typeId` the CALLER chose can mint a `policy` — and a `policy` with no `scope` matches everything in the org (`governance/policy-resolve.ts`'s `listPolicyCandidates` selects every live `policy` row and the unscoped ones match every target). So an unguarded door of that shape is an org-wide governance write handed to whoever holds plain `object:write`.

THE FULL CENSUS (M21.7 — filterless, measured not read; recorded in ADR-0032 §6a)
FIVE doors take a `typeId` the caller chose. Three were wrong, and all three for the same reason: their guard sets were assembled by censusing a DIFFERENT sibling (peer-bound config, pair-bound identity, service membership), so the governance guard those censuses were modelled on is the one none of them went looking for.

# DOOR                                    typeId from         BEFORE             AFTER (M21.7) 1 POST /federation/overlays               body.typeId         object:write ONLY  + policy:write @org root 2 POST /discovery/accept                  REMOVED in increment 6 (ADR-0047) — the door is gone, not merely guarded 3 {POST,PATCH,PUT,DELETE} /objects/{type} path param          type refused       unchanged (measured) 4 POST /plans + /plans/{id}/apply         manifest.objects[]  policy:write+scope unchanged (measured) 5 POST /federation/hand-fill              body.typeId         federation:write   + policy:write @org root

DOORS 1 AND 2 WERE LIVE. An Operator — plain `object:write` at the org root, `policy:write` nowhere — POSTed `{typeId:"policy", properties:{enforcement:"required", effects:[{requireApprovals: {count:99, fromRole:"Owner", scope:"organization"}}]}}` and got 201 from each: twice over, a live org-wide policy demanding an unmeetable quorum. On the overlay door `assertPolicyOverlayOnlyAddsStrictness` never even ran — it is gated on base AND overlay both being `policy`, and the base was a service.

DOOR 5 WAS NOT LIVE, and closing it anyway is the point. `federation:write` (`0012_federation.sql:218-219`) and `policy:write` (`0010_governance.sql:174-175`) both land on Administrator and Owner, so nothing reachable through today's API holds one without the other — safety by coincidence between two grant lists in two unrelated migrations, undone by a single org-defined role. Its case below builds that role rather than trusting the accident.

THREE REMEDIES, TWO SHAPES, chosen by whether the type must stay serviceable at that door: - OVERLAY and HAND-FILL keep serving `policy` and take the PERMISSION. DESIGN §13 makes both canonical: an overlay locally annotating a commander-distributed global policy, and an air-gapped outpost keying a commander-origin object in by hand. Refusing the type would delete the feature and leave `assertPolicyOverlayOnlyAddsStrictness` dead. - DISCOVERY refuses the TYPE, for every caller including one holding `policy:write`: no plugin proposes governance documents, and a proposal carries no scope for the binding to bind.

Journal replay (`federation/import-repo.ts`) is deliberately NOT a door: `typeId` arrives from a signature- and chain-verified bundle, and its `object_upsert` branch has no try/catch, so one refusal aborts a whole signed bundle (ADR-0032 §6a). A hostile peer is a PAIRING problem.

WHAT THIS FILE ASSERTS
- EVERY door, including the ones already closed — "listed as closed" is not "measured closed", and the doors found open here had been listed. Each refusal case asserts the SPECIFIC violation (status + the named permission or type in the detail) and that NOTHING was written; each door with a permission remedy also has a control proving the fix did not simply close the door. - THE PROPERTY over the whole door table at once, and over `GOVERNANCE_MANAGED_OBJECT_TYPE_IDS` rather than over today's two type names — because per-door cases are precisely how this survived: DOOR 2's block was censused for the peer-bound guard and never re-asked for this one, and DOOR 5 was "listed" by a case that only proved an Operator could not reach it. - THE CENSUS ITSELF, by source scan (second `describe`, in three layers: the choke point's exported write surface, everything that writes the `objects` table at all, and every runtime-valued `typeId` handed to that surface). Nothing above goes red when a SIXTH door appears, and a census never re-run is the property behind every finding here. That describe also states what it still CANNOT see, because a completeness test that over-claims is worse than none — it stops the next person looking. - THE SCAN ITSELF, by a fourth case running the layer-3 walker over synthetic sources. That exists because round 1's statement of what the scan could not see was PROSE, and the prose was wrong: it claimed an unreadable call "fails safe by construction", and a one-line call proved otherwise the next day. What a scan can and cannot see is now a test, not a paragraph.

MUTATIONS RUN (2026-08-18, the grant cases). Baseline: 7 passed. MEASURED, not predicted.
CASE NAMES ARE THE POST-REBASE ONES. These mutations were run against the M22 draft of this file, where the grant cases were numbered DOOR 2b/2c/2d against a three-door scheme; they are named here by the door they actually drive in THIS file's five-door scheme. The mapping is 2b -> 4b, 2c -> 4c, 2d -> DOORS 1+5. Nothing was re-measured for the rename — only relabelled.

```text
W-1  DELETE `assertScanOverrideGrantNotSelfDecided` from `createObject`
       -> 2 failed (DOOR 4b, DOORS 1+5). NOTE WHAT SURVIVED: DOOR 4 above stayed green, because
          it drives an `object:write`-only actor who is refused on AUTHORITY before the repo
          layer is reached. The permission mapping and the field guard are different defences
          and only one of them was ever tested.
W-2  DELETE it from `updateObject`
       -> 1 failed (DOOR 4c), and only DOOR 4c. The update half is the strictly worse hole — it
          flips an already-DENIED grant to `approved` — and it has its own case for that reason.
W-3  DELETE the explicit call in `federation/handfill-repo.ts`
       -> 1 failed (DOORS 1+5), and only that case. Hand-fill wears the `federationImport` flag
          that exempts the choke point, so it is the one door a choke-point install does NOT
          cover.
W-4  the guard checks `status` but ignores the four bare decision fields
       -> 1 failed (DOOR 4b). `expiresAt` with no approval is a window nobody opened.
W-5  the APPROVE route stops re-deriving standing (hardcoded `component` tier)
       -> 1 failed (DOOR 4b's trailing approve case). The raise route's check cannot cover a
          grant that never passed through the raise route.
```

### §157. A REAL, PAIRED commander peer for the hand-fill cases

A REAL, PAIRED commander peer for the hand-fill cases — and the fixture is load-bearing.

These cases originally passed `peer: randomUUID()`, a peer that does not exist. `handFillObject` runs `assertGovernanceAuthorityForHandFill` BEFORE `getPeerByIdOrName`, so the refusal under test still fired — but the case's "nothing was written" half was VACUOUS: with no such peer the write could not have happened whatever the guard did, and unwiring the guard turned the case red with a 404 about the peer rather than letting the policy row land. Green (and red) for a reason unrelated to what the case claims. With a real peer, the ONLY thing standing between the request and a live org-wide `policy` row is the guard, which is the whole point of the case.

### §158. A subject holding one permission and not the other

A subject holding `federation:write` at the org root and NOT `policy:write` — the actor no BUILT-IN role can express (both permissions land on Administrator and Owner and nowhere else), built here through the org-defined-role mechanism `roles.org_id` exists for. This is the shape that turns DOOR 5's coincidence into the overlay hole, so the guard is tested against it rather than against the role table's current accident.

### §159. M25.7 — THE THIRD ACTOR

M25.7 — THE THIRD ACTOR: EVERY PERMISSION THESE DOORS ASK FOR, EXCEPT `freeze:write`.
The two actors above make this file measure ONE bar for the WHOLE set — `object:write`-only and `federation:write`-only are both refused everywhere, so the loops stay green no matter what the doors do to an actor who clears the governance bar. That is exactly how M25.7's hole survived a green suite: `freeze` was added to `GOVERNANCE_MANAGED_OBJECT_TYPE_IDS`, which at three of the five doors means "demand `policy:write` INSTEAD of `object:write`" — a permission UPGRADE, not a refusal — and `policy:write` is neither of the two permissions a freeze needs. A holder of it walked straight through `POST /plans`+apply, `/federation/overlays` and `/federation/hand-fill` and minted a freeze that federates, blocks at every peer, and can be lifted at neither end.

WHY THIS ROLE IS BROADER THAN "`policy:write` AND NOTHING ELSE". An actor holding only `policy:write` is refused at three of these doors by their own FRONT gates — `/overlays` and `/objects/{type}` want `object:write`, `/hand-fill` wants `federation:write` — so a 403 would prove nothing about the governance question, which is the vacuous shape this file exists to avoid (see `handFillPeer`'s note). Permissions are monotone: an actor refused while holding MORE is refused while holding less, so the strongest reachable actor is the sharpest test. The one thing deliberately withheld is `freeze:write` — the permission the typed door demands — plus, for the same reason, this role is bound at the org root where `freeze:write` would have to sit to cover anything.

Its non-vacuity control is the `(control)` case beside the property loop: this same actor is still ADMITTED for a type whose bar genuinely IS `policy:write`, so the refusal is measured to be about the TYPE and not about the actor.

### §160. THIS CASE WAS RE-AIMED IN M21.7

THIS CASE WAS RE-AIMED IN M21.7. It was written as "the overlay route also runs `assertPolicyScopeWithinAuthority`", asserting `/org-wide policy/` — that string belongs to that function — with a narrow Administrator (`Administrator` at one service, nothing at the org root) as the actor. Both halves were wrong, and MEASURED wrong, not argued wrong:

1. That actor never reached either governance guard. The route's PRE-EXISTING org-root check refuses it first — observed detail: "subject '…' lacks 'object:write' at scope '<orgId>'". So the case was green-able by code that had no governance guard at all. 2. `assertPolicyScopeWithinAuthority` would be INERT AS AUTHORIZATION on this path anyway, which is why `federation/overlay-repo.ts` deliberately does not call it. It has exactly two branches: the `scope.objectRef` branch wants `policy:write` at-or-above that object, and the broader branch (unscoped / selector / group) wants it at the org root. The overlay guard already demands org-root `policy:write`, and `authz/resolve.ts`'s `scope_expand` walks UPWARD from the checked scope — so an org-root grant satisfies a check at any descendant. Everyone who passes the overlay guard passes both branches. (Its one non-authorization behaviour, a 400 for a `scope.objectRef` that resolves to nothing, is not what this case was for; a dangling ref matches no target and fails safe.)

What the case is now: the guard's SCOPE, which is the part of it a mutation can silently weaken. Swap `scopeObjectId: input.orgId` in `createOverlay` for the base object's id and the Operator case above stays green while this one goes red. The actor therefore holds `object:write` AT THE ORG ROOT (so it clears the route check and actually reaches the guard) and `policy:write` only at one service — authority to author governance SOMEWHERE, which is not authority to author it at the org-root containment every overlay is created under.

### §161. DOOR 2 IS GONE

DOOR 2 IS GONE — `POST /discovery/accept` was REMOVED in increment 6 (ADR-0047).

Its three cases went with it. They proved that the import surface refused governance-managed types outright rather than checking a permission, and they were the second of the two holes this file was written for. That hole is now closed the strongest way available: THE DOOR DOES NOT EXIST. Discovery proposes, and its output becomes IaC code a human commits — there is no longer an observation-driven write path to smuggle a `policy` through.

The remaining doors below still carry the invariant, and the enumeration further down (which drives every governance-managed type against every door) lost one entry rather than one type, so nothing about the type set went unchecked.

Recorded rather than deleted quietly: this file's header counts the doors, and a reader who finds four where the prose says five should learn why here.

### §162. The grant-specific cases, carried in on the rebase

THE GRANT-SPECIFIC CASES, carried in from M22.6/D3 on the rebase onto main.

They were written against this file's other draft, whose door numbering ran 1 objects-generic / 2 IaC / 3 federation-import. This file numbers five doors differently, so the cases are RENUMBERED to the doors they actually drive — an IaC case labelled `DOOR 2` here would name the discovery-proposal door and send the next reader to the wrong module.

### §163. The hole this closes in the permission mapping

THE HOLE THIS CLOSES
`writePermissionFor` maps a governance-managed type to `policy:write` at the resolved target domain, and DOOR 2 above proves an `object:write`-only actor is refused. Nobody ever asked what happens to an actor who HOLDS `policy:write` — a routine scoped policy-author binding, which is exactly what an Administrator at a containment domain is. drizzle/0075's `property_schema` is typed-but-OPEN (it must be: `import-repo.ts` Ajv-validates with no try/catch and one rejection aborts a peer's whole signed bundle), so it accepts `status: "approved"` and a free-string `expiresAt`. That actor could therefore apply an already-approved standing waiver with NO tier check on the rule being waived, NO Decision, NO hash-chained audit event and NO future-expiry validation — every guarantee of the override design, routed around a second door.

The fix is NOT another permission: it is `assertScanOverrideGrantNotSelfDecided`, installed at the `graph/objects-repo.ts` choke point every local write door funnels through.

### §164. A GENUINE `policy:write` HOLDER, scoped to that domain

A GENUINE `policy:write` HOLDER, scoped to that domain. Administrator is the role that carries `policy:write` (see `governance/scan-declared-override-exclusions`'s O4). `Viewer` at the org root supplies the `object:read` that `POST /plans` requires and NOTHING else; `Administrator` — the role carrying `policy:write` (drizzle/0010) — is bound at the DOMAIN only. That is the realistic shape: an author with policy authority over their own subtree and none above it.

### §165. And the one that did get through cannot be approved

...AND THE ONE THAT DID GET THROUGH CANNOT BE APPROVED EITHER. It names `payments` as its tier while the component hangs off the org root, so `payments` is nowhere on that component's containment chain. This is the case that proves the approve route RE-DERIVES standing rather than inheriting the raise route's check: this grant never passed through the raise route at all — it arrived through IaC — and a federated peer could deliver the same shape.

### §166. The two doors a per-route install always misses

The two doors a per-route install always misses, and the reason the guard lives at the choke point. HAND-FILL is the sharper of the two: `handFillObject` stamps `federationImport`, which is exactly the flag that exempts the choke point — so it inherits an exemption whose stated reason ("a throw aborts a peer's whole signed bundle") is a statement about a CHANNEL that does not exist on a local operator action. `handfill-repo.ts` therefore calls the guard for itself, and this case is what proves it did. OVERLAY needs no special handling — `overlay-repo.ts` calls `createObject` with no import flag — and is asserted anyway, because "needs no handling" is a claim about today's code.

### §167. Deliberately the only source assertion in this file

Deliberately a source assertion and deliberately the ONLY one in this file. The behaviour of door 3 is that it does NOT refuse, which is indistinguishable from "nobody wired the guard" by observation alone — so the thing worth pinning is that the exemption is DOCUMENTED where the next author will look, rather than being an omission they have to rediscover. Its behavioural proof is `subscription-guard-write-doors.integration.test.ts`'s signed-bundle case.

### §168. The door the census found open, with nobody at it

THE DOOR THE CENSUS FOUND OPEN WITHOUT AN ATTACKER TO WALK THROUGH IT (M21.7).

The case above only shows an Operator cannot reach hand-fill at all. It says nothing about the actor who CAN, and hand-fill takes a free-form `typeId` and free-form `properties` — the overlay shape exactly. Before the fix it wrote a `policy` for anyone with `federation:write`.

No BUILT-IN role can demonstrate that, and the reason is the point: `federation:write` is granted to Administrator and Owner (`0012_federation.sql:218-219`) and `policy:write` to Administrator and Owner (`0010_governance.sql:174-175`) — the same two roles, so every actor reachable through today's API who holds one holds the other. The door was safe by COINCIDENCE between two grant lists in two unrelated migrations, with nothing holding them together; `roles.org_id` exists for org-defined roles, and one of those with `federation:write` and no `policy:write` is all it takes. This case builds exactly that role, so the guard is proven to FIRE rather than merely to be present.

THE PEER IS REAL (`handFillPeer`), and that is the other half. With the nonexistent peer this case shipped with, the "nothing was written" assertion below could not have failed whatever the guard did — the write was unreachable regardless — and unwiring the guard turned the case red with a 404 about the peer instead of letting the row land. Measured with the real peer: deleting the `assertGovernanceAuthorityForHandFill` call from `handFillObject` fails this case on `expected 201 to be 403`, with the org-wide `policy` row live in `objects`.

### §169. THE SPECIFIC VIOLATION, PER TYPE

THE SPECIFIC VIOLATION, PER TYPE — and this assertion is where the one-bar-for-the-whole-set assumption first became visible. Most governance-managed types are refused here for a PERMISSION reason and the detail names `policy:write`. A PROJECTION-BOUND type (M25.7's `freeze`) is refused for a TYPE reason, ahead of that check, and its detail names the typed door instead — because `policy:write` was never the bar it should have had to clear. A blanket `/policy:write/` here would have had to be satisfied by weakening the freeze refusal back into a permission upgrade, which is the defect, so the expectation branches.

### §170. Without this, refusing that type outright would satisfy

Without this, DOOR 5 above is satisfied by refusing `policy` at hand-fill outright — which would delete the feature's reason for existing (DESIGN §13: an air-gapped outpost with no bundle transport keys in a commander-origin object by hand, and a commander-distributed global policy is squarely that).

This case used to name a peer that does not exist and assert only `not.toBe(403)` — satisfied by the 404 the missing peer produces, i.e. by a hand-fill route that is broken for every caller. With `handFillPeer` it asserts the write ACTUALLY COMPLETES, which is the claim the control is making. `provenance: 'manual'` is asserted because that is what makes a later signed bundle reconcile over the row (`handfill-repo.ts` module doc) — a 201 that stored an ordinary locally-authored policy would be a different feature.

### §171. THE PROPERTY, ASSERTED ACROSS EVERY DOOR AT ONCE

THE PROPERTY, ASSERTED ACROSS EVERY DOOR AT ONCE — not door by door.

The cases above are per-door and each names its own reason, which is what makes a failure readable. But per-door cases are exactly how this hole survived: DOOR 2 was censused for the PEER-BOUND guard and never re-asked for the governance one, and DOOR 5 was listed with a case that only proved an Operator could not reach it. So the property gets its own statement, over the door table and over `GOVERNANCE_MANAGED_OBJECT_TYPE_IDS` rather than over the two type names we happen to have today — add a third governance type and this widens by itself.

### §172. Every door whose type comes from the request

EVERY door whose `typeId` comes from the request, driven by ONE caller's token.

Parameterised on the actor (M25.7) rather than hardcoding `operator`/`federationOnly` inside each entry, because the bar is per TYPE, not per door table: the same five doors have to be driven by a second actor — one holding every permission they ask for except `freeze:write` — and a copy of this table for that actor is a copy that goes stale when a sixth door lands.

`handFillActorToken` is separate because DOOR 5's front gate is `federation:write`: the `object:write`-only Operator cannot reach it at all, so the original property case handed it the federation-only actor. An actor holding both drives the whole table with one token.

### §173. The payload must be well-formed for the type

THE PAYLOAD HAS TO BE WELL-FORMED FOR THE TYPE, OR THE REFUSAL IS NOT WHAT STOPPED IT.

`ORG_WIDE_POLICY_PROPERTIES` is a `policy` document. Sent as a `freeze` it fails `drizzle/0089`'s registered `required` list at Ajv, and every door answers 400 — which LOOKS like a refusal and is not one: a caller who sends a well-formed freeze walks straight past a schema that was never an authorization control. MEASURED: with the three `isProjectionBoundObjectType` refusals deleted, this table sending the policy bag returned 400 from `/overlays`, and sending the bag below returned 201 with a live `freeze` object. The second is the escalation; only the second proves the guard.

### §174. THE SECOND PROPERTY

THE SECOND PROPERTY (M25.7) — THE BAR IS PER TYPE, AND THE CASE ABOVE CANNOT SEE THAT.

The loop above drives two actors who are refused everywhere, so it measures ONE bar for the WHOLE set and stays green whatever the doors do to an actor who clears the governance bar. That is precisely the gap M25.7 fell into: adding `freeze` to `GOVERNANCE_MANAGED_OBJECT_TYPE_IDS` makes two doors refuse it and instructs the other three to demand `policy:write` — an UPGRADE, not a refusal — and `policy:write` is neither of the two permissions a freeze actually requires. Measured before the fix: a holder of `policy:write` and `federation:write`, with `freeze:write` NOWHERE, minted a federating freeze through `POST /plans`+apply, `/federation/overlays` and `/federation/hand-fill`, with its declared `scopeObjectId` bound to no authority at all and no `freezes` row at this instance — a block that federates and cannot be lifted at either end.

So the second property is stated over `PROJECTION_BOUND_OBJECT_TYPE_IDS` and the SAME door table, with the strongest actor that still lacks the typed door's own permission.

MUTATIONS RUN 2026-08-24, MEASURED not predicted. Baseline: 24 passed.

```text
P-1  DELETE all three `isProjectionBoundObjectType` refusals (`coordination-as-code/plans-repo.ts`,
       `federation/overlay-repo.ts`, `federation/handfill-repo.ts`)
       -> 1 failed, on the FIRST door in the table, with the object live in the response:
          "POST /api/v1/federation/overlays accepted a 'freeze' from an actor with no
           'freeze:write': {…"typeId":"freeze"…"originDomainId":"01a035ea-85f5-…"…}:
           expected 201 to be 403"
P-2  DELETE only `coordination-as-code/plans-repo.ts`'s
       -> "POST /api/v1/plans + /apply accepted a 'freeze' … "status":"applied" …
           expected 200 to be 403"
P-3  DELETE only `federation/handfill-repo.ts`'s
       -> "POST /api/v1/federation/hand-fill accepted a 'freeze' … expected 201 to be 403"
```

Each guard is therefore load-bearing on its own door, not covered by a sibling. Note what P-1 FIRST produced: with the door table still sending `ORG_WIDE_POLICY_PROPERTIES`, the un-guarded overlay answered 400 from Ajv's `required` list, not 201 — a red test for a reason that is not an authorization control at all. `propertiesFor` exists because of that measurement.

### §175. Without this, an actor who can do nothing would satisfy

WITHOUT THIS, THE CASE ABOVE IS SATISFIED BY AN ACTOR WHO CAN DO NOTHING.

Every assertion up there is a 403, and a 403 is what a mis-provisioned role, a broken token or a route-level front gate produces too. This case drives the two doors whose remedy is a PERMISSION rather than a refusal (`/overlays` and `/hand-fill` — DESIGN §13 makes both canonical for `policy`) with the identical token and requires a 201. So the pair together says what the property actually claims: the doors distinguish `policy` from `freeze` by TYPE, and this actor clears the governance bar for the one and is refused the other.

The refusing door (`/objects/{type}`) has no such control by construction — they refuse EVERY governance-managed type for every caller, which their own DOOR cases above already pin.

### §176. THE COMPLETENESS HALF OF THE CENSUS

THE COMPLETENESS HALF OF THE CENSUS — the part that was missing, and the reason the two holes existed at all.

Every behavioural case above tests a door someone thought to list. Nothing above goes red when a SIXTH door appears, and "a census written for a sibling guard, never re-run for this one" is precisely how DOOR 1 and DOOR 2 shipped open. So the census itself is machine-checked, in three layers, each of which fails by FILE NAME on the thing the layer below it cannot see:

LAYER 1 — THE CHOKE POINT'S EXPORTED SURFACE. `graph/objects-repo.ts` is where every local write lands, and layer 3's scan can only look for calls to functions it knows the names of. So the names are not hardcoded: this layer enumerates the module's exported callables and requires the set to equal a REVIEWED classification, then layer 3 builds its pattern from the entries classified `WRITE`. A new exported write wrapper there — the shape that used to be invisible, because the whole file was exempt and its internal delegation `input.typeId` was already an accepted expression — now fails here by name, and once classified `WRITE` every call site of it anywhere in the tree comes into layer 3's scan. The classification is not taken on trust either: every function that touches the `objects` table directly is DERIVED from the source and must be classified `WRITE`, so a direct writer cannot be filed as read-only.

LAYER 2 — RAW WRITES THAT SKIP THE CHOKE POINT ENTIRELY. Layers 1 and 3 are both anchored on `graph/objects-repo.ts`; a module that reached for drizzle (or raw SQL) against the `objects` table itself would be outside both. So every file that writes that table is enumerated and must equal a reviewed table, with the reason each non-choke-point one cannot mint a type.

LAYER 3 — THE DOORS. Every call to the choke point's write surface whose `typeId` argument is NOT a string literal — i.e. every site where the type is chosen at runtime — must equal a REVIEWED table. A new such call site anywhere fails with the file and the expression, which forces the governance question to be asked for it. The table is per SITE, not per expression: every entry carries `×<how many call sites in that file spell it that way>`, so a SECOND door in a file the census already lists is a diff even when it is spelled exactly like the first. That count is a round-2 repair; `scanRuntimeTypeIdWriteSites`'s own doc comment records what the `Set<string>` it replaced was measured hiding.

A string literal is exempt because the type is then fixed at the call site: `createObject({typeId: "component"})` can never produce a `policy` no matter what the request says. Everything else is in the table, including the internal and import-channel sites, each with the reason it is safe — "not listed" and "listed as safe" have to be different states or the table is just a filter.

`deleteObject` IS one of the write names, and its absence was a hole: the scan used to name `createObject`/`updateObject`/`upsertObjectByUrn` only, so a door that DELETED a governance object with a caller-supplied `typeId` passed it silently. Removing a `required` policy is exactly as governance-relevant as installing one. Adding it surfaced `coordination-as-code/plans-repo.ts`'s apply-delete branch (`entry.typeId`), which is accounted for below — `prepareApplyChecks` demands `writePermissionFor(entry.typeId)` for every non-`noop` action, delete included.

Deliberately NOT filtered to `routes/`: three of the five doors (`overlay-repo`, `handfill-repo`, `plans-repo`) live under `federation/` and `iac/`, and a filter is where the next instance hides.

WHAT THESE THREE LAYERS STILL CANNOT SEE — stated because a completeness test that over-claims is worse than none, since it stops the next person looking.
- WHETHER AN EXPRESSION IS CALLER-SUPPLIED. The scan reports the `typeId` EXPRESSION; only a human can say whether `OUTPOST_OBJECT_TYPE_ID` is a constant and `input.typeId` is a request field. That is the reviewing this test forces, not the reviewing it performs. - A CALL WHOSE `typeId` THE WALKER CANNOT RESOLVE. This bullet used to claim such a call "reads as the empty expression … so it FAILS rather than passing … fails safe by construction". THAT WAS FALSE, and false in the direction that matters. Measured on the real tree (2026-08-17, not argued — the walker was run against a mutated `graph/placements-repo.ts`): the old walker took the first `typeId:` LINE within 30 lines below the call, which need not have belonged to that call at all. A one-line `await deleteObject(tx, { ...base, typeId: input.typeId, idOrUrn })` inserted above the existing literal-typed delete resolved to `"placement"` — a literal, therefore skipped — and this describe stayed GREEN with a new caller-supplied door in the tree. The empty expression only occurred when no `typeId:` line at all appeared before the walk stopped; the same mutation moved 20 lines up, where nothing followed it, did go red. THE WALKER WAS FIXED RATHER THAN THE SENTENCE SOFTENED (`resolveTypeIdArgument`): it reads the call's OWN argument object, starting at the call itself so a single-line call is seen, with bracket-depth tracking so a nested object's `typeId` cannot be mistaken for the argument's. A matched call therefore has exactly two outcomes — its own `typeId` expression, or the literal `<no typeId found>`, which no reviewed table contains and which fails loudly. None of that is asserted in prose here: `LAYER 3 (self-test)` runs the walker over synthetic sources holding each spelling, so weakening it turns a NAMED case red. - A CALL THE WALKER NEVER MATCHES, which is the blind spot that remains. The write surface is found by NAME, so an aliased import (`import { createObject as mintObject }`) or a dynamic dispatch (`writers[kind](…)`) is invisible to all of layer 3 — not reported as unresolved, simply not seen. The self-test pins that as a known limit with a fixture, so it is a measured hole rather than a remembered one. LAYER 1 is the partial backstop: a new write surface AT the choke point still fails there by name, whatever its call sites are spelled like. - RELATIONSHIP writes, and every non-`objects` table. Out of scope: a `policy` is an object row.

### §177. LAYER 0 — A GUARD ON THE GUARD

LAYER 0 — A GUARD ON THE GUARD (M22.6, carried in on the rebase).

Two cases above (`DOOR 3` and `PROPERTY`) are loops over `GOVERNANCE_MANAGED_OBJECT_TYPE_IDS`. A loop over an accidentally-empty — or accidentally-shrunk — set passes every one of its assertions VACUOUSLY, which is this repo's second most reliable defect class (a test green for the wrong reason). Pinning the membership means the set cannot quietly lose a member without a red test.

Naming the known members also makes an ADDITION visible in review. A fourth type is driven against every door above automatically, which is the point of the loop — but a reader still sees it arrive here rather than inferring it from a passing suite.

### §178. The freeze object is the wire form, by owner decision

`freeze` is M25.7's (owner decision D6): its graph object is the WIRE FORM of a freeze window, rebuilt into a peer's `freezes` table on import, where it BLOCKS — so minting one through a door that takes a caller-supplied `typeId` would stop releases in another security domain on plain `object:write`. The count moved 3 -> 4 and this line is where the addition is visible in review, which is what the docblock above says this case is for.

### §179. LAYER 1's reviewed table

LAYER 1's reviewed table: every exported callable of `graph/objects-repo.ts`, classified.

`WRITE` entries become layer 3's scan pattern. Add an export to that module and this test names it; classify it `WRITE` and every call site of it in the tree joins the door census.

### §180. Sets `managed_by_stack` on rows an IaC apply DECLARES

Sets `managed_by_stack` on rows an IaC apply DECLARES (drizzle/0068). Same shape as the two above: no insert, no `type_id` in the `set`, and the rows are selected by an id list the caller already resolved. It is a raw write on purpose — the column is not federated content and must not allocate a journal sequence or a revision, so routing it through the choke point would be wrong, not merely unnecessary.

WHY IT IS SAFE IS NOT "IT CANNOT MINT A TYPE" ALONE — this column decides which rows an apply DELETES, so being outside the choke point deserves the second sentence. It is unreachable from any request: nothing in `objects-repo.ts`'s inputs, no route, and no schema can express it, so it moves only when `coordination-as-code/plans-repo.ts`'s apply moves it, on ids that apply already authorized per entry. That is the entire point of moving stack ownership out of tenant-writable `labels`.

### §181. A verified shared entry converges rather than refusing

ADR-0045 D2a adoption: a signature-verified shared journal entry CONVERGES onto the receiver's import-minted artifact anchor (same urn, different id) instead of being skip-and-record-dropped forever. Sets originDomainId/revision/properties on ONE existing row selected `FOR UPDATE` by (type_id = 'artifact', urn) — no insert, no `type_id` in the `set`, and the row's type is pinned in the WHERE, so it cannot mint or retype anything. It is a raw write on purpose: the choke point's update path allocates a fresh journal sequence and revision, and adoption must take the PEER'S origin/revision verbatim (allocating our own would make the adopted copy diverge from the very entry it adopts).

### §182. LAYER 3's reviewed table

LAYER 3's reviewed table: file → the `typeId` expressions it passes to a write, with why.

`×N` is the number of CALL SITES in that file spelling it that way, and it is part of the assertion: a second site is a diff even when it reuses the first one's expression. Bump a count only after asking the governance question of the NEW site — the reason it is written down.

### §183. That second door is gone, removed by the increment

DOOR 2 WAS `routes/executors.ts`'s `proposedObject.typeId`, and it is GONE: increment 6 removed `POST /discovery/accept` (ADR-0047), taking the write site with it. This census noticing the disappearance is the mechanism working — it fails on a site that appears OR vanishes, because either changes the set of places a governance type could reach the graph. Five doors became four; nothing was re-pointed. DOOR 3 — governance types refused outright (`assertNotGovernanceManagedObjectType`), on every verb including DELETE — which is what the four sites are: create, update, upsert-by-URN, delete, all spelled `type`, and all four of them one entry until this table went per-site.

### §184. ---- NOT DOORS

---- NOT DOORS: the type is runtime-valued but no CALLER chooses it. --------------------- A fixed `typeId` per registry, closed over from `TypedRegistryConfig`; never a route param. The governance registries ARE the legitimate door — they carry `writePermission: 'policy:write'` and, for `policy`, `assertPolicyScopeWithinAuthority`. Four sites, one per verb, the same shape as DOOR 3.

### §185. The choke point's own internal delegation

The choke point's own internal delegation: `upsertObjectByUrn` hands the input it was given to `createObject` on the insert path and to `updateObject` on the replace path — hence ×2, both inside that one function. NARROWED from the wholesale file exemption this used to be: only these already-reviewed expressions are accepted, and layer 1 is what fires when a NEW write surface appears in this file rather than a new expression inside an existing one.

### §186. M22.6's typed grant routes

M22.6's typed grant routes — ADDED BY THIS CENSUS RATHER THAN BY THE AUTHOR, which is the mechanism working. The routes landed and this layer went red on the next run; the entry below is the review the redness demanded, not a suppression of it.

NOT A DOOR, for the same reason `OUTPOST_OBJECT_TYPE_ID` is not: `SCAN_OVERRIDE_GRANT_TYPE_ID` is a module constant — a literal behind a name — so no caller chooses this type. The ×2 are the `createObject` at the RAISE route and the `updateObject` at the DECIDE route.

AND THE PERMISSION SPLIT IS THE POINT OF THE PAIR, so it is recorded here where the next reviewer will read it: the raise site authorizes `object:write` at the COMPONENT (raising a `requested` grant authorizes nothing), while the decide site authorizes `policy:write` at the grant's derived tier object, refuses a self-approval, and is the ONLY caller permitted to write the five decision properties — `graph/objects-repo.ts` refuses `status`, `expiresAt`, `decidedByActorId`, `decidedAt` and `decisionReason` at every other local door. A future edit that let the raise site write those, or that let the decide site skip the tier check, would leave this entry looking unchanged, which is why DOORS 4b/4c above assert the behaviour.

### §187. M25.7's freeze wire form

M25.7's freeze wire form — ADDED BY THIS CENSUS RATHER THAN BY THE AUTHOR, the second time the mechanism has worked: `governance/freeze-object.ts` landed and this layer went red on the next run. The entry below is the review that redness demanded.

NOT A DOOR, for the same reason `OUTPOST_OBJECT_TYPE_ID` and `SCAN_OVERRIDE_GRANT_TYPE_ID` are not: `FREEZE_OBJECT_TYPE_ID` is a module constant — a literal behind a name — so no caller chooses this type. The ×2 are `attachFreezeObject`'s `createObject` (minting the wire form of a freeze the caller has ALREADY inserted into `freezes`) and `syncFreezeObject`'s `updateObject` (re-snapshotting it after a lift or a window edit).

THE GOVERNANCE QUESTION, ASKED AND ANSWERED, because that is what this table is for: a `freeze` object federates and is rebuilt into a peer's `freezes` table where it BLOCKS, so minting one through a weak door would stop releases in ANOTHER SECURITY DOMAIN on plain `object:write`. `freeze` is therefore IN `GOVERNANCE_MANAGED_OBJECT_TYPE_IDS`, which is why every behavioural case above now loops over it too.

AND THAT WAS NOT ENOUGH, which is the correction this entry carries. The first version of this note said membership "closes all five doors at once". It closes TWO. At the other three (`POST /plans`+apply, `/federation/overlays`, `/federation/hand-fill`) membership means "demand `policy:write` instead of `object:write`" — an UPGRADE, not a refusal — and `policy:write` is neither of the permissions a freeze needs. `freeze` is therefore ALSO in `PROJECTION_BOUND_OBJECT_TYPE_IDS`, which those three refuse outright; `PROPERTY (per type)` above measures it with an actor holding every permission those doors ask for except `freeze:write`, and its `(control)` sibling proves that actor is still admitted for `policy`.

This module is reachable only from `POST /api/v1/freezes`, which authorizes `freeze:write` at the freeze's own scope plus `federation:write` for the federating form — the latter on the lift and window-edit verbs too, since both re-publish the object.

### §188. Resolves the type argument of the write call there

Resolves the `typeId` ARGUMENT of the write call beginning at `lines[i]`, column `from`.

It walks the call character by character, tracking bracket depth, and accepts a `typeId` key only at the depth of the call's own argument object — `write(tx, { HERE })`. Two consequences, both of them the point:

- it starts AT the call, so `write(tx, { orgId, typeId: input.typeId })` on one line is read; - a `typeId` in a NESTED object, or in a later unrelated statement, is not mistaken for it.

The line-based walker this replaces did neither, and it did not fail when it missed — it took the first `typeId:` line within 30 lines below the call, whoever's it was. Measured 2026-08-17: a one-line `deleteObject(tx, { ...base, typeId: input.typeId, idOrUrn })` added to `graph/placements-repo.ts` resolved to the `"placement"` literal of the NEXT call and was dropped as a literal — a new caller-supplied door, and LAYER 3 green.

When the argument object closes without a `typeId` (built elsewhere, spread in), the answer is `NO_TYPEID`, which is in no reviewed table and so fails loudly. The one thing that gets past is a call this never matches at all — see the self-test's `aliased-import.ts`.

### §189. The third layer's measurement, extracted for reuse

LAYER 3's measurement, extracted from the test that uses it so the SELF-TEST can run it over synthetic sources. Returns file → `<typeId expression> ×<call sites spelling it that way>`, with string-literal types dropped (a literal cannot be chosen by a caller).

PER SITE, NOT PER EXPRESSION. This collected into a `Set<string>` keyed on `(file, expression)` until 2026-08-17, so a second unguarded write in an already-listed file, spelled like the first, was invisible — measured by adding a whole extra `createObject(tx, { … typeId: input.typeId … })` to `federation/handfill-repo.ts`, the very file whose door this census had just closed, and watching LAYER 3 stay green. Thirteen of the tree's twenty-three write sites were hidden behind ten deduped entries at the time.

### §190. THE LAYER THAT WATCHES LAYER 3

THE LAYER THAT WATCHES LAYER 3. Every claim this file makes about what the scan can and cannot see is asserted HERE, against synthetic sources, because the alternative is a comment — and a comment claiming this walker "fails safe by construction" is exactly what shipped in M21.7 round 1 and was measured false the next day. Weaken the walker and a NAMED case goes red.

The KNOWN LIMIT at the bottom asserts the walker's actual, unhappy behaviour. It is a change detector on purpose: improve the walker and it goes red, which is the prompt to move the limit out of the header. What it must never become is silence.

## `apps/server/src/governance/governance-reach.integration.test.ts`

### §191. GOVERNANCE REACH IS TENANT-WRITABLE

GOVERNANCE REACH IS TENANT-WRITABLE — and until this file, nothing recorded when it changed.

The property (`governance/governance-reach.ts`): **the permission that changes what governance REACHES is weaker than, and differently held from, the permission that AUTHORS governance.** `Operator` holds `object:write` + `relationship:write`; `policy:write` belongs to `Administrator` and `Owner` alone.

## This file drives REAL DOORS, deliberately

The unit-testable half of this change is one map diff. What it cannot tell you is whether the recorder RUNS — and "a component built, unit-tested green and never installed" is this repo's dominant defect. So every case here goes through HTTP (`server.app.inject`) or through the repo function a route calls, never through `recordGovernanceReachChange` directly.

## The four measured claims this file pins, two of which were wrong when first stated

- CLAIM (holds): `DELETE /relationships/{id}` authorizes `relationship:write` at BOTH endpoints, symmetric with create. An earlier reading that delete needed only `relationship:read` at the org was a misreading of the LIST handler. `CASE 2` pins the symmetry from the component side. - CLAIM (holds): a COMPONENT-scoped Operator cannot do this at all — authority expands strictly upward, so a component binding satisfies neither endpoint check at a service. `CASE 2`. - CLAIM (holds): route 1 (`objects.domain_id`) move-authorization belongs to `graph/containment-parent-authz.ts` (merged as #244; this branch is rebased on it) and is not duplicated here. This file records reach for route 1; it authorizes nothing. - CLAIM (STALE when stated): "#244 adds no authorization to `relationships-repo.ts`". It changes 96 lines there — but for CYCLES, not for governance reach, so the residual below is untouched by it either way.

## The residual this change addresses, stated exactly

An actor holding `relationship:write` at a SERVICE OR BROADER — but no `policy:write` — can detach a component from a governed service and re-attach it under an ungoverned one. Both endpoint checks pass legitimately; that is an ordinary platform-team Operator. `CASE 1` proves the move still succeeds (this change is detection, not prevention) AND that it is now recorded.

### §192. A component in a governed service, and one without

A component inside a governed service, plus an ungoverned service to move it to. `contains` is `one_to_many` on the TO side (one service per component), so the escape is necessarily delete-then-create rather than a second create.

### §193. ROUTE-1 DEPENDENTS FIRST, AS THE NEGATIVE CONTROL

ROUTE-1 DEPENDENTS FIRST, AS THE NEGATIVE CONTROL. A domain whose live children name it via `objects.domain_id` cannot be tombstoned at all: `deleteObject`'s route-1 orphan guard (M20, the ui-review branch) answers 409 with the blockers named, because that delete would leave the children permanently unadministrable — nothing to record, because nothing happened. If that guard ever went quiet, this half is what goes red first.

### §194. A SECOND component, born UNgoverned, moved IN

A SECOND component, born UNgoverned, moved IN. Deliberately not the seeded component moved out and back: `relationships_org_type_from_to_key` is not filtered on `deleted_at`, so re-creating a soft-deleted (type, from, to) triple 409s. That is worth pinning here in a comment because it is the same fact that makes the CASE 1 escape necessarily a move to a DIFFERENT container rather than a detach-and-reattach in place.

## `apps/server/src/governance/governance-reach.ts`

### §195. WHEN AN OBJECT MOVES, THE POLICIES THAT GOVERN IT CHANGE

WHEN AN OBJECT MOVES, THE POLICIES THAT GOVERN IT CHANGE — AND NOTHING RECORDED IT.

## The property

> **The permission that changes what governance REACHES is weaker than, and differently held > from, the permission that AUTHORS governance.**

`governance/policy-resolve.ts` matches every scope kind — `objectRef`, `selector`, `group`, `ownerGroup`, unscoped — over the target's CONTAINMENT CHAIN (`graph/containment.ts`), and `authz/resolve.ts`'s `scopeExpandCte` expands authority upward over the same edges. Containment is therefore the reach of all governance. It is also ordinary tenant-writable graph data, by THREE routes:

```text
1. `objects.domain_id` — written by every typed `PUT`/`PATCH` under `object:write` (or
   `policy:write` for the governance-owned types);
2. the `contains` edge — created and deleted through the generic `/relationships` endpoints and
   through IaC apply under `relationship:write`; and
3. TOMBSTONING A CONTAINER, which writes no containment field at all and yet detaches everything
   beneath it, because every route above skips a DELETED ancestor. See
   `countContainmentDependents` for why this one is neither of the other two and could not be
   left to the edge cascade it appears to share.
```

`policy:write` is held by `Administrator` and `Owner` alone (`drizzle/0010_governance.sql:174`). `relationship:write` and `object:write` are held by `Operator` and up (`drizzle/0002_rls_rbac_seed.sql:210`). So the actor who can move a component out from under a `required` gate is a strictly weaker, and routinely granted, principal than the one who authored that gate — and the move produced an `object.update` or a relationship create/delete indistinguishable from any other.

This is `docs/proposals/governance-label-namespace.md` §7a/§8.8, which measured the escape and filed it as the next task rather than fixing it. See `docs/proposals/governance-reach-on-containment-move.md` for the options weighed and why this one was taken.

## What this module is, and what it deliberately is NOT

It is DETECTION, not prevention. The move still succeeds. What changes is that a move which alters the set of policies matching the moved object now writes a `Decision` naming every policy gained and lost, plus a hash-chained audit event pointing at it (charter principle 6 — "every engine verdict persists a Decision record with its inputs").

Prevention — requiring `policy:write`, or a new governance-move permission, when a move drops a policy — is a behaviour change to tenant write ergonomics and is proposed for owner decision in §4 of the proposal, NOT taken here. The refusal would be the cheap part; the expensive part is that its trigger is *computed*, so an operator cannot predict which reorganisations will be refused, and the estate's ordinary reorganisation work would start requiring an administrator. That is the same objection that sank option (b) of the label proposal, and it deserves an owner's answer rather than an implementer's.

## Why the cost objection that killed detection for LABELS does not apply here

The label proposal rejected an audit-event remedy partly because "it costs a full policy scan plus a containment walk on the hottest write path in the system" — `createObject`, which the M1 definition of done budgets at 5,000 sequential creates.

This path is COLD, and the difference is structural rather than a matter of degree:

```text
- a CREATE is never a move. `createObject` resolves a default containment parent and is not
  instrumented here at all — a brand-new object has no "before" reach to have changed.
- an UPDATE pays nothing unless `domain_id` actually changes value. A `PATCH` renaming an object,
  or a `PUT` restating the parent it already has, short-circuits before any query.
- a relationship write pays nothing unless its type is `contains`. Every other edge type — the
  overwhelming majority of relationship writes — short-circuits on a string comparison.
- an org with no `policy` rows pays ONE indexed `SELECT` per instrumented write, because
  `matchPoliciesForTargets` returns early on an empty candidate list before walking anything.
```

What remains is two `matchPoliciesForTargets` calls on a genuine reorganisation, which is a human-initiated, low-frequency act.

## Why the repo choke point rather than the routes

The same split `federation/domain-local.ts` and `graph/containment-parent-authz.ts` argue for, but landing on the OTHER side of it — and the reason is that this is a RECORDING, not an authorization.

Authorization belongs at the door because it needs a real requesting subject, and running it at the repo would abort the federation importer and IaC apply, whose actors hold no bindings. A recording has the opposite requirement: it must happen on EVERY write regardless of who is acting, precisely so that a reach change arriving through an import or an apply is as visible as one arriving through `DELETE /relationships/{id}`.

FIVE sites, and the count is the point — `updateObject`, `upsertObjectByUrn`'s hand-fill reconciliation branch (which deliberately does NOT delegate to `updateObject`), `createRelationship`, `deleteRelationship`, and `deleteObject`. Between them they cover every door — the typed routes, the generic routes, IaC apply, `POST /discovery/accept`, federation import, hand-fill and overlays — without enumerating any of them, which is the census failure this repo keeps paying for (`docs/BUILD_AND_TEST.md` §4.4). Each was proved installed by deleting it alone and watching one named case fail; the log is in `governance-reach.integration.test.ts` and the PR body.

## Scope of the recorded delta: the moved object, and why that is the honest boundary

The reach delta is computed for the object whose parent changed, NOT for its descendants. Moving a service moves everything under it, and walking the subtree would be unbounded work on a write path.

It is not a gap in what the record MEANS, because every scope kind here is anchored on the containment chain: a policy that stops reaching the moved node stops reaching everything beneath it by the same edge, so the delta recorded at the moved node is exactly the delta its descendants inherit. The Decision says so in `inputContext.appliesToDescendants`, rather than leaving a reader to assume the record is complete for one object.

### §196. Every policy currently reaching this object, keyed by id

Every policy currently reaching `objectId`, keyed by policy object id.

Keyed by POLICY, not by (policy, matched object): a move that keeps a policy but changes where it attaches — an org-root-scoped policy re-anchoring under a new parent, a selector matching a different ancestor — has not changed what governs the object, and recording it would bury the cases that did under ones that did not.

### §197. How many live objects have this one as a parent

How many LIVE objects have `objectId` on their containment chain as a PARENT — i.e. how many would lose it if it were tombstoned.

## Why this exists: the third door, which writes no containment field at all

Routes 1 and 2 are both a write to a containment value. This one is neither. Every containment route in `graph/containment.ts` joins `parent.deleted_at IS NULL` — deliberately, so "a deleted service must not go on governing live components" — which means **soft-deleting a container silently detaches everything beneath it**, under `object:write` at the container, while every child's own `domain_id` still reads as correct.

It is the widest of the three: one delete moves an unbounded number of objects out of reach of every policy anchored at-or-above the container, and unlike a re-parent it is not visible as a move — nothing about the children changes.

## Why the cascade does not already cover it

`deleteObject` tombstones the row and THEN cascades `deleteRelationship` over its edges. By the time a cascaded `contains` delete runs, the container is already tombstoned, so route 2's before-reach has already lost it and the diff is empty. The per-child recorder is INERT on this path — measured, and the reason this route is instrumented separately rather than assumed covered by the edge cascade it appears to share.

## The routes it counts: `containmentChildrenSql`, COMPOSED — not restated

`graph/containment.ts`'s exported downward fragment, one level, counted. It is the same three arms the depth doors and the read filter descend, so "what contains this row" and "what does this row contain" cannot disagree here.

⚠️ IT USED TO BE A HAND-TYPED COPY, AND IT HAD ALREADY DRIFTED IN TWO PLACES. Because it is ONE LEVEL rather than recursive, a census for the downward WALK did not see it: `containment.ts`'s header asserted "exactly one definition" while this was the third. Both drifts changed what counts as a dependent, and both are now fixed by composing:

```text
- ARM 2 counted `contains` EDGES and never joined the child object, so a live edge to a
  TOMBSTONED child counted as a dependent — contradicting this function's own first sentence
  ("how many LIVE objects"). Reachable: `deleteObject`'s cascade refuses REPLICA edges, and
  legacy rows predate it. The record it produced said "detached 1 contained object(s)" about a
  row that was already gone.
- ARM 3 compared `properties ->> 'componentId'` as RAW TEXT with no `UUID_TEXT_PATTERN` guard
  and no cast, while the fragment casts to `uuid`. Measured on PostgreSQL 16, `uuid` equality is
  case-insensitive and `text` equality is not, so an UPPER-CASE-HEX `componentId` was a parent
  going UP and not a dependent counted DOWN. The cast form is the correct side — see
  `placementNamesObjectSql`'s note, which weighs it against migration 0051's text index and
  decides the mirror is worth more.
```

## The self-exclusion, and why it is HERE and not in the fragment

`c.child_id <> objectId` answers this function's QUESTION — "how many OTHER rows would lose this parent if it were tombstoned?" — for which a row that is its own containment parent (only reachable as legacy or federation-imported data; every write door refuses to create one) loses nothing, because it IS the tombstone.

It must not move into `containmentChildrenSql`. That fragment is defined as the EXACT INVERSE of the four routes `containmentChain` walks up, and `containmentChain` does not exclude self either — a self-parented row is walked, blows the depth bound and refuses loudly (ADR-0037). An exclusion added there would break the inverse property the fragment exists to guarantee, and would silently change a WRITE DOOR (`containmentSubtreeExceeds`) as well as this read.

Applying it across all three arms rather than to arm 1 alone (where the old copy had it) is a deliberate, unreachable-by-any-door widening of the exclusion: a self `contains` edge is refused by `relationships-repo.ts`'s cycle check, and a placement's `componentId` is the resolved component's id, never its own. It only makes the pathological-data answer consistent across arms.

Counted rather than enumerated: the record needs to say how wide the blast radius was, and walking every descendant's before/after reach on a delete is unbounded work on a write path. `count(*)` over the fragment's `UNION ALL` is the sum of the three arms, which is exactly what the three added sub-counts computed.

### §198. Computes the reach AFTER the write

Computes the reach AFTER the write (the caller is inside the same transaction, so this sees the uncommitted change), diffs it against `before`, and persists a Decision + audit event when — and ONLY when — the set of matching policies differs.

Persist-on-change is not an optimisation here, it is the whole contract. A recorder that wrote a row per containment write would reproduce the defect this repo has already paid for once: a gate re-writing a byte-identical Decision every tick, 1.44 GB/day in production, 99.94% duplicates. "Reach changed" is a genuine edge, so the row count is bounded by real reorganisations.

### §199. ROUTE 3's recorder

ROUTE 3's recorder — a CONTAINER being tombstoned, which detaches its descendants without writing any containment field.

## Why it cannot reuse `recordGovernanceReachChange`

That function diffs the SUBJECT's own before/after reach, and for a deleted container the diff is empty by construction: `containmentChain` filters `deleted_at IS NULL` on ANCESTORS but deliberately not on the TARGET itself ("governance may legitimately be evaluated over a deleted object"), so the container's own chain — and therefore its own reach — is identical either side of the tombstone. Reusing it here would compile, run, record nothing, and look installed. This is the shape that has to be written separately rather than adapted.

## What is recorded instead, and why it is the honest statement

The policies reaching the CONTAINER are exactly the ones its descendants inherit THROUGH it, so that set — plus how many objects were hanging off it — is the blast radius, computed in bounded work rather than by walking an unbounded subtree.

It is stated as `mayNoLongerReach` rather than `lost`, and the distinction is real: a descendant reachable by a SECOND route (a component whose `domain_id` and whose service both lead to the same policy) keeps it. Over-reporting here is the right direction — the alternative is per-descendant before/after on a delete — but calling it a loss when it may not be would make the record wrong rather than conservative.

## `apps/server/src/governance/governance.integration.test.ts`

### §200. Governance engine integration suite

Governance engine integration suite (BUILD_AND_TEST.md §8 M4 DoD, Testcontainers postgres:16): everything the unit suite (policy-model.test.ts, evaluate.test.ts, cel-sandbox.test.ts) can't reach because it needs a real graph (containment, `member_of`), a real subprocess plugin host (webhook-control, fake-executor), and the real gate seam (coordination/gates.ts) wired through the real HTTP API. Every scenario drives the public API via `@scp/sdk`'s `ScpClient`, exactly like a real caller — this is deliberately NOT a white-box test of governance/*.ts's internals (those are the unit suite's job).

Most scenarios share ONE server (module-level `beforeAll`/`afterAll`) — real Postgres, real outbox relay, real reconcile loop, real subprocess plugin host — to amortize boot cost, same pattern as coordination.integration.test.ts. The automatic-rollback scenario gets its own server because it needs `FakeExecutorConfig.forcePhase` pre-configured at plugin-instance boot time for specific, test-known target object ids (harness.ts's `fakeExecutorConfig` passthrough, added for exactly this).

### §201. A real HTTP server on loopback

A real HTTP server on loopback (never the internet — BUILD_AND_TEST.md's "tests never touch the internet" is about egress off the test host, not inter-process loopback calls the way Testcontainers Postgres itself already is) that `@scp/plugin-webhook-control` — running for real inside a spawned subprocess — POSTs to. Responds with whatever `ControlOutcomeStatus` the caller asked for via the `x-test-outcome` request header (set per `control_bindings.config`), so ONE server fixture can back many differently-configured control bindings across many tests.

### §202. A required policy scoped directly to a change's own

A required policy scoped directly to a change's own (single) target ALSO gates that target's wave boundary, not just the `validating->accepted` lifecycle edge (coordination/gates.ts's module doc: every wave boundary is real-governance-evaluated in M4, unlike most other lifecycle edges) — so `requireControls`/`requireApprovals` effects on such a policy resolve (control runs for real; approval requests materialize) from wave 0's FIRST gate check, well before — and independently of — the change ever reaching `validating`. This is the right place to wait for an approval request in tests below, instead of `waitForValidating` (which the wave gate blocking would make this policy's own approval/control effects prevent from ever firing).

### §203. Stricter-wins resolution matrix

Stricter-wins resolution matrix (org/domain/service/component conflicts) — real containment walk (policy-resolve.ts) + real merge (policy-model.ts), through `scp policy evaluate`'s dry-run endpoint. The pure-merge algorithm itself is exhaustively table/property-tested in policy-model.test.ts; this proves the DB-driven "gather" half actually feeds it correctly.

### §204. This change's `requireControls` reference synthetic

This change's `requireControls` reference synthetic (non-object) ids on purpose — this test only cares about resolution, never about a real control actually running — so its wave-boundary gate can never satisfy them. Cancel it rather than leaving it to occupy the shared reconcile loop's every-tick attention (and the resulting per-tick 'blocked' Decision inserts) for the remaining lifetime of this describe block's server.

### §205. CRITICAL #1a (adversarial review)

CRITICAL #1a (adversarial review): a lower-scope same-named policy with a FALSE/broken condition must NOT neutralize a higher-scope required policy's effects. The pre-fix evaluator ANDed every contributor's condition, so one false condition zeroed the whole merged policy.

### §206. M22.8 — THE RUN NAMES THE CROSSING IT AUTHORIZED

M22.8 — THE RUN NAMES THE CROSSING IT AUTHORIZED. `gate_kind`/`gate_ref` have been stored on `control_runs` since M4 and were never projected onto the wire. That was invisible while a control produced at most ONE run per change; M22.0a keyed the cache on gate identity, so a change now legitimately carries a lifecycle-edge run AND a wave-boundary run for the same control.

THIS TEST MEASURED THAT AMBIGUITY RATHER THAN ASSUMING IT. The first version of these assertions read the run `waitForControlRun`'s `.find()` happened to return and asserted it was the lifecycle edge; it came back `wave_boundary`. That is precisely the confusion the field removes — an operator reading this listing had NO way to tell which crossing let a change through, and neither did this test. So the assertion is now on the SET.

### §207. CRITICAL #1b (adversarial review)

CRITICAL #1b (adversarial review): a policy's DECLARED scope is bound to the author's own `policy:write` authority — a component-scoped author cannot publish an org-wide (or higher-scope) policy, which was the planting vector that made #1a exploitable.

### §208. Security fast-follow after PR #9's adversarial review

Security fast-follow after PR #9's adversarial review: CRITICAL #1b's scope-authority binding was only wired into the TYPED `/policies` route. The generic `/objects/{type}` endpoint and the IaC plan/apply path both create/mutate the exact same `policy`/`control` graph objects but checked only generic `object:write` (never `policy:write`, never `assertPolicyScopeWithinAuthority`) — a live governance bypass reachable by (a) a component-scoped Administrator (the same actor the test above blocks on the typed route), and (b) an Operator holding ZERO `policy:write` anywhere, planting an org-wide `required` policy demanding an unreachable approval quorum (an org-wide governance DoS any non-Viewer role could trigger).

### §209. A real role name, not the nonexistent one before

`Approver`, NOT the "NonexistentRole" this fixture used to carry. role-model.md §5 step 6's `fromRole` validation refuses a policy naming a non-built-in at the `objects-repo` choke point — which IaC apply passes through — so the old value now 422s. The negative cases below were unaffected (the authority check refuses first, still 403), but the NON-REGRESSION case at the end of this test legitimately succeeds, and it was failing on the role name rather than on the thing under test.

Using a real role keeps the only variable SCOPE AUTHORITY. `count: 99` is retained because the unsatisfiable-quorum shape is the point of the exploit; that part is still expressible, and is a different defect from naming a role nobody can hold.

### §210. Exploit (a, via IaC)

Exploit (a, via IaC): a component-scoped Administrator (holds 'policy:write' ONLY at `component`) tries an org-wide (unscoped) policy through a manifest apply. Also bound as a Viewer at the ORG ROOT — `POST /plans` checks `object:read` at org root regardless of manifest content (routes/plans.ts's own documented scope decision, unrelated to this fix), so without this second binding the actor couldn't reach `/plans` at all and the test wouldn't isolate the `policy:write`/scope-authority variable this fix is actually about. Viewer grants no write permission of any kind, so the actor's WRITE authority stays exactly 'policy:write' at `component` and nothing broader.

### §211. Required control blocks accept; hybrid gate

Required control blocks accept; hybrid gate (scan AND approval — either missing blocks); control outcomes + evidence persisted and referenced by the Decision (joined by controlObjectId — see routes/changes.ts's explain handler / control_runs.decision_id's own doc comment for why there's no raw FK).

### §212. The reason tree's shape, as the transition composes it

transition.ts: `decision.reasonTree = { summary, gate: gate.reasonTree }` — the per-policy detail (name/enforcement/effects/contributingPolicyVersions) lives on the GATE'S reasonTree (evaluate.ts's `GovernanceEvaluationResult.reasonTree.policies`), nested under `gate` here; `inputContext.gate` (gate-orchestrator.ts's `GateOutcome.inputContext`) is a different, coarser object (matchedPolicyCount/effectivePolicyCount) with no `policies` array at all.

### §213. MAJOR #7 (adversarial review)

MAJOR #7 (adversarial review): `approves` edges are DESIGN §10.2 approval EVIDENCE and are system-managed — the generic /relationships endpoint must refuse to fabricate one (a graph-visible fake "X approved this"), so approval evidence only ever derives from the DB-vote-backed approval-vote path.

### §214. MAJOR #5 (adversarial review)

MAJOR #5 (adversarial review): a requireApprovals.scope written as a scope-KIND keyword (DESIGN §10.1's own example `"scope":"service"`) must resolve to the change target's containing service — NOT crash the reconcile tick with a raw `::uuid` cast (22P02).

### §215. The SAME keyword, on the shape migration 0021 actually created

The SAME keyword, on the shape migration 0021 actually created. The test above wires the component to the service with `domainId: service.id` — a component whose *containing domain* IS a service object. That is not the service/component model: 0021 links them with a `contains` edge and leaves `domain_id` pointing at the org root. On that real shape, gate-orchestrator's domain_id-only walk found no ancestor of kind 'service', `resolveApprovalScope` returned null, and the caller treats null as an UNSATISFIABLE required approval — fail CLOSED, with prewarm skipping materialization so no human could vote it through either. Wedged forever.

### §216. Freezes: block, mandatory reason, and a rejected override

Freezes: block, mandatory reason, and — MAJOR #6 — a REJECTED override (unauthorized / no reason) is now routed through the Decision+audit path (409 carrying decision_id, an audited rejected-transition Decision), NOT a rolled-back raw 403. Authorized override succeeds and audits with the reason. SECURITY-SENSITIVE surface.

### §217. A freeze at a service must block that service's components

A freeze scoped at a SERVICE must block that service's components. DESIGN §10.3 lists `service` as a freeze scope level, but gate-orchestrator's freeze walk followed `domain_id` only — services and components are siblings under a domain, so the service id never entered the scope set. `activeFreezesForScopes` matches by EXACT SET MEMBERSHIP, so the freeze was simply not found: it failed OPEN, silently, with the freeze still listed as active.

### §218. CRITICAL #2 (adversarial review)

CRITICAL #2 (adversarial review): a narrow-scope override must NOT slip a change past a BROADER simultaneous freeze the actor has no authority over. `activeFreezesForScopes` can return several; only checking the first one was the bypass.

### §219. `OrgAdmin`, not `Operator`

`OrgAdmin`, not `Operator`: this case is about which POLICY fires, so both actors need to be able to propose AND accept. drizzle/0099 took `change:accept` out of `object:write` and deliberately withheld it from Operator (role-model.md §5 step 3 — the one intentional breakage), so an Operator now 403s at the accept door before any policy is consulted and this case would go green-adjacent for the wrong reason. OrgAdmin holds `change:accept` and is NOT named `Approver`, so the `requireApprovals.fromRole: "Approver"` quorum below is still unsatisfiable by either of them — which is exactly what the member's 409 depends on.

### §220. Emergency changes (DESIGN §10.3)

Emergency changes (DESIGN §10.3) — SECURITY-SENSITIVE surface: only a permitted actor (change:emergency) may flag a change emergency; a flagged change follows a CONFIGURED emergencyPolicy set instead of the normal required policies, never a blanket bypass, and the bypass itself is visible in the Decision trail (never a silent allow indistinguishable from "no policy applied").

### §221. M17.1 (ADR-0013): the `scan-result-control` ControlPlugin

M17.1 (ADR-0013): the `scan-result-control` ControlPlugin — a coordinated Trivy scan VERDICT turned into gate evidence, proven through the REAL gate seam (not a plugin-unit tautology): a required policy naming the scan control genuinely blocks promotion when the verdict fails (over-threshold OR digest-mismatch) and lets it through when the verdict passes. This plugin/gate consumes the verdict; it never runs Trivy itself (charter coordinate-not-execute) — the charter-enumerated `scp-managed-scan` runner is what scans, as the commander's promotion scan step (ADR-0020).

### §222. A real control object bound to the real plugin

A real `control` graph object bound to the real `scan-result-control` plugin, pointed at the Trivy fixture with a fixed scanned `digest` + `severities`. `expectedDigest` is OPTIONAL: pass it to exercise the operator-pinned fallback path (a change with no tracked artifact digest); OMIT it to prove the gate threads the CHANGE's own tracked `sourceRef.artifact_digest` into `context.artifactDigest`, which the plugin binds against (context wins over config, ADR-0013).

### §223. The binding is to the CHANGE's REAL tracked artifact

The binding is to the CHANGE's REAL tracked artifact — NOT to an operator-typed config value. These two tests set NO `config.expectedDigest`; the ONLY digest the verdict can bind against is the change's own `sourceRef.artifact_digest`, which the gate now threads into `context.artifactDigest`. This is what makes ADR-0013's "nothing slipped in" non-tautological: the same `policy:write` author can no longer type the expected digest next to the scan source.

### §224. A regression guard for the digest canonicalization fix

M17.2 REGRESSION GUARD for the artifactDigest canonicalization fix.

A change created through the TYPED first-party report ingress (`POST /change-sources/{kind}/report` — the route M17.2 teaches to carry an SBOM reference) reports its artifact digest as a FLAT camelCase `artifactDigest`. Before M17.2 that value was never lifted to the documented canonical `sourceRef.artifact_digest`; it survived only because `resolveChangeArtifactDigest` also accepts the camelCase spelling as a fallback. M17.2 lifts it properly — and this test proves the fix HELPS rather than breaks M17.1's shipped binding: the scan gate must still bind the Trivy verdict to a report-route change's real digest.

### §225. M10.4 (BUILD_AND_TEST.md §8): the `github-check` ControlPlugin

M10.4 (BUILD_AND_TEST.md §8): the `github-check` ControlPlugin — a GitHub Check Run verdict for the change's OWN tracked commit turned into wave-gate evidence, proven through the REAL gate seam (real subprocess plugin host, real GitHub Checks-API-shaped fixture).

### §226. A loopback server shaped like the provider's checks API

A real loopback HTTP server shaped like GitHub's Check Runs API (`GET /repos/{owner}/{repo}/commits/{ref}/check-runs`). State is keyed by `ref` (the commit sha in the URL), so ONE fixture backs many differently-configured bindings/changes across tests — same pattern as `startTrivySource`. `callCountFor` lets a test PROVE the plugin was invoked again (not served from `control_runs`' cache) after the M10.4 expired-cooldown bypass fires.

### §227. Backdates the cached expired row past the recheck window

Directly backdate the cached 'expired' row past `control-runner.ts`'s EXPIRED_RECHECK_INTERVAL_MS (30s) — the deterministic, non-flaky way to prove the cooldown bypass actually re-invokes the plugin rather than caching 'expired' forever the way every OTHER status is cached (which would permanently deadlock this wave, since a wave-boundary gate is asked well before CI on a fresh commit has even started).

### §228. Automatic rollback fires on wave (control/gate) failure

Automatic rollback fires on wave (control/gate) failure — its own server because it needs `FakeExecutorConfig.forcePhase` fixed at plugin-instance boot time for specific, test-known target object ids (created with an explicit `id:`).

### §229. `forcePhase` has no trigger-kind distinction

`forcePhase` has no trigger-kind distinction (this file's module doc) — `autoRollbackTargetId` fails EVERY trigger, sync or rollback alike, so the auto-triggered rollback change's own wave fails too and never reaches 'accepted'. That's deliberately exercised by the SECOND assertion below (no infinite rollback-of-a-rollback regress), not a test gap — this test's real subject is the TRIGGER itself, not the rollback's own eventual success (already proven by coordination.integration.test.ts's "rollback restores prior known-good state" case).

### §230. SIX TICKS, not 30 arbitrary seconds

SIX TICKS, not 30 arbitrary seconds: propose -> executing, dispatch the wave target, observe the forced failure, mark the wave failed, and one more tick for the `failed` branch to trigger the rollback. See `reconcileTicks` for why a deadline in seconds against the advertised 1s tick is the same arithmetic error as the sleeps this commit removed — the real tick measured 2025ms median with ONE org.

### §231. The deadline this commit was measured failing on

THE DEADLINE THIS COMMIT WAS MEASURED FAILING ON: a legacy copy of this file, run in a parallel fork beside the fixed one under deliberate CPU load, timed out here after 15_000ms. The rollback change is a SECOND full lifecycle (propose -> executing, dispatch, observe the forced failure, mark the wave failed), so it needs five ticks of its own and 15s bought fewer than two.

### §232. The negative is asserted from a positive signal

The negative below is asserted from a POSITIVE signal, not from a fixed sleep: the failed-wave branch that WOULD have re-triggered is the same one that sets `reconcile_blocked_at`, and a parked change is filtered out of `listChangeRowsInStates` forever. Once parking is observed, the engine has taken its one and only look at this failure — so "no rollback-of-a-rollback" is settled rather than merely not-yet-observed, and a slow box cannot make it vacuous.

## `apps/server/src/governance/group-scope-ownership.integration.test.ts`

### §233. GROUP SCOPE'S **OWNING**-SUBJECT HALF

GROUP SCOPE'S **OWNING**-SUBJECT HALF — ADR-0016 §2a (2026-08-15).

DESIGN §10.1 has always said a group-scoped policy "applies when the change's **acting or owning subject** is a `member_of` that group". Only the ACTING half was ever built. For a policy that CONSTRAINS — and every enforcing consumer of `matchPoliciesForTargets` is a constraint — a scope that fails to match is a constraint that does not apply, so the missing half was a FAIL-OPEN: a non-member could evade a group's own gate by being the one to push the button, and the whole mechanism was structurally inert wherever the actor is `SYSTEM_ACTOR_ID` (every wave boundary).

The shipped, live exposure is the M17.5 scan-requirement gate: `resolveEffectiveScanThreshold` merges a per-severity MIN over what matched, so a group-scoped scan CEILING that failed to match left the effective threshold LOOSER than the operator authored — no error, no log, the gate just permits more. Test (f) below is that exposure, closed.

WHAT THIS FILE PINS, in both directions: - (a)(b)(c) the fail-open is CLOSED: a group-scoped constraint now applies to a NON-MEMBER, and to `SYSTEM_ACTOR_ID`, when the work belongs to the group; - (d) the negative control — it still applies to a MEMBER (the acting half is untouched); - (e) THE MIGRATION PIN — the acting half is preserved EXACTLY where no ownership exists: a non-member acting on an unowned target still gets no match, before and after. This is the test that says the change is additive rather than "group scope now matches everything"; - (f) the live scan-threshold exposure, end to end through the real resolver; - (g) the tier LABEL: an ownership match anchors at the OWNED object, so ADR-0016 §5's promise that a block can show WHICH tier set the floor survives; - (h) ownership is graph data, so revoking it revokes the governance.

Everything asserts against real Postgres through the real matcher — never a hand-built match set.

### §234. This is the whole migration-safety claim in one test

This is the whole migration-safety claim in one test. The change is ADDITIVE: it adds the ownership half and touches nothing else, so on an estate with no `owns` edge into the target's chain, a group-scoped policy behaves exactly as it did before 2026-08-15. If this ever fails, group scope has been widened into "matches everything", which is a different (and wrong) design than the one ADR-0016 §2a records.

## `apps/server/src/governance/instance-freeze-admission.integration.test.ts`

### §235. M25.3 — THE INSTANCE-SCOPED

M25.3 — THE INSTANCE-SCOPED (PLATFORM) FREEZE TIER, end to end against real Postgres (drizzle/0086, docs/proposals/campaigns-rework.md §2, owner decision D1).

The guarantee under test: *a freeze declared by this DEPLOYMENT'S OPERATOR, addressed by stage coordinate and carrying no `org_id` at all, holds the targets it covers in EVERY org on the instance — including an org that has declared no freeze of its own and cannot author or (by default) override one.*

WHAT EACH CASE IS FOR, AND WHY NONE OF THEM IS THE OBVIOUS ONE-DIRECTION SHAPE
A. WIRING — the route is INSTALLED, not merely written. Delete the `registerInstanceFreezeRoutes` line in `app.ts` and this goes red; nothing else here would notice, because every other case could reach the table through the repo layer. B. THE TWO CREDENTIALS — an authenticated tenant Owner cannot write this surface; the operator token can. A one-directional version (only the success) would pass against a door with no lock at all. C. THE BLOCK ACROSS THE TIER BOUNDARY — an org with no freeze of its own, blocked. D. ADDRESSING, BOTH WIDTHS — `environment` alone reaches every region of it; `environment` + `region` reaches exactly one and admits its siblings (D5 per-target admission, proving that property is NOT tier-specific). E. THE OVERRIDE RULING, BOTH DIRECTIONS — the SAME org-root Owner holding `freeze:override` is REFUSED against a non-overridable platform freeze and ADMITTED once the operator sets `overridable`. Either direction alone is the vacuous shape: refusal alone passes against a freeze nobody can ever override, admission alone passes against no check at all. F. CRITICAL #2 ACROSS TIERS — a change covered by an org freeze AND a platform freeze needs BOTH satisfied, and satisfying one is not authority over the other. G. RLS UNDER A REAL LEAST-PRIVILEGED PRINCIPAL — `RawScpAppClient` authenticates as `scp_app`, NOT as the Testcontainers superuser. This is non-negotiable and it is why it exists: migrations 0029/0035/0036/0074 all shipped operator-write tables with NO WRITABLE PRINCIPAL AT ALL and the suite was green throughout, because the bootstrap user bypasses grants and RLS unconditionally. 0083 §2 then did it AGAIN. The `scp_operator` half is probed with `has_table_privilege` and `pg_policies` for the same reason — the superuser connection every other case runs on is structurally incapable of observing either.

EVERY CASE USES A UNIQUE `environment` LABEL. The instance tier has no `org_id`, so within this file's database (isolation is per FILE — see `vitest.integration.config.ts`) one case's freeze is live for every other case. A shared environment name would make the cases order-dependent in a way that reads as flake; a `matchAllEnvironments` freeze is authored in exactly ONE case and lifted before that case returns.

### §236. The org-tier freeze beside the platform one

The ORG-tier freeze beside the platform one, authored through the ordinary operator door.

M25.9 MOVED THIS OFF THE REPO SEAM. It used to insert the row directly with `createdByActorId: org.orgId` — the ORG object, which is nobody's subject — and cases F and I below then retract it as `admin`. Owner ruling D1 made lifting a freeze you did not declare cost `freeze:override`, so a fixture attributed to the org root turned both of those lifts into a 403 for a reason neither case is about. Authored through `POST /api/v1/freezes` as `admin`, the creator IS the retracting subject and the lift stays the plain `freeze:write` act the cases mean it to be. The platform tier's fixture already went through its own shipped door for the same reason (see `platformFreeze`).

### §237. The LIFECYCLE edge, deliberately

The LIFECYCLE edge, deliberately: it keeps any-target-frozen => block (there is no such thing as accepting three quarters of a change) and it is the ONLY path on which the override loop is reachable at all — `EvaluateWaveGateContext` carries no `overrideFreeze` field. That is the proposal's "honest limit" and it is pre-existing, not created by M25.3.

`targetObjectIds` MUST BE THE CHANGE'S DECLARED TARGETS — components/services — and never a placement, because that is what the production caller supplies. `coordination/gates.ts`'s `evaluateLifecycleGate` builds this set as `targetObjectIdsOf(changeObject.properties)`; only the WAVE boundary ever sees placements (the plan compiler expands targets into them). Passing a placement here was a review finding: it made cases E and F green in a configuration the lifecycle edge cannot produce, and it is the reason case E2 below exists — a component target declares no stage coordinate, so at this edge ONLY a deployment-wide platform freeze matches.

### §238. THE CONSEQUENCE, STATED SO IT CHANGES LOUDLY

THE CONSEQUENCE, STATED SO IT CHANGES LOUDLY: `EvaluateWaveGateContext` carries no `overrideFreeze` (pre-existing, and true at the org tier too), so the override loop runs ONLY on `validating -> accepted`. Combine the two facts and `overridable: true` is exercisable for `allEnvironments` freezes and for nothing else. If a later change gives the wave boundary an override path, or expands a component target to its placements at the accept edge, this assertion goes red and the ADR-0040 §7 limit has to be rewritten rather than quietly lapsing.

### §239. The sharp arm the nobody case does not measure

THE SHARP ARM, and the one the `nobody` arm above does NOT measure: an actor who holds `freeze:override` SOMEWHERE — enough to satisfy the org freeze at its own scope — and not at the org root, where the admitted platform freeze is checked. A Viewer proves nothing about the quantifier because it fails both halves; this principal fails exactly one, which is what "every freeze, at ITS OWN scope" means. Scope expansion runs DOWNWARD, so an Owner at the component reaches the component and never the root above it.

### §240. THE FIXTURE IS THE BUG

THE FIXTURE IS THE BUG: `readStageCoordinate` trims what the GRAPH declares and `instanceFreezeCovers` compares with `!==`, so an untrimmed `" env "` on the operator's side matched nothing at all while `PUT` returned 200 and `GET /v1/instance/freezes` listed the row cleanly. 0086's `instance_freezes_match_ck` cannot close it — `length(btrim(...)) > 0` TESTS a value, it does not STORE one.

### §241. DIRECTION TWO — A PLATFORM FREEZE IS NEVER STOOD ASIDE

DIRECTION TWO — A PLATFORM FREEZE IS NEVER STOOD ASIDE. `POST /v1/changes/{id}/rollback` requires `object:write` at the org and nothing else: no `freeze:override`, no reason, no operator token. A tier-blind D7 made that the CHEAPEST route past the freeze `checkFreeze` tells the caller "no tenant role can override, however privileged" — cheaper than the override it is contrasted with, which is the contradiction this arm pins.

### §242. The other side of that barrier, asserted separately

BARRIER 2's other side, and the reason it is asserted separately: under FORCE ROW LEVEL SECURITY a grant with no applicable policy is denied every statement no matter what it was granted, and a policy with no grant is denied too. 0029/0035/0036/0074 shipped the read half only and NOTHING in the database could write them; 0083 §2 repeated it. The suite could not see either, because every operator write in it runs as a superuser.

Probed by INTROSPECTION rather than by connecting as `scp_operator`, deliberately: the role is NOLOGIN by design (drizzle/0076 — a role that cannot authenticate fails closed if provisioning is skipped), so there is no password to connect with and `has_table_privilege` + `pg_policies` are the honest instruments.

## `apps/server/src/governance/instance-freezes-repo.test.ts`

### §243. The matching rule of the instance-scoped freeze tier

`instanceFreezeCovers` — the matching rule of the instance-scoped freeze tier (drizzle/0086, campaigns-rework §2), measured without a database.

IT IS PURE FOR EXACTLY THIS REASON. The integration suite proves the rule reaches a real wave through a real graph; what it CANNOT cheaply enumerate is the cross product of three freeze shapes against four coordinate shapes, and the two combinations a reviewer guesses wrong live in that cross product:

```text
* an `environment`-only freeze covers a stage that declares NO region (it is still that
  environment — "freeze prod" means prod, not "the parts of prod that named themselves"), and
* a REGION-NARROWED freeze does NOT (that stage has not said it is that region).
```

The two pull in opposite directions from the same null, which is why both are here.

## `apps/server/src/governance/instance-freezes-repo.ts`

### §244. M25.3 — THE INSTANCE-SCOPED

M25.3 — THE INSTANCE-SCOPED (PLATFORM) FREEZE TIER'S READ PATH (drizzle/0086, docs/proposals/campaigns-rework.md §2 — owner decision D1).

`freezes-repo.ts` is the ORG tier: a freeze names a graph object and `containmentChain` decides coverage. This file is the tier ABOVE org, which has no `org_id` and no object id to name, and therefore matches on a STAGE COORDINATE instead (0086's header; `regional-executors.ts`'s `readStageCoordinate` is the one reader of that convention).

READS ONLY — the write path is `routes/instance-freezes.ts`, over a DIFFERENT CONNECTION
`scp_app` (the `TenantTx` this file runs on) holds SELECT and nothing else on `instance_freezes`: no write grant, and no write RLS policy in any verb. Operator writes go over `withOperatorDb`'s `scp_operator` connection, which is not a `TenantTx` at all. So there is no `createInstanceFreeze` here and there cannot be one — a write verb in this file would fail at the database on every real deployment while passing under the Testcontainers superuser, which is exactly how four tables shipped with no writable principal (drizzle/0076's header).

### §245. EVERY LIVE INSTANCE FREEZE COVERING `at`

EVERY LIVE INSTANCE FREEZE COVERING `at` — no coordinate filter at all.

THE WINDOW PREDICATE IS STILL KNOWN IN EXACTLY ONE PLACE, AND IT IS NOT THIS FUNCTION
`freezes-repo.ts`'s `activeFreezesInWindow` claims in its own docblock to be THE ONLY PLACE that knows `starts_at <= at < ends_at AND lifted_at IS NULL`, and that claim is load-bearing: `graph/containment.ts`'s header records that three copies of ONE walk drifted until a service-scoped freeze failed OPEN, and the half-open boundary (`lte` on the start, `gt` on the end) is precisely the detail two copies stop agreeing about — silently, in either direction. `coordination/service-board.ts` already made that claim false once by hand-rolling the comparison in JS, and M25.2 had to undo it.

A second table cannot share the first table's `where` clause, so the predicate is factored into `freezeWindowCovers` — a column-generic SQL fragment — and BOTH tiers' window reads are built from that one fragment. There is still exactly one place that knows the predicate; it moved down a level rather than being copied.

SOFT LIFT is part of the predicate for the same reason it is at the org tier (drizzle/0085): a retracted freeze stops being returned here and therefore stops holding anything on EVERY path at once, with no lift-specific code in reconcile, the gate, or the board.

Served by `instance_freezes_window`. Returns `[]` on the overwhelmingly common deployment — this table ships empty — which is what preserves `freeze-scope.ts`'s INERTNESS property: the cost of M25.3 to an instance with nothing frozen is ONE extra indexed read per change per tick, and not a single additional containment walk or property lookup.

### §246. Does this platform freeze cover a target at that stage

DOES THIS PLATFORM FREEZE COVER A TARGET AT THIS STAGE COORDINATE? — pure, no database.

`coordinate` is `null` for a target that declares no stage at all: a legacy component-shaped wave target, or a placement whose deployment-target carries no `properties.environment` (`readStageCoordinate`'s three cases). Such a target is covered ONLY by an explicitly deployment-wide freeze — an environment-addressed freeze reaches the stages that SAY they are that environment, following ADR-0031's rule that locality is declared and never inferred.

THE THREE FORMS, and the second is the one a reviewer guesses wrong: * `matchAllEnvironments`            -> every target, coordinate or not. * `matchEnvironment` alone          -> EVERY REGION of that environment, including a stage that declares no region at all. "Freeze prod" means prod, not "the parts of prod that named themselves". * `matchEnvironment` + `matchRegion`-> that one stage. A target with no declared region does NOT match a region-narrowed freeze: it has not said it is that region.

Comparison is EXACT (`!==`), and both sides are trimmed BEFORE they get here — `readStageCoordinate` trims what the graph declares, and `InstanceFreezeMatchSchema` trims what the operator sends.

THAT SECOND HALF WAS MISSING AND THIS DOCBLOCK ASSERTED IT ANYWAY (M25.3 review finding 3). What it originally claimed was that 0086's `instance_freezes_match_ck` closed the operator side; it does not, and could not — `length(btrim("match_environment")) > 0` TESTS a value, it does not STORE one, so `" prod"` satisfies the CHECK, is accepted with 200, lists cleanly, and then matches nothing at all. A freeze that holds nothing while reading as in force is the one failure mode this tier must not have, and the guard against it now lives where the value enters (the Zod schema's `.trim()`), with this comparison staying exact. Recorded rather than quietly corrected because a well-written comment naming a hazard is a signal to sweep, not evidence it was handled.

Deliberately NOT case-insensitive: `properties.environment` is an opaque operator-chosen label everywhere else in this repo (`listRegionTargets` compares it with `=`), and one matcher folding case while the region view does not is the drift this file is careful about.

### §247. The whole live table, newest window first

The whole live table, newest window first — the operator LIST read.

Includes LIFTED rows, deliberately and for the same reason `listFreezes`/`getFreeze` do at the org tier: lifted is a FIELD, not an absence. An operator asking "what did we freeze last week" is asking about rows this instance retracted, and the id in a months-old block Decision has to stay resolvable through this surface.

## `apps/server/src/governance/move-enforcement.integration.test.ts`

### §248. The opt-in second bar on a move, through the real path

`governance:move` — THE OPT-IN SECOND BAR ON A CONTAINMENT MOVE, THROUGH THE REAL DOORS. (docs/proposals/governance-reach-on-containment-move.md §9.2/§9.5; owner ruling 2026-08-18.)

Every case goes through HTTP (`server.app.inject`), never a repo function, for the reason `routes/containment-move-authz.integration.test.ts` states: the failure mode this feature exists to prevent is a DOOR that forgot the check, and a repo-level test cannot see a door.

MUTATION LOG — each mutation applied ALONE, run, reverted, restoration verified with `cmp`
m1  remove the `assertGovernanceMoveAdmits` call in `graph/containment-parent-authz.ts` → RED: "PATCH /services/{id} …", "PATCH /objects/service/{id} …", "the org root as a DESTINATION is NOT exempt …", "the INSTANCE rung activates …" (all four reach that door) m2  remove ONLY the twin in `iac/plans-repo.ts::prepareApplyChecks` → RED: "POST /plans/{id}/apply …" ALONE — the M24 lesson (a door-only fix ships inert on IaC) m2b remove ONLY the `contains` call in `prepareApplyChecks`' RELATIONSHIP loop (route 2) → RED: "POST /plans/{id}/apply — a `contains` RELATIONSHIP entry …" ALONE. Added after review found the first round had twinned route 1 (`domainId`) and not route 2, leaving an Operator able to make through apply the move `POST /relationships` refuses them. m3  remove the call in `graph/components-repo.ts::setComponentService` → RED: "PUT /components/{idOrUrn}/service …" alone m4  remove the two `contains` calls in `routes/relationships.ts` → RED: "POST /relationships (contains) …" and "DELETE /relationships/{id} (contains) …" m5  make the org root exempt (skip when the destination is `orgId`) → RED: "the org root as a DESTINATION is NOT exempt …" AND "POST /relationships (contains) …" — recorded rather than tidied, because the second RED is the point: a `contains` DELETE's destination IS the org root, so the exemption would silently un-govern the whole take-it-out-of-the-container verb, not just the explicit move-to-root m6  drop the instance-rung OR in `resolveGovernanceMoveEnforcement` (`enforced: rungs.length > 0`) → RED: "the INSTANCE rung activates …" alone m9  remove the `contains` call in `routes/executors.ts`'s `POST /discovery/accept` loop → RED: "POST /discovery/accept (contains onto a PRE-EXISTING child) …" alone m9b drop the `!createdInThisBatch.has(toId)` carve-out at that same door → RED: the SUCCESS half of that case (a fresh child contained in its own batch) — the case that keeps "governed" from quietly meaning "discovery is off"

THE INSTANCE RUNG IS AN INSTANCE-GLOBAL FIXTURE
`governance_move_instance_rung` has no `org_id` and the integration suite runs `singleFork` against ONE shared Postgres, so the row is deleted in a `finally` AND at teardown no matter how this file exits — a rung left enabled would enforce `governance:move` for every later file.

### §249. A component with NO `contains` edge

A component with NO `contains` edge — the only shape a `POST /relationships` of `contains` can succeed against (the 0022 partial unique index permits exactly one live parent). The generic `/objects/component` route REFUSES an orphan by design (create-strict), and since increment 6 removed `POST /discovery/accept` there is NO HTTP door that produces one. It is therefore made the way the harness's `createOrphanComponent` now makes one: straight through `graph/objects-repo.ts`, which is the same function every import path calls.

### §250. The second IaC hole, found after the first round shipped

THE SECOND IaC HOLE, found in review after the first round shipped: the twin had been added to the object loop (route 1, `domainId`) and not to the relationship loop (route 2, `contains`) — so an Operator could perform through apply the exact move `POST /relationships` refuses them, and a manifest's `component.service` change compiles to precisely this pair of entries. Remove ONLY the relationship-loop call and only this case goes red.

### §251. THE m9 CASE IS GONE WITH ITS DOOR

THE m9 CASE IS GONE WITH ITS DOOR. `POST /discovery/accept` was the third caller-supplied- `typeId` relationship door and this case proved a `contains` through it was refused as a move. Increment 6 removed the route (ADR-0047), so there is nothing left to drive: the guard it exercised (`assertGovernanceMoveAdmits` on a `contains` write) is still proven by the `POST /relationships` and IaC-apply cases above, which are the doors that remain.

Recorded rather than deleted silently, because the mutation log at the top of this file names m9 and a reader finding no such case should learn why, not wonder.

### §252. The one place this check deliberately disagrees

The one place this check deliberately disagrees with `containment-parent-authz.ts`'s two exemptions. Those are proved from CUSTODY (the root's holders already hold every rooted row); `governance:move` is about governance REACH, and moving a row out of a governed subtree up to the org root is exactly the reach reduction it gates. Make the root exempt and only this case goes red.

## `apps/server/src/governance/move-enforcement.ts`

### §253. The opt-in second bar on a containment move

`governance:move` — THE OPT-IN SECOND BAR ON A CONTAINMENT MOVE, resolved in exactly one place. (docs/proposals/governance-reach-on-containment-move.md §9.2; owner ruling 2026-08-18; drizzle/0083.)

## What the lattice is

Enforcement is a set of enabled RUNGS. A rung is either THE INSTANCE (a deployment-wide singleton, operator-authored) or ONE CONTAINER OBJECT (org root, containment domain, service, assembly). Enforcement APPLIES TO A MOVE iff the instance rung is enabled, or any object on the MOVED object's containment chain, or any object on the DESTINATION container's chain, carries a rung. That OR is the monotone half of the owner's ruling — *"if enabled there, orgs can't disable it; same with the next layer … if an org enables it, a service can't disable it"* — and the DELETE verb enforces the other half by refusing 409 while an upper rung is enabled, rather than reporting a disable that leaves the state enforced anyway.

When enforcement applies, the actor must hold `governance:move` AT-OR-ABOVE the moved object AND AT-OR-ABOVE the destination — the deliberate mirror of #244's `object:write` pair, so an operator learns ONE rule about moves rather than two.

## There is no computed trigger, and that is the design

Whether a move needs the permission depends ONLY on which rungs are set — never on which policies happen to match the object, and never on whether the move would drop a policy. §4(a) of the same proposal argues that at length: a bar that appears and disappears as unrelated governance is authored elsewhere is unpredictable to the person being refused, and un-explainable in a refusal sentence. Predictability over precision (charter priority 1: simplicity).

## THE ORG ROOT IS NOT EXEMPT HERE — the one place this check DIFFERS from #244's pair

`graph/containment-parent-authz.ts` exempts the org root at BOTH ends, and both exemptions are proved there: the org root's holders already held custody of every rooted row, so a move to or out of the root can only SHRINK the custodian set, and a shrinking custodian set is not the escalation an `object:write` pair exists to stop.

THAT PROOF DOES NOT TRANSFER, because this permission is not about custody. Governance REACH runs with containment: the policies that match an object are the ones scoped at it or at something on its chain (`governance/policy-resolve.ts`). Moving a row OUT of a governed subtree and up to the org root is precisely the reach REDUCTION this permission gates — it is the archetypal case, not an edge case — so exempting the root would exempt the very move the owner asked to govern. The custody argument and the reach argument point in OPPOSITE directions at the root, and each check follows its own. Cross-referenced in `containment-parent-authz.ts` beside its two exemptions so the difference reads as deliberate rather than as one of the copies having been missed.

## EVERY WRITER OF A CONTAINMENT PARENT, and which of them is a door

The first version of this header claimed the minter census was complete when it had been run only over `federation` and `discovery`, and that scoped claim — stated as a conclusion about the whole caller-facing surface — is precisely what hid TWO live holes (IaC apply's relationship loop, and discovery accept's, both closed 2026-08-18 after review). Re-run filterless (`grep -rna "'contains'\|\"contains\"" apps/server/src` plus every `updateObject`/`domainId` writer); this list is the whole of it, and a new writer belongs on it BEFORE it ships:

ROUTE 1 (`objects.domain_id`) — gated at `graph/containment-parent-authz.ts` `resolveDeclaredContainmentParent` (door (a); every typed + generic PATCH goes through it) and `iac/plans-repo.ts::prepareApplyChecks`'s object twin (door (b)). ROUTE 2 (`contains` edge) — THREE caller-facing minters, all now gated: - `graph/components-repo.ts` :104 (create — not a move, no prior reach to leave) and :180/:238 (`setComponentService`, door (c)); - `routes/relationships.ts` :104 POST / :252 DELETE (door (c)); - `iac/plans-repo.ts::prepareApplyChecks`'s RELATIONSHIP loop, which calls `createRelationship`/`deleteRelationship` at :1288/:1293 with the manifest's own `typeId` (door (b), route 2) — a manifest's `component.service` change compiles to exactly this; - `routes/executors.ts`'s `POST /discovery/accept` relationship loop, which resolves BOTH endpoints to pre-existing rows and mints with the REAL principal (door (c), third copy).

## What is carved out, and why the carve-out is structural rather than a flag

Federation import, the federation OVERLAY and HAND-FILL are NOT subject to this bar, and no code in them says so — because none of them can reach a door. Measured, not assumed:

```text
- `federation/import-repo.ts` (:208 `upsertObjectByUrn`, :363 `updateObject`),
  `federation/handfill-repo.ts` (:294), `federation/overlay-repo.ts` (:188) and
  `federation/outposts-repo.ts` (:142/:569/:634) call the REPO directly. They never call
  `resolveDeclaredContainmentParent`, which is where door (a) lives, and none of them mints a
  `contains` edge (see the census above).
- The subjects those paths carry are synthetic (`FEDERATION_IMPORT_ACTOR_ID` and friends) and
  hold no bindings, so running an authorization down there would abort every import rather than
  protect anything — the same argument `graph/containment-parent-authz.ts`'s "authorization at
  the door, invariant at the repo" section makes, applied unchanged.
```

DISCOVERY ACCEPT IS NO LONGER ON THAT LIST. It looked like an import and is not one: it takes its proposal from the REQUEST BODY under `requireAuth`, so its subject is a real principal and its endpoints may be live rows. Only the objects it created IN THE SAME REQUEST are exempt there, and for the create-is-not-a-move reason, not the federation reason.

The receiver does not referee: a peer's authority already decided the move, and refusing its journal would diverge the replica from the authority that owns it.

## Why a refusal here carries no `decision_id`

Every door below throws from INSIDE the caller's `withTenantTx`, so a Decision written here would be rolled back with the refusal it explains and the id would name a row that does not exist — a dangling pointer is worse than none. The refusal instead carries the whole explanation in its sentence: which rung is enabled, at which tier and name, and which END the actor lacks the permission at. The out-of-band shape that WOULD persist a Decision on a refusal (`federation/promotion-repo.ts`: record in a fresh committed transaction, then throw) needs a `Db` handle, which no repo-level door has. OWNER RULING 2026-08-18 (ADR-0038 §3): door-level AUTHORIZATION refusals are sentence-only — consistent with every other permission 403 in the system (object:write, policy:write, #244's own move refusals carry none); charter principle 6's `decision_id` is for ENGINE VERDICTS (gates, policies), which these are not. Not an open question any more; the sentence is the record, and the audit log carries the write that was refused.

### §254. THE INSTANCE RUNG

THE INSTANCE RUNG — no row means DISABLED, decided here and nowhere else.

Byte-for-byte the reasoning `dependencies/subscription-resolution.ts`'s `readInstanceSubscriptionUnlock` carries: re-deriving "absent = off" in a route is how the API and the doors come to disagree about a deployment nobody has configured — the loudest possible bug in the safest-sounding line of code.

### §255. Does the move lattice reach this object, and why

Does the `governance:move` lattice reach this object, and why?

Walks `containmentChain` — the SAME walk the authorization scope expansion and the policy matcher use, so a rung can never describe a containment relationship the rest of the system does not believe in — and joins the rung table onto it. Loud on the depth bound (ADR-0037): a chain that exceeds the bound throws rather than answering "not enforced", because failing OPEN here would silently un-govern exactly the deep subtrees an org bothered to put a rung on.

The read half of the whole feature: the doors, the explain route, the CLI and the Admin page all call this, so a UI verdict and a refusal cannot disagree.

### §256. THE DOOR CHECK

THE DOOR CHECK. Fail-closed, called AFTER the door's own `object:write`/`relationship:write` pair, and a no-op — one cheap singleton read plus at most two chain walks — on every deployment with no rung set, which is all of them until an operator sets one.

ORs enforcement over the MOVED object's chain and the DESTINATION's chain (the monotone rule), then demands `governance:move` at BOTH ends. The org root is NOT exempt at either end — see the module header for why the custody exemption in `containment-parent-authz.ts` does not transfer.

### §257. The rung write verbs

The rung write verbs. Authorization and the Decision/audit pair live one module over (`governance/move-rung-write.ts`, shared by the HTTP door and the IaC apply door — the follow-up named in proposal §9.6 Q4, now built); what lives HERE is the SHAPE of an enablement and the monotone refusal, so no door can disagree with another about either.

### §258. Disable one rung

Disable one rung — REFUSED 409 while any UPPER rung is enabled, naming it.

"Orgs can't disable it" is the owner's monotone half, and this is where it is real. Reporting a successful disable while the OR above keeps every move under this subtree enforced would be the worst of both: the operator believes they turned it off, the refusals continue, and nothing in the system says why. THE INSTANCE RUNG COUNTS AS AN UPPER RUNG — it is above everything by construction.

Disabling a rung that is not enabled is a 404 at the route, not here.

## `apps/server/src/governance/move-rung-write.ts`

### §259. THE RUNG WRITE'S EFFECTS, IN ONE PLACE

THE RUNG WRITE'S EFFECTS, IN ONE PLACE — shared by every door that may enable or disable one.

WHY THIS MODULE EXISTS RATHER THAN A SECOND COPY IN THE IaC APPLY PATH
`routes/governance-move.ts` was the only writer when the lattice was built. Adding the IaC surface (charter principle 3: API -> SDK -> CLI -> IaC, the follow-up named in proposal `governance-reach-on-containment-move.md` §9.6 Q4) makes `coordination-as-code/plans-repo.ts`'s apply a SECOND door into `governance_move_rungs`, and a rung write is not a row write — two things happen around it, and both are obligations rather than niceties:

1. A DECISION IS RECORDED, under one kind, so `GET /decisions?kind=governance.move_enforcement` answers "every rung this org ever enabled or disabled" in one index descent. A second writer that skips it makes that sentence FALSE for whichever rungs happened to arrive through IaC — the class of self-contradiction this repo keeps finding in its own accepted documents — and breaks charter principle 6 for exactly the acts an auditor would go looking for. 2. AN AUDIT EVENT IS APPENDED, hash-chained in the same transaction as the write.

Both are inseparable from the row, so they live WITH the row rather than beside each caller. The route and `coordination-as-code/plans-repo.ts` call these two functions; neither reimplements any of it. This is `dependencies/producer-declaration.ts`'s shape, applied unchanged — that module's header carries the longer form of the argument.

WHAT IS *NOT* HERE, AND WHY
- THE AUTHORIZATION. It is the same pair at both doors (`governanceMoveRungScopeCheck`), but the doors CONSUME it differently: the route authorizes inline, while `coordination-as-code/plans-repo.ts` pushes every check into one list its route drains to completion BEFORE any mutation runs. So the pair is expressed once and applied twice, exactly like `dependencyProducerScopeCheck`. - THE MONOTONE REFUSAL on a disable (409 while an upper rung is enabled). It lives in `move-enforcement.ts`'s `disableGovernanceMoveRung`, which both doors reach through here, so a manifest that drops a rung under an enabled ancestor fails its apply with the verb's own sentence rather than with a second, differently-worded copy. - THE "IS THERE A RUNG HERE AT ALL" CHECK. The route 404s on the caller's own `idOrUrn`; the IaC path 404s as an apply-time prune miss. Same rule, two genuinely different messages, and each door has already had to establish the answer before it gets here. - THE SUBJECT-TYPE CHECK (`assertRungSubjectType`). Same reason: the route runs it on a live lookup, the IaC path re-derives it from the STORED diff.

### §260. THE AUTHORITY EVERY RUNG WRITE TAKES

THE AUTHORITY EVERY RUNG WRITE TAKES — `policy:write` AT-OR-ABOVE THE SUBJECT (owner ruling 2026-08-18, ADR-0038 §2), expressed ONCE so the route and the IaC apply path cannot drift apart.

Enabling a rung is a governance-authoring act and is held to the same bar as authoring a policy; `policy:write` is Administrator/Owner only (drizzle/0010:174). `authorize` expands strictly UPWARD from the scope object, so naming the subject IS "at-or-above the subject".

THE SHAPE IS A PAIR, NOT A CALL, because the two doors consume authority differently — see this module's header, and `dependencies/producer-declaration.ts`'s `dependencyProducerScopeCheck`, which this mirrors.

### §261. Enable: write the row, record it, append the event

ENABLE: write the row, record the Decision, append the audit event. The whole act, so no door can perform a fraction of it.

Idempotent by construction — `enableGovernanceMoveRung` is an upsert, because re-stating an enabled rung is what `scp apply` and an idempotent PUT do routinely. The Decision and the audit event are written UNCONDITIONALLY on each call: somebody really did perform the act, and the growth is bounded by human action rather than by a loop (`insertDecisionIfChanged` is the guard for TIMER-driven writers, which this is not).

### §262. Disable: delete the row, record it, append the event

DISABLE: delete the row, record the Decision, append the audit event.

THE DELETE RUNS FIRST, and the order is load-bearing: `disableGovernanceMoveRung` throws 409 while an upper rung is enabled, so a refused disable must not leave a Decision claiming enforcement was turned off. (The throw would roll the transaction back anyway; writing it first would still be a record of something that did not happen, in a file the next reader would copy.)

## `apps/server/src/governance/placement-governance.integration.test.ts`

### §263. GOVERNANCE OVER A PLACEMENT WAVE TARGET

GOVERNANCE OVER A PLACEMENT WAVE TARGET (ADR-0026).

THE PROPERTY, AND WHY THESE ARE THE TESTS
Under stage-shaped compilation a `change_wave_targets.target_object_id` is a PLACEMENT, not a component. Every wave-boundary governance decision is derived from that id — policy matching and freeze scoping walk its containment chain, and the CEL context reads the object itself.

A placement's chain used to be `[org root, placement]` and nothing more: its `domain_id` is the org root and it has no incoming `contains` edge. So the day a wave target became a placement, every component- and service-scoped policy stopped matching at the wave boundary and every service-scoped freeze failed OPEN — silently, because a policy that stops matching produces the same `allow` verdict as a policy that was never meant to match. On the live estate that is 11 `required` component-scoped prod-gate policies.

Each test below therefore asserts a VERDICT (or a permission answer), never a message or a count: the question is whether governance still fires over the new shape, and the only honest evidence of that is the decision it produces. Every one is written so that removing the fix flips the verdict from `block` to `allow` — the direction that matters, since `allow` is what a silently dead gate looks like.

ONE EXCEPTION, ADDED BY M25.2 (2026-08-23), and it is an exception on purpose. The two FREEZE cases assert the per-target RESOLVER (`GateOutcome.frozenTargets`) as well as the verdict, because M25.2 relocated freeze enforcement onto a per-target seam in `coordination/reconcile.ts` — so a partially frozen wave now correctly ALLOWS, and the verdict alone stopped being a faithful measure of "did route 3/route 4 reach this placement?". Re-expecting those two to whatever the new verdict happens to be would have kept the file green while deleting the only live evidence that either route still works on the freeze path. Both halves are asserted instead; see the comment on the service-scoped case.

MUTATION LOG (each applied ALONE against a passing suite, then reverted)
| Mutation | Result |
| `containment.ts`: drop route 3 (the placement -> component branch of the LATERAL union) | the component-scoped policy, service-scoped policy, service-scoped freeze and approval-scope tests all FAIL (verdict flips to `allow` / scope resolves to null) | | `containment.ts`: make route 3 read `deploymentTargetId` instead of `componentId` | the same four FAIL — the route must reach the right endpoint, not just any endpoint | | `gate-orchestrator.ts`: `governanceSubjectOf` returns `targetObjectId` unconditionally | the CEL-subject test FAILS (`subject.typeId` is `placement`, the condition goes false, the required policy stops firing, verdict flips to `allow`) | | `authz/resolve.ts`: drop the shared fragment from `scopeExpandCte` | the component-role-reaches-its-placement test FAILS | | `containment.ts`: drop the CASE guard, cast `componentId` bare | the malformed-`componentId` test FAILS with a Postgres cast error instead of an answer |

ROUTE 4 (the deployment-target as a containing scope, owner-approved 2026-08-02):

| Mutation | Result |
| `containment.ts`: drop route 4 from `placementParentsSql` | the target-scoped policy, target-scoped freeze and target-bound role tests all FAIL. The malformed-`deploymentTargetId` test correctly still PASSES — it asserts the COMPONENT route survives a bad place, so it is not a test of route 4's presence | | `containment.ts`: point route 4 at `componentId` instead | the same three FAIL — reaching *an* endpoint is not the same as reaching the right one | | `containment.ts`: drop the CASE guard (shared by both endpoints) | BOTH malformed tests FAIL with `invalid input syntax for type uuid`, which is how the guard is shown to cover the endpoint route 4 added and not just the original |

One mutation REFUTED a claim rather than confirming it, and the claim was corrected: swapping `service-board.ts` to the pair fragment leaves its tests green, because arm 1's `IN (componentIds)` filter discards the deployment-target row. See `placementComponentParentSql`'s comment — the fragments stay separate on narrower, true grounds.

### §264. A required policy whose one effect is an uncast approval

A `required` policy whose single effect is an approval nobody has cast. If it MATCHES and FIRES, the gate blocks; if it fails to match, the gate allows. That asymmetry is the whole measurement: `allow` is exactly what a silently dead gate returns.

### §265. REWRITTEN FOR M25.2, NOT RE-EXPECTED

REWRITTEN FOR M25.2, NOT RE-EXPECTED. Read this before touching the assertions.
This case and its route-4 twin below are the only live coverage of containment routes 3 and 4 ON THE FREEZE PATH. M25.2 moved freeze ENFORCEMENT off the whole-wave verdict and onto a per-target seam in `coordination/reconcile.ts`'s trigger loop, which means the verdict alone is no longer a faithful measure of "did the freeze reach this placement?" — a partially frozen wave now correctly ALLOWS.

Flipping these two tests' expectations to match whatever the new verdict happens to be would be the vacuous-test failure in its purest form: the suite would stay green while the only assertion that route 3 still reaches a placement's SERVICE quietly stopped being made. So both halves are asserted instead —

```text
(a) THE RESOLVER still reports the service as covering this placement (`frozenTargets`,
    which is `governance/freeze-scope.ts`'s per-target answer, and the input BOTH the gate
    and the reconcile-loop actuator consume); and
(b) THE VERDICT is still `block` when EVERY target is covered, which is the case M25.2
    deliberately kept whole-wave, and `allow` the moment an uncovered sibling joins the
    wave — with (a) still true of the covered one.
```

Drop route 3 and (a) goes empty in both shapes, which no verdict assertion could have caught.

### §266. ROUTE 4 — the deployment-target as a containing scope

ROUTE 4 — the deployment-target as a containing scope. Unlike route 3 these do not restore lost gating; they make gating START, which is why the route was an owner decision (2026-08-02) rather than part of the fix. The live estate's twelfth `required` prod-gate policy is scoped exactly this way and had never once matched.

## `apps/server/src/governance/policy-model.ts`

### §267. Policy shapes, plus the pure stricter-wins resolution

Policy document shapes + the PURE stricter-wins resolution algorithm (DESIGN.md §10.1, BUILD_AND_TEST.md §8 M4: "Resolution: walk containment org→domain→service→component, inherit downward, STRICTER-WINS on conflict; a local domain may add strictness, never weaken a higher-level requirement unless explicitly permitted").

Deliberately split from `policy-resolve.ts` (which does the impure DB work of finding which policy objects match a given target's containment chain): everything in THIS file is a pure function over already-gathered data, per BUILD_AND_TEST.md §4.1's rule ("anything testable as a pure function must be written as a pure function") — the unit-test DoD bullet ("stricter-wins merge logic table-driven") targets exactly this file.

--- The stricter-wins model, concretely ---

A policy MATCHES a target's containment chain at some ancestor (org/domain/service/component — `MatchedPolicy.scopeDepth`, 0 = org root, increasing toward the target). Two matched policies are considered "the same policy, refined at different scope levels" when they share the same `name` — e.g. an org-wide "prod-security" policy and a domain's own "prod-security" policy both governing the same target. `resolvePolicies` groups matches by name and, within each group, computes ONE effective policy:

```text
- **effective enforcement = the MAX severity across the group** (required > recommended >
  advisory) — a domain-level instance can never reduce what an org-level instance already
  requires, because there is no "weaken" effect in this schema (MVP deliberately ships no
  such effect — DESIGN's "unless explicitly permitted" escape hatch is not implemented; every
  instance in a name-group can only ever raise the bar).
- **effective effects = the UNION across the group** (`requireControls` arrays merged as a
  set union; `requireApprovals` entries merged by `(fromRole, scope)` pair, count taking the
  MAX) — a local instance can ADD a stricter requirement (another required control, a higher
  approval count) but adding is the only thing possible; nothing in the merge can remove an
  entry another instance in the group already contributed.
```

Policies with DIFFERENT names never merge with each other — each is evaluated (condition + effects) independently, and a transition blocks if ANY required-enforcement policy (after this merge) has an unmet effect. This is what makes "local adds strictness, never weakens" a structural property of the merge rather than a convention someone could violate by mis-scoping a policy: there is no code path that can produce an effective enforcement below the strictest contributor, or an effective effect set missing something a contributor required.

### §268. How this policy matched

How this policy matched (for the reason tree — DESIGN §10.1 "explainability is the return value"): which ancestor object's scope declaration matched, and how.

`group` and `ownerGroup` are the TWO HALVES of one `scope.group` declaration (DESIGN §10.1's "acting **or** owning subject"), and they are labelled apart on purpose: - `group` — the ACTING subject is transitively `member_of` the scoped group. Anchors at the org root (depth 0); depends on WHO pushed the button. - `ownerGroup` — an OWNING subject of the matched object (the group itself, or anything transitively `member_of` it, holding an `owns` edge) is in the scoped group. Anchors at the owned object's real depth; independent of who is acting. Added 2026-08-15 (ADR-0016 §2a) — shipping only the `group` half was a fail-open for every CONSTRAINT effect. Collapsing both onto `group` would make the label name a branch that covers two different facts, which is how a provenance label goes quietly false.

### §269. A merged requirement, carrying its winning contributor

A merged requireApprovals requirement, carrying its WINNING contributor's own document coordinates (`originPolicyObjectId`/`originPolicyVersion`/`originEffectIndex` — the position of this exact effect within THAT contributor's own `properties.effects` array). This is what lets `governance/approvals-repo.ts` materialize one `approval_requests` row per distinct requirement keyed by (policy, policy version, effect index) — the same dedup key whether this requirement came from a single policy or was raised by a stricter local override (the winning contributor's coordinates are stable across repeated resolution as long as nothing edits the documents).

### §270. The union of a set of contributors' effects

The union of a set of contributors' effects — `requireControls` set-unioned, `requireApprovals` merged by `(fromRole, scope)` with the MAX count winning (its winning contributor's origin coordinates carried). Pure and order-independent. Extracted (adversarial-review CRITICAL #1a) so BOTH `resolvePolicies` (over every contributor, for the summary view) and `governance/evaluate.ts`'s `resolveFiredPolicies` (over ONLY the contributors whose OWN condition fired) compute effects identically — the fix hinges on the effect union being taken over the *firing* subset, never over a set gated by an AND of every contributor's condition.

### §271. One name-group's merged, effective requirement

One name-group's merged, effective requirement — a SUMMARY view (union of every contributor's effects, max enforcement) surfaced for `contributors` and the emergency/auto-rollback flags.

IMPORTANT (adversarial-review CRITICAL #1a): the `requireControls`/`requireApprovals`/ `enforcement` fields here are the "if EVERY contributor fired" union and MUST NOT be used to decide what to enforce — a contributor whose own `condition` is false/absent-yet-erroring contributes nothing at gate time. The authoritative, condition-aware effect set is computed by `governance/evaluate.ts`'s `resolveFiredPolicies` over the *firing* contributors only. These summary fields exist for `resolvePolicies`' own unit tests and for cheap `emergencyPolicy`/`autoRollbackOnFailure` group flags (neither of which is condition-gated).

### §272. The pure stricter-wins merge

The pure stricter-wins merge (module doc comment). Grouping key is `name`; within a group, enforcement takes the max severity and effects union. Order of `matches` does not affect the result (verified by the property test) — the whole point of a declarative merge. See `EffectivePolicy`'s own doc comment on why the merged effect fields are a summary, not the enforcement authority.

## `apps/server/src/governance/policy-resolve.ts`

### §273. The impure "gather" half of policy resolution

The impure "gather" half of policy resolution (DESIGN.md §10.1) — everything here touches the database; `policy-model.ts`'s `resolvePolicies` is the pure merge that consumes this file's output. Kept deliberately separate per BUILD_AND_TEST.md §4.1's "anything testable as a pure function must be written as a pure function."

Resolution walks the target's containment chain (org → domain → service → [assembly] → component — the assembly rung is OPTIONAL and arrives via the same generic `contains` walk — DESIGN §10.1; `graph/containment.ts`'s `containmentChain`, shared with the gate orchestrator so a policy and a freeze can never disagree about what contains what) and, at every ancestor, checks every `policy`-typed graph object in the org for a scope match (explicit `objectRef`, label `selector`, or `group` — DESIGN §7's `member_of` expansion, reused). Org policy counts are expected to be small (dozens, not thousands) — a full scan per gate check is the honest, simple MVP choice; a materialized `governed_by`-indexed lookup is a natural later optimization behind this exact same function signature if profiling ever shows it's needed (DESIGN §5's own "escape hatch" precedent for named queries).

GROUP SCOPE HAS TWO HALVES — AND SHIPPING ONLY ONE OF THEM WAS A FAIL-OPEN
DESIGN §10.1 has always said a group-scoped policy "applies when the change's **acting or owning subject** is a `member_of` that group". Until 2026-08-15 this file implemented only the ACTING half (`isMemberOf(actor, group)`), so `scope.group` meant, exactly and only, *"the human whose credential is on the request that triggered this evaluation is transitively in this group"*.

That reading is fine for a policy that GRANTS or ROUTES. It is a FAIL-OPEN for a policy that CONSTRAINS, because **a constraint that fails to match is a constraint that does not apply**. Every enforcing consumer of this function is a constraint: - `gate-orchestrator.ts` `evaluateGovernanceGate` — fewer `requireControls`/`requireApprovals`, and a group-scoped `emergencyPolicy` that misses leaves an emergency change UNGATED; - `scan-requirements.ts` `resolveEffectiveScanThreshold` — the shipped ADR-0016/M17.5 gate, whose per-severity MIN silently loses a group-scoped scan CEILING, leaving the effective threshold LOOSER than the operator authored. No error, no log; the gate just permits more. So a non-member could evade a group's own gate simply by being the one to push the button.

Worse, the acting half is STRUCTURALLY INERT wherever the actor is `SYSTEM_ACTOR_ID` (the nil UUID, which is `member_of` nothing): `coordination/reconcile.ts`'s wave-boundary gate, `campaign-reconcile.ts`, `shouldAutoRollback`, and `prewarmGovernanceForChange` all pass it. The same document therefore governed the `validating → accepted` edge and NOT the wave boundaries of the very same change.

The OWNING half (below, `via: "ownerGroup"`) closes both. It is deliberately ADDITIVE — it only ever adds matches, never removes one — so for every consumer the change is monotonically TIGHTENING and no gate that fired before can stop firing. See ADR-0016 §2a for the decision, the before/after, and the migration note.

### §274. A match found within the bound is valid regardless

ADR-0037 asymmetry: a match found within the bound is valid regardless of what else the frontier was doing — membership is a reachability fact. Only NON-membership can be fabricated by a cut walk, and a fabricated "not a member" here makes a group-scoped REQUIRED policy silently not apply: fail-open, the worst direction this repo knows (ADR-0026). So: match wins; no-match with a still-expanding frontier refuses; clean no-match stays false.

### §275. DESIGN §10.1's **OWNING**-subject half of group scope

DESIGN §10.1's **OWNING**-subject half of group scope: which of `chainObjectIds` are OWNED by `groupObjectId` — either directly (the group itself holds the `owns` edge) or through any transitive `member_of` member of it (a team, a user, a service account).

DIRECTION. `isMemberOf` above expands a subject UPWARD to the groups it belongs to; this expands a group DOWNWARD to its members. Same `member_of` closure, walked the other way, because here the group is the known end and the owners are not.

WHY IT ANCHORS ON THE CONTAINMENT CHAIN, NOT ON THE TARGET ALONE. Ownership scope inherits downward exactly as `objectRef` and `selector` scope do: if a group owns a SERVICE, its policy governs that service's components. Restricting the match to a direct `owns` edge on the target itself would make ownership scope the only scope kind that does not inherit — and would fail open on every component whose ownership is recorded at the service, which is the normal shape (`routes/ownership.ts`). Note `owns`'s registered `to_types` (`0002_rls_rbac_seed.sql:173-176`) are service/component/domain/deployment-target/contract and deliberately EXCLUDE `organization`, so this can never match at the org root — an ownership match is always strictly more specific than the unscoped/acting-subject anchor.

NO ARBITRARY DEPTH BOUND, DELIBERATELY. `UNION` (not `UNION ALL`) over a bare `member_id` makes this cycle-safe by construction: a row already produced is never re-produced, so a `member_of` cycle terminates the recursion instead of spinning. `isMemberOf` above caps at `depth < 10` because it carries a `depth` column, which defeats `UNION`'s own dedup and forces a cap; that silent-truncation property is a KNOWN, SEPARATELY-TRACKED defect at six sites and is not touched here. This function does not add a seventh.

### §276. The shared walk both matchers run

The shared walk both `matchPoliciesForTargets` and `matchPoliciesForTargetsByTarget` run — candidates, chains, the ownership cache and the four scope-kind branches, all identical. Only WHAT HAPPENS WITH A MATCH differs between the two callers (one flat dedup vs. one dedup per target), so that is the only thing factored out as a callback. Keeping this walk in ONE place is deliberate: two copies of one containment/scope predicate drifting apart is exactly how this file describes the group-scope fail-open ever having shipped (module doc above).

### §277. (b) THE OWNING-SUBJECT HALF (ADR-0016 §2a, 2026-08-15)

(b) THE OWNING-SUBJECT HALF (ADR-0016 §2a, 2026-08-15) — "this rule governs work ON what this group owns." Independent of who is acting, which is exactly why it closes the fail-open (module doc). It DOES have a real anchor — the owned object on the chain — so it records at that object's true depth rather than at the org root. That is not cosmetic: `scan-requirements.ts` derives the six-tier explainability label from `matchedAt.objectId`'s type, so anchoring a service-ownership match at the org root would report an org-tier ceiling for a service-tier requirement (ADR-0016 §5's promise that a blocked promotion can show WHICH tier set the binding floor).

### §278. Gathers every policy matching any target's chain

Gathers every policy that matches ANY of `targetObjectIds`' containment chains (or the actor's group membership), each annotated with WHERE/HOW it matched — ready to hand to `policy-model.ts`'s `resolvePolicies` for the stricter-wins merge. Deduplicates a policy that matches the same target-chain-object more than once.

THAT DEDUP IS NOT THEORETICAL, and this comment used to say it was ("can't happen with today's three match kinds"). The scope keys are independent `if`s, not `else if`s, so a document carrying two of them matches on OR and CAN record the same (policy, object) twice — e.g. `{objectRef: <a service>, group: <the group that owns it>}`. The surviving `via` names the FIRST branch that matched, not the only one (branch order: objectRef → selector → group → ownerGroup). The MATCH is right either way (the entry, its anchor and its depth are identical whichever branch produced it); only the provenance LABEL is lossy, and it is lossy in a documented, deterministic direction. Widening `via` to a set would change the shape of every persisted reason tree and is deliberately left out of this change.

DEDUPES ACROSS TARGETS, on purpose: this is the UNION every caller here wants except one (`binding-policy/reconcile-bindings.ts`'s per-target attribution — see `matchPoliciesForTargetsByTarget` below, which exists BECAUSE this dedup is unsafe for that caller: two targets sharing a common ancestor matched by the same policy would collapse into one entry with no record of which target(s) it covers).

### §279. The per-target-attributed sibling of that matcher

The per-target-attributed sibling of `matchPoliciesForTargets`, for callers that need to know WHICH target a match covers rather than the flat union — today just `binding-policy/reconcile-bindings.ts`'s `gatherContributions`, which used to call the function above once per target (one full policy-table scan + group-ownership resolution per target) purely to get this attribution. Runs the SAME shared walk once for the whole `targetObjectIds` list — one scan, one ownership resolution — and dedupes PER TARGET (`${policyId}::${objectId}` within each target's own list) rather than across all of them, so the result for each target is identical to what an isolated single-target call to `matchPoliciesForTargets` would have returned. Every id in `targetObjectIds` gets an entry, even an empty one, so a caller can index the result without deciding what a missing key means (mirrors `freezesByTarget`'s contract).

## `apps/server/src/governance/policy-scope-authz.ts`

### §280. Binds a policy's declarable scope to the author's own

Binds a policy's DECLARABLE scope to the author's own `policy:write` authority (adversarial review CRITICAL #1b). This function is the ONLY thing in the tree that bounds a policy's reach to its author's authority, so read the next section before reasoning about it — a security argument was built here on a premise about object containment that the code does not have.

A POLICY'S CONTAINMENT PLACEMENT (`domain_id`) BOUNDS NOTHING. VERIFIED, NOT ASSUMED.
A policy object has a containment parent like every other object, and it is tempting to read that placement as some part of the policy's reach — a policy "inside" a component being somehow local to it, so that only its DECLARED scope needed a separate control. Placement contributes NOTHING to reach. Three sites, each checkable in a minute:

1. **Candidate selection has no `domain_id` predicate at all.** `listPolicyCandidates` (`governance/policy-resolve.ts`) selects EVERY non-deleted `policy` row in the org — `and(eq(orgId), eq(typeId, "policy"), isNull(deletedAt))` and nothing else. A policy written under one component is a candidate for every target in the org. 2. **Matching reads only `properties.scope`.** `matchPoliciesForTargets` (`governance/policy-resolve.ts`) matches unscoped / `objectRef` / `selector` / `group` against the TARGET's `containmentChain`. The policy row's own `domain_id` is never consulted. 3. **Merging is by `name`.** `resolvePolicies` (`governance/policy-model.ts`) groups matches by `m.name`, takes the max enforcement and unions effects. Two same-named policies merge regardless of where either one sits; `matchedAt.depth` only orders `contributors` for the reason tree and is documented there as having no bearing on the result.

So the CRITICAL #1a vector — plant an org-wide same-named policy and bend governance across the org — needs no particular placement. Placement is not a weak version of this control; it is a different control over a different question, and the two must not be conflated:

- **CUSTODY — the containment `authorize`.** At create, the route checks `policy:write` at the resolved containment parent (`routes/typed-registries.ts:202-207`, scope = `resolveDomainId(body.domainId)`): it decides WHERE the row may be PLACED. Because PATCH (`:344-349`) and DELETE (`:401-406`) then re-check at the row's OWN id, and `scope_expand` (`authz/resolve.ts`) walks upward from there through `objects.domain_id`, that placement is what decides WHO MAY MUTATE OR DELETE THE ROW AFTERWARDS. Custody of the document, not reach of the document. - **JURISDICTION — this function.** It reads `properties.scope` and nothing else, and it is the sole guard for CRITICAL #1a/#1b. Its whole three-door census is `routes/typed-registries.ts:134` (typed `/policies`: POST, PATCH-with-properties, PUT) and `iac/plans-repo.ts:733` and `:758` (IaC apply, create and update branches); the generic `/objects/policy` door does not need it because `assertNotGovernanceManagedObjectType` (`routes/objects-generic.ts`) refuses every write verb on `policy`/`control` outright. Delete any one of those three and the vector is open again — nothing downstream re-derives it.

That is why an actor holding `policy:write` at a single component, who legitimately passes the custody check by writing the row at their own component, must still be refused an org-wide (unscoped, label-selector, or group) `scope`: custody was never evidence of jurisdiction.

Rule (fail-closed): - `scope.objectRef` (and no selector/group): the policy is bounded to that concrete object, so the author must hold `policy:write` at-or-above THAT object. - anything broader — unscoped, a label `selector` (which can match objects org-wide), or a `group` scope — has org-wide blast radius, so it requires `policy:write` at the ORG ROOT.

The `group` case got BROADER on 2026-08-15 (ADR-0016 §2a) and this rule needed no change, which is the point of writing it conservatively. It used to reach "wherever a member acts"; it now also reaches "whatever the group or its members OWN, and everything contained beneath that" — DESIGN §10.1's owning-subject half, which had never been built. Both readings are org-wide in the worst case, so org-root authority was already the right bar and remains it.

A `selector`-scoped policy could in principle be bounded to the subtree its selector can match; that's a strictly-safe future refinement — requiring org-root authority for any selector is the conservative choice for now (you can't publish a broad-matching policy without broad authority).

## `apps/server/src/governance/policy-write-gate-ordering.integration.test.ts`

### §281. PIN — OWNED BY THE M21.7 SESSION

PIN — OWNED BY THE M21.7 SESSION. DO NOT "FIX" THIS IN A UI MILESTONE.

`POST /api/v1/policies` (routes/typed-registries.ts, the shared typed-registry factory) authorizes `policy:write` at `resolveDomainId(body.domainId) ?? org` FIRST, and only THEN runs the scope-authority check (`assertPolicyScopeWithinAuthority`: an `objectRef`-scoped policy needs `policy:write` at-or-above THAT object). RBAC scope expansion walks UPWARD only. So a principal whose `policy:write` binding sits AT a component — the exact "component team enables its own dependency subscription" shape ADR-0032 §6 describes — is refused at the FIRST gate whenever the body omits `domainId`, before the check that would have admitted them ever runs.

This file MEASURES that ordering and pins it as it stands today, so that: - the M21.6 web client knows it must send `domainId` = THE COMPONENT ITSELF with an objectRef-scoped policy (case 2 below: any org object is accepted as `domainId`, RBAC expands upward from it so component-, domain- and org-bound administrators all pass, and the policy lands contained by the component where its team can PATCH/DELETE it — the containment domain refuses the component-bound team, case 3), and its 403 copy names "policy:write at this component (or above)"; - whoever changes the ordering (the M21.7 session has taken it to the owner) sees exactly which assertion flips and updates this pin deliberately, rather than the behaviour drifting behind a UI-milestone commit.

Nothing here is a statement that the ordering is RIGHT. It is a statement of what the server DOES, measured, so nothing else in this round is built on a guess about it.

THE TRIPWIRE (M21.7 session decision, 2026-08-16): the FIRST case — 403 WITHOUT `domainId` for a component-bound `policy:write` — is deliberately kept as measured and is the assertion that fires if anyone lands the "ergonomic default" (authorize a bounded `objectRef` policy at-or-above the ref when the body omits `domainId`) WITHOUT an owner decision. The M21.7 derivation found that default splits AUTHORIZED SCOPE from WRITTEN CONTAINMENT: `assertMayDeclareDomainLocal` would run at the component while the row lands at the org root — a policy the component team was allowed to author but could never PATCH/DELETE (those routes authorize at the policy's own id). If that case flips to 201, stop: either the owner decided, or the split just shipped.

## `apps/server/src/governance/scan-db.test.ts`

### §282. M13.3b-ii unit tests (ADR-0020, proposal §13.3b)

M13.3b-ii unit tests (ADR-0020, proposal §13.3b) — the pure staleness classifier, the schema-compat assertion, and the atomic-swap install. The connected-refresh (skopeo pull) and the cosign-verify load are exercised in the integration suite (they need network/cosign); here we prove the decision logic + the fail-closed swap without either.

## `apps/server/src/governance/scan-db.ts`

### §283. M13.3b-ii — OFFLINE SCANNER-DB PRE-LOAD + REFRESH

M13.3b-ii — OFFLINE SCANNER-DB PRE-LOAD + REFRESH (ADR-0020, proposal §13.3b). The single home for the commander's server-maintained Trivy-DB cache: reading its on-disk `metadata.json`, classifying its staleness against the operator's INSTANCE-SCOPED policy (owner decision 2026-07-24: "a company applies their own rules"), asserting its schema is one the PINNED Trivy binary can read, and populating it two ways — a connected operator-invoked skopeo refresh, and an air-gap operator-load of a cosign-signed DB blob carried across the CDS.

WHY A SERVER-MAINTAINED OPERATIONAL CACHE IS NEW (and does NOT violate "SCP has no blob storage for promotion artifacts"): the trivy-db is the scan's INPUT (operational data), not a promotion artifact SCP is caching for someone else. It is exactly the objectStorage-PVC precedent (values.yaml) applied to operational scanner data.

FAIL-CLOSED THROUGHOUT (proposal §13.3b, owner 2026-07-24): a configured-but-missing/corrupt/ unreadable-schema/hard-stale DB yields NO scan → NO evidence → E6 refuses. Only a fresh (or soft-stale WARN) DB scans; a warn is surfaced in the ScanEvidence + Decision, never silently.

### §284. Build a database in staging, validate it, then swap

Build a fresh DB directory in staging, VALIDATE it (trivy.db present + readable metadata + a schema the pinned binary accepts), then ATOMICALLY swap it into `<cacheDir>/db` — no torn read during a concurrent scan (a scan `docker cp`s a point-in-time snapshot of the dir; `rename` keeps any already-opened inode intact). Refuses (throws, no cache write) a DB the pinned Trivy can't read. Staging is created UNDER `cacheDir` so the rename is same-filesystem (hence atomic).

### §285. Connected refresh: skopeo-copy the upstream OCI trivy-db

Connected refresh: skopeo-copy the upstream OCI trivy-db (allowlist-guarded, ADR-0019 §4) into a `dir:` layout, extract its layer(s), and atomically install the resulting DB into the cache with the schema-compat assertion. Operator-invoked; the ONE place this reaches the network, exactly the vendored-skopeo channel #111 established. Returns the installed metadata.

### §286. Air-gap operator-load: VERIFY a cosign-signed DB blob

Air-gap operator-load: VERIFY a cosign-signed DB blob (detached signature against the operator's public key, plus an optional digest cross-check) BEFORE accepting the bytes into the cache. No federation message/flow — the operator produced the signed blob at the connected side (skopeo-pull + repackage + cosign sign-blob) and walked it across the CDS. The blob is the SAME `type:'blob'` shape as the connected repackage: a (gzipped) tar carrying trivy.db + metadata.json. A tampered blob / wrong key / digest mismatch is REFUSED with NO cache write.

## `apps/server/src/governance/scan-declared-facts.test.ts`

### §287. M22.5 / M22.6 — THE TWO SERVER-SIDE FACT FOLDS, pure

M22.5 / M22.6 — THE TWO SERVER-SIDE FACT FOLDS, pure.

Everything here is a function that takes rows (or a properties bag) and returns the fact the gate hands to the matcher. The DATABASE reads and the WIRING are proven at the real gate in `scan-declared-override-exclusions.integration.test.ts`; nothing in this file can say anything about either, and it does not pretend to.

MUTATIONS RUN (2026-08-17), measured against a baseline of 17 passed and reverted by an exact inverse edit: U-1  UNION the per-target declarations instead of intersecting them  -> 3 failed. U-2  UNION the per-target grants instead of intersecting them        -> 2 failed. A third, "read an unparseable status as `approved`", is covered by the projection cases below and was not run separately.

The property that makes these worth pinning separately is the INTERSECTION. ADR-0033 §3 forbids unioning across a change's targets, and a union here is not a hypothetical mistake — it is the shape a reader reaches for first, because "gather every fact about the change" is the obvious phrasing and it is the wrong one. A single-target change (the overwhelmingly common shape) is unaffected either way, so nothing but a deliberate multi-target test can tell the two apart.

### §288. MEASURED, and the opposite of what was written first

MEASURED, and the opposite of what was written first. A per-entry filter is unreachable through the write door (which refuses the whole bag) and reachable only through federation import, where an unrecognised entry means either "the peer has a newer vocabulary" or "somebody wrote something we cannot interpret". For a LOOSENING both must resolve the same way: partially interpreting a document we do not fully understand is how a loosening acquires a meaning nobody authored.

## `apps/server/src/governance/scan-declared-facts.ts`

### §289. What the component declared, read once at the gate

M22.5 (ADR-0033 §6, owner decision D2) — WHAT THE COMPONENT DECLARED, read once at gate time and handed to the pure matcher as data.

THE DECISION THIS IMPLEMENTS, AND THE SEAM IT ACCEPTS
The owner chose that component info encodes the override DIRECTLY; a SecOps-authored mapping from declaration to exemption was recommended and DECLINED. The consequence was raised before the decision and is real: `component.properties` are writable at plain `object:write` SCOPED AT THAT COMPONENT, so the beneficiary of a declaration is also its author, at a weaker permission than the `policy:write` that authored the constraint.

That is settled. What bounds it is NOT this file's permission model — it is the ADMISSION algebra one layer up. The component authors the override; it does NOT author its own admission. A `declared_fact` clause has effect only if every tier from `platform` down admits that class AND a tier holding `policy:write` authored the clause that names the fact and the value. A component can write `egress: none` all day and change nothing until someone with real authority says that assertion means something.

THE RESIDUAL HAZARD, ACCEPTED AND MADE VISIBLE
The declaration is read LIVE at gate time from a tenant-writable bag and is NOT pinned to the artifact, so it can be flipped for the duration of one gate and flipped back. ADR-0033 §6 records this as accepted and not removable under D2. What this increment does about it is the only thing available: the resolved value is pinned VERBATIM into the gate Decision's `inputContext` and into `control_runs.evidence`, so the flip is visible AFTER THE FACT to anyone reading either. Visible, not prevented — and stated here rather than discovered.

WHY ONLY A `component` MAY DECLARE
There is no registered `property_schema` for `security.declarations` on ANY type — drizzle/0075's §2a records why the `component` fragment was written and then deleted (typing a key on a heavily federated type is the same bundle-abort hazard as closing a key set). So nothing at the database stops a `service` object — or a `component` — from carrying an unvalidated `security` bag. The type filter below is therefore load-bearing rather than decorative: without it, a facts read for a service-targeted change would honour a bag that passed through no validation at all. A non-component target contributes NO declarations, which after the intersection means no `declared_fact` exclusion for the whole change — the fail-closed direction, and the same shape `scan-vendor-latest.ts` has for the same reason.

### §290. Parsed through the same strict schema the write door uses

PARSED THROUGH THE SAME `z.strictObject` THE WRITE DOOR USES, not a looser reader.

A row can predate the write door (a pre-0067 object, an IaC apply, a federation import from a peer with a newer vocabulary), so this is a genuine second validation and not belt-and-braces. Re-using the write door's schema means a bag the API would refuse is also one the GATE refuses — if the two readers disagreed, the looser one would be the one that decides verdicts.

### §291. All or nothing, and that is the deliberate choice

ALL OR NOTHING, and that is the deliberate choice rather than a consequence of using `safeParse`. A per-entry filter was written first and then removed: it was unreachable through the write door (which refuses the whole bag) and reachable only through federation import, where the two live readings of a bag containing an unrecognised entry are "the peer has a newer vocabulary" and "somebody wrote something we cannot interpret". For a LOOSENING both of those must resolve the same way — contribute nothing — because partially interpreting a document we do not fully understand is how a loosening acquires a meaning nobody authored.

### §292. Pure: composes several targets' declarations into one

PURE — compose several targets' declarations into the ONE set that describes the change.

AN INTERSECTION ON THE WHOLE PAIR, never a union and never a key-only intersection. One verdict is produced for one artifact across a change's whole target set (ADR-0033 §3), so a fact declared by one target that leaked onto a sibling would excuse findings on a component nobody made an assertion about. And intersecting on the KEY alone would be worse than a union: `egress: none` and `egress: internet` would agree on the key and the surviving value would be whichever target was read first — a loosening decided by row order.

NO TARGETS yields no declarations, not "everything": an intersection over an empty family is conventionally the universe, which here would be a declared-fact pass for a change with nobody declaring anything.

## `apps/server/src/governance/scan-declared-override-exclusions.integration.test.ts`

### §293. The component-declared facts and the override request

M22.5 (component-declared facts, D2) and M22.6 (the override request, D3/D4) — PROVEN AT THE REAL GATE, and at the real authoring doors.

The pure predicates are pinned in `packages/schemas/src/scan-exclusion-declared-override.test.ts` and the pure folds in `scan-declared-facts.test.ts`. NEITHER of those can tell you whether the thing is WIRED — this repo's dominant defect is a component built, tested green against itself, and installed nowhere — so every test below drives a PRODUCTION entry point:

```text
- the real lifecycle gate, through the real subprocess plugin host running the real
  `scan-result-control` against a real loopback Trivy-shaped result;
- the real component write route, for the declaration's strict door;
- the real `/scan-override-grants` routes, for raising, approving, denying and revoking;
- the real generic `/objects/{type}` endpoint, for the governance-managed refusal.
```

Nothing here calls `resolveEffectiveScanExclusionsForTargets`, `applyScanExclusions` or either fact resolver directly.

MUTATIONS RUN against this file (2026-08-17) — the MEASURED result of each, each applied ALONE against a passing suite and reverted by an exact inverse edit. Baseline: 10 passed. Nothing below is a prediction.

M-1  DELETE the `attachDeclaredFacts` call in `resolveEffectiveScanExclusionsForTargets` -> 1 failed (D1). THE INSTALLATION PROOF for M22.5: the declarations resolve and reach nothing. M-2  DELETE the `attachApprovedOverrides` call, same function -> 1 failed (O1). The installation proof for M22.6. M-3  replace the `(properties->>'expiresAt')::timestamptz > at` SQL window with `true` -> 1 failed (O2). An expired grant would authorise a promotion — the whole reason expiry is a read-time window and not a status a (non-existent) job flips. M-4  approve authorizes `object:write` at the COMPONENT instead of `policy:write` at the TIER -> 1 failed (O4). The waiver becomes available to exactly the party it constrains. M-5  remove `scan_override_grant` from `GOVERNANCE_MANAGED_OBJECT_TYPE_IDS` -> 1 failed here (O6) + 1 in `governance-managed-write-doors.integration.test.ts` (the set-membership guard). NOTE what did NOT fail: that file's DOOR 1 and DOOR 2 stayed green, because they loop over a set the type had just left. That is precisely why the membership guard exists as its own case. M-6  delete BOTH `assertValidComponentSecurityDeclarations` calls in `graph/objects-repo.ts` -> 1 failed (D4). M-7  `declaredFactPredicate` accepts a clause with `declaredFact` and NO `declaredValue` -> 1 failed (D3) — but ONLY AFTER `pnpm -w build`. The first run of this mutation passed the whole suite, because `scan-result-control` runs in a SUBPROCESS that loads the BUILT `@scp/schemas`, so a source-only edit to that package is invisible here. Any future mutation of `packages/schemas` must rebuild before it is measured; the unit suite caught this one immediately, which is why both exist. MUTATIONS RUN for the D3 review round (2026-08-18, cases O7-O11). Baseline: 15 passed.

```text
M-9   the authority bar grants every candidate (`applyOverrideAuthorityBar`'s two refusals)
        -> 2 failed (O7, O9) + 3 in `scan-override-authority.test.ts`.
M-10  `requiredOverrideApprovalTier` always returns the bottom rung
        -> 3 failed (O7, O8, O9). O8 fails on the RECORDED bar, which is why the bar is in the
           Decision and not only in the filter.
M-11  `attachApprovedOverrides` derives the bar from NO ceiling
        -> 3 failed here (O7, O8, O9) + A9 in `scan-exclusion-actuator.integration.test.ts`.
M-12  DELETE `assertOverrideTierStanding` at the RAISE route
        -> 1 failed (O10), and only O10.
M-13  DELETE the instance-floor refusal at APPROVE
        -> 1 failed (O11), and only O11.
M-14  the DECIDE route's `updateObject` passes `scanOverrideGrantDecision: false`
        -> 1 failed (O1). THE ANTI-VACUITY MUTATION for the internal bypass: without it the flag
           could have been dead code and every refusal above would still have looked correct.
M-15  `scanExclusionsForDecision` stops recording `overrideRequiredTier` /
      `overridesRefusedForAuthority`
        -> 4 failed (O1, O7, O8, O9).
M-16  `scanExclusionsForDecision` stops recording the grant's DERIVED `grantTier`
        -> 1 failed (O1).
```

```text
M-8  drop `declaredFacts` and `approvedOverrides` from `scanExclusionsForDecision`
       -> 2 failed (D1, O1). The exclusion applies and the Decision cannot explain why.
```

MUTATION RUN for O13 — the guarded `::timestamptz` cast (2026-08-18). Baseline: 17 passed.

```text
M-17  UNWRAP the `CASE ... ~ ISO_TIMESTAMP_TEXT_PATTERN` in `scan-override-grants.ts`'s live-grant
      window back to the bare `(properties->>'expiresAt')::timestamptz` cast
        -> 1 failed (O13), and ONLY O13; the other 16 passed. It fails by TIMEOUT rather than by
           an assertion, and that is the defect's own shape rather than a weak test: the cast
           throws inside the gate's query, so no control run is ever written and there is nothing
           to assert against. Nothing else in this file notices, because a peer's row is the only
           way to reach a non-ISO `expiresAt` — every LOCAL door refuses the field outright.
```

Instance-scoped `scan_exclusion_admissions` rows are GLOBAL to the deployment and the integration suite runs `singleFork` against ONE shared Postgres, so a row left behind would silently admit loosenings in every later suite. They are cleared in an `afterEach` that runs regardless of outcome, and once more at teardown.

### §294. THE PRODUCTION WRITE DOOR

THE PRODUCTION WRITE DOOR (M22.9). This used to `INSERT INTO scan_exclusion_admissions` over the admin pool, which made the suite green while the two instance rungs every clause requires — and that NO policy can ever contribute — had no writer outside these tests. The whole exclusion dimension was inert on a real deployment. It now goes through `PUT /api/v1/instance/scan-exclusion-admissions/{tier}` with the deployment operator token, exactly as an operator would; delete that route's registration in `app.ts` and every admitting test in this file dies. The PUT is a whole-set REPLACE, so this unions with what is already admitted rather than clobbering an earlier call in the same test.

### §295. A second principal, since the raiser may not approve

A SECOND PRINCIPAL TO RAISE WITH, because the raiser may not be the approver (ADR-0033 §6a, owner decision 2026-08-18).

Every case below used to raise AND approve as `admin`, which the separation-of-duties refusal now answers 400 to — seven of them went red at once when it landed, which is the measurement that says the guard reaches the real route rather than only the unit under it.

`Operator` at the component supplies exactly the `object:write` the raise route asks for and NOTHING else — deliberately the weakest identity that can raise, so these fixtures keep proving that raising is open (it authorizes nothing) while approving is not. `Viewer` at the org root supplies the reads the SDK needs to resolve the component on the way in.

### §296. M22.8 — the authoring guard

M22.8 — the authoring guard (`governance/scan-rule-authoring-guard.ts`) refuses a `scanExclusion` rule that requires no scan control: such a document is silently inert, because the six-tier resolution is reached only inside `if (allControlIds.length > 0)`. `SCAN_RULE_TEST_CONTROL_REF` is a DANGLING reference on purpose — see that constant's own doc: a real bound control would add a control run and change what these tests measure. `admit`-only stays untouched — it is an admission, not a rule about a finding (exempt).

### §297. The gate Decision's own record of the exclusion set

The gate Decision's own record of the exclusion set, read from the `decisions` table the way an operator resolving a `decision_id` would.

EVERY decision for the change is scanned, not the latest one, and that is a measured correction rather than caution: a change writes SEVERAL `transition` decisions on its way through, and the LAST one is `coordinated -> executing`, whose `inputContext.gate` is `{gatesBound: 0}` — it runs no policy gate at all. Reading only the newest row therefore reports "no exclusions recorded" for a change whose gate recorded them perfectly well one transition earlier.

### §298. NARROWED, and now required to be (M22.4 review round)

NARROWED, and now required to be (M22.4 review round): a `declared_fact` clause with NO narrowing matcher was a bare `() => true` that excluded EVERY finding at EVERY severity, while the tiers above had consented only to the CLASS and could not see the blast radius. It is refused at the authoring door and inert at read time. Every finding these cases scan is `curl`, so naming it changes nothing they assert.

### §299. RAISED at the component, then APPROVED at the ORG

RAISED at the component, then APPROVED at the ORG — and the org rather than the service is the whole of the D3 floor made visible (owner decision, 2026-08-18). This case named `service.id` until that floor landed and the grant stopped applying, which is correct and is the behaviour change to know about: NO clause here authors a `scanThreshold`, so the bar has no tier contributor to derive from and sits on the floor. A service-tier grant is below it.

Read together with O7/O8: a grant below the bar is refused and a grant at-or-above it applies. The floor's effect is that "at-or-above" now starts at `org` even when nothing set a ceiling, because the gate is still enforcing one the contributors cannot see.

### §300. ...and the BAR it was measured against

...and the BAR it was measured against. No `scanThreshold` is authored anywhere in this org and no instance floor is set — and the bar is still `org`, NOT the bottom rung. That is the D3 floor (owner decision, 2026-08-18): "no tier contributed a ceiling" is not "no ceiling is enforced", because the control binding's `config.threshold` and the scan plugin's shipped fail-closed 0/0 are both in force and neither is authorable below `org`.

### §301. The decision is enforced now, not merely asserted

M22.6 REVIEW ROUND — D3 IS ENFORCED, NOT MERELY ASSERTED

Until this round `tierObjectId` was chosen freely by the REQUESTER and read afterwards only for PRESENCE. Because `authz/resolve.ts`'s `scopeExpandCte` expands UPWARD, naming a LOWER object strictly WIDENED the set of principals whose bindings satisfied the approve check — so the party seeking a waiver selected the authority that granted it, and a service lead could approve away a ceiling set at org or platform while the audit trail truthfully recorded "under authority of '<service>'".

O7/O8 are a MATCHED PAIR and must be read together: identical org, identical ceiling, identical clause, identical finding, identical grant — the ONLY difference is which rung the grant was approved at. O9 proves the same bar is re-derived at the gate from a rule authored AFTER the approval. O10/O11 are the authoring doors.

### §302. The escalation in the objection, exactly

The escalation in the objection, exactly: a platform floor, a grant approved at the service. The floor is set AFTER the approval on purpose — so the approve-time refusal cannot be what is being measured, and only the gate's re-derivation can produce this outcome.

The floor names `maxLow`, a severity the finding does not even have. That is deliberate: it proves the bar is the most senior tier that set ANY ceiling, not the tier whose value happens to BIND. Excluding a finding lowers the COUNT, which loosens every ceiling on that severity at once, so a junior tier must not be able to defeat a senior one indirectly.

### §303. SEPARATION OF DUTIES

SEPARATION OF DUTIES (owner decision, 2026-08-18). The escalation D3 exists to stop needs two things to go wrong: an authority bar that does not bind, and one actor holding both halves of the act. O7-O9 cover the bar. This covers the actor.

It is NOT a substitute for the bar and the assertions say so: a SECOND principal with the same standing approves the very same grant successfully at the end, which is the point — this rule constrains WHO signs, never WHETHER the waiver is permissible.

### §304. THE DEFECT THIS PINS

THE DEFECT THIS PINS. The live-grant window casts `properties->>'expiresAt'` to `timestamptz` inside the gate's own query. `expiresAt` is refused at every LOCAL door, but the M22.6 authoring guard deliberately EXEMPTS `federationImport` — a throw on that path aborts a peer's whole signed bundle — and the registered `property_schema` types the field only as `{"type": "string"}`, deliberately (0075 §1: typing it would move the failure from one grant to the whole channel). So a peer can legitimately deliver `expiresAt: "never"`.

With a BARE cast, that one row throws inside EVERY gate evaluation for the org — the reconcile prewarm, the wave boundary, `POST /policy-evaluate` and the commander promotion scan — so no change in the org can be validated or advanced until an operator finds it. Fail-OPEN by way of a crash, reachable from across a trust boundary. The resolver now wraps the cast in a `CASE ... ~ pattern`, exactly as `graph/containment.ts` wraps its `::uuid`.

WHY THE ROW IS PLANTED THROUGH `upsertObjectByUrn` WITH `federationImport` RATHER THAN A RAW INSERT, and what that does and does not buy. It is the exact function `import-repo.ts`'s `object_upsert` branch calls, with the same actor and the same context shape, so this exercises the REAL import writer and the REAL registry validation — which is the precondition the whole finding rests on: if `property_schema` refused `"never"`, no such row could exist and the guard would be unreachable. A raw `INSERT INTO objects` would prove nothing about that and is exactly the shortcut that let the exclusion dimension ship green and inert. What it does NOT do is drive a signed bundle end to end — `verifyBundleSignature`/`verifyJournalChain` are upstream of this function and are covered by `federation/federation.integration.test.ts`; duplicating a two-domain fixture here would not exercise one additional line of the resolver.

## `apps/server/src/governance/scan-exclusion-actuator.integration.test.ts`

### §305. M22.7 — THE ACTUATOR

M22.7 — THE ACTUATOR (ADR-0033 §10). The lever behind the signal.

Everything M22 built before this increment produces a FACT and moves nothing. A control outcome is cached and deliberately treated as a historical fact, so a grant approved after a change's gate has already run is inert on that change **forever**: the operator sees an approved grant, the gate keeps refusing, and nothing connects the two. BUILD_AND_TEST.md §8 M22 names this "the increment this project most reliably forgets" and prescribes the proof exactly — *grant an exclusion after a change has already failed its gate, assert it subsequently passes; delete the force forwarding and this test must die.*

THE LOOP IS OFF (`withPluginHost`, not `withReconcileLoop`) AND THAT IS DELIBERATE. Every test here counts `control_runs` rows and asserts that a second evaluation creates one — or, for the stability cases, that it creates none. A live reconcile loop is a COMPETING CONSUMER for exactly that work and would make those counts non-deterministic. `prewarmGovernanceForChange` and `evaluateWaveGate` are driven directly because they ARE the production entry points: `coordination/reconcile.ts` calls the first once per tick for every `validating` change (`advanceValidatingChanges`) and the second once per tick for every pending wave (`advanceExecutingChanges`), with exactly these arguments. Driving them here is running the loop's body without the loop's scheduler.

MUTATIONS RUN against this file (2026-08-17) — the MEASURED result of each, each applied ALONE against a passing suite and reverted by an exact inverse edit. Baseline: 8 passed. Nothing below is a prediction; where a measurement contradicted the guess that motivated the test, the measurement is what is written.

```text
M-1  DELETE `force` from the PREWARM's `ensureControlRuns` call (gate-orchestrator.ts)
       -> 3 failed (A1, A6, A7). THE INSTALLATION PROOF for the lifecycle-edge site: the grant
          resolves, the hash differs, and the cached verdict is handed back anyway.
M-2  DELETE `force` from the EVALUATE site's `ensureControlRuns` call (same file)
       -> 1 failed (A2), and ONLY A2. Two call sites, two proofs: wiring one and not the other
          is the precise mistake M22.2's own measured mutation M-2 found in the threading.
M-3  DELETE the `exclusionSetHash` stamp in `control-runner.ts`
       -> 3 failed (A1, A3, A7). NOTE WHAT SURVIVED: A2, A5 and A6 stayed green, because with
          nothing recorded every scan run looks stale and the gate force-re-runs on every pass —
          which still produces the RIGHT VERDICT. The damage is entirely amplification, and A3 is
          the only test that can see it. A suite of nothing but "the grant takes effect" cases
          would have called this mutation harmless.
M-4  `scanExclusionSetHash` folds `Date.now()` into the digest
       -> 2 failed (A3, A7). The re-run storm: a control re-evaluated, and a row inserted, on
          every single ~1s tick for as long as the change is parked.
M-5  `scanExclusionSetChangedForGate` compares EVERY cached run, not just ones whose evidence
     parses as `ScanEvidence`
       -> 1 failed (A8), and only A8. A non-scan control beside a scan control would be forced to
          re-run for as long as any clause exists anywhere in the org. A8 was written for this
          mutation after A4 turned out NOT to catch it: with nothing authored the expected hash is
          `undefined` too, so the comparison agrees by accident.
M-6  revert `ensureControlRun`'s `latestControlRunForGate` to the gate-agnostic
     `latestControlRun` (M22.0a)
       -> 1 failed (A5), and only A5. The lifecycle-edge pass made while the grant was live
          authorises the later wave, long after the grant lapsed.
M-7  `scanExclusionSetHash` returns a fixed string instead of `undefined` for an empty set
       -> 1 failed (A4). Every deployment that authored no exclusion would start writing a key it
          never had into evidence that is copied verbatim into signed promotion bundles.
```

MUTATIONS RUN for A9/A10 (M22.6 review round, 2026-08-18). Baseline: 10 passed.

```text
M-8  the D3 authority bar reads NO ceiling (`requiredOverrideApprovalTier(undefined)` in
     `scan-requirements.ts`'s `attachApprovedOverrides`)
       -> 4 failed: A9 here, plus O7/O8/O9 in
          `scan-declared-override-exclusions.integration.test.ts`. ONE deletion, both producers —
          which is the whole reason that resolution lives in the resolver rather than being
          threaded in from each gate site (see that function's docblock for the measurement that
          forced the change).
M-9  the EARLIER, threaded design: `ceiling: undefined` at the PREWARM call site only
       -> before A9/A10 existed, NOTHING failed anywhere. That is why this pair is here: every
          case in the M22.5/M22.6 gate file is driven through the EVALUATE site, so the cached
          run the host-less accept edge reads was completely unguarded and completely green.
```

Instance-scoped `scan_exclusion_admissions` rows are GLOBAL to the deployment and the integration suite runs `singleFork` against ONE shared Postgres, so a row left behind would silently admit loosenings in every later suite. They are cleared in an `afterEach` that runs regardless of outcome, and once more at teardown.

### §306. THE PRODUCTION WRITE DOOR

THE PRODUCTION WRITE DOOR (M22.9). This used to `INSERT INTO scan_exclusion_admissions` over the admin pool, which made the suite green while the two instance rungs every clause requires — and that NO policy can ever contribute — had no writer outside these tests. The whole exclusion dimension was inert on a real deployment. It now goes through `PUT /api/v1/instance/scan-exclusion-admissions/{tier}` with the deployment operator token, exactly as an operator would; delete that route's registration in `app.ts` and every admitting test in this file dies. The PUT is a whole-set REPLACE, so this unions with what is already admitted rather than clobbering an earlier call in the same test.

### §307. M22.8 — the authoring guard

M22.8 — the authoring guard (`governance/scan-rule-authoring-guard.ts`) refuses a `scanExclusion` rule that requires no scan control: such a document is silently inert, because the six-tier resolution is reached only inside `if (allControlIds.length > 0)`. `SCAN_RULE_TEST_CONTROL_REF` is a DANGLING reference on purpose — see that constant's own doc: a real bound control would add a control run and change what these tests measure.

### §308. TWO PRINCIPALS, because the raiser may not be the approver

TWO PRINCIPALS, because the raiser may not be the approver (ADR-0033 §6a, owner decision 2026-08-18). Every call here used to raise and approve as `admin`, which the separation-of-duties refusal answers 400 to — seven cases in this file went red at once when it landed, which is the measurement that says the guard reaches the real route.

The raiser is `Operator` at the component: exactly the `object:write` the raise route asks for and nothing more, so these fixtures keep proving that raising is open (it authorizes nothing) while approving is not.

### §309. The counterweight to A1, and it is not politeness

The counterweight to A1, and it is not politeness. The gate this rides on is evaluated on EVERY reconcile tick (~1s) for every parked change; a comparison that could not agree with itself would re-run the plugin and insert a `control_runs` row forever — the measured 1.44 GB/day write-amplification pattern (ADR-0024 §D0) reproduced in a new table. Folding anything time-varying into the digest fails exactly here.

### §310. The second amplification case, and what the compare finds

The second amplification case, and the reason the comparison identifies a scan verdict by `ScanEvidenceSchema.safeParse` rather than by control id or plugin module. Anything that is not a scan verdict carries no `exclusionSetHash` and never will; comparing it against a non-empty expected hash would force it to re-run on EVERY tick for as long as any clause exists anywhere in the org — a permanent storm on controls that have nothing to do with scanning.

The stand-in is a required control with NO binding, whose run `ensureControlRun` writes with `evidence: {}`. That is a real shape (a stale `requireControls` reference), it is the exact shape a `webhook-control` verdict shares for this comparison's purposes — neither parses — and it needs no second plugin fixture.

### §311. The DoD case that proves the cache key carries GATE IDENTITY

The DoD case that proves the cache key carries GATE IDENTITY. The lifecycle-edge run below is a genuine, authorized `pass` — made while the grant was live. The wave boundary is a DIFFERENT crossing and must ask again; keyed without gate identity (pre-M22.0a) it would reuse that pass and ship a production wave on a waiver that lapsed weeks earlier.

The clock is wound forward by editing the STORED expiry rather than sleeping: the approve route refuses a past `expiresAt` at authoring time, which is why this cannot go through it.

### §312. The security half a happy-path actuator would miss

The security half, and the one an actuator built only for the happy path would miss. Without forcing, a revoked grant leaves a cached `pass` standing for the life of the change: the operator revokes, the UI says revoked, and the gate keeps letting it through. This direction matters more than A1's, because A1's failure mode is an inconvenience and this one is a live vulnerability shipping under a waiver that was withdrawn.

### §313. What the recorded value means, pinned at the real gate

What the recorded value MEANS, pinned at the real gate rather than in a unit test over a hand-built object: it is a function of the resolved exclusion set and of nothing else — not of the change, not of the control, not of when the run happened. If it varied per change, the comparison would still work by accident (it only ever compares a run against its own successor) while being useless for every other purpose the field claims to serve.

### §314. A9 / A10 — D3'S AUTHORITY BAR AT *THIS* CALL SITE

A9 / A10 — D3'S AUTHORITY BAR AT *THIS* CALL SITE (M22.6 review round)

WHY HERE AND NOT ONLY IN `scan-declared-override-exclusions.integration.test.ts`: measured, not assumed. Threading the resolved ceiling into the exclusion resolver is a TWO-CALL-SITE wiring, and the first mutation run against the bar found that setting the PREWARM site's `ceiling` to `undefined` left every case in that file green — the reconcile-loop tests there are driven through the EVALUATE site. That is the identical shape M-1/M-2 above record for `force`, one increment later, and it is why this pair exists: the prewarm's run is the one that gets CACHED and later read by the host-less accept edge, so an unbarred grant here authorises the edge a human actually clicks.

## `apps/server/src/governance/scan-exclusion-actuator.test.ts`

### §315. M22.7 — the PURE half of the actuator

M22.7 — the PURE half of the actuator: what the recorded digest is a function of.

The wiring is proven in `scan-exclusion-actuator.integration.test.ts` against the real gate; none of these cases can tell you whether anything is installed. What they pin is the contract that makes the wiring safe — an empty set hashing to nothing, a stable set hashing stably, and every field of the resolved set actually reaching the digest. A digest that ignored a field would leave a change to that field invisible to the actuator, which is the same defect as having no actuator at all, only harder to see.

MUTATIONS RUN (2026-08-17), each applied alone against a passing suite and reverted by an exact inverse edit. Baseline: 9 passed. Measured, not predicted. U-M1  hash `canonicalJson(resolved.clauses)` instead of the whole resolved object -> 3 failed (the vendor, declared-fact and grant cases). A grant approved, revoked or expired under an UNCHANGED clause list — which is the ordinary case, since the clause is authored once by SecOps and the grants move underneath it — would never be noticed. The integration suite does catch this one too, but only through the gate; this is the cheap version that says exactly which field went missing. U-M2  return a fixed string instead of `undefined` for an empty clause list -> 1 failed here, and 1 in the integration suite (A4, the byte-identical promise).

## `apps/server/src/governance/scan-exclusion-actuator.ts`

### §316. M22.7 (ADR-0033 §10) — THE ACTUATOR

M22.7 (ADR-0033 §10) — THE ACTUATOR. The lever behind the signal.

WHY THIS FILE EXISTS. Everything M22 built up to here produces a *fact*: a clause is admitted, a grant is approved, a declaration is made. None of it moves anything, because a control outcome is cached and deliberately treated as a historical fact (`control-runner.ts`'s own doc: "a control result is a historical fact, not continuously re-polled"). So a grant approved five minutes after a change's gate ran is **inert on that change forever** — the operator sees an approved grant, the gate keeps refusing, and nothing in the system connects the two. ADR-0033 §10 calls this out as the blocking prerequisite and BUILD_AND_TEST.md §8 M22 names it "the increment this project most reliably forgets".

THE MECHANISM, IN ONE SENTENCE: the gate hashes the exclusion set it resolved, the server stamps that hash onto the run's evidence, and the next evaluation re-resolves, re-hashes, and passes `force: true` to `ensureControlRuns` when the two differ.

THREE PROPERTIES THIS FILE IS RESPONSIBLE FOR, none of them optional:

1. **The hash is over the RESOLVED SET, never over inputs including a clock.** A grant's `expiresAt` is a *stored* value and hashes stably; `now` is not, and hashing anything derived from it would make a clause sitting near an expiry boundary re-run the control on EVERY reconcile tick — the measured 1.44 GB/day write-amplification pattern (ADR-0024 §D0) reproduced in `control_runs` instead of `decisions`. `scanExclusionSetHash` therefore takes the resolved object and nothing else.

2. **Nothing authored ⇒ no hash ⇒ no forcing, ever.** An empty clause list yields `undefined`, the stamp writes no key, and the comparison finds `undefined === undefined`. A deployment that has authored no exclusion is byte-identical to pre-M22 and pays not one extra control run.

3. **A stable set must settle after ONE re-run.** The value compared against is written by the same call the comparison triggers, from the same resolved object, through the same function — so a set that stops changing stops forcing. Two functions computing "the hash" is precisely the shape where the stamp and the comparison drift and the loop never converges; there is one.

### §317. The content digest of a resolved exclusion set

The content digest of a resolved exclusion set, or `undefined` when nothing was admitted.

`canonicalJson` sorts object keys recursively and PRESERVES array order — which is safe here for the same measured reason `scanThresholdForDecision` relies on: the resolver already returns `clauses` (and every fact array) sorted by content, so two identical resolutions serialize identically. If a future field is added to `EffectiveScanExclusions`, the question to ask is not "is it useful?" but "would two identical evaluations produce it identically?" — a field that would not must be excluded here, or this becomes a re-run generator.

### §318. The same digest, taken from a control-run CONTEXT

The same digest, taken from a control-run CONTEXT — the shape `buildControlContext` produced and `ensureControlRun` was handed.

This is the STAMPING side, and it reads the context rather than accepting the resolved object as an argument on purpose: `ensureControlRun` is reached from several call sites with a `context` bag and no typed exclusion parameter, and threading a second, parallel argument alongside the one already inside the bag is how the two come to disagree. What is stamped is exactly what was sent.

A context carrying no `scanExclusions`, or one whose value does not parse, yields no hash. The second case cannot arise from the gate (which builds the object from the resolver's own output), and if it ever did the honest answer is "this run records no exclusion set", not a hash of something unvalidated.

### §319. Was any cached outcome produced under a different set

Whether any cached SCAN outcome for this gate crossing was produced against a DIFFERENT exclusion set than the one just resolved — i.e. whether `ensureControlRuns` must be forced.

READS THE SAME ROW THE CACHE WOULD RETURN. `latestControlRunForGate` is deliberately the same lookup `ensureControlRun` performs (M22.0a, keyed on gate identity), so this answers "is the run that would be reused stale?" rather than "does some run somewhere disagree?". A control with no run yet for this crossing is not consulted at all — it will run regardless.

ONLY A SCAN VERDICT IS COMPARED, identified by `ScanEvidenceSchema.safeParse` — the same shape test `federation/promotion-repo.ts` uses to recognise scan evidence, never a control-id or module allowlist. This matters in both directions:

```text
- A `webhook-control`/`github-check` run carries no `exclusionSetHash` and never will. Comparing
  it against a non-empty expected hash would force it to re-run on every single tick for as long
  as any exclusion clause exists anywhere in the org — a permanent re-run storm on controls that
  have nothing to do with scanning.
- A scan run whose plugin call FAILED has `evidence: {}` (the catch path in `ensureControlRun`),
  which does not parse either, so a broken binding is retried on its own existing schedule rather
  than hammered by this.
```

FORCING IS ALL-OR-NOTHING for the crossing, because `ensureControlRuns` takes one `force` for the whole list. One stale scan verdict therefore re-runs the non-scan controls beside it too. That is accepted and bounded: it happens only when the resolved set actually CHANGED (an approval, a revocation, an expiry, an admission edit), which is a human-rate event, and never on a steady tick.

## `apps/server/src/governance/scan-exclusions.integration.test.ts`

### §320. M22.2 — THE EXCLUSION DIMENSION, PROVEN AT THE REAL GATE

M22.2 — THE EXCLUSION DIMENSION, PROVEN AT THE REAL GATE (ADR-0033 §1–§4, migration 0066).

The pure algebra is pinned in `scan-requirements.test.ts` and the pure application in `packages/schemas/src/supply-chain.test.ts`. NEITHER of those can tell you whether the thing is WIRED, and this repo's dominant defect is a component built, tested green against itself, and installed nowhere. So every test in this file drives a PRODUCTION entry point end to end:

```text
- the real lifecycle gate (`prewarmGovernanceForChange` / `evaluateGovernanceGate` via the
  reconcile loop), through the real subprocess plugin host running the real
  `scan-result-control` against a real loopback Trivy-shaped result;
- the commander's own managed scan (`runPromotionScanStep`), which resolves and applies
  exclusions server-side because it has no plugin to thread a context to.
```

Nothing here calls `resolveEffectiveScanExclusions` or `applyScanExclusions` directly.

MUTATIONS RUN against this file (2026-08-17) — the MEASURED result of each, reverted afterwards by an exact inverse edit. Baseline: 11 passed. Nothing below is a prediction.

```text
M-1  DROP `scanExclusions` from `buildControlContext`'s returned object (gate-orchestrator.ts)
       -> 6 failed (G2, G11, G3, G4, G5, G8). The clauses resolve and never reach the control.
M-2  DROP the `scanExclusions` argument at the PREWARM call site ONLY, leaving the evaluate site
     wired
       -> 1 failed: G11, AND ONLY G11. This is the measurement that changed the shape of this
          file. Every other test's change goes straight to `executing` and its only control run
          is a `wave_boundary` one, so the whole suite except G11 proves the EVALUATE site and
          says NOTHING about the prewarm — whose run is the one that gets CACHED and read at the
          host-less accept edge. G11 exists because this mutation survived without it.
M-3  route exclusions through `ceilingContributorKeys` instead of `exclusionContributorKeys`
       -> 1 failed (G4). An unevaluable CEL condition would then ADMIT the clause — the
          fail-open this dimension's opposite sign exists to prevent.
M-4  UNION the per-target clause sets instead of intersecting them
       -> 1 failed (G5). A clause admitted for component A leaks onto sibling component B.
M-5  restore `firedPolicies: []` in `federation/promotion-scan-step.ts`
       -> 2 failed (G6, G7). The commander path stops seeing anything authored below the
          instance floors, which is the divergence at the boundary where evidence is FROZEN.
          G7 fails too because its `refused: "unsupported"` marker only appears once a clause
          was admitted at all.
M-6  `persistScanFindings` writing `scanFindingRetentionClass(false)` unconditionally
       -> 1 failed (G8). Excluded findings lose their accepted-risk (class E) retention.
```

M22.9 MUTATIONS RUN (2026-08-18) against the ADMISSION WRITE DOOR — the MEASURED result of each, reverted afterwards by an exact inverse edit. Baseline: 15 passed. Nothing below is a prediction.

```text
M-1  DELETE `registerInstanceScanExclusionAdmissionRoutes(app, deps)` from `app.ts`
       -> 13 of 15 failed HERE, plus 3 in `scan-requirements-read.integration.test.ts`. The two
          survivors are G1 (admits nothing by design) and G9 (asserts the table's CHECK over the
          admin pool). This is the measurement the whole increment exists for: before the
          conversion, deleting the production write door for the exclusion dimension's mandatory
          precondition killed NOTHING anywhere in the tree. Measured again (M-1b) against the
          other two converted suites: 17 more failed across `scan-exclusion-actuator` and
          `scan-declared-override-exclusions`, for 33 across four files.
M-2  the PUT becomes ADDITIVE (the replace's `DELETE ... NOT (class = ANY($3))` removed)
       -> 2 failed: E2 (the withdrawal path) and E4 (its step 4 re-block never happens, so the
          wait for a `fail` run times out). The revocation is load-bearing, not decoration.
M-3  DELETE `requireOperator(deps, request)` from the PUT handler
       -> 1 failed (E3), and ONLY E3. A tenant admin could then admit a loosening for every org
          on the deployment.
M-4  [ANTI-VACUITY] the PUT answers 200 with the requested set but stores NO row (the INSERT
     loop removed and the read-back replaced by the request's own classes)
       -> 12 failed, E1 and E2 among them. E1 asserts the ROW over the admin pool rather than
          the response body, which is the only reason it can tell these two apart; E3 correctly
          SURVIVED, because its subject is the refusal and a refusal writes nothing either way.
```

Instance-scoped `scan_exclusion_admissions` rows are GLOBAL to the deployment and the integration suite runs `singleFork` against ONE shared Postgres, so a row left behind would silently admit loosenings in every later suite. They are cleared in an `afterEach` that runs regardless of outcome, and once more at teardown.

### §321. Loopback-only Trivy fixture

Loopback-only Trivy fixture (never the internet). `sev` seeds the severities; `fix` is a parallel list of `y`/`n` deciding whether that entry carries a `FixedVersion` — the ONE field the `no_fix_available` class reads, and the reason this file cannot reuse M17.5's source, which emits none at all.

### §322. The admin connection is kept for the storage tests

The ADMIN connection is kept for the STORAGE-CONTRACT tests below (G9/G10 assert the CHECK constraints and the two write barriers directly) and for teardown. It is NO LONGER how an admission is authored: `admitAtInstance` now goes through the production route, for the reason M22.9 exists — an integration suite that INSERTs the precondition itself proves nothing about whether an operator can ever create one.

### §323. The production write door, and why the helper is so

THE PRODUCTION WRITE DOOR, and the reason this helper looks the way it does.

Every admitting test in this file used to `INSERT INTO scan_exclusion_admissions` over the admin pool. That made the suite green while the `platform`/`trust_domain` rungs — which every clause in ADR-0033 §1's monotone AND requires, and which NO policy can ever contribute — had no writer outside these tests. The exclusion dimension was built, tested and INERT on any real deployment.

So this now calls `PUT /api/v1/instance/scan-exclusion-admissions/{tier}` with the deployment operator token, exactly as an operator would. Delete that route's registration in `app.ts` and every admitting test in this file dies at its first line.

The PUT is a whole-set REPLACE, so the helper unions with what is already admitted (read back through the route's own GET) rather than clobbering an earlier call in the same test.

### §324. M22.8 — the authoring guard

M22.8 — the authoring guard (`governance/scan-rule-authoring-guard.ts`) refuses a `scanExclusion` rule that requires no scan control: such a document is silently inert, because the six-tier resolution is reached only inside `if (allControlIds.length > 0)`. `SCAN_RULE_TEST_CONTROL_REF` is a DANGLING reference on purpose — see that constant's own doc: a real bound control would add a control run and change what these tests measure. An `admit`-ONLY effect is EXEMPT and is deliberately left untouched: it is an admission, not a rule about a finding, and demanding that an org-wide admission enumerate scan controls would be wrong. Every `admit`-only call in this suite therefore still exercises the exemption.

### §325. M22.8 — the authoring guard

M22.8 — the authoring guard (`governance/scan-rule-authoring-guard.ts`) refuses a `scanThreshold` rule that requires no scan control: such a document is silently inert, because the six-tier resolution is reached only inside `if (allControlIds.length > 0)`. `SCAN_RULE_TEST_CONTROL_REF` is a DANGLING reference on purpose — see that constant's own doc: a real bound control would add a control run and change what these tests measure.

### §326. Measured, and why this is not folded into the other

MEASURED, and it is why this test exists rather than being folded into G2: G2's change moves straight to `executing` and its ONLY control run is a `wave_boundary` one, so G2 proves the EVALUATE site and NOTHING about the PREWARM site. Threading only the evaluate site is a real and plausible mistake — mutation M-2 in the header removes exactly that argument — and it would leave a loosening working at a wave boundary and silently absent at the edge a human clicks, because `prewarmGovernanceForChange`'s run is the one `readExistingControlOutcomes` reads at the host-less `validating -> accepted` gate.

`prewarmGovernanceForChange` IS the production entry point: `coordination/reconcile.ts` `advanceValidatingChanges` calls it with exactly these arguments, once per tick, for every change sitting in `validating`. It is driven directly here because no change in this harness stays in `validating` long enough for a tick to catch it — which is a fixture limitation, not a statement about production, and driving the same function with the same real plugin host and real CEL sandbox exercises the same code path.

### §327. M22.9 — THE OPERATOR WRITE DOOR ITSELF

M22.9 — THE OPERATOR WRITE DOOR ITSELF.

Everything above admits through `PUT /instance/scan-exclusion-admissions/{tier}`, so the whole file already dies if that route disappears. These cases pin the door's OWN properties: who may open it, what a write actually stores, and that withdrawal works — none of which a gate test can tell you, because a gate only ever observes the admitted state.

## `apps/server/src/governance/scan-findings-read.integration.test.ts`

### §328. The findings route is registered, and the marker holds

M22.9 (ADR-0033 §7) — `GET /control-runs/{id}/findings` IS REGISTERED, AND THE MARKER REACHES THE WIRE.

`scan_findings` was write-only: two producers wrote it, both discarded the return, and the only reads anywhere in the tree were integration tests reaching into the table. The read route closes that. What it did NOT come with was a proof it is INSTALLED — the wire contract is pinned in `packages/schemas/src/governance.test.ts` and the repo function in `scan-findings.integration.test.ts`, and neither touches the handler, so deleting the `typed.route` block killed no test. This repo's dominant defect is a component built, tested green against itself, and installed nowhere.

SO EVERY CASE HERE SPEAKS REAL HTTP to a really-listening server, and the rows under test are produced by the REAL lifecycle gate driving the REAL subprocess plugin host running the REAL `scan-result-control` against a loopback Trivy-shaped result. Nothing calls `loadScanFindings`.

WHY `fetch` RATHER THAN THE SDK: `@scp/sdk`'s handwritten client exposes `controlRuns.listForChange` and nothing else, and the generated `listControlRunFindings` is not re-exported from the package index — so there is no SDK method to call today. That gap is real and worth naming: `apps/web` and the CLI consume ONLY the SDK (charter principle 3), so until a wrapper lands this route has no first-party consumer. These cases pin the HTTP surface the wrapper would sit on.

WHAT THESE CASES DO NOT COVER, stated rather than glossed: the `unsupported` marker. It is produced only by an OpenSCAP verdict, which arrives through the commander's managed scan step and not through any bound ControlPlugin, so it cannot be reached over HTTP from here at all — it is pinned at the producer in `scan-findings.integration.test.ts` (P2). `truncated` and ABSENT are both reachable and both covered below, which is what makes "a non-`full` marker survives to the wire" a measurement rather than an assumption.

MUTATIONS RUN against this file (2026-08-18) — the MEASURED result, applied against a passing suite and reverted by an exact inverse edit. Baseline: 5 passed. Nothing below is a prediction.

```text
M-1  DELETE the whole `typed.route({ method: "GET", url: "/api/v1/control-runs/:id/findings" })`
     block from `routes/governance.ts`
       -> 5 failed here (F1-F5), all with `expected 404 to be 200`. AND: the server's ENTIRE unit
          suite stayed green under the same deletion — 81 files, 1173 tests — which is the
          measurement this file exists for. `packages/schemas/src/governance.test.ts` pins the
          wire CONTRACT and `scan-findings.integration.test.ts` pins the repo function, and
          neither of them ever reaches the handler.
```

```text
          NOTE WHAT F3 WOULD HAVE DONE ALONE: its cross-org assertion is `404`, which is exactly
          what a deleted route answers, so the tenancy case is satisfied by the mutation. It dies
          only because of the positive control on the line above it — the OWNER reading their own
          run and getting 200. That control is not decoration; without it the tenancy case is a
          test that passes when the feature is absent.
```

### §329. Loopback-only Trivy fixture

Loopback-only Trivy fixture (never the internet). `?n=<count>` produces that many synthetic HIGH findings — the only way to reach `SCAN_FINDINGS_PERSIST_CAP` through the real plugin; `?fix=y,n` controls per-finding `FixedVersion`, which is what makes one finding excludable by a `no_fix_available` clause and its neighbour not.

### §330. THE ROUTE'S REASON TO EXIST

THE ROUTE'S REASON TO EXIST. `SCAN_EXCLUSION_EVIDENCE_CAP` (100) bounds the per-clause enumeration on `evidence.exclusions.applied` while `appliedCount` stays EXACT, so past 100 exclusions these class-`E` rows are the ONLY per-finding record of what an operator chose to tolerate (ADR-0033 D10, charter principle 6). A run whose findings are all class `O` would not show that, which is why this fixture excludes one of the two.

### §331. ABSENCE SURVIVES AS ABSENCE

ABSENCE SURVIVES AS ABSENCE. `fixedVersion` is the field the `no_fix_available` clause matched on, and the row that has none omits the key rather than sending `null` — `ScanFindingSchema`'s attribution fields are `.optional()` and never nullable, so a `null` would fail the response schema (`toPersistedScanFinding` drops them for exactly that reason). A consumer that read `fixedVersion === null` as "no fix" would be reading a key that is never sent.

### §332. PAGING IS NOT OPTIONAL on this surface

PAGING IS NOT OPTIONAL on this surface: `SCAN_FINDINGS_PERSIST_CAP` is 2000 rows per run and M22.0a made several runs per change the norm. Driven at `limit=1` over a two-row set rather than over a large one, because what needs proving is that the cursor ADVANCES and TERMINATES, and a 2000-row walk would prove the same thing 1000 times more slowly.

THE MARKER ON THE SECOND PAGE is the assertion that is easy to omit and matters most: a consumer that pages sees `findingsRecord` on the first response and would otherwise have to remember it — and `ControlRunFindingsResponseSchema` makes it required precisely so no page can be read without it.

### §333. THE STATE A BARE ARRAY CANNOT EXPRESS

THE STATE A BARE ARRAY CANNOT EXPRESS. `webhook-control` returns `status` and `evidence` verbatim from an operator-configured endpoint, so its run is a real, passing control outcome whose evidence is not a scan verdict — the same shape every pre-M22.1b run has. A consumer that read `items: []` and stopped would conclude "this scan found nothing"; the `null` says "there is no finding set here at all, and no exclusion can apply".

### §334. CHARTER PRINCIPLE 3

CHARTER PRINCIPLE 3: every capability is API -> SDK -> CLI -> IaC -> UI, and the UI and CLI consume ONLY the generated SDK. A route with no client wrapper therefore has no first-party consumer, which is how a surface ships complete-on-paper and unreachable in practice — the exact shape M22.9's admission door already shipped in once.

Every other case here speaks raw `fetch` ON PURPOSE, so that a 404 means "the route is not registered" rather than "the wrapper is wrong". This one is the opposite question, and it is the only case in the file that can answer it: the wrapper was added AFTER the route, and an unexercised wrapper is the same defect class one layer up.

## `apps/server/src/governance/scan-findings-repo.ts`

### §335. The one writer of the scan findings table

M22.1b (ADR-0033 §7) — THE ONE WRITER of `scan_findings` (migration 0073).

A scan verdict was four integers until M22.1a; every rule in ADR-0033 is a rule about a FINDING, so this is what makes the rest of M22 expressible. Both verdict producers funnel through here:

```text
- `federation/promotion-scan-step.ts` — the commander's own managed scan. It runs server-side
  and already has the parsed findings in hand, so it passes them straight through.
- `governance/control-runner.ts` — the `scan-result-control` ControlPlugin. That plugin runs in
  the subprocess plugin host with NO `DATABASE_URL` and cannot write anything; it transports its
  capped findings out on `ControlOutcome.evidence` and the SERVER persists them here, stripping
  the transport key on the way (`takeScanFindingsFromTransport`) so nothing lands on the
  `control_runs.evidence` column that federation copies verbatim into a promotion bundle.
```

WHAT THIS FUNCTION REFUSES, and why the refusal lives here rather than at each caller:

```text
1. A method whose verdicts STRUCTURALLY CANNOT decompose into findings (OpenSCAP — XCCDF
   rule-results have no package, no purl, no `FixedVersion`, no `Class`, and XCCDF emits no
   `critical` at all). It writes NOTHING and reports `unsupported`, decided from the METHOD
   before the payload is examined. ADR-0033's consequences list is explicit that this must be
   "explicit and tested, not left to 'there were no findings to exclude'" — so the refusal
   survives even when a caller hands it a non-empty array.
2. A producer that transported no findings at all (a pre-M22.1b plugin, a malformed payload).
   Reports `undefined` — an ABSENT marker, indistinguishable from every scan recorded before
   this increment, which consumers must refuse exclusions for exactly as they do a truncated
   set.
```

THE RETURNED MARKER IS NOT THIS FUNCTION'S OPINION. It comes from the pure `scanFindingsRecordFor`, which each caller ALSO calls to stamp `evidence.findingsRecord` before inserting the control run — because the marker has to be on the row at INSERT time while the rows here need the control run's id, which only exists after it. One pure function decides both, in one transaction, so "the evidence says full, the table says otherwise" is not a reachable state.

THE READER THIS DEMANDED IS `loadScanFindings` BELOW, and it has the shape demanded: it hands back the marker WITH the rows, never the rows alone. Every marker state except `full` — `truncated`, `unsupported`, and ABSENT — refuses every exclusion for that scan ("you cannot except what you did not record"), and a loader that returns a bare array is one a caller can use without ever learning that.

### §336. The positions an admitted exclusion clause excuses

M22.2 (ADR-0033 D10, ADR-0024 §D1) — the positions an admitted exclusion clause EXCLUDED.

These rows are written at retention class `E` instead of `O`, and the split is the whole point of assigning a class per row: an excluded finding is ACCEPTED-RISK EVIDENCE that explains a live verdict and records what an operator chose to tolerate, so it must outlive the short telemetry window an ordinary finding gets. Collapsing the two classes would either keep every finding forever (this is the highest-cardinality table in the system) or discard the only per-finding record of why a promotion was allowed.

The DECIDER is upstream, never here: the plugin (or the promotion scan step) applied the clauses against a gate context this transaction no longer holds, so re-deriving the set here is not possible and guessing it would be worse.

### §337. ADR-0024 §D1 class, assigned PER ROW at write time

ADR-0024 §D1 class, assigned PER ROW at write time (ADR-0033 D10). `E` for a finding an admitted exclusion clause tolerated — accepted-risk evidence explaining a LIVE verdict — and `O` for every other, which is telemetry about what a scanner saw. Assigned at INSERT rather than by a later UPDATE, because the exclusion decision is made in the same call that produced these rows and a two-step would leave a window where the row's class contradicts the evidence beside it.

### §338. Reading the rows this file writes, as the writer promises

M22.9 — READING the rows this file writes, and the reader the writer's docblock demanded.

WHAT WAS TRUE BEFORE THIS FUNCTION, stated plainly because the conclusion it invites is nearly the wrong one: `persistScanFindings` had two call sites, both discarded its return, and the only reads of `scan_findings` anywhere in the tree were integration tests. Both producers resolve exclusions against the IN-MEMORY array, so deleting the writer would have left production behaviour byte-identical — and "therefore it is dead code, hold it out of the merge" is wrong. `SCAN_EXCLUSION_EVIDENCE_CAP` (100) bounds the per-clause enumeration on `evidence.exclusions` while `appliedCount` stays EXACT, so past 100 exclusions these class-`E` rows are the only per-finding record of what an operator chose to tolerate — the accepted-risk evidence ADR-0033 D10 requires under charter principle 6. Removing the writer would have deleted an audit record. What was actually missing was this.

It is also NOT the `decisions` write-amplification shape, which is what a write-only activity-proportional table looks like from a distance. That was ONE byte-identical row rewritten every reconcile tick on an IDLE system (99.94% duplicates, ADR-0024 §Context); these rows are distinct per finding and are written once per real gate crossing. The retention story is still owed, and migration 0073's header says exactly what bounds the table until ADR-0024's generic prune lands — deliberately no bespoke sweeper here (charter priority 7, Simplicity first).

THE MARKER COMES BACK WITH THE ROWS AND CANNOT BE OMITTED, because every state except `full` — `truncated`, `unsupported`, ABSENT — refuses every exclusion for that scan, and a caller handed a bare array can never learn that. `record: undefined` covers two situations that a consumer must treat identically and does not need to distinguish: no marker was written (every pre-M22.1b verdict), or the run's evidence does not parse as scan evidence at all (any non-scan control). The parse is `ScanEvidenceSchema`, the same whole-document parse the E6 export gate already applies to this column, so a document those two would read differently is not reachable.

`undefined` for the whole result means NO SUCH CONTROL RUN is visible in this org — distinct from a run with zero findings, which is `{ record, findings: [], nextCursor: null }`.

PAGING IS NOT OPTIONAL. `SCAN_FINDINGS_PERSIST_CAP` is 2000 rows per run and M22.0a made several runs per change the norm, so an unbounded load is a footgun on the only surface that has this data; the caller must pass a limit.

## `apps/server/src/governance/scan-findings.integration.test.ts`

### §339. Findings persisted, and wired at both verdict producers

M22.1b — `scan_findings` PERSISTED, AND WIRED AT BOTH VERDICT PRODUCERS (ADR-0033 §7/§7a, migration 0065).

M22.1a made both Trivy parse sites derive their counts from one shared `parseTrivyFindings`, so findings finally EXIST at parse time — and nothing wrote them anywhere. Every rule in ADR-0033 is a rule about a FINDING, so a table nobody fills is the whole milestone stalled. The failure mode this file exists to refuse is this repo's dominant one: a component built, tested green against itself, and installed nowhere.

SO EVERY TEST HERE DRIVES A PRODUCTION ENTRY POINT. Nothing calls `persistScanFindings` directly:

```text
- `runPromotionScanStep(...)` — the commander's own managed scan (`federation/`).
- `ensureControlRun(...)`     — the ControlPlugin path (`governance/`), where the plugin has no
                                `DATABASE_URL` and hands its findings to the server on the
                                outcome's evidence.
```

MUTATIONS RUN against this file (2026-08-17) — the MEASURED result of each, reverted by an exact inverse edit. Baseline: 14 passed.

```text
M-A  DELETE the `persistScanFindings(...)` call in `governance/control-runner.ts`
       -> 3 failed (A1, A2, A3). The plugin-side wiring is INSTALLED, not merely built.
M-B  DELETE the `persistScanFindings(...)` call in `federation/promotion-scan-step.ts`
       -> 5 failed (P1, P3, P5, R1, R3). The managed-scan wiring is INSTALLED.
          P2 and P4 survive this one BY DESIGN — both assert an ABSENCE of rows, so neither can
          ever witness the writer disappearing. That is why M-D exists.
M-C  DELETE the `takeScanFindingsFromTransport` strip in `control-runner.ts` (persist the raw
     outcome evidence)
       -> 2 failed (A3, A4): the transport key survives onto `control_runs.evidence`, which
          federation copies VERBATIM into a promotion bundle. This is the mutation that would
          have federated accepted-risk detail ADR-0033 §8 confines to grants.
M-D  `scanMethodCarriesFindings("openscap")` returning `true`
       -> 1 failed (P2): an OpenSCAP verdict gains a finding set. The refusal is by METHOD,
          which is why P2 hands the openscap runner a NON-EMPTY findings array — a refusal
          keyed on "there were no findings to exclude" would pass a broken build.
```

```text
       THIS MUTATION SURVIVED ON ITS FIRST RUN, and the reason is worth writing down: the server
       resolves `@scp/schemas` to `dist/`, not `src/`, so editing the source and re-running the
       integration suite tests the OLD compiled function. It only went red after
       `pnpm --filter @scp/schemas build`. An integration mutation that lives in a workspace
       PACKAGE is not applied until that package is rebuilt — a green run after mutating `src`
       is green for the wrong reason, not evidence of coverage.
M-E  drop `ON DELETE CASCADE` from `scan_findings_control_run_fk` (migration 0065)
       -> 1 failed (R3): findings outlive the verdict they explain.
```

Real PostgreSQL 16 via Testcontainers, in its OWN database (`createIsolatedDomain`), so the RLS probes can hold a raw `scp_app` connection without touching any other file's data.

### §340. The runner deliberately returns findings ALONGSIDE `openscap`

The runner deliberately returns findings ALONGSIDE `openscap`. XCCDF rule-results have no package, purl, `FixedVersion` or `Class`, so this can never happen for real — which is exactly why it is injected here. ADR-0033's consequences list requires this be refused explicitly "and tested, not left to 'there were no findings to exclude'"; a refusal keyed on an empty array would let this through.

### §341. PRODUCER A — the ControlPlugin path

PRODUCER A — the ControlPlugin path (governance/control-runner.ts)

The plugin runs in the subprocess plugin host with no `DATABASE_URL`. It transports its capped findings out on the outcome's evidence and the SERVER persists them; the fake host below stands in for that subprocess and returns exactly the record `scan-result-control` builds.

### §342. TENANCY — ordinary tenant data under RLS

TENANCY — ordinary tenant data under RLS (ADR-0033 §7a), NOT the instance-scoped exception M22.2's admission rows are. Probed with a RAW `scp_app` connection: the database's own defenses, independent of whether the repo layer remembers to filter.

## `apps/server/src/governance/scan-override-authority.test.ts`

### §343. The approver-standing algebra, as a pure function

M22.6 (ADR-0033 §6a, owner decision D3) — THE APPROVER-STANDING ALGEBRA, as a pure function.

This file pins the two halves of the derivation and nothing else. The WIRING — that the gate actually calls them, with the real ceiling and the real containment chain — is proven at the real gate in `scan-declared-override-exclusions.integration.test.ts` (cases O7-O10), because a pure test cannot tell you whether a component is installed, which is this repo's dominant defect.

THE DEFECT THESE EXIST AGAINST: `tierObjectId` was chosen freely by the REQUESTER and read afterwards only for PRESENCE. Since `scopeExpandCte` expands UPWARD, naming a LOWER object strictly WIDENED the approver set — a service lead could approve away a platform-set `maxCritical: 0` and the audit trail would truthfully record "under authority of '<service>'".

MUTATIONS RUN (2026-08-18), each applied ALONE against a passing suite and reverted by an exact inverse edit. Baseline: 8 passed. MEASURED, not predicted.

```text
U-1  `applyOverrideAuthorityBar` grants EVERY candidate (both refusal branches disabled)
       -> 3 failed here, plus O7 and O9 at the real gate. The whole objection, undone.
U-2  `requiredOverrideApprovalTier` iterates an empty contributor list (always `component`)
       -> 2 failed here, plus O7, O8 and O9 at the real gate.
U-3  an off-chain `tierObjectId` falls open to `"component"` instead of being refused
       -> 1 failed ("NOT ON THE CHAIN"). The fail-open an absent map lookup invites, and the one
          a reviewer is most likely to write while "tidying up a nullable".
```

### §344. THIS CASE INVERTED

THIS CASE INVERTED (owner decision, 2026-08-18). It used to assert `component`, i.e. no bar, on the reading that with no `scanThreshold` policy and no instance floor nothing constrains the requester. That reading was wrong, and an adversarial pass measured the escalation it allowed: the gate still enforces a ceiling from the control binding's `config.threshold` (authored at CONTROL scope, which is nowhere on the component's containment chain) or, failing that, from the plugin's shipped fail-closed `maxCritical`/`maxHigh` = 0. Exclusions are applied BEFORE the comparison, so with the bar at `component` a service-scoped `policy:write` holder could raise and self-approve a waiver against a ceiling they had no standing to author.

`org` and not the fully-derived tier: deriving the true bar makes every grant inert wherever nothing was authored, which kills the feature. `org` is the most senior rung a TENANT can author at — the strongest floor that leaves the override usable. See `requiredOverrideApprovalTier`'s docblock for what this deliberately does NOT close.

### §345. The mutation a reasonable implementer writes

The mutation a reasonable implementer writes: "only the tier whose value is the per-severity MIN is actually being waived". Wrong, and this case is the argument. Excluding a finding drops it out of the COUNT, so a count of 6 falling to 5 satisfies platform's ceiling of 5 exactly as it satisfies the service ceiling of 0 that produced the block. Keying on the MIN would let the service tier defeat platform's ceiling indirectly.

### §346. A label the tier vocabulary does not know contributes nothing

A label the tier vocabulary does not know contributes nothing — `tierRank` returns -1 and the loop skips it — so the answer is whatever the floor is. This used to read `component`; it now reads `org` for the same reason every other no-contribution case does, and that is the safe direction: an unparseable contributor must never be the thing that LOWERS a bar. A federated row from a peer running a newer tier vocabulary is exactly how such a label arrives.

## `apps/server/src/governance/scan-override-grant-authoring-guard.ts`

### §347. A grant may be raised through any door, and what that costs

M22.6 (ADR-0033 §6a; owner decisions D3, D4) — A GRANT MAY BE *RAISED* THROUGH ANY WRITE DOOR; IT MAY ONLY BE *DECIDED* THROUGH THE ONE THAT ARBITRATES IT.

THE HOLE THIS CLOSES — A SECOND DOOR STRAIGHT TO THE REPO LAYER
`scan_override_grant` is in `GOVERNANCE_MANAGED_OBJECT_TYPE_IDS`, and the previous version of this feature relied on that alone. The set buys exactly two things: the generic `/objects/{type}` endpoint refuses the type outright, and `coordination-as-code/plans-repo.ts` demands `policy:write` at the target domain instead of `object:write`. The routes' own docblock then reasoned "without that, a holder of plain `object:write` could write `{status: "approved", expiresAt: "2099-…"}` directly" — true, and not the whole shape. A holder of `policy:write` at a CONTAINMENT DOMAIN — an ordinary scoped policy-author binding — could submit an IaC manifest creating exactly that document and `POST /plans/{id}/apply` it. `drizzle/0075`'s `property_schema` is typed-but-OPEN (it must be: `import-repo.ts` Ajv-validates with no try/catch and one rejection aborts a peer's whole signed bundle), so it accepts `status: "approved"` and a free-string `expiresAt`. The result was an already-approved grant with NO tier check on the rule being waived, NO Decision, NO hash-chained audit event and NO future-expiry validation — every guarantee of the override design, routed around.

The permission mapping was never the defence. The defence is that the DECISION FIELDS are writable only by the act that decides, and that has to be enforced where the data lands.

WHY THE CHOKE POINT AND NOT THE ROUTE — THE STANDING LESSON IN THIS REPO
`graph/objects-repo.ts`'s `createObject`/`updateObject` are the one place every LOCAL write door funnels through. A filterless census of doors reaching them with a free-form `typeId` and free-form `properties` finds: the generic `/objects/{type}` routes, `POST /plans` + `/plans/{id}/apply`, `POST /federation/hand-fill`, `POST /federation/overlays`, the typed registries and `services/objects-service.ts`. Installing at any one of them rebuilds the same rake for the next. This is the fourth guard to be installed at that choke point for exactly this reason (`component-declaration-guard.ts`, `subscription-authoring-guard.ts`, `scan-rule-authoring-guard.ts` are the other three), and PR #249's five recorders and PR #256's discovery/accept finding are the two prior instances of the same class in this tree.

WHAT IS REFUSED, AND WHY `requested` IS STILL ALLOWED THROUGH
Refused: `status` present and anything other than `requested`, and any of `expiresAt`, `decidedByActorId`, `decidedAt`, `decisionReason`. Those five fields ARE the decision — the resolver's live-grant window reads `status = 'approved'` AND `expiresAt > now()`, and the other three are the audit attribution.

A `requested` grant is deliberately NOT refused at any door. It authorizes nothing (the resolver requires `approved`), it is exactly the record ADR-0033 wants raised early and often, and refusing it would make an IaC-managed stack unable to even declare the request it wants a human to decide.

The check is on the value about to be STORED. `updateObject` REPLACES `properties`, so a document that omits `status` entirely de-approves rather than preserves — safe in the tightening direction, and still refused if it carries `expiresAt`, because a decision field with no decision is a row a later reader cannot explain.

THE TWO EXEMPTIONS, EACH AS NARROW AS IT LOOKS
1. `federationImport` (the choke point's existing `if (!input.federationImport)` block). NOT because imported data is trusted: `import-repo.ts`'s `object_upsert` branch has NO try/catch, so a throw aborts a peer's ENTIRE signed bundle and wedges the channel. D9 makes grants federate FULLY, so an approved grant legitimately arrives over the journal; it was decided at its AUTHORING instance, where this guard ran, and M6 single-writer authority means only that instance's domain can ever revise it. The exemption is closed at the OTHER `federationImport` supplier — `federation/handfill-repo.ts` calls this guard explicitly, because hand-fill is a LOCAL operator action wearing the import flag with no bundle to wedge. 2. `ScanOverrideGrantDecisionWrite` — the internal flag `routes/scan-override-grants.ts`'s `decide` helper sets on its `updateObject` call. It is a TypeScript-only field on the repo input: no request body reaches it, and no other module sets it. That helper is the only code path that performs the `policy:write`-at-the-derived-tier check, the future-expiry validation, the Decision and the hash-chained audit event — which is precisely the list of things this guard exists to make unskippable.

## `apps/server/src/governance/scan-override-grants.ts`

### §348. The override request, as a governed object

M22.6 (ADR-0033 §6a; owner decisions D3, D4, D9) — THE OVERRIDE REQUEST, as a governance-managed graph object.

WHY A GRAPH OBJECT AND NOT A TABLE (charter principle 2)
A grant is a governed thing with an owner, an authority, a lifecycle and — under D9 — a requirement to FEDERATE. `objects` already provides all four, including the journal entry kind that makes the fourth possible: `JournalEntryKindSchema` admits exactly nine entry kinds and none of them is a bespoke row, so a grant stored outside `objects` could never cross a federation boundary at all. ADR-0026 D9 made this same call for `placement` and 0051's header records the same deciding fact.

WHY `approval_requests` COULD NOT BE REUSED — measured, not assumed
Three structural refusals, any one of which is fatal: 1. `change_object_id NOT NULL` — it is CHANGE-KEYED. D4's grant is standing, per (component x finding), and outlives every change. 2. TWO-STATE (`pending | satisfied`) — no deny, no revoke, no expire. 3. ENGINE-MATERIALIZED with no create API — a human cannot raise one. The shape to copy is `freeze.override` (DESIGN §10.3): a mandatory non-empty reason and a HIGH-SEVERITY hash-chained audit event per act. The approvals path is explicitly NOT the shape to copy — a vote writes no audit event today, and that gap must not be inherited by a surface whose entire purpose is to tolerate a known vulnerability.

APPROVER STANDING (D3): THE TIER THAT SET THE RULE — and it needs NO new authority model
A platform-set floor is waivable only at platform; an assembly-set ceiling at assembly. Escalation is then self-evident: you cannot waive a constraint stricter than your own authority.

VERIFIED END TO END against this tree rather than taken from the ADR: - `authz/resolve.ts`'s `scopeExpandCte` starts at the named `scopeObjectId` and walks UPWARD (`objects.domain_id`, `contains`, and the two placement routes). So a `policy:write` binding at the named tier object — or at anything ABOVE it — satisfies the check, and a binding BELOW it (at a component, say) never reaches its assembly or its siblings. Authority expands strictly upward, which is exactly D3's "you cannot waive what you could not have authored". - `policy-scope-authz.ts` requires `policy:write` AT-OR-ABOVE the object for a BOUNDED `objectRef`; the org-root bar applies only to unscoped, selector and group scopes. Naming the tier's object concretely IS the bounded case. So the approve check below is one ordinary `authorize({permission: "policy:write", scopeObjectId: tierObjectId})` call. That is the whole of why D3 was affordable — AND IT IS NOT SUFFICIENT ON ITS OWN, which the first version of this module got wrong.

THE HOLE THAT WAS HERE. `scopeExpandCte` expanding upward cuts BOTH ways: a binding below the named object never satisfies the check, but naming a LOWER object strictly WIDENS the set of principals that do. `tierObjectId` was supplied by the REQUESTER and compared to nothing, so the party seeking a waiver chose the authority that would grant it — name your own service, approve at your own service, and a platform-set `maxCritical: 0` is waived while the audit trail truthfully records "under authority of '<service>'". The authorize call was never wrong; what was missing was any DERIVATION of which object it should be pointed at.

THE TIER IS NOW DERIVED, at three places, none of which trusts the claim: - RAISE and APPROVE call `assertOverrideTierStanding` — the named object must lie on the component's own containment chain, and the approve half additionally refuses while an INSTANCE floor is set (no graph object maps to `platform`/`trust_domain`, so such a grant could never apply and approving it would leave the approver with a false belief). - THE GATE calls `applyOverrideAuthorityBar`, which is the decisive one: it re-derives the grant's tier from the target's chain and compares it against the tier that actually set the ceiling. See that function's docblock for the full argument, including why the bar is EVERY contributing tier rather than only the binding one.

A note on what CANNOT decide who may RAISE a request: `owners-of` walks `domain_id` only and never joins `contains`, so it does not see a component's service or assembly. Raising is therefore gated on plain `object:write` at the component — the permission a component owner already has — rather than on an ownership query that would be silently wrong for every component whose owner is attached at the service.

EXPIRY IS A READ-TIME SQL WINDOW, NEVER A STATUS A JOB FLIPS
Following `freezes-repo.ts`'s `activeFreezesForScopes`, which compares `starts_at`/`ends_at` against `at` on every read. There is NO sweeper anywhere in this tree and no `boss.schedule` usage to build one on, so a design that needed one would ship a grant that never expires. The `ScanOverrideGrantStatus` enum therefore has no `expired` member: adding one would be a promise that something transitions rows into it, and any reader that then trusted the status alone would honour an expired grant.

The comparison is done IN SQL (`(properties->>'expiresAt')::timestamptz > now()`) rather than in TypeScript, for the same reason the freeze window is: a filter the database applies cannot be skipped by a second caller who forgot it. The in-memory `expiresAt` that travels on the resolved fact is for the AUDIT TRAIL ("until when"), never a second enforcement point.

### §349. The resolver: grants live for this target right now

THE RESOLVER — grants that are LIVE for this target right now.

Three conditions, all applied by the database in one statement: 1. `status = 'approved'` — a `requested`, `denied` or `revoked` grant authorizes nothing. 2. `expiresAt` PRESENT and STILL IN THE FUTURE. An approved grant with no `expiresAt` is REFUSED rather than treated as unlimited: D4's grant is standing *with an expiry*, and a row that lost its expiry (a hand-written property, a federated row from a peer that omitted it) is exactly the shape that must not become a permanent blanket waiver. 3. it names THIS component.

`at` is injected rather than read from `now()` so a test can pin the boundary; production callers pass the gate's own instant. The comparison is a timestamptz cast in SQL — a text comparison on an ISO string would be *almost* right and would silently mis-order the moment a peer wrote an offset other than `Z`.

THE CAST IS GUARDED, AND THAT IS NOT DECORATION — it is the second instance of a class this repo has already paid for once. `graph/containment.ts` wraps its `::uuid` in a `CASE ... ~ pattern` for exactly this reason, and the sweep for that property did not reach this cast when it was written.

`expiresAt` is a FREE-FORM STRING on this path. The registered `property_schema` types it only as `{"type": "string"}`, and the M22.6 authoring guard — which refuses the field outright at every local door — deliberately EXEMPTS `federationImport`, because a throw there aborts a peer's whole signed bundle. D9 federates grants fully, so an approved grant for this component legitimately arrives over the journal, and `import-repo.ts` writes its properties verbatim after an Ajv check that a bare `type: string` passes. One peer row carrying `expiresAt: "never"` would make a BARE cast throw inside every gate evaluation for that org — prewarm, wave boundary, `POST /policy-evaluate` and the commander promotion scan all die, so no change in the org can be validated or advanced until an operator finds the row. Fail-open by way of a crash, from across a trust boundary.

With the `CASE`, a malformed value yields NULL, `NULL > $at` is NULL, and the row is simply not returned — the grant is NOT live. That is the fail-CLOSED direction and it agrees with condition 2 above: a grant that lost a usable expiry authorizes nothing.

`CASE` rather than a sibling `WHERE` conjunct, for the reason containment.ts records: only `CASE` guarantees the ordering. Postgres may evaluate two same-cost-class jsonb quals in either order, so a guard sitting beside the cast is not a guard.

### §350. Instants as text, before Postgres is asked to read one

ISO-8601 instants, as TEXT, before Postgres is asked to read one.

DELIBERATELY WIDER THAN `toISOString()`. Narrowing this to the `Z` shape Node emits would reject legitimate federated grants from a peer that wrote a numeric offset — and the docblock above anticipates exactly that peer. A fail-closed wrong answer is still a wrong answer: it would drop a valid waiver silently. So offsets are accepted, and Postgres remains the thing that decides what the instant MEANS; this pattern only decides whether it is safe to ask.

### §351. THE READ-TIME WINDOW

THE READ-TIME WINDOW. `freezes-repo.ts`'s pattern, and the reason ADR-0033 §6a forbids a status column a job flips: nothing in this tree would ever flip it.

Guarded exactly as `graph/containment.ts` guards its `::uuid` — see the docblock above for why an unguarded cast here is a tenant-wide denial of service reachable from a peer.

### §352. The same refusal in code, not redundant with the query

THE SAME REFUSAL, IN JS, and not redundant with the SQL `CASE` above. The window decides which ROWS come back; this decides what a `ScanOverrideGrantCandidate` is allowed to CARRY. A future caller reading `.expiresAt` off a candidate — to render it, to compare it, to put it in a Decision — must not receive a string that is not an instant, and it should not have to know that a SQL predicate two dozen lines up was the only thing keeping it honest.

### §353. The authority bar, applied to one target's live grants

D3, ENFORCED — the authority bar, applied to one target's live grants.

WHAT WAS WRONG, IN ONE SENTENCE
`tierObjectId` was chosen freely by the REQUESTER, resolved with `getObjectByIdOrUrnAnyType` on trust, and read afterwards only for PRESENCE. Because `scopeExpandCte` expands UPWARD, naming a LOWER object strictly WIDENS the approver set — so the party seeking a waiver selected the authority that would grant it, and a service lead could approve away a platform-set floor while the audit trail truthfully recorded "under authority of '<service>'".

THE FIX: THE TIER IS DERIVED, THE CLAIM IS ONLY VALIDATED
Two derivations, neither of which reads anything the requester wrote:

```text
- THE GRANT'S OWN TIER comes from placing `tierObjectId` on THIS TARGET'S containment chain and
  reading `tierForObjectType` off the placement. A named object that is not on the chain is not
  an ancestor of the component, holds no authority over it through any route the RBAC walk uses,
  and is refused outright — never silently mapped to `component`.
- THE BAR (`requiredTier`) comes from `EffectiveScanThreshold.contributors`, the provenance M22.0
  recorded so a block could name the tier that bound it.
```

A grant applies only when its derived tier is AT OR ABOVE the bar. `TIER_ORDER` is top-down, so "at or above" is `rank <= rank`.

WHY THE BAR IS *EVERY* CONTRIBUTOR AND NOT ONLY THE BINDING ONE
Tempting and wrong: "only the tier whose value is the per-severity MIN is being waived". Excluding a finding removes it from the COUNT, which loosens every ceiling on that severity at once — a count of 6 dropping to 5 satisfies a platform ceiling of 5 just as surely as it satisfies the service ceiling of 0 that produced the block. So the bar is the most senior tier that set ANY ceiling; anything narrower lets a junior tier defeat a senior one indirectly.

TWO CONSEQUENCES, STATED RATHER THAN DISCOVERED
```text
- AN INSTANCE FLOOR MAKES GRANTS INERT. `readInstanceScanFloors` contributes at `platform` /
  `trust_domain`, and `tierForObjectType` maps no graph object to either — those rungs are
  authored with the deployment operator token, which no tenant role can grant. So while an
  instance floor is set, no grant can clear the bar. That is D3 read literally ("a platform-set
  floor is waivable only at platform") and it is why the approve route refuses up front rather
  than letting an operator believe they granted something.
- WITH NO TIER-SET CEILING THE BAR IS `org`, AND IT IS NEVER `component`. This bullet used to
  claim the opposite — "no constraint stricter than the requester's own authority to escalate
  past" — which was false, and measurably so: the gate still enforces a ceiling from the control
  binding's `config.threshold` (authored at CONTROL scope, off the component's chain) or, when
  nothing else decides a severity, from the scan plugin's shipped fail-closed 0/0. Exclusions
  are subtracted from the counts BEFORE they are compared, so a bar of `component` let a
  service-scoped `policy:write` holder waive a ceiling they had no standing to author. The floor
  is `org` — the most senior rung a tenant can author at — and it only ever tightens the bottom:
  `platform`/`trust_domain` contributions still raise the bar past it. See
  `requiredOverrideApprovalTier` in `scan-requirements.ts` for the full argument, the rejected
  alternative, and what the floor deliberately does NOT close.
```

### §354. Pure: composes several targets' live grants into one

PURE — compose several targets' live grants into the ONE set that describes the change.

AN INTERSECTION, never a union, for exactly the reason ADR-0033 §3 forbids unioning clauses: one verdict is produced for one artifact across the change's whole target set, and a grant approved for component A that leaked onto sibling B would tolerate a vulnerability on a component nobody approved anything for.

The intersection is on the (vulnerabilityId, pkgName) PAIR — what the grant actually excuses — and NOT on `grantObjectId`, which is per-component by construction and would make every multi-target intersection empty. The surviving `grantObjectId` is the first in the deterministic order, so the evidence names a real, resolvable grant rather than a synthesized one.

## `apps/server/src/governance/scan-override-standing.ts`

### §355. The authoring-time half of the approver standing rule

M22.6 (ADR-0033 §6a, owner decision D3) — THE AUTHORING-TIME HALF of "the approver tier is DERIVED, never declared".

WHY THIS FILE EXISTS RATHER THAN LIVING IN `scan-override-grants.ts`
Purely structural: `scan-requirements.ts` already imports the grant resolver, so the grant module cannot import back without a cycle. This module sits above both and is imported only by the routes.

THIS IS THE WEAKER OF THE TWO CHECKS, AND THAT IS DELIBERATE
The DECISIVE check is `applyOverrideAuthorityBar`, applied at the gate where the effective ceiling and its contributing tiers actually exist. Everything here is an authoring-time refusal that exists so an approver is not left believing they granted something a gate will silently ignore — the same reason the approve route already refuses a past `expiresAt` that the resolver would ignore anyway.

A refusal at the door can never be the whole enforcement for this feature, because the rule a grant waives is resolved PER CHANGE from the policies matching that change's targets: a ceiling can be authored, retargeted or conditioned after the grant is approved. So the door refuses what it can prove now, and the gate re-derives everything from scratch.

### §356. THE CHAIN CHECK

THE CHAIN CHECK — `tierObjectId` must be an object on the COMPONENT'S OWN containment chain.

`getObjectByIdOrUrnAnyType` resolving the id proves only that the row exists. Naming any object in the graph was the original defect: because `authz/resolve.ts`'s `scopeExpandCte` expands UPWARD, a requester naming an object they already hold `policy:write` at hands themselves approver standing. Requiring the object to be an ancestor (or the component itself) makes the named authority one that genuinely reaches this component through the same routes the RBAC walk uses, and gives the gate a tier to derive rather than a label to trust.

Returns the DERIVED tier so the caller never re-derives it from a different source.

### §357. THE INSTANCE-FLOOR CHECK

THE INSTANCE-FLOOR CHECK — refuse to APPROVE a grant that could never apply.

`scan_requirement_floors` rows are authored ONLY with the deployment operator token (`routes/instance-scan-floors.ts`: "no tenant role can grant it"), and they contribute at `platform` / `trust_domain`. `tierForObjectType` maps NO graph object to either rung, so while any such floor is set there is no `tierObjectId` a tenant could name that clears the bar — the gate would refuse every grant for authority.

D3 read literally: "a platform-set floor is waivable only at platform." That is exactly what this says out loud at the door, instead of letting an approver sign an accepted-risk record that has no effect. A floor added AFTER an approval is still handled — by the gate, which re-derives the bar on every evaluation.

NOTE THE ASYMMETRY WITH `deny`/`revoke`: only APPROVE is refused. Taking a waiver back must never be harder than making one, and neither verb can loosen anything.

## `apps/server/src/governance/scan-requirements-read.integration.test.ts`

### §358. The scan-requirements read surface, end to end

M22.8 — `GET /components/{idOrUrn}/scan-requirements`, THE READ SURFACE (ADR-0033 §11).

WHAT THIS FILE IS FOR. The pure algebra is already pinned in `scan-requirements.test.ts` and the pure application in `packages/schemas/src/supply-chain.test.ts`. Neither can tell you whether the ROUTE exists, whether it is wired to the same resolution the gate uses, or whether it keeps its one promise — that it writes NOTHING. So every test below goes through the HTTP surface via the generated SDK. Nothing here calls `readComponentScanRequirements` directly.

THE PROMISE THAT MAKES THIS SURFACE WORTH HAVING is R3: zero Decision rows. `POST /policy-evaluate` runs the real orchestrator and writes one Decision per call with no write suppression, so a UI polling it recreates — per viewer, per interval — the amplification ADR-0024 §D0 exists over. R3 asserts both halves against the same database in the same test, because "this one writes nothing" is only meaningful next to "and that one does".

MUTATIONS RUN against this file are recorded in the increment report, not predicted here.

### §359. THE PRODUCTION WRITE DOOR

THE PRODUCTION WRITE DOOR (M22.9). This used to `INSERT INTO scan_exclusion_admissions` over the admin pool, which made the suite green while the two instance rungs every clause requires — and that NO policy can ever contribute — had no writer outside these tests. It now goes through `PUT /api/v1/instance/scan-exclusion-admissions/{tier}` with the deployment operator token, so this read surface is tested against admissions an operator could actually have authored. The PUT is a whole-set REPLACE, so this unions with what is already admitted.

## `apps/server/src/governance/scan-requirements-read.ts`

### §360. The read surface behind the scan-requirements route

M22.8 — THE READ SURFACE behind `GET /components/{idOrUrn}/scan-requirements`.

WHY THIS IS NOT `POST /policy-evaluate`
`policy-evaluate` runs the real orchestrator and, like every real gate, WRITES A DECISION — one row per call, through `insertDecision`, with no write suppression on that path. A UI or a CLI loop polling it would reproduce, per viewer and per interval, exactly the amplification ADR-0024 §D0 was raised over after 1.44 GB/day of byte-identical rows was measured in production.

This function writes NOTHING. It performs reads only: the instance floor/admission tables, the policy matcher, and the containment chain. Nothing here inserts, and nothing here is allowed to.

IT EVALUATES NO CEL, AND THAT IS A DESIGN COMMITMENT RATHER THAN A SHORTCUT
A CEL condition is evaluated against a CHANGE: `buildCelContext` needs the change's id, its emergency flag, its targets, the governance subject, that subject's graph facts and the gate's own instant. This route is asked about a COMPONENT. There is no change, so there is no honest context to evaluate against — a fabricated one would produce an answer that is confidently wrong and, being a scan LOOSENING surface, wrong in a direction nobody would check.

So every condition-carrying contributor is treated CONSERVATIVELY — and the conservative direction is OPPOSITE in the two dimensions, exactly as ADR-0033 §4 requires:

```text
- **CEILING**: an unevaluated condition STILL SETS ITS CEILING. Dropping a ceiling turns a fail
  into a pass, so the safe reading is to include it. This is the same sign
  `ceilingContributorKeys` already applies to a condition that ERRORED.
- **EXCLUSION**: an unevaluated condition YIELDS NO CLAUSE. Admitting a loosening whose
  condition could not be evaluated IS the fail-open. Same sign as `exclusionContributorKeys`.
```

Both signs are obtained WITHOUT a second copy of that logic, by handing the two existing helpers one synthetic firing set (see `unevaluatedFiringSet`). If somebody ever merges those two helpers — which ADR-0033 §4 forbids in those words — this surface changes sign along with the gate, rather than quietly keeping the old one.

The affected policies are NAMED in the response (`unevaluatedConditions`) rather than folded in silently, because a reader who cannot see which statements were guessed at cannot tell a conservative answer from a confident one.

THE ANSWER IS COMPUTED FOR THE CALLER, AND THAT IS VISIBLE IN IT
`matchPoliciesForTargets` takes an `actorObjectId`, because DESIGN §10.1's `scope.group` has an ACTING half: a group-scoped policy matches when the acting subject is transitively `member_of` the scoped group. So two callers can legitimately get two different ceilings for one component, and the real gate gets a third at a wave boundary, where the actor is `SYSTEM_ACTOR_ID` and is `member_of` nothing. Passing the authenticated caller is the only choice that describes a real evaluation rather than an invented one; the OWNING half (ADR-0016 §2a) is actor-independent and matches for everybody, which is what makes a CONSTRAINT authored by ownership stable here.

### §361. The synthetic firing set for a CEL-free evaluation

The synthetic firing set for a CEL-free evaluation.

IT IS NOT A FIRING SET AND MUST NOT BE USED AS ONE. `enforcement`, `requireControls` and `requireApprovals` are deliberately inert: this object exists solely to feed `ceilingContributorKeys` and `exclusionContributorKeys`, the two functions that read nothing but `fired`, `contributingPolicyVersions` and `conditionErrorPolicyVersions`. Handing it to a gate would enforce nothing at all, which is why nothing outside this module may see it.

THE ENCODING. A contributor with NO condition genuinely fires — there is nothing to evaluate and it applies unconditionally — so it lands in `contributingPolicyVersions`. A contributor WITH a condition was not evaluated, which is the same epistemic state as a condition that could not be evaluated, so it lands in `conditionErrorPolicyVersions`. The two existing helpers then produce the two opposite signs on their own: the ceiling's key set is the UNION of both lists, and the exclusion's is the first list MINUS the second.

Grouped by `name`, mirroring `resolvePolicies`' grouping key, so the shape is comparable to a real firing set. The grouping does not change either key set — both are unions over every entry.

MEASURED REDUNDANCY, recorded rather than tidied away. A mutation that put EVERY contributor into `contributingPolicyVersions` (dropping the filter below) left the whole suite green: the subtraction inside `exclusionContributorKeys` removes the condition-carrying ones again, so the `conditionErrorPolicyVersions` list alone already carries BOTH signs. The filter is therefore belt-and-braces, and it stays — the object should not claim that a conditional contributor "fired" — but nobody should read it as the thing holding the loosening closed. That is `exclusionContributorKeys`' subtraction, and `scan-requirements.ts` says so at the subtraction.

### §362. Which classes are admitted, and at which tiers

WHICH CLASSES ARE ADMITTED FOR THIS TARGET, and at which tiers a clause of each would survive.

EVERY class is reported, including ones nobody has admitted. The shipped default is that admission is EMPTY at every tier, so the most important state this surface can show is `admittedBy: [], effectiveAtTiers: []` — "nothing you author of this class will do anything". Reporting only the classes somebody happened to admit would make that state invisible, which is precisely the silent-no-op this increment exists to end.

`effectiveAtTiers` NEVER lists `platform` or `trust_domain`. Those two rungs come from `scan_exclusion_admissions`, a table with a `class` column and no clause: an instance rung can ADMIT and can never CONTRIBUTE. Listing them would invite an operator to look for an authoring surface that does not exist.

### §363. Resolves everything the read surface reports

Resolves everything the read surface reports. Reads only; writes nothing.

WHAT IT DELIBERATELY DOES NOT RESOLVE: the per-class FACTS — the dependency inventory's line heads (M22.4), the component's declarations (M22.5) and live override grants with their expiry (M22.6). Those are attached by `resolveEffectiveScanExclusionsForTargets` and each costs a join or a property read PER TARGET. This surface exists to be POLLED, and its question is "which rules are in force", not "what would this scan's findings do against them". Resolving facts here would put the inventory join on a polled endpoint and would invite the confusion ADR-0033 §1's last paragraph names: a clause being ADMITTED and a clause APPLYING to a finding are different questions, and one hidden behind the other is how a loosening stops being auditable.

## `apps/server/src/governance/scan-requirements.test.ts`

### §364. The monotone conjunction, as a pure function

M22.2 (ADR-0033 §1, §3) — THE MONOTONE AND, as a pure function.

The resolver's DB half is proven end-to-end at the real gate in `scan-exclusions.integration.test.ts`; this file pins the ALGEBRA, which is where the security property lives and where a plausible-looking edit does the damage. Every case below is a behaviour a reasonable implementer might have written the other way round.

MUTATIONS RUN (2026-08-17), each reverted by an exact inverse edit. Baseline: 9 passed. These are MEASURED results — one of them survived, and that is recorded rather than quietly dropped.

```text
R-1  flip the AND to an OR (admit when ANY represented tier above admits)
       -> 1 failed: "ADMITTED AT COMPONENT BUT NOT AT ORG".
R-2  UNION the per-target clause sets instead of intersecting them
       -> 1 failed: "EXCLUSIONS NEVER UNION ACROSS TARGETS".
R-3  ask EVERY tier above, whether or not it is represented on this target's chain
       -> 2 failed: "ADMITTED AT COMPONENT BUT NOT AT ORG" and "a tier that is NOT
          REPRESENTED". The first is the one worth noting: over-asking is not merely
          restrictive, it changes which admissions are recorded in `admittedBy`.
R-4  drop the `targets.length === 0` guard
       -> SURVIVED (9 passed). Recorded because a surviving mutation is information: the guard
          is a SECOND barrier, not the only one — with no targets the loop never runs, so
          `surviving` stays `undefined` and the `!surviving` check below returns `undefined`
          anyway. Both are kept: the guard states the intent at the top of the function, where
          a reader looking for "what does an empty family mean here" will look.
R-5  stop sorting the resolved clause array
       -> 1 failed: "the resolved clause array is ORDER-INDEPENDENT and content-sorted".
```

## `apps/server/src/governance/scan-requirements.ts`

### §365. M17.5 — SCOPED SCAN-REQUIREMENT RESOLUTION

M17.5 — SCOPED SCAN-REQUIREMENT RESOLUTION (ADR-0016).

Computes the EFFECTIVE scan threshold for a change's targets as the per-severity MIN across a SIX-tier chain, top-down:

platform -> trust domain (partition) -> org -> containment domain -> service -> component

MOST-RESTRICTIVE-WINS: a child tier may only ever TIGHTEN a ceiling, never loosen it. This mirrors — and is the same shape as — the existing stricter-wins `requireControls` set-union in `policy-model.ts` `resolvePolicies`, where a child scope can add a required control but can never drop one.

ORDER-INDEPENDENT BY CONSTRUCTION. The merge is a per-severity MIN over a SET; MIN is commutative and associative, so the result cannot depend on the order tiers are visited in. That is not a nicety — it is why this design is safe on top of `graph/containment.ts`, which DOCUMENTS (containment.ts:60-73) that containment-domain-vs-service is NOT a strict ordering: two ancestors of different kinds can be exactly equidistant from a component and TIE. "Most specific wins" override semantics would be undefined at that tie; most-restrictive-wins has no such failure mode. DO NOT add ordering/precedence logic here — it would reintroduce exactly the sensitivity this design exists to avoid.

TWO SENSES OF "DOMAIN", never conflated (ADR-0016 terminology): - `trust_domain` — the AMBIENT federation boundary (a partition) ABOVE org. Comes from the instance-scoped `scan_requirement_floors` table (no `org_id`), which applies to EVERY org on the deployment. - `containment_domain` — the intra-org `domain` OBJECT TYPE BELOW org, an ordinary graph node on the containment chain. The stored/emitted literal is `trust_domain`, never bare `domain`.

WHAT IS NEW HERE AND WHAT IS NOT. The four org-and-below tiers reuse the EXISTING machinery unchanged: `matchPoliciesForTargets` (org-rooted policy matching over `containmentChain`) gathers the contributing policy documents; this module only reads a `scanThreshold` effect out of them and folds it into the MIN. No new resolution engine, no new matching rules, no new tables for org-and-below (charter principle 2 — new concepts arrive as policy data). Only the two above-org tiers are new structure, and they share ONE table.

THE MATCHER THAT REUSE DEPENDS ON WAS FAIL-OPEN UNTIL 2026-08-15 (ADR-0016 §2a). `scope.group` implemented only DESIGN §10.1's ACTING-subject half, so a group-scoped scan CEILING contributed to the MIN below ONLY when the acting subject happened to be a member of that group. Since an absent contributor cannot tighten anything (see ABSENT NEVER MEANS ZERO), the effective threshold came out LOOSER than the operator authored — silently, for every non-member, and ALWAYS at the wave boundary, where the actor is `SYSTEM_ACTOR_ID` and is `member_of` nothing. This module was the live exposure of that defect, not its cause: nothing here needed to change. The matcher now also matches on the OWNING subject (`via: "ownerGroup"`), which is strictly additive, so this merge can only ever gain a contributor — never lose one. Note the knock-on for the tier LABEL below: an ownership match anchors at the OWNED object rather than the org root, so a service-owned ceiling is finally reported at the `service` tier instead of `org`.

ABSENT NEVER MEANS ZERO. A tier that sets no ceiling for a severity contributes NOTHING for that severity. Reading "no floor" as 0 would make it the TIGHTEST possible ceiling and would block everything — the exact inversion of the intended semantics.

CONDITIONS ARE HONOURED — a ceiling comes ONLY from the FIRED set. An org-and-below contributor whose CEL `condition` evaluated FALSE contributes NOTHING, exactly as it contributes no `requireControls`/`requireApprovals` (evaluate.ts `resolveFiredPolicies`; gate-orchestrator.ts drives both off the same `fired`). Anything else would let `when env == "prod", maxCritical: 0` silently apply in dev — tightening-only, so never unsafe, but SILENTLY over-restrictive and a block citing a policy whose condition was false (charter principle 6: every verdict must explain itself).

AN UNEVALUABLE CONDITION FAILS CLOSED — AT EVERY ENFORCEMENT LEVEL. "Condition FALSE" and "condition COULD NOT BE EVALUATED" are different things and are treated differently. A contributor whose CEL `condition` ERRORS (parse error, missing key, sandbox TIMEOUT) STILL SUPPLIES ITS CEILING, whether it was authored `advisory`, `recommended` or `required`. The admitted key set is therefore the UNION of, per name-group: - `contributingPolicyVersions` of groups with `fired === true` (the fired set), and - `conditionErrorPolicyVersions` of EVERY group (evaluate.ts) — the contributors that errored.

WHY THIS DELIBERATELY DIFFERS FROM evaluate.ts's require*-EFFECT SEMANTICS. There, `resolveFiredPolicies` fires a group closed ONLY when a contributor that is at least `required` errors (`requiredConditionEvalError`); an advisory/recommended contributor whose condition errors is annotated (`conditionError`) and does not fire. That carve-out is sound for require*-effects because dropping an ADVISORY `requireControls` only loses a WARNING — an advisory effect can never block, so nothing that would have failed now passes. It does NOT transfer to ceilings: a `scanThreshold` is applied by `scan-result-control` REGARDLESS of the enforcement level of the policy that authored it, so dropping an advisory ceiling converts a FAIL into a PASS. And a ceiling-only policy has no require* effect, which makes `advisory` the most natural — and most common — enforcement to author one at. Restricting the carve-out to `required` here would therefore be FAIL-OPEN on the most typical authoring shape.

PRECISE, NOT COARSE. Only the contributor that ACTUALLY ERRORED is re-admitted. A sibling contributor in the same name-group whose condition cleanly evaluated FALSE stays EXCLUDED — admitting a whole group because one of its members errored would reintroduce exactly the over-restriction (a false condition tightening a ceiling) this design removed.

The instance-scoped floors (platform / trust domain) carry no condition and are unaffected.

### §366. A `scanThreshold` effect on a policy document

A `scanThreshold` effect on a policy document — the org-and-below tiers' authoring surface (`effects: [{ scanThreshold: { maxHigh: 0 } }]`, validated by the policy JSON Schema updated in drizzle/0029). Deliberately NOT added to `policy-model.ts`'s `PolicyEffect` union: that union drives the gate's require/approve enforcement, and a scan ceiling is not an "unsatisfied effect" — it is an INPUT to a control's own verdict. `mergeContributorEffects` already ignores effect shapes it doesn't recognize, so existing enforcement is untouched.

### §367. The six-tier label for a graph object type

The six-tier label for a graph object type. Only used for EXPLAINABILITY (which tier set the ceiling) — never for precedence, because there is no precedence in a MIN. An object type outside the four org-and-below tiers is reported at the `component` (deepest) label with its real `objectTypeId` carried alongside, so the mapping stays auditable instead of silently lying.

THIS IS ONLY AS HONEST AS THE ANCHOR IT IS GIVEN. It reads `match.matchedAt.objectId`'s type, so a scope kind with no anchor of its own reports the tier of wherever it was parked. `scope.group`'s ACTING half parks at the org root (`typeId: "organization"`), so it is reported as `org` — which is the truthful answer for a ceiling that genuinely applies org-wide whenever a member acts. Its OWNING half (ADR-0016 §2a) anchors at the actually-owned object, so it reports that object's real tier. Before the owning half existed, EVERY group-scoped ceiling read `org` regardless of what it governed, quietly breaking ADR-0016 §5's promise that a block can show which tier set the floor.

### §368. The optional rung between a service and its components

M22.0 (ADR-0033 §5). The OPTIONAL rung between a service and its components (migration 0055). It shipped AFTER this function was written and fell through to `component` below, so an assembly-anchored ceiling enforced correctly and reported the WRONG tier — the same class of defect §2a fixed for group scope, at a rung added later. Nothing about the MERGE changes: `mergeScanThresholds` never reads a tier.

WALKING a rung is edge-generic and free (`containmentChain` matches on the `contains` edge, never on the parent's type, which is why 0055 shipped no resolver edit). NAMING one is not. If a third container level is ever added, every hardcoded rung list must be revisited — this switch and `APPROVAL_SCOPE_KEYWORDS` in gate-orchestrator.ts are the two that 0055 silently missed.

### §369. The merge: pure, order-independent, per-severity minimum

THE MERGE — pure, order-independent, per-severity MIN over the contributing tiers.

Extracted as a pure function (BUILD_AND_TEST.md §4.1: "anything testable as a pure function must be written as a pure function") so the order-independence property is unit-testable without a database, and integration-testable at the real gate.

### §370. The instance-scoped (above-org) floors

The instance-scoped (above-org) floors — `platform` + `trust_domain`, read through the ORDINARY tenant transaction under the table's tenant-read RLS policy. No privileged connection is needed to EVALUATE a gate (ADR-0016 §3's stated reason for preferring this over a privileged table).

NOTE (dated 2026-07-23, M17.5 follow-on): this reads BOTH `origin: 'local'` and `origin: 'federated'` rows uniformly — but no federation writer producing `origin: 'federated'` rows exists; only the operator PUT (routes/instance-scan-floors.ts) writes this table today. Under the 2026-07-23 D5 decision, outposts/retrans never evaluate scan policy (they validate the commander's signature, not requirements), so federated-origin floors are DORMANT until a genuine multi-commander distribution need exists. This resolution code is already correct for that future — nothing here needs to change when a federated writer eventually lands.

### §371. The policy keys admitted to set a ceiling: the union

The `(policyObjectId, policyVersion)` keys admitted to set a ceiling: the UNION of every contributor that actually FIRED and every contributor whose condition could NOT be evaluated, at ANY enforcement level (see the module doc's fail-closed section). A contributor whose condition cleanly evaluated FALSE is in neither set and can never set a ceiling.

### §372. Resolves the effective threshold across all six tiers

Resolves the effective scan threshold for a change's targets across all six tiers.

Returns `undefined` when NO tier contributes any ceiling — mirroring how the gate leaves `context.artifactDigest` unset rather than inventing one: the control then falls back to its own per-binding `config.threshold`, the documented M17.1 behaviour, unchanged.

### §373. The exclusion dimension, resolved beside the ceiling

M22.2 (ADR-0033 §1, §3, §4) — THE EXCLUSION DIMENSION, resolved beside the ceiling and sharing nothing with it but the tier vocabulary.

Everything below runs the OPPOSITE way from everything above, on purpose:

| | ceiling (ADR-0016, above)          | exclusion (ADR-0033, here)                        |
```text
| | per-severity MIN over a SET       | monotone AND down the TIER CHAIN                  |
| | a child may only TIGHTEN          | a clause needs admission from every tier above it  |
| | absent contributes nothing        | admission is EMPTY at every tier by default        |
| | union across targets is SAFE      | union across targets is an INVERSION — never done  |
| | an UNEVALUABLE condition FAILS    | an UNEVALUABLE condition yields NO exclusion       |
| |   CLOSED and still sets a ceiling |   (`ceilingContributorKeys` MUST NOT be reused)    |
```

With nothing authored anywhere, `resolveEffectiveScanExclusions` returns `undefined` and every downstream consumer behaves byte-identically to pre-M22.2. That is the property the suite pins first, because it is the one that makes the rest of this safe to ship.

### §374. The tiers that are REPRESENTED for this target

The tiers that are REPRESENTED for this target — `platform` and `trust_domain` always (they are facts about the deployment), plus every tier label present on this target's containment chain.

This is what keeps the AND from being vacuous in both directions. Requiring EVERY tier in `TIER_ORDER` to admit would make a clause unreachable for any org with no containment domain and no assembly — there would be nobody to speak for those rungs. Requiring only the tiers that happened to author something would be the fail-OPEN twin: a silent tier would be read as consent. So: a rung that EXISTS must say yes, and a rung that does not exist is not asked.

### §375. The tier of every object on this target's chain

M22.6 (D3) — the TIER of every object on this target's containment chain, by object id.

`representedTiers` answers "which rungs exist here"; this answers "which rung is THIS object", which is the question an override grant's derived authority needs and which no set of tier labels can answer. It is built from the SAME `containmentChain` walk that produced `representedTiers`, so a grant can never be placed at a rung the admission algebra did not see.

An id ABSENT from this map is not "unknown, assume component" — it is an object that is not an ancestor of this target at all, and `applyOverrideAuthorityBar` refuses it.

### §376. The conjunction: per target, then intersected across

THE AND — pure, order-independent, resolved PER TARGET and then INTERSECTED across targets.

A clause anchored at tier T has effect only if EVERY represented tier strictly above T admits its class. `platform` and `trust_domain` are always represented, so a deployment whose operator has inserted no admission row admits nothing at all and every clause beneath is inert — which is exactly the default this feature ships with.

WHY THE CROSS-TARGET COMPOSITION IS AN INTERSECTION, NOT A UNION. ADR-0033 §3 forbids unioning: for a CEILING more contributors can only tighten, so union is safe; for an EXCLUSION a union is an inversion — a clause admitted for one target would leak to its siblings, which is silent cross-component scope creep, and it would widen a LOOSENING past the reach of the BLOCKING it loosens (a failing scan verdict stops only that component from moving forward). One verdict is produced for one artifact across the change's whole target set, so the only composition that cannot leak is the one where every target independently admitted the clause. A single-target change — the overwhelmingly common shape — is unaffected either way.

A clause of a class whose PREDICATE is not yet built (`vendor_latest`, `declared_fact`, `approved_override`) still resolves here and is still admitted; it simply matches no finding (`scanExclusionClauseMatches` in `@scp/schemas`). Admission and application are separate questions and conflating them would hide one behind the other.

Returns `undefined` when NO clause survives — mirroring `resolveEffectiveScanThreshold`, so the conditional context key is simply absent and no evidence field appears.

### §377. The policy keys admitted to contribute an exclusion

The `(policyObjectId, policyVersion)` keys admitted to contribute an EXCLUSION: contributors of a group that FIRED, MINUS every contributor whose condition could not be evaluated.

DELIBERATELY NOT `ceilingContributorKeys`, and the two must never be merged. That helper UNIONS the errored contributors back IN, at every enforcement level, because dropping a CEILING converts a fail into a pass. Here the sign is reversed: ADMITTING a clause whose condition could not be evaluated IS the fail-open. ADR-0033 §4 states the requirement in exactly those terms — "the two dimensions need opposite error handling and must not share that helper".

The subtraction is not belt-and-braces. `resolveFiredPolicies` ADDS an errored REQUIRED contributor into `contributingPolicyVersions` (so a fail-closed group blocks and names what broke), so "fired contributors" alone would already carry an unevaluable contributor's effects.

### §378. The instance-scoped (above-org) ADMISSIONS

The instance-scoped (above-org) ADMISSIONS — the `platform` and `trust_domain` rungs of the AND.

Read through the ORDINARY tenant transaction under the table's tenant-read RLS policy, exactly as `readInstanceScanFloors` reads its own table, so no gate evaluation path needs the privileged connection. A DEPLOYMENT WITH NO ROWS ADMITS NOTHING, which is the shipped default: the table is created empty and never seeded (absent never means admitted).

### §379. The instant this whole evaluation is measured against

M22.4 — THE instant this whole evaluation is measured against: the vendor rule's freshness bound AND the override grants' expiry window, which are the same clock by construction rather than by convention (`resolveEffectiveScanExclusionsForTargets` resolves it once and threads it). Injectable for tests ONLY; every production caller omits it and gets one `new Date()`. It never enters a Decision or evidence — a timestamp in either would defeat write suppression (M22.0).

### §380. THE PER-TARGET GATHER

THE PER-TARGET GATHER — every input the pure AND consumes, built from the graph, for each target independently.

EXTRACTED IN M22.8, NOT REWRITTEN. `GET /components/{idOrUrn}/scan-requirements` has to answer "which exclusion classes are admitted here, and where would a clause have effect" — which is a question about ADMISSIONS and REPRESENTED TIERS, neither of which survives into `EffectiveScanExclusions` (that type carries only the clauses that already won). Rebuilding the gather in the read module would have produced a second construction of the AND's inputs, one edit away from the read surface and the gate disagreeing about what is admitted — which is the exact class of divergence M22.2 closed at `promotion-scan-step.ts`'s `firedPolicies: []`.

So there is ONE gather, and both consumers call it. `resolveEffectiveScanExclusionsForTargets` feeds it to the pure resolver and then attaches the per-class FACTS; the read surface feeds it to the same pure resolver and reads the admissions off it directly, resolving no facts.

### §381. M22.8 — WHICH TIERS ABOVE `tier` ARE REPRESENTED, top-down

M22.8 — WHICH TIERS ABOVE `tier` ARE REPRESENTED, top-down. The one place `TIER_ORDER` and `tierRank` are read from outside this module's own AND, so the read surface cannot drift into a second opinion about the chain's shape.

### §382. M22.6 (D3), THE DERIVED BAR

M22.6 (D3), THE DERIVED BAR — the tier an override grant must have been approved at-or-above, read off the RULE rather than off the request.

PURE, and the one place the bar is computed. The ceiling's `contributors` are the provenance M22.0 put into the gate Decision precisely so a block could name the tier that bound it; this is the second consumer of that provenance and the reason it had to be recorded rather than merged away.

THE MOST SENIOR CONTRIBUTOR WINS, not the one whose value happens to be the per-severity MIN. Excluding a finding removes it from the COUNT, which loosens EVERY ceiling on that severity at once — a count of 6 dropping to 5 satisfies a platform ceiling of 5 exactly as it satisfies the service ceiling of 0 that produced the block. Keying on the binding contributor alone would let a junior tier defeat a senior tier's ceiling indirectly, which is the escalation D3 exists to forbid.

THERE IS NO SUCH THING AS "NO CEILING", WHICH IS WHY THE BAR NEVER FALLS BELOW `org`.

This docblock used to say the opposite — that with no contributors the bar is `component`, i.e. no bar, because "there is no constraint stricter than the requester's own authority to escalate past, and the control falls back to its own per-binding `config.threshold`". That sentence names the counter-example in its own final clause and was wrong on both halves:

```text
* `config.threshold` IS a constraint. It is authored at the CONTROL object's scope
  (`routes/governance.ts`'s `PUT /controls/:idOrUrn/binding`, guarded by `policy:write` AT THE
  CONTROL), which is nowhere on the component's containment chain. A service- or component-scoped
  principal cannot author it and therefore must not be able to waive it.
* When neither a policy nor the binding config decides a severity, the plugin does not stop
  enforcing — it applies its historical fail-closed default of `maxCritical`/`maxHigh` = 0
  (`scan-result-control/src/index.ts`, `critical.value ?? 0`, and that module's own docblock says
  so). That is a PLATFORM-SHIPPED rule no tenant can edit at all.
```

Exclusions are applied BEFORE the counts are compared, so an approved grant on the only CRITICAL turns a fail into a pass against whichever of those ceilings is in force. With the bar at `component`, every candidate that merely sat on the chain cleared it — so a team lead holding a routine service-scoped `policy:write` could raise and approve a waiver against a ceiling they had no standing over. That is precisely the escalation D3 exists to forbid.

THE FLOOR IS `org` (owner decision, 2026-08-18), and it is a floor rather than the fully-derived answer on purpose. Deriving the true bar — injecting the binding config and the 0/0 default as synthetic contributors — was costed and REJECTED because it makes every grant inert on any deployment that authored no `scanThreshold` policy and no `config.threshold`, killing the feature outright for the common case. `org` is the most senior rung a TENANT can author at, so it is the strongest bar that still leaves the override usable: a component-, assembly-, service- or containment-domain-scoped grant can never clear it, while an org-tier grant keeps working.

WHAT THE FLOOR DOES NOT CLOSE, stated because a partial guard read as a total one is worse than none: an ORG-tier approver can still waive a `config.threshold` authored at control scope. Closing that requires the full derivation above and its cost. `platform`/`trust_domain` contributions still raise the bar past `org` normally — the floor only ever tightens the bottom, never loosens the top.

### §383. The lowest tier that may ever approve an override

The lowest tier that may ever approve an override, regardless of what the ceiling says.

`org` rather than `component`: see `requiredOverrideApprovalTier`. Named rather than inlined so the test that pins it and the code that applies it cannot drift apart.

### §384. Resolves the effective exclusion set across seven rungs

Resolves the effective exclusion set for a change's targets across all seven rungs.

Structurally parallel to `resolveEffectiveScanThreshold` and deliberately NOT folded into it: the two share the tier vocabulary and nothing else, and a single function computing both would be one edit away from letting a ceiling contributor admit an exclusion. It does CONSUME the ceiling — `approved_override` is measured against it (D3) — but only as an input it cannot change.

### §385. One instant for the whole evaluation, threaded always

ONE INSTANT FOR THE WHOLE EVALUATION, resolved here and threaded UNCONDITIONALLY. The previous shape forwarded `input.now` only when it was defined, which meant the shared clock existed only on the TEST path: in production `resolveVendorLatestFactsForTarget` took a `new Date()` of its own ONCE PER TARGET and `attachApprovedOverrides` took yet another, so a change with three targets measured the vendor freshness bound against four different instants and the override expiry window against a fifth. Harmless-looking and unfindable — the tests that assert "the same now" were the only callers for whom it was true. Both attach* functions now REQUIRE the instant (as does `resolveVendorLatestFactsForTarget`), so no future one can quietly re-acquire a clock.

### §386. Resolve the vendor facts, but only if a rule needs them

M22.4 (owner decision D1) — resolve the VENDOR FACTS, but only if a `vendor_latest` clause actually survived the AND.

TWO PHASES ON PURPOSE, and the order is the point. Phase one is the admission algebra, which is pure and cheap; phase two is an inventory read per target, which is neither. Resolving the facts unconditionally would put two joins per target on EVERY gate evaluation in the estate — including the overwhelming majority that have authored no exclusion at all, for whom M22.2's promise is that behaviour is byte-identical to pre-M22. So the facts are resolved only once a clause of that class has been admitted by every tier above it.

The facts are then INTERSECTED across targets, exactly like the clauses and for exactly the same reason (ADR-0033 §3): a fact is as much a loosening as a clause is, and one target's currency must never excuse a sibling's findings.

### §387. Resolve what the component declared, only if needed

M22.5 (owner decision D2) — resolve WHAT THE COMPONENT DECLARED, but only if a `declared_fact` clause actually survived the AND.

SAME TWO-PHASE SHAPE AS THE VENDOR FACTS, and for the same measured reason: the admission algebra is pure and cheap, a property read per target is not, and the overwhelming majority of deployments have authored no exclusion at all. M22.2's promise to them is that behaviour is byte-identical to pre-M22, and that promise is kept by not asking the question.

The facts are INTERSECTED across targets (ADR-0033 §3): a declaration is as much a loosening as a clause is, and one component's assertion must never excuse a sibling's findings.

### §388. Resolve the live override grants, only if needed

M22.6 (owner decisions D3/D4) — resolve the LIVE override grants, but only if an `approved_override` clause actually survived the AND.

THE EXPIRY IS APPLIED HERE, AT READ TIME, and this is the only place it is applied. `at` is the gate's own instant, so a grant that expired one second ago is simply not in the result — there is no status to have been flipped and no sweeper to have failed to run.

The gate-evaluation instant is the SAME one the vendor rule's freshness bound uses, and it is now PASSED IN rather than taken here. This docblock previously asserted that sameness while the code did `input.now ?? new Date()` locally and the vendor path did its own per target — so the claim held only under a test that injected `now`, which is why no test ever caught it. The instant is resolved once in `resolveEffectiveScanExclusionsForTargets` and is a required parameter here.

THE AUTHORITY BAR (D3) IS APPLIED HERE TOO, and it is applied PER TARGET before the intersection, never after. A grant's tier is derived from the containment chain of the target it excuses, and two targets have two different chains — the same `tierObjectId` can be an ancestor of one and a stranger to the other. Filtering after the intersection would let a grant that cleared the bar for target A excuse a finding on target B it has no standing over, which is the same cross-target leak ADR-0033 §3 forbids for clauses.

### §389. THE BAR IS RESOLVED HERE, NOT THREADED IN FROM THE CALLER

THE BAR IS RESOLVED HERE, NOT THREADED IN FROM THE CALLER — measured, not preferred.

The first version of this fix took the ceiling as a REQUIRED input field so TypeScript would force every gate site to supply it. Three sites supplied it, and the mutation run said what a type cannot: setting the commander producer's (`federation/promotion-scan-step.ts`) to `undefined` left the WHOLE suite green, because that producer has no override-grant coverage at all. A fourth site would inherit the same silence. So the resolver asks for itself, from the SAME `matches` and `firedPolicies` the exclusion dimension already resolved against — there is no longer a call site that can get this wrong, and `applyOverrideAuthorityBar` is reached by every caller of this function by construction. One deletion (this resolution) now kills a named test at every producer instead of one test per site.

IT COSTS NOTHING ON THE PATH THAT MATTERS. This runs only AFTER an `approved_override` clause has survived the AND — the same two-phase shape the vendor and declared facts use, for the same measured reason. A deployment that authored no override clause (the overwhelming majority, and every deployment before M22) pays not one extra query, and M22.2's promise that its behaviour is byte-identical to pre-M22 is kept. Where it does run, it repeats one indexed resolution the gate already did in the same transaction against identical inputs — deterministic by construction, because `matches` and `firedPolicies` are the caller's own.

## `apps/server/src/governance/scan-rule-authoring-guard.integration.test.ts`

### §390. A scan rule requiring no scan is refused at authoring

M22.8 — A SCAN RULE THAT REQUIRES NO SCAN IS REFUSED AT AUTHORING TIME (`governance/scan-rule-authoring-guard.ts`).

The refusal is only worth having if it is installed at the CHOKE POINT rather than at one route. ADR-0032 §6a's sibling shipped at the typed `/policies` route and a filterless census then found three more doors reaching `createObject` with a free-form `typeId` and free-form `properties`. G2 below plants the identical refused document through IaC apply, which is one of those three, and would go green against a route-only install — which is exactly why it exists.

WHAT THE REFUSAL DOES *NOT* CLAIM matters as much as what it does, and G5/G6 pin both edges: an unbound control is NOT proof that a policy is inert (bindings are a separate call and a refusal there would make authoring order-dependent), and an `admit`-only `scanExclusion` is an ADMISSION rather than a rule about a finding and is exempt.

## `apps/server/src/governance/scan-rule-authoring-guard.ts`

### §391. M22.8 (BUILD_AND_TEST.md §8 M22.8)

M22.8 (BUILD_AND_TEST.md §8 M22.8) — A SCAN RULE THAT REQUIRES NO SCAN IS REFUSED AT AUTHORING TIME.

TWO REFUSALS LIVE HERE, and the header below is about the first. The second (`assertDeclaredFactClauseIsNarrowed`) refuses a `declared_fact` clause that narrows nothing; it has its own docblock. They share this file because both are authoring-time refusals of a scan rule that says something other than what its author believes — one that constrains nothing, and one that constrains everything — and both are installed at the same two choke points for the same `federationImport` reasons.

THE MEASURED DEFAULT EXPERIENCE THIS ENDS
A first-time SecOps author writes the obvious document:

{"scope": {"objectRef": "<service>"}, "effects": [{"scanThreshold": {"maxHigh": 0}}]}

It is accepted, it is versioned, it appears in the policy list, and it constrains NOTHING.

BE PRECISE ABOUT WHERE, because the two gate sites differ and a guard whose stated reason is only half true is the provenance-label defect this repo has already paid for:

```text
- `prewarmGovernanceForChange` computes `allControlIds` from the fired set's `requireControls`
  and only then, INSIDE `if (allControlIds.length > 0)`, resolves the six-tier ceiling and the
  exclusion set at all. With no control required, neither is ever resolved on that path — the
  one whose run is CACHED and later read by the host-less accept edge.
- `evaluateGovernanceGate` resolves both UNCONDITIONALLY (M22.0 hoisted them out of the `host`
  ternary on purpose), so the ceiling does reach the Decision at a wave boundary. It still
  constrains nothing: no scan control is required, so no scan verdict is ever produced for the
  ceiling to be compared against or for a clause to act on.
```

Either way the rule does not bind, and the failure is FAIL-CLOSED in the narrow sense (nothing passes that would otherwise have failed — with no scan control there is no scan at all), which is exactly why it never surfaces as an incident. It surfaces as a rule that mysteriously does not fire, with no error, no log and no way for the author to discover why. That is the same harm `component-declaration-guard.ts` names for a misspelled declaration, and it gets the same remedy: refuse at the door, where a 400 costs one round-trip and leaves nobody with a false belief.

THE DOCUMENT MUST BE SELF-CONTAINED, AND THAT IS THE PRECISE CLAIM
The refusal does NOT claim "this ceiling can never apply". `resolveEffectiveScanThreshold` reads every matched policy, not just the one carrying `requireControls`, so a bare ceiling authored beside SOME OTHER policy that requires a scan control genuinely would apply. The refusal is narrower and stronger than that: a scan RULE must, in its own document, require the scan it constrains.

That is not tidiness. Depending on a sibling policy makes the constraint conditional on that sibling's continued existence, its scope still covering this target, and — worst — its own CEL condition still firing, because a group whose condition is false contributes no `requireControls` and `allControlIds` collapses to empty. The ceiling then evaporates for exactly the changes the sibling's condition excluded, silently. Requiring the document to carry its own requirement is what makes M22's stated invariant — "fail-closed universality survives: a missing scan still refuses exactly like a failed one" — a property of the rule rather than of the estate around it.

A LOCAL, DETERMINISTIC CHECK IS ALSO THE ONLY KIND THAT CAN LIVE AT A CHOKE POINT. A guard that consulted other policies would accept a document today and refuse the identical document tomorrow because an unrelated policy was deleted — and because the UPDATE half checks `nextProperties` (the value about to be STORED, see `objects-repo.ts`), that would make an untouched, already-valid policy un-editable as a side effect of somebody else's delete.

AN `admit`-ONLY `scanExclusion` IS EXEMPT, DELIBERATELY
`{"scanExclusion": {"admit": ["no_fix_available"]}}` is an ADMISSION — one rung of ADR-0033 §1's monotone AND stating that a class of loosening MAY have effect beneath it. It produces no verdict, constrains no scan, and is authored at the top of the chain (platform, trust domain, org) where naming a specific component's scan control would be meaningless. Refusing it would demand that every org-wide admission enumerate scan controls it has no business knowing about.

An `exclude` clause is the opposite: it is a rule about a finding in a scan, and a clause with no scan required is inert for the same reason a ceiling is. Both halves can ride in one effect, so the test is on `exclude`'s presence, never on the effect kind.

"NAMES NO SCAN CONTROL" — AND WHY AN UNBOUND CONTROL IS NOT PROOF OF ONE
Naming any control is not enough: `requireControls: ["<a webhook control>"]` makes `allControlIds` non-empty, so the ceiling resolves and lands in the Decision, and still no scan ever runs for it to constrain. So the check resolves the named controls' bindings and requires at least one bound to a scan-verdict module.

BUT AN ABSENT BINDING IS REFUSED FROM BEING EVIDENCE, in the same "a miss yields nothing" spirit ADR-0033 §1 applies to a matcher. A control object and its binding are two API calls; refusing a policy because the binding has not been created YET would make policy authoring order-dependent, and — through the `nextProperties` update rule again — would make an already-valid policy un-editable the moment somebody re-pointed or dropped a binding. So the refusal fires only when every named control is BOUND and none of them is bound to a scan-verdict module: exactly when the document can be PROVEN inert, never when it merely cannot be proven live.

### §392. The control plugin modules that produce a SCAN VERDICT

The control plugin modules that produce a SCAN VERDICT — the evidence a `scanThreshold` is compared against and a `scanExclusion` clause acts on.

CENSUS, not a guess: `plugin-host/subprocess-entry.ts`'s `loadPlugin` switch and `plugin-host/contract.ts`'s `PluginHostInstanceConfig["module"]` union are the authority on which modules exist, and `control-runner.ts`'s `KNOWN_CONTROL_MODULES` lists the three that are ControlPlugins (`webhook-control`, `scan-result-control`, `github-check`). Exactly one of the three emits `ScanEvidence`. `federation/promotion-scan-step.ts` is the OTHER verdict producer in the system and is deliberately absent: it is a server-side step, not a control binding, and no `requireControls` entry can ever name it.

If a second scan-verdict ControlPlugin is ever added, it belongs here — and the failure mode of forgetting is a FALSE REFUSAL (a legitimate policy rejected), which is loud, not a false accept.

### §393. True when this effect sets a ceiling the gate would read

True when this effect sets a ceiling the gate would actually read — the same test `scan-requirements.ts`'s `parseScanThresholdEffect` applies, expressed against the same schema so the two cannot drift into disagreeing about what a ceiling is. A malformed or empty `scanThreshold` contributes nothing to the MIN, so it is not a rule and is not refused here (it is already inert for a reason this guard does not own).

### §394. A `declared_fact` CLAUSE THAT NARROWS NOTHING IS REFUSED

A `declared_fact` CLAUSE THAT NARROWS NOTHING IS REFUSED — the write half of a pair whose read half is `declaredFactPredicate` in `@scp/schemas`.

THE SHAPE, AND WHY IT IS NOT MERELY BROAD
`{"scanExclusion": {"exclude": {"class": "declared_fact", "declaredFact": "egress", "declaredValue": "none"}}}` carries none of `vulnerabilityId`/`pkgName`/`purl`/`findingClass`. The class's predicate is finding-INDEPENDENT once the declaration holds — it has nothing about a finding to test — so with no narrowing matcher the clause excludes EVERY finding at EVERY severity for every target that declared the pair. It turns the scan gate off, and it reads like an exception.

ADMISSION CANNOT SEE IT, which is what makes this worth a door rather than a lint. ADR-0033 §1's AND is per CLASS: the tiers above consent to "`declared_fact` may be used beneath me", never to a particular clause, and they are not shown the clauses a lower tier subsequently writes. So one service-tier `policy:write` holder plus the component owner's own `object:write` on `properties.security` — the weaker permission ADR-0033 §6 names as the accepted seam — is the whole escalation. The seam is bounded by the CLAUSE's matchers; a clause with none has no bound.

WHY THE READ-TIME REFUSAL IS NOT ENOUGH ON ITS OWN, AND VICE VERSA
The predicate already returns `undefined` for this shape, so nothing is excluded even if such a clause is stored. That is the reach the door cannot have: a clause authored before this guard existed, or one arriving over federation import — which every guard at this choke point deliberately skips, because a throw on that path aborts a whole signed bundle and wedges the channel. Conversely the door is the reach the predicate cannot have: silently ignoring an authored rule leaves the author believing the exception is in force, which is the exact "rule that mysteriously does not fire" this module's header exists to end. Two halves, one property, neither redundant.

ONLY THIS CLASS. The property is "a class predicate that does not itself narrow per finding", and a filterless read of all four cases in `scanExclusionClassPredicate` finds exactly one: `no_fix_available` tests the finding's own `fixedVersion`; `vendor_latest` joins its class, purl, name and installed version against resolved facts; `approved_override` joins its `vulnerabilityId` against a specific grant. An unnarrowed clause of those three excludes what the class name says and no more — a reach an admitting tier CAN predict from the class alone. This one collapses to a constant, so it alone carries the extra requirement, and widening the refusal to all four would refuse the ordinary org-wide `{"class": "no_fix_available"}` that ADR-0033 §1 uses as its example.

PURE AND SYNCHRONOUS, unlike its neighbour: it reads only the document. That is why it is installed AHEAD of the awaited refusals at both choke points — a bad write must not pay for a round trip.

## `apps/server/src/governance/scan-vendor-exclusions.integration.test.ts`

### §395. M22.4 — THE VENDOR RULE AT THE REAL GATE

M22.4 — THE VENDOR RULE AT THE REAL GATE (ADR-0033, owner decision D1).

The arithmetic is pinned pure in `scan-vendor-latest.test.ts` and the predicate pure in `packages/schemas/src/scan-exclusion-classes.test.ts`. NEITHER can tell you whether the thing is INSTALLED, and this repo's dominant defect is a component built, tested green against itself, and called by nothing. So every test here drives the real lifecycle gate — real policy resolution, real instance admissions, real dependency inventory, real subprocess plugin host, real `scan-result-control` against a loopback Trivy-shaped result — and nothing below calls `resolveVendorLatestFactsForTarget`, `foldVendorLatestFacts` or `applyScanExclusions` directly.

WHAT MAKES THESE TESTS NON-VACUOUS: every one of them is a scan that WOULD FAIL. The default ceiling is the historical fail-closed 0/0, so a single HIGH blocks; a `pass` is therefore only reachable if the finding was genuinely removed before counting. Every finding the fixture emits also carries a `FixedVersion`, so `no_fix_available` — the one class that was already built — cannot be responsible for any pass here.

MUTATIONS RUN (2026-08-17), each measured and reverted by an exact inverse edit. Recorded in the increment report; nothing here is a prediction.

`scan_exclusion_admissions` rows are INSTANCE-scoped (no `org_id`) and the integration suite runs `singleFork` against one shared Postgres, so a leaked row would admit loosenings in every later suite. They are cleared in an `afterEach` that runs regardless of outcome, and again at teardown.

### §396. A scanner-shaped result with per-result class and identity

A Trivy-shaped result with PER-RESULT `Class` and per-entry `PkgIdentifier.PURL` — the two fields the vendor rule joins on and the reason this fixture cannot reuse M22.2's, which emits a single `os-pkgs` result and no purl at all.

`cls`/`pkg`/`purl`/`sev` are parallel comma lists; every entry carries a `FixedVersion` so no pass below can be attributed to `no_fix_available`. That isolation is about ADMISSION, not about the predicate: this suite admits only `vendor_latest`, so a `no_fix_available` clause never survives the AND anyway. `FixedVersion` itself does NOT disqualify a vendor pass — a fix in a newer major is exactly the case D1 excuses (owner decision, 2026-08-18).

### §397. Derived from the identifier rather than hardcoded

DERIVED FROM THE PURL rather than hardcoded, because M22.4's review round put the installed version INTO the join: the fact now says "this package is at head AT VERSION X", and the predicate requires the scanned artifact to actually carry X. A fixture pinning `1.0.0` while its purl said `@4.17.21` described an artifact that had DRIFTED from its manifest — which is precisely the case the join exists to refuse, so it would have made every lang-pkgs case here fail for the right reason and the wrong purpose. Falls back to `1.0.0` for the os-pkgs entries, which carry no purl and join on the base image digest instead.

### §398. THE PRODUCTION WRITE DOOR

THE PRODUCTION WRITE DOOR (M22.9). This used to `INSERT INTO scan_exclusion_admissions` over the admin pool, which made the suite green while the two instance rungs every clause requires — and that NO policy can ever contribute — had no writer outside these tests. The whole exclusion dimension was inert on a real deployment. It now goes through `PUT /api/v1/instance/scan-exclusion-admissions/{tier}` with the deployment operator token, exactly as an operator would; delete that route's registration in `app.ts` and every admitting test in this file dies. The PUT is a whole-set REPLACE, so this unions with what is already admitted rather than clobbering an earlier call in the same test.

### §399. Seed one component's inventory through the real verbs

Seed ONE component's dependency inventory through the real repo verbs, then set the observed head trio directly so the test controls `latest_observed_at`.

The trio is written by UPDATE rather than through `recordDependencyLineHead` for exactly one reason: that door stamps `new Date()`, and the staleness cases below need a timestamp in the past. Everything else — the line identity, the declaration — goes through the production verbs.

### §400. M22.8 — the authoring guard

M22.8 — the authoring guard (`governance/scan-rule-authoring-guard.ts`) refuses a `scanExclusion` rule that requires no scan control: such a document is silently inert, because the six-tier resolution is reached only inside `if (allControlIds.length > 0)`. `SCAN_RULE_TEST_CONTROL_REF` is a DANGLING reference on purpose — see that constant's own doc: a real bound control would add a control run and change what these tests measure.

### §401. DISTINCT COORDINATES, and this is not cosmetic

DISTINCT COORDINATES, and this is not cosmetic: `dependency_lines`' identity is `(org_id, ecosystem, coordinate, major)`, so two components in ONE org declaring the same image share ONE line row — and the second seed would overwrite the first's observed trio, silently turning the "never observed" case into a copy of the "stale" one. A mutation run (NULL read as "up to date") caught exactly that and survived this test until it was fixed.

(a) never observed — the shape an OUTPOST is always in, because `dependencyVersionPollRoleGuard` refuses to poll on anything that has not explicitly declared itself a commander, and `dependency_lines` does not federate.

## `apps/server/src/governance/scan-vendor-latest.test.ts`

### §402. The vendor rule's arithmetic, kept pure

M22.4 (ADR-0033, owner decision D1) — THE VENDOR RULE'S ARITHMETIC, pure.

Everything here is about the direction of a MISSING fact. A vendor-pass removes a finding before it is counted, so an absence read the wrong way does not produce an error, it produces a PASS — and the pass looks exactly like a component that really is current. Each `it` below is one of the absences ADR-0033 and the M22 definition of done enumerate, and each asserts the refusal by its NAME rather than by "not at head", so a future edit that collapses two refusals into one has to say so out loud.

MUTATIONS RUN — measured, each reverted by an exact inverse edit; recorded in the increment report.

## `apps/server/src/governance/scan-vendor-latest.ts`

### §403. Are we on the latest of this major line

M22.4 (ADR-0033, owner decision D1) — "ARE WE ON THE LATEST OF THIS MAJOR LINE?", resolved once against the ADR-0032 dependency inventory and handed to the pure matcher as data.

THE RULE
The owner's headline rule is that a vendor dependency is accepted only if the component is on the LATEST VERSION OF A MAJOR VERSION — no exceptions unless an override is created and approved (M22.6). "Latest of a major version" is not a new concept that needs a new store: it is exactly `dependency_lines`' identity `(org_id, ecosystem, coordinate, major)` plus its observed head, so this file is a READ over the existing inventory and adds no storage of its own.

WHY THIS FILE IS IN `governance/` AND NOT IN `dependencies/`
`dependencies/` owns the inventory: what a manifest declared, what an index answered, when a head moved and which write door may move it. This file OWNS NOTHING THERE. It reads two of that module's tables and reuses two of its pure functions (`lineAcceptsVersion` for "is this string a version on this line", `dependencyVersionPollIntervalSeconds` for the freshness bound) and writes nothing anywhere. It is a governance question asked of dependency data, so it lives beside the gate that asks it.

EVERY ABSENCE FAILS CLOSED, AND THAT LIST IS THE FEATURE
A vendor-pass is a LOOSENING: it removes a finding before it is counted. So the interesting cases are not the ones where it applies but the ones where it must not, and each is a distinct, named `VendorLineRefusal` rather than a fall-through:

1. NO INVENTORY ROW — the component declares nothing, or nothing on this line. Nothing to be at the head of. Handled by absence: the query returns no row and no key is emitted. 2. NULL `latest_version` — "not yet observed" is NEVER "no newer version exists" (migration 0061 says so on the column, and `scan_requirement_floors` established the same reading for its nullable ceilings). `head_not_observed`. 3. A STALE HEAD — see `vendorLatestStalenessBoundMs`. An observation from before the bound is a claim about a world that has since moved. `head_stale`. 4. AN OUTPOST — `dependencyVersionPollRoleGuard` (ADR-0032 §7c) refuses to poll on anything that has not explicitly declared `SCP_FEDERATION_ROLE=commander`, and `dependency_lines` is a per-domain projection that does not federate. So on an outpost the head was never observed LOCALLY and the columns are NULL — case 2, reached by data rather than by a role check here. That is deliberate: a second role predicate in this file would be a predicate to forget, and the poll's own module doc makes the same argument about its work-list. 5. AN `unresolved` OR `unpinned` `FROM` — `dockerfile.ts` records an ARG-interpolated reference as `unresolved` and a bare `FROM alpine` as `unpinned`, and neither carries a comparable version, so `placeDeclarationOnLine` refuses to mint a line for it at all. Case 1 again, by construction: there is no row to be at the head of. 6. A DIGEST-ONLY `FROM alpine@sha256:…` — pinned, but with no version string, so likewise no line. Case 1. 7. NO DEPENDENCY AUTOMATION AT ALL (owner decision D7) — no ingested manifests and no polled head, so no vendor-pass and the component upgrades manually. THE GATE IS DECOUPLED FROM AUTOMATION; THE DATA IS NOT. Nothing here widens ingestion or polling coverage to make the rule universally evaluable — that was considered at length and explicitly declined (ADR-0033 "Alternatives considered").

### §404. How many poll cycles an observation may be old

How many POLL CYCLES an observation may be old before it stops counting as evidence.

Three, not a wall-clock duration, and the difference is the whole point: the bound is DERIVED from `SCP_DEPENDENCY_VERSION_POLL_INTERVAL_SECONDS`, so an operator who slows the poll to weekly does not silently acquire a gate that refuses every vendor-pass, and one who speeds it to hourly gets a correspondingly tighter freshness requirement for free. A hardcoded "7 days" here would be a second, invisible configuration of the same thing — and the two would disagree the first time anybody changed either.

Three cycles tolerates one missed tick plus the run that noticed, without tolerating a poll that has been dead for a week.

### §405. The freshness bound, read from the live environment

The freshness bound, in milliseconds, read from the LIVE env on every resolution — the rule M14.4 established for every value that a re-scheduling loop can have changed underneath it.

NOT HARDCODED, BY REQUIREMENT. `dependencyVersionPollIntervalSeconds` is the single definition of how often a head can move, floor included; this is a multiple of it and has no number of its own except the cycle count above.

### §406. PURE — is this declaration at its line's head?

PURE — is this declaration at its line's head?

The two arms are genuinely different questions and are kept apart rather than unified behind a "compare the versions" helper:

- `oci` COMPARES `latest_digest`, NEVER THE TAG. An OCI index reports TAGS, and a tag is mutable: `3.19` names one set of bytes today and another next week, so two references agreeing on a tag is not evidence they are the same image. `dependency_lines.latest_digest` exists precisely because "a mutable tag is not an identity" (ADR-0032 §7), and it is recorded in the SAME observation as the version so the pair cannot be one that never existed. Comparing `resolved_version` to `latest_version` here would be comparing tags with extra steps and would pass a component sitting on a stale `3.19` that the registry has since repointed. - the four LANGUAGE ecosystems have immutable published versions, so the version IS the identity and the comparison is an ordering — through `lineAcceptsVersion`, the same door both inventory ingresses use, so "is `2.1.0` on the `2` line" means one thing in this tree.

A declaration AHEAD of the recorded head is accepted (`compareVersions` > 0): the component is not behind, and the poll simply has not caught up. Refusing there would fail a component for its own currency.

### §407. Pure: folds one target's rows into the matcher's facts

PURE — fold one target's inventory rows into the facts the matcher consumes.

TWO "ALL, NOT ANY" RULES, both fail-closed and both load-bearing:

1. THE BASE IMAGE. A multi-stage build declares several `oci` lines, and an `os-pkgs` finding names no image — Trivy reports the package, not which `FROM` it arrived on. There is no material to attribute it to one of them, so the pass requires EVERY declared base-image line to be at its head, and requires at least one to exist. "Any" would let a component with a current builder stage and a stale runtime stage excuse every OS finding in the runtime. 2. A LINE DECLARED FROM TWO MANIFESTS. `component_dependencies` is keyed by manifest path on purpose (one component can legitimately declare `lodash` from a root and a workspace `package.json`), so one line can have several rows at different versions. A key is emitted only if EVERY row for that line is at the head — one stale declaration is a real exposure and must not be voted away by a current sibling.

RULE 2 SAID THAT AND WAS FALSE ACROSS MAJORS UNTIL 2026-08-18, which is why the key now carries a version. "A line" is `(ecosystem, coordinate, MAJOR)`, and the emitted key carried no major and no version — so a component declaring `lodash@4.17.21` (at head of the `4` line) and `lodash@3.10.1` (behind head of the `3` line) emitted one `npm|lodash` from the current line, which then excused the stale one's findings. A current sibling voting away a stale declaration is exactly what the rule forbids; it was only ever enforced WITHIN one major. `vendorLatestPackageKey` now takes the version, so each at-head row contributes a key naming the version it is at, and a finding is excused only if the artifact SHIPS that version.

EVERY AT-HEAD ROW ON A LINE CONTRIBUTES ITS OWN KEY, not just the first one seen. Two rows on one line can both be at head at DIFFERENT versions — `evaluateVendorLineAtHead` accepts a declaration AHEAD of the recorded head, so `4.17.21` (== head) and `4.17.22` (poll not caught up) both pass. Keeping only the first row's key would make the emitted set depend on the order the join returned rows, which has no `ORDER BY`: a loosening decided by row order, and a Decision `inputContext` that differs between two identical evaluations (defeating `insertDecisionIfChanged`).

### §408. Read ONE target's declared inventory, joined to its lines

Read ONE target's declared inventory, joined to its lines.

One index descent on `component_dependencies`' primary-key prefix `(org_id, component_object_id)` plus the composite-key join — the same forward lookup `listComponentDependencies` takes. A target that is not a component (a service, an assembly) simply declares nothing and yields no rows, which is the correct answer rather than an error: `component_dependencies` is keyed by the COMPONENT's graph object id and nothing else has declarations.

### §409. AN UNRECOGNISED ECOSYSTEM IS DROPPED, not coerced

AN UNRECOGNISED ECOSYSTEM IS DROPPED, not coerced. The column is plain `text` with no CHECK, so a sixth ecosystem written by a future ingress (or by raw SQL) would otherwise arrive here as a string this file has no rule for. Dropping it means no key and no base-image credit — the fail-closed direction, and the same reading `readInstanceScanExclusionAdmissions` gives an unrecognised tier label.

### §410. Resolve one target's vendor facts

Resolve one target's vendor facts.

`now` IS REQUIRED, and the optional `now?: Date` it replaces is the reason. The caller (`scan-requirements.ts`) forwarded it only when defined, so on every PRODUCTION path this function fell back to a `new Date()` of its own — once PER TARGET, with the override-expiry window taking yet another instant. Only the TEST path passed one, so the shared-instant claim in the caller's docblock was true exactly where nothing depended on it and false everywhere it mattered: the vacuous-test shape (a fixture that silently never applied) this repo tracks as a recurring source. A required parameter makes the single instant a compile-time property rather than a convention, and it is contained — one production call site.

### §411. Pure: composes several targets' facts into one set

PURE — compose several targets' facts into the ONE set that describes the change.

AN INTERSECTION, NEVER A UNION, for exactly the reason ADR-0033 §3 forbids unioning CLAUSES: one verdict is produced for one artifact across a change's whole target set, and a fact admitted for one target that leaked onto a sibling would excuse findings on a component nobody said was current. `baseImageAtLatest` is therefore an AND and `packageKeys` a set intersection. A single-target change — the overwhelmingly common shape — is unaffected.

NO TARGETS yields `undefined`, not "everything": an intersection over an empty family is conventionally the universe, which here would be a vendor-pass for a change with nothing to be current about.

## `apps/server/src/governance/scanner-assignments.integration.test.ts`

### §412. M13.3a — the SCANNER-ASSIGNMENT REGISTRY end-to-end

M13.3a — the SCANNER-ASSIGNMENT REGISTRY end-to-end (ADR-0020 §2, proposal §13.3), against real Postgres under real RLS. The registry MIRRORS `scan_requirement_floors`' instance-scoped posture, so these assertions mirror the M17.5 suite's: operator PUT/GET round-trip, tenant read, and tenant-write refusal driven through a REAL tenant transaction (`scp_app`, NOBYPASSRLS) — not a mock. The last test proves the schema `scanner` widening left the E6 gate fixture parse unchanged.

## `apps/server/src/governance/scanner-registry.test.ts`

### §413. M13.3a — `resolveScannersForType` unit tests

M13.3a — `resolveScannersForType` unit tests (ADR-0020 §2). The table read is driven through a STUB `tx` returning canned rows, so the resolution/parsing behaviour is testable without a database (the real seeded-table read is proven in the integration suite). What matters here is the mapping from a stored `methods` jsonb to the returned `ScanMethod[]`, and the fail-closed `[]` meanings.

## `apps/server/src/governance/scanner-registry.ts`

### §414. M13.3a — SCANNER-ASSIGNMENT RESOLUTION

M13.3a — SCANNER-ASSIGNMENT RESOLUTION (ADR-0020 §2, proposal §13.3).

The commander's promotion scan step (Build B — not here) resolves, for an artifact's executor Type, WHICH managed scan method(s) to run. This module is that resolution, and ONLY that: given a Type, return the assigned `ScanMethod[]`. It reads the instance-scoped `scanner_assignments` table through the ORDINARY tenant transaction under the table's tenant-read RLS policy — no privileged connection is needed to RESOLVE an assignment, mirroring `readInstanceScanFloors` (scan-requirements.ts) exactly (the assignments are instance-global config, no `org_id`, so there is no org context to thread).

EMPTY / UNKNOWN TYPE -> `[]`, WITH A CLEAR MEANING. A Type with no row, an all-`[]` row, or a Type outside the closed `ExecutorType` set all resolve to `[]`. `[]` means "no managed scanner for this Type" — the promotion scan step produces NO managed evidence, so E6 refuses that Type's cross-boundary promotion unless valid org-pipeline evidence already covers the digest. This is FAIL-CLOSED by design (proposal §13.3), never a silent pass: an unassigned Type cannot promote on managed evidence, because there is none.

The stored `methods` jsonb is validated on the way OUT (not trusted blindly): any element that is not a valid `ScanMethod` is dropped, so a hand-edited or version-skewed row can never hand the scan step a method it cannot run. A malformed row degrades to fewer methods (or none) — never to a throw and never to an invented method.

### §415. The managed scan methods assigned to `executorType`, or `[]`

The managed scan methods assigned to `executorType`, or `[]` (no managed scanner — see the module doc). `executorType` is typed `string` (not `ExecutorType`) on purpose: the caller resolves it from an artifact/binding at runtime, and an unknown value must resolve cleanly to `[]` rather than being a type error — the fail-closed meaning is identical whether the Type is unknown or merely unassigned.

## `apps/server/src/governance/scoped-scan-requirements.integration.test.ts`

### §416. M17.5 — SCOPED SCAN-REQUIREMENT POLICIES

M17.5 — SCOPED SCAN-REQUIREMENT POLICIES (ADR-0016), the BUILD_AND_TEST.md §8 M17 "Integration (scoped scan)" definition of done, proven at the REAL gate against real Postgres.

Every assertion here is end-to-end through the public API and the real governance gate: a real `policy` graph object, the real `matchPoliciesForTargets`/`containmentChain` walk, the real instance-scoped floor table under real RLS, the real subprocess plugin host running the real `scan-result-control` against a real (loopback) Trivy-shaped result. Nothing here asserts on a hand-built merge input — the merged ceiling is read back out of the CONTROL RUN EVIDENCE the gate actually persisted, which is the only place a tautology could not hide.

The six tiers, top-down:

platform -> trust domain (partition) -> org -> containment domain -> service -> component

...plus the OPTIONAL `assembly` rung between service and component (migration 0055; named as a tier by M22.0 / ADR-0033 §5, pinned by test (a2) below). It is optional in the sense the others are not — most chains have no assembly at all — which is why the list above is still "the six tiers" and why every test that does not care about it uses the four-rung `buildChain` default.

TWO SENSES OF "DOMAIN": `trust_domain` is the ambient federation boundary ABOVE org (an instance-scoped floor row, no `org_id`); `containment_domain` is the intra-org `domain` OBJECT TYPE BELOW org (an ordinary graph node). The fixture below builds BOTH, in the same chain, so the two can be told apart in the resolved contributor list rather than taken on faith.

### §417. Disambiguated: what the previous lookup could not tell

M22.0a — DISAMBIGUATED. This used to be `.find(r => r.controlObjectId === controlId)`, which was unambiguous only while a control could produce at most ONE run per change. Since the control-run cache is keyed on gate identity (`latestControlRunForGate`), a single change can now hold a `lifecycle_edge` run AND a `wave_boundary` run for the same control — and `.find()` silently returned whichever row the listing happened to put first.

Every assertion in this file still passed under the old form, because both runs resolve the same ceiling from the same policies and their evidence agrees. That is exactly why it was worth fixing BEFORE it mattered: the first test whose two runs legitimately DIFFER would have gone green or red on listing order. Now the caller gets the NEWEST matching run rather than an arbitrary one.

IT CAN NOW NAME THE GATE IT MEANS — M22.8 closed the gap this comment used to record. `controlRuns.listForChange` (and `/changes/{id}/explain`, the other projection of the same shape) carry `gateKind` and `gateRef` as additive optional response fields, so an operator reading the API can finally tell which crossing a given run authorized rather than inferring it from ordering. This helper is deliberately left filtering on control + status: its callers want "the newest run of this control in this state", and narrowing it to one crossing would change what every existing assertion in this file means. `scan-requirements-read.integration.test.ts` is where the projection itself is pinned.

### §418. `scan_requirement_floors` is INSTANCE-GLOBAL

`scan_requirement_floors` is INSTANCE-GLOBAL (no `org_id`) and the integration suite runs `singleFork` against ONE shared Postgres, so a live floor left behind here (e.g. platform maxHigh = 0) would silently tighten EVERY later suite's gates — notably M17.1's supply-chain scan tests. Each test sets exactly the floors it needs, but a test that FAILS mid-way never reaches the next one's `setInstanceFloors`, so clearing must happen in a hook that runs regardless of outcome. Both rows are reset to all-NULL (inert) after every test AND once more at teardown, so this file is self-contained no matter where it fails.

### §419. The full containment chain, with the component reachable

org root -> containment domain -> service -> component, with the component reachable from BOTH the service (`contains`) and the org root (its own `domain_id`) — the real four-tier chain the org-and-below resolver walks.

`withAssembly` inserts the OPTIONAL rung migration 0055 added, giving `org -> containment domain -> service -> ASSEMBLY -> component`. The component then hangs off the assembly rather than the service, so the service is reached only by continuing up through the assembly — which is what makes the two tiers separable in the contributor list below. Only ONE assembly rung is built because `assembly -> assembly` is refused at write time (`relationships-repo.ts`; migration 0054's header), so this is the deepest legal ladder.

### §420. M22.8 — the authoring guard

M22.8 — the authoring guard (`governance/scan-rule-authoring-guard.ts`) refuses a `scanThreshold` rule that requires no scan control: such a document is silently inert, because the six-tier resolution is reached only inside `if (allControlIds.length > 0)`. `SCAN_RULE_TEST_CONTROL_REF` is a DANGLING reference on purpose — see that constant's own doc: a real bound control would add a control run and change what these tests measure.

### §421. THE ASSERTION: per-severity MIN across all six tiers

THE ASSERTION: per-severity MIN across all six tiers. maxCritical: platform 90, containment-domain 60, service 5            -> 5 maxHigh:     platform 90, trust-domain 80, service 50, component 4    -> 4 maxMedium:   platform 90, trust-domain 80, org 7                      -> 7 maxLow:      platform 90, trust-domain 80, org 70, containment-dom 6   -> 6

### §422. (a2) THE ASSEMBLY RUNG

(a2) THE ASSEMBLY RUNG (M22.0, ADR-0033 §5). Migration 0055 added the OPTIONAL `service -> assembly -> component` level. `containmentChain` walks it for free (it matches on the `contains` EDGE, never on the parent's TYPE), so an assembly-anchored ceiling has always ENFORCED correctly — the merge is an order-independent per-severity MIN that never reads a tier label. But `tierForObjectType` is a HARDCODED rung list, and until M22.0 it fell `assembly` through to `component`: the ceiling bound, and the Decision named the wrong tier, breaking ADR-0016 §5's promise that a block can say which tier bound it.

```text
   THE TWO ARMS ARE DELIBERATELY SPLIT, and the contrast is the point:
     * ENFORCEMENT — the assembly's maxHigh: 0 really does tighten the org's 5 and fail the
       run. Reverting `case "assembly"` leaves this GREEN, because the merge never reads a
       tier. A test that asserted only this would be green for the wrong reason.
     * THE LABEL — the persisted contributor names tier `assembly`. Reverting `case
       "assembly"` turns it into `component` and ONLY this arm goes red.
```

```text
   A LOOSE `service` FLOOR IS AUTHORED ALONGSIDE so the assertion also rules out the other
   plausible mislabel (reporting the assembly at its parent's tier): three contributors, three
   distinct labels, one of which can only come from the new switch case.
```

```text
   MUTATION-PROVEN (measured 2026-08-17): reverting `case "assembly"` in `tierForObjectType`
   fails ONLY the label arm — `expected 'component' to be 'assembly'` — while the enforcement
   arm above it stays green and the run still fails at maxHigh 0. That contrast is the result,
   not a side effect of it.
```

### §423. A conditional policy contributes only when it fires

(b2) A CONDITIONAL scan-requirement policy contributes its ceiling ONLY when its condition fired — the same condition semantics `requireControls`/`requireApprovals` already have. Both arms are identical but for the condition string, and both run at the REAL gate.

### §424. The same fixture, but the condition cannot be evaluated

ARM 3 — the SAME fixture, ADVISORY enforcement, but the condition cannot be EVALUATED (it references a label the component does not carry, so cel-js errors). "Condition FALSE" and "condition UNEVALUABLE" are different: a false condition drops the ceiling (ARM 1), but an UNEVALUABLE one must FAIL CLOSED and still supply its ceiling — at EVERY enforcement level, advisory included. A scan ceiling is applied by scan-result-control regardless of the authoring policy's enforcement, so silently dropping it would flip this FAIL to a PASS (the fail-open regression this arm pins). `scanFloorPolicy` authors `advisory` by default.

### §425. Precision: only the contributor that errored is readmitted

(b3) PRECISION: an UNEVALUABLE condition re-admits ONLY the contributor that errored — a SIBLING in the same name-group whose condition cleanly evaluated FALSE stays EXCLUDED. This guards the fail-closed carve-out from over-correcting back into the over-restriction the FIRED-set change removed (a cleanly-false ceiling must never tighten).

### §426. One name group with two contributors on the component

ONE name-group ("floor-multi") with TWO contributors on the component: - the ERRORED one carries a LOOSER ceiling (maxHigh: 5) and an unevaluable condition, - the cleanly-FALSE sibling carries a TIGHTER ceiling (maxHigh: 0) and condition `1 == 2`. If the fix over-admitted the whole group, the sibling's 0 would win the MIN and BLOCK. It must not: only the errored contributor's 5 may apply, so two HIGHs PASS at an effective 5.

### §427. MIN over the whole set, regardless of visit order

MIN over the whole set, regardless of visit order: maxCritical: platform 3, org 7, service 1        -> 1 maxHigh:     platform 9, trust 2, dom 6, comp 9  -> 2 maxMedium:   trust 8, org 4, comp 3              -> 3 maxLow:      dom 5, service 9                    -> 5

## `apps/server/src/governance/service-policy-scope.integration.test.ts`

### §428. Service-scoped policy, with the authz half elsewhere

Service-scoped POLICY (model P2 — the authz half lives in authz/service-scope.integration.test.ts).

This file's counterpart header, and DESIGN §10.1, have always said resolution walks `org -> domain -> service -> component`. It didn't: `containmentChain` walked `objects.domain_id` only, and components/services are siblings under a domain — so a service-scoped policy governed NOTHING. Migration 0021's `contains` edge plus the two-route walk is what makes the documented behaviour real, and this is the test that says so.

The precedence case is the subtle one. With two routes the chain is a DAG, not a line: a component's domain is reachable BOTH directly (component.domain_id) and via its service (service.domain_id), at different depths. policy-model.ts sorts by depth DESC (deepest = most specific wins), so picking the wrong depth for the domain would let a domain-scoped policy outrank a service-scoped one — silently, and only for components that have a service.

### §429. Documented in containmentChain

Documented in containmentChain: if C.domain_id != S.domain_id, then C's own domain and its service are each exactly ONE hop from C and are structurally equidistant — max-depth cannot separate them. Pinned here so the behaviour is a known, tested fact rather than a surprise.

INERT today: policy-model.ts groups by policy NAME and merges order-independently, using depth only to order a display-only `contributors` array — so a tie changes no outcome. If this test ever starts mattering for enforcement, containmentChain's depth model needs fixing first.

## `apps/server/src/governance/test-support/conditional-hang-cel-worker-entry.ts`

### §430. A worker that hangs on a sentinel and evaluates the rest

Test-only worker entry that HANGS on the sentinel expression `"__HANG__"` but evaluates every other expression normally via `cel-js`. Unlike `hanging-cel-worker-entry.ts` (which hangs on ANY message, so a respawned worker hangs again), this lets `cel-sandbox.test.ts` prove that the SAME sandbox instance recovers after a timeout: the first call hangs and is terminated, and a subsequent NON-sentinel call against the respawned worker succeeds (MINOR (b) — the pre-fix timeout test only ever proved recovery via a brand-new sandbox, never that a wedged pool healed).

## `apps/server/src/governance/test-support/hanging-cel-worker-entry.ts`

### §431. A worker that receives messages but never responds

Test-only worker entry that receives messages but never responds — lets `cel-sandbox.test.ts` exercise `CelSandbox`'s hard-timeout/terminate path deterministically, without depending on being able to construct a genuinely slow real CEL expression (cel-js has no loop/sleep construct to hang itself with, by design — see cel-sandbox.test.ts's comment).

## `apps/server/src/governance/test-support/scan-rule-control.ts`

### §432. TEST SUPPORT for M22.8's authoring refusal

TEST SUPPORT for M22.8's authoring refusal (`governance/scan-rule-authoring-guard.ts`).

A `scanThreshold` or `scanExclusion.exclude` policy must now name, IN ITS OWN DOCUMENT, a control bound to a scan-verdict plugin — because a scan rule that requires no scan is silently inert (`prewarmGovernanceForChange` reaches the six-tier resolution only inside `if (allControlIds.length > 0)`, and with no scan required there is no verdict to constrain).

Every M22 suite authored its ceilings and clauses as bare effect documents, which is exactly the shape the guard refuses. This constant is what those suites name instead.

WHY A DANGLING REFERENCE RATHER THAN A REAL BOUND CONTROL — measured, not preferred
The first attempt had each suite's policy helper find-or-create a REAL control bound to `scan-result-control`. It failed two tests, and both failures are the reason this file exists:

1. `scan-exclusions` asserts a change holds EXACTLY ONE `control_runs` row. A second scan control — created because the ceiling policy is authored BEFORE the suite creates its own control — produces a second run, and the assertion is about the M22.0a cache key, not about controls. 2. `scoped-scan-requirements` (b) began failing its accept edge, because a second bound control genuinely runs and genuinely participates in the gate.

In other words: attaching a real control to make an unrelated test's POLICY legal changes what that test measures. A dangling reference does not. `ensureControlRun` refuses a non-uuid `requireControls` entry BEFORE it touches the database and writes NO `control_runs` row for it, so naming this adds no run, no plugin call and no control object; and every helper that names it authors at `advisory` enforcement, which can never block a gate.

The guard reads an unresolvable entry as "cannot be PROVEN inert" and passes — its documented sign, and the same one an unbound control gets. That is a REAL branch of the guard, not a loophole: `scan-rule-authoring-guard.integration.test.ts` G5 pins it deliberately, and G3/G4 pin the bound-control branches against genuinely bound controls.

This is also the form `group-scope-ownership.integration.test.ts` already used for its `requireControls` effects before M22.8 existed, so it is the established shape for a suite that exercises resolution rather than execution.
