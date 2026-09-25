import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command } from "commander";

/** `scp connect gitea` (M29.2) — registering an EXISTING Gitea (Mode A import), the same two
 *  writes as `connect argocd`: the token into the org's secret store, then the execution system
 *  that names it. The BUNDLED Gitea needs no command (the stack controller registers it). */

const CREATED_ID = "88888888-8888-4888-8888-888888888888";
const created: { properties?: Record<string, unknown>; name?: string }[] = [];
const secrets: { key: string; value: string }[] = [];
const order: string[] = [];

vi.mock("@scp/sdk", () => {
  class ScpApiError extends Error {}
  class ScpClient {
    secrets = {
      put: vi.fn(async (key: string, body: { value: string }) => {
        order.push("secret");
        secrets.push({ key, value: body.value });
      })
    };
    object(_type: string) {
      return {
        create: vi.fn(async (body: { name?: string; properties?: Record<string, unknown> }) => {
          order.push("system");
          created.push(body);
          return {
            id: CREATED_ID,
            urn: "urn:scp:execution-system:gitea",
            name: body.name ?? "gitea",
            typeId: "execution-system"
          };
        })
      };
    }
  }
  return { ScpClient, ScpApiError };
});

let configDir: string;
const savedEnv = { ...process.env };
let logs: string[] = [];

async function run(args: string[]): Promise<void> {
  const program: Command = (await import("./cli.js")).buildProgram();
  await program.parseAsync(["node", "scp", "connect", "gitea", ...args]);
}

beforeAll(async () => {
  await import("./cli.js");
}, 30_000);

beforeEach(async () => {
  logs = [];
  created.length = 0;
  secrets.length = 0;
  order.length = 0;
  configDir = await mkdtemp(path.join(tmpdir(), "scp-connect-gitea-test-"));
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
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(configDir, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

const BASE = ["--url", "https://gitea.example.com/", "--token", "pat-secret", "--no-validate"];

describe("scp connect gitea", () => {
  it("stores the token FIRST, then registers a kind=gitea system that names it", async () => {
    await run([...BASE, "--output", "json"]);
    expect(order).toEqual(["secret", "system"]);
    expect(secrets).toEqual([{ key: "gitea-gitea-token", value: "pat-secret" }]);
    expect(created[0]).toMatchObject({
      name: "gitea",
      properties: {
        kind: "gitea",
        serverUrl: "https://gitea.example.com",
        tokenSecretKey: "gitea-gitea-token"
      }
    });
    expect(created[0]!.properties).not.toHaveProperty("allowInternalEgress");
  });

  it("a pasted /api/v1 suffix is dropped (the plugin appends it), and --name/--token-key are honoured", async () => {
    await run([
      "--url",
      "https://git.internal/api/v1",
      "--token",
      "t",
      "--no-validate",
      "--name",
      "corp-gitea",
      "--token-key",
      "corp-key",
      "--allow-internal-egress"
    ]);
    expect(created[0]).toMatchObject({
      name: "corp-gitea",
      properties: {
        serverUrl: "https://git.internal",
        tokenSecretKey: "corp-key",
        allowInternalEgress: true
      }
    });
  });

  it("validates with Gitea's own `token` scheme, and a failed check warns without blocking", async () => {
    const fetched: { url: string; auth: string | undefined }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
        fetched.push({ url, auth: init?.headers?.["authorization"] });
        return { ok: false, status: 401 } as Response;
      })
    );
    await run(["--url", "https://gitea.example.com", "--token", "pat-secret"]);
    expect(fetched).toEqual([
      { url: "https://gitea.example.com/api/v1/user", auth: "token pat-secret" }
    ]);
    expect(created).toHaveLength(1);
  });

  it("the token never reaches stdout", async () => {
    await run(BASE);
    expect(logs.join("\n")).not.toContain("pat-secret");
    expect(logs.join("\n")).toContain(`Next: scp iac scaffold --from ${CREATED_ID}`);
  });
});
