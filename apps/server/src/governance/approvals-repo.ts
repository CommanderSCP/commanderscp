import { and, eq, isNull } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { ChangeState, Decision } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { approvalRequests, approvalVotes, relationships } from "../db/schema.js";
import { conflict, forbidden, notFound } from "../errors.js";
import { isUniqueViolation } from "../db/pg-errors.js";
import { hasRoleAtScope } from "../authz/resolve.js";
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import { computeObjectContentHash, computeRelationshipContentHash } from "../graph/content-hash.js";
import { ensureInstanceKey, signAttestation, type SignedAttestation } from "./attestation.js";
import { appendJournalEntry } from "../federation/journal-repo.js";
import { ensureFederationSelf } from "../federation/self-repo.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import { getChangeRow } from "../coordination/changes-repo.js";
import { insertDecision } from "../coordination/decisions-repo.js";
import { TERMINAL_STATES } from "../coordination/transitions.js";

/** N-of-M approval quorum. See docs/governance.md §1. */

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
  /** Set once this request's change reached a terminal state. See ApprovalRequestSchema's doc. */
  closedAt: Date | null;
  closedReason: string | null;
  closedDecisionId: string | null;
}

export interface CloseApprovalRequestsForChangeInput {
  orgId: string;
  changeObjectId: string;
  /** The terminal `toState` that closed these requests (e.g. `"cancelled"`, `"rolled_back"`). */
  closedReason: string;
  /** The SAME Decision id the closing transition itself recorded. */
  decisionId: string;
}

/** Closes every still-open approval request for a change, in the CALLER's transaction — meant to
 *  be called from `transitionChange` the moment a change reaches a terminal state, so a dead
 *  change never again shows a votable, "still pending" approval request. Idempotent: only rows
 *  with `closedAt IS NULL` are touched, so calling this twice (or racing a duplicate transition)
 *  never overwrites an earlier closure's reason/decision. See docs/governance.md §6. */
export async function closeApprovalRequestsForChange(
  tx: TenantTx,
  input: CloseApprovalRequestsForChangeInput
): Promise<ApprovalRequestRow[]> {
  const rows = await tx
    .update(approvalRequests)
    .set({
      closedAt: new Date(),
      closedReason: input.closedReason,
      closedDecisionId: input.decisionId
    })
    .where(
      and(
        eq(approvalRequests.orgId, input.orgId),
        eq(approvalRequests.changeObjectId, input.changeObjectId),
        isNull(approvalRequests.closedAt)
      )
    )
    .returning();
  return rows as ApprovalRequestRow[];
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

/** Idempotent create-if-not-exists for an approval instance. See docs/governance.md §2. */
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

export type CastApprovalVoteResult =
  | { verdict: "allow"; vote: ApprovalVoteRow }
  /** A vote refused because the request's change is already terminal — the Decision + audit event
   *  below still commit in this same transaction (the caller must NOT throw here; see
   *  `routes/governance.ts`'s block-then-409-after-commit comment, mirrored from
   *  `coordination/transition.ts`). */
  | { verdict: "block"; decision: Decision; blockedReason: string };

/** Casts one vote: (0) the request's change must not already be terminal, (1) eligibility check.
 *  See docs/governance.md §3. */
export async function castApprovalVote(
  tx: TenantTx,
  input: CastApprovalVoteInput
): Promise<CastApprovalVoteResult> {
  const request = await getApprovalRequest(tx, input.orgId, input.approvalRequestId);

  // A change that reached cancelled/rolled_back can never act on a vote again — refuse it with an
  // audited, Decision-carrying 409 rather than silently recording a vote nobody will ever read.
  const changeRow = await getChangeRow(tx, input.orgId, request.changeObjectId);
  if (TERMINAL_STATES.has(changeRow.state as ChangeState)) {
    const decision = await insertDecision(tx, {
      orgId: input.orgId,
      kind: "approval_vote",
      subjectId: request.id,
      verdict: "block",
      inputContext: {
        changeObjectId: request.changeObjectId,
        changeState: changeRow.state,
        voterObjectId: input.voterObjectId
      },
      reasonTree: {
        summary:
          `refused: change '${request.changeObjectId}' is in terminal state '${changeRow.state}' ` +
          `— a vote on approval request '${request.id}' can never affect it`
      }
    });
    await appendAuditEvent(tx, {
      orgId: input.orgId,
      actorId: input.voterObjectId,
      action: "approval_vote.blocked",
      subjectId: request.id,
      reason: `change is in terminal state '${changeRow.state}'`,
      decisionId: decision.id,
      requestId: input.requestId
    });
    return {
      verdict: "block",
      decision,
      blockedReason: `change is in terminal state '${changeRow.state}' — voting is refused`
    };
  }

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
  const key = await ensureInstanceKey(tx, input.orgId);
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

  // Approvals as evidence ride the journal, so exports carry. See docs/governance.md §4.
  if (!changeObject.domainLocal) {
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
  }

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
        // This domain's minted id, the same every other site uses. See docs/governance.md §5.
        originDomainId: (await ensureFederationSelf(tx, input.orgId)).domainId,
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

  return { verdict: "allow", vote: row };
}
