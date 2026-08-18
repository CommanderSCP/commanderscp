import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GovernanceMoveEnforcement,
  GovernanceMoveInstanceRung,
  GovernanceMoveRungList,
  GovernanceMoveRungWriteResponse
} from "@scp/schemas";

/**
 * `scp governance move-enforcement …` — THE ACTION BODIES ACTUALLY CALL THE SDK.
 *
 * `governance-move-cli.test.ts` proves the six verbs are REGISTERED and pins the pure formatters;
 * neither reaches a Commander `.action()` closure. The `dependency-read-verbs-wire.test.ts` lesson
 * ("component built, never installed" one layer down — a `return;` inserted first in the action left
 * a fully green package) applies exactly the same way here, so every verb is driven through
 * `buildProgram().parseAsync([...])` against a stubbed `@scp/sdk`.
 *
 * MUTATIONS WATCHED TO FAIL (each applied alone, then reverted): `return;` as the first statement of
 * every action → that verb's call-count assertion goes RED (no SDK call, nothing printed); dropping
 * the `--enabled` parse guard in `instance set`'s action → the "rejects a non-boolean" case goes RED;
 * dropping the `SCP_OPERATOR_TOKEN` guard → the "refuses without a token" case goes RED and the SDK
 * is called anyway (the negative assertion on `setInstanceCalls` catches it).
 */

const enforcementCalls: { type: string; idOrUrn: string }[] = [];
const rungsCalls: number[] = [];
const enableCalls: { idOrUrn: string; req: unknown }[] = [];
const disableCalls: { idOrUrn: string }[] = [];
const instanceCalls: number[] = [];
const setInstanceCalls: { req: unknown; operatorToken: string }[] = [];

const ENFORCEMENT: GovernanceMoveEnforcement = {
  enforced: true,
  instance: { enabled: false },
  rungs: [
    {
      tier: "service",
      subjectObjectId: "019f0000-0000-7000-8000-00000000a001",
      name: "checkout",
      enabledAt: "2026-08-18T00:00:00.000Z",
      enabledByObjectId: "019f0000-0000-7000-8000-00000000ad01",
      depth: 1
    }
  ]
};

const RUNG_LIST: GovernanceMoveRungList = {
  instance: { enabled: true },
  rungs: ENFORCEMENT.rungs
};

const WRITE_RESPONSE: GovernanceMoveRungWriteResponse = {
  subjectObjectId: "019f0000-0000-7000-8000-00000000a001",
  tier: "service",
  enabled: true,
  enforcement: ENFORCEMENT,
  decisionId: "019f0000-0000-7000-8000-00000000d001"
};

const INSTANCE: GovernanceMoveInstanceRung = { enabled: false, updatedAt: null };

let nextEnforcement: GovernanceMoveEnforcement;
let nextRungList: GovernanceMoveRungList;
let nextEnableResponse: GovernanceMoveRungWriteResponse;
let nextDisableResponse: GovernanceMoveRungWriteResponse;
let nextInstance: GovernanceMoveInstanceRung;
let nextSetInstance: GovernanceMoveInstanceRung;

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
    governanceMove = {
      enforcement: async (type: string, idOrUrn: string) => {
        enforcementCalls.push({ type, idOrUrn });
        return nextEnforcement;
      },
      rungs: async () => {
        rungsCalls.push(1);
        return nextRungList;
      },
      enable: async (idOrUrn: string, req: unknown) => {
        enableCalls.push({ idOrUrn, req });
        return nextEnableResponse;
      },
      disable: async (idOrUrn: string) => {
        disableCalls.push({ idOrUrn });
        return nextDisableResponse;
      },
      instance: async () => {
        instanceCalls.push(1);
        return nextInstance;
      },
      setInstance: async (req: unknown, operatorToken: string) => {
        setInstanceCalls.push({ req, operatorToken });
        return nextSetInstance;
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
  await buildProgram().parseAsync(["node", "scp", "governance", "move-enforcement", ...args]);
}

// Warm the dynamic import once, in a hook (see outpost-reconcile-precondition.test.ts for why).
beforeAll(async () => {
  await import("./cli.js");
}, 30_000);

beforeEach(async () => {
  enforcementCalls.length = 0;
  rungsCalls.length = 0;
  enableCalls.length = 0;
  disableCalls.length = 0;
  instanceCalls.length = 0;
  setInstanceCalls.length = 0;
  nextEnforcement = ENFORCEMENT;
  nextRungList = RUNG_LIST;
  nextEnableResponse = WRITE_RESPONSE;
  nextDisableResponse = { ...WRITE_RESPONSE, enabled: false };
  nextInstance = INSTANCE;
  nextSetInstance = { enabled: true, updatedAt: "2026-08-18T01:00:00.000Z" };
  logged = [];
  configDir = await mkdtemp(path.join(tmpdir(), "scp-governance-move-"));
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

describe("scp governance move-enforcement status <type> <idOrUrn>", () => {
  it("calls governanceMove.enforcement(type, idOrUrn) and prints the verdict + the chain's rungs", async () => {
    await run(["status", "service", "019f0000-0000-7000-8000-00000000a001"]);
    expect(enforcementCalls).toEqual([
      { type: "service", idOrUrn: "019f0000-0000-7000-8000-00000000a001" }
    ]);
    const out = logged.join("\n");
    expect(out).toMatch(/ENFORCED/i);
    expect(out).toContain("true");
    expect(out).toContain("checkout");
  });
});

describe("scp governance move-enforcement rungs", () => {
  it("calls governanceMove.rungs() with no arguments and prints the instance state + the rung table", async () => {
    await run(["rungs"]);
    expect(rungsCalls).toEqual([1]);
    const out = logged.join("\n");
    expect(out).toMatch(/instance rung: enabled/);
    expect(out).toContain("checkout");
  });

  it("says 'disabled' when the instance rung is off — not hardcoded to one wording", async () => {
    nextRungList = { instance: { enabled: false }, rungs: [] };
    await run(["rungs"]);
    expect(logged.join("\n")).toMatch(/instance rung: disabled/);
  });
});

describe("scp governance move-enforcement enable <idOrUrn>", () => {
  it("calls governanceMove.enable(idOrUrn, {}) with no --note", async () => {
    await run(["enable", "019f0000-0000-7000-8000-00000000a001"]);
    expect(enableCalls).toEqual([{ idOrUrn: "019f0000-0000-7000-8000-00000000a001", req: {} }]);
    const out = logged.join("\n");
    expect(out).toContain("019f0000-0000-7000-8000-00000000d001");
  });

  it("threads --note into the request body", async () => {
    await run([
      "enable",
      "019f0000-0000-7000-8000-00000000a001",
      "--note",
      "quarterly reorg freeze"
    ]);
    expect(enableCalls).toEqual([
      {
        idOrUrn: "019f0000-0000-7000-8000-00000000a001",
        req: { note: "quarterly reorg freeze" }
      }
    ]);
  });
});

describe("scp governance move-enforcement disable <idOrUrn>", () => {
  it("calls governanceMove.disable(idOrUrn) and prints the resulting enabled:false", async () => {
    await run(["disable", "019f0000-0000-7000-8000-00000000a001"]);
    expect(disableCalls).toEqual([{ idOrUrn: "019f0000-0000-7000-8000-00000000a001" }]);
    const out = logged.join("\n");
    expect(out).toContain("false");
  });
});

describe("scp governance move-enforcement instance get", () => {
  it("calls governanceMove.instance() and prints '(never set)' for a null updatedAt", async () => {
    await run(["instance", "get"]);
    expect(instanceCalls).toEqual([1]);
    expect(logged.join("\n")).toContain("(never set)");
  });
});

describe("scp governance move-enforcement instance set --enabled <bool>", () => {
  it("REFUSES with no SCP_OPERATOR_TOKEN, and never calls the SDK", async () => {
    delete process.env.SCP_OPERATOR_TOKEN;
    await expect(run(["instance", "set", "--enabled", "true"])).rejects.toThrow(
      /SCP_OPERATOR_TOKEN/
    );
    expect(setInstanceCalls).toEqual([]);
  });

  it("REJECTS a non-boolean --enabled value before calling the SDK", async () => {
    process.env.SCP_OPERATOR_TOKEN = "op-secret";
    await expect(run(["instance", "set", "--enabled", "yes"])).rejects.toThrow(/true.*false/i);
    expect(setInstanceCalls).toEqual([]);
  });

  it("calls governanceMove.setInstance({enabled:true}, token) once SCP_OPERATOR_TOKEN is set", async () => {
    process.env.SCP_OPERATOR_TOKEN = "op-secret";
    await run(["instance", "set", "--enabled", "true"]);
    expect(setInstanceCalls).toEqual([{ req: { enabled: true }, operatorToken: "op-secret" }]);
    expect(logged.join("\n")).toContain("true");
  });

  it("threads --enabled false as a literal false, not a truthy string", async () => {
    process.env.SCP_OPERATOR_TOKEN = "op-secret";
    await run(["instance", "set", "--enabled", "false"]);
    expect(setInstanceCalls).toEqual([{ req: { enabled: false }, operatorToken: "op-secret" }]);
  });
});
