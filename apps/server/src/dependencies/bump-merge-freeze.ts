import type { TenantTx } from "../db/tenant-tx.js";
import { freezesByTarget, unionFreezes, type EffectiveFreeze } from "../governance/freeze-scope.js";

/**
 * M25.8 — THE DEPENDENCY ACTUATOR'S FREEZE CHECK (owner decision D8).
 *
 * ============================================================================================
 * WHAT WAS TRUE BEFORE THIS FILE
 * ============================================================================================
 * The dependency-subscription actuator consulted NO freeze and NO governance gate at all. Measured
 * filterlessly (`grep -rna "freeze" apps/server/src/dependencies/`, against a known-positive control
 * over `apps/server/src/governance/` so an empty result could be read as evidence): the word did not
 * occur in this directory outside unrelated comments.
 *
 * The path never enters `evaluateGovernanceGate` — that function has exactly two callers, both in
 * `coordination/gates.ts`. `bump-gate.ts` calls `prewarmGovernanceForChange`, which RUNS controls
 * and blocks on nothing, and never calls `checkFreeze`. The bookkeeping Change this path creates is
 * documented as deliberately never advanced, so it never reaches the wave gate either. The
 * consequence: a declared change freeze over an org did not stop SCP from opening AND AUTO-MERGING a
 * version bump into that org's repositories — the most freeze-relevant act on the instance, and the
 * one that was unguarded.
 *
 * ============================================================================================
 * THE BOUNDARY IS D8's, AND IT IS NARROWER THAN "REFUSE THE BUMP"
 * ============================================================================================
 * A freeze blocks AUTO-MERGE. It does NOT block PR authoring. Opening the bump pull request during a
 * freeze is allowed — the work stays visible and queued, which is what preserves the value of the
 * subscription — and merging it into the tenant's default branch is refused, with a Decision. Pull
 * requests accumulate during the window and merge when it closes.
 *
 * "AND MERGE WHEN IT CLOSES" NAMES A PRODUCER, and it has to, because for one release it did not.
 * The only thing that enqueues an auto-merge gate job is `observedBumpRouter`, driven by a PROVIDER
 * WEBHOOK about the bump's branch — and a freeze expiring, being lifted or being shortened touches
 * no repository and therefore produces no such event. So the sentence above was, briefly, an
 * assurance with nothing behind it: a bump refused here stayed refused for ever, silently, with the
 * pull request stranded and its latest Decision promising the opposite. What makes it true is
 * `dependencies/bump-freeze-redrive.ts` — a per-minute sweep that re-asks
 * {@link checkBumpMergeFreeze} for exactly the bumps this file's refusal named and re-drives the
 * gate for the ones nothing covers any more. It is a SWEEP rather than a job scheduled at `endsAt`
 * on purpose: a lift and a shortening both happen BEFORE `endsAt`, and a shortening can move
 * `endsAt` later.
 *
 * So this module is consulted at BOTH of the actuator's two `trigger()` calls, and it does two
 * different things at them, because they are two different acts:
 *
 *   * `bump-gate.ts` — the STANDALONE merge (`action: "merge"`). Its whole purpose is the merge, so a
 *     covering freeze is a REFUSAL with its own named cause and its own Decision.
 *   * `bump-dispatch.ts` — the AUTHORING run (`action: "bump"`). This one is not obviously a merge
 *     and that is the trap: `@scp/plugin-managed-dep`'s `publishBump` has an AUTO-MERGE TAIL, taken
 *     whenever the descriptor's `delivery` is `auto_merge` and an `expectedHeadCommit` rides along
 *     (`repo-write.ts`: "Both the publish tail and the standalone merge action reach the provider
 *     through here"). A freeze there therefore DOWNGRADES the delivery to `pull_request` rather than
 *     refusing: the trigger still fires, the branch is still authored, the pull request is still
 *     opened, and the tail does not merge. That IS D8 expressed at that seam, not a workaround for
 *     it. Guarding only the file with "merge" in its name would have left the other half of the same
 *     act open — the incomplete-call-site census failure this repo has paid for before.
 *
 * ============================================================================================
 * `freezesByTarget`, NEVER A HAND-ROLLED WALK, AND NEVER A SECOND WINDOW PREDICATE
 * ============================================================================================
 * The resolution is `governance/freeze-scope.ts`'s, unchanged and shared with the wave gate and the
 * per-target hold. Two properties come with it and neither is re-derived here:
 *
 *   * it walks `containmentChain`, so a freeze declared at the component's SERVICE, its domain or
 *     the org root covers the component. A hand-rolled `domain_id`-only walk once made a
 *     service-scoped freeze fail OPEN — silently, because a freeze that stops matching produces the
 *     same `allow` a freeze that never existed would; and
 *   * it returns BOTH TIERS. A platform freeze declared by this deployment's operator blocks an
 *     auto-merge exactly as an org freeze does, with no per-tier branch anywhere below.
 *
 * INERTNESS comes with it too: an org with no active freeze pays two indexed window reads and walks
 * no containment chain at all.
 *
 * ============================================================================================
 * WHAT THIS DELIBERATELY DOES NOT MODEL
 * ============================================================================================
 * NO OVERRIDE. `gate-orchestrator.ts`'s `checkFreeze` admits a change when every covering freeze is
 * individually overridden by an actor holding `freeze:override` at that freeze's own scope, with a
 * reason. There is no such actor here and there cannot be one: both call sites run under
 * `SYSTEM_ACTOR_ID` on a background queue with no HTTP request in scope, so an override could only
 * ever be a constant in this file — which is a freeze that overrides itself. The operator's remedy is
 * the shipped one: lift or shorten the freeze (`DELETE`/`PATCH /v1/freezes/{id}`, or
 * `DELETE`/`PUT /v1/instance/freezes/{key}` for the platform tier) — and the next attempt, which
 * `bump-freeze-redrive.ts` schedules within a minute of the freeze releasing, merges. That producer
 * is named because "the next attempt" was for one release a thing nothing produced; see the header
 * above.
 *
 * NO `atomic`. That bit restores whole-wave semantics by making a freeze over ANY target of a set
 * cover EVERY target of it. A bump has exactly one target — the component — so the union of one
 * target's covering freezes and the atomic freezes over the same single target is that same set.
 * Reading it would be a no-op dressed as a rule.
 *
 * READS ONLY, on a `TenantTx` the caller owns, exactly as `freezesByTarget` itself does: each caller
 * decides what to persist and does it in its own transaction.
 */

/**
 * A covering freeze set, projected for a Decision's `inputContext`.
 *
 * `endsAt` AND NEVER `now`. This is the whole anti-write-amplification contract and it is copied
 * from `coordination/freeze-hold.ts`'s `describeFreezes`, which copied it from the gate's
 * freeze-block context. Recording the window BOUNDARY makes the refusal byte-identical on every
 * attempt for the length of the freeze, so `insertDecisionIfChanged` suppresses all but the first.
 * Recording the clock instead is what produced a measured 1.44 GB/day in production (ADR-0024) —
 * and this path is re-entered on every provider event about the bump's branch, which is precisely
 * the repeat-evaluation shape that bill was run up on.
 *
 * SORTED BY ID for the same reason: `restatesDecision` canonicalizes object KEYS but array ORDER is
 * significant, and `activeFreezesInWindow` has no `ORDER BY`, so an unsorted array would let a
 * reordered query result make an unchanged situation look new.
 */
export interface BumpMergeFreezeRecord {
  id: string;
  /** Which tier declared it, and therefore which surface resolves `id`: `GET /v1/freezes/{id}` for
   *  `org`, `GET /v1/instance/freezes` for `platform`. Without it a refusal names an id that 404s on
   *  the only surface a reader would try. */
  tier: "org" | "platform";
  /** NULL for a platform freeze — that tier has no object id in any org's containment chain. */
  scopeObjectId: string | null;
  name: string | null;
  /** The window boundary, ISO-8601. NEVER the clock — see the interface doc. */
  endsAt: string;
}

/** What a covering freeze set says, for a caller that is about to merge. */
export interface BumpMergeFreezeVerdict {
  /** Every covering freeze, deduped and sorted by id. Never empty: a verdict exists only when
   *  something covers the component. */
  freezes: BumpMergeFreezeRecord[];
  /** One sentence an operator can act on — names each freeze, where it was declared and when its
   *  window closes. Composed from stable facts only, so it too is dedup-safe. */
  reason: string;
}

/**
 * Every active freeze covering `componentObjectId`, from both tiers, or `null` when nothing covers
 * it.
 *
 * `null` RATHER THAN AN EMPTY VERDICT, deliberately and for the reason `evaluateFreezeHolds` states
 * for its map: the caller's seam is `const frozen = await checkBumpMergeFreeze(...); if (frozen)
 * { refuse } `, and a present-but-empty verdict would make that `if` true for every bump on the
 * instance.
 *
 * THE SCOPE IS THE COMPONENT WHOSE DEPENDENCY IS BEING BUMPED, and it is the only object either
 * call site could honestly resolve against: the bump is an edit to that component's manifest in that
 * component's repository, and both seams already hold its id from server-owned storage
 * (`bump-dispatch.ts` from the subscription resolution's `componentObjectId`, `bump-gate.ts` from
 * `dependency_bump_authorships.component_object_id`, which no tenant can write). Everything wider —
 * the service, the domain, the org root — is reached by `containmentChain` from it, so a freeze
 * declared at any of those covers the bump without this file naming them.
 *
 * A CONSEQUENCE OF THAT CHOICE, STATED. A component is not a placement and declares no stage
 * coordinate, so `readStageCoordinate` answers `null` for it and an ENVIRONMENT-ADDRESSED platform
 * freeze (`match: { environment: "prod" }`) does not cover a bump. A DEPLOYMENT-WIDE one
 * (`matchAllEnvironments`) does, and covers it unconditionally. That is the honest answer rather than
 * a convenient one: a manifest edit on a branch happens in no environment, so there is no coordinate
 * to match and inventing one would make "freeze prod" mean something different here than it means
 * everywhere else it is read.
 *
 * `now` is injectable for the same reason `evaluateFreezeHolds` takes it — the window boundary is
 * testable without a real sleep, and this repo's integration suite has a CI gate against fixed
 * sleeps. Production passes nothing.
 */
export async function checkBumpMergeFreeze(
  tx: TenantTx,
  orgId: string,
  componentObjectId: string,
  now: Date = new Date()
): Promise<BumpMergeFreezeVerdict | null> {
  const covering = unionFreezes(await freezesByTarget(tx, orgId, [componentObjectId], now));
  if (covering.length === 0) return null;
  const freezes = describeBumpMergeFreezes(covering);
  return {
    freezes,
    reason:
      `auto-merge is withheld: ${freezes.length} active change freeze(s) cover component ` +
      `${componentObjectId} — ` +
      freezes.map(describeOneFreeze).join("; ") +
      `. The pull request is open and stays open; merging into the default branch is what the ` +
      `freeze refuses. No further provider event is needed: a background sweep re-checks every ` +
      `withheld bump on this instance once a minute and merges this one within about that long of ` +
      `the freeze releasing — whether it expires, is lifted or is shortened`
  };
}

/** The Decision projection — sorted, and carrying the boundary rather than the clock. */
function describeBumpMergeFreezes(freezes: EffectiveFreeze[]): BumpMergeFreezeRecord[] {
  return [...freezes]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((f) => ({
      id: f.id,
      tier: f.tier,
      scopeObjectId: f.tier === "platform" ? null : f.scopeObjectId,
      name: f.name,
      endsAt: f.endsAt.toISOString()
    }));
}

/** One freeze, in one phrase — the tier is named because the two are lifted through different doors
 *  by different principals, and an operator reading the refusal needs to know which one they hold. */
function describeOneFreeze(f: BumpMergeFreezeRecord): string {
  return (
    `${f.tier} freeze '${f.name ?? f.id}' (${f.id})` +
    (f.scopeObjectId === null
      ? " declared by this deployment's operator, deployment-wide"
      : ` at scope ${f.scopeObjectId}`) +
    ` until ${f.endsAt}`
  );
}
