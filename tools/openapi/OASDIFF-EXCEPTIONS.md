# oasdiff breaking-change exceptions

The `/v1` API is additive-only; `tools/openapi/check.sh` runs `oasdiff breaking` between the
committed spec at the merge base with `main` and the freshly emitted spec, and fails on any
ERR-level (breaking) change. That gate is **not** self-overriding — `check.sh`'s own header records
that an intentional breaking change requires an explicit **`api-v2-exception`** label + review
(BUILD_AND_TEST.md §7 "API breaking change" row, `.github/workflows/ci.yml`). This file is the
durable record of each such exception so the label is never a mystery in the git history.

## Log

### ADR-0007 — executor binding `purpose` → Type taxonomy (2026-07-17)

**Spec:** [docs/adr/0007-executor-binding-type-taxonomy.md](../../docs/adr/0007-executor-binding-type-taxonomy.md),
[docs/proposals/executor-type-taxonomy.md](../../docs/proposals/executor-type-taxonomy.md).
Migration: `apps/server/drizzle/0026_executor_binding_type.sql`.

**What breaks (deliberate, one-time):** the flat routing key `purpose ∈ {infra, software}` is
replaced by the two-level Category/Type taxonomy and the wire field is renamed `purpose → type`. In
**request** positions this is oasdiff-breaking:

- `?purpose=` query params renamed to `?type=` on `GET/DELETE/PATCH /executors/{idOrUrn}/binding`
  (parameter removed + added; enum values `infra`/`software` removed).
- request-body property `purpose` renamed to `type`, with the enum changed from
  `{infra, software}` to `{image, rpm, deb, npm, infrastructure, configuration}`, on
  `POST /changes`, `POST /campaigns`, `POST /change-sources/{sourceKind}/mappings`, the discovery
  `sourceMappings[]`, and `PATCH /executors/{idOrUrn}/binding`.
- response field `movedBindingPurposes` renamed to `movedBindingTypes` on `POST /components/{idOrUrn}/merge`.

Additive-in-response parts (the new `type`/`category` fields on binding / source-mapping /
wave-target responses) are **not** breaking.

**Why it is acceptable here:** owner decision D3 (ADR-0007) — a hard cutover with no legacy aliases,
safe because there is a **single instance** (homelab) and therefore no federation version-skew and
no external SDK consumer to break. This is explicitly **not** a precedent for post-GA `/v1`
breakage; a post-federation cutover would instead require a lockstep fleet upgrade.

**How the gate is satisfied:** the PR carries the **`api-v2-exception`** label; reviewers approve the
break against this record. `check.sh` still reports the breaking change (by design) — the label is
the branch-protection override, not a suppression in the script.

### ADR-0021 D5/D6 — change-lifecycle `promote` → `accept`, service-board `stage` → `wave` (2026-07-25)

**Spec:** [docs/adr/0021-terminology.md](../../docs/adr/0021-terminology.md) D5 (the `promote` →
`accept` rename) and D6 (`stage` vs `wave`); vocabulary fixed by
[docs/GLOSSARY.md](../../docs/GLOSSARY.md). Migration:
`apps/server/drizzle/0039_change_state_accepted.sql`.

**What breaks (deliberate, one-time):** two independent renames land in one batch, because they
would otherwise cost two separate `/v1` exceptions for one vocabulary decision.

*D5 — the change-lifecycle approval gate:*

- **Route path renamed:** `POST /v1/changes/{id}/promote` → `POST /v1/changes/{id}/accept`
  (path removed + added).
- **`operationId` renamed:** `promoteChange` → `acceptChange`, which renames the generated SDK
  operation and every derived type (`PromoteChange*` → `AcceptChange*`).
- **`ChangeState` enum value renamed:** `promoted` → `accepted`. This enum appears in a **response**
  position on every change-bearing payload — `GET/POST /changes`, `/changes/{id}`,
  `/changes/{id}/explain`, `/changes/{id}/cancel|accept|rollback`, and the campaign rollback
  response's nested `rollbackChange` — and as a **request** value on `GET /changes?state=`.

*D6 — the service release board (`GET /v1/services/{idOrUrn}/board`), response body only:*

- Response field renamed `currentStage` → `currentWave`.
- Response field renamed `stages` → `waves`.
- The element schema behind that array is renamed `ServiceBoardStageSchema` → `ServiceBoardWaveSchema`
  (exported type `ServiceBoardStage` → `ServiceBoardWave`), which renames the inlined object in the
  emitted spec and its generated SDK type.

**Why it is acceptable here:** the same single-instance reasoning ADR-0007 relied on still holds,
and it was re-checked against the deployment as it stands today rather than inherited — owner
decision O1, 2026-07-24. CommanderSCP runs as **one instance** (the homelab k3s deployment). There
is no second instance to skew against, so no federation peer can be on the other side of the
rename; the journal exchange carries graph objects and status, not this route or this enum's
spelling. There is **no SDK consumer outside this monorepo** — the CLI, the IaC package and the web
UI are the only callers, they consume the generated SDK exclusively (charter principle 3), and all
of them ship from the same commit as the server. So the window in which an old caller could meet a
new server does not exist, which is exactly the condition that would otherwise force an
expand/contract with a dual-accept period. The rename is therefore done **in place, single-phase**,
with no legacy alias and no deprecation window (ADR-0021 D5, and the migration's own header).

The cost argument for paying it now rather than later is in ADR-0021 D5: the price of this rename
only grows — with each additional deployment, each additional SDK consumer, and each additional
month of documentation written in the old vocabulary. Pre-1.0 with one instance is the cheapest
this will ever be. As with ADR-0007, this is **not** a precedent for post-GA `/v1` breakage.

**How the gate is satisfied:** the PR carries the **`api-v2-exception`** label; reviewers approve
the break against this record. CI job **3b (oasdiff)** reports the breaking change and goes red —
that is the designed, approved outcome, not a failure to fix. `check.sh` is not suppressed,
bypassed, or edited; the label is the branch-protection override. Job **3 (codegen drift)** must
still be **green** — the regenerated `tools/openapi/openapi.v1.json` and `packages/sdk/src/generated/*`
are committed in this PR.
