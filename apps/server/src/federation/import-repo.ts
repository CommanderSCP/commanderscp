import {
  asContainmentDomainId,
  asTrustDomainId,
  JOURNAL_DIVERGENCE_PROBLEM_TYPE,
  type ContainmentDomainId,
  type SyncBundle,
  type SyncJournalEntry,
  type SyncScope,
  type TrustDomainId,
  PipelineHookKindSchema,
  TestRunEvidenceSchema
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
import {
  getCursor,
  advanceCursor,
  verifyAndAdvanceTailAttestation,
  type SyncCursor
} from "./cursors-repo.js";
import { recordBundleTransfer, type BundleTransport } from "./bundle-transfers-repo.js";
import { recordAuditWitness } from "./audit-witness-repo.js";
import { entryMatchesScope } from "./scope-filter.js";
import {
  deleteHook,
  recordTestRunEvidence,
  upsertHook
} from "../coordination/pipeline-hooks-repo.js";
import {
  clearUnattachedChangeStatus,
  recordUnattachedChangeStatus
} from "./unattached-change-status-repo.js";
import { createRelationship, deleteRelationship } from "../graph/relationships-repo.js";
import { deleteObject, isUuid, upsertObjectByUrn } from "../graph/objects-repo.js";
import { adoptArtifactIdentity, findArtifactByIdentity } from "../graph/artifacts-repo.js";
import { updateObject } from "../graph/objects-repo.js";
import { findObjectByIdOrUrnAnyType, getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import {
  isFreezeObjectType,
  liftFreezeProjectionForTombstonedObject,
  rebuildFreezeProjectionFromObject
} from "../governance/freeze-object.js";
import { getObjectType } from "../graph/type-registry-repo.js";
import { appendAuditEvent } from "../audit/audit-repo.js";

/** `scp federation import`. See docs/federation.md §246. */

// The sentinel actor id for import-authored audit events. See docs/federation.md §247.
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

/** The change id a status names, only when a real UUID. See docs/federation.md §248. */
function recordableChangeObjectId(payload: Record<string, unknown>): string | null {
  const raw = payload.objectId;
  return typeof raw === "string" && isUuid(raw) ? raw : null;
}

/** The `change_status` enrichment's object lookup with case (a). See docs/federation.md §249. */
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

/** Security-sensitive: single-writer authority was forgeable. See docs/federation.md §250. */
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

/** Resolves an imported object's LOCAL containment placement. See docs/federation.md §251. */
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
  exporterDomainId: TrustDomainId,
  /** §7.2.6 — threaded onto every `federationImport` context so a resync overwrites stale revisions. */
  forceOverwrite = false
): Promise<void> {
  const payload = entry.payload;
  const requestId = `federation-import:${entry.id}`;

  switch (entry.entryKind) {
    case "object_upsert":
    case "policy_upsert": {
      const typeId = String(payload.typeId);
      const urn = String(payload.urn);
      const revision = Number(payload.revision ?? entry.sequence);
      // AN UNREGISTERED TYPE COSTS ONE ENTRY, NEVER THE CHANNEL. See docs/federation.md §252.
      if (!(await getObjectType(tx, typeId))) {
        await appendAuditEvent(tx, {
          orgId,
          actorId: FEDERATION_IMPORT_ACTOR_ID,
          action: "federation.import.entry_dropped",
          // `subject_id` is a `uuid` column; a payload id that is not one would poison the
          // transaction this record exists to save. The urn is in `reason` either way.
          subjectId: typeof payload.id === "string" && isUuid(payload.id) ? payload.id : null,
          reason:
            `dropped ${entry.entryKind} entry ${entry.id} (sequence ${entry.sequence}) from ` +
            `'${exporterDomainId}': object type '${typeId}' is not registered at this instance ` +
            `(urn '${urn}'). This instance is behind the peer on migrations; re-sync from genesis ` +
            `after upgrading to replay it. The rest of the bundle was applied.`,
          requestId
        });
        return;
      }
      // An artifact identity collision converges, never drops. See docs/federation.md §253.
      if (typeId === "artifact") {
        const digest = (payload.properties as Record<string, unknown> | undefined)?.digest;
        const artifactType = (payload.properties as Record<string, unknown> | undefined)
          ?.artifactType;
        if (typeof digest === "string" && typeof artifactType === "string") {
          const existingByIdentity = await findArtifactByIdentity(tx, orgId, artifactType, digest);
          if (existingByIdentity && existingByIdentity.id !== payload.id) {
            await adoptArtifactIdentity(tx, orgId, {
              existingId: existingByIdentity.id,
              originDomainId: exporterDomainId,
              revision,
              incomingProperties: (payload.properties as Record<string, unknown>) ?? {},
              actorObjectId: FEDERATION_IMPORT_ACTOR_ID,
              requestId
            });
            return;
          }
        }
      }
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
        federationImport: { originDomainId, revision, provenance: null, forceOverwrite }
      });
      // THE EVIDENCE RESOLVES ITSELF. See docs/federation.md §254.
      await clearUnattachedChangeStatus(tx, orgId, exporterDomainId, upserted.id);
      // A freeze's projection row is rebuilt here. See docs/federation.md §255.
      if (isFreezeObjectType(upserted.typeId)) {
        await rebuildFreezeProjectionFromObject(tx, {
          orgId,
          object: upserted,
          fallbackActorId: FEDERATION_IMPORT_ACTOR_ID
        });
      }
      return;
    }
    case "object_tombstone": {
      const typeId = String(payload.typeId);
      const idOrUrn = String(payload.urn ?? payload.id);
      // Resolved before the delete, since after it the row is gone. See docs/federation.md §256.
      const freezeObjectBeingTombstoned = isFreezeObjectType(typeId)
        ? await findObjectByIdOrUrnAnyType(tx, orgId, idOrUrn)
        : undefined;
      try {
        await deleteObject(tx, {
          orgId,
          typeId,
          actorObjectId: FEDERATION_IMPORT_ACTOR_ID,
          requestId,
          idOrUrn,
          federationImport: {
            originDomainId: exporterDomainId,
            revision: entry.sequence,
            forceOverwrite
          }
        });
      } catch (err) {
        if (isNotFound(err)) return; // never replicated locally — nothing to tombstone
        throw err;
      }
      // A TOMBSTONED FREEZE MUST STOP BLOCKING. See docs/federation.md §257.
      if (freezeObjectBeingTombstoned) {
        await liftFreezeProjectionForTombstonedObject(tx, {
          orgId,
          objectId: freezeObjectBeingTombstoned.id,
          actorId: FEDERATION_IMPORT_ACTOR_ID
        });
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
          federationImport: { originDomainId, revision, forceOverwrite }
        });
      } catch (err) {
        // Endpoints not yet replicated locally. See docs/federation.md §258.
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
          federationImport: {
            originDomainId: exporterDomainId,
            revision: entry.sequence,
            forceOverwrite
          }
        });
      } catch (err) {
        if (isNotFound(err)) return;
        throw err;
      }
      return;
    }
    case "pipeline_hook_upsert": {
      // No try-catch around the write, and that is a correction. See docs/federation.md §259.
      const p = entry.payload as {
        componentObjectId?: unknown;
        kind?: unknown;
        hookId?: unknown;
        workflow?: unknown;
        stage?: unknown;
        everySeconds?: unknown;
        maxAgeSeconds?: unknown;
        quietWindowSeconds?: unknown;
      };
      const parsed = PipelineHookKindSchema.safeParse(p.kind);
      if (
        typeof p.componentObjectId !== "string" ||
        typeof p.hookId !== "string" ||
        !parsed.success
      ) {
        console.error("[federation] pipeline_hook_upsert: malformed payload — dropped");
        return;
      }
      await upsertHook(tx, orgId, {
        federationImport: true,
        componentObjectId: p.componentObjectId,
        kind: parsed.data,
        hookId: p.hookId,
        workflow: p.workflow,
        stage: typeof p.stage === "string" ? p.stage : null,
        everySeconds: typeof p.everySeconds === "number" ? p.everySeconds : null,
        maxAgeSeconds: typeof p.maxAgeSeconds === "number" ? p.maxAgeSeconds : null,
        quietWindowSeconds: typeof p.quietWindowSeconds === "number" ? p.quietWindowSeconds : null
      });
      return;
    }

    case "pipeline_hook_tombstone": {
      // No try-catch around this write either, for the same reason. See docs/federation.md §260.
      const p = entry.payload as {
        componentObjectId?: unknown;
        kind?: unknown;
        hookId?: unknown;
      };
      const parsed = PipelineHookKindSchema.safeParse(p.kind);
      if (
        typeof p.componentObjectId !== "string" ||
        typeof p.hookId !== "string" ||
        !parsed.success
      ) {
        console.error("[federation] pipeline_hook_tombstone: malformed payload — dropped");
        return;
      }
      // A no-op delete is NOT an error — the same rule `deleteHook` itself states. A tombstone
      // for a hook this domain never received (dropped out-of-order, or filtered by scope) is
      // ordinary, and treating it as failure would re-deliver forever.
      await deleteHook(
        tx,
        orgId,
        { componentObjectId: p.componentObjectId, kind: parsed.data, hookId: p.hookId },
        true
      );
      return;
    }

    case "pipeline_evidence_upsert": {
      // No try-catch around this third write, for the same reason. See docs/federation.md §261.
      const p = entry.payload as {
        componentObjectId?: unknown;
        targetObjectId?: unknown;
        hookId?: unknown;
        artifactDigest?: unknown;
        commitSha?: unknown;
        evidence?: unknown;
      };
      if (
        typeof p.componentObjectId !== "string" ||
        typeof p.targetObjectId !== "string" ||
        typeof p.hookId !== "string"
      ) {
        console.error("[federation] pipeline_evidence_upsert: malformed payload — dropped");
        return;
      }
      const parsed = TestRunEvidenceSchema.safeParse(p.evidence);
      if (!parsed.success) {
        // PARSED, NOT TRUSTED. The gate reads `payload` as a `TestRunEvidence` — a row that does
        // not satisfy the schema would be silently unreadable by the only function that consults
        // it, which is worse than absent because the hold would report "no evidence" while a row
        // sat there.
        console.error(
          "[federation] pipeline_evidence_upsert: payload is not TestRunEvidence — dropped"
        );
        return;
      }
      await recordTestRunEvidence(tx, orgId, {
        federationImport: true,
        componentObjectId: p.componentObjectId,
        targetObjectId: p.targetObjectId,
        hookId: p.hookId,
        artifactDigest: typeof p.artifactDigest === "string" ? p.artifactDigest : null,
        commitSha: typeof p.commitSha === "string" ? p.commitSha : null,
        source: "peer_reported",
        producerSubjectId: null,
        evidence: parsed.data
      });
      return;
    }

    case "change_status": {
      // Best-effort enrichment ONLY. See docs/federation.md §262.
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
          federationImport: {
            originDomainId: exporterDomainId,
            revision: existing.revision + 1,
            forceOverwrite
          }
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
    case "audit_segment": {
      // §7.2.7 — no longer discarded. See docs/federation.md §263.
      const auditEventId =
        payload && typeof payload === "object" && "auditEventId" in payload
          ? String((payload as { auditEventId: unknown }).auditEventId)
          : null;
      if (auditEventId) {
        await recordAuditWitness(tx, {
          orgId,
          peerDomainId: exporterDomainId,
          originDomainId: asTrustDomainId(entry.originDomainId),
          sequence: entry.sequence,
          auditEventId,
          contentHash: entry.rowHash
        });
      }
      return;
    }
    case "approval_evidence":
    case "key_rotation":
      // Informational-only in a plain sync bundle (v1). See docs/federation.md §264.
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

/** Segment verification: strict, fail-closed, one path. See docs/federation.md §265. */
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

  const anchor = describeAnchor(cursor);
  const verification = verifyJournalChain(entries, {
    contiguous: receiverExpectsContiguity,
    // Only a REAL recorded hash is ever passed. `undefined` here means genesis, which is the right
    // claim for a true first sync and a lie for an anchorless resumed cursor — the two are kept
    // apart by `anchorToFirstEntry` below rather than by pretending they are the same thing.
    expectedPrevHash:
      receiverExpectsContiguity && anchor.state === "held"
        ? (cursor.rowHash ?? undefined)
        : undefined,
    // The ONE relaxation, and only with a local operator's one-shot permit in force (W1).
    anchorToFirstEntry: receiverExpectsContiguity && anchor.state === "permitted",
    // Full first-sync: anchor to the bundle's own first entry (trust-on-first-sync). Otherwise a
    // lower bound of cursor+1 (exact for contiguous; minimum for sparse) — and note that a
    // re-anchor permit does NOT loosen this: a permitted run must still begin at exactly cursor+1,
    // so nothing between the cursor and the run's start can be skipped.
    expectedStartSequence:
      receiverExpectsContiguity && anchor.state === "genesis"
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
    throw conflict(
      describeContiguityBreak(input, code, reason, {
        ...anchor,
        // Only a break on the run's FIRST entry is a failure of the ANCHOR comparison; from the
        // second entry on, the thing that did not match is the previous entry's own row hash, which
        // is present and real whatever the cursor holds.
        brokeAtRunStart: verification.brokenAt?.sequence === entries[0]!.sequence
      })
    );
  }
  throw conflict(`tampered or broken journal segment (rejected, fail-closed): ${reason}`);
}

/** What a strict run can anchor to, measured from the cursor. See docs/federation.md §266. */
type AnchorState = "held" | "genesis" | "permitted" | "none";

interface AnchorFacts {
  state: AnchorState;
  sequence: number;
}

function describeAnchor(cursor: SyncCursor): AnchorFacts {
  if (cursor.rowHash !== null) return { state: "held", sequence: cursor.sequence };
  if (cursor.sequence === 0) return { state: "genesis", sequence: 0 };
  return {
    // The permit is issued for ONE exact cursor position; a cursor that has moved since has
    // outrun it, and `advanceCursor` clears it on any real advance regardless.
    state: cursor.reanchorFromSeq === cursor.sequence ? "permitted" : "none",
    sequence: cursor.sequence
  };
}

/** This side's `sync_scope`, verbatim — the operator cannot read it from the other domain, and for
 *  `custom` the mode name alone is not the configuration. */
function describeScope(scope: SyncScope): string {
  return scope.mode === "custom"
    ? `custom ${JSON.stringify(scope.labelSelector)}`
    : `'${scope.mode}'`;
}

/** THE OPENING CLAUSE MUST MATCH THE CODE. See docs/federation.md §267. */
function describeBreakShape(
  code: JournalChainBreakCode,
  peerLabel: string,
  anchor: AnchorFacts & { brokeAtRunStart: boolean }
): string {
  if (code === "sequence_gap") {
    return `journal chain from peer ${peerLabel} is not gap-free — sequences are missing from the run`;
  }
  if (anchor.state === "none" && anchor.brokeAtRunStart) {
    return (
      `journal run from peer ${peerLabel} could not be anchored: this side has NO recorded ` +
      `anchor for that peer (its cursor sits at sequence ${anchor.sequence} with no row hash), so ` +
      `the run's first entry was compared against the genesis hash and could not match — the ` +
      `arriving run may itself be perfectly contiguous`
    );
  }
  return (
    `journal run from peer ${peerLabel} does not link to this side's last known-good anchor ` +
    `(prev_hash${anchor.state === "held" ? `, recorded at sequence ${anchor.sequence}` : ""}) — ` +
    `the arriving run may itself be perfectly contiguous`
  );
}

/** THE ANCHOR CLAUSE. See docs/federation.md §268. */
function describeAnchorClause(anchor: AnchorFacts & { brokeAtRunStart: boolean }): string {
  switch (anchor.state) {
    case "held":
      return (
        `(2) THIS SIDE'S ANCHOR: a real anchor IS recorded for that peer — the row hash of ` +
        `sequence ${anchor.sequence} — and the run does not continue from it. A scope change on ` +
        `THIS side no longer strands a cursor (re-pairing this peer at 'full' re-anchors an ` +
        `anchorless one at the next run, whatever the scope was before that call), so also check ` +
        `whether the peer rebuilt, rewound or replayed its own journal. `
      );
    case "genesis":
      return (
        `(2) THIS SIDE'S ANCHOR: nothing has ever been applied from that peer, so the run was ` +
        `required to start at the beginning of its chain (genesis). A peer that has been synced ` +
        `elsewhere first, or that starts mid-chain, needs a bootstrap snapshot rather than a ` +
        `resumed export. `
      );
    case "permitted":
      return (
        `(2) THIS SIDE'S ANCHOR: none is recorded (the cursor sits at sequence ${anchor.sequence} ` +
        `with no row hash, which is what entries applied while THIS side was narrow leave behind), ` +
        `and a one-shot re-anchor permit IS already in force for exactly that position from a local ` +
        `re-pair of this peer at sync_scope 'full' (whatever the scope was set to before that call). ` +
        `The anchor comparison was therefore NOT what failed: the permit re-anchors, ` +
        `it does not loosen anything else — the run must still begin at exactly sequence ` +
        `${anchor.sequence + 1} and be internally gap-free, and that is what it failed. `
      );
    case "none":
      return (
        `(2) THIS SIDE'S ANCHOR: none is recorded. The cursor sits at sequence ${anchor.sequence} ` +
        `with no row hash — what entries applied while THIS side's sync_scope was narrow leave ` +
        `behind, since a sparse chain carries no linkable tail — so there was nothing for the run ` +
        `to continue from and it was compared against genesis. RE-APPLY this side's scope for that ` +
        `peer (\`scp federation pair <peer> --sync-scope full\`) — even if it already reads 'full' ` +
        `— to issue a one-shot permit for exactly this cursor position; the peer's next contiguous ` +
        `run re-anchors and resumes. `
      );
  }
}

/** THE DIAGNOSTIC for a contiguity break. See docs/federation.md §269. */
function describeContiguityBreak(
  input: {
    receiverScope: SyncScope;
    peerName: string;
    exporterDomainId: TrustDomainId;
  },
  code: JournalChainBreakCode,
  reason: string,
  anchor: AnchorFacts & { brokeAtRunStart: boolean }
): string {
  const { receiverScope, peerName, exporterDomainId } = input;
  return (
    `${describeBreakShape(code, `'${peerName}' (${exporterDomainId})`, anchor)} — import rejected, ` +
    `fail-closed (${reason}). ` +
    `This side's sync_scope for that peer is ${describeScope(receiverScope)}, which expects a ` +
    `contiguous, gap-free, prev_hash-linked chain with no missing sequences. sync_scope is ` +
    `per-side LOCAL config: never carried on the wire and never reconciled, so neither operator ` +
    `can see the other side's value from their own — which makes a scope change on EITHER side ` +
    `the most likely cause here. ` +
    `(1) ASYMMETRY: a peer whose OWN sync_scope for this domain is narrower (status_only / ` +
    `changes_only / policies_only / custom) legitimately ships a SPARSE chain, which a side at ` +
    `'full' refuses. ` +
    describeAnchorClause(anchor) +
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
  transport: BundleTransport = "bundle",
  /** §7.2.6 RESYNC ONLY. See docs/federation.md §270. */
  forceOverwrite = false
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

  // Resume from cursor, continuous with what was applied. See docs/federation.md §271.
  const isFullScope = peer.syncScope.mode === "full";
  const cursor = await getCursor(tx, orgId, peer.id, exporterDomainId);
  const toApply = bundle.entries.filter((entry) => entry.sequence > cursor.sequence);

  // DIVERGENCE RAIL 4. See docs/federation.md §272.
  if (bundle.tailAttestation) {
    const att = bundle.tailAttestation;
    const attestationChecksum = computeBundleChecksum({
      exporterDomainId: bundle.header.exporterDomainId,
      peerDomainId: bundle.header.peerDomainId,
      tailSequence: att.tailSequence,
      tailRowHash: att.tailRowHash
    });
    if (!verifyBundleSignature(attestationChecksum, att.signature, bundleKey)) {
      throw new ProblemError(409, "Conflict", {
        type: JOURNAL_DIVERGENCE_PROBLEM_TYPE,
        detail: "tail attestation signature verification failed (rejected, fail-closed)"
      });
    }
    await verifyAndAdvanceTailAttestation(tx, orgId, peer.id, exporterDomainId, att, {
      isReplay: bundle.header.throughSequence <= cursor.sequence
    });
  }

  // Single-writer authority: every entry about to be applied must be authored by the verified
  // signer — reject the WHOLE bundle if any claims a foreign origin (CRITICAL review fix; see
  // assertEntryAuthoredBySigner). Runs before verification/apply so forged-authorship is caught
  // fail-closed regardless of scope.
  for (const entry of toApply) {
    assertEntryAuthoredBySigner(entry, exporterDomainId);
  }

  // Throws a 409 on ANY failure. See docs/federation.md §273.
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
      await applyEntry(tx, orgId, entry, exporterDomainId, forceOverwrite);
      applied += 1;
    } else if (entry.entryKind === "change_status") {
      // THE SECOND DROP CHOKEPOINT. See docs/federation.md §274.
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
  }

  // Advance once to the last applied entry, with its hash. See docs/federation.md §275.
  if (isFullScope && toApply.length > 0) {
    const last = toApply[toApply.length - 1]!;
    await advanceCursor(tx, orgId, peer.id, exporterDomainId, last.sequence, last.rowHash);
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
    transport,
    // An ordinary `.scpbundle` sync import — the metadata leg, never bytes.
    channel: "metadata"
  });

  return {
    peerDomainId: peer.id,
    appliedEntries: applied,
    skippedEntries: skipped,
    lastAppliedSequence: lastSequence
  };
}
