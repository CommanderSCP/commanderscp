import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { JOURNAL_DIVERGENCE_PROBLEM_TYPE, type TrustDomainId } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { syncCursors } from "../db/schema.js";
import { ProblemError } from "../errors.js";
import { latestDecisionForSubjectKind } from "../coordination/decisions-repo.js";

/** Decision kind for a STANDING importer-side journal divergence with a peer (rails 1/2/4, §7.2).
 *  Distinct from `federation-sync-pull` (which covers every sync block — mTLS, checksum, chain) so
 *  RAIL 5 can ask precisely "is a divergence standing for this peer?" without reason-string matching.
 *  Cleared when the resync operation (§7.2.6) writes a newer, non-block Decision of this kind. */
export const FEDERATION_DIVERGENCE_DECISION_KIND = "federation-divergence";

/** Per-peer resumable sync cursors. See docs/federation.md §64. */

export interface SyncCursor {
  sequence: number;
  rowHash: string | null;
  /** The ONE-SHOT operator re-anchor permit (drizzle/0042), or `null` for "no permit". Meaningful
   *  only when it EQUALS {@link sequence}: the permit is issued for one exact cursor position, so a
   *  cursor that has moved since has already outrun it. See {@link permitCursorReanchor}. */
  reanchorFromSeq: number | null;
}

export async function getCursor(
  tx: TenantTx,
  orgId: string,
  peerDomainId: TrustDomainId,
  originDomainId: TrustDomainId
): Promise<SyncCursor> {
  const rows = await tx
    .select({
      lastAppliedSeq: syncCursors.lastAppliedSeq,
      lastAppliedRowHash: syncCursors.lastAppliedRowHash,
      reanchorFromSeq: syncCursors.reanchorFromSeq
    })
    .from(syncCursors)
    .where(
      and(
        eq(syncCursors.orgId, orgId),
        eq(syncCursors.peerDomainId, peerDomainId),
        eq(syncCursors.originDomainId, originDomainId)
      )
    )
    .limit(1);
  return {
    sequence: rows[0]?.lastAppliedSeq ?? 0,
    rowHash: rows[0]?.lastAppliedRowHash ?? null,
    reanchorFromSeq: rows[0]?.reanchorFromSeq ?? null
  };
}

/** Issues the one-shot re-anchor permit for a peer's cursors. See docs/federation.md §65. */
export async function permitCursorReanchor(
  tx: TenantTx,
  orgId: string,
  peerDomainId: TrustDomainId
): Promise<number> {
  // RAIL 5 pre-check (§7.2). See docs/federation.md §66.
  const eligible = await tx
    .select({ one: sql<number>`1` })
    .from(syncCursors)
    .where(
      and(
        eq(syncCursors.orgId, orgId),
        eq(syncCursors.peerDomainId, peerDomainId),
        isNull(syncCursors.lastAppliedRowHash),
        gt(syncCursors.lastAppliedSeq, 0)
      )
    )
    .limit(1);
  if (eligible.length === 0) return 0;

  // The rails can be undone by following the printed remedy. See docs/federation.md §67.
  const standing = await latestDecisionForSubjectKind(
    tx,
    orgId,
    peerDomainId,
    FEDERATION_DIVERGENCE_DECISION_KIND
  );
  if (standing && standing.verdict === "block") {
    throw new ProblemError(409, "Conflict", {
      type: JOURNAL_DIVERGENCE_PROBLEM_TYPE,
      detail:
        "refusing to re-anchor this peer's sync cursor while a journal_divergence is standing — run " +
        "`scp federation resync --peer <peer>` instead; re-anchoring here would adopt a forked or " +
        "rolled-back tail as truth",
      decisionId: standing.id
    });
  }

  const updated = await tx
    .update(syncCursors)
    .set({ reanchorFromSeq: sql`${syncCursors.lastAppliedSeq}`, updatedAt: new Date() })
    .where(
      and(
        eq(syncCursors.orgId, orgId),
        eq(syncCursors.peerDomainId, peerDomainId),
        isNull(syncCursors.lastAppliedRowHash),
        gt(syncCursors.lastAppliedSeq, 0)
      )
    )
    .returning({ peerDomainId: syncCursors.peerDomainId });
  return updated.length;
}

/** The highest origin sequence this domain has applied. See docs/federation.md §68. */
export async function maxAppliedSequenceForPeer(
  tx: TenantTx,
  orgId: string,
  peerDomainId: TrustDomainId
): Promise<number> {
  const rows = await tx
    .select({ maxSeq: sql<number>`coalesce(max(${syncCursors.lastAppliedSeq}), 0)` })
    .from(syncCursors)
    .where(and(eq(syncCursors.orgId, orgId), eq(syncCursors.peerDomainId, peerDomainId)));
  return Number(rows[0]?.maxSeq ?? 0);
}

/** Advances the cursor forward only, never regressing it. See docs/federation.md §69. */
export async function advanceCursor(
  tx: TenantTx,
  orgId: string,
  peerDomainId: TrustDomainId,
  originDomainId: TrustDomainId,
  sequence: number,
  rowHash: string | null
): Promise<void> {
  const current = await getCursor(tx, orgId, peerDomainId, originDomainId);
  if (sequence <= current.sequence) return;

  const existing = await tx
    .select({ orgId: syncCursors.orgId })
    .from(syncCursors)
    .where(
      and(
        eq(syncCursors.orgId, orgId),
        eq(syncCursors.peerDomainId, peerDomainId),
        eq(syncCursors.originDomainId, originDomainId)
      )
    )
    .limit(1);

  if (existing[0]) {
    await tx
      .update(syncCursors)
      .set({
        lastAppliedSeq: sequence,
        lastAppliedRowHash: rowHash,
        reanchorFromSeq: null,
        updatedAt: new Date()
      })
      .where(
        and(
          eq(syncCursors.orgId, orgId),
          eq(syncCursors.peerDomainId, peerDomainId),
          eq(syncCursors.originDomainId, originDomainId)
        )
      );
  } else {
    await tx.insert(syncCursors).values({
      orgId,
      peerDomainId,
      originDomainId,
      lastAppliedSeq: sequence,
      lastAppliedRowHash: rowHash
    });
  }
}

/** §7.2.6 RESYNC ONLY. See docs/federation.md §70. */
export async function resetCursor(
  tx: TenantTx,
  orgId: string,
  peerDomainId: TrustDomainId,
  originDomainId: TrustDomainId,
  toSequence: number,
  toRowHash: string | null
): Promise<void> {
  const existing = await tx
    .select({ orgId: syncCursors.orgId })
    .from(syncCursors)
    .where(
      and(
        eq(syncCursors.orgId, orgId),
        eq(syncCursors.peerDomainId, peerDomainId),
        eq(syncCursors.originDomainId, originDomainId)
      )
    )
    .limit(1);
  if (existing[0]) {
    await tx
      .update(syncCursors)
      .set({
        lastAppliedSeq: toSequence,
        lastAppliedRowHash: toRowHash,
        reanchorFromSeq: null,
        attestedTailSeq: null,
        attestedTailRowHash: null,
        updatedAt: new Date()
      })
      .where(
        and(
          eq(syncCursors.orgId, orgId),
          eq(syncCursors.peerDomainId, peerDomainId),
          eq(syncCursors.originDomainId, originDomainId)
        )
      );
  } else {
    await tx.insert(syncCursors).values({
      orgId,
      peerDomainId,
      originDomainId,
      lastAppliedSeq: toSequence,
      lastAppliedRowHash: toRowHash
    });
  }
}

/** DIVERGENCE RAIL 4. See docs/federation.md §71. */
export async function verifyAndAdvanceTailAttestation(
  tx: TenantTx,
  orgId: string,
  peerDomainId: TrustDomainId,
  originDomainId: TrustDomainId,
  attestation: { tailSequence: number; tailRowHash: string },
  opts: { isReplay: boolean }
): Promise<void> {
  const rows = await tx
    .select({
      orgId: syncCursors.orgId,
      attestedTailSeq: syncCursors.attestedTailSeq,
      attestedTailRowHash: syncCursors.attestedTailRowHash
    })
    .from(syncCursors)
    .where(
      and(
        eq(syncCursors.orgId, orgId),
        eq(syncCursors.peerDomainId, peerDomainId),
        eq(syncCursors.originDomainId, originDomainId)
      )
    )
    .limit(1);
  const rowExists = rows.length > 0;
  const prevSeq = rows[0]?.attestedTailSeq ?? null;
  const prevHash = rows[0]?.attestedTailRowHash ?? null;

  if (prevSeq !== null) {
    if (attestation.tailSequence === prevSeq && attestation.tailRowHash !== prevHash) {
      throw new ProblemError(409, "Conflict", {
        type: JOURNAL_DIVERGENCE_PROBLEM_TYPE,
        detail:
          `exporter attested a DIFFERENT tail hash at the same height (sequence ${prevSeq}) than ` +
          `previously recorded — a forked/re-minted tail`
      });
    }
    if (!opts.isReplay && attestation.tailSequence < prevSeq) {
      throw new ProblemError(409, "Conflict", {
        type: JOURNAL_DIVERGENCE_PROBLEM_TYPE,
        detail:
          `exporter's live attested journal tail regressed: sequence ${attestation.tailSequence} is ` +
          `below the highest previously attested (${prevSeq}) — a rolled-back tail after a lost-tail restore`
      });
    }
  }

  // Monotonic advance; EQUAL-and-identical falls through as an idempotent no-op.
  if (prevSeq === null || attestation.tailSequence > prevSeq) {
    if (rowExists) {
      await tx
        .update(syncCursors)
        .set({
          attestedTailSeq: attestation.tailSequence,
          attestedTailRowHash: attestation.tailRowHash,
          updatedAt: new Date()
        })
        .where(
          and(
            eq(syncCursors.orgId, orgId),
            eq(syncCursors.peerDomainId, peerDomainId),
            eq(syncCursors.originDomainId, originDomainId)
          )
        );
    } else {
      await tx.insert(syncCursors).values({
        orgId,
        peerDomainId,
        originDomainId,
        attestedTailSeq: attestation.tailSequence,
        attestedTailRowHash: attestation.tailRowHash
      });
    }
  }
}
