import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { objects } from "../db/schema.js";
import { withTenantTx } from "../db/tenant-tx.js";
import {
  buildTestServer,
  createTestOrg,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";

/**
 * THE VALIDATION HALF OF A `domain_id` WRITE — "does this id still name a LIVE object in this org?"
 *
 * `graph/containment-parent-authz.ts` owns the AUTHORIZATION half of a containment-parent move and
 * says so at length. Its own module doc named the other half and assigned it to the repo — this is
 * what it said BEFORE this file existed, quoted because the gap is exactly the gap between the
 * sentence and the code:
 *
 *   > What the repo owns is the invariant half: `resolveContainmentParent` (called from here) is
 *   > what rejects a `domainId` naming an object outside the org, and `createObject` still resolves
 *   > the default parent for itself.
 *
 * `createObject` does exactly that (`objects-repo.ts`, `resolveContainmentParent` on line 1 of its
 * body). `updateObject` did NOT. Its `domain_id` write was
 *
 *     const nextDomainId = input.domainId === undefined ? existing.domainId : input.domainId;
 *
 * — the caller's value, straight onto the column. Every guard that ran afterwards asked a different
 * question, and the one that looks closest is the one that made this hard to see:
 * `assertRootedContainmentParent` walks `containmentChain(parentId)`, and that walk **deliberately
 * does not filter `deleted_at` on its seed row** ("the TARGET itself is not filtered — governance may
 * legitimately be evaluated over a deleted object"). So a TOMBSTONED parent whose own ancestors are
 * alive seeds the walk, reaches the org root through them, and is pronounced rooted. The refusal
 * that exists for precisely this value — `resolveContainmentParent`'s `deleted_at IS NULL` filter,
 * whose comment records the incident it was installed for — never ran on the update path at all.
 *
 * ## Why that is the unrecoverable state, not a cosmetic one
 *
 * `authz/resolve.ts`'s `scopeExpandCte` joins `parent_o.deleted_at IS NULL` on every hop. A row
 * parented under a tombstone therefore has its scope expansion terminate at itself: no ancestor
 * binding, **not even the org root Owner's**, reaches it again. It cannot be read, edited, moved
 * back or deleted through the API by anyone, while governance keeps matching it (policy matching
 * reads `properties.scope`, never placement). That is byte-for-byte the state
 * `resolveContainmentParent`'s comment measured — `DELETE /domains/{d}` then
 * `PATCH /services/{s} {domainId: d}` answering 200 — reached here through a different door.
 *
 * ## Which door, and why the HTTP doors alone were not the whole story
 *
 * Every HTTP door calls `resolveDeclaredContainmentParent`, which calls `resolveContainmentParent`,
 * so the doors were closed. **IaC apply is not a door in that sense.** `POST /plans` resolves the
 * manifest's `domainId` ONCE, at plan-compute time, and PERSISTS the resolved value in the plan's
 * diff; `POST /plans/{id}/apply` — a separate request, arbitrarily later — replays that stored value
 * through `updateObject` without ever calling the helper. Soft-delete the parent in between and the
 * stale pointer is written. That asymmetry is the whole defect: `createObject` re-validates at APPLY
 * time (it calls `resolveContainmentParent` itself), so the same TOCTOU on the CREATE branch is
 * already refused, and only the UPDATE branch was open. `containment-root-source-and-create-rooting`
 * pins the create half; this file pins the update half.
 *
 * ## Installation, and how it is proved
 *
 * Deleting the `resolveContainmentParent` call from `updateObject` must make the first test below
 * fail. It asserts the ROW, not the status code: an unreachable row is exactly the one a read API
 * would hide, so "the GET 403s" would pass whether or not the write landed.
 */
describe("updateObject validates that a new containment parent is still live", () => {
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

  /** Read straight from the table. The whole failure mode is a row no read API will show. */
  async function domainIdOf(org: TestOrg, objectId: string): Promise<string | null | undefined> {
    return withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const row = await tx.query.objects.findFirst({
        where: and(eq(objects.orgId, org.orgId), eq(objects.id, objectId))
      });
      return row?.domainId;
    });
  }

  interface Fixture {
    org: TestOrg;
    /** The service the manifest re-parents. Starts at the org root. */
    serviceId: string;
    serviceUrn: string;
    serviceName: string;
    domainId: string;
    planId: string;
  }

  /**
   * Builds the TOCTOU: a plan whose stored diff re-parents `service` under `domain`, computed while
   * `domain` is alive. The caller decides whether to tombstone it before applying.
   */
  async function makePlannedMove(label: string): Promise<Fixture> {
    const org = await createTestOrg(server, label);

    const domain = await post(org.adminToken, "/api/v1/domains", { name: `${label}-domain` });
    expect(domain.status, domain.body).toBe(201);
    const domainId = domain.json().id as string;

    const serviceName = `${label}-service`;
    const service = await post(org.adminToken, "/api/v1/services", { name: serviceName });
    expect(service.status, service.body).toBe(201);
    const serviceId = service.json().id as string;
    const serviceUrn = service.json().urn as string;

    // The ordinary create lands the row at the org root — the shape most rows have.
    expect(await domainIdOf(org, serviceId)).toBe(org.orgId);

    const plan = await post(org.adminToken, "/api/v1/plans", {
      manifest: {
        stackName: `${label}-stack`,
        objects: [
          { urn: serviceUrn, typeId: "service", name: serviceName, domainId },
          // Declared so the manifest does not prune it; irrelevant to the move itself.
          {
            urn: `urn:scp:${org.orgName}:domain:${label}-domain`,
            typeId: "domain",
            name: `${label}-domain`
          }
        ],
        relationships: []
      }
    });
    expect(plan.status, plan.body).toBe(201);

    // THE PREMISE, ASSERTED: the stored diff really does carry the resolved parent, so what apply
    // replays later is a pointer captured now rather than one it re-derives.
    expect(plan.body).toContain(domainId);

    return { org, serviceId, serviceUrn, serviceName, domainId, planId: plan.json().id as string };
  }

  async function applyPlan(
    token: string,
    planId: string
  ): Promise<{ status: number; body: string }> {
    const res = await server.app.inject({
      method: "POST",
      url: `/api/v1/plans/${planId}/apply`,
      headers: { authorization: `Bearer ${token}` }
    });
    return { status: res.statusCode, body: res.body };
  }

  async function deleteDomain(org: TestOrg, domainId: string): Promise<void> {
    const res = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/domains/${domainId}`,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    expect(res.statusCode, res.body).toBe(200);
  }

  it("POST /plans/{id}/apply refuses a stored move onto a parent soft-deleted since plan time", async () => {
    const f = await makePlannedMove("liveness-iac-toctou");

    // The window. Nothing about the plan changes; the graph underneath it does.
    await deleteDomain(f.org, f.domainId);

    const applied = await applyPlan(f.org.adminToken, f.planId);

    // Before the fix this answered 200. `assertRootedContainmentParent` did not catch it —
    // `containmentChain` seeds its walk with the tombstone itself and climbs to the org root through
    // the tombstone's live ancestors, so the dead parent is pronounced "rooted".
    expect(applied.status, applied.body).toBe(400);
    expect(applied.body).toContain(f.domainId);
    expect(applied.body).toContain("live object");

    // THE LOAD-BEARING ASSERTION — the ROW, not the status. The service must still be at the org
    // root, where it started.
    expect(await domainIdOf(f.org, f.serviceId)).toBe(f.org.orgId);

    // And it is still reachable, which is the property the whole guard exists to preserve: had the
    // write landed, this GET would answer 403 for the ORG-ROOT ADMIN, permanently.
    const readBack = await server.app.inject({
      method: "GET",
      url: `/api/v1/services/${f.serviceId}`,
      headers: { authorization: `Bearer ${f.org.adminToken}` }
    });
    expect(readBack.statusCode, readBack.body).toBe(200);
  });

  // -------------------------------------------------------------------------------------------
  // THE OTHER DIRECTION — a suite made of refusals cannot tell an over-broad guard from a correct
  // one, so the success case is as load-bearing as the refusal above.
  // -------------------------------------------------------------------------------------------

  it("the SAME apply, with the parent left alive, still performs the move", async () => {
    const f = await makePlannedMove("liveness-iac-control");

    const applied = await applyPlan(f.org.adminToken, f.planId);
    expect(applied.status, applied.body).toBe(200);

    expect(await domainIdOf(f.org, f.serviceId)).toBe(f.domainId);
  });

  it("an ordinary PATCH that never mentions domainId is untouched", async () => {
    // The guard is gated on an actual CHANGE of parent. This is the overwhelmingly common update
    // shape and it must cost nothing and refuse nothing.
    const org = await createTestOrg(server, "liveness-patch-noop");
    const service = await post(org.adminToken, "/api/v1/services", { name: "untouched" });
    expect(service.status, service.body).toBe(201);
    const serviceId = service.json().id as string;

    const patched = await server.app.inject({
      method: "PATCH",
      url: `/api/v1/services/${serviceId}`,
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: { name: "untouched-renamed" }
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(await domainIdOf(org, serviceId)).toBe(org.orgId);
  });

  // -------------------------------------------------------------------------------------------
  // THE DOOR HALF, PINNED. It was already closed (`resolveDeclaredContainmentParent` ->
  // `resolveContainmentParent`), and the repo-side guard must not be the only thing holding it —
  // if this ever starts depending on the repo check, the door regressed.
  // -------------------------------------------------------------------------------------------

  it("PATCH /services/{id} refuses a move onto a tombstoned parent at the door", async () => {
    const org = await createTestOrg(server, "liveness-http-door");
    const domain = await post(org.adminToken, "/api/v1/domains", { name: "door-domain" });
    expect(domain.status, domain.body).toBe(201);
    const domainId = domain.json().id as string;

    const service = await post(org.adminToken, "/api/v1/services", { name: "door-service" });
    expect(service.status, service.body).toBe(201);
    const serviceId = service.json().id as string;

    await deleteDomain(org, domainId);

    const patched = await server.app.inject({
      method: "PATCH",
      url: `/api/v1/services/${serviceId}`,
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: { domainId }
    });
    expect(patched.statusCode, patched.body).toBe(400);
    expect(await domainIdOf(org, serviceId)).toBe(org.orgId);
  });

  it("PATCH /services/{id} refuses a domainId that names nothing at all", async () => {
    const org = await createTestOrg(server, "liveness-http-missing");
    const service = await post(org.adminToken, "/api/v1/services", {
      name: "missing-parent-service"
    });
    expect(service.status, service.body).toBe(201);
    const serviceId = service.json().id as string;

    const patched = await server.app.inject({
      method: "PATCH",
      url: `/api/v1/services/${serviceId}`,
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: { domainId: "00000000-0000-4000-8000-000000000000" }
    });
    expect(patched.statusCode, patched.body).toBe(400);
    expect(await domainIdOf(org, serviceId)).toBe(org.orgId);
  });
});
