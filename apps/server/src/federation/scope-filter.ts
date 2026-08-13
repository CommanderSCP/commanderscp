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
/**
 * M20.2 (ADR-0031 §2/§3) — is this journal entry one whose object never leaves its own security
 * domain?
 *
 * Exported so the two sides can be reasoned about (and tested) independently of the scope modes,
 * and so `export-repo.ts`/`import-repo.ts` can report *why* an entry was withheld without
 * re-deriving the rule. Never widen this to consult anything outside the entry: the whole design
 * rests on {@link entryMatchesScope} staying a pure, synchronous predicate that the importer — which
 * cannot query the sender's database — can apply to exactly the same input and reach exactly the
 * same answer.
 */
export function isDomainLocalEntry(entry: SyncJournalEntry): boolean {
  return (entry.payload as { domainLocal?: unknown }).domainLocal === true;
}

export function entryMatchesScope(entry: SyncJournalEntry, scope: SyncScope): boolean {
  // M20.2 (ADR-0031 §3) — DOMAIN-LOCAL ENTRIES MATCH NO SCOPE, IN EITHER DIRECTION.
  //
  // Ahead of the mode switch, and deliberately not a case inside it: this is not a narrower scope,
  // it is a property of the ENTRY that no scope can override. `full` is the mode that proves it —
  // the widest scope there is, and the one an operator reaches for when something is missing, so a
  // clause reachable only from the narrow modes would leak exactly when someone widens to debug.
  //
  // `=== true` rather than truthiness: the payload is `Record<string, unknown>` off the wire, and a
  // filter deciding what crosses a security boundary must have no coercion in it. The stamp is
  // written ONLY when true (`graph/objects-repo.ts`), so absent means false and there is no
  // third, unknown state to resolve — which is why the column behind it is NOT NULL.
  //
  // Applied at BOTH ends, like every predicate in this module: `export-repo.ts` filters here so the
  // bytes never leave, and `import-repo.ts` re-applies it so a peer that ships one anyway — a
  // misconfigured or downgraded sender — still has it dropped rather than applied. That symmetry is
  // only possible because the flag rides IN the payload; resolving it by a database lookup at
  // export time would leave the receiving side with nothing to check.
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

/** The one entry shape that carries a change's GRAPH OBJECT across a peer boundary. Probed through
 *  {@link entryMatchesScope} itself rather than restated as a list of modes, so this predicate can
 *  never drift from the filter it describes. It deliberately carries no `labels`: under a `custom`
 *  label selector, whether any given change object rides is a per-object fact this domain cannot
 *  know in advance, so the probe answers "not guaranteed" — the conservative direction. */
const CHANGE_OBJECT_PROBE = {
  entryKind: "object_upsert",
  payload: { typeId: "change" }
} as unknown as SyncJournalEntry;

/**
 * True when a peer at this scope will send us the change GRAPH OBJECTS it authors — i.e. when the
 * ABSENCE of a change object locally is a real observation rather than a filter artifact.
 *
 * Read consumers need this to stay honest. `status_only` forwards `change_status` (positive
 * evidence that changes exist on the peer) while withholding the `object_upsert` that carries the
 * change itself; `policies_only` forwards neither; a `custom` selector may forward some and not
 * others. Under any of those, "no change object here" means "I was not sent one", NOT "none
 * exists" — see `coordination/service-board.ts`, which would otherwise report a component
 * mid-release as `stable`.
 *
 * Sound for the RECEIVING side specifically because `import-repo.ts` re-applies this same predicate
 * against the RECEIVER's own `peer.syncScope` (defense in depth), so a local scope that excludes
 * change objects excludes them regardless of what the sender chose to ship.
 */
export function scopeCarriesChangeObjects(scope: SyncScope): boolean {
  return entryMatchesScope(CHANGE_OBJECT_PROBE, scope);
}
