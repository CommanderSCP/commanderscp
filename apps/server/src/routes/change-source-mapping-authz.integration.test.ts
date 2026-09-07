import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import {
  createTestComponent,
  createTestOrg,
  createTestUser,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/** The three mapping mutation doors take write at the root. See docs/routes.md §27. */
describe("source-mapping write doors are scoped at the component, credential doors are not", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  /** A component the narrow actor administers, and one they hold nothing at. */
  let mineId: string;
  let theirsId: string;
  let mineName: string;
  let theirsName: string;
  /** Bearer token whose ONLY binding is `Administrator` at `mineId`. */
  let mineToken: string;
  /** Bearer token for a real, authenticated user with NO role bindings at all. */
  let unboundToken: string;

  beforeAll(async () => {
    // `withPluginHost` for one reason only: `POST /discovery/run` fail-closes on `deps.pluginHost`
    // BEFORE it authorizes, so without a host every caller gets 400 and the org-root pin this file
    // exists to hold would be untestable at that door.
    server = await listenTestServer({ withPluginHost: true });
    org = await createTestOrg(server, "mapping-authz");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    mineName = `mine-${randomUUID().slice(0, 8)}`;
    theirsName = `theirs-${randomUUID().slice(0, 8)}`;
    mineId = (await createTestComponent(admin, { name: mineName })).id;
    theirsId = (await createTestComponent(admin, { name: theirsName })).id;

    // Administrator carries `object:write`, bound at ONE component and nowhere else — genuine,
    // legitimate authority over that component, and none at all over its sibling.
    mineToken = (await createTestUser(server, org, [{ role: "Administrator", scope: mineId }]))
      .token;
    // Authenticated, and holding nothing anywhere — the principal a door with no bar of its own
    // would admit. `requireAuth` passes for this token; only `authorize` stops it.
    unboundToken = (await createTestUser(server, org, [])).token;
  }, 180_000);

  afterAll(async () => {
    await server?.close();
  });

  interface Response {
    status: number;
    body: string;
    json: () => Record<string, unknown>;
  }

  async function call(
    method: "POST" | "PUT" | "PATCH" | "DELETE",
    token: string,
    url: string,
    payload?: Record<string, unknown>
  ): Promise<Response> {
    const res = await server.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload })
    });
    return { status: res.statusCode, body: res.body, json: () => res.json() };
  }

  /** Creates one mapping per component through the real door, as the org-root admin. */
  async function seed(sourceKind: string): Promise<{ mine: string; theirs: string }> {
    const mine = await admin.changeSources.createMapping(sourceKind, {
      component: mineId,
      repoPattern: `acme/${sourceKind}-mine`,
      type: "configuration"
    });
    const theirs = await admin.changeSources.createMapping(sourceKind, {
      component: theirsId,
      repoPattern: `acme/${sourceKind}-theirs`,
      type: "configuration"
    });
    return { mine: mine.id, theirs: theirs.id };
  }

  it("PATCH .../mappings/{id}: a component-bound admin flips THEIR mapping's pause switch and not a sibling's", async () => {
    const kind = `pause-${randomUUID().slice(0, 8)}`;
    const { mine, theirs } = await seed(kind);

    const own = await call("PATCH", mineToken, `/api/v1/change-sources/${kind}/mappings/${mine}`, {
      enabled: false
    });
    expect(own.status, own.body).toBe(200);
    expect(own.json().enabled).toBe(false);

    const other = await call(
      "PATCH",
      mineToken,
      `/api/v1/change-sources/${kind}/mappings/${theirs}`,
      { enabled: false }
    );
    expect(other.status, other.body).toBe(403);

    // The refusal is real, not cosmetic: the sibling is still routing.
    const after = await admin.changeSources.listMappings(kind);
    expect(after.items.find((m) => m.id === theirs)?.enabled).toBe(true);

    // PURE WIDENING: the org-root Owner reaches the same row it always could.
    const asOwner = await call(
      "PATCH",
      org.adminToken,
      `/api/v1/change-sources/${kind}/mappings/${theirs}`,
      { enabled: false }
    );
    expect(asOwner.status, asOwner.body).toBe(200);
  });

  it("PATCH .../mappings/{id}/scope: same component bar on the scope label", async () => {
    const kind = `label-${randomUUID().slice(0, 8)}`;
    const { mine, theirs } = await seed(kind);

    const own = await call(
      "PATCH",
      mineToken,
      `/api/v1/change-sources/${kind}/mappings/${mine}/scope`,
      { scope: "domain" }
    );
    expect(own.status, own.body).toBe(200);
    expect(own.json().scope).toBe("domain");

    const other = await call(
      "PATCH",
      mineToken,
      `/api/v1/change-sources/${kind}/mappings/${theirs}/scope`,
      { scope: "global" }
    );
    expect(other.status, other.body).toBe(403);
    const after = await admin.changeSources.listMappings(kind);
    expect(after.items.find((m) => m.id === theirs)?.scope).toBeNull();

    const asOwner = await call(
      "PATCH",
      org.adminToken,
      `/api/v1/change-sources/${kind}/mappings/${theirs}/scope`,
      { scope: "global" }
    );
    expect(asOwner.status, asOwner.body).toBe(200);
  });

  it("DELETE .../mappings: authorized at the component named in the body, so a sibling's rows survive", async () => {
    const kind = `del-${randomUUID().slice(0, 8)}`;
    await seed(kind);

    const other = await call("DELETE", mineToken, `/api/v1/change-sources/${kind}/mappings`, {
      component: theirsId,
      repoPattern: `acme/${kind}-theirs`,
      pathPattern: null,
      type: "configuration"
    });
    expect(other.status, other.body).toBe(403);
    expect((await admin.changeSources.listMappings(kind)).items).toHaveLength(2);

    const own = await call("DELETE", mineToken, `/api/v1/change-sources/${kind}/mappings`, {
      component: mineId,
      repoPattern: `acme/${kind}-mine`,
      pathPattern: null,
      type: "configuration"
    });
    expect(own.status, own.body).toBe(200);
    expect(own.json().deleted).toBe(1);

    const asOwner = await call(
      "DELETE",
      org.adminToken,
      `/api/v1/change-sources/${kind}/mappings`,
      {
        component: theirsId,
        repoPattern: `acme/${kind}-theirs`,
        pathPattern: null,
        type: "configuration"
      }
    );
    expect(asOwner.status, asOwner.body).toBe(200);
    expect(asOwner.json().deleted).toBe(1);
  });

  it("the org-root Owner still reaches a STRANDED mapping whose component's ancestors are all tombstoned", async () => {
    // THE CASE THAT MAKES THE RE-SCOPE A DISJUNCTION RATHER THAN A MOVE. See docs/routes.md §28.
    const kind = `stranded-${randomUUID().slice(0, 8)}`;
    const label = randomUUID().slice(0, 8);

    const domain = await call("POST", org.adminToken, "/api/v1/domains", {
      name: `stranded-domain-${label}`
    });
    expect(domain.status, domain.body).toBe(201);
    const domainId = domain.json().id as string;

    const service = await call("POST", org.adminToken, "/api/v1/services", {
      name: `stranded-svc-${label}`,
      domainId
    });
    expect(service.status, service.body).toBe(201);
    const serviceId = service.json().id as string;

    // `domainId` AND `service`: route 1 (`objects.domain_id`) and route 2 (the `contains` edge) are
    // separate arms of the upward walk, so both have to be cut for the chain to dead-end. Pointing
    // the component's containment parent at the DOMAIN, and deleting the service too, cuts both.
    const component = await call("POST", org.adminToken, "/api/v1/components", {
      name: `stranded-comp-${label}`,
      service: serviceId,
      domainId
    });
    expect(component.status, component.body).toBe(201);
    const componentId = component.json().id as string;

    // TWO mappings, both created BEFORE the deletions — `createSourceMapping` resolves its
    // component live, so a stranded mapping can only ever come into being this way (which is
    // precisely how a merge strands one). The second is the control for the refusal at the end.
    const mapping = await admin.changeSources.createMapping(kind, {
      component: componentId,
      repoPattern: `acme/${kind}`,
      type: "configuration"
    });
    const stray = await admin.changeSources.createMapping(kind, {
      component: componentId,
      repoPattern: `acme/${kind}-stray`,
      type: "configuration"
    });

    const delComponent = await call("DELETE", org.adminToken, `/api/v1/components/${componentId}`);
    expect(delComponent.status, delComponent.body).toBe(200);
    const delService = await call("DELETE", org.adminToken, `/api/v1/services/${serviceId}`);
    expect(delService.status, delService.body).toBe(200);
    // The orphan guard permits this precisely because every child is already a tombstone. If it
    // ever stopped permitting it, this test would stop covering the case it names — so assert it.
    const delDomain = await call("DELETE", org.adminToken, `/api/v1/domains/${domainId}`);
    expect(delDomain.status, delDomain.body).toBe(200);

    // The mappings outlived all three, which is the whole problem.
    expect((await admin.changeSources.listMappings(kind)).items.map((m) => m.id).sort()).toEqual(
      [mapping.id, stray.id].sort()
    );

    // All three re-scoped doors, as the org-root Owner. Without the org-root arm every one of
    // these is a 403 — the walk from `componentId` reaches nothing at all.
    const pause = await call(
      "PATCH",
      org.adminToken,
      `/api/v1/change-sources/${kind}/mappings/${mapping.id}`,
      { enabled: false }
    );
    expect(pause.status, pause.body).toBe(200);

    const scope = await call(
      "PATCH",
      org.adminToken,
      `/api/v1/change-sources/${kind}/mappings/${mapping.id}/scope`,
      { scope: "domain" }
    );
    expect(scope.status, scope.body).toBe(200);

    const removed = await call(
      "DELETE",
      org.adminToken,
      `/api/v1/change-sources/${kind}/mappings`,
      {
        component: componentId,
        repoPattern: `acme/${kind}`,
        pathPattern: null,
        type: "configuration"
      }
    );
    expect(removed.status, removed.body).toBe(200);
    expect(removed.json().deleted).toBe(1);
    expect((await admin.changeSources.listMappings(kind)).items.map((m) => m.id)).toEqual([
      stray.id
    ]);

    // And the widening did not leak the other way: a principal with no bindings anywhere is still
    // refused at the surviving stranded mapping. A cut chain reaches NO binding, so a check that
    // had simply stopped refusing would look identical to the fix from the Owner's side alone.
    const refused = await call(
      "PATCH",
      unboundToken,
      `/api/v1/change-sources/${kind}/mappings/${stray.id}`,
      { enabled: false }
    );
    expect(refused.status, refused.body).toBe(403);
  });

  it("an unknown mapping id stays 404 for BOTH — resolving the row before scoping is what keeps it from becoming 403", async () => {
    // `scopeExpandCte` seeds its CTE with the raw uuid and never checks existence, so scoping at an
    // id that names nothing expands to a one-row set no binding matches — including the org root
    // Owner's. Loading the row first is the only thing that keeps this a 404.
    const kind = `missing-${randomUUID().slice(0, 8)}`;
    const ghost = randomUUID();

    const asOwner = await call(
      "PATCH",
      org.adminToken,
      `/api/v1/change-sources/${kind}/mappings/${ghost}`,
      { enabled: false }
    );
    expect(asOwner.status, asOwner.body).toBe(404);

    const asNarrow = await call(
      "PATCH",
      mineToken,
      `/api/v1/change-sources/${kind}/mappings/${ghost}/scope`,
      { scope: "domain" }
    );
    expect(asNarrow.status, asNarrow.body).toBe(404);
  });

  // The doors §8.6 excludes — org-root `object:write`/`object:read`, deliberately

  it("the credential doors still demand org-root authority: a component-bound admin is refused at every one", async () => {
    const key = `cred-${randomUUID().slice(0, 8)}`;
    const kind = `cred-${randomUUID().slice(0, 8)}`;

    // Each pair: refused for one principal, allowed for the other. See docs/routes.md §29.
    const put = await call("PUT", mineToken, `/api/v1/secrets/${key}`, { value: "v" });
    expect(put.status, put.body).toBe(403);
    const putAsOwner = await call("PUT", org.adminToken, `/api/v1/secrets/${key}`, { value: "v" });
    expect(putAsOwner.status, putAsOwner.body).toBe(200);

    const del = await call("DELETE", mineToken, `/api/v1/secrets/${key}`);
    expect(del.status, del.body).toBe(403);
    const delAsOwner = await call("DELETE", org.adminToken, `/api/v1/secrets/${key}`);
    expect(delAsOwner.status, delAsOwner.body).toBe(204);

    const hook = await call("PUT", mineToken, `/api/v1/change-sources/${kind}/webhook-secret`, {
      secret: "s"
    });
    expect(hook.status, hook.body).toBe(403);
    const hookAsOwner = await call(
      "PUT",
      org.adminToken,
      `/api/v1/change-sources/${kind}/webhook-secret`,
      { secret: "s" }
    );
    expect(hookAsOwner.status, hookAsOwner.body).toBe(200);

    // THE `accept` PROBE IS GONE WITH ITS DOOR (ADR-0047). It checked that a component-bound
    // Administrator is refused at an org-root-barred door and the owner passes. That property is
    // still proven immediately below by `/discovery/run`, which carries the same org-root bar and
    // is the door that still exists — so the case keeps its subject, one probe lighter.

    // The discovery route's org-root bar is a different one. See docs/routes.md §30.
    const run = {
      pluginModule: "argocd-discovery",
      pluginInstanceId: `probe-${randomUUID().slice(0, 8)}`,
      config: {}
    };
    const dial = await call("POST", mineToken, "/api/v1/discovery/run", run);
    expect(dial.status, dial.body).toBe(403);
    const dialAsOwner = await call("POST", org.adminToken, "/api/v1/discovery/run", run);
    expect(dialAsOwner.status, dialAsOwner.body).toBe(400);
  });
});
