import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import {
  createTestOrg,
  listenTestServer,
  type ListeningTestServer
} from "../test-support/harness.js";
import { startPluginHostForRole } from "../plugin-host/host-bootstrap.js";
import type { SubprocessPluginHost } from "../plugin-host/host.js";

/** The route validates the config it will actually use. See docs/routes.md §142. */
describe("discovery validates the EFFECTIVE config", () => {
  let server: ListeningTestServer;
  let host: SubprocessPluginHost | undefined;

  beforeAll(async () => {
    server = await listenTestServer();
    // main.ts gives every role a host (#200); listenTestServer does not, so wire one the same way
    // production does — without it this route 400s before reaching the validation under test.
    host = await startPluginHostForRole(server.deps, "api");
  });

  afterAll(async () => {
    await host?.stop();
    await server.close();
  });

  /** Posts a discovery run and returns `{status, detail}`. See docs/routes.md §143. */
  async function runDiscovery(token: string, config: Record<string, unknown>) {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/v1/discovery/run",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        pluginModule: "argocd-discovery",
        pluginInstanceId: `probe-${randomUUID().slice(0, 8)}`,
        config
      }
    });
    const body = (res.json() ?? {}) as { detail?: string };
    return { status: res.statusCode, detail: body.detail ?? "" };
  }

  it("accepts an execution-system-backed run that supplies NO serverUrl", async () => {
    const org = await createTestOrg(server, "disc-effective");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const sys = await admin.object("execution-system").create({
      name: `argocd-${randomUUID().slice(0, 8)}`,
      properties: {
        kind: "argocd",
        // A closed loopback port: the run gets past validation and then fails to CONNECT, which is
        // the point. Asserting a successful scan would need a real Argo CD, and tests never reach
        // the network beyond loopback.
        serverUrl: "http://127.0.0.1:1"
      }
    });

    const { status, detail } = await runDiscovery(org.adminToken, { executionSystemId: sys.id });

    // GUARD FIRST. The real assertion below is an ABSENCE, and an absence passes for any wrong
    // reason — the first version of this test had the URL wrong, got a 404, and passed vacuously
    // (a 404 body contains no "serverUrl" either). Its sibling caught it. So pin that the request
    // actually REACHED the handler before reading anything into what it did not say.
    expect(status, "the request must reach the route at all").not.toBe(404);
    expect(status, "and must be authorized").not.toBe(403);

    // The measurement is the ABSENCE of the schema rejection. Whatever happens downstream — a
    // connection refusal, an egress refusal — means validation let the documented shape through.
    expect(
      detail,
      "naming a system is the documented way to call this route; rejecting it for the field the server itself supplies made that path unusable"
    ).not.toContain("serverUrl");
  });

  it("STILL rejects an inline run that supplies no serverUrl", async () => {
    const org = await createTestOrg(server, "disc-effective-inline");

    const { status, detail } = await runDiscovery(org.adminToken, { namespace: "argocd" });

    expect(status, "no system named means the body IS the effective config").toBe(400);
    expect(
      detail,
      "moving a validation call is how validation gets silently deleted — the inline path must still be checked"
    ).toContain("serverUrl");
  });
});
