import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import { withTenantTx } from "../db/tenant-tx.js";
import { matchPoliciesForTargets } from "./policy-resolve.js";
import {
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * Service-scoped POLICY (model P2 — the authz half lives in authz/service-scope.integration.test.ts).
 *
 * This file's counterpart header, and DESIGN §10.1, have always said resolution walks
 * `org -> domain -> service -> component`. It didn't: `containmentChain` walked `objects.domain_id`
 * only, and components/services are siblings under a domain — so a service-scoped policy governed
 * NOTHING. Migration 0021's `contains` edge plus the two-route walk is what makes the documented
 * behaviour real, and this is the test that says so.
 *
 * The precedence case is the subtle one. With two routes the chain is a DAG, not a line: a
 * component's domain is reachable BOTH directly (component.domain_id) and via its service
 * (service.domain_id), at different depths. policy-model.ts sorts by depth DESC (deepest = most
 * specific wins), so picking the wrong depth for the domain would let a domain-scoped policy
 * outrank a service-scoped one — silently, and only for components that have a service.
 */
describe("policy resolution: service scope governs the service's components", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let svcId: string;
  let compId: string;
  let loneCompId: string;
  let actorId: string;

  const policyFor = (name: string, objectRef: string) =>
    admin.policies.create({
      name,
      properties: {
        scope: { objectRef },
        enforcement: "required",
        effects: [{ kind: "requireApproval", quorum: 1, role: "Approver" }]
      }
    });

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "svc-policy");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    actorId = org.orgId; // org root doubles as the actor object in the harness's admin context

    const svc = await admin.object("service").create({ name: "ledger" });
    const comp = await admin.object("component").create({ name: "ledger-api" });
    const lone = await admin.object("component").create({ name: "ledger-unassigned" });
    svcId = svc.id;
    compId = comp.id;
    loneCompId = lone.id;

    await admin.relationships.create({ typeId: "contains", fromId: svcId, toId: compId });
  });

  afterAll(async () => {
    await server?.close();
  });

  it("a policy scoped at the SERVICE matches a component inside it", async () => {
    const policy = await policyFor("ledger-service-policy", svcId);

    const matched = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      matchPoliciesForTargets(tx, {
        orgId: org.orgId,
        targetObjectIds: [compId],
        actorObjectId: actorId
      })
    );

    const hit = matched.find((m) => m.policyObjectId === policy.id);
    expect(hit, "a service-scoped policy must govern the service's components").toBeDefined();
    // It matched AT the service — the reason tree must say so, not claim it matched the component.
    expect(hit!.matchedAt.objectId).toBe(svcId);
    expect(hit!.matchedAt.via).toBe("objectRef");
  });

  it("does NOT match a component the service does not contain (the orphan-import case)", async () => {
    const matched = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      matchPoliciesForTargets(tx, {
        orgId: org.orgId,
        targetObjectIds: [loneCompId],
        actorObjectId: actorId
      })
    );
    expect(matched.find((m) => m.name === "ledger-service-policy")).toBeUndefined();
  });

  it("PRECEDENCE: a service-scoped policy is MORE specific than a domain-scoped one", async () => {
    // The DAG hazard: the component's domain is reachable directly AND via its service. If the walk
    // kept the shorter path for the domain, the domain would tie or outrank the service.
    const domainPolicy = await policyFor("domain-wide-policy", org.orgId);
    const svcPolicy = await policyFor("service-specific-policy", svcId);

    const matched = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      matchPoliciesForTargets(tx, {
        orgId: org.orgId,
        targetObjectIds: [compId],
        actorObjectId: actorId
      })
    );

    const dom = matched.find((m) => m.policyObjectId === domainPolicy.id);
    const svc = matched.find((m) => m.policyObjectId === svcPolicy.id);
    expect(dom, "the org/domain-scoped policy should still match").toBeDefined();
    expect(svc, "the service-scoped policy should match").toBeDefined();
    // Deeper = more specific = wins (policy-model.ts sorts by matchedAt.depth DESC).
    expect(svc!.matchedAt.depth).toBeGreaterThan(dom!.matchedAt.depth);
  });

  it("a soft-deleted `contains` edge stops the service policy governing the component", async () => {
    const comp = await admin.object("component").create({ name: "ledger-temp" });
    const edge = await admin.relationships.create({
      typeId: "contains",
      fromId: svcId,
      toId: comp.id
    });
    await policyFor("ledger-detach-policy", svcId);

    const before = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      matchPoliciesForTargets(tx, {
        orgId: org.orgId,
        targetObjectIds: [comp.id],
        actorObjectId: actorId
      })
    );
    expect(before.find((m) => m.name === "ledger-detach-policy")).toBeDefined();

    await admin.relationships.delete(edge.id);

    const after = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      matchPoliciesForTargets(tx, {
        orgId: org.orgId,
        targetObjectIds: [comp.id],
        actorObjectId: actorId
      })
    );
    expect(
      after.find((m) => m.name === "ledger-detach-policy"),
      "a deleted edge must stop conferring governance — the walk filters deleted_at IS NULL"
    ).toBeUndefined();
  });
});
