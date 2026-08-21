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

/**
 * ================================================================================================
 * M23.6 CLAUSES 1 AND 7 — THE TWO LEDGERS, AND THE CENSUS THAT KEEPS THEM COMPLETE
 * ================================================================================================
 *
 * The per-class arms live in each plugin's `runner-launcher-selection.test.ts`, because the clause
 * asks for "each of the three plugins" by name. What lives HERE is the thing those three arms rest
 * on and cannot check for themselves: that the ledgers see EVERYTHING.
 *
 * A gate built on "the spawn ledger was empty" is worth exactly as much as the guarantee that a
 * spawn cannot happen off-ledger. So:
 *   - `execFileAsync` — the package's only binding of `promisify(execFile)` — must be referenced
 *     EXACTLY ONCE, inside `spawnRunnerProcess`. A second direct call is a spawn no ledger sees.
 *   - `kubernetesConstructions += 1` must appear exactly twice, once in each of the Kubernetes
 *     module's two constructors, and that module must export exactly those two constructors.
 *   - the three managed plugins must import no process-spawning API of their own. A plugin that
 *     called `child_process` directly would bypass this package entirely, and the three
 *     selection tests would keep passing while the clause was false.
 *
 * WHY A SOURCE CENSUS RATHER THAN A RUNTIME CHECK. Both are "this never happens anywhere", and a
 * runtime check can only speak for the paths a test drives. `grep -rna`, deliberately: CLAUDE.md
 * §4.4b — some tracked source files carry literal NUL bytes and a plain recursive search drops them
 * with no output and exit 1, which is indistinguishable from "no such code exists". This file reads
 * the bytes itself rather than shelling out to a search tool, which sidesteps the hazard entirely.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");

function read(relative: string): string {
  return readFileSync(resolve(REPO_ROOT, relative), "utf8");
}

/**
 * Comments removed, so a census counts CODE. This file's own subjects are heavily documented — the
 * Docker adapter's doc explains `execFile`'s three traps and the Kubernetes adapter's explains why
 * `maxBuffer` is an `execFile` concept it does not have — and a census that counted prose would be a
 * gate on how much a hazard is explained rather than on whether it exists. That is the inverse of
 * CLAUDE.md's rule: a comment naming a hazard is a signal to sweep, never the thing swept.
 */
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
    // THREE NAMES, TWO COUNTED CONSTRUCTIONS. `createDefaultKubernetesIo` (M23.6) builds nothing of
    // its own — it delegates to `createFetchKubernetesIo`, which is why the count above stays at two
    // — and it exists because the three closures it now holds were, as an object literal inside
    // `resolveRunnerLauncher`, the one stretch of the Kubernetes path NO test could reach. That is
    // where a planted `spawnSync` ran a real `docker version` with every suite green.
    expect(constructors.slice().sort()).toStrictEqual([
      "createDefaultKubernetesIo",
      "createFetchKubernetesIo",
      "createKubernetesRunnerLauncher"
    ]);
  });
});
