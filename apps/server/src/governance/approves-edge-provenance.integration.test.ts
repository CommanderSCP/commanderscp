import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import pg from "pg";
import { withTenantTx } from "../db/tenant-tx.js";
import { federationSelf, relationships } from "../db/schema.js";
import { createObject, deleteObject } from "../graph/objects-repo.js";
import { materializeApprovalRequest } from "./approvals-repo.js";
import {
  buildTestServer,
  createTestOrg,
  createTestUser,
  testDatabaseUrl,
  type TestOrg,
  type TestServer,
  type TestUser
} from "../test-support/harness.js";

/**
 * ================================================================================================
 * THE `approves` EDGE'S FEDERATION PROVENANCE — the org id is not a domain id
 * ================================================================================================
 *
 * `castApprovalVote` stamped `relationships.origin_domain_id` with the ORG id, where every other
 * writer of that column stamps `federation_self.domain_id` — a uuid MINTED per org, unrelated to
 * `org_id`. The edge therefore claimed an origin domain present in no `federation_self` row.
 *
 * The damage is LOCAL as well as federated, which is why this file asserts the cascade and not
 * only the column: `graph/objects-repo.ts`'s `deleteObject` tombstones touching edges under
 * `origin_domain_id = self.domain_id`, so the `approves` edge missed the filter and survived the
 * deletion of its own endpoint — live, dangling, forever.
 *
 * Two halves, because the defect has two populations: rows written from now on (the code fix) and
 * rows already on disk (drizzle/0110). The second is exercised by re-running the migration's own
 * SQL against a row put back into the broken state — the file on disk is the fixture, so a future
 * edit to that SQL is measured rather than assumed.
 */
describe("the `approves` edge is stamped with this domain's minted domain id", () => {
  let server: TestServer;
  let org: TestOrg;
  let approver: TestUser;
  let changeId: string;
  let componentId: string;
  let admin: pg.Client;

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  /** The repair migration verbatim — read from disk so the test measures the shipped SQL. */
  function repairSql(): string {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    return readFileSync(
      path.join(dir, "..", "..", "drizzle", "0110_approves_edge_origin_domain_repair.sql"),
      "utf8"
    );
  }

  async function selfDomainId(): Promise<string> {
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ domainId: federationSelf.domainId })
        .from(federationSelf)
        .where(eq(federationSelf.orgId, org.orgId))
    );
    expect(rows).toHaveLength(1);
    return rows[0]!.domainId;
  }

  async function approvesEdge() {
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({
          id: relationships.id,
          originDomainId: relationships.originDomainId,
          deletedAt: relationships.deletedAt
        })
        .from(relationships)
        .where(and(eq(relationships.orgId, org.orgId), eq(relationships.typeId, "approves")))
    );
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "approves-provenance");
    // Superuser: the repair migration is a cross-org `UPDATE ... FROM federation_self`, and it runs
    // in production as the bootstrap role that bypasses RLS. Running it through a tenant tx would
    // measure the RLS predicate instead of the migration.
    admin = new pg.Client({ connectionString: testDatabaseUrl() });
    await admin.connect();

    approver = await createTestUser(server, org, [{ role: "Approver", scope: org.orgId }]);

    componentId = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const component = await createObject(tx, {
        orgId: org.orgId,
        typeId: "component",
        actorObjectId: org.orgId,
        requestId: "approves-provenance-setup",
        name: `comp-${Math.random().toString(36).slice(2, 8)}`
      });
      return component.id;
    });

    const change = await server.app.inject({
      method: "POST",
      url: "/api/v1/changes",
      headers: bearer(org.adminToken),
      payload: { name: `approves-provenance-${Date.now()}`, targets: [componentId] }
    });
    expect(change.statusCode, change.body).toBe(201);
    changeId = change.json().id;

    // Materialized directly rather than through a policy evaluation: what is under test is the
    // edge the VOTE writes, and a policy would only add scaffolding between the two.
    const request = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      materializeApprovalRequest(tx, {
        orgId: org.orgId,
        changeObjectId: changeId,
        policyObjectId: componentId,
        policyVersion: 1,
        effectIndex: 0,
        requiredCount: 1,
        fromRole: "Approver",
        scopeObjectId: org.orgId
      })
    );

    const vote = await server.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${request.id}/votes`,
      headers: bearer(approver.token),
      payload: {}
    });
    expect(vote.statusCode, vote.body).toBe(201);
  });

  afterAll(async () => {
    await admin?.end();
    await server?.close();
  });

  it("stamps `federation_self.domain_id`, not the org id", async () => {
    const edge = await approvesEdge();
    expect(edge.originDomainId).toBe(await selfDomainId());
    // Stated separately because it is the whole defect: the two values are different uuids, and a
    // fix that made them equal by accident would still be wrong.
    expect(edge.originDomainId).not.toBe(org.orgId);
  });

  it("the local delete cascade reaches the edge — the consequence that is not about federation", async () => {
    // `deleteObject` tombstones touching edges under `origin_domain_id = self.domain_id`. With the
    // org id stamped, this edge stayed live after its own endpoint was deleted. Driven at the repo
    // rather than through `DELETE /objects/:id`, which does not serve the `change` type (a change
    // is cancelled through its own route, and cancelling is not a tombstone).
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      deleteObject(tx, {
        orgId: org.orgId,
        typeId: "change",
        actorObjectId: org.orgId,
        requestId: "approves-provenance-cascade",
        idOrUrn: changeId
      })
    );
    expect((await approvesEdge()).deletedAt).not.toBeNull();
  });

  // LAST, and that ordering is load-bearing: this case puts the row BACK into the broken state, so
  // running it before the two above would repair the fixture they measure and make them green
  // whatever the code does. The tombstone the cascade case leaves behind is irrelevant here — the
  // migration's predicate is about provenance, not liveness.
  it("drizzle/0110 repairs a row already written with the org id", async () => {
    const edge = await approvesEdge();
    // Back to the pre-fix state, as the shipped rows on disk actually are.
    await admin.query("UPDATE relationships SET origin_domain_id = org_id WHERE id = $1", [
      edge.id
    ]);
    expect((await approvesEdge()).originDomainId).toBe(org.orgId);

    await admin.query(repairSql());

    expect((await approvesEdge()).originDomainId).toBe(await selfDomainId());
  });
});
