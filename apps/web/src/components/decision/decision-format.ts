import { ScpApiError, type Decision } from "@scp/sdk";

/**
 * Decision formatting shared by every surface that renders a Decision timeline (design spec §2.13):
 * change detail, change pipeline, and (after its own migration) campaign detail. Structural inputs
 * only — nothing here imports a campaign type, so adopting it needs no changes to this module.
 */

/** The one-line human summary of a Decision — the `reasonTree.summary` when the server wrote one,
 *  else the raw tree so the record is never silently blank (charter principle 6). */
export function decisionSummary(decision: Decision): string {
  const summary = decision.reasonTree.summary;
  if (typeof summary === "string") return summary;
  return JSON.stringify(decision.reasonTree);
}

/** Every gate/policy block surfaces as a 4xx carrying `decision_id` (DESIGN §6/§10.4) — this is
 *  the UI's one "Why?" plumbing point: pull it back out of a thrown `ScpApiError` so a failed
 *  accept/cancel/rollback can link straight to the Decision record that explains it, instead of
 *  just showing an opaque error string. */
export function decisionIdOf(error: unknown): string | undefined {
  return error instanceof ScpApiError ? error.problem?.decision_id : undefined;
}
