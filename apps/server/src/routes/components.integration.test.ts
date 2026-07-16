import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import {
  createOrphanComponent,
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
