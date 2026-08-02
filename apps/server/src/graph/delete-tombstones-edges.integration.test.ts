import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull, or } from "drizzle-orm";
import { ScpClient } from "@scp/sdk";
import { asTrustDomainId } from "@scp/schemas";
import {
  createOrphanComponent,
  createTestOrg,
  createTestUser,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { relationships } from "../db/schema.js";
import { containmentChain } from "./containment.js";
import { hasPermission } from "../authz/resolve.js";

/**
 * AN OBJECT'S EDGES MUST NOT OUTLIVE THE OBJECT — AND A DELETED ANCESTOR MUST NOT GOVERN.
 *
 * ============================================================================================
 * THE PROPERTY, AND HOW IT WAS FOUND
 * ============================================================================================
 * `deleteObject` tombstoned the object ROW alone. Every `relationships` row touching it kept
 * `deleted_at IS NULL` — a live edge to a dead node.
 *
 * Measured on the live homelab (2026-08-02) during the ADR-0026 §6 pair merge: soft-deleting one
 * absorbed component took the estate from 0 dangling `contains` edges to 1, and it had to be removed
 * by hand. §6's own verification list demands "the absorbed component is soft-deleted with no live
 * `contains` edge", which says the hazard was anticipated and never enforced anywhere in code.
 *
 * It is not tidiness. The containment walk is BUILT from those edges and filtered only on the EDGE's
 * `deleted_at`, so a dangling edge keeps a deleted service on a live component's chain — and that
 * chain is what `matchPoliciesForTargets`, `containmentScopeIds` for freezes and `authz/resolve.ts`
 * both read.
 *
 * ============================================================================================
 * WHY THE FIX HAS TWO HALVES, AND WHY NEITHER IS SUFFICIENT ALONE
 * ============================================================================================
 *   the CASCADE (objects-repo) — stops NEW dangling edges. It cannot be complete: it refuses REPLICA
 *                                edges, because single-writer authority for those belongs to another
 *                                domain, and it obviously cannot fix rows already in a database.
 *   the FILTER (containment +   — makes a deleted ancestor stop governing regardless of why its edge
 *   authz)                       is still live. This is what covers the two cases the cascade can't.
 *
 * A fix that shipped only the cascade would read as complete and leave both gaps.
 *
 * ============================================================================================
 * MUTATION LOG (each applied ALONE against a passing suite, then reverted)
 * ============================================================================================
 * | Mutation | Result |
 * |---|---|
 * | `objects-repo.ts`: drop the cascade block | the dangling-edge test FAILS (1 live edge to a dead node, exactly what was measured live) |
 * | `containment.ts`: drop `svc.deleted_at IS NULL` from route 2 | the deleted-service-still-governs test FAILS — the policy fires from a dead scope |
 * | `authz/resolve.ts`: drop the `parent_o.deleted_at IS NULL` join | the deleted-service-still-grants test FAILS — a role bound at a dead service still authorizes writes |
 * | `objects-repo.ts`: cascade WITHOUT the `originDomainId = self` filter | the replica-edge test FAILS with a single-writer conflict, taking the whole delete down with it |
 */
describe("deleting an object tombstones its edges, and a deleted ancestor stops governing", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "delete-cascade");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  /** A service containing one component — the exact shape the live estate had. */
  async function servicedComponent(label: string) {
    const component = await createOrphanComponent(admin, `${label}-comp`);
    const service = await admin.object("service").create({ name: `${label}-svc` });
    await admin.relationships.create({
      typeId: "contains",
      fromId: service.id,
      toId: component.id
    });
    return { component, service };
  }

  /** Live edges touching `objectId` in either direction. */
  async function liveEdgesTouching(objectId: string) {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ id: relationships.id, typeId: relationships.typeId })
        .from(relationships)
        .where(
          and(
            eq(relationships.orgId, org.orgId),
            isNull(relationships.deletedAt),
            or(eq(relationships.fromId, objectId), eq(relationships.toId, objectId))
          )
        )
    );
  }

  /**
   * Re-opens the edge the cascade just tombstoned, producing a LIVE `contains` row whose `from_id`
   * is a deleted object — the state a replica edge, or any row predating this fix, is already in.
   *
   * It has to be surgery: `POST /relationships` refuses an endpoint that is deleted (400), which is
   * itself the right behaviour and is why this state cannot be reached through the API. The write
   * runs in its OWN committed transaction and is then READ BACK, because a fixture that silently
   * updates zero rows leaves the test measuring the fixed state and passing for the wrong reason.
   */
  async function reopenEdge(fromId: string, toId: string) {
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(relationships)
        .set({ deletedAt: null })
        .where(
          and(
            eq(relationships.orgId, org.orgId),
            eq(relationships.fromId, fromId),
            eq(relationships.toId, toId)
          )
        )
    );
    const live = await liveEdgesTouching(toId);
    expect(
      live.length,
      "fixture must actually take effect — a no-op surgery would fake a pass"
    ).toBeGreaterThan(0);
  }

  const gatingPolicy = (name: string, objectRef: string) =>
    admin.policies.create({
      name,
      properties: {
        scope: { objectRef },
        enforcement: "required",
        effects: [{ requireApprovals: { count: 1, fromRole: "Approver", scope: "organization" } }]
      }
    });

  it("soft-deleting a component leaves NO live edge pointing at it", async () => {
    const { component } = await servicedComponent("cascade");
    expect(
      await liveEdgesTouching(component.id),
      "precondition: the contains edge exists"
    ).toHaveLength(1);

    await admin.components.delete(component.id);

    expect(
      await liveEdgesTouching(component.id),
      "this is the exact measurement taken on the live estate: before the fix the delete left the service's `contains` edge live, pointing at a dead node"
    ).toHaveLength(0);
  });

  it("soft-deleting the SERVICE tombstones the same edge from the other side", async () => {
    // The cascade matches `from_id` OR `to_id`; a fix that only handled one direction would leave
    // every component pointing at a dead service.
    const { service, component } = await servicedComponent("cascade-svc");

    await admin.object("service").delete(service.id);

    expect(await liveEdgesTouching(service.id)).toHaveLength(0);
    expect(
      await liveEdgesTouching(component.id),
      "the surviving component must not keep an edge to a deleted service either — it is the same row"
    ).toHaveLength(0);
  });

  it("a policy scoped at a DELETED service stops gating its live component", async () => {
    // The reader-side half. Proved by forcing the state the cascade cannot reach: the edge is
    // restored underneath after the delete, standing in for a replica edge or a pre-existing row.
    const { service, component } = await servicedComponent("dead-scope");
    await gatingPolicy("dead-scope-gate", service.id);

    // Control: while the service lives, its policy gates the component.
    let chain = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      containmentChain(tx, org.orgId, component.id)
    );
    expect(chain.map((c) => c.id)).toContain(service.id);

    await admin.object("service").delete(service.id);
    await reopenEdge(service.id, component.id);

    chain = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      containmentChain(tx, org.orgId, component.id)
    );
    expect(
      chain.map((c) => c.id),
      "a deleted service must not stay on a live component's chain — everything scoped at it would go on governing"
    ).not.toContain(service.id);
  });

  it("a role bound at a DELETED service stops granting over its live component", async () => {
    const { service, component } = await servicedComponent("dead-authz");
    const operator = await createTestUser(server, org, [{ role: "Operator", scope: service.id }]);

    const before = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      hasPermission(tx, {
        orgId: org.orgId,
        subjectObjectId: operator.objectId,
        permission: "object:write",
        scopeObjectId: component.id
      })
    );
    expect(before, "precondition: a service-scoped role reaches its components").toBe(true);

    await admin.object("service").delete(service.id);
    await reopenEdge(service.id, component.id);

    const after = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      hasPermission(tx, {
        orgId: org.orgId,
        subjectObjectId: operator.objectId,
        permission: "object:write",
        scopeObjectId: component.id
      })
    );
    expect(
      after,
      "authority must track containment: a binding at a deleted scope is a privilege that should have gone away"
    ).toBe(false);
  });

  it("the delete still succeeds when an edge belongs to ANOTHER domain", async () => {
    // Single-writer authority: `deleteRelationship` refuses a replica edge outright. If the cascade
    // did not filter on ownership it would throw mid-delete and take the whole operation down —
    // turning a tidy-up into an outage for any object touched by a federated edge.
    const { component, service } = await servicedComponent("replica-edge");
    const foreignDomain = asTrustDomainId("019f0000-0000-7000-8000-000000000abc");
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(relationships)
        .set({ originDomainId: foreignDomain })
        .where(
          and(
            eq(relationships.orgId, org.orgId),
            eq(relationships.fromId, service.id),
            eq(relationships.toId, component.id)
          )
        )
    );

    await expect(
      admin.components.delete(component.id),
      "a replica edge must be SKIPPED, not attempted — attempting it fails the whole delete"
    ).resolves.not.toThrow();

    // And the walk still refuses to let the (now deleted) component be governed through it.
    const edges = await liveEdgesTouching(component.id);
    expect(
      edges,
      "the foreign edge legitimately survives — this domain may not write it"
    ).toHaveLength(1);
  });
});
