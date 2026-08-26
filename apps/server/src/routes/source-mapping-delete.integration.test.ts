import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { ScpClient } from "@scp/sdk";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * DELETING A SOURCE MAPPING — the first operator-facing delete this table has had.
 *
 * ============================================================================================
 * WHY THE ROUTE EXISTS
 * ============================================================================================
 * Before this, the ONLY way to remove a `source_mappings` row was an IaC apply's prune. A mapping
 * created by `discovery accept` or by hand could never be taken back through the API.
 *
 * The cost is not inconvenience. A `docs/proposals/post-import-configuration.md` §6 pair merge
 * soft-deletes the absorbed component and
 * STRANDS its mappings: they stop matching (a dead component is excluded at read time) but they stay
 * in the table and keep appearing in `GET /mappings`, with no way to clean them. On the live homelab
 * that is 5 rows left by three merges.
 *
 * ============================================================================================
 * WHY THE IDENTITY TUPLE AND NOT AN ID
 * ============================================================================================
 * `source_mappings` has no unique constraint and `POST /discovery/accept` inserts unconditionally,
 * so an estate can hold several byte-identical rows — the homelab does. A by-id delete would remove
 * one and leave the survivor still correlating, so the operator would see "deleted" and a push would
 * still route there. Matching the tuple removes everything that says the same thing, which is the
 * reasoning `deleteSourceMappingsMatching` was already written with for IaC prune.
 *
 * ============================================================================================
 * MUTATION LOG (each applied ALONE against a passing suite, then reverted)
 * ============================================================================================
 * | Mutation | Result |
 * |---|---|
 * | resolve the component WITHOUT `includeDeleted` | the stranded-mapping test FAILS with 404 — the rows most needing deletion are exactly the undeletable ones |
 * | return 204 instead of the row count | the duplicate test FAILS — it can no longer tell 2 rows removed from 0 |
 * | delete only the first matching row | the duplicate test FAILS — the survivor still correlates |
 */
describe("deleting a source mapping", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "mapping-delete");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  it("removes a mapping and reports the count", async () => {
    const kind = `del-${uuidv7()}`;
    const repo = `acme/one-${uuidv7()}`;
    const c = await createTestComponent(admin, { name: `del-${uuidv7()}` });
    await admin.changeSources.createMapping(kind, {
      component: c.id,
      repoPattern: repo,
      type: "configuration"
    });
    expect((await admin.changeSources.listMappings(kind)).items).toHaveLength(1);

    const { deleted } = await admin.changeSources.deleteMapping(kind, {
      component: c.id,
      repoPattern: repo,
      pathPattern: null,
      type: "configuration"
    });

    expect(deleted).toBe(1);
    expect((await admin.changeSources.listMappings(kind)).items).toHaveLength(0);
  });

  it("removes EVERY byte-identical duplicate, not just one", async () => {
    // The homelab holds duplicates because `discovery accept` inserts unconditionally. Removing one
    // would report success while the survivor kept correlating.
    const kind = `del-dup-${uuidv7()}`;
    const repo = `acme/dup-${uuidv7()}`;
    const c = await createTestComponent(admin, { name: `dup-${uuidv7()}` });
    for (let i = 0; i < 3; i++) {
      await admin.changeSources.createMapping(kind, {
        component: c.id,
        repoPattern: repo,
        type: "configuration"
      });
    }
    expect((await admin.changeSources.listMappings(kind)).items).toHaveLength(3);

    const { deleted } = await admin.changeSources.deleteMapping(kind, {
      component: c.id,
      repoPattern: repo,
      pathPattern: null,
      type: "configuration"
    });

    expect(deleted, "all three, or the survivor still routes").toBe(3);
    expect((await admin.changeSources.listMappings(kind)).items).toHaveLength(0);
  });

  it("deletes a mapping STRANDED on a soft-deleted component — the case it was built for", async () => {
    const kind = `del-stranded-${uuidv7()}`;
    const repo = `acme/stranded-${uuidv7()}`;
    const doomed = await createTestComponent(admin, { name: `stranded-${uuidv7()}` });
    await admin.changeSources.createMapping(kind, {
      component: doomed.id,
      repoPattern: repo,
      type: "configuration"
    });

    await admin.components.delete(doomed.id);
    // Still listed: the row outlives its component, which is the whole problem.
    expect((await admin.changeSources.listMappings(kind)).items).toHaveLength(1);

    const { deleted } = await admin.changeSources.deleteMapping(kind, {
      component: doomed.id,
      repoPattern: repo,
      pathPattern: null,
      type: "configuration"
    });

    expect(
      deleted,
      "resolving the component must accept a deleted one — otherwise the rows most in need of cleanup are precisely the ones that cannot be cleaned"
    ).toBe(1);
    expect((await admin.changeSources.listMappings(kind)).items).toHaveLength(0);
  });

  it("reports 0 rather than failing when nothing matches", async () => {
    // A no-op must be visible. A bare 204 would look identical to a successful delete, and the
    // operator would believe a mapping was gone that is still routing.
    const kind = `del-none-${uuidv7()}`;
    const c = await createTestComponent(admin, { name: `none-${uuidv7()}` });
    const { deleted } = await admin.changeSources.deleteMapping(kind, {
      component: c.id,
      repoPattern: "acme/never-mapped",
      pathPattern: null,
      type: "configuration"
    });
    expect(deleted).toBe(0);
  });

  it("does NOT delete a mapping that differs only by pathPattern", async () => {
    // NULL is a meaningful pattern value, so absent and null must target different rows. If the
    // tuple were matched loosely, deleting the catch-all would take the path-scoped row with it.
    const kind = `del-precise-${uuidv7()}`;
    const repo = `acme/precise-${uuidv7()}`;
    const c = await createTestComponent(admin, { name: `precise-${uuidv7()}` });
    await admin.changeSources.createMapping(kind, {
      component: c.id,
      repoPattern: repo,
      type: "configuration"
    });
    await admin.changeSources.createMapping(kind, {
      component: c.id,
      repoPattern: repo,
      pathPattern: "svc/**",
      type: "configuration"
    });

    const { deleted } = await admin.changeSources.deleteMapping(kind, {
      component: c.id,
      repoPattern: repo,
      pathPattern: null,
      type: "configuration"
    });

    expect(deleted, "only the catch-all").toBe(1);
    const left = (await admin.changeSources.listMappings(kind)).items;
    expect(left).toHaveLength(1);
    expect(left[0]!.pathPattern).toBe("svc/**");
  });
});
