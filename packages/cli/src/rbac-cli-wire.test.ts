import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `scp role` / `role-binding` / `authz` / `operator-credential` / `idp` — THE ACTION BODIES
 * ACTUALLY CALL THE SDK.
 *
 * Registering a command and having it do something are different facts, and only the second one
 * matters. A `return;` inserted as the first statement of every action leaves a fully green package
 * unless something drives the Commander closures — this repo has paid for that once already
 * (`dependency-read-verbs-wire.test.ts`), so every verb here is driven through
 * `buildProgram().parseAsync([...])` against a stubbed `@scp/sdk`.
 *
 * The cases that are NOT merely call-count assertions, and why each exists:
 *
 *  - `--acknowledge` absent vs present-but-empty must reach the API as `undefined` vs `[]`. D7
 *    treats them as different statements — "I did not look" and "I looked and it is empty" — and
 *    the door refuses the first for a group subject. Defaulting one to the other in the CLI would
 *    silently convert a refusal into an admission.
 *  - `role update` must send `undefined` for flags the operator omitted, never `[]`. The API reads
 *    absent as "leave alone" and empty as "clear", so conflating them would silently widen where a
 *    role may be bound.
 *  - `operator-credential` verbs must REFUSE without a token rather than send an empty header.
 */

const rolesListCalls: number[] = [];
const rolesCreateCalls: unknown[] = [];
const rolesUpdateCalls: { id: string; body: Record<string, unknown> }[] = [];
const rolesDeleteCalls: { id: string; body: unknown }[] = [];
const bindingsListCalls: unknown[] = [];
const bindingsCreateCalls: Record<string, unknown>[] = [];
const bindingsDeleteCalls: { id: string; body: unknown }[] = [];
const grantPreviewCalls: string[] = [];
const effectiveCalls: string[] = [];
const credCreateCalls: { body: unknown; token: string }[] = [];
const credListCalls: string[] = [];
const credRevokeCalls: { id: string; token: string }[] = [];
const objectUpdateCalls: { type: string; idOrUrn: string; body: Record<string, unknown> }[] = [];

const ROLE = {
  id: "019f0000-0000-7000-8000-0000000000r1",
  orgId: null,
  name: "Owner",
  permissions: ["object:write", "object:read"],
  bindableAt: null,
  deprecated: false,
  deprecationReason: null
};

const BINDING = {
  id: "019f0000-0000-7000-8000-0000000000b1",
  subjectId: "019f0000-0000-7000-8000-0000000000s1",
  roleId: ROLE.id,
  roleName: "Owner",
  scopeObjectId: "019f0000-0000-7000-8000-0000000000c1",
  effect: "allow",
  createdAt: "2026-08-28T00:00:00.000Z"
};

vi.mock("@scp/sdk", () => {
  class ScpApiError extends Error {
    status?: number;
    problem?: Record<string, unknown>;
    constructor(message: string, opts: { status?: number } = {}) {
      super(message);
      this.status = opts.status;
    }
  }
  class ScpClient {
    roles = {
      list: async () => {
        rolesListCalls.push(1);
        return { items: [ROLE] };
      },
      create: async (body: unknown) => {
        rolesCreateCalls.push(body);
        return ROLE;
      },
      update: async (id: string, body: Record<string, unknown>) => {
        rolesUpdateCalls.push({ id, body });
        return ROLE;
      },
      delete: async (id: string, body: unknown) => {
        rolesDeleteCalls.push({ id, body });
      }
    };
    roleBindings = {
      list: async (query: unknown) => {
        bindingsListCalls.push(query);
        return { items: [BINDING], nextCursor: null };
      },
      create: async (body: Record<string, unknown>) => {
        bindingsCreateCalls.push(body);
        return BINDING;
      },
      delete: async (id: string, body: unknown) => {
        bindingsDeleteCalls.push({ id, body });
      },
      grantPreview: async (subjectId: string) => {
        grantPreviewCalls.push(subjectId);
        return {
          subjectId,
          subjectTypeId: "group",
          acknowledgementRequired: true,
          acknowledgementComplete: true,
          withheldPrincipalCount: 0,
          acknowledgedPrincipalIds: ["019f0000-0000-7000-8000-0000000000p1"],
          principals: [],
          subjectExternallySynced: true
        };
      }
    };
    authz = {
      effective: async (scopeObjectId: string) => {
        effectiveCalls.push(scopeObjectId);
        return { scopeObjectId, permissions: ["object:read"], contributingBindings: [] };
      }
    };
    operatorCredentials = {
      create: async (body: unknown, token: string) => {
        credCreateCalls.push({ body, token });
        return {
          id: "019f0000-0000-7000-8000-0000000000e1",
          name: "ci",
          token: "scp_op_abc.def",
          createdAt: "2026-08-28T00:00:00.000Z",
          expiresAt: null
        };
      },
      list: async (token: string) => {
        credListCalls.push(token);
        return { items: [], callerMechanism: "bootstrap-env-token" };
      },
      revoke: async (id: string, token: string) => {
        credRevokeCalls.push({ id, token });
      }
    };
    object(type: string) {
      return {
        update: async (idOrUrn: string, body: Record<string, unknown>) => {
          objectUpdateCalls.push({ type, idOrUrn, body });
          return { id: idOrUrn, name: "g", type };
        }
      };
    }
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

beforeAll(async () => {
  await import("./cli.js");
});

beforeEach(async () => {
  for (const a of [
    rolesListCalls,
    rolesCreateCalls,
    rolesUpdateCalls,
    rolesDeleteCalls,
    bindingsListCalls,
    bindingsCreateCalls,
    bindingsDeleteCalls,
    grantPreviewCalls,
    effectiveCalls,
    credCreateCalls,
    credListCalls,
    credRevokeCalls,
    objectUpdateCalls
  ]) {
    a.length = 0;
  }
  logged = [];
  configDir = await mkdtemp(path.join(tmpdir(), "scp-rbac-cli-"));
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

describe("scp role", () => {
  it("list calls roles.list and renders built-in vs org", async () => {
    await run(["role", "list"]);
    expect(rolesListCalls).toHaveLength(1);
    expect(logged.join("\n")).toContain("built-in");
  });

  it("create passes repeated --permission through as an array", async () => {
    await run([
      "role",
      "create",
      "--name",
      "Release Captain",
      "--permission",
      "object:read",
      "change:accept",
      "--reason",
      "seat the release team"
    ]);
    expect(rolesCreateCalls).toHaveLength(1);
    expect(rolesCreateCalls[0]).toMatchObject({
      name: "Release Captain",
      permissions: ["object:read", "change:accept"],
      reason: "seat the release team"
    });
  });

  it("update sends UNDEFINED for omitted flags, never an empty array", async () => {
    await run(["role", "update", "r1", "--name", "Renamed", "--reason", "rename only"]);
    expect(rolesUpdateCalls).toHaveLength(1);
    const body = rolesUpdateCalls[0]!.body;
    expect(body.name).toBe("Renamed");
    // The distinction the API turns on: absent = leave alone, [] = clear. Sending [] here would
    // silently strip the role's permissions and widen where it may be bound.
    expect(body.permissions).toBeUndefined();
    expect(body.bindableAt).toBeUndefined();
  });

  it("delete calls roles.delete with the reason", async () => {
    await run(["role", "delete", "r1", "--reason", "no longer needed"]);
    expect(rolesDeleteCalls).toEqual([{ id: "r1", body: { reason: "no longer needed" } }]);
  });
});

describe("scp role-binding", () => {
  it("list forwards --subject and --scope as filters", async () => {
    await run(["role-binding", "list", "--subject", "s1", "--scope", "c1"]);
    expect(bindingsListCalls).toEqual([{ subjectId: "s1", scopeObjectId: "c1" }]);
  });

  it("create WITHOUT --acknowledge sends undefined, not []", async () => {
    await run([
      "role-binding",
      "create",
      "--subject",
      "s1",
      "--role",
      "r1",
      "--scope",
      "c1",
      "--reason",
      "grant"
    ]);
    expect(bindingsCreateCalls).toHaveLength(1);
    // D7: undefined is "I did not look" and the door REFUSES it for a group subject. Defaulting to
    // [] here would turn that refusal into an admission — the CLI silently asserting on the
    // operator's behalf that the group is empty.
    expect(bindingsCreateCalls[0]!.acknowledgedPrincipalIds).toBeUndefined();
  });

  it("create WITH --acknowledge and values sends them", async () => {
    await run([
      "role-binding",
      "create",
      "--subject",
      "s1",
      "--role",
      "r1",
      "--scope",
      "c1",
      "--reason",
      "grant",
      "--acknowledge",
      "p1",
      "p2"
    ]);
    expect(bindingsCreateCalls[0]!.acknowledgedPrincipalIds).toEqual(["p1", "p2"]);
  });

  it("grant-preview WARNS when the subject is directory-managed", async () => {
    await run(["role-binding", "grant-preview", "s1"]);
    expect(grantPreviewCalls).toEqual(["s1"]);
    // The acknowledgement is a statement about a moment; for a synced group that moment is shorter
    // than it looks, and the operator has to learn it BEFORE granting.
    expect(logged.join("\n")).toMatch(/IDENTITY PROVIDER/i);
  });

  it("delete calls roleBindings.delete with the reason", async () => {
    await run(["role-binding", "delete", "b1", "--reason", "revoke"]);
    expect(bindingsDeleteCalls).toEqual([{ id: "b1", body: { reason: "revoke" } }]);
  });
});

describe("scp authz effective", () => {
  it("calls authz.effective and prints the permissions", async () => {
    await run(["authz", "effective", "c1"]);
    expect(effectiveCalls).toEqual(["c1"]);
    expect(logged.join("\n")).toContain("object:read");
  });
});

describe("scp operator-credential", () => {
  it("REFUSES every verb without a token rather than sending an empty header", async () => {
    for (const args of [
      ["operator-credential", "create", "--name", "ci"],
      ["operator-credential", "list"],
      ["operator-credential", "revoke", "e1"]
    ]) {
      await expect(run(args)).rejects.toThrow(/operator credential is required/i);
    }
    // The negative half: nothing reached the SDK. Without this, a guard that threw AFTER the call
    // would still pass the assertion above.
    expect(credCreateCalls).toHaveLength(0);
    expect(credListCalls).toHaveLength(0);
    expect(credRevokeCalls).toHaveLength(0);
  });

  it("create passes the token and prints the secret once", async () => {
    process.env.SCP_OPERATOR_TOKEN = "bootstrap";
    await run(["operator-credential", "create", "--name", "ci"]);
    expect(credCreateCalls).toEqual([
      { body: { name: "ci", expiresAt: null }, token: "bootstrap" }
    ]);
    expect(logged.join("\n")).toContain("scp_op_abc.def");
    // Tells the operator the next step, since minting while leaving the env var set looks exactly
    // like having finished the migration.
    expect(logged.join("\n")).toMatch(/unset SCP_OPERATOR_TOKEN/i);
  });

  it("list surfaces that the caller is still on the BOOTSTRAP token", async () => {
    process.env.SCP_OPERATOR_TOKEN = "bootstrap";
    await run(["operator-credential", "list"]);
    expect(credListCalls).toEqual(["bootstrap"]);
    expect(logged.join("\n")).toMatch(/BOOTSTRAP env token/i);
  });

  it("--operator-token beats the environment", async () => {
    process.env.SCP_OPERATOR_TOKEN = "from-env";
    await run(["operator-credential", "revoke", "e1", "--operator-token", "from-flag"]);
    expect(credRevokeCalls).toEqual([{ id: "e1", token: "from-flag" }]);
  });
});

describe("scp idp", () => {
  it("map writes the externalIdentity property and states who owns the group now", async () => {
    await run(["idp", "map", "g1", "--claim-value", "SCP.OrgAdmin"]);
    expect(objectUpdateCalls).toEqual([
      {
        type: "group",
        idOrUrn: "g1",
        body: { properties: { externalIdentity: { claimValue: "SCP.OrgAdmin" } } }
      }
    ]);
    // The consequence an operator must not discover later: hand-added members are removed at their
    // next login, because the directory is authoritative for a mapped group.
    expect(logged.join("\n")).toMatch(/DIRECTORY is authoritative/i);
  });

  it("unmap clears it and says the current members STAY", async () => {
    await run(["idp", "unmap", "g1"]);
    expect(objectUpdateCalls[0]!.body).toEqual({ properties: { externalIdentity: null } });
    // Unmapping stops future reconciliation; it does not empty the group. Getting that backwards
    // is the difference between a config change and an outage.
    expect(logged.join("\n")).toMatch(/CURRENT members stay/i);
  });
});
