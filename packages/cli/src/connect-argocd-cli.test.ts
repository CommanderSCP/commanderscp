import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command } from "commander";

/**
 * `scp connect argocd`'s printed "Next:" hint. `scp discovery accept` was removed with the route
 * it called (ADR-0047, commit c7aa2a9) and replaced by `scp iac scaffold`, but the hint kept
 * pointing at the gone command — an operator following it verbatim would hit "unknown command".
 * This pins the CURRENT hint text: `scp iac scaffold --from <executionSystemId>`, and that neither
 * the removed command name nor the old multi-flag `discovery run` invocation appears anywhere in
 * it.
 */

const CREATED_ID = "99999999-9999-4999-8999-999999999999";

vi.mock("@scp/sdk", () => {
  class ScpApiError extends Error {}
  class ScpClient {
    secrets = { put: vi.fn(async () => undefined) };
    federation = {
      self: vi.fn(async () => {
        throw new Error("not registered");
      })
    };
    object(_type: string) {
      return {
        create: vi.fn(async () => ({
          id: CREATED_ID,
          urn: "urn:scp:execution-system:argocd",
          name: "argocd",
          typeId: "execution-system"
        }))
      };
    }
  }
  return { ScpClient, ScpApiError };
});

let configDir: string;
const savedEnv = { ...process.env };
let logs: string[] = [];

async function buildProgram(): Promise<Command> {
  const mod = await import("./cli.js");
  return mod.buildProgram();
}

async function run(args: string[]): Promise<void> {
  const program = await buildProgram();
  await program.parseAsync(["node", "scp", "connect", "argocd", ...args]);
}

beforeAll(async () => {
  await import("./cli.js");
}, 30_000);

beforeEach(async () => {
  logs = [];
  configDir = await mkdtemp(path.join(tmpdir(), "scp-connect-argocd-test-"));
  process.env.SCP_CONFIG_DIR = configDir;
  await writeFile(
    path.join(configDir, "credentials.json"),
    JSON.stringify({
      baseUrl: "http://localhost:8080/api/v1",
      token: "tok",
      org: "acme",
      expiresAt: "2030-01-01T00:00:00Z"
    })
  );
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(configDir, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

describe("scp connect argocd — the printed 'Next:' hint", () => {
  it("points at `scp iac scaffold --from <id>`, not the removed `scp discovery accept`", async () => {
    await run([
      "--url",
      "https://argocd.example.com",
      "--token",
      "shh",
      "--no-validate",
      "--output",
      "json"
    ]);
    const text = logs.join("\n");
    expect(text).toContain(`Next: scp iac scaffold --from ${CREATED_ID}`);
    expect(text).not.toContain("discovery accept");
    expect(text).not.toContain("discovery run --module");
  });
});
