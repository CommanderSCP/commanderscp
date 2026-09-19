import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * `managed-iac`'s plan-summary chip (docs/proposals/pipeline-mockup-data.md §6): the structured
 * add/change/destroy tally the mockups draw as `"plan 7c1e · 2 add / 0 change / 1 destroy"`.
 *
 * SOURCE: `apps/runner-iac/run.sh` writes `/workspace/plan.json` via `tofu show -json` for every
 * action (`plan` and `rollback`; `apply` leaves the antecedent plan's file in place, since it only
 * ever applies a plan already produced by a prior `plan` action in the same workspace). That is a
 * STRUCTURED document, so this reads `resource_changes[].change.actions` — NEVER human stdout,
 * which would need a locale- and tofu-version-stable regex over a string this codebase does not
 * control.
 *
 * HONESTY (charter principle 6: absent ≠ unknown ≠ zero): anything that is not a genuine plan
 * document — invalid JSON, no `resource_changes` array (the shape `tofu show -json` of a STATE
 * file produces, which is exactly what `rollback` writes to the same `plan.json` name) — returns
 * `undefined`, never a zeroed `{add: 0, change: 0, destroy: 0}`.
 */
export interface PlanSummary {
  /** A stable identity for THIS plan document — its own sha256 hex digest, so re-reading the same
   *  evidence twice (a re-poll, an `apply` that leaves `plan.json` untouched) reports one
   *  unchanging `ref` rather than manufacturing a new one. The UI slices it for display, the same
   *  idiom `revision.slice(0, 7)` already uses elsewhere on this row. */
  ref: string;
  add: number;
  change: number;
  destroy: number;
}

/**
 * One resource's `change.actions` -> which tally it moves. `no-op`/`read` (and anything else
 * unrecognised) move neither. A replace's `actions` array carries BOTH `create` and `delete` —
 * counted in ADD and DESTROY, never CHANGE — the same convention `tofu plan`'s own human summary
 * line uses ("N to add, N to change, N to destroy"), so the structured count here never disagrees
 * with the number an operator already knows from stdout.
 */
function tallyActions(
  actions: unknown,
  tally: { add: number; change: number; destroy: number }
): void {
  if (!Array.isArray(actions)) return;
  const creates = actions.includes("create");
  const deletes = actions.includes("delete");
  if (creates) tally.add += 1;
  if (deletes) tally.destroy += 1;
  if (!creates && !deletes && actions.includes("update")) tally.change += 1;
}

/**
 * Pure parse — no filesystem — so the malformed/absent-shape cases are unit-testable against a
 * literal string, no fixture file needed. Returns `undefined` (never a zeroed summary) for
 * anything that is not a real plan document.
 */
export function summarizePlanJson(raw: string): PlanSummary | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const resourceChanges = (parsed as { resource_changes?: unknown }).resource_changes;
  // NOT a plan document at all (e.g. `tofu show -json` of a STATE file — no `resource_changes`
  // key). An EMPTY array is a real, honest zero-change plan and is deliberately NOT caught here.
  if (!Array.isArray(resourceChanges)) return undefined;

  const tally = { add: 0, change: 0, destroy: 0 };
  for (const entry of resourceChanges) {
    if (typeof entry !== "object" || entry === null) continue;
    const change = (entry as { change?: unknown }).change;
    if (typeof change !== "object" || change === null) continue;
    tallyActions((change as { actions?: unknown }).actions, tally);
  }

  return {
    ref: createHash("sha256").update(raw).digest("hex"),
    ...tally
  };
}

/**
 * Reads `<workspaceDir>/plan.json`. Absent on ANY read failure — missing file (a `plan` step that
 * failed before producing it), permission error, anything — never thrown: a missing plan summary
 * must not fail the run whose own outcome this file is merely enriching.
 */
export async function summarizePlanFile(workspaceDir: string): Promise<PlanSummary | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(workspaceDir, "plan.json"), "utf8");
  } catch {
    return undefined;
  }
  return summarizePlanJson(raw);
}
