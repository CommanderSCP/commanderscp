import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ContainmentDomainId } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import { auditEvents, decisions } from "../db/schema.js";
import { upsertObjectByUrn } from "../graph/objects-repo.js";
import { matchPoliciesForTargets } from "./policy-resolve.js";
import {
  GOVERNANCE_REACH_AUDIT_ACTION,
  GOVERNANCE_REACH_DECISION_KIND
} from "./governance-reach.js";
import {
  buildTestServer,
  createTestOrg,
  createTestUser,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";

/**
 * GOVERNANCE REACH IS TENANT-WRITABLE — and until this file, nothing recorded when it changed.
 *
 * The property (`governance/governance-reach.ts`): **the permission that changes what governance
 * REACHES is weaker than, and differently held from, the permission that AUTHORS governance.**
 * `Operator` holds `object:write` + `relationship:write`; `policy:write` belongs to `Administrator`
 * and `Owner` alone.
 *
 * ## This file drives REAL DOORS, deliberately
 *
 * The unit-testable half of this change is one map diff. What it cannot tell you is whether the
 * recorder RUNS — and "a component built, unit-tested green and never installed" is this repo's
 * dominant defect. So every case here goes through HTTP (`server.app.inject`) or through the repo
 * function a route calls, never through `recordGovernanceReachChange` directly.
 *
 * ## The four measured claims this file pins, two of which were wrong when first stated
 *
 *  - CLAIM (holds): `DELETE /relationships/{id}` authorizes `relationship:write` at BOTH endpoints,
 *    symmetric with create. An earlier reading that delete needed only `relationship:read` at the org
 *    was a misreading of the LIST handler. `CASE 2` pins the symmetry from the component side.
 *  - CLAIM (holds): a COMPONENT-scoped Operator cannot do this at all — authority expands strictly
 *    upward, so a component binding satisfies neither endpoint check at a service. `CASE 2`.
 *  - CLAIM (holds): route 1 (`objects.domain_id`) move-authorization is `feat/m21-7-authz-and-pr-url`'s
 *    and is not duplicated here. This file records reach for route 1; it authorizes nothing.
 *  - CLAIM (STALE when stated): "that branch adds no authorization to `relationships-repo.ts`". It
 *    now changes 96 lines there — but for CYCLES, not for governance reach, so the residual below is
 *    untouched by it either way.
 *
 * ## The residual this change addresses, stated exactly
 *
 * An actor holding `relationship:write` at a SERVICE OR BROADER — but no `policy:write` — can detach
 * a component from a governed service and re-attach it under an ungoverned one. Both endpoint checks
 * pass legitimately; that is an ordinary platform-team Operator. `CASE 1` proves the move still
 * succeeds (this change is detection, not prevention) AND that it is now recorded.
 */
describe("a containment write that changes which policies reach an object", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await buildTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  async function post(
    token: string,
    url: string,
    payload: Record<string, unknown>
  ): Promise<{ status: number; body: string; json: () => Record<string, unknown> }> {
    const res = await server.app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${token}` },
      payload
    });
    return { status: res.statusCode, body: res.body, json: () => res.json() };
  }

  /** A `required` policy scoped at one object — the shape whose silent disappearance is the harm. */
  async function seedPolicyAt(org: TestOrg, name: string, objectRef: string): Promise<string> {
    const res = await post(org.adminToken, "/api/v1/policies", {
      name,
      properties: {
        enforcement: "required",
        scope: { objectRef },
        effects: [{ requireApprovals: { count: 1, fromRole: "Owner", scope: "organization" } }]
      }
    });
    expect(res.status, res.body).toBe(201);
    return res.json().id as string;
  }

  /** Ground truth, read the way the ENGINE reads it — not from a route's opinion of it. */
  async function reachingPolicyNames(org: TestOrg, targetId: string): Promise<string[]> {
    const matched = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      matchPoliciesForTargets(tx, {
        orgId: org.orgId,
        targetObjectIds: [targetId],
        actorObjectId: org.orgId
      })
    );
    return [...new Set(matched.map((m) => m.name))].sort();
  }

  async function reachDecisionsFor(
    org: TestOrg,
    subjectId: string
  ): Promise<{ verdict: string; inputContext: Record<string, unknown>; reasonTree: Record<string, unknown> }[]> {
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(decisions)
        .where(
          and(
            eq(decisions.orgId, org.orgId),
            eq(decisions.kind, GOVERNANCE_REACH_DECISION_KIND),
            eq(decisions.subjectId, subjectId)
          )
        )
    );
    return rows.map((r) => ({
      verdict: r.verdict,
      inputContext: r.inputContext as Record<string, unknown>,
      reasonTree: r.reasonTree as Record<string, unknown>
    }));
  }

  async function reachAuditReasons(org: TestOrg, subjectId: string): Promise<string[]> {
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.orgId, org.orgId),
            eq(auditEvents.action, GOVERNANCE_REACH_AUDIT_ACTION),
            eq(auditEvents.subjectId, subjectId)
          )
        )
    );
    return rows.map((r) => r.reason ?? "");
  }

  /** The live `contains` edge id for a (service, component) pair, read through the real list door. */
  async function containsEdgeId(
    org: TestOrg,
    serviceId: string,
    componentId: string
  ): Promise<string> {
    const list = await server.app.inject({
      method: "GET",
      url: `/api/v1/relationships?typeId=contains&limit=100`,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    expect(list.statusCode, list.body).toBe(200);
    const edge = (
      list.json() as { items: { id: string; fromId: string; toId: string }[] }
    ).items.find((r) => r.toId === componentId && r.fromId === serviceId);
    expect(edge, `expected a contains edge ${serviceId} -> ${componentId}`).toBeDefined();
    return edge!.id;
  }

  /**
   * A component inside a governed service, plus an ungoverned service to move it to.
   * `contains` is `one_to_many` on the TO side (one service per component), so the escape is
   * necessarily delete-then-create rather than a second create.
   */
  async function seedEstate(label: string): Promise<{
    org: TestOrg;
    governedServiceId: string;
    ungovernedServiceId: string;
    componentId: string;
    edgeId: string;
    policyName: string;
  }> {
    const org = await createTestOrg(server, label);
    const governed = await post(org.adminToken, "/api/v1/services", { name: `${label}-governed` });
    expect(governed.status, governed.body).toBe(201);
    const ungoverned = await post(org.adminToken, "/api/v1/services", {
      name: `${label}-ungoverned`
    });
    expect(ungoverned.status, ungoverned.body).toBe(201);
    const governedServiceId = governed.json().id as string;
    const ungovernedServiceId = ungoverned.json().id as string;

    const policyName = `${label}-prod-gate`;
    await seedPolicyAt(org, policyName, governedServiceId);

    const component = await post(org.adminToken, "/api/v1/components", {
      name: `${label}-component`,
      service: governedServiceId
    });
    expect(component.status, component.body).toBe(201);
    const componentId = component.json().id as string;

    const edgeId = await containsEdgeId(org, governedServiceId, componentId);

    // The premise. If this fails, every assertion below is vacuous — the policy never reached.
    expect(await reachingPolicyNames(org, componentId)).toContain(policyName);

    return { org, governedServiceId, ungovernedServiceId, componentId, edgeId, policyName };
  }

  // ===========================================================================================
  // CASE 1 — ROUTE 2, the `contains` edge. THE RESIDUAL, end to end.
  // ===========================================================================================

  it("CASE 1: an Operator with relationship:write and NO policy:write moves a component out of a governed service — the move SUCCEEDS, and it is now recorded", async () => {
    const e = await seedEstate("reach-route2");

    // Authority at BOTH services and the component — an ordinary platform-team Operator, holding
    // every permission the two endpoint checks legitimately demand, and `policy:write` nowhere.
    const operator = await createTestUser(server, e.org, [
      { role: "Operator", scope: e.governedServiceId },
      { role: "Operator", scope: e.ungovernedServiceId },
      { role: "Operator", scope: e.componentId }
    ]);

    const detach = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/relationships/${e.edgeId}`,
      headers: { authorization: `Bearer ${operator.token}` }
    });
    // NOT a 403. This change is detection, not prevention — asserting the success is what keeps a
    // future prevention change from being mistaken for this one.
    expect(detach.statusCode, detach.body).toBe(200);

    const reattach = await post(operator.token, "/api/v1/relationships", {
      typeId: "contains",
      fromId: e.ungovernedServiceId,
      toId: e.componentId
    });
    expect(reattach.status, reattach.body).toBe(201);

    // THE HARM, measured through the engine's own matcher: the `required` gate no longer reaches.
    expect(await reachingPolicyNames(e.org, e.componentId)).not.toContain(e.policyName);

    // THE RECORD. Subject is the COMPONENT — the object whose governance changed, not the edge.
    const recorded = await reachDecisionsFor(e.org, e.componentId);
    const reduced = recorded.filter((d) => d.verdict === "reach_reduced");
    expect(reduced.length).toBeGreaterThan(0);
    expect(reduced[0]!.inputContext.route).toBe("contains");
    expect(JSON.stringify(reduced[0]!.reasonTree.lost)).toContain(e.policyName);

    // The audit event NAMES the policy, so the hash-chained log is readable without a join.
    const reasons = await reachAuditReasons(e.org, e.componentId);
    expect(reasons.join(" ")).toContain(e.policyName);
    expect(reasons.join(" ")).toContain("no longer governed by");
  });

  // ===========================================================================================
  // CASE 2 — the claim that a COMPONENT-scoped Operator cannot do this at all.
  // ===========================================================================================

  it("CASE 2: a COMPONENT-scoped Operator is refused at BOTH ends — authority expands upward, so a component binding reaches no service", async () => {
    const e = await seedEstate("reach-component-scoped");

    const narrow = await createTestUser(server, e.org, [
      { role: "Operator", scope: e.componentId }
    ]);

    const detach = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/relationships/${e.edgeId}`,
      headers: { authorization: `Bearer ${narrow.token}` }
    });
    expect(detach.statusCode, detach.body).toBe(403);

    const reattach = await post(narrow.token, "/api/v1/relationships", {
      typeId: "contains",
      fromId: e.ungovernedServiceId,
      toId: e.componentId
    });
    expect(reattach.status, reattach.body).toBe(403);

    // Unmoved and still governed — the refusal is real, not a 403 on a write that happened anyway.
    expect(await reachingPolicyNames(e.org, e.componentId)).toContain(e.policyName);
  });

  // ===========================================================================================
  // CASE 3 — ROUTE 1, `objects.domain_id`.
  // ===========================================================================================

  it("CASE 3: re-parenting via domainId is recorded, with the old and new parent named", async () => {
    const org = await createTestOrg(server, "reach-route1");
    const governed = await post(org.adminToken, "/api/v1/domains", { name: "route1-governed" });
    const other = await post(org.adminToken, "/api/v1/domains", { name: "route1-other" });
    expect(governed.status, governed.body).toBe(201);
    expect(other.status, other.body).toBe(201);
    const governedId = governed.json().id as string;
    const otherId = other.json().id as string;

    const policyName = "route1-prod-gate";
    await seedPolicyAt(org, policyName, governedId);

    const service = await post(org.adminToken, "/api/v1/services", {
      name: "route1-service",
      domainId: governedId
    });
    expect(service.status, service.body).toBe(201);
    const serviceId = service.json().id as string;
    expect(await reachingPolicyNames(org, serviceId)).toContain(policyName);

    const move = await server.app.inject({
      method: "PATCH",
      url: `/api/v1/services/${serviceId}`,
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: { domainId: otherId }
    });
    expect(move.statusCode, move.body).toBe(200);

    expect(await reachingPolicyNames(org, serviceId)).not.toContain(policyName);

    const recorded = await reachDecisionsFor(org, serviceId);
    const reduced = recorded.filter((d) => d.verdict === "reach_reduced");
    expect(reduced.length).toBe(1);
    expect(reduced[0]!.inputContext.route).toBe("domain_id");
    expect(reduced[0]!.inputContext.fromDomainId).toBe(governedId);
    expect(reduced[0]!.inputContext.toDomainId).toBe(otherId);
    expect(JSON.stringify(reduced[0]!.reasonTree.lost)).toContain(policyName);
  });

  it("CASE 3b: a write that does NOT change the parent records nothing — the recorder is off the ordinary write path", async () => {
    const org = await createTestOrg(server, "reach-route1-noop");
    const domain = await post(org.adminToken, "/api/v1/domains", { name: "noop-domain" });
    expect(domain.status, domain.body).toBe(201);
    const domainId = domain.json().id as string;
    await seedPolicyAt(org, "noop-gate", domainId);

    const service = await post(org.adminToken, "/api/v1/services", {
      name: "noop-service",
      domainId
    });
    expect(service.status, service.body).toBe(201);
    const serviceId = service.json().id as string;

    // A rename, and a PUT-style restatement of the parent it already has. Neither is a move.
    const rename = await server.app.inject({
      method: "PATCH",
      url: `/api/v1/services/${serviceId}`,
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: { name: "noop-service-renamed" }
    });
    expect(rename.statusCode, rename.body).toBe(200);
    const restate = await server.app.inject({
      method: "PATCH",
      url: `/api/v1/services/${serviceId}`,
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: { domainId }
    });
    expect(restate.statusCode, restate.body).toBe(200);

    expect(await reachDecisionsFor(org, serviceId)).toEqual([]);
  });

  // ===========================================================================================
  // CASE 4 — ROUTE 3, the door that writes NO containment field at all.
  // ===========================================================================================

  it("CASE 4: tombstoning a CONTAINER detaches everything beneath it, and that is recorded against the container", async () => {
    const org = await createTestOrg(server, "reach-route3");
    const domain = await post(org.adminToken, "/api/v1/domains", { name: "route3-domain" });
    expect(domain.status, domain.body).toBe(201);
    const domainId = domain.json().id as string;

    const policyName = "route3-prod-gate";
    await seedPolicyAt(org, policyName, domainId);

    const service = await post(org.adminToken, "/api/v1/services", {
      name: "route3-service",
      domainId
    });
    expect(service.status, service.body).toBe(201);
    const serviceId = service.json().id as string;
    expect(await reachingPolicyNames(org, serviceId)).toContain(policyName);

    const del = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/domains/${domainId}`,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    expect(del.statusCode, del.body).toBe(200);

    // THE HARM. The service's own `domain_id` still names the domain and nothing about the service
    // was written — but the containment walk skips a deleted ancestor, so the gate is gone.
    expect(await reachingPolicyNames(org, serviceId)).not.toContain(policyName);

    const recorded = await reachDecisionsFor(org, domainId);
    expect(recorded.length).toBe(1);
    expect(recorded[0]!.verdict).toBe("reach_reduced");
    expect(recorded[0]!.inputContext.route).toBe("container_deleted");
    expect(Number(recorded[0]!.inputContext.dependentCount)).toBeGreaterThan(0);
    expect(JSON.stringify(recorded[0]!.reasonTree.mayNoLongerReach)).toContain(policyName);

    const reasons = await reachAuditReasons(org, domainId);
    expect(reasons.join(" ")).toContain(policyName);
  });

  it("CASE 4b: deleting a LEAF records nothing — the dependent-count guard keeps ordinary deletes off this path", async () => {
    const org = await createTestOrg(server, "reach-route3-leaf");
    const domain = await post(org.adminToken, "/api/v1/domains", { name: "leaf-domain" });
    expect(domain.status, domain.body).toBe(201);
    const domainId = domain.json().id as string;
    await seedPolicyAt(org, "leaf-gate", domainId);

    const service = await post(org.adminToken, "/api/v1/services", {
      name: "leaf-service",
      domainId
    });
    expect(service.status, service.body).toBe(201);
    const serviceId = service.json().id as string;

    const del = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/services/${serviceId}`,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    expect(del.statusCode, del.body).toBe(200);

    expect(await reachDecisionsFor(org, serviceId)).toEqual([]);
  });

  // ===========================================================================================
  // CASE 5 — the tightening direction, so a suite made of refusals cannot hide an over-broad guard.
  // ===========================================================================================

  it("CASE 5: a move that ADDS governance is recorded as reach_extended, not as a loss", async () => {
    const e = await seedEstate("reach-extend");

    // A SECOND component, born UNgoverned, moved IN. Deliberately not the seeded component moved out
    // and back: `relationships_org_type_from_to_key` is not filtered on `deleted_at`, so re-creating
    // a soft-deleted (type, from, to) triple 409s. That is worth pinning here in a comment because it
    // is the same fact that makes the CASE 1 escape necessarily a move to a DIFFERENT container
    // rather than a detach-and-reattach in place.
    const moved = await post(e.org.adminToken, "/api/v1/components", {
      name: "reach-extend-mover",
      service: e.ungovernedServiceId
    });
    expect(moved.status, moved.body).toBe(201);
    const movedId = moved.json().id as string;
    expect(await reachingPolicyNames(e.org, movedId)).not.toContain(e.policyName);

    const edgeId = await containsEdgeId(e.org, e.ungovernedServiceId, movedId);
    const detach = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/relationships/${edgeId}`,
      headers: { authorization: `Bearer ${e.org.adminToken}` }
    });
    expect(detach.statusCode, detach.body).toBe(200);

    const attach = await post(e.org.adminToken, "/api/v1/relationships", {
      typeId: "contains",
      fromId: e.governedServiceId,
      toId: movedId
    });
    expect(attach.status, attach.body).toBe(201);

    const recorded = await reachDecisionsFor(e.org, movedId);
    const extended = recorded.filter((d) => d.verdict === "reach_extended");
    expect(extended.length).toBe(1);
    expect(JSON.stringify(extended[0]!.reasonTree.gained)).toContain(e.policyName);
    expect(await reachingPolicyNames(e.org, movedId)).toContain(e.policyName);
  });

  // ===========================================================================================
  // CASE 7 — ROUTE 1's SECOND WRITE SITE, which does not delegate to `updateObject`.
  // ===========================================================================================

  it("CASE 7: hand-fill reconciliation re-parents a shadow onto its authoritative id, and that is recorded too", async () => {
    const org = await createTestOrg(server, "reach-handfill");
    const governed = await post(org.adminToken, "/api/v1/domains", { name: "handfill-governed" });
    const other = await post(org.adminToken, "/api/v1/domains", { name: "handfill-other" });
    expect(governed.status, governed.body).toBe(201);
    expect(other.status, other.body).toBe(201);
    const governedId = governed.json().id as string;
    const otherId = other.json().id as string;

    const policyName = "handfill-prod-gate";
    await seedPolicyAt(org, policyName, governedId);

    // The peer's claimed authority. `upsertObjectByUrn` compares this against the stored row's
    // `origin_domain_id` and never resolves it, so a bare id is the whole of what the branch needs.
    const peerDomainId = randomUUID();
    const urn = `urn:scp:${org.orgName}:service:handfill-shadow`;

    // 1. The hand-filled shadow, exactly as `federation/handfill-repo.ts` writes one.
    const shadow = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      upsertObjectByUrn(tx, {
        orgId: org.orgId,
        typeId: "service",
        actorObjectId: org.orgId,
        requestId: "handfill-seed",
        urn,
        name: "handfill-shadow",
        domainId: governedId as ContainmentDomainId,
        properties: {},
        labels: {},
        federationImport: { originDomainId: peerDomainId, revision: 0, provenance: "manual" }
      })
    );
    expect(await reachingPolicyNames(org, shadow.object.id)).toContain(policyName);

    // 2. The real, signature-verified import arrives: a DIFFERENT authoritative id, and a different
    //    containment parent. This is the branch that writes `domain_id` without going through
    //    `updateObject` — the one an install census misses.
    const authoritativeId = randomUUID();
    const reconciled = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      upsertObjectByUrn(tx, {
        orgId: org.orgId,
        typeId: "service",
        actorObjectId: org.orgId,
        requestId: "handfill-reconcile",
        id: authoritativeId,
        urn,
        name: "handfill-shadow",
        domainId: otherId as ContainmentDomainId,
        properties: {},
        labels: {},
        federationImport: { originDomainId: peerDomainId, revision: 1, provenance: null }
      })
    );
    expect(reconciled.object.id).toBe(authoritativeId);
    expect(await reachingPolicyNames(org, authoritativeId)).not.toContain(policyName);

    // Recorded against the AUTHORITATIVE id — the one every later reference uses.
    const recorded = await reachDecisionsFor(org, authoritativeId);
    expect(recorded.length).toBe(1);
    expect(recorded[0]!.verdict).toBe("reach_reduced");
    expect(recorded[0]!.inputContext.handFillReconciliation).toBe(true);
    expect(recorded[0]!.inputContext.previousObjectId).toBe(shadow.object.id);
    expect(JSON.stringify(recorded[0]!.reasonTree.lost)).toContain(policyName);
  });

  it("CASE 6: a non-contains relationship write records nothing — the type guard keeps this off every other edge in the system", async () => {
    const e = await seedEstate("reach-other-edge");
    const target = await post(e.org.adminToken, "/api/v1/components", {
      name: "other-edge-dependency",
      service: e.ungovernedServiceId
    });
    expect(target.status, target.body).toBe(201);
    const targetId = target.json().id as string;

    const before = (await reachDecisionsFor(e.org, targetId)).length;
    const dep = await post(e.org.adminToken, "/api/v1/relationships", {
      typeId: "depends_on",
      fromId: e.componentId,
      toId: targetId
    });
    expect(dep.status, dep.body).toBe(201);
    expect((await reachDecisionsFor(e.org, targetId)).length).toBe(before);
  });
});
