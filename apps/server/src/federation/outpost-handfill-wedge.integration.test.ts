import { randomUUID, generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { ScpApiError, ScpClient } from "@scp/sdk";
import { asTrustDomainId } from "@scp/schemas";
import {
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { objects, syncJournal } from "../db/schema.js";
import { initFederationSelf, ensureFederationSelf } from "./self-repo.js";
import { upsertObjectByUrn } from "../graph/objects-repo.js";

/**
 * M16.2 phase A, REVIEW ROUND 4 (H1) — THE FIFTH LOCAL WRITE DOOR, AND RECOVERY FROM THE WEDGE IT
 * COULD CREATE.
 *
 * `POST /v1/federation/hand-fill` sets `federationImport`, which made the peer-binding choke point in
 * `graph/objects-repo.ts` SKIP — so it bypassed all three clause-(4) refusals. Measured before the fix,
 * all HTTP 201: an UNPAIRED `peerDomainId`; a `commander`-role peer (whose tier `GET /federation/status`
 * then reported, the exact outcome the role check exists to prevent); and a SECOND live `outpost` object
 * for a peer that already had a legitimate one — after which the commander's own
 * `PATCH /v1/federation/outposts/{peer}` returned 409 FOREVER with no delete door anywhere in the API.
 *
 * This file pins BOTH halves, because closing a door is only half the job when the state it could reach
 * is unrecoverable:
 *   (A) the door — `assertHandFillableType` (handfill-repo.ts) restricts a hand-filled peer-bound object
 *       to this instance's OWN `federation_self.domainId`, the only shape a real replica has;
 *   (B) THE RECOVERY — `POST /v1/federation/outposts/{peer}/reconcile` fixes a database that is ALREADY
 *       wedged. Both recovery tests build the wedge at the REPO layer on purpose: the API can no longer
 *       produce it, and a test that only proves prevention would leave every already-wedged install
 *       needing SQL. `it("RECOVERY …")` is where that is proven.
 */
describe("M16.2 H1: the hand-fill write door + wedge recovery (Testcontainers)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let selfDomainId: string;

  async function expectApiError(
    call: Promise<unknown>,
    status: number,
    detail: RegExp
  ): Promise<void> {
    await call.then(
      () => {
        throw new Error(`expected the call to fail with HTTP ${status}, but it succeeded`);
      },
      (err: unknown) => {
        expect(err).toBeInstanceOf(ScpApiError);
        const apiError = err as ScpApiError;
        expect(apiError.status).toBe(status);
        expect(apiError.problem?.detail ?? "").toMatch(detail);
      }
    );
  }

  function publicKeyB64(): string {
    const { publicKey } = generateKeyPairSync("ed25519");
    return publicKey.export({ format: "der", type: "spki" }).toString("base64");
  }

  async function pairPeerViaApi(role: "outpost" | "commander" | "retrans"): Promise<string> {
    const domainId = randomUUID();
    await admin.federation.pair({
      domainId,
      name: `${role}-${domainId.slice(0, 8)}`,
      role,
      publicKey: publicKeyB64()
    });
    return domainId;
  }

  async function outpostRowsForPeer(peerDomainId: string) {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(objects)
        .where(
          and(
            eq(objects.orgId, org.orgId),
            eq(objects.typeId, "outpost"),
            isNull(objects.deletedAt)
          )
        )
        .then((rows) =>
          rows.filter(
            (row) => (row.properties as { peerDomainId?: string }).peerDomainId === peerDomainId
          )
        )
    );
  }

  /**
   * Plants the wedge the API can no longer produce: a live, FOREIGN-ORIGIN, `provenance:'manual'`
   * `outpost` object bound to `peerDomainId`. This is byte-for-byte the row `handFillObject` used to
   * write (same `federationImport` shape, `revision: 0`), created here through the repo because the route
   * now refuses it — which is precisely the state an install upgraded from an older build can hold.
   */
  async function plantShadow(peerDomainId: string, trustTier: string, urnSuffix: string) {
    return withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const { object } = await upsertObjectByUrn(tx, {
        orgId: org.orgId,
        typeId: "outpost",
        actorObjectId: org.orgId,
        requestId: `test-plant-${urnSuffix}`,
        urn: `urn:scp:${org.orgId}:outpost:shadow-${urnSuffix}`,
        name: `shadow-${urnSuffix}`,
        properties: { peerDomainId, trustTier },
        federationImport: {
          originDomainId: asTrustDomainId(peerDomainId),
          revision: 0,
          provenance: "manual"
        }
      });
      return object;
    });
  }

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "handfill-wedge");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      initFederationSelf(tx, {
        orgId: org.orgId,
        name: `commander-${randomUUID().slice(0, 8)}`,
        role: "commander"
      })
    );
    selfDomainId = (
      await withTenantTx(server.deps.db, org.orgId, (tx) => ensureFederationSelf(tx, org.orgId))
    ).domainId;
  }, 120_000);

  afterAll(async () => {
    await server?.close();
  });

  // -----------------------------------------------------------------------------------------
  // (A) THE DOOR — the three refusals hand-fill used to bypass, now reachable through it too.
  // -----------------------------------------------------------------------------------------

  it("hand-fill CANNOT plant an `outpost` object naming an UNPAIRED domain (was 201)", async () => {
    const commanderPeer = await pairPeerViaApi("commander");
    const unpaired = randomUUID();
    await expectApiError(
      admin.federation.handFill({
        peer: commanderPeer,
        typeId: "outpost",
        urn: `urn:scp:${org.orgId}:outpost:hand-unpaired`,
        name: "hand-unpaired",
        properties: { peerDomainId: unpaired, trustTier: "il5" }
      }),
      400,
      /must be this instance's own federation domain id/i
    );
    expect(await outpostRowsForPeer(unpaired)).toHaveLength(0);
  });

  it("hand-fill CANNOT plant an `outpost` object about a COMMANDER-role peer, so status cannot report its tier (was 201 + a reported trustTier)", async () => {
    const commanderPeer = await pairPeerViaApi("commander");
    await expectApiError(
      admin.federation.handFill({
        peer: commanderPeer,
        typeId: "outpost",
        urn: `urn:scp:${org.orgId}:outpost:hand-commander`,
        name: "hand-commander",
        properties: { peerDomainId: commanderPeer, trustTier: "il5" }
      }),
      400,
      /must be this instance's own federation domain id/i
    );
    const status = await admin.federation.status();
    const entry = status.peers.find((p) => p.peer.id === commanderPeer);
    expect(entry?.trustTier ?? null).toBeNull();
    expect(entry?.unknownFields ?? []).toContain("trustTier");
  });

  it("hand-fill CANNOT plant a SECOND `outpost` object for a peer that already has one — the 1:1 binding holds through this door too (was 201)", async () => {
    const outpostPeer = await pairPeerViaApi("outpost");
    const commanderPeer = await pairPeerViaApi("commander");
    const legit = await admin.federation.createOutpost({
      peerDomainId: outpostPeer,
      trustTier: "govcloud"
    });

    await expectApiError(
      admin.federation.handFill({
        peer: commanderPeer,
        typeId: "outpost",
        urn: `urn:scp:${org.orgId}:outpost:hand-duplicate`,
        name: "hand-duplicate",
        properties: { peerDomainId: outpostPeer, trustTier: "commercial" }
      }),
      400,
      /must be this instance's own federation domain id/i
    );

    // Still exactly one object, and the commander's own PATCH still works — the wedge never forms.
    expect(await outpostRowsForPeer(outpostPeer)).toHaveLength(1);
    const patched = await admin.federation.updateOutpost(outpostPeer, { trustTier: "il5" });
    expect(patched.objectId).toBe(legit.objectId);
    expect(patched.trustTier).toBe("il5");
  });

  it("hand-fill STILL WORKS for the legitimate replica shape (own domain id) and for every non-peer-bound type", async () => {
    const commanderPeer = await pairPeerViaApi("commander");
    // The OUTPOST-side use the skip's justification was actually about: the arriving replica names the
    // RECEIVING instance's own domain. Narrowing the door must not break it.
    const replica = await admin.federation.handFill({
      peer: commanderPeer,
      typeId: "outpost",
      urn: `urn:scp:${org.orgId}:outpost:own-replica`,
      name: "own-replica",
      properties: { peerDomainId: selfDomainId, trustTier: "airgap" }
    });
    expect(replica.provenance).toBe("manual");
    expect(replica.originDomainId).toBe(commanderPeer);

    // And an ordinary type is untouched by the narrowing (the guard is peer-bound types only).
    const ordinary = await admin.federation.handFill({
      peer: commanderPeer,
      typeId: "service",
      urn: `urn:scp:${org.orgId}:service:hand-ordinary`,
      name: "hand-ordinary",
      properties: {}
    });
    expect(ordinary.provenance).toBe("manual");
  });

  // -----------------------------------------------------------------------------------------
  // (B) THE AMPLIFIERS — deterministic resolution, and authority over last-write-wins.
  // -----------------------------------------------------------------------------------------

  it("with an OLDER duplicate present, GET/PATCH resolve to the LOCAL-ORIGIN row — authority, not row order (was an ORDER-BY-less LIMIT 1)", async () => {
    const peer = await pairPeerViaApi("outpost");
    const legit = await admin.federation.createOutpost({ peerDomainId: peer, trustTier: "il5" });
    const shadow = await plantShadow(peer, "commercial", `det-${peer.slice(0, 8)}`);
    // BACKDATED ON PURPOSE, and this is what makes the test non-vacuous: with the shadow merely created
    // LATER, plain `(created_at, id)` ordering would already put the local row first, so the test would
    // pass even with the authority ranking removed (proved by mutation). Backdating makes the shadow the
    // FIRST row in every naive ordering, so only a real local-origin-first preference can pass.
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(objects)
        .set({ createdAt: new Date(Date.now() - 86_400_000) })
        .where(eq(objects.id, shadow.id))
    );
    expect(await outpostRowsForPeer(peer)).toHaveLength(2);

    // Ten reads in a row all land on the same, LOCAL row — not on the foreign-origin copy (which used
    // to produce a 409 "read-only replica" from GET's own resolution).
    for (let i = 0; i < 10; i += 1) {
      const got = await admin.federation.getOutpost(peer);
      expect(got.objectId).toBe(legit.objectId);
      expect(got.originIsSelf).toBe(true);
      expect(got.provenance ?? null).toBeNull();
    }
    // And the PATCH the wedge used to make permanently impossible now succeeds.
    const patched = await admin.federation.updateOutpost(peer, { trustTier: "govcloud" });
    expect(patched.objectId).toBe(legit.objectId);
    expect(patched.trustTier).toBe("govcloud");
  });

  /**
   * N7 (review round 5) — AN ORDER-INDEPENDENT WITNESS FOR THE STATUS RANKING.
   *
   * The previous version of this test built ONE arrangement (shadow created LATER) and so pinned the
   * ORDER, not the ranking: the lens showed it stayed GREEN with `status-repo.ts`'s `tierRank`
   * collapsed to a constant AND `current.rank <= rank` flipped to `<`. Round 2 had already hardened
   * the sibling RESOLUTION test after the same catch.
   *
   * Backdating alone does NOT fix it, and that is worth stating: with all ranks equal, `<=` is
   * first-wins and `<` is last-wins, so ANY SINGLE arrangement is beaten by one of the two
   * degradations. Only building BOTH arrangements makes the assertion order-independent —
   * `il5` must win whether the shadow is the FIRST row or the LAST one in `(created_at, id)` order,
   * which no tie-break rule can deliver and only a real local-origin-first preference can.
   */
  it("a manual shadow can NEVER override the commander's own asserted tier on /federation/status, whichever row comes first (was last-write-wins)", async () => {
    // (a) shadow LAST in `(created_at, id)` order — the original wedge shape.
    const later = await pairPeerViaApi("outpost");
    await admin.federation.createOutpost({ peerDomainId: later, trustTier: "il5" });
    await plantShadow(later, "commercial", `status-later-${later.slice(0, 8)}`);

    // (b) shadow FIRST — backdated a day, so every naive ordering puts the hand-typed copy ahead of
    // the commander's own object.
    const earlier = await pairPeerViaApi("outpost");
    await admin.federation.createOutpost({ peerDomainId: earlier, trustTier: "il5" });
    const backdated = await plantShadow(
      earlier,
      "commercial",
      `status-earlier-${earlier.slice(0, 8)}`
    );
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(objects)
        .set({ createdAt: new Date(Date.now() - 86_400_000) })
        .where(eq(objects.id, backdated.id))
    );

    const status = await admin.federation.status();
    for (const peer of [later, earlier]) {
      const entry = status.peers.find((p) => p.peer.id === peer);
      expect(entry?.trustTier, `peer ${peer} reported the shadow's tier`).toBe("il5");
      expect(entry?.trustTierProvenance).toBe("declared");
      expect(entry?.unknownFields ?? []).not.toContain("trustTier");
    }
  });

  it("N4: a local-origin row that asserts NO tier SILENCES the field — a shadow's tier cannot fill the commander's silence, and the two read surfaces agree", async () => {
    const peer = await pairPeerViaApi("outpost");
    // The commander's own object, DELIBERATELY tier-less: the operator has not decided a posture.
    const legit = await admin.federation.createOutpost({ peerDomainId: peer });
    expect(legit.trustTier).toBeNull();
    // A hand-typed shadow that DOES carry a tier. Before the fix, `status-repo.ts` dropped tier-less
    // rows BEFORE ranking, so the authority never entered the contest and this `il5` was rendered on
    // the Overview as the commander's own posture.
    await plantShadow(peer, "il5", `silence-${peer.slice(0, 8)}`);

    const status = await admin.federation.status();
    const entry = status.peers.find((p) => p.peer.id === peer);
    expect(entry?.trustTier ?? null).toBeNull();
    expect(entry?.trustTierProvenance ?? null).toBeNull();
    expect(entry?.unknownFields ?? []).toContain("trustTier");

    // THE AGREEMENT, asserted directly: the two new read surfaces are the same question asked twice,
    // and a UI that reads one and renders the other must not see two different answers.
    const object = await admin.federation.getOutpost(peer);
    expect(object.objectId).toBe(legit.objectId);
    expect(object.originIsSelf).toBe(true);
    expect(object.trustTier).toBe(entry?.trustTier ?? null);
    expect(object.unknownFields).toContain("trustTier");
  });

  it("when the ONLY tier available is an unverified shadow, it is reported as `unverified` AND declared unknown", async () => {
    const peer = await pairPeerViaApi("outpost");
    await plantShadow(peer, "commercial", `unverified-${peer.slice(0, 8)}`);

    const status = await admin.federation.status();
    const entry = status.peers.find((p) => p.peer.id === peer);
    // The value rides the wire for shape stability, and is declared NOT an observation — so phase B
    // cannot render a hand-typed claim as a commander assertion.
    expect(entry?.trustTier).toBe("commercial");
    expect(entry?.trustTierProvenance).toBe("unverified");
    expect(entry?.unknownFields ?? []).toContain("trustTier");

    const listed = (await admin.federation.listOutposts()).filter((c) => c.peerDomainId === peer);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.provenance).toBe("manual");
    expect(listed[0]?.originIsSelf).toBe(false);
    expect(listed[0]?.unknownFields).toContain("trustTier");
  });

  // -----------------------------------------------------------------------------------------
  // (C) RECOVERY — from the wedged state, not merely prevention of it.
  // -----------------------------------------------------------------------------------------

  it("RECOVERY (wedged: local + shadow): reconcile REMOVES the shadow and the peer is manageable again", async () => {
    const peer = await pairPeerViaApi("outpost");
    const legit = await admin.federation.createOutpost({ peerDomainId: peer, trustTier: "il5" });
    const shadow = await plantShadow(peer, "commercial", `rec-a-${peer.slice(0, 8)}`);
    expect(await outpostRowsForPeer(peer)).toHaveLength(2);

    const result = await admin.federation.reconcileOutpost(peer);
    expect(result.config.objectId).toBe(legit.objectId);
    expect(result.adoptedObjectId).toBeNull();
    expect(result.removedShadowObjectIds).toEqual([shadow.id]);
    expect(result.removedLocalObjectIds).toEqual([]);

    // The binding is 1:1 again, the surviving row is the commander's own, and — the whole point — a
    // FRESH declaration for this peer is possible again where it used to 409 forever.
    expect(await outpostRowsForPeer(peer)).toHaveLength(1);
    const patched = await admin.federation.updateOutpost(peer, { trustTier: "airgap" });
    expect(patched.objectId).toBe(legit.objectId);
    expect(patched.trustTier).toBe("airgap");
  });

  it("RECOVERY (wedged: shadow only, no local object): reconcile ADOPTS the shadow, which then journals and PATCHes like any commander-origin object", async () => {
    const peer = await pairPeerViaApi("outpost");
    const shadow = await plantShadow(peer, "commercial", `rec-b-${peer.slice(0, 8)}`);

    // THE WEDGE, measured: POST is refused by the 1:1 guard and PATCH is refused as a replica, so
    // before this fix the peer's config could never be managed through the API again.
    await expectApiError(
      admin.federation.createOutpost({ peerDomainId: peer, trustTier: "il5" }),
      409,
      /already has an outpost config object/i
    );
    await expectApiError(
      admin.federation.updateOutpost(peer, { trustTier: "il5" }),
      409,
      /read-only replica/i
    );

    const journalBefore = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select({ id: syncJournal.id }).from(syncJournal).where(eq(syncJournal.orgId, org.orgId))
    );

    const result = await admin.federation.reconcileOutpost(peer);
    expect(result.adoptedObjectId).toBe(shadow.id);
    expect(result.removedShadowObjectIds).toEqual([]);
    expect(result.removedLocalObjectIds).toEqual([]);
    expect(result.config.originIsSelf).toBe(true);
    expect(result.config.provenance ?? null).toBeNull();
    // Adoption makes it LOCALLY AUTHORED, so it must now ride the journal down to the outpost — an
    // adopted row that never journals would be config the outpost can never receive.
    const journalAfter = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select({ id: syncJournal.id }).from(syncJournal).where(eq(syncJournal.orgId, org.orgId))
    );
    expect(journalAfter.length).toBeGreaterThan(journalBefore.length);

    // RECOVERED: the ordinary write verbs work again.
    const patched = await admin.federation.updateOutpost(peer, { trustTier: "govcloud" });
    expect(patched.objectId).toBe(shadow.id);
    expect(patched.trustTier).toBe("govcloud");
    expect(patched.unknownFields).toEqual([]);
  });

  it("reconcile REFUSES to touch a signature-verified replica — trading this wedge for a sync wedge is not a recovery", async () => {
    const peer = await pairPeerViaApi("outpost");
    await admin.federation.createOutpost({ peerDomainId: peer, trustTier: "il5" });
    // A VERIFIED foreign-origin row (provenance NULL — what a real import writes) claiming the same peer.
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      upsertObjectByUrn(tx, {
        orgId: org.orgId,
        typeId: "outpost",
        actorObjectId: org.orgId,
        requestId: "test-verified-clash",
        urn: `urn:scp:${org.orgId}:outpost:verified-${peer.slice(0, 8)}`,
        name: "verified-clash",
        properties: { peerDomainId: peer },
        federationImport: { originDomainId: asTrustDomainId(peer), revision: 7, provenance: null }
      })
    );

    // 409 CONFLICT, NOT 404 (review round 5, N3). The peer demonstrably HAS config — the GET below
    // answers 200 at the same instant — so 404 was an acknowledged wrong code that told a
    // status-keyed consumer "no outpost config" and HID the authority conflict on the very door H1
    // added for recovery. The status is pinned here, not just the prose, because a UI keys on it.
    await expectApiError(
      admin.federation.reconcileOutpost(peer),
      409,
      /signature-verified replicas this domain did not author/i
    );
    // …and the refusal must name a verb the API ACTUALLY OFFERS (N9). It used to say "resolve the
    // authority conflict at its source" — advice, not an action, on the one door whose job is to BE
    // the action. It now names `?keep=` and the id to pass.
    await admin.federation.reconcileOutpost(peer).then(
      () => {
        throw new Error("expected a refusal");
      },
      (err: unknown) => {
        expect((err as ScpApiError).problem?.detail ?? "").toMatch(/\?keep=/);
      }
    );
    // THE CONTRADICTION THAT MAKES 404 WRONG, asserted rather than argued.
    const stillReadable = await admin.federation.getOutpost(peer);
    expect(stillReadable.peerDomainId).toBe(peer);
    // Nothing removed: both rows survive, and the refusal says why.
    expect(await outpostRowsForPeer(peer)).toHaveLength(2);
  });

  /**
   * N9 (review round 5) — CLOSING THE VERIFIED-DUPLICATE CLASS WHILE THE SURFACE IS UNSHIPPED.
   *
   * A VERIFIED foreign-origin duplicate bound to one peer had NO public-API recovery: `PATCH` 409s
   * (the binding scan's `blocking` filter exempts only `provenance='manual'`), the default reconcile
   * refuses by design, `DELETE /api/v1/objects/outpost/{id}` is 403 by this milestone's own refusal,
   * and IaC prune only touches stack-managed objects. NOT reachable today — in canonical hub-and-spoke
   * no bundle a commander imports carries an `outpost` row bound to one of ITS peers — but reachable
   * the moment two authoring domains describe one outpost (a sub-commander, or a dual-homed outpost).
   * `?keep=` closes the class the only way that is safe: THIS DOMAIN DELETES THE ROW IT AUTHORED,
   * which is an ordinary journaled tombstone and re-declarable. The refusal to delete a
   * signature-verified replica is unchanged — the second test below is what keeps that half honest.
   */
  it("N9 RECOVERY (verified duplicate): ?keep=<verified> drops the row THIS domain authored and restores the 1:1 binding", async () => {
    const peer = await pairPeerViaApi("outpost");
    const local = await admin.federation.createOutpost({ peerDomainId: peer, trustTier: "il5" });
    const verified = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      upsertObjectByUrn(tx, {
        orgId: org.orgId,
        typeId: "outpost",
        actorObjectId: org.orgId,
        requestId: `test-verified-keep-${peer.slice(0, 8)}`,
        urn: `urn:scp:${org.orgId}:outpost:verified-keep-${peer.slice(0, 8)}`,
        name: "verified-keep",
        properties: { peerDomainId: peer, trustTier: "govcloud" },
        federationImport: { originDomainId: asTrustDomainId(peer), revision: 7, provenance: null }
      })
    );
    expect(await outpostRowsForPeer(peer)).toHaveLength(2);

    // Deleting a locally authored row JOURNALS — it is an ordinary tombstone, not the silent local
    // cleanup a shadow removal is (this domain never authored a shadow, so claiming authorship of
    // its deletion would push a delete for a row the real authority still owns).
    const journalBefore = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select({ id: syncJournal.id }).from(syncJournal).where(eq(syncJournal.orgId, org.orgId))
    );

    const result = await admin.federation.reconcileOutpost(peer, {
      keep: verified.object.id
    });
    expect(result.config.objectId).toBe(verified.object.id);
    expect(result.config.originIsSelf).toBe(false);
    expect(result.adoptedObjectId).toBeNull();
    expect(result.removedShadowObjectIds).toEqual([]);
    expect(result.removedLocalObjectIds).toEqual([local.objectId]);

    const journalAfter = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select({ id: syncJournal.id }).from(syncJournal).where(eq(syncJournal.orgId, org.orgId))
    );
    expect(journalAfter.length).toBeGreaterThan(journalBefore.length);

    // THE CLASS IS CLOSED: exactly one row again, and the peer resolves deterministically to it.
    expect(await outpostRowsForPeer(peer)).toHaveLength(1);
    const got = await admin.federation.getOutpost(peer);
    expect(got.objectId).toBe(verified.object.id);
    // The surviving row is a REPLICA, so a local write is still (correctly) refused — that is the
    // single-writer rule, not a wedge: the binding is 1:1 and the state is honest.
    await expectApiError(
      admin.federation.updateOutpost(peer, { trustTier: "airgap" }),
      409,
      /read-only replica/i
    );
  });

  it("N9: ?keep= NEVER deletes a signature-verified replica — the escape does not become a sync wedge", async () => {
    const peer = await pairPeerViaApi("outpost");
    const local = await admin.federation.createOutpost({ peerDomainId: peer, trustTier: "il5" });
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      upsertObjectByUrn(tx, {
        orgId: org.orgId,
        typeId: "outpost",
        actorObjectId: org.orgId,
        requestId: `test-verified-nodelete-${peer.slice(0, 8)}`,
        urn: `urn:scp:${org.orgId}:outpost:verified-nodelete-${peer.slice(0, 8)}`,
        name: "verified-nodelete",
        properties: { peerDomainId: peer },
        federationImport: { originDomainId: asTrustDomainId(peer), revision: 7, provenance: null }
      })
    );

    // Asking to keep the LOCAL row is asking to delete the verified replica. Refused — deleting one
    // would make the next real import a single-writer violation and wedge that peer's sync.
    await expectApiError(
      admin.federation.reconcileOutpost(peer, { keep: local.objectId }),
      409,
      /signature-verified replicas this domain did not author/i
    );
    expect(await outpostRowsForPeer(peer)).toHaveLength(2);
  });

  it("N9: ?keep= naming a row that is not one of the peer's live claimants is a 400, not a silent fallback", async () => {
    const peer = await pairPeerViaApi("outpost");
    await admin.federation.createOutpost({ peerDomainId: peer, trustTier: "il5" });
    const otherPeer = await pairPeerViaApi("outpost");
    const other = await admin.federation.createOutpost({ peerDomainId: otherPeer });

    // Silently ignoring an unrecognised `keep` would be the worst outcome: the operator asked for one
    // survivor and got a different one, with a 200.
    await expectApiError(
      admin.federation.reconcileOutpost(peer, { keep: other.objectId }),
      400,
      /is not one of the live outpost config objects bound to peer/i
    );
    expect(await outpostRowsForPeer(peer)).toHaveLength(1);
    expect(await outpostRowsForPeer(otherPeer)).toHaveLength(1);
  });

  it("reconcile on a peer with no config object at all is a 404 — the ONE branch where the resource really is absent", async () => {
    const peer = await pairPeerViaApi("outpost");
    await expectApiError(
      admin.federation.reconcileOutpost(peer),
      404,
      /no outpost config object to reconcile/i
    );
    // Pinned as the counterpart to the 409 above: the two refusals must not collapse onto one code,
    // or a consumer can no longer tell "this peer has nothing" from "this peer has too much".
    await expectApiError(admin.federation.getOutpost(peer), 404, /has no outpost config object/i);
  });
});
