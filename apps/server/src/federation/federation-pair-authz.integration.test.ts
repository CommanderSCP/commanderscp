import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import {
  createTestOrg,
  createTestUser,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg,
  type TestUser
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { federationPeerKeys, federationPeers, roleBindings, roles } from "../db/schema.js";
import { initFederationSelf } from "./self-repo.js";
import { trustDomainIdFromWire } from "../domain-id-edge.js";

/**
 * ================================================================================================
 * `federation:pair` — ESTABLISHING A LINK IS NOT THE SAME ACT AS OPERATING ONE (owner ruling D4)
 * ================================================================================================
 *
 * THE CHAIN. `POST /api/v1/federation/peers` took `federation:write` alone and the peer's Ed25519
 * `publicKey` VERBATIM from the request body (a changed value is a KEY ROTATION that supersedes the
 * current window). `POST /api/v1/federation/imports` takes that same single permission, and
 * `applyEntry`'s `object_upsert` branch resolves ANY registered `typeId` through
 * `upsertObjectByUrn`. So on `federation:write` alone: pair a peer with a keypair you generated,
 * import a bundle you signed with it, and you hold estate write authority having never held
 * `object:write`.
 *
 * WHERE THE BAR GOES, AND WHY NOT ON IMPORT. A throw on the import path wedges a legitimately paired
 * peer's whole signed bundle, and an import from a legitimately paired peer writing what that peer
 * sent is the federation contract working as designed. PAIRING is the link that can be gated without
 * breaking the contract, so `federation:pair` (drizzle/0094) is demanded there — ADDED alongside the
 * existing `federation:write` check, never substituted for it.
 *
 * NOT LIVE TODAY, which is why the actor below has to be BUILT. drizzle/0012 grants
 * `federation:write` to Administrator and Owner and to no other built-in role, and drizzle/0094
 * grants `federation:pair` to exactly those two — so no built-in role can express "operates the link,
 * cannot establish one". The FederationAdmin role role-model.md §4.1 is designing is precisely that
 * shape, and testing against the built-in role table's current accident would measure nothing.
 *
 * ================================================================================================
 * WHAT THIS FILE ASSERTS
 * ================================================================================================
 *  1. THE REFUSAL, on both halves of the ruling — a link operator cannot ADD a peer and cannot
 *     RE-KEY one — each with the "nothing was written" half read from `federation_peers` /
 *     `federation_peer_keys` directly, because a refusal that still stored the key is not a refusal.
 *  2. THE REFUSAL IS ABOUT THIS PERMISSION. Every 403 is matched against `federation:pair` by name.
 *     A bare status assertion would be satisfied by the `federation:write` check that was already
 *     there, and would go on passing if the new bar were deleted tomorrow.
 *  3. THE CONTROL, which is also the non-vacuity witness: the SAME actor still exports a bundle and
 *     reads status (200), and still edits a peer's TRANSPORT through the structurally keyless PATCH.
 *     That proves the actor genuinely holds `federation:write` — so the 403s above are about
 *     `federation:pair` and not about being powerless — and proves the ruling's "import, export,
 *     status, outposts, resync and poke stay on `federation:write`" survived.
 *  4. BOTH GRANTED ROLES, measured separately: a built-in ADMINISTRATOR pairs and re-keys (201), and
 *     so does the bootstrap OWNER. Asserting one would leave the other's grant in 0094 unmeasured.
 *
 * ================================================================================================
 * MUTATION RUN (2026-08-25). MEASURED, not predicted.
 * ================================================================================================
 *   M-1  DELETE the `permission: "federation:pair"` authorize block from `POST /federation/peers`
 *        (`routes/federation.ts`), leaving the `federation:write` one
 *          -> 2 failed | 4 passed. Both refusal cases went red, each with the peer row it should
 *             have refused printed in the failure message:
 *             "a link operator (federation:write, no federation:pair) cannot ADD a peer"
 *               AssertionError: {"id":"998ff4c4-...","name":"smuggled-998ff4c4","role":"commander",
 *               ...,"publicKey":"MCowBQYDK2VwAyEATzUGQ/QFZRKid4u+EvM/FwXBxoSauG9hi76kl+ZVTyc="}:
 *               expected 201 to be 403
 *             "... cannot RE-KEY an existing peer"
 *               AssertionError: {"id":"9573f29f-...","name":"established-9573f29f",...}:
 *               expected 201 to be 403
 *             — i.e. with the bar removed the link-only actor both admitted a brand-new peer under a
 *             key it generated itself AND rotated an established peer's trust anchor to one. The
 *             four control/grant cases stayed GREEN, which is the point of case 3: they do not
 *             depend on the new bar and are not what makes the refusals pass.
 *
 *   M-2  NARROW drizzle/0094's grant to `name IN ('Owner')` — the migration's other half
 *          -> 2 failed | 4 passed, and a DIFFERENT two:
 *             "a built-in ADMINISTRATOR pairs and re-keys"
 *               AssertionError: {"status":403,"detail":"subject '01a03ab7-...' lacks
 *               'federation:pair' at scope '01a03ab7-...'"}: expected 403 to be 201
 *             "the built-in role table really does carry the new permission ..."
 *               AssertionError: expected [ 'Owner' ] to deeply equal [ 'Administrator', 'Owner' ]
 *             — so the Administrator half of the grant is measured, not assumed, and the two
 *             refusal cases do NOT depend on it (they stayed green: they are refused by the absent
 *             permission, not by a role table accident).
 */
describe("federation:pair — a second bar on pairing, added never substituted (Testcontainers)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  /** `federation:read` + `federation:write` at the org root, NO `federation:pair`, NO `object:write`
   *  — the FederationAdmin shape (role-model.md §4.1). */
  let linkOperator: TestUser;
  let administrator: TestUser;
  /** A peer paired by the OWNER before the refusal cases run — the thing a re-key is attempted on,
   *  and the peer the control export/PATCH cases operate. */
  let establishedPeer: string;
  let establishedPeerKey: string;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "fed-pair-authz");
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      initFederationSelf(tx, {
        orgId: org.orgId,
        name: `commander-${randomUUID().slice(0, 8)}`,
        role: "commander"
      })
    );
    linkOperator = await createLinkOperator();
    administrator = await createTestUser(server, org, [
      { role: "Administrator", scope: org.orgId }
    ]);

    establishedPeer = randomUUID();
    establishedPeerKey = publicKeyB64();
    const paired = await pair(org.adminToken, {
      domainId: establishedPeer,
      name: `established-${establishedPeer.slice(0, 8)}`,
      role: "outpost",
      publicKey: establishedPeerKey
    });
    expect(paired.statusCode, paired.body).toBe(201);
  }, 180_000);

  afterAll(async () => {
    await server?.close();
  });

  function publicKeyB64(): string {
    const { publicKey } = generateKeyPairSync("ed25519");
    return publicKey.export({ format: "der", type: "spki" }).toString("base64");
  }

  async function pair(token: string, payload: Record<string, unknown>) {
    return server.app.inject({
      method: "POST",
      url: "/api/v1/federation/peers",
      headers: { authorization: `Bearer ${token}` },
      payload
    });
  }

  /**
   * The actor under test: it OPERATES the link and cannot ESTABLISH one.
   *
   * Built through `roles.org_id` (the org-defined-role mechanism) because no built-in role can
   * express it — see this file's header. The `Viewer` binding exists only so the harness mints an
   * auth row and a live token; `object:read` is no part of what is under test and grants no write
   * anywhere. `federation:pair` is conspicuously ABSENT from the permission list, which is the whole
   * fixture.
   */
  async function createLinkOperator(): Promise<TestUser> {
    const user = await createTestUser(server, org, [{ role: "Viewer", scope: org.orgId }]);
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const roleId = randomUUID();
      await tx.insert(roles).values({
        id: roleId,
        orgId: org.orgId,
        name: `federation-admin-${randomUUID().slice(0, 8)}`,
        permissions: ["federation:read", "federation:write"]
      });
      await tx.insert(roleBindings).values({
        id: randomUUID(),
        orgId: org.orgId,
        subjectId: user.objectId,
        roleId,
        scopeObjectId: org.orgId,
        effect: "allow"
      });
    });
    return user;
  }

  /** Peer rows for a trust-domain id — read from the table, not from the API, so a refusal that
   *  answered 403 while still writing would be caught. */
  async function peerRows(domainId: string) {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ id: federationPeers.id, name: federationPeers.name })
        .from(federationPeers)
        .where(
          and(
            eq(federationPeers.orgId, org.orgId),
            eq(federationPeers.id, trustDomainIdFromWire(domainId))
          )
        )
    );
  }

  /** Every registered key window for a peer, oldest first — a re-key appends one and supersedes the
   *  previous, so this is what "the trust anchor is untouched" is measured against. */
  async function keyWindows(domainId: string) {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({
          publicKey: federationPeerKeys.publicKey,
          supersededAtSequence: federationPeerKeys.supersededAtSequence
        })
        .from(federationPeerKeys)
        .where(
          and(
            eq(federationPeerKeys.orgId, org.orgId),
            eq(federationPeerKeys.peerDomainId, trustDomainIdFromWire(domainId))
          )
        )
    );
  }

  it("a link operator (federation:write, no federation:pair) cannot ADD a peer", async () => {
    const domainId = randomUUID();
    const res = await pair(linkOperator.token, {
      domainId,
      name: `smuggled-${domainId.slice(0, 8)}`,
      role: "commander",
      // A key this actor generated itself — the first move of the chain the ruling closes.
      publicKey: publicKeyB64()
    });

    expect(res.statusCode, res.body).toBe(403);
    // THE SPECIFIC BAR, named. `federation:write` is held here, so a 403 mentioning THAT permission
    // would mean something else refused and this case would be measuring the wrong door.
    expect(res.body).toMatch(/federation:pair/);
    expect(
      await peerRows(domainId),
      "a refusal that still admitted the peer is not a refusal"
    ).toHaveLength(0);
    expect(await keyWindows(domainId)).toHaveLength(0);
  });

  it("a link operator cannot RE-KEY an existing peer", async () => {
    // The second half of the ruling, and the more dangerous one: the peer is already trusted, so a
    // rotation here silently redirects an EXISTING link's trust anchor to the attacker's key.
    const attackerKey = publicKeyB64();
    const res = await pair(linkOperator.token, {
      domainId: establishedPeer,
      name: `established-${establishedPeer.slice(0, 8)}`,
      role: "outpost",
      publicKey: attackerKey
    });

    expect(res.statusCode, res.body).toBe(403);
    expect(res.body).toMatch(/federation:pair/);

    // The trust anchor is untouched: still exactly one key window, still the ORIGINAL key, still
    // current (not superseded).
    const windows = await keyWindows(establishedPeer);
    expect(windows).toHaveLength(1);
    expect(windows[0]!.publicKey).toBe(establishedPeerKey);
    expect(windows[0]!.publicKey).not.toBe(attackerKey);
    expect(windows[0]!.supersededAtSequence).toBeNull();
  });

  it("CONTROL: the SAME actor still exports, reads status, and edits peer TRANSPORT — the link keeps working", async () => {
    // Non-vacuity for both cases above: without this, every 403 there is equally explained by an
    // actor holding nothing at all, and the file would prove nothing about `federation:pair`.
    //
    // It is also the ruling's other half, asserted rather than assumed: "import, export, status,
    // outposts, resync and poke stay on `federation:write` so the link keeps working". Over-narrowing
    // would break a paired federation, which is a worse outcome than the hole being closed.
    const exported = await server.app.inject({
      method: "POST",
      url: "/api/v1/federation/exports",
      headers: { authorization: `Bearer ${linkOperator.token}` },
      payload: { peer: establishedPeer, sinceSequence: 0 }
    });
    expect(exported.statusCode, exported.body).toBe(200);

    const status = await server.app.inject({
      method: "GET",
      url: "/api/v1/federation/status",
      headers: { authorization: `Bearer ${linkOperator.token}` }
    });
    expect(status.statusCode, status.body).toBe(200);

    // THE PER-FIELD SPLIT, made real. `PATCH /federation/peers/{id}` is transport-only — its request
    // schema admits no key material at all — so it deliberately does NOT demand `federation:pair`:
    // "may edit peer transport, may NOT rotate a peer's trust anchor" is now enforced at the
    // permission layer as well as by the body's shape.
    //
    // On its OWN peer, not on `establishedPeer`. This case must fail only for its own reason: run
    // against a peer another case has attempted to re-key, the anchor assertion below would go red
    // whenever THAT case's guard was removed, and this control would be reporting someone else's
    // failure under a title about the link still working.
    const transportPeer = randomUUID();
    const transportPeerKey = publicKeyB64();
    const transportPaired = await pair(org.adminToken, {
      domainId: transportPeer,
      name: `transport-${transportPeer.slice(0, 8)}`,
      role: "outpost",
      publicKey: transportPeerKey
    });
    expect(transportPaired.statusCode, transportPaired.body).toBe(201);

    const patched = await server.app.inject({
      method: "PATCH",
      url: `/api/v1/federation/peers/${transportPeer}`,
      headers: { authorization: `Bearer ${linkOperator.token}` },
      payload: { baseUrl: "https://moved-by-the-link-operator.example.test" }
    });
    expect(patched.statusCode, patched.body).toBe(200);

    // And the transport edit did not disturb the trust anchor either.
    const windows = await keyWindows(transportPeer);
    expect(windows).toHaveLength(1);
    expect(windows[0]!.publicKey).toBe(transportPeerKey);
  });

  it("a built-in ADMINISTRATOR pairs and re-keys — drizzle/0094's Administrator grant", async () => {
    const domainId = randomUUID();
    const firstKey = publicKeyB64();
    const created = await pair(administrator.token, {
      domainId,
      name: `admin-paired-${domainId.slice(0, 8)}`,
      role: "outpost",
      publicKey: firstKey
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(await peerRows(domainId)).toHaveLength(1);

    // The RE-KEY half: a second pair call with a different key rotates the anchor, superseding the
    // first window. This is the capability being gated, exercised by a role that holds the grant.
    const rotatedKey = publicKeyB64();
    const rekeyed = await pair(administrator.token, {
      domainId,
      name: `admin-paired-${domainId.slice(0, 8)}`,
      role: "outpost",
      publicKey: rotatedKey
    });
    expect(rekeyed.statusCode, rekeyed.body).toBe(201);

    const windows = await keyWindows(domainId);
    expect(windows.map((w) => w.publicKey).sort()).toEqual([firstKey, rotatedKey].sort());
    const current = windows.filter((w) => w.supersededAtSequence === null);
    expect(current).toHaveLength(1);
    expect(current[0]!.publicKey).toBe(rotatedKey);
  });

  it("the bootstrap OWNER pairs and re-keys — drizzle/0094's Owner grant", async () => {
    // Measured separately from Administrator on purpose: 0094 names two roles, and one case cannot
    // witness two grants. (`establishedPeer` was already paired by this actor in `beforeAll`, so the
    // ADD half is covered there; this is the rotation half plus a fresh add.)
    const domainId = randomUUID();
    const firstKey = publicKeyB64();
    const created = await pair(org.adminToken, {
      domainId,
      name: `owner-paired-${domainId.slice(0, 8)}`,
      role: "outpost",
      publicKey: firstKey
    });
    expect(created.statusCode, created.body).toBe(201);

    const rotatedKey = publicKeyB64();
    const rekeyed = await pair(org.adminToken, {
      domainId,
      name: `owner-paired-${domainId.slice(0, 8)}`,
      role: "outpost",
      publicKey: rotatedKey
    });
    expect(rekeyed.statusCode, rekeyed.body).toBe(201);

    const current = (await keyWindows(domainId)).filter((w) => w.supersededAtSequence === null);
    expect(current).toHaveLength(1);
    expect(current[0]!.publicKey).toBe(rotatedKey);
  });

  it("the built-in role table really does carry the new permission on exactly the two granted roles", async () => {
    // drizzle/0094 read back from the live database. Without this, every case above could be green
    // against a migration that granted the permission to everybody (the refusal case would still
    // fail-closed for an org-defined role that lists it explicitly), and the ADD/RE-KEY grants would
    // not be pinned to the two roles the ruling names.
    const builtIns = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ name: roles.name, permissions: roles.permissions })
        .from(roles)
        // `org_id IS NULL` is what 0094's WHERE clause selects — the BUILT-IN roles. This org's own
        // `federation-admin-*` role is deliberately excluded: it is a fixture, not a shipped grant.
        .where(isNull(roles.orgId))
    );
    const holders = builtIns
      .filter((r) => r.permissions.includes("federation:pair"))
      .map((r) => r.name)
      .sort();
    // `OrgAdmin` JOINED THE SET IN drizzle/0099, BY OWNER RULING D6 (2026-08-27), and this assertion
    // is what caught the change rather than letting it land silently — which is the whole reason it
    // enumerates the holders instead of spot-checking two names.
    //
    // D6 resolved a contradiction inside role-model.md: §4.1 and D4 both granted `federation:pair` to
    // "Administrator, Owner and OrgAdmin", while §3C's permission list — the one 0099's seed literal
    // is copied from — omitted it. D4 governs, because it is the ruling that REASONED about this
    // permission: establishing a trust relationship is a different act from operating one, so the
    // role that operates the link must not decide whose signature this instance believes. That names
    // `FederationAdmin` as the withholding, and it is the ONLY one — §3B holds `federation:write` and
    // not this. Withholding it from OrgAdmin as well would leave an org whose only pairing principals
    // are Owner and the D5-deprecated Administrator, i.e. unadministrable in exactly the dimension
    // OrgAdmin exists to cover.
    //
    // So the list below is three, and `FederationAdmin`'s ABSENCE from it is the load-bearing half.
    expect(holders).toEqual(["Administrator", "OrgAdmin", "Owner"]);
    expect(holders).not.toContain("FederationAdmin");
  });
});
