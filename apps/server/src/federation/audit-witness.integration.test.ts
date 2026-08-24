import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asTrustDomainId, type TrustDomainId } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import { createObject } from "../graph/objects-repo.js";
import { ensureInstanceKey } from "../governance/attestation.js";
import { ensureFederationSelf, type FederationSelf } from "./self-repo.js";
import { pairPeer } from "./peers-repo.js";
import { exportSyncBundle } from "./export-repo.js";
import { importSyncBundle } from "./import-repo.js";
import { listAuditWitnessesForOrigin } from "./audit-witness-repo.js";
import { createIsolatedDomain, type IsolatedDomain } from "./test-support/isolated-domain.js";

/**
 * FEDERATION AUDIT WITNESS (§7.2.7). A full-scope receiver, importing a peer's sync bundle, must
 * persist a passive witness of that peer's audit-chain head from the `audit_segment` entries it used
 * to discard — WITHOUT the witness ever blocking the import. This is what lets the post-failover
 * runbook detect a truncation `scp audit verify` alone cannot see.
 */
describe("federation audit witness: import persists a peer's audit-chain head, never blocking", () => {
  let domainA: IsolatedDomain;
  let domainB: IsolatedDomain;
  let selfA: FederationSelf;
  let originA: TrustDomainId;

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
    domainA = await createIsolatedDomain("witness-a");
    domainB = await createIsolatedDomain("witness-b");
    selfA = await withTenantTx(domainA.db, domainA.orgId, (tx) => ensureFederationSelf(tx, domainA.orgId));
    originA = asTrustDomainId(selfA.domainId);
    await pair(domainA, domainB, "outpost");
    await pair(domainB, domainA, "commander");
    // Audited actions on A → each writes an audit_segment journal entry (non-domain-local subject).
    for (const name of ["w-svc-1", "w-svc-2"]) {
      await withTenantTx(domainA.db, domainA.orgId, (tx) =>
        createObject(tx, {
          orgId: domainA.orgId,
          domainId: null,
          typeId: "service",
          actorObjectId: domainA.orgId,
          requestId: `witness-${name}`,
          name
        })
      );
    }
  }, 90_000);

  afterAll(async () => {
    await domainA.close();
    await domainB.close();
  });

  it("a full-scope import persists witnesses of A's audit-chain head, and does NOT block the import", async () => {
    const bundle = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      exportSyncBundle(tx, domainA.orgId, domainB.orgName)
    );
    const result = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      importSyncBundle(tx, domainB.orgId, bundle)
    );
    // The witness is enrichment — the import still applies its real entries.
    expect(result.appliedEntries).toBeGreaterThan(0);

    const witnesses = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      listAuditWitnessesForOrigin(tx, domainB.orgId, originA)
    );
    expect(witnesses.length).toBeGreaterThan(0);
    // Every witness names A as the origin, carries a real auditEventId + content hash, in chain order.
    for (const w of witnesses) {
      expect(w.originDomainId).toBe(selfA.domainId);
      expect(w.auditEventId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(w.contentHash.length).toBeGreaterThan(0);
    }
    const sequences = witnesses.map((w) => w.sequence);
    expect([...sequences]).toEqual([...sequences].sort((x, y) => x - y));
  });

  it("re-importing the same bundle does not double-record witnesses (idempotent by origin+sequence)", async () => {
    const before = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      listAuditWitnessesForOrigin(tx, domainB.orgId, originA)
    );
    const bundle = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      exportSyncBundle(tx, domainA.orgId, domainB.orgName)
    );
    await withTenantTx(domainB.db, domainB.orgId, (tx) => importSyncBundle(tx, domainB.orgId, bundle));
    const after = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      listAuditWitnessesForOrigin(tx, domainB.orgId, originA)
    );
    expect(after.length).toBe(before.length);
  });
});
