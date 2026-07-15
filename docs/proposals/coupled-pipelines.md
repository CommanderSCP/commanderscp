# Proposal: coupled pipelines — a software release waits on an infra release (M12 P4B)

**Status:** Draft — proposed 2026-07-15, pending owner review.
**Relates to:** [service-component-model.md](service-component-model.md) (P1–P4A), `apps/server/drizzle/0024_wave_target_purpose.sql` (P4A — and §1 corrects its closing comment), [DESIGN.md](../DESIGN.md) §9.1–§9.4, §12, [PROJECT_CHARTER.md](../../PROJECT_CHARTER.md) principles 1 (coordinate, don't execute), 2 (graph-native), 3 (API-first parity), 6 (explainability).

---

## Why now

> **Owner:** *"a software deployment can wait on an infra deployment before continuing. Or it knows there's no need to wait."*
>
> **(1)** *"feature A is code complete. The software requires a new S3 bucket, so we need to be sure the software doesn't get deployed out until the infra gets deployed out in a given region."*
>
> **(2)** *"image is ready for promotion, but we need to be sure the code to create the app in ArgoCD is also deployed out. We'll need the image deployed and available first before the ArgoCD can deploy."*

**Both of these fail OPEN today, silently, in seconds.** This is not a missing optimisation — it is an open hole, and P4B closes it.

The chain from a webhook to a live executor trigger is **entirely unconditional**:

| step | code | condition |
|---|---|---|
| `proposed → evaluated` | `reconcile.ts:105-134` | none |
| `evaluated → coordinated` | `reconcile.ts:161-225` | none |
| `coordinated → executing` | `reconcile.ts:226-254` | **none** — a bare `transitionChange(toState:"executing")` |
| first wave gate | `gates.ts:159-193` | governance only (policies/freezes/controls/approvals — none of which can see a sibling change; §1) |

Only one lifecycle edge is governance-evaluated at all — `GOVERNED_LIFECYCLE_EDGES = new Set(["validating->promoted"])` (`gates.ts:91`) — and it sits *after* execution. So an app-repo push with no policy configured walks `proposed → executing` and triggers its executor within a few reconcile ticks. The S3 bucket does not exist. Nothing notices, nothing warns, and no Decision records that a prerequisite was ever considered.

The hole is symmetric in owner example (2): whichever of the two releases lands first ships immediately, regardless of the other.

---

## 1. What we verified (and what the docs/comments claimed)

Grounded against the code. This project's own comments are the most dangerous input to a P4B design, so each row carries evidence.

### 1.1 The comment that would have produced the wrong design

| Claim | Reality |
|---|---|
| `drizzle/0024_wave_target_purpose.sql:35` — *"Likely home: the **existing** `coordinated-change` type + `correlates` (DESIGN §9.2)"* | **The "existing" thing is a write-only stub.** `typeId "correlates"` appears exactly once in all TypeScript — the write at `correlation.ts:98`. **Zero engine readers.** Its key is `labels->>'correlationKey'` alone, org-wide, no time window, no state filter — so a single immortal `Coordinated: refs/heads/main` object accretes every push in the org forever. It is populated by 1 of 5 `proposeChange` origins (`POST /changes` accepts `correlationKey` at `routes/changes.ts:106` and **never links**). The group is selected with `findFirst` and **no `orderBy`** (`correlation.ts:71-79`), so which group wins is nondeterministic. Adopting it means building the key derivation, the read path, and the scoping from zero and inheriting only a name. |

This comment was written by this project's own author, yesterday, in the migration immediately preceding this work. **0025's header must explicitly supersede it**, or the next designer walks into it exactly as we nearly did.

### 1.2 The finding that kills the obvious predicate

| Claim | Reality |
|---|---|
| "the software waits until the infra change is `promoted`" — the intuitive predicate, and the one the campaign engine uses (`campaign-reconcile.ts:267`) | **A forward change NEVER auto-promotes.** `reconcile.ts:789` is literally `if (!change.rollbackOfObjectId) return; // forward change — waits for a human 'scp change promote'.` Verified exhaustively: `toState: "promoted"` has exactly **two** writers repo-wide — `reconcile.ts:796` (rollback changes only) and `routes/changes.ts:304` (the human HTTP promote route). `watchdog.ts:20-21` confirms it in prose: `validating` gets a 24h SLA "because it is often waiting on a HUMAN `scp change promote` call". **So `promoted` means "a human signed off", not "the infra got deployed out."** A `promoted` predicate would insert a mandatory manual step into the owner's fully-automated webhook-born flow and hang both examples on the happy path. |
| the physical fact — "the bucket exists" | is `executing → validating`, written by `completeExecution` (`reconcile.ts:775-786`) with reason `"auto: every wave succeeded"`. At that instant the executor has run and reported success. |

This single fact reverses the winning panel design's central choice. See §3.3.

### 1.3 `changes.correlation_key` is not dead — it is **poisoned**

| Claim | Reality |
|---|---|
| `changes.correlation_key` is a free, ready-made coupling key (it has 3 writers, an API field, a CLI flag `cli.ts:1387`, a UI column, and a DTO reader) | **Reusing it would brick every deployment in every org on upgrade.** `packages/plugins/github/src/index.ts:230-236` auto-derives it on every event: `push → payload.ref` (= the literal string `refs/heads/main` for **every repo in the org**), `deployment → deployment.environment` (= `"production"`), `pull_request → pr-<n>`, `workflow_run → run-<id>` (which collide across repos by coincidence). The column is **already populated with universally-colliding values on ~every webhook-born change, right now.** Any predicate keyed on it makes the first satisfied release satisfy every waiter org-wide. Independently disqualifying: it has no index and no unique constraint (`schema.ts:408-413`), and it is a **column**, so it does not cross federation. |

### 1.4 A new relationship type is **not** free across federation (the map ranked this the best charter fit)

| Claim | Reality |
|---|---|
| terrain map §3.2: a new registry-seeded relationship type "replicates for free under `full` sync scope" | **Half true, and the missing half is a bundle-abort.** `JournalEntryKindSchema` (`packages/schemas/src/federation.ts:42-52`) has **no `relationship_type_upsert`** — a builtin relationship type arrives *only* via migration. `import-repo.ts:188-214` calls `createRelationship`, which calls `requireRelationshipType`, which throws **`notFound`** (`type-registry-repo.ts:188`) = `ProblemError(404)` (`errors.ts:32-34`). The import's catch is `if (err instanceof ProblemError && err.status === 400) return; throw err;` (`import-repo.ts:211-212`) — **a 404 is re-thrown.** So the first `releases_after`-style edge journaled from a migrated commander to an un-migrated outpost **aborts the entire signed bundle**, blocking every subsequent journal entry on that channel. In a hub-and-spoke fleet with rolling upgrades — the charter's mandated topology — that is a real outage, not a theoretical one. Object *properties*, by contrast, cross verbatim through `PromotionBundleSchema.change.properties` (`federation.ts:226` → `promotion-repo.ts:190`) with no version coupling at all. |

### 1.5 The emit path the whole feature depends on has **no API contract** (charter principle 3)

| Claim | Reality |
|---|---|
| `scp change-source report` is a typed, SDK-generated path | **False on every count.** `ChangeSourceWebhookBodySchema = z.record(z.string(), z.unknown())` (`packages/schemas/src/changes.ts:233`), bound at `routes/change-sources.ts:75` — no typed contract at all. `packages/sdk/src/client.ts:1167-1185`'s `changeSources.report()` is **hand-written**, with an inline parameter type and `body: req as Record<string, unknown>` — codegen never touches it. So the CI report path appears in OpenAPI: nowhere. |
| `ChangeReportRequestSchema` types that path | **It exists and is bound to no route.** `packages/schemas/src/executors.ts:212-221` defines exactly the right shape, with a doc comment describing exactly this use ("a thin, typed wrapper around the SAME `POST /change-sources/{sourceKind}/webhook` ingress"). It is orphaned. |
| `DESIGN.md:599` / `BUILD_AND_TEST.md:359` name `scp change report --plan-json` | That command does not exist. It is `scp change-source report <sourceKind>` (`cli.ts:2568`). |

**Adding `provides`/`requires` to that path without fixing it would repeat P4A's parity break exactly.** See §7 Phase 1.

### 1.6 Two live security holes P4B would make load-bearing

| Claim | Reality |
|---|---|
| a `change` graph object is engine-managed | **False.** `GOVERNANCE_MANAGED_OBJECT_TYPE_IDS = new Set(["policy","control"])` (`governance/governance-managed-types.ts:24`); `COORDINATION_TARGET_SCOPED_OBJECT_TYPE_IDS = new Set(["campaign"])` (`coordination/campaign-scope-authz.ts:16`). **`change` is in neither.** So `PATCH /objects/change/{id}` (`routes/objects-generic.ts:255-256`) lets any `object:write` holder rewrite a change's properties — **including flipping a coordinated change's `purpose` mid-flight to point it at the wrong executor. That is a live P4A hole today**, independent of P4B. |
| `POST /changes` binds the declared targets to the actor's authority | **False.** `routes/changes.ts:71-78` authorizes `object:write` at `body.domainId ?? auth.orgId` and **never checks `body.targets`**. `POST /campaigns` closes exactly this class with `assertCampaignTargetsWithinAuthority` (`campaign-scope-authz.ts`); changes have no equivalent. Pre-existing — but after P4B it is a **forged-provider** vector. |

### 1.7 Everything else we relied on, verified

| Claim | Verdict |
|---|---|
| `properties` is the right home for a per-release fact — P4A precedent | ✅ `changes-repo.ts:141-145` writes `{...input.properties, targets, purpose}`. `purpose` crosses federation for free via the bundle's free-form `properties` passthrough (`federation.ts:226` → `promotion-repo.ts:190`). |
| a GIN index already serves `@>` on `objects.properties` | ✅ `CREATE INDEX obj_props ON objects USING gin (properties jsonb_path_ops)` (`drizzle/0001_graph_core.sql:170`; mirrored `schema.ts:197`). `jsonb_path_ops` exists to serve `@>`. **Zero index migration.** (A *partial* index predicated on `type_id='change'` — the panel winner's proposal — would be both unusable by a join-driven query and redundant with this one.) |
| a new change state needs no DDL | ✅ `changes.state` is plain `text`; the repo has zero `CHECK (` constraints outside RLS. `decisions.kind`/`verdict` are `text` (`schema.ts:469,471`) and `z.string()` on the wire (`schemas/changes.ts:110-112`). oasdiff: 8 warnings, 0 errors, `--fail-on ERR` exits 0. |
| a new state cannot be forgotten by the watchdog | ✅ `WATCHDOG_SLA_MS: Record<Exclude<ChangeState,"cancelled"|"rolled_back"|"promoted">, number>` (`watchdog.ts:23`) is exhaustive — the build breaks until an SLA is supplied — and `NON_TERMINAL_STATES = Object.keys(WATCHDOG_SLA_MS)` (`watchdog.ts:33`) auto-enrols it in the sweep. |
| a new state **is** forgotten by everything else | ✅ All five `listChangeRowsInStates` calls hardcode state literals (`reconcile.ts:107,163,229,274,307`) — a `waiting` change is swept by **zero** of them without its own pass. Three hand-maintained lists go stale silently: `change-list.tsx:34-43` (filter), `change-detail.tsx:30-38` (`CANCELLABLE_STATES` — **omitting it hides all three action buttons, trapping the change**), `cli.ts:1436` (help string). `transitions.test.ts` breaks in **three** places (`:70` `toBe(8)`, `:71` `toBe(64)`, `:75` `toBe(13)`) plus its hardcoded edge set. `stateBadgeVariant` (`change-list.tsx:48-65`) has a `default:` arm and degrades gracefully. |
| the phantom anti-drift test | ✅ `transitions.ts:10-12`, `db/schema.ts:419`, and `drizzle/0007:42-43` **all three** claim the SQL seed is "cross-checked against this constant by `transitions.integration.test.ts` so the two never drift". `git log --all --diff-filter=A -- "*transitions.integration.test.ts"` is empty and the file is not on disk. **It has never existed.** P4B edits both halves — we are the first change that drift would bite. |
| a rollback cannot inherit a coupling | ✅ `rollback.ts:57-73` constructs a fresh `proposeChange` passing only name/sourceKind/sourceRef/targets/topology/`purpose`/`rollbackOfObjectId` — it does **not** spread `originalObject.properties`. This is load-bearing (a rollback carrying `requires` would deadlock the escape hatch; a rollback carrying `provides` would satisfy a waiter *by destroying its prerequisite*) and it is currently an accident of one function. §3 adds an explicit guard **and** a test rather than depending on it. |
| `source_mappings` can already point at a `deployment-target` | ✅ `createSourceMapping` (`source-mappings-repo.ts:35`) resolves via `getObjectByIdOrUrnAnyType` — **no type filter** — despite the column being `component_object_id`, and the column has no FK. The owner's "shared infra binds to the deployment-target" needs **zero** new machinery. The column name lies; the behaviour is permissive. |
| federation preserves object ids | ✅ `promotion-repo.ts:170-172`: *"a full-graph sync bundle preserves ids verbatim across domains — `graph/objects-repo.ts`'s `FederationImportContext` never regenerates an incoming id."* So an object **reference** in `properties` resolves in a synced peer. |
| `invalidatePropertyValidatorCache` guards a `property_schema` edit | **False — it has zero callers** (`property-validation.ts:43`; repo-wide grep returns only the definition). The compiled-validator cache is keyed on `type.id` and never invalidated, so a *runtime* `property_schema` edit does not take effect in a running process. Our tightening (§3.6) lands via **migration + process restart**, so this does not bite us — but the function's existence implies a guard that is not there. |
| `matchComponentForSource` is deterministic | **False, and P4B raises the stakes.** `correlation.ts:35-46` has no `ORDER BY` and returns the first row; `schema.ts:486-504` has only a non-unique index. A component with both an infra and a software mapping for `sourceKind=github` gets whichever purpose Postgres returns first. **This is being fixed in parallel; P4B must not merge before it lands** (§8 dependency). |
| campaigns are a precedent for safe ordering | **False.** `campaign-reconcile.ts:166` excludes `'failed'` from the active-wave finder, so a failed wave is skipped and the plan marked `completed` — **a campaign ships the software when the infra fails**, the precise inverse of the ask. `reconcile.ts:337` pointedly does not. This design cites campaigns for nothing. |

---

## 2. The governing insight: **direction cannot be derived from `purpose`**

Every design that reads "software waits on infra" as a *rule* satisfies at most half the brief, and the ambiguity is not resolvable from the code.

`drizzle/0024:22-24` records the owner's own definition verbatim:

> *"infra = the IaC substrate (EC2, S3, the K8s cluster itself); **Argo CD is SOFTWARE**, since it deploys onto that substrate."*

Owner example (2) — *"we'll need the image deployed and available first before the ArgoCD can deploy"* — is the ArgoCD-app release waiting on the image release. Under the owner's recorded definition **both are `software`**; under the "the manifest is Terraform" reading, it is **infra waiting on software**. `BindingPurposeSchema = z.enum(["infra","software"])` (`packages/schemas/src/executors.ts:18`) has exactly two values, so:

- **software-waits-on-infra** (hardcoded direction) → example (2) is inexpressible, or expressed backwards.
- **software-waits-on-software** → any purpose-keyed predicate makes each change the other's prerequisite: **both park forever**.
- and `purpose` is not a free label to work around it with — it is the **executor routing key**. `reconcile.ts:649` is `getExecutorBinding(tx, orgId, targetObjectId, purpose)`, backed by `unique("executor_bindings_org_target_purpose_key")` (`schema.ts:1192`). Mislabelling the ArgoCD change `infra` to satisfy a coupling drives it through Terraform.

**Therefore the predicate must not read `purpose` at all.** The design below is direction-agnostic: one mechanism, one code path, both examples, and the "is the ArgoCD manifest infra or software?" question becomes **moot** rather than load-bearing. That is why it is not in §8.

---

## 3. The design

### 3.1 Shape: two symmetric fields on the change, one of them scoped to a graph object

Two new properties on the change's graph object — the exact home P4A gave `purpose` (`changes-repo.ts:141-145`):

```ts
properties.provides: string[]                        // "this release makes these keys true AT MY TARGETS"
properties.requires: { key: string; at: string }[]   // "this release needs key K true at object `at`"
```

- `provides` is an opaque key list. **The provider declares no scope** — its scope is already recorded: `properties.targets`, which `proposeChange` resolves and writes (`changes-repo.ts:141-144`).
- `requires` names both the key **and the object the key must be true at**. `at` is an id-or-URN at the API boundary, **resolved to an object id at propose time** exactly as `targets` are, so a typo is a **400 at emit**, not a silent forever-wait.

Owner example (1):

| | targets | emits |
|---|---|---|
| infra repo CI (`regions/us-east-1/**` → deployment-target `us-east-1`, `purpose:'infra'`) | `[us-east-1]` | `--provides feature-a` |
| app repo CI (→ component `payments-api`, `purpose:'software'`) | `[payments-api]` | `--requires feature-a@us-east-1` |

Owner example (2), component-owned, direction inverted, **same code path**:

| | targets | emits |
|---|---|---|
| image build | `[payments-api]` | `--provides feature-a` |
| ArgoCD-app release | `[payments-api]` | `--requires feature-a@payments-api` |

`at` is **mandatory**, not defaulted to the requirer's own target — because in owner example (1) the requirer targets `payments-api` and the prerequisite lands on `us-east-1`. A default would be wrong for the headline case.

### 3.2 Where the key lives, and the query

`objects.properties`, not `changes.correlation_key` (§1.3), and not a new column or table. Four consequences, all verified:

1. **The whole predicate is ONE `@>` containment**, and `obj_props` (`drizzle/0001:170`) already serves it. **No index migration.**
2. **Federation costs zero code** — properties cross verbatim (`federation.ts:226` → `promotion-repo.ts:190`), the same hole `purpose` uses today. formatVersion stays 1. A column would not cross; a relationship type would abort an un-migrated peer's bundle (§1.4).
3. **No join is added** — `listChangeRowsInStates` (`changes-repo.ts:259-277`) and `listChanges` (`:350-355`) already `innerJoin(objects)`.
4. **P4B is inert until a pipeline opts in.** Nothing auto-derives these fields; no existing change carries them; zero existing changes alter behaviour by a single tick.

### 3.3 The predicate — execution success, **not** human sign-off

> A change `W` in `waiting` releases to `executing` **iff, for every `{key, at}` in `requiresOf(W)`, there exists a change `P` with `P.org = W.org`, `P.object_id ≠ W.object_id`, `P.state ∈ {validating, promoted}`, and `P.properties ⊇ {"provides":[key], "targets":[at]}`.**

**We disagree with the panel winner here, and §1.2 is why.** The winning design chose `promoted` on the argument that *"'the infra got deployed out' means someone signed off"* — while simultaneously justifying the whole mechanism as *"a **physical** precondition — the bucket does not exist — not a governance opinion."* Both cannot be true, and `reconcile.ts:789` settles it: a forward change never auto-promotes, so `promoted` would make every coupled release wait for a human to click promote on the prerequisite. In the owner's stated scenario — two independent webhook-born changes from two CI pipelines — **nobody is watching to click it**. Both examples would deadlock on the happy path, with the 24h warn firing once into a void.

`validating` is the state `completeExecution` writes with reason `"auto: every wave succeeded"` (`reconcile.ts:775-786`) — the executor ran, the bucket exists, the image is available. That is the physical fact the coupling models. `{validating, promoted}` is "execution succeeded and has not been undone" (`cancelled`/`rolled_back`/`failed` are excluded by construction).

An org wanting human sign-off on infra before software ships already has that lever: the **software's own** `validating → promoted` gate. Coupling one release to another release's human ceremony is governance by side effect.

**A dead prerequisite is mechanically identical to a slow one, and that is deliberate.** The predicate is existential over a *condition*, not a pointer to a row. A cancelled/failed infra change is simply not in `{validating, promoted}` → the waiter keeps waiting. The operator fixes the terraform and re-pushes; a **new** change with the same key reaches `validating`; the waiter releases **with no operator action on the waiter and nothing to re-point**. This is what makes "wait forever" (the owner's choice) coherent rather than stubborn — and it is why we do not add a dead-prerequisite branch, a re-point verb, or a "which retry counts" rule. The difference is surfaced diagnostically (§3.7), not in the state machine.

**Nothing is re-checked after release.** See §5.

### 3.4 Hold point: a new `waiting` state, `coordinated → waiting → executing`

`advanceCoordinatedChanges` (`reconcile.ts:226-254`) gains a pure, zero-I/O routing guard before its existing `transitionChange`:

```ts
if (change.rollbackOfObjectId === null && requiresOf(object.properties).length > 0) → toState: "waiting"
else                                                                                → toState: "executing"   // unchanged
```

The rollback guard is defence-in-depth, not dead code: rollbacks carry no `requires` today only because `rollback.ts:57-73` happens not to spread properties (§1.7), and a future "tidy-up" refactor would silently deadlock every rollback. The guard states the invariant; a named test pins it.

**Why `coordinated → waiting` and not the wave gate:**

- **It triggers nothing, structurally.** `advanceCoordinatedChanges` only ever calls `transitionChange`. Every executor trigger lives downstream in `advanceExecutingChanges`. Charter principle 1 is satisfied by control flow, not discipline.
- **It does not inherit the two bugs the terrain map calls fatal on contact.** Both are consequences of *the wait having no state-entry event*: the gate-block path writes nothing to `changes`, so `updatedAt` freezes at the head of `ORDER BY updatedAt ASC LIMIT 25` forever (map bug #2 — the exact bug `reconcile_blocked_at` was invented to fix, `schema.ts:393-404`), and `reconcile.ts:429` inserts a Decision unconditionally *before* the block check, every ~2-3s, with no dedup and no retention anywhere (map bug #1, ~30k rows/day/waiter). A transition writes the row and happens exactly once → **2 Decisions per coupled change, and quarantine into a disjoint sweep**.
- **It does not touch `evaluateWaveGate`.** This matters more than it looks: that function has **two** callers, and `campaign-reconcile.ts:181-192` passes `changeObjectId: campaignObjectId` — a **campaign** object. Any coupling check placed inside it evaluates every campaign wave as a change. We avoid that entirely.
- **The honest state.** A waiting change reads `waiting`, not `executing`, and gets `validating`'s 24h SLA rather than `executing`'s 30-minute false alarm.
- **Not `coordinated → executing` as a governed edge**: that requires widening `GOVERNED_LIFECYCLE_EDGES` (`gates.ts:91`), turning the full policy/freeze/approval stack on at an engine-automatic edge with no human caller — an enormous blast radius on every existing org, to buy nothing. The coupling is not governance, and it must **not** be bypassable by `emergency` (`gate-orchestrator.ts:330-340` proceeds ungated with `effectivePolicies = []` when no `emergencyPolicy` is configured). An emergency deploy to a nonexistent bucket still fails. Keeping the check outside the orchestrator makes that true by construction.

**The tradeoff we accept:** a new `ChangeState` is wire-visible. oasdiff passes (8 warnings, 0 errors, exit 0), and the SDK does no response validation (`sdk.gen.ts:1189`), so an un-upgraded UI renders `waiting` raw. But oasdiff's own message is right that a client switching exhaustively on state may break. We pay the three hand-maintained lists off *in the same commit* (§3.8) rather than letting them go stale the way P4A's IaC `Campaign.purpose` did.

### 3.5 The sweep — invert the poll

`advanceWaitingChanges(db, orgId, gateDeps)`, added to the org tick beside the existing five (`reconcile.ts:895-899`). It does **not** list waiters and test them. It asks **"which waiters are releasable?"**:

```sql
SELECT w.object_id
FROM changes w
JOIN objects wo ON wo.id = w.object_id
WHERE w.org_id = $1
  AND w.state = 'waiting'
  AND jsonb_typeof(wo.properties->'requires') = 'array'      -- junk/absent => NOT releasable (fail-closed)
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(wo.properties->'requires') AS req(item)
    WHERE NOT EXISTS (
      SELECT 1 FROM changes p JOIN objects po ON po.id = p.object_id
      WHERE p.org_id = w.org_id
        AND p.object_id <> w.object_id
        AND p.state IN ('validating','promoted')
        AND po.properties @> jsonb_build_object(
              'provides', jsonb_build_array(req.item->'key'),
              'targets',  jsonb_build_array(req.item->'at'))))
ORDER BY w.updated_at ASC
LIMIT 25;
```

Double `NOT EXISTS` = "no requirement lacks a satisfying provider". Each releasable row is then re-checked **under the existing `tryAcquireChangeCoordinationLock`** (the established lost-the-race pattern, `reconcile.ts:407-412`), writes the release Decision, and transitions.

**A stuck waiter returns zero rows** — zero batch slots, zero writes, zero Decisions, per tick, forever. That kills starvation *within* the new state too (a naive `listChangeRowsInStates(["waiting"])` would let one typo'd key at the frozen-`updatedAt` head stall 25 healthy releases whose prerequisites were sitting right there).

**The junk guard is fail-CLOSED, matching the narrower.** The panel winner's version coerced a non-array `requires` to `[]` in SQL (→ releasable) while its TS narrower threw — the SQL said ship, the narrower said error. Here both refuse: `requiresOf` throws (same rationale as `purposeOf`, `changes-repo.ts:329-339` — a newer commander can hand an older outpost a shape it has never seen), and the SQL declines to release. A junk-carrying change never reaches `waiting` at all: the routing guard throws, `reconcile.ts:248-250` logs it, the change stays `coordinated`, and `coordinated`'s **5-minute** SLA flags it. Loud, fast, fail-closed.

> **Uncertainty, stated:** whether Postgres uses `obj_props` for the parameterised `@>` inside the correlated subquery must be **EXPLAIN-verified in the integration test**, not assumed. Postgres supports runtime-key GIN scans in a nested loop, so we expect it to — but if the planner refuses, the fallback is per-waiter probes plus an `updatedAt` bump per poll to round-robin waiters among themselves. That fallback is strictly worse (write amplification) and we would rather know than guess.

### 3.6 Explainability — exactly two Decisions per coupled change

`decisions.kind` and `.verdict` are free-form at both layers (§1.7), so `kind:"coupling"` needs no migration.

1. **On entering `waiting`** — `verdict:"wait"`. `inputContext` pins, **per requirement**: `{key, at, atName, provider: <change id>|null, providerState: <state at evaluation time>|null, everProvidedAtScope: boolean}`.
2. **On release** — `verdict:"release"`. Pins, per requirement, the satisfying provider's id and its state.

Both are written inside `transitionChange`'s own transaction, so the audit event is hash-chained with the action. Live status is deliberately **not** read from Decisions — Decisions are pinned historical records; `resolveWaitStatus` re-reads live state at read time. Conflating the two is what produces a 30k-row/day flood.

No wall-clock goes in `inputContext`: the Decision row's own `created_at` **is** the evaluation time. (This convention is grafted from the panel's runner-up, where it enabled dedup; here it costs nothing and keeps the record stable.)

**Write-time validation, on every path.** `object_types.property_schema` for `change` is currently the fully permissive `'{"type":"object"}'::jsonb` (`drizzle/0002:163`), so tightening it is purely additive:

```json
{"type":"object","properties":{
  "provides":{"type":"array","items":{"type":"string","minLength":1}},
  "requires":{"type":"array","items":{"type":"object","required":["key","at"],
              "additionalProperties":false,
              "properties":{"key":{"type":"string","minLength":1},"at":{"type":"string","minLength":1}}}}}}
```

Ajv is `{allErrors:true, strict:false}` (`property-validation.ts:14`) — `strict:false` disables meta-checks only; `required` and `additionalProperties:false` **are** enforced, at `objects-repo.ts:142` (create) and `:423` (update), which covers `POST /changes`, the webhook processor, **and federation import**. This works because the schema arrives by migration + restart; it would *not* work for a runtime edit, because `invalidatePropertyValidatorCache` has zero callers (§1.7).

### 3.7 Diagnostics — the 2am path

`resolveWaitStatus(tx, orgId, changeObjectId)` returns, per requirement:

| observation | meaning |
|---|---|
| `provider: <id>, state: "executing"` | **waiting correctly.** The prerequisite is in flight. Nothing is wrong. |
| `provider: <id>, state: "cancelled"` | dead prerequisite — re-run the pipeline (any new provider satisfies the same key). |
| `provider: null, everProvidedAtScope: false` | **strong typo signal.** No change has *ever* provided this key at this scope. |

Because `at` is a **resolved object**, the "did you mean" is exact rather than a prefix guess: `listProvidedKeysAtScope(orgId, at)` answers *"no change has ever provided `feature-a` at `us-east-1`; keys provided there: `feature-b`, `feature-c`."* This is the concrete payoff of scoping the key to an object instead of embedding the region as a substring.

Surfaced by `scp change wait-status <id>`, by `GET /changes/{id}/explain`, and by a "Waiting on" panel on the change detail page.

### 3.8 Every surface

| surface | change |
|---|---|
| **Migration `0025_coupled_pipelines.sql`** | 3 `state_transitions` rows (`coordinated→waiting` `wait`; `waiting→executing` `release`; `waiting→cancelled` `cancel`); the `change` `property_schema` tightening (§3.6). **No new table, no ALTER TABLE, no index.** Header **supersedes `0024:35`** (§1.1). |
| **`packages/schemas/src/changes.ts`** | `ChangeStateSchema += "waiting"`. `CreateChangeRequestSchema += provides?: string[]`, `requires?: {key,at}[]` (`.optional()`, never `.default()` — the file's own comment at `:215-219` records why: a default renders the property *required* in the generated SDK type, a /v1 break). `ChangeSchema += provides, requires` — **typed on the response**, not left buried in `properties` the way `purpose` is. `ChangeExplainResponseSchema += waitStatus`. `DecisionSchema`: no change. |
| **`packages/schemas/src/executors.ts`** | `ChangeReportRequestSchema += provides`, `requires` — and it finally gets **bound to a route** (Phase 1). |
| **`apps/server/src/routes/change-sources.ts`** | **NEW** `POST /change-sources/{sourceKind}/report`, `operationId: reportChangeSource`, body = `ChangeReportRequestSchema`. Writes one `change_source_events` row exactly as `/webhook` does — same persist-then-process, same processor, not a new engine path. The raw `/webhook` route is **untouched** (it must keep accepting provider payloads verbatim). |
| **`apps/server/src/routes/changes.ts`** | thread `provides`/`requires` into `proposeChange` (2 lines, beside `purpose` at `:110`); add `assertChangeTargetsWithinAuthority` (§1.6). |
| **`apps/server/src/routes/objects-generic.ts`** | **NEW** `ENGINE_MANAGED_OBJECT_TYPE_IDS = {"change"}` + `assertNotEngineManagedObjectType`, mirroring the two existing guards at `:119-120,255-256,304-305,351-352`, refusing POST/PATCH/PUT/DELETE on `change` and routing callers to `/changes` (§1.6). |
| **`apps/server/src/coordination/changes-repo.ts`** | `providesOf`/`requiresOf` (narrow-or-throw, `purposeOf`'s pattern and rationale); `listReleasableWaitingChanges`; `resolveWaitStatus`; `listProvidedKeysAtScope`; `ProposeChangeInput += provides, requires` written into `properties` with P4A's **exact precedence idiom** (`input.provides ?? providesOf(input.properties)`, spread *after* `...input.properties` — load-bearing for the same documented reason as `purpose`: `promotion-repo.ts:190` replays a peer's properties verbatim, and a bare `?? undefined` would clobber a coupling that crossed a domain boundary); `at` resolved via `getObjectByIdOrUrnAnyType` beside the existing target loop (`:106-109`); `toChangeShape` surfaces both. |
| **`apps/server/src/coordination/reconcile.ts`** | routing guard in `advanceCoordinatedChanges` (`:226-254`); new `advanceWaitingChanges` wired into the org tick at `:895-899`. |
| **`apps/server/src/coordination/transitions.ts`** | 3 edges in `LEGAL_TRANSITIONS` (`:34-48`). Deliberately **no `waiting→rolled_back`** — the module's own rationale (`:18-22`) says rollback is legal only "once the change has actually done something an external system needs reverting"; `waiting` is precisely such a state, and `cancel` is the correct verb. |
| **`apps/server/src/coordination/watchdog.ts`** | `WATCHDOG_SLA_MS += waiting: 24h` (**compulsory** — the exhaustive `Record` at `:23` breaks the build otherwise; auto-enrolled in the sweep by `NON_TERMINAL_STATES` at `:33`). `waitingOn` (`:104-113`) gains a `waiting` arm calling `resolveWaitStatus` to name the actual unsatisfied `{key, at}` pairs — a warn that says only "stalled in waiting for 24h" is strictly worse than the state badge. |
| **`apps/server/src/coordination/webhook-processor.ts`** | `ExtractedHint += provides?, requires?` (`:37-41`); `genericHint` reads them (`:43-51`); **`extractHint`'s github branch must carry them through** (`:53-68` reconstructs field-by-field and does *not* spread `generic` — the one line that would silently drop the key); `proposeChange` call (`:114-127`) threads them. |
| **SDK** | `pnpm gen` (committed; CI fails on drift). **Plus:** the hand-written `changeSources.report` wrapper (`client.ts:1167-1185`) is **deleted and replaced by the generated `reportChangeSource` operation** — this is the parity fix, not a hand edit. |
| **CLI** | `change propose --provides <k,...> --requires <k@obj,...>`; `change-source report --provides/--requires` (**the pipeline command**); `change list --state` help (`:1436` — the named staleness trap) `+= waiting`; `changeRow`/`changeDetailRow` (`:108,:121`); **NEW `scp change wait-status <id>`**. |
| **IaC** | **Nothing, and this is the parity answer, not a gap.** `packages/iac/src/index.ts:9-24` exports Service, Component, Domain, Team, DeploymentTarget, Group, User, ServiceAccount, Campaign, Initiative, ReleaseTopology — **there is no `Change` construct**, because a change is a runtime event, not desired state. This is the check P4A skipped: `purpose` leaked onto `Campaign`, which has no `purpose` prop (`construct.ts:295-318`), so every IaC-authored campaign silently resolves to `'software'`. That is adjacent P4A debt, not ours, and it should be fixed separately. |
| **UI** | `change-list.tsx:34-43` `CHANGE_STATES += "waiting"`; `stateBadgeVariant` `case "waiting"` → `info`. `change-detail.tsx:30-36` **`CANCELLABLE_STATES += "waiting"`** (**load-bearing** — omit it and all three action buttons hide, trapping the change); **not** `ROLLBACKABLE_STATES`. New "Waiting on" panel from `explain.waitStatus`. `correlationKey` column left exactly as it is. |
| **Federation** | **zero code.** Both fields ride the `properties` passthrough. formatVersion stays 1. Gets a pinning test, since it works by virtue of a spread a refactor could remove. **Honest caveat:** `requires[].at` is an object id, so it resolves in the peer only if the graph is synced — and a promoted waiter needs a **locally** succeeded provider (§6). |
| **Docs** | ADR under `docs/adr/`. `DESIGN.md` §9.2 — **correct** the standing lie that the app/infra/config-repo CoordinatedChange grouping is a differentiator (`:425` — nothing reads it) and its overclaimed matching dimensions (it lists commit SHA and artifact digest; `CorrelationHint` is `{sourceKind, repo, path}` and matches repo/path globs only). Fix `DESIGN.md:599` / `BUILD_AND_TEST.md:359`'s `scp change report --plan-json`. Pipeline-author guide: the two CI snippets, and the explicit warning that **a raw GitHub push webhook cannot carry a key** (§6). |
| **Tests** | Integration (real Postgres, Testcontainers): software-first→waits→releases when infra hits `validating`; infra-first→releases next tick; example (2) inverted (proving direction-agnosticism); scope mismatch (`feature-a@eu-west-1` does not satisfy `feature-a@us-east-1`) — **the cross-team collision proof**; dead prerequisite (cancelled provider → still waiting; re-run → releases with no action on the waiter); no-`requires` change unaffected (**the inertness proof**); rollback of a `provides` change neither waits nor provides (pins `rollback.ts:57-73`); federation round-trip; `everProvidedAtScope` reporting; junk `requires` from a bundle rejected at write; a waiter does not starve 25 siblings; **EXPLAIN asserts `obj_props` is used** (§3.5). **Plus: finally write `coordination/transitions.integration.test.ts`** — three comments claim it guards exactly the drift this change introduces (§1.7). |

---

## 4. The owner's fixed decisions, and how this honours each

| Decision | How |
|---|---|
| **Region = a deployment-target.** *"Whatever a shared target would be for an instance of the component. Example being it being in us-east-1."* Shared infra binds to the deployment-target; component-owned infra binds to the component. | The region enters as **`requires[].at`, a resolved reference to a real `deployment-target` graph object** — not as a substring in a key, and not as an inference. The infra pipeline's `source_mappings` row points at `us-east-1`; verified reachable **today with zero new machinery** (`createSourceMapping` applies no type filter, `source-mappings-repo.ts:35`; `webhook-processor.ts:118` proposes `targets: [match.componentObjectId]` verbatim; the column has no FK). Component-owned infra is the identical mechanism with `at` = the component. **The engine still does not know what a "region" *is*** — it knows an object id — and we will not pretend otherwise: regional *policy* and regional *reporting* remain impossible, and `DESIGN.md:429`'s claim that "regional, domain-based, federated topologies are all data, not workflow code" is still false. `hosted_on` and `deploys_to` are deliberately **not** lit up (§5). |
| **The predicate is an EXPLICIT KEY both pipelines emit.** Not inferred. | `provides`/`requires` are set **only** by an explicit `--provides`/`--requires` flag. Nothing derives them — that is precisely what poisoned `correlation_key` (§1.3), and it is what makes P4B inert until a pipeline author opts in. Both rejected alternatives ("latest promoted infra change for the component"; "any in-flight infra change") are structurally absent: the engine matches an emitted string at a named scope, nothing else. |
| **Timeout: wait forever, warn at a threshold.** Not fail, not proceed. | The existing watchdog, unchanged in mechanism: `waiting: 24h` (matching `validating`, which got 24h for the identical reason — `watchdog.ts:18-21`, "an expected wait, not a stall"), fires **once per state-entry** (guard `:82`, cleared only by `transition.ts:194`), writes Decision + audit + best-effort notification, and **never transitions**. Nothing times out; nothing gives up. We could not build a give-up action honestly even if asked: the executor `abort` verb has **zero engine callers** (`plugin-host/contract.ts:37`; `reconcile.ts:518,629` call only `status()`/`trigger()`), so SCP cannot stop an external run. |

---

## 5. What this deliberately does NOT do

- **No `change_couplings` table.** Charter-violating (principle 2). Not a close call.
- **No new relationship type**, despite the terrain map ranking it the best charter fit. Two independent reasons: (a) **§1.4** — an un-migrated outpost 404s the edge and the 404 aborts the whole signed bundle; (b) a change→change edge is *impossible* for the first-arriver case (you cannot edge to an object that does not exist yet), and a component-level edge is a standing rule that cannot name **which release** — which the owner explicitly rejected.
- **No touch to `correlates` / `coordinated-change` / `changes.correlation_key`.** They stay exactly as dead as they are (§1.1, §1.3). We do not "fix" the GitHub mapper either — repointing `p.ref` would silently re-group shipped (if inert) data for zero P4B benefit.
- **No policy / control / freeze / approval / campaign.** All foreclosed by code, re-verified: CEL has no sibling handle, no host functions (`cel-worker-entry.ts:52` takes two args), no `purpose` in context, and both call sites hardcode `correlationKey: null` (`gate-orchestrator.ts:249,348`); `ensureControlRun` returns the first run's status forever (`control-runner.ts:68-71`), so "infra not ready → fail" caches permanently; freezes are wall-clock with no lift API; approvals are human-only; and campaigns cannot adopt an arrived change, are single-purpose, and **ship past a failed wave** (§1.7).
- **No region concept, no `hosted_on`/`deploys_to` traversal.** `hosted_on` says where a component *runs*, not that its software *waits*; deriving the wait from it would make every component on a target wait on every infra change for that target. `deploys_to` has zero consumers; the infra change already names its scope in `properties.targets`, which the predicate indexes.
- **No purpose in the predicate.** §2.
- **No re-check after release; no post-release rollback repair.** The coupling is a **one-shot precondition pinned in the release Decision**, not a maintained invariant. If the infra is rolled back after the software shipped, P4B does nothing. Forced, not chosen: repairing it means initiating a corrective action nobody asked for (charter principle 1), `abort` has zero engine callers so an in-flight run cannot be stopped, and `promoted` is in **no** sweep pass (all five `listChangeRowsInStates` calls: `reconcile.ts:107,163,229,274,307`). The honest guarantee is *"the prerequisite had succeeded at the instant this released, and here is its id and state"* — weaker than the word "coupled" may suggest, and stated rather than implied. Cascading rollback is a coherent future feature (`reconcile.ts:805-817`'s `rollbackOfObjectId` chase is its shape). It is P4C.
- **No wave/region granularity.** Webhook-born changes have exactly **one wave** (`webhook-processor.ts:114-127` → single target, no topology → `plan-compiler.ts:117-122` → wave 0). The predicate is evaluated once, before wave 0. There is no per-region wave to attach to, `change_waves.name` has zero readers, and `gate_bindings` has no writer at all.
- **No key uniqueness constraint.** `UNIQUE(org, key, scope)` would detect reuse — and would destroy the single best property of the design, that a *failed* infra release can be fixed and re-pushed and the waiter releases unaided. Retry-friendliness and reuse-detection are the same mechanism pointed in opposite directions. We chose retry-friendliness; reuse-detection is a **warn** (§6), not a block.
- **No Decision-flood dedup, no `next_reconcile_at` backoff.** Both were required by designs that hold at the wave gate. We do not hold there, so we do not inherit either bug and will not smuggle a generic fix for freeze/approval blocks into P4B's budget. Those remain live and separately worth fixing.

---

## 6. Failure modes, and what actually happens

| # | Failure | What happens | Verdict |
|---|---|---|---|
| 1 | **A raw GitHub push webhook cannot carry a key.** `mapGithubWebhookEventToHint` (`github/index.ts:222-266`) returns `{repo, commitSha, correlationKey}` from GitHub's own payload — there is nowhere to put a `releaseKey`, and we deliberately do not synthesise one. | The change carries no `requires` → proceeds → **today's fail-open**. The coupled pipelines **must** emit via `scp change-source report` (a CI step), which routes through `genericHint` because it sends no `x-github-event` header (`webhook-processor.ts:57-59`). | **The most important operator fact in this design.** The owner's own words — *"an explicit key both pipelines emit"* — already describe a CI step; a push webhook is not one. Must be the first line of the pipeline-author guide. |
| 2 | **Double ingress.** A repo that keeps its push webhook **and** adds the CI report matches the same `source_mappings` row twice → two changes; the push-born one carries no key and ships in seconds. | The coupled release waits; its unwaited twin ships. | Real trap — but **pre-existing**: such a repo already double-deploys today (two changes, two executor triggers) independent of P4B. Documented, not engineered around. A `source_mappings.requires_report` flag is the mechanical answer and is deliberately out of scope. |
| 3 | **First-arriver: software with key K before any provider exists.** | **It waits.** No special case, no arrival-order bookkeeping — the predicate is simply false right now and becomes true the moment a provider reaches `validating`. | **This IS owner example (1)**, and roughly half of all orderings given "minutes or DAYS apart, in either order". Proceeding here would close nothing. |
| 4 | **Typo'd key** (`feture-a@us-east-1`). | Waits forever, mechanically indistinguishable from a slow prerequisite. `everProvidedAtScope: false` is set at entry; `wait-status` lists the keys actually provided at that scope; the watchdog warns once at 24h. | **Our weakest point.** We have replaced a fast silent *wrong* deploy with a slow silent *absent* one, and the push signal is weak (see #7). The `at` half is protected — a typo there is a **400 at emit** — so the surface is halved, not closed. |
| 5 | **Typo'd scope** (`feature-a@us-east-l`). | **400 at emit.** `getObjectByIdOrUrnAnyType` finds no object. | The concrete payoff of scoping to a resolved object rather than a compound string. |
| 6 | **Prerequisite fails / is cancelled.** | Waiter keeps waiting. Operator fixes and re-pushes; the new change satisfies the same key; **the waiter releases with no action on the waiter**. `wait-status` says *"provider abc123, state `cancelled` — will not satisfy"*. | Correct, and the direct dividend of an existential predicate. The engine cannot abandon a pipeline author's explicit assertion, and has no safe compensating action anyway (`abort` is dead). |
| 7 | **The 24h warn reaches nobody by default.** `seed.ts` configures zero notification bindings, so `dispatch.ts:28`'s loop body never runs. | A `console.warn` + a Decision row. And it fires **once**: `watchdogFlaggedAt` clears only on transition (`transition.ts:194`), and a waiter transitions once — so a 30-day wait shows one 29-day-old warning. | **Pre-existing** (it already applies to every watchdog flag) and not ours to fix here — but it is exactly why the 24h timer is not our primary typo defence. The correct completion is a notification on entering `waiting` with a never-provided key; that needs the binding gap fixed first. |
| 8 | **Key reuse fails OPEN.** CI hardcodes `--provides main`; the first succeeded release satisfies every future waiter at that scope, forever. The gate is decoratively green. | Detected: at release, if **more than one** provider satisfies a requirement, emit `verdict:"warn"` naming them — free from the same query. **Warn, never block** (a hotfix under one release name is legitimate). | The one failure that wears success's mask. The `at` scope bounds the namespace (two teams' `v1.2.3` at different components do not collide) but cannot prevent it. Mitigation is convention + the warn + the pinned Decision. |
| 9 | **Two teams, same key, same scope.** | They are, by construction, releasing against the same component or the same deployment-target. A collision there is a real ambiguity, not a coincidence. | Bounded by #8's scope-namespacing, which is the whole reason `at` is mandatory. |
| 10 | **Mutual deadlock** (A requires K1 provides K2; B requires K2 provides K1). | Both wait forever; both warn at 24h; the cycle is visible in two `wait-status` calls (each names the other, in state `waiting`). | No cycle detection, deliberately: a key with no provider *yet* is indistinguishable from a key in a cycle, because the future provider set is unknowable. Diagnosable, not automatic. |
| 11 | **Federation: the coupling crosses; the satisfier may not.** A software change promoted commander→outpost lands still carrying `requires` and waits **locally**. If that outpost's infra is driven from the commander rather than by a locally-arriving report, no local provider ever exists. | Waits forever. | Correct per-outpost semantics **and** a foot-gun for exactly the hub-and-spoke topology the charter mandates. **This is §8 Q2.** Related: `requires[].at` is an object id, so the scope object must have been synced — if not, no provider can ever target it and the waiter hangs identically. |
| 12 | **Races.** Two replicas both see a waiter as releasable. | The existing per-change advisory lock + a fresh re-check under the lock (`reconcile.ts:407-412`'s established pattern). The routing guard runs inside `advanceCoordinatedChanges`'s existing lock. | Solved machinery, not new. |
| 13 | **>25 simultaneously-releasable waiters.** | Released across successive ticks (~25 / 2-3s), since a released waiter leaves the state and drains the batch. | Benign; a thundering-herd release after a long infra outage is staggered rather than simultaneous. |
| 14 | **Junk `requires` from a version-skewed peer.** | Rejected at write by the tightened `property_schema` on the federation import path (`objects-repo.ts:142`). If it somehow lands, `requiresOf` throws → the change stays `coordinated` → flagged at **5 minutes**. Both layers fail closed. | Fixed the panel winner's SQL/TS inconsistency (its SQL said release, its narrower said throw). |
| 15 | **Adoption is bilateral and unenforced.** A team that ships `--requires` before its partner ships `--provides` parks every one of its releases. | Waits; nothing validates that a required key has a prospective producer (the engine cannot know a pipeline exists until it reports). | The failure lands on the team that did the safety-conscious thing. A `scp doctor` check is the right follow-up and is out of scope. |

---

## 7. Phasing

Each phase is independently shippable and behaviour-preserving.

**Phase 1 — give the CI emit path a contract.** (charter principle 3; valuable on its own, independent of P4B)
Bind the orphaned `ChangeReportRequestSchema` to a new typed `POST /change-sources/{sourceKind}/report`; delete the hand-written SDK wrapper and regenerate; point `scp change-source report` at the generated operation; fix `DESIGN.md:599` / `BUILD_AND_TEST.md:359`. No engine change. Closes a live parity gap that exists today and is a hard prerequisite for Phase 3 — without it, P4B's headline declaration channel has no OpenAPI contract, no generated SDK, and no Zod validation, exactly as P4A's IaC `Campaign.purpose` had none.

**Phase 2 — close the two holes P4B would make load-bearing.** (security; both pre-existing)
`ENGINE_MANAGED_OBJECT_TYPE_IDS = {"change"}` on `routes/objects-generic.ts` (§1.6 — this also closes a **live P4A hole**: `PATCH /objects/change/{id}` can flip a coordinated change's `purpose` mid-flight). `assertChangeTargetsWithinAuthority` on `POST /changes`, a direct copy of `campaign-scope-authz.ts:36-52`. **Compat note, stated rather than buried:** the second is a genuine behaviour change — a proposer holding `object:write` at their domain but not over the declared targets now gets a 403 where they previously got a 201. That is the correct behaviour and matches campaigns, but it is not free, and it deserves its own line in the release notes.

**Phase 3 — the coupling.** The migration, `provides`/`requires`, the narrowers, the `waiting` state + 3 edges, the routing guard, `advanceWaitingChanges`, the predicate, the two Decisions, the 24h SLA, the ingress threading, the UI/CLI state lists, the property-schema tightening, `transitions.integration.test.ts` (the phantom — we edit both halves, so we write it), and the integration suite. **Inert until a pipeline emits a field**: no existing change carries `requires`, nothing derives it, and the no-wait path is one pure property read with zero queries.

**Phase 4 — operator ergonomics.** `scp change wait-status`, `resolveWaitStatus` on `explain`, the "Waiting on" UI panel, `listProvidedKeysAtScope` ("did you mean"), the key-reuse warn, the pipeline-author guide, and the `DESIGN.md` §9.2 corrections.

**Hard dependency (not a phase):** the nondeterministic `source_mappings` match (`correlation.ts:35-46`, no `ORDER BY`; `schema.ts:486-504`, non-unique index) is being fixed in parallel and **must land before Phase 3**. Our predicate does not read `purpose`, so it cannot mis-gate a wait — but the same unordered `SELECT` decides which **target object** a report resolves to, and the region story (§4) depends entirely on the infra repo resolving to `us-east-1` rather than to the component. We need a deterministic, documented tie-break; we do not need a particular one.

---

## 8. Open questions for the owner

Two. Everything else is either answered by the code (§1) or decided above with a stated rationale — including "is the ArgoCD-app change infra or software?", which **§2 makes moot** by refusing to read `purpose` in the predicate at all.

**Q1. Does a software release wait for the infra to have *run successfully*, or for a *human to have signed off* on it?**

We chose **run successfully** (`state ∈ {validating, promoted}`) and §3.3 defends it: `validating` is the state the engine writes with reason *"auto: every wave succeeded"* — the executor ran, the bucket exists — and `promoted` is unreachable without a human (`reconcile.ts:789`), so a `promoted` predicate would insert a mandatory manual click into your fully-automated flow and hang both examples on the happy path. Your own words — *"until the infra gets deployed out"*, *"we'll need the image deployed and available first"* — point the same way.

We ask anyway because this is the one place a wrong read costs a **silent permanent deadlock** rather than a bug, and because an org that genuinely wants *"no software ships until a human signed off on the infra"* is not unreasonable. If you want that, say so and we make it a per-requirement flag (`{key, at, requirePromoted?: true}`) rather than the default — but we would rather not add the knob, because your software change's own `validating → promoted` gate is already where humans sign off, and coupling one release to another release's ceremony is governance by side effect.

**Q2. When a promoted software release crosses into an outpost still carrying `requires`, should it wait again there?**

Our design says **yes, for free**: `properties` cross verbatim (`federation.ts:226` → `promotion-repo.ts:190`), so the waiter re-evaluates against that outpost's **own local** changes. That is correct if regions are outposts and each outpost's infra lands locally — *"the infra landed in us-east-1's outpost, so release the software in us-east-1's outpost"*.

It is a trap if the outpost's infra is driven from the commander: **the coupling crosses, the satisfier does not**, and the release waits forever (§6 #11). The alternative — "it was satisfied upstream; don't re-wait" — is equally defensible and needs `requires` stripped on promotion (~2 lines in `promotion-repo.ts`).

The code takes no position because the concept of a region does not exist in it (`grep -rni region` over the whole source returns exactly one hit — a comment at `packages/schemas/src/federation.ts:18`). Only you know whether your regions are outposts or deployment-targets inside one domain, and this is the one place that distinction changes the mechanism rather than just the naming.
