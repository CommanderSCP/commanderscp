/**
 * Wires `@scp/plugin-github` into `@scp/plugin-testkit`'s generic `ExecutorPlugin` and
 * `DiscoveryPlugin` conformance suites (BUILD_AND_TEST.md §4.2: "every shipped plugin runs the
 * relevant `@scp/plugin-testkit` suite in its own package tests"). The suites themselves live in
 * plugin-testkit and know nothing about GitHub specifics — this file is only the fixture factory,
 * same thin-wiring shape as `fake-executor.conformance.test.ts` / `webhook-control.conformance.test.ts`.
 *
 * Unlike those two, this plugin makes REAL outbound HTTP calls (`ctx.http` is not a stub), so
 * `github-test-support.ts`'s `createRealHttpClient()` + `nock` fixtures stand in for github.com.
 * The conformance suites call `factory()` fresh per `it()` but exercise trigger/status/abort/
 * observe/discover in an order this file doesn't control — so the fixtures below are `persist()`ed
 * (reusable across an unpredictable number of matching calls) rather than one-shot, and this file
 * intentionally does NOT assert `nock.isDone()`/exact call counts (that precise, single-call-proof
 * testing lives in `index.test.ts`, matching the repo's "thin conformance fixture" convention —
 * see fake-executor's/webhook-control's own conformance files, neither of which makes assertions
 * beyond wiring the factory).
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";
import type { PluginContext } from "@scp/plugin-api";
import { runDiscoveryConformanceSuite, runExecutorConformanceSuite } from "@scp/plugin-testkit";
import nock from "nock";
import { createGithubDiscoveryPlugin, createGithubExecutorPlugin } from "./index.js";
import {
  buildGithubConfig,
  buildTestCtx,
  installationTokenFor,
  nockInstallationToken
} from "./github-test-support.js";

const executorConfig = buildGithubConfig({ owner: "conformance-org", repo: "conformance-repo" });
const discoveryConfig = buildGithubConfig({
  owner: "conformance-org",
  repo: "conformance-discovery-repo"
});

beforeAll(() => {
  nock.disableNetConnect(); // fail loudly on any unfixtured call rather than hitting the real network

  // -- Executor suite fixtures (persisted: the generic suite calls trigger()/status()/abort()/
  // observe() an unpredictable number of times across its own `it()` blocks). --
  nockInstallationToken(executorConfig, { persist: true });
  const executorToken = installationTokenFor(executorConfig);
  const executorAuthHeader = `Bearer ${executorToken}`;

  // trigger(): workflow_dispatch POST, then the runs-list correlation poll. The correlated run
  // gets a UNIQUE id per poll (Date.now()) — so the cross-restart dedup conformance test (MAJOR
  // #4) is non-vacuous: a broken (non-durable) dedup would re-dispatch and correlate a DIFFERENT
  // run id, while a durable one returns the cached `workflow_run::<id>` without any HTTP at all.
  nock(executorConfig.apiBaseUrl ?? "https://api.github.com")
    .matchHeader("authorization", executorAuthHeader)
    .post(
      `/repos/${executorConfig.owner}/${executorConfig.repo}/actions/workflows/ci.yml/dispatches`
    )
    .reply(204)
    .persist();
  nock(executorConfig.apiBaseUrl ?? "https://api.github.com")
    .matchHeader("authorization", executorAuthHeader)
    .get(`/repos/${executorConfig.owner}/${executorConfig.repo}/actions/workflows/ci.yml/runs`)
    .query({ event: "workflow_dispatch", per_page: "5" })
    .reply(200, () => {
      const id = Date.now();
      return {
        workflow_runs: [
          {
            id,
            status: "completed",
            conclusion: "success",
            html_url: `https://github.com/${executorConfig.owner}/${executorConfig.repo}/actions/runs/${id}`,
            head_sha: "a".repeat(40),
            created_at: new Date().toISOString()
          }
        ]
      };
    })
    .persist();

  // status(): ANY correlated run id (path regex) reads back completed/success.
  nock(executorConfig.apiBaseUrl ?? "https://api.github.com")
    .matchHeader("authorization", executorAuthHeader)
    .get(new RegExp(`/repos/${executorConfig.owner}/${executorConfig.repo}/actions/runs/\\d+$`))
    .reply(200, (uri: string) => {
      const id = Number(uri.split("/").pop());
      return {
        id,
        status: "completed",
        conclusion: "success",
        html_url: `https://github.com/${executorConfig.owner}/${executorConfig.repo}/actions/runs/${id}`,
        head_sha: "a".repeat(40)
      };
    })
    .persist();

  // abort(): cancel ANY correlated run id (path regex).
  nock(executorConfig.apiBaseUrl ?? "https://api.github.com")
    .matchHeader("authorization", executorAuthHeader)
    .post(
      new RegExp(`/repos/${executorConfig.owner}/${executorConfig.repo}/actions/runs/\\d+/cancel$`)
    )
    .reply(202)
    .persist();

  // observe(): commits + runs polling fallback.
  nock(executorConfig.apiBaseUrl ?? "https://api.github.com")
    .matchHeader("authorization", executorAuthHeader)
    .get(`/repos/${executorConfig.owner}/${executorConfig.repo}/commits`)
    .reply(200, [{ sha: "b".repeat(40), commit: { author: { date: new Date().toISOString() } } }])
    .persist();
  nock(executorConfig.apiBaseUrl ?? "https://api.github.com")
    .matchHeader("authorization", executorAuthHeader)
    .get(`/repos/${executorConfig.owner}/${executorConfig.repo}/actions/runs`)
    .reply(200, { workflow_runs: [] })
    .persist();

  // -- Discovery suite fixtures. --
  nockInstallationToken(discoveryConfig, { persist: true });
  const discoveryAuthHeader = `Bearer ${installationTokenFor(discoveryConfig)}`;
  nock(discoveryConfig.apiBaseUrl ?? "https://api.github.com")
    .matchHeader("authorization", discoveryAuthHeader)
    .get(`/repos/${discoveryConfig.owner}/${discoveryConfig.repo}/contents/`)
    .reply(200, [{ name: "service-a", path: "service-a", type: "dir" }])
    .persist();
  nock(discoveryConfig.apiBaseUrl ?? "https://api.github.com")
    .matchHeader("authorization", discoveryAuthHeader)
    .get(`/repos/${discoveryConfig.owner}/${discoveryConfig.repo}/contents/service-a`)
    .reply(200, [{ name: "package.json", path: "service-a/package.json", type: "file" }])
    .persist();
});

afterAll(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

runExecutorConformanceSuite("github", async () => {
  // A durable statePath (fresh per factory() call) so the cross-restart dedup test reads on-disk
  // state, not the first instance's memory (MAJOR #4). `executorConfig` is shared across the file
  // so the installation-token/dispatch fixtures keep matching; only statePath varies per call.
  const statePath = join(await mkdtemp(join(tmpdir(), "github-conformance-")), "state.json");
  const build = (): {
    plugin: ReturnType<typeof createGithubExecutorPlugin>;
    ctx: PluginContext;
  } => ({
    plugin: createGithubExecutorPlugin(),
    ctx: buildTestCtx({ ...executorConfig, statePath })
  });
  return { ...build(), restart: async () => build() };
});

runDiscoveryConformanceSuite("github-discovery", async () => {
  const plugin = createGithubDiscoveryPlugin();
  const ctx: PluginContext = buildTestCtx(discoveryConfig);
  return { plugin, ctx };
});
