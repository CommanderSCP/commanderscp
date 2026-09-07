import type { SyncJournalEntry, SyncScope } from "@scp/schemas";

/** Sync scope filtering. See docs/federation.md §522. */
/** Is this entry one whose object never leaves its domain. See docs/federation.md §523. */
export function isDomainLocalEntry(entry: SyncJournalEntry): boolean {
  return (entry.payload as { domainLocal?: unknown }).domainLocal === true;
}

export function entryMatchesScope(entry: SyncJournalEntry, scope: SyncScope): boolean {
  // Domain-local entries match no scope, in either direction. See docs/federation.md §524.
  if (isDomainLocalEntry(entry)) return false;
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

/** The one entry shape carrying a change's object across. See docs/federation.md §525. */
const CHANGE_OBJECT_PROBE = {
  entryKind: "object_upsert",
  payload: { typeId: "change" }
} as unknown as SyncJournalEntry;

/** True when a peer at this scope sends us its own objects. See docs/federation.md §526. */
export function scopeCarriesChangeObjects(scope: SyncScope): boolean {
  return entryMatchesScope(CHANGE_OBJECT_PROBE, scope);
}
