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

/**
 * Per-peer resumable sync cursors (DESIGN.md §13: "per-domain monotonic sequence cursors make
 * replication idempotent and resumable"). One row per (peer domain, origin domain) this side has
 * ever applied entries from — tracks the last sequence number AND the last applied entry's
 * `rowHash` durably committed, so an interrupted transfer resumes from here, re-applying an
 * already-seen sequence is a no-op, and a RESUMED import can verify true hash-chain continuity
 * against what was actually applied last time (not just internal contiguity within one bundle —
 * see `import-repo.ts`'s doc comment, SECURITY-SENSITIVE).
 */

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

/**
 * ISSUE THE ONE-SHOT RE-ANCHOR PERMIT for every cursor of `peerDomainId` that currently holds NO
 * anchor (drizzle/0042). SECURITY-SENSITIVE — read that migration's header before changing this. (That
 * header predates M16.2 phase A and says the column is written by "ONE function, reached by ONE
 * route"; it is now the TWO scope-declaring operator routes listed below. An applied migration file is
 * a historical artifact and is deliberately not edited — its hash is recorded — so this is the current
 * statement.)
 *
 * CALLED FROM EXACTLY TWO PLACES, both of which are LOCAL, AUTHENTICATED (`federation:write`)
 * OPERATOR DECLARATIONS of this peer's own `sync_scope` — and in both the request must actually CARRY a
 * `syncScope`, with the permit keyed off the RESULTING scope being `full` (never off the transition — see
 * `pairPeer`'s long note for why):
 *   * `pairPeer` — `POST /v1/federation/peers` (`syncScope` is part of every pair/re-pair body);
 *   * `updatePeerTransport` — `PATCH /v1/federation/peers/{id}` (M16.2 phase A E4), gated on
 *     `input.syncScope !== undefined`. Re-applied there deliberately: the documented recovery for a
 *     wedged peer is "declare the scope `full` again", and it must work on EVERY route that can declare a
 *     scope, or the same operator action would heal the peer through one door and silently leave it
 *     wedged forever through the other. The `!== undefined` gate is what keeps the trigger as narrow as
 *     this sentence claims — without it, absent-means-preserve made a pure RENAME issue the permit
 *     (review round 4, H8), so the code was wider than every doc describing it.
 * `sync_scope` is never carried on the wire, so no peer can induce either call; nothing in an import,
 * relay, inbox, poke or pull path may ever call this.
 *
 * The predicate is the whole safety story. Only a cursor with `last_applied_row_hash IS NULL AND
 * last_applied_seq > 0` — an anchorless cursor left behind by this side's OWN narrow-scope
 * verification — is permitted, and the permit records the EXACT sequence it was issued for, so it
 * can never apply to a position the cursor has since moved to. A cursor that already holds a real
 * anchor is untouched: there is nothing to re-anchor, and weakening it would be a real loss.
 * `last_applied_seq` itself is deliberately NOT rewound (it is the key-rotation anchor —
 * {@link maxAppliedSequenceForPeer}).
 */
export async function permitCursorReanchor(
  tx: TenantTx,
  orgId: string,
  peerDomainId: TrustDomainId
): Promise<number> {
  // RAIL 5 pre-check (§7.2): would this call ACTUALLY issue a permit? Only an anchorless cursor
  // (`last_applied_row_hash IS NULL AND last_applied_seq > 0`) is eligible. If none exists this is a
  // no-op — an unrelated `pairPeer`/`updatePeerTransport` that merely left scope at `full` on an
  // already-healthy peer — and it must fall straight through, NEVER refusing. Rail 5 fires only where
  // a real permit would be issued, which is the whole false-positive story.
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

  // RAIL 5 (§7.2 — review's sharpest finding: "the rails can be undone by following the printed
  // remedy"). The current no-anchor error message PRESCRIBES a re-anchor; so while a
  // `journal_divergence` is STANDING for this peer, this permit — the mechanism that message points
  // at — must be refused. Re-anchoring here would silently adopt the forked/rolled-back tail as
  // truth; `scp federation resync` is the sanctioned recovery, and it (not this) clears the standing
  // verdict.
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

/** The highest origin sequence THIS domain has verifiably applied from `peerDomainId`, across all
 *  origin domains that peer has relayed (in practice one — a direct peer's own domain). Used as the
 *  key-rotation ANCHOR (peers-repo.ts): when a peer's key rotates, the old key is declared valid
 *  only through this sequence, and the new key from here on — the authenticated compromise-recovery
 *  boundary. `0` when nothing has ever been applied from the peer. */
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

/** Advances the cursor to `sequence`/`rowHash`, but ONLY forward — never regresses it, so an
 *  out-of-order or duplicate apply can never rewind progress already recorded (belt-and-braces on
 *  top of the entry-level idempotent-replay check the import path itself performs).
 *
 *  ALSO CONSUMES the one-shot re-anchor permit (drizzle/0042): any real advance clears it, so a
 *  permit covers exactly one accepted run and is re-issued only by another `pairPeer` call that
 *  again leaves this peer's `sync_scope` at `full`. Clearing it unconditionally (rather than only
 *  when `rowHash` is non-null) is what makes "one-shot" true in both directions — a receiver that is
 *  narrowed AGAIN before the permit is used advances with a null hash and must be re-permitted by a
 *  fresh `pairPeer` call at the NEW position. */
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

/**
 * DIVERGENCE RAIL 4 (multi-region-instance-resilience.md §7.2) — verify the exporter's signed tail
 * attestation against the MONOTONIC high-water mark this side holds for (peer, origin), then advance
 * it. The attestation's SIGNATURE is verified by the caller (import-repo, which holds the peer key);
 * this owns only the ordering contract:
 *   - `tailSequence` EQUAL to the mark but a DIFFERENT `tailRowHash` → a fork at the same height →
 *     `journal_divergence` (UNAMBIGUOUS — the exporter's tail at that exact height was re-minted);
 *   - `tailSequence` BELOW the mark, on a FRESH bundle → the exporter's live tail went backwards →
 *     `journal_divergence`;
 *   - `tailSequence` ABOVE the mark → advance (the normal, healthy case);
 *   - EQUAL and identical → idempotent no-op.
 *
 * `isReplay` is the load-bearing distinction (a real bug caught in test): a legitimately OLDER bundle
 * re-delivered (the file/CDS path can, and idempotent re-import is a hard invariant) carries a
 * genuinely lower attestation that was TRUE when it was exported — refusing it as a "regression"
 * would break replay. A replay is exactly a bundle whose own `throughSequence` is at or below what we
 * have already applied; for those, the below-the-mark case is a no-op, not a refusal. A same-height
 * hash FORK is still refused even on a replay (a legitimate replay never changes the hash at a height
 * it once reported). Runs for BOTH full and sparse receivers, independent of how many entries the
 * bundle applied — which is why it catches a rolled-back tail for a narrow-scope peer rails 1–3 miss.
 * It only ever WRITES the two attested columns; `advanceCursor` owns `last_applied_*` on the same
 * row, so whichever runs first the other's select-then-update/insert leaves it intact.
 */
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
