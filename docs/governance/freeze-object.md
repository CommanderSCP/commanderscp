# freeze-object

Reference for `apps/server/src/governance/freeze-object.ts`. The source carries a one-line headline at each site and points here.

> Partial: 3 of 9 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. THE SNAPSHOT THAT TRAVELS

THE SNAPSHOT THAT TRAVELS — every field `rebuildFreezeProjectionFromObject` needs to reconstitute an enforceable row, and nothing else.

`scopeObjectUrn` rides ALONGSIDE `scopeObjectId` rather than instead of it. Ids are preserved verbatim by federation import (`import-repo.ts` passes `payload.id` through), so the two normally agree — but the urn is what survives `upsertObjectByUrn`'s hand-fill reconciliation, which REPLACES a locally-generated placeholder id with the authoritative one. Carrying only the id would leave a freeze pointing at a scope that had since been re-keyed.

`liftedAt`/`liftReason` are part of the snapshot because a lift MUST reach downstream. Without them a commander could declare a freeze at an outpost and never retract it there — M25.1's "a surface with an entrance and no exit" defect rebuilt one boundary over, and worse, because the replica guard deliberately refuses the outpost a local exit.

`createdByActorId` travels for explainability only. It names an actor object that does not exist at the receiving instance, which is fine — the column has no FK, for the same reason `lifted_by_actor_id` has none.

## §2. THE IMPORT SIDE

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

## §3. THE TOMBSTONE SIDE

THE TOMBSTONE SIDE — WHAT STOPS AN IMPORTED FREEZE BLOCKING FOREVER
Lifts the projection row of a `freeze` object that a peer has tombstoned. Called from `federation/import-repo.ts`'s `object_tombstone` branch.

WITHOUT THIS THE TOMBSTONE IS A ONE-WAY DOOR IN THE WORST DIRECTION. `object_tombstone` used to soft-delete the `objects` row and stop, which is correct for every type whose object IS the record — but a freeze's enforcement lives in `freezes`, and nothing there reads `objects`. So the projection row survived its own wire form: `activeFreezesInWindow` kept returning it, every gate and per-target admission kept refusing on it, and it was UNLIFTABLE — `lockFreezeRow` refuses a local lift because the object's origin domain is foreign, and the declaring domain had already spent the only verb that reaches here (a re-snapshot needs a live object to re-snapshot). A commander deleting a freeze object would have permanently frozen its outposts.

A LIFT, NOT A DELETE, for the reason M25.1 settled for the local verb: a lift is SOFT because `gate` and `freeze_admission` Decisions cite `freeze.id` in their `inputContext` forever and that citation has to keep resolving (charter principle 6). Deleting the row would break the explanation of blocks that already happened.

ALREADY-LIFTED ROWS ARE LEFT ALONE (`lifted_at IS NULL` in the WHERE). The first lift is the one that stopped enforcement; overwriting its timestamp and its declaring domain's own reason with a later tombstone would rewrite history to no effect — the freeze is already not in force.

SCOPED TO THE ROW THIS OBJECT OWNS (`object_id = <object>`), the same guard the rebuild's update arm carries, so a tombstone can never reach a locally-authored freeze.
