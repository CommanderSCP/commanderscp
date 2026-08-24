import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command } from "commander";
import type { RelayBuild } from "@scp/schemas";

/**
 * M13.1b — THE CLI HALF OF THE AUTO-RELAY BUILD LEDGER'S OPERATOR READ SURFACE, `scp federation
 * relay-builds`.
 *
 * WHY THE WIRE AND NOT ONLY THE OPTIONS. A build in which `--status`/`--limit` exist, the help text
 * is perfect, and the action drops them on the floor before calling the SDK passes a surface-only
 * test completely. That "wording, not behaviour" shape is this project's second-most-common
 * recurring bug (`outpost-reconcile-precondition.test.ts`, `scan-exclusion-admissions-cli.test.ts`),
 * so `@scp/sdk` is mocked wholesale here and every assertion is against the ACTUAL call the mock
 * recorded, plus the rendered table text — the CLI consumes only the SDK (charter principle 3), so
 * intercepting it is the honest seam.
 */

interface ListCall {
  opts: { status?: string; limit?: number };
}

const listCalls: ListCall[] = [];
let listed: RelayBuild[] = [];

function relayBuild(overrides: Partial<RelayBuild> = {}): RelayBuild {
  return {
    changeObjectId: "11111111-2222-4333-8444-555555555555",
    sourceChangeObjectId: "urn:scp:foreign:change:abc123",
    status: "pending",
    attempts: 2,
    failedAttempts: 1,
    nextAttemptAt: "2026-08-23T00:00:00.000Z",
    claimedUntil: null,
    lastReason: "artifact digest mismatch",
    lastDecisionId: "22222222-3333-4444-8555-666666666666",
    tarballPath: null,
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
    ...overrides
  };
}

vi.mock("@scp/sdk", () => {
  class ScpApiError extends Error {}
  class ScpClient {
    federation = {
      listRelayBuilds: async (opts: { status?: string; limit?: number } = {}) => {
        listCalls.push({ opts });
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
  await program.parseAsync(["node", "scp", "federation", "relay-builds", ...args]);
}

// Warm the dynamic import in a hook rather than charging it to the first `it` — the whole CLI
// module graph is transformed on first import (`outpost-reconcile-precondition.test.ts`'s reason),
// and the import must stay lazy so the SDK mock above is installed before the graph is evaluated.
beforeAll(async () => {
  await import("./cli.js");
}, 30_000);

beforeEach(async () => {
  listCalls.length = 0;
  listed = [relayBuild()];
  logs = [];
  configDir = await mkdtemp(path.join(tmpdir(), "scp-relay-builds-test-"));
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

describe("scp federation relay-builds — the declared surface", () => {
  it("the command exists under `federation`, with --status and --limit", async () => {
    const cmd = findCommand(await buildProgram(), ["federation", "relay-builds"]);
    expect(cmd, "`scp federation relay-builds` is missing").toBeDefined();
    expect(cmd!.options.find((o) => o.long === "--status")).toBeDefined();
    expect(cmd!.options.find((o) => o.long === "--limit")).toBeDefined();
  });

  it("the description names where rows exist and the exit from `exhausted`", async () => {
    // Owner ask: an operator reading `--help` must learn BOTH that this is role-agnostic (empty,
    // never a 409, off a retrans) AND how to clear an exhausted row — mirroring the runbook.
    const cmd = findCommand(await buildProgram(), ["federation", "relay-builds"])!;
    expect(cmd.description()).toMatch(/role:retrans/);
    expect(cmd.description()).toMatch(/honestly empty/);
    expect(cmd.description()).toContain("scp federation relay --change");
  });
});

describe("scp federation relay-builds — what actually reaches the API", () => {
  it("no flags: calls the SDK with an EMPTY opts object (no status, no limit)", async () => {
    await run([]);
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0]!.opts).toEqual({});
  });

  it("--status is forwarded to the SDK call verbatim", async () => {
    await run(["--status", "exhausted"]);
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0]!.opts.status).toBe("exhausted");
    expect(listCalls[0]!.opts.limit).toBeUndefined();
  });

  it("--limit is forwarded as a NUMBER, not the raw string", async () => {
    await run(["--limit", "25"]);
    expect(listCalls[0]!.opts.limit).toBe(25);
    expect(typeof listCalls[0]!.opts.limit).toBe("number");
  });

  it("--status and --limit together both reach the call", async () => {
    await run(["--status", "pending", "--limit", "10"]);
    expect(listCalls[0]!.opts).toEqual({ status: "pending", limit: 10 });
  });

  it("--output json prints the response verbatim through the same call", async () => {
    listed = [relayBuild({ status: "built" })];
    await run(["--output", "json"]);
    const printed: unknown = JSON.parse(logs.join(""));
    expect(printed).toEqual(listed);
  });
});

describe("scp federation relay-builds — the rendered table", () => {
  it("prints change/status/attempts/failedAttempts/nextAttempt as the response states", async () => {
    listed = [
      relayBuild({
        changeObjectId: "33333333-4444-4555-8666-777777777777",
        status: "exhausted",
        attempts: 5,
        failedAttempts: 4,
        nextAttemptAt: "2026-08-23T01:00:00.000Z"
      })
    ];
    await run([]);
    const text = logs.join("\n");
    expect(text).toContain("33333333-4444-4555-8666-777777777777");
    expect(text).toContain("exhausted");
    // attempts/failedAttempts printed EXACTLY as the response states — never a derived "N/cap".
    expect(text).toContain("5");
    expect(text).toContain("4");
    expect(text).not.toMatch(/5\s*\/\s*\d/);
    expect(text).toContain("2026-08-23T01:00:00.000Z");
  });

  it("an OMITTED (null) sourceChangeObjectId/claimedUntil/lastReason/decisionId render `-`, never `undefined` or blank", async () => {
    listed = [
      relayBuild({
        sourceChangeObjectId: null,
        claimedUntil: null,
        lastReason: null,
        lastDecisionId: null
      })
    ];
    await run([]);
    const text = logs.join("\n");
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("null");
    // one row's worth of `-` for the four nullable columns (plus header line has none)
    const dashCount = (text.match(/(^|\s)-(\s|$)/gm) ?? []).length;
    expect(dashCount).toBeGreaterThanOrEqual(4);
  });

  it("real nullable values survive verbatim — the guard must distinguish, not blank everything", async () => {
    listed = [
      relayBuild({
        sourceChangeObjectId: "urn:scp:foreign:change:xyz",
        claimedUntil: "2026-08-23T02:00:00.000Z",
        lastReason: "cosign verify failed",
        lastDecisionId: "44444444-5555-4666-8777-888888888888"
      })
    ];
    await run([]);
    const text = logs.join("\n");
    expect(text).toContain("urn:scp:foreign:change:xyz");
    expect(text).toContain("2026-08-23T02:00:00.000Z");
    expect(text).toContain("cosign verify failed");
    expect(text).toContain("44444444-5555-4666-8777-888888888888");
  });

  it("an empty ledger prints the table printer's no-results line, not a crash", async () => {
    listed = [];
    await expect(run([])).resolves.not.toThrow();
    expect(logs.join("\n")).toContain("(no results)");
  });
});
