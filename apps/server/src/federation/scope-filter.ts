import type { SyncJournalEntry, SyncScope } from "@scp/schemas";

/**
 * Sync scope filtering (DESIGN.md §13: "sync scope is configurable per peer: full graph /
 * policies-only / changes-only / status-only / label-selector custom").
 *
 * IMPLEMENTATION NOTE (M6 PR body — documented deviation): applied at IMPORT/apply time, not at
 * export time. Stripping non-matching entries out of an exported segment BEFORE signing would
 * fragment the journal's sequence contiguity (`verifyJournalChain` requires no gaps), which this
 * milestone does not attempt to solve with per-scope sub-chains (the reserved `base_revision`/
 * `conflict` journal fields are exactly the kind of format-compatible extension point a future
 * per-scope chain could use without a format break). Every peer therefore currently receives —
 * and cryptographically verifies — the FULL signed history for the exported range; sync scope
 * narrows what the IMPORTING side actually applies to its local graph, not what is disclosed in
 * transit. Confidentiality across scope boundaries is out of v1 scope; only the FILE transport and
 * `federation-https`'s transport-level mTLS bound exposure today.
 */
export function entryMatchesScope(entry: SyncJournalEntry, scope: SyncScope): boolean {
  switch (scope.mode) {
    case "full":
      return true;
    case "policies_only":
      return entry.entryKind === "policy_upsert" || entry.entryKind === "key_rotation";
    case "changes_only":
      return (
        entry.entryKind === "change_status" ||
        entry.entryKind === "approval_evidence" ||
        (entry.entryKind === "object_upsert" && entry.payload.typeId === "change") ||
        (entry.entryKind === "object_tombstone" && entry.payload.typeId === "change")
      );
    case "status_only":
      return entry.entryKind === "change_status" || entry.entryKind === "audit_segment";
    case "custom": {
      const labels = (entry.payload as { labels?: unknown }).labels;
      if (!labels || typeof labels !== "object") return false;
      const record = labels as Record<string, unknown>;
      return Object.entries(scope.labelSelector).every(([key, value]) => record[key] === value);
    }
    default:
      return false;
  }
}

export function filterByScope(entries: SyncJournalEntry[], scope: SyncScope): SyncJournalEntry[] {
  return entries.filter((entry) => entryMatchesScope(entry, scope));
}
