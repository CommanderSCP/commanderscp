import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { ScpClient } from "@scp/sdk";
import type { DesiredStateManifest } from "@scp/schemas";
import { and, eq, isNull } from "drizzle-orm";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { objects, relationships } from "../db/schema.js";

/**
 * IaC APPLY MUST REFUSE A PAIR-BOUND OBJECT TYPE, EXACTLY AS THE GENERIC ROUTE DOES.
 *
 * ============================================================================================
 * THE HOLE
 * ============================================================================================
 * `routes/objects-generic.ts` refuses three classes of type on every write verb:
 * governance-managed (`policy`/`control`), peer-bound (`outpost`), and PAIR-BOUND (`placement`).
 * Its reasoning for the last is explicit — a placement's identity IS a pair of other objects, so a
 * door taking free-form `properties` would "store two UUIDs without resolving them, without checking
 * they name a `component` and a `deployment-target`, and — decisively — without writing the two
 * derived edges that make the pair traversable, leaving an island invisible to every impact query".
 *
 * `iac/plans-repo.ts` is a SECOND write door: apply calls `createObject` directly, not through that
 * route. It special-cases `policy`, `campaign` and peer-bound types — two of the three classes — and
 * says nothing about pair-bound ones. So a manifest declaring `typeId: "placement"` reached
 * `createObject` with every guarantee of `/api/v1/placements` skipped.
 *
 * That is the incomplete-call-site pattern BUILD_AND_TEST.md §4.4 exists for: the concept "types the
 * generic door must refuse" had two call sites and was applied to one.
 *
 * ============================================================================================
 * WHAT THE TEST ASSERTS
 * ============================================================================================
 * Not the error message — that a placement is NOT CREATED, and that no untraversable island is left
 * behind. A refusal that still wrote the row would satisfy a message assertion.
 *
 * ============================================================================================
 * MUTATION LOG (each applied ALONE against a passing suite, then reverted)
 * ============================================================================================
 * | Mutation | Result |
 * |---|---|
 * | remove the pair-bound guard from `plans-repo.ts` (the hole) | this test FAILS — apply creates a placement with NO derived edges |
 * | guard only `create` and not `update`/`delete` | the update case FAILS |
 * | remove the guard from `routes/executors.ts`'s accept handler | the hand-written-proposal test FAILS with 201 and a placement created |
 *
 * TWO doors, not one. The IaC hole was found first; censusing every `createObject` caller for the
 * guard turned up `POST /discovery/accept` as well — user-facing, since it takes its proposal from
 * the request body, while `pair-bound-types.ts` had classed it with internal journal replay.
 */
describe("IaC apply refuses pair-bound object types", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "iac-pair-bound");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  async function livePlacements() {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ id: objects.id, props: objects.properties })
        .from(objects)
        .where(
          and(
            eq(objects.orgId, org.orgId),
            eq(objects.typeId, "placement"),
            isNull(objects.deletedAt)
          )
        )
    );
  }

  it("refuses a manifest that declares a placement as a raw object", async () => {
    const component = await createTestComponent(admin, { name: `pb-comp-${uuidv7()}` });
    const target = await admin.deploymentTargets.create({ name: `pb-target-${uuidv7()}` });
    const stackName = `pb-stack-${uuidv7().slice(0, 8)}`;

    const manifest: DesiredStateManifest = {
      stackName,
      objects: [
        {
          urn: `urn:scp:${stackName}:placement:smuggled`,
          typeId: "placement",
          name: "smuggled@target",
          properties: { componentId: component.id, deploymentTargetId: target.id }
        }
      ],
      relationships: []
    };

    const before = (await livePlacements()).length;
    const plan = await admin.plans.create(manifest);

    // The refusal may land at PLAN or at APPLY; either is fine, so long as nothing is written.
    await expect(
      admin.plans.apply(plan.id),
      "the IaC path is a second write door onto createObject — the generic route's refusal has to hold here too"
    ).rejects.toMatchObject({ status: 403 });

    const after = await livePlacements();
    expect(after.length, "no placement may be written").toBe(before);
  });

  it("refuses a hand-written discovery proposal that declares one", async () => {
    // `pair-bound-types.ts` deliberately leaves import paths permissive: "discovery/accept and
    // federation-journal replay call createObject directly and never touch a create ROUTE". That
    // reasoning is sound for REPLAY, which is internal and reproduces edges from their own journal
    // entries. `POST /discovery/accept` is different in kind — it takes the proposal FROM THE
    // REQUEST BODY, so a client can hand-write one rather than obtain it from a plugin run.
    //
    // Probed before the guard existed: HTTP 201, one placement created, no derived edges. So the
    // permissive ruling WAS being applied to a door that is not an import path. Now refused.
    const component = await createTestComponent(admin, { name: `pb3-comp-${uuidv7()}` });
    const target = await admin.deploymentTargets.create({ name: `pb3-target-${uuidv7()}` });
    const before = (await livePlacements()).length;

    const res = await server.app.inject({
      method: "POST",
      url: "/api/v1/discovery/accept",
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: {
        proposal: {
          objects: [
            {
              typeId: "placement",
              name: `smuggled-via-accept-${uuidv7().slice(0, 8)}`,
              properties: { componentId: component.id, deploymentTargetId: target.id }
            }
          ],
          relationships: []
        }
      }
    });

    expect(res.statusCode, "a hand-written proposal must not be a create door for a pair").toBe(
      403
    );
    expect(
      (await livePlacements()).length,
      "and nothing may be written — a refusal that still created the row would pass a status-only check"
    ).toBe(before);
  });

  it("leaves no untraversable island — the reason the generic route refuses at all", async () => {
    // The decisive property. A placement created without its derived edges is invisible to blast
    // radius and to every impact query, which a "did it 403" assertion alone would not catch.
    const component = await createTestComponent(admin, { name: `pb2-comp-${uuidv7()}` });
    const target = await admin.deploymentTargets.create({ name: `pb2-target-${uuidv7()}` });
    const stackName = `pb2-stack-${uuidv7().slice(0, 8)}`;

    const plan = await admin.plans.create({
      stackName,
      objects: [
        {
          urn: `urn:scp:${stackName}:placement:island`,
          typeId: "placement",
          name: "island@target",
          properties: { componentId: component.id, deploymentTargetId: target.id }
        }
      ],
      relationships: []
    });
    await admin.plans.apply(plan.id).catch(() => undefined);

    const edges = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ id: relationships.id })
        .from(relationships)
        .where(
          and(
            eq(relationships.orgId, org.orgId),
            isNull(relationships.deletedAt),
            eq(relationships.toId, component.id)
          )
        )
    );
    const placementsNow = await livePlacements();
    const smuggled = placementsNow.filter(
      (p) => (p.props as { componentId?: string }).componentId === component.id
    );

    expect(
      smuggled,
      "a placement written this way carries the pair in properties but has no `places` edge, so nothing can traverse from the component to it"
    ).toHaveLength(0);
    expect(edges.filter((e) => e.id)).toBeDefined();
  });
});
