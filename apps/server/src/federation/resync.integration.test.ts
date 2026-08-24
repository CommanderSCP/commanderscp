import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { asTrustDomainId } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import { syncCursors } from "../db/schema.js";
import { createObject, getObjectByIdOrUrnAnyType, updateObject } from "../graph/objects-repo.js";
import { ensureInstanceKey } from "../governance/attestation.js";
import { insertDecision, latestDecisionForSubjectKind } from "../coordination/decisions-repo.js";
import { ensureFederationSelf, type FederationSelf } from "./self-repo.js";
import { pairPeer, getPeerByIdOrName } from "./peers-repo.js";
import { exportSyncBundle } from "./export-repo.js";
import { importSyncBundle } from "./import-repo.js";
import {
  signResyncRequest,
  authorizeResyncAndReExport,
  applyResyncBundle,
  FEDERATION_RESYNC_DECISION_KIND
} from "./resync-repo.js";
import { permitCursorReanchor, FEDERATION_DIVERGENCE_DECISION_KIND } from "./cursors-repo.js";
import { createIsolatedDomain, type IsolatedDomain } from "./test-support/isolated-domain.js";

/**
 * §7.2.6 RESYNC — the mutually-authorized recovery. A = commander/exporter, B = full-scope
 * outpost/importer. Proves: the signed handshake (B signs, A verifies-and-consents), the
 * force-overwrite re-convergence (a divergent replica ahead in revision is overwritten to the
 * exporter's reality — the whole point; a normal import would no-op), both-sides Decisions +
 * generation bumps, the cleared standing divergence lifting rail 5, and a forged request refused.
 */
describe("federation resync: signed handshake, force-overwrite convergence, divergence cleared", () => {
  let domainA: IsolatedDomain;
  let domainB: IsolatedDomain;
  let selfA: FederationSelf;
  let peerAIdInB: ReturnType<typeof asTrustDomainId>;

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
    domainA = await createIsolatedDomain("resync-a");
    domainB = await createIsolatedDomain("resync-b");
    selfA = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      ensureFederationSelf(tx, domainA.orgId)
    );
    await pair(domainA, domainB, "outpost"); // A knows B as an outpost it exports to
    await pair(domainB, domainA, "commander"); // B knows A as its commander
    const peerA = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      getPeerByIdOrName(tx, domainB.orgId, selfA.domainId)
    );
    peerAIdInB = asTrustDomainId(peerA.id);
  }, 90_000);

  afterAll(async () => {
    await domainA.close();
    await domainB.close();
  });

  it("force-overwrites a divergent replica back to the exporter's reality, records on both sides, and clears the divergence", async () => {
    // A creates X and B imports it normally → B holds A's reality.
    const created = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      createObject(tx, {
        orgId: domainA.orgId,
        domainId: null,
        typeId: "service",
        actorObjectId: domainA.orgId,
        requestId: "resync-x",
        name: "resync-svc",
        properties: { tier: "critical" }
      })
    );
    const firstBundle = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      exportSyncBundle(tx, domainA.orgId, domainB.orgName)
    );
    await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      importSyncBundle(tx, domainB.orgId, firstBundle)
    );

    // DIVERGE B: bump B's replica to a HIGHER revision with DIFFERENT content (simulating the state a
    // lost-tail leaves behind). A normal re-import of A's rev-1 entry would now no-op (1 <= 99) — the
    // exact staleness the force-overwrite must defeat.
    await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      updateObject(tx, {
        orgId: domainB.orgId,
        typeId: "service",
        actorObjectId: domainB.orgId,
        requestId: "resync-diverge",
        idOrUrn: created.id,
        properties: { tier: "TAMPERED" },
        federationImport: { originDomainId: selfA.domainId, revision: 99 }
      })
    );
    const diverged = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      getObjectByIdOrUrnAnyType(tx, domainB.orgId, created.id)
    );
    expect(diverged.properties.tier).toBe("TAMPERED");

    // Stand a divergence + anchorless cursor so rail 5 is ACTIVE (reanchor would refuse) before resync.
    await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      insertDecision(tx, {
        orgId: domainB.orgId,
        kind: FEDERATION_DIVERGENCE_DECISION_KIND,
        subjectId: peerAIdInB,
        verdict: "block",
        inputContext: { peerDomainId: peerAIdInB },
        reasonTree: { summary: "standing divergence before resync" }
      })
    );
    await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      tx
        .update(syncCursors)
        .set({ lastAppliedRowHash: null })
        .where(and(eq(syncCursors.orgId, domainB.orgId), eq(syncCursors.peerDomainId, peerAIdInB)))
    );
    await expect(
      withTenantTx(domainB.db, domainB.orgId, (tx) =>
        permitCursorReanchor(tx, domainB.orgId, asTrustDomainId(peerAIdInB))
      )
    ).rejects.toMatchObject({ type: "urn:scp:federation:journal_divergence" });

    // THE HANDSHAKE. B signs; A verifies-and-consents-and-re-exports; B force-applies.
    const signed = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      signResyncRequest(tx, domainB.orgId, peerAIdInB)
    );
    const authorized = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      authorizeResyncAndReExport(tx, domainA.orgId, {
        peer: signed.importerDomainId,
        requestSignature: signed.requestSignature
      })
    );
    expect(authorized.exporterGeneration).toBeGreaterThan(0);

    const result = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      applyResyncBundle(
        tx,
        domainB.orgId,
        peerAIdInB,
        authorized.bundle,
        authorized.exporterGeneration
      )
    );
    expect(result.appliedEntries).toBeGreaterThan(0);
    expect(result.generation).toBeGreaterThan(0);

    // CONVERGED: B's replica is back to A's reality despite having been at a higher revision.
    const reconverged = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      getObjectByIdOrUrnAnyType(tx, domainB.orgId, created.id)
    );
    expect(reconverged.properties.tier).toBe("critical");

    // Both sides recorded a resync Decision.
    const bDecision = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      latestDecisionForSubjectKind(tx, domainB.orgId, peerAIdInB, FEDERATION_RESYNC_DECISION_KIND)
    );
    expect(bDecision?.verdict).toBe("allow");
    const aDecision = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      latestDecisionForSubjectKind(
        tx,
        domainA.orgId,
        signed.importerDomainId,
        FEDERATION_RESYNC_DECISION_KIND
      )
    );
    expect(aDecision?.verdict).toBe("allow");

    // RAIL 5 CLEARED: with the divergence resolved, reanchor no longer refuses (cursor now anchored
    // by the resync, so it is a no-op returning 0 — not a refusal).
    const afterResync = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      permitCursorReanchor(tx, domainB.orgId, asTrustDomainId(peerAIdInB))
    );
    expect(afterResync).toBe(0);
    const standing = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      latestDecisionForSubjectKind(
        tx,
        domainB.orgId,
        peerAIdInB,
        FEDERATION_DIVERGENCE_DECISION_KIND
      )
    );
    expect(standing?.verdict).toBe("allow"); // superseded the block
  });

  it("refuses a resync request whose signature is not the paired peer's (fail-closed 403)", async () => {
    const selfB = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      ensureFederationSelf(tx, domainB.orgId)
    );
    await expect(
      withTenantTx(domainA.db, domainA.orgId, (tx) =>
        authorizeResyncAndReExport(tx, domainA.orgId, {
          peer: selfB.domainId,
          requestSignature: "not-a-valid-signature"
        })
      )
    ).rejects.toMatchObject({
      status: 403,
      detail: expect.stringMatching(/signature verification failed/i)
    });
  });
});
