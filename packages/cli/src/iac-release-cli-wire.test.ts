import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** `scp iac release` END TO END THROUGH COMMANDER: the command really reaches the `ScpClient.stacks`
 *  wrapper with the stack and every named row. See docs/coordination-as-code.md §328. */

const releaseCalls: { stack: string; body: Record<string, unknown> }[] = [];

vi.mock("@scp/sdk", () => {
  class ScpApiError extends Error {}
  class ScpClient {
    stacks = {
      release: async (stack: string, body: Record<string, unknown>) => {
        releaseCalls.push({ stack, body });
        const urns = (body["urns"] as string[] | undefined) ?? [];
        const edges =
          (body["relationships"] as { typeId: string; fromUrn: string; toUrn: string }[]) ?? [];
        return {
          stackName: stack,
          releasedObjects: urns.map((urn) => ({
            id: "019f0000-0000-7000-8000-000000000001",
            urn,
            typeId: "deployment-target"
          })),
          releasedRelationships: edges.map((e) => ({
            id: "019f0000-0000-7000-8000-000000000002",
            ...e
          }))
        };
      }
    };
  }
  return { ScpClient, ScpApiError, reconcileStaleClaimants: () => null };
});

let configDir: string;
const savedEnv = { ...process.env };
let logged: string[] = [];

async function run(args: string[]): Promise<void> {
  const { buildProgram } = await import("./cli.js");
  await buildProgram().parseAsync(["node", "scp", ...args]);
}

beforeEach(async () => {
  releaseCalls.length = 0;
  logged = [];
  configDir = await mkdtemp(path.join(tmpdir(), "scp-iac-release-cli-"));
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
    logged.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = undefined;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(configDir, { recursive: true, force: true });
  process.env = { ...savedEnv };
  process.exitCode = undefined;
});

describe("scp iac release (wire)", () => {
  it("sends the stack, every --urn and every --relationship triple", async () => {
    await run([
      "iac",
      "release",
      "agentkit-org",
      "--urn",
      "urn:scp:acme:deployment-target:shared",
      "--urn",
      "urn:scp:acme:user:alice",
      "--relationship",
      "contains urn:scp:acme:service:a urn:scp:acme:component:b"
    ]);
    expect(releaseCalls).toEqual([
      {
        stack: "agentkit-org",
        body: {
          urns: ["urn:scp:acme:deployment-target:shared", "urn:scp:acme:user:alice"],
          relationships: [
            {
              typeId: "contains",
              fromUrn: "urn:scp:acme:service:a",
              toUrn: "urn:scp:acme:component:b"
            }
          ]
        }
      }
    ]);
    expect(logged).toContain("released urn:scp:acme:deployment-target:shared (deployment-target)");
  });

  it("refuses to send a release naming nothing — there is no 'release everything' form", async () => {
    await expect(run(["iac", "release", "agentkit-org"])).rejects.toThrow(
      "name at least one --urn or --relationship"
    );
    expect(releaseCalls).toEqual([]);
  });

  it("refuses a malformed --relationship rather than guessing its parts", async () => {
    await expect(
      run(["iac", "release", "s", "--relationship", "contains urn:scp:acme:service:a"])
    ).rejects.toThrow('--relationship must be "<typeId> <fromUrn> <toUrn>"');
    expect(releaseCalls).toEqual([]);
  });
});
