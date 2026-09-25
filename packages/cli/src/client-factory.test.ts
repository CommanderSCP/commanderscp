import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** `clientFromStoredCredentials`'s base-URL precedence (M29.1) — the SAME `--base-url` >
 *  `$SCP_API_URL` > saved-config order `login-base-url.test.ts` already proves for `scp login`,
 *  extended here to every OTHER command. Found while writing scripts/scp-install-kind-drill.sh: `scp
 *  install`'s own port-forward closes when it exits, so a later `scp whoami` against a fresh one at
 *  a different port had no way to say so short of `--base-url` on every single command. */

const constructedOpts: { baseUrl: string; token?: string }[] = [];

vi.mock("@scp/sdk", () => {
  class ScpClient {
    constructor(opts: { baseUrl: string; token?: string }) {
      constructedOpts.push(opts);
    }
  }
  return { ScpClient };
});

const REMOTE = "http://saved.example.com/api/v1";
const ENV_URL = "http://env.example.com/api/v1";
const FLAG_URL = "http://flag.example.com/api/v1";

let configDir: string;
const savedEnv = { ...process.env };

beforeEach(async () => {
  constructedOpts.length = 0;
  configDir = await mkdtemp(path.join(tmpdir(), "scp-client-factory-test-"));
  process.env.SCP_CONFIG_DIR = configDir;
  delete process.env.SCP_API_URL;
  await writeFile(
    path.join(configDir, "credentials.json"),
    JSON.stringify({
      baseUrl: REMOTE,
      token: "tok",
      org: "acme",
      expiresAt: "2030-01-01T00:00:00Z"
    })
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(configDir, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

describe("clientFromStoredCredentials base URL precedence", () => {
  it("no flag, no env -> the saved config", async () => {
    const { clientFromStoredCredentials } = await import("./client-factory.js");
    await clientFromStoredCredentials({});
    expect(constructedOpts).toEqual([{ baseUrl: REMOTE, token: "tok" }]);
  });

  it("SCP_API_URL env overrides the saved config", async () => {
    process.env.SCP_API_URL = ENV_URL;
    const { clientFromStoredCredentials } = await import("./client-factory.js");
    await clientFromStoredCredentials({});
    expect(constructedOpts).toEqual([{ baseUrl: ENV_URL, token: "tok" }]);
  });

  it("--base-url overrides both the env and the saved config", async () => {
    process.env.SCP_API_URL = ENV_URL;
    const { clientFromStoredCredentials } = await import("./client-factory.js");
    await clientFromStoredCredentials({ baseUrl: FLAG_URL });
    expect(constructedOpts).toEqual([{ baseUrl: FLAG_URL, token: "tok" }]);
  });

  it("refuses with no stored credentials at all", async () => {
    await rm(path.join(configDir, "credentials.json"));
    const { clientFromStoredCredentials } = await import("./client-factory.js");
    await expect(clientFromStoredCredentials({})).rejects.toThrow(/Not logged in/);
  });
});
