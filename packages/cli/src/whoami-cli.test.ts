import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command } from "commander";

/** `scp whoami` — M29.1 (the front door): confirms "am I actually logged in", the same question
 *  `scp install`'s DoD asks. Session-based (GET /auth/me via ScpClient.auth.me). */

const calls: { method: string; args: unknown[] }[] = [];

function currentUser() {
  return {
    userId: "019f0000-0000-7000-8000-000000000001",
    orgId: "019f0000-0000-7000-8000-000000000002",
    orgName: "default",
    username: "admin",
    subjectObjectId: "019f0000-0000-7000-8000-000000000003",
    instanceRole: "commander" as const,
    roleBindings: [
      {
        roleId: "019f0000-0000-7000-8000-000000000004",
        roleName: "Owner",
        scopeObjectId: "019f0000-0000-7000-8000-000000000002",
        effect: "allow" as const
      }
    ],
    permissionsAnywhere: ["*"]
  };
}

vi.mock("@scp/sdk", async () => {
  const actual = await vi.importActual<typeof import("@scp/sdk")>("@scp/sdk");
  class ScpClient {
    auth = {
      me: async (...args: unknown[]) => (calls.push({ method: "auth.me", args }), currentUser())
    };
  }
  return { ...actual, ScpClient };
});

let configDir: string;
const savedEnv = { ...process.env };

async function program(): Promise<Command> {
  return (await import("./cli.js")).buildProgram();
}

beforeAll(async () => {
  await import("./cli.js");
}, 30_000);

beforeEach(async () => {
  calls.length = 0;
  configDir = await mkdtemp(path.join(tmpdir(), "scp-whoami-cli-test-"));
  process.env.SCP_CONFIG_DIR = configDir;
  await writeFile(
    path.join(configDir, "credentials.json"),
    JSON.stringify({
      baseUrl: "http://localhost:8080/api/v1",
      token: "tok",
      org: "default",
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

describe("scp whoami", () => {
  it("is registered on the program", async () => {
    const cmd = (await program()).commands.find((c) => c.name() === "whoami");
    expect(cmd, "`scp whoami` is missing").toBeDefined();
  });

  it("calls GET /auth/me (ScpClient.auth.me) — a session read, not a bare token check", async () => {
    await (await program()).parseAsync(["node", "scp", "whoami"]);
    expect(calls).toEqual([{ method: "auth.me", args: [] }]);
  });

  it("without stored credentials, refuses with the same message every other command uses", async () => {
    await rm(path.join(configDir, "credentials.json"));
    await expect((await program()).parseAsync(["node", "scp", "whoami"])).rejects.toThrow(
      /Not logged in/
    );
  });
});
