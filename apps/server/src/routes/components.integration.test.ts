import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import type { ExecutorType } from "@scp/schemas";
import {
  createOrphanComponent,
  createTestComponent,
  createTestOrg,
  createTestUser,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * Strict create-in-service for `component` (M12 P5a, docs/proposals/organize-after.md). This is the
 * DEDICATED acceptance suite for the invariant "a directly-created component belongs to a service"
 * — the migration proves the rest of the codebase still works through the strict route, and
 * service-contains / plans / typed-registries-cli prove the containment/IaC/CLI edges; here we pin
 * the route contract itself:
 *   - POST /components requires a service and writes the `contains` edge atomically;
 *   - the GENERIC /objects/component route refuses every write verb (403) — the strict route is the
 *     only way in;
 *   - IMPORT (discovery/accept) stays permissive — an imported component may be an orphan;
 *   - PUT is strict on create, field-only on update;
 *   - the create is authority-gated at the service (relationship:write), not just the domain.
 */
describe("components: strict create-in-service (M12 P5a)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "components-strict");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  const authHeader = (token: string) => ({ authorization: `Bearer ${token}` });

  it("POST /components with a service returns 201 and writes the `contains` edge atomically", async () => {
    const svc = await admin.services.create({ name: `svc-${randomUUID().slice(0, 8)}` });
    const comp = await admin.components.create({ name: "checkout-api", service: svc.id });

    expect(comp.typeId).toBe("component");
    // The component is contained by exactly its service — one edge, from that service.
    const edges = await admin.relationships.list({ typeId: "contains", toId: comp.id });
    expect(edges.items).toHaveLength(1);
    expect(edges.items[0]!.fromId).toBe(svc.id);
  });

  it("POST /components WITHOUT a service is 400 (a component must belong to a service)", async () => {
    // The SDK type forbids omitting `service`, so drive the raw route — the server, not the client,
    // is the authority. Zod's required field rejects it before any row is written.
    const res = await server.app.inject({
      method: "POST",
      url: "/api/v1/components",
      headers: authHeader(org.adminToken),
      payload: { name: "orphan-attempt" }
    });
    expect(res.statusCode, res.body).toBe(400);
  });

  it("the GENERIC /objects/component route refuses EVERY write verb (403) — strict route is the only way in", async () => {
    // First make a component the legitimate way, to target with the generic update/delete verbs.
    const svc = await admin.services.create({ name: `svc-${randomUUID().slice(0, 8)}` });
    const comp = await admin.components.create({ name: "guarded", service: svc.id });

    const post = await server.app.inject({
      method: "POST",
      url: "/api/v1/objects/component",
      headers: authHeader(org.adminToken),
      payload: { name: "via-generic" }
    });
    expect(post.statusCode, post.body).toBe(403);

    const patch = await server.app.inject({
      method: "PATCH",
      url: `/api/v1/objects/component/${comp.id}`,
      headers: authHeader(org.adminToken),
      payload: { labels: { x: "1" } }
    });
    expect(patch.statusCode, patch.body).toBe(403);

    const put = await server.app.inject({
      method: "PUT",
      url: `/api/v1/objects/component/${comp.urn}`,
      headers: authHeader(org.adminToken),
      payload: { name: "via-generic-put" }
    });
    expect(put.statusCode, put.body).toBe(403);

    const del = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/objects/component/${comp.id}`,
      headers: authHeader(org.adminToken)
    });
    expect(del.statusCode, del.body).toBe(403);
  });

  it("IMPORT stays permissive — discovery/accept mints an orphan component with no `contains` edge", async () => {
    const orphan = await createOrphanComponent(admin, `imported-${randomUUID().slice(0, 8)}`);
    const edges = await admin.relationships.list({ typeId: "contains", toId: orphan.id });
    expect(edges.items).toHaveLength(0);
  });

  it("PUT /components/:urn is strict on CREATE (400 without a service) and field-only on UPDATE (ignores service)", async () => {
    const svc = await admin.services.create({ name: `svc-${randomUUID().slice(0, 8)}` });
    const urn = `urn:scp:components-strict:component:put-${randomUUID().slice(0, 8)}`;

    // Create branch, no service -> 400.
    const noSvc = await server.app.inject({
      method: "PUT",
      url: `/api/v1/components/${encodeURIComponent(urn)}`,
      headers: authHeader(org.adminToken),
      payload: { name: "put-create-no-svc" }
    });
    expect(noSvc.statusCode, noSvc.body).toBe(400);

    // Create branch, with service -> 201 + edge.
    const created = await admin.components.upsertByUrn(urn, { name: "put-created", service: svc.id });
    expect(created.name).toBe("put-created");
    const edges = await admin.relationships.list({ typeId: "contains", toId: created.id });
    expect(edges.items).toHaveLength(1);
    expect(edges.items[0]!.fromId).toBe(svc.id);

    // Update branch (URN now exists): a `service` is optional and IGNORED — re-assignment is P5b's
    // move verb, so the component stays contained by its ORIGINAL service even if a different one is
    // named. Update the name to prove the update path ran.
    const other = await admin.services.create({ name: `svc-${randomUUID().slice(0, 8)}` });
    const updated = await admin.components.upsertByUrn(urn, { name: "put-renamed", service: other.id });
    expect(updated.name).toBe("put-renamed");
    expect(updated.id).toBe(created.id);
    const after = await admin.relationships.list({ typeId: "contains", toId: created.id });
    expect(after.items).toHaveLength(1);
    expect(after.items[0]!.fromId).toBe(svc.id); // still the ORIGINAL service, not `other`
  });

  it("is idempotent by Idempotency-Key — a retried create returns the same component, not a second one", async () => {
    const svc = await admin.services.create({ name: `svc-${randomUUID().slice(0, 8)}` });
    const key = randomUUID();
    const payload = { name: "idem-comp", service: svc.id };

    const first = await server.app.inject({
      method: "POST",
      url: "/api/v1/components",
      headers: { ...authHeader(org.adminToken), "idempotency-key": key },
      payload
    });
    const second = await server.app.inject({
      method: "POST",
      url: "/api/v1/components",
      headers: { ...authHeader(org.adminToken), "idempotency-key": key },
      payload
    });
    expect(first.statusCode, first.body).toBe(201);
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json().id).toBe(first.json().id);
    // Exactly one contains edge — the retry didn't write a second component or a second edge.
    const edges = await admin.relationships.list({ typeId: "contains", toId: first.json().id });
    expect(edges.items).toHaveLength(1);
  });

  it("create is authority-gated at the SERVICE — a subject scoped only to an unrelated service is refused", async () => {
    const target = await admin.services.create({ name: `target-${randomUUID().slice(0, 8)}` });
    const unrelated = await admin.services.create({ name: `other-${randomUUID().slice(0, 8)}` });

    // Operator only on `unrelated` — no write authority at the org root (the create scope) nor at
    // `target` (the containment parent). Both authorize() gates in the strict route deny this.
    const user = await createTestUser(server, org, [{ role: "Operator", scope: unrelated.id }]);
    const client = new ScpClient({ baseUrl: server.baseUrl, token: user.token });

    await expect(client.components.create({ name: "sneaky", service: target.id })).rejects.toMatchObject(
      { status: 403 }
    );
  });

  it("rejects an unauthenticated create (401)", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/v1/components",
      payload: { name: "no-auth", service: "whatever" }
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("components: assign / atomic move into a service (M12 P5b)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "components-assign");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  const containsEdges = (componentId: string) =>
    admin.relationships.list({ typeId: "contains", toId: componentId, limit: 10 });

  it("assign: an imported orphan gains a `contains` edge to the chosen service", async () => {
    const svc = await admin.services.create({ name: `svc-${randomUUID().slice(0, 8)}` });
    const orphan = await createOrphanComponent(admin, `orphan-${randomUUID().slice(0, 8)}`);
    expect((await containsEdges(orphan.id)).items).toHaveLength(0);

    const returned = await admin.components.setService(orphan.id, svc.id);
    expect(returned.id).toBe(orphan.id);

    const edges = (await containsEdges(orphan.id)).items;
    expect(edges).toHaveLength(1);
    expect(edges[0]!.fromId).toBe(svc.id);
  });

  it("move: re-parenting is ATOMIC — exactly one live edge, now pointing at the new service", async () => {
    const svcA = await admin.services.create({ name: `svcA-${randomUUID().slice(0, 8)}` });
    const svcB = await admin.services.create({ name: `svcB-${randomUUID().slice(0, 8)}` });
    const comp = await createTestComponent(admin, { name: "movable", service: svcA.id });

    await admin.components.setService(comp.id, svcB.id);

    // The 0022 index guarantees at most one LIVE contains edge; it must now be svcB (the old svcA
    // edge is soft-deleted, not lingering — a move that left both would show two here).
    const edges = (await containsEdges(comp.id)).items;
    expect(edges).toHaveLength(1);
    expect(edges[0]!.fromId).toBe(svcB.id);
  });

  it("noop: setting the same service again is idempotent (still exactly one edge, no error)", async () => {
    const svc = await admin.services.create({ name: `svc-${randomUUID().slice(0, 8)}` });
    const comp = await createTestComponent(admin, { name: "steady", service: svc.id });

    await admin.components.setService(comp.id, svc.id);
    await admin.components.setService(comp.id, svc.id);

    const edges = (await containsEdges(comp.id)).items;
    expect(edges).toHaveLength(1);
    expect(edges[0]!.fromId).toBe(svc.id);
  });

  it("rejects a non-service target (400) and a non-component subject (400)", async () => {
    const svc = await admin.services.create({ name: `svc-${randomUUID().slice(0, 8)}` });
    const comp = await createTestComponent(admin, { name: "typed", service: svc.id });
    const notAService = await admin.teams.create({ name: `team-${randomUUID().slice(0, 8)}` });

    // service ref is a team → 400
    await expect(admin.components.setService(comp.id, notAService.id)).rejects.toMatchObject({
      status: 400
    });
    // subject ref is a service, not a component → 400
    await expect(admin.components.setService(svc.id, svc.id)).rejects.toMatchObject({ status: 400 });
  });

  it("assign is authority-gated at BOTH endpoints — a subject that can write the component but not the service is refused", async () => {
    const svc = await admin.services.create({ name: `svc-${randomUUID().slice(0, 8)}` });
    const orphan = await createOrphanComponent(admin, `orphan-${randomUUID().slice(0, 8)}`);

    // Operator on the component only — has relationship:write there, but NOT over `svc`.
    const user = await createTestUser(server, org, [{ role: "Operator", scope: orphan.id }]);
    const client = new ScpClient({ baseUrl: server.baseUrl, token: user.token });

    await expect(client.components.setService(orphan.id, svc.id)).rejects.toMatchObject({
      status: 403
    });
    expect((await containsEdges(orphan.id)).items).toHaveLength(0); // nothing written
  });

  it("MOVE additionally requires write over the OLD service — the 3rd scope create-strict never checks", async () => {
    const svcA = await admin.services.create({ name: `svcA-${randomUUID().slice(0, 8)}` });
    const svcB = await admin.services.create({ name: `svcB-${randomUUID().slice(0, 8)}` });
    const comp = await createTestComponent(admin, { name: "guarded-move", service: svcA.id });

    // Operator on the component AND the NEW service — but NOT the OLD service (svcA). A move must
    // still fail, because svcA loses a child. This is the incomplete-census trap: cloning
    // createComponentInService (service-only authz) would let this 403-worthy move through.
    const user = await createTestUser(server, org, [
      { role: "Operator", scope: comp.id },
      { role: "Operator", scope: svcB.id }
    ]);
    const client = new ScpClient({ baseUrl: server.baseUrl, token: user.token });

    await expect(client.components.setService(comp.id, svcB.id)).rejects.toMatchObject({
      status: 403
    });
    // The move did not happen — still in svcA.
    const edges = (await containsEdges(comp.id)).items;
    expect(edges).toHaveLength(1);
    expect(edges[0]!.fromId).toBe(svcA.id);
  });
});

describe("components: driving-case merge (M12 P5d)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "components-merge");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  const rand = () => randomUUID().slice(0, 8);
  const putBinding = (targetId: string, type: ExecutorType) =>
    admin.executors.putBinding(targetId, {
      pluginModule: "fake-executor",
      pluginInstanceId: `inst-${rand()}`,
      config: { statePath: "/tmp/x" },
      allowedHosts: [],
      type
    });
  const typesOf = async (id: string) =>
    (await admin.executors.listBindings(id)).map((b) => b.type).sort();

  it("folds a binding-only loser into the survivor: bindings move here, loser soft-deleted", async () => {
    const survivor = await createOrphanComponent(admin, `surv-${rand()}`);
    const loser = await createOrphanComponent(admin, `lose-${rand()}`);
    await putBinding(survivor.id, "infrastructure");
    await putBinding(loser.id, "configuration");

    const result = await admin.components.merge(survivor.id, loser.id);
    expect(result.survivor.id).toBe(survivor.id);
    expect(result.movedBindingTypes).toEqual(["configuration"]);

    expect(await typesOf(survivor.id)).toEqual(["configuration", "infrastructure"]);
    await expect(admin.components.get(loser.id)).rejects.toMatchObject({ status: 404 });
  });

  it("REJECTS a binding-type collision (Q1); relabel-then-merge is the driving-case flow", async () => {
    const survivor = await createOrphanComponent(admin, `surv-${rand()}`);
    const loser = await createOrphanComponent(admin, `lose-${rand()}`);
    // Both default to 'configuration' (the guaranteed argocd double-import collision).
    await putBinding(survivor.id, "configuration");
    await putBinding(loser.id, "configuration");

    await expect(admin.components.merge(survivor.id, loser.id)).rejects.toMatchObject({ status: 409 });
    // Nothing moved — loser still alive with its binding.
    await expect(admin.components.get(loser.id)).resolves.toBeTruthy();
    expect(await typesOf(survivor.id)).toEqual(["configuration"]);

    // Relabel the loser's binding to infrastructure (P5c), then the merge succeeds.
    await admin.executors.repurposeBinding(loser.id, "infrastructure");
    const result = await admin.components.merge(survivor.id, loser.id);
    expect(result.movedBindingTypes).toEqual(["infrastructure"]);
    expect(await typesOf(survivor.id)).toEqual(["configuration", "infrastructure"]);
    await expect(admin.components.get(loser.id)).rejects.toMatchObject({ status: 404 });
  });

  it("REJECTS a loser with live graph edges — general graph-rewrite is out of scope", async () => {
    const survivor = await createOrphanComponent(admin, `surv-${rand()}`);
    const svc = await admin.services.create({ name: `svc-${rand()}` });
    // A loser assigned to a service has a `contains` edge — not a binding-only orphan.
    const loser = await createTestComponent(admin, { name: `lose-${rand()}`, service: svc.id });
    await putBinding(loser.id, "configuration");

    await expect(admin.components.merge(survivor.id, loser.id)).rejects.toMatchObject({ status: 409 });
    await expect(admin.components.get(loser.id)).resolves.toBeTruthy(); // untouched
  });

  it("REJECTS a merge while an in-flight change targets either component", async () => {
    const survivor = await createOrphanComponent(admin, `surv-${rand()}`);
    const loser = await createOrphanComponent(admin, `lose-${rand()}`);
    await putBinding(loser.id, "configuration");
    // A freshly-proposed change on the survivor is in-flight (non-terminal).
    await admin.changes.propose({ name: "in-flight", targets: [survivor.id] });

    await expect(admin.components.merge(survivor.id, loser.id)).rejects.toMatchObject({ status: 409 });
    await expect(admin.components.get(loser.id)).resolves.toBeTruthy();
  });

  it("rejects self-merge (400) and a non-component loser (400)", async () => {
    const comp = await createOrphanComponent(admin, `c-${rand()}`);
    await expect(admin.components.merge(comp.id, comp.id)).rejects.toMatchObject({ status: 400 });
    const svc = await admin.services.create({ name: `svc-${rand()}` });
    await expect(admin.components.merge(comp.id, svc.id)).rejects.toMatchObject({ status: 400 });
  });

  it("requires object:write on BOTH components (a subject scoped only to the survivor is refused)", async () => {
    const survivor = await createOrphanComponent(admin, `surv-${rand()}`);
    const loser = await createOrphanComponent(admin, `lose-${rand()}`);
    await putBinding(loser.id, "configuration");

    const user = await createTestUser(server, org, [{ role: "Operator", scope: survivor.id }]);
    const client = new ScpClient({ baseUrl: server.baseUrl, token: user.token });
    await expect(client.components.merge(survivor.id, loser.id)).rejects.toMatchObject({ status: 403 });
    await expect(admin.components.get(loser.id)).resolves.toBeTruthy(); // nothing happened
  });
});
