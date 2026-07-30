import { randomUUID, generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { asTrustDomainId, type TrustDomainId } from "@scp/schemas";
import {
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { bundleTransfers, syncCursors } from "../db/schema.js";
import { initFederationSelf } from "./self-repo.js";
import { pairPeer } from "./peers-repo.js";
import {
  recordBundleTransfer,
  lastConfirmedSyncImportAt,
  lastSyncExportForPeer
} from "./bundle-transfers-repo.js";
import { getFederationStatus } from "./status-repo.js";

/**
 * M16.2 phase A, REVIEW ROUND 4 — THE STATUS ROW'S REMAINING HONESTY DEFECTS (H3, H4, H9a).
 *
 * Each case below is a MEASURED wrong answer from the previous revision, pinned so it cannot come back:
 *
 *   H3 — `lastSyncedBundleChecksum` (documented as "the last CONFIRMED INBOUND **sync** bundle") and
 *        `lastSyncedAt` were read off `listRecentTransfers(...).find(t => t.status === 'confirmed')`:
 *        ANY direction, ANY kind, last 5 rows. Inserting the exact row `promotion-repo.ts` writes on an
 *        accepted promotion (import/promotion/confirmed) made the field report that PROMOTION checksum —
 *        and removed `lastSyncedBundleChecksum` from `unknownFields` — for a peer no sync bundle had ever
 *        arrived from.
 *   H4 — `connectivity` overclaimed in BOTH positive branches: a peer with an `http://` baseUrl AND a
 *        deliveryTarget read `air-gap` (a configured, dialable-in-principle topology labelled air-gapped),
 *        and an https peer read `connected` even having never been reached. The field is now
 *        `transportMode` and says only what CONFIG says.
 *   H9a — `lastSyncExportForPeer` ordered by `through_sequence DESC`, and Postgres DESC is NULLS FIRST,
 *        so one export row with a NULL `through_sequence` would sort first and make the code report
 *        "never exported" FOREVER. Not reachable through `export-repo.ts` today, which is exactly when a
 *        trap is cheap to disarm — so the trap is exercised directly.
 */
describe("M16.2 review round 4: federation status honesty (Testcontainers)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;

  function publicKeyB64(): string {
    const { publicKey } = generateKeyPairSync("ed25519");
    return publicKey.export({ format: "der", type: "spki" }).toString("base64");
  }

  async function pairFresh(input: {
    baseUrl?: string;
    deliveryTarget?: Record<string, unknown>;
  }): Promise<TrustDomainId> {
    const domainId = asTrustDomainId(randomUUID());
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      pairPeer(tx, {
        orgId: org.orgId,
        domainId,
        name: `peer-${domainId.slice(0, 8)}`,
        role: "outpost",
        publicKey: publicKeyB64(),
        ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
        ...(input.deliveryTarget !== undefined
          ? { deliveryTarget: input.deliveryTarget as never }
          : {})
      })
    );
    return domainId;
  }

  async function statusFor(peerDomainId: string) {
    const status = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      getFederationStatus(tx, org.orgId)
    );
    return status.peers.find((p) => p.peer.id === peerDomainId);
  }

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "status-honesty");
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      initFederationSelf(tx, {
        orgId: org.orgId,
        name: `commander-${randomUUID().slice(0, 8)}`,
        role: "commander"
      })
    );
  }, 120_000);

  afterAll(async () => {
    await server?.close();
  });

  // ---------------------------------------------------------------------------------------
  // H3 — the "as of ⟨bundle⟩" identifier names a SYNC IMPORT, or nothing.
  // ---------------------------------------------------------------------------------------

  it("H3: a confirmed import/PROMOTION row does NOT become the 'as of ⟨bundle⟩' identifier", async () => {
    const peer = await pairFresh({ baseUrl: "https://p.example.test" });
    // Byte-for-byte the row `promotion-repo.ts` writes when a promotion bundle is accepted.
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      recordBundleTransfer(tx, {
        orgId: org.orgId,
        peerDomainId: peer,
        direction: "import",
        kind: "promotion",
        status: "confirmed",
        checksum: "promotion-checksum-that-must-not-leak-into-the-sync-label"
      })
    );

    const entry = await statusFor(peer);
    expect(entry?.lastSyncedBundleChecksum ?? null).toBeNull();
    expect(entry?.lastSyncedAt ?? null).toBeNull();
    // …and the honest-unknown declaration is still made, so a UI renders "unknown" rather than a name.
    expect(entry?.unknownFields ?? []).toContain("lastSyncedBundleChecksum");
  });

  it("H3: a confirmed import/SYNC row DOES, and the timestamp comes off the SAME row", async () => {
    const peer = await pairFresh({ baseUrl: "https://p.example.test" });
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      recordBundleTransfer(tx, {
        orgId: org.orgId,
        peerDomainId: peer,
        direction: "import",
        kind: "promotion",
        status: "confirmed",
        checksum: "promotion-noise"
      })
    );
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      recordBundleTransfer(tx, {
        orgId: org.orgId,
        peerDomainId: peer,
        direction: "import",
        kind: "sync",
        status: "confirmed",
        checksum: "the-real-sync-bundle"
      })
    );

    const entry = await statusFor(peer);
    expect(entry?.lastSyncedBundleChecksum).toBe("the-real-sync-bundle");
    expect(entry?.lastSyncedAt).not.toBeNull();
    expect(entry?.unknownFields ?? []).not.toContain("lastSyncedBundleChecksum");
  });

  it("H3: an EXPORT/sync row is not an inbound anchor either — direction is part of the predicate", async () => {
    const peer = await pairFresh({ baseUrl: "https://p.example.test" });
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      recordBundleTransfer(tx, {
        orgId: org.orgId,
        peerDomainId: peer,
        direction: "export",
        kind: "sync",
        status: "confirmed",
        checksum: "outbound-not-inbound",
        throughSequence: 3
      })
    );
    const entry = await statusFor(peer);
    expect(entry?.lastSyncedBundleChecksum ?? null).toBeNull();
    // The EXPORT side of the same ledger is reported separately and correctly — the two never merge.
    expect(entry?.lastExportedBundleChecksum).toBe("outbound-not-inbound");
  });

  // ---------------------------------------------------------------------------------------
  // H4 — `transportMode` describes CONFIG, and says nothing about reachability.
  // ---------------------------------------------------------------------------------------

  it("H4: an http baseUrl PLUS a deliveryTarget is NOT reported as air-gap — it is declared unknown", async () => {
    const peer = await pairFresh({
      baseUrl: "http://insecure.example.test",
      deliveryTarget: { provider: "filesystem", outDir: "/tmp/out", inDir: "/tmp/in" }
    });
    const entry = await statusFor(peer);
    // A configured, non-air-gapped topology must never be relabelled air-gapped just because
    // federation refuses to dial its URL. That is a contradiction to surface, not a posture to infer.
    expect(entry?.transportMode ?? null).toBeNull();
    expect(entry?.unknownFields ?? []).toContain("transportMode");
  });

  it("H4: an https peer reads `dialable` — a CONFIG statement — while the reachability fields stay honest", async () => {
    const peer = await pairFresh({ baseUrl: "https://never-reached.example.test" });
    const entry = await statusFor(peer);
    expect(entry?.transportMode).toBe("dialable");
    // The peer has NEVER been reached, and every field that measures that says so. `dialable` is not
    // contradicted by them because it never claimed reachability in the first place.
    expect(entry?.lastPullAttemptAt ?? null).toBeNull();
    expect(entry?.lastPullSuccessAt ?? null).toBeNull();
    expect(entry?.effectiveCadence).toBe("poll");
  });

  it("H4: a peer with NO baseUrl and a deliveryTarget is the real air-gap shape", async () => {
    const peer = await pairFresh({
      deliveryTarget: { provider: "filesystem", outDir: "/tmp/out", inDir: "/tmp/in" }
    });
    const entry = await statusFor(peer);
    expect(entry?.transportMode).toBe("air-gap");
    expect(entry?.unknownFields ?? []).not.toContain("transportMode");
  });

  // ---------------------------------------------------------------------------------------
  // H9a — DESC is NULLS FIRST in Postgres.
  // ---------------------------------------------------------------------------------------

  it("H9a: one export row with a NULL through_sequence does not make the peer read 'never exported'", async () => {
    const peer = await pairFresh({ baseUrl: "https://p.example.test" });
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      recordBundleTransfer(tx, {
        orgId: org.orgId,
        peerDomainId: peer,
        direction: "export",
        kind: "sync",
        status: "created",
        throughSequence: 12,
        checksum: "real-export"
      })
    );
    // The trap: a sync-export row with no `through_sequence`. Unreachable through `export-repo.ts`
    // today — inserted directly, because the point is that the ORDERING must not depend on that.
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      recordBundleTransfer(tx, {
        orgId: org.orgId,
        peerDomainId: peer,
        direction: "export",
        kind: "sync",
        status: "created",
        throughSequence: null,
        checksum: "null-sequence-row"
      })
    );

    const found = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      lastSyncExportForPeer(tx, org.orgId, peer)
    );
    // With `DESC` alone (NULLS FIRST) the null row sorted first and the helper returned `null` — the
    // commander would have said "never exported" forever despite a real export.
    expect(found?.throughSequence).toBe(12);
    expect(found?.checksum).toBe("real-export");

    const entry = await statusFor(peer);
    expect(entry?.lastExportedThroughSequence).toBe(12);
    expect(entry?.unknownFields ?? []).not.toContain("lastExportedThroughSequence");
  });

  // ---------------------------------------------------------------------------------------
  // N8 (review round 5) — THE SAME TRAP, IN THE HELPER H3 NOW MAKES TWO FIELDS DEPEND ON.
  // ---------------------------------------------------------------------------------------

  it("N8: one confirmed import/sync row with a NULL confirmed_at does not make the peer read 'never synced'", async () => {
    const peer = await pairFresh({ baseUrl: "https://p.example.test" });
    // A genuine, correctly-stamped confirmed sync import.
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      recordBundleTransfer(tx, {
        orgId: org.orgId,
        peerDomainId: peer,
        direction: "import",
        kind: "sync",
        status: "confirmed",
        checksum: "the-real-sync-bundle",
        transport: "bundle"
      })
    );
    // The trap: a row matching the SAME predicate whose `confirmed_at` is NULL. Postgres `DESC` is
    // NULLS FIRST, so it sorted ahead of the real row and the `!row?.confirmedAt` bail below made
    // BOTH `lastSyncedAt` and `lastSyncedBundleChecksum` read null — "never synced" and "bundle
    // unknown" over a real sync. `recordBundleTransfer` cannot write this shape (it stamps
    // `confirmed_at` whenever status is confirmed), so it is inserted directly — exactly as H9a's
    // own test does, and for the same reason: an unreachable trap is the cheapest kind to disarm,
    // and H3 has just made two more fields depend on this ordering.
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.insert(bundleTransfers).values({
        id: randomUUID(),
        orgId: org.orgId,
        peerDomainId: peer,
        direction: "import",
        kind: "sync",
        status: "confirmed",
        sinceSequence: null,
        throughSequence: null,
        checksum: "null-confirmed-at-row",
        transport: null,
        confirmedAt: null
      })
    );

    const found = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      lastConfirmedSyncImportAt(tx, org.orgId, peer)
    );
    expect(found?.checksum).toBe("the-real-sync-bundle");
    expect(found?.at).toBeInstanceOf(Date);

    const entry = await statusFor(peer);
    expect(entry?.lastSyncedAt ?? null).not.toBeNull();
    expect(entry?.lastSyncedBundleChecksum).toBe("the-real-sync-bundle");
    expect(entry?.unknownFields ?? []).not.toContain("lastSyncedBundleChecksum");
  });

  it("nothing here disturbs the honest-null case: a bare peer declares every unobservable field", async () => {
    const peer = await pairFresh({});
    const entry = await statusFor(peer);
    expect(entry?.transportMode ?? null).toBeNull();
    expect(entry?.trustTier ?? null).toBeNull();
    expect(entry?.trustTierProvenance ?? null).toBeNull();
    for (const name of [
      "trustTier",
      "transportMode",
      "lastSyncedBundleChecksum",
      "lastExportedThroughSequence",
      "lastExportedBundleChecksum",
      "pendingExportEntryCount",
      "healthRollup",
      "appliedAtPeer"
    ]) {
      expect(entry?.unknownFields ?? []).toContain(name);
    }
    // Sanity: the fixtures above never leaked into this peer's ledger or cursor.
    const ledger = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ id: bundleTransfers.id })
        .from(bundleTransfers)
        .where(and(eq(bundleTransfers.orgId, org.orgId), eq(bundleTransfers.peerDomainId, peer)))
    );
    expect(ledger).toHaveLength(0);
    const cursors = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ seq: syncCursors.lastAppliedSeq })
        .from(syncCursors)
        .where(and(eq(syncCursors.orgId, org.orgId), eq(syncCursors.peerDomainId, peer)))
    );
    expect(cursors).toHaveLength(0);
  });
});
