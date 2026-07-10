import { describe, expect, it } from "vitest";
import type { PluginContext, ScopedHttpRequest, ScopedHttpResponse } from "@scp/plugin-api";
import { createWebhookControlPlugin } from "./index.js";

function testCtx(config: unknown, requestImpl?: (req: ScopedHttpRequest) => Promise<ScopedHttpResponse>): PluginContext {
  return {
    orgId: "org-1",
    domainId: "domain-1",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { get: async () => undefined },
    http: {
      request: requestImpl ?? (async () => ({ status: 200, headers: {}, body: { status: "pass" } }))
    },
    config
  };
}

describe("webhook-control plugin", () => {
  it("POSTs changeId/controlId/context to the configured url and maps a 2xx pass response", async () => {
    const plugin = createWebhookControlPlugin();
    let seenRequest: ScopedHttpRequest | undefined;
    const ctx = testCtx({ url: "https://example.invalid/hook" }, async (req) => {
      seenRequest = req;
      return { status: 200, headers: {}, body: { status: "pass", evidence: { scanId: "abc" } } };
    });

    const outcome = await plugin.evaluate(ctx, { changeId: "c1", controlId: "ctl1", context: { foo: "bar" } });

    expect(outcome).toEqual({ status: "pass", detail: undefined, evidence: { scanId: "abc" } });
    expect(seenRequest?.method).toBe("POST");
    expect(seenRequest?.url).toBe("https://example.invalid/hook");
    expect(seenRequest?.body).toEqual({ changeId: "c1", controlId: "ctl1", context: { foo: "bar" } });
  });

  it("maps a 2xx fail response", async () => {
    const plugin = createWebhookControlPlugin();
    const ctx = testCtx({ url: "https://example.invalid/hook" }, async () => ({
      status: 200,
      headers: {},
      body: { status: "fail", detail: "CVE-2026-1234 found" }
    }));
    const outcome = await plugin.evaluate(ctx, { changeId: "c1", controlId: "ctl1", context: {} });
    expect(outcome.status).toBe("fail");
    expect(outcome.detail).toBe("CVE-2026-1234 found");
  });

  it("times out -> 'timed_out' when the endpoint never responds within timeoutMs", async () => {
    const plugin = createWebhookControlPlugin();
    const ctx = testCtx(
      { url: "https://example.invalid/hook", timeoutMs: 20 },
      () => new Promise(() => {}) // never resolves
    );
    const outcome = await plugin.evaluate(ctx, { changeId: "c1", controlId: "ctl1", context: {} });
    expect(outcome.status).toBe("timed_out");
    expect(outcome.evidence).toBeDefined();
  });

  it("a thrown/rejected http call maps to 'fail', never an uncaught rejection", async () => {
    const plugin = createWebhookControlPlugin();
    const ctx = testCtx({ url: "https://example.invalid/hook" }, async () => {
      throw new Error("ECONNREFUSED");
    });
    const outcome = await plugin.evaluate(ctx, { changeId: "c1", controlId: "ctl1", context: {} });
    expect(outcome.status).toBe("fail");
    expect(outcome.detail).toContain("ECONNREFUSED");
  });

  it("a non-2xx HTTP response maps to 'fail' with the status code in evidence", async () => {
    const plugin = createWebhookControlPlugin();
    const ctx = testCtx({ url: "https://example.invalid/hook" }, async () => ({
      status: 500,
      headers: {},
      body: "internal error"
    }));
    const outcome = await plugin.evaluate(ctx, { changeId: "c1", controlId: "ctl1", context: {} });
    expect(outcome.status).toBe("fail");
    expect(outcome.evidence).toMatchObject({ httpStatus: 500 });
  });

  it("a response body without a recognized 'status' field maps to 'fail' (fails safe on a malformed endpoint)", async () => {
    const plugin = createWebhookControlPlugin();
    const ctx = testCtx({ url: "https://example.invalid/hook" }, async () => ({
      status: 200,
      headers: {},
      body: { ok: true } // no 'status' field at all
    }));
    const outcome = await plugin.evaluate(ctx, { changeId: "c1", controlId: "ctl1", context: {} });
    expect(outcome.status).toBe("fail");
  });

  it("a response body with an UNRECOGNIZED status string maps to 'fail' rather than passing through arbitrary values", async () => {
    const plugin = createWebhookControlPlugin();
    const ctx = testCtx({ url: "https://example.invalid/hook" }, async () => ({
      status: 200,
      headers: {},
      body: { status: "totally-made-up" }
    }));
    const outcome = await plugin.evaluate(ctx, { changeId: "c1", controlId: "ctl1", context: {} });
    expect(outcome.status).toBe("fail");
  });

  it("missing 'url' config fails closed rather than throwing", async () => {
    const plugin = createWebhookControlPlugin();
    const ctx = testCtx({});
    const outcome = await plugin.evaluate(ctx, { changeId: "c1", controlId: "ctl1", context: {} });
    expect(outcome.status).toBe("fail");
  });
});
