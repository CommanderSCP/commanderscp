import { badRequest, conflict } from "../errors.js";
import { DependencySubscriptionEffectSchema } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { delegationRefusalMessage, readStandingDelegationVerdict } from "./delegation-detection.js";

/**
 * A GROUP-SCOPED `dependencySubscription` EFFECT IS REFUSED AT AUTHORING TIME — IN BOTH DIRECTIONS
 * — because neither direction can be relied on to do what it says.
 *
 * ================================================================================================
 * WHY THIS GUARD EXISTS AND WHY IT LIVES HERE RATHER THAN IN THE MATCHER
 * ================================================================================================
 * A `scope.group` policy matches on EITHER of two independent halves (DESIGN §10.1's "acting or
 * owning subject"; `governance/policy-resolve.ts:292-322`):
 *   (i)  THE ACTING HALF (`:298`, via `isMemberOf` at `:104-123`) — the ACTING SUBJECT is a
 *        transitive `member_of` the group.
 *   (ii) THE OWNING HALF (`:313`, via `ownedByGroupOrItsMembers` at `:150-173`) — the group, or any
 *        transitive `member_of` member of it, holds an `owns` edge on SOMETHING IN THE TARGET'S
 *        CONTAINMENT CHAIN. This half NEVER READS `actorObjectId`.
 * Either is right for "this rule governs work done by, or on the things owned by, this group". Neither
 * is sufficient for a CONSTRAINT, because a constraint that fails to match is a constraint that does
 * not apply — and whether either half matches is a fact about membership and ownership, never a fact
 * about what the author wrote.
 *
 * THE OPT-OUT DIRECTION — fails OPEN, AND SINCE 2026-08-17 THIS IS THE SOLE GROUND FOR THE REFUSAL
 * (ADR-0032 §6a-ii). Where the named group owns nothing on the component's chain and the actor is not
 * a member, a group-scoped OPT-OUT contributes nothing: `disabledBy` is never set
 * (`subscription-resolution.ts:342-348`) and the AND at `:402` returns STILL-ENABLED. SCP then authors
 * a bump for a dependency a team explicitly opted out of, which is precisely the case the opt-out
 * exists to serve: "one or more dependencies are causing issues when upgraded, so we want to handle
 * that manually" (the owner's stated requirement, proposal §1).
 *
 * IT IS NOT A CORNER CASE. The ENABLE routinely arrives from a broader, actor-independent scope — an
 * org- or service-wide `objectRef`, or a `selector` — while the opt-out is the narrow, team-shaped
 * thing someone writes at group scope. NOTHING TIES THE TWO SCOPES' REACH TOGETHER, so "the enable
 * applied here" implies nothing whatever about "the opt-out will apply here".
 *
 * The failure is silent in both halves — the matcher returns fewer rows, the merge sees fewer
 * contributions, and `enabled: true` is a perfectly ordinary-looking answer. Nothing errors and
 * nothing logs. An operator would learn about it from a pull request they explicitly asked never to
 * receive.
 *
 * AND THE OWNING HALF SHARPENED THIS RATHER THAN SOFTENING IT: ITS REACH IS MUTABLE GRAPH DATA.
 * `owns` edges are created and deleted at runtime through the ordinary ownership API
 * (`routes/ownership.ts:156-165` creates one, `:235-262` deletes one, both plain
 * `relationship:write`). For a policy that TIGHTENS — every enforcing consumer ADR-0016 §2a was
 * written for — that is exactly right and monotone. For an OPT-OUT the same property is a FAIL-OPEN
 * TRAPDOOR: revoking an `owns` edge, in a re-org or a cleanup that is not about this policy at all,
 * silently RE-SUBSCRIBES a component whose team opted out. No error, no log, and no Decision that
 * says a subscription came back.
 *
 * ================================================================================================
 * THE ENABLE DIRECTION — STILL REFUSED, BUT NOT FOR THE REASON THIS FILE USED TO GIVE
 * (ADR-0032 §6a-ii, 2026-08-17)
 * ================================================================================================
 * M21.3 permitted a group-scoped ENABLE on the reasoning that failing to match yields NOT-enabled,
 * which is the safe direction. M21.4 refused it on the reasoning that it is PERMANENTLY INERT: the
 * background jobs resolve as `SYSTEM_ACTOR_ID` — the all-zero sentinel which by its own doc comment
 * is "never a real graph object id (no `objects` row exists at this id)"
 * (`coordination/system-actor.ts:9`) — and a principal with no `objects` row is a transitive
 * `member_of` nothing.
 *
 * THAT SECOND REASONING IS FALSE, and was already false the day it was written. ADR-0016 §2a
 * (PR #237, 2026-08-15 — the same date M21.4 widened this guard) shipped the OWNING half above, and
 * that half does not consult the actor at all. So a group-scoped ENABLE **does** fire for
 * `SYSTEM_ACTOR_ID` wherever the group owns anything on the chain;
 * `governance/group-scope-ownership.integration.test.ts:188` ("it applies to SYSTEM_ACTOR_ID too")
 * pins exactly that. Do not re-derive "inert" from the sentinel's membership: that fact is still
 * true, and it is now irrelevant.
 *
 * WHAT THE ENABLE DIRECTION RESTS ON NOW, stated honestly rather than re-justified: its own original
 * ground is gone and no equally strong one replaces it. What remains is the same mutable-reach
 * property read the other way — such an enable fires exactly where the group HAPPENS to own something
 * on the chain, which is a fact about the ownership graph rather than a set the author named, and it
 * changes whenever an `owns` edge does. It is kept in the refusal for three reasons, in decreasing
 * weight: the remedy is identical (`objectRef`/`selector`), so the cost of keeping it is only
 * ergonomic; one scope kind must not mean two different things depending on the sign of `enabled`, or
 * authors end up reasoning about this guard instead of about scope; and re-permitting it would reopen
 * the narrowing below, which is proven and load-bearing.
 *
 * THIS CAN BE RELAXED for the enable direction if a future design resolves subscriptions PER OWNER
 * DELIBERATELY — taking each subscribing component's own team as an explicit input rather than
 * inheriting whatever the ownership graph happens to say. NOTE THE TRIGGER HAS MOVED: the old wording
 * ("once the actor is no longer the system sentinel") no longer names anything, because the owning
 * half made the actor irrelevant.
 *
 * SO WHY NOT FIX THE MATCHER? The matcher WAS fixed, on its OTHER consumer's terms: ADR-0016 §2a
 * added the owning half for `scanThreshold`, in the TIGHTENING direction, which is why it needed no
 * permission from this feature. What survives of the original argument is its boundary, not its
 * prohibition — this guard governs THIS FEATURE'S USE of the matcher and changes no matcher
 * behaviour. A group-scoped scan CEILING that matches on neither half still leaves the effective
 * threshold LOOSER than the operator authored; that residue belongs to the matcher, is tracked for
 * both consumers at once, and is not touched here.
 *
 * What this guard does instead is REFUSE TO DEPEND ON A REACH NOBODY DECLARED. It converts a silent
 * fail-open at evaluation time into a loud refusal at authoring time, which is the same move
 * `0061`'s declared-producer CHECK makes: make the unusable state unrepresentable rather than
 * guarded. An author who wants a group-wide opt-out writes it at `objectRef`/`selector` scope, whose
 * reach is exactly what the author wrote down.
 *
 * ================================================================================================
 * WHERE IT IS INSTALLED — THE CHOKE POINT, NOT THE ROUTE (M21.3 review round)
 * ================================================================================================
 * First cut installed this in ONE place: the composed `validateWrite` of the typed `/policies`
 * routes. Its sibling check `assertPolicyScopeWithinAuthority` was already installed in THREE
 * (that same config, plus `iac/plans-repo.ts`'s create and update branches) — which is the tell that
 * "the typed route" was never the boundary. Measured, not reasoned about: a manifest declaring
 * `{typeId:"policy", properties:{scope:{group:"team-platform"}, effects:[{dependencySubscription:
 * {enabled:false, coordinate:"acme-lib"}}]}}` applied cleanly through `POST /plans` +
 * `/plans/{id}/apply` and the object read back, while `POST /api/v1/federation/hand-fill` and
 * `POST /api/v1/federation/overlays` (free-form `typeId`, `object:write`) planted the same document.
 *
 * The fix is NOT a fourth, fifth and sixth call — that is the same rake, and the seventh door would
 * miss it again. It is installed at `graph/objects-repo.ts`'s `createObject`/`updateObject`, the ONE
 * choke point every local write door funnels through, following the M16.2 clause-(4) precedent that
 * already lives there. See those two call sites for the exemption and its census.
 *
 * STILL DELIBERATELY NARROW, in two ways rather than the original three. Only the `policy` TYPE is
 * inspected, and only when `group` is the ONLY scope the policy carries. Every other effect type is
 * untouched and every other object type is untouched — this guard must not become the place where
 * unrelated policy rules accumulate. What it no longer narrows on is the effect's DIRECTION: both
 * `enabled: false` and `enabled: true` are refused — since ADR-0032 §6a-ii, on ONE ground rather
 * than two.
 *
 * ================================================================================================
 * WHY `group` MUST BE THE *ONLY* SCOPE FOR THIS TO REFUSE
 * ================================================================================================
 * `matchPoliciesForTargets` evaluates the three scope kinds INDEPENDENTLY, not as alternatives: the
 * `objectRef` branch (`policy-resolve.ts:271-279`) and the `selector` branch (:281-290) each record a
 * match on their own, before the `group` branch (:292-322) is even reached, and the `record()` map
 * dedups by (policy, matched object). So a policy carrying BOTH `group` and `objectRef` contributes
 * for EVERY caller through the `objectRef` route, whatever the group's membership or ownership says.
 * The hazard this guard exists for is simply absent there, and refusing it would emit a 400 telling
 * the author to do the thing they had already done.
 *
 * RESIDUAL, stated rather than papered over: "carries an `objectRef`/`selector`" is a STRUCTURAL
 * test, not a proof that the non-group scope will actually match something. An `objectRef` naming a
 * URN that resolves to nothing, or a `selector` whose labels no object carries today, leaves the
 * group branch as the only live route and the original hazard with it. That is deliberate and it is
 * not fixable at this layer: a `selector` is designed to match objects that do not exist yet, so
 * "does this scope match anything right now?" is not a question authoring time can answer for the
 * general case — and answering it for `objectRef` alone would make the guard's behaviour depend on
 * which of two equally-broad scope kinds the author happened to pick. The over-broad refusal this
 * narrowing removes was a certain, everyday false positive; the residual is a dangling reference,
 * which is already broken in ways this guard is not responsible for.
 */
export function assertEnforceableDependencySubscriptionScope(args: {
  /** The object type being written. The guard applies to `policy` ONLY — `listPolicyCandidates`
   *  (`policy-resolve.ts:71-87`) selects `type_id = 'policy'` and nothing else, so a
   *  `dependencySubscription` effect on any other type is never resolved and carries no hazard.
   *  Taken as an argument rather than checked by each caller so that every installation site —
   *  including the free-form-`typeId` doors (hand-fill, overlay, IaC manifests) — is correct by
   *  construction instead of by remembering. */
  typeId: string;
  properties: Record<string, unknown> | undefined;
}): void {
  if (args.typeId !== "policy") return;

  const scope = args.properties?.scope as
    { group?: unknown; objectRef?: unknown; selector?: unknown } | undefined;
  // Only `group` matching depends on something the author did not write down — the actor's
  // membership, or an `owns` edge somewhere on the target's chain. `objectRef` and `selector` resolve
  // against the graph and reach exactly what they name, so they carry no such hazard.
  if (!scope || typeof scope.group !== "string" || scope.group === "") return;

  // Mirrors the matcher's own truthiness tests exactly, because what matters is whether the OTHER
  // branch runs, not whether the field looks plausible:
  //   - `if (scope.objectRef)` at :271 — a non-string or empty value reaches `resolveRef` and
  //     resolves to nothing, so it is not a live route;
  //   - `if (scope.selector?.labels)` at :281 — note `{}` IS live: `labelsMatch` is an `every()`
  //     over zero entries, which is `true` for every ancestor. `selector: {}` with no `labels` is
  //     not.
  const hasObjectRef = typeof scope.objectRef === "string" && scope.objectRef !== "";
  const selectorLabels = (scope.selector as { labels?: unknown } | undefined)?.labels;
  const hasSelector = typeof selectorLabels === "object" && selectorLabels !== null;
  if (hasObjectRef || hasSelector) return;

  const effects = args.properties?.effects;
  if (!Array.isArray(effects)) return;

  for (const raw of effects) {
    const candidate = (raw as { dependencySubscription?: unknown } | null)?.dependencySubscription;
    if (candidate === undefined) continue;
    const parsed = DependencySubscriptionEffectSchema.safeParse(candidate);
    // A malformed effect is NOT this guard's business — it contributes nothing at resolution time
    // and is reported there. Rejecting it here would make this guard a second, divergent validator
    // of the effect's shape, and the two would drift.
    if (!parsed.success) continue;

    // BOTH DIRECTIONS, ONE REMEDY, ONE GROUND (ADR-0032 §6a-ii) — the message names the direction's
    // own failure, because "scope it differently" without the reason is an instruction an author has
    // to take on faith. It must NOT say "the job belongs to no group": that was the M21.4 wording and
    // it is false (§6a-ii), and an author who checks it will find a counter-example and dismiss the
    // whole refusal.
    throw badRequest(
      parsed.data.enabled
        ? "A dependency-subscription enable (enabled: true) cannot be scoped to a group. " +
            "A group-scoped policy applies where the acting subject belongs to that group OR where " +
            "the group owns something on the target's containment chain — so which components this " +
            "enable actually reaches is decided by `owns` edges rather than by anything written " +
            "here, and it changes silently whenever ownership is edited. Scope it with `objectRef` " +
            "or `selector` instead — those reach exactly what they name, for every caller."
        : "A dependency-subscription opt-out (enabled: false) cannot be scoped to a group. " +
            "A group-scoped policy applies only where the acting subject belongs to that group or " +
            "the group owns something on the target's containment chain, so an opt-out authored " +
            "this way would silently fail to apply everywhere else and the dependency would keep " +
            "being bumped — and removing an `owns` edge later would silently re-subscribe a " +
            "component you opted out. Scope the opt-out with `objectRef` or `selector` instead — " +
            "those reach exactly what they name, for every caller."
    );
  }
}

/**
 * ================================================================================================
 * M21.5 — ENABLING SUBSCRIPTIONS FOR A COMPONENT WHOSE REPOSITORY ALREADY DELEGATES IS REFUSED
 * (charter `scp-managed-dep` amendment 2026-08-13; ADR-0032 §8)
 * ================================================================================================
 * "CommanderSCP refuses to enable dependency subscriptions for a component whose repository already
 * delegates the same manifests to another dependency-update system."
 *
 * WHY IT LIVES BESIDE THE SCOPE GUARD, AND AT THE SAME CHOKE POINT. Everything this file's header
 * establishes about WHERE an authoring-time refusal belongs applies here unchanged and is not
 * re-argued: the typed `/policies` route was never the boundary, three free-form-`typeId` doors
 * (`POST /plans` + apply, `POST /federation/hand-fill`, `POST /federation/overlays`) reach
 * `createObject` with the same document, and adding a fourth, fifth and sixth call rebuilds the same
 * rake. So this is installed at `graph/objects-repo.ts`'s `createObject`/`updateObject` — the ONE
 * choke point every local write door funnels through — with the identical `federationImport`
 * exemption and the identical closing of that exemption at `handfill-repo.ts`.
 *
 * WHY IT IS ASYNC WHEN ITS SIBLING IS NOT. The sibling decides from the DOCUMENT alone. This one
 * needs a fact about a repository, and the fact cannot be fetched here: `createObject` runs inside a
 * tenant transaction holding two per-org advisory locks to commit, and provider I/O there would hold
 * them across a network call. The fact is therefore probed asynchronously (where the repository is
 * already being read) and persisted as a Decision; this performs ONE indexed read of it. See
 * `delegation-detection.ts`'s module doc for why a Decision is the right home rather than a
 * convenient one, and for what an ABSENT probe means.
 *
 * ONLY AN ENABLE IS REFUSED. An `enabled: false` effect is an OPT-OUT, and refusing to author an
 * opt-out for a delegating component would refuse the very document that turns SCP's authoring OFF —
 * the direction the conflict wants. So the direction is read, not just the presence of the effect.
 * (Note the contrast with the scope guard above, which refuses BOTH directions: there, both
 * directions were broken; here, only one of them can collide with another actuator.)
 *
 * ONLY AN `objectRef` SCOPE CAN BE DECIDED HERE, AND THE RESIDUAL IS COVERED ELSEWHERE. A
 * `selector`-scoped enable names no component — by design, since "a `selector` is designed to match
 * objects that do not exist yet" (this file's own residual note on the sibling guard). There is
 * therefore no repository to have probed, and no refusal that could be issued honestly. That gap is
 * NOT left open: `dependencies/bump-actuator.ts` re-reads the same standing verdict before every
 * authored bump, so a component reached by a selector-scoped enable is refused at the moment SCP
 * would write to it. One stored fact, two readers, neither fail-open.
 *
 * A 409 RATHER THAN A 400, carrying the probe's `decision_id`. This is not a malformed document —
 * it is a well-formed one that conflicts with the state of the world, which is what 409 means; and
 * charter principle 6 requires every blocked response to carry a `decision_id`, which here is the
 * probe that found the file. An operator can `GET /decisions/{id}` and see exactly which config was
 * read, at which ref, and which manifests it claimed.
 */
export async function assertNoDelegatedDependencyUpdates(
  tx: TenantTx,
  args: {
    orgId: string;
    /** As with the sibling guard, taken as an argument so every installation site — including the
     *  free-form-`typeId` doors — is correct by construction rather than by remembering. */
    typeId: string;
    properties: Record<string, unknown> | undefined;
  }
): Promise<void> {
  if (args.typeId !== "policy") return;

  const effects = args.properties?.effects;
  if (!Array.isArray(effects)) return;

  // Does this document ENABLE anything at all? An opt-out-only policy is never refused — see the
  // header. Parsed with the same schema the resolver uses, so a document that would contribute
  // nothing at resolution time cannot be refused here either.
  const enables = effects.some((raw) => {
    const candidate = (raw as { dependencySubscription?: unknown } | null)?.dependencySubscription;
    if (candidate === undefined) return false;
    const parsed = DependencySubscriptionEffectSchema.safeParse(candidate);
    return parsed.success && parsed.data.enabled;
  });
  if (!enables) return;

  const scope = args.properties?.scope as { objectRef?: unknown } | undefined;
  const objectRef = typeof scope?.objectRef === "string" ? scope.objectRef.trim() : "";
  if (objectRef === "") return; // see "ONLY AN `objectRef` SCOPE CAN BE DECIDED HERE"

  // Resolved exactly as `governance/policy-resolve.ts`'s own `resolveRef` does — id or URN — because
  // the object this refusal is about must be the same object the matcher would later attach to. A
  // ref that resolves to nothing is a dangling reference, which is already broken in ways this guard
  // is not responsible for (the sibling guard's residual note says the same of the same case).
  const row = /^[0-9a-fA-F-]{36}$/.test(objectRef)
    ? await tx.query.objects.findFirst({
        where: (t, { eq: eqOp, and: andOp }) =>
          andOp(eqOp(t.orgId, args.orgId), eqOp(t.id, objectRef))
      })
    : await tx.query.objects.findFirst({
        where: (t, { eq: eqOp, and: andOp }) =>
          andOp(eqOp(t.orgId, args.orgId), eqOp(t.urn, objectRef))
      });
  if (!row) return;

  const standing = await readStandingDelegationVerdict(tx, args.orgId, row.id);
  if (!standing?.delegated) return;

  throw conflict(delegationRefusalMessage(standing.collisions), {
    decisionId: standing.decisionId
  });
}
