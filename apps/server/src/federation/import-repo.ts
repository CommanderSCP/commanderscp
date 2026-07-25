import {
  asContainmentDomainId,
  asTrustDomainId,
  type ContainmentDomainId,
  type SyncBundle,
  type SyncJournalEntry,
  type SyncScope,
  type TrustDomainId
} from "@scp/schemas";
import {
  computeBundleChecksum,
  verifyBundleSignature,
  verifyJournalChain,
  JOURNAL_CONTIGUITY_BREAK_CODES,
  type JournalChainBreakCode
} from "@scp/schemas/federation-journal";
import type { TenantTx } from "../db/tenant-tx.js";
import { conflict, ProblemError } from "../errors.js";
import { ensureFederationSelf } from "./self-repo.js";
import { getPeerByIdOrName, listPeerKeyWindows, verificationKeyForSequence } from "./peers-repo.js";
import { getCursor, advanceCursor, type SyncCursor } from "./cursors-repo.js";
import { recordBundleTransfer, type BundleTransport } from "./bundle-transfers-repo.js";
import { entryMatchesScope } from "./scope-filter.js";
import {
  clearUnattachedChangeStatus,
  recordUnattachedChangeStatus
} from "./unattached-change-status-repo.js";
import { createRelationship, deleteRelationship } from "../graph/relationships-repo.js";
import { deleteObject, isUuid, upsertObjectByUrn } from "../graph/objects-repo.js";
import { updateObject } from "../graph/objects-repo.js";
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";

/**
 * `scp federation import` — the receiving side of the `.scpbundle` file transport (DESIGN.md
 * §13). SECURITY-SENSITIVE (M6 PR body flag — every check here is fail-closed by construction:
 * an exception aborts the whole caller transaction, applying nothing):
 *
 *  1. Bundle-level: the payload must hash to the claimed `checksum`, and `checksum` must verify
 *     against the EXPORTING peer's Ed25519 public key (resolved at the historical point in time
 *     the bundle claims to have been exported, honoring key rotation).
 *  2. Chain-level: every entry from `cursor+1` onward must form a contiguous, correctly-signed
 *     hash chain continuing from the LAST entry this side actually applied (`sync_cursors`'
 *     `lastAppliedRowHash` — not just internal-to-this-bundle contiguity, which alone would let an
 *     attacker splice in a fabricated sub-chain at an arbitrary cursor). `verifyJournalChain`
 *     returning `valid: false` for ANY reason rejects the ENTIRE segment — no partial-prefix
 *     application.
 *  3. Row-level (graph/objects-repo.ts, graph/relationships-repo.ts): single-writer authority is
 *     re-checked on every individual write via `FederationImportContext` — a bundle cannot make
 *     this domain apply a write claiming authorship of an object it doesn't already know belongs
 *     to the SAME origin domain the bundle is nominally from.
 *
 * Import applies through the exact same repo functions the public API's write path uses
 * (`upsertObjectByUrn`, `createRelationship`, ...) — DESIGN §6: "a federation bundle import is
 * literally a replay of public-API writes that converges no matter how many times it is applied."
 * This is also why import can never bypass local RLS/RBAC/tenancy: it runs inside the SAME
 * `withTenantTx` as any other request, under the SAME `scp_app` role, so a bundle addressed to
 * org A can only ever write org A's rows — there is no cross-org code path here at all.
 */

// Well-known sentinel actor id for federation-import-authored audit events — no `objects` row
// backs it (audit_events.actor_id carries no FK constraint, by design — schema.ts). Distinct from
// any real user/service-account id so `scp audit verify`/UI can recognize "this action came from
// a federation import," not a masquerading human actor.
//
// Must be a value `z.string().uuid()` actually accepts: Zod's UUID regex only special-cases the
// literal nil UUID (all zeros — already claimed by coordination/system-actor.ts's SYSTEM_ACTOR_ID)
// and the literal max UUID (all f's), rejecting any other non-RFC-4122 string including
// "…-00000000fed0" (found live: it 500'd GET /api/v1/audit-events' response schema the moment a
// federation-import-authored audit event existed). Use the max UUID as federation's sentinel.
export const FEDERATION_IMPORT_ACTOR_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

function isNotFound(err: unknown): boolean {
  return err instanceof ProblemError && err.status === 404;
}

/** The lifecycle state a `change_status` payload reports, from EITHER of the two shapes that exist:
 *  `toState` (a transition entry) or `state` (a propose entry). `null` when neither is a string —
 *  payloads are `z.record(z.string(), z.unknown())` on the wire, so nothing here may assume a type. */
function reportedChangeState(payload: Record<string, unknown>): string | null {
  const raw = payload.toState ?? payload.state;
  return typeof raw === "string" ? raw : null;
}

/**
 * The change object id a `change_status` payload names, but ONLY when it is genuinely a UUID.
 *
 * Load-bearing, not defensive noise: `federation_unattached_change_status.change_object_id` is a
 * `uuid` column, and a malformed value would make the INSERT throw and poison the whole import
 * transaction — turning "one unrecordable enrichment entry" into "this peer's entire bundle is
 * rejected", a strictly worse outcome than the drop this record exists to stop. Payloads are
 * `z.record(z.string(), z.unknown())`, so nothing upstream guarantees the shape.
 */
function recordableChangeObjectId(payload: Record<string, unknown>): string | null {
  const raw = payload.objectId;
  return typeof raw === "string" && isUuid(raw) ? raw : null;
}

/**
 * The `change_status` enrichment's object lookup with case (a) — "this domain holds no replica of
 * the object the entry names" — separated from every other failure: returns null rather than
 * throwing, so the caller's best-effort catch covers only genuinely unexpected errors instead of
 * collapsing the expected `status_only` shape and a real bug into one silent swallow.
 */
async function findReplicaOrNull(
  tx: TenantTx,
  orgId: string,
  objectId: string
): Promise<Awaited<ReturnType<typeof getObjectByIdOrUrnAnyType>> | null> {
  try {
    return await getObjectByIdOrUrnAnyType(tx, orgId, objectId);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/**
 * SECURITY-SENSITIVE (M6 review fix — CRITICAL: single-writer authority was forgeable on CREATE).
 * The ONLY domain a signed bundle may vouch authorship for is the domain that cryptographically
 * SIGNED it (the verified `exporterDomainId`). M6 federation is direct-peer: there is no multi-hop
 * relay of a third party's origin (that is the deferred reserved-fields path, DESIGN §13). So:
 *
 *  - The signed, hash-chained top-level `entry.originDomainId` MUST equal the exporter. A malicious
 *    but legitimately-paired peer X could otherwise sign an entry for a NEW urn claiming
 *    `originDomainId = <parent P>`; on the create path `createObject` would write that verbatim
 *    (the update-path 409 authority check only guards EXISTING rows), making the victim believe P
 *    authoritatively owns an object X forged — and an inflated `revision` would then permanently
 *    409-block P's real future updates (a durable DoS on P's authority).
 *  - Any free-form `payload.originDomainId` (attacker-controlled) MUST be absent or equal the
 *    exporter — never trusted as the authority, never written.
 *
 * Called on every entry BEFORE apply (including scope-skipped ones), so a bundle containing ANY
 * forged-authorship entry is rejected wholesale, fail-closed.
 */
function assertEntryAuthoredBySigner(entry: SyncJournalEntry, exporterDomainId: string): void {
  if (entry.originDomainId !== exporterDomainId) {
    throw conflict(
      `forged authorship (rejected, fail-closed): entry ${entry.id} (sequence ${entry.sequence}) ` +
        `claims origin domain '${entry.originDomainId}', but the bundle was signed by '${exporterDomainId}' ` +
        `— a peer can only vouch for its OWN authorship`
    );
  }
  const claimed = entry.payload.originDomainId;
  if (claimed !== undefined && claimed !== null && String(claimed) !== exporterDomainId) {
    throw conflict(
      `forged authorship (rejected, fail-closed): entry ${entry.id} (sequence ${entry.sequence}) ` +
        `payload claims origin domain '${String(claimed)}', but the bundle was signed by '${exporterDomainId}'`
    );
  }
}

/**
 * Resolves an imported object's LOCAL containment placement (`objects.domain_id`) — a genuinely
 * separate concern from single-writer CONTENT authority (`originDomainId`), and one this
 * milestone's own two-domain E2E surfaced the hard way: `authz/resolve.ts`'s RBAC containment
 * walk assumes "every object's chain terminates at ITS OWN org's root" (that module's own doc
 * comment). Preserving a foreign domain's `domainId` verbatim breaks that assumption the moment
 * the referenced parent wasn't ALSO replicated (the common case — DESIGN §13 never requires
 * syncing an origin domain's own root/containment objects) — the replica becomes a syntactically
 * valid but UNREACHABLE-BY-RBAC row: no local role binding's containment walk can ever reach it,
 * so every authorized read/write against it fails closed with 403, forever.
 *
 * The fix: `domainId` is LOCAL PLACEMENT, not authority — DESIGN §13's single-writer authority
 * governs WHO may write a row, never WHERE it displays in a domain's own containment tree. So:
 * if the payload's claimed parent id already exists in THIS org (e.g. a nested hierarchy that WAS
 * fully replicated, parent-first, in this same import), preserve it — the nesting is genuinely
 * meaningful locally too. Otherwise (the common case), the replica is placed under THIS domain's
 * OWN org root instead (`undefined` — `graph/objects-repo.ts`'s existing default), which is
 * reachable by every role binding an operator normally holds. An explicit `null` (the origin's
 * own object WAS its org root) is preserved as `null` only when nothing else already exists at
 * that exact id locally, avoiding a collision with this domain's OWN, unrelated root object.
 */
async function resolveImportDomainId(
  tx: TenantTx,
  orgId: string,
  rawDomainId: unknown
): Promise<ContainmentDomainId | null | undefined> {
  if (rawDomainId === null) return undefined; // never re-parent a replica onto THIS domain's own root
  if (typeof rawDomainId !== "string") return undefined;
  const parent = await tx.query.objects.findFirst({
    where: (t, { eq: eqOp, and: andOp, isNull: isNullOp }) =>
      andOp(eqOp(t.id, rawDomainId), eqOp(t.orgId, orgId), isNullOp(t.deletedAt))
  });
  // BOUNDARY (ADR-0021 D4): `rawDomainId` is untyped bundle-payload JSON. It becomes a
  // containment domain id only once it has been shown to name a live object in THIS org.
  return parent ? asContainmentDomainId(rawDomainId) : undefined;
}

async function applyEntry(
  tx: TenantTx,
  orgId: string,
  entry: SyncJournalEntry,
  exporterDomainId: TrustDomainId
): Promise<void> {
  const payload = entry.payload;
  const requestId = `federation-import:${entry.id}`;

  switch (entry.entryKind) {
    case "object_upsert":
    case "policy_upsert": {
      const typeId = String(payload.typeId);
      const urn = String(payload.urn);
      const revision = Number(payload.revision ?? entry.sequence);
      // Authority is the cryptographically-verified signer — NEVER the attacker-controlled
      // `payload.originDomainId` (validated identical to `exporterDomainId` by
      // `assertEntryAuthoredBySigner` before we get here). CRITICAL review fix.
      const originDomainId = exporterDomainId;
      const { object: upserted } = await upsertObjectByUrn(tx, {
        orgId,
        typeId,
        actorObjectId: FEDERATION_IMPORT_ACTOR_ID,
        requestId,
        urn,
        id: typeof payload.id === "string" ? payload.id : undefined,
        name: String(payload.name ?? urn),
        domainId: await resolveImportDomainId(tx, orgId, payload.domainId),
        properties: (payload.properties as Record<string, unknown>) ?? {},
        labels: (payload.labels as Record<string, unknown>) ?? {},
        federationImport: { originDomainId, revision, provenance: null }
      });
      // THE EVIDENCE RESOLVES ITSELF. If this domain had previously recorded unattached
      // `change_status` for this very object (the status entry arrived before its object — routine
      // at any scope wide enough to ship both), that ignorance is now over: the change object IS
      // here and the board's normal replica treatment takes over. Clearing it is what stops the
      // signal from being a ratchet — see `unattached-change-status-repo.ts`. Keyed on the object
      // id rather than on `typeId === "change"` so it is correct even if a future entry kind
      // carries the same id; a delete that matches nothing is a no-op. The id comes from the row
      // that ACTUALLY landed, not from `payload.id` (which is optional on the wire).
      await clearUnattachedChangeStatus(tx, orgId, exporterDomainId, upserted.id);
      return;
    }
    case "object_tombstone": {
      const typeId = String(payload.typeId);
      const idOrUrn = String(payload.urn ?? payload.id);
      try {
        await deleteObject(tx, {
          orgId,
          typeId,
          actorObjectId: FEDERATION_IMPORT_ACTOR_ID,
          requestId,
          idOrUrn,
          federationImport: { originDomainId: exporterDomainId, revision: entry.sequence }
        });
      } catch (err) {
        if (isNotFound(err)) return; // never replicated locally — nothing to tombstone
        throw err;
      }
      return;
    }
    case "relationship_upsert": {
      // Authority is the verified signer, never `payload.originDomainId`. CRITICAL review fix
      // (same forgeable-authority-on-create hole as object_upsert above).
      const originDomainId = exporterDomainId;
      const revision = Number(payload.revision ?? entry.sequence);
      try {
        await createRelationship(tx, {
          orgId,
          actorObjectId: FEDERATION_IMPORT_ACTOR_ID,
          requestId,
          id: typeof payload.id === "string" ? payload.id : undefined,
          typeId: String(payload.typeId),
          fromId: String(payload.fromId),
          toId: String(payload.toId),
          properties: (payload.properties as Record<string, unknown>) ?? {},
          labels: (payload.labels as Record<string, unknown>) ?? {},
          federationImport: { originDomainId, revision }
        });
      } catch (err) {
        // Endpoints not yet replicated locally (out-of-order relative to this domain's own
        // history — should not happen for a from-genesis or contiguous-cursor import, since a
        // relationship's origin domain always creates its endpoints first in its OWN chain, but
        // handled defensively rather than failing the whole bundle over one skippable edge).
        if (err instanceof ProblemError && err.status === 400) return;
        throw err;
      }
      return;
    }
    case "relationship_tombstone": {
      try {
        await deleteRelationship(tx, {
          orgId,
          actorObjectId: FEDERATION_IMPORT_ACTOR_ID,
          requestId,
          id: String(payload.id),
          federationImport: { originDomainId: exporterDomainId, revision: entry.sequence }
        });
      } catch (err) {
        if (isNotFound(err)) return;
        throw err;
      }
      return;
    }
    case "change_status": {
      // Best-effort enrichment ONLY: mirrors the lifecycle state into the change's already-
      // replicated graph object (from a corresponding object_upsert entry) for cross-domain
      // status visibility. Never creates a LOCAL `changes` state-machine row — a synced change
      // must never be picked up by this domain's own reconciliation loop (DESIGN §13
      // single-writer authority: replicas are read-only, and "read-only" here specifically means
      // "not managed by MY engine," not just "not graph-writable"). Swallows any failure (e.g. the
      // underlying object hasn't been replicated yet) — this entry kind is enrichment, not core
      // graph content, so it must never abort an otherwise-valid import.
      //
      // THE TWO FAILURE MODES ARE NOT THE SAME, and are no longer collapsed into one bare `catch`:
      //
      //  (a) NO REPLICATED OBJECT TO ATTACH TO — the normal, expected shape for a peer paired at
      //      `status_only` scope (scope-filter.ts sends `change_status` but never the change's
      //      `object_upsert`), and a transient one at wider scopes when this entry precedes the
      //      object it refers to. Note precisely what this means: this domain HAS received positive
      //      evidence that a change exists on the peer (this entry names `payload.objectId` and
      //      `payload.toState`) — it is NOT equivalent to "no change was ever proposed there". The
      //      evidence is nonetheless dropped: a `change_status` payload carries no `targets`, so
      //      nothing here can attribute it to a component, and synthesizing a graph object from it
      //      would fabricate name/targets/urn this domain was never sent.
      //
      //      THE EVIDENCE IS NO LONGER DROPPED. It is recorded in
      //      `federation_unattached_change_status` (drizzle/0040) — the "federation-layer store for
      //      unattached peer status" this comment used to name as missing future work. It carries
      //      the object id, the propose-time urn/name when the payload supplied them, and the last
      //      reported state, and it is DELETED by the `object_upsert` branch above the moment the
      //      change object actually lands. `coordination/service-board.ts` reads it so a board can
      //      no longer report a confident `stable` over evidence this domain literally received.
      //      Attribution stays at (peer, change) grain — per-COMPONENT would need `targets` on the
      //      wire; see the repo module's header for that owner decision.
      //  (b) ANY OTHER failure — still swallowed (enrichment must never abort a valid import), but
      //      deliberately distinguished below so (a) is not used to explain away (b).
      try {
        const objectId = String(payload.objectId ?? "");
        if (!objectId) return;
        const reportedState = reportedChangeState(payload);
        const existing = await findReplicaOrNull(tx, orgId, objectId);
        if (!existing) {
          // (a) — evidence received; nothing local to attach it to. RECORD it.
          const recordableId = recordableChangeObjectId(payload);
          if (recordableId) {
            await recordUnattachedChangeStatus(tx, {
              orgId,
              peerDomainId: exporterDomainId,
              changeObjectId: recordableId,
              urn: typeof payload.urn === "string" ? payload.urn : null,
              name: typeof payload.name === "string" ? payload.name : null,
              lastState: reportedState,
              dropReason: "no_local_replica"
            });
          }
          return;
        }
        if (existing.originDomainId !== exporterDomainId) return; // not a replica of THIS peer — leave alone
        const state = reportedState;
        if (!state) return;
        await updateObject(tx, {
          orgId,
          typeId: existing.typeId,
          actorObjectId: FEDERATION_IMPORT_ACTOR_ID,
          requestId,
          idOrUrn: existing.id,
          properties: { ...existing.properties, federationState: state },
          federationImport: { originDomainId: exporterDomainId, revision: existing.revision + 1 }
        });
      } catch {
        // (b) only — case (a) never reaches here (it returns from inside the branch above). Still
        // swallowed: enrichment must never abort an otherwise-valid import. Note the (a) RECORD
        // sits inside this try deliberately: a genuine failure of that write would poison the
        // surrounding transaction anyway (Postgres), so the whole import fails closed at COMMIT —
        // swallowing it here cannot turn a broken write into a silently green import.
      }
      return;
    }
    case "approval_evidence":
    case "audit_segment":
    case "key_rotation":
      // Informational-only in a plain sync bundle (v1): already hash-chained/signed on the
      // exporting side (audit-completeness lives there); not separately persisted here. Promotion
      // Bundles carry approval evidence through a DEDICATED, validated path instead
      // (promotion-repo.ts's `importedApprovalEvidence` table) — that is the flow the DoD's
      // "tampered/missing approval attestation rejects the approval as evidence" test targets.
      return;
    default:
      return;
  }
}

export interface ImportSyncBundleResult {
  peerDomainId: string;
  appliedEntries: number;
  skippedEntries: number;
  lastAppliedSequence: number;
}

/**
 * SEGMENT VERIFICATION — strict, fail-closed, one path; only the DIAGNOSTIC is smart.
 *
 * WHAT THIS DOES. `contiguous` is chosen from the RECEIVER's `peer.syncScope` and from nothing
 * else. A `full` receiver demands an exactly gap-free, prev_hash-linked, cursor-continuous run
 * (with trust-on-first-sync for the very first segment ever seen from an origin); a receiver
 * configured narrow verifies the sparse shape it asked for. A run that does not verify is
 * REJECTED — there is no fallback, no laxer retry, and no path by which a chain with a hole in it
 * is applied.
 *
 * WHY NOT "ACCEPT A SPARSE CHAIN FROM A NARROWER SENDER" (owner decision). It is true that a
 * sender narrowed to `status_only`/`changes_only`/`policies_only` legitimately ships a chain full
 * of holes, and that a `full` receiver meeting one is almost certainly looking at a config
 * asymmetry rather than an attack. It is ALSO true that a sparse run and a maliciously thinned run
 * are the same bytes: the bundle checksum/signature only prove the SENDER produced what arrived,
 * so a signer (or anyone holding its key) can delete a middle entry, re-sign, and a receiver that
 * tolerates holes will take it. Contiguity is the ONLY check that catches that, and this is the
 * one place it is caught. So it stays absolute. The misconfiguration is fixed where it belongs —
 * in the operator's hands, with a message that tells them exactly what to fix.
 *
 * THE MESSAGE IS THE FEATURE. A contiguity break (`sequence_gap` / `prev_hash_mismatch` —
 * `JOURNAL_CONTIGUITY_BREAK_CODES`) gets {@link describeContiguityBreak}: an opening clause that
 * states what the CODE actually means (the two do not mean the same thing — see
 * {@link describeBreakShape}), the peer, THIS side's `sync_scope` verbatim, why a gap-free chain
 * was expected, BOTH ways a scope change legitimately produces this (a narrower sender shipping a
 * sparse chain; a re-widened/re-narrowed side left on a stale cursor anchor), and the commands to
 * compare. It never says "tampered" — that would be a
 * verdict, and the likeliest cause is config. It also never says the opposite: a broken chain IS
 * what withheld or removed entries look like, and the message says so too. Every OTHER break code
 * (`row_hash_mismatch`, `signature_invalid`, `no_public_key`, `sequence_not_increasing`,
 * `sequence_before_start`) is a content-integrity failure and keeps the security-toned wording.
 */
function verifySegment(input: {
  entries: SyncJournalEntry[];
  cursor: SyncCursor;
  receiverExpectsContiguity: boolean;
  receiverScope: SyncScope;
  peerName: string;
  exporterDomainId: TrustDomainId;
  resolvePublicKey: (entry: SyncJournalEntry) => string | null;
}): void {
  const { entries, cursor, receiverExpectsContiguity, resolvePublicKey } = input;
  if (entries.length === 0) return;

  const isFirstSyncFromThisOrigin = cursor.sequence === 0 && cursor.rowHash === null;
  const verification = verifyJournalChain(entries, {
    contiguous: receiverExpectsContiguity,
    expectedPrevHash:
      receiverExpectsContiguity && !isFirstSyncFromThisOrigin
        ? (cursor.rowHash ?? undefined)
        : undefined,
    // Full first-sync: anchor to the bundle's own first entry (trust-on-first-sync). Otherwise a
    // lower bound of cursor+1 (exact for contiguous; minimum for sparse).
    expectedStartSequence:
      receiverExpectsContiguity && isFirstSyncFromThisOrigin
        ? entries[0]!.sequence
        : cursor.sequence + 1,
    // Per-entry key resolved by AUTHENTICATED sequence (never timestamp) — an entry signed before
    // a rotation verifies against the old key only while its sequence is within that key's window.
    resolvePublicKey
  });
  if (verification.valid) return;

  const code = verification.brokenAt?.code;
  const reason = verification.brokenAt?.reason ?? "unknown";
  if (code && JOURNAL_CONTIGUITY_BREAK_CODES.includes(code)) {
    throw conflict(describeContiguityBreak(input, code, reason));
  }
  throw conflict(`tampered or broken journal segment (rejected, fail-closed): ${reason}`);
}

/** This side's `sync_scope`, verbatim — the operator cannot read it from the other domain, and for
 *  `custom` the mode name alone is not the configuration. */
function describeScope(scope: SyncScope): string {
  return scope.mode === "custom"
    ? `custom ${JSON.stringify(scope.labelSelector)}`
    : `'${scope.mode}'`;
}

/**
 * THE OPENING CLAUSE MUST MATCH THE CODE. The two contiguity codes do not mean the same thing, and
 * saying "not gap-free" for both is false half the time:
 *  - `sequence_gap` really is "the run I was shown has holes in it" — sequences are missing.
 *  - `prev_hash_mismatch` is "this run does not link to the anchor I am holding". The run can be
 *    perfectly contiguous, gap-free and authentic and still fail this, because the anchor is THIS
 *    side's state, not the peer's. Telling that operator their peer shipped a chain with gaps
 *    sends them hunting for something that is not there.
 */
function describeBreakShape(code: JournalChainBreakCode, peerLabel: string): string {
  return code === "sequence_gap"
    ? `journal chain from peer ${peerLabel} is not gap-free — sequences are missing from the run`
    : `journal run from peer ${peerLabel} does not link to this side's last known-good anchor ` +
        `(prev_hash) — the arriving run may itself be perfectly contiguous`;
}

/**
 * THE DIAGNOSTIC for a contiguity break. Two things the operator cannot see from one side: what
 * shape the arriving run actually has, and what THIS side is configured to expect. Deliberately
 * NOT a verdict in either direction — the likely causes plus what to check, and an explicit note
 * that a genuine break looks identical, because this check is exactly where that is caught.
 *
 * BOTH DIRECTIONS OF A SCOPE CHANGE ARE NAMED, because the product itself produces both. A sender
 * narrower than this side ships a sparse chain (`sequence_gap`). But re-widening or re-narrowing
 * EITHER side leaves this side's cursor anchored under the previous scope regime, so the peer's
 * next run — contiguous, gap-free, authentic — does not link to that stale anchor
 * (`prev_hash_mismatch`). Leading the operator to a tampering investigation for a state the
 * product just created is exactly the failure this message exists to avoid, so the withheld-after-
 * signing clause is kept but gated on "and no scope changed since the last accepted import".
 */
function describeContiguityBreak(
  input: {
    receiverScope: SyncScope;
    peerName: string;
    exporterDomainId: TrustDomainId;
  },
  code: JournalChainBreakCode,
  reason: string
): string {
  const { receiverScope, peerName, exporterDomainId } = input;
  return (
    `${describeBreakShape(code, `'${peerName}' (${exporterDomainId})`)} — import rejected, ` +
    `fail-closed (${reason}). ` +
    `This side's sync_scope for that peer is ${describeScope(receiverScope)}, which expects a ` +
    `contiguous, gap-free, prev_hash-linked chain with no missing sequences. sync_scope is ` +
    `per-side LOCAL config: never carried on the wire and never reconciled, so neither operator ` +
    `can see the other side's value from their own — which makes a scope change on EITHER side ` +
    `the most likely cause here, in either of two shapes. ` +
    `(1) ASYMMETRY: a peer whose OWN sync_scope for this domain is narrower (status_only / ` +
    `changes_only / policies_only / custom) legitimately ships a SPARSE chain, which a side at ` +
    `'full' refuses. ` +
    `(2) RE-ALIGNMENT: re-widening or re-narrowing either side back does not rewrite this side's ` +
    `cursor, which is still anchored to the previous scope regime — so the peer's next run, ` +
    `contiguous and authentic though it is, links to an anchor this side no longer expects. ` +
    `Run \`scp federation peers\` on BOTH domains, align the two sync_scope values, and check ` +
    `whether either side's scope changed since the last accepted import; then re-export. ` +
    `If the two sides already agree AND neither scope has changed since that import, this is an ` +
    `unexplained break in the peer's journal — entries withheld or removed after signing look ` +
    `exactly like this — and should be investigated as such.`
  );
}

export async function importSyncBundle(
  tx: TenantTx,
  orgId: string,
  bundle: SyncBundle,
  /** HOW this bundle reached us. Defaults to `"bundle"` — every path EXCEPT the live-pull scheduler
   *  is a file/pushed/inbox handoff, and the scheduler is the one caller that passes `"live-pull"`
   *  explicitly. Recorded on the transfer row so the §13 "as of" label can attribute the transport
   *  from fact rather than from a timestamp comparison that cannot work (drizzle/0041). */
  transport: BundleTransport = "bundle"
): Promise<ImportSyncBundleResult> {
  const self = await ensureFederationSelf(tx, orgId);
  if (bundle.header.peerDomainId !== self.domainId) {
    throw conflict(
      `bundle is addressed to domain '${bundle.header.peerDomainId}', not this domain ('${self.domainId}')`
    );
  }
  // BOUNDARY (ADR-0021 D4): the exporter identity arrives as a plain string on the wire. It is
  // the bundle's claimed AUTHORITY, and every use below (cursor key, single-writer stamp) is the
  // trust sense — never a containment parent. Asserted once here, after the addressed-to-us check
  // and immediately before the peer lookup that pins it to a paired peer.
  const exporterDomainId = asTrustDomainId(bundle.header.exporterDomainId);
  const peer = await getPeerByIdOrName(tx, orgId, exporterDomainId);
  const keyWindows = await listPeerKeyWindows(tx, orgId, peer.id);
  const currentPeerKey = keyWindows.find((k) => k.supersededAtSequence === null)?.publicKey ?? null;

  // 1. Bundle-level checksum + signature — fail closed. The checksum covers the HEADER as well as
  //    the entries (M6 review fix — CRITICAL: an unsigned header let anyone rewrite exporterDomainId
  //    / sinceSequence / throughSequence / exportedAt in transit), so a rewritten header fails here.
  const recomputedChecksum = computeBundleChecksum({
    header: bundle.header,
    entries: bundle.entries
  });
  if (recomputedChecksum !== bundle.checksum) {
    throw conflict(
      "bundle checksum mismatch — payload does not match the signed checksum (rejected, fail-closed)"
    );
  }
  // The exporter signs with the key current when it exported, i.e. the key valid at the highest
  // sequence the bundle covers (`throughSequence`); empty bundles fall back to the current key.
  // Key selection is anchored to the AUTHENTICATED sequence — NEVER a self-declared timestamp
  // (M6 review fix — CRITICAL: rotation now hard-revokes a compromised key for all new content).
  const bundleKey =
    verificationKeyForSequence(keyWindows, bundle.header.throughSequence) ?? currentPeerKey;
  if (!bundleKey || !verifyBundleSignature(bundle.checksum, bundle.bundleSignature, bundleKey)) {
    throw conflict("bundle signature verification failed (rejected, fail-closed)");
  }

  // 2. Resume-from-cursor + hash-chain verification, continuous with what was actually applied
  //    last time (not just internally contiguous within this one bundle) — EXCEPT on the very
  //    first sync ever received from this origin (cursor.sequence === 0), where there is by
  //    definition no prior state to demand exact continuity from. DESIGN.md §13 explicitly
  //    anticipates starting mid-chain here ("`scp federation export`... + optional snapshot for
  //    bootstrap"): an outpost may bootstrap from a snapshot/later cursor rather than absolute
  //    sequence 1. In that one case, trust-on-first-sync applies: verification anchors to the
  //    bundle's OWN first entry (still checking every entry's signature and the chain's INTERNAL
  //    contiguity from there) rather than demanding the impossible ("prove this is really
  //    sequence 1 forward" when it may legitimately not be). Every SUBSEQUENT sync from the same
  //    origin, once a cursor is established, is held to the strict exact-continuity check —
  //    closing the gap an attacker could otherwise exploit by claiming "this is my first sync"
  //    indefinitely to splice in an arbitrary later segment.
  // A scope-filtered bundle (any non-`full` peer — MAJOR review fix) is SPARSE: it deliberately
  // omits out-of-scope entries, so its sequence has gaps and each entry's `prevHash` points at an
  // omitted predecessor this side never sees. Such a bundle is verified with `contiguous: false`
  // (still checking every rowHash + signature + strictly-increasing sequence — only omission of
  // in-scope entries becomes undetectable, inherent to scoping). A `full` peer keeps the strict
  // contiguous, cursor-continuous verification with trust-on-first-sync — and keeps it: a `full`
  // receiver meeting a narrower SENDER fails closed (owner decision), with a message that names
  // the scope asymmetry as the likely cause instead of crying tampering (`verifySegment`).
  const isFullScope = peer.syncScope.mode === "full";
  const cursor = await getCursor(tx, orgId, peer.id, exporterDomainId);
  const toApply = bundle.entries.filter((entry) => entry.sequence > cursor.sequence);

  // Single-writer authority: every entry about to be applied must be authored by the verified
  // signer — reject the WHOLE bundle if any claims a foreign origin (CRITICAL review fix; see
  // assertEntryAuthoredBySigner). Runs before verification/apply so forged-authorship is caught
  // fail-closed regardless of scope.
  for (const entry of toApply) {
    assertEntryAuthoredBySigner(entry, exporterDomainId);
  }

  // Throws a 409 on ANY failure — there is no accept-anyway path. The 409's `detail` is the
  // operator-facing diagnostic and every transport carries it verbatim: `POST /v1/federation/imports`
  // returns it as the problem detail, the live-pull scheduler records it as the peer's `refused`
  // reason + block Decision (federation-sync.ts), and the air-gap inbox walk records it on the
  // ledger row + block Decision for the offending file (inbox-loop.ts).
  verifySegment({
    entries: toApply,
    cursor,
    receiverExpectsContiguity: isFullScope,
    receiverScope: peer.syncScope,
    peerName: peer.name,
    exporterDomainId,
    resolvePublicKey: (entry) => verificationKeyForSequence(keyWindows, entry.sequence)
  });

  let applied = 0;
  let lastSequence = cursor.sequence;
  for (const entry of toApply) {
    // Import-side scope filter kept as DEFENSE-IN-DEPTH (the bundle is already scope-filtered at
    // export). All toApply entries in a scoped bundle are in-scope; this only ever skips if an
    // exporter shipped something out-of-scope.
    if (entryMatchesScope(entry, peer.syncScope)) {
      await applyEntry(tx, orgId, entry, exporterDomainId);
      applied += 1;
    } else if (entry.entryKind === "change_status") {
      // THE SECOND DROP CHOKEPOINT. This receiver's OWN scope discarded a change-status entry that
      // the sender did ship — e.g. a `policies_only` receiver. The board's scope-derived caveat
      // already covers this case, but recording it is strictly more precise (it names WHICH change
      // and its state, so the caveat can be conditioned on the change still being in flight rather
      // than firing forever). Recorded only for `change_status`: no other skipped entry kind
      // carries a lifecycle state this domain could otherwise mistake for "nothing is happening".
      const payload = entry.payload;
      const objectId = recordableChangeObjectId(payload);
      if (objectId) {
        await recordUnattachedChangeStatus(tx, {
          orgId,
          peerDomainId: exporterDomainId,
          changeObjectId: objectId,
          urn: typeof payload.urn === "string" ? payload.urn : null,
          name: typeof payload.name === "string" ? payload.name : null,
          lastState: reportedChangeState(payload),
          dropReason: "receiver_scope"
        });
      }
    }
    lastSequence = entry.sequence;
    // Full scope: advance per applied entry, carrying the rowHash for next sync's continuity check.
    if (isFullScope) {
      await advanceCursor(tx, orgId, peer.id, exporterDomainId, entry.sequence, entry.rowHash);
    }
  }

  // Scoped: advance ONCE to the FULL range's tail (header.throughSequence), so out-of-scope entries
  // are marked seen and never re-requested. rowHash continuity is not used for a sparse chain, so
  // store null (we don't hold throughSequence's rowHash — it may be an out-of-scope entry).
  if (!isFullScope) {
    const advanceTo = Math.max(cursor.sequence, bundle.header.throughSequence, lastSequence);
    if (advanceTo > cursor.sequence) {
      await advanceCursor(tx, orgId, peer.id, exporterDomainId, advanceTo, null);
    }
  }

  const skipped = bundle.entries.length - toApply.length;

  await recordBundleTransfer(tx, {
    orgId,
    peerDomainId: peer.id,
    direction: "import",
    kind: "sync",
    status: "confirmed",
    sinceSequence: bundle.header.sinceSequence,
    throughSequence: bundle.header.throughSequence,
    checksum: bundle.checksum,
    transport
  });

  return {
    peerDomainId: peer.id,
    appliedEntries: applied,
    skippedEntries: skipped,
    lastAppliedSequence: lastSequence
  };
}
