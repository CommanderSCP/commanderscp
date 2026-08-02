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

/**
 * `POST /discovery/run` VALIDATES THE CONFIG IT WILL ACTUALLY USE, NOT THE REQUEST BODY.
 *
 * ============================================================================================
 * THE CONTRADICTION THIS RESOLVES
 * ============================================================================================
 * The handler supports naming an execution-system instead of supplying connection details, and says
 * so in as many words: "a caller may NAME a system, never supply its serverUrl/token/egress
 * allowance". The merge below it stamps the persisted `serverUrl` as server-governed — it WINS over
 * anything the caller sent, which is the SSRF defence (MAJOR #6).
 *
 * But `validatePluginConfig` ran on `request.body.config` BEFORE that merge, and
 * `argocd-discovery`'s manifest requires `serverUrl`. So the documented call was rejected for
 * missing exactly the field the server was about to supply, and the only way through was to send a
 * dummy `serverUrl` that is then overwritten — a required field whose value is ignored.
 *
 * Measured on the live homelab 2026-08-02, immediately after #200 made this route reachable at all
 * on an api-only process: `{executionSystemId}` alone answered
 * `400 properties failed JSON Schema validation: / must have required property 'serverUrl'`.
 *
 * ============================================================================================
 * WHY BOTH TESTS EXIST
 * ============================================================================================
 * Moving a validation call is exactly the change that can silently DELETE the validation. So the
 * pair pins both directions: the system-backed path must stop being rejected, AND the inline path
 * must still be rejected for the same missing field. A fix that merely deleted the call would pass
 * the first test and fail the second.
 *
 * ============================================================================================
 * MUTATION LOG (each applied ALONE against a passing suite, then reverted)
 * ============================================================================================
 * | Mutation | Result |
 * |---|---|
 * | move `validatePluginConfig` back onto `request.body.config` before the merge (the bug) | the system-backed test FAILS with the `serverUrl` schema error |
 * | delete the `validatePluginConfig` call entirely | the inline test FAILS — an unvalidated config reaches the plugin |
 *
 * The system-backed test asserts an ABSENCE, which passes for any wrong reason. The first version
 * had the wrong URL, 404'd, and passed vacuously — its sibling caught it by failing on the status.
 * It now pins that the request reached the handler before reading meaning into what it did not say.
 */
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

  /**
   * Posts a discovery run and returns `{status, detail}` — never throws, so the DETAIL can be read.
   *
   * `app.inject` rather than the SDK: the SDK throws on a non-2xx, and the whole measurement here is
   * WHICH error came back. Injecting also removes the URL from the set of things that can be wrong —
   * the first version of this file guessed the prefix, 404'd, and made one test pass vacuously.
   */
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
