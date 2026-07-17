import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import type { ExecutorType } from "@scp/schemas";
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
 * `executor_bindings.type` — 1:N per target, keyed by the routing Type (ADR-0007, migration 0026;
 * was `purpose` in migration 0023).
 *
 * A component may own SEVERAL pipelines at once — e.g. an `infrastructure` (Terraform) pipeline AND a
 * `configuration` (GitOps sync) pipeline. The schema once made that impossible: UNIQUE(org_id,
 * target_object_id), and upsertExecutorBinding keyed its lookup on (org, target) — so binding the
 * second pipeline SILENTLY REPLACED the first. No error, no warning, just one binding quietly gone.
 * That silent-destruction case is the first test below.
 *
 * The second thing under test is the derived-Category projection and the closed-enum guard: a binding
 * carries a read-only `category` derived from its `type`, and a Type outside the closed set is rejected.
 */
describe("executor bindings: 1:N per target, keyed by Type", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "binding-type");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  // `fake-executor` deliberately: it is in KNOWN_EXECUTOR_MODULES but has no manifest, so
  // validatePluginConfig skips it — this file is about the routing Type, not each plugin's config shape.
  const bind = (targetId: string, type: ExecutorType | undefined, instance: string) =>
    admin.executors.putBinding(targetId, {
      pluginModule: "fake-executor",
      pluginInstanceId: instance,
      ...(type ? { type } : {}),
      config: {}
    });

  it("a component holds BOTH a configuration and an infrastructure binding — adding one no longer destroys the other", async () => {
    const comp = await createTestComponent(admin, { name: "static-fleet" });

    const configuration = await bind(comp.id, "configuration", "gh-deploy");
    const infrastructure = await bind(comp.id, "infrastructure", "gh-terraform");

    expect(configuration.type).toBe("configuration");
    expect(configuration.category).toBe("configuration"); // derived Category projection
    expect(infrastructure.type).toBe("infrastructure");
    expect(infrastructure.category).toBe("infrastructure");
    expect(infrastructure.id).not.toBe(configuration.id); // a NEW row, not an update of the first

    // Pre-P3 this returned ONE row and the first binding was gone.
    const all = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      listExecutorBindingsForTarget(tx, org.orgId, comp.id)
    );
    expect(all).toHaveLength(2);
    expect(all.map((b) => b.type).sort()).toEqual(["configuration", "infrastructure"]);
    expect(all.find((b) => b.type === "configuration")!.pluginInstanceId).toBe("gh-deploy");
    expect(all.find((b) => b.type === "infrastructure")!.pluginInstanceId).toBe("gh-terraform");
  });

  it("a build Type coexists with configuration/infrastructure — three orthogonal pipelines on one component", async () => {
    // The Type split's whole point: a component can build an image, sync config, AND apply infra —
    // three distinct routing keys, three rows, no collision (ADR-0007, organize-after.md:87 resolved).
    const comp = await createTestComponent(admin, { name: "full-stack" });
    const image = await bind(comp.id, "image", "ci-image");
    await bind(comp.id, "configuration", "gh-deploy");
    await bind(comp.id, "infrastructure", "gh-terraform");

    expect(image.type).toBe("image");
    expect(image.category).toBe("build"); // image/rpm/deb/npm all derive Category `build`

    const all = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      listExecutorBindingsForTarget(tx, org.orgId, comp.id)
    );
    expect(all).toHaveLength(3);
    expect(all.map((b) => b.type).sort()).toEqual(["configuration", "image", "infrastructure"]);
  });

  it("re-binding the SAME Type still updates in place (one pipeline per Type)", async () => {
    const comp = await createTestComponent(admin, { name: "rebind-me" });
    const first = await bind(comp.id, "configuration", "gh-deploy-v1");
    const second = await bind(comp.id, "configuration", "gh-deploy-v2");

    expect(second.id).toBe(first.id); // updated, not duplicated
    const all = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      listExecutorBindingsForTarget(tx, org.orgId, comp.id)
    );
    expect(all).toHaveLength(1);
    expect(all[0]!.pluginInstanceId).toBe("gh-deploy-v2");
  });

  it("omitting type defaults to 'configuration' — the server-side default", async () => {
    const comp = await createTestComponent(admin, { name: "default-shaped" });
    const created = await bind(comp.id, undefined, "gh-default");
    expect(created.type).toBe("configuration");

    // And it is the one an unqualified lookup finds — i.e. exactly what reconcile triggers by default.
    const found = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      getExecutorBinding(tx, org.orgId, comp.id)
    );
    expect(found?.pluginInstanceId).toBe("gh-default");
  });

  it("the default lookup ('configuration') is unaffected by an infrastructure binding existing", async () => {
    // The regression that would matter most: adding an infrastructure pipeline must not change which
    // binding a default ('configuration') lookup resolves. `wave-target-type.integration.test.ts`
    // covers the routing end to end; this stays as the narrow unit-level guarantee the resolver owes.
    const comp = await createTestComponent(admin, { name: "both-pipelines" });
    await bind(comp.id, "configuration", "gh-deploy");
    await bind(comp.id, "infrastructure", "gh-terraform");

    const forDefault = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      getExecutorBinding(tx, org.orgId, comp.id, "configuration")
    );
    expect(forDefault?.pluginInstanceId).toBe("gh-deploy");

    const forInfra = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      getExecutorBinding(tx, org.orgId, comp.id, "infrastructure")
    );
    expect(forInfra?.pluginInstanceId).toBe("gh-terraform");
  });

  it("rejects a Type outside the closed set", async () => {
    const comp = await createTestComponent(admin, { name: "bad-type" });
    await expect(
      admin.executors.putBinding(comp.id, {
        pluginModule: "fake-executor",
        pluginInstanceId: "x",
        // 'data' was explicitly considered and withdrawn — see migration 0023 / ADR-0007 D4.
        type: "data" as never,
        config: {}
      })
    ).rejects.toThrow();
  });

  it("READ PATH: an infrastructure binding is retrievable via the API, not just creatable", async () => {
    // The gap this closes: P3's first cut threaded the routing key through every WRITE and none of the
    // reads, so PUT could create a non-default binding that no API call could ever return — GET
    // silently answered with the default one. Write-complete, read-incomplete.
    const comp = await createTestComponent(admin, { name: "readback-comp" });
    await bind(comp.id, "configuration", "cfg");
    await bind(comp.id, "infrastructure", "inf");

    const dflt = await admin.executors.getBinding(comp.id);
    expect(dflt.type).toBe("configuration"); // unqualified read resolves the default Type
    expect(dflt.pluginInstanceId).toBe("cfg");

    const infra = await admin.executors.getBinding(comp.id, "infrastructure");
    expect(infra.type).toBe("infrastructure");
    expect(infra.category).toBe("infrastructure");
    expect(infra.pluginInstanceId).toBe("inf");
  });

  it("READ PATH: 404s for a Type with no binding (rather than falling back to another)", async () => {
    const comp = await createTestComponent(admin, { name: "cfg-only" });
    await bind(comp.id, "configuration", "cfg");
    await expect(admin.executors.getBinding(comp.id, "infrastructure")).rejects.toThrow();
  });

  it("the DB constraint — not just the upsert — enforces one binding per (target, type)", async () => {
    // Concurrent binds of the SAME Type: exactly one row must exist afterwards, whether the app upsert
    // or UNIQUE(org_id, target_object_id, type) settles it. (The P2 review found the analogous
    // check-then-insert race on `contains`; same discipline applied here.)
    const comp = await createTestComponent(admin, { name: "race-type" });
    await Promise.allSettled([
      bind(comp.id, "infrastructure", "race-a"),
      bind(comp.id, "infrastructure", "race-b")
    ]);
    const all = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      listExecutorBindingsForTarget(tx, org.orgId, comp.id)
    );
    expect(all.filter((b) => b.type === "infrastructure")).toHaveLength(1);
  });
});
