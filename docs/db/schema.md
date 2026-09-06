# schema

Reference for `apps/server/src/db/schema.ts`. The source carries a one-line headline at each site and points here.

> Partial: 28 of 117 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. M1 Graph Core schema (DESIGN.md §4.1-§4.3, §7, §8)

M1 Graph Core schema (DESIGN.md §4.1-§4.3, §7, §8). Supersedes M0's minimal `objects` table with the full generic graph model: object_types/relationship_types (runtime type registry), objects/relationships (the graph itself, federation-ready provenance columns, optimistic concurrency, soft delete), roles/role_bindings (RBAC), audit_events (hash-chained append-only log), outbox (transactional outbox feeding pg-boss + SSE), and idempotency_keys (Idempotency-Key replay per DESIGN.md §6).

RLS policies, the `scp_app` least-privileged role, built-in type/role seed rows, and the outbox NOTIFY trigger are hand-authored SQL (drizzle-kit cannot express them) — see drizzle/0002_rls_rbac_seed.sql.

## §2. M20.7 (ADR-0031 §6c) — WHY this object is domain-local

M20.7 (ADR-0031 §6c) — WHY this object is domain-local. The container it INHERITED locality from at create (M20.5/§6a), or NULL when an operator DECLARED it, or when it is not domain-local at all. Those three states are exhaustive and need no discriminator column.

HISTORICAL, deliberately: it records the container as it was at create and is never updated to follow it, so after §6b's publish-container-then-child flow a still-local child legitimately points at a container that has since become shared. That is the true answer to "how did this become domain-local", not staleness. Re-deriving it live would need the containment walk §6a exists to avoid.

No FK: losing the provenance because its source was tombstoned would be worse than a dangling id, which readers render as "inherited, source no longer present". The URN is denormalized alongside the id because `objects.urn` is IMMUTABLE (`updateObject` writes `urn: existing.urn`), so it cannot drift — and it is accepted anywhere an id is, which means a badge can render "inherited from secure-partition" and link to it with NO lookup. `name` is deliberately absent: it IS mutable, and the urn's last segment is the name as at create, which for historical provenance is the more honest label.

## §3. drizzle/0097 — object type ids this role may be bound at

drizzle/0097 — object type ids this role may be bound at. NULL = ANY scope, which is what the five built-in ladder rows carry and must keep carrying (their live bindings predate the column).

**ENFORCED SINCE role-model.md §5 step 5** — `authz/role-binding-door.ts`'s `assertRoleBindableAtScope`, called by `POST /api/v1/role-bindings`. GRANT ONLY: a revoke deliberately does not re-check it, or every binding already written at a nonsensical scope would become permanent, and cleaning those up is half the reason the column exists.

THE DATABASE STILL ENFORCES NOTHING and that is unchanged: `scope_object_id` is a bare `uuid NOT NULL REFERENCES objects(id)` with no type constraint, so a row written by hand SQL or restored from a dump can still point at a `user` or a `change`. Such a binding is inert — until `objects.domain_id`, which carries no type constraint either, parents something under it and it suddenly confers authority (role-model.md §1.3h). The door is the only layer that sees this, which is why the check is at the door and not here.

## §4. drizzle/0097 — the NATURAL KEY of a grant

drizzle/0097 — the NATURAL KEY of a grant. Without it a write door creates duplicate grants that are individually revocable and COLLECTIVELY still granting: revoke one, the other still grants, and the revoke reports success. That is why this lands BEFORE the role-binding API, not with it.

## §5. THE RECONCILE ROUND-ROBIN CURSOR

THE RECONCILE ROUND-ROBIN CURSOR (migration 0056) — engine scheduling state, and the ONLY column `listChangeRowsInStates` orders by. "When did the engine last take this change's turn", which is a queue position and NOT a fact about the change.

It exists because `updated_at` used to carry both meanings at once. The engine serves `ORDER BY <cursor> ASC LIMIT BATCH_LIMIT`, and five reconcile paths re-stamp a change they examined but could NOT advance so it goes to the back of the queue — without that, >BATCH_LIMIT stuck changes own every batch slot forever and everything behind them is never evaluated even once (measured: 13 days of stopped production coordination behind green health checks, homelab 2026-08-01 — see reconcile.ts's gate-blocked bump). Sharing `updated_at` for that made the API-visible `Change.updatedAt` read "1s ago" for a change that had done nothing for three days.

THE SPLIT IS STARVATION-SAFE BY DIRECTION, which is the property to check when touching this. The guarantee needs the not-advanced paths to push a change BACKWARD in the queue; every other write that used to move `updated_at` incidentally (a transition, a `source_ref` stamp, a park) now leaves the cursor alone, which can only make a change be served SOONER. Nothing that could delay a change was removed.

DELIBERATELY UN-INDEXED. `changes_org_state` already narrows the candidate set to one org and state; adding a btree on this column would defeat HOT updates for the per-tick bump — index churn on exactly the write that fires most often (ADR-0024's cost lesson, one write class over). `updated_at`, which this replaces in the ORDER BY, was never indexed either.

NOT ON THE WIRE, like `reconcile_blocked_at` beside it. See `Change`'s `updatedAt` docblock in `@scp/schemas` for the reasoning.

## §6. Decision records (DESIGN §10.4) — the explainability funnel

Decision records (DESIGN §10.4) — the explainability funnel. Every engine verdict (lifecycle transition, gate check, watchdog flag, rollback trigger, plan compile) persists exactly one of these with its full input context and a structured reason tree, independent of whether the verdict allowed or blocked anything.

## §7. M4 Governance Engine (DESIGN.md §10, BUILD_AND_TEST.md §8 M4)

M4 Governance Engine (DESIGN.md §10, BUILD_AND_TEST.md §8 M4). Hand-authored grants/RLS in drizzle/0010_governance.sql (same pattern as 0002/0005/0007). Policies and Controls themselves are NOT new tables — they are graph objects of the pre-seeded `policy`/`control` types (0002 §5), managed through typed-registry endpoints exactly like `release-topology` (0007 §9): the document lives in `objects.properties`, and the document's own version is `objects.version` (bumped on every update) — the same pinning pattern `change_plans.topology_version` already uses. What DOES need new projection tables is everything with real lifecycle/quorum state that the graph's generic model has no place for: control run evidence, approval quorum, and freezes.

THAT LAST CLAUSE WAS NARROWED BY OWNER DECISION D6 (M25.7, ADR-0043) — READ BOTH HALVES
It used to be flat: a freeze was not a graph object and never could be, and this line is the PRIMARY SOURCE the rest of the codebase cited for that — `drizzle/0089` and `governance/freeze-object.ts` both quote it by line number. Left as it stood it would keep asserting, from the file the citations point at, exactly what the citations say was retracted.

THE DISTINCTION THAT SURVIVES, and it is a real one rather than a hedge:

```text
* A freeze's ENFORCEMENT STATE still has no place in the generic object model. The window
  predicate `starts_at <= at < ends_at AND lifted_at IS NULL` is evaluated on a hot gate path
  by `activeFreezesInWindow` — the single owner of that comparison — and re-expressing it as
  jsonb comparisons would put a second copy of it in the system. That is why `freezes` (below)
  STAYS, unchanged, and why every reader that BLOCKS still reads it.
* A freeze's WIRE FORM is now a `freeze` graph object (drizzle/0089), for one reason: nothing
  table-shaped can cross a security boundary. `JournalEntryKindSchema` admits nine kinds and
  none is freeze-shaped, and widening it is both an oasdiff response break and a fail-closed
  cliff at an un-upgraded peer — so an object on the existing `object_upsert` is the only
  route a freeze has. `federation/import-repo.ts` rebuilds the projection row from it at the
  receiving instance, which is what makes an imported freeze actually block.
```

So: object PLUS projection (the pattern `changes` and `campaigns` already use), opt-in per freeze (`freezes.object_id IS NULL` is the default and the whole pre-M25.7 estate), and org tier only — `instance_freezes` (drizzle/0086) has no `org_id` and does not federate under any decision (ADR-0040). Control run evidence and approval quorum are untouched by D6: both clauses above still hold for them flatly.

## §8. 0065 — the composite-FK target for `scan_findings`

0065 — the composite-FK target for `scan_findings`. `id` is already the primary key, so this adds no new uniqueness; it exists so a `(org_id, control_run_id)` foreign key has something to reference, which is what makes "a finding cannot point at another org's scan" a STRUCTURAL barrier rather than a repo-layer habit (0061 could not do this for its `objects(id)` references and says so).

## §9. M5 Campaigns (DESIGN.md §9.5, BUILD_AND_TEST.md §8 M5)

M5 Campaigns (DESIGN.md §9.5, BUILD_AND_TEST.md §8 M5). Hand-authored grants/RLS/seed data in drizzle/0011_campaigns.sql (same pattern as 0002/0005/0007/0010).

KEY DESIGN DECISION (documented at length in 0011's own header): a Campaign is NOT a second transition-guarded state machine. `campaign` is a graph object (pre-seeded built-in types, 0002 §5); what they need beyond the generic object model is exactly what a Change needed — a compiled plan -> waves -> wave_targets shape, over the SAME `coordination/plan-compiler.ts` pure function `change_plans`/`change_waves`/ `change_wave_targets` already use. `campaign_wave_targets` differs in one way: its unit of work is an entire real M3 Change (`memberChangeObjectId`), not a direct executor trigger — see `coordination/campaign-reconcile.ts`. Campaign STATUS is a pure derived aggregation (`coordination/campaign-status.ts`), never a stored column here.

## §10. M6 Federation (DESIGN.md §13, BUILD_AND_TEST.md §8 M6)

M6 Federation (DESIGN.md §13, BUILD_AND_TEST.md §8 M6). Hand-authored grants/RLS in drizzle/0012_federation.sql (same pattern as 0002/0007/0010/0011).

SCOPING DECISION (M6 PR body): DESIGN.md's federation "domain" means a whole SCP instance (a Domain Control Plane) — a different concept from the pre-existing `domain` OBJECT TYPE (an org-internal containment node under which services/components live). This schema keeps federation identity/peers/journal ORG-SCOPED (one federation self-identity + peer set per org, same `org_isolation` RLS every other tenant table gets), because the sync journal is derived from the per-org outbox/audit stream and every row it carries (`objects`/`relationships`/ `changes`/policy/approval rows) is already org_id-scoped end to end. Per the charter ("MSPs needing hard isolation run one instance per customer"), one org per instance is the expected shape, so this collapses to one federation domain per instance in practice — nothing in the M6 DoD depends on the distinction. The Ed25519 key that SIGNS journal segments/bundles is the SAME key `governance/attestation.ts`'s `ensureInstanceKey` already manages for approval attestations — as of M6 that table (`instanceKeys`, above) is ALSO org-scoped, for exactly this reason, so "one Ed25519 identity signs both approval attestations and federation material" (DESIGN §13: "SCP performs all signing and validation itself") holds at the org-as-domain granularity this schema uses throughout.

## §11. M14.1 (ADR-0009, drizzle/0037) — per-peer poke-mode

M14.1 (ADR-0009, drizzle/0037) — per-peer poke-mode. NOT NULL DEFAULT false: default-off, so every existing peer migrates as a no-op poll-mode peer. `true` means the commander MAY send this peer a contentless wake signal and its frequent poll is disabled (full enforcement is M14.4); the M14.1 pair-time guard requires an https/mTLS-capable `baseUrl` before it can be set true. Plain boolean column (not jsonb) — a two-state switch, not registry-shaped data.

## §12. ONE-SHOT RE-ANCHOR PERMIT

ONE-SHOT RE-ANCHOR PERMIT (drizzle/0042) — SECURITY-SENSITIVE, and deliberately writable only from a LOCAL, AUTHENTICATED OPERATOR ACTION that declares this peer's own `sync_scope`: today `pairPeer` (`POST /v1/federation/peers`) and `updatePeerTransport` (`PATCH /v1/federation/peers/{id}`, M16.2 phase A E4 — which re-applies this guard precisely so widening a scope to `full` heals a wedged cursor on BOTH scope-declaring routes rather than one). Nothing else may write it; read "`pairPeer`" below as "either of those two operator paths".

A receiver whose own `sync_scope` is narrow verifies sparse and advances this cursor with `last_applied_row_hash = NULL` (it never holds the tail entry's hash — the tail may be an entry it was never shown). That is correct while it stays narrow. When a `pairPeer` call leaves that peer's `sync_scope` at `full` — whatever it was set to before that call — while this cursor is still anchorless, the strict path has no way to link the peer's next, perfectly contiguous run to it — every subsequent import is refused forever (the one-way ratchet). Setting this column to the CURRENT `last_applied_seq` permits the next strict run to adopt its OWN first entry as the anchor, for that one cursor position only. Everything else stays strict: the run must still begin at exactly `last_applied_seq + 1`, be internally gap-free, and verify every rowHash and signature — so a re-signed run with a deleted middle entry is still refused.

Consumed by the first `advanceCursor` that records real progress (which always writes a real row hash on the strict path), and only re-issued by another `pairPeer` call that again leaves this peer at `full` with an anchorless cursor. NOTHING a peer sends can set it: no import/relay/poke path writes this column.

## §13. Bundle-transfer tracking (DESIGN §13)

Bundle-transfer tracking (DESIGN §13). One row per `.scpbundle` this side produced or consumed. PER-HOP AND INSERT-ONLY — never a lifecycle (doc corrected 2026-07-29, M16.1): `created` is written by the exporter, `submitted` only by a retrans's onward drop, `confirmed` only by the receiver, each in its OWN database, and no production path ever updates a row. See `bundle-transfers-repo.ts` for the full note (including the one test-fixture update) and the UNBUILT return-path confirmation (future increment M16.4).

## §14. M17.5 — instance-scoped scan-requirement floors (ADR-0016 §3)

M17.5 — instance-scoped scan-requirement floors (ADR-0016 §3). Hand-authored table/RLS/grants in drizzle/0029_scan_requirement_floors.sql; read that file's header for the full rationale.

THE ONE TABLE IN THIS SCHEMA WITH NO `org_id`, and deliberately so: it carries the two ABOVE-ORG tiers of the six-tier scan-requirement chain (platform -> trust domain (partition) -> org -> containment domain -> service -> component). A deployment sits in exactly one partition, so a trust-domain floor applies to EVERY org hosted on it. This is the documented exception to DESIGN §4.2's "org_id NOT NULL on every tenant-scoped table" — the table is not tenant-scoped and holds no per-tenant rows at all, so it exposes no cross-tenant visibility.

`tier` is spelled `trust_domain`, NEVER bare `domain`: the trust domain (partition) is the ambient federation boundary ABOVE org, while the `domain` OBJECT TYPE (the containment domain, see the `federation_self` comment above) is an intra-org grouping BELOW org. Different concepts.

Access: tenant-READ (RLS `FOR SELECT USING (true)`, `scp_app` holds SELECT only) / operator-WRITE (over the admin connection — `scp_app` has no write grant AND there is no write policy).

Every severity ceiling is NULLABLE: NULL = "this tier sets no ceiling for this severity", which contributes NOTHING to the per-severity MIN. Absent is never read as 0.

## §15. 'local' | 'federated'

'local' | 'federated'. NOTE (dated 2026-07-23, M17.5 follow-on): the CHECK admits both, but NO federation writer producing `origin: 'federated'` rows exists — only the operator PUT (routes/instance-scan-floors.ts) writes this table. Under the 2026-07-23 D5 decision (outposts/retrans never evaluate scan policy — they validate the commander's signature, not requirements), federated-origin floors are DORMANT until a genuine multi-commander distribution need exists. Not a bug; see the matching note in scan-requirements.ts and the ADR-0016 addendum.

## §16. M21.2 — the DEPENDENCY INVENTORY substrate (ADR-0032 §3/§4/§5/§7)

M21.2 — the DEPENDENCY INVENTORY substrate (ADR-0032 §3/§4/§5/§7). Hand-authored table/RLS/grants in drizzle/0061_dependency_inventory.sql; read that file's header for the full rationale — the four measurements behind the principle-2 bend, the URN-collision argument, and the RLS mirroring.

Two things about these tables are invariants rather than current shape:

1. NO `depends_on` EDGE IS EVER MINTED for a package dependency (ADR-0032 §5). That relationship type is the wave-plan toposort input, the `impact-of`/`blast-radius` default relType, and the `stageDependencies` materialisation target; a cycle among co-placed targets is a hard plan-compile error and package graphs routinely contain cycles. Package dependencies live in these two tables and nowhere else. 2. NOTHING HERE MAY EXPOSE A TRANSITIVE TRAVERSAL (ADR-0032 §3). Direct declared dependencies only — the transitive closure is an SBOM by another name (ADR-0013) and SCP stores no SBOM bytes. Both hot queries are single-hop index lookups served by the two indexes below; the moment a recursive walk appears here the graph representation becomes necessary again and the measured `impact-of` CTE hazard (7+ min, then disk exhaustion, against a 5s statement_timeout) applies.

## §17. The identity of ONE MAJOR LINE of one dependency, in one org

The identity of ONE MAJOR LINE of one dependency, in one org. Derived, high-churn observation data — the category `changeSourceEvents` and `objectHealth` already occupy — so it is a projection table and it does NOT federate (ADR-0032 §3, unchanged: that is what justifies the principle-2 bend).

IT IS WRITTEN ON THE COMMANDER ONLY (ADR-0032 §7d, owner decision 2026-08-17). This comment used to say "per-domain … each domain derives its own", quoting §3; that half is reversed. All dependency automation is commander-only — a FIELD outpost never ORIGINATES a bump, it receives the resulting change down the global pipeline the commander manages — so these rows exist in exactly one place, and an EMPTY `dependency_lines` on a field outpost is correct rather than a sync failure. "Field" is the qualifier that makes that sentence true: an HQ outpost is the outpost in the COMMANDER'S OWN trust domain, so its rows ARE these rows (ADR-0032 §7d's vocabulary note, read out of the code in `dependencies/commander-only.ts`). Any deployment whose `SCP_FEDERATION_ROLE` reads `outpost` is a field outpost, which is why the table is empty exactly there and nowhere else. `drizzle/0061`'s `COMMENT ON` carried the old wording, which is what an operator actually meets in `\d+ dependency_lines`; 0061 is merged and not editable in place, so `drizzle/0066` restates it there. The two are meant to be read as one statement — keep them saying the same thing.

THE COORDINATE IS NOT A URN, and that is why this is a table. `graph/urn.ts`'s `slugify` lowercases and hyphenate-collapses every non-alphanumeric run, so `@acme/lib`, `acme/lib` and `acme-lib` all become `acme-lib` — one URN, a 409 collision, no auto-suffix and no upsert-by-coordinate. `coordinate` is therefore the ecosystem-native string stored VERBATIM, and `(orgId, ecosystem, coordinate, major)` is the identity.

## §18. THE PRODUCER LINK USED TO BE HERE

THE PRODUCER LINK USED TO BE HERE — `produced_by_object_id` + `produced_by_declared_at` + `produced_by_declared_by_object_id`, with a partial index and the `dependency_lines_internal_is_declared` CHECK. All five are gone (drizzle/0068, ADR-0032 §7e).

They made the declaration PER MAJOR LINE, and a line is minted only by a CONSUMER's manifest. So every new major of a coordinate the org publishes minted a fresh row with a NULL producer — honestly third-party, since nobody had filled it in — and `buildLineWorkList` then handed the org's own coordinate to a PUBLIC INDEX. That is §7b clause 1's dependency-confusion catastrophe, re-armed silently at each major bump; both barriers that exist against it read the column, and neither can protect a column nobody filled in. The declaration now lives in `dependencyLineProducers`, keyed `(org_id, ecosystem, coordinate)`.

DO NOT REINSTATE THIS AS A MATERIALIZED CACHE stamped by `upsertDependencyLine` at mint time. It closes the same hole with no human step, and it puts a `produced_by_*` write back inside the ingestion verb — which deletes "the capability is absent from ingestion", the property this whole feature protects. The join makes the projection unnecessary rather than safe.

## §19. WHICH COMPONENT THIS ORG DECLARES IT PRODUCES ONE COORDINATE

WHICH COMPONENT THIS ORG DECLARES IT PRODUCES ONE COORDINATE (ADR-0032 §7e, proposal §12.1). Hand-authored table/RLS/grants in `drizzle/0068_dependency_line_producers.sql`.

THE GRAIN IS THE COORDINATE, NOT THE LINE, and that is a security property rather than tidiness. A `dependency_lines` row is `(org, ecosystem, coordinate, major)` and is minted ONLY by a consumer's manifest, so under per-line grain (a) a producer with no consumers yet had no row to attach to, and (b) every new major minted a fresh NULL-producer row that the version poll then handed to a public index — §7b clause 1's dependency confusion, on a daily timer, re-armed at each major bump with nothing to alert on. Keyed by coordinate, a brand-new major of a declared coordinate is internal FROM THE INSTANT IT IS MINTED, because there is no per-major field left to populate.

IT IS NOT A GRAPH OBJECT, AND THAT IS THE FEDERATION DECISION (proposal §12.4). A `produces` relationship or a `producedBy` policy effect WOULD federate — `policy` does — and a field outpost would then hold a declaration with no inventory behind it: a visible assertion nothing can act on. A projection table cannot make that mistake; it exists only where the inventory does, which since ADR-0032 §7d is the commander alone.

DECLARED, NEVER INFERRED. Nothing writes this table except the two verbs in `routes/dependency-producers.ts`; `inventory-ingestion.ts` does not import it, which is the enforcement, exactly as `dependency-inventory-repo.ts` not importing `relationships` is the enforcement for "no `depends_on` edge is minted".

## §20. WHEN THE MANIFEST WAS READ

WHEN THE MANIFEST WAS READ — the phase-2 provider read, not the phase-3 write. That is what makes it comparable between two passes that overlap: the ordering guard in `inventory-ingestion.ts` refuses to apply a pass whose evidence is older than what the row already carries, and a write-time stamp would say the opposite thing (the pass that landed last, not the pass that looked last).

## §21. THE REPOSITORY THIS ENTRY'S EVIDENCE CAME FROM

THE REPOSITORY THIS ENTRY'S EVIDENCE CAME FROM — which is what makes the array a merge target rather than something a pass replaces wholesale.

A pass reads exactly ONE repository, and `source_mappings` is many-per-component: a component legitimately releases from `acme/widgets` (its `go.mod`) and from `acme/charts` (its `Dockerfile`). Keyed by `path` alone, a charts pass replaced the entire array and ERASED the widgets pass's `unreadable` verdict minutes later — state (iii) "manifests unreadable" rendered as state (ii) "genuinely declares nothing", which is precisely the lie this table was built to prevent. So the writer replaces only the `(repo, *)` slice it holds evidence over (`mergeIngestionStamp`), and the component-level `outcome` is computed ACROSS the merged set.

## §22. WHEN THE PASS THAT WROTE THIS ENTRY LOOKED, ISO-8601

WHEN THE PASS THAT WROTE THIS ENTRY LOOKED, ISO-8601. The only thing that orders two passes over the SAME repository: a late-delivered retry of an earlier pass must not replace a newer slice (both delivery hops are at-least-once and the ingestion queue is a competing consumer). Per entry rather than per row because the row's own `last_attempt_at` is now the newest across ALL repositories, which says nothing about whether this repository's slice is stale.

## §23. THE DEPENDENCY INGESTION'S RECEIPT, PER COMPONENT

THE DEPENDENCY INGESTION'S RECEIPT, PER COMPONENT (migration 0065, ADR-0032 §4)
`component_dependencies.observed_at` is PER ROW, so a component with ZERO rows carries no timestamp at all and three different truths produce the same empty list: never ingested; ingested fine and genuinely declares nothing; ingestion ran and every manifest was unreadable. The ingestion has always COMPUTED which one — the verdict, the per-manifest skip reason and a detail are all on `ComponentIngestionOutcome`, the backfill route reports them per component and the loop logs them — and NOTHING PERSISTED IT, so a reader arriving later has only the absence of rows to go on and is forced to render "no dependencies" over all three. The third rendered as the second is a lie told with a straight face: the component is silently unsubscribed from everything it declares, and the screen says it has nothing to declare.

ONE ROW PER COMPONENT, UPSERTED. Bounded by the component count, not by the event rate — a pass updates a row rather than appending one, which is the distinction ADR-0024's 1.44 GB/day measurement is actually about.

"NEVER ATTEMPTED" IS THE ABSENCE OF A ROW, never a value: the only writer of "we have never looked at this component" would be a pass that ran, which is a contradiction. `scp_app` holds no DELETE grant here for the same reason — deleting a stamp forges that absence.

WHY NOT THE DECISION THE INGESTION ALREADY WRITES: it writes NO Decision on the refused paths (not enabled, not addressable), which are exactly the components whose empty list needs explaining; and it is persist-on-change with the ref, the commit and every timestamp deliberately excluded, so "when did we last look?" is unanswerable from it BY DESIGN.

## §24. Per (REPOSITORY, manifest path), sorted

Per (REPOSITORY, manifest path), sorted. Per path because `manifest_path` is part of `component_dependencies`' primary key — one component legitimately declares from several manifests, so "one readable, one not" is ordinary rather than hypothetical, and a count cannot tell an operator WHICH file to fix. Per REPOSITORY because a pass reads exactly one and `source_mappings` is many-per-component: a pass replaces only its own repository's slice, so a successful charts release can no longer erase a failed widgets read. `[]` — never NULL — states "no manifest is known for this component".

## §25. WHAT COMMANDERSCP ITSELF AUTHORED FOR A DEPENDENCY BUMP

WHAT COMMANDERSCP ITSELF AUTHORED FOR A DEPENDENCY BUMP (migration 0063, ADR-0032 §8/§9)
SERVER-OWNED STORAGE, AND THAT IS THE ENTIRE POINT OF THE TABLE.

Every input that decides whose credential merges what — the repository, the authored ref, the base branch, the component, the line, the branch's head commit, the pull request — used to be read out of `changes.source_ref.scp_authored`. `source_ref` is the raw delivery payload plus a few lifted keys, and ANY authenticated principal can write it verbatim through `POST /api/v1/changes`; the event that starts the merge gate can likewise be produced through `POST /change-sources/{kind}/report`. A tenant could therefore fabricate a "bump" naming any repository and have SCP merge into it with SCP's own installation credential — a confused deputy, not a validation gap, and no amount of validating an attacker-writable field fixes one.

A merge is the one irreversible thing this feature does, so it acts ONLY on facts SCP ITSELF RECORDED. These rows are written by `dependencies/bump-actuator.ts` when SCP decides to author, and updated only by the ingress that observes SCP's own branch coming back and by the gate that actuates the merge. There is no route, no IaC type and no federation importer that reaches them. A change with no row here is NOT a bump change and never reaches the merge path.

`changes.source_ref.scp_authored` is still written — as the human-readable explanation on the change (principle 6) — and is no longer READ by anything that decides a write.

## §26. The config-source trigger's durable handoff (migration 0109)

The config-source trigger's durable handoff (migration 0109). The webhook pass RECORDS that a registered repo moved; a separate reconcile step drains it outside that transaction, where an out-of-process manifest read is legal and a failure is isolated to one row.

Dedup is a PARTIAL UNIQUE INDEX over pending rows only — see the migration header for why the same commit may legitimately be enqueued again once the first entry has drained.

## §27. IN-FLIGHT AND CONCLUDED HOOK RUNS

IN-FLIGHT AND CONCLUDED HOOK RUNS (migration 0098) — the state `pipelineEvidence` structurally cannot hold.

`TestRunEvidenceSchema.outcome` is `passed|failed` and nothing else, on purpose: "Evidence is a record of something that FINISHED; an in-flight run is expressed by the ABSENCE of evidence." That leaves one fact with nowhere to live — THAT SCP ALREADY ASKED. Without it, the 1s reconcile tick looks for evidence of a postDeploy suite, correctly finds none, and dispatches the suite again; and again; because nothing in the database distinguishes "not started" from "started, running".

This table is NOT a second evidence table and must never become one. `evaluatePostDeployGate` does not read it. Evidence records the answer; this records the question having been posed.

`pipelineHookRunsIdentity` IS THE TRIGGER GUARD, AND IT IS `NULLS NOT DISTINCT`
The claim row is inserted BEFORE `trigger()` fires, so winning or losing this constraint is what decides who dispatches — the crash-safe three-step shape `reconcile.ts`'s `triggerWaveTarget` uses for wave targets (PR #7 review CRITICAL #2), applied to hooks.

`.nullsNotDistinct()` because `postMerge` is not target-specific and belongs to no wave, so its `waveIndex` is NULL — and under PostgreSQL's DEFAULT `NULLS DISTINCT`, NULL never equals NULL, so a plain UNIQUE would leave the guard applying to every hook kind EXCEPT that one. Nothing would error and nothing would log; the suite would simply run once per tick. Requires PostgreSQL 15+; DESIGN.md §3 pins the required floor at 16+.

## §28. NULLABLE, AND THAT IS THE WHOLE DESIGN

NULLABLE, AND THAT IS THE WHOLE DESIGN. The row is claimed BEFORE `trigger()` is called, so there is no external run to name yet. NOT NULL would force trigger-then-insert, and a crash between the two would leave a running workflow in the estate with no record of it here — the exact double-dispatch this table exists to prevent. NULL therefore means "durably claimed, not yet dispatched OR did not survive to record the answer"; both recover identically by re-deriving the SAME `idempotencyKey` and re-calling `trigger()`, which a conformant executor dedups (`TriggerIntent.idempotencyKey`).
