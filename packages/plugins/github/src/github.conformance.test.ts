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

const RUN_ID = 424_242;

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

  // trigger(): workflow_dispatch POST, then the runs-list correlation poll — matches immediately
  // so the suite never waits on correlateDispatchedRun's 500ms inter-attempt backoff.
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
    .reply(200, {
      workflow_runs: [
        {
          id: RUN_ID,
          status: "completed",
          conclusion: "success",
          html_url: `https://github.com/${executorConfig.owner}/${executorConfig.repo}/actions/runs/${RUN_ID}`,
          head_sha: "a".repeat(40),
          created_at: new Date().toISOString()
        }
      ]
    })
    .persist();

  // status(): the correlated run always reads back as completed/success.
  nock(executorConfig.apiBaseUrl ?? "https://api.github.com")
    .matchHeader("authorization", executorAuthHeader)
    .get(`/repos/${executorConfig.owner}/${executorConfig.repo}/actions/runs/${RUN_ID}`)
    .reply(200, {
      id: RUN_ID,
      status: "completed",
      conclusion: "success",
      html_url: `https://github.com/${executorConfig.owner}/${executorConfig.repo}/actions/runs/${RUN_ID}`,
      head_sha: "a".repeat(40)
    })
    .persist();

  // abort(): cancel the correlated run.
  nock(executorConfig.apiBaseUrl ?? "https://api.github.com")
    .matchHeader("authorization", executorAuthHeader)
    .post(`/repos/${executorConfig.owner}/${executorConfig.repo}/actions/runs/${RUN_ID}/cancel`)
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
  const plugin = createGithubExecutorPlugin();
  const ctx: PluginContext = buildTestCtx(executorConfig);
  return { plugin, ctx };
});

runDiscoveryConformanceSuite("github-discovery", async () => {
  const plugin = createGithubDiscoveryPlugin();
  const ctx: PluginContext = buildTestCtx(discoveryConfig);
  return { plugin, ctx };
});
