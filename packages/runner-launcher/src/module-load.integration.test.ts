import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { RUNNER_LAUNCHER_DEADLINE_ANNOTATION, RUNNER_LAUNCHER_DEADLINE_LABEL } from "./index.js";

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** THE BUILT PACKAGE LOADS UNDER A REAL NODE ESM LOADER. See docs/runner-launcher.md §321. */

describe("M23.2: `@scp/runner-launcher` can actually be imported by Node", () => {
  beforeAll(async () => {
    // FRESH `dist`, ALWAYS. `tsc -b` is incremental and costs ~2s when nothing changed.
    await execFileAsync("npx", ["tsc", "-b"], { cwd: PACKAGE_ROOT, timeout: 120_000 });
  }, 130_000);

  it("THE BUILT ENTRY POINT LOADS, and its Kubernetes exports are reachable from it", async () => {
    // A CHILD `node`, not a dynamic import in this process: vitest's loader is the thing whose
    // disagreement with Node hid the defect, so it must not be the thing consulted.
    const entry = resolve(PACKAGE_ROOT, "dist/index.js");
    const script = [
      `const m = await import(${JSON.stringify(entry)});`,
      // Every export the cycle spans, exercised rather than merely counted: a `typeof` on a
      // re-export is satisfied by a binding that would throw the moment it is read.
      `if (typeof m.createKubernetesRunnerLauncher !== "function") throw new Error("no k8s factory");`,
      `if (typeof m.resolveRunnerLauncher !== "function") throw new Error("no resolver");`,
      `if (m.RUNNER_LAUNCHER_DEADLINE_ANNOTATION !== "scp.launcher.deadline") throw new Error("annotation binding is wrong: " + m.RUNNER_LAUNCHER_DEADLINE_ANNOTATION);`,
      `if (m.runnerJobName("abc") !== "scp-runner-abc") throw new Error("job name is wrong");`,
      // The resolver's Docker branch reads `index.ts` bindings at CALL time, which is the half of
      // the cycle that is supposed to be safe. Call it, so "safe" is exercised and not assumed.
      `const docker = m.resolveRunnerLauncher({});`,
      `if (typeof docker.run !== "function") throw new Error("docker branch is broken");`,
      `console.log("LOADED");`
    ].join("\n");
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      { cwd: PACKAGE_ROOT, timeout: 60_000 }
    );
    expect(stdout.trim()).toBe("LOADED");
  }, 60_000);

  it("THE ANNOTATION AND THE LABEL STILL AGREE — the equality the literal used to express", () => {
    // `RUNNER_LAUNCHER_DEADLINE_ANNOTATION` was `= RUNNER_LAUNCHER_DEADLINE_LABEL` until that line
    // proved unloadable. The relationship is still load-bearing — `reap()` reads the Docker LABEL and
    // the Kubernetes ANNOTATION with one predicate, and an operator greps for one string across both
    // substrates — so it is asserted here instead of expressed by an initialiser that cannot run.
    expect(RUNNER_LAUNCHER_DEADLINE_ANNOTATION).toBe(RUNNER_LAUNCHER_DEADLINE_LABEL);
  });
});
