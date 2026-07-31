import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// apps/server/src/test-support -> ../../../packages/cli/dist/bin.js. The real built CLI binary
// (not an in-process import) — a genuine black-box exercise of `scp`, same as scripts/e2e-m0.sh.
// Requires `pnpm build` to have run first (turbo's test:integration task depends on build).
const CLI_BIN = path.resolve(__dirname, "../../../../packages/cli/dist/bin.js");

export interface CliInvocation {
  configDir: string;
  cleanup(): Promise<void>;
  run(args: string[]): Promise<{ stdout: string; stderr: string }>;
  runJson<T = unknown>(args: string[]): Promise<T>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Confirmed flake (2026-07-31, CI run 30631863957 job 91160378014): `scp login` exits 0, but the
 * VERY NEXT `scp <cmd>` in the same session occasionally sees "Not logged in" — `credentials.json`
 * not yet visible to the next `node <CLI_BIN>` subprocess's `readFile`, despite `login`'s own
 * `saveCredentials` being fully awaited before that process exits. Root cause NOT found: per-session
 * `configDir` isolation (this file), the `port: 0` server binding (harness.ts), and every awaited
 * subprocess call were all confirmed correct by code review, and two full local
 * `test:integration` runs (95 files / 791 tests each) produced zero repro. Whatever the underlying
 * cause — most plausibly a CI-runner-specific filesystem visibility delay between two independently
 * spawned processes — a fresh child process's `readFile` of a file another process just wrote is
 * exactly the boundary this credentials round-trip crosses, so guard it directly here rather than
 * masking the symptom with a blanket test retry: after `login`, poll for a parseable
 * `credentials.json` (bounded, short) before handing control back to the caller.
 */
async function waitForCredentials(configDir: string): Promise<void> {
  const credentialsPath = path.join(configDir, "credentials.json");
  const attempts = 5;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const raw = await readFile(credentialsPath, "utf8");
      JSON.parse(raw); // throws on a partial/torn write, same as a missing file — keep polling.
      return;
    } catch {
      if (attempt === attempts) {
        throw new Error(
          `scp login exited but ${credentialsPath} never became readable after ${attempts} attempts — ` +
            "the CLI's own saveCredentials() should have made it visible before its process exited."
        );
      }
      await sleep(50 * attempt);
    }
  }
}

/** One isolated `scp` CLI session (its own `~/.scp`-equivalent credentials dir) against `baseUrl`. */
export async function startCliSession(baseUrl: string): Promise<CliInvocation> {
  const configDir = await mkdtemp(path.join(os.tmpdir(), "scp-cli-test-"));

  async function run(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const result = await execFileAsync("node", [CLI_BIN, ...args], {
      env: { ...process.env, SCP_CONFIG_DIR: configDir, SCP_API_URL: baseUrl }
    });
    // Only `login` (password or --device) writes credentials.json; every other command only READS
    // it, so this check is a no-op (an extra stat + readFile) for the other ~95% of calls.
    if (args[0] === "login") {
      await waitForCredentials(configDir);
    }
    return result;
  }

  return {
    configDir,
    run,
    runJson: async <T>(args: string[]): Promise<T> => {
      const { stdout } = await run([...args, "--output", "json"]);
      return JSON.parse(stdout) as T;
    },
    cleanup: async () => {
      await rm(configDir, { recursive: true, force: true });
    }
  };
}
