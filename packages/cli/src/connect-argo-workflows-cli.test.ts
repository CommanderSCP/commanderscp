import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command } from "commander";

/** `scp connect argo-workflows` — the registration that makes the build lane bindable.
 *
 *  The property under test is `namespace`. The argo-workflows plugin REQUIRES it and interpolates
 *  it into every API path, and a system-backed binding builds its plugin config from the
 *  execution-system's properties — so a system registered without it submits to
 *  `/api/v1/workflows/undefined/submit`. */

const CREATED_ID = "99999999-9999-4999-8999-999999999999";
const created: { properties?: Record<string, unknown>; name?: string }[] = [];

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
        create: vi.fn(async (body: { name?: string; properties?: Record<string, unknown> }) => {
          created.push(body);
          return {
            id: CREATED_ID,
            urn: "urn:scp:execution-system:argo-workflows",
            name: body.name ?? "argo-workflows",
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

async function buildProgram(): Promise<Command> {
  const mod = await import("./cli.js");
  return mod.buildProgram();
}

async function run(args: string[]): Promise<void> {
  const program = await buildProgram();
  await program.parseAsync(["node", "scp", "connect", "argo-workflows", ...args]);
}

beforeAll(async () => {
  await import("./cli.js");
}, 30_000);

beforeEach(async () => {
  logs = [];
  created.length = 0;
  configDir = await mkdtemp(path.join(tmpdir(), "scp-connect-argo-wf-test-"));
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

const BASE = [
  "--url",
  "https://argo-server.scp-argo-workflows.svc:2746",
  "--token",
  "shh",
  "--namespace",
  "scp-argo-workflows",
  "--no-validate",
  "--output",
  "json"
];

describe("scp connect argo-workflows", () => {
  it("records `namespace` on the execution-system — the key the plugin cannot run without", async () => {
    await run(BASE);
    expect(created).toHaveLength(1);
    expect(created[0]?.properties).toMatchObject({
      kind: "argo-workflows",
      serverUrl: "https://argo-server.scp-argo-workflows.svc:2746",
      namespace: "scp-argo-workflows",
      tokenSecretKey: "argo-workflows-argo-workflows-token"
    });
  });

  it("REFUSES to register without --namespace rather than creating an unusable system", async () => {
    // commander reports the missing option and exits; what matters is that it NAMES the option and
    // that nothing was created — a system registered without a namespace is unusable at submit.
    const withoutNamespace = BASE.filter(
      (arg, i) => arg !== "--namespace" && BASE[i - 1] !== "--namespace"
    );
    let stderr = "";
    const write = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write);
    try {
      await run(withoutNamespace).catch(() => undefined);
    } finally {
      write.mockRestore();
    }
    expect(stderr).toMatch(/--namespace/);
    expect(created, "nothing may be created when the required option is absent").toHaveLength(0);
  });

  it("omits allowInternalEgress unless declared, and sets it when asked", async () => {
    await run(BASE);
    expect(created[0]?.properties).not.toHaveProperty("allowInternalEgress");
    created.length = 0;
    await run([...BASE, "--allow-internal-egress"]);
    expect(created[0]?.properties).toMatchObject({ allowInternalEgress: true });
  });

  it("points the operator at the BUILD LANE bind, which is what fills the Build step", async () => {
    await run(BASE);
    const text = logs.join("\n");
    expect(text).toContain(`--execution-system ${CREATED_ID} --type image --lane build`);
  });
});
