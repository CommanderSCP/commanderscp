/**
 * Wires `@scp/plugin-webhook-control` into `@scp/plugin-testkit`'s generic `ControlPlugin`
 * conformance suite (BUILD_AND_TEST.md §4.2: "every shipped plugin runs the relevant
 * `@scp/plugin-testkit` suite in its own package tests"). The suite itself lives in
 * plugin-testkit and knows nothing about webhook-control specifics — this file is only the
 * fixture factory, pointed at a `ctx.http` stub that always returns a well-formed pass response.
 */
import type { PluginContext, ScopedHttpResponse } from "@scp/plugin-api";
import { runControlConformanceSuite } from "@scp/plugin-testkit";
import { createWebhookControlPlugin } from "./index.js";

runControlConformanceSuite("webhook-control", async () => {
  const plugin = createWebhookControlPlugin();
  const ctx: PluginContext = {
    orgId: "conformance-org",
    domainId: "conformance-domain",
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
