import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import { withTenantTx } from "../db/tenant-tx.js";
import { matchPoliciesForTargets } from "./policy-resolve.js";
import {
  createOrphanComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/** Service-scoped policy, with the authz half elsewhere. See docs/governance.md §428. */
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
    const comp = await createOrphanComponent(server, org, "ledger-api");
    const lone = await createOrphanComponent(server, org, "ledger-unassigned");
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

  it("PRECEDENCE: a service-scoped policy is more specific than an ORG-ROOT-scoped one", async () => {
    // The DAG hazard: the component's domain is reachable directly AND via its service. If the walk
    // kept the shorter path, the ancestor would rank too specific.
    // NOTE the honest scope of this test: it compares service vs the ORG ROOT. It does NOT prove
    // "service beats domain" in general — see the caveat test below and containmentChain's doc.
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

  it("KNOWN LIMIT: a component's OWN domain and its service TIE when the domains differ", async () => {
    // Documented in containmentChain. See docs/governance.md §429.
    const otherDomain = await admin.object("domain").create({ name: "other-domain" });
    const svcElsewhere = await admin.object("service").create({
      name: "svc-in-other-domain",
      domainId: otherDomain.id
    });
    const comp = await createOrphanComponent(server, org, "comp-in-root-domain");
    await admin.relationships.create({
      typeId: "contains",
      fromId: svcElsewhere.id,
      toId: comp.id
    });

    const domPolicy = await policyFor("tie-domain-policy", otherDomain.id);
    const svcPolicy = await policyFor("tie-service-policy", svcElsewhere.id);

    const matched = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      matchPoliciesForTargets(tx, {
        orgId: org.orgId,
        targetObjectIds: [comp.id],
        actorObjectId: actorId
      })
    );
    const dom = matched.find((m) => m.policyObjectId === domPolicy.id);
    const svc = matched.find((m) => m.policyObjectId === svcPolicy.id);
    // Both govern the component (that much IS guaranteed) ...
    expect(dom, "the service's domain still governs via the service hop").toBeDefined();
    expect(svc).toBeDefined();
    // ... and the service is at least as specific as that domain. `toBeGreaterThan` would be the
    // stronger claim, and it is exactly the one containmentChain does NOT make.
    expect(svc!.matchedAt.depth).toBeGreaterThanOrEqual(dom!.matchedAt.depth);
  });

  it("a soft-deleted `contains` edge stops the service policy governing the component", async () => {
    const comp = await createOrphanComponent(server, org, "ledger-temp");
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
