import { and, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { TenantTx } from "../db/tenant-tx.js";
import { approvalRequests, approvalVotes, relationships } from "../db/schema.js";
import { conflict, forbidden, notFound } from "../errors.js";
import { isUniqueViolation } from "../db/pg-errors.js";
import { hasRoleAtScope } from "../authz/resolve.js";
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import { computeObjectContentHash, computeRelationshipContentHash } from "../graph/content-hash.js";
import { ensureInstanceKey, signAttestation, type SignedAttestation } from "./attestation.js";
import { appendJournalEntry } from "../federation/journal-repo.js";

/**
 * N-of-M approval quorum (DESIGN §10.2). SECURITY-SENSITIVE surfaces (M4 PR body flag: "approval
 * quorum integrity + N-of-M can't be forged"):
 *
 *  - **No double-voting**: `approval_votes`' unique `(org_id, approval_request_id,
 *    voter_object_id)` index (db/schema.ts) is the actual enforcement — `castApprovalVote` below
 *    just turns the resulting constraint violation into a clean 409 rather than a raw DB error.
 *    An application-layer "have they already voted" check would race a concurrent duplicate
 *    request; the DB constraint cannot.
 *  - **No non-member votes**: `castApprovalVote` calls `authz/resolve.ts`'s `hasRoleAtScope`
 *    BEFORE inserting anything — a subject who does not hold `fromRole` at-or-above the request's
 *    scope is rejected with 403, never silently accepted-but-uncounted.
 *  - **Attestation**: every accepted vote is Ed25519-signed at creation (`attestation.ts`) over a
 *    canonical record binding voter + approved object + decision id + timestamp — tamper-evident,
 *    independently verifiable, no external PKI (DESIGN §10.2).
 */

export interface ApprovalRequestRow {
  id: string;
  orgId: string;
  changeObjectId: string;
  policyObjectId: string;
  policyVersion: number;
  effectIndex: number;
  requiredCount: number;
  fromRole: string;
  scopeObjectId: string;
  status: "pending" | "satisfied";
  createdAt: Date;
  satisfiedAt: Date | null;
  satisfiedDecisionId: string | null;
}

export interface MaterializeApprovalRequestInput {
  orgId: string;
  changeObjectId: string;
  policyObjectId: string;
  policyVersion: number;
  effectIndex: number;
  requiredCount: number;
  fromRole: string;
  scopeObjectId: string;
}

/**
 * Idempotent create-if-not-exists (DESIGN §10.2 "approval control instances materialize as
 * approval tasks") — the unique `(org, change, policy, policyVersion, effectIndex)` key means
 * calling this repeatedly for the same firing policy/effect is always safe and always returns
 * the SAME row, even under concurrent callers (route handler + reconcile's background
 * materialization both call this for the same requirement).
 */
export async function materializeApprovalRequest(
  tx: TenantTx,
  input: MaterializeApprovalRequestInput
): Promise<ApprovalRequestRow> {
  const existing = await tx
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.orgId, input.orgId),
        eq(approvalRequests.changeObjectId, input.changeObjectId),
        eq(approvalRequests.policyObjectId, input.policyObjectId),
        eq(approvalRequests.policyVersion, input.policyVersion),
        eq(approvalRequests.effectIndex, input.effectIndex)
      )
    )
    .limit(1);
  if (existing[0]) return existing[0] as ApprovalRequestRow;

  try {
    const [row] = await tx
      .insert(approvalRequests)
      .values({
        id: uuidv7(),
        orgId: input.orgId,
        changeObjectId: input.changeObjectId,
        policyObjectId: input.policyObjectId,
        policyVersion: input.policyVersion,
        effectIndex: input.effectIndex,
        requiredCount: input.requiredCount,
        fromRole: input.fromRole,
        scopeObjectId: input.scopeObjectId
      })
      .returning();
    return row as ApprovalRequestRow;
  } catch (err) {
    if (isUniqueViolation(err, "approval_requests_dedup_key")) {
      const [row] = await tx
        .select()
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.orgId, input.orgId),
            eq(approvalRequests.changeObjectId, input.changeObjectId),
            eq(approvalRequests.policyObjectId, input.policyObjectId),
            eq(approvalRequests.policyVersion, input.policyVersion),
            eq(approvalRequests.effectIndex, input.effectIndex)
          )
        )
        .limit(1);
      if (row) return row as ApprovalRequestRow;
    }
    throw err;
  }
}

export async function getApprovalRequest(
  tx: TenantTx,
  orgId: string,
  id: string
): Promise<ApprovalRequestRow> {
  const rows = await tx
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.orgId, orgId), eq(approvalRequests.id, id)))
    .limit(1);
  if (!rows[0]) throw notFound(`approval request '${id}' not found`);
  return rows[0] as ApprovalRequestRow;
}

export async function listApprovalRequestsForChange(
  tx: TenantTx,
  orgId: string,
  changeObjectId: string
): Promise<ApprovalRequestRow[]> {
  const rows = await tx
    .select()
    .from(approvalRequests)
    .where(
      and(eq(approvalRequests.orgId, orgId), eq(approvalRequests.changeObjectId, changeObjectId))
    );
  return rows as ApprovalRequestRow[];
}

export interface ApprovalVoteRow {
  id: string;
  approvalRequestId: string;
  voterObjectId: string;
  decisionId: string | null;
  attestation: SignedAttestation;
  votedAt: Date;
}

export async function listVotesForRequest(
  tx: TenantTx,
  orgId: string,
  approvalRequestId: string
): Promise<ApprovalVoteRow[]> {
  const rows = await tx
    .select()
    .from(approvalVotes)
    .where(
      and(eq(approvalVotes.orgId, orgId), eq(approvalVotes.approvalRequestId, approvalRequestId))
    );
  return rows as unknown as ApprovalVoteRow[];
}

export interface QuorumStatus {
  satisfied: boolean;
  count: number;
  required: number;
}

export async function quorumStatus(
  tx: TenantTx,
  orgId: string,
  request: ApprovalRequestRow
): Promise<QuorumStatus> {
  const votes = await listVotesForRequest(tx, orgId, request.id);
  return {
    satisfied: votes.length >= request.requiredCount,
    count: votes.length,
    required: request.requiredCount
  };
}

export interface CastApprovalVoteInput {
  orgId: string;
  approvalRequestId: string;
  voterObjectId: string;
  voterIdpSubject?: string | null;
  decisionId?: string | null;
  requestId: string;
}

/**
 * Casts one vote: (1) eligibility check (`hasRoleAtScope` — 403 if the voter doesn't hold the
 * request's `fromRole` at-or-above its scope), (2) sign an attestation, (3) insert the vote row,
 * relying on the DB's unique constraint to reject a genuine double-vote race as a 409 rather than
 * silently overwriting — and (4) idempotently record the graph-visible `approves` relationship
 * (DESIGN §10.2 "approvals are recorded as `approves` relationships") from voter -> the CHANGE
 * object this approval request ultimately gates (upserted, since one voter may cast votes toward
 * several approval requests on the SAME change — `approves` is a coarser, per-change signal; the
 * `approval_votes` row is the fine-grained source of truth quorum counting actually uses).
 */
export async function castApprovalVote(
  tx: TenantTx,
  input: CastApprovalVoteInput
): Promise<ApprovalVoteRow> {
  const request = await getApprovalRequest(tx, input.orgId, input.approvalRequestId);

  const eligible = await hasRoleAtScope(tx, {
    orgId: input.orgId,
    subjectObjectId: input.voterObjectId,
    roleName: request.fromRole,
    scopeObjectId: request.scopeObjectId
  });
  if (!eligible) {
    throw forbidden(
      `subject '${input.voterObjectId}' does not hold role '${request.fromRole}' at or above scope '${request.scopeObjectId}' — not eligible to vote on approval request '${request.id}'`
    );
  }

  const changeObject = await getObjectByIdOrUrnAnyType(tx, input.orgId, request.changeObjectId);
  const key = await ensureInstanceKey(tx);
  const attestation = signAttestation(key, {
    approverSubjectId: input.voterObjectId,
    approverIdpSubject: input.voterIdpSubject ?? null,
    approvedObjectUrn: changeObject.urn,
    approvedObjectContentHash: computeObjectContentHash({
      id: changeObject.id,
      orgId: changeObject.orgId,
      domainId: changeObject.domainId,
      typeId: changeObject.typeId,
      name: changeObject.name,
      urn: changeObject.urn,
      properties: changeObject.properties,
      labels: changeObject.labels,
      version: changeObject.version
    }),
    decisionId: input.decisionId ?? null,
    timestamp: new Date().toISOString()
  });

  let row: ApprovalVoteRow;
  try {
    const [inserted] = await tx
      .insert(approvalVotes)
      .values({
        id: uuidv7(),
        orgId: input.orgId,
        approvalRequestId: input.approvalRequestId,
        voterObjectId: input.voterObjectId,
        decisionId: input.decisionId ?? null,
        attestation
      })
      .returning();
    row = inserted as unknown as ApprovalVoteRow;
  } catch (err) {
    if (isUniqueViolation(err, "approval_votes_no_double_vote")) {
      throw conflict(
        `subject '${input.voterObjectId}' has already voted on approval request '${request.id}'`
      );
    }
    throw err;
  }

  // M6 (DESIGN §13): approvals-as-evidence ride the journal so a Promotion Bundle exported later
  // can carry this attestation, and so a peer syncing with a `full`/`changes_only` scope can see
  // it happened, WITHOUT it ever becoming authority anywhere but here (§13 "approvals transfer as
  // evidence, never as authority" — this entry is read-only history, never replayed as a vote).
  await appendJournalEntry(tx, {
    orgId: input.orgId,
    entryKind: "approval_evidence",
    contentHash: attestation.record.approvedObjectContentHash,
    payload: {
      approvalRequestId: input.approvalRequestId,
      changeObjectId: request.changeObjectId,
      changeUrn: changeObject.urn,
      voterObjectId: input.voterObjectId,
      attestation
    }
  });

  // Idempotent upsert of the graph-visible `approves` relationship (voter -> change). A
  // pre-existing edge (from an earlier vote on a DIFFERENT approval request for the same change)
  // is left as-is — the relationship is a coarse "this subject approved something on this
  // change" signal; `approval_votes` remains the fine-grained, per-request source of truth.
  const relTypeId = "approves";
  const existingRel = await tx.query.relationships.findFirst({
    where: (t, { eq: eqOp, and: andOp, isNull: isNullOp }) =>
      andOp(
        eqOp(t.orgId, input.orgId),
        eqOp(t.typeId, relTypeId),
        eqOp(t.fromId, input.voterObjectId),
        eqOp(t.toId, request.changeObjectId),
        isNullOp(t.deletedAt)
      )
  });
  if (!existingRel) {
    const relId = uuidv7();
    const relProperties = { approvalRequestIds: [request.id] };
    try {
      await tx.insert(relationships).values({
        id: relId,
        orgId: input.orgId,
        typeId: relTypeId,
        fromId: input.voterObjectId,
        toId: request.changeObjectId,
        properties: relProperties,
        originDomainId: input.orgId,
        revision: 1,
        contentHash: computeRelationshipContentHash({
          id: relId,
          orgId: input.orgId,
          typeId: relTypeId,
          fromId: input.voterObjectId,
          toId: request.changeObjectId,
          properties: relProperties,
          labels: {}
        })
      });
    } catch {
      // Best-effort — a races-with-itself duplicate (two votes on two different approval
      // requests for the same change, same millisecond) just leaves the first relationship in
      // place; never fails the vote itself over this secondary, coarser signal.
    }
  }

  // Flip the request to 'satisfied' the moment quorum is reached, in the SAME transaction as the
  // vote that tipped it over — no separate reconcile step needed to notice.
  const status = await quorumStatus(tx, input.orgId, request);
  if (status.satisfied && request.status !== "satisfied") {
    await tx
      .update(approvalRequests)
      .set({
        status: "satisfied",
        satisfiedAt: new Date(),
        satisfiedDecisionId: input.decisionId ?? null
      })
      .where(eq(approvalRequests.id, request.id));
  }

  return row;
}
