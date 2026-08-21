import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KubernetesRunnerIo } from "@scp/runner-launcher";
import {
  BUMP_SPEC,
  DECLARED_MANIFEST_PATHS,
  githubHandler,
  recordingCtx
} from "./write-test-support.js";
import { __resetManagedDepOutcomes, createManagedDepExecutorPlugin } from "./index.js";
import {
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
 * `createManagedDepExecutorPlugin()` — no argument — so the DEFAULT PARAMETER is the whole of the
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
    const plugin = createManagedDepExecutorPlugin();
    const c = depCtx({
      ...KUBERNETES_SETTINGS,
      kubernetes: { ...KUBERNETES_SETTINGS.kubernetes, io: recordingIo(seen) }
    });
    await plugin.trigger(c, intent("select-3")).catch(() => undefined);
    await whenKubernetesReapSettled("scp");
    // NON-VACUITY FIRST: a run that never happened spawns nothing either.
    expect(seen, "the run never reached the Kubernetes adapter, so 'nothing was spawned' is empty").toContain(
      "POST /apis/batch/v1/namespaces/scp/jobs"
    );
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
    expect(runnerSpawns().length, "the Docker path spawned nothing, so the negative arm proves nothing").toBeGreaterThan(0);
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
