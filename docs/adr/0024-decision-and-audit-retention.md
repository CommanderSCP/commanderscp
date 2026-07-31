# ADR-0024: Decision & audit retention — classes of evidence, checkpointed chains, and a floor no peer can fall below

**Status:** **Accepted (owner-decided 2026-07-31 — all seven decisions in §Decisions taken).** Nothing in this ADR is implemented yet; it ships no code. Follow-ups F1–F11 carry the work.
**Relates to:** charter principle 4 (PostgreSQL is the only required stateful dependency); principle 5 (air-gap first-class); principle 6 (explainability & auditability); principle 7 (Simplicity first); DESIGN.md §4.3 (audit log), §10.4 (Decision records), §13 (federation), §18 (deferred list); [ADR-0021](0021-terminology.md) (trust vs containment domain); PR #153 (`insertDecisionIfChanged`, the write-rate fix this retention design sits behind)

---

## Context

### What happened

On 2026-07-29 the production homelab instance's `decisions` table was measured at **12.33M rows / 15 GB**, growing **~1.08M rows/day (1.44 GB/day)** steadily since 2026-07-20. 99.99% of those rows were `gate|block` verdicts across **29 subject_ids**; one hour's 39,175 rows collapsed to **25 distinct** `(subject_id, input_context, reason_tree)` tuples — **99.94% byte-identical duplication**. The cause was a per-tick re-write in the reconcile wave gate, fixed on main by PR #153 (`insertDecisionIfChanged`, guarded by `coordination/decision-write-amplification.integration.test.ts`).

That fix removes the *write amplification*. It does not give the platform a *retention* story, and the incident exposed that there is not one to give.

### The grounded state of the code (verified 2026-07-31)

1. **Nothing in this database is ever deleted.** A census of all 50 `pgTable`s in `apps/server/src/db/schema.ts` finds `.delete(` call sites for four of them, and **zero raw `DELETE FROM` statements anywhere in `apps/server/src`**. `objects`/`relationships` soft-delete via `deleted_at` and are never reclaimed. There is no pruning job, no partition rotation, and `kubectl get cronjobs` on the live instance returns none. The earlier working list of "six append-only tables" was itself incomplete — `federation_inbox_files` (INSERT-only from the inbox loop), `outbox`, `state_transitions`, `control_runs`, `plans`/`change_plans`/`change_waves`/`change_wave_targets`, `object_health`, `sessions` (has `expires_at`, never purged) and `idempotency_keys` all grow monotonically with activity too. **The gap is not "a few tables lack a TTL"; it is that the platform has no deletion story at all.**

2. **`idempotency_keys` is a special case with a semantic, not merely a storage, problem.** It stores full `response_body` JSONB, has no `expires_at`, and is never purged. Choosing a retention window for it *changes observable API behaviour* (a replay after the window re-executes rather than returning the cached response), so its window is a contract decision, not a storage one.

3. **`audit_events` cannot be pruned by deletion, at all.** `verifyAuditChain` (`packages/schemas/src/audit-chain.ts`) starts at `AUDIT_GENESIS_HASH` and walks every event in `seq` order; `scp audit verify` (`packages/cli/src/cli.ts:2144`) drives it through `listAllAuditEvents()`, which has **no `since` parameter** and pages the org's complete history. Deleting any row permanently breaks verification of **everything after the gap**. DESIGN.md:256 promises the mitigation — *"chain heads are periodically **anchored** to object storage/filesystem for external verifiability (grafted)"* — and **it was never built**. Independently of storage, the client-side full walk is an O(n) verification cost that will become unusable long before disk does.

4. **`sync_journal` is worse than `audit_events`, and it grows on every instance whether or not it federates.** It is hash-chained *and* Ed25519-signed per entry, and receivers verify contiguity explicitly (`federation/import-repo.ts` distinguishes `sequence_gap` from `prev_hash_mismatch` and refuses rather than silently accepting a hole — the message is the feature). Three facts compound:
   - Every audit event is **duplicated into the journal** as an `audit_segment` entry — `audit/audit-repo.ts` appends one on the single call site every audited action funnels through. So `sync_journal` grows at ≥ the audit rate on a standalone instance with no peers at all.
   - `sync_cursors` records how far **this side has read from a peer**. A sender does not durably know how far a receiver has read — and for an air-gapped peer whose bundles are hand-carried, it *cannot*.
   - DESIGN.md §13 describes bundle export as *"journal segments (+ optional snapshot for bootstrap …)"*. **No snapshot-bootstrap path exists in the export code.** A peer that falls below a pruned journal floor would therefore have no way to re-bootstrap — pruning would be unrecoverable, not merely inconvenient.

5. **`decision_id` is referenced from 5 columns across 5 tables, none FK-constrained**: `audit_events.decision_id`, `control_runs.decision_id`, `approval_requests.satisfied_decision_id`, `approval_votes.decision_id`, `federation_inbox_files.decision_id`. A naive prune leaves dangling references and a `/v1/decisions/{id}` that 404s from inside an audit record.

6. **The 12.3M exploded rows were, without exception, uncited and superseded.** The one-off cleanup kept 1,304 rows of 12,812,620 — first + last per identical-content group, UNION anything referenced — and found **zero dangling `decision_id` references afterwards**. This is the empirical basis for the retention classes below: the rows that grew without bound are exactly the rows nothing points at.

### The three tensions this ADR has to resolve

- **T1 — "reconstructible forever".** DESIGN.md:511 states a Decision's inputs are *"reconstructible forever, even after policies change."* Read literally, that forbids any TTL on any Decision.
- **T2 — the chain.** Any deletion from `audit_events` (or `sync_journal`) breaks verification of the suffix, and the promised anchoring mitigation does not exist.
- **T3 — dangling references.** Five unconstrained citation columns mean correctness of a prune depends entirely on getting a query right, with nothing enforcing it.

And one meta-point that should be recorded plainly rather than tidied away: **unbounded growth is not in §18's deferred list.** §18 documents what was deliberately deferred *and why deferral is safe*. Retention was not deferred; it was **overlooked**, and found in production. §18 should say so in those words (D8) rather than acquiring a retroactive row that implies foresight nobody had.

---

## Decision

### D0 — Frame: write rate first, retention second. Neither substitutes for the other.

Retention cannot save a table taking 1M duplicate rows/day; dedupe cannot save a table that only ever grows. The order is: **(a)** no engine writes a Decision on a tick where nothing changed (PR #153, extended to its three latent siblings), then **(b)** retention bounds what accumulates legitimately. This ADR is (b), and it explicitly does **not** license relaxing (a) — a retention job is not a reason to tolerate write amplification, because pruning cost scales with the garbage rate.

### D1 — Retention is by **evidentiary class**, never a global TTL.

Every row in an activity-proportional table falls into exactly one class:

| Class | Meaning | Policy |
|---|---|---|
| **P — Permanent evidence** | The trail an auditor or incident reviewer is entitled to years later | **Never deleted.** May be *archived* (moved to a signed file) only under D3's conditions. |
| **E — Evidentiary, floored** | Explains something that is still live, or is retained for a compliance window | Retained at least as long as its subject is live; then a long, configurable window (default 1 year). |
| **O — Operational telemetry** | Bookkeeping about how the machinery ran | Short configurable window (default 30–180 days by table). |

Initial assignment (each is an owner-reviewable call, not a derivation):

- **P:** `audit_events`; `sync_journal`; every Decision that is **cited** (§D4) or **pinned**; the audit events recording retention runs and retention-config changes (§D6).
- **E:** `imported_approval_evidence`, `control_runs`, `approval_requests`/`approval_votes`, `state_transitions`, `plans`/`change_plans`/`change_waves`; the **latest** Decision per `(org, subject, kind)` while its subject object is live.
- **O:** superseded, uncited Decisions; processed `change_source_events`; `bundle_transfers`; `federation_inbox_files`; delivered `outbox` rows; expired `sessions`; `object_health` history; `idempotency_keys` (see D7).

### D2 — A Decision is permanent iff it is *cited*, *current*, or *pinned*.

Concretely, a Decision is retained indefinitely when **any** holds:

1. Its `id` appears in any of the five citation columns (§Context 5). Citations are the platform's own statement that this Decision carries evidentiary weight.
2. It is the newest Decision for its `(org_id, subject_id, kind)` **and** the subject object is not deleted — this is the row `/changes/{id}` "Why?", `scp change explain`, and the service board render today.
3. It is **pinned** — a new `decision_pins` table for legal hold / open incident, written by an explicit API call, itself audited.

Everything else is **uncited and superseded**, and is pruned after a configurable window (**default: 365 days**, O2). That is precisely the class that produced 99.94% of the production volume.

**The window is deliberately long, because the job's purpose is insurance, not space.** Post-#153 the expected rate is ~1 Decision per genuine state change — order 1,500/day for a busy org, ≈ 2 MB/day ≈ 0.7 GB/year at the measured 1,337 B/row. At that rate a 90-day window reclaims nothing worth having. What the job actually defends against is a *regression* in the write path — most sharply the CEL-volatility case, where a single policy with an unevaluable condition (a typo'd identifier, a renamed label) is a permanent operator error that never self-heals and restores the full 43,200 rows/day/change. 365 days keeps the platform's behaviour within a rounding error of "Decisions are permanent" while capping that blast radius.

**This resolves T1 without weakening the guarantee anybody relies on.** The promise that matters at DESIGN.md:511 is that inputs are *snapshotted rather than re-derived*, so an explanation is immune to later policy change. A `decision_id` handed back in a blocked 4xx resolves for as long as anyone could act on it; a Decision cited by an audit record resolves forever. What lapses is a superseded duplicate that no record points at and no UI renders.

### D3 — `audit_events` and `sync_journal` are **never deleted**. They are checkpointed, and only then archivable.

**Three things must exist before any byte of chain leaves hot storage, in this order:**

1. **Checkpoints — build the anchoring DESIGN.md:256 already promised.** A `audit_checkpoints(org_id, seq, row_hash, occurred_at, created_at, signature)` row, written on a schedule, recording a verified chain head. Externally anchored to the **filesystem** (the same path air-gap bundles use), never to a cloud object store — charter principle 4 and principle 5 both forbid making one required.
2. **Verification from a checkpoint.** `verifyAuditChain` gains an explicit starting `expectedPrevHash` (today hard-coded to `AUDIT_GENESIS_HASH`), and the API gains `GET /v1/audit-events?sinceSeq=`, so `scp audit verify` can verify a suffix against a recorded anchor instead of re-walking all history. **This is independently worth building even if nothing is ever archived** — it is the fix for the O(n) full walk.
3. **Archive, not delete.** Only once (1) and (2) hold may a *prefix* of the chain be exported to a signed file that verifies standalone and re-imports for verification. **A hole in the middle is never permissible**, checkpoint or not.

**`sync_journal` is un-prunable until bootstrap-snapshot export exists, and that export is prioritised (O5).** Even with checkpoints, pruning the journal is unsafe without it (§Context 4) — a peer below the floor could never resync, and for an air-gapped peer the sender cannot even know the floor. This is **not** an indefinite deferral: on a standalone instance the `audit_segment` duplication makes the journal the second-fastest-growing table in the system, so F6 is scheduled with the federation work rather than parked. Rejected in the same breath: suppressing `audit_segment` writes on peerless instances (§Rejected alternatives).

### D4 — Referential integrity: enforce it in the database **and** by construction.

Both, because the failure mode here is a query that quietly misses a citation site:

- **Add real FK constraints on all five citation columns — `(org_id, <column>)` → `decisions(org_id, id)`, `ON DELETE RESTRICT`** (O3), created `NOT VALID` then `VALIDATE CONSTRAINT` to avoid a long exclusive lock. Requires a unique index on `decisions(org_id, id)`. Three things make this exact shape the right one:
  - **Composite, not `(id)` alone, because FK checks bypass RLS.** PostgreSQL performs referential-integrity checks with row security *not* applied. An `(id)`-only FK would therefore permit one org's audit event to cite another org's Decision, and would leak cross-tenant existence (the insert succeeds or fails depending on whether a foreign id exists). With `org_id` in the key the constraint can only ever match same-org rows, since RLS already pins `org_id` on the referencing insert.
  - **RESTRICT, because it converts a pruning bug into a loud job failure** rather than silent corruption of the audit trail. `ON DELETE SET NULL`/`CASCADE` are in any case **impossible on `audit_events`** — `drizzle/0002_rls_rbac_seed.sql:35` revokes UPDATE and DELETE from `scp_app` and `:124` adds an immutability trigger, so nothing may modify that table. Only RESTRICT/NO ACTION are available.
  - **Feasible, verified 2026-07-31:** every one of the five columns is locally minted and none is ever written from an imported payload — single writers at `audit-repo.ts`, `controls-repo.ts:103`, `approvals-repo.ts:86/252/353` and `retrans-relay.ts`, reached only from local routes; `federation/import-repo.ts` never writes a `decision_id`. **Precondition before `VALIDATE`:** a production survey confirming zero rows in any of the five columns fail to resolve to a same-org Decision.
- **The prune query still excludes cited rows by anti-join across all five columns**, so the FK is belt-and-braces and never the primary mechanism.
- **A scheduled dangling-reference check** reports zero-or-fail, and a permanent integration test asserts the retained set is closed under citation. The check must be **filterless** — it enumerates citation columns from the schema, so a sixth citation column added later fails the test rather than being silently unprotected.

### D5 — Do **not** partition `decisions` in v1.

Partitioning + `DETACH`/`DROP` is dramatically cheaper than `DELETE` at scale (the one-off cleanup used `TRUNCATE` precisely to avoid ~13 GB of WAL). But: a FK must reference a unique index **containing the partition key**, so range-partitioning `decisions` on `created_at` makes D4's FKs on `id` alone impossible. Post-#153 the steady-state volume is small enough that batched `DELETE` with normal autovacuum is adequate, and charter priority 7 puts **Simplicity first**. So: **batched `DELETE`, FKs kept**; partitioning is recorded as the escalation if measurement shows the prune job cannot keep up (F6). This trade should be revisited on evidence, not preference.

### D6 — Deletion is itself an audited, explainable act.

- Every retention run writes **one audit event** and **one Decision** (`kind: 'retention'`) per table, recording the window applied, the retained-set predicate, and rows removed. Deleting evidence without evidence of the deletion would violate principle 6 outright.
- **Retention configuration is org-scoped, graph-native, and versioned** — a policy-shaped document, not a server env var (principle 2), so an operator can see and diff it and a change to it is audited.
- **A hard floor below which no window may be configured** (proposed: 30 days), so a misconfiguration cannot silently destroy a compliance trail.
- The retention job runs **only in a worker-capable process**, and must be safe to run concurrently across replicas.

### D7 — `idempotency_keys` gets an explicit contract, not just a broom.

Its window is the documented lifetime of an `Idempotency-Key` — **24 hours** (O6) — stated in the API docs and in the OpenAPI description, because expiry is observable: a replay after the window re-executes. Pruning it is then *implementing* the contract rather than changing behaviour by side effect. 24h is safe for this platform's replay paths specifically because federation does **not** depend on it: bundle import is idempotent by content hash (`federation_inbox_files`' unique index on `(org_id, inbox_dir, file_name, sha256)`) and by origin sequence, never via `idempotency_keys`.

### D8 — Record the oversight honestly in DESIGN.md.

Two edits, both proposed here and neither made:

- **DESIGN.md §10.4 (line 511)** — replace *"reconstructible forever, even after policies change"* with wording that says what is actually guaranteed:

  > Because the *inputs* are persisted — not re-derived — "blocked because required policy `prod-security@v3` control `security-scan` (Trivy binding) returned `fail` (CVE-2026-1234)" stays reconstructible **for as long as the Decision is retained, and unchanged by any later policy edit**. Retention is by evidentiary class (ADR-0024): a Decision **cited** by an audit event, control run, approval or import record, or **pinned**, or **current for its subject**, is kept **permanently**; only uncited, superseded Decisions age out.

- **DESIGN.md §18** — add a row, worded as the correction of an oversight rather than a considered deferral:

  > | Retention / data lifecycle | **Not a deferral — an oversight, found in production 2026-07-29** (`decisions` at 1.44 GB/day). Corrected by ADR-0024: retention by evidentiary class, checkpointed audit chains, no deletion of chained tables. |

---

## Decisions taken (owner, 2026-07-31)

| # | Question | **Decision** | Note |
|---|---|---|---|
| **O1** | Is D2's citation rule an acceptable reading of "reconstructible forever"? | **(a) yes — citation rule; amend DESIGN.md §10.4 per D8** | Alternatives were "all Decisions permanent" and "permanent + compressed"; both rejected in §Rejected alternatives. |
| **O2** | Default window for uncited superseded Decisions | **365 days** | Chosen for defense-in-depth, not disk — see the arithmetic under D2. Revised up from an initially-proposed 90 days once the post-#153 rate was worked through. |
| **O3** | FK constraints on the five citation columns | **Composite `(org_id, <column>)` → `decisions(org_id, id)`, `ON DELETE RESTRICT`** | Composite because FK checks bypass RLS; RESTRICT because `SET NULL`/`CASCADE` are impossible against `audit_events`. Feasibility verified; production survey is the gate on `VALIDATE`. |
| **O4** | Build audit checkpointing + `sinceSeq` now, or only when archiving is needed? | **(a) now — the full D3 stack** | Includes `verifyAuditChain(startingPrevHash)`, `GET /v1/audit-events?sinceSeq=`, `scp audit verify --from`, and the checkpoint table + anchor job. Fixes the O(n) client-side verify walk as a side effect. |
| **O5** | `sync_journal` | **(c) prioritise bootstrap-snapshot export** | Journal stays un-prunable until it lands. Suppressing `audit_segment` on peerless instances explicitly rejected. |
| **O6** | `Idempotency-Key` lifetime | **24 hours** | A public contract change — must be stated in the OpenAPI description, not just implemented (D7). |
| **O7** | Milestone assignment | **(c) split by urgency** | F8 and F9 are production-driven and precede milestone work; F1–F4, F7, F10 form the retention milestone; F6 rides with the federation work. |

---

## Consequences

- **Positive.** Growth becomes bounded and *explainable*. `scp audit verify` stops being O(all history). The audit chain gains the external anchoring DESIGN promised. Five silent reference relationships become database-enforced. Deletions are auditable.
- **Negative / accepted.** **This does remove something reachable today.** `GET /v1/decisions?subjectId=` (`routes/changes.ts:453`) lists a subject's *full* Decision history, so an uncited superseded Decision is retrievable now and would not be after the window. What survives is the cited set, the current Decision per `(subject, kind)`, and pins — an operator archaeologising a long-closed incident sees a shorter history, not a broken link. FKs add write-path cost on five tables and foreclose partitioning `decisions` without dropping them first. `sync_journal` keeps growing until F5 lands.
- **Air-gap.** Retention floors that depend on a peer's progress are computed per peer; where the floor is **unknown** (air-gapped, or an outpost seen from the commander), the answer is **do not prune** — never a guess. This is the same discipline DESIGN.md §13 already applies to staleness ("unknown, never fresh").
- **Not introduced.** No object store, no external archival service, no new required stateful dependency (principle 4). Archives are signed files on the filesystem, the same channel air-gap bundles use.

---

## Follow-ups (code — deliberately **not** written in this session)

Sequenced per O7: production-driven work first, then the retention milestone, then federation.

**Now — production-driven, ahead of milestone work**

| # | Work |
|---|---|
| **F8** | The three latent write-amplification siblings — `campaign-reconcile.ts:220` (worse than the fixed one: its guard deliberately re-includes `blocked` waves), `campaign-reconcile.ts:150`, `federation-sync.ts:379`. Live risk, not milestone work. |
| **F9** | A DB growth/sizing/backup runbook under `docs/runbooks/` (none exists). The live instance still runs the bundled **eval** Postgres, which `deploy/helm/values.yaml` marks "EVALUATION ONLY … NOT for production (no HA, no backups, no tuning)" (the `postgres.eval` block). |
| **F12** | **Measure the post-#153 Decision write rate** once it deploys (rows/hour vs distinct content). This is the evidence O2's window and F11's trigger both rest on, and it does not exist yet. |

**Retention milestone (BUILD_AND_TEST.md §8 — number to be assigned)**

| # | Work | Depends on |
|---|---|---|
| **F1** | `decision_pins` table + pin/unpin API, audited | — |
| **F2** | Retention config as a versioned org-scoped document + 30-day hard floor | — |
| **F3** | Retention job (worker-capable, replica-safe, batched DELETE) + per-run audit event & `kind: 'retention'` Decision | F2 |
| **F4** | Composite FKs on the five citation columns (`NOT VALID` → `VALIDATE`), preceded by the production dangling-reference survey; plus the **filterless** citation-column integration test | survey |
| **F5** | `audit_checkpoints` + anchor job + `verifyAuditChain(startingPrevHash)` + `GET /v1/audit-events?sinceSeq=` + `scp audit verify --from` | — |
| **F7** | `idempotency_keys` TTL + documented 24h lifetime in OpenAPI | — |
| **F10** | DESIGN.md §10.4 and §18 edits per D8 | — |

**With the federation work**

| # | Work |
|---|---|
| **F6** | Bootstrap-snapshot export — unlocks `sync_journal` retention and bounds standalone-instance journal growth (O5). |

**On evidence only**

| # | Work |
|---|---|
| **F11** | Escalate to partitioning `decisions` **only** if F3 is measured unable to keep up — and note it requires dropping F4's FKs first. |

---

## Rejected alternatives

- **A global TTL on all append-only tables.** Simple and wrong: it deletes cited evidence and breaks both hash chains. The tables differ in kind, not just in size.
- **Delete from `audit_events` and accept that verify fails before the gap.** Turns a tamper-evidence mechanism into one that cannot distinguish pruning from tampering — the exact property it exists to provide.
- **Keep every Decision forever and absorb the growth (O1 alternative b).** Genuinely tempting: it keeps DESIGN.md:511 literally true, needs no machinery at all, and at the expected post-#153 rate (~0.7 GB/year) it is affordable. Rejected because it is a standing bet that the write path never regresses, and the CEL-volatility case shows how cheap a regression is — one policy with an unevaluable condition is a permanent operator error that never self-heals and restores the full 43,200 rows/day/change. O2's 365-day window is the compromise: near-identical behaviour, bounded blast radius.
- **Stop writing `audit_segment` journal entries on instances with no peers (O5 alternative b).** The cheapest volume win available, and rejected anyway: it puts conditional logic in the hottest path in the system, immediately adjacent to a hash chain, and a peer paired later would silently lose history it receives today. Bootstrap-snapshot export (F6) addresses the same growth without either hazard.
- **Cap `decisions` by row count / ring-buffer.** Retention would then depend on *other* subjects' churn: a noisy change could evict the evidence for a quiet, important one.
- **Move old rows to object storage / a data warehouse.** Violates principle 4 (new required stateful dependency) and principle 5 (air-gap). The filesystem archive is the air-gap-native equivalent and already has a signing story.
- **Fix only the write amplification (PR #153) and call it done.** It reduces the slope, not the integral; a legitimately busy org still grows without bound, and this ADR's second-largest table (`sync_journal`) is untouched by it.
- **Retroactively add "retention" to §18's deferred list as though it were planned.** Rejected in favour of D8's explicit "oversight, found in production" wording; §18's value is that its rows are honest.
