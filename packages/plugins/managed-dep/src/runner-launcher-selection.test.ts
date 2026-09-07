import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { observeNodeSpawns } from "@scp/source-census";
import type { KubernetesRunnerIo } from "@scp/runner-launcher";
import {
  BUMP_SPEC,
  DECLARED_MANIFEST_PATHS,
  githubHandler,
  recordingCtx
} from "./write-test-support.js";
import { __resetManagedDepOutcomes, createManagedDepExecutorPlugin } from "./index.js";
import {
  K8S_SA_DIR,
  clearRunnerSpawns,
  kubernetesConstructionCount,
  runnerSpawnCount,
  runnerSpawns,
  whenKubernetesReapSettled,
  whenReapSettled
} from "@scp/runner-launcher";

/** The standing gate that adapter selection is installed. See docs/plugins.md §359. */

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

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

let workspaceRoot: string;
beforeEach(async () => {
  __resetManagedDepOutcomes();
  workspaceRoot = await mkdtemp(join(tmpdir(), "managed-dep-select-"));
});
afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

function depCtx(overrides: Record<string, unknown>) {
  const { ctx } = recordingCtx(githubHandler({}, {}));
  return {
    ...ctx,
    config: {
      runnerImage: "scp-runner-dep:vetted",
      workspaceRoot,
      appId: "12345",
      installationId: "67890",
      privateKeyPem,
      ...overrides
    }
  };
}

const intent = (key: string) => ({
  kind: "custom" as const,
  idempotencyKey: key,
  parameters: {
    ecosystem: BUMP_SPEC.ecosystem,
    coordinate: BUMP_SPEC.coordinate,
    manifestPath: BUMP_SPEC.manifestPath,
    declaredManifestPaths: DECLARED_MANIFEST_PATHS,
    fromVersion: BUMP_SPEC.fromVersion,
    toVersion: BUMP_SPEC.toVersion,
    repo: "acme/widget",
    baseBranch: "main",
    changeObjectId: "0198f3c1-1111-7000-8000-00000000000a",
    delivery: "pull_request"
  }
});

describe("M23.2: managed-dep, constructed the way production constructs it, honours the selection", () => {
  it("`runnerLauncher: 'kubernetes'` REACHES THE KUBERNETES ADAPTER through the ZERO-ARGUMENT factory", async () => {
    const seen: string[] = [];
    const plugin = createManagedDepExecutorPlugin();
    const ctx = depCtx({
      ...KUBERNETES_SETTINGS,
      kubernetes: { ...KUBERNETES_SETTINGS.kubernetes, io: recordingIo(seen) }
    });
    const ref = await plugin.trigger(ctx, intent("select-1"));
    expect(
      seen,
      "the Kubernetes adapter was never reached — the plugin still defaults to Docker"
    ).toContain("POST /apis/batch/v1/namespaces/scp/jobs");
    expect((await plugin.status(ctx, ref)).phase).toBe("failed");
  });

  it("WITH THE SELECTION ABSENT the Kubernetes io is NEVER touched — the default is unchanged", async () => {
    const seen: string[] = [];
    const plugin = createManagedDepExecutorPlugin();
    const ctx = depCtx({
      kubernetes: { ...KUBERNETES_SETTINGS.kubernetes, io: recordingIo(seen) }
    });
    await plugin.trigger(ctx, intent("select-2")).catch(() => undefined);
    expect(seen).toStrictEqual([]);
  });

  /** No process is spawned on the Kubernetes path. See docs/plugins.md §360. */
  it("ON THE KUBERNETES PATH NOTHING IS SPAWNED — no container CLI, under any name", async () => {
    await whenReapSettled();
    clearRunnerSpawns();
    const before = runnerSpawnCount();
    const seen: string[] = [];
    const plugin = createManagedDepExecutorPlugin();
    const c = depCtx({
      ...KUBERNETES_SETTINGS,
      kubernetes: { ...KUBERNETES_SETTINGS.kubernetes, io: recordingIo(seen) }
    });
    await plugin.trigger(c, intent("select-3")).catch(() => undefined);
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
    const plugin = createManagedDepExecutorPlugin();
    await plugin.trigger(depCtx({}), intent("select-4")).catch(() => undefined);
    await whenReapSettled();
    expect(
      runnerSpawns().length,
      "the Docker path spawned nothing, so the negative arm proves nothing"
    ).toBeGreaterThan(0);
    expect(new Set(runnerSpawns().map((s) => s.file))).toStrictEqual(new Set(["docker"]));
  });

  /** Never constructed, which is stronger than never called. See docs/plugins.md §361. */
  it("WITH THE DOCKER LAUNCHER SELECTED NO KUBERNETES CLIENT IS CONSTRUCTED — an air-gapped VM gains no dependency", async () => {
    const seen: string[] = [];
    const before = kubernetesConstructionCount();
    const plugin = createManagedDepExecutorPlugin();
    const c = depCtx({ kubernetes: { ...KUBERNETES_SETTINGS.kubernetes, io: recordingIo(seen) } });
    await plugin.trigger(c, intent("select-5")).catch(() => undefined);
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
    const plugin = createManagedDepExecutorPlugin();
    const c = depCtx({
      ...KUBERNETES_SETTINGS,
      kubernetes: { ...KUBERNETES_SETTINGS.kubernetes, io: recordingIo(seen) }
    });
    await plugin.trigger(c, intent("select-6")).catch(() => undefined);
    expect(kubernetesConstructionCount()).toBeGreaterThan(before);
  });
});

/** M23.6 CLAUSE 1, BEHAVIOURALLY. See docs/plugins.md §362. */
describe("M23.6 clause 1, behaviourally: managed-dep creates no process on the Kubernetes path", () => {
  it("OBSERVED FROM OUTSIDE: the Kubernetes trigger spawns NOTHING and the Docker trigger spawns", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "managed-dep-observed-"));
    try {
      // BOTH SUBJECTS AS BUILT `dist`, RESOLVED THE WAY NODE WOULD. The driver runs from a temp
      // directory, so a bare specifier there would resolve against nothing; `createRequire` rooted at
      // this package's own `package.json` is the same lookup the plugin host performs.
      const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
      const pluginEntry = join(packageRoot, "dist/index.js");
      const supportEntry = join(packageRoot, "dist/write-test-support.js");
      const driver = `
import { readFileSync } from "node:fs";
const OUT = process.env.SCP_SPAWN_OBSERVER_OUT;
const spawnsSoFar = () =>
  readFileSync(OUT, "utf8").split("\\n").filter((l) => l.trim().length > 0).length;

const { createRequire } = await import("node:module");
const req = createRequire(${JSON.stringify(join(packageRoot, "package.json"))});
const rl = await import(req.resolve("@scp/runner-launcher"));
const mod = await import(${JSON.stringify(pluginEntry)});
const support = await import(${JSON.stringify(supportEntry)});
const { generateKeyPairSync } = await import("node:crypto");
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

const plugin = mod.createManagedDepExecutorPlugin();
const { ctx: base } = support.recordingCtx(support.githubHandler({}, {}));

const seen = [];
const io = {
  request: async (r) => {
    seen.push(r.method + " " + r.path.split("?")[0]);
    throw new Error("observed-probe: the Kubernetes io was reached");
  },
  copyDir: async () => undefined,
  removeDir: async () => undefined
};
const config = {
  runnerImage: "scp-runner-dep:vetted",
  workspaceRoot: ${JSON.stringify(workspace)},
  appId: "12345",
  installationId: "67890",
  privateKeyPem,
  // A BINARY THAT CANNOT EXIST, so the Docker control below is hermetic and fast: the ledger and the
  // observer both record the INTENT to spawn, whether or not a container runtime is installed.
  dockerBinary: "scp-no-such-container-cli"
};
const intent = (key) => ({
  kind: "custom",
  idempotencyKey: key,
  parameters: {
    ecosystem: support.BUMP_SPEC.ecosystem,
    coordinate: support.BUMP_SPEC.coordinate,
    manifestPath: support.BUMP_SPEC.manifestPath,
    declaredManifestPaths: support.DECLARED_MANIFEST_PATHS,
    fromVersion: support.BUMP_SPEC.fromVersion,
    toVersion: support.BUMP_SPEC.toVersion,
    repo: "acme/widget",
    baseBranch: "main",
    changeObjectId: "0198f3c1-1111-7000-8000-00000000000a",
    delivery: "pull_request"
  }
});

mod.__resetManagedDepOutcomes();
await plugin
  .trigger(
    { ...base, config: { ...config, runnerLauncher: "kubernetes", kubernetes: {
      namespace: "scp",
      workspaceRoot: ${JSON.stringify(workspace)},
      workspaceVolume: { kind: "persistentVolumeClaim", claimName: "scp-runner-workspace" },
      io
    } } },
    intent("observed-k8s")
  )
  .catch(() => undefined);
await rl.whenKubernetesReapSettled("scp");
const afterKubernetes = spawnsSoFar();

mod.__resetManagedDepOutcomes();
await plugin.trigger({ ...base, config }, intent("observed-docker")).catch(() => undefined);
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
        `managed-dep created a process on the Kubernetes path: ${JSON.stringify(run.spawns)}`
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

/** M23.6 CLAUSE 1, THE HOLE EVERY CASE ABOVE LEFT. See docs/plugins.md §363. */
describe("M23.6 clause 1: managed-dep on the Kubernetes path with NO injected transport", () => {
  it("NO `io`, NO `dockerBinary`: the resolver builds its OWN transport and NOTHING is spawned", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "managed-dep-defaultio-"));
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
const mod = await import(${JSON.stringify(pluginEntry)});
const support = await import(${JSON.stringify(join(packageRoot, "dist/write-test-support.js"))});
const { generateKeyPairSync } = await import("node:crypto");
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const plugin = mod.createManagedDepExecutorPlugin();
mod.__resetManagedDepOutcomes();
const { ctx: base } = support.recordingCtx(support.githubHandler({}, {}));
const config = {
  runnerImage: "scp-runner-dep:vetted",
  workspaceRoot: ${JSON.stringify(workspace)},
  appId: "12345",
  installationId: "67890",
  privateKeyPem,
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
const ref = await plugin.trigger(c, {
  kind: "custom",
  idempotencyKey: "defaultio-k8s",
  parameters: {
    ecosystem: support.BUMP_SPEC.ecosystem,
    coordinate: support.BUMP_SPEC.coordinate,
    manifestPath: support.BUMP_SPEC.manifestPath,
    declaredManifestPaths: support.DECLARED_MANIFEST_PATHS,
    fromVersion: support.BUMP_SPEC.fromVersion,
    toVersion: support.BUMP_SPEC.toVersion,
    repo: "acme/widget",
    baseBranch: "main",
    changeObjectId: "0198f3c1-1111-7000-8000-00000000000a",
    delivery: "pull_request"
  }
}).catch((e) => {
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
        `managed-dep created a process on the Kubernetes path: ${JSON.stringify(run.spawns)}`
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
