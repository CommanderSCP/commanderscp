import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubprocessPluginHost } from "./host.js";

// Wraps the REAL `child_process.spawn` (calls through — this must still spawn genuine children,
// not a stub) so the env-leak test below can inspect exactly what `host.ts` passed it. `vi.mock`
// factories are hoisted above imports by Vitest, and ESM named exports can't be `vi.spyOn`'d
// directly ("Module namespace is not configurable") — re-exporting a `vi.fn(actual.spawn)` wrapper
// is the supported pattern.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

/**
 * Unit-layer tests for the subprocess plugin host's PROCESS boundary (no Postgres — these spawn
 * real child `node` processes but never touch the DB, so they belong under `pnpm test`, not the
 * Testcontainers integration suite). Two PR #7 adversarial-review findings against `host.ts`:
 *
 *  - CRITICAL #3: the child inherited the full parent `process.env` (admin `DATABASE_URL`,
 *    cookie/OIDC secrets) — a plugin could connect to Postgres as the admin/superuser role and
 *    bypass RLS entirely.
 *  - CRITICAL #4: the readline framing of the child's stdout had no line-length cap, so a plugin
 *    that streams bytes without ever emitting `\n` grows the PARENT process's memory unboundedly.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RUNAWAY_STDOUT_FIXTURE = path.resolve(__dirname, "test-support/runaway-stdout-entry.ts");

let host: SubprocessPluginHost | undefined;

afterEach(async () => {
  await host?.stop();
  host = undefined;
  vi.restoreAllMocks();
});

describe("SubprocessPluginHost: child environment (CRITICAL #3)", () => {
  it("never inherits process.env — the spawned child's env has none of the parent's secrets/DATABASE_URL", async () => {
    const childProcess = await import("node:child_process");
    const spawnSpy = vi.mocked(childProcess.spawn);
    spawnSpy.mockClear();

    const sentinelSecrets = {
      DATABASE_URL: "postgres://admin:supersecret@localhost:5432/scp",
      SCP_RUNTIME_DATABASE_URL: "postgres://scp_app:secret@localhost:5432/scp",
      SCP_COOKIE_SECRET: "cookie-secret-value",
      SCP_OIDC_CLIENT_SECRET: "oidc-client-secret-value",
      SUPER_SECRET_TOKEN: "should-never-leak"
    };
    for (const [key, value] of Object.entries(sentinelSecrets)) {
      vi.stubEnv(key, value);
    }

    host = new SubprocessPluginHost({ callTimeoutMs: 10_000 });
    await host.start([
      { id: "env-probe", module: "fake-executor", orgId: "org-1", domainId: "domain-1" }
    ]);

    expect(spawnSpy).toHaveBeenCalled();
    const spawnCall = spawnSpy.mock.calls[0]!;
    const spawnOptions = spawnCall[2] as { env?: NodeJS.ProcessEnv } | undefined;
    const childEnv = spawnOptions?.env;
    expect(childEnv).toBeDefined();

    for (const key of Object.keys(sentinelSecrets)) {
      expect(childEnv).not.toHaveProperty(key);
    }
    // None of the VALUES leaked under some other key either.
    const serializedEnv = JSON.stringify(childEnv);
    for (const value of Object.values(sentinelSecrets)) {
      expect(serializedEnv).not.toContain(value);
    }

    // The plugin config surface the child DOES need is still present — this isn't a "blank env
    // breaks everything" false victory.
    expect(childEnv).toMatchObject({
      SCP_PLUGIN_MODULE: "fake-executor",
      SCP_PLUGIN_INSTANCE_ID: "env-probe",
      SCP_PLUGIN_ORG_ID: "org-1",
      SCP_PLUGIN_DOMAIN_ID: "domain-1"
    });

    // The instance is genuinely alive and answering RPCs (not just "spawn was called with a
    // stripped env and then the child died") — proves stripping env didn't break the child.
    const caps = await host.executor("env-probe").describeCapabilities();
    expect(caps.supportsTrigger).toBe(true);
  });
});

describe("SubprocessPluginHost: ControlPlugin instances (M4)", () => {
  it("loads a 'webhook-control' module and answers evaluate() over the real subprocess boundary", async () => {
    host = new SubprocessPluginHost({ callTimeoutMs: 10_000 });
    await host.start([
      {
        id: "control-probe",
        module: "webhook-control",
        orgId: "org-1",
        domainId: "domain-1",
        // No 'url' configured — the plugin fails closed rather than throwing (index.test.ts covers
        // the full HTTP-mapping matrix in-process); this test's job is only to prove the SUBPROCESS
        // boundary (spawn, module resolution, JSON-RPC round trip) works end to end for a
        // ControlPlugin instance, mirroring the executor env-probe test above.
        config: {}
      }
    ]);

    const outcome = await host.control("control-probe").evaluate({
      changeId: "change-1",
      controlId: "control-1",
      context: {}
    });
    expect(outcome.status).toBe("fail");
    expect(outcome.evidence).toBeDefined();
  });
});

describe("SubprocessPluginHost: unbounded stdout line guard (CRITICAL #4)", () => {
  it("kills (and restarts-with-backoff) a child that streams bytes on stdout without ever sending a newline, instead of buffering it forever", async () => {
    const stderrChunks: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
        return true;
      });

    host = new SubprocessPluginHost({
      callTimeoutMs: 5_000,
      restartBackoffBaseMs: 20,
      maxRestartBackoffMs: 100,
      maxLineBytes: 128 * 1024, // 128KB — small so the fixture (64KB writes) trips it fast
      subprocessEntryPath: RUNAWAY_STDOUT_FIXTURE
    });

    await host.start([
      { id: "flood", module: "fake-executor", orgId: "org-1", domainId: "domain-1" }
    ]);

    const baselineRss = process.memoryUsage().rss;

    // The fixture floods stdout with 64KB, newline-free writes forever, as fast as it can. If the
    // guard is broken (mutated away), readline just keeps concatenating those chunks into one
    // ever-growing in-memory line and this line-guard message never appears — the host would
    // instead eventually time out or OOM. With the guard in place, it should trip (and the child
    // get killed + respawned, which floods again and trips again) multiple times within a few
    // seconds.
    await vi.waitFor(
      () => {
        const trips = stderrChunks.filter((c) => c.includes("exceeded max line size")).length;
        expect(trips).toBeGreaterThanOrEqual(2);
      },
      { timeout: 10_000, interval: 100 }
    );

    // The PARENT (this test process) never had to buffer more than a small, bounded multiple of
    // maxLineBytes — nowhere near the many megabytes the fixture would have streamed unbounded in
    // this window if the guard didn't exist. Generous bound: flaky-proof, but would still catch a
    // real regression back to unbounded buffering.
    const rssGrowthMb = (process.memoryUsage().rss - baselineRss) / (1024 * 1024);
    expect(rssGrowthMb).toBeLessThan(300);

    stderrSpy.mockRestore();
  }, 15_000);
});
