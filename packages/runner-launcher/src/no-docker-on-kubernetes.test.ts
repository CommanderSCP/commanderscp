import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  RUNNER_SPAWN_LEDGER_MAX,
  clearRunnerSpawns,
  createDockerRunnerLauncher,
  kubernetesConstructionCount,
  resolveRunnerLauncher,
  runnerSpawnCount,
  runnerSpawns
} from "./index.js";

/** M23.6 CLAUSES 1 AND 7. See docs/runner-launcher.md §322. */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");

function read(relative: string): string {
  return readFileSync(resolve(REPO_ROOT, relative), "utf8");
}

/** Comments removed, so a census counts CODE. See docs/runner-launcher.md §323. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

/** Tracked source under a directory, read as BYTES-first text — never through a search tool. */
function trackedSources(prefix: string): { path: string; text: string }[] {
  const out = execFileSync("git", ["ls-files", "-z", prefix], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  return out
    .split("\0")
    .filter((p) => p.endsWith(".ts") && !p.endsWith(".test.ts"))
    .map((p) => ({ path: p, text: read(p) }));
}

describe("M23.6 clause 1: a spawn cannot happen where no ledger can see it", () => {
  it("`execFileAsync` is referenced EXACTLY ONCE in the package, inside the one spawner", () => {
    const source = read("packages/runner-launcher/src/index.ts");
    const uses = [...stripComments(source).matchAll(/\bexecFileAsync\b/g)].length;
    // The declaration (`const execFileAsync = promisify(execFile)`) and the single call inside
    // `spawnRunnerProcess`. Anything more is a spawn route around the ledger.
    expect(
      uses,
      "a second `execFileAsync` appeared. Route it through spawnRunnerProcess, or the clause-1 gate silently stops gating"
    ).toBe(2);
    expect(source).toContain("return execFileAsync(file, [...argv], options);");
  });

  it("the Kubernetes adapter starts no process of its own", () => {
    const code = stripComments(read("packages/runner-launcher/src/kubernetes-adapter.ts"));
    // AN IMPORT OR A CALL, NOT A MENTION. This module's doc explains at length why `maxBuffer` is an
    // `execFile` concept it deliberately does not have; that prose is the opposite of a violation.
    expect(
      /["']node:child_process["']/.test(code),
      "kubernetes-adapter.ts imports node:child_process — the Kubernetes path is an HTTP client and nothing else"
    ).toBe(false);
    for (const forbidden of ["execFile(", "execFileSync(", "spawn(", "spawnSync(", "execSync("]) {
      expect(
        code.includes(forbidden),
        `kubernetes-adapter.ts calls ${forbidden} — the Kubernetes path starts no process`
      ).toBe(false);
    }
  });

  it("NEITHER of the three managed plugins imports a process-spawning API", () => {
    const offenders: string[] = [];
    for (const plugin of ["managed-iac", "managed-dep", "managed-scan"]) {
      for (const { path, text } of trackedSources(`packages/plugins/${plugin}/src`)) {
        // An IMPORT, not a mention: all three plugins discuss `execFile` in prose, because the
        // reason their credentials left the argv is worth explaining at the site.
        if (/^\s*import[^\n]*["']node:child_process["']/m.test(text)) offenders.push(path);
        if (/\brequire\(\s*["']node:?child_process["']\s*\)/.test(text)) offenders.push(path);
      }
    }
    expect(
      offenders,
      "a plugin that spawns for itself bypasses @scp/runner-launcher, and its selection test would keep passing while the clause was false"
    ).toStrictEqual([]);
  });

  it("the ledger RECORDS a spawn, by binary name — the control every empty-ledger assertion rests on", async () => {
    clearRunnerSpawns();
    const before = runnerSpawnCount();
    // A binary that does not exist: the record is written BEFORE the child is started, so this is
    // machine-independent and needs no container runtime.
    const launcher = createDockerRunnerLauncher("scp-no-such-container-cli");
    await launcher.reap().catch(() => undefined);
    expect(runnerSpawnCount()).toBeGreaterThan(before);
    expect(runnerSpawns().map((s) => s.file)).toContain("scp-no-such-container-cli");
    expect(runnerSpawns().map((s) => s.verb)).toContain("ps");
    // …and it records the RENAME rather than the concept, which is what the clause asks for.
    expect(runnerSpawns().every((s) => s.file !== "docker")).toBe(true);
  });

  it("the ledger is BOUNDED — a long-lived worker cannot grow it without limit", () => {
    clearRunnerSpawns();
    expect(runnerSpawns().length).toBe(0);
    expect(RUNNER_SPAWN_LEDGER_MAX).toBeLessThanOrEqual(1_000);
  });
});

describe("M23.6 clause 7: nothing Kubernetes is CONSTRUCTED on the Docker path", () => {
  it("`resolveRunnerLauncher` with no selection builds no Kubernetes launcher and no API client", () => {
    const before = kubernetesConstructionCount();
    // The settings are PRESENT and the selection is not — the shape a deployment that once ran on
    // Kubernetes and moved back to compose would have.
    const launcher = resolveRunnerLauncher({
      dockerBinary: "docker",
      kubernetes: {
        namespace: "scp",
        workspaceRoot: "/scp-workspace",
        workspaceVolume: { kind: "persistentVolumeClaim", claimName: "scp-runner-workspace" }
      }
    });
    expect(launcher).toBeDefined();
    expect(
      kubernetesConstructionCount() - before,
      "the Docker branch constructed Kubernetes machinery and discarded it"
    ).toBe(0);
  });

  it("…and DOES build exactly two when the selection is present — the counter is not inert", () => {
    const before = kubernetesConstructionCount();
    resolveRunnerLauncher({
      runnerLauncher: "kubernetes",
      kubernetes: {
        namespace: "scp",
        workspaceRoot: "/scp-workspace",
        workspaceVolume: { kind: "persistentVolumeClaim", claimName: "scp-runner-workspace" }
      }
    });
    // The launcher AND the fetch io it defaults to: two constructions, and the number matters —
    // an injected `io` (which every unit fixture supplies) builds only one.
    expect(kubernetesConstructionCount() - before).toBe(2);
  });

  it("THE CENSUS: exactly two construction sites, and exactly two exported constructors", () => {
    const source = read("packages/runner-launcher/src/kubernetes-adapter.ts");
    expect(
      [...source.matchAll(/kubernetesConstructions \+= 1;/g)].length,
      "a Kubernetes constructor that does not record itself makes clause 7's gate partial"
    ).toBe(2);
    const constructors = [...source.matchAll(/^export function (create[A-Za-z]+)\(/gm)].map(
      (m) => m[1]!
    );
    // THREE NAMES, TWO COUNTED CONSTRUCTIONS. See docs/runner-launcher.md §324.
    expect(constructors.slice().sort()).toStrictEqual([
      "createDefaultKubernetesIo",
      "createFetchKubernetesIo",
      "createKubernetesRunnerLauncher"
    ]);
  });
});
