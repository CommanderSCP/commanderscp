/** Config-source sync status computation. See docs/config-source.md §35. */

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
      // A new stage without a case fails the build here. See docs/config-source.md §36.
      const exhaustive: never = outcome;
      throw new Error(`config-source sync: unhandled outcome stage ${JSON.stringify(exhaustive)}`);
    }
  }
}
