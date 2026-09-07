/** One place that logs every argv and raises on a non-zero exit. See docs/cosign.md §18. */
import { execFileSync } from "node:child_process";

export interface RunResult {
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Extra environment variables to overlay onto `process.env` for this invocation only. */
  env?: NodeJS.ProcessEnv;
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
