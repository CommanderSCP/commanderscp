/**
 * `@scp/plugin-gitea` behavioral test suite (M15.1b). Every HTTP call is fixtured deterministically
 * with `nock` against Node's `http`/`https` core modules (see `gitea-test-support.ts`'s module doc
 * for why the `ScopedHttpClient` uses `node:https` directly, not `fetch`). `nock.disableNetConnect()`
 * is active file-wide so any unanticipated call fails loudly rather than reaching the real network
 * (CLAUDE.md: "Tests never touch the internet"). Each test's interceptors are checked for full
 * consumption by the file-wide `afterEach` (`nock.pendingMocks()` must be empty).
 *
 * These assert REAL Gitea wire shapes (documented Swagger + the bare-hex X-Gitea-Signature), not
 * tautologies: the auth header is `token <PAT>` (NOT github's Bearer), the base is `/api/v1`, the
 * run status is a single Gitea enum, and the webhook signature is bare hex with NO `sha256=` prefix.
 */
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import nock from "nock";
import {
  createGiteaDiscoveryPlugin,
  createGiteaExecutorPlugin,
  giteaAdapter,
  mapGiteaWebhookEventToHint,
  verifyGiteaWebhookSignature,
  type GiteaConfig
} from "./index.js";
import { apiBase, authHeaderFor, buildGiteaConfig, buildTestCtx } from "./gitea-test-support.js";

const plugin = createGiteaExecutorPlugin();
const discoveryPlugin = createGiteaDiscoveryPlugin();

function setup(overrides: Partial<GiteaConfig> = {}) {
  const config = buildGiteaConfig(overrides);
  const ctx = buildTestCtx(config);
  return { config, ctx, authHeader: authHeaderFor(config), base: apiBase(config) };
}

beforeAll(() => {
  nock.disableNetConnect();
});

afterAll(() => {
  nock.enableNetConnect();
});

afterEach(() => {
  const pending = nock.pendingMocks();
  nock.cleanAll();
  expect(pending, `unconsumed nock interceptors after test: ${pending.join(", ")}`).toEqual([]);
});

// -------------------------------------------------------------------------------------------
// verifyGiteaWebhookSignature — bare-hex X-Gitea-Signature (NO sha256= prefix). Pure function.
// -------------------------------------------------------------------------------------------

describe("verifyGiteaWebhookSignature (bare-hex X-Gitea-Signature)", () => {
  const secret = "gitea-webhook-secret";
  const body = Buffer.from(JSON.stringify({ ref: "refs/heads/main" }));

  /** Gitea's real signing scheme: bare hex, no prefix. */
  function sign(rawBody: Buffer, withSecret: string): string {
    return createHmac("sha256", withSecret).update(rawBody).digest("hex");
  }

  it("accepts a validly-signed body (real bare-hex HMAC-SHA256, Gitea's X-Gitea-Signature scheme)", () => {
    expect(verifyGiteaWebhookSignature(body, sign(body, secret), secret)).toBe(true);
  });

  it("rejects a signature computed with the WRONG secret", () => {
    expect(verifyGiteaWebhookSignature(body, sign(body, "other-secret"), secret)).toBe(false);
  });

  it("rejects a github-style 'sha256='-PREFIXED header — that is NOT a valid Gitea signature", () => {
    // The concrete cross-provider correctness point: the exact same HMAC bytes, but with github's
    // prefix, must be rejected by the gitea verifier (and vice-versa, tested at the server layer).
    expect(verifyGiteaWebhookSignature(body, `sha256=${sign(body, secret)}`, secret)).toBe(false);
  });

  it("rejects when the signature header is missing entirely", () => {
    expect(verifyGiteaWebhookSignature(body, undefined, secret)).toBe(false);
  });

  it("rejects a non-hex header without throwing", () => {
    expect(() => verifyGiteaWebhookSignature(body, "not-hex-zzzz", secret)).not.toThrow();
    expect(verifyGiteaWebhookSignature(body, "not-hex-zzzz", secret)).toBe(false);
  });

  it("rejects a truncated digest (length guard, fail-closed not thrown)", () => {
    const truncated = sign(body, secret).slice(0, -4);
    expect(() => verifyGiteaWebhookSignature(body, truncated, secret)).not.toThrow();
    expect(verifyGiteaWebhookSignature(body, truncated, secret)).toBe(false);
  });

  it("rejects when the BODY was tampered with after signing", () => {
    const validForOriginal = sign(body, secret);
    const tampered = Buffer.from(JSON.stringify({ ref: "refs/heads/evil" }));
    expect(verifyGiteaWebhookSignature(tampered, validForOriginal, secret)).toBe(false);
  });
});

// -------------------------------------------------------------------------------------------
// mapGiteaWebhookEventToHint — pure function.
// -------------------------------------------------------------------------------------------

describe("mapGiteaWebhookEventToHint", () => {
  it("maps push to repo/commitSha/ref", () => {
    expect(
      mapGiteaWebhookEventToHint("push", {
        ref: "refs/heads/main",
        after: "0".repeat(40),
        head_commit: { id: "1".repeat(40) },
        repository: { full_name: "acme/widgets" }
      })
    ).toEqual({
      repo: "acme/widgets",
      commitSha: "1".repeat(40),
      correlationKey: "refs/heads/main",
      ref: "refs/heads/main"
    });
  });

  it("maps pull_request using the top-level number Gitea nests it at", () => {
    const hint = mapGiteaWebhookEventToHint("pull_request", {
      number: 7,
      pull_request: { head: { sha: "2".repeat(40) } },
      repository: { full_name: "acme/widgets" }
    });
    expect(hint).toEqual({
      repo: "acme/widgets",
      commitSha: "2".repeat(40),
      correlationKey: "pr-7"
    });
  });

  it("maps release to tag_name/target_commitish", () => {
    const hint = mapGiteaWebhookEventToHint("release", {
      release: { tag_name: "v2.0.0", target_commitish: "main" },
      repository: { full_name: "acme/widgets" }
    });
    expect(hint).toEqual({ repo: "acme/widgets", correlationKey: "v2.0.0", path: "main" });
  });

  it("maps a package event with a sha256: version to artifactDigest (the registry correlation key)", () => {
    const digest = "sha256:" + "ab".repeat(32);
    const hint = mapGiteaWebhookEventToHint("package", {
      repository: { full_name: "acme/widgets" },
      package: { name: "widgets", version: digest, type: "container" }
    });
    expect(hint).toEqual({
      repo: "acme/widgets",
      artifactDigest: digest,
      correlationKey: `widgets:${digest}`
    });
  });

  it("maps a package event with a TAG (non-digest) version to correlationKey only, artifactDigest undefined", () => {
    const hint = mapGiteaWebhookEventToHint("package", {
      repository: { full_name: "acme/widgets" },
      package: { name: "widgets", version: "1.2.3", type: "container" }
    });
    expect(hint?.artifactDigest).toBeUndefined();
    expect(hint?.correlationKey).toBe("widgets:1.2.3");
  });

  it("returns null for an unrecognized event name", () => {
    expect(mapGiteaWebhookEventToHint("issues", {})).toBeNull();
    expect(mapGiteaWebhookEventToHint("star", { repository: { full_name: "a/b" } })).toBeNull();
  });
});

// -------------------------------------------------------------------------------------------
// trigger() — workflow_dispatch (Gitea Actions, ASSUMED shapes; the token-auth header is real).
// -------------------------------------------------------------------------------------------

describe("trigger() — workflow_dispatch", () => {
  it("dispatches, correlates the newest run, returns action_run::<id>, and carries the token auth header", async () => {
    const { config, ctx, authHeader, base } = setup();
    const dispatchScope = nock(base)
      .matchHeader("authorization", authHeader)
      .post(
        `/repos/${config.owner}/${config.repo}/actions/workflows/${config.defaultWorkflowId}/dispatches`,
        { ref: "main", inputs: {} }
      )
      .reply(204);
    const runId = 4242;
    const pollScope = nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/actions/runs`)
      .reply(200, {
        workflow_runs: [
          {
            id: runId,
            status: "running",
            html_url: `${config.baseUrl}/${config.owner}/${config.repo}/actions/runs/${runId}`,
            head_sha: "5".repeat(40),
            created_at: new Date().toISOString()
          }
        ]
      });

    const ref = await plugin.trigger(ctx, { kind: "workflow_dispatch" });
    expect(ref.externalId).toBe(`action_run::${runId}`);
    expect(ref.url).toBe(`${config.baseUrl}/${config.owner}/${config.repo}/actions/runs/${runId}`);
    dispatchScope.done();
    pollScope.done();
  });

  it("uses intent.parameters.workflowId/ref/inputs over the config defaults", async () => {
    const { config, ctx, authHeader, base } = setup();
    const dispatchScope = nock(base)
      .matchHeader("authorization", authHeader)
      .post(`/repos/${config.owner}/${config.repo}/actions/workflows/deploy.yml/dispatches`, {
        ref: "release/1.0",
        inputs: { environment: "staging" }
      })
      .reply(204);
    const runId = 909;
    const pollScope = nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/actions/runs`)
      .reply(200, {
        workflow_runs: [{ id: runId, status: "waiting", created_at: new Date().toISOString() }]
      });

    const ref = await plugin.trigger(ctx, {
      kind: "workflow_dispatch",
      parameters: {
        workflowId: "deploy.yml",
        ref: "release/1.0",
        inputs: { environment: "staging" }
      }
    });
    expect(ref.externalId).toBe(`action_run::${runId}`);
    dispatchScope.done();
    pollScope.done();
  });

  it("returns an uncorrelated workflow_dispatch::<key> ref (not a throw) when no run correlates after 3 attempts", async () => {
    const { config, ctx, authHeader, base } = setup();
    const dispatchScope = nock(base)
      .matchHeader("authorization", authHeader)
      .post(
        `/repos/${config.owner}/${config.repo}/actions/workflows/${config.defaultWorkflowId}/dispatches`
      )
      .reply(204);
    const pollScope = nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/actions/runs`)
      .times(3)
      .reply(200, { workflow_runs: [] });

    const ref = await plugin.trigger(ctx, { kind: "workflow_dispatch" });
    expect(ref.externalId.startsWith("workflow_dispatch::")).toBe(true);
    expect(ref.url).toBeUndefined();
    dispatchScope.done();
    pollScope.done();
  }, 10_000);

  it("throws a clear Error when no workflowId is available, WITHOUT any HTTP call", async () => {
    const config = buildGiteaConfig({ defaultWorkflowId: undefined });
    const ctx = buildTestCtx(config);
    await expect(plugin.trigger(ctx, { kind: "workflow_dispatch" })).rejects.toThrow(
      /no workflowId/
    );
  });

  it("resolves the PAT from ctx.secrets when only tokenSecretKey is configured", async () => {
    const config = buildGiteaConfig({ tokenPlaintext: undefined, tokenSecretKey: "gitea-pat" });
    const ctx = buildTestCtx(config, { secrets: { "gitea-pat": "resolved-secret-pat" } });
    const dispatchScope = nock(apiBase(config))
      .matchHeader("authorization", "token resolved-secret-pat")
      .post(
        `/repos/${config.owner}/${config.repo}/actions/workflows/${config.defaultWorkflowId}/dispatches`
      )
      .reply(204);
    const pollScope = nock(apiBase(config))
      .matchHeader("authorization", "token resolved-secret-pat")
      .get(`/repos/${config.owner}/${config.repo}/actions/runs`)
      .reply(200, {
        workflow_runs: [{ id: 1, status: "running", created_at: new Date().toISOString() }]
      });

    const ref = await plugin.trigger(ctx, { kind: "workflow_dispatch" });
    expect(ref.externalId).toBe("action_run::1");
    dispatchScope.done();
    pollScope.done();
  });
});

// -------------------------------------------------------------------------------------------
// trigger() idempotency
// -------------------------------------------------------------------------------------------

describe("trigger() idempotency — in-memory dedup cache", () => {
  it("a second trigger() with the SAME idempotencyKey returns the SAME ref and never re-dispatches", async () => {
    const { config, ctx, authHeader, base } = setup();
    const runId = 7001;
    const dispatchScope = nock(base)
      .matchHeader("authorization", authHeader)
      .post(
        `/repos/${config.owner}/${config.repo}/actions/workflows/${config.defaultWorkflowId}/dispatches`
      )
      .reply(204);
    const pollScope = nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/actions/runs`)
      .reply(200, {
        workflow_runs: [{ id: runId, status: "running", created_at: new Date().toISOString() }]
      });

    const intent = { kind: "workflow_dispatch" as const, idempotencyKey: `mem-${randomKey()}` };
    const first = await plugin.trigger(ctx, intent);
    expect(first.externalId).toBe(`action_run::${runId}`);
    dispatchScope.done();
    pollScope.done();

    // Second call: no interceptors remain + net-connect disabled → a re-dispatch would throw.
    const second = await plugin.trigger(ctx, intent);
    expect(second.externalId).toBe(first.externalId);
  });
});

describe("trigger() idempotency — file-backed dedup cache", () => {
  let dir: string;
  let statePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "scp-gitea-test-"));
    statePath = join(dir, "state.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("a second trigger() re-reads the on-disk cache and never re-dispatches", async () => {
    const { config, ctx, authHeader, base } = setup({ statePath });
    const runId = 7002;
    const dispatchScope = nock(base)
      .matchHeader("authorization", authHeader)
      .post(
        `/repos/${config.owner}/${config.repo}/actions/workflows/${config.defaultWorkflowId}/dispatches`
      )
      .reply(204);
    const pollScope = nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/actions/runs`)
      .reply(200, {
        workflow_runs: [{ id: runId, status: "running", created_at: new Date().toISOString() }]
      });

    const intent = { kind: "workflow_dispatch" as const, idempotencyKey: "file-backed-key" };
    const first = await plugin.trigger(ctx, intent);
    dispatchScope.done();
    pollScope.done();

    const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
      keys: Record<string, { externalId: string }>;
    };
    expect(persisted.keys["file-backed-key"]?.externalId).toBe(first.externalId);

    const second = await plugin.trigger(ctx, intent);
    expect(second.externalId).toBe(first.externalId);
  });
});

// -------------------------------------------------------------------------------------------
// status() — Gitea's SINGLE status enum → phase.
// -------------------------------------------------------------------------------------------

describe("status() — single Gitea status enum", () => {
  async function statusFor(runStatus: string) {
    const { config, ctx, authHeader, base } = setup();
    const runId = Math.floor(Math.random() * 1_000_000) + 1;
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/actions/runs/${runId}`)
      .reply(200, { id: runId, status: runStatus, head_sha: "8".repeat(40) });
    return plugin.status(ctx, { externalId: `action_run::${runId}` });
  }

  it("running -> running", async () => {
    const s = await statusFor("running");
    expect(s.phase).toBe("running");
    expect(s.progress).toBe(0.5);
  });
  it("waiting -> running", async () => expect((await statusFor("waiting")).phase).toBe("running"));
  it("success -> succeeded", async () => {
    const s = await statusFor("success");
    expect(s.phase).toBe("succeeded");
    expect(s.progress).toBe(1);
  });
  it("failure -> failed", async () => expect((await statusFor("failure")).phase).toBe("failed"));
  it("cancelled -> aborted", async () =>
    expect((await statusFor("cancelled")).phase).toBe("aborted"));
  it("an unknown status maps to running (safe default, not a crash)", async () =>
    expect((await statusFor("some-future-status")).phase).toBe("running"));

  it("an uncorrelated ref reports pending WITHOUT any HTTP call", async () => {
    const config = buildGiteaConfig();
    const ctx = buildTestCtx(config);
    const s = await plugin.status(ctx, { externalId: "workflow_dispatch::key" });
    expect(s.phase).toBe("pending");
  });

  it("a non-2xx status response throws a clear HTTP-status-bearing Error", async () => {
    const { config, ctx, authHeader, base } = setup();
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/actions/runs/500`)
      .reply(500, { message: "boom" });
    await expect(plugin.status(ctx, { externalId: "action_run::500" })).rejects.toThrow(/HTTP 500/);
  });

  it("ENCODES the runId sliced out of externalId into the route", async () => {
    // Same census class as readFileAtRef's `repo`/`ref` (M21.2 review BLOCKERS 1-2) and github's
    // `postCommitStatus` sha: a non-literal string spliced into a REST route. `externalId` is
    // stored correlation state and numeric in practice, so this encoding is an IDENTITY today and
    // its removal would change no observed behaviour — which is exactly why it is pinned. An
    // unpinned member of a censused class is indistinguishable from an untouched one on the next
    // refactor (CLAUDE.md, "census by property, not by symptom"). Unencoded, `../../../user`
    // re-targets this GET at `<base>/user` because `new URL()` collapses literal `..` segments;
    // encoded it is `..%2F..%2F..%2Fuser`, ONE segment a URL does not normalize away. The
    // interceptor matches only the encoded form, and `disableNetConnect()` plus the file-wide
    // pending-mocks check make the unencoded form fail loudly rather than pass quietly.
    const { config, ctx, authHeader, base } = setup();
    const runId = "../../../user";
    const scope = nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/actions/runs/${encodeURIComponent(runId)}`)
      .reply(200, { id: 1, status: "success", head_sha: "8".repeat(40) });

    const s = await plugin.status(ctx, { externalId: `action_run::${runId}` });
    expect(s.phase).toBe("succeeded");
    scope.done();
  });
});

// -------------------------------------------------------------------------------------------
// abort()
// -------------------------------------------------------------------------------------------

describe("abort()", () => {
  it("cancels a correlated run", async () => {
    const { config, ctx, authHeader, base } = setup();
    nock(base)
      .matchHeader("authorization", authHeader)
      .post(`/repos/${config.owner}/${config.repo}/actions/runs/9001/cancel`)
      .reply(200);
    expect(await plugin.abort(ctx, { externalId: "action_run::9001" })).toEqual({ aborted: true });
  });

  it("a non-2xx cancel maps to aborted:false with detail, never throws", async () => {
    const { config, ctx, authHeader, base } = setup();
    nock(base)
      .matchHeader("authorization", authHeader)
      .post(`/repos/${config.owner}/${config.repo}/actions/runs/9002/cancel`)
      .reply(409, { message: "already done" });
    const r = await plugin.abort(ctx, { externalId: "action_run::9002" });
    expect(r.aborted).toBe(false);
    expect(r.detail).toContain("409");
  });

  it("an uncorrelated ref reports aborted:false without any HTTP call", async () => {
    const config = buildGiteaConfig();
    const ctx = buildTestCtx(config);
    expect(await plugin.abort(ctx, { externalId: "workflow_dispatch::key" })).toEqual({
      aborted: false,
      detail: "gitea: no correlated run to cancel"
    });
  });

  it("ENCODES the runId sliced out of externalId into the cancel route", async () => {
    // The second of this adapter's two `externalId`-derived route splices — see the identical pin
    // in `status()` above for why an identity-today encoding is still pinned. Unencoded this POST
    // would land on `<base>/user/cancel` rather than on the run.
    const { config, ctx, authHeader, base } = setup();
    const runId = "../../../user";
    const scope = nock(base)
      .matchHeader("authorization", authHeader)
      .post(
        `/repos/${config.owner}/${config.repo}/actions/runs/${encodeURIComponent(runId)}/cancel`
      )
      .reply(200);

    expect(await plugin.abort(ctx, { externalId: `action_run::${runId}` })).toEqual({
      aborted: true
    });
    scope.done();
  });
});

// -------------------------------------------------------------------------------------------
// observe() — commits + runs + PACKAGE pushes (artifactDigest), and poll-vs-push equivalence.
// -------------------------------------------------------------------------------------------

describe("observe() polling — commits, runs, and package pushes", () => {
  function nockCommitsAndRuns(
    base: string,
    authHeader: string,
    config: GiteaConfig,
    opts: { commits?: unknown[]; runs?: unknown[] }
  ) {
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/commits`)
      .reply(200, opts.commits ?? []);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/actions/runs`)
      .reply(200, { workflow_runs: opts.runs ?? [] });
  }

  it("emits a package-push event with correlation.artifactDigest for a sha256: package version (github never populated this)", async () => {
    const { config, ctx, authHeader, base } = setup();
    const digest = "sha256:" + "cd".repeat(32);
    nockCommitsAndRuns(base, authHeader, config, {});
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/packages/${config.owner}`)
      .reply(200, [
        {
          type: "container",
          name: "widgets",
          version: digest,
          created_at: "2026-07-02T00:00:00Z",
          repository: { full_name: `${config.owner}/${config.repo}` }
        }
      ]);

    const events = await plugin.observe(ctx);
    const pkgEvent = events.find((e) => e.correlation.artifactDigest !== undefined);
    expect(pkgEvent).toBeDefined();
    expect(pkgEvent?.kind).toBe("custom");
    expect(pkgEvent?.correlation.artifactDigest).toBe(digest);
    expect(pkgEvent?.correlation.repo).toBe(`${config.owner}/${config.repo}`);
  });

  it("a tag-versioned package emits NO artifactDigest (never fabricated) but a correlationKey", async () => {
    const { config, ctx, authHeader, base } = setup();
    nockCommitsAndRuns(base, authHeader, config, {});
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/packages/${config.owner}`)
      .reply(200, [
        { type: "container", name: "widgets", version: "1.4.0", created_at: "2026-07-02T00:00:00Z" }
      ]);

    const events = await plugin.observe(ctx);
    const pkgEvent = events.find((e) => e.correlation.correlationKey === "widgets:1.4.0");
    expect(pkgEvent).toBeDefined();
    expect(pkgEvent?.correlation.artifactDigest).toBeUndefined();
  });

  it("maps commits and runs to well-formed ExecutorEvents", async () => {
    const { config, ctx, authHeader, base } = setup();
    const commitSha = "a1".repeat(20);
    const runSha = "b2".repeat(20);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/commits`)
      .reply(200, [{ sha: commitSha, commit: { author: { date: "2026-07-01T00:00:00Z" } } }]);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/actions/runs`)
      .reply(200, {
        workflow_runs: [
          { id: 55, status: "success", head_sha: runSha, created_at: "2026-07-01T00:05:00Z" }
        ]
      });
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/packages/${config.owner}`)
      .reply(200, []);

    const events = await plugin.observe(ctx);
    const push = events.find((e) => e.kind === "push");
    expect(push?.correlation).toEqual({
      repo: `${config.owner}/${config.repo}`,
      path: undefined,
      commitSha,
      artifactDigest: undefined,
      correlationKey: "refs/heads/*"
    });
    const run = events.find((e) => e.kind === "workflow_run");
    expect(run?.correlation.commitSha).toBe(runSha);
    expect(run?.correlation.correlationKey).toBe("run-55");
  });

  it("poll-vs-push equivalence: observe()'s polled push carries the SAME repo/commitSha mapGiteaWebhookEventToHint yields for the equivalent push webhook", async () => {
    const commitSha = "c3".repeat(20);
    const webhookHint = mapGiteaWebhookEventToHint("push", {
      ref: "refs/heads/main",
      after: commitSha,
      head_commit: { id: commitSha },
      repository: { full_name: "acme/widgets" }
    });
    const { config, ctx, authHeader, base } = setup({ owner: "acme", repo: "widgets" });
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/commits`)
      .reply(200, [{ sha: commitSha, commit: { author: { date: "2026-07-01T00:00:00Z" } } }]);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/actions/runs`)
      .reply(200, { workflow_runs: [] });
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/packages/${config.owner}`)
      .reply(200, []);

    const events = await plugin.observe(ctx);
    const polledPush = events.find((e) => e.kind === "push");
    expect(polledPush?.correlation.repo).toBe(webhookHint?.repo);
    expect(polledPush?.correlation.commitSha).toBe(webhookHint?.commitSha);
  });

  it("silently skips (does not throw for) a rate-limited/non-2xx resource — the lenient observe posture", async () => {
    const { config, ctx, authHeader, base } = setup();
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/commits`)
      .reply(403, { message: "rate limited" });
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/actions/runs`)
      .reply(200, { workflow_runs: [] });
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/packages/${config.owner}`)
      .reply(200, []);

    await expect(plugin.observe(ctx)).resolves.toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------
// Base-URL resolution (M15.3b) — explicit `baseUrl` → injected `serverUrl` (Mode A: import an
// EXISTING Gitea, the execution-system's serverUrl injected as config.serverUrl). Gitea has NO
// provider default (unlike github's api.github.com), so neither being set is a hard, clear error.
// -------------------------------------------------------------------------------------------

describe("base URL resolution (baseUrl → serverUrl; required, no default)", () => {
  it("with ONLY serverUrl set (no baseUrl) every request targets <serverUrl>/api/v1", async () => {
    const serverUrl = "https://gitea.self-hosted.example";
    // baseUrl explicitly undefined → the injected serverUrl is the sole base; apiBase() and
    // index.ts's asConfig must both resolve to `${serverUrl}/api/v1`.
    const { config, ctx, authHeader, base } = setup({ baseUrl: undefined, serverUrl });
    expect(config.baseUrl).toBeUndefined();
    expect(base).toBe(`${serverUrl}/api/v1`);
    const commitSha = "e5".repeat(20);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/commits`)
      .reply(200, [{ sha: commitSha, commit: { author: { date: "2026-07-01T00:00:00Z" } } }]);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/actions/runs`)
      .reply(200, { workflow_runs: [] });
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/packages/${config.owner}`)
      .reply(200, []);

    const events = await plugin.observe(ctx);
    expect(events.find((e) => e.kind === "push")?.correlation.commitSha).toBe(commitSha);
  });

  it("an explicit baseUrl WINS over an injected serverUrl", async () => {
    const explicit = "https://gitea-explicit.example";
    const serverUrl = "https://gitea-injected.example";
    const { config, ctx, authHeader, base } = setup({ baseUrl: explicit, serverUrl });
    expect(base).toBe(`${explicit}/api/v1`);
    // Fixtures live ONLY on the explicit host — a request to the injected host would reject (net
    // connect disabled) and these would go unconsumed (afterEach fails).
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/commits`)
      .reply(200, []);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/actions/runs`)
      .reply(200, { workflow_runs: [] });
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/packages/${config.owner}`)
      .reply(200, []);

    await expect(plugin.observe(ctx)).resolves.toEqual([]);
  });

  it("throws a clear error when NEITHER baseUrl NOR serverUrl is set — no HTTP call attempted", async () => {
    const config = buildGiteaConfig({ baseUrl: undefined, serverUrl: undefined });
    const ctx = buildTestCtx(config);
    // asConfig throws before any api() call, so no interceptor is needed; net-connect is disabled,
    // so a stray call would reject anyway.
    await expect(plugin.observe(ctx)).rejects.toThrow(/no base URL configured/);
  });
});

// -------------------------------------------------------------------------------------------
// discover() (DiscoveryPlugin) — Gitea contents-API topology walk. The `sourceKind: 'gitea'` on
// the proposed component's sourceMapping is the load-bearing assertion (matches the executor's
// source_kind so imported components correlate observed gitea events). Gitea's contents API is
// GitHub-compatible; the fixtures below are REAL Gitea contents-API entry shapes.
// -------------------------------------------------------------------------------------------

describe("discover() (DiscoveryPlugin)", () => {
  it("proposes one Service (repo root) + one Component per marker-file-containing top-level dir; the component's sourceMapping.sourceKind is 'gitea'; non-marker dirs and non-dir entries are skipped", async () => {
    const { config, ctx, authHeader, base } = setup({ owner: "acme", repo: "monorepo" });
    // Gitea contents API (GitHub-compatible), rooted under this package's `/api/v1` base.
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/contents/`)
      .reply(200, [
        { name: "service-a", path: "service-a", type: "dir" },
        { name: "docs", path: "docs", type: "dir" }, // dir, but no marker file inside -> skipped
        { name: "README.md", path: "README.md", type: "file" } // not a dir -> no contents/ call
      ]);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/contents/service-a`)
      .reply(200, [
        { name: "go.mod", path: "service-a/go.mod", type: "file" },
        { name: "main.go", path: "service-a/main.go", type: "file" }
      ]);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/contents/docs`)
      .reply(200, [{ name: "README.md", path: "docs/README.md", type: "file" }]);

    const proposal = await discoveryPlugin.discover(ctx);

    const services = proposal.objects.filter((o) => o.typeId === "service");
    expect(services).toHaveLength(1);
    expect(services[0]).toMatchObject({ name: config.repo });

    const components = proposal.objects.filter((o) => o.typeId === "component");
    expect(components).toHaveLength(1);
    expect(components[0]?.name).toBe("service-a");
    // The whole point of the discovery half: a gitea-kinded source_mapping so observed gitea
    // events correlate against the imported component. type is omitted -> defaults to
    // 'configuration' server-side (follow-up: infer 'image' from a Dockerfile marker).
    expect(components[0]?.properties?.sourceMapping).toEqual({
      sourceKind: "gitea",
      repoPattern: `${config.owner}/${config.repo}`,
      pathPattern: "service-a/**"
    });

    // `contains`, SERVICE -> COMPONENT — the registered membership edge (migration 0021), NOT the
    // `part_of` this plugin used to emit: no migration registers that, so accept answered every
    // proposal carrying one with a 404 and the discovery relationship channel never worked.
    expect(proposal.relationships).toHaveLength(1);
    expect(proposal.relationships[0]).toEqual({
      typeId: "contains",
      fromUrn: `urn:scp:service:gitea:${config.owner}/${config.repo}`,
      toUrn: `urn:scp:component:gitea:${config.owner}/${config.repo}/service-a`
    });

    // The endpoints must be the ALIASES the proposed objects declare, asserted BY REFERENCE to
    // those objects rather than as a third copy of the literal. Restating the strings would let a
    // plugin change its URN scheme in one of the two places and stay green — and an endpoint that
    // names no proposed object is exactly the 404 (`object '...' not found`) that made this edge
    // unimportable even once its type was right.
    expect(proposal.relationships[0]?.fromUrn).toBe(services[0]?.urn);
    expect(proposal.relationships[0]?.toUrn).toBe(components[0]?.urn);
  });

  it("proposes ONLY the Service object (no components) when no top-level dir contains a marker file", async () => {
    const { config, ctx, authHeader, base } = setup();
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/contents/`)
      .reply(200, [{ name: "docs", path: "docs", type: "dir" }]);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/contents/docs`)
      .reply(200, [{ name: "index.md", path: "docs/index.md", type: "file" }]);

    const proposal = await discoveryPlugin.discover(ctx);
    expect(proposal.objects).toHaveLength(1);
    expect(proposal.objects[0]?.typeId).toBe("service");
    expect(proposal.relationships).toHaveLength(0);
  });
});

function randomKey(): string {
  return Math.random().toString(36).slice(2);
}

// -------------------------------------------------------------------------------------------
// readFileAtRef (M21.2, ADR-0032 §4) — the first file-body read in this package. Gitea's contents
// API is deliberately GITHUB-COMPATIBLE, so the fixtures below carry Gitea's documented
// `ContentsResponse` fields (`type`/`encoding`/`size`/`content`/`sha`, with `sha` being the BLOB
// sha) and a directory comes back from the same route as an array — the same shapes github's suite
// asserts. What is NOT github-shaped, and is asserted here, is the ref resolution: Gitea's contents
// response has no commit sha, so the commit comes from `GET /repos/{o}/{r}/commits?sha=<ref>&limit=1`
// (the same documented list-commits endpoint `pollCommits` already uses).
// -------------------------------------------------------------------------------------------

describe("readFileAtRef()", () => {
  const REF_COMMIT_SHA = "7c".repeat(20);

  function nockResolveRef(
    base: string,
    authHeader: string,
    config: GiteaConfig,
    ref = "main",
    sha: string | null = REF_COMMIT_SHA
  ) {
    return nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/commits`)
      .query({ sha: ref, limit: "1" })
      .reply(200, sha === null ? [] : [{ sha, commit: { message: "chore: bump" } }]);
  }

  it("reads a manifest and reports the commit the ref resolved to (from the commits list, NOT the blob sha)", async () => {
    const { config, ctx, authHeader, base } = setup();
    const manifest = "module example.com/widgets\n\ngo 1.22\n";
    const refScope = nockResolveRef(base, authHeader, config);
    const contentsScope = nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/contents/go.mod`)
      .query({ ref: REF_COMMIT_SHA })
      .reply(200, {
        name: "go.mod",
        path: "go.mod",
        sha: "blobgomod",
        // Present in Gitea's response and deliberately NOT used as `commitSha` — it means "last
        // commit that touched this file", a different fact from "what the ref resolved to".
        last_commit_sha: "ff".repeat(20),
        type: "file",
        size: Buffer.byteLength(manifest, "utf8"),
        encoding: "base64",
        content: Buffer.from(manifest, "utf8").toString("base64")
      });

    const result = await giteaAdapter.readFileAtRef(ctx, { path: "go.mod", ref: "main" });

    expect(result).toEqual({
      outcome: "found",
      path: "go.mod",
      requestedRef: "main",
      commitSha: REF_COMMIT_SHA,
      content: manifest,
      sizeBytes: Buffer.byteLength(manifest, "utf8"),
      blobSha: "blobgomod"
    });
    // NEGATIVE CONTROL: `last_commit_sha` is present in the fixture and must NOT be what was picked.
    expect((result as { commitSha: string }).commitSha).not.toBe("ff".repeat(20));
    refScope.done();
    contentsScope.done();
  });

  it("ESCAPES a '#' in both the ref and the path — unencoded it starts a URL fragment and TRUNCATES the request", async () => {
    // `#` is where these two encodings are load-bearing rather than decorative: `git
    // check-ref-format` permits it in a ref and it is legal in a filename, so neither
    // `assertSafeRef` nor `assertSafeRepoPath` refuses it — but unencoded it ends the URL, so step
    // 1's `?sha=release/#42` would query `sha=release/` (resolving the WRONG commit) and step 2
    // would request the `docs/` directory listing. Both are wrong answers, not errors, which is
    // why they are pinned rather than left to the not-found paths.
    const { config, ctx, authHeader, base } = setup();
    const ref = "release/#42";
    const path = "docs/notes#1.md";
    const refScope = nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/commits`)
      // nock decodes before matching, so this asserts the DECODED value round-trips — the
      // unencoded form never gets here at all, its `#` having been dropped as a fragment.
      .query({ sha: ref, limit: "1" })
      .reply(200, [{ sha: REF_COMMIT_SHA }]);
    const contentsScope = nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/contents/docs/notes%231.md`)
      .query({ ref: REF_COMMIT_SHA })
      .reply(200, {
        path,
        sha: "blobhash",
        type: "file",
        size: 3,
        encoding: "base64",
        content: Buffer.from("ok\n", "utf8").toString("base64")
      });

    const result = await giteaAdapter.readFileAtRef(ctx, { path, ref });
    expect(result).toMatchObject({ outcome: "found", content: "ok\n" });
    refScope.done();
    contentsScope.done();
  });

  it("round-trips MULTI-BYTE UTF-8 content (sizeBytes counts bytes, not UTF-16 units)", async () => {
    const { config, ctx, authHeader, base } = setup();
    const text = 'FROM alpine:1.0\nLABEL org.opencontainers.image.authors="Ada — 日本語 🎉"\n';
    nockResolveRef(base, authHeader, config);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/contents/Dockerfile`)
      .query({ ref: REF_COMMIT_SHA })
      .reply(200, {
        path: "Dockerfile",
        sha: "blobdock",
        type: "file",
        size: Buffer.byteLength(text, "utf8"),
        encoding: "base64",
        content: Buffer.from(text, "utf8").toString("base64")
      });

    const result = await giteaAdapter.readFileAtRef(ctx, { path: "Dockerfile", ref: "main" });
    expect(result.outcome).toBe("found");
    if (result.outcome !== "found") throw new Error("unreachable");
    expect(result.content).toBe(text);
    expect(result.sizeBytes).toBe(Buffer.byteLength(text, "utf8"));
    expect(result.sizeBytes).not.toBe(result.content.length);
  });

  it("a 404 on the FILE is a routine not_found (missing: 'path'), not a throw", async () => {
    const { config, ctx, authHeader, base } = setup();
    nockResolveRef(base, authHeader, config);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/contents/pom.xml`)
      .query({ ref: REF_COMMIT_SHA })
      .reply(404, { message: "object does not exist [id: , rel_path: pom.xml]" });

    const result = await giteaAdapter.readFileAtRef(ctx, { path: "pom.xml", ref: "main" });
    expect(result).toMatchObject({ outcome: "not_found", missing: "path" });
  });

  it("an EMPTY commits list for an unknown ref is not_found (missing: 'ref') — Gitea 200s that case", async () => {
    const { config, ctx, authHeader, base } = setup();
    nockResolveRef(base, authHeader, config, "no-such-branch", null);
    // NEGATIVE CONTROL: no contents interceptor is registered. Falling through to the contents call
    // would hit `nock.disableNetConnect()` and reject, failing this test rather than passing quietly.

    const result = await giteaAdapter.readFileAtRef(ctx, {
      path: "go.mod",
      ref: "no-such-branch"
    });
    expect(result).toMatchObject({ outcome: "not_found", missing: "ref" });
  });

  it("refuses an OVERSIZE file on Gitea's declared `size`, without decoding it", async () => {
    const { config, ctx, authHeader, base } = setup();
    nockResolveRef(base, authHeader, config);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/contents/package.json`)
      .query({ ref: REF_COMMIT_SHA })
      .reply(200, {
        path: "package.json",
        sha: "blobbig",
        type: "file",
        size: 9_000_000,
        encoding: "base64",
        content: Buffer.from("{}", "utf8").toString("base64")
      });

    const result = await giteaAdapter.readFileAtRef(ctx, { path: "package.json", ref: "main" });
    expect(result).toMatchObject({ outcome: "refused", reason: "too_large", sizeBytes: 9_000_000 });
    expect(result.outcome).not.toBe("found");
  });

  it("refuses on the COMPUTED payload size when the declared size understates it", async () => {
    const { config, ctx, authHeader, base } = setup();
    const big = "x".repeat(4096);
    nockResolveRef(base, authHeader, config);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/contents/requirements.txt`)
      .query({ ref: REF_COMMIT_SHA })
      .reply(200, {
        path: "requirements.txt",
        sha: "blobreq",
        type: "file",
        size: 12,
        encoding: "base64",
        content: Buffer.from(big, "utf8").toString("base64")
      });

    const result = await giteaAdapter.readFileAtRef(ctx, {
      path: "requirements.txt",
      ref: "main",
      maxBytes: 1024
    });
    expect(result).toMatchObject({ outcome: "refused", reason: "too_large", sizeBytes: 4096 });
  });

  it("refuses a DIRECTORY (array response) and a SUBMODULE (type != 'file')", async () => {
    const { config, ctx, authHeader, base } = setup();
    nockResolveRef(base, authHeader, config);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/contents/services`)
      .query({ ref: REF_COMMIT_SHA })
      .reply(200, [{ name: "api", path: "services/api", type: "dir" }]);

    const dir = await giteaAdapter.readFileAtRef(ctx, { path: "services", ref: "main" });
    expect(dir).toMatchObject({ outcome: "refused", reason: "not_a_file" });
    // `reason` alone does NOT pin the ARRAY branch: with `Array.isArray` deleted this same input
    // still yields not_a_file through the type gate, because `[].type` is undefined. The detail —
    // and the entry count, which only the array branch can produce — is what separates the two
    // gates. Censused here rather than fixed only where the reviewer found it (github).
    expect((dir as { detail: string }).detail).toContain(
      "is a directory (contents returned a listing of 1 entries)"
    );

    nockResolveRef(base, authHeader, config);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/contents/vendor/lib`)
      .query({ ref: REF_COMMIT_SHA })
      .reply(200, {
        path: "vendor/lib",
        sha: "submod",
        type: "submodule",
        submodule_git_url: "https://gitea.example.com/acme/lib.git"
      });

    const sub = await giteaAdapter.readFileAtRef(ctx, { path: "vendor/lib", ref: "main" });
    expect(sub).toMatchObject({ outcome: "refused", reason: "not_a_file" });
    expect((sub as { detail: string }).detail).toContain("content type 'submodule'");
  });

  it("refuses a BINARY file rather than returning replacement-character mojibake", async () => {
    const { config, ctx, authHeader, base } = setup();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    nockResolveRef(base, authHeader, config);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/contents/logo.png`)
      .query({ ref: REF_COMMIT_SHA })
      .reply(200, {
        path: "logo.png",
        sha: "blobpng",
        type: "file",
        size: png.byteLength,
        encoding: "base64",
        content: png.toString("base64")
      });

    const result = await giteaAdapter.readFileAtRef(ctx, { path: "logo.png", ref: "main" });
    expect(result).toMatchObject({ outcome: "refused", reason: "not_text" });
  });

  it("makes a REDIRECT legible — the failure a self-hosted Gitea behind a proxy actually produces", async () => {
    const { config, ctx, authHeader, base } = setup();
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/commits`)
      .query({ sha: "main", limit: "1" })
      .reply(302, "", { location: "https://gitea.example.com/api/v1/" });

    await expect(giteaAdapter.readFileAtRef(ctx, { path: "go.mod", ref: "main" })).rejects.toThrow(
      /HTTP 302.*redirects are refused/s
    );
  });

  it("throws a status-bearing error for a non-2xx that is neither 404 nor a redirect", async () => {
    const { config, ctx, authHeader, base } = setup();
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/commits`)
      .query({ sha: "main", limit: "1" })
      .reply(500, { message: "internal server error" });

    await expect(giteaAdapter.readFileAtRef(ctx, { path: "go.mod", ref: "main" })).rejects.toThrow(
      /HTTP 500/
    );
  });

  it("surfaces an egress-guard denial as an actionable error naming the self-hosted case (the guard is NOT relaxed)", async () => {
    // This is the failure an in-cluster Gitea on a private address produces: the guard blocks
    // loopback/private egress for every tenant-configurable plugin (subprocess-entry.ts:210-215,
    // egress-guard.ts:83) and `gitea` is deliberately not an operator-plane module. The adapter's
    // job is to make that legible, never to bypass it — so this test injects a ctx whose http client
    // throws exactly what the guard throws, and asserts only on the message.
    const config = buildGiteaConfig();
    const ctx = {
      ...buildTestCtx(config),
      http: {
        request: async () => {
          throw Object.assign(
            new Error(
              "egress guard: host 'gitea.internal' resolves to private 10.42.0.7 — internal egress blocked for this plugin (SSRF)"
            ),
            { egressBlocked: true as const }
          );
        }
      }
    };

    await expect(giteaAdapter.readFileAtRef(ctx, { path: "go.mod", ref: "main" })).rejects.toThrow(
      /refused by the plugin egress guard.*10\.42\.0\.7.*self-hosted gitea/s
    );
  });

  it("refuses a path-traversal BEFORE any HTTP happens", async () => {
    const { ctx } = setup();
    await expect(
      giteaAdapter.readFileAtRef(ctx, { path: "a/../../etc/passwd", ref: "main" })
    ).rejects.toThrow(/^gitea readFileAtRef: path .* contains a '\.'\/'\.\.' segment/);
  });

  // -----------------------------------------------------------------------------------------
  // ADVERSARIAL `ref` and `repo` (M21.2 review, BLOCKERS 1 and 2). `repo` was spliced into this
  // adapter's routes RAW — proven to build `.../repos/acme/widgets/../../../commits?sha=main` —
  // and `ref` was only `encodeURIComponent`d, which leaves `..` intact. Each test registers NO
  // interceptor, so with the assert removed the call escapes as a nock no-match; asserting the
  // MESSAGE (not merely that it threw) is what keeps these from passing for the wrong reason.
  // -----------------------------------------------------------------------------------------

  it("refuses a REPO traversal BEFORE any HTTP — the route, not just the repo, was being re-targeted", async () => {
    const { ctx } = setup();
    await expect(
      giteaAdapter.readFileAtRef(ctx, {
        repo: "acme/widgets/../../..",
        path: "go.mod",
        ref: "main"
      })
    ).rejects.toThrow(
      /^gitea readFileAtRef: repo 'acme\/widgets\/\.\.\/\.\.\/\.\.' contains a '\.'\/'\.\.' segment/
    );
  });

  it("refuses a REPO outside `owner/repo` or outside the provider's own segment charset", async () => {
    const { ctx } = setup();
    await expect(
      giteaAdapter.readFileAtRef(ctx, { repo: "acme/widgets?x=", path: "go.mod", ref: "main" })
    ).rejects.toThrow(/has a segment 'widgets\?x=' outside/);
    await expect(
      giteaAdapter.readFileAtRef(ctx, { repo: "acme/group/widgets", path: "go.mod", ref: "main" })
    ).rejects.toThrow(/exactly 2 '\/'-separated segments/);
  });

  it("refuses a REF traversal and the other git-forbidden ref shapes BEFORE any HTTP", async () => {
    const { ctx } = setup();
    await expect(
      giteaAdapter.readFileAtRef(ctx, { path: "go.mod", ref: "../../../../user" })
    ).rejects.toThrow(/^gitea readFileAtRef: ref '.*' contains '\.\.'/);
    for (const ref of ["main ", "ma?in", "main~1", "HEAD@{1}", "main."]) {
      await expect(giteaAdapter.readFileAtRef(ctx, { path: "go.mod", ref }), ref).rejects.toThrow(
        /^gitea readFileAtRef: ref /
      );
    }
  });

  it("NEVER fabricates `blobSha` — a contents response without `sha` comes back without one", async () => {
    // `ReadFileAtRefFound.blobSha` promises it is "never fabricated when it did not" carry one;
    // an `entry.sha ?? "unknown"` mutation survived this suite before this test existed.
    const { config, ctx, authHeader, base } = setup();
    const manifest = "module example.com/x\n";
    nockResolveRef(base, authHeader, config);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/contents/go.mod`)
      .query({ ref: REF_COMMIT_SHA })
      .reply(200, {
        path: "go.mod",
        // no `sha` at all
        type: "file",
        size: Buffer.byteLength(manifest, "utf8"),
        encoding: "base64",
        content: Buffer.from(manifest, "utf8").toString("base64")
      });

    const result = await giteaAdapter.readFileAtRef(ctx, { path: "go.mod", ref: "main" });
    expect(result).toMatchObject({ outcome: "found", content: manifest });
    expect((result as { blobSha?: string }).blobSha).toBeUndefined();
  });
});

/**
 * ============================================================================================
 * THIS ADAPTER WRITES NOTHING (owner decision 2026-08-15; ADR-0032 §9)
 * ============================================================================================
 * ADR-0032 §9 admits `GitProviderAdapter` as an escape hatch on two grounds — the `ExecutorPlugin`
 * object is unchanged, and "It also only READS." M21.5 briefly grew branch/commit/pull-request
 * hooks on all three providers, which contradicts the second ground. The repository-write authority
 * now lives inside the enumerated `scp-managed-dep` class (`packages/plugins/managed-dep`), where
 * the charter's containment preconditions bind.
 *
 * `@scp/git-provider-core`'s own suite pins the INTERFACE at the type level. This pins the OBJECT,
 * here, because the interface is structural: an adapter carrying extra write methods still
 * satisfies it, so the type-level pin alone would not notice a hook re-added to this file. Asserted
 * per provider rather than once, because the hooks existed on all three — the census is the point
 * (CLAUDE.md: fix the property, then find every place with it).
 */
describe("gitea adapter surface — read-only", () => {
  it("carries no repository-write hook, and still carries the read hook", () => {
    for (const hook of ["createBranch", "putFileOnBranch", "openPullRequest"]) {
      expect(hook in giteaAdapter, `${hook} must not be on the gitea adapter`).toBe(false);
    }
    expect(typeof giteaAdapter.readFileAtRef).toBe("function");
  });
});
