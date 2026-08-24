import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { asTrustDomainId } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import { createObject } from "../graph/objects-repo.js";
import { ensureInstanceKey } from "../governance/attestation.js";
import { ensureFederationSelf, type FederationSelf } from "./self-repo.js";
import { pairPeer, getPeerByIdOrName } from "./peers-repo.js";
import { exportSyncBundle, JournalDivergenceDetected } from "./export-repo.js";
import { importSyncBundle } from "./import-repo.js";
import { ownJournalTail } from "./journal-repo.js";
import { getCursor } from "./cursors-repo.js";
import {
  signResyncRequest,
  authorizeResyncAndReExport,
  applyResyncBundle
} from "./resync-repo.js";
import { createIsolatedDomain, type IsolatedDomain } from "./test-support/isolated-domain.js";

/**
 * §7.5 LOST-TAIL SIMULATION — the permanent gate that ties the divergence rails and resync together
 * end to end. A (exporter) loses its journal tail (a rolled-back async restore): its journal is
 * rewound below what B (a full-scope importer) has already applied. A real pull then RAIL-1-refuses
 * (a cursor cannot outrun the origin's tail), and the resync operation converges B back onto A's
 * restored reality. This is the flow §7.5 demands, exercised over two real databases.
 */
describe("§7.5 lost-tail simulation: a rolled-back exporter tail refuses a pull, and resync recovers", () => {
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
    domainA = await createIsolatedDomain("losttail-a");
    domainB = await createIsolatedDomain("losttail-b");
    selfA = await withTenantTx(domainA.db, domainA.orgId, (tx) => ensureFederationSelf(tx, domainA.orgId));
    await pair(domainA, domainB, "outpost");
    await pair(domainB, domainA, "commander");
    const peerA = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      getPeerByIdOrName(tx, domainB.orgId, selfA.domainId)
    );
    peerAIdInB = asTrustDomainId(peerA.id);
  }, 90_000);

  afterAll(async () => {
    await domainA.close();
    await domainB.close();
  });

  it("rewinds A's journal below B's cursor → RAIL 1 refuses the pull → resync converges B onto A's restored tail", async () => {
    // A produces a few entries; B imports all → B's cursor sits at A's full tail N.
    for (const name of ["lt-1", "lt-2", "lt-3"]) {
      await withTenantTx(domainA.db, domainA.orgId, (tx) =>
        createObject(tx, {
          orgId: domainA.orgId,
          domainId: null,
          typeId: "service",
          actorObjectId: domainA.orgId,
          requestId: `losttail-${name}`,
          name
        })
      );
    }
    const full = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      exportSyncBundle(tx, domainA.orgId, domainB.orgName)
    );
    await withTenantTx(domainB.db, domainB.orgId, (tx) => importSyncBundle(tx, domainB.orgId, full));
    const cursorBefore = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      getCursor(tx, domainB.orgId, peerAIdInB, peerAIdInB)
    );
    const tailN = await withTenantTx(domainA.db, domainA.orgId, (tx) => ownJournalTail(tx, domainA.orgId));
    expect(cursorBefore.sequence).toBe(tailN.sequence);

    // THE LOST TAIL: A's async replica was restored to an earlier point — rewind its journal below B's
    // cursor by deleting the last two entries. (A real restore rolls the whole DB back; deleting the
    // journal tail is the minimal, deterministic stand-in for "the exporter's tail is now behind".)
    const rewindTo = tailN.sequence - 2;
    // The journal is append-only for the runtime role, so rewind it over the DOMAIN's own superuser
    // connection — a faithful stand-in for a Postgres-level restore, which is what a lost tail is.
    const adminA = new pg.Client({ connectionString: domainA.adminUrl });
    await adminA.connect();
    try {
      await adminA.query(`DELETE FROM sync_journal WHERE org_id = $1 AND sequence > $2`, [
        domainA.orgId,
        rewindTo
      ]);
    } finally {
      await adminA.end();
    }
    const tailAfter = await withTenantTx(domainA.db, domainA.orgId, (tx) => ownJournalTail(tx, domainA.orgId));
    expect(tailAfter.sequence).toBe(rewindTo);

    // A normal forward pull now has sinceSequence (B's cursor, N) BEYOND A's rewound tail → RAIL 1.
    await expect(
      withTenantTx(domainA.db, domainA.orgId, (tx) =>
        exportSyncBundle(tx, domainA.orgId, domainB.orgName, cursorBefore.sequence)
      )
    ).rejects.toBeInstanceOf(JournalDivergenceDetected);

    // RESYNC recovers: B signs, A consents + re-exports from genesis (its restored journal), B force-
    // imports + resets its cursor to A's restored tail.
    const signed = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      signResyncRequest(tx, domainB.orgId, peerAIdInB)
    );
    const authorized = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      authorizeResyncAndReExport(tx, domainA.orgId, {
        peer: signed.importerDomainId,
        requestSignature: signed.requestSignature
      })
    );
    await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      applyResyncBundle(tx, domainB.orgId, peerAIdInB, authorized.bundle, authorized.exporterGeneration)
    );

    const cursorAfter = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      getCursor(tx, domainB.orgId, peerAIdInB, peerAIdInB)
    );
    // Converged: B's cursor now sits at A's CURRENT tail (the resync's own consent audit event
    // appended one entry on A, so A's live tail is just past the rewind point), NOT stranded ahead of
    // A as it was before (cursorBefore N > rewound tail). The point is B is no longer beyond A.
    const tailAfterResync = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      ownJournalTail(tx, domainA.orgId)
    );
    expect(cursorAfter.sequence).toBe(tailAfterResync.sequence);
    expect(cursorAfter.sequence).toBeLessThan(cursorBefore.sequence); // no longer stranded ahead

    // And a forward pull no longer refuses (the divergence is gone).
    await expect(
      withTenantTx(domainA.db, domainA.orgId, (tx) =>
        exportSyncBundle(tx, domainA.orgId, domainB.orgName, cursorAfter.sequence)
      )
    ).resolves.toBeDefined();
  });
});
