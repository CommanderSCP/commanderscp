import { v7 as uuidv7 } from "uuid";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantTx } from "../db/tenant-tx.js";
import { countContainmentDependents } from "./governance-reach.js";
import {
  buildTestServer,
  createTestOrg,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";

/**
 * ================================================================================================
 * THE FOURTH COPY OF THE DOWNWARD WALK — found by property, not by shape (2026-08-26)
 * ================================================================================================
 *
 * `graph/containment.ts`'s header asserted the downward direction had EXACTLY ONE definition,
 * `containmentChildrenSql`, composed by the depth doors and by `authz/readable-scope.ts`. It was
 * false. `countContainmentDependents` was an independent hand-typed copy of the same three arms, and
 * `graph/objects-repo.ts`'s container-delete guard was a fifth. Both are ONE LEVEL rather than
 * recursive, which is exactly why a census run for `WITH RECURSIVE` — or for "the downward walk" —
 * returned two hits and concluded the claim was true. Censusing the PROPERTY ("code that enumerates
 * the rows contained by a given row") over each route's predicate returns four.
 *
 * AND THEY HAD DRIFTED, in two directions at once. This file pins both fixes, because both change
 * what counts as a dependent and one of them changes a WRITE DOOR's refusal.
 *
 * ------------------------------------------------------------------------------------------------
 * DRIFT 1 — arm 2 counted EDGES, not live children (it counted too MUCH)
 * ------------------------------------------------------------------------------------------------
 * The copy's route-2 sub-count read `relationships` alone and never joined the child object, while
 * the fragment joins `child_o.deleted_at IS NULL`. So a live `contains` edge to a TOMBSTONED child
 * counted as a dependent — contradicting the function's own first sentence, "how many LIVE objects".
 * `deleteObject`'s cascade cannot close that gap: it refuses REPLICA edges (single-writer authority)
 * and cannot retroactively fix rows already in a database.
 *
 * The observable cost was a FALSE governance record: `recordContainerDeletionReachChange` returns
 * early on `dependentCount === 0`, so a container whose only `contains` child was already gone still
 * wrote a Decision and a hash-chained audit event saying "detached 1 contained object(s)".
 *
 * ------------------------------------------------------------------------------------------------
 * DRIFT 2 — arm 3 compared RAW TEXT, not `uuid` (it counted too LITTLE), and so did the delete door
 * ------------------------------------------------------------------------------------------------
 * Measured, PostgreSQL 16:
 *
 *     '0191F1E2-…-AA'::uuid = '0191f1e2-…-aa'::uuid  ->  TRUE
 *     '0191F1E2-…-AA'       = '0191f1e2-…-aa'        ->  FALSE
 *
 * Every id compared here comes out of a `uuid` column, hence lower-case. So a placement whose
 * `componentId` was written as UPPER-CASE HEX was a PARENT on the way up (`placementParentsSql`
 * casts, because it must join `objects.id`) and NOT A CHILD on the way down — the two directions
 * disagreeing about which values count, which is the failure class the shared fragment exists to
 * end. `containment.ts`'s INDEX NOTE had already weighed the cast against migration 0051's text
 * index and chosen the cast; the two hand-typed copies had simply never been told.
 *
 * NOT reachable through `POST /placements` — `createPlacement` resolves both endpoints and writes
 * their own ids — so the rows are planted here with a direct `UPDATE`, the same "no API can write
 * this, which is the hazard" exception the past-the-bound and malformed-`effect` fixtures take. The
 * population is federation-imported and legacy rows, i.e. exactly the population
 * `placementEndpointParentSql`'s `CASE` guard was written for.
 *
 * ⚠️ BEHAVIOUR CHANGE TO A WRITE DOOR, pinned by "the delete door refuses it too" below: deleting a
 * component or deployment-target named by such a placement is now REFUSED (409) instead of answering
 * 200 and leaving the placement live and dangling. That is the guard's stated purpose, so the fix is
 * in its favour — but it is a refusal that did not exist yesterday and is called out rather than
 * folded in.
 *
 * ================================================================================================
 * MUTATION LOG — each mutation applied ALONE, run, reverted
 * ================================================================================================
 *  m1  `countContainmentDependents`: restore the hand-typed three-sub-count body
 *      → RED: "a live `contains` edge to a TOMBSTONED child is not a dependent"
 *        (`expected 1 to be 0`) and "an UPPER-CASE-HEX componentId is a dependent, as it is a
 *        parent" (`expected 0 to be 1`).
 *  m2  `placementNamesObjectSql`: `(… ->> 'componentId')::uuid` -> the raw text comparison
 *      → RED: both of the upper-case-hex cases, including the delete door's 409.
 *  m3  drop the `WHERE c.child_id <> …` self-exclusion
 *      → RED: "a self-parented legacy row is not its own dependent" (`expected 1 to be 0`).
 */
describe("countContainmentDependents composes the ONE downward fragment (census by property)", () => {
  let server: TestServer;
  let org: TestOrg;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "dependents-drift");
  }, 120_000);

  afterAll(async () => {
    await server?.close();
  });

  const uniq = (p: string): string => `${p}-${uuidv7().slice(0, 8)}`;

  async function call(
    method: "GET" | "POST" | "DELETE",
    url: string,
    payload?: Record<string, unknown>
  ): Promise<{ status: number; body: string; json: () => Record<string, unknown> }> {
    const res = await server.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${org.adminToken}` },
      ...(payload === undefined ? {} : { payload })
    });
    return { status: res.statusCode, body: res.body, json: () => res.json() };
  }

  const created = async (url: string, payload: Record<string, unknown>): Promise<string> => {
    const res = await call("POST", url, payload);
    expect(res.status, res.body).toBe(201);
    return res.json().id as string;
  };

  const dependentsOf = async (objectId: string): Promise<number> =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      countContainmentDependents(tx, org.orgId, objectId)
    );

  /** Raw SQL, because every one of these shapes is one no door will write. */
  const plant = async (statement: ReturnType<typeof sql>): Promise<void> => {
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await tx.execute(statement);
    });
  };

  it("a live `contains` edge to a TOMBSTONED child is not a dependent — the count says LIVE objects", async () => {
    const serviceId = await created("/api/v1/services", { name: uniq("drift-svc") });
    const componentId = await created("/api/v1/components", {
      name: uniq("drift-comp"),
      service: serviceId
    });

    // CONTROL: while the child is live it counts, so a 0 below cannot be the query matching nothing.
    expect(
      await dependentsOf(serviceId),
      "control: a live contained component is a dependent"
    ).toBe(1);

    // Tombstone the CHILD without touching the edge. `DELETE /components/{id}` would cascade the
    // edge and prove nothing; the rows this is about are the ones the cascade cannot reach — REPLICA
    // edges it refuses by design, and rows already in a database when it shipped.
    await plant(
      sql`UPDATE objects SET deleted_at = now() WHERE id = ${componentId} AND org_id = ${org.orgId}`
    );

    const liveEdges = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const rows = await tx.execute<{ n: string }>(
        sql`SELECT count(*) AS n FROM relationships
            WHERE org_id = ${org.orgId} AND type_id = 'contains'
              AND from_id = ${serviceId}::uuid AND deleted_at IS NULL`
      );
      return Number(rows.rows[0]?.n ?? 0);
    });
    expect(liveEdges, "the edge must still be LIVE, or this case measures nothing").toBe(1);

    expect(
      await dependentsOf(serviceId),
      "a dangling edge to a dead child is not a live object that would lose this parent"
    ).toBe(0);
  });

  it("an UPPER-CASE-HEX componentId is a dependent, exactly as it is already a containment PARENT", async () => {
    const serviceId = await created("/api/v1/services", { name: uniq("hex-svc") });
    const componentId = await created("/api/v1/components", {
      name: uniq("hex-comp"),
      service: serviceId
    });
    const targetId = await created("/api/v1/deployment-targets", { name: uniq("hex-target") });
    const placementId = await created("/api/v1/placements", {
      component: componentId,
      deploymentTarget: targetId
    });

    expect(await dependentsOf(componentId), "control: a live placement is a dependent").toBe(1);

    // The federated/legacy shape. `createPlacement` cannot write this — it persists the resolved
    // objects' own ids — so it is planted, exactly as a hostile or corrupt peer's `object_upsert`
    // would land it through `createObject`.
    await plant(
      sql`UPDATE objects
          SET properties = jsonb_set(properties, '{componentId}', to_jsonb(upper(${componentId}::text)))
          WHERE id = ${placementId} AND org_id = ${org.orgId}`
    );
    const stored = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const rows = await tx.execute<{ c: string }>(
        sql`SELECT properties ->> 'componentId' AS c FROM objects WHERE id = ${placementId}`
      );
      return rows.rows[0]?.c ?? "";
    });
    expect(stored, "the fixture must actually be upper-case, or this case measures nothing").toBe(
      componentId.toUpperCase()
    );
    expect(stored).not.toBe(componentId);

    expect(
      await dependentsOf(componentId),
      "uuid equality is case-insensitive and text equality is not — the two directions must agree"
    ).toBe(1);
  });

  it("the delete DOOR refuses it too — the guard and the count read ONE predicate", async () => {
    const serviceId = await created("/api/v1/services", { name: uniq("hexdoor-svc") });
    const componentId = await created("/api/v1/components", {
      name: uniq("hexdoor-comp"),
      service: serviceId
    });
    const targetId = await created("/api/v1/deployment-targets", { name: uniq("hexdoor-target") });
    const placementId = await created("/api/v1/placements", {
      component: componentId,
      deploymentTarget: targetId
    });

    // The pair's OTHER end, so this case is not a second copy of the one above.
    await plant(
      sql`UPDATE objects
          SET properties = jsonb_set(properties, '{deploymentTargetId}', to_jsonb(upper(${targetId}::text)))
          WHERE id = ${placementId} AND org_id = ${org.orgId}`
    );

    // BEHAVIOUR CHANGE, 2026-08-26: this answered 200 before, leaving the placement live and naming
    // a tombstoned deployment-target — the exact dangling-placement gap the guard exists to close.
    const refused = await call("DELETE", `/api/v1/deployment-targets/${targetId}`);
    expect(refused.status, refused.body).toBe(409);
    expect(String((refused.json() as { detail?: string }).detail)).toContain("placement");

    // …and it is a guard, not a ban: remove the placement and the delete lands.
    expect((await call("DELETE", `/api/v1/placements/${placementId}`)).status).toBe(200);
    expect((await call("DELETE", `/api/v1/deployment-targets/${targetId}`)).status).toBe(200);
  });

  // ---------------------------------------------------------------------------------------------
  // The self-exclusion, which lives at THIS caller and not in the shared fragment
  // ---------------------------------------------------------------------------------------------

  it("a self-parented legacy row is not its own dependent — but its live children still are", async () => {
    const selfParented = await created("/api/v1/domains", { name: uniq("self-domain") });
    const childId = await created("/api/v1/services", {
      name: uniq("self-child"),
      domainId: selfParented
    });

    // No door can write this: `assertRootedContainmentParent` refuses the cycle on a move, and on a
    // create the id does not exist yet to be named as its own parent.
    await plant(
      sql`UPDATE objects SET domain_id = ${selfParented}::uuid
          WHERE id = ${selfParented} AND org_id = ${org.orgId}`
    );

    expect(
      await dependentsOf(selfParented),
      "the row is its own parent; tombstoning it detaches the CHILD and not itself"
    ).toBe(1);
    expect(
      (
        await withTenantTx(server.deps.db, org.orgId, async (tx) => {
          const rows = await tx.execute<{ d: string | null }>(
            sql`SELECT domain_id::text AS d FROM objects WHERE id = ${childId}`
          );
          return rows.rows[0]?.d;
        })
      )?.toLowerCase(),
      "control: the child really does name the self-parented row"
    ).toBe(selfParented.toLowerCase());
  });
});
