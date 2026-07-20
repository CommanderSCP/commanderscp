/**
 * Thin `node:child_process` wrapper used by the cosign wrapper in this package. Every
 * external-binary invocation goes through here so there is exactly one place that logs the
 * literal argv being run (useful for the "prove there's no hidden network call" audits this
 * package's own README/tests do) and turns a non-zero exit into a thrown Error carrying stdout
 * + stderr, instead of swallowing the failure the way a bare `execFileSync` in a try/catch does.
 *
 * Deliberately uses `execFileSync` (argv array, no shell) rather than `exec`/a shell string —
 * this is the same choice `scripts/doctor.mjs` and `tools/helm-verify/src/verify.ts` make
 * elsewhere in this repo, and it matters here specifically: image references, registry hosts,
 * and file paths can contain characters (`:`, `/`, `@`) that would be
 * shell-metacharacter-adjacent if this ever went through a shell.
 */
import { execFileSync } from "node:child_process";

export interface RunResult {
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Extra environment variables to overlay onto `process.env` for this invocation only. */
  env?: NodeJS.ProcessEnv;
  /** Working directory for the child process. */
  cwd?: string;
  /** Print the command being run (argv only, never env values) to stderr before executing. Default true. */
  log?: boolean;
}

export class CommandError extends Error {
  constructor(
    public readonly command: string,
    public readonly args: string[],
    public readonly exitCode: number | null,
    public readonly stdout: string,
    public readonly stderr: string
  ) {
    super(
      `command failed (exit ${exitCode}): ${command} ${args.join(" ")}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`
    );
    this.name = "CommandError";
  }
}

/** Run `command args...` to completion, throwing CommandError on non-zero exit. */
export function run(command: string, args: string[], options: RunOptions = {}): RunResult {
  if (options.log !== false) {
    // argv only — never dump `options.env`, which is exactly where COSIGN_PASSWORD/COSIGN_KEY live.
    process.stderr.write(`+ ${command} ${args.join(" ")}\n`);
  }
  try {
    const stdout = execFileSync(command, args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      encoding: "utf8",
      // Command output (image lists, manifests) can be larger than the 1MB default.
      maxBuffer: 64 * 1024 * 1024
    });
    return { stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string; message?: string };
    throw new CommandError(
      command,
      args,
      e.status ?? null,
      e.stdout ?? "",
      e.stderr ?? e.message ?? String(err)
    );
  }
}

/** Like `run`, but returns null instead of throwing when the binary can't be found/executed at all — used by preflight checks. */
export function which(command: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
