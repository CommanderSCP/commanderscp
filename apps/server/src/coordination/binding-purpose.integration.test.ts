import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import { withTenantTx } from "../db/tenant-tx.js";
import { getExecutorBinding, listExecutorBindingsForTarget } from "./executor-bindings-repo.js";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * `executor_bindings.purpose` — 1:1 -> 1:N per target (model P3, migration 0023).
 *
 * Owner model: "All services involve infra and software." A component may own BOTH pipelines — e.g. a
 * fleet of static instances with its own infra pipeline AND its own software deploy. The schema made
 * that impossible: UNIQUE(org_id, target_object_id), and upsertExecutorBinding keyed its lookup on
 * (org, target) — so binding the second pipeline SILENTLY REPLACED the first. No error, no warning,
 * just one binding quietly gone. That silent-destruction case is the first test below.
 *
 * The second thing under test is that 1:N changed NOTHING for existing deployments: every pre-P3
 * binding migrated to purpose='software', and reconcile/resolve ask for 'software'.
 */
describe("executor bindings: 1:N per target, keyed by purpose", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "binding-purpose");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  // `fake-executor` deliberately: it is in KNOWN_EXECUTOR_MODULES but has no manifest, so
  // validatePluginConfig skips it — this file is about PURPOSE, not each plugin's config shape.
  const bind = (targetId: string, purpose: "infra" | "software" | undefined, instance: string) =>
    admin.executors.putBinding(targetId, {
      pluginModule: "fake-executor",
      pluginInstanceId: instance,
      ...(purpose ? { purpose } : {}),
      config: {}
    });

  it("a component holds BOTH an infra and a software binding — adding one no longer destroys the other", async () => {
    const comp = await createTestComponent(admin, { name: "static-fleet" });

    const software = await bind(comp.id, "software", "gh-deploy");
    const infra = await bind(comp.id, "infra", "gh-terraform");

    expect(software.purpose).toBe("software");
    expect(infra.purpose).toBe("infra");
    expect(infra.id).not.toBe(software.id); // a NEW row, not an update of the first

    // Pre-P3 this returned ONE row and the software binding was gone.
    const all = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      listExecutorBindingsForTarget(tx, org.orgId, comp.id)
    );
    expect(all).toHaveLength(2);
    expect(all.map((b) => b.purpose).sort()).toEqual(["infra", "software"]);
    expect(all.find((b) => b.purpose === "software")!.pluginInstanceId).toBe("gh-deploy");
    expect(all.find((b) => b.purpose === "infra")!.pluginInstanceId).toBe("gh-terraform");
  });

  it("re-binding the SAME purpose still updates in place (one pipeline per purpose)", async () => {
    const comp = await createTestComponent(admin, { name: "rebind-me" });
    const first = await bind(comp.id, "software", "gh-deploy-v1");
    const second = await bind(comp.id, "software", "gh-deploy-v2");

    expect(second.id).toBe(first.id); // updated, not duplicated
    const all = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      listExecutorBindingsForTarget(tx, org.orgId, comp.id)
    );
    expect(all).toHaveLength(1);
    expect(all[0]!.pluginInstanceId).toBe("gh-deploy-v2");
  });

  it("omitting purpose defaults to 'software' — the behaviour-preserving default", async () => {
    const comp = await createTestComponent(admin, { name: "legacy-shaped" });
    const created = await bind(comp.id, undefined, "gh-legacy");
    expect(created.purpose).toBe("software");

    // And it is the one an unqualified lookup finds — i.e. exactly what reconcile triggers.
    const found = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      getExecutorBinding(tx, org.orgId, comp.id)
    );
    expect(found?.pluginInstanceId).toBe("gh-legacy");
  });

  it("reconcile's lookup ('software') is unaffected by an infra binding existing", async () => {
    // The regression that would matter most: adding an infra pipeline must not change which binding
    // a 'software' lookup resolves. (When this was written P4 did not exist and reconcile could only
    // ever ask for 'software'; P4A now lets a wave target name its purpose, and
    // `wave-target-purpose.integration.test.ts` covers the routing end to end. This stays as the
    // narrow unit-level guarantee the resolver itself owes.)
    const comp = await createTestComponent(admin, { name: "both-pipelines" });
    await bind(comp.id, "software", "gh-deploy");
    await bind(comp.id, "infra", "gh-terraform");

    const forReconcile = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      getExecutorBinding(tx, org.orgId, comp.id, "software")
    );
    expect(forReconcile?.pluginInstanceId).toBe("gh-deploy");

    const forInfra = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      getExecutorBinding(tx, org.orgId, comp.id, "infra")
    );
    expect(forInfra?.pluginInstanceId).toBe("gh-terraform");
  });

  it("rejects a purpose outside the closed set", async () => {
    const comp = await createTestComponent(admin, { name: "bad-purpose" });
    await expect(
      admin.executors.putBinding(comp.id, {
        pluginModule: "fake-executor",
        pluginInstanceId: "x",
        // 'data' was explicitly considered and withdrawn — see migration 0023.
        purpose: "data" as never,
        config: {}
      })
    ).rejects.toThrow();
  });

  it("READ PATH: an infra binding is retrievable via the API, not just creatable", async () => {
    // The gap this closes: P3's first cut threaded `purpose` through every WRITE and none of the
    // reads, so PUT could create an infra binding that no API call could ever return — GET silently
    // answered with the software one. Write-complete, read-incomplete.
    const comp = await createTestComponent(admin, { name: "readback-comp" });
    await bind(comp.id, "software", "sw");
    await bind(comp.id, "infra", "inf");

    const dflt = await admin.executors.getBinding(comp.id);
    expect(dflt.purpose).toBe("software"); // unqualified read is unchanged for every existing caller
    expect(dflt.pluginInstanceId).toBe("sw");

    const infra = await admin.executors.getBinding(comp.id, "infra");
    expect(infra.purpose).toBe("infra");
    expect(infra.pluginInstanceId).toBe("inf");
  });

  it("READ PATH: 404s for a purpose with no binding (rather than falling back to another)", async () => {
    const comp = await createTestComponent(admin, { name: "sw-only" });
    await bind(comp.id, "software", "sw");
    await expect(admin.executors.getBinding(comp.id, "infra")).rejects.toThrow();
  });

  it("the DB constraint — not just the upsert — enforces one binding per (target, purpose)", async () => {
    // Concurrent binds of the SAME purpose: exactly one row must exist afterwards, whether the app
    // upsert or UNIQUE(org_id, target_object_id, purpose) settles it. (The P2 review found the
    // analogous check-then-insert race on `contains`; same discipline applied here.)
    const comp = await createTestComponent(admin, { name: "race-purpose" });
    await Promise.allSettled([
      bind(comp.id, "infra", "race-a"),
      bind(comp.id, "infra", "race-b")
    ]);
    const all = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      listExecutorBindingsForTarget(tx, org.orgId, comp.id)
    );
    expect(all.filter((b) => b.purpose === "infra")).toHaveLength(1);
  });
});
