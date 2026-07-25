import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SyncBundle } from "@scp/schemas";
import { computeBundleChecksum, signBundleChecksum } from "@scp/schemas/federation-journal";
import { withTenantTx } from "../db/tenant-tx.js";
import { createObject } from "../graph/objects-repo.js";
import { createRelationship } from "../graph/relationships-repo.js";
import { ensureInstanceKey } from "../governance/attestation.js";
import { proposeChange } from "../coordination/changes-repo.js";
import { ensureFederationSelf, type FederationSelf } from "./self-repo.js";
import { pairPeer } from "./peers-repo.js";
import { getCursor } from "./cursors-repo.js";
import { exportSyncBundle } from "./export-repo.js";
import { importSyncBundle, type ImportSyncBundleResult } from "./import-repo.js";
import { listUnattachedChangeStatusInStates } from "./unattached-change-status-repo.js";
import { createIsolatedDomain, type IsolatedDomain } from "./test-support/isolated-domain.js";

/**
 * THE SENDER-NARROW / RECEIVER-`full` ASYMMETRY — the misconfiguration that used to halt federation
 * sync outright and blame TAMPERING for it.
 *
 * `federation_peers.sync_scope` is per-side LOCAL config: set independently by the operator on each
 * domain, never carried on the wire, never reconciled. The receiver's default is `full`. So the most
 * likely field mistake in an outpost rollout — the outpost operator pairs the commander without
 * `--sync-scope` while the commander operator narrows what it SENDS — produced a receiver demanding
 * a gap-free chain from a sender that legitimately ships a sparse one. First entry, `sequence_gap`,
 * `409 tampered or broken journal segment`, sync dead. Fail-closed, so never a safety hole; a
 * diagnosability disaster, and M16 is when operators will actually do this.
 *
 * WHAT IS PINNED HERE: the segment is ACCEPTED (its integrity is fully proven — see
 * `import-repo.ts`'s `verifySegment` for why sparseness is not a tamper signal once the bundle
 * checksum + signature have already covered the whole payload), the asymmetry is REPORTED naming
 * both scopes, and the word "tampered" never appears for it.
 */
describe("federation sync_scope asymmetry: a narrower SENDER does not read as tampering (Testcontainers, two databases)", () => {
  let commander: IsolatedDomain;
  let outpost: IsolatedDomain;
  let selfCommander: FederationSelf;
  let selfOutpost: FederationSelf;

  let componentId: string;
  let changeId: string;

  let fullSyncResult: ImportSyncBundleResult;
  let firstSparseResult: ImportSyncBundleResult;
  let secondSparseResult: ImportSyncBundleResult;
  let firstSparseBundle: SyncBundle;

  const exportToOutpost = (): Promise<SyncBundle> =>
    withTenantTx(commander.db, commander.orgId, (tx) =>
      exportSyncBundle(tx, commander.orgId, outpost.orgName)
    );
  const importAtOutpost = (bundle: SyncBundle): Promise<ImportSyncBundleResult> =>
    withTenantTx(outpost.db, outpost.orgId, (tx) => importSyncBundle(tx, outpost.orgId, bundle));

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
    const outpostKey = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      ensureInstanceKey(tx, outpost.orgId)
    );

    // THE OUTPOST OPERATOR pairs the commander and never passes `--sync-scope` — so this side is
    // `full` (peers-repo.ts's default) and expects a gap-free chain. This is the whole setup.
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

    // A first, genuinely CONTIGUOUS sync while both sides are still `full`. It establishes the
    // cursor's rowHash anchor, so the strict check below has something to anchor to — without it the
    // fallback would be reached for a reason other than the one under test.
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

    // THE COMMANDER OPERATOR narrows what this outpost RECEIVES to `status_only`. Reasonable on its
    // own (change status crosses the boundary, graph content does not). Nothing tells the outpost.
    await withTenantTx(commander.db, commander.orgId, (tx) =>
      pairPeer(tx, {
        orgId: commander.orgId,
        domainId: selfOutpost.domainId,
        name: outpost.orgName,
        role: "outpost",
        publicKey: outpostKey.publicKey,
        syncScope: { mode: "status_only" }
      })
    );

    changeId = await withTenantTx(commander.db, commander.orgId, async (tx) => {
      const { change } = await proposeChange(tx, {
        orgId: commander.orgId,
        actorObjectId: commander.orgId,
        requestId: "scope-asym-change",
        name: "payments rollout",
        targets: [componentId]
      });
      return change.id;
    });
    firstSparseBundle = await exportToOutpost();
    firstSparseResult = await importAtOutpost(firstSparseBundle);

    // A SECOND sparse sync. The first one advanced the cursor with `rowHash: null` (no anchor left),
    // so this exercises the no-anchor branch rather than the strict-then-fallback one.
    await withTenantTx(commander.db, commander.orgId, async (tx) => {
      await proposeChange(tx, {
        orgId: commander.orgId,
        actorObjectId: commander.orgId,
        requestId: "scope-asym-change-2",
        name: "payments rollout two",
        targets: [componentId]
      });
    });
    secondSparseResult = await importAtOutpost(await exportToOutpost());
  }, 180_000);

  afterAll(async () => {
    await commander.close();
    await outpost.close();
  });

  it("the premise: the sender really did ship a SPARSE chain, and this side is really `full`", () => {
    const span = firstSparseBundle.header.throughSequence - firstSparseBundle.header.sinceSequence;
    expect(firstSparseBundle.entries.length).toBeGreaterThan(0);
    // Fewer entries than the range they span == the sender withheld out-of-scope sequences.
    expect(firstSparseBundle.entries.length).toBeLessThan(span);
    // ...and the gaps are real, not merely a short range.
    const sequences = firstSparseBundle.entries.map((e) => e.sequence);
    expect(Math.max(...sequences) - Math.min(...sequences) + 1).toBeGreaterThan(sequences.length);
  });

  it("REGRESSION: the sparse segment IMPORTS instead of halting sync as a tampered chain", () => {
    expect(firstSparseResult.appliedEntries).toBeGreaterThan(0);
    expect(firstSparseResult.lastAppliedSequence).toBe(firstSparseBundle.header.throughSequence);
  });

  it("the asymmetry is REPORTED: both scopes named, an action given, and never the word 'tampered'", () => {
    const message = firstSparseResult.scopeAsymmetry;
    expect(message, "an accepted sparse segment must carry the diagnostic").toBeTruthy();
    expect(message!).toMatch(/SPARSE journal segment/);
    // THIS side's scope, stated — the operator cannot see it from the other domain.
    expect(message!).toMatch(/sync_scope for that peer is 'full'/);
    // The likely cause, named, with the narrow modes spelled out.
    expect(message!).toMatch(/SENDER's sync_scope is almost certainly narrower/);
    expect(message!).toMatch(/status_only/);
    // Something to actually do.
    expect(message!).toMatch(/scp federation peers.*BOTH domains/);
    // The peer is identified by both name and domain id.
    expect(message!).toContain(commander.orgName);
    expect(message!).toContain(selfCommander.domainId);
    // THE POINT: a config asymmetry is never announced as tampering.
    expect(message!).not.toMatch(/tampered/);
  });

  it("the change status still lands as evidence — the sparse segment was applied, not merely tolerated", async () => {
    const unattached = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      listUnattachedChangeStatusInStates(tx, outpost.orgId, ["proposed"])
    );
    expect(unattached.map((u) => u.changeObjectId)).toContain(changeId);
    // The sender withheld the change OBJECT (out of `status_only`); this receiver is `full`, so the
    // drop is the sender's, not this side's filter.
    expect(unattached.find((u) => u.changeObjectId === changeId)!.dropReason).toBe(
      "no_local_replica"
    );
  });

  it("a SECOND sparse sync still imports once the rowHash anchor is gone, and still reports", async () => {
    expect(secondSparseResult.appliedEntries).toBeGreaterThan(0);
    expect(secondSparseResult.scopeAsymmetry).toMatch(/SPARSE journal segment/);
    const cursor = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      getCursor(tx, outpost.orgId, selfCommander.domainId, selfCommander.domainId)
    );
    // Sparse acceptance advances past the out-of-scope sequences so they are never re-requested,
    // and stores no anchor (this side never saw the entries those hashes chain through).
    expect(cursor.rowHash).toBeNull();
    expect(cursor.sequence).toBe(secondSparseResult.lastAppliedSequence);
  });

  it("CONTROL: the earlier full<->full sync verified strictly and reported NO asymmetry", () => {
    expect(fullSyncResult.appliedEntries).toBeGreaterThan(0);
    expect(fullSyncResult.scopeAsymmetry ?? null).toBeNull();
  });
});

/**
 * THE FENCES on the acceptance above. The point of `verifySegment` is that only the CONTIGUITY
 * guarantee is relaxed — never an integrity check — so both of these must still be rejected, and
 * rejected as what they are.
 *
 * Both cases re-sign the bundle after mutating it, which is what makes them meaningful: an
 * in-transit attacker cannot get this far (the bundle checksum + signature cover `{header, entries}`
 * and are verified first), so these model the residual threat — a signer producing bad content.
 */
describe("federation sync_scope asymmetry: integrity failures are never retried in the laxer mode (Testcontainers, two databases)", () => {
  let commander: IsolatedDomain;
  let outpost: IsolatedDomain;
  let selfCommander: FederationSelf;
  let selfOutpost: FederationSelf;
  let commanderPrivateKey: string;
  let outpostPublicKey: string;
  let componentId: string;

  /** Mutate one entry's payload (breaking its rowHash) and RE-SIGN the bundle, so the bundle-level
   *  checksum/signature gate passes and the chain check is what has to catch it. */
  const corruptAndResign = (bundle: SyncBundle, index: number): SyncBundle => {
    const entries = bundle.entries.map((entry, i) =>
      i === index ? { ...entry, payload: { ...entry.payload, name: "INJECTED-NAME" } } : entry
    );
    const checksum = computeBundleChecksum({ header: bundle.header, entries });
    return {
      ...bundle,
      entries,
      checksum,
      bundleSignature: signBundleChecksum(commanderPrivateKey, checksum)
    };
  };

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

  it("a CONTIGUOUS chain with mutated, re-signed content is rejected outright (no laxer retry)", async () => {
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
      detail: expect.stringMatching(/tampered or broken journal segment.*row_hash mismatch/)
    });
  });

  it("a SPARSE chain with mutated, re-signed content is rejected too — sparseness buys no leniency", async () => {
    // The clean contiguous sync first, so the receiver holds a rowHash anchor.
    const clean = await withTenantTx(commander.db, commander.orgId, (tx) =>
      exportSyncBundle(tx, commander.orgId, outpost.orgName)
    );
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      importSyncBundle(tx, outpost.orgId, clean)
    );

    // Now the sender narrows and emits a sparse segment...
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
