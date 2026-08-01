import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SyncBundle } from "@scp/schemas";
import { computeBundleChecksum, signBundleChecksum } from "@scp/schemas/federation-journal";
import { syncCursors } from "../db/schema.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { createObject } from "../graph/objects-repo.js";
import { createRelationship } from "../graph/relationships-repo.js";
import { ensureInstanceKey } from "../governance/attestation.js";
import { proposeChange } from "../coordination/changes-repo.js";
import { ProblemError } from "../errors.js";
import { ensureFederationSelf, type FederationSelf } from "./self-repo.js";
import { pairPeer } from "./peers-repo.js";
import { getCursor, type SyncCursor } from "./cursors-repo.js";
import { exportSyncBundle } from "./export-repo.js";
import { importSyncBundle, type ImportSyncBundleResult } from "./import-repo.js";
import { createIsolatedDomain, type IsolatedDomain } from "./test-support/isolated-domain.js";

/**
 * THE SENDER-NARROW / RECEIVER-`full` ASYMMETRY — a misconfiguration that halts federation sync, and
 * that used to blame TAMPERING for it.
 *
 * `federation_peers.sync_scope` is per-side LOCAL config: set independently by the operator on each
 * domain, never carried on the wire, never reconciled. The receiver's default is `full`. So the most
 * likely field mistake in an outpost rollout — the outpost operator pairs the commander without
 * `--sync-scope` while the commander operator narrows what it SENDS — produces a receiver demanding
 * a gap-free chain from a sender that legitimately ships a sparse one.
 *
 * THE VERDICT IS UNCHANGED AND MUST STAY UNCHANGED (owner decision): the import is REFUSED,
 * fail-closed. A sparse run and a maliciously thinned one are the same bytes — the bundle signature
 * only proves the SENDER produced what arrived — so contiguity is the only check that catches an
 * entry deleted and re-signed, and this is the one place it is caught. Relaxing it to be friendlier
 * to a misconfiguration would trade a real detection for a diagnosability win that belongs in the
 * MESSAGE.
 *
 * WHAT IS PINNED HERE, therefore, is the message and the recovery:
 *  1. the refusal names the peer, states THIS side's `sync_scope` verbatim, explains that a narrower
 *     sender legitimately ships a sparse chain, and says what to compare — and never says "tamper";
 *  2. it is not a verdict either: it says a genuine break looks identical and must be investigated
 *     if the two sides already agree;
 *  3. NOTHING is applied and the cursor does not move;
 *  4. once the operator RE-ALIGNS the two scopes, sync resumes cleanly — in EITHER direction, and
 *     with the strict path fully intact afterwards (no one-way ratchet).
 *
 * (4) IS THE ONE THAT KEEPS BREAKING, AND PHASES 5-8 ARE WHERE IT IS NAILED DOWN (pre-M16 residual
 * W1). A receiver whose OWN scope was narrow holds a cursor with NO row hash — correct while it is
 * narrow, because a sparse chain has no linkable tail. WIDENING that peer back to `full` used to
 * leave the strict path comparing the peer's next, perfectly contiguous run against
 * JOURNAL_GENESIS_HASH, which it can never equal: the peer was wedged forever, by a SUPPORTED local
 * configuration change, and the message's prescribed recovery was inert. The fix is a ONE-SHOT
 * re-anchor permit `pairPeer` issues whenever the RESULTING `sync_scope` is `full` and the cursor is
 * anchorless — regardless of what the scope was before that call — keyed to a local, authenticated
 * operator action on config that never crosses the wire, which re-anchors the next run and relaxes
 * NOTHING else. So:
 *  5. re-widening BOTH sides resumes sync and restores a real anchor (PHASE 5, PHASE 6);
 *  6. and the permit does not reopen the deletion window the owner chose to keep closed: a
 *     re-signed run with a middle entry removed is refused WITH the permit in force (PHASE 5a) and
 *     after it has been consumed (PHASE 7);
 *  7. an anchorless cursor with NO permit — a state the current code no longer leaves a `full`-scope
 *     peer in on its own (PHASE 8 forces it directly to prove the message still describes it as
 *     what it is, rather than as a stale anchor — the W2 honesty fix).
 */
describe("federation sync_scope asymmetry: refused fail-closed, diagnosed accurately, recoverable (Testcontainers, two databases)", () => {
  let commander: IsolatedDomain;
  let outpost: IsolatedDomain;
  let selfCommander: FederationSelf;
  let selfOutpost: FederationSelf;
  let outpostPublicKey: string;
  let commanderPublicKey: string;
  let commanderPrivateKey: string;

  let componentId: string;

  let fullSyncResult: ImportSyncBundleResult;
  let sparseBundle: SyncBundle;
  let refusal: ProblemError;
  let cursorAfterRefusal: SyncCursor;
  let realignedResult: ImportSyncBundleResult;
  let cursorAfterRealign: SyncCursor;
  let resumedResult: ImportSyncBundleResult;
  let receiverNarrowedResult: ImportSyncBundleResult;
  let cursorBeforeRewiden: SyncCursor;
  let cursorAfterWidenPair: SyncCursor;
  let thinnedWhilePermittedRefusal: ProblemError;
  let rewidenOutcome:
    { ok: true; result: ImportSyncBundleResult } | { ok: false; refusal: ProblemError };
  let cursorAfterRewiden: SyncCursor;
  let postRewidenResult: ImportSyncBundleResult;
  let cursorAfterPostRewiden: SyncCursor;
  let thinnedAfterReanchorRefusal: ProblemError;
  let unanchoredRefusal: ProblemError;

  const exportToOutpost = (): Promise<SyncBundle> =>
    withTenantTx(commander.db, commander.orgId, (tx) =>
      exportSyncBundle(tx, commander.orgId, outpost.orgName)
    );
  const importAtOutpost = (bundle: SyncBundle): Promise<ImportSyncBundleResult> =>
    withTenantTx(outpost.db, outpost.orgId, (tx) => importSyncBundle(tx, outpost.orgId, bundle));
  const outpostCursor = (): Promise<SyncCursor> =>
    withTenantTx(outpost.db, outpost.orgId, (tx) =>
      getCursor(tx, outpost.orgId, selfCommander.domainId, selfCommander.domainId)
    );
  const setCommanderScopeForOutpost = (
    syncScope: Parameters<typeof pairPeer>[1]["syncScope"]
  ): Promise<unknown> =>
    withTenantTx(commander.db, commander.orgId, (tx) =>
      pairPeer(tx, {
        orgId: commander.orgId,
        domainId: selfOutpost.domainId,
        name: outpost.orgName,
        role: "outpost",
        publicKey: outpostPublicKey,
        syncScope
      })
    );
  const setOutpostScopeForCommander = (
    syncScope: Parameters<typeof pairPeer>[1]["syncScope"]
  ): Promise<unknown> =>
    withTenantTx(outpost.db, outpost.orgId, (tx) =>
      pairPeer(tx, {
        orgId: outpost.orgId,
        domainId: selfCommander.domainId,
        name: commander.orgName,
        role: "commander",
        publicKey: commanderPublicKey,
        syncScope
      })
    );
  /** Re-sign a mutated entry list so the bundle-level checksum/signature gate PASSES and the chain
   *  check is what has to catch the mutation — the residual threat this whole design is about (a
   *  signer, or anyone holding its key, producing bad content). */
  const resign = (bundle: SyncBundle, entries: SyncBundle["entries"]): SyncBundle => {
    const checksum = computeBundleChecksum({ header: bundle.header, entries });
    return {
      ...bundle,
      entries,
      checksum,
      bundleSignature: signBundleChecksum(commanderPrivateKey, checksum)
    };
  };
  /** REMOVE one entry from the MIDDLE of the part of the bundle this side has not yet applied, and
   *  re-sign. Deleting below the cursor would be filtered out before verification ever sees it, and
   *  deleting the last would merely truncate — neither exercises the hole. */
  const thinAboveCursor = (bundle: SyncBundle, cursorSequence: number): SyncBundle => {
    const pending = bundle.entries.filter((entry) => entry.sequence > cursorSequence);
    expect(pending.length).toBeGreaterThan(2);
    const removed = pending[1]!;
    return resign(
      bundle,
      bundle.entries.filter((entry) => entry.sequence !== removed.sequence)
    );
  };
  const expectRefused = async (bundle: SyncBundle): Promise<ProblemError> =>
    importAtOutpost(bundle).then(
      () => {
        throw new Error("expected this segment to be REFUSED, fail-closed");
      },
      (err: unknown) => {
        if (!(err instanceof ProblemError)) throw err;
        return err;
      }
    );
  const proposeOnCommander = (requestId: string, name: string): Promise<string> =>
    withTenantTx(commander.db, commander.orgId, async (tx) => {
      const { change } = await proposeChange(tx, {
        orgId: commander.orgId,
        actorObjectId: commander.orgId,
        requestId,
        name,
        targets: [componentId]
      });
      return change.id;
    });

  beforeAll(async () => {
    commander = await createIsolatedDomain("scopeAsymCommander");
    outpost = await createIsolatedDomain("scopeAsymOutpost");

    selfCommander = await withTenantTx(commander.db, commander.orgId, (tx) =>
      ensureFederationSelf(tx, commander.orgId)
    );
    selfOutpost = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      ensureFederationSelf(tx, outpost.orgId)
    );
    const commanderKey = await withTenantTx(commander.db, commander.orgId, (tx) =>
      ensureInstanceKey(tx, commander.orgId)
    );
    commanderPublicKey = commanderKey.publicKey;
    commanderPrivateKey = commanderKey.privateKey;
    const outpostKey = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      ensureInstanceKey(tx, outpost.orgId)
    );
    outpostPublicKey = outpostKey.publicKey;

    // THE OUTPOST OPERATOR pairs the commander and never passes `--sync-scope` — so this side is
    // `full` (peers-repo.ts's default) and expects a gap-free chain. This is the whole setup.
    await setOutpostScopeForCommander(undefined);
    await setCommanderScopeForOutpost(undefined);

    // A first, genuinely CONTIGUOUS sync while both sides are still `full`. It establishes the
    // cursor's rowHash anchor, so the strict check below has something to anchor to.
    const seeded = await withTenantTx(commander.db, commander.orgId, async (tx) => {
      const service = await createObject(tx, {
        orgId: commander.orgId,
        domainId: null,
        typeId: "service",
        actorObjectId: commander.orgId,
        requestId: "scope-asym-service",
        name: "payments-api"
      });
      const component = await createObject(tx, {
        orgId: commander.orgId,
        domainId: null,
        typeId: "component",
        actorObjectId: commander.orgId,
        requestId: "scope-asym-component",
        name: "payments-web"
      });
      await createRelationship(tx, {
        orgId: commander.orgId,
        actorObjectId: commander.orgId,
        requestId: "scope-asym-contains",
        typeId: "contains",
        fromId: service.id,
        toId: component.id
      });
      return { componentId: component.id };
    });
    componentId = seeded.componentId;
    fullSyncResult = await importAtOutpost(await exportToOutpost());

    // ── PHASE 2. THE COMMANDER OPERATOR narrows what this outpost RECEIVES to `status_only`.
    // Reasonable on its own (change status crosses the boundary, graph content does not). Nothing
    // tells the outpost, whose own row still says `full`.
    await setCommanderScopeForOutpost({ mode: "status_only" });
    await proposeOnCommander("scope-asym-change", "payments rollout");
    sparseBundle = await exportToOutpost();
    refusal = await importAtOutpost(sparseBundle).then(
      () => {
        throw new Error("expected the sparse segment to be REFUSED, fail-closed");
      },
      (err: unknown) => {
        if (!(err instanceof ProblemError)) throw err;
        return err;
      }
    );
    cursorAfterRefusal = await outpostCursor();

    // ── PHASE 3. THE OPERATOR RE-ALIGNS by widening the SENDER back to `full` (the direction that
    // keeps the receiver's gap-free guarantee). Sync must resume on the STRICT path.
    await setCommanderScopeForOutpost({ mode: "full" });
    realignedResult = await importAtOutpost(await exportToOutpost());
    cursorAfterRealign = await outpostCursor();
    // ...and keep working for the NEXT change, not just the backlog.
    await proposeOnCommander("scope-asym-change-3", "payments rollout three");
    resumedResult = await importAtOutpost(await exportToOutpost());

    // ── PHASE 4. RE-ALIGNMENT IN THE OTHER DIRECTION: the commander narrows again AND the outpost
    // operator narrows its own row to match. A sparse chain is now the configured, expected shape.
    await setCommanderScopeForOutpost({ mode: "status_only" });
    await setOutpostScopeForCommander({ mode: "status_only" });
    await proposeOnCommander("scope-asym-change-4", "payments rollout four");
    receiverNarrowedResult = await importAtOutpost(await exportToOutpost());

    // ── PHASE 5. THE OPERATOR UNDOES PHASE 4: both sides go back to `full`. This is THE WEDGE
    // (pre-M16 residual W1). This side's cursor was advanced under the SPARSE regime and therefore
    // carries NO row hash — it never held one, because a sparse chain has no linkable tail. The
    // commander's next bundle is contiguous, gap-free and authentic, and used to be refused anyway
    // (and forever after), because an absent anchor was read as genesis, which a mid-chain run can
    // never equal. Widening is a LOCAL, AUTHENTICATED operator action, so it — and nothing that
    // arrives on the wire — is what issues the one-shot re-anchor permit.
    cursorBeforeRewiden = await outpostCursor();
    await setCommanderScopeForOutpost({ mode: "full" });
    await setOutpostScopeForCommander({ mode: "full" });
    cursorAfterWidenPair = await outpostCursor();
    await proposeOnCommander("scope-asym-change-5", "payments rollout five");
    await proposeOnCommander("scope-asym-change-5b", "payments rollout five-b");
    const rewidenBundle = await exportToOutpost();

    // ── PHASE 5a. THE PERMIT MUST NOT BE A HOLE. Before the honest run, offer the SAME bundle with
    // a middle entry deleted and re-signed — indistinguishable, byte for byte, from a legitimately
    // thinned chain. The permit re-anchors; it does not tolerate gaps. This must be REFUSED, with
    // the permit still in force afterwards.
    thinnedWhilePermittedRefusal = await expectRefused(
      thinAboveCursor(rewidenBundle, cursorBeforeRewiden.sequence)
    );

    // ── PHASE 5b. The honest run: accepted, and the cursor is strictly anchored again.
    rewidenOutcome = await importAtOutpost(rewidenBundle).then(
      (result) => ({ ok: true as const, result }),
      (err: unknown) => {
        if (!(err instanceof ProblemError)) throw err;
        return { ok: false as const, refusal: err };
      }
    );
    cursorAfterRewiden = await outpostCursor();

    // ── PHASE 6. FOLLOW-ON. A brand-new change on the commander, after the re-anchor, on the fully
    // strict path with a real anchor — the case the reviewer measured as still REFUSED.
    await proposeOnCommander("scope-asym-change-6", "payments rollout six");
    postRewidenResult = await importAtOutpost(await exportToOutpost());
    cursorAfterPostRewiden = await outpostCursor();

    // ── PHASE 7. AND THE DELETION WINDOW STAYS CLOSED once the permit has been consumed: same
    // thinning, now against a cursor that holds a real anchor.
    await proposeOnCommander("scope-asym-change-7", "payments rollout seven");
    await proposeOnCommander("scope-asym-change-7b", "payments rollout seven-b");
    thinnedAfterReanchorRefusal = await expectRefused(
      thinAboveCursor(await exportToOutpost(), cursorAfterPostRewiden.sequence)
    );

    // ── PHASE 8 (W2 — THE MESSAGE MUST DESCRIBE THE CODE'S ACTUAL STATE). An anchorless cursor
    // with NO permit is not produced by any supported operation any more, so it is FORCED here:
    // strip the row hash and the permit directly. What is pinned is that the refusal then says what
    // actually happened — no anchor recorded, compared against genesis — instead of blaming a
    // "last known-good anchor" and a "previous scope regime" that do not exist.
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      tx
        .update(syncCursors)
        .set({ lastAppliedRowHash: null, reanchorFromSeq: null })
        .where(
          and(
            eq(syncCursors.orgId, outpost.orgId),
            eq(syncCursors.peerDomainId, selfCommander.domainId),
            eq(syncCursors.originDomainId, selfCommander.domainId)
          )
        )
    );
    unanchoredRefusal = await expectRefused(await exportToOutpost());
  }, 180_000);

  afterAll(async () => {
    await commander.close();
    await outpost.close();
  });

  it("the premise: the sender really did ship a SPARSE chain, and this side is really `full`", () => {
    const span = sparseBundle.header.throughSequence - sparseBundle.header.sinceSequence;
    expect(sparseBundle.entries.length).toBeGreaterThan(0);
    // Fewer entries than the range they span == the sender withheld out-of-scope sequences.
    expect(sparseBundle.entries.length).toBeLessThan(span);
    // ...and the gaps are real, not merely a short range.
    const sequences = sparseBundle.entries.map((e) => e.sequence);
    expect(Math.max(...sequences) - Math.min(...sequences) + 1).toBeGreaterThan(sequences.length);
  });

  it("FAIL-CLOSED: the sparse segment is REFUSED, and nothing from it is applied", async () => {
    expect(refusal.status).toBe(409);
    // The cursor is exactly where the earlier clean full↔full sync left it: a refused segment
    // applies no prefix and advances nothing.
    expect(cursorAfterRefusal.sequence).toBe(fullSyncResult.lastAppliedSequence);
    expect(cursorAfterRefusal.rowHash).not.toBeNull();
  });

  it("the refusal is DIAGNOSTIC, not an alarm: peer named, this side's scope stated, action given", () => {
    const message = refusal.detail ?? refusal.message;
    // The peer, by both name and domain id — an operator reading a log needs both.
    expect(message).toContain(commander.orgName);
    expect(message).toContain(selfCommander.domainId);
    // THIS side's scope, verbatim — it cannot be read from the other domain.
    expect(message).toMatch(/This side's sync_scope for that peer is 'full'/);
    // What that scope expects, and why the arriving chain does not match it.
    expect(message).toMatch(/gap-free/);
    expect(message).toMatch(/contiguous/);
    // The likely cause, with the narrow modes spelled out — named as likely, not as a verdict.
    expect(message).toMatch(/most likely cause/);
    expect(message).toMatch(/status_only/);
    // Something to actually do.
    expect(message).toMatch(/scp federation peers.*BOTH domains/);
    // THE POINT: a config asymmetry is never announced as tampering.
    expect(message.toLowerCase()).not.toContain("tamper");
  });

  it("...but it does NOT claim the asymmetry as fact — a genuine break looks identical and it says so", () => {
    const message = refusal.detail ?? refusal.message;
    // This path is exactly where a withheld/removed entry is caught. Telling the operator "this is
    // just a config mismatch" would be the mirror-image dishonesty of crying tampering.
    expect(message).toMatch(/If the two sides already agree/);
    expect(message).toMatch(/withheld or removed/);
    expect(message).toMatch(/investigated/);
  });

  it("RE-ALIGNED (sender widened back to `full`): sync resumes on the STRICT path", () => {
    expect(realignedResult.appliedEntries).toBeGreaterThan(0);
    // A rowHash anchor is back, which is what proves the strict path is the one that ran — the old
    // sparse-acceptance path advanced the cursor with `rowHash: null` and could never restore it,
    // permanently disabling strict verification for that peer (the one-way ratchet).
    expect(cursorAfterRealign.rowHash).not.toBeNull();
    expect(cursorAfterRealign.sequence).toBe(realignedResult.lastAppliedSequence);
    // And it keeps working for subsequent changes, not just the backlog that was stuck.
    expect(resumedResult.appliedEntries).toBeGreaterThan(0);
  });

  it("RE-ALIGNED THE OTHER WAY (receiver narrowed to match): the sparse shape is the configured one", () => {
    // The same sender scope that was refused above is now accepted, because the RECEIVER is no
    // longer claiming a gap-free guarantee it was never going to get. Nothing about the bytes
    // changed — which is the whole point: the refusal was about configuration, not content.
    expect(receiverNarrowedResult.appliedEntries).toBeGreaterThan(0);
  });

  it("THE PREMISE OF THE WEDGE: narrow-scope importing really did leave an ANCHORLESS cursor", () => {
    // Not a contrivance — this is what the sparse path records, because it never holds the range
    // tail's row hash (the tail may be an entry this side was never shown).
    expect(cursorBeforeRewiden.sequence).toBeGreaterThan(0);
    expect(cursorBeforeRewiden.rowHash).toBeNull();
    expect(cursorBeforeRewiden.reanchorFromSeq).toBeNull();
    // ...and WIDENING this side's own scope — a local, authenticated operator action on config that
    // never crosses the wire — is what issues the one-shot permit, for that EXACT position.
    expect(cursorAfterWidenPair.sequence).toBe(cursorBeforeRewiden.sequence);
    expect(cursorAfterWidenPair.rowHash).toBeNull();
    expect(cursorAfterWidenPair.reanchorFromSeq).toBe(cursorBeforeRewiden.sequence);
  });

  it("THE PERMIT IS NOT A HOLE: a re-signed run with a middle entry deleted is REFUSED anyway", () => {
    // The deletion case is the one that decides the whole design, and the re-anchor must not
    // reopen it: with the permit in force, the ONLY relaxed check is the first entry's link to an
    // anchor this side never recorded. Gaps are still fatal.
    expect(thinnedWhilePermittedRefusal.status).toBe(409);
    const message = thinnedWhilePermittedRefusal.detail ?? thinnedWhilePermittedRefusal.message;
    expect(message).toMatch(/is not gap-free/);
    // ...and it says, truthfully, that the permit was in force and was not what failed.
    expect(message).toMatch(/one-shot re-anchor permit IS already in force/);
    expect(message).toMatch(/must still begin at exactly sequence/);
    expect(message.toLowerCase()).not.toContain("tamper");
  });

  it("RE-WIDENED BOTH SIDES: sync RESUMES and the cursor is strictly anchored again (no ratchet)", () => {
    // THE W1 REGRESSION. This used to be refused — and refused for every subsequent bundle too,
    // byte-identically — so a supported, purely local configuration change wedged the peer forever.
    expect(rewidenOutcome.ok).toBe(true);
    if (!rewidenOutcome.ok) return;
    expect(rewidenOutcome.result.appliedEntries).toBeGreaterThan(0);

    // Strictly anchored again: a real row hash is recorded, and the permit is CONSUMED — one run,
    // not a standing exemption.
    expect(cursorAfterRewiden.rowHash).not.toBeNull();
    expect(cursorAfterRewiden.sequence).toBe(rewidenOutcome.result.lastAppliedSequence);
    expect(cursorAfterRewiden.reanchorFromSeq).toBeNull();
    // And it never rewound: the re-anchor is a permit, not a cursor reset (which would also rewind
    // the key-rotation anchor `maxAppliedSequenceForPeer`).
    expect(cursorAfterRewiden.sequence).toBeGreaterThan(cursorBeforeRewiden.sequence);
  });

  it("...and the NEXT change after the re-anchor syncs on the fully strict path", () => {
    expect(postRewidenResult.appliedEntries).toBeGreaterThan(0);
    expect(cursorAfterPostRewiden.rowHash).not.toBeNull();
    expect(cursorAfterPostRewiden.sequence).toBe(postRewidenResult.lastAppliedSequence);
    expect(cursorAfterPostRewiden.reanchorFromSeq).toBeNull();
  });

  it("...and the deletion window stays CLOSED after the permit is consumed", () => {
    expect(thinnedAfterReanchorRefusal.status).toBe(409);
    const message = thinnedAfterReanchorRefusal.detail ?? thinnedAfterReanchorRefusal.message;
    expect(message).toMatch(/is not gap-free/);
    // A real anchor is held now, and the message says so rather than inventing a scope story.
    expect(message).toMatch(/a real anchor IS recorded for that peer/);
    expect(message.toLowerCase()).not.toContain("tamper");
  });

  it("AN ANCHORLESS CURSOR IS DESCRIBED AS ONE — not as a stale anchor from a previous regime", () => {
    // W2. The old message blamed "this side's last known-good anchor" and "the previous scope
    // regime" for a measured cursor of `{sequence: N, rowHash: null}` compared against
    // JOURNAL_GENESIS_HASH. There was no anchor and no stale regime — and the recovery it
    // prescribed did nothing.
    expect(unanchoredRefusal.status).toBe(409);
    const message = unanchoredRefusal.detail ?? unanchoredRefusal.message;

    // (a) THE OPENING CLAUSE STATES WHAT ACTUALLY HAPPENED. No holes in this run, so it must not
    // open with "not gap-free"; no anchor either, so it must not claim one.
    expect(message).not.toMatch(/^journal chain from peer .* is not gap-free/);
    expect(message).toMatch(/could not be anchored: this side has NO recorded anchor/);
    expect(message).toMatch(/compared against the genesis hash/);
    expect(message).toMatch(
      new RegExp(`cursor sits at sequence ${cursorAfterPostRewiden.sequence}`)
    );

    // (b) AND THE RECOVERY IS THE ONE THAT ACTUALLY WORKS — the operator-side widen that issues the
    // permit, not "align the scopes and re-export" (which is inert for this state).
    expect(message).toMatch(/--sync-scope full/);
    expect(message).toMatch(/one-shot permit/);

    // (c) still not a verdict, in either direction.
    expect(message.toLowerCase()).not.toContain("tamper");
    expect(message).toMatch(/AND neither scope has changed since that import/);
    expect(message).toMatch(/check whether either side's scope changed/);
  });

  it("CONTROL: the earlier full↔full sync verified strictly and was never diagnosed", () => {
    expect(fullSyncResult.appliedEntries).toBeGreaterThan(0);
    expect(fullSyncResult.lastAppliedSequence).toBeGreaterThan(0);
  });
});

/**
 * R1 — THE ALREADY-WEDGED POPULATION (pre-M16 residual W1, follow-up fix). The PHASE 5-8 tests above
 * all get to the wedged state via a scope TRANSITION (narrow → full), because that is how the fix in
 * e40e569 issued the re-anchor permit. But every peer the shipped W1 bug actually wedged got there
 * BEFORE that fix existed: its `sync_scope` already reads `full` (the operator widened it with the
 * pre-fix code — that widen is HOW it wedged) and its cursor is anchorless. There is no transition
 * left for that peer to make: `sync_scope` already says `full`. Under the transition-gated fix, the
 * refusal message's own prescribed recovery (`scp federation pair <peer> --sync-scope full`) was a
 * no-op — `previousScope.mode !== "full"` is false when the row already reads `full` — so the peer
 * stayed wedged forever, byte-identical refusal and all.
 *
 * THIS SUITE constructs that exact population DIRECTLY (peer paired at `full` throughout — never
 * narrowed, so there is genuinely no transition anywhere in this test's history — with an anchorless
 * cursor forced in afterward, the same technique PHASE 8 above uses), then runs the prescribed
 * recovery and asserts it actually works: the permit is issued and the peer's next run is accepted
 * with a strictly re-anchored cursor. It also re-confirms the permit issued this way is not a hole:
 * a re-signed bundle with a deleted middle entry is refused with the permit in force and again after
 * it is consumed, and a run starting above cursor+1 is refused too.
 */
describe("federation sync_scope full re-pair (R1): the ALREADY-WEDGED population (no transition) is healed", () => {
  let commander: IsolatedDomain;
  let outpost: IsolatedDomain;
  let selfCommander: FederationSelf;
  let selfOutpost: FederationSelf;
  let commanderPrivateKey: string;
  let commanderPublicKey: string;
  let outpostPublicKey: string;
  let componentId: string;

  const exportToOutpost = (): Promise<SyncBundle> =>
    withTenantTx(commander.db, commander.orgId, (tx) =>
      exportSyncBundle(tx, commander.orgId, outpost.orgName)
    );
  const importAtOutpost = (bundle: SyncBundle): Promise<ImportSyncBundleResult> =>
    withTenantTx(outpost.db, outpost.orgId, (tx) => importSyncBundle(tx, outpost.orgId, bundle));
  const outpostCursor = (): Promise<SyncCursor> =>
    withTenantTx(outpost.db, outpost.orgId, (tx) =>
      getCursor(tx, outpost.orgId, selfCommander.domainId, selfCommander.domainId)
    );
  /** THE RECOVERY THE REFUSAL MESSAGE PRESCRIBES, verbatim: re-pair this peer with
   *  `--sync-scope full`. The peer's row already says `full` — this call changes NOTHING about the
   *  configured scope. It is exactly `packages/cli/src/cli.ts`'s `federation pair --sync-scope full`
   *  from the outpost operator's seat. */
  const rePairWithFull = (): Promise<unknown> =>
    withTenantTx(outpost.db, outpost.orgId, (tx) =>
      pairPeer(tx, {
        orgId: outpost.orgId,
        domainId: selfCommander.domainId,
        name: commander.orgName,
        role: "commander",
        publicKey: commanderPublicKey,
        syncScope: { mode: "full" }
      })
    );
  const resign = (bundle: SyncBundle, entries: SyncBundle["entries"]): SyncBundle => {
    const checksum = computeBundleChecksum({ header: bundle.header, entries });
    return {
      ...bundle,
      entries,
      checksum,
      bundleSignature: signBundleChecksum(commanderPrivateKey, checksum)
    };
  };
  /** Same technique as the other suite's `thinAboveCursor`: delete a MIDDLE pending entry and
   *  re-sign — indistinguishable, byte for byte, from a legitimately scope-narrowed sender. */
  const thinAboveCursor = (bundle: SyncBundle, cursorSequence: number): SyncBundle => {
    const pending = bundle.entries.filter((entry) => entry.sequence > cursorSequence);
    expect(pending.length).toBeGreaterThan(2);
    const removed = pending[1]!;
    return resign(
      bundle,
      bundle.entries.filter((entry) => entry.sequence !== removed.sequence)
    );
  };
  /** Delete the FIRST pending entry and re-sign, so the run this side is asked to apply starts at
   *  `cursorSequence + 2`, not `cursorSequence + 1` — a different shape from a middle hole: the
   *  break is at the run's own start, not somewhere inside it. */
  const startAboveCursorPlusOne = (bundle: SyncBundle, cursorSequence: number): SyncBundle => {
    const pending = bundle.entries.filter((entry) => entry.sequence > cursorSequence);
    expect(pending.length).toBeGreaterThan(1);
    const skipped = pending[0]!;
    return resign(
      bundle,
      bundle.entries.filter((entry) => entry.sequence !== skipped.sequence)
    );
  };
  const expectRefused = async (bundle: SyncBundle): Promise<ProblemError> =>
    importAtOutpost(bundle).then(
      () => {
        throw new Error("expected this segment to be REFUSED, fail-closed");
      },
      (err: unknown) => {
        if (!(err instanceof ProblemError)) throw err;
        return err;
      }
    );
  const proposeOnCommander = (requestId: string, name: string): Promise<string> =>
    withTenantTx(commander.db, commander.orgId, async (tx) => {
      const { change } = await proposeChange(tx, {
        orgId: commander.orgId,
        actorObjectId: commander.orgId,
        requestId,
        name,
        targets: [componentId]
      });
      return change.id;
    });

  beforeAll(async () => {
    commander = await createIsolatedDomain("wedgedPopCommander");
    outpost = await createIsolatedDomain("wedgedPopOutpost");

    selfCommander = await withTenantTx(commander.db, commander.orgId, (tx) =>
      ensureFederationSelf(tx, commander.orgId)
    );
    selfOutpost = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      ensureFederationSelf(tx, outpost.orgId)
    );
    const commanderKey = await withTenantTx(commander.db, commander.orgId, (tx) =>
      ensureInstanceKey(tx, commander.orgId)
    );
    commanderPublicKey = commanderKey.publicKey;
    commanderPrivateKey = commanderKey.privateKey;
    const outpostKey = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      ensureInstanceKey(tx, outpost.orgId)
    );
    outpostPublicKey = outpostKey.publicKey;

    // Both sides paired at `full` from the very start — NEVER narrowed, so there is no transition
    // anywhere in this test's history for the transition-gated fix to have keyed off.
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      pairPeer(tx, {
        orgId: outpost.orgId,
        domainId: selfCommander.domainId,
        name: commander.orgName,
        role: "commander",
        publicKey: commanderPublicKey,
        syncScope: { mode: "full" }
      })
    );
    await withTenantTx(commander.db, commander.orgId, (tx) =>
      pairPeer(tx, {
        orgId: commander.orgId,
        domainId: selfOutpost.domainId,
        name: outpost.orgName,
        role: "outpost",
        publicKey: outpostPublicKey,
        syncScope: { mode: "full" }
      })
    );

    componentId = await withTenantTx(commander.db, commander.orgId, async (tx) => {
      const service = await createObject(tx, {
        orgId: commander.orgId,
        domainId: null,
        typeId: "service",
        actorObjectId: commander.orgId,
        requestId: "wedged-pop-service",
        name: "ledger-api"
      });
      const component = await createObject(tx, {
        orgId: commander.orgId,
        domainId: null,
        typeId: "component",
        actorObjectId: commander.orgId,
        requestId: "wedged-pop-component",
        name: "ledger-web"
      });
      await createRelationship(tx, {
        orgId: commander.orgId,
        actorObjectId: commander.orgId,
        requestId: "wedged-pop-contains",
        typeId: "contains",
        fromId: service.id,
        toId: component.id
      });
      return component.id;
    });
  }, 180_000);

  afterAll(async () => {
    await commander.close();
    await outpost.close();
  });

  it("THE PREMISE: a genuine full↔full sync establishes a real anchor and a positive sequence", async () => {
    const firstResult = await importAtOutpost(await exportToOutpost());
    expect(firstResult.appliedEntries).toBeGreaterThan(0);
    const cursor = await outpostCursor();
    expect(cursor.sequence).toBeGreaterThan(0);
    expect(cursor.rowHash).not.toBeNull();
    expect(cursor.reanchorFromSeq).toBeNull();
  });

  it("FORCE THE ALREADY-WEDGED STATE directly: full sync_scope, anchorless cursor, no permit — with NO transition anywhere", async () => {
    // Simulates exactly what the shipped W1 bug left behind, WITHOUT ever narrowing this peer's
    // scope: this is the population the transition-gated fix could never reach, because there is no
    // "previous non-full scope" for it to have transitioned from.
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      tx
        .update(syncCursors)
        .set({ lastAppliedRowHash: null, reanchorFromSeq: null })
        .where(
          and(
            eq(syncCursors.orgId, outpost.orgId),
            eq(syncCursors.peerDomainId, selfCommander.domainId),
            eq(syncCursors.originDomainId, selfCommander.domainId)
          )
        )
    );
    const cursor = await outpostCursor();
    expect(cursor.sequence).toBeGreaterThan(0);
    expect(cursor.rowHash).toBeNull();
    expect(cursor.reanchorFromSeq).toBeNull();
  });

  it("THE REFUSAL, PRE-RECOVERY: the peer's next honest, contiguous run is refused fail-closed", async () => {
    await proposeOnCommander("wedged-pop-change-1", "ledger rollout one");
    const refusal = await expectRefused(await exportToOutpost());
    expect(refusal.status).toBe(409);
    const cursor = await outpostCursor();
    // Refused: nothing applied, cursor unmoved.
    expect(cursor.rowHash).toBeNull();
  });

  it("THE RECOVERY THE MESSAGE PRESCRIBES ACTUALLY WORKS: re-pairing at `full` (already `full`, no transition) issues the permit", async () => {
    const cursorBefore = await outpostCursor();
    expect(cursorBefore.reanchorFromSeq).toBeNull();

    await rePairWithFull();

    const cursorAfterRepair = await outpostCursor();
    // THE DEFECT, MADE CONCRETE: under the transition-gated fix, this call is a no-op for issuance
    // — `previousScope.mode !== "full"` is false because the row already read `full` before AND
    // after this call — so `reanchorFromSeq` would stay `null` and the peer would remain wedged
    // forever. R1 keys issuance off the RESULTING scope and the cursor's actual (anchorless) state
    // instead, so the permit IS issued here.
    expect(cursorAfterRepair.reanchorFromSeq).toBe(cursorBefore.sequence);
    expect(cursorAfterRepair.sequence).toBe(cursorBefore.sequence);
    expect(cursorAfterRepair.rowHash).toBeNull();
  });

  it("THE PERMIT IS STILL NOT A HOLE: a re-signed run with a middle entry deleted is refused even with the permit in force", async () => {
    const cursor = await outpostCursor();
    expect(cursor.reanchorFromSeq).toBe(cursor.sequence);

    await proposeOnCommander("wedged-pop-change-2", "ledger rollout two");
    await proposeOnCommander("wedged-pop-change-2b", "ledger rollout two-b");
    const bundle = await exportToOutpost();

    const thinned = await expectRefused(thinAboveCursor(bundle, cursor.sequence));
    expect(thinned.status).toBe(409);
    expect(thinned.detail ?? thinned.message).toMatch(/is not gap-free/);
    expect((thinned.detail ?? thinned.message).toLowerCase()).not.toContain("tamper");

    const skewed = await expectRefused(startAboveCursorPlusOne(bundle, cursor.sequence));
    expect(skewed.status).toBe(409);

    // Neither malicious variant consumed the permit or moved the cursor — both were refused before
    // anything was applied.
    const cursorAfterAttacks = await outpostCursor();
    expect(cursorAfterAttacks.reanchorFromSeq).toBe(cursor.sequence);
    expect(cursorAfterAttacks.rowHash).toBeNull();
  });

  it("THE HONEST RUN IS ACCEPTED: the permit re-anchors the cursor and is consumed", async () => {
    const cursorBefore = await outpostCursor();
    const result = await importAtOutpost(await exportToOutpost());
    expect(result.appliedEntries).toBeGreaterThan(0);

    const cursorAfter = await outpostCursor();
    expect(cursorAfter.rowHash).not.toBeNull();
    expect(cursorAfter.sequence).toBe(result.lastAppliedSequence);
    expect(cursorAfter.sequence).toBeGreaterThan(cursorBefore.sequence);
    // ONE-SHOT: consumed by the very run it permitted.
    expect(cursorAfter.reanchorFromSeq).toBeNull();
  });

  it("AND THE DELETION WINDOW STAYS CLOSED once the permit has been consumed", async () => {
    await proposeOnCommander("wedged-pop-change-3", "ledger rollout three");
    await proposeOnCommander("wedged-pop-change-3b", "ledger rollout three-b");
    const cursor = await outpostCursor();
    const thinned = await expectRefused(thinAboveCursor(await exportToOutpost(), cursor.sequence));
    expect(thinned.status).toBe(409);
    expect(thinned.detail ?? thinned.message).toMatch(/is not gap-free/);
    expect(thinned.detail ?? thinned.message).toMatch(/a real anchor IS recorded for that peer/);
  });
});

/**
 * WHAT THE STRICT CHECK BUYS, stated as tests. Each case re-signs the bundle after mutating it,
 * which is what makes it meaningful: an in-transit attacker cannot get this far (the bundle checksum
 * and signature cover `{header, entries}` and are verified first), so these model the residual
 * threat — a signer, or anyone holding its key, producing bad content.
 *
 * The DELETION case is the one that decides the whole design. It is indistinguishable, byte for
 * byte, from a legitimately scope-narrowed sender; a receiver that tolerates holes takes it. Only
 * contiguity refuses it.
 */
describe("federation journal integrity: mutated and THINNED re-signed bundles are refused (Testcontainers, two databases)", () => {
  let commander: IsolatedDomain;
  let outpost: IsolatedDomain;
  let selfCommander: FederationSelf;
  let selfOutpost: FederationSelf;
  let commanderPrivateKey: string;
  let commanderPublicKey: string;
  let outpostPublicKey: string;
  let componentId: string;

  const resign = (bundle: SyncBundle, entries: SyncBundle["entries"]): SyncBundle => {
    const checksum = computeBundleChecksum({ header: bundle.header, entries });
    return {
      ...bundle,
      entries,
      checksum,
      bundleSignature: signBundleChecksum(commanderPrivateKey, checksum)
    };
  };
  /** Mutate one entry's payload (breaking its rowHash) and RE-SIGN, so the bundle-level
   *  checksum/signature gate passes and the chain check is what has to catch it. */
  const corruptAndResign = (bundle: SyncBundle, index: number): SyncBundle =>
    resign(
      bundle,
      bundle.entries.map((entry, i) =>
        i === index ? { ...entry, payload: { ...entry.payload, name: "INJECTED-NAME" } } : entry
      )
    );
  /** REMOVE an entry outright and RE-SIGN. Every surviving entry is authentic and verifies; the
   *  bundle checksum and signature are valid. Only the hole is wrong. */
  const deleteAndResign = (bundle: SyncBundle, index: number): SyncBundle =>
    resign(
      bundle,
      bundle.entries.filter((_entry, i) => i !== index)
    );

  beforeAll(async () => {
    commander = await createIsolatedDomain("scopeFenceCommander");
    outpost = await createIsolatedDomain("scopeFenceOutpost");

    selfCommander = await withTenantTx(commander.db, commander.orgId, (tx) =>
      ensureFederationSelf(tx, commander.orgId)
    );
    selfOutpost = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      ensureFederationSelf(tx, outpost.orgId)
    );
    const commanderKey = await withTenantTx(commander.db, commander.orgId, (tx) =>
      ensureInstanceKey(tx, commander.orgId)
    );
    commanderPrivateKey = commanderKey.privateKey;
    commanderPublicKey = commanderKey.publicKey;
    const outpostKey = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      ensureInstanceKey(tx, outpost.orgId)
    );
    outpostPublicKey = outpostKey.publicKey;

    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      pairPeer(tx, {
        orgId: outpost.orgId,
        domainId: selfCommander.domainId,
        name: commander.orgName,
        role: "commander",
        publicKey: commanderKey.publicKey
      })
    );
    await withTenantTx(commander.db, commander.orgId, (tx) =>
      pairPeer(tx, {
        orgId: commander.orgId,
        domainId: selfOutpost.domainId,
        name: outpost.orgName,
        role: "outpost",
        publicKey: outpostKey.publicKey
      })
    );

    componentId = await withTenantTx(commander.db, commander.orgId, async (tx) => {
      const service = await createObject(tx, {
        orgId: commander.orgId,
        domainId: null,
        typeId: "service",
        actorObjectId: commander.orgId,
        requestId: "scope-fence-service",
        name: "fence-api"
      });
      const component = await createObject(tx, {
        orgId: commander.orgId,
        domainId: null,
        typeId: "component",
        actorObjectId: commander.orgId,
        requestId: "scope-fence-component",
        name: "fence-web"
      });
      await createRelationship(tx, {
        orgId: commander.orgId,
        actorObjectId: commander.orgId,
        requestId: "scope-fence-contains",
        typeId: "contains",
        fromId: service.id,
        toId: component.id
      });
      return component.id;
    });
  }, 180_000);

  afterAll(async () => {
    await commander.close();
    await outpost.close();
  });

  it("a CONTIGUOUS chain with mutated, re-signed content is rejected as an integrity failure", async () => {
    const bundle = await withTenantTx(commander.db, commander.orgId, (tx) =>
      exportSyncBundle(tx, commander.orgId, outpost.orgName)
    );
    expect(bundle.entries.length).toBeGreaterThan(1);
    await expect(
      withTenantTx(outpost.db, outpost.orgId, (tx) =>
        importSyncBundle(tx, outpost.orgId, corruptAndResign(bundle, bundle.entries.length - 1))
      )
    ).rejects.toMatchObject({
      status: 409,
      // A rowHash failure is NOT a scope asymmetry, and keeps the security-toned wording — the
      // typed break code is what keeps the two apart (`JournalChainBreakCode`).
      detail: expect.stringMatching(/tampered or broken journal segment.*row_hash mismatch/)
    });
  });

  it("THE DELETION CASE: a re-signed bundle with a MIDDLE entry removed is REFUSED", async () => {
    const bundle = await withTenantTx(commander.db, commander.orgId, (tx) =>
      exportSyncBundle(tx, commander.orgId, outpost.orgName)
    );
    expect(bundle.entries.length).toBeGreaterThan(2);
    const thinned = deleteAndResign(bundle, 1);

    // The premise: everything EXCEPT contiguity is intact. The bundle checksum recomputes, the
    // bundle signature verifies, and every surviving entry is the sender's own authentic row. This
    // is exactly what a scope-narrowed sender's traffic looks like — which is why tolerating it in
    // the name of diagnosability would have silently deleted this detection.
    expect(thinned.checksum).toBe(
      computeBundleChecksum({ header: thinned.header, entries: thinned.entries })
    );
    expect(thinned.entries).toHaveLength(bundle.entries.length - 1);

    await expect(
      withTenantTx(outpost.db, outpost.orgId, (tx) => importSyncBundle(tx, outpost.orgId, thinned))
    ).rejects.toMatchObject({
      status: 409,
      detail: expect.stringMatching(/is not gap-free/)
    });

    // Nothing applied: the cursor is untouched.
    const cursor = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      getCursor(tx, outpost.orgId, selfCommander.domainId, selfCommander.domainId)
    );
    expect(cursor.sequence).toBe(0);
  });

  it("a SPARSE chain with mutated, re-signed content is rejected too — narrowness buys no leniency", async () => {
    // The clean contiguous sync first, so the receiver holds a rowHash anchor.
    const clean = await withTenantTx(commander.db, commander.orgId, (tx) =>
      exportSyncBundle(tx, commander.orgId, outpost.orgName)
    );
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      importSyncBundle(tx, outpost.orgId, clean)
    );

    // Now BOTH sides narrow — the configured-sparse shape, where the receiver has knowingly given
    // up the gap-free guarantee. Every other check still applies.
    await withTenantTx(commander.db, commander.orgId, (tx) =>
      pairPeer(tx, {
        orgId: commander.orgId,
        domainId: selfOutpost.domainId,
        name: outpost.orgName,
        role: "outpost",
        publicKey: outpostPublicKey,
        syncScope: { mode: "status_only" }
      })
    );
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      pairPeer(tx, {
        orgId: outpost.orgId,
        domainId: selfCommander.domainId,
        name: commander.orgName,
        role: "commander",
        // The SAME key — a different value here would register a rotation and hard-revoke the key
        // that signed everything this test is about to verify.
        publicKey: commanderPublicKey,
        syncScope: { mode: "status_only" }
      })
    );
    await withTenantTx(commander.db, commander.orgId, async (tx) => {
      await proposeChange(tx, {
        orgId: commander.orgId,
        actorObjectId: commander.orgId,
        requestId: "scope-fence-change",
        name: "fence rollout",
        targets: [componentId]
      });
    });
    const sparse = await withTenantTx(commander.db, commander.orgId, (tx) =>
      exportSyncBundle(tx, commander.orgId, outpost.orgName)
    );
    expect(sparse.entries.length).toBeGreaterThan(0);

    await expect(
      withTenantTx(outpost.db, outpost.orgId, (tx) =>
        // The LAST entry — the export restarts from sequence 0, so the leading ones sit below the
        // cursor and are filtered out before verification ever sees them.
        importSyncBundle(tx, outpost.orgId, corruptAndResign(sparse, sparse.entries.length - 1))
      )
    ).rejects.toMatchObject({
      status: 409,
      detail: expect.stringMatching(/tampered or broken journal segment.*row_hash mismatch/)
    });

    // And nothing from the rejected segment applied.
    const cursorAfter = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      getCursor(tx, outpost.orgId, selfCommander.domainId, selfCommander.domainId)
    );
    expect(cursorAfter.sequence).toBe(clean.header.throughSequence);
  });
});
