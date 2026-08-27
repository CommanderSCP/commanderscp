/**
 * The D7 single-ownership predicate (team-pipeline-iac proposal §4/§5, D7):
 *
 * > "The one new rule is single ownership per stack: a stack bound to a config source is
 * > repo-owned, and a direct CLI apply against it is refused (409 naming the owning config
 * > source) — otherwise the next sync would silently revert the push. Removing the stack from the
 * > config-source registration returns it to CLI-push."
 *
 * PURE LOGIC ONLY: whether a stack IS bound to a config source is a DB read (a later increment's
 * job, once the API-surface slot frees). This module is the decision that read feeds — given the
 * binding (or its absence), decide whether `scp apply`'s direct path is refused, and build the
 * self-explaining detail a 409 response carries. Every stack that is not repo-owned behaves exactly
 * as it does today (`allowed: true`, unconditionally) — this module changes nothing about that
 * path; it only adds the one new refusal D7 describes.
 */

/** The config source a stack is bound to, as far as this predicate needs to know. `name` is
 *  carried alongside `id` so the refusal message is self-explaining without a second lookup — the
 *  409 names the config source a caller can go inspect, not just an opaque id. */
export interface StackConfigSourceBinding {
  configSourceId: string;
  configSourceName: string;
}

export type CliApplyDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: "repo_owned";
      configSourceId: string;
      configSourceName: string;
      /** The full sentence a 409 response can return verbatim — self-explaining per D7's own
       *  wording ("409 naming the owning config source"). */
      message: string;
    };

/**
 * `binding` is `null` for every stack not bound to a config source — including a stack that WAS
 * bound and had the binding removed (D7: "removing the stack from the config-source registration
 * returns it to CLI-push"), since that removal is exactly what turns this function's next call for
 * the same stack from the refusing branch back to `{ allowed: true }`. There is no third state:
 * "bound but ambiguous" is `registration-match.ts`'s concern at SYNC time, not this predicate's —
 * by the time a stack carries a binding here, sync has already resolved it to exactly one config
 * source.
 */
export function evaluateCliApplyOwnership(
  binding: StackConfigSourceBinding | null
): CliApplyDecision {
  if (binding === null) return { allowed: true };
  return {
    allowed: false,
    reason: "repo_owned",
    configSourceId: binding.configSourceId,
    configSourceName: binding.configSourceName,
    message:
      `this stack is repo-owned by config source '${binding.configSourceName}' ` +
      `(${binding.configSourceId}) — apply is delivered by that repo's sync, not a direct CLI ` +
      `apply, or the next sync would silently revert the push; remove the stack from the config ` +
      `source's registration to return it to CLI-push`
  };
}
