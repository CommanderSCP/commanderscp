import { afterAll, beforeAll } from "vitest";
import type { PluginContext } from "@scp/plugin-api";
import { runNotificationConformanceSuite } from "@scp/plugin-testkit";
import { createSmtpNotifyPlugin } from "./index.js";
import { startFakeSmtpServer, type FakeSmtpServerHandle } from "./test-support/fake-smtp-server.js";

let server: FakeSmtpServerHandle;

beforeAll(async () => {
  server = await startFakeSmtpServer();
});
afterAll(async () => {
  await server.close();
});

runNotificationConformanceSuite("smtp-notify", async () => {
  const ctx: PluginContext = {
    orgId: "org-1",
    domainId: "domain-1",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { get: async () => undefined },
    http: {
      request: async () => {
        throw new Error("smtp-notify: never calls ctx.http");
      }
    },
    config: {
      host: "127.0.0.1",
      port: server.port,
      from: "scp@example.com",
      to: ["ops@example.com"]
    }
  };
  return {
    plugin: createSmtpNotifyPlugin(),
    ctx,
    message: { subject: "conformance", body: "conformance body", severity: "info" }
  };
});
