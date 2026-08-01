import { describe, expect, it } from "vitest";
import type { PluginContext, ScopedHttpRequest, ScopedHttpResponse } from "@scp/plugin-api";
import { createGithubCheckControlPlugin } from "./index.js";

function testCtx(
  config: unknown,
  requestImpl?: (req: ScopedHttpRequest) => Promise<ScopedHttpResponse>
): PluginContext {
  return {
    orgId: "org-1",
    scopeKey: "domain-1",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { get: async () => undefined },
    http: {
      request: requestImpl ?? (async () => ({ status: 200, headers: {}, body: { check_runs: [] } }))
    },
    config
  };
}

const BASE_CONFIG = { owner: "acme", repo: "widgets", token: "gh-token" };

describe("github-check plugin", () => {
  it("all check runs completed+success for the ref -> pass", async () => {
    const plugin = createGithubCheckControlPlugin();
    let seenRequest: ScopedHttpRequest | undefined;
    const ctx = testCtx(BASE_CONFIG, async (req) => {
      seenRequest = req;
      return {
        status: 200,
        headers: {},
        body: {
          check_runs: [
            { name: "build", status: "completed", conclusion: "success" },
            { name: "lint", status: "completed", conclusion: "neutral" }
          ]
        }
      };
    });

    const outcome = await plugin.evaluate(ctx, {
      changeId: "c1",
      controlId: "ctl1",
      context: { commitSha: "abc123" }
    });

    expect(outcome.status).toBe("pass");
    expect(seenRequest?.method).toBe("GET");
    expect(seenRequest?.url).toBe(
      "https://api.github.com/repos/acme/widgets/commits/abc123/check-runs"
    );
    expect(seenRequest?.headers?.authorization).toBe("Bearer gh-token");
  });

  it("prefers context.commitSha over config.expectedRef", async () => {
    const plugin = createGithubCheckControlPlugin();
    let seenUrl: string | undefined;
    const ctx = testCtx({ ...BASE_CONFIG, expectedRef: "operator-pinned-sha" }, async (req) => {
      seenUrl = req.url;
      return {
        status: 200,
        headers: {},
        body: { check_runs: [{ name: "build", status: "completed", conclusion: "success" }] }
      };
    });
    await plugin.evaluate(ctx, {
      changeId: "c1",
      controlId: "ctl1",
      context: { commitSha: "from-context-sha" }
    });
    expect(seenUrl).toContain("/from-context-sha/");
  });

  it("falls back to config.expectedRef when context carries no commitSha", async () => {
    const plugin = createGithubCheckControlPlugin();
    let seenUrl: string | undefined;
    const ctx = testCtx({ ...BASE_CONFIG, expectedRef: "operator-pinned-sha" }, async (req) => {
      seenUrl = req.url;
      return {
        status: 200,
        headers: {},
        body: { check_runs: [{ name: "build", status: "completed", conclusion: "success" }] }
      };
    });
    await plugin.evaluate(ctx, { changeId: "c1", controlId: "ctl1", context: {} });
    expect(seenUrl).toContain("/operator-pinned-sha/");
  });

  it("no target ref anywhere fails closed rather than throwing", async () => {
    const plugin = createGithubCheckControlPlugin();
    const ctx = testCtx(BASE_CONFIG);
    const outcome = await plugin.evaluate(ctx, { changeId: "c1", controlId: "ctl1", context: {} });
    expect(outcome.status).toBe("fail");
  });

  it("missing owner/repo config fails closed", async () => {
    const plugin = createGithubCheckControlPlugin();
    const ctx = testCtx({ token: "gh-token" });
    const outcome = await plugin.evaluate(ctx, {
      changeId: "c1",
      controlId: "ctl1",
      context: { commitSha: "abc" }
    });
    expect(outcome.status).toBe("fail");
  });

  it("no auth token resolvable fails closed", async () => {
    const plugin = createGithubCheckControlPlugin();
    const ctx = testCtx({ owner: "acme", repo: "widgets" });
    const outcome = await plugin.evaluate(ctx, {
      changeId: "c1",
      controlId: "ctl1",
      context: { commitSha: "abc" }
    });
    expect(outcome.status).toBe("fail");
  });

  it("resolves a token via ctx.secrets when tokenSecretKey is configured", async () => {
    const plugin = createGithubCheckControlPlugin();
    const ctx: PluginContext = {
      ...testCtx({ owner: "acme", repo: "widgets", tokenSecretKey: "gh-pat" }, async () => ({
        status: 200,
        headers: {},
        body: { check_runs: [{ name: "build", status: "completed", conclusion: "success" }] }
      })),
      secrets: { get: async (key) => (key === "gh-pat" ? "resolved-token" : undefined) }
    };
    const outcome = await plugin.evaluate(ctx, {
      changeId: "c1",
      controlId: "ctl1",
      context: { commitSha: "abc" }
    });
    expect(outcome.status).toBe("pass");
  });

  it("a 404 (no check runs reported yet) maps to 'expired', not 'fail'", async () => {
    const plugin = createGithubCheckControlPlugin();
    const ctx = testCtx(BASE_CONFIG, async () => ({
      status: 404,
      headers: {},
      body: { message: "No commit found" }
    }));
    const outcome = await plugin.evaluate(ctx, {
      changeId: "c1",
      controlId: "ctl1",
      context: { commitSha: "abc" }
    });
    expect(outcome.status).toBe("expired");
  });

  it("zero check runs on a 200 response maps to 'expired' (CI hasn't started)", async () => {
    const plugin = createGithubCheckControlPlugin();
    const ctx = testCtx(BASE_CONFIG, async () => ({
      status: 200,
      headers: {},
      body: { check_runs: [] }
    }));
    const outcome = await plugin.evaluate(ctx, {
      changeId: "c1",
      controlId: "ctl1",
      context: { commitSha: "abc" }
    });
    expect(outcome.status).toBe("expired");
  });

  it("a still-running (status != completed) check run maps to 'expired', not 'fail'", async () => {
    const plugin = createGithubCheckControlPlugin();
    const ctx = testCtx(BASE_CONFIG, async () => ({
      status: 200,
      headers: {},
      body: { check_runs: [{ name: "build", status: "in_progress", conclusion: null }] }
    }));
    const outcome = await plugin.evaluate(ctx, {
      changeId: "c1",
      controlId: "ctl1",
      context: { commitSha: "abc" }
    });
    expect(outcome.status).toBe("expired");
  });

  it("a completed check run with conclusion=failure maps to 'fail' (terminal)", async () => {
    const plugin = createGithubCheckControlPlugin();
    const ctx = testCtx(BASE_CONFIG, async () => ({
      status: 200,
      headers: {},
      body: { check_runs: [{ name: "build", status: "completed", conclusion: "failure" }] }
    }));
    const outcome = await plugin.evaluate(ctx, {
      changeId: "c1",
      controlId: "ctl1",
      context: { commitSha: "abc" }
    });
    expect(outcome.status).toBe("fail");
    expect(outcome.detail).toContain("build=failure");
  });

  it("checkName filters to just the named run — other failing runs are ignored", async () => {
    const plugin = createGithubCheckControlPlugin();
    const ctx = testCtx({ ...BASE_CONFIG, checkName: "build" }, async () => ({
      status: 200,
      headers: {},
      body: {
        check_runs: [
          { name: "build", status: "completed", conclusion: "success" },
          { name: "flaky-e2e", status: "completed", conclusion: "failure" }
        ]
      }
    }));
    const outcome = await plugin.evaluate(ctx, {
      changeId: "c1",
      controlId: "ctl1",
      context: { commitSha: "abc" }
    });
    expect(outcome.status).toBe("pass");
  });

  it("checkName with no matching run maps to 'expired'", async () => {
    const plugin = createGithubCheckControlPlugin();
    const ctx = testCtx({ ...BASE_CONFIG, checkName: "build" }, async () => ({
      status: 200,
      headers: {},
      body: { check_runs: [{ name: "lint", status: "completed", conclusion: "success" }] }
    }));
    const outcome = await plugin.evaluate(ctx, {
      changeId: "c1",
      controlId: "ctl1",
      context: { commitSha: "abc" }
    });
    expect(outcome.status).toBe("expired");
  });

  it("times out -> 'timed_out' when the API never responds within timeoutMs", async () => {
    const plugin = createGithubCheckControlPlugin();
    const ctx = testCtx({ ...BASE_CONFIG, timeoutMs: 20 }, () => new Promise(() => {}));
    const outcome = await plugin.evaluate(ctx, {
      changeId: "c1",
      controlId: "ctl1",
      context: { commitSha: "abc" }
    });
    expect(outcome.status).toBe("timed_out");
  });

  it("a thrown/rejected http call maps to 'fail', never an uncaught rejection", async () => {
    const plugin = createGithubCheckControlPlugin();
    const ctx = testCtx(BASE_CONFIG, async () => {
      throw new Error("ECONNREFUSED");
    });
    const outcome = await plugin.evaluate(ctx, {
      changeId: "c1",
      controlId: "ctl1",
      context: { commitSha: "abc" }
    });
    expect(outcome.status).toBe("fail");
    expect(outcome.detail).toContain("ECONNREFUSED");
  });

  it("a non-2xx/non-404 HTTP response maps to 'fail' with the status code in evidence", async () => {
    const plugin = createGithubCheckControlPlugin();
    const ctx = testCtx(BASE_CONFIG, async () => ({
      status: 500,
      headers: {},
      body: "internal error"
    }));
    const outcome = await plugin.evaluate(ctx, {
      changeId: "c1",
      controlId: "ctl1",
      context: { commitSha: "abc" }
    });
    expect(outcome.status).toBe("fail");
    expect(outcome.evidence).toMatchObject({ httpStatus: 500 });
  });
});
