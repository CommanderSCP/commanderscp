import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SyncBundle } from "@scp/schemas";
import { computeBundleChecksum, signBundleChecksum } from "@scp/schemas/federation-journal";
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
 */
describe("federation sync_scope asymmetry: refused fail-closed, diagnosed accurately, recoverable (Testcontainers, two databases)", () => {
  let commander: IsolatedDomain;
  let outpost: IsolatedDomain;
  let selfCommander: FederationSelf;
  let selfOutpost: FederationSelf;
  let outpostPublicKey: string;
  let commanderPublicKey: string;

  let componentId: string;

  let fullSyncResult: ImportSyncBundleResult;
  let sparseBundle: SyncBundle;
  let refusal: ProblemError;
  let cursorAfterRefusal: SyncCursor;
  let realignedResult: ImportSyncBundleResult;
  let cursorAfterRealign: SyncCursor;
  let resumedResult: ImportSyncBundleResult;
  let receiverNarrowedResult: ImportSyncBundleResult;

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

  it("CONTROL: the earlier full↔full sync verified strictly and was never diagnosed", () => {
    expect(fullSyncResult.appliedEntries).toBeGreaterThan(0);
    expect(fullSyncResult.lastAppliedSequence).toBeGreaterThan(0);
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
