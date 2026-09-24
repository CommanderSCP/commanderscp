import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command } from "commander";

/** `scp connect argocd`'s printed "Next:" hint. See docs/cli.md §106. */

const CREATED_ID = "99999999-9999-4999-8999-999999999999";
/** Every `object(...).create` body the command sent — hoisted so the mock factory can reach it. */
const created = vi.hoisted(() => ({ bodies: [] as unknown[] }));

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
        create: vi.fn(async (body: unknown) => {
          created.bodies.push(body);
          return {
            id: CREATED_ID,
            urn: "urn:scp:execution-system:argocd",
            name: "argocd",
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
  await program.parseAsync(["node", "scp", "connect", "argocd", ...args]);
}

beforeAll(async () => {
  await import("./cli.js");
}, 30_000);

beforeEach(async () => {
  logs = [];
  created.bodies.length = 0;
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

describe("scp connect argocd --authoring-* (M28.4, ADR-0055)", () => {
  const base = ["--url", "https://argocd.example.com", "--token", "shh", "--no-validate"];
  const repo = "https://gitea.example/platform/gitops.git";

  it("records the carrier on the execution-system as properties.authoring", async () => {
    await run([
      ...base,
      "--authoring-repo",
      repo,
      "--authoring-path",
      "charts/scp-authored-manifests",
      "--authoring-revision",
      "carrier-v1"
    ]);
    expect(created.bodies).toHaveLength(1);
    expect(
      (created.bodies[0] as { properties: Record<string, unknown> }).properties.authoring
    ).toEqual({
      repoURL: repo,
      path: "charts/scp-authored-manifests",
      targetRevision: "carrier-v1"
    });
  });

  it("writes NOTHING when the flags describe no carrier (no revision) — refused before registering", async () => {
    await expect(run([...base, "--authoring-repo", repo, "--authoring-path", "c"])).rejects.toThrow(
      /do not describe a carrier/
    );
    expect(created.bodies).toEqual([]);
  });

  it("without the flags, no authoring is declared — import-and-coordinate only", async () => {
    await run(base);
    expect(
      (created.bodies[0] as { properties: Record<string, unknown> }).properties
    ).not.toHaveProperty("authoring");
  });
});
