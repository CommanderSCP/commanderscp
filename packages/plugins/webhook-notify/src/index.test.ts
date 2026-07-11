import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import nock from "nock";
import type { PluginContext } from "@scp/plugin-api";
import { webhookNotifyPlugin } from "./index.js";
import { createNodeHttpTestClient } from "./test-node-http-client.js";

const URL_BASE = "http://notify.test";

function testCtx(config: unknown): PluginContext {
  return {
    orgId: "org-1",
    domainId: "domain-1",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { get: async () => undefined },
    http: createNodeHttpTestClient(),
    config
  };
}

beforeAll(() => {
  nock.disableNetConnect();
});
afterEach(() => {
  nock.cleanAll();
});
afterAll(() => {
  nock.enableNetConnect();
});

describe("@scp/plugin-webhook-notify", () => {
  it("POSTs the message shape to config.url and reports delivered:true on 2xx", async () => {
    const scope = nock(URL_BASE)
      .post("/hook", {
        subject: "Change stalled",
        body: "details here",
        severity: "warning",
        context: { changeObjectId: "c1" }
      })
      .reply(200, {});

    const result = await webhookNotifyPlugin.send(testCtx({ url: `${URL_BASE}/hook` }), {
      subject: "Change stalled",
      body: "details here",
      severity: "warning",
      context: { changeObjectId: "c1" }
    });

    expect(scope.isDone()).toBe(true);
    expect(result).toEqual({ delivered: true });
  });

  it("defaults context to {} when the message omits it", async () => {
    const scope = nock(URL_BASE)
      .post("/hook", (body) => JSON.stringify(body.context) === "{}")
      .reply(200, {});

    const result = await webhookNotifyPlugin.send(testCtx({ url: `${URL_BASE}/hook` }), {
      subject: "s",
      body: "b",
      severity: "info"
    });

    expect(scope.isDone()).toBe(true);
    expect(result.delivered).toBe(true);
  });

  it("merges config.headers into the request", async () => {
    const scope = nock(URL_BASE, { reqheaders: { "x-api-key": "secret-token" } })
      .post("/hook")
      .reply(200, {});

    await webhookNotifyPlugin.send(
      testCtx({ url: `${URL_BASE}/hook`, headers: { "x-api-key": "secret-token" } }),
      {
        subject: "s",
        body: "b",
        severity: "critical"
      }
    );

    expect(scope.isDone()).toBe(true);
  });

  it("reports delivered:false (never throws) on a non-2xx response", async () => {
    const scope = nock(URL_BASE).post("/hook").reply(500, { error: "boom" });

    const result = await webhookNotifyPlugin.send(testCtx({ url: `${URL_BASE}/hook` }), {
      subject: "s",
      body: "b",
      severity: "info"
    });

    expect(scope.isDone()).toBe(true);
    expect(result.delivered).toBe(false);
    expect(result.detail).toContain("500");
  });

  it("reports delivered:false (never throws) when the endpoint is unreachable", async () => {
    // No nock interceptor registered — disableNetConnect() makes this reject immediately with a
    // "disallowed net connect" style error, which send() must catch and turn into a DeliveryResult.
    const result = await webhookNotifyPlugin.send(testCtx({ url: `${URL_BASE}/unregistered` }), {
      subject: "s",
      body: "b",
      severity: "info"
    });

    expect(result.delivered).toBe(false);
    expect(result.detail).toBeDefined();
  });

  it("times out (delivered:false) when the endpoint never responds within config.timeoutMs", async () => {
    nock(URL_BASE).post("/hook").delay(200).reply(200, {});

    const result = await webhookNotifyPlugin.send(
      testCtx({ url: `${URL_BASE}/hook`, timeoutMs: 20 }),
      {
        subject: "s",
        body: "b",
        severity: "info"
      }
    );

    expect(result.delivered).toBe(false);
    expect(result.detail).toContain("timed out");
  });

  it("throws synchronously (config error, not a DeliveryResult) when config.url is missing", async () => {
    await expect(
      webhookNotifyPlugin.send(testCtx({}), { subject: "s", body: "b", severity: "info" })
    ).rejects.toThrow("config.url is required");
  });
});
