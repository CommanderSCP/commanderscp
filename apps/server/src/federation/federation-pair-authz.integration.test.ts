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

/** Establishing a link is not the same act as operating one. See docs/federation.md §133. */
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

  /** The actor under test. See docs/federation.md §134. */
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
    // Non-vacuity for both cases above. See docs/federation.md §135.
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

    // THE PER-FIELD SPLIT, made real. See docs/federation.md §136.
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
    // `OrgAdmin` JOINED THE SET IN drizzle/0099, BY OWNER RULING D6. See docs/federation.md §137.
    expect(holders).toEqual(["Administrator", "OrgAdmin", "Owner"]);
    expect(holders).not.toContain("FederationAdmin");
  });
});
