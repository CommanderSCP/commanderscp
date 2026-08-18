import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@scp/plugin-api";
import type { RunnerLauncher, RunnerSpec } from "@scp/runner-launcher";
import { createManagedScanExecutorPlugin } from "./index.js";

/**
 * M23.1 — THE STANDING GATE THAT THE PORT IS INSTALLED, not merely present.
 *
 * See `@scp/plugin-managed-iac`'s file of the same name for why this is separate from
 * `launch-argv.golden.test.ts`: the golden proves the Docker bytes are unchanged and would keep
 * passing if this plugin retained a private copy of the launch sequence with `@scp/runner-launcher`
 * dead beside it. The only check that distinguishes the two is to delete the wiring — here, by
 * injecting a launcher that throws — and require a named test to die.
 *
 * M23.1 PHASE 2 CHANGED WHAT "DIES" LOOKS LIKE. Before phase 2, `trigger()` had no outer catch, so
 * an injected launcher's throw escaped as a REJECTION and this test asserted that. It no longer
 * does — `trigger()` now resolves, and the failure is recorded via `withRecordedOutcome` instead —
 * so the first test below was rewritten rather than deleted, to the STRICTER shape managed-dep's own
 * seam test already used: a plugin that kept a private, second launch path would report `succeeded`,
 * and one that recorded a generic failure without the injected launcher's own message would fail the
 * `detail` match. Editing this in place (rather than deleting it) is itself the gate for phase 2's
 * fix — a bare deletion here would make phase 2's whole "every path records" property untestable in
 * this plugin the same way it is meant to prove installed.
 *
 * THIS PLUGIN IS THE ONE WHERE THE SEAM'S CONFIG SURFACE HAS TEETH. `dockerBinary` decides which
 * executable runs, and managed-scan shipped a live RCE because it sat on `KNOWN_EXECUTOR_MODULES`
 * with no manifest, so `validatePluginConfig` returned early and a tenant binding could set it. The
 * second test below pins that the resolver is handed exactly that one field and nothing else has
 * been invented alongside it — M23.1 adds NO new key to the server-injected class.
 */

// `reap` is stubbed on every fake below to satisfy the port — it is never called by a plugin
// directly, only by the Docker adapter's own `run()` (see `@scp/runner-launcher`'s
// `reaper.integration.test.ts`), so nothing here exercises it.
function throwingLauncher(): RunnerLauncher {
  return {
    run(): Promise<never> {
      throw new Error("managed-scan test: the injected RunnerLauncher was reached");
    },
    reap: async () => []
  };
}

function recordingLauncher(seen: RunnerSpec[]): RunnerLauncher {
  return {
    async run(spec) {
      seen.push(spec);
      return { succeeded: true, stdout: "recorded", stderr: "" };
    },
    reap: async () => []
  };
}

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "managed-scan-seam-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function ctx(overrides: Record<string, unknown> = {}): PluginContext {
  return {
    orgId: "org-1",
    scopeKey: "domain-1",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { get: async () => undefined },
    http: {
      request: async () => {
        throw new Error("managed-scan: never calls ctx.http");
      }
    },
    config: { runnerImage: "scp-runner-scan:vetted", networkMode: "none", ...overrides }
  };
}

describe("M23.1: managed-scan launches through the injected RunnerLauncher", () => {
  it("a launcher failure is RECORDED as failed, never left pending — the plugin has no second, private launch path", async () => {
    const plugin = createManagedScanExecutorPlugin(() => throwingLauncher());
    const c = ctx();
    const ref = await plugin.trigger(c, {
      kind: "custom",
      idempotencyKey: "seam-1",
      parameters: {
        method: "trivy",
        inputDir: join(scratch, "oci"),
        outputDir: join(scratch, "out")
      }
    });
    // trigger() RESOLVES (phase 2) — if the plugin still had a private, second launch path that
    // never touched the injected launcher, it would resolve too, but status() below would report
    // `succeeded`. Only reaching THIS injected launcher and RECORDING what it threw makes both
    // assertions pass together.
    const status = await plugin.status(c, ref);
    expect(status.phase).toBe("failed");
    expect(status.detail).toMatch(/the injected RunnerLauncher was reached/);
  });

  it("the resolver is handed the server-injected dockerBinary and NOTHING else", async () => {
    const seen: RunnerSpec[] = [];
    const resolverSaw: Record<string, unknown>[] = [];
    const plugin = createManagedScanExecutorPlugin((config) => {
      resolverSaw.push({ ...config });
      return recordingLauncher(seen);
    });

    const c = ctx({ dockerBinary: "/usr/local/bin/docker" });
    const ref = await plugin.trigger(c, {
      kind: "custom",
      idempotencyKey: "seam-2",
      parameters: {
        method: "trivy",
        inputDir: join(scratch, "oci"),
        outputDir: join(scratch, "out")
      }
    });

    // `toStrictEqual` on the WHOLE object, not a property check: the point is the ABSENCE of any
    // further adapter-selection key, because every key here joins the server-injected,
    // never-tenant-settable class and must be added to all three enforcement layers in the same
    // change. M23.2 is where that happens; M23.1 must not smuggle one in early.
    expect(resolverSaw).toStrictEqual([{ dockerBinary: "/usr/local/bin/docker" }]);
    expect(seen).toHaveLength(1);

    // THE WHOLE SPEC, `toStrictEqual`. See `@scp/plugin-managed-iac`'s file of the same name for the
    // measurement that forced it: with the three goldens deleted, three load-bearing fields could be
    // flipped at once and the whole repo stayed green. The goldens still own the Docker BYTES and
    // the four preload combinations; these six fields now also live in a file that carries no
    // deletion hazard in its header.
    expect(seen[0], "managed-scan's RunnerSpec changed").toStrictEqual({
      // Derived from the same key `externalId` is built from, so an orphaned container is traceable
      // to the run the commander is waiting on. Caller-supplied, never adapter-minted.
      runId: "seam-2",
      labels: { "scp.executor": "scp-managed-scan", "scp.run-id": "seam-2" },
      image: "scp-runner-scan:vetted",
      // trivy takes no extra run.sh args; only `openscap` appends the two positional ones (and
      // appends them EVEN WHEN EMPTY, which is the golden's business).
      operands: ["trivy"],
      // A CONFIG READ (server-injected, default "none") — this class's charter clause is qualified
      // ("excepting operator-allowlisted registry pulls"), so the operator setting is legitimate.
      networkMode: "none",
      // No preload dirs in this intent, so NEITHER `-e` pair fires. The two are INDEPENDENTLY
      // conditional; that independence is the golden's four-combination matrix. They stay in `env`
      // even when they DO fire: `SCP_SCAN_DB_DIR`/`SCP_SCAN_SCAP_DIR` are container PATHS, not
      // secrets, which is why this plugin's five golden `create` lines did not move when the
      // secrecy split landed.
      env: [],
      // NO CREDENTIAL AT ALL. A scan reads bytes the server already pulled; the runner holds
      // nothing, so no `--env-file` is ever written for this plugin.
      secretEnv: [],
      // The server-pulled OCI layout, always, and alone when no cache is preloaded.
      copyIn: [{ hostDir: join(scratch, "oci"), containerPath: "/work/image" }],
      // THE OPPOSITE OF managed-iac ON BOTH AXES, and fail-closed on purpose: a failed scan must
      // produce NO evidence (the commander writes none and E6 then refuses), and a failed copy-out
      // ESCAPES rather than being swallowed.
      copyOut: {
        containerPath: "/work/out",
        hostDir: join(scratch, "out"),
        when: "on-success",
        onFailure: "propagate"
      },
      // 10 minutes, and 32 MiB — the LARGEST of the three, because a Trivy report is the biggest
      // thing any of these runners writes to stdout.
      timeoutMs: 10 * 60_000,
      maxBuffer: 32 * 1024 * 1024
    });
    expect((await plugin.status(c, ref)).phase).toBe("succeeded");
  });
});
