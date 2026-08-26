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

/**
 * SOURCE-MAPPING WRITE DOORS ARE AUTHORIZED AT THE COMPONENT THE MAPPING BELONGS TO — and the
 * CREDENTIAL doors next to them are NOT.
 *
 * ============================================================================================
 * WHY THIS FILE EXISTS
 * ============================================================================================
 * `authz/resolve.ts` expands a checked scope strictly UPWARD, so a check pinned at `auth.orgId` can
 * be satisfied by an org-root binding and by NOTHING else. Every write door on `source_mappings`
 * was pinned that way, which made the mappings of a component unreachable to the very role that
 * administers the component (docs/proposals/role-model.md §4.2/§8). Re-scoping each door to the
 * object that actually carries the authority — the mapping's `component_object_id` — is a PURE
 * WIDENING: an org-root binding still satisfies a check at any object below it, so everything that
 * worked before still works, identically. The org-root cases below are here to hold that line.
 *
 * ============================================================================================
 * AND WHY IT ALSO TESTS DOORS THAT WERE DELIBERATELY LEFT ALONE
 * ============================================================================================
 * The re-scope above is a `object:write`-plus-`auth.orgId` pattern, and the same two files hold
 * four more instances of that pattern that MUST NOT be re-scoped (role-model.md §8.6): the
 * encrypted-secret doors, the webhook-secret door, and the two discovery doors that make SCP dial
 * an execution system with stored credentials. Sweeping them mechanically would hand a
 * component-scoped administrator the org's execution-system credentials. Nothing in the tree
 * pinned their org-root requirement — all 334 `403` assertions in `apps/server` were enumerated and
 * ZERO covered any of these doors — so the next person running this census could sweep them and
 * ship green. The last case below is that pin.
 *
 * ============================================================================================
 * MUTATION LOG (each applied ALONE against a passing suite, then reverted)
 * ============================================================================================
 * | Mutation | Result |
 * |---|---|
 * | revert `PATCH .../mappings/:id` to `scopeObjectId: auth.orgId` | the pause-switch case FAILS: 403 where 200 was expected |
 * | revert `PATCH .../mappings/:id/scope` to `scopeObjectId: auth.orgId` | the scope-label case FAILS: 403 where 200 was expected |
 * | revert `DELETE .../mappings` to `scopeObjectId: auth.orgId` | the delete case FAILS: 403 where 200 was expected |
 * | drop the per-component `hasPermission` inside `backfillSourceMappings` | the backfill case FAILS: 2 mappings created instead of 1 — it writes the OTHER team's row |
 * | delete the `authorize` at `PUT /secrets/{key}` (a credential door has no object to re-scope TO, so a sweep can only weaken it) | the credential-door case FAILS: 200 where 403 was expected |
 */
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

  // -------------------------------------------------------------------------------------------
  // The re-scoped doors
  // -------------------------------------------------------------------------------------------

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

  it("POST /discovery/backfill-source-mappings creates only the components the caller can write, and says so", async () => {
    const kind = `backfill-${randomUUID().slice(0, 8)}`;
    const proposal = {
      objects: [],
      relationships: [],
      sourceMappings: [
        { objectName: mineName, sourceKind: kind, repoPattern: "acme/mine", type: "configuration" },
        {
          objectName: theirsName,
          sourceKind: kind,
          repoPattern: "acme/theirs",
          type: "configuration"
        }
      ]
    };

    const narrow = await call("POST", mineToken, "/api/v1/discovery/backfill-source-mappings", {
      proposal
    });
    expect(narrow.status, narrow.body).toBe(200);
    const narrowBody = narrow.json() as {
      createdSourceMappingIds: string[];
      skipped: Array<{ objectName: string; reason: string }>;
    };
    expect(narrowBody.createdSourceMappingIds).toHaveLength(1);
    expect(narrowBody.skipped).toEqual([
      { objectName: theirsName, reason: expect.stringContaining("object:write") }
    ]);

    // The skip is a real refusal to write, not a cosmetic report.
    const created = await admin.changeSources.listMappings(kind);
    expect(created.items).toHaveLength(1);
    expect(created.items[0]!.componentObjectId).toBe(mineId);

    // PURE WIDENING: the org-root Owner still backfills everything — here, the one row the narrow
    // actor was refused (the other is now a duplicate, and stays idempotently skipped).
    const asOwner = await call(
      "POST",
      org.adminToken,
      "/api/v1/discovery/backfill-source-mappings",
      { proposal }
    );
    expect(asOwner.status, asOwner.body).toBe(200);
    const ownerBody = asOwner.json() as {
      createdSourceMappingIds: string[];
      skipped: Array<{ objectName: string; reason: string }>;
    };
    expect(ownerBody.createdSourceMappingIds).toHaveLength(1);
    expect(ownerBody.skipped).toEqual([{ objectName: mineName, reason: "already mapped" }]);
    expect((await admin.changeSources.listMappings(kind)).items).toHaveLength(2);
  });

  // -------------------------------------------------------------------------------------------
  // The doors §8.6 excludes — org-root `object:write`/`object:read`, deliberately
  // -------------------------------------------------------------------------------------------

  it("the credential doors still demand org-root authority: a component-bound admin is refused at every one", async () => {
    const key = `cred-${randomUUID().slice(0, 8)}`;
    const kind = `cred-${randomUUID().slice(0, 8)}`;

    // Each pair is (refused for the component-bound admin, NOT refused for the org root). The
    // second half of every pair is what makes the first half meaningful: it proves the request was
    // otherwise well-formed and that only the actor's standing decided the outcome.
    //
    // `PUT`/`DELETE /secrets/{key}` and `PUT .../webhook-secret` write the org's encrypted
    // credential material; role-model.md §1.3d splits these into their own `secret:write`
    // permission rather than widening them. `POST /discovery/run` and `/accept` are the doors that
    // make SCP dial an execution system with a stored token, or commit what such a dial returned.
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

    const accepted = {
      proposal: {
        objects: [{ typeId: "component", name: `disc-${randomUUID().slice(0, 8)}` }],
        relationships: []
      }
    };
    const accept = await call("POST", mineToken, "/api/v1/discovery/accept", accepted);
    expect(accept.status, accept.body).toBe(403);
    const acceptAsOwner = await call("POST", org.adminToken, "/api/v1/discovery/accept", accepted);
    expect(acceptAsOwner.status, acceptAsOwner.body).toBe(201);

    // `/discovery/run`'s org-root bar is `object:read`, which the component-bound Administrator
    // holds AT THEIR COMPONENT and nowhere else — so it refuses for exactly the reason under test.
    // The owner's control stops at 400 (an empty argocd config fails `validatePluginConfig`), which
    // is downstream of the authorize call and therefore proves it passed — and, unlike a 200, it
    // dials nothing.
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
