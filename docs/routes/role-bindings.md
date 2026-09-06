# role-bindings

Reference for `apps/server/src/routes/role-bindings.ts`. The source carries a one-line headline at each site and points here.

> Partial: 5 of 20 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. A BUILT-IN IS NOT EDITABLE THROUGH ANY ORG'S API

A BUILT-IN IS NOT EDITABLE THROUGH ANY ORG'S API. `roles`' RLS admits `org_id IS NULL` for reads, so `getRoleById` legitimately returns a shared singleton — and editing one would rewrite the permission set of every org on the deployment at once. `updateRole`'s `org_id` predicate makes it unaddressable anyway; this refusal exists so the answer is a stated 403 rather than a confusing 404.

## §2. REFUSES WITH BINDINGS, rather than cascading

REFUSES WITH BINDINGS, rather than cascading. `role_bindings.role_id` is a plain FK, so a cascade here would silently revoke authority from every holder in one request with one audit event naming the ROLE and not the principals — an unreviewable mass revoke wearing a tidy-up's name. The same shape as the containment rule that refuses to delete a container with children: the caller revokes the bindings first, and each revoke is its own audited, floor-checked decision.

## §3. §2d — THE PROJECTION FILTER

§2d — THE PROJECTION FILTER. Applied to the CLOSURE, not to the walk: the walk has to see everything (it is the same set the 409 compares against, and a filtered walk would make `withheldPrincipalCount` unknowable), and only the RESPONSE is narrowed. Costs one query for the caller's readable roots and nothing more for an org-root reader, which is the caller D7 is for.

## §4. 3 — the two objects

3 — the two objects. `getObjectByIdOrUrnAnyType` refuses a SOFT-DELETED row by default, which matters on both sides: a binding at a tombstoned scope is unreachable authority nobody can revoke (this module's §5), and a binding to a tombstoned subject is a grant to a principal that has been removed. A uuid is required by the schema, so the id-or-URN helper is only ever handed an id here.

## §5. THE ADMINISTRATOR FLOOR

THE ADMINISTRATOR FLOOR (`docs/authz/role-binding-door.md` §7) — DELETE FIRST, THEN ASK.

This used to be `assertNotLastAdministrativeBinding`, evaluated BEFORE the delete and excluding this row from its own count. That shape is why the floor guarded exactly one of the three doors that can empty an org's administrators: a rule phrased as "what would be left if I removed THIS binding" has to be re-derived, correctly, by every other door — and `DELETE /relationships/{id}` (remove the `member_of` edge under a group's binding) and `DELETE /objects/team/{id}` (tombstone the group holding it) each bricked an org in four plain sequential requests while this guard counted the surviving row and reported success.

The predicate is now the ORG's invariant, evaluated after the mutation and blind to which verb ran, and `graph/relationships-repo.ts` and `graph/objects-repo.ts` call the SAME function. AFTER both authority bars still holds: an actor with no standing must get a 403 about their standing, not a 409 disclosing how many administrators this org has left.

INSIDE this `withTenantTx`, so a refusal rolls the DELETE back with it — the row survives and the org stays administrable. The relevance test below is the cost short-circuit §7 documents; it is a statement about the floor's four inputs, not a filter over callers.
