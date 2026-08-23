import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ComponentDependencyBumpsResponse,
  ComponentDependencyInventoryResponse
} from "@scp/schemas";

/**
 * WHAT THIS FILE PINS THAT `dependency-subscription-cli.test.ts` CANNOT: that the two M21.6 read
 * verbs' ACTION BODIES actually call the SDK and feed the printers.
 *
 * The closed-list test proves `.command("inventory")` / `.command("bumps")` are REGISTERED, and the
 * pure printers are unit-pinned; but a Commander `.action()` closure is unreachable from either. A
 * mutation that inserted `return;` as the first statement of BOTH actions left the whole package
 * green (116/116) — the M21 lesson ("component built, never installed") one layer down. So here the
 * commands are DRIVEN through `buildProgram().parseAsync([...])` against a stubbed SDK (the
 * `outpost-reconcile-precondition.test.ts` pattern): what the verb asked the SDK for, and what it
 * printed off the answer, are the assertions.
 *
 * MUTATIONS WATCHED TO FAIL: `return;` before `clientFromStoredCredentials` in the inventory
 * action → both inventory cases RED (no SDK call, no header, no row); the same in the bumps action →
 * both bumps cases RED; restored.
 */

const inventoryCalls: { idOrUrn: string; query: unknown }[] = [];
const bumpsCalls: { idOrUrn: string; query: unknown }[] = [];

/** What the stubbed SDK answers NEXT — a test swaps in a `managedHere: false` envelope, or a
 *  stamped inventory / a URL-carrying bump, and the action must print off THAT answer. */
let nextInventory: ComponentDependencyInventoryResponse;
let nextBumps: ComponentDependencyBumpsResponse;

const COMPONENT_ID = "0198f000-0000-7000-8000-000000000010";
const LINE_ID = "0198f000-0000-7000-8000-000000000011";

const inventoryResponse: ComponentDependencyInventoryResponse = {
  component: { id: COMPONENT_ID, name: "checkout-api", domainId: null },
  dependencyManagement: { managedHere: true, reason: "commander" },
  ingestion: null,
  lastIngestionDecision: null,
  componentGate: { enabled: true, reason: "enabled", contributions: [] },
  rows: [
    {
      line: {
        id: LINE_ID,
        ecosystem: "npm",
        coordinate: "@acme/lib",
        major: "1",
        tagPattern: null
      },
      manifestPath: "package.json",
      declaredVersion: "^1.2.3",
      resolvedVersion: "1.2.3",
      resolvedDigest: null,
      observedRepo: "acme/app",
      observedRef: "refs/heads/main",
      observedAt: "2026-08-16T00:00:00.000Z",
      head: {
        latestVersion: "1.4.0",
        latestDigest: null,
        latestObservedAt: "2026-08-16T01:00:00.000Z"
      },
      producer: null,
      subscription: {
        enabled: true,
        reason: "enabled",
        granularity: "minor_and_patch",
        delivery: "pull_request",
        contributions: []
      }
    },
    {
      line: {
        id: LINE_ID,
        ecosystem: "go",
        coordinate: "golang.org/x/net",
        major: "0",
        tagPattern: null
      },
      manifestPath: "go.mod",
      declaredVersion: "v0.30.0",
      resolvedVersion: "v0.30.0",
      resolvedDigest: null,
      observedRepo: "acme/app",
      observedRef: "refs/heads/main",
      observedAt: "2026-08-16T00:00:00.000Z",
      head: { latestVersion: null, latestDigest: null, latestObservedAt: null },
      producer: null,
      subscription: {
        enabled: false,
        reason: "not_enabled",
        granularity: "patch",
        delivery: "pull_request",
        contributions: []
      }
    }
  ],
  nextCursor: "next-page-token"
};

const bumpsResponse: ComponentDependencyBumpsResponse = {
  component: { id: COMPONENT_ID, name: "checkout-api", domainId: null },
  dependencyManagement: { managedHere: true, reason: "commander" },
  rows: [
    {
      changeId: "0198f000-0000-7000-8000-000000000020",
      changeName: "bump @acme/lib 1.2.3 -> 1.4.0",
      line: { id: LINE_ID, ecosystem: "npm", coordinate: "@acme/lib", major: "1" },
      manifestPath: "package.json",
      fromVersion: "1.2.3",
      toVersion: "1.4.0",
      repo: "acme/app",
      baseBranch: "main",
      authoredRef: "refs/heads/scp/dep-bump/0198f000-0000-7000-8000-000000000020",
      pullRequestNumber: 42,
      pullRequestUrl: null,
      headCommit: "abc123",
      dispatchedAt: "2026-08-16T03:00:00.000Z",
      mergedAt: null,
      delivery: "pull_request",
      deliveryReason: "first look is always a pull request",
      merge: null
    }
  ],
  nextCursor: null
};

vi.mock("@scp/sdk", () => {
  class ScpApiError extends Error {
    status?: number;
    problem?: Record<string, unknown>;
    constructor(
      message: string,
      opts: { status?: number; problem?: Record<string, unknown> } = {}
    ) {
      super(message);
      this.status = opts.status;
      this.problem = opts.problem;
    }
  }
  class ScpClient {
    dependencySubscriptions = {
      inventory: async (idOrUrn: string, query: unknown) => {
        inventoryCalls.push({ idOrUrn, query });
        return nextInventory;
      },
      bumps: async (idOrUrn: string, query: unknown) => {
        bumpsCalls.push({ idOrUrn, query });
        return nextBumps;
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
  await buildProgram().parseAsync(["node", "scp", "dependency-subscriptions", ...args]);
}

// Warm the dynamic import once, in a hook (see outpost-reconcile-precondition.test.ts for why).
// No per-hook budget: the package's declared hookTimeout (vitest.config.ts, 30s) governs — a
// trailing number here would be a SECOND owner of the same deadline (#265's hook census refuses it).
beforeAll(async () => {
  await import("./cli.js");
});

beforeEach(async () => {
  inventoryCalls.length = 0;
  bumpsCalls.length = 0;
  nextInventory = inventoryResponse;
  nextBumps = bumpsResponse;
  logged = [];
  configDir = await mkdtemp(path.join(tmpdir(), "scp-dep-read-verbs-"));
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

describe("scp dependency-subscriptions inventory — the action calls the SDK and prints off the answer", () => {
  it("calls `dependencySubscriptions.inventory(<component>, {})` and prints the envelope, then one row per (line × manifest), then the cursor pointer", async () => {
    await run(["inventory", "--component", COMPONENT_ID]);
    expect(inventoryCalls).toEqual([{ idOrUrn: COMPONENT_ID, query: {} }]);
    const out = logged.join("\n");
    // The envelope FIRST (component; a null stamp is NEVER ATTEMPTED, never "no dependencies").
    expect(out).toMatch(/component: checkout-api/);
    expect(out).toMatch(/ingestion: never attempted/);
    expect(out).not.toMatch(/not managed on this instance/);
    expect(out).toMatch(/component gate: enabled/);
    // The rows, off the printer: coordinate verbatim, `-` for a head not observed.
    expect(out).toContain("@acme/lib");
    expect(out).toContain("golang.org/x/net");
    expect(out).toMatch(/enabled \(minor_and_patch, pull_request\)/);
    expect(out).not.toMatch(/no rows on record/);
    expect(out).toContain("more rows: --cursor next-page-token");
  });

  it("threads --limit/--cursor into the SDK call and applies --ecosystem as a DISPLAY filter over the fetched page", async () => {
    await run([
      "inventory",
      "--component",
      "urn:scp:acme:component:checkout-api",
      "--limit",
      "50",
      "--cursor",
      "abc",
      "--ecosystem",
      "go"
    ]);
    // The SDK call carries the page query and NEVER the ecosystem (the route has no such filter).
    expect(inventoryCalls).toEqual([
      { idOrUrn: "urn:scp:acme:component:checkout-api", query: { limit: 50, cursor: "abc" } }
    ]);
    const out = logged.join("\n");
    expect(out).toContain("golang.org/x/net");
    expect(out).not.toContain("@acme/lib");
  });

  it("prints the ingestion STAMP line off a stamped answer — ok + 0 rows reads 'no dependencies declared', and the empty-rows note points at it", async () => {
    nextInventory = {
      ...inventoryResponse,
      ingestion: {
        lastAttemptAt: "2026-08-16T02:00:00.000Z",
        source: "loop",
        outcome: "ok",
        rowsWritten: 0,
        detail: null,
        manifests: [
          {
            repo: "acme/app",
            path: "package.json",
            outcome: "ok",
            rows: 0,
            at: "2026-08-16T02:00:00.000Z"
          }
        ]
      },
      rows: [],
      nextCursor: null
    };
    await run(["inventory", "--component", COMPONENT_ID]);
    const out = logged.join("\n");
    expect(out).toContain("ingestion: ok — no dependencies declared (read 1 manifest(s))");
    expect(out).toContain("acme/app:package.json=ok");
    expect(out).toMatch(/no rows on record/);
  });

  it("when the server says dependencies are NOT managed here, prints the component line and the posture and SKIPS the stamp, the gate and the table", async () => {
    nextInventory = {
      ...inventoryResponse,
      dependencyManagement: { managedHere: false, reason: "outpost" }
    };
    await run(["inventory", "--component", COMPONENT_ID]);
    // The SDK was still called — the route answers 200 there; the CLI merely refuses to narrate
    // an envelope that is not to be interpreted.
    expect(inventoryCalls).toEqual([{ idOrUrn: COMPONENT_ID, query: {} }]);
    const out = logged.join("\n");
    expect(out).toMatch(/component: checkout-api/);
    expect(out).toContain("dependencies are not managed on this instance (outpost)");
    expect(out).not.toMatch(/ingestion:/);
    expect(out).not.toMatch(/component gate:/);
    expect(out).not.toContain("@acme/lib");
    expect(out).not.toMatch(/more rows/);
    // …and --output json still hands back the whole answer, posture included.
    logged = [];
    await run(["inventory", "--component", COMPONENT_ID, "--output", "json"]);
    expect(JSON.parse(logged.join("\n")).dependencyManagement).toEqual({
      managedHere: false,
      reason: "outpost"
    });
  });
});

describe("scp dependency-subscriptions bumps — the action calls the SDK and prints off the answer", () => {
  it("calls `dependencySubscriptions.bumps(<component>, {})` and prints the component line and a `#n` row", async () => {
    await run(["bumps", "--component", COMPONENT_ID]);
    expect(bumpsCalls).toEqual([{ idOrUrn: COMPONENT_ID, query: {} }]);
    const out = logged.join("\n");
    expect(out).toContain(`component: checkout-api (${COMPONENT_ID})`);
    expect(out).toContain("#42");
    expect(out).toContain("1.2.3 -> 1.4.0");
    // Never a composed link.
    expect(out).not.toMatch(/https?:\/\//);
    expect(out).not.toMatch(/more rows/);
    expect(out).not.toMatch(/not managed on this instance/);
  });

  it("the PR column prints the STORED URL when the server sent one (in place of `#n`) — still never composed", async () => {
    nextBumps = {
      ...bumpsResponse,
      rows: [{ ...bumpsResponse.rows[0]!, pullRequestUrl: "https://git.example/acme/app/pulls/42" }]
    };
    await run(["bumps", "--component", COMPONENT_ID]);
    const out = logged.join("\n");
    expect(out).toContain("https://git.example/acme/app/pulls/42");
    expect(out).not.toContain("#42");
  });

  it("when the server says dependencies are NOT managed here, prints the component line and the posture and SKIPS the table", async () => {
    nextBumps = {
      ...bumpsResponse,
      dependencyManagement: { managedHere: false, reason: "role_undeclared" }
    };
    await run(["bumps", "--component", COMPONENT_ID]);
    expect(bumpsCalls).toEqual([{ idOrUrn: COMPONENT_ID, query: {} }]);
    const out = logged.join("\n");
    expect(out).toContain(`component: checkout-api (${COMPONENT_ID})`);
    expect(out).toContain("dependencies are not managed on this instance (role_undeclared)");
    // No table: neither the row's PR number nor the "(no results)" placeholder.
    expect(out).not.toContain("#42");
    expect(out).not.toMatch(/no results/);
  });

  it("--output json prints the response verbatim (still through the SDK call)", async () => {
    await run(["bumps", "--component", COMPONENT_ID, "--limit", "5", "--output", "json"]);
    expect(bumpsCalls).toEqual([{ idOrUrn: COMPONENT_ID, query: { limit: 5 } }]);
    expect(JSON.parse(logged.join("\n"))).toEqual(bumpsResponse);
  });
});
