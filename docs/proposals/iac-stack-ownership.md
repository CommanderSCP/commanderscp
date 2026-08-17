# IaC stack ownership belongs in a column, not in `labels`

**Status:** v0.1 Draft — **proposed, pending review.** The code in the accompanying PR implements §4; §6 is what it deliberately does not do.
**Relates to:** [ADR-0003](../adr/0003-internal-egress-for-execution-systems.md) (declaration-grants-nothing), [ADR-0026](iac-placements.md) (placement ownership follows the component), [ADR-0031](../adr/0031-domain-local-objects-never-federate.md) ("authorization at the door, invariant at the repo"), and the governance-label-namespace proposal whose census §8.3 is this item.

---

## 1. The defect

`iac/plan-diff.ts`'s `isStackManaged` and `iac/plans-repo.ts`'s
`labels @> {"scp:managed-by":"iac","scp:stack":"<name>"}` decided the IaC **prune pool** — which live
objects and relationships an apply DELETES — by reading two keys out of the row's own `labels` map.

Two permissions met at that comparison, and they were not the same size:

| Act | Permission required, before this change |
|---|---|
| Author and apply a stack's desired state | `object:write` (or `policy:write` / `federation:write`, per `writePermissionFor`) at **every object the manifest touches**, plus `relationship:write` at both endpoints of every edge |
| Write the two keys that decide what that apply deletes | `object:write` **at the one object**. No schema — every type registers `labels` with none — no reserved namespace, no prefix rule, no validation of any kind |

Both directions were reproduced through real HTTP doors before the fix
(`apps/server/src/iac/iac-stack-ownership.integration.test.ts` is those reproductions with their
expectations inverted):

**Enrolment.** An Operator bound at ONE object — `object:write` there and nowhere else, no IaC
authority, no plan permission — issues one `PATCH /api/v1/objects/service/{id}` with
`labels: {"scp:managed-by":"iac","scp:stack":"<victim stack>"}`. That stack's **unchanged** manifest
then plans a `delete` for the object, and the apply executes it:

```
{ "kind": "object", "action": "delete",
  "urn": "urn:scp:…-victim:service:victim", "typeId": "service",
  "reason": "previously managed by this stack, no longer present in the desired manifest" }
```

The reason is **false** — the stack never managed it — and it is the only thing a plan reviewer has
to go on. The delete also takes the object's `source_mappings`, `placements` and `executor_bindings`
with it, because those pools are keyed on owned object ids.

**Escape.** The object's owner strips the two keys with a full-replacement `labels: {}`. The object
leaves the pool, so when its stack later drops it from the manifest to decommission it, the plan
proposes **zero deletes** and the object survives its own decommission. No error, no Decision,
nothing in the diff to notice — the same silent shape as the selector-label evasion.

**Fail direction, measured:** absence of the marker **orphans, it never deletes.** An unowned row is
untouched by every stack. That bounds the severity — the escape direction is a silent survival, not
a silent deletion — and the regression suite pins it so it cannot start meaning "prune it".

## 2. The property

> **A governance decision whose match key is writable by its own subject, at a strictly weaker
> permission than the one that authored the constraint.**

## 3. Why a column and not a reserved label namespace

The reserved `scp.governance/` namespace fixes the two instances where the match key is written by
an **authority** — an operator holding org-root `policy:write` — so a permission bar is the right
shape for it. Its own census says this instance is "not fixable with this namespace", and the reason
is worth stating rather than inheriting: **stack ownership has no such principal.** It is stamped by
an apply as a consequence of what a manifest declares, and there is no permission that should let
anyone type it directly. The honest encoding of "not tenant data" in this schema is a column —
`origin_domain_id`, `provenance`, `revision` and `domain_local` all already say exactly that by
being columns rather than map entries.

A namespace would also have cost what the column gets for free. **`labels` federate.** A peer's
object carrying `scp:stack=X` arrived here as a replica still carrying it and joined a local stack
named X's prune pool — where `deleteObject` refuses a replica with a 409 and aborts the whole apply.
One domain could wedge another's IaC. `managed_by_stack` is absent from the journal payload, so a
replica arrives owned by nobody, which is the truth.

**Rejected: reserving `scp:managed-by`/`scp:stack` as server-managed label keys.** No migration, and
it does put the value out of tenant reach — but every full-replacement `PUT`/`PATCH` on an
IaC-managed object omits those keys, so it is either a 403 on ordinary editing of a large fraction of
the estate, or a silent re-merge, and the two representations (a key that looks like tenant data and
behaves like a system column) stay fused. Against decision priority #1 the column is one statable
sentence: *`managed_by_stack` is written by the IaC apply and by nothing else.*

## 4. What the PR changes

**4a. The column.** `objects.managed_by_stack` and `relationships.managed_by_stack`
(`drizzle/0068`), nullable, with a partial index for the pool lookup.

**4b. One writer.** `iac/stack-ownership.ts`, called only from `executePlanDiff`. No route passes
it; no request body can express it. Both statements are a single bulk `UPDATE` with
`IS DISTINCT FROM`, so an apply that changes no ownership writes no rows.

**4c. The read path.** `fetchManagedObjects`/`fetchManagedRelationships` select on the column, and
`isStackManaged`'s signature changed from a labels map to `string | null` — so a caller cannot re-key
it on labels by mistake and still type-check. `ExistingObjectSnapshot` gained a required
`managedByStack`, which made the compiler census every snapshot construction site.

**4d. The marker labels stay, explicitly demoted.** They are still written, so operators, dashboards
and `scp` output keep the marker they already grep for; they are documented at every site as a
**descriptive mirror that decides nothing**. They are self-healing rather than protected: a tenant
edit makes the row's labels differ from what the manifest merges, so the next plan diffs it as an
`update` and the apply rewrites them. Between those moments the label can mislead a human; it can no
longer mislead the diff. Every doc comment that called them "the pruning convention" —
`packages/schemas`'s `iac.ts` and `graph.ts`, `packages/iac`'s `construct.ts`,
`graph/relationships-repo.ts`, `db/schema.ts` — was rewritten, because a comment asserting the old
rule is exactly what talks the next reader into reinstating it.

**4e. The backfill is a one-time snapshot of what the old code already trusted** — deliberately, and
not an endorsement of it. Deriving the column from the labels preserves every estate's current prune
pool exactly: no stack silently loses the ability to converge, and none silently gains a delete
candidate. Whatever poisoning predates the migration is carried over once and then frozen, because
from there the column moves only when an apply moves it. Starting every column `NULL` would empty
every prune pool in the estate on upgrade — the loud-but-wrong failure, where the next
decommissioning apply reports nothing to do.

## 5. Two things this fixes rather than merely preserves

**Adoption is now explicit for every non-delete diff entry, `noop` included.** It used to be a side
effect of merging the marker labels, which meant a declared object that was already byte-identical
was never a `noop` on the apply that adopted it — so nothing had to think about the case. With
ownership explicit, skipping `noop` would leave an object declared-but-unowned: undeletable by the
very stack that declares it, i.e. the escape direction reached by accident. It is stamped.

**Only relationship CREATES were ever labelled.** An edge a manifest declared that some other door
had already written — `POST /components` writes a `contains` edge — stayed declared-but-unowned
forever and could never be pruned by the stack that declared it. Objects never had that gap. Both
halves now stamp every non-delete entry, so the two agree.

## 6. What this deliberately does not do

**It does not restrict who may write the marker labels.** They are ordinary tenant data now and stay
that way; refusing them would rebuild the fix as the namespace rule §3 rejects.

**It does not expose `managed_by_stack` on the API.** The prune pool is internal and the change is
zero-drift against the committed OpenAPI spec. Surfacing it (so an operator can ask "which stack owns
this?" without reading a possibly-stale mirror) is a small additive follow-up, listed here rather
than taken, because it is a capability decision and not part of closing the hole.

**The residual is the same one the label-namespace work names:** ownership is now immovable, and the
object can still be **moved**. A stack's reach is what its manifest declares, and a subject holding
`relationship:write` can still re-parent itself out from under a containment-scoped decision. That is
a strictly larger decision (authorize at both the old and the new container, which touches every
typed route) and is filed separately.
