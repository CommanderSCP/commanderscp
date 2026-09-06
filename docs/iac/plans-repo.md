# plans-repo

Reference for `apps/server/src/iac/plans-repo.ts`. The source carries a one-line headline at each site and points here.

> Partial: 14 of 62 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. Live objects this stack OWNS — the object prune pool

Live objects this stack OWNS — the object prune pool.

Keyed on the server-written `managed_by_stack` column (drizzle/0068), NOT on `labels @> {"scp:managed-by":"iac","scp:stack":…}` as it was until then. That containment test read a map the prune target itself could write under plain `object:write`, so two label keys put an arbitrary object into this delete pool — or took an object out of it, so its own stack could never decommission it. `iac/stack-ownership.ts` has the full account.

## §2. Bindings THIS stack owns (drizzle/0108)

Bindings THIS stack owns (drizzle/0108). The `managed_by_stack` predicate is the whole safety property of IaC-managed authority: a binding granted through `POST /role-bindings` carries NULL, never matches, and therefore cannot be revoked by any manifest.

Joined to `roles` for the NAME, because a manifest declares a role by name and the diff has to key on the same thing the author wrote.

## §3. A role binding names TWO objects and OWNS NEITHER

A role binding names TWO objects and OWNS NEITHER. Unlike every collection above — where the referenced object is the row's owner and the stack declares it — a binding points at a subject and a scope that almost always live outside this stack (a user, an org root, somebody else's service). They are added here so `endpointId` can resolve them at apply; ownership is unaffected, and `computePlanDiff` never treats them as objects this stack manages.

## §4. THE BINDING POOL SPANS OBJECTS *AND* PLACEMENTS

THE BINDING POOL SPANS OBJECTS *AND* PLACEMENTS. `executor_bindings.target_object_id` points at either, and a placement is not in `manifest.objects` (that door refuses pair-bound types, #207), so keying the pool on owned OBJECTS alone made every binding on a placement invisible to the diff: unadoptable (a re-plan proposes it forever) and unprunable. Sequenced after the placement read rather than folded into the Promise.all above, because the placement ids ARE the extra targets — the dependency is real, not incidental ordering.

## §5. THE PRUNE POOL

THE PRUNE POOL — DROP, and here the claim holds. This pool decides what gets RETRACTED. A declaration whose producer cannot be named is one this plan can neither honestly report a prune of (the reviewed entry names the producer LOSING the coordinate) nor prove ownership of, since ownership is inherited from a component that is no longer there. Dropping it means the retraction does not happen: inaction, and the coordinate keeps the behaviour it has today.

## §6. THE EXISTENCE POOL

THE EXISTENCE POOL — KEEP, ALWAYS. This pool answers "does this coordinate already have a holder", and the answer is YES whether or not the holder can be named: the row is live and the next declaration is an upsert straight over it. Dropping it made the diff emit a `create`, whose reason sentence tells the reviewing operator the coordinate "is polled as third-party today" — so the plan inverted its own most consequential fact and the apply performed an unreviewed overwrite. Keeping the row under `unresolvedProducerUrn` makes it an `update` that NAMES the situation, which `invalidProducerDeclarations` refuses in its own branch.

## §7. ROLE BINDINGS AND ORG ROLES

ROLE BINDINGS AND ORG ROLES (drizzle/0108). Read UNCONDITIONALLY for the reason the rollout pool gives: absent means empty for both, so a prune is always in scope and a pool we skipped reading would make every prune a silent no-op.

SCOPED TO THIS STACK'S OWN ROWS. `managed_by_stack = :stackName` is the whole safety property: a binding granted through `POST /role-bindings` carries NULL, is invisible here, and therefore cannot be revoked by any manifest.

## §8. §9 — STACK THEFT IS A 409, NOT AN INTERNAL ERROR

§9 — STACK THEFT IS A 409, NOT AN INTERNAL ERROR. `computePlanDiff` throws a typed `StackOwnershipConflictError` when the manifest names an object another stack manages; without this mapping it would surface as a 500 and read as a server fault rather than the deliberate refusal it is. Adoption of an UNMANAGED object is untouched and stays legal — that is how an existing estate comes under IaC in the first place.

## §9. ROLE BINDING ENDPOINTS

ROLE BINDING ENDPOINTS. A binding names two objects and OWNS NEITHER — the subject and the scope almost always live outside this stack — so they are resolved here rather than falling out of the object loop above, which only walks objects the manifest DECLARES. Without this `endpointId` throws at apply and the whole plan 500s, which is exactly what it did.

No authorization check is attached: writing a binding is not writing the subject or the scope, and demanding `object:write` on them would refuse every legitimate grant to a user this stack does not manage. The authority question is the subset rule, which `createStackManagedRoleBinding` asks at the moment of the write.

## §10. RESOLVED BUT NOT CHECKED

RESOLVED BUT NOT CHECKED. `endpointId` throws an INTERNAL error for a URN this pass did not resolve, and the deployment-target may legitimately belong to another stack — so a placement at a foreign target used to fail apply with "internal: could not resolve object id". No `object:write` is pushed for it deliberately: ownership follows the COMPONENT (decision Q4), and demanding write on the target would hand every deployment-target owner a veto.

## §11. OWNERSHIP, STAMPED FOR EVERY OBJECT THIS MANIFEST DECLARES

OWNERSHIP, STAMPED FOR EVERY OBJECT THIS MANIFEST DECLARES (drizzle/0068). One statement, and one rule: a stack owns exactly the rows its manifest declares, plus the rows it already owned.

`noop` counts, and that is the case worth stating. A declared object that happens to be byte-identical to what is stored is still an object this stack declares — skipping it because "nothing changed" would leave it undeletable by the stack that owns it, which is the escape direction of the very defect this replaces, arrived at by accident. Under the old label scheme this was accidentally handled: adopting an object rewrote its labels, so it was never a noop on the apply that adopted it. Ownership is now explicit rather than a side effect of a label merge, so it has to be said.

`delete` entries are excluded by construction — they are not in this list — and ownership is never CLEARED here: a row leaves a stack by being pruned, not by being disowned into an orphan no stack could ever clean up.

## §12. C1 — projection rows

C1 — projection rows. These run AFTER object creates (a binding needs its deployment-target / a mapping needs its component to exist) and BEFORE object deletes. The delete ordering is load-bearing, not cosmetic: `deleteObject` is a SOFT delete, and both projection tables are keyed on the object id with no `deleted_at` of their own. Prune the object first and its rows become permanently unreachable garbage — invisible to every list query (they filter on a live target) and outside every future plan's ownership pool (which is built from LIVE labelled objects), so nothing would ever remove them.

Deletes before creates/updates, mirroring the relationship ordering above and for the same reason: `UNIQUE (org_id, target_object_id, type)` means two bindings swapping Types in one plan would collide if the creates ran first.

## §13. ROLLOUTS AND CONVERGENCE

ROLLOUTS AND CONVERGENCE (D12/D25(b); migration 0106) — the writes that end the drop. Deletes first, then upserts, mirroring the hook block above so a same-key delete+create in one plan cannot land in the order that leaves nothing behind.

`update` IS APPLIED HERE TOO, unlike hooks, which have no update action: a rollout's identity is `(component, targetClass)` and the strategy is its VALUE, so a changed strategy is one row changing. Treating it as a delete+create would imply a window with no strategy at all.

## §14. ROLE BINDINGS AND ORG ROLES

ROLE BINDINGS AND ORG ROLES (drizzle/0108) — through the REAL doors, never around them
Every refusal the typed route enforces applies here unchanged, because this calls the same functions: the no-escalation subset rule, `bindable_at`, D5's Administrator deprecation, the administrative floor on delete, and the org advisory lock. That is deliberate and is the whole reason this is not a direct insert — an IaC path that wrote `role_bindings` itself would be a second door with its own drift, and the guard census this milestone paid for would be wrong.

THE APPLYING PRINCIPAL IS `actorObjectId`, which for a config-source sync is the TEAM object (ADR-0046 §1 / D9). So a team's own repo cannot grant that team authority it does not already hold — the subset rule refuses it. Stated because the symptom (an apply refusing a line the author believes correct) is otherwise hard to attribute.

ROLES BEFORE BINDINGS on the create side: a binding may name a role this same manifest authors, and `getRoleByName` has to find it. Deletes run in the opposite order for the mirror reason — the role delete door refuses while a binding still points at the role.
