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

/**
 * A PURE `role=api` PROCESS MUST BE ABLE TO DISPATCH A DISCOVERY SCAN.
 *
 * ============================================================================================
 * THE PROPERTY
 * ============================================================================================
 * `main.ts` used to construct the `SubprocessPluginHost` inside its `role === "all" || "worker"`
 * guard. That guard exists to stop TWO processes running the reconcile/watchdog/observe loops; it
 * has nothing to say about whether a process may host a plugin for the duration of one request.
 *
 * Conflating them broke discovery in the deployment shape the Helm chart actually ships. On a split
 * api/worker install the api process — the only one serving HTTP — had no host, so
 * `POST /discovery/run` answered 400 for every caller, and the message told the operator to set
 * `SCP_ROLE=all`, which would have started a second set of loops beside the worker's. Measured on
 * the live homelab on 2026-08-02: the route was unreachable there, which is what blocked the
 * ADR-0026 §6 migration's required verification step (re-resolving a moved binding against the real
 * Argo CD).
 *
 * ============================================================================================
 * WHAT IS ASSERTED, AND WHY IT IS THE FAILURE MODE RATHER THAN A SUCCESS
 * ============================================================================================
 * A genuinely successful scan needs a reachable Argo CD, which an offline test must not require
 * (CLAUDE.md: tests never touch the internet). So the measurement is that the request gets PAST the
 * host check and fails later, for a reason that can only be reached once a host exists. `400 unknown
 * discovery plugin module` is that reason: it is evaluated immediately after the host guard, and it
 * was unreachable on an api process before this change.
 *
 * That is a real distinction, not a semantic one — before the fix EVERY body produced the same
 * "no plugin host" answer, so a caller could not tell a misconfigured request from a misconfigured
 * deployment.
 *
 * NOTE on `test-support/harness.ts`: it mirrors the OLD coupling, creating a host only under
 * `withReconcileLoop`. That is why no existing test caught this — the harness reproduced the bug
 * faithfully. These tests therefore call the PRODUCTION wiring (`startPluginHostForRole`) directly
 * rather than relying on the harness.
 *
 * ============================================================================================
 * MUTATION LOG (each applied ALONE against a passing suite, then reverted)
 * ============================================================================================
 * | Mutation | Result |
 * |---|---|
 * | `host-bootstrap.ts`: assign `deps.pluginHost` only for all/worker (the old behaviour) | BOTH the deps test and the api-dispatch test FAIL — the route answers "no plugin host" again |
 * | `host-bootstrap.ts`: drop the role check in `sharedPluginInstancesForRole` so api also starts the shared fake-executor | the instance-gating test FAILS (an api process would run a coordination singleton it does not own) |
 * | `host-bootstrap.ts`: have `sharedPluginInstancesForRole` return `[]` for every role | the worker test FAILS — the coordination loops would lose the shared instance they depend on |
 */
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
