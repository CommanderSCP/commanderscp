import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  createTestOrg,
  createTestUser,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg,
  type TestUser
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { relationships, roleBindings, roles } from "../db/schema.js";
import { SYSTEM_MANAGED_RELATIONSHIP_TYPE_IDS } from "../graph/system-managed-relationships.js";
import { deriveUrn } from "../graph/urn.js";
import { getMergedOverlayView } from "../federation/overlay-repo.js";

/**
 * THE RELATIONSHIP HALF OF THE CALLER-SUPPLIED-`typeId` CENSUS.
 *
 * ================================================================================================
 * THE PROPERTY
 * ================================================================================================
 * `governance/governance-managed-write-doors.integration.test.ts` censused every door that reaches
 * `createObject`/`updateObject`/`upsertObjectByUrn` with an OBJECT `typeId` the caller chose. It
 * closed three. It never asked the same question one table over, and the answer there was worse:
 *
 * > **A door that reaches `createRelationship` with a `typeId` the CALLER chose needs the same
 * > PAIR of guards the generic `/relationships` door carries — refuse the system-managed types,
 * > and authorize `relationship:write` at BOTH endpoints — and one door carried neither.**
 *
 * Both halves are load-bearing, for different reasons, and a door with one of them is not half safe:
 *
 *  - **The TYPE refusal holds for every caller, the org Owner included.** `approves`, `coordinates`
 *    and `annotates` are engine-owned (`graph/system-managed-relationships.ts`): the only legal way
 *    each comes into existence is a dedicated path that checks an authority `createRelationship`
 *    itself never checks. A hand-written `approves` edge is graph-visible fake approval evidence; a
 *    hand-written `annotates` edge is an overlay that skipped
 *    `assertPolicyOverlayOnlyAddsStrictness`, and `federation/overlay-repo.ts`'s
 *    `getMergedOverlayView` merges the `from` object's properties into the base for EVERY
 *    `annotates` edge it finds — which is exactly the weakening the refusal exists to make
 *    unreachable, and which the third case below measures rather than asserts.
 *  - **The BOTH-ENDPOINT check is what makes a relationship write a write at two places.** PR #4's
 *    CRITICAL 1: `member_of` feeds RBAC subject expansion, and `contains` IS a containment parent
 *    (`graph/containment.ts` route 2) — the reach of every policy scope kind
 *    (`governance/policy-resolve.ts`) and the route RBAC scope expansion walks upward
 *    (`authz/resolve.ts`'s `scopeExpandCte`). An edge minted with authority at neither endpoint
 *    changes who governs, and who has authority over, an object the actor was never given.
 *
 * ================================================================================================
 * THE FULL CENSUS (filterless — every call site of `createRelationship`, plus every raw INSERT into
 * `relationships`, measured 2026-08-17)
 * ================================================================================================
 *
 *  # SITE                                          typeId from            GUARDS
 *  1 routes/relationships.ts POST/DELETE            body.typeId           refusal + both endpoints
 *  2 iac/plans-repo.ts (plan apply)                 manifest entry.typeId refusal (`:873`)
 *  3 routes/executors.ts POST /discovery/accept     proposal relationship NEITHER  <- THE HOLE
 *  4 federation/import-repo.ts (journal replay)     signed bundle payload not a door (see below)
 *  5 everything else (13 call sites + the one raw   a string LITERAL      n/a
 *    INSERT, `governance/approvals-repo.ts`)
 *
 * SITE 5 is the reason the hole survived: `correlates`, `depends_on`, `owns`, `contains`,
 * `coordinates`, `annotates` and the placement-derived edges are all spelled as literals at their
 * call sites, so a reader scanning for "who can pick a relationship type?" sees a wall of constants
 * and two obviously-guarded doors. The third door spells it `proposedRelationship.typeId`, a few
 * lines below three OBJECT-type refusals that make the surrounding handler LOOK guarded.
 *
 * SITE 4 is deliberately NOT a door, on the same reasoning the object census recorded: `typeId`
 * arrives from a signature- and chain-verified bundle, and the branch has no try/catch, so one
 * refusal aborts a whole signed bundle. A hostile peer is a PAIRING problem. `discovery/accept` is
 * the opposite — its proposal comes from the REQUEST BODY, and the route's own pair-bound guard
 * already says so in prose ("a client can hand-write one that never came from a plugin run"),
 * having drawn exactly that distinction for OBJECT types and then not applied it one loop down.
 *
 * ================================================================================================
 * WHY THE REMEDY IS THE GENERIC DOOR'S PAIR AND NOT A DISCOVERY ALLOWLIST
 * ================================================================================================
 * Every `DiscoveryPlugin` in the tree emits exactly one edge type — `part_of` (github, gitea,
 * gitlab; argocd emits none) — so an allowlist of one string would refuse nothing that works today
 * and is tempting. It is still the wrong shape. `relationship_types` is an org's own extensibility
 * surface (`POST /relationship-types`; charter principle 2, "new concepts arrive as
 * relationship/policy/registry data"), and a plugin is by definition third-party code; an allowlist
 * naming today's built-ins would refuse an org's own custom edge between its own objects for no
 * security reason. The bar that IS defensible is the one the generic door already sets, applied
 * here unchanged — which is why the second case asserts the two doors AGREE rather than asserting
 * a list.
 *
 * ================================================================================================
 * A SEPARATE DEFECT THIS FILE MEASURED AND DOES NOT FIX: `part_of` IS NOT A REGISTERED TYPE
 * ================================================================================================
 * The controls below were first written against `part_of`, on the reasoning above that it is the
 * one edge every DiscoveryPlugin emits. They failed 404: `relationship type 'part_of' is not
 * registered`. No migration in `apps/server/drizzle/` defines it — the seeded set is `owns`,
 * `consumes`, `depends_on`, `communicates_with`, `hosted_on`, `governed_by`, `deploys_to`,
 * `coordinates`, `synchronizes_with`, `member_of`, `approves`, `annotates` (0002) plus `contains`
 * (0021). So `discovery accept` of a github/gitea/gitlab proposal's relationships has never worked
 * at all, and every end-to-end discovery test in the tree passes `relationships: []` at the accept
 * step, which is why nothing went red. It is a real defect in a different subsystem (either the
 * plugins should emit `contains`, or `part_of` should be registered as its inverse), and this file
 * fixes an authorization hole rather than quietly changing what an import produces. The controls
 * therefore use `contains` — the edge a component actually gets — which is also the stronger
 * control, since it is the SAME type as the refusal case one section up.
 */
describe("relationship typeId door census: POST /discovery/accept (Testcontainers)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  /** `object:write` + `relationship:write` at the org root — the actor `/discovery/accept`'s own
   *  `object:write @ org root` check admits, and the one every legitimate import runs as. */
  let importer: TestUser;
  let svcA: { id: string; urn: string };
  let svcB: { id: string; urn: string };

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "rel-doors");
    importer = await createTestUser(server, org, [{ role: "Operator", scope: org.orgId }]);
    svcA = await createService("rel-doors-a");
    svcB = await createService("rel-doors-b");
    FIXTURE_PROPERTIES.campaign = { properties: { targets: [svcA.id] } };
  }, 180_000);

  afterAll(async () => {
    await server?.close();
  });

  async function post(url: string, token: string, payload: unknown) {
    return server.app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${token}` },
      payload: payload as Record<string, unknown>
    });
  }

  /** A live, non-tombstoned edge of this type between these two objects — "was the ROW written?".
   *  Read from the TABLE, never from `GET /relationships`: a list route that filtered the type
   *  would make every "nothing was written" assertion in this file vacuous. */
  async function liveEdges(typeId: string, fromId: string, toId: string) {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ id: relationships.id })
        .from(relationships)
        .where(
          and(
            eq(relationships.orgId, org.orgId),
            eq(relationships.typeId, typeId),
            eq(relationships.fromId, fromId),
            eq(relationships.toId, toId),
            isNull(relationships.deletedAt)
          )
        )
    );
  }

  async function createService(
    label: string,
    properties?: Record<string, unknown>
  ): Promise<{ id: string; urn: string }> {
    const res = await post("/api/v1/services", org.adminToken, {
      name: `${label}-${randomUUID().slice(0, 8)}`,
      ...(properties ? { properties } : {})
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as { id: string; urn: string };
    return { id: body.id, urn: body.urn };
  }

  /**
   * An object of ANY type, minted through this route's own OBJECT import.
   *
   * The import path is the only one that is permissive about type (the owner ruling recorded in
   * `routes/objects-generic.ts`: `component` must belong to a service on the strict create route,
   * so `POST /objects/component` is refused and `POST /components` writes the `contains` edge
   * atomically). Two cases below need what only an import can give them: an ORPHAN `component`,
   * which has not already spent its one-service-per-component slot, and a `user`/`change` pair for
   * the `approves` endpoint types.
   */
  async function importObject(typeId: string, label: string): Promise<{ id: string; urn: string }> {
    const name = `${label}-${randomUUID().slice(0, 8)}`;
    const res = await post("/api/v1/discovery/accept", importer.token, {
      proposal: {
        objects: [{ typeId, name, ...(FIXTURE_PROPERTIES[typeId] ?? {}) }],
        relationships: []
      }
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = (res.json() as { createdObjectIds: string[] }).createdObjectIds[0]!;
    return { id, urn: deriveUrn(org.orgId, typeId, name) };
  }

  /** The minimum each fixture type's `property_schema` demands (`graph/property-validation.ts`
   *  runs on every create). Only `campaign` has a required key — `targets`, from migration 0011 —
   *  and the value is deliberately a service this admin already owns: the fixture is here to give
   *  `coordinates` a legal 'from' endpoint, not to exercise campaign target authority. */
  const FIXTURE_PROPERTIES: Record<string, { properties: Record<string, unknown> }> = {};

  /**
   * The FIRST legal endpoint types of a relationship type, read from `relationship_types` at
   * runtime (`NULL` from/to arrays mean "anything", which `annotates` carries).
   *
   * Read, not hardcoded, and the difference is a case that was green for the wrong reason: with
   * `service` on both ends, the `approves` and `coordinates` cases below got a 400 from
   * `createRelationship`'s endpoint-TYPE check — `relationship type 'approves' does not allow
   * 'service' as the 'from' endpoint` — BEFORE reaching the guard under test. Both were red at the
   * time, so the mistake was visible; once the guard lands they would have gone green on a refusal
   * that has nothing to do with it, and deleting the guard would not have turned them red.
   */
  async function legalEndpointTypes(typeId: string): Promise<{ from: string; to: string }> {
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.execute<{ from_types: string[] | null; to_types: string[] | null }>(
        sql`SELECT from_types, to_types FROM relationship_types WHERE id = ${typeId}`
      )
    );
    const row = rows.rows[0];
    expect(
      row,
      `relationship type '${typeId}' is not registered — the fixture cannot be built`
    ).toBeDefined();
    return { from: row!.from_types?.[0] ?? "service", to: row!.to_types?.[0] ?? "service" };
  }

  /** `POST /discovery/accept` carrying one relationship and no objects. */
  async function accept(token: string, typeId: string, fromUrn: string, toUrn: string) {
    return post("/api/v1/discovery/accept", token, {
      proposal: { objects: [], relationships: [{ typeId, fromUrn, toUrn }] }
    });
  }

  // -------------------------------------------------------------------------------------------
  // HALF 1 — the TYPE refusal. Holds for EVERY caller, including the org-root Owner, exactly as it
  // does at the generic door and at plan apply.
  //
  // Driven off `SYSTEM_MANAGED_RELATIONSHIP_TYPE_IDS` rather than off today's three names, so a
  // FOURTH engine-owned type added to that set is asked about here without anyone remembering to.
  // -------------------------------------------------------------------------------------------

  it.each([...SYSTEM_MANAGED_RELATIONSHIP_TYPE_IDS])(
    "the org-root Owner cannot mint a system-managed '%s' edge through a discovery proposal",
    async (typeId) => {
      const endpointTypes = await legalEndpointTypes(typeId);
      const from = await importObject(endpointTypes.from, `sysmanaged-${typeId}-from`);
      const to = await importObject(endpointTypes.to, `sysmanaged-${typeId}-to`);

      const res = await accept(org.adminToken, typeId, from.urn, to.urn);

      expect(res.statusCode, res.body).toBe(403);
      // The SPECIFIC violation — the type, named. A 403 for some other reason would satisfy a bare
      // status assertion and prove nothing about this guard.
      expect(res.body).toContain(typeId);
      expect(res.body).toMatch(/system-managed/);
      expect(
        await liveEdges(typeId, from.id, to.id),
        "a refusal that still wrote the edge is not a refusal"
      ).toHaveLength(0);
    }
  );

  it("the generic door refuses the same edge for the same actor — the two doors agree", async () => {
    const from = await createService("agree-from");
    const to = await createService("agree-to");

    // `annotates` admits ANY endpoint pair (`0002_rls_rbac_seed.sql`: from_types/to_types NULL), so
    // this compares the two doors on identical inputs with no type-registry difference in the way.
    const generic = await post("/api/v1/relationships", org.adminToken, {
      typeId: "annotates",
      fromId: from.id,
      toId: to.id
    });
    expect(generic.statusCode, generic.body).toBe(403);

    const discovery = await accept(org.adminToken, "annotates", from.urn, to.urn);
    expect(discovery.statusCode, discovery.body).toBe(403);

    expect(await liveEdges("annotates", from.id, to.id)).toHaveLength(0);
  });

  it("the forged 'annotates' edge the refusal prevents would have been merged into the base object", async () => {
    // Not a second copy of the case above: it measures the CONSEQUENCE, so a future reader weighing
    // "does discovery really need this one?" has an answer rather than an argument.
    // `getMergedOverlayView` merges the `from` object's properties into the base for EVERY
    // `annotates` edge it finds, with no check that the edge came through `createOverlay` — so a
    // forged edge is a silent property rewrite of an object the forger never wrote to.
    const base = await createService("overlay-base", { tier: "gold" });
    const forged = await createService("overlay-forged", { tier: "forged-by-discovery" });

    const res = await accept(org.adminToken, "annotates", forged.urn, base.urn);
    expect(res.statusCode, res.body).toBe(403);

    const view = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      getMergedOverlayView(tx, org.orgId, base.id)
    );
    expect(view.overlays).toHaveLength(0);
    expect(view.merged.tier).toBe("gold");
    expect(await liveEdges("annotates", forged.id, base.id)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------------------------
  // HALF 2 — `relationship:write` at BOTH endpoints.
  //
  // The first actor is BUILT rather than borrowed: every built-in role that grants `object:write`
  // also grants `relationship:write` at the same scope (`0002_rls_rbac_seed.sql:208-222`), so an
  // actor who passes `/discovery/accept`'s `object:write @ org root` check happens to hold
  // `relationship:write` at the org root too. That is safety by coincidence between two entries of
  // one ARRAY literal, undone by a single org-defined role — the mechanism `roles.org_id` exists
  // for — so the guard is tested against that shape and not against the role table's accident.
  // -------------------------------------------------------------------------------------------

  /** An org-defined role granting `object:write` and NOT `relationship:write`, bound at the org
   *  root: the actor no built-in role can express, and exactly the shape `/discovery/accept`'s
   *  org-root `object:write` check admits. */
  async function createObjectWriteOnlyUser(): Promise<TestUser> {
    // Viewer purely so the harness mints an auth row and a live token; it grants no write anywhere.
    const user = await createTestUser(server, org, [{ role: "Viewer", scope: org.orgId }]);
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const roleId = randomUUID();
      await tx.insert(roles).values({
        id: roleId,
        orgId: org.orgId,
        name: `object-write-only-${randomUUID().slice(0, 8)}`,
        permissions: ["object:read", "object:write"]
      });
      await tx.insert(roleBindings).values({
        id: randomUUID(),
        orgId: org.orgId,
        subjectId: user.objectId,
        roleId,
        scopeObjectId: org.orgId,
        effect: "allow"
      });
    });
    return user;
  }

  it("an actor with object:write and no relationship:write cannot mint an edge through a proposal", async () => {
    const actor = await createObjectWriteOnlyUser();

    const res = await accept(actor.token, "depends_on", svcA.urn, svcB.urn);

    expect(res.statusCode, res.body).toBe(403);
    expect(res.body).toMatch(/relationship:write/);
    expect(await liveEdges("depends_on", svcA.id, svcB.id)).toHaveLength(0);
  });

  it("rights at 'from' but not 'to' is a 403, and the edge is not written", async () => {
    const from = await createService("endpoint-from-ok");
    const to = await createService("endpoint-to-denied");
    const actor = await createTestUser(server, org, [
      { role: "Operator", scope: org.orgId },
      // Deny-override (`authz/resolve.ts:157`): an explicit deny at ANY matching scope beats every
      // allow above it. The org-root allow still satisfies `object:write @ org root`, so the actor
      // reaches the relationship loop and is stopped by the endpoint check alone — which is what
      // makes this case about THIS guard rather than about the door's entry check.
      { role: "Operator", scope: to.id, effect: "deny" }
    ]);

    const res = await accept(actor.token, "depends_on", from.urn, to.urn);

    expect(res.statusCode, res.body).toBe(403);
    expect(await liveEdges("depends_on", from.id, to.id)).toHaveLength(0);
  });

  it("rights at 'to' but not 'from' is also a 403 (symmetric)", async () => {
    const from = await createService("endpoint-from-denied");
    const to = await createService("endpoint-to-ok");
    const actor = await createTestUser(server, org, [
      { role: "Operator", scope: org.orgId },
      { role: "Operator", scope: from.id, effect: "deny" }
    ]);

    const res = await accept(actor.token, "depends_on", from.urn, to.urn);

    expect(res.statusCode, res.body).toBe(403);
    expect(await liveEdges("depends_on", from.id, to.id)).toHaveLength(0);
  });

  it("a 'contains' edge — the reach of every policy scope — is authorized at the container too", async () => {
    // The case that makes this more than an RBAC nicety. `contains` IS containment
    // (`graph/containment.ts` route 2), so minting one puts the child under a container whose
    // policies then reach it and whose role bindings then have authority over it. Before this
    // guard the permission required for that was `object:write` at the org root and nothing else —
    // neither `relationship:write` at the endpoints nor the `policy:write` that authored the
    // policies whose reach it changes (`governance/governance-reach.ts`'s opening property).
    const container = await createService("contains-container");
    const child = await importObject("component", "contains-child");
    const actor = await createTestUser(server, org, [
      { role: "Operator", scope: org.orgId },
      { role: "Operator", scope: container.id, effect: "deny" }
    ]);

    const res = await accept(actor.token, "contains", container.urn, child.urn);

    expect(res.statusCode, res.body).toBe(403);
    expect(await liveEdges("contains", container.id, child.id)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------------------------
  // CONTROLS — the fix must not simply close the door. Import is what this route is FOR, and a
  // refusal test with no control is how a guard that breaks the feature ships green.
  // -------------------------------------------------------------------------------------------

  it("the SAME 'contains' edge the case above refused imports for an authorized actor: 201, row written", async () => {
    // Deliberately the same type, endpoints and door as the `contains` refusal — the ONLY
    // difference is the actor's authority at the container. A control on a different type would
    // leave "the guard refuses everything" and "the guard refuses the unauthorized" indistinguishable.
    const container = await createService("control-contains-container");
    const child = await importObject("component", "control-contains-child");

    const res = await accept(importer.token, "contains", container.urn, child.urn);

    expect(res.statusCode, res.body).toBe(201);
    expect(
      (res.json() as { createdRelationshipIds: string[] }).createdRelationshipIds
    ).toHaveLength(1);
    expect(
      await liveEdges("contains", container.id, child.id),
      "the control must prove the ROW landed, not merely that the status was 201"
    ).toHaveLength(1);
  });

  it("a non-system-managed edge between two pre-existing objects still imports", async () => {
    const from = await createService("control-depends-from");
    const to = await createService("control-depends-to");

    const res = await accept(importer.token, "depends_on", from.urn, to.urn);

    expect(res.statusCode, res.body).toBe(201);
    expect(await liveEdges("depends_on", from.id, to.id)).toHaveLength(1);
  });

  it("a proposal that creates its own objects AND the edge between them still imports in one accept", async () => {
    // The `urnToId` branch: an edge whose endpoints are minted in the SAME batch and referenced by
    // the URN they are about to get. The endpoint authorization has to run against ids that did not
    // exist when the request arrived, which is the half a fix written against pre-existing
    // endpoints alone would get wrong.
    const serviceName = `control-batch-svc-${randomUUID().slice(0, 8)}`;
    const componentName = `control-batch-cmp-${randomUUID().slice(0, 8)}`;

    const res = await post("/api/v1/discovery/accept", importer.token, {
      proposal: {
        objects: [
          { typeId: "service", name: serviceName },
          { typeId: "component", name: componentName }
        ],
        relationships: [
          {
            typeId: "contains",
            fromUrn: deriveUrn(org.orgId, "service", serviceName),
            toUrn: deriveUrn(org.orgId, "component", componentName)
          }
        ]
      }
    });

    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as { createdObjectIds: string[]; createdRelationshipIds: string[] };
    expect(body.createdObjectIds).toHaveLength(2);
    expect(body.createdRelationshipIds).toHaveLength(1);
  });
});
