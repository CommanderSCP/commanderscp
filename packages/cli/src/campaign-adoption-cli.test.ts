import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command } from "commander";
import type { CampaignAdoptionResponse } from "@scp/schemas";

/**
 * M25.5 — THE CLI HALF of the campaign adoption read surface, `scp campaign adoption <id>`
 * ("has each of this campaign's components migrated yet?"). The route (`GET
 * /campaigns/{id}/adoption`) already existed; only the `ScpClient` wrapper and this CLI command
 * were missing. Same wiring-not-wording shape as `relay-builds-cli.test.ts`.
 */

const CAMPAIGN_ID = "77777777-7777-4777-8777-777777777777";

interface AdoptionCall {
  id: string;
}

const adoptionCalls: AdoptionCall[] = [];
let result: CampaignAdoptionResponse;

function campaignAdoptionResult(
  overrides: Partial<CampaignAdoptionResponse> = {}
): CampaignAdoptionResponse {
  return {
    campaignObjectId: CAMPAIGN_ID,
    evidence: { kind: "delivered" },
    targets: [
      {
        targetObjectId: "88888888-8888-4888-8888-888888888888",
        targetUrn: "urn:scp:component:checkout-api",
        targetName: "checkout-api",
        verdict: "adopted",
        summary: "delivered at 2026-08-30",
        observations: ["change delivered at 2026-08-30T12:00:00Z"]
      }
    ],
    unresolvedTargets: [],
    ...overrides
  };
}

vi.mock("@scp/sdk", () => {
  class ScpApiError extends Error {}
  class ScpClient {
    campaigns = {
      adoption: async (id: string) => {
        adoptionCalls.push({ id });
        return result;
      }
    };
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
  await program.parseAsync(["node", "scp", "campaign", "adoption", ...args]);
}

beforeAll(async () => {
  await import("./cli.js");
}, 30_000);

beforeEach(async () => {
  adoptionCalls.length = 0;
  result = campaignAdoptionResult();
  logs = [];
  configDir = await mkdtemp(path.join(tmpdir(), "scp-campaign-adoption-test-"));
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
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(configDir, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

function findCommand(root: Command, names: string[]): Command | undefined {
  let current: Command | undefined = root;
  for (const name of names) {
    current = current?.commands.find((c) => c.name() === name);
    if (current === undefined) return undefined;
  }
  return current;
}

describe("scp campaign adoption — the declared surface", () => {
  it("the command exists under `campaign`", async () => {
    const cmd = findCommand(await buildProgram(), ["campaign", "adoption"]);
    expect(cmd, "`scp campaign adoption` is missing").toBeDefined();
  });
});

describe("scp campaign adoption — what actually reaches the API", () => {
  it("the id argument is forwarded to the SDK call verbatim", async () => {
    await run([CAMPAIGN_ID]);
    expect(adoptionCalls).toHaveLength(1);
    expect(adoptionCalls[0]!.id).toBe(CAMPAIGN_ID);
  });

  it("--output json prints the response verbatim through the same call", async () => {
    result = campaignAdoptionResult({ unresolvedTargets: ["urn:scp:component:missing"] });
    await run([CAMPAIGN_ID, "--output", "json"]);
    const printed: unknown = JSON.parse(logs.join(""));
    expect(printed).toEqual(result);
  });
});

describe("scp campaign adoption — the rendered output", () => {
  it("prints each target's ref/verdict/summary and its observations", async () => {
    result = campaignAdoptionResult({
      targets: [
        {
          targetObjectId: "99999999-9999-4999-8999-999999999999",
          targetUrn: "urn:scp:component:payments-api",
          verdict: "not_adopted",
          summary: "no delivered change observed yet",
          observations: ["no matching change on the target's default branch"]
        }
      ]
    });
    await run([CAMPAIGN_ID]);
    const text = logs.join("\n");
    expect(text).toContain("urn:scp:component:payments-api");
    expect(text).toContain("not_adopted");
    expect(text).toContain("no delivered change observed yet");
    expect(text).toContain("no matching change on the target's default branch");
  });

  it("prints unresolved targets when present", async () => {
    result = campaignAdoptionResult({ unresolvedTargets: ["urn:scp:component:deleted-one"] });
    await run([CAMPAIGN_ID]);
    const text = logs.join("\n");
    expect(text).toContain("Unresolved targets");
    expect(text).toContain("urn:scp:component:deleted-one");
  });
});
