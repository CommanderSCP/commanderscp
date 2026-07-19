/**
 * Wires `@scp/plugin-gitlab` into `@scp/plugin-testkit`'s generic `ExecutorPlugin` +
 * `DiscoveryPlugin` conformance suites (BUILD_AND_TEST.md §4.2: "every shipped plugin runs the
 * relevant plugin-testkit suite"). Same thin-fixture shape as `gitea.conformance.test.ts`: this
 * plugin makes REAL outbound HTTP calls (`ctx.http` is not a stub), so `gitlab-test-support.ts`'s
 * `createRealHttpClient()` + `nock` fixtures stand in for a GitLab instance. Fixtures are
 * `persist()`ed (the suite calls each verb an unpredictable number of times) and this file
 * deliberately does NOT assert `nock.isDone()` — that precise single-call proof lives in
 * `index.test.ts`.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";
import type { PluginContext } from "@scp/plugin-api";
import { runDiscoveryConformanceSuite, runExecutorConformanceSuite } from "@scp/plugin-testkit";
import nock from "nock";
import { createGitlabDiscoveryPlugin, createGitlabExecutorPlugin } from "./index.js";
import {
  apiBase,
  buildGitlabConfig,
  buildTestCtx,
  projectIdOf,
  tokenHeaderFor
} from "./gitlab-test-support.js";

const config = buildGitlabConfig({ projectPath: "conformance-org/conformance-repo" });
const base = apiBase(config);
const token = tokenHeaderFor(config);
const pid = projectIdOf(config);

// Discovery conformance runs against its OWN repo config so its persisted tree fixtures never collide
// with the executor suite's commits/pipelines fixtures.
const discoveryConfig = buildGitlabConfig({ projectPath: "conformance-org/conformance-discovery" });
const discoveryBase = apiBase(discoveryConfig);
const discoveryPid = projectIdOf(discoveryConfig);

beforeAll(() => {
  nock.disableNetConnect();

  // trigger(): create pipeline returns a UNIQUE id per call (Date.now()) so the cross-restart dedup
  // test is non-vacuous — a broken (non-durable) dedup would re-create and return a DIFFERENT id; a
  // durable one returns the cached ref with no HTTP.
  nock(base)
    .matchHeader("private-token", token)
    .post(`/projects/${pid}/pipeline`)
    .reply(201, () => ({ id: Date.now(), status: "success", sha: "a".repeat(40) }))
    .persist();

  // status(): ANY correlated pipeline id reads back success.
  nock(base)
    .matchHeader("private-token", token)
    .get(new RegExp(`/projects/${pid}/pipelines/\\d+$`))
    .reply(200, (uri: string) => ({ id: Number(uri.split("/").pop()), status: "success", sha: "a".repeat(40) }))
    .persist();

  // abort(): cancel ANY correlated pipeline id.
  nock(base)
    .matchHeader("private-token", token)
    .post(new RegExp(`/projects/${pid}/pipelines/\\d+/cancel$`))
    .reply(200, { status: "canceled" })
    .persist();

  // observe(): commits + pipelines.
  nock(base)
    .matchHeader("private-token", token)
    .get(new RegExp(`/projects/${pid}/repository/commits`))
    .reply(200, [{ id: "b".repeat(40), created_at: new Date().toISOString() }])
    .persist();
  nock(base)
    .matchHeader("private-token", token)
    .get(new RegExp(`/projects/${pid}/pipelines(\\?|$)`))
    .reply(200, [])
    .persist();

  // -- Discovery suite fixtures (GitLab repository-tree). --
  nock(discoveryBase)
    .matchHeader("private-token", token)
    .get(new RegExp(`/projects/${discoveryPid}/repository/tree`))
    .query(true)
    .reply(200, (uri: string) => {
      // The root listing (no path) returns one tree; a path=service-a listing returns a marker blob.
      if (/[?&]path=/.test(uri)) {
        return [{ name: "package.json", path: "service-a/package.json", type: "blob" }];
      }
      return [{ name: "service-a", path: "service-a", type: "tree" }];
    })
    .persist();
});

afterAll(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

runExecutorConformanceSuite("gitlab", async () => {
  // A durable statePath (fresh per factory() call) so the cross-restart dedup test reads on-disk
  // state, not the first instance's memory.
  const statePath = join(await mkdtemp(join(tmpdir(), "gitlab-conformance-")), "state.json");
  const build = (): { plugin: ReturnType<typeof createGitlabExecutorPlugin>; ctx: PluginContext } => ({
    plugin: createGitlabExecutorPlugin(),
    ctx: buildTestCtx({ ...config, statePath })
  });
  return { ...build(), restart: async () => build() };
});

runDiscoveryConformanceSuite("gitlab-discovery", async () => {
  const plugin = createGitlabDiscoveryPlugin();
  const ctx: PluginContext = buildTestCtx(discoveryConfig);
  return { plugin, ctx };
});
