import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command } from "commander";
import { StackBackendSchema, type StackView } from "@scp/schemas";

/** `scp stack …` over a mocked SDK (M29.4, ADR-0058): each verb reaches its ScpClient method. */

interface Call {
  method: string;
  args: unknown[];
}
const calls: Call[] = [];

function view(): StackView {
  return {
    settings: { updatePolicy: "automatic", upgradeGeneration: 3 },
    controller: {
      release: "1.0.0",
      lastSeenAt: "2026-09-24T00:00:00.000Z",
      reporting: true,
      observedUpgradeGeneration: 3
    },
    backends: StackBackendSchema.options.map((backend) => ({
      backend,
      enabled: backend === "argo-events",
      sizeTier: "small" as const,
      status:
        backend === "argo-events"
          ? {
              phase: "ready" as const,
              runningVersion: "1.0.0",
              targetVersion: "1.0.0",
              lastError: null,
              needs: [],
              observedAt: "2026-09-24T00:00:00.000Z"
            }
          : null
    }))
  };
}

vi.mock("@scp/sdk", () => {
  class ScpApiError extends Error {}
  class ScpClient {
    stack = {
      get: async (...args: unknown[]) => (calls.push({ method: "get", args }), view()),
      putBackend: async (...args: unknown[]) => (
        calls.push({ method: "putBackend", args }),
        view()
      ),
      putSettings: async (...args: unknown[]) => (
        calls.push({ method: "putSettings", args }),
        view()
      ),
      requestUpgrade: async (...args: unknown[]) => (
        calls.push({ method: "requestUpgrade", args }),
        view()
      ),
      diagnostics: async (...args: unknown[]) => (
        calls.push({ method: "diagnostics", args }),
        { generatedAt: "now", stack: view(), backends: [] }
      )
    };
  }
  return { ScpClient, ScpApiError };
});

let configDir: string;
const savedEnv = { ...process.env };

async function program(): Promise<Command> {
  return (await import("./cli.js")).buildProgram();
}

async function run(args: string[]): Promise<void> {
  await (await program()).parseAsync(["node", "scp", "stack", ...args]);
}

beforeAll(async () => {
  await import("./cli.js");
}, 30_000);

beforeEach(async () => {
  calls.length = 0;
  configDir = await mkdtemp(path.join(tmpdir(), "scp-stack-cli-test-"));
  process.env.SCP_CONFIG_DIR = configDir;
  process.env.SCP_OPERATOR_TOKEN = "op-token";
  await writeFile(
    path.join(configDir, "credentials.json"),
    JSON.stringify({
      baseUrl: "http://localhost:8080/api/v1",
      token: "tok",
      org: "acme",
      expiresAt: "2030-01-01T00:00:00Z"
    })
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(configDir, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

describe("scp stack", () => {
  it("offers exactly the verbs the SDK has (API -> SDK -> CLI parity)", async () => {
    const group = (await program()).commands.find((c) => c.name() === "stack");
    expect(group, "`scp stack` is missing").toBeDefined();
    expect(group!.commands.map((c) => c.name()).sort()).toEqual(
      ["diagnostics", "disable", "enable", "status", "updates", "upgrade"].sort()
    );
  });

  it("status is a session read and prints whether the controller is acting", async () => {
    await run(["status"]);
    expect(calls).toEqual([{ method: "get", args: [] }]);
    const printed = vi
      .mocked(console.log)
      .mock.calls.map((c) => String(c[0]))
      .join("\n");
    expect(printed).toContain("stack controller: reporting, release 1.0.0");
  });

  it("enable sends the backend, the tier and the operator credential", async () => {
    await run(["enable", "argo-rollouts", "--size", "large"]);
    expect(calls).toEqual([
      {
        method: "putBackend",
        args: ["argo-rollouts", { enabled: true, sizeTier: "large" }, "op-token"]
      }
    ]);
  });

  it("disable sends enabled:false and keeps the tier", async () => {
    await run(["disable", "gitea", "--operator-token", "flag-token"]);
    expect(calls).toEqual([
      { method: "putBackend", args: ["gitea", { enabled: false }, "flag-token"] }
    ]);
  });

  it("an unknown backend or tier is refused before any call", async () => {
    await expect(run(["enable", "harbor"])).rejects.toThrow(/backend must be one of argocd\|/);
    await expect(run(["enable", "gitea", "--size", "huge"])).rejects.toThrow(/--size must be/);
    expect(calls).toEqual([]);
  });

  it("every change refuses without an operator credential, and says which one", async () => {
    delete process.env.SCP_OPERATOR_TOKEN;
    await expect(run(["enable", "gitea"])).rejects.toThrow(/deployment operator credential/);
    await expect(run(["upgrade"])).rejects.toThrow(/deployment operator credential/);
    await expect(run(["diagnostics"])).rejects.toThrow(/deployment operator credential/);
    expect(calls).toEqual([]);
  });

  it("upgrade and updates reach their verbs", async () => {
    await run(["upgrade"]);
    await run(["updates", "manual"]);
    expect(calls).toEqual([
      { method: "requestUpgrade", args: ["op-token"] },
      { method: "putSettings", args: [{ updatePolicy: "manual" }, "op-token"] }
    ]);
    await expect(run(["updates", "sometimes"])).rejects.toThrow(/policy must be one of/);
  });

  it("diagnostics writes the bundle to a file when asked", async () => {
    const out = path.join(configDir, "diag.json");
    await run(["diagnostics", "--out", out]);
    expect(JSON.parse(await readFile(out, "utf8")).stack.settings.upgradeGeneration).toBe(3);
  });
});
