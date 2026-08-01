/**
 * Wires `@scp/plugin-github-check` into `@scp/plugin-testkit`'s generic `ControlPlugin`
 * conformance suite (BUILD_AND_TEST.md §4.2: "every shipped plugin runs the relevant
 * `@scp/plugin-testkit` suite in its own package tests"). The suite itself lives in
 * plugin-testkit and knows nothing about github-check specifics — this file is only the fixture
 * factory, pointed at a `ctx.http` stub that always returns a well-formed green check run.
 */
import type { PluginContext, ScopedHttpResponse } from "@scp/plugin-api";
import { runControlConformanceSuite } from "@scp/plugin-testkit";
import { createGithubCheckControlPlugin } from "./index.js";

runControlConformanceSuite("github-check", async () => {
  const plugin = createGithubCheckControlPlugin();
  const ctx: PluginContext = {
    orgId: "conformance-org",
    scopeKey: "conformance-domain",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { get: async () => undefined },
    http: {
      request: async (): Promise<ScopedHttpResponse> => ({
        status: 200,
        headers: {},
        body: { check_runs: [{ name: "build", status: "completed", conclusion: "success" }] }
      })
    },
    config: { owner: "conformance-org", repo: "conformance-repo", token: "conformance-token" }
  };
  return {
    plugin,
    ctx,
    request: {
      changeId: "conformance-change",
      controlId: "conformance-control",
      context: { commitSha: "abc123" }
    }
  };
});
