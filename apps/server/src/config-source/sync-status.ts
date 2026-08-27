/**
 * Config-source sync status computation (team-pipeline-iac proposal §4, "failure honesty"):
 *
 * > "A manifest that fails validation or an apply that is refused (authz, freeze, strict-create)
 * > produces a visible config-source status (API/UI/CLI) and a Decision — never a silent skip. The
 * > repo being ahead of the graph must be a *displayed* state, not an inferred one."
 *
 * A sync attempt stops at exactly one of six places, and this module's whole job is making that
 * six-way space EXHAUSTIVE in the type system, so a status can never be inferred by its absence:
 *
 *   1. the manifest could not be read at all (git error, not found, refused-too-large) —
 *      `manifest_unreadable`
 *   2. it was read but failed schema validation — `manifest_invalid`
 *   3. it validated but `authorize()` refused one or more diff entries — `authz_refused`
 *   4. it authorized but an active freeze parks the apply (ADR-0028 hold shape, "freezes hold, not
 *      block") — `freeze_held`
 *   5. it applied, and the plan carried at least one non-noop entry — `applied`
 *   6. it applied, and the plan was entirely `noop` (idempotent re-sync of an unchanged manifest,
 *      §5 "Idempotent") — `no_op`
 *
 * `computeConfigSourceSyncStatus` takes {@link SyncAttemptOutcome} — where ONE sync attempt
 * actually stopped, as the caller (a later increment's DB-backed sync loop) observed it — and maps
 * it onto the display status above. The switch below has NO `default:` branch: TypeScript's
 * exhaustiveness check on the `never` assignment is what makes a forgotten case a COMPILE ERROR
 * here rather than a status that silently falls through to nothing, which is exactly the bug this
 * module exists to make structurally impossible.
 */

export interface SyncAuthzRefusal {
  action: string;
  typeId: string;
  reason: string;
}

/** Where one sync attempt stopped, and the facts needed to explain that stopping point. Modeled as
 *  a discriminated union (rather than one object with several optional fields) so an inconsistent
 *  combination — e.g. `validation_failed` with no errors, or a freeze hold with no freeze ids — is
 *  unrepresentable rather than merely undocumented. */
export type SyncAttemptOutcome =
  | { stage: "read_failed"; detail: string }
  | { stage: "validation_failed"; errors: readonly string[] }
  | { stage: "authz_refused"; refusals: readonly SyncAuthzRefusal[] }
  | { stage: "freeze_held"; freezeIds: readonly string[] }
  /** Reached apply. `changedEntryCount` is the number of non-noop diff entries — the same
   *  noop-exemption convention `iac/plans-repo.ts` uses everywhere else in this codebase — and is
   *  what distinguishes `applied` from `no_op` below; it is never inferred from `stage` alone. */
  | { stage: "plan_computed"; changedEntryCount: number };

export type ConfigSourceSyncStatus =
  | { status: "manifest_unreadable"; detail: string }
  | { status: "manifest_invalid"; errors: readonly string[] }
  | { status: "authz_refused"; refusals: readonly SyncAuthzRefusal[] }
  | { status: "freeze_held"; freezeIds: readonly string[] }
  | { status: "applied"; changedEntryCount: number }
  | { status: "no_op" };

export function computeConfigSourceSyncStatus(outcome: SyncAttemptOutcome): ConfigSourceSyncStatus {
  switch (outcome.stage) {
    case "read_failed":
      return { status: "manifest_unreadable", detail: outcome.detail };
    case "validation_failed":
      return { status: "manifest_invalid", errors: outcome.errors };
    case "authz_refused":
      return { status: "authz_refused", refusals: outcome.refusals };
    case "freeze_held":
      return { status: "freeze_held", freezeIds: outcome.freezeIds };
    case "plan_computed":
      return outcome.changedEntryCount > 0
        ? { status: "applied", changedEntryCount: outcome.changedEntryCount }
        : { status: "no_op" };
    default: {
      // Unreachable for any value `SyncAttemptOutcome` can type-check as: `outcome` narrows to
      // `never` here only if every stage above was handled. A NEW stage added to the union without
      // a matching `case` fails the build at this line — the type system, not a code reviewer, is
      // what keeps this switch exhaustive. Left as a thrown error (never a fallback status) so that
      // even a `// @ts-expect-error`-forced bad value at a call site is loud at runtime too, rather
      // than being silently reported as some OTHER, unrelated status.
      const exhaustive: never = outcome;
      throw new Error(`config-source sync: unhandled outcome stage ${JSON.stringify(exhaustive)}`);
    }
  }
}
