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
import { objects, relationships } from "../db/schema.js";
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
   * Tombstones an object BELOW THE DOORS — a bare `deleted_at` write that runs no cascade and no
   * guard — leaving its `contains` edge LIVE with a dead `from_id`. That is the exact state a
   * replica row, or any row predating the container-delete guard, is already in.
   *
   * It has to be surgery since the 2026-08-18 owner ruling (ADR-0038 clause 5): `DELETE` on a
   * container that still has containment children answers 409 with the blockers named, so the
   * live-child-under-dead-ancestor shape can no longer be REACHED through any door — which is the
   * point of the guard, and why the reader-side pins below still matter: they are the
   * defence-in-depth for the legacy/imported population. The write runs in its OWN committed
   * transaction and is READ BACK, because a fixture that silently updates zero rows leaves the
   * test measuring the fixed state and passing for the wrong reason.
   */
  async function tombstoneBelowTheDoors(objectId: string) {
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(objects)
        .set({ deletedAt: new Date() })
        .where(and(eq(objects.orgId, org.orgId), eq(objects.id, objectId)))
    );
    const [row] = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ deletedAt: objects.deletedAt })
        .from(objects)
        .where(and(eq(objects.orgId, org.orgId), eq(objects.id, objectId)))
    );
    expect(
      row?.deletedAt,
      "fixture must actually take effect — a no-op surgery would fake a pass"
    ).not.toBeNull();
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

  it("soft-deleting an object tombstones the edge it is the FROM side of", async () => {
    // The cascade matches `from_id` OR `to_id`; a fix that only handled one direction would leave
    // every component pointing at a dead service. DELIBERATE FLIP (2026-08-18, ADR-0038 clause 5):
    // this case used to delete a service that still CONTAINED a component — the container-delete
    // guard now refuses exactly that (pinned below), so the from_id direction is pinned on a
    // non-containment edge instead: a childless service with a `depends_on` edge FROM it.
    const upstream = await admin.object("service").create({ name: `cascade-from-up` });
    const downstream = await admin.object("service").create({ name: `cascade-from-down` });
    await admin.relationships.create({
      typeId: "depends_on",
      fromId: upstream.id,
      toId: downstream.id
    });
    expect(await liveEdgesTouching(upstream.id), "precondition").toHaveLength(1);

    await admin.object("service").delete(upstream.id);

    expect(await liveEdgesTouching(upstream.id)).toHaveLength(0);
    expect(
      await liveEdgesTouching(downstream.id),
      "the surviving service must not keep an edge to a deleted one either — it is the same row"
    ).toHaveLength(0);
  });

  it("deleting a service that still CONTAINS a component is REFUSED with the blocker named", async () => {
    // The owner ruling of 2026-08-18 (ADR-0038 clause 5): a container with live containment
    // children refuses deletion on every route, before the tombstone — the alternative was this
    // very file's original fixture, a component left live under a dead service. The 409 names the
    // blocker so the remedy is in the message.
    const { service, component } = await servicedComponent("delete-refused");

    await expect(admin.object("service").delete(service.id)).rejects.toMatchObject({
      status: 409
    });

    // Both rows still live, edge intact — the refusal really was before the tombstone.
    expect(await liveEdgesTouching(service.id)).toHaveLength(1);
    const chain = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      containmentChain(tx, org.orgId, component.id)
    );
    expect(chain.map((c) => c.id)).toContain(service.id);
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

    // The dead-ancestor shape is planted below the doors — the container-delete guard (ADR-0038
    // clause 5) refuses the API route to it, which is pinned in its own case above.
    await tombstoneBelowTheDoors(service.id);

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

    // Planted below the doors, as above — the API route to a dead ancestor is closed.
    await tombstoneBelowTheDoors(service.id);

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
