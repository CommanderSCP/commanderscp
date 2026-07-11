import type { SyncJournalEntry, SyncScope } from "@scp/schemas";

/**
 * Sync scope filtering (DESIGN.md §13: "sync scope is configurable per peer: full graph /
 * policies-only / changes-only / status-only / label-selector custom").
 *
 * SECURITY-SENSITIVE (M6 review fix — MAJOR: confidentiality). Applied at BOTH export and import.
 * `export-repo.ts` ships ONLY the in-scope entries to a scoped peer — a `policies_only` /
 * `status_only` / `custom` peer, scoped precisely FOR confidentiality, must never receive the
 * full plaintext graph on disk / in transit (the earlier design filtered only at import, so the
 * complete graph was still disclosed to a peer that then simply chose not to APPLY the parts
 * outside its scope). `importSyncBundle` re-applies this same predicate as defense-in-depth.
 *
 * A scope-filtered bundle is therefore SPARSE — its sequence has deliberate gaps — so it is
 * verified with `verifyJournalChain({ contiguous: false })` (every rowHash + signature still
 * checked; only omission of in-scope entries is undetectable, inherent to being shown part of a
 * chain). The importer's cursor still advances to the FULL range's `throughSequence` so
 * out-of-scope entries are marked seen and never re-requested. A future per-scope sub-chain (using
 * the reserved `base_revision`/`conflict` journal fields) could restore full contiguity proofs
 * per scope without a format break; out of v1 scope. Changing a peer's scope requires a full
 * re-sync from sequence 0 (the cursor has already advanced past entries a widened scope would now
 * want) — documented operational boundary.
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
