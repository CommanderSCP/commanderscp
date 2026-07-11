/**
 * Wires `@scp/plugin-argocd` into `@scp/plugin-testkit`'s generic `ExecutorPlugin` conformance
 * suite (BUILD_AND_TEST.md §4.2: "every shipped plugin runs the relevant `@scp/plugin-testkit`
 * suite in its own package tests"). The suite itself lives in plugin-testkit and knows nothing
 * about ArgoCD specifics — this file is only the fixture factory.
 *
 * Unlike the other conformance fixtures in this repo (fake-executor, webhook-control), which
 * stub `ctx.http` directly with an in-memory function, this fixture wires a REAL
 * `ScopedHttpClient` (`./test-node-http-client.ts` — node:http/https, not `fetch`; see that
 * file's doc comment for why) so the suite's calls travel through `index.ts`'s actual
 * `apiRequest()` HTTP path and get intercepted by `nock`, exercising the real wire format rather
 * than only in-process logic.
 *
 * The conformance suite calls trigger/status/abort/observe in varying combinations, and with
 * varying target names per `it()` (e.g. "conformance-target" for most assertions,
 * "conformance-idempotency-target" for the idempotencyKey test), without this fixture knowing
 * ahead of time which name a given test will use. Every interceptor below therefore matches by
 * path REGEX (any application name) and is `.persist()`-ed rather than tied to one literal name
 * or a fixed call count — the equivalent of webhook-control's conformance fixture always
 * returning the same well-formed response regardless of how many times `evaluate()` is called.
 */
import { afterAll } from "vitest";
import nock from "nock";
import type { PluginContext } from "@scp/plugin-api";
import { runExecutorConformanceSuite } from "@scp/plugin-testkit";
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

// abort(): DELETE .../applications/{name}/operation — any application name.
nock(SERVER_URL)
  .persist()
  .delete(/^\/api\/v1\/applications\/[^/]+\/operation$/)
  .reply(200, {});

// observe(): GET .../applications — no items, so the suite's "well-formed events" loop is trivially satisfied.
nock(SERVER_URL).persist().get("/api/v1/applications").reply(200, { items: [] });

runExecutorConformanceSuite("argocd", async () => {
  const plugin = createArgoCdExecutorPlugin();
  const ctx: PluginContext = {
    orgId: "conformance-org",
    domainId: "conformance-domain",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { get: async () => undefined },
    http: createNodeHttpTestClient(),
    config: { serverUrl: SERVER_URL, token: "conformance-token" }
  };
  return { plugin, ctx };
});

afterAll(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});
