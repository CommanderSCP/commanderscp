import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { observeNodeSpawns } from "@scp/source-census";
import type { PluginContext } from "@scp/plugin-api";
import type { KubernetesRunnerIo } from "@scp/runner-launcher";
import { createManagedIacExecutorPlugin } from "./index.js";
import {
  K8S_SA_DIR,
  clearRunnerSpawns,
  kubernetesConstructionCount,
  runnerSpawnCount,
  runnerSpawns,
  whenKubernetesReapSettled,
  whenReapSettled
} from "@scp/runner-launcher";

/**
 * M23.2 — THE STANDING GATE THAT ADAPTER SELECTION IS *INSTALLED*, NOT MERELY BUILT.
 *
 * `launcher-seam.test.ts` proves this plugin launches through the injected `RunnerLauncher`, and
 * every one of its cases injects a resolver. That is precisely why it CANNOT prove this: production
 * injects nothing. `apps/server/src/plugin-host/subprocess-entry.ts` constructs this plugin as
 * `createManagedIacExecutorPlugin()` — no argument — so the DEFAULT PARAMETER is the whole of the
 * production wiring, and a test that always passes its own resolver never touches it.
 *
 * That is this repository's dominant defect class, named in CLAUDE.md: a component built, tested
 * through a seam that bypasses the wiring, and installed nowhere. It has happened six times in one
 * session, including a live RCE on main. The only check that works is to delete the wiring and watch
 * a NAMED test die — so this file constructs the plugin with NO ARGUMENT and requires the Kubernetes
 * adapter to be reached. Revert the default parameter to `resolveDockerRunnerLauncher` and this dies;
 * nothing else in the repository does.
 */

/** The Kubernetes launcher's injected seam, recording what the adapter tried to send and then
 *  refusing. Reaching it AT ALL is the assertion — the Docker adapter cannot touch this object. */
function recordingIo(seen: string[]): KubernetesRunnerIo {
  return {
    request: async (req) => {
      seen.push(`${req.method} ${req.path.split("?")[0]}`);
      throw new Error("m23.2-selection: the Kubernetes io was reached");
    },
    copyDir: async () => undefined,
    removeDir: async () => undefined
  };
}

const KUBERNETES_SETTINGS = {
  runnerLauncher: "kubernetes" as const,
  kubernetes: {
    namespace: "scp",
    workspaceRoot: "/scp-workspace",
    workspaceVolume: { kind: "persistentVolumeClaim", claimName: "scp-runner-workspace" } as const
  }
};

let workspaceRoot: string;
beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "managed-iac-select-"));
});
afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

function ctx(overrides: Record<string, unknown>): PluginContext {
  return {
    orgId: "org-1",
    scopeKey: "domain-1",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { get: async () => undefined },
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

describe("M23.2: managed-iac, constructed the way production constructs it, honours the selection", () => {
  it("`runnerLauncher: 'kubernetes'` REACHES THE KUBERNETES ADAPTER through the ZERO-ARGUMENT factory", async () => {
    const seen: string[] = [];
    const plugin = createManagedIacExecutorPlugin();
    const c = ctx({
      ...KUBERNETES_SETTINGS,
      kubernetes: { ...KUBERNETES_SETTINGS.kubernetes, io: recordingIo(seen) }
    });
    const ref = await plugin.trigger(c, {
      kind: "sync",
      targetRef: "t1",
      parameters: { iacAction: "plan" },
      idempotencyKey: "select-1"
    });
    expect(
      seen,
      "the Kubernetes adapter was never reached — the plugin still defaults to Docker"
    ).toContain("POST /apis/batch/v1/namespaces/scp/jobs");
    expect((await plugin.status(c, ref)).phase).toBe("failed");
  });

  it("WITH THE SELECTION ABSENT the Kubernetes io is NEVER touched — the default is unchanged", async () => {
    const seen: string[] = [];
    const plugin = createManagedIacExecutorPlugin();
    // The io is present in config but the selection is not. A resolver that reached for Kubernetes
    // whenever settings happened to be injected would be the auto-detection M15.4 declined to
    // create, one level down.
    const c = ctx({ kubernetes: { ...KUBERNETES_SETTINGS.kubernetes, io: recordingIo(seen) } });
    await plugin
      .trigger(c, {
        kind: "sync",
        targetRef: "t2",
        parameters: { iacAction: "plan" },
        idempotencyKey: "select-2"
      })
      .catch(() => undefined);
    expect(seen).toStrictEqual([]);
  });

  /**
   * ================================================================================================
   * M23.6 CLAUSE 1 — NO PROCESS IS SPAWNED ON THE KUBERNETES PATH
   * ================================================================================================
   * The clause asks for the recorded SPAWN, not a mock's call count, "so a renamed binary cannot
   * pass it". `runnerSpawns()` records the binary as it was handed to `execFile` and nothing else in
   * the package can start a process — `no-docker-on-kubernetes.test.ts` censuses that. Measured
   * before the ledger existed: a real `execFile(dockerBinary, ["version", …])` in
   * `resolveRunnerLauncher`'s KUBERNETES branch left the whole workspace green.
   */
  it("ON THE KUBERNETES PATH NOTHING IS SPAWNED — no container CLI, under any name", async () => {
    await whenReapSettled();
    clearRunnerSpawns();
    const before = runnerSpawnCount();
    const seen: string[] = [];
    const plugin = createManagedIacExecutorPlugin();
    const c = ctx({
      ...KUBERNETES_SETTINGS,
      kubernetes: { ...KUBERNETES_SETTINGS.kubernetes, io: recordingIo(seen) }
    });
    await plugin
      .trigger(c, {
        kind: "sync",
        targetRef: "t3",
        parameters: { iacAction: "plan" },
        idempotencyKey: "select-3"
      })
      .catch(() => undefined);
    await whenKubernetesReapSettled("scp");
    // NON-VACUITY FIRST: a run that never happened spawns nothing either.
    expect(
      seen,
      "the run never reached the Kubernetes adapter, so 'nothing was spawned' is empty"
    ).toContain("POST /apis/batch/v1/namespaces/scp/jobs");
    expect(runnerSpawns(), "a process was spawned on the Kubernetes path").toStrictEqual([]);
    expect(runnerSpawnCount()).toBe(before);
  });

  it("AND THE DOCKER PATH DOES SPAWN ONE — the control that makes the assertion above mean anything", async () => {
    // Machine-independent: the ledger records the intent to spawn, so this holds whether or not a
    // container CLI is installed and whether or not the image exists.
    await whenReapSettled();
    clearRunnerSpawns();
    const plugin = createManagedIacExecutorPlugin();
    await plugin
      .trigger(ctx({}), {
        kind: "sync",
        targetRef: "t4",
        parameters: { iacAction: "plan" },
        idempotencyKey: "select-4"
      })
      .catch(() => undefined);
    await whenReapSettled();
    expect(
      runnerSpawns().length,
      "the Docker path spawned nothing, so the negative arm proves nothing"
    ).toBeGreaterThan(0);
    expect(new Set(runnerSpawns().map((s) => s.file))).toStrictEqual(new Set(["docker"]));
  });

  /**
   * ================================================================================================
   * M23.6 CLAUSE 7 — NEVER *CONSTRUCTED*, WHICH IS STRONGER THAN NEVER CALLED
   * ================================================================================================
   * The `io is NEVER touched` case above is a statement about CALLS. Measured: making the Docker
   * branch of `resolveRunnerLauncher` build `createFetchKubernetesIo(...)` AND
   * `createKubernetesRunnerLauncher(...)`, discard both and return the Docker launcher left
   * `pnpm -w test` green (72/72). This arm is what that mutation now fails.
   */
  it("WITH THE DOCKER LAUNCHER SELECTED NO KUBERNETES CLIENT IS CONSTRUCTED — an air-gapped VM gains no dependency", async () => {
    const seen: string[] = [];
    const before = kubernetesConstructionCount();
    const plugin = createManagedIacExecutorPlugin();
    const c = ctx({ kubernetes: { ...KUBERNETES_SETTINGS.kubernetes, io: recordingIo(seen) } });
    await plugin
      .trigger(c, {
        kind: "sync",
        targetRef: "t5",
        parameters: { iacAction: "plan" },
        idempotencyKey: "select-5"
      })
      .catch(() => undefined);
    expect(
      kubernetesConstructionCount() - before,
      "the Docker path built a Kubernetes launcher or API client and threw it away"
    ).toBe(0);
    expect(seen).toStrictEqual([]);
  });

  it("…and the construction counter MOVES when the Kubernetes launcher IS selected", async () => {
    // The control for the arm above: a counter that never moved would satisfy it forever.
    const seen: string[] = [];
    const before = kubernetesConstructionCount();
    const plugin = createManagedIacExecutorPlugin();
    const c = ctx({
      ...KUBERNETES_SETTINGS,
      kubernetes: { ...KUBERNETES_SETTINGS.kubernetes, io: recordingIo(seen) }
    });
    await plugin
      .trigger(c, {
        kind: "sync",
        targetRef: "t6",
        parameters: { iacAction: "plan" },
        idempotencyKey: "select-6"
      })
      .catch(() => undefined);
    expect(kubernetesConstructionCount()).toBeGreaterThan(before);
  });
});

/**
 * ==================================================================================================
 * M23.6 CLAUSE 1, BEHAVIOURALLY — THE SPAWN IS OBSERVED FROM OUTSIDE THIS PROCESS
 * ==================================================================================================
 *
 * WHY THE LEDGER ARM ABOVE IS NOT ENOUGH, MEASURED. `runnerSpawns()` records what goes THROUGH
 * `spawnRunnerProcess`. A real `child_process.execFile(dockerBinary, …)` on the Kubernetes path goes
 * nowhere near it: planted in `resolveRunnerLauncher`'s Kubernetes branch it left this file, its two
 * siblings and the whole workspace GREEN while fourteen processes were actually created. What caught
 * it was a source census — and a census proves the presence of TEXT, never the absence of an
 * EXECUTION, which is this repository's most expensive standing confusion.
 *
 * SO THIS CASE RUNS THE PLUGIN IN A CHILD `node` whose `node:child_process` was wrapped before the
 * plugin loaded, and asserts over the processes that were actually created. It carries its OWN
 * control in the same child, in order: the Kubernetes trigger first (nothing may be created), then a
 * Docker trigger (something must be), so an observer that had silently stopped observing fails the
 * second half rather than passing the first.
 */
describe("M23.6 clause 1, behaviourally: managed-iac creates no process on the Kubernetes path", () => {
  it("OBSERVED FROM OUTSIDE: the Kubernetes trigger spawns NOTHING and the Docker trigger spawns", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "managed-iac-observed-"));
    try {
      // BOTH SUBJECTS AS BUILT `dist`, RESOLVED THE WAY NODE WOULD. The driver runs from a temp
      // directory, so a bare specifier there would resolve against nothing; `createRequire` rooted at
      // this package's own `package.json` is the same lookup the plugin host performs.
      const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
      const pluginEntry = join(packageRoot, "dist/index.js");
      const driver = `
import { readFileSync } from "node:fs";
const OUT = process.env.SCP_SPAWN_OBSERVER_OUT;
const spawnsSoFar = () =>
  readFileSync(OUT, "utf8").split("\\n").filter((l) => l.trim().length > 0).length;

const { createRequire } = await import("node:module");
const req = createRequire(${JSON.stringify(join(packageRoot, "package.json"))});
const rl = await import(req.resolve("@scp/runner-launcher"));
const plugin = (await import(${JSON.stringify(pluginEntry)})).createManagedIacExecutorPlugin();

const seen = [];
const io = {
  request: async (req) => {
    seen.push(req.method + " " + req.path.split("?")[0]);
    throw new Error("observed-probe: the Kubernetes io was reached");
  },
  copyDir: async () => undefined,
  removeDir: async () => undefined
};
const base = {
  orgId: "org-1",
  scopeKey: "domain-1",
  logger: { debug() {}, info() {}, warn() {}, error() {} },
  secrets: { get: async () => undefined },
  http: { request: async () => { throw new Error("managed-iac: never calls ctx.http"); } }
};
const config = {
  runnerImage: "scp-runner-iac:vetted",
  workspaceRoot: ${JSON.stringify(workspace)},
  networkMode: "none",
  statePath: ${JSON.stringify(join(workspace, "dedup.json"))},
  // A BINARY THAT CANNOT EXIST, so the Docker control below is hermetic and fast: the ledger and the
  // observer both record the INTENT to spawn, whether or not a container runtime is installed.
  dockerBinary: "scp-no-such-container-cli"
};

await plugin
  .trigger(
    { ...base, config: { ...config, runnerLauncher: "kubernetes", kubernetes: {
      namespace: "scp",
      workspaceRoot: ${JSON.stringify(workspace)},
      workspaceVolume: { kind: "persistentVolumeClaim", claimName: "scp-runner-workspace" },
      io
    } } },
    { kind: "sync", targetRef: "t1", parameters: { iacAction: "plan" }, idempotencyKey: "observed-k8s" }
  )
  .catch(() => undefined);
await rl.whenKubernetesReapSettled("scp");
const afterKubernetes = spawnsSoFar();

await plugin
  .trigger(
    { ...base, config },
    { kind: "sync", targetRef: "t2", parameters: { iacAction: "plan" }, idempotencyKey: "observed-docker" }
  )
  .catch(() => undefined);
await rl.whenReapSettled();
console.log(JSON.stringify({ seen, afterKubernetes, afterDocker: spawnsSoFar() }));
`;
      const run = await observeNodeSpawns({ module: driver, timeoutMs: 120_000 });
      expect(run.ok, `the probe did not complete:\n${run.stderr}`).toBe(true);
      const report = JSON.parse(run.stdout.trim().split("\n").pop()!) as {
        seen: string[];
        afterKubernetes: number;
        afterDocker: number;
      };
      // NON-VACUITY: the Kubernetes adapter was genuinely reached through the zero-argument factory.
      expect(
        report.seen,
        "the probe never reached the Kubernetes adapter, so 'nothing was created' is empty"
      ).toContain("POST /apis/batch/v1/namespaces/scp/jobs");
      expect(
        report.afterKubernetes,
        `managed-iac created a process on the Kubernetes path: ${JSON.stringify(run.spawns)}`
      ).toBe(0);
      // THE CONTROL, IN THE SAME CHILD: the Docker path must be seen creating one, by name.
      expect(
        report.afterDocker,
        "the Docker trigger created no process either, so the observer proves nothing"
      ).toBeGreaterThan(0);
      expect(run.binaries).toStrictEqual(["scp-no-such-container-cli"]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 180_000);
});

/**
 * ==================================================================================================
 * M23.6 CLAUSE 1, THE HOLE EVERY CASE ABOVE LEFT: the `io` THIS SUITE ALWAYS INJECTS
 * ==================================================================================================
 *
 * Every case above hands the plugin a `kubernetes.io`. `resolveRunnerLauncher` reads it as
 * `k8s.io ?? createDefaultKubernetesIo(…)`, and the right-hand side of a `??` is not evaluated when
 * the left is present — so the transport the resolver builds FOR ITSELF, which is the only one
 * production ever gets, was evaluated by no test in this repository.
 *
 * MEASURED, NOT SUSPECTED. A `spawnSync(config.dockerBinary ?? "docker", ["version"])` planted on
 * that right-hand side, in a NEW module so that no `node:child_process` string appears in
 * `kubernetes-adapter.ts` for the source census to find, executed a REAL `docker version` while
 * `@scp/runner-launcher` reported 427/427 and the three managed plugins reported 38 + 50 + 255 —
 * every suite green, including the observed case above. A marker file proved the probe was reached
 * rather than merely present.
 *
 * So this case injects NOTHING: no `io`, and NO `dockerBinary` either. The Kubernetes adapter is not
 * given a container binary in production and must not need one, so with the field absent the only
 * name a probe can reach for is `DEFAULT_DOCKER_BINARY` — and the assertion is simply that this
 * child created no process at all, with no binary name guessed in advance.
 *
 * TWO THINGS MAKE THE EMPTY LIST MEAN SOMETHING, because a green negative arm was already worthless
 * once: `kubernetesConstructionCount()` must move by TWO (the launcher AND the transport the resolver
 * built — an injected `io` makes it one, which is what every case above produces), and the run must
 * fail naming the projected service-account token path, which is proof the resolver's own `readToken`
 * closure actually executed. The observer's own liveness is then proven in the SAME child by a
 * deliberate spawn at the end.
 */
describe("M23.6 clause 1: managed-iac on the Kubernetes path with NO injected transport", () => {
  it("NO `io`, NO `dockerBinary`: the resolver builds its OWN transport and NOTHING is spawned", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "managed-iac-defaultio-"));
    try {
      const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
      const pluginEntry = join(packageRoot, "dist/index.js");
      const driver = `
import { readFileSync } from "node:fs";
const OUT = process.env.SCP_SPAWN_OBSERVER_OUT;
const spawnsSoFar = () =>
  readFileSync(OUT, "utf8").split("\\n").filter((l) => l.trim().length > 0).length;

const { createRequire } = await import("node:module");
const req = createRequire(${JSON.stringify(join(packageRoot, "package.json"))});
const rl = await import(req.resolve("@scp/runner-launcher"));
const plugin = (await import(${JSON.stringify(pluginEntry)})).createManagedIacExecutorPlugin();
const base = {
  orgId: "org-1",
  scopeKey: "domain-1",
  logger: { debug() {}, info() {}, warn() {}, error() {} },
  secrets: { get: async () => undefined },
  http: { request: async () => { throw new Error("managed-iac: never calls ctx.http"); } }
};
const config = {
  runnerImage: "scp-runner-iac:vetted",
  workspaceRoot: ${JSON.stringify(workspace)},
  networkMode: "none",
  statePath: ${JSON.stringify(join(workspace, "dedup.json"))},
  runnerLauncher: "kubernetes",
  kubernetes: {
    namespace: "scp",
    workspaceRoot: ${JSON.stringify(workspace)},
    workspaceVolume: { kind: "persistentVolumeClaim", claimName: "scp-runner-workspace" },
    // A DEAD LOCAL PORT. If this ever runs somewhere a projected token DOES exist, the request still
    // cannot leave the machine — nothing in this repository's tests may touch a network.
    apiBase: "http://127.0.0.1:1"
  }
};

const before = rl.kubernetesConstructionCount();
const c = { ...base, config };
let detail = "";
const ref = await plugin.trigger(c, { kind: "sync", targetRef: "t1", parameters: { iacAction: "plan" }, idempotencyKey: "defaultio-k8s" }).catch((e) => {
  detail = String(e && e.message ? e.message : e);
  return null;
});
const constructed = rl.kubernetesConstructionCount() - before;
if (ref) {
  const st = await plugin.status(c, ref);
  detail = (st && st.detail) || detail;
}
await rl.whenKubernetesReapSettled("scp");
const afterKubernetes = spawnsSoFar();

// THE OBSERVER WAS LIVE IN THIS CHILD — the control, deliberately, and by a name nothing else uses.
// Without it "zero spawns" is also what a broken preload reports.
const { execFileSync } = await import("node:child_process");
try {
  execFileSync("scp-observer-liveness-control", ["--probe"], { stdio: "ignore" });
} catch {}
console.log(
  JSON.stringify({ constructed, detail, afterKubernetes, afterControl: spawnsSoFar(), ledger: rl.runnerSpawnCount() })
);
`;
      const run = await observeNodeSpawns({ module: driver, timeoutMs: 120_000 });
      expect(run.ok, `the probe did not complete:\n${run.stderr}`).toBe(true);
      const report = JSON.parse(run.stdout.trim().split("\n").pop()!) as {
        constructed: number;
        detail: string;
        afterKubernetes: number;
        afterControl: number;
        ledger: number;
      };
      // NON-VACUITY 1 — the `??` right-hand side was EVALUATED: launcher plus the transport the
      // resolver built for itself. An injected `io` makes this one.
      expect(
        report.constructed,
        "the resolver did not build its own transport, so the branch this case exists for was not evaluated"
      ).toBe(2);
      // NON-VACUITY 2 — the resolver's own `readToken` closure actually RAN. This process is not a pod.
      expect(
        report.detail,
        "the run never reached the default transport's token read, so nothing past construction was driven"
      ).toContain(`${K8S_SA_DIR}/token`);
      expect(
        report.afterKubernetes,
        `managed-iac created a process on the Kubernetes path: ${JSON.stringify(run.spawns)}`
      ).toBe(0);
      expect(report.ledger).toBe(0);
      // THE OBSERVER'S LIVENESS, in this same child and after the fact.
      expect(
        report.afterControl,
        "the deliberate control spawn was not recorded either — this child was not being observed"
      ).toBeGreaterThan(report.afterKubernetes);
      expect(run.binaries).toStrictEqual(["scp-observer-liveness-control"]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 180_000);
});
