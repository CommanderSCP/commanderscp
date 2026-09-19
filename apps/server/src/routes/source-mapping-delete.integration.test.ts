import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { ScpClient } from "@scp/sdk";
import { withTenantTx } from "../db/tenant-tx.js";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/** DELETING A SOURCE MAPPING. See docs/routes.md §412. */
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

    // TOMBSTONED BENEATH THE API, deliberately, and this is the one honest way to write this test
    // from 2026-09-18 on: `DELETE /components/{id}` now REFUSES while a mapping names the component
    // (`graph/objects-repo.ts` route 5, docs/graph.md §125a), so the API can no longer produce this
    // state. The population it addresses is the rows created BEFORE that guard existed — 38 of them
    // on the live homelab — and they must stay deletable, which is what this test pins.
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.execute(
        sql`UPDATE objects SET deleted_at = now() WHERE id = ${doomed.id}::uuid AND org_id = ${org.orgId}::uuid`
      )
    );
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

  it("writes one source_mapping.delete audit event PER ROW, naming the component and the tuple", async () => {
    // A hard delete of correlation config leaves nothing behind — no row, no tombstone, no
    // `deleted_at` — so the audit event is the ONLY surviving record that the route existed and who
    // removed it (charter principle 6). Per row, not per call: the duplicate case above would
    // otherwise report one event for three removed routes.
    const kind = `del-audit-${uuidv7()}`;
    const repo = `acme/audit-${uuidv7()}`;
    const c = await createTestComponent(admin, { name: `audit-${uuidv7()}` });
    for (let i = 0; i < 2; i++) {
      await admin.changeSources.createMapping(kind, {
        component: c.id,
        repoPattern: repo,
        pathPattern: "svc/**",
        type: "configuration"
      });
    }

    const { deleted } = await admin.changeSources.deleteMapping(kind, {
      component: c.id,
      repoPattern: repo,
      pathPattern: "svc/**",
      type: "configuration"
    });
    expect(deleted).toBe(2);

    const page = await admin.auditEvents.list({ limit: 200 });
    const events = page.items.filter(
      (e) => e.action === "source_mapping.delete" && e.subjectId === c.id
    );
    expect(events, "one per removed row").toHaveLength(2);
    expect(events[0]!.reason).toContain(kind);
    expect(events[0]!.reason).toContain(repo);
    expect(events[0]!.reason).toContain("svc/**");
    expect(events[0]!.reason).toContain(c.id);
  });

  it("writes NO audit event when nothing matched — a no-op is not an action", async () => {
    const kind = `del-audit-none-${uuidv7()}`;
    const c = await createTestComponent(admin, { name: `audit-none-${uuidv7()}` });
    const { deleted } = await admin.changeSources.deleteMapping(kind, {
      component: c.id,
      repoPattern: "acme/never-mapped",
      pathPattern: null,
      type: "configuration"
    });
    expect(deleted).toBe(0);
    const page = await admin.auditEvents.list({ limit: 200 });
    expect(
      page.items.filter((e) => e.action === "source_mapping.delete" && e.subjectId === c.id)
    ).toHaveLength(0);
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
