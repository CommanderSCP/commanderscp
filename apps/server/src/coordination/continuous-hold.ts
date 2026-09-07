import type { HookFreshnessContext } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import {
  latestTestRunEvidence,
  listHooksForComponents,
  orgDeclaresHookKind,
  resolveHookSubjects
} from "./pipeline-hooks-repo.js";
import {
  buildHookFreshnessContext,
  evaluateContinuousHold,
  type ContinuousHoldVerdict
} from "./pipeline-hook-verdicts.js";

/** THE CONTINUOUS-TEST HOLD, PREDICATE HALF. See docs/coordination.md §328. */

/** One holding `continuous` hook. Shaped to `ContinuousTestHoldSchema` plus the freshness context
 *  the Decision carries — see the note on the wire projection at the bottom of this file. */
export interface ContinuousHookHold {
  hookId: string;
  /** THREE REASONS, NEVER COLLAPSED. `failed` means the probe ran and the target is sick — check
   *  the target. `stale`/`no_evidence` mean nobody is looking — check the prober. They demand
   *  different operator actions, so they must not share a word. */
  reason: NonNullable<ContinuousHoldVerdict["reason"]>;
  /** Server-composed, rendered verbatim (charter principle 6 — the UI composes no copy from raw
   *  fields). Names ids and instants only, never a display name that can drift. */
  summary: string;
  staleAfter: string | null;
  lastReportedAt: string | null;
  /** `HookFreshnessContextSchema`-shaped, straight from `buildHookFreshnessContext`. This is what
   *  Part 3 requires the Decision's `inputContext` to carry, and it is deliberately built by that
   *  function rather than assembled here so the "no `now`" property has ONE owner. */
  freshness: HookFreshnessContext;
}

/** One held wave target and what is holding it. */
export interface ContinuousHoldTargetVerdict {
  targetObjectId: string;
  /** The (component, deployment-target) pair this target resolves to, or `null` for a
   *  legacy-shaped wave target that names a component directly. Reported, never required. */
  stage: { componentObjectId: string; deploymentTargetObjectId: string | null } | null;
  /** Every holding hook, SORTED BY `hookId`. SORTED IS LOAD-BEARING: this array goes verbatim into
   *  a Decision's `inputContext`, and `restatesDecision` canonicalizes object KEYS only — array
   *  element ORDER is significant, so an unsorted array would let a reordered query result make an
   *  unchanged situation look new. One new row per tick is ADR-0024 rebuilt from parts. */
  holds: ContinuousHookHold[];
}

/** Every target a declared continuous hook is holding. See docs/coordination.md §329. */
export async function evaluateContinuousHolds(
  tx: TenantTx,
  input: { orgId: string; targetObjectIds: string[]; now?: Date }
): Promise<Map<string, ContinuousHoldTargetVerdict>> {
  const { orgId, targetObjectIds } = input;
  const holds = new Map<string, ContinuousHoldTargetVerdict>();
  if (targetObjectIds.length === 0) return holds;

  // THE INERTNESS GATE. One indexed existence read; everything below it is skipped entirely for an
  // org that declares nothing. See the module doc.
  if (!(await orgDeclaresHookKind(tx, orgId, "continuous"))) return holds;

  const now = input.now ?? new Date();
  const subjects = await resolveHookSubjects(tx, orgId, targetObjectIds);
  const componentObjectIds = [...new Set([...subjects.values()].map((s) => s.componentObjectId))];
  const hooks = (await listHooksForComponents(tx, orgId, componentObjectIds)).filter(
    // `maxAgeSeconds` is nullable because the four kinds share one table, and it is REQUIRED on
    // this kind (`ManifestContinuousHookSchema`: "REQUIRED. Evidence older than this is ABSENT").
    // A row without one is not a freshness rule and is skipped rather than defaulted to a window
    // nobody declared — defaulting would invent an enforcement the author never wrote.
    (h) => h.kind === "continuous" && h.maxAgeSeconds !== null
  );
  if (hooks.length === 0) return holds;

  const byComponent = new Map<string, typeof hooks>();
  for (const hook of hooks) {
    const list = byComponent.get(hook.componentObjectId) ?? [];
    list.push(hook);
    byComponent.set(hook.componentObjectId, list);
  }

  for (const targetObjectId of targetObjectIds) {
    const subject = subjects.get(targetObjectId);
    // Absent means the target object is soft-deleted, or a placement is missing half its identity
    // (`resolveHookSubjects`). A DEAD TARGET IS NOT HELD — the same ordering `freeze-hold.ts` makes
    // explicit: holding one parks a row that reconcile should be terminalizing, carrying an
    // explanation that is not merely absent but WRONG.
    if (!subject) continue;

    const applicable = byComponent.get(subject.componentObjectId);
    if (!applicable) continue;

    const held: ContinuousHookHold[] = [];
    for (const hook of applicable) {
      const maxAgeSeconds = hook.maxAgeSeconds!;
      // No binding filter: that is the contract, not an omission. See docs/coordination.md §330.
      const row = await latestTestRunEvidence(tx, orgId, {
        componentObjectId: subject.componentObjectId,
        targetObjectId: subject.targetObjectId,
        hookId: hook.hookId
      });
      const payload =
        row === null
          ? null
          : (row.payload as { outcome: "passed" | "failed"; completedAt: string });

      const verdict = evaluateContinuousHold(
        { maxAgeSeconds },
        payload === null ? null : { outcome: payload.outcome, completedAt: payload.completedAt },
        now
      );
      if (!verdict.held || verdict.reason === undefined) continue;

      const freshness = buildHookFreshnessContext(
        { kind: "continuous", hookId: hook.hookId, maxAgeSeconds },
        row === null || payload === null
          ? null
          : {
              evidenceId: row.id,
              outcome: payload.outcome,
              completedAt: payload.completedAt,
              artifactDigest: row.artifactDigest,
              commitSha: row.commitSha
            }
      );

      held.push({
        hookId: hook.hookId,
        reason: verdict.reason,
        summary: summarize(hook.hookId, verdict),
        staleAfter: verdict.staleAfter,
        lastReportedAt: verdict.lastReportedAt,
        freshness
      });
    }

    if (held.length === 0) continue;
    held.sort((a, b) => a.hookId.localeCompare(b.hookId));
    holds.set(targetObjectId, {
      targetObjectId,
      stage: {
        componentObjectId: subject.componentObjectId,
        deploymentTargetObjectId: subject.deploymentTargetObjectId
      },
      holds: held
    });
  }
  return holds;
}

/** The server-composed sentence. See docs/coordination.md §331. */
export function summarize(hookId: string, verdict: ContinuousHoldVerdict): string {
  switch (verdict.reason) {
    case "failed":
      return `continuous probe '${hookId}' last reported FAILED at ${String(verdict.lastReportedAt)} — the target is sick; check the target`;
    case "stale":
      return `continuous probe '${hookId}' last reported at ${String(verdict.lastReportedAt)} and its evidence went stale at ${String(verdict.staleAfter)} — nobody is looking; check the prober`;
    default:
      return `continuous probe '${hookId}' has never reported — nobody is looking; check the prober`;
  }
}

export interface ContinuousHeldTargetRecord {
  targetObjectId: string;
  componentObjectId: string | null;
  deploymentTargetObjectId: string | null;
  holds: ContinuousHookHold[];
}

/** THE `held` ARRAY OF THE `continuous_test` DECISION. See docs/coordination.md §332. */
export function describeContinuousHeldTargets(
  heldTargets: ContinuousHoldTargetVerdict[]
): ContinuousHeldTargetRecord[] {
  return [...heldTargets]
    .sort((a, b) => a.targetObjectId.localeCompare(b.targetObjectId))
    .map((entry) => ({
      targetObjectId: entry.targetObjectId,
      componentObjectId: entry.stage?.componentObjectId ?? null,
      deploymentTargetObjectId: entry.stage?.deploymentTargetObjectId ?? null,
      holds: entry.holds
    }));
}

/** One line an operator can read, per held target. See docs/coordination.md §333. */
export function describeContinuousHold(verdict: ContinuousHoldTargetVerdict): string {
  return verdict.holds
    .map((h) => `${h.summary} — target ${verdict.targetObjectId} is not triggered while it stands`)
    .join("; ");
}
