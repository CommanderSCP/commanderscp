/**
 * Wires `@scp/plugin-gitea` into `@scp/plugin-testkit`'s generic `ExecutorPlugin` conformance suite
 * (BUILD_AND_TEST.md §4.2: "every shipped plugin runs the relevant plugin-testkit suite"). Same
 * thin-fixture shape as `github.conformance.test.ts`: this plugin makes REAL outbound HTTP calls
 * (`ctx.http` is not a stub), so `gitea-test-support.ts`'s `createRealHttpClient()` + `nock`
 * fixtures stand in for a Gitea instance. Fixtures are `persist()`ed (the suite calls each verb an
 * unpredictable number of times) and this file deliberately does NOT assert `nock.isDone()` — that
 * precise single-call proof lives in `index.test.ts`.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";
import type { PluginContext } from "@scp/plugin-api";
import { runDiscoveryConformanceSuite, runExecutorConformanceSuite } from "@scp/plugin-testkit";
import nock from "nock";
import { createGiteaDiscoveryPlugin, createGiteaExecutorPlugin } from "./index.js";
import { apiBase, authHeaderFor, buildGiteaConfig, buildTestCtx } from "./gitea-test-support.js";

const config = buildGiteaConfig({ owner: "conformance-org", repo: "conformance-repo" });
const base = apiBase(config);
const authHeader = authHeaderFor(config);

// Discovery conformance runs against its OWN repo config so its persisted contents fixtures never
// collide with the executor suite's runs/commits fixtures above.
const discoveryConfig = buildGiteaConfig({
  owner: "conformance-org",
  repo: "conformance-discovery-repo"
});
const discoveryBase = apiBase(discoveryConfig);

beforeAll(() => {
  nock.disableNetConnect();

  // trigger(): workflow_dispatch → 204, then the runs-list correlation poll. A UNIQUE run id per
  // poll (Date.now()) makes the cross-restart dedup test non-vacuous: a broken (non-durable) dedup
  // would re-dispatch and correlate a DIFFERENT id; a durable one returns the cached ref with no HTTP.
  nock(base)
    .matchHeader("authorization", authHeader)
    .post(`/repos/${config.owner}/${config.repo}/actions/workflows/ci.yml/dispatches`)
    .reply(204)
    .persist();
  nock(base)
    .matchHeader("authorization", authHeader)
    .get(`/repos/${config.owner}/${config.repo}/actions/runs`)
    .reply(200, () => ({
      workflow_runs: [{ id: Date.now(), status: "success", head_sha: "a".repeat(40), created_at: new Date().toISOString() }]
    }))
    .persist();

  // status(): ANY correlated run id reads back success.
  nock(base)
    .matchHeader("authorization", authHeader)
    .get(new RegExp(`/repos/${config.owner}/${config.repo}/actions/runs/\\d+$`))
    .reply(200, (uri: string) => ({ id: Number(uri.split("/").pop()), status: "success", head_sha: "a".repeat(40) }))
    .persist();

  // abort(): cancel ANY correlated run id.
  nock(base)
    .matchHeader("authorization", authHeader)
    .post(new RegExp(`/repos/${config.owner}/${config.repo}/actions/runs/\\d+/cancel$`))
    .reply(200)
    .persist();

  // observe(): commits + runs + packages.
  nock(base)
    .matchHeader("authorization", authHeader)
    .get(`/repos/${config.owner}/${config.repo}/commits`)
    .reply(200, [{ sha: "b".repeat(40), commit: { author: { date: new Date().toISOString() } } }])
    .persist();
  nock(base)
    .matchHeader("authorization", authHeader)
    .get(`/packages/${config.owner}`)
    .reply(200, [])
    .persist();

  // -- Discovery suite fixtures (Gitea contents API, GitHub-compatible). --
  nock(discoveryBase)
    .matchHeader("authorization", authHeader)
    .get(`/repos/${discoveryConfig.owner}/${discoveryConfig.repo}/contents/`)
    .reply(200, [{ name: "service-a", path: "service-a", type: "dir" }])
    .persist();
  nock(discoveryBase)
    .matchHeader("authorization", authHeader)
    .get(`/repos/${discoveryConfig.owner}/${discoveryConfig.repo}/contents/service-a`)
    .reply(200, [{ name: "package.json", path: "service-a/package.json", type: "file" }])
    .persist();
});

afterAll(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

runExecutorConformanceSuite("gitea", async () => {
  // A durable statePath (fresh per factory() call) so the cross-restart dedup test reads on-disk
  // state, not the first instance's memory (MAJOR #4).
  const statePath = join(await mkdtemp(join(tmpdir(), "gitea-conformance-")), "state.json");
  const build = (): { plugin: ReturnType<typeof createGiteaExecutorPlugin>; ctx: PluginContext } => ({
    plugin: createGiteaExecutorPlugin(),
    ctx: buildTestCtx({ ...config, statePath })
  });
  return { ...build(), restart: async () => build() };
});

runDiscoveryConformanceSuite("gitea-discovery", async () => {
  const plugin = createGiteaDiscoveryPlugin();
  const ctx: PluginContext = buildTestCtx(discoveryConfig);
  return { plugin, ctx };
});
