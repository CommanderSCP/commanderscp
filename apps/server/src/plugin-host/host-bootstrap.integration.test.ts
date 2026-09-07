import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildTestServer,
  createTestOrg,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";
import { sharedPluginInstancesForRole, startPluginHostForRole } from "./host-bootstrap.js";
import { DEFAULT_EXECUTOR_INSTANCE_ID } from "../coordination/executor-config.js";
import type { SubprocessPluginHost } from "./host.js";
import type { AppDeps } from "../types.js";

/** A pure API process must be able to dispatch a scan. See docs/plugin-host.md §42. */
describe("the plugin host is available to every role, the shared instance only to background roles", () => {
  let server: TestServer;
  let org: TestOrg;
  /** Every host started here, so afterAll stops them all — each start spawns a real supervisor. */
  const hosts: SubprocessPluginHost[] = [];
  let host: SubprocessPluginHost | undefined;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "host-bootstrap");
  });

  afterAll(async () => {
    for (const h of hosts) await h.stop().catch(() => undefined);
    await server?.close();
  });

  it("gates the shared fake-executor INSTANCE by role, and nothing else", () => {
    expect(
      sharedPluginInstancesForRole("api"),
      "an api process does not own the coordination loops' process-wide singleton"
    ).toEqual([]);

    for (const role of ["all", "worker"] as const) {
      const instances = sharedPluginInstancesForRole(role);
      expect(
        instances,
        `${role} runs the coordination loops and needs the shared instance`
      ).toHaveLength(1);
      expect(instances[0]!.id).toBe(DEFAULT_EXECUTOR_INSTANCE_ID);
    }
  });

  it("publishes a host on deps for a pure api role", async () => {
    const deps: AppDeps = { db: server.deps.db, config: server.deps.config };
    host = await startPluginHostForRole(deps, "api");
    hosts.push(host);

    expect(
      deps.pluginHost,
      "the api process is the ONLY one serving HTTP — without a host here, no route can ever dispatch a plugin"
    ).toBeDefined();
  });

  it("lets POST /discovery/run get PAST the host check on an api-role process", async () => {
    // Wire the route to what an api-role process would ACTUALLY have: whatever
    // `startPluginHostForRole` published on `deps`. Reading the function's RETURN value instead
    // would pass even if the api role were never given a host — the first version of this test did
    // exactly that, and a mutation restoring the old role gate left it green.
    const deps: AppDeps = { db: server.deps.db, config: server.deps.config };
    hosts.push(await startPluginHostForRole(deps, "api"));
    server.deps.pluginHost = deps.pluginHost;

    const res = await server.app.inject({
      method: "POST",
      url: "/api/v1/discovery/run",
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: { pluginModule: "definitely-not-a-real-module", pluginInstanceId: "probe" }
    });

    expect(res.statusCode).toBe(400);
    const detail = (res.json() as { detail?: string }).detail ?? "";
    expect(
      detail,
      "reaching the module check proves the host guard was passed — before the fix this said 'no plugin host' for every body, so a bad request and a broken deployment were indistinguishable"
    ).toContain("unknown discovery plugin module");
    expect(detail).not.toContain("plugin host");
  });

  it("still refuses when there is genuinely no host (buildApp callers like openapi:emit)", async () => {
    server.deps.pluginHost = undefined;
    const res = await server.app.inject({
      method: "POST",
      url: "/api/v1/discovery/run",
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: { pluginModule: "definitely-not-a-real-module", pluginInstanceId: "probe" }
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { detail?: string }).detail ?? "").toContain("no plugin host");
    server.deps.pluginHost = host;
  });
});
