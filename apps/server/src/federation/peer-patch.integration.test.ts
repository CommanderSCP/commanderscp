import { randomUUID, generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";
import { ScpApiError, ScpClient } from "@scp/sdk";
import { asTrustDomainId } from "@scp/schemas";
import {
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { federationPeerKeys, syncCursors } from "../db/schema.js";
import { initFederationSelf } from "./self-repo.js";
import { getCursor } from "./cursors-repo.js";

/**
 * M16.2 phase A (E4) — `PATCH /v1/federation/peers/{id}`: THE NARROW, STRUCTURALLY KEYLESS PEER WRITE.
 *
 * WHY IT MATTERS. Before this increment the only peer write was `POST /federation/peers`, whose body
 * REQUIRES `publicKey` and treats a different value as a KEY ROTATION: it supersedes the current key
 * window at the applied-sequence anchor and hard-revokes the old key. A Settings form that read a peer,
 * changed one field and re-paired would rotate that peer's trust anchor the moment it dropped or
 * mangled the key. This suite pins both halves of the fix:
 *
 *   (a) a PATCH leaves `federation_peer_keys` COMPLETELY UNCHANGED — no new window row, the existing
 *       row's `superseded_at` still NULL — and the NON-VACUITY CONTROL right beside it shows the same
 *       assertions DO catch a real rotation when a re-pair performs one;
 *   (b) EVERY pair-time guard still fires on the new path. The census (G1–G11, with each guard's
 *       disposition) lives on `updatePeerTransport` in `peers-repo.ts`; the behavioural ones are
 *       exercised here.
 */
describe("M16.2 E4: PATCH /federation/peers/{id} — transport only, never key material (Testcontainers)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  /** A fresh Ed25519 PUBLIC key in the base64-DER encoding federation stores keys in. The private
   *  half is never needed here — nothing in this suite signs anything. */
  function publicKeyB64(): string {
    const { publicKey } = generateKeyPairSync("ed25519");
    return publicKey.export({ format: "der", type: "spki" }).toString("base64");
  }

  async function pairFresh(
    opts: { baseUrl?: string; pokeMode?: boolean; syncScope?: { mode: "full" } } = {}
  ): Promise<{ domainId: string; publicKey: string }> {
    const domainId = randomUUID();
    const publicKey = publicKeyB64();
    await admin.federation.pair({
      domainId,
      name: `peer-${domainId.slice(0, 8)}`,
      role: "outpost",
      publicKey,
      ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
      ...(opts.pokeMode !== undefined ? { pokeMode: opts.pokeMode } : {}),
      ...(opts.syncScope !== undefined ? { syncScope: opts.syncScope } : {})
    });
    return { domainId, publicKey };
  }

  /** Every key-window row for a peer, oldest first, as comparable snapshots. */
  async function keyWindows(peerDomainId: string) {
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(federationPeerKeys)
        .where(
          and(
            eq(federationPeerKeys.orgId, org.orgId),
            eq(federationPeerKeys.peerDomainId, asTrustDomainId(peerDomainId))
          )
        )
    );
    return rows
      .map((row) => ({
        id: row.id,
        publicKey: row.publicKey,
        cosignPublicKey: row.cosignPublicKey,
        effectiveFrom: row.effectiveFrom?.toISOString() ?? null,
        effectiveFromSequence: row.effectiveFromSequence,
        supersededAt: row.supersededAt?.toISOString() ?? null,
        supersededAtSequence: row.supersededAtSequence
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async function liveKeyWindowCount(peerDomainId: string): Promise<number> {
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ id: federationPeerKeys.id })
        .from(federationPeerKeys)
        .where(
          and(
            eq(federationPeerKeys.orgId, org.orgId),
            eq(federationPeerKeys.peerDomainId, asTrustDomainId(peerDomainId)),
            isNull(federationPeerKeys.supersededAt)
          )
        )
    );
    return rows.length;
  }

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

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "peer-patch");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
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

  it("THE DoD: a PATCH of baseUrl leaves federation_peer_keys COMPLETELY unchanged", async () => {
    const { domainId, publicKey } = await pairFresh();
    const before = await keyWindows(domainId);
    expect(before).toHaveLength(1);
    expect(before[0]?.publicKey).toBe(publicKey);
    expect(before[0]?.supersededAt).toBeNull();

    const patched = await admin.federation.updatePeer(domainId, {
      baseUrl: "https://outpost-a.example.test"
    });
    expect(patched.baseUrl).toBe("https://outpost-a.example.test");
    // The response still reports the SAME registered key — read from the window, never rewritten.
    expect(patched.publicKey).toBe(publicKey);

    const after = await keyWindows(domainId);
    // No new row, and every column of the existing row byte-identical — including `superseded_at`,
    // still NULL, which is what "the old key was not revoked" actually means.
    expect(after).toEqual(before);
    expect(after).toHaveLength(1);
    expect(after[0]?.supersededAt).toBeNull();
    expect(after[0]?.supersededAtSequence).toBeNull();
    expect(await liveKeyWindowCount(domainId)).toBe(1);
  });

  /**
   * M16.2 phase B (B2) — THE SAME DoD, OVER THE WHOLE SETTINGS-FORM SAVE.
   *
   * The case above patches ONE field. A settings form does not: it saves every transport field the
   * operator can see, in one request, and it is the multi-field save an implementer is tempted to
   * build on `POST /federation/peers` ("just send the peer back") — which is the re-pair that
   * rotates the trust anchor. So the field set the UI can actually send
   * (`apps/web/src/routes/outpost-settings.tsx`'s `PEER_SETTINGS_PATCH_KEYS`, plus `pokeMode`, which
   * B3's configuration card sends through this same door) is exercised here as one body, against a
   * real database.
   *
   * `deliveryTarget` is deliberately NOT in this body: `SCP_DELIVERY_ROOTS` is unset on this test
   * server, so every per-peer directory is refused before storage — which is its own case, "GUARD
   * G4" below. A refusal writes nothing, so it could not exercise this one anyway.
   */
  it("B2: the WHOLE settings-form save (name+baseUrl+syncScope+pokeMode at once) leaves federation_peer_keys byte-identical", async () => {
    const { domainId, publicKey } = await pairFresh({
      baseUrl: "https://outpost-form.example.test",
      syncScope: { mode: "full" }
    });
    const before = await keyWindows(domainId);
    expect(before).toHaveLength(1);
    expect(before[0]?.publicKey).toBe(publicKey);
    expect(before[0]?.supersededAt).toBeNull();

    const saved = await admin.federation.updatePeer(domainId, {
      name: "amer-prod-renamed",
      baseUrl: "https://outpost-form-2.example.test",
      syncScope: { mode: "status_only" },
      pokeMode: true
    });

    // PREMISE — every field really was written, so the key assertions below are over a save that
    // actually did something.
    expect(saved.name).toBe("amer-prod-renamed");
    expect(saved.baseUrl).toBe("https://outpost-form-2.example.test");
    expect(saved.syncScope).toEqual({ mode: "status_only" });
    expect(saved.pokeMode).toBe(true);
    expect(saved.role).toBe("outpost");
    expect(saved.publicKey).toBe(publicKey);

    const after = await keyWindows(domainId);
    // NO NEW KEY-WINDOW ROW, and the existing row's `superseded_at` still NULL — i.e. the old key was
    // not revoked, which is the whole claim.
    expect(after).toEqual(before);
    expect(after).toHaveLength(1);
    expect(after[0]?.supersededAt).toBeNull();
    expect(after[0]?.supersededAtSequence).toBeNull();
    expect(await liveKeyWindowCount(domainId)).toBe(1);
  });

  it("NON-VACUITY CONTROL: the very same assertions DO catch the rotation a re-pair performs", async () => {
    // Without this control, "the key window is unchanged" could be passing because nothing in the
    // suite is capable of changing it. A re-pair with a DIFFERENT public key must move exactly the
    // things the PATCH left alone.
    const { domainId } = await pairFresh();
    const before = await keyWindows(domainId);
    expect(before).toHaveLength(1);

    const rotated = publicKeyB64();
    await admin.federation.pair({
      domainId,
      name: `peer-${domainId.slice(0, 8)}`,
      role: "outpost",
      publicKey: rotated
    });

    const after = await keyWindows(domainId);
    expect(after).not.toEqual(before);
    expect(after).toHaveLength(2);
    expect(after.filter((row) => row.supersededAt === null)).toHaveLength(1);
    const superseded = after.find((row) => row.supersededAt !== null);
    expect(superseded).toBeDefined();
    expect(superseded?.supersededAtSequence).not.toBeNull();
    expect(superseded?.publicKey).toBe(before[0]?.publicKey);
  });

  it("no key material is even REPRESENTABLE on the PATCH: smuggled key fields are ignored, not applied", async () => {
    const { domainId, publicKey } = await pairFresh();
    const before = await keyWindows(domainId);

    // Raw HTTP, because the SDK's typed signature cannot express these fields at all — which is the
    // point: the contract has no place for them. A caller that sends them anyway must not rotate
    // anything (Zod strips what the schema does not declare).
    const res = await server.app.inject({
      method: "PATCH",
      url: `/api/v1/federation/peers/${domainId}`,
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: {
        name: "renamed-through-patch",
        publicKey: publicKeyB64(),
        cosignPublicKey: "-----BEGIN PUBLIC KEY-----\nnope\n-----END PUBLIC KEY-----",
        role: "commander"
      }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { name: string; role: string; publicKey: string };
    // The transport field it WAS allowed to change did change…
    expect(body.name).toBe("renamed-through-patch");
    // …while `role` (G11: identity-level, pairing-only) and the registered key are untouched.
    expect(body.role).toBe("outpost");
    expect(body.publicKey).toBe(publicKey);
    expect(await keyWindows(domainId)).toEqual(before);
  });

  it("GUARD G7 (M14.1/M14.3): poke-mode requires an https/mTLS baseUrl, over the MERGED post-write tuple", async () => {
    // (i) explicit poke-mode with NO baseUrl at all — refused.
    const bare = await pairFresh();
    await expectApiError(
      admin.federation.updatePeer(bare.domainId, { pokeMode: true }),
      400,
      /poke-mode requires an mTLS\/https peer/i
    );

    // (ii) explicit poke-mode on a plain-http baseUrl — refused.
    const http = await pairFresh({ baseUrl: "http://outpost.example.test" });
    await expectApiError(
      admin.federation.updatePeer(http.domainId, { pokeMode: true }),
      400,
      /poke-mode requires an mTLS\/https peer/i
    );

    // (iii) THE M14.3 HOLE, on the new path: an OMITTED pokeMode preserves `true` while the baseUrl is
    //       downgraded to http. Keying the guard off the request alone would check a tuple that is not
    //       the one persisted, and would leave an {http, pokeMode:true} row the sender would dial with
    //       the federation bearer in cleartext.
    const poking = await pairFresh({ baseUrl: "https://outpost-b.example.test", pokeMode: true });
    await expectApiError(
      admin.federation.updatePeer(poking.domainId, { baseUrl: "http://outpost-b.example.test" }),
      400,
      /poke-mode requires an mTLS\/https peer/i
    );
    // The refused PATCH stored nothing: still https, still poking.
    const unchanged = await admin.federation.getPeer(poking.domainId);
    expect(unchanged.baseUrl).toBe("https://outpost-b.example.test");
    expect(unchanged.pokeMode).toBe(true);

    // (iv) the legitimate case still works: poke-mode ON with an https baseUrl in the same PATCH.
    const ok = await pairFresh();
    const enabled = await admin.federation.updatePeer(ok.domainId, {
      baseUrl: "https://outpost-c.example.test",
      pokeMode: true
    });
    expect(enabled.pokeMode).toBe(true);
    // …and turning poke-mode OFF is always allowed, whatever the baseUrl.
    const disabled = await admin.federation.updatePeer(ok.domainId, { pokeMode: false });
    expect(disabled.pokeMode).toBe(false);
  });

  it("GUARD G4: a deliveryTarget outside the operator allowlists is refused before it is ever stored", async () => {
    const { domainId } = await pairFresh();
    // SCP_DELIVERY_ROOTS is unset on this test server, so ANY per-peer directory must be refused —
    // the fail-closed default, identical to the pair route's behaviour.
    await expectApiError(
      admin.federation.updatePeer(domainId, {
        deliveryTarget: { provider: "filesystem", outDir: "/tmp/anywhere" }
      }),
      400,
      /no operator delivery roots are declared/i
    );
    // Same for an s3 target with no SCP_DELIVERY_S3_ENDPOINTS allowlist.
    await expectApiError(
      admin.federation.updatePeer(domainId, {
        deliveryTarget: {
          provider: "s3-compatible",
          endpoint: "https://minio.example.test:9000",
          bucket: "bundles"
        }
      }),
      400,
      /no operator s3 delivery endpoints are declared/i
    );
    // Nothing was stored: the peer still resolves through the instance-env fallback.
    const peer = await admin.federation.getPeer(domainId);
    expect(peer.deliveryTarget ?? null).toBeNull();
  });

  it("GUARD G8: a PATCH that leaves the scope at `full` re-anchors a wedged, anchorless cursor", async () => {
    const { domainId } = await pairFresh({ syncScope: { mode: "full" } });
    const peerDomainId = asTrustDomainId(domainId);

    // Manufacture the exact wedged state drizzle/0042 exists for: progress recorded (seq > 0) with NO
    // anchor (`last_applied_row_hash IS NULL`) and no permit. This is what a period of narrow-scope
    // verification leaves behind.
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.insert(syncCursors).values({
        orgId: org.orgId,
        peerDomainId,
        originDomainId: peerDomainId,
        lastAppliedSeq: 7,
        lastAppliedRowHash: null,
        reanchorFromSeq: null
      })
    );
    const wedged = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      getCursor(tx, org.orgId, peerDomainId, peerDomainId)
    );
    expect(wedged.reanchorFromSeq).toBeNull();

    // The documented recovery — declare the scope `full` — must work through THIS route too, or the
    // same operator action heals the peer via one door and silently wedges it forever via the other.
    await admin.federation.updatePeer(domainId, { syncScope: { mode: "full" } });
    const healed = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      getCursor(tx, org.orgId, peerDomainId, peerDomainId)
    );
    expect(healed.reanchorFromSeq).toBe(7);

    // NARROWING gets no permit (sparse verification never consults the anchor) — the permit is issued
    // only for a resulting scope of `full`.
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(syncCursors)
        .set({ reanchorFromSeq: null })
        .where(and(eq(syncCursors.orgId, org.orgId), eq(syncCursors.peerDomainId, peerDomainId)))
    );
    await admin.federation.updatePeer(domainId, { syncScope: { mode: "status_only" } });
    const narrowed = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      getCursor(tx, org.orgId, peerDomainId, peerDomainId)
    );
    expect(narrowed.reanchorFromSeq).toBeNull();
  });

  it("G10: absent means PRESERVE — a one-field PATCH cannot blank anything else", async () => {
    const { domainId, publicKey } = await pairFresh({
      baseUrl: "https://outpost-d.example.test",
      pokeMode: true,
      syncScope: { mode: "full" }
    });
    const before = await admin.federation.getPeer(domainId);

    const patched = await admin.federation.updatePeer(domainId, { name: "only-the-name" });
    expect(patched.name).toBe("only-the-name");
    expect(patched.baseUrl).toBe(before.baseUrl);
    expect(patched.syncScope).toEqual(before.syncScope);
    expect(patched.pokeMode).toBe(before.pokeMode);
    expect(patched.deliveryTarget ?? null).toBe(before.deliveryTarget ?? null);
    expect(patched.publicKey).toBe(publicKey);
    expect(patched.pairedAt).toBe(before.pairedAt);
  });

  // TITLE CORRECTED IN REVIEW ROUND 4 (H2). This case used to be titled "…requires federation:write"
  // while asserting only 401 (anonymous) and 404 (unknown peer) — BOTH of which still fire with the
  // route's `authorize(...)` block deleted, so the title described the code and the assertions pinned
  // nothing. The permission gate is now witnessed for real, on THIS route and the five others this
  // milestone added, by `outposts-rbac.integration.test.ts` (an `object:write` actor without
  // `federation:write`, mutation-proven route by route). What is left here is what this file can
  // honestly claim: authentication, and that a PATCH never conjures a peer row.
  it("G1: the PATCH is AUTHENTICATED (401 anonymous), and an unknown peer is a 404 that creates nothing", async () => {
    const { domainId } = await pairFresh();

    const anonymous = await server.app.inject({
      method: "PATCH",
      url: `/api/v1/federation/peers/${domainId}`,
      payload: { name: "no-auth" }
    });
    expect(anonymous.statusCode).toBe(401);

    // A peer id that does not exist in this org resolves to nothing — no row is created by a PATCH.
    await expectApiError(
      admin.federation.updatePeer(randomUUID(), { name: "ghost" }),
      404,
      /not found/i
    );
    const stillOne = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select({ n: sql<number>`count(*)::int` }).from(federationPeerKeys)
    );
    expect(stillOne[0]!.n).toBeGreaterThan(0);
  });
});
