import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture the baseUrl every ScpClient is constructed with, so we can assert which host
// `scp login` actually targets given flag / env / saved-config precedence.
const constructedBaseUrls: string[] = [];

vi.mock("@scp/sdk", () => {
  class ScpClient {
    baseUrl: string;
    constructor(opts: { baseUrl: string }) {
      this.baseUrl = opts.baseUrl;
      constructedBaseUrls.push(opts.baseUrl);
    }
    async login() {
      return { token: "tok", org: "acme", expiresAt: "2030-01-01T00:00:00Z" };
    }
    deviceFlow = {
      start: async () => ({
        verificationUri: "https://example/device",
        userCode: "ABCD",
        deviceCode: "dev-code",
        interval: 0,
        expiresIn: 60
      }),
      poll: async () => ({ token: "tok", org: "acme", expiresAt: "2030-01-01T00:00:00Z" })
    };
  }
  class ScpApiError extends Error {
    problem?: unknown;
  }
  return { ScpClient, ScpApiError };
});

const REMOTE = "https://scp.example.com/api/v1";
const LOCALHOST = "http://localhost:8080/api/v1";

let configDir: string;
const savedEnv = { ...process.env };

async function runLogin(args: string[]): Promise<void> {
  // Import lazily so the module picks up the mocked @scp/sdk.
  const { buildProgram } = await import("./cli.js");
  await buildProgram().parseAsync(["node", "scp", "login", ...args]);
}

async function writeSavedConfig(baseUrl: string): Promise<void> {
  await writeFile(
    path.join(configDir, "credentials.json"),
    JSON.stringify({ baseUrl, token: "old", org: "acme", expiresAt: "2030-01-01T00:00:00Z" })
  );
}

beforeEach(async () => {
  constructedBaseUrls.length = 0;
  configDir = await mkdtemp(path.join(tmpdir(), "scp-login-test-"));
  process.env.SCP_CONFIG_DIR = configDir;
  process.env.SCP_USERNAME = "user";
  process.env.SCP_PASSWORD = "pass";
  delete process.env.SCP_API_URL;
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(configDir, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

describe("scp login base URL precedence", () => {
  it("(a) no flag + saved remote config -> targets the remote instance", async () => {
    await writeSavedConfig(REMOTE);
    await runLogin([]);
    expect(constructedBaseUrls).toEqual([REMOTE]);
  });

  it("(b) explicit --base-url overrides the saved config", async () => {
    await writeSavedConfig(REMOTE);
    const flagUrl = "https://other.example.com/api/v1";
    await runLogin(["--base-url", flagUrl]);
    expect(constructedBaseUrls).toEqual([flagUrl]);
  });

  it("(c) SCP_API_URL env is honored over saved config", async () => {
    await writeSavedConfig(REMOTE);
    const envUrl = "https://env.example.com/api/v1";
    process.env.SCP_API_URL = envUrl;
    await runLogin([]);
    expect(constructedBaseUrls).toEqual([envUrl]);
  });

  it("(d) no flag + no config -> localhost default", async () => {
    await runLogin([]);
    expect(constructedBaseUrls).toEqual([LOCALHOST]);
  });

  it("(a-device) device flow shares the resolver: saved remote config -> remote", async () => {
    await writeSavedConfig(REMOTE);
    await runLogin(["--device"]);
    expect(constructedBaseUrls).toEqual([REMOTE]);
  });
});
