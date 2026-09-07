/** Wires this plugin into the generic executor conformance suite. See docs/plugins.md §11. */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import nock from "nock";
import type { PluginContext } from "@scp/plugin-api";
import { runExecutorConformanceSuite, mkdtempTracked } from "@scp/plugin-testkit";
import { createArgoCdExecutorPlugin } from "./index.js";
import { createNodeHttpTestClient } from "./test-node-http-client.js";

const SERVER_URL = "http://argocd-conformance.test";

function genericApplication(name: string): unknown {
  return {
    metadata: { name },
    status: {
      sync: { status: "Synced", revision: "conformance-revision" },
      health: { status: "Healthy" },
      reconciledAt: new Date(0).toISOString()
    }
  };
}

nock.disableNetConnect();
nock.enableNetConnect(SERVER_URL.replace("http://", ""));

// trigger(): POST .../applications/{name}/sync — any application name, any body, generic 2xx.
nock(SERVER_URL)
  .persist()
  .post(/^\/api\/v1\/applications\/[^/]+\/sync$/)
  .reply(200, {});

// status(): GET .../applications/{name} — any application name, a plausible healthy+synced app.
nock(SERVER_URL)
  .persist()
  .get(/^\/api\/v1\/applications\/[^/]+$/)
  .reply(200, (uri: string) => {
    const name = uri.split("/").pop() ?? "conformance-target";
    return genericApplication(name);
  });

nock(SERVER_URL)
  .persist()
  .delete(/^\/api\/v1\/applications\/[^/]+\/operation$/)
  .reply(200, {});

// observe(): GET .../applications — no items, so the suite's "well-formed events" loop is trivially satisfied.
nock(SERVER_URL).persist().get("/api/v1/applications").reply(200, { items: [] });

runExecutorConformanceSuite("argocd", async () => {
  const statePath = join(await mkdtempTracked(join(tmpdir(), "argocd-conformance-")), "state.json");
  const build = (): {
    plugin: ReturnType<typeof createArgoCdExecutorPlugin>;
    ctx: PluginContext;
  } => ({
    plugin: createArgoCdExecutorPlugin(),
    ctx: {
      orgId: "conformance-org",
      scopeKey: "conformance-domain",
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      secrets: { get: async () => undefined },
      http: createNodeHttpTestClient(),
      // statePath makes dedup durable across the simulated restart (MAJOR #4).
      config: { serverUrl: SERVER_URL, token: "conformance-token", statePath }
    }
  });
  return { ...build(), restart: async () => build() };
});

afterAll(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});
