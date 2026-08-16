# ADR-0034 — Remove the `initiative` object type

**Numbering note (2026-08-16):** written as ADR-0032 on the `claude/ui-review-worktree-efc42b` branch; main took 0032 for dependency subscriptions (#236, 2026-08-15) before this branch merged, so this ADR is **0034** (0033 is the loud depth bound). Every reference on the branch was updated in the same commit.

**Status:** Accepted (owner instruction, 2026-08-10 — explicit, given after the charter and API-gate consequences below were put in front of them).
**Supersedes:** the Initiative Model / Initiative Structure sections of PROJECT_CHARTER.md, and DESIGN.md §9.5's initiative half.

## Context

An **initiative** was the portfolio rung above campaigns: a strategic objective — the charter's examples were Cloud Modernization, FedRAMP Certification, Data Center Exit, Platform Standardization — grouping campaigns through `coordinates` edges, with a status **always derived by traversal and never stored** (`graph/named-queries.ts`'s `initiative-rollup`, over `campaign-status.ts`'s pure `computeInitiativeRollup`).

The rung shipped in M5 alongside campaigns. Measured at removal time, it carried:

| Surface | What existed |
|---|---|
| API | `POST/GET /initiatives`, `GET /initiatives/{id}`, `POST /initiatives/{id}/campaigns` |
| Graph | `initiative` object type; `coordinates` widened to admit `initiative -> campaign`; the `initiative-rollup` named query |
| SDK / CLI | `client.initiatives.*`; `scp initiative create/list/status/add-campaign` |
| IaC | `Initiative` / `InitiativeProps` constructs |
| UI | `/initiatives` list and detail pages, plus a nav entry |

What it did **not** carry is the point: no plan, no waves, no gates, no execution, and no stored state of its own. Every actuator lived one rung down on the campaign. An initiative was a read-only view over campaign status wearing a first-class object type.

## Decision

Remove the concept entirely — graph type, API, SDK, CLI, IaC construct, UI and docs — rather than deprecate it in place.

## Consequences

### This is a breaking `/v1` change, and it needed the owner

CLAUDE.md holds `/v1` **additive-only**, enforced by CI job `3b. API breaking-change gate (oasdiff, /v1 additive-only)`. Removing four paths and an enum member from `/graph/query/{name}` is breaking on both counts. The workflow's documented escape is the **`api-v2-exception` label**, appliable only by a user with write access — so merging this requires that label, deliberately, by a human. That gate is doing exactly its job here: it forced the break to be a decision rather than a diff.

`Initiative` was also a **public IaC construct**. Any user stack importing it fails to compile after upgrade. There is no shim.

### The charter changed

PROJECT_CHARTER.md listed `Initiative` among the concepts "expected to remain stable" in the core object model. The charter governs where anything conflicts with it (CLAUDE.md), so removing the type required editing the charter itself, not working around it. Both dedicated charter sections are deleted and every enumeration updated.

### `coordinates` survives, narrowed — the trap in this change

`coordinates` was seeded (migration `0002` §5) as `['campaign','initiative'] -> ['change','campaign']`, which is **two distinct memberships sharing one relationship type**:

- `initiative -> campaign` — the rung being removed;
- `campaign -> change` — **still load-bearing**. `coordination/campaign-reconcile.ts` writes one per fanned-out member change, and campaign rollback reads membership to decide what to revert.

Dropping the type with the concept would have silently broken every campaign on the instance. Migration `0056` therefore narrows it to `['campaign'] -> ['change']` and keeps it. Narrowing `to_types` also retires the `campaign -> campaign` combination the old arrays permitted; nothing ever wrote one — it existed only as an artefact of two memberships sharing a row.

The system-managed guarantee on `coordinates` (refused on both `POST /relationships` and the IaC apply path, because an injected edge could sweep an arbitrary Change into a victim campaign's rollback) is **unchanged**. Its IaC-side test moved from the removed `Initiative` construct onto `Campaign`, because the property was always about `coordinates`, not about what sat above a campaign.

### Tenant data is deleted

Migration `0056` hard-deletes every `initiative` object in every org, its `coordinates` membership edges, any other edge touching it, and orphaned `object_health` / `role_bindings` / `freezes` rows scoped to one. A type row cannot be dropped while objects reference it, so this is unavoidable for a removal; it is recorded here because a reader should not have to infer from a schema diff that a `DELETE` ran against tenant data.

Campaigns are untouched. An initiative's only relationship to a campaign was membership, so removing the grouping strands nothing beneath it.

The migration is **idempotent** — verified by applying it twice against a database seeded with an initiative, its `coordinates` edge and a freeze scoped to it.

### What replaces it

Nothing. If portfolio grouping returns, it should return as **campaign metadata or a label-based view**, not as a first-class object type — the removal's whole finding is that a rung with no plan, no waves and no execution does not earn one. Whatever grouping ships next also inherits an open question this rung never answered: what a team is supposed to *do* with a strategic objective beyond read it.
