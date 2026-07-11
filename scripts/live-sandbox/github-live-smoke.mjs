#!/usr/bin/env node
/**
 * Opt-in nightly live-sandbox smoke test (BUILD_AND_TEST.md §8 M7 DoD) — drives the REAL
 * `@scp/plugin-github` `ExecutorPlugin` against a REAL GitHub App installation and a REAL test
 * repository, end to end: `trigger()` a `workflow_dispatch`, then poll `status()` until the
 * dispatched run reaches a terminal phase. Never runs in the gating CI pipeline
 * (.github/workflows/nightly-live-sandbox.yml gates this behind a secret-presence check and
 * schedule/workflow_dispatch only) — this is the ONE place in the whole test suite that is
 * DELIBERATELY allowed to touch the real network, because proving GitHub's actual wire format
 * against a live server is exactly what this script exists for (every other test in this repo
 * fixtures GitHub with nock — see packages/plugins/github/src/index.test.ts).
 *
 * HONESTLY UNVERIFIED: this script has never been run against a real GitHub App/repo — no live
 * credentials were available in the environment this milestone was built in. It is written
 * directly against `@scp/plugin-github`'s actual, tested (via nock) `ExecutorPlugin` contract, so
 * it SHOULD work as-is once `M7_LIVE_GITHUB_*` secrets are configured, but "should work" is not
 * "has been proven to work" — flagged explicitly in the M7 PR body's deterministic-vs-live-sandbox
 * breakdown.
 *
 * Env vars (all required, checked by the workflow's check-secrets job before this ever runs):
 *   GH_APP_PRIVATE_KEY      — PEM-encoded RSA private key for the GitHub App
 *   GH_APP_ID               — the GitHub App's numeric id
 *   GH_APP_INSTALLATION_ID  — the installation id on the target org/repo
 *   GH_TEST_REPO            — "owner/repo" of a real, disposable test repository
 *   GH_TEST_WORKFLOW_ID     — workflow file name (e.g. "smoke.yml") to dispatch; must exist on
 *                             the test repo's default branch and accept workflow_dispatch with no
 *                             required inputs
 */
// Relative dist import (not the bare "@scp/plugin-github" specifier) — this script has no
// package.json of its own to declare that workspace dependency in, so bare-specifier resolution
// would fail regardless of cwd; `pnpm build` (run by the workflow before this step) is what makes
// this path exist.
import { setTimeout as sleep } from "node:timers/promises";
import { createGithubExecutorPlugin } from "../../packages/plugins/github/dist/index.js";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`github-live-smoke: required env var ${name} is not set`);
    process.exit(1);
  }
  return value;
}

async function main() {
  const [owner, repo] = requireEnv("GH_TEST_REPO").split("/");
  if (!owner || !repo) {
    console.error(
      `github-live-smoke: GH_TEST_REPO must be "owner/repo", got "${process.env.GH_TEST_REPO}"`
    );
    process.exit(1);
  }

  const plugin = createGithubExecutorPlugin();
  const ctx = {
    orgId: "live-sandbox",
    domainId: "live-sandbox",
    logger: {
      debug: (msg, meta) => console.debug(`[github-live-smoke] ${msg}`, meta ?? ""),
      info: (msg, meta) => console.log(`[github-live-smoke] ${msg}`, meta ?? ""),
      warn: (msg, meta) => console.warn(`[github-live-smoke] ${msg}`, meta ?? ""),
      error: (msg, meta) => console.error(`[github-live-smoke] ${msg}`, meta ?? "")
    },
    secrets: {
      async get(key) {
        if (key === "github-app-private-key") return requireEnv("GH_APP_PRIVATE_KEY");
        return undefined;
      }
    },
    http: {
      async request({ method, url, headers, body }) {
        const response = await fetch(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body)
        });
        const text = await response.text();
        let parsed = text;
        try {
          parsed = text ? JSON.parse(text) : undefined;
        } catch {
          // non-JSON response — return raw text, matching production's unscopedFetchHttpClient
        }
        const responseHeaders = {};
        response.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });
        return { status: response.status, headers: responseHeaders, body: parsed };
      }
    },
    config: {
      appId: requireEnv("GH_APP_ID"),
      installationId: requireEnv("GH_APP_INSTALLATION_ID"),
      owner,
      repo,
      privateKeySecretKey: "github-app-private-key",
      defaultWorkflowId: requireEnv("GH_TEST_WORKFLOW_ID")
    }
  };

  console.log(
    `github-live-smoke: dispatching workflow '${ctx.config.defaultWorkflowId}' on ${owner}/${repo}`
  );
  const idempotencyKey = `live-sandbox-${Date.now()}`;
  const ref = await plugin.trigger(ctx, { kind: "workflow_dispatch", idempotencyKey });
  console.log(`github-live-smoke: trigger() returned`, ref);

  // Idempotency proof against a REAL server: retrigger with the SAME key and assert the SAME ref.
  const retriggerRef = await plugin.trigger(ctx, { kind: "workflow_dispatch", idempotencyKey });
  if (retriggerRef.externalId !== ref.externalId) {
    console.error(
      `github-live-smoke: FAIL — idempotency violated: first trigger() -> ${ref.externalId}, retry with the same idempotencyKey -> ${retriggerRef.externalId}`
    );
    process.exit(1);
  }
  console.log(
    "github-live-smoke: PASS — idempotencyKey retry returned the identical ExternalRunRef"
  );

  const deadline = Date.now() + 5 * 60_000; // 5 minutes — generous for a trivial smoke workflow
  let lastStatus;
  while (Date.now() < deadline) {
    lastStatus = await plugin.status(ctx, ref);
    console.log(
      `github-live-smoke: status = ${lastStatus.phase} (${lastStatus.detail ?? "no detail"})`
    );
    if (
      lastStatus.phase === "succeeded" ||
      lastStatus.phase === "failed" ||
      lastStatus.phase === "aborted"
    ) {
      break;
    }
    await sleep(5_000);
  }

  if (!lastStatus || lastStatus.phase !== "succeeded") {
    console.error(
      `github-live-smoke: FAIL — workflow did not succeed within the deadline (last phase: ${lastStatus?.phase ?? "none"})`
    );
    process.exit(1);
  }
  console.log("github-live-smoke: PASS — dispatched workflow reached 'succeeded'");
}

main().catch((err) => {
  console.error("github-live-smoke: fatal error", err);
  process.exit(1);
});
