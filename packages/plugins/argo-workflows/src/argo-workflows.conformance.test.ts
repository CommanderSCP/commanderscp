/**
 * Wires `@scp/plugin-argo-workflows` into `@scp/plugin-testkit`'s generic `ExecutorPlugin`
 * conformance suite (BUILD_AND_TEST.md §4.2: "every shipped plugin runs the relevant
 * `@scp/plugin-testkit` suite in its own package tests"). Mirrors
 * `packages/plugins/argocd/src/argocd.conformance.test.ts` exactly, including the `restart` hook —
 * the suite's idempotency-across-a-simulated-subprocess-restart assertion needs a FRESH plugin
 * instance + ctx sharing only the durable (on-disk) `statePath`, never the first instance's
 * in-process memory.
 *
 * Like the ArgoCD fixture (and unlike fake-executor/webhook-control's in-memory stubs), this wires
 * a REAL `ScopedHttpClient` (`./test-node-http-client.ts`) so the suite's calls travel through
 * `index.ts`'s actual `apiRequest()` HTTP path and get intercepted by `nock`, exercising the real
 * wire format rather than only in-process logic.
 *
 * Every interceptor matches by path REGEX (any workflow/template name the suite happens to use)
 * and is `.persist()`-ed, since the suite calls trigger/status/abort/observe with varying target
 * names across its own `it()`s without this fixture knowing which name a given test will use ahead
 * of time.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import nock from "nock";
import type { PluginContext } from "@scp/plugin-api";
import { runExecutorConformanceSuite, mkdtempTracked } from "@scp/plugin-testkit";
import { createArgoWorkflowsExecutorPlugin } from "./index.js";
import { createNodeHttpTestClient } from "./test-node-http-client.js";

const SERVER_URL = "http://argo-workflows-conformance.test";
const NAMESPACE = "conformance-ns";

function genericWorkflow(name: string): unknown {
  return {
    metadata: { name, uid: `uid-${name}`, creationTimestamp: new Date(0).toISOString() },
    status: { phase: "Succeeded", startedAt: new Date(0).toISOString() }
  };
}

nock.disableNetConnect();
nock.enableNetConnect(SERVER_URL.replace("http://", ""));

// trigger(): POST .../submit — any template name, any body, a well-formed submit response.
nock(SERVER_URL)
  .persist()
  .post(`/api/v1/workflows/${NAMESPACE}/submit`)
  .reply(200, (_uri: string, requestBody: unknown) => {
    const resourceName = (requestBody as { resourceName?: string })?.resourceName ?? "conformance";
    // A distinct uid per call so a DIFFERENT idempotencyKey (or no key at all) mints a distinct ref,
    // exactly as the suite's own idempotency test expects.
    return genericWorkflow(`${resourceName}-${Math.random().toString(36).slice(2)}`);
  });

// status(): GET .../workflows/{namespace}/{name} — any workflow name, a plausible succeeded workflow.
nock(SERVER_URL)
  .persist()
  .get(new RegExp(`^/api/v1/workflows/${NAMESPACE}/[^/]+$`))
  .reply(200, (uri: string) => {
    const name = uri.split("/").pop() ?? "conformance-target";
    return genericWorkflow(name);
  });

nock(SERVER_URL)
  .persist()
  .put(new RegExp(`^/api/v1/workflows/${NAMESPACE}/[^/]+/terminate$`))
  .reply(200, {});

// observe(): GET .../workflows/{namespace} — no items, so the suite's "well-formed events" loop is
// trivially satisfied.
nock(SERVER_URL).persist().get(`/api/v1/workflows/${NAMESPACE}`).reply(200, { items: [] });

runExecutorConformanceSuite("argo-workflows", async () => {
  const statePath = join(
    await mkdtempTracked(join(tmpdir(), "argo-workflows-conformance-")),
    "state.json"
  );
  const build = (): {
    plugin: ReturnType<typeof createArgoWorkflowsExecutorPlugin>;
    ctx: PluginContext;
  } => ({
    plugin: createArgoWorkflowsExecutorPlugin(),
    ctx: {
      orgId: "conformance-org",
      scopeKey: "conformance-domain",
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      secrets: { get: async () => undefined },
      http: createNodeHttpTestClient(),
      // statePath makes dedup (and abort-tracking) durable across the simulated restart.
      config: {
        serverUrl: SERVER_URL,
        namespace: NAMESPACE,
        token: "conformance-token",
        statePath
      }
    }
  });
  return { ...build(), restart: async () => build() };
});

afterAll(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});
