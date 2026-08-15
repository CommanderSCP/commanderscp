import { badRequest } from "../errors.js";
import { DependencySubscriptionEffectSchema } from "@scp/schemas";

/**
 * A GROUP-SCOPED `dependencySubscription` EFFECT IS REFUSED AT AUTHORING TIME — IN BOTH DIRECTIONS
 * — because neither direction can be relied on to do what it says.
 *
 * ================================================================================================
 * WHY THIS GUARD EXISTS AND WHY IT LIVES HERE RATHER THAN IN THE MATCHER
 * ================================================================================================
 * `matchPoliciesForTargets` returns a `scope.group` policy ONLY when the ACTING SUBJECT is a
 * transitive `member_of` that group (`governance/policy-resolve.ts:186-193`, via `isMemberOf` at
 * :72-89). That is the right semantics for "this rule governs work done BY this group". It is the
 * WRONG semantics for a constraint, because a constraint that fails to match is a constraint that
 * does not apply.
 *
 * THE OPT-OUT DIRECTION — fails OPEN. A group-scoped OPT-OUT that fails to match yields
 * STILL-ENABLED. SCP then authors a bump for a dependency a team explicitly opted out of, which is
 * precisely the case the opt-out exists to serve: "one or more dependencies are causing issues when
 * upgraded, so we want to handle that manually" (the owner's stated requirement, proposal §1).
 *
 * The failure is silent in both halves — the matcher returns fewer rows, the merge sees fewer
 * contributions, and `enabled: true` is a perfectly ordinary-looking answer. Nothing errors and
 * nothing logs. An operator would learn about it from a pull request they explicitly asked never to
 * receive.
 *
 * ================================================================================================
 * THE ENABLE DIRECTION — INERT, AND M21.4 IS WHAT MADE THAT MEASURABLE (ADR-0032 §6a, 2026-08-15)
 * ================================================================================================
 * M21.3 permitted a group-scoped ENABLE on the reasoning that failing to match yields NOT-enabled,
 * which is the safe direction, so nothing is lost. That reasoning was INCOMPLETE, and M21.4 is
 * where the missing half became a fact rather than a worry.
 *
 * The background jobs that ACT on a subscription resolve as `SYSTEM_ACTOR_ID` — the all-zero
 * sentinel, which by its own doc comment is "never a real graph object id (no `objects` row exists
 * at this id)" (`coordination/system-actor.ts:9`). A principal with no `objects` row is a transitive
 * `member_of` NOTHING, so `matchPoliciesForTargets` can never return a `scope.group` policy for it.
 * A group-scoped ENABLE is therefore PERMANENTLY INERT on every path that does work:
 * `internal-release-detection.ts`'s subscriber gate and the third-party poll's work-list both go
 * through `listSubscribedComponentLines` with that actor.
 *
 * What makes it a footgun rather than merely a no-op is that the SAME policy resolves ENABLED for a
 * human team member who asks — they are in the group, so the matcher hands it back, the merge
 * enables the pair, and the API says `enabled: true`. The team sees a working subscription and
 * receives nothing, forever, with no error anywhere. "Nothing is lost" is true only of the
 * enablement algebra; it is false of the feature, and a subscription that silently never fires is
 * its own kind of failure — the mirror image of an opt-out that silently never applies.
 *
 * So the refusal now covers BOTH directions, for two different reasons that happen to have the same
 * remedy. THIS CAN BE RELAXED for the enable direction if a future design resolves subscriptions
 * PER OWNER rather than per acting subject (evaluating each subscribing component's own team
 * membership instead of the job's), at which point a group-scoped enable would be meaningful and
 * only the opt-out's fail-open would remain. Nothing in the tree does that today.
 *
 * SO WHY NOT FIX THE MATCHER? Because that would be fixing the instance from the wrong end. The same
 * exposure exists for `scanThreshold` (ADR-0016, shipped): a group-scoped scan CEILING silently does
 * not contribute for a non-member, leaving the effective threshold LOOSER than the operator
 * authored. Changing `matchPoliciesForTargets` here would change that shipped gate's behaviour as a
 * side effect of a dependency feature — which is how a governance change gets made without anyone
 * deciding to make one. The matcher is where both consumers meet and is tracked separately.
 *
 * What this guard does instead is REFUSE TO DEPEND ON THE BROKEN PART. It converts a silent
 * fail-open at evaluation time into a loud refusal at authoring time, which is the same move
 * `0061`'s declared-producer CHECK makes: make the unusable state unrepresentable rather than
 * guarded. An author who wants a group-wide opt-out writes it at `objectRef`/`selector` scope, where
 * matching does not depend on who is asking.
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
 * `enabled: false` and `enabled: true` are refused, for the two different reasons above.
 *
 * ================================================================================================
 * WHY `group` MUST BE THE *ONLY* SCOPE FOR THIS TO REFUSE
 * ================================================================================================
 * `matchPoliciesForTargets` evaluates the three scope kinds INDEPENDENTLY, not as alternatives: the
 * `objectRef` branch (`policy-resolve.ts:161-169`) and the `selector` branch (:171-181) each record a
 * match on their own, before the actor-dependent `group` branch (:183-193) is even reached, and the
 * `record()` map dedups by (policy, matched object). So a policy carrying BOTH `group` and
 * `objectRef` contributes for EVERY caller through the `objectRef` route — member or not. The hazard
 * this guard exists for is simply absent there, and refusing it would emit a 400 telling the author
 * to do the thing they had already done.
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
   *  (`policy-resolve.ts:41-57`) selects `type_id = 'policy'` and nothing else, so a
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
  // Only `group` matching is actor-dependent. `objectRef` and `selector` resolve against the graph
  // and are answered identically whoever asks, so they carry no such hazard.
  if (!scope || typeof scope.group !== "string" || scope.group === "") return;

  // Mirrors the matcher's own truthiness tests exactly, because what matters is whether the OTHER
  // branch runs, not whether the field looks plausible:
  //   - `if (scope.objectRef)` at :161 — a non-string or empty value reaches `resolveRef` and
  //     resolves to nothing, so it is not a live route;
  //   - `if (scope.selector?.labels)` at :171 — note `{}` IS live: `labelsMatch` is an `every()`
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

    // BOTH DIRECTIONS, ONE REMEDY, TWO REASONS (ADR-0032 §6a) — the message names the direction's
    // own failure, because "scope it differently" without the reason is an instruction an author
    // has to take on faith.
    throw badRequest(
      parsed.data.enabled
        ? "A dependency-subscription enable (enabled: true) cannot be scoped to a group. " +
            "A group-scoped policy is only matched when the acting subject belongs to that group, " +
            "and the background job that acts on a subscription runs as the system actor, which " +
            "belongs to no group — so an enable authored this way would read as enabled in the " +
            "API for a team member and never actually fetch or bump anything. Scope it with " +
            "`objectRef` or `selector` instead — those resolve against the graph and apply " +
            "regardless of who is asking."
        : "A dependency-subscription opt-out (enabled: false) cannot be scoped to a group. " +
            "A group-scoped policy is only matched when the acting subject belongs to that group, " +
            "so an opt-out authored this way would silently fail to apply for everyone else and " +
            "the dependency would keep being bumped. Scope the opt-out with `objectRef` or " +
            "`selector` instead — those resolve against the graph and apply regardless of who is " +
            "asking."
    );
  }
}
