/** Wires this plugin into the generic control conformance suite. See docs/plugins.md §161. */
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
