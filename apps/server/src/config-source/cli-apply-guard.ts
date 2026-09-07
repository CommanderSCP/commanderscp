/** The D7 single-ownership predicate. See docs/config-source.md §4. */

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

/** A null binding returns the stack to CLI-push. See docs/config-source.md §5. */
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
