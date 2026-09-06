import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asTrustDomainId, type SyncBundle, type TrustDomainId } from "@scp/schemas";
import { computeBundleChecksum, signBundleChecksum } from "@scp/schemas/federation-journal";
import { withTenantTx } from "../db/tenant-tx.js";
import { syncCursors } from "../db/schema.js";
import { and, eq } from "drizzle-orm";
import { createObject } from "../graph/objects-repo.js";
import { ensureInstanceKey } from "../governance/attestation.js";
import { ensureFederationSelf, type FederationSelf } from "./self-repo.js";
import { pairPeer, getPeerByIdOrName } from "./peers-repo.js";
import { exportSyncBundle, JournalDivergenceDetected } from "./export-repo.js";
import { importSyncBundle } from "./import-repo.js";
import { permitCursorReanchor, FEDERATION_DIVERGENCE_DECISION_KIND } from "./cursors-repo.js";
import { insertDecision } from "../coordination/decisions-repo.js";
import { createIsolatedDomain, type IsolatedDomain } from "./test-support/isolated-domain.js";

/**
 * DIVERGENCE RAILS 1/2/4/5 (multi-region-instance-resilience.md §7.2) — the fork/rollback detection
 * that turns a lost tail after an async-replication failover from silent divergence into a named,
 * fail-closed `journal_divergence`. Two GENUINELY separate databases (isolated-domain.ts), the same
 * topology M6's own suite uses. A = commander/exporter, B = full-scope outpost/importer.
 */
describe("divergence rails: export-side tail/anchor checks, tail attestation, reanchor refusal", () => {
  let domainA: IsolatedDomain;
  let domainB: IsolatedDomain;
  let selfA: FederationSelf;
  let keyA: { publicKey: string; privateKey: string };
  let peerAIdInB: TrustDomainId;

  async function pair(a: IsolatedDomain, b: IsolatedDomain, role: "outpost" | "commander") {
    const key = await withTenantTx(b.db, b.orgId, (tx) => ensureInstanceKey(tx, b.orgId));
    const self = await withTenantTx(b.db, b.orgId, (tx) => ensureFederationSelf(tx, b.orgId));
    await withTenantTx(a.db, a.orgId, (tx) =>
      pairPeer(tx, {
        orgId: a.orgId,
        domainId: self.domainId,
        name: b.orgName,
        role,
        publicKey: key.publicKey,
        syncScope: { mode: "full" }
      })
    );
  }

  beforeAll(async () => {
    domainA = await createIsolatedDomain("rails-a");
    domainB = await createIsolatedDomain("rails-b");
    selfA = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      ensureFederationSelf(tx, domainA.orgId)
    );
    keyA = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      ensureInstanceKey(tx, domainA.orgId)
    );
    await pair(domainA, domainB, "outpost");
    await pair(domainB, domainA, "commander");
    for (const name of ["svc-1", "svc-2", "svc-3"]) {
      await withTenantTx(domainA.db, domainA.orgId, (tx) =>
        createObject(tx, {
          orgId: domainA.orgId,
          domainId: null,
          typeId: "service",
          actorObjectId: domainA.orgId,
          requestId: `rails-${name}`,
          name
        })
      );
    }
    const peerA = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      getPeerByIdOrName(tx, domainB.orgId, selfA.domainId)
    );
    peerAIdInB = asTrustDomainId(peerA.id);
  }, 90_000);

  afterAll(async () => {
    await domainA.close();
    await domainB.close();
  });

  async function exportFromA(
    sinceSequence?: number,
    lastAppliedRowHash?: string
  ): Promise<SyncBundle> {
    return withTenantTx(domainA.db, domainA.orgId, (tx) =>
      exportSyncBundle(tx, domainA.orgId, domainB.orgName, sinceSequence, lastAppliedRowHash)
    );
  }

  it("RAIL 4: every export carries a signed tail attestation, and a healthy import advances the high-water mark", async () => {
    const bundle = await exportFromA();
    expect(bundle.tailAttestation).toBeDefined();
    expect(bundle.tailAttestation!.tailSequence).toBeGreaterThan(0);

    await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      importSyncBundle(tx, domainB.orgId, bundle)
    );

    const attested = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      tx
        .select({ seq: syncCursors.attestedTailSeq, hash: syncCursors.attestedTailRowHash })
        .from(syncCursors)
        .where(and(eq(syncCursors.orgId, domainB.orgId), eq(syncCursors.peerDomainId, peerAIdInB)))
        .limit(1)
    );
    expect(attested[0]?.seq).toBe(bundle.tailAttestation!.tailSequence);
    expect(attested[0]?.hash).toBe(bundle.tailAttestation!.tailRowHash);
  });

  /** Re-sign a bundle's tail attestation at a chosen (sequence, rowHash) with A's REAL key — models
   *  the exporter itself attesting a rolled-back/forked tail (a bug or a compromised/rolled-back
   *  exporter), the exact B1 threat rail 4 exists to catch. */
  function withAttestation(
    bundle: SyncBundle,
    tailSequence: number,
    tailRowHash: string
  ): SyncBundle {
    const signature = signBundleChecksum(
      keyA.privateKey,
      computeBundleChecksum({
        exporterDomainId: bundle.header.exporterDomainId,
        peerDomainId: bundle.header.peerDomainId,
        tailSequence,
        tailRowHash
      })
    );
    return { ...bundle, tailAttestation: { tailSequence, tailRowHash, signature } };
  }

  async function highWaterSeq(): Promise<number> {
    const rows = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      tx
        .select({ seq: syncCursors.attestedTailSeq })
        .from(syncCursors)
        .where(and(eq(syncCursors.orgId, domainB.orgId), eq(syncCursors.peerDomainId, peerAIdInB)))
        .limit(1)
    );
    return rows[0]?.seq ?? 0;
  }

  it("RAIL 4: an attestation at the SAME height but a DIFFERENT rowHash is refused journal_divergence (a fork), even on a replay", async () => {
    const recorded = await highWaterSeq();
    const bundle = await exportFromA(); // a replay bundle (nothing new since the happy test)
    const forked = withAttestation(bundle, recorded, "f0f0f0f0".repeat(8));
    await expect(
      withTenantTx(domainB.db, domainB.orgId, (tx) => importSyncBundle(tx, domainB.orgId, forked))
    ).rejects.toMatchObject({ type: "urn:scp:federation:journal_divergence" });
  });

  it("RAIL 4: an OLDER bundle re-delivered (its attestation legitimately below the mark) is NOT refused — idempotent replay is preserved", async () => {
    // A genuine replay: the bundle's own throughSequence is at/below what B applied, and its
    // attestation is honestly older. This must be a no-op, not a false regression.
    const recorded = await highWaterSeq();
    const bundle = await exportFromA();
    const older = withAttestation(
      bundle,
      Math.max(0, recorded - 1),
      bundle.tailAttestation!.tailRowHash
    );
    const result = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      importSyncBundle(tx, domainB.orgId, older)
    );
    expect(result.appliedEntries).toBe(0);
    expect(await highWaterSeq()).toBe(recorded); // mark neither regressed nor advanced
  });

  it("RAIL 4: a FRESH bundle (new entries beyond the cursor) whose attestation regresses below the mark IS refused", async () => {
    // Make the next export genuinely fresh so it is not treated as a replay.
    await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      createObject(tx, {
        orgId: domainA.orgId,
        domainId: null,
        typeId: "service",
        actorObjectId: domainA.orgId,
        requestId: "rails-fresh-regression",
        name: "fresh-svc"
      })
    );
    const recorded = await highWaterSeq();
    const fresh = await exportFromA();
    const regressed = withAttestation(fresh, recorded - 1, "deadbeef".repeat(8));
    await expect(
      withTenantTx(domainB.db, domainB.orgId, (tx) =>
        importSyncBundle(tx, domainB.orgId, regressed)
      )
    ).rejects.toMatchObject({ type: "urn:scp:federation:journal_divergence" });
  });

  it("RAIL 4: a forged attestation signature (not A's key) is refused fail-closed", async () => {
    const bundle = await exportFromA();
    const tampered: SyncBundle = {
      ...bundle,
      tailAttestation: { ...bundle.tailAttestation!, signature: "not-a-real-signature" }
    };
    await expect(
      withTenantTx(domainB.db, domainB.orgId, (tx) => importSyncBundle(tx, domainB.orgId, tampered))
    ).rejects.toMatchObject({
      type: "urn:scp:federation:journal_divergence",
      detail: expect.stringMatching(/attestation signature/i)
    });
  });

  it("RAIL 1: a pull whose sinceSequence is BEYOND the exporter's own tail is a journal_divergence (no new wire data)", async () => {
    const tail = (await exportFromA()).tailAttestation!.tailSequence;
    await expect(exportFromA(tail + 5)).rejects.toBeInstanceOf(JournalDivergenceDetected);
    await expect(exportFromA(tail + 5)).rejects.toMatchObject({ rail: "export-tail" });
  });

  it("RAIL 2: a pull whose anchor rowHash does not match the exporter's journal at that height is a journal_divergence", async () => {
    // A valid mid-journal sinceSequence, but a bogus anchor hash.
    await expect(exportFromA(1, "not-the-real-rowhash-at-seq-1")).rejects.toBeInstanceOf(
      JournalDivergenceDetected
    );
    await expect(exportFromA(1, "not-the-real-rowhash-at-seq-1")).rejects.toMatchObject({
      rail: "anchor"
    });
  });

  it("RAIL 5: reanchor is REFUSED while a divergence stands AND the cursor is anchorless; but not otherwise", async () => {
    // Force an anchorless cursor for A on B (rowHash NULL, seq > 0) — the state a narrow-scope
    // verification leaves behind, and the only state a reanchor permit is eligible for.
    await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      tx
        .insert(syncCursors)
        .values({
          orgId: domainB.orgId,
          peerDomainId: peerAIdInB,
          originDomainId: peerAIdInB,
          lastAppliedSeq: 3,
          lastAppliedRowHash: null
        })
        .onConflictDoUpdate({
          target: [syncCursors.orgId, syncCursors.peerDomainId, syncCursors.originDomainId],
          set: { lastAppliedSeq: 3, lastAppliedRowHash: null, attestedTailSeq: null }
        })
    );

    // No standing divergence yet → the permit is issued (returns > 0), no throw (no false positive).
    const permitted = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      permitCursorReanchor(tx, domainB.orgId, peerAIdInB)
    );
    expect(permitted).toBeGreaterThan(0);

    await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      insertDecision(tx, {
        orgId: domainB.orgId,
        kind: FEDERATION_DIVERGENCE_DECISION_KIND,
        subjectId: peerAIdInB,
        verdict: "block",
        inputContext: { peerDomainId: peerAIdInB },
        reasonTree: { summary: "test-seeded standing divergence" }
      })
    );
    // Re-null the anchor (advanceCursor may have run; keep it eligible).
    await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      tx
        .update(syncCursors)
        .set({ lastAppliedRowHash: null, reanchorFromSeq: null })
        .where(and(eq(syncCursors.orgId, domainB.orgId), eq(syncCursors.peerDomainId, peerAIdInB)))
    );

    // Standing divergence + anchorless cursor → REFUSED, naming resync.
    await expect(
      withTenantTx(domainB.db, domainB.orgId, (tx) =>
        permitCursorReanchor(tx, domainB.orgId, peerAIdInB)
      )
    ).rejects.toMatchObject({ type: "urn:scp:federation:journal_divergence" });

    // No false positive: give the cursor a real anchor → reanchor is a no-op (returns 0), NOT a
    // refusal, even with the divergence still standing (there is nothing to re-anchor).
    await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      tx
        .update(syncCursors)
        .set({ lastAppliedRowHash: "a-real-anchor-hash" })
        .where(and(eq(syncCursors.orgId, domainB.orgId), eq(syncCursors.peerDomainId, peerAIdInB)))
    );
    const anchored = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      permitCursorReanchor(tx, domainB.orgId, peerAIdInB)
    );
    expect(anchored).toBe(0);
  });
});
