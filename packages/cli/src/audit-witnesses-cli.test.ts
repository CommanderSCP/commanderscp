import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command } from "commander";
import type { AuditWitness } from "@scp/schemas";

/**
 * Federation audit witness (multi-region-instance-resilience.md §7.2.7) — THE CLI HALF of the
 * post-failover runbook's peers-witness comparison read surface (resilience runbook §7.2 step 5),
 * `scp audit witnesses --origin <domainId>`.
 *
 * Same wiring-not-wording shape as `relay-builds-cli.test.ts`: `@scp/sdk` is mocked wholesale and
 * every assertion is against the ACTUAL call the mock recorded, plus the rendered table text.
 */

interface ListCall {
  originDomainId: string;
}

const listCalls: ListCall[] = [];
let listed: AuditWitness[] = [];

function auditWitness(overrides: Partial<AuditWitness> = {}): AuditWitness {
  return {
    originDomainId: "peer-domain-1",
    sequence: 1,
    auditEventId: "55555555-5555-4555-8555-555555555555",
    contentHash: "deadbeef",
    witnessedAt: "2026-08-30T12:00:00.000Z",
    ...overrides
  };
}

vi.mock("@scp/sdk", () => {
  class ScpApiError extends Error {}
  class ScpClient {
    federation = {
      listAuditWitnesses: async (originDomainId: string) => {
        listCalls.push({ originDomainId });
        return listed;
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
  await program.parseAsync(["node", "scp", "audit", "witnesses", ...args]);
}

beforeAll(async () => {
  await import("./cli.js");
}, 30_000);

beforeEach(async () => {
  listCalls.length = 0;
  listed = [auditWitness()];
  logs = [];
  configDir = await mkdtemp(path.join(tmpdir(), "scp-audit-witnesses-test-"));
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

describe("scp audit witnesses — the declared surface", () => {
  it("the command exists under `audit`, with a required --origin", async () => {
    const cmd = findCommand(await buildProgram(), ["audit", "witnesses"]);
    expect(cmd, "`scp audit witnesses` is missing").toBeDefined();
    const originOpt = cmd!.options.find((o) => o.long === "--origin");
    expect(originOpt).toBeDefined();
    expect(originOpt!.mandatory).toBe(true);
  });
});

describe("scp audit witnesses — what actually reaches the API", () => {
  it("--origin is forwarded to the SDK call verbatim", async () => {
    await run(["--origin", "peer-domain-1"]);
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0]!.originDomainId).toBe("peer-domain-1");
  });

  it("--output json prints the response verbatim through the same call", async () => {
    listed = [auditWitness({ sequence: 7 })];
    await run(["--origin", "peer-domain-1", "--output", "json"]);
    const printed: unknown = JSON.parse(logs.join(""));
    expect(printed).toEqual(listed);
  });

  it("missing --origin refuses without ever calling the SDK", async () => {
    await expect(run([])).rejects.toThrow();
    expect(listCalls).toHaveLength(0);
  });
});

describe("scp audit witnesses — the rendered table", () => {
  it("prints origin/sequence/auditEventId/contentHash/witnessedAt as the response states", async () => {
    listed = [
      auditWitness({
        originDomainId: "peer-domain-9",
        sequence: 42,
        auditEventId: "66666666-6666-4666-8666-666666666666",
        contentHash: "cafef00d",
        witnessedAt: "2026-08-30T13:00:00.000Z"
      })
    ];
    await run(["--origin", "peer-domain-9"]);
    const text = logs.join("\n");
    expect(text).toContain("peer-domain-9");
    expect(text).toContain("42");
    expect(text).toContain("66666666-6666-4666-8666-666666666666");
    expect(text).toContain("cafef00d");
    expect(text).toContain("2026-08-30T13:00:00.000Z");
  });

  it("an empty witness set prints the table printer's no-results line, not a crash", async () => {
    listed = [];
    await expect(run(["--origin", "peer-domain-1"])).resolves.not.toThrow();
    expect(logs.join("\n")).toContain("(no results)");
  });
});
