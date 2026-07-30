import { randomUUID, generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import {
  createTestOrg,
  createTestUser,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg,
  type TestUser
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { initFederationSelf } from "./self-repo.js";

/**
 * M16.2 phase A, REVIEW ROUND 4 (H2) — RBAC COVERAGE FOR EVERY NEW FEDERATION ROUTE.
 *
 * WHY THIS FILE EXISTS. A lens removed ALL SIX `authorize(...)` blocks from the routes this milestone
 * added (peers GET + PATCH, outposts POST / GET-list / GET-one / PATCH) and the ENTIRE federation
 * integration suite stayed GREEN — 24 files, 231 tests. `peer-patch.integration.test.ts`'s
 * "G1/G2: … requires federation:write" asserted only 401 (anonymous) and 404 (unknown peer): both fire
 * with the permission check deleted, so the title described the code and the assertions pinned nothing.
 * "Wording, not behaviour" is this repo's second recurring bug source, and the E1 side-door refusals
 * (`/objects/outpost` → 403, plan-apply → `federation:write`) all rest on the claim that these routes are
 * gated on `federation:*` rather than plain `object:write`. That claim needed a witness.
 *
 * TWO ACTORS, because the write and read gates are different permissions and each needs a witness that
 * can ONLY fail on that gate:
 *
 *   * `operator` — the built-in `Operator` role AT THE ORG ROOT. drizzle/0002 gives it `object:write`
 *     and `relationship:write`; drizzle/0012 adds `federation:read` to every built-in role but adds
 *     `federation:write` to Administrator/Owner ONLY. So it holds `object:write` and NOT
 *     `federation:write` — the review's exact actor — and a 403 from it on a WRITE route means precisely
 *     "object:write is not enough here", which is the whole argument the E1 side-door refusals make.
 *
 *   * `selfScoped` — `Owner`, bound at SELF scope. It holds `federation:read` as a permission but has no
 *     authority AT THE ORG ROOT, which is the scope every one of these routes checks. It is the only way
 *     to witness the READ gate at all: no built-in role lacks `federation:read`, so an actor that fails
 *     on the permission alone does not exist. A 403 from it therefore proves the `authorize(...)` call
 *     RUNS and its `scopeObjectId` is honored — delete the block and the call returns 200.
 *
 * MUTATION-PROVEN: deleting the `authorize(...)` block from ANY of these routes turns its case red
 * (each route is asserted independently, so a single deletion is caught by a single named test).
 */
describe("M16.2 H2: every new federation route rejects object:write-only (Testcontainers)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let operator: TestUser;
  let selfScoped: TestUser;
  let outpostPeerId: string;

  function publicKeyB64(): string {
    const { publicKey } = generateKeyPairSync("ed25519");
    return publicKey.export({ format: "der", type: "spki" }).toString("base64");
  }

  /** Raw inject rather than the SDK: the assertion is about the STATUS a bare token gets, and inject
   *  keeps the un-permitted call from being shaped by any client-side convenience. */
  async function asActor(
    actor: TestUser,
    method: "GET" | "POST" | "PATCH",
    url: string,
    payload?: Record<string, unknown>
  ) {
    return server.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${actor.token}` },
      ...(payload === undefined ? {} : { payload })
    });
  }

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "outposts-rbac");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      initFederationSelf(tx, {
        orgId: org.orgId,
        name: `commander-${randomUUID().slice(0, 8)}`,
        role: "commander"
      })
    );
    // Org-root Operator: object:write + relationship:write + federation:read, NO federation:write.
    operator = await createTestUser(server, org, [{ role: "Operator", scope: org.orgId }]);
    // Owner, but only over ITS OWN object — every permission, no authority at the org root.
    selfScoped = await createTestUser(server, org, [{ role: "Owner", scope: "self" }]);

    outpostPeerId = randomUUID();
    await admin.federation.pair({
      domainId: outpostPeerId,
      name: `outpost-${outpostPeerId.slice(0, 8)}`,
      role: "outpost",
      publicKey: publicKeyB64(),
      baseUrl: "https://outpost-rbac.example.test"
    });
    await admin.federation.createOutpost({ peerDomainId: outpostPeerId, trustTier: "govcloud" });
  }, 120_000);

  afterAll(async () => {
    await server?.close();
  });

  it("the Operator actor really does hold object:write — so every 403 below is about the FEDERATION permission, not about being powerless", async () => {
    const created = await server.app.inject({
      method: "POST",
      url: "/api/v1/objects/service",
      headers: { authorization: `Bearer ${operator.token}` },
      payload: { name: `rbac-witness-${randomUUID().slice(0, 8)}`, properties: {} }
    });
    // A plain graph write SUCCEEDS for this actor. Without this control the whole file could pass with
    // a token that has no permissions at all, and would prove nothing about `federation:*` specifically.
    expect(created.statusCode).toBe(201);
  });

  it("GET /v1/federation/peers/{id} — 403 — the org-root scope check fires", async () => {
    const res = await asActor(selfScoped, "GET", `/api/v1/federation/peers/${outpostPeerId}`);
    expect(res.statusCode).toBe(403);
  });

  it("PATCH /v1/federation/peers/{id} — 403 without federation:write", async () => {
    const res = await asActor(operator, "PATCH", `/api/v1/federation/peers/${outpostPeerId}`, {
      name: "renamed-by-an-unauthorized-actor"
    });
    expect(res.statusCode).toBe(403);
    // And the refusal is REAL, not merely a status: the peer is untouched.
    const peer = await admin.federation.getPeer(outpostPeerId);
    expect(peer.name).not.toBe("renamed-by-an-unauthorized-actor");
  });

  it("POST /v1/federation/outposts — 403 without federation:write", async () => {
    const otherPeer = randomUUID();
    await admin.federation.pair({
      domainId: otherPeer,
      name: `outpost-${otherPeer.slice(0, 8)}`,
      role: "outpost",
      publicKey: publicKeyB64()
    });
    const res = await asActor(operator, "POST", "/api/v1/federation/outposts", {
      peerDomainId: otherPeer,
      trustTier: "il5"
    });
    expect(res.statusCode).toBe(403);
    // Nothing was declared — the 403 fired BEFORE the write, not after it.
    const configs = await admin.federation.listOutposts();
    expect(configs.some((c) => c.peerDomainId === otherPeer)).toBe(false);
  });

  it("GET /v1/federation/outposts — 403 — the org-root scope check fires", async () => {
    const res = await asActor(selfScoped, "GET", "/api/v1/federation/outposts");
    expect(res.statusCode).toBe(403);
  });

  it("GET /v1/federation/outposts/{peerDomainId} — 403 — the org-root scope check fires", async () => {
    const res = await asActor(selfScoped, "GET", `/api/v1/federation/outposts/${outpostPeerId}`);
    expect(res.statusCode).toBe(403);
  });

  it("PATCH /v1/federation/outposts/{peerDomainId} — 403 without federation:write", async () => {
    const res = await asActor(operator, "PATCH", `/api/v1/federation/outposts/${outpostPeerId}`, {
      trustTier: "commercial"
    });
    expect(res.statusCode).toBe(403);
    const config = await admin.federation.getOutpost(outpostPeerId);
    expect(config.trustTier).toBe("govcloud");
  });

  it("POST /v1/federation/outposts/{peerDomainId}/reconcile — 403 without federation:write", async () => {
    const res = await asActor(
      operator,
      "POST",
      `/api/v1/federation/outposts/${outpostPeerId}/reconcile`,
      {}
    );
    expect(res.statusCode).toBe(403);
  });

  it("the SIDE DOORS stay closed for the same actor — an `object:write` holder cannot reach `outpost` rows through the generic endpoints either", async () => {
    // This is the other half of the E1 argument: `federation:write` on the real routes is only
    // meaningful if the weaker-permission doors refuse the type outright.
    for (const [method, url] of [
      ["POST", "/api/v1/objects/outpost"],
      ["PATCH", `/api/v1/objects/outpost/${outpostPeerId}`],
      ["PUT", `/api/v1/objects/outpost/urn:scp:x:outpost:y`],
      ["DELETE", `/api/v1/objects/outpost/${outpostPeerId}`]
    ] as const) {
      const res = await server.app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${operator.token}` },
        ...(method === "DELETE"
          ? {}
          : { payload: { name: "side-door", properties: { peerDomainId: outpostPeerId } } })
      });
      expect(res.statusCode).toBe(403);
    }
  });
});
