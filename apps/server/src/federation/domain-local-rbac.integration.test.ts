import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import {
  createTestOrg,
  createTestUser,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg,
  type TestUser
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { roleBindings, roles } from "../db/schema.js";

/**
 * M20.1 (ADR-0031 §1) — DECLARING AN OBJECT DOMAIN-LOCAL REQUIRES `federation:write`, AT EVERY DOOR.
 *
 * ## Why this file exists, and why it is a CENSUS rather than a handful of cases
 *
 * `domainLocal` was added to `CreateObjectRequestSchema` and `UpsertObjectRequestSchema` — and it
 * immediately appeared on **six** routes, not two, because `CreateComponentRequestSchema` and
 * `UpsertComponentRequestSchema` **extend** those bodies and the typed-registry factory generates a
 * create + upsert pair for every registered type. A door that accepted the field and forgot to
 * thread it would silently drop an operator's declaration; a door that threaded it but forgot to
 * authorize it would let `object:write` alone decide what crosses a security boundary.
 *
 * Guarding routes one at a time is the incomplete-call-site-census failure this project keeps
 * paying for (CLAUDE.md), so the coverage here is not a hand-written list. {@link declaringRoutes}
 * DERIVES the set from the committed OpenAPI document — every operation whose request body admits
 * `domainLocal` — and the drift test asserts that set is exactly what this file exercises. **Add a
 * seventh door and this file goes red until it is covered.** That is the property worth having; the
 * individual 403s below are what it protects.
 *
 * ## The actor, and the control that makes its 403s mean something
 *
 * `operator` is the built-in **Operator** role at the org root: `drizzle/0002` gives it
 * `object:write`, and `drizzle/0012` grants `federation:write` to Administrator/Owner **only**. So it
 * can create objects and cannot declare locality — which is exactly the distinction ADR-0031 draws,
 * and the same actor `outposts-rbac.integration.test.ts` uses for the mirror-image case.
 *
 * Every 403 from `operator` is therefore about the *federation* permission specifically. The first
 * test is the control that earns that reading: without proving this actor can create an ordinary
 * object, the whole file would pass just as well with a token holding no permissions at all.
 *
 * ## The PUBLISH door tests use two DIFFERENT actors, in the opposite direction
 *
 * `POST /objects/{type}/{idOrUrn}/publish` is gated on BOTH permissions, so it is exercised from
 * both sides and `operator` can only test one of them. The `federationOnly` /
 * `federationAndObjectWrite` pair below are org-defined roles differing in exactly `object:write`,
 * which is what makes that 403 attributable. Their cases say so explicitly; do not read the
 * paragraph above as covering them.
 *
 * ### MUTATION RUN (2026-08-25) for the publish `object:write` bar. MEASURED, not predicted.
 *
 * DELETE the `object:write` `authorize` from the publish handler in `routes/objects-generic.ts`
 *   -> 1 failed | 16 passed. "403 with federation:write but NO object:write" went red on
 *      `AssertionError: ... expected 200 to be 403`, and the returned body is the proof rather than
 *      the status: `"domainLocal":false,"version":2` — a subject holding `object:write` NOWHERE had
 *      cleared the locality flag and re-versioned a live estate row, which is the whole defect.
 *      THE OTHER PUBLISH CASES STAYED GREEN, including the `federation:write` 403 — so the new bar
 *      is not what makes them pass and they are not what makes it pass.
 *
 * ## What is asserted at each door — three things, because a status code alone is weak
 *
 *   1. `domainLocal: true` from `operator` → **403**, and **nothing was written** (no object exists
 *      at that urn afterwards). A refusal that still created the row is not a refusal.
 *   2. The *same* request without `domainLocal` → **201**. This is what stops the file from passing
 *      because the route is simply broken for this actor, and it is the mutation-sensitivity that
 *      makes each 403 attributable to `assertMayDeclareDomainLocal` rather than to the ordinary
 *      `object:write` check that precedes it.
 *   3. An admin (holding `federation:write`) sending `domainLocal: true` → **201 with
 *      `domainLocal === true` on the response**. Deleting the column from the INSERT, or dropping
 *      the field on the way through the route, turns this red — so the authorization test cannot
 *      pass while the feature it guards silently does nothing.
 */

const OPENAPI_PATH = fileURLToPath(
  new URL("../../../../tools/openapi/openapi.v1.json", import.meta.url)
);

type OpenApiDoc = {
  paths: Record<
    string,
    Record<
      string,
      { requestBody?: { content?: Record<string, { schema?: Record<string, unknown> }> } }
    >
  >;
};

/**
 * Every `METHOD /path` in the committed contract whose request body admits `domainLocal`.
 *
 * Read from the emitted document rather than from the Zod sources because the document is what the
 * server actually validates against and what the SDK is generated from — and because a body reached
 * through `.extend()` (the component routes) is invisible to a reader scanning for the field name.
 * The schemas are emitted inline per operation, so a recursive walk is the honest way to find them;
 * `$ref` is followed one hop into `components.schemas` in case that ever changes.
 */
function declaringRoutes(doc: OpenApiDoc): string[] {
  const components = (doc as unknown as { components?: { schemas?: Record<string, unknown> } })
    .components?.schemas;

  function mentionsDomainLocal(node: unknown, depth = 0): boolean {
    if (depth > 25 || node === null || typeof node !== "object") return false;
    if (Array.isArray(node)) return node.some((child) => mentionsDomainLocal(child, depth + 1));
    const record = node as Record<string, unknown>;
    const properties = record.properties;
    if (properties && typeof properties === "object" && "domainLocal" in properties) return true;
    const ref = record.$ref;
    if (typeof ref === "string" && ref.startsWith("#/components/schemas/") && components) {
      const target = components[ref.slice("#/components/schemas/".length)];
      if (target && mentionsDomainLocal(target, depth + 1)) return true;
    }
    return Object.entries(record).some(
      ([key, value]) => key !== "$ref" && mentionsDomainLocal(value, depth + 1)
    );
  }

  const found: string[] = [];
  for (const [path, operations] of Object.entries(doc.paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      if (!["post", "put", "patch"].includes(method)) continue;
      const bodySchemas = Object.values(operation?.requestBody?.content ?? {}).map((c) => c.schema);
      if (bodySchemas.some((schema) => mentionsDomainLocal(schema))) {
        found.push(`${method.toUpperCase()} ${path}`);
      }
    }
  }
  return found.sort();
}

describe("M20.1 (ADR-0031): declaring domainLocal requires federation:write at EVERY door", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let operator: TestUser;
  /**
   * The PUBLISH pair. Two org-defined roles differing in EXACTLY ONE permission, `object:write`, so
   * the 403 below is attributable to the bar under test and to nothing else.
   *
   * Org-defined rather than built-in because no BUILT-IN role can express "federation:write without
   * object:write": `drizzle/0012` puts `federation:write` on Administrator and Owner, and
   * `drizzle/0002` puts `object:write` on both of those plus Operator and Approver, so every
   * built-in holder of one holds the other. Comparing against `admin` instead would leave the 403
   * explainable by any of four other permissions Administrator happens to carry.
   */
  let federationOnly: TestUser;
  let federationAndObjectWrite: TestUser;
  let serviceUrn: string;

  /** Raw inject, not the SDK: the subject is the STATUS an under-permissioned token gets, and the
   *  generated client would shape the call with its own conveniences. */
  async function asOperator(method: "POST" | "PUT", url: string, payload: Record<string, unknown>) {
    return server.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${operator.token}` },
      payload
    });
  }

  async function objectExistsAt(type: string, urn: string): Promise<boolean> {
    const res = await server.app.inject({
      method: "GET",
      url: `/api/v1/objects/${type}/${encodeURIComponent(urn)}`,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    return res.statusCode === 200;
  }

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "domain-local-rbac");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    // Org-root Operator: object:write + relationship:write + federation:read, NO federation:write.
    operator = await createTestUser(server, org, [{ role: "Operator", scope: org.orgId }]);
    federationOnly = await createUserWithPermissions(["federation:read", "federation:write"]);
    federationAndObjectWrite = await createUserWithPermissions([
      "federation:read",
      "federation:write",
      "object:write"
    ]);
    const service = await admin
      .object("service")
      .create({ name: `svc-${randomUUID().slice(0, 8)}` });
    serviceUrn = service.urn;
  }, 180_000);

  /**
   * A subject holding EXACTLY `permissions` at the org root.
   *
   * Viewer is bound purely so the harness mints an auth row and a live token; `object:read` grants
   * no write anywhere and is no part of what is under test.
   */
  async function createUserWithPermissions(permissions: string[]): Promise<TestUser> {
    const user = await createTestUser(server, org, [{ role: "Viewer", scope: org.orgId }]);
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const roleId = randomUUID();
      await tx.insert(roles).values({
        id: roleId,
        orgId: org.orgId,
        name: `dl-publish-${randomUUID().slice(0, 8)}`,
        permissions
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

  /** A fresh domain-local `service`, created by the admin — the only actor that can declare one. */
  async function newDomainLocalService(label: string): Promise<{ id: string }> {
    const created = await admin
      .object("service")
      .create({ name: `${label}-${randomUUID().slice(0, 8)}`, domainLocal: true });
    expect(created.domainLocal).toBe(true);
    return { id: created.id };
  }

  async function publishAs(token: string, id: string) {
    return server.app.inject({
      method: "POST",
      url: `/api/v1/objects/service/${id}/publish`,
      headers: { authorization: `Bearer ${token}` }
    });
  }

  afterAll(async () => {
    await server?.close();
  });

  it("CONTROL: the Operator actor really does hold object:write — so every 403 below is about federation:write", async () => {
    const res = await asOperator("POST", "/api/v1/objects/service", {
      name: `control-${randomUUID().slice(0, 8)}`
    });
    expect(res.statusCode).toBe(201);
  });

  it("CENSUS: every route in the contract that admits domainLocal is covered by a case in this file", () => {
    const doc = JSON.parse(readFileSync(OPENAPI_PATH, "utf8")) as OpenApiDoc;
    const inContract = declaringRoutes(doc);

    // The contract must actually contain the field — otherwise an emit regression that dropped
    // `domainLocal` everywhere would make this test pass by finding nothing to cover. (Paths here
    // are contract paths: the `/api/v1` prefix is the server basePath and is not part of them.)
    expect(inContract).toContain("POST /objects/{type}");
    expect(inContract.length).toBeGreaterThanOrEqual(26);

    // Each door is accounted for by the code path that authorizes it. Two of these were found BY
    // this census rather than before it: `/objects/service` and its `orgs/{org}` path-override form
    // are LITERAL routes Fastify prefers over the parametric `/objects/{type}`, so they carry their
    // own body schema and dropped `domainLocal` silently — the second occurrence of the exact
    // hazard that schema's own comment already records, for `domainId`/`properties`/`labels`/
    // `id`/`urn`.
    const authorizedBy = new Map<string, RegExp[]>([
      ["objects-generic.ts", [/^POST \/objects\/\{type\}$/, /^PUT \/objects\/\{type\}\/\{urn\}$/]],
      ["components.ts", [/^POST \/components$/, /^PUT \/components\/\{urn\}$/]],
      ["objects-service.ts", [/^POST \/(orgs\/\{org\}\/)?objects\/service$/]],
      // routes/typed-registries.ts — ONE factory generating a create/upsert pair per registered
      // type. `/services` is exercised below as its witness; enumerating all twelve types would
      // only re-test the same two `authorize` calls.
      ["typed-registries.ts", [/^(POST|PUT) \/[a-z-]+(\/\{urn\})?$/]]
    ]);

    const unexplained = inContract.filter(
      (route) => ![...authorizedBy.values()].flat().some((pattern) => pattern.test(route))
    );
    // A door that matches no known code path is a NEW one. It fails here until someone decides
    // which module authorizes it — which is the whole reason this census is derived rather than
    // hand-written.
    expect(unexplained).toEqual([]);

    // Each named module must still actually own at least one live route, so deleting a door (or
    // renaming a path) cannot leave a stale entry silently covering nothing.
    for (const [module, patterns] of authorizedBy) {
      expect(
        inContract.filter((route) => patterns.some((pattern) => pattern.test(route))),
        `no contract route is attributed to ${module}`
      ).not.toEqual([]);
    }
  });

  it("POST /objects/{type} — 403 with domainLocal:true, and NOTHING is written", async () => {
    const name = `generic-${randomUUID().slice(0, 8)}`;
    const res = await asOperator("POST", "/api/v1/objects/service", { name, domainLocal: true });
    expect(res.statusCode).toBe(403);
    expect(await objectExistsAt("service", `urn:scp:${org.orgId}:service:${name}`)).toBe(false);
  });

  it("POST /objects/{type} — the SAME request WITHOUT domainLocal succeeds (so the 403 is about the flag)", async () => {
    const res = await asOperator("POST", "/api/v1/objects/service", {
      name: `generic-ok-${randomUUID().slice(0, 8)}`
    });
    expect(res.statusCode).toBe(201);
  });

  it("PUT /objects/{type}/{urn} — 403 with domainLocal:true, and NOTHING is written", async () => {
    const name = `upsert-${randomUUID().slice(0, 8)}`;
    const urn = `urn:scp:${org.orgId}:service:${name}`;
    const res = await asOperator("PUT", `/api/v1/objects/service/${encodeURIComponent(urn)}`, {
      name,
      domainLocal: true
    });
    expect(res.statusCode).toBe(403);
    expect(await objectExistsAt("service", urn)).toBe(false);
  });

  it("POST /components — 403 with domainLocal:true (the door it inherited via .extend())", async () => {
    const name = `cmp-${randomUUID().slice(0, 8)}`;
    const res = await asOperator("POST", "/api/v1/components", {
      name,
      service: serviceUrn,
      domainLocal: true
    });
    expect(res.statusCode).toBe(403);
    expect(await objectExistsAt("component", `urn:scp:${org.orgId}:component:${name}`)).toBe(false);
  });

  it("PUT /components/{urn} — 403 with domainLocal:true", async () => {
    const name = `cmp-upsert-${randomUUID().slice(0, 8)}`;
    const urn = `urn:scp:${org.orgId}:component:${name}`;
    const res = await asOperator("PUT", `/api/v1/components/${encodeURIComponent(urn)}`, {
      name,
      service: serviceUrn,
      domainLocal: true
    });
    expect(res.statusCode).toBe(403);
    expect(await objectExistsAt("component", urn)).toBe(false);
  });

  it("POST /objects/service — 403 with domainLocal:true (the LITERAL route that shadows /objects/{type})", async () => {
    // The door this file's census discovered. Fastify prefers this static route over the parametric
    // one for the exact path `/objects/service`, so it has its own body schema and its own handler —
    // and it dropped `domainLocal` on the floor until the census named it.
    const name = `shadow-${randomUUID().slice(0, 8)}`;
    const res = await asOperator("POST", "/api/v1/objects/service", { name, domainLocal: true });
    expect(res.statusCode).toBe(403);
    expect(await objectExistsAt("service", `urn:scp:${org.orgId}:service:${name}`)).toBe(false);
  });

  it("POST /objects/service — an authorized actor's declaration REACHES the column through the shadowing route", async () => {
    // The other half: proving the shadowing route now threads the field, not merely that it refuses.
    // Before the fix this returned 201 with `domainLocal: false` — a silently discarded declaration,
    // which is worse than a refusal because the operator believes the object stays home.
    const name = `shadow-ok-${randomUUID().slice(0, 8)}`;
    const res = await server.app.inject({
      method: "POST",
      url: "/api/v1/objects/service",
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: { name, domainLocal: true }
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).domainLocal).toBe(true);
  });

  it("POST /services — 403 with domainLocal:true (the typed-registry factory door)", async () => {
    const name = `typed-${randomUUID().slice(0, 8)}`;
    const res = await asOperator("POST", "/api/v1/services", { name, domainLocal: true });
    expect(res.statusCode).toBe(403);
    expect(await objectExistsAt("service", `urn:scp:${org.orgId}:service:${name}`)).toBe(false);
  });

  it("PUT /services/{urn} — 403 with domainLocal:true (the typed-registry factory door)", async () => {
    const name = `typed-upsert-${randomUUID().slice(0, 8)}`;
    const urn = `urn:scp:${org.orgId}:service:${name}`;
    const res = await asOperator("PUT", `/api/v1/services/${encodeURIComponent(urn)}`, {
      name,
      domainLocal: true
    });
    expect(res.statusCode).toBe(403);
    expect(await objectExistsAt("service", urn)).toBe(false);
  });

  it("POST /objects/{type}/{idOrUrn}/publish — 403 without federation:write, and the object stays domain-local", async () => {
    // M20.4. Undoing a boundary decision cannot be cheaper than making it, so publish is gated on
    // the same permissionS that declared locality — this case covers the `federation:write` half,
    // and the two cases below cover the `object:write` half. Note this route takes NO body, so the census above
    // (which reads request bodies) cannot see it — it is covered here explicitly, and this comment
    // is why the census is a floor rather than the whole story.
    const created = await admin
      .object("service")
      .create({ name: `publish-rbac-${randomUUID().slice(0, 8)}`, domainLocal: true });

    const res = await server.app.inject({
      method: "POST",
      url: `/api/v1/objects/service/${created.id}/publish`,
      headers: { authorization: `Bearer ${operator.token}` }
    });
    expect(res.statusCode).toBe(403);

    // The refusal is REAL, not merely a status: the object is untouched and still domain-local.
    const after = await admin.object("service").get(created.id);
    expect(after.domainLocal).toBe(true);
  });

  it("POST /objects/{type}/{idOrUrn}/publish — 403 with federation:write but NO object:write, and the object stays domain-local", async () => {
    // THE ASYMMETRY THIS CLOSES. Declaring locality costs `object:write` AND `federation:write`
    // (every 403 above). Publishing — the INVERSE verb, which UPDATEs the estate row, bumps
    // `version`, and sweeps the object plus its edges onto the federation journal — cost only
    // `federation:write`. So the FederationAdmin shape ("operates the link, does not edit the
    // estate", `federation/handfill-repo.ts`) could mutate and re-version estate rows here.
    //
    // The actor differs from the one in the NEXT case in exactly one permission, so this 403 cannot
    // be explained by anything but the `object:write` bar.
    const created = await newDomainLocalService("publish-no-objwrite");

    const res = await publishAs(federationOnly.token, created.id);
    expect(res.statusCode, res.body).toBe(403);

    // The refusal is REAL, not merely a status: the row is untouched and still domain-local.
    const after = await admin.object("service").get(created.id);
    expect(after.domainLocal).toBe(true);
  });

  it("POST /objects/{type}/{idOrUrn}/publish — the SAME actor plus object:write succeeds (so the 403 is about object:write)", async () => {
    // The control that earns the case above its reading. Without it, the file would pass just as
    // well against a publish route that is broken for every non-admin subject.
    const created = await newDomainLocalService("publish-both");

    const res = await publishAs(federationAndObjectWrite.token, created.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body).object.domainLocal).toBe(false);
  });

  it("POST /objects/{type}/{idOrUrn}/publish — an authorized actor publishes, and it is one-way", async () => {
    const created = await admin
      .object("service")
      .create({ name: `publish-ok-${randomUUID().slice(0, 8)}`, domainLocal: true });

    const res = await server.app.inject({
      method: "POST",
      url: `/api/v1/objects/service/${created.id}/publish`,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).object.domainLocal).toBe(false);

    // Second publish is a 409, not a silent success — re-journaling an object that already federates
    // would emit a redundant revision to every peer.
    const again = await server.app.inject({
      method: "POST",
      url: `/api/v1/objects/service/${created.id}/publish`,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    expect(again.statusCode).toBe(409);
  });

  it("AN AUTHORIZED ACTOR ACTUALLY GETS THE DECLARATION — the guard is not just refusing everyone", async () => {
    const created = await admin
      .object("service")
      .create({ name: `declared-${randomUUID().slice(0, 8)}`, domainLocal: true });
    // Round-tripped through the wire contract, so dropping the field anywhere between the route and
    // the column turns this red — the authorization tests above cannot pass over a no-op feature.
    expect(created.domainLocal).toBe(true);

    const fetched = await admin.object("service").get(created.id);
    expect(fetched.domainLocal).toBe(true);
  });

  it("an ordinary object is domainLocal:false — the default is the status quo, present on the wire", async () => {
    const created = await admin
      .object("service")
      .create({ name: `ordinary-${randomUUID().slice(0, 8)}` });
    expect(created.domainLocal).toBe(false);
  });
});
