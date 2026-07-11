import { afterAll, beforeAll } from "vitest";
import nock from "nock";
import { runNotificationConformanceSuite } from "@scp/plugin-testkit";
import type { PluginContext } from "@scp/plugin-api";
import { createWebhookNotifyPlugin } from "./index.js";
import { createNodeHttpTestClient } from "./test-node-http-client.js";

const URL_BASE = "http://notify-conformance.test";

beforeAll(() => {
  nock.disableNetConnect();
  // Persisted (not per-test) — the generic conformance suite calls send() an unpredictable
  // number of times; this just needs to always answer 200 so `delivered: true` is well-formed.
  nock(URL_BASE).persist().post("/hook").reply(200, {});
});
afterAll(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

runNotificationConformanceSuite("webhook-notify", async () => {
  const ctx: PluginContext = {
    orgId: "org-1",
    domainId: "domain-1",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { get: async () => undefined },
    http: createNodeHttpTestClient(),
    config: { url: `${URL_BASE}/hook` }
  };
  return {
    plugin: createWebhookNotifyPlugin(),
    ctx,
    message: { subject: "conformance", body: "conformance body", severity: "info" }
  };
});
