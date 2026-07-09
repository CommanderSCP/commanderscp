import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
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

/** One isolated `scp` CLI session (its own `~/.scp`-equivalent credentials dir) against `baseUrl`. */
export async function startCliSession(baseUrl: string): Promise<CliInvocation> {
  const configDir = await mkdtemp(path.join(os.tmpdir(), "scp-cli-test-"));

  async function run(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync("node", [CLI_BIN, ...args], {
      env: { ...process.env, SCP_CONFIG_DIR: configDir, SCP_API_URL: baseUrl }
    });
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
