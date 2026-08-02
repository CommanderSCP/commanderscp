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
 *
 * BUDGET RAISED 2026-08-02 (CI run 30770220554 job 91556316977). The guard fired for real and still
 * lost: 5 attempts at `50 * attempt` is 500 ms of total patience, on a shard whose tests took 916 s
 * — i.e. a heavily loaded runner, which is exactly the condition the delay needs and the condition
 * under which 500 ms is thinnest. The guard's PURPOSE is to outlast a visibility delay of unknown
 * length, so a budget that short was never the right shape; this is the same fix, sized honestly.
 *
 * Now ~5 s across 16 attempts with the backoff capped, so the tail is patience rather than one long
 * final sleep. It stays a WAIT, not a retry-the-test: if `credentials.json` never becomes readable
 * the failure is still loud, still points at this boundary, and still refuses to let a "Not logged
 * in" error surface later as a confusing assertion failure somewhere unrelated.
 */
async function waitForCredentials(configDir: string): Promise<void> {
  const credentialsPath = path.join(configDir, "credentials.json");
  const attempts = 16;
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
      // Capped so the total (~5 s) is spread across many checks instead of a few long ones — the
      // file becomes visible at some unknown moment, so checking OFTEN matters more than waiting
      // LONG, and an uncapped ramp would spend most of the budget asleep past that moment.
      await sleep(Math.min(50 * attempt, 500));
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
