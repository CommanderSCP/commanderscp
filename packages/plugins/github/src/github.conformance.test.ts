/** Wires this plugin into the executor and discovery suites. See docs/plugins.md §169. */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";
import type { PluginContext } from "@scp/plugin-api";
import {
  runDiscoveryConformanceSuite,
  runExecutorConformanceSuite,
  mkdtempTracked
} from "@scp/plugin-testkit";
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

  nock(executorConfig.apiBaseUrl ?? "https://api.github.com")
    .matchHeader("authorization", executorAuthHeader)
    .post(
      new RegExp(`/repos/${executorConfig.owner}/${executorConfig.repo}/actions/runs/\\d+/cancel$`)
    )
    .reply(202)
    .persist();

  nock(executorConfig.apiBaseUrl ?? "https://api.github.com")
    .matchHeader("authorization", executorAuthHeader)
    .get(`/repos/${executorConfig.owner}/${executorConfig.repo}/commits`)
    .query(true)
    .reply(200, [{ sha: "b".repeat(40), commit: { author: { date: new Date().toISOString() } } }])
    .persist();
  nock(executorConfig.apiBaseUrl ?? "https://api.github.com")
    .matchHeader("authorization", executorAuthHeader)
    .get(`/repos/${executorConfig.owner}/${executorConfig.repo}/actions/runs`)
    .query(true)
    .reply(200, { workflow_runs: [] })
    .persist();

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
  const statePath = join(await mkdtempTracked(join(tmpdir(), "github-conformance-")), "state.json");
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
