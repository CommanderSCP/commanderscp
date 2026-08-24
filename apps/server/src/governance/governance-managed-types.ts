/**
 * Object types the governance subsystem owns end to end (DESIGN §10.1/§10.2): `policy` documents
 * bind their DECLARED `properties.scope` to the author's own authority
 * (governance/policy-scope-authz.ts, CRITICAL #1b); `control` documents are the entries a policy's
 * `requireControls` effect can reference. Both are gated behind `policy:write` — never the generic
 * `object:write` every other typed resource uses (routes/typed-registries.ts's
 * `GOVERNANCE_TYPED_REGISTRY_RESOURCES`).
 *
 * Single source of truth for every write path that must special-case these types instead of
 * treating them like an ordinary graph object (security fast-follow after PR #9's adversarial
 * review found the generic `/objects/{type}` endpoint and the IaC plan/apply path both skipped
 * this entirely — a live governance bypass):
 *  - `routes/objects-generic.ts` refuses to create/update/delete these types at all, routing
 *    callers to the typed `/policies`/`/controls` resources instead.
 *  - `iac/plans-repo.ts` enforces the same `policy:write` permission (and, for `policy`, the same
 *    `assertPolicyScopeWithinAuthority` scope binding) a client-controlled manifest could
 *    otherwise use to plant an org-wide policy through `POST /plans` + `.../apply`.
 *
 * Adding a new governance-owned type later means updating this one set and re-checking the two
 * call sites above — not re-auditing every write path in the codebase from scratch.
 *
 * ===========================================================================================
 * THERE IS A THIRD WRITE PATH, AND THIS DOCBLOCK DID NOT ENUMERATE IT (M22.6, ADR-0033 §8)
 * ===========================================================================================
 * `federation/import-repo.ts`'s `object_upsert` branch reaches `createObject`/`updateObject` with a
 * free-form `typeId` and free-form `properties`, and it is NOT covered by either bullet above. That
 * is not a hole: it is a deliberate, narrow exemption whose reason is structural — that branch has NO
 * try/catch, so a throw there aborts the peer's ENTIRE signed bundle and wedges the channel. An
 * authoring-time refusal belongs at the AUTHORING instance; by the time a row arrives here it has
 * already been signature- and chain-verified, and `graph/objects-repo.ts` records who authored it.
 * The same reasoning is written out at length in `dependencies/subscription-guard-write-doors.
 * integration.test.ts`, and its census found `federationImport` set by exactly two modules —
 * `import-repo.ts` and `federation/handfill-repo.ts` — of which hand-fill is a LOCAL operator action
 * with no channel to wedge and therefore does NOT get the exemption.
 *
 * It is named here because the previous version of this docblock said "the two call sites above" and
 * a reader adding a fourth governance type would have gone looking for two doors and found three.
 * `governance-managed-write-doors.integration.test.ts` now enumerates every id in this set against
 * every door, so the count cannot silently go stale again.
 */
export const GOVERNANCE_MANAGED_OBJECT_TYPE_IDS: ReadonlySet<string> = new Set([
  "policy",
  "control",
  /**
   * M22.6 (ADR-0033 §6a) — a `scan_override_grant` is a standing, expiring authorization to TOLERATE
   * A KNOWN VULNERABILITY. Its `properties` carry the component it excuses, the finding, the tier
   * whose authority approved it and its expiry; a holder of plain `object:write` at that component
   * writing any of those directly would be granting themselves the waiver they are supposed to be
   * requesting. That is the identical shape `policy.properties.scope` has, so it gets the identical
   * treatment: refused on the generic `/objects/{type}` endpoint, and `policy:write` (not
   * `object:write`) through the IaC plan/apply path.
   *
   * The typed routes (`routes/scan-override-grants.ts`) are the only local authoring door, and they
   * split the permission the way D3 requires — `object:write` at the component to RAISE a request,
   * `policy:write` at the named tier object to APPROVE, deny or revoke one.
   */
  "scan_override_grant",
  /**
   * M25.7 (owner decision D6, ADR-0043) — a `freeze` object is the WIRE FORM of a freeze window: it
   * rides `object_upsert` to this org's peers, and `federation/import-repo.ts` rebuilds a `freezes`
   * projection row from it at every receiving instance, which is what makes it BLOCK there.
   *
   * So a caller who can mint one through a door that takes a free-form `typeId` can stop releases
   * in ANOTHER SECURITY DOMAIN — and, without this entry, could do it holding nothing but plain
   * `object:write` at their own domain. That is a wider blast radius than the `policy` hole this
   * set was created for, and it arrives with the same shape: authority carried in `properties`
   * (`scopeObjectId`, the window, `atomic`) that no generic write door inspects.
   *
   * The typed door is `POST /api/v1/freezes`, which demands `freeze:write` at the freeze's own
   * scope and, for the federating form, `federation:write` on top — and which is also the only
   * place that writes the object and its projection row together, so a `freeze` object minted
   * anywhere else would federate a freeze that does not exist locally.
   *
   * MEMBERSHIP HERE IS NECESSARY AND NOT SUFFICIENT, and the first version of this entry claimed
   * otherwise ("closes all five doors at once"). It does not: of the five doors, only TWO refuse
   * the type ({POST,PATCH,PUT,DELETE} `/objects/{type}` and `POST /discovery/accept`). The other
   * three — `POST /plans`+apply, `POST /federation/overlays`, `POST /federation/hand-fill` — take
   * membership as an instruction to demand `policy:write` INSTEAD of `object:write`, which is a
   * permission UPGRADE, not a refusal. See {@link PROJECTION_BOUND_OBJECT_TYPE_IDS}, which is the
   * set those three consult, and which is what actually closes them for `freeze`.
   *
   * FEDERATION JOURNAL REPLAY IS STILL NOT A DOOR, for the structural reason recorded above:
   * `import-repo.ts` is where a freeze object is SUPPOSED to arrive.
   */
  "freeze"
]);

export function isGovernanceManagedObjectType(typeId: string): boolean {
  return GOVERNANCE_MANAGED_OBJECT_TYPE_IDS.has(typeId);
}

/**
 * ==============================================================================================
 * TYPES WHOSE GRAPH OBJECT IS ONLY HALF THE RECORD — refused outright at every door that takes a
 * caller-supplied `typeId`, the way {@link import("../graph/pair-bound-types.js")} refuses
 * `placement`.
 * ==============================================================================================
 *
 * WHY A SECOND SET AND NOT A SECOND MEANING FOR THE FIRST. `GOVERNANCE_MANAGED_OBJECT_TYPE_IDS`
 * answers "which permission?"; three of the five doors answer it with `policy:write` and then
 * WRITE THE ROW. That is right for `policy` and `control` — DESIGN §13 makes "locally annotate a
 * commander-distributed global policy" and "an air-gapped operator keys a commander-origin policy
 * in by hand" canonical, so refusing the type would delete the feature. It is WRONG for a type
 * whose object is meaningless on its own.
 *
 * THE HOLE THIS CLOSES, MEASURED ON THE M25.7 TREE BEFORE IT EXISTED. An actor holding
 * `policy:write` at a narrow domain — and `freeze:write` / `federation:write` NOWHERE — could
 * `POST /plans` a manifest object of `typeId: "freeze"` and apply it. Three things then went
 * wrong at once, and only the first is a permission problem:
 *
 *   1. `iac/plans-repo.ts`'s `writePermissionFor` mapped the type to `policy:write`, which the
 *      actor held, so the freeze's two REAL gates (`freeze:write` at its scope, `federation:write`
 *      on top for the federating form) were bypassed entirely — `policy:write` became a complete
 *      substitute for both.
 *   2. `prepareApplyChecks` scope-binds a DECLARED `properties.*` to the actor's own authority for
 *      exactly two types (`policy`, `campaign`). A `freeze`'s declared `properties.scopeObjectId`
 *      was bound to nothing, so the narrow actor's freeze could name any scope in the org.
 *   3. The result was UNLIFTABLE AT BOTH ENDS. Only `POST /v1/freezes` writes the object and the
 *      `freezes` row together, so the authoring instance got an object with no projection row and
 *      `DELETE /v1/freezes/{id}` 404s there; at the peer the row IS rebuilt, and `lockFreezeRow`
 *      refuses to lift it because its origin domain is foreign. A block nobody can retract.
 *
 * REFUSAL LOSES NOTHING REAL, which is the test this repo applies before refusing a type at a
 * door (`pair-bound-types.ts`'s "is it called an import path" paragraph). There is no
 * "annotate a distributed freeze" use case — a freeze carries no strictness lattice for an
 * overlay to add to — and none of the three doors can write the projection row anyway, so what
 * they would produce is by construction the broken half-record above.
 *
 * BEFORE ADDING A MEMBER, the question is the one that separates this set from the governance
 * one: does a row of this type require a SECOND write, in another table, that only a typed route
 * performs? If yes it belongs here, whatever its permission story is. `scan_override_grant` does
 * NOT — it is wholly an object — which is why it stays governance-managed and permission-gated.
 *
 * The doors that consult this set are the three that would otherwise upgrade rather than refuse:
 *  - `iac/plans-repo.ts`'s `prepareApplyChecks` (per-entry, every non-`noop` action)
 *  - `federation/overlay-repo.ts`'s `createOverlay`
 *  - `federation/handfill-repo.ts`'s `assertGovernanceAuthorityForHandFill`
 * The other two already refuse every governance-managed type, so a member of this set is refused
 * there by the wider rule; `governance-managed-write-doors.integration.test.ts` drives all five
 * with an actor holding every permission those doors ask for EXCEPT `freeze:write`, so "refused"
 * is measured rather than assumed.
 *
 * FEDERATION JOURNAL REPLAY IS NOT A DOOR HERE EITHER, and for this set the reason is doubled:
 * `import-repo.ts`'s `object_upsert` branch is exactly where a `freeze` object is SUPPOSED to
 * arrive, and it is the branch that then writes the projection row.
 */
export const PROJECTION_BOUND_OBJECT_TYPE_IDS: ReadonlySet<string> = new Set(["freeze"]);

export function isProjectionBoundObjectType(typeId: string): boolean {
  return PROJECTION_BOUND_OBJECT_TYPE_IDS.has(typeId);
}

/** The one sentence every door's refusal says, so three doors cannot drift into three different
 *  explanations of one rule. `door` names the caller's own route so the message routes them
 *  somewhere real. */
export function projectionBoundRefusalDetail(typeId: string, door: string): string {
  return (
    `object type '${typeId}' is projection-backed: its graph object is only the WIRE half of the ` +
    `record, and ${door} cannot write the enforcement row that goes with it — a '${typeId}' minted ` +
    `here would federate and block at every peer while not existing at this instance, and could ` +
    `then be lifted at neither end. Use /api/v1/${typeId}s, which writes both halves in one ` +
    `transaction and enforces '${typeId}:write' at the declared scope plus 'federation:write' to ` +
    `federate it.`
  );
}
