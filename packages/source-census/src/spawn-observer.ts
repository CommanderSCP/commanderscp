import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * ==================================================================================================
 * `observeNodeSpawns` — "NOTHING WAS SPAWNED" AS A MEASUREMENT RATHER THAN AS A CENSUS
 * ==================================================================================================
 *
 * THE DEFECT THIS EXISTS FOR, MEASURED. M23.6 clause 1 is "no plugin spawns a Docker CLI on the
 * Kubernetes path". What stood for it was two things, and neither could carry it:
 *
 *   - A LEDGER inside `@scp/runner-launcher`: `spawnRunnerProcess` records the binary by name, and
 *     each managed plugin asserts the ledger is empty on the Kubernetes path. But the ledger only
 *     sees calls that go THROUGH it. A real `execFile(dockerBinary, ["version", …])` planted in
 *     `resolveRunnerLauncher`'s Kubernetes branch left all three ledger tests GREEN while fourteen
 *     spawns actually happened.
 *   - A SOURCE CENSUS: `execFileAsync` must appear exactly twice in `index.ts`, the Kubernetes
 *     adapter must not name `execFile(`, no plugin may import `node:child_process`. That is a
 *     statement about TEXT. This repository has a named failure for reading text and calling it
 *     behaviour — `@scp/source-census` was created because ten such censuses were each measured
 *     green over wiring that had been COMMENTED OUT — and the same asymmetry applies here in its
 *     sharpest form: a census can prove a string is present; it can never prove an execution is
 *     absent, because the next spawn is written in whatever spelling the census does not hold.
 *
 * SO THE OBSERVER SITS OUTSIDE THE SUBJECT. It runs the subject in a CHILD `node` with
 * `test-support/spawn-observer-preload.cjs` `--require`d ahead of it (see that file for why a CJS
 * preload is the only ordering that works, and for the `util.promisify.custom` trap that would
 * otherwise have made this silently blind to the exact call `@scp/runner-launcher` makes). Every
 * process creation is appended to a file as it happens. The assertion is then over WHAT THE PROCESS
 * DID, not over what its source says — so a rename, an indirection, a dynamic `import()`, a helper
 * in a new file, or a call site nobody censused all land in the same list.
 *
 * WHY NOT AN INJECTABLE SPAWNER ON `RunnerLauncherConfig`, which the clause's own wording suggested.
 * It was considered and rejected on the same grounds `index.ts` states for `dockerBinary`: that
 * interface is the SERVER-INJECTED, never-tenant-settable plugin config surface, and a field naming
 * an arbitrary callable is a new hole in exactly the surface a live RCE was already shipped through.
 * It is also strictly WEAKER than this: an injected spawner is only consulted by code that chose to
 * consult it, so the planted `execFile` above would have walked past it untouched — which is the
 * same reason the ledger did not catch it. The cost of doing it this way instead is real and is
 * named here rather than left to be discovered: each observed run is a fresh `node` process
 * (~0.3–1.5s), the subject must be reachable as BUILT `dist` rather than through vitest's loader,
 * and the driver script is a string rather than type-checked code.
 *
 * COVERAGE, STATED. Every process-creating export of `node:child_process`, its promisified form, and
 * `ChildProcess.prototype.spawn` beneath them all. NOT a native addon calling `posix_spawn`
 * directly — see the preload's own note for why that is out of reach portably, and for the pinned
 * census that keeps the wrapped set complete as Node changes.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The preload, resolved from the PACKAGE ROOT rather than from this file's directory — `src/` and
 * `dist/` are siblings, so one expression is correct whether this module is being run by vitest from
 * source or imported as built output by another package's test.
 */
export const SPAWN_OBSERVER_PRELOAD = resolve(
  __dirname,
  "..",
  "test-support",
  "spawn-observer-preload.cjs"
);

/** One process creation, exactly as the child made it. */
export interface ObservedSpawn {
  /** Which route created it: an export name, `<name>[promisified]`, or the prototype catch-all. */
  readonly via: string;
  /** The binary (or module, for `fork`) as it was passed — a rename is visible here and nowhere else. */
  readonly file: string;
  /** The argv array, when the route carries one. */
  readonly argv: readonly string[];
}

export interface ObservedRun {
  /** Every creation, in order. EMPTY is the assertion clause 1 rests on. */
  readonly spawns: readonly ObservedSpawn[];
  /** Distinct binaries, deduplicated — the shape most assertions actually want. */
  readonly binaries: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  /** True when the child exited 0. A driver that threw before reaching the subject spawns nothing
   *  either, so every caller must check this before believing an empty list. */
  readonly ok: boolean;
}

export interface ObserveOptions {
  /**
   * ESM source for the child. Written to a real `.mjs` file rather than passed to `-e`, so a syntax
   * error names a line and a stack trace from the subject is readable.
   */
  readonly module: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

/**
 * Run `module` in a child `node` under the spawn observer and report every process it created.
 *
 * NEVER THROWS ON A NON-ZERO CHILD. A driver that crashed is a result the caller must be able to
 * assert about — "the list was empty because the subject never ran" is the vacuity every caller of
 * this function has to rule out for itself, and it can only do that if it can see `ok` and `stderr`.
 */
export async function observeNodeSpawns(opts: ObserveOptions): Promise<ObservedRun> {
  const dir = mkdtempSync(join(tmpdir(), "scp-spawn-observer-"));
  const entry = join(dir, "driver.mjs");
  const out = join(dir, "spawns.jsonl");
  try {
    writeFileSync(entry, opts.module, "utf8");
    writeFileSync(out, "", "utf8");
    const child = spawn(process.execPath, ["--require", SPAWN_OBSERVER_PRELOAD, entry], {
      cwd: opts.cwd,
      env: {
        ...process.env,
        ...opts.env,
        SCP_SPAWN_OBSERVER_OUT: out
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    const exitCode = await new Promise<number | null>((resolveExit) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, opts.timeoutMs ?? 120_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolveExit(code);
      });
    });
    const spawns = readFileSync(out, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as ObservedSpawn);
    return {
      spawns,
      binaries: [...new Set(spawns.map((s) => s.file))].sort(),
      stdout,
      stderr,
      exitCode,
      ok: exitCode === 0
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
