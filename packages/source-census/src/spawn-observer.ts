import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Nothing was spawned, as a measurement not a census. See docs/source-census.md §15. */

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The preload, resolved from the package root not this file. See docs/source-census.md §16. */
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

/** Runs a module under the observer, never throwing. See docs/source-census.md §17. */
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
