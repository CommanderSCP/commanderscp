import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** `clientFromStoredCredentials`'s base-URL precedence (M29.1, tightened by the #422 review's
 *  SHOULD-FIX 5) — `--base-url` > `$SCP_API_URL` (same HOST as the saved session only) > the saved
 *  config. Found while writing scripts/scp-install-kind-drill.sh: `scp install`'s own port-forward
 *  closes when it exits, so a later `scp whoami` against a fresh one at a different PORT had no way
 *  to say so short of `--base-url` on every single command — `$SCP_API_URL` fills that gap, but
 *  ONLY within the same host: honouring it unconditionally let any ambient env var (not just this
 *  drill's) decide where the stored session token gets sent, an M28-class hole. */

const constructedOpts: { baseUrl: string; token?: string }[] = [];

vi.mock("@scp/sdk", () => {
  class ScpClient {
    constructor(opts: { baseUrl: string; token?: string }) {
      constructedOpts.push(opts);
    }
  }
  return { ScpClient };
});

// REMOTE is loopback (127.0.0.1) — the realistic `scp install`/port-forward shape, and the only
// host class the port-changing exception applies to (#422 re-verify SHOULD-FIX 3).
const REMOTE = "http://127.0.0.1:8080/api/v1";
const SAME_HOST_ENV_URL = "http://127.0.0.1:9999/api/v1";
const DIFFERENT_HOST_ENV_URL = "http://evil.example.com/api/v1";
const FLAG_URL = "http://flag.example.com/api/v1";

let configDir: string;
const savedEnv = { ...process.env };

async function writeCredentials(baseUrl: string): Promise<void> {
  await writeFile(
    path.join(configDir, "credentials.json"),
    JSON.stringify({ baseUrl, token: "tok", org: "acme", expiresAt: "2030-01-01T00:00:00Z" })
  );
}

beforeEach(async () => {
  constructedOpts.length = 0;
  configDir = await mkdtemp(path.join(tmpdir(), "scp-client-factory-test-"));
  process.env.SCP_CONFIG_DIR = configDir;
  delete process.env.SCP_API_URL;
  await writeCredentials(REMOTE);
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

  it("SCP_API_URL env overrides the saved config when it names the SAME host (a reopened port-forward on a new port)", async () => {
    process.env.SCP_API_URL = SAME_HOST_ENV_URL;
    const { clientFromStoredCredentials } = await import("./client-factory.js");
    await clientFromStoredCredentials({});
    expect(constructedOpts).toEqual([{ baseUrl: SAME_HOST_ENV_URL, token: "tok" }]);
  });

  it("MUTATION-CAUGHT: SCP_API_URL naming a DIFFERENT host is refused, not silently sent the stored token (#422 SHOULD-FIX 5, M28-class)", async () => {
    process.env.SCP_API_URL = DIFFERENT_HOST_ENV_URL;
    const { clientFromStoredCredentials } = await import("./client-factory.js");
    await expect(clientFromStoredCredentials({})).rejects.toThrow(/not a trusted override/);
    // and it must not have constructed a client pointed at the untrusted host along the way
    expect(constructedOpts).toEqual([]);
  });

  it("MUTATION-CAUGHT (#422 re-verify SHOULD-FIX 3): a same-host, DIFFERENT-PORT env is refused for a NON-loopback host — the port exception is loopback-only", async () => {
    await writeCredentials("http://scp.example.com/api/v1");
    process.env.SCP_API_URL = "http://scp.example.com:9999/api/v1";
    const { clientFromStoredCredentials } = await import("./client-factory.js");
    await expect(clientFromStoredCredentials({})).rejects.toThrow(/not a trusted override/);
    expect(constructedOpts).toEqual([]);
  });

  it("MUTATION-CAUGHT (#422 re-verify SHOULD-FIX 3): an https saved session never accepts an http SCP_API_URL downgrade, even on loopback", async () => {
    await writeCredentials("https://127.0.0.1/api/v1");
    process.env.SCP_API_URL = "http://127.0.0.1:9999/api/v1";
    const { clientFromStoredCredentials } = await import("./client-factory.js");
    await expect(clientFromStoredCredentials({})).rejects.toThrow(/not a trusted override/);
    expect(constructedOpts).toEqual([]);
  });

  it("--base-url overrides both a different-host env and the saved config (an explicit flag is consent; an ambient env var is not)", async () => {
    process.env.SCP_API_URL = DIFFERENT_HOST_ENV_URL;
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
