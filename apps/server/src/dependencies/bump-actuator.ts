import type { TenantTx } from "../db/tenant-tx.js";
import type { DependencySubscriptionDelivery } from "@scp/schemas";
import { conflict } from "../errors.js";
import { proposeChange } from "../coordination/changes-repo.js";
import { deriveUrn } from "../graph/urn.js";
import { SYSTEM_ACTOR_ID } from "../coordination/system-actor.js";
import { listControlRunsForChange } from "../governance/controls-repo.js";
import { delegationRefusalMessage, readStandingDelegationVerdict } from "./delegation-detection.js";

/**
 * M21.5 — THE ACTUATOR SEAM: what the server decides BEFORE `scp-managed-dep` is dispatched, and
 * what it records so the commit that comes back is recognised as its own.
 *
 * Three things live here, and nothing else does. The plugin performs the edit and the write; the
 * subscription resolution (M21.3) decides who is subscribed; this is only the narrow band between
 * them where the SERVER has to make a decision the plugin structurally cannot.
 *
 *   1. THE DELEGATION RE-CHECK ({@link assertComponentNotDelegated}) — the other half of the
 *      authoring-time refusal, for the components the authoring-time refusal cannot see.
 *   2. THE DELIVERY RESOLUTION ({@link resolveEffectiveDelivery}) — auto-merge is downgraded to a
 *      pull request unless a governed control already evidenced the component's own checks passed.
 *   3. THE BUMP CHANGE ({@link recordBumpChange}) — recorded so that the push webhook this bump
 *      eventually produces CORRELATES TO IT rather than minting a second, unrelated change.
 */

/** The branch prefix `@scp/plugin-managed-dep` authors under. Restated here rather than imported so
 *  the server does not take a build-time dependency on a plugin package for a string the CORRELATION
 *  path needs; `delegation-detection.test.ts`'s "the authored-branch contract" block pins the two
 *  against each other — along with the descriptor {@link buildBumpIntentParameters} emits — which is
 *  the seam where a drift would actually hurt. */
export const BUMP_BRANCH_PREFIX = "scp/dep-bump/";

/** The fully-qualified ref a bump for `changeObjectId` is authored on. */
export function bumpRefFor(changeObjectId: string): string {
  return `refs/heads/${BUMP_BRANCH_PREFIX}${changeObjectId}`;
}

/** `changes.source_kind` for a bump SCP authored. Distinct from `github` deliberately: the ORIGIN of
 *  this change is CommanderSCP's own subscription resolution, not an observed provider event, and a
 *  reader that cannot tell those apart cannot answer "did we author this?". */
export const BUMP_SOURCE_KIND = "dependency-bump";

/**
 * ============================================================================================
 * THE DELEGATION RE-CHECK — the half the authoring-time refusal structurally cannot cover
 * ============================================================================================
 * `subscription-authoring-guard.ts`'s `assertNoDelegatedDependencyUpdates` refuses a policy whose
 * `scope.objectRef` names a component with a standing delegation verdict. It CANNOT refuse a
 * `selector`-scoped enable, because a selector names no component — by design, since a selector is
 * meant to match objects that do not exist yet.
 *
 * So the same stored verdict is read again here, immediately before SCP would write to the
 * repository. That is not belt-and-braces: it is the only point at which the component is known for
 * a selector-scoped enable, and it is also what makes a delegation ADDED AFTER the policy was
 * authored stop the writes rather than only the policy. One stored fact, two readers, neither of
 * them fail-open.
 */
export async function assertComponentNotDelegated(
  tx: TenantTx,
  orgId: string,
  componentObjectId: string
): Promise<void> {
  const standing = await readStandingDelegationVerdict(tx, orgId, componentObjectId);
  if (!standing?.delegated) return;
  throw conflict(delegationRefusalMessage(standing.collisions), {
    decisionId: standing.decisionId
  });
}

export type DeliveryResolution = {
  delivery: DependencySubscriptionDelivery;
  /** Why. Carried into the bump change's `sourceRef` so "why was this not auto-merged?" is
   *  answerable from the change alone (charter principle 6). */
  reason: string;
  /** The control run that evidenced green, when one did. */
  controlObjectId?: string;
  controlRunId?: string;
};

/**
 * ============================================================================================
 * AUTO-MERGE IS EVIDENCED BY A GOVERNED CONTROL — AND THIS IS NOT A SECOND GATE
 * ============================================================================================
 * The charter: "automatic merge is permitted only where a governed control evidences that the
 * component's own checks passed". ADR-0032 §8: "Auto-merge's CI-green condition is expressed as a
 * governed control so the existing gate machinery decides, not new code."
 *
 * So this function INVENTS NOTHING. It reads `control_runs` — the rows the existing machinery
 * already deposits (`governance/control-runner.ts`'s `ensureControlRun` for a wave-boundary gate,
 * `coordination/gates.ts` for a lifecycle edge) — for the bump change, and asks one question: did a
 * governed control PASS? The control that answers it in practice is `@scp/plugin-github-check`,
 * which is exactly "CI green for this change's commit" and was built for that purpose in M10.4.
 *
 * WHY IT IS EXPRESSED AS A DOWNGRADE RATHER THAN A REFUSAL. `pull_request` is the more restrictive
 * member of the pair and the resolver already treats it as such (`DependencySubscriptionDeliverySchema`:
 * "auto-merge is the privileged option and is acquired unanimously"). A bump whose checks have not
 * (yet) gone green is not a bump that must not happen — it is a bump that must be delivered the safe
 * way. Throwing here would withhold the pull request that the checks need in order to run at all.
 *
 * FAIL-CLOSED IN EVERY DIRECTION THAT MATTERS:
 *   * no control run at all               -> pull_request ("absent never means passed")
 *   * only `expired` runs (CI in flight)  -> pull_request
 *   * ANY `fail`/`timed_out`              -> pull_request, even if another control passed
 *   * a control run that passed           -> auto_merge, named in the reason
 *
 * The "any fail wins" rule is deliberate and is the same asymmetry the subscription merge itself
 * uses: a single objecting contribution defeats any number of permitting ones, because the cost of
 * the two mistakes is not symmetric.
 */
export async function resolveEffectiveDelivery(
  tx: TenantTx,
  orgId: string,
  input: { changeObjectId: string; requested: DependencySubscriptionDelivery }
): Promise<DeliveryResolution> {
  if (input.requested === "pull_request") {
    return { delivery: "pull_request", reason: "the subscription resolved to pull_request" };
  }

  const runs = await listControlRunsForChange(tx, orgId, input.changeObjectId);
  if (runs.length === 0) {
    return {
      delivery: "pull_request",
      reason:
        "auto_merge was asked for, but no governed control has evidenced this component's own checks — absent never means passed"
    };
  }
  const objecting = runs.find((r) => r.status === "fail" || r.status === "timed_out");
  if (objecting) {
    return {
      delivery: "pull_request",
      reason: `auto_merge was asked for, but control ${objecting.controlObjectId} reported '${objecting.status}'`,
      controlObjectId: objecting.controlObjectId,
      controlRunId: objecting.id
    };
  }
  const passing = runs.find((r) => r.status === "pass");
  if (!passing) {
    return {
      delivery: "pull_request",
      reason: `auto_merge was asked for, but no governed control has passed yet (latest: '${runs[0]?.status ?? "none"}')`
    };
  }
  return {
    delivery: "auto_merge",
    reason: `control ${passing.controlObjectId} evidenced this component's own checks passed`,
    controlObjectId: passing.controlObjectId,
    controlRunId: passing.id
  };
}

export interface RecordBumpChangeInput {
  orgId: string;
  requestId: string;
  componentObjectId: string;
  /** The repository the bump is authored into, as `changes.source_ref.repo` spells it elsewhere. */
  repo: string;
  /** The branch the bump is based on and the pull request will target. */
  baseBranch: string;
  ecosystem: string;
  coordinate: string;
  manifestPath: string;
  /**
   * EVERY manifest path this component's inventory declares (ADR-0032 §3 projection rows), not just
   * the one being edited.
   *
   * It is here because the plugin's manifest-only verifier refuses a target the component does not
   * declare — "a manifest the component already contains", in the charter's words — and the only
   * place that fact exists is the server's inventory. Sending just `manifestPath` and letting the
   * plugin default the set to it would make that gate compare a value with itself and pass
   * vacuously; the plugin therefore REQUIRES this and refuses a descriptor without it.
   *
   * It is a descriptor, not content: a list of references to files that already exist, exactly the
   * category `manifestPath` itself is in (ADR-0032 §9's distinction).
   */
  declaredManifestPaths: string[];
  fromVersion: string;
  toVersion: string;
  delivery: DeliveryResolution;
}

/**
 * ============================================================================================
 * THE PROVENANCE LOOP — a commit SCP authors must come back as ITSELF
 * ============================================================================================
 * ADR-0032 §9's closing sentence: "A commit SCP authors is observed back in via the normal webhook
 * path, so the bump change must be recorded such that the returning event CORRELATES TO IT rather
 * than minting a second, unrelated change."
 *
 * That sentence describes a real hazard rather than a tidiness concern. Today EVERY change is minted
 * by `coordination/webhook-processor.ts` from an OBSERVED event: it extracts a hint, matches
 * `source_mappings`, and calls `proposeChange`. A bump SCP authors produces a perfectly ordinary push
 * to the component's repository, which matches that component's perfectly ordinary source mapping —
 * so without something to stop it, one bump becomes TWO changes: the one SCP recorded when it decided
 * to author, and the one the webhook minted when the commit arrived. They would gate independently,
 * appear as two releases of the same component, and neither would know about the other.
 *
 * THE JOIN IS THE BRANCH, AND IT IS DECLARED ON BOTH SIDES. The change is recorded FIRST, so its id
 * exists; the branch the plugin authors is `scp/dep-bump/<changeObjectId>`, so the id is carried in
 * the one field a git push always has. The change ALSO records the repo and ref it claims, under
 * `source_ref.scp_authored`. Correlation then requires BOTH: the incoming ref must name a change, and
 * that change must claim this repo and this ref.
 *
 * REQUIRING BOTH IS THE WHOLE POINT, not defensiveness. A branch name is attacker-typable — anyone
 * who can push to any repository this instance observes could create `scp/dep-bump/<some-uuid>` and,
 * with a one-sided check, attach their push to somebody else's change. Reading the change's own
 * declaration is what makes the correlation a fact SCP asserted rather than a claim the payload made.
 * It is the same "declared, never inferred" rule ADR-0030 §2 states for pipeline classification and
 * that this repository's own provenance-label lesson learned the hard way.
 *
 * WHY THE BRANCH AND NOT THE COMMIT SHA. The sha is only known after the push, so a webhook that
 * arrives before the actuator has finished recording it would find nothing — a race whose losing side
 * is exactly the double-change this exists to prevent. The branch is chosen BEFORE anything is
 * written and is therefore race-free.
 */
export async function recordBumpChange(
  tx: TenantTx,
  input: RecordBumpChangeInput
): Promise<{ changeObjectId: string; authoredRef: string }> {
  const name = `dependency bump: ${input.coordinate} ${input.fromVersion} -> ${input.toVersion}`;
  // The change id is minted by `proposeChange`, but the ref must be known to record ON the change —
  // so the id is chosen here and passed in. `proposeChange` accepts an explicit `id` for exactly this
  // kind of caller.
  const { randomUUID } = await import("node:crypto");
  const changeObjectId = randomUUID();
  const authoredRef = bumpRefFor(changeObjectId);

  await proposeChange(tx, {
    orgId: input.orgId,
    id: changeObjectId,
    // The system actor: nobody asked for this change, a new version was released. Identical
    // attribution to the webhook processor's own proposals, and for the identical reason.
    actorObjectId: SYSTEM_ACTOR_ID,
    requestId: input.requestId,
    name,
    urn: deriveUrn(input.orgId, "change", name, changeObjectId),
    sourceKind: BUMP_SOURCE_KIND,
    sourceRef: {
      repo: input.repo,
      // THE DECLARATION the correlation half verifies against. Nothing else in `source_ref` is
      // load-bearing for correlation, and nothing outside this key may be used for it.
      scp_authored: {
        repo: input.repo,
        ref: authoredRef,
        baseBranch: input.baseBranch,
        ecosystem: input.ecosystem,
        coordinate: input.coordinate,
        manifestPath: input.manifestPath,
        fromVersion: input.fromVersion,
        toVersion: input.toVersion,
        delivery: input.delivery.delivery,
        deliveryReason: input.delivery.reason,
        ...(input.delivery.controlRunId
          ? {
              evidencedByControlObjectId: input.delivery.controlObjectId,
              evidencedByControlRunId: input.delivery.controlRunId
            }
          : {})
      }
    },
    targets: [input.componentObjectId]
  });

  return { changeObjectId, authoredRef };
}

/**
 * What the server hands `scp-managed-dep` as `intent.parameters` — a DESCRIPTOR, and every field of
 * it names something that already exists in the component's repository or is a version token.
 *
 * Deliberately built in ONE place: the plugin refuses any parameter that could hold authored file
 * content (`CONTENT_BEARING_KEYS`), and a caller assembling this object ad hoc is how such a key
 * eventually gets added by someone who finds it convenient. There is no `sourceFiles` here and there
 * is nowhere to put one.
 */
export function buildBumpIntentParameters(
  input: RecordBumpChangeInput & { changeObjectId: string }
): Record<string, unknown> {
  return {
    ecosystem: input.ecosystem,
    coordinate: input.coordinate,
    manifestPath: input.manifestPath,
    declaredManifestPaths: input.declaredManifestPaths,
    fromVersion: input.fromVersion,
    toVersion: input.toVersion,
    repo: input.repo,
    baseBranch: input.baseBranch,
    changeObjectId: input.changeObjectId,
    delivery: input.delivery.delivery
  };
}
