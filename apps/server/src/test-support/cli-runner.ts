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

/** Confirmed flake: the next command sees no credentials. See docs/test-support.md §1. */
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
