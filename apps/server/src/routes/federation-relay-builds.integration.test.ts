import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  buildTestServer,
  createTestOrg,
  createTestUser,
  type TestOrg,
  type TestServer,
  type TestUser
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import {
  claimRelayBuild,
  completeRelayBuild,
  exhaustRelayBuild,
  markRelayBuildForwarded,
  seedRelayBuild
} from "../federation/relay-builds-repo.js";

/**
 * M13.1b — the OPERATOR READ SURFACE for the auto-relay build ledger (owner ask: see queue depth
 * and exhausted rows without DB surgery). HTTP-level, per the delete-the-wiring rule: every
 * assertion here goes through `GET /api/v1/federation/relay-builds` via `server.app.inject`, never
 * `listRelayBuilds` called directly — a route that forgot its `authorize(...)` call, or a handler
 * that dropped the query params on the floor, would be invisible to a repo-level test and is
 * exactly what this file exists to catch.
 *
 * Fixture rows are seeded through the REAL writers (`seedRelayBuild` / `claimRelayBuild` /
 * `completeRelayBuild` / `exhaustRelayBuild` / `markRelayBuildForwarded`) — the ledger table has no
 * FK to `changes` (drizzle/0047's own header: "the ledger must survive independently of the change
 * row"), so a fixture-only `changeObjectId` is a legitimate row, not a shortcut around a
 * constraint. `updatedAt` is then pinned with a direct SQL nudge so the DESC-ordering assertion
 * does not depend on four transactions landing on four distinguishable wall-clock instants.
 */
describe("GET /federation/relay-builds — the auto-relay ledger's operator triage surface (Testcontainers)", () => {
  let server: TestServer;
  let org: TestOrg;
  let noPerms: TestUser;

  const pendingId = randomUUID();
  const builtId = randomUUID();
  const forwardedId = randomUUID();
  const exhaustedId = randomUUID();
  const sourceForPending = `src-${randomUUID()}`;
  const builtDecisionId = randomUUID();
  const forwardedDecisionId = randomUUID();
  const exhaustedDecisionId = randomUUID();
  const builtTarballPath = "/drop/scp-relay-built.tar.gz";
  const forwardedTarballPath = "/drop/scp-relay-forwarded.tar.gz";
  const exhaustReason = "artifact bytes absent from the source registry";

  /** Force a deterministic `updated_at` ordering across the four fixture rows — DESC order should
   *  come out exhausted, forwarded, built, pending (most recently "touched" first). */
  async function pinUpdatedAt(changeObjectId: string, secondsAgo: number): Promise<void> {
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.execute(sql`
        UPDATE federation_relay_builds
           SET updated_at = now() - (${secondsAgo} * interval '1 second')
         WHERE org_id = ${org.orgId} AND change_object_id = ${changeObjectId}
      `)
    );
  }

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "relay-builds-read");
    // A user with NO role bindings at all — authenticated, zero permissions (mirrors
    // federation-status-authz.integration.test.ts's isolated-org pattern for "lacks the read gate
    // entirely", the thing createTestUser's Owner-at-self actor does not witness: Owner carries
    // federation:read as a PERMISSION everywhere, just not at the org-root SCOPE this route checks).
    noPerms = await createTestUser(server, org, []);

    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      // pending — the bare causal seed, nothing else has happened to it yet.
      await seedRelayBuild(tx, {
        orgId: org.orgId,
        changeObjectId: pendingId,
        sourceChangeObjectId: sourceForPending
      });

      await seedRelayBuild(tx, {
        orgId: org.orgId,
        changeObjectId: builtId,
        sourceChangeObjectId: null
      });
      const builtClaim = await claimRelayBuild(tx, org.orgId, builtId, 3600);
      if (!builtClaim) throw new Error("expected the built fixture's claim to succeed");
      const completed = await completeRelayBuild(tx, org.orgId, builtClaim, {
        tarballPath: builtTarballPath,
        decisionId: builtDecisionId
      });
      if (!completed) throw new Error("expected the built fixture's release to succeed");

      // forwarded — the RECEIVING side's terminal state; its own writer upserts directly.
      await markRelayBuildForwarded(tx, {
        orgId: org.orgId,
        changeObjectId: forwardedId,
        sourceChangeObjectId: null,
        forwardedPath: forwardedTarballPath,
        decisionId: forwardedDecisionId
      });

      // exhausted — seed, claim, then the TERMINAL failure release.
      await seedRelayBuild(tx, {
        orgId: org.orgId,
        changeObjectId: exhaustedId,
        sourceChangeObjectId: null
      });
      const exhaustedClaim = await claimRelayBuild(tx, org.orgId, exhaustedId, 3600);
      if (!exhaustedClaim) throw new Error("expected the exhausted fixture's claim to succeed");
      const exhausted = await exhaustRelayBuild(tx, org.orgId, exhaustedClaim, {
        reason: exhaustReason,
        decisionId: exhaustedDecisionId
      });
      if (!exhausted) throw new Error("expected the exhausted fixture's release to succeed");
    });

    // Pin `updated_at` so DESC order is unambiguous: exhausted (newest) > forwarded > built > pending.
    await pinUpdatedAt(pendingId, 40);
    await pinUpdatedAt(builtId, 30);
    await pinUpdatedAt(forwardedId, 20);
    await pinUpdatedAt(exhaustedId, 10);
  }, 120_000);

  afterAll(async () => {
    await server?.close();
  });

  function get(url: string, token?: string) {
    return server.app.inject({
      method: "GET",
      url,
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {})
    });
  }

  it("401s with no bearer token at all", async () => {
    const res = await get("/api/v1/federation/relay-builds");
    expect(res.statusCode).toBe(401);
  });

  it("403s for an authenticated caller with no federation:read permission", async () => {
    const res = await get("/api/v1/federation/relay-builds", noPerms.token);
    expect(res.statusCode).toBe(403);
  });

  it("400s on a junk status value — refused by the zod enum, never reaches the repo", async () => {
    const res = await get(
      "/api/v1/federation/relay-builds?status=not-a-real-status",
      org.adminToken
    );
    expect(res.statusCode).toBe(400);
    const body = res.json() as { title: string; status: number };
    expect(body.status).toBe(400);
  });

  it("returns all four ledger states with every field, ordered by updatedAt DESC", async () => {
    const res = await get("/api/v1/federation/relay-builds", org.adminToken);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: Array<{
        changeObjectId: string;
        sourceChangeObjectId: string | null;
        status: string;
        attempts: number;
        failedAttempts: number;
        nextAttemptAt: string;
        claimedUntil: string | null;
        lastReason: string | null;
        lastDecisionId: string | null;
        tarballPath: string | null;
        createdAt: string;
        updatedAt: string;
      }>;
    };

    // ORDERING: exhausted, forwarded, built, pending — the pinned updatedAt DESC sequence.
    expect(body.items.map((i) => i.changeObjectId)).toEqual([
      exhaustedId,
      forwardedId,
      builtId,
      pendingId
    ]);

    const byId = new Map(body.items.map((i) => [i.changeObjectId, i]));

    expect(byId.get(pendingId)).toMatchObject({
      sourceChangeObjectId: sourceForPending,
      status: "pending",
      attempts: 0,
      failedAttempts: 0,
      claimedUntil: null,
      lastReason: null,
      lastDecisionId: null,
      tarballPath: null
    });

    expect(byId.get(builtId)).toMatchObject({
      sourceChangeObjectId: null,
      status: "built",
      attempts: 1,
      failedAttempts: 0,
      claimedUntil: null,
      lastReason: null,
      lastDecisionId: builtDecisionId,
      tarballPath: builtTarballPath
    });

    expect(byId.get(forwardedId)).toMatchObject({
      sourceChangeObjectId: null,
      status: "forwarded",
      attempts: 0,
      failedAttempts: 0,
      lastDecisionId: forwardedDecisionId,
      tarballPath: forwardedTarballPath
    });

    expect(byId.get(exhaustedId)).toMatchObject({
      sourceChangeObjectId: null,
      status: "exhausted",
      attempts: 1,
      failedAttempts: 1,
      claimedUntil: null,
      lastReason: exhaustReason,
      lastDecisionId: exhaustedDecisionId
    });

    // Every field the schema promises is present (not merely `toMatchObject`-subset-checked) on at
    // least one row — proves the route doesn't silently drop a column on the way out.
    for (const key of [
      "changeObjectId",
      "sourceChangeObjectId",
      "status",
      "attempts",
      "failedAttempts",
      "nextAttemptAt",
      "claimedUntil",
      "lastReason",
      "lastDecisionId",
      "tarballPath",
      "createdAt",
      "updatedAt"
    ]) {
      expect(byId.get(exhaustedId)).toHaveProperty(key);
    }
  });

  it("the status filter returns only matching rows", async () => {
    const res = await get("/api/v1/federation/relay-builds?status=exhausted", org.adminToken);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ changeObjectId: string; status: string }> };
    expect(body.items.map((i) => i.changeObjectId)).toEqual([exhaustedId]);
    expect(body.items.every((i) => i.status === "exhausted")).toBe(true);
  });

  it("limit bounds the result count, keeping the most-recently-updated rows first", async () => {
    const res = await get("/api/v1/federation/relay-builds?limit=2", org.adminToken);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ changeObjectId: string }> };
    expect(body.items.map((i) => i.changeObjectId)).toEqual([exhaustedId, forwardedId]);
  });
});
