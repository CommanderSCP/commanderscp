import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** M28.3 — THE COMMANDS, end to end through commander, not the helpers: `scp change propose
 *  --apply-plan` really sends the apply declaration, and `scp change explain` really prints each
 *  target's plan evidence. A helper test stays green when the command stops calling it. */

const proposeCalls: Record<string, unknown>[] = [];
const PLAN_ID = "01a0d160-9479-7769-91ea-d3c1cf6dd393";
const DIGEST = "7c1e".padEnd(64, "0");

vi.mock("@scp/sdk", () => {
  class ScpApiError extends Error {}
  class ScpClient {
    changes = {
      propose: async (body: Record<string, unknown>) => {
        proposeCalls.push(body);
        return {
          id: "019f0000-0000-7000-8000-00000000c0a1",
          name: body["name"],
          state: "proposed",
          emergency: false,
          properties: body["properties"] ?? {}
        };
      },
      explain: async (id: string) => ({
        change: { id, name: "prod-us-east-1 network", state: "validating" },
        plan: {
          id: "019f0000-0000-7000-8000-00000000p1a0",
          status: "completed",
          waves: [
            {
              waveIndex: 0,
              name: null,
              status: "succeeded",
              targets: [
                {
                  targetObjectId: "019f0000-0000-7000-8000-0000000000t1",
                  targetName: "prod-us-east-1",
                  status: "succeeded",
                  observed: { plan: { ref: DIGEST, add: 2, change: 0, destroy: 1 } }
                },
                {
                  targetObjectId: "019f0000-0000-7000-8000-0000000000t2",
                  targetName: "gamma",
                  status: "succeeded",
                  observed: null
                }
              ]
            }
          ]
        },
        decisions: [],
        controlRuns: [],
        waitStatus: null,
        stageDependencyStatus: null
      })
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
  proposeCalls.length = 0;
  logged = [];
  configDir = await mkdtemp(path.join(tmpdir(), "scp-infra-cli-"));
  process.env.SCP_CONFIG_DIR = configDir;
  delete process.env.SCP_OPERATOR_TOKEN;
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

describe("scp change propose --apply-plan (wire)", () => {
  it("sends Type infrastructure and properties.infrastructure.applyPlan", async () => {
    await run([
      "change",
      "propose",
      "--name",
      "apply prod network",
      "--targets",
      "019f0000-0000-7000-8000-0000000000t1",
      "--apply-plan",
      PLAN_ID,
      "--properties",
      '{"ticket":"OPS-1"}'
    ]);
    expect(proposeCalls).toHaveLength(1);
    expect(proposeCalls[0]).toMatchObject({
      name: "apply prod network",
      targets: ["019f0000-0000-7000-8000-0000000000t1"],
      type: "infrastructure",
      properties: { ticket: "OPS-1", infrastructure: { applyPlan: PLAN_ID } }
    });
  });

  it("without the flag, sends no infrastructure declaration at all", async () => {
    await run([
      "change",
      "propose",
      "--name",
      "plan",
      "--targets",
      "t1",
      "--type",
      "infrastructure"
    ]);
    expect(proposeCalls[0]!["properties"]).toBeUndefined();
    expect(proposeCalls[0]!["type"]).toBe("infrastructure");
  });
});

describe("scp change explain (wire)", () => {
  it("prints the plan evidence on the planned target, and nothing on the other", async () => {
    await run(["change", "explain", PLAN_ID]);
    const out = logged.join("\n");
    expect(out).toContain(
      "prod-us-east-1: succeeded — plan 7c1e00000000 · 2 add / 0 change / 1 destroy"
    );
    expect(out).toMatch(/gamma: succeeded$/m);
  });
});
