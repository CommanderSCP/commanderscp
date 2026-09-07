/** Wires this plugin into the generic control conformance suite. See docs/plugins.md §553. */
import type { PluginContext, ScopedHttpResponse } from "@scp/plugin-api";
import { runControlConformanceSuite } from "@scp/plugin-testkit";
import { createWebhookControlPlugin } from "./index.js";

runControlConformanceSuite("webhook-control", async () => {
  const plugin = createWebhookControlPlugin();
  const ctx: PluginContext = {
    orgId: "conformance-org",
    scopeKey: "conformance-domain",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { get: async () => undefined },
    http: {
      request: async (): Promise<ScopedHttpResponse> => ({
        status: 200,
        headers: {},
        body: { status: "pass", evidence: { conformance: true } }
      })
    },
    config: { url: "https://example.invalid/webhook-control" }
  };
  return {
    plugin,
    ctx,
    request: { changeId: "conformance-change", controlId: "conformance-control", context: {} }
  };
});
