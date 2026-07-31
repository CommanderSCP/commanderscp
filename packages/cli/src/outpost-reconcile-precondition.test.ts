import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutpostConfig } from "@scp/schemas";

/**
 * WHAT THIS FILE PINS THAT THE SURFACE TEST CANNOT: that `scp federation outpost reconcile`
 * ACTUALLY SENDS the `?ifClaimant=` precondition, derived from a listing it took itself.
 *
 * The surface test can only read the command's OPTIONS — so a build in which the flag exists, the
 * help text is perfect, and the action quietly issues the bare call passes it completely. That
 * "wording, not behaviour" shape is this project's second-most-common recurring bug, so the wire
 * argument is asserted here against a stubbed SDK, and the stub is what a mutation flips.
 *
 * `@scp/sdk` is mocked wholesale (the `login-base-url.test.ts` pattern): the CLI consumes only the
 * SDK, so intercepting it is the honest seam for "what did the command ask the API to do".
 */

interface ReconcileCall {
  peerDomainId: string;
  opts: { keep?: string; ifClaimants?: readonly string[] };
}

const reconcileCalls: ReconcileCall[] = [];
const listCalls: number[] = [];
let reconcileImpl: (call: ReconcileCall) => unknown = () => ({
  config: {},
  adoptedObjectId: null,
  removedShadowObjectIds: [],
  removedLocalObjectIds: []
});
let listed: OutpostConfig[] = [];

// REAL v4 UUIDs, not readable placeholders: `OutpostReconcileStaleProblemSchema` is what the CLI
// narrows the 412 body with, and it rejects a malformed id — a hand-written "aaaa…" would make this
// file pass or fail for a reason that has nothing to do with the behaviour under test.
const PEER = randomUUID();
const OTHER_PEER = randomUUID();
const SHADOW_ID = randomUUID();
const LOCAL_ID = randomUUID();
const FIRST_ID = randomUUID();
const SECOND_ID = randomUUID();
const APPEARED_ID = randomUUID();

function claimant(over: Partial<OutpostConfig> & { objectId: string }): OutpostConfig {
  return {
    urn: `urn:scp:test:outpost:${over.objectId}`,
    name: over.objectId,
    peerDomainId: PEER,
    trustTier: null,
    originDomainId: randomUUID(),
    originIsSelf: false,
    provenance: null,
    revision: 1,
    version: 1,
    unknownFields: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over
  } as OutpostConfig;
}

vi.mock("@scp/sdk", async () => {
  const { OutpostReconcileStaleProblemSchema } = await import("@scp/schemas");
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
    federation = {
      listOutposts: async () => {
        listCalls.push(Date.now());
        return listed;
      },
      reconcileOutpost: async (
        peerDomainId: string,
        opts: { keep?: string; ifClaimants?: readonly string[] } = {}
      ) => {
        const call = { peerDomainId, opts };
        reconcileCalls.push(call);
        const result = reconcileImpl(call);
        if (result instanceof Error) throw result;
        return result;
      }
    };
  }
  return {
    ScpClient,
    ScpApiError,
    // The real narrowing helper — a stub that always returned the raw member would hide exactly the
    // schema mismatch the helper exists to catch.
    reconcileStaleClaimants: (err: unknown) => {
      if (!(err instanceof ScpApiError) || err.status !== 412) return null;
      const parsed = OutpostReconcileStaleProblemSchema.safeParse(err.problem);
      return parsed.success ? parsed.data.claimants : null;
    }
  };
});

let configDir: string;
const savedEnv = { ...process.env };

async function runReconcile(args: string[]): Promise<void> {
  const { buildProgram } = await import("./cli.js");
  await buildProgram().parseAsync(["node", "scp", "federation", "outpost", "reconcile", ...args]);
}

beforeEach(async () => {
  reconcileCalls.length = 0;
  listCalls.length = 0;
  listed = [];
  reconcileImpl = () => ({
    config: claimant({ objectId: randomUUID() }),
    adoptedObjectId: null,
    removedShadowObjectIds: [],
    removedLocalObjectIds: []
  });
  configDir = await mkdtemp(path.join(tmpdir(), "scp-reconcile-test-"));
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
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = undefined;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(configDir, { recursive: true, force: true });
  process.env = { ...savedEnv };
  process.exitCode = undefined;
});

describe("scp federation outpost reconcile — the precondition on the wire", () => {
  it("reads FIRST and sends one token per claimant of THAT peer", async () => {
    listed = [
      claimant({ objectId: FIRST_ID, version: 3 }),
      claimant({ objectId: SECOND_ID, version: 7 }),
      claimant({ objectId: randomUUID(), version: 1, peerDomainId: OTHER_PEER })
    ];
    await runReconcile(["--peer", PEER]);

    expect(listCalls).toHaveLength(1);
    expect(reconcileCalls).toHaveLength(1);
    // The token is the SET the preview was computed from — and only this peer's rows.
    expect(reconcileCalls[0]!.opts.ifClaimants).toEqual([`${FIRST_ID}:3`, `${SECOND_ID}:7`]);
  });

  it("prints the per-row consequences BEFORE the call, including the PROPAGATING delete", async () => {
    listed = [
      claimant({ objectId: SHADOW_ID, provenance: "manual" }),
      claimant({ objectId: LOCAL_ID, originIsSelf: true })
    ];
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    await runReconcile(["--peer", PEER, "--keep", SHADOW_ID]);
    const before = logged.join("\n");
    expect(before).toMatch(new RegExp(`ADOPT\\s+${SHADOW_ID}`));
    expect(before).toMatch(new RegExp(`DELETE\\s+${LOCAL_ID}`));
    expect(before).toMatch(/PROPAGATE/);
  });

  it("--no-precondition sends the BARE call — the escape is real, and it is the only way to get one", async () => {
    listed = [claimant({ objectId: FIRST_ID, version: 3 })];
    await runReconcile(["--peer", PEER, "--no-precondition"]);
    expect(listCalls).toHaveLength(0);
    expect(reconcileCalls[0]!.opts.ifClaimants).toBeUndefined();
  });

  it("a 412 re-previews from the refusal body itself and exits non-zero", async () => {
    listed = [claimant({ objectId: FIRST_ID, version: 3 })];
    const fresh = [
      claimant({ objectId: FIRST_ID, version: 3 }),
      claimant({ objectId: APPEARED_ID, originIsSelf: true })
    ];
    const { ScpApiError } = await import("@scp/sdk");
    reconcileImpl = () =>
      new (
        ScpApiError as unknown as new (
          m: string,
          o: { status: number; problem: Record<string, unknown> }
        ) => Error
      )("Precondition Failed", {
        status: 412,
        problem: {
          type: "about:blank",
          title: "Precondition Failed",
          status: 412,
          detail: `1 appeared (${APPEARED_ID}:1)`,
          claimants: fresh
        }
      });
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });

    await runReconcile(["--peer", PEER]);

    const printed = errors.join("\n");
    // The generic handler in bin.ts would have printed the bare title ("Precondition Failed"); the
    // operator must instead learn WHAT moved and what the world looks like NOW.
    expect(printed).toMatch(/1 appeared/);
    expect(printed).toContain(APPEARED_ID);
    expect(printed).toMatch(/Nothing was adopted, removed or journaled/);
    expect(process.exitCode).toBe(1);
    // …and it must NOT silently retry: exactly one attempt was made.
    expect(reconcileCalls).toHaveLength(1);
  });
});
