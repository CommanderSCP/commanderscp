import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@scp/plugin-api";
import type { RunnerLauncher, RunnerSpec } from "@scp/runner-launcher";
import { createManagedIacExecutorPlugin } from "./index.js";

/**
 * M23.1 — THE STANDING GATE THAT THE PORT IS INSTALLED, not merely present.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE GOLDEN. `launch-argv.golden.test.ts` proves the Docker
 * BYTES are unchanged; it would go on passing if this plugin kept its own private copy of the
 * launch sequence and `@scp/runner-launcher` were dead code nobody called. The recurring failure
 * that costs the most here is a component that is built, wired nowhere, and covered by tests that
 * reach it directly (CLAUDE.md; six instances in one M21 session, one of them a live RCE on main).
 * The only check that catches it is to REMOVE the wiring and watch a named test die — so this file
 * removes it deliberately, by injecting a launcher that throws, and requires the failure to surface
 * through `trigger()`.
 *
 * A grep for `resolveLauncher(` would not do: a commented-out call still matches the raw text, and a
 * call inside dead code still matches the stripped text.
 *
 * M23.1 PHASE 2 CHANGED WHERE THE FAILURE LANDS. The paragraph that used to sit here said
 * managed-iac's `trigger()` had no outer catch, so a launcher failure REJECTED out of `trigger()`
 * and nothing was cached — `status()` then reported `pending`, not `failed`. That was true and is
 * now the defect phase 2 fixes: `trigger()` RESOLVES, the failure is recorded via
 * `@scp/runner-launcher`'s `withRecordedOutcome`, and `status()` reports `failed` with the injected
 * launcher's own message. The first test below was rewritten to that stricter shape — a plugin that
 * kept a second, private launch path would still resolve, but would report `succeeded` — rather than
 * deleted, because deleting it would take this file's whole reason for existing to zero along with
 * it. The second new test below (credential redaction) exists BECAUSE this plugin's failure path now
 * writes to a durable store: see its own comment for why an identity redactor here is not merely a
 * missed nicety.
 */

/** No Docker, no argv — the point is that this object is reached at all. */
function throwingLauncher(): RunnerLauncher {
  return {
    run(): Promise<never> {
      throw new Error("managed-iac test: the injected RunnerLauncher was reached");
    }
  };
}

function recordingLauncher(seen: RunnerSpec[]): RunnerLauncher {
  return {
    async run(spec) {
      seen.push(spec);
      return { succeeded: true, stdout: "recorded", stderr: "" };
    }
  };
}

let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "managed-iac-seam-"));
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

function ctx(
  overrides: Record<string, unknown> = {},
  secretGet?: (key: string) => Promise<string | undefined>
): PluginContext {
  return {
    orgId: "org-1",
    scopeKey: "domain-1",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { get: secretGet ?? (async () => undefined) },
    http: {
      request: async () => {
        throw new Error("managed-iac: never calls ctx.http");
      }
    },
    config: {
      runnerImage: "scp-runner-iac:vetted",
      workspaceRoot,
      networkMode: "none",
      statePath: join(workspaceRoot, "dedup.json"),
      ...overrides
    }
  };
}

describe("M23.1: managed-iac launches through the injected RunnerLauncher", () => {
  it("a launcher failure is RECORDED as failed, never left pending — the plugin has no second, private launch path", async () => {
    const plugin = createManagedIacExecutorPlugin(() => throwingLauncher());
    const c = ctx();
    const ref = await plugin.trigger(c, {
      kind: "sync",
      targetRef: "t1",
      parameters: { iacAction: "plan" },
      idempotencyKey: "seam-1"
    });
    // trigger() RESOLVES (phase 2) — a plugin with a private second launch path that never touched
    // the injected launcher would resolve too, but status() would then report "succeeded" instead.
    const status = await plugin.status(c, ref);
    expect(status.phase).toBe("failed");
    expect(status.detail).toMatch(/the injected RunnerLauncher was reached/);
  });

  it("a create failure's recorded detail carries NO credential value", async () => {
    // THE COUPLING PHASE 2 NAMED: this plugin's failure path now writes `detail` to a durable JSON
    // file (`saveState`), and `reconcile.ts` copies it from there into a persisted `Decision`'s
    // `inputContext`. A raw `docker create` rejection's real message is
    // `Command failed: docker create … -e AWS_SECRET_ACCESS_KEY=<value> …` — this test does not go
    // through the real Docker adapter (whose own `RunnerLaunchError` already redacts what IT knows
    // to redact); it injects a launcher that throws that shape DIRECTLY, so the assertion is on
    // `trigger()`'s OWN redaction, independent of whatever the adapter would have already done.
    // Replacing that redactor with the identity function is exactly the mutation this test exists to
    // catch — see @scp/runner-launcher's `withRecordedOutcome` doc for why `redact` is a required,
    // load-bearing parameter rather than decoration.
    const SEEDED_SECRET = "zzz9-do-not-leak-zzz9";
    const leaking: RunnerLauncher = {
      run(): Promise<never> {
        throw new Error(
          `Command failed: docker create --network none -e AWS_SECRET_ACCESS_KEY=${SEEDED_SECRET} scp-runner-iac:vetted plan`
        );
      }
    };
    const plugin = createManagedIacExecutorPlugin(() => leaking);
    const c = ctx({ infraCredsSecretKeys: { AWS_SECRET_ACCESS_KEY: "aws-secret" } }, async (key) =>
      key === "aws-secret" ? SEEDED_SECRET : undefined
    );
    const ref = await plugin.trigger(c, {
      kind: "sync",
      targetRef: "t1",
      parameters: { iacAction: "plan" },
      idempotencyKey: "seam-3"
    });

    const status = await plugin.status(c, ref);
    expect(status.phase).toBe("failed");
    expect(status.detail).not.toContain(SEEDED_SECRET);
    // The failure is still legible — redaction removed the VALUE, not the fact that it failed.
    expect(status.detail).toContain("docker create");
  });

  it("the resolver receives the server-injected dockerBinary, and the run reaches the port once", async () => {
    const seen: RunnerSpec[] = [];
    const resolverSaw: (string | undefined)[] = [];
    const plugin = createManagedIacExecutorPlugin((config) => {
      resolverSaw.push(config.dockerBinary);
      return recordingLauncher(seen);
    });

    const c = ctx();
    (c.config as Record<string, unknown>).dockerBinary = "/usr/local/bin/docker";
    const ref = await plugin.trigger(c, {
      kind: "sync",
      targetRef: "t1",
      parameters: { iacAction: "apply" },
      idempotencyKey: "seam-2"
    });

    expect(resolverSaw).toStrictEqual(["/usr/local/bin/docker"]);
    expect(seen).toHaveLength(1);

    // THE WHOLE SPEC, `toStrictEqual`, AND THAT IS THE POINT OF THIS ASSERTION.
    //
    // This test used to capture the entire `RunnerSpec` and then assert only `image` and
    // `operands`, with a comment declining the rest as "the golden's job". It was measured and it
    // was not true: `git rm` the three `launch-argv.golden.test.ts` files AND flip three
    // load-bearing fields in `runRunnerContainer` at once — `when: "always"` -> `"on-success"`,
    // `onFailure: "swallow"` -> `"propagate"`, `maxBuffer: 16 MiB` -> `32 MiB` — and the repo ran
    // "Tasks: 14 successful, 14 total". A file that carries a deletion hazard in its header cannot
    // be the only thing asserting a field; this file carries no such instruction and is named for
    // the wiring it guards, so the fields live here TOO. The goldens are not redundant — they pin
    // the Docker BYTES for four managed-scan preload combinations and the rollback arm, which
    // nothing here reaches — but no single deletion can now take these six fields to zero.
    //
    // EVERY FIELD IS A LITERAL, not re-derived from `index.ts`. The workspace path is the one
    // deterministic thing about this run and is spelled out rather than read back from the spec:
    // `workspaceDirFor` sanitises orgId and targetRef into `<workspaceRoot>/<org>/<target>`, and a
    // change to that layout must fail here.
    const workspaceDir = join(workspaceRoot, "org-1", "t1");
    expect(seen[0], "managed-iac's RunnerSpec changed").toStrictEqual({
      // THE RUN'S OWN IDENTITY, DERIVED FROM THE IDEMPOTENCY KEY — caller-supplied, never
      // adapter-minted, so a retry addresses the same container name and M23.3's Kubernetes arm can
      // put the same string in `metadata.name`. `toRunnerRunId("seam-2")` is a lossless slug, hence
      // the bare key; a key needing sanitisation gets a digest appended instead of colliding.
      runId: "seam-2",
      labels: { "scp.executor": "scp-managed-iac", "scp.run-id": "seam-2" },
      image: "scp-runner-iac:vetted",
      operands: ["apply"],
      // A CONFIG READ for this plugin (server-injected, default "none") — unlike managed-dep, whose
      // charter clause carries no operator qualifier and passes a literal.
      networkMode: "none",
      // No rollback extras in this intent, so nothing non-secret to pass.
      env: [],
      // No `infraCredsSecretKeys` in this ctx, so no credentials are materialised. When they ARE,
      // they go HERE and not into `env` — the Docker adapter delivers `secretEnv` through a
      // mode-0600 `--env-file` instead of `-e`, and the Kubernetes adapter must deliver it as a
      // per-run Secret. The golden owns the populated case and the env-file's contents.
      secretEnv: [],
      // The plugin's OWN state dir — `dirname(statePath)` — never the workspace (which is copied
      // INTO the container) and never `os.tmpdir()` (which is shared with every other local user).
      secretEnvDir: workspaceRoot,
      // COPIED, never bind-mounted: nothing on the host becomes a container mount.
      copyIn: [{ hostDir: workspaceDir, containerPath: "/workspace" }],
      // THE ASYMMETRY THAT IS THIS PLUGIN'S ALONE, on both axes. A failed `apply` may still have
      // produced a partial plan.json worth persisting (`when: "always"`), and a copy-out that
      // itself fails does NOT fail the run (`onFailure: "swallow"`). managed-scan and managed-dep
      // are the opposite on both. This is the pair a "unify the three launchers" refactor
      // normalises away by accident.
      copyOut: {
        containerPath: "/workspace",
        hostDir: workspaceDir,
        when: "always",
        onFailure: "swallow"
      },
      // 10 minutes (the default; tenant-settable via config.timeoutMs) and 16 MiB — the SMALLEST
      // stdout budget of the three, and not a shared default.
      timeoutMs: 10 * 60_000,
      maxBuffer: 16 * 1024 * 1024
    });
    expect((await plugin.status(c, ref)).phase).toBe("succeeded");
  });
});
