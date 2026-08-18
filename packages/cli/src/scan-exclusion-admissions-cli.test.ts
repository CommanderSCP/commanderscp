import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command } from "commander";
import { ScanExclusionClassSchema } from "@scp/schemas";
import type { InstanceScanExclusionAdmission } from "@scp/schemas";

/**
 * M22.9 — THE OPERATOR SURFACE FOR THE TWO RUNGS EVERY EXCLUSION CLAUSE NEEDS, AND IT SHIPPED
 * WITH NOTHING HOLDING IT.
 *
 * A filterless `grep -rna 'instanceScanExclusionAdmissionRow|scan-exclusion-admissions'
 * --include='*.ts'` (dist excluded) found ZERO references outside `cli.ts` itself: the row
 * formatter, `list` and `set` were all reachable only from the command block that defines them, so
 * DELETING THE ENTIRE BLOCK left `@scp/cli` green. Four behaviours were untested and every one of
 * them is one-way:
 *
 *   - the `trust-domain` -> `trust_domain` literal mapping (ADR-0016/ADR-0033 terminology: the
 *     AMBIENT federation partition, never the intra-org containment `domain` object);
 *   - the class allowlist, whose whole point is that a typo admits NOTHING while the operator
 *     believes they granted something;
 *   - the `SCP_OPERATOR_TOKEN` precondition — an admission opens a loosening for every org on the
 *     deployment, so a tenant login must not be able to reach it;
 *   - and THE DESTRUCTIVE DEFAULT: `set` is a REPLACE, so omitting `--class` sends `classes: []`
 *     and REVOKES every admission at that rung. With that rung empty the monotone AND fails at the
 *     top for every clause beneath it, and every exclusion on the deployment goes inert.
 *
 * WHY THE WIRE AND NOT ONLY THE OPTIONS. `outpost-cli-surface.test.ts` can pin what a command
 * DECLARES; a build in which the options exist, the help text is perfect and the action sends the
 * wrong body passes it completely. That "wording, not behaviour" shape is this project's
 * second-most-common recurring bug, so the four assertions above are made against a stubbed
 * `@scp/sdk` — the `outpost-reconcile-precondition.test.ts` pattern, and the honest seam, because
 * the CLI consumes only the SDK (charter principle 3).
 */

interface PutCall {
  tier: string;
  body: { origin?: string; classes?: string[]; note?: string | null };
  operatorToken: string;
}

const putCalls: PutCall[] = [];
const listCalls: number[] = [];
let listed: InstanceScanExclusionAdmission[] = [];

function admission(
  over: Partial<InstanceScanExclusionAdmission> = {}
): InstanceScanExclusionAdmission {
  return {
    tier: "platform",
    class: "no_fix_available",
    origin: "local",
    note: null,
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...over
  };
}

vi.mock("@scp/sdk", () => {
  class ScpApiError extends Error {}
  class ScpClient {
    instanceScanExclusionAdmissions = {
      list: async () => {
        listCalls.push(Date.now());
        return listed;
      },
      put: async (tier: string, body: PutCall["body"], operatorToken: string) => {
        putCalls.push({ tier, body, operatorToken });
        return listed;
      }
    };
  }
  return { ScpClient, ScpApiError };
});

let configDir: string;
const savedEnv = { ...process.env };

async function buildProgram(): Promise<Command> {
  const mod = await import("./cli.js");
  return mod.buildProgram();
}

async function run(args: string[]): Promise<void> {
  const program = await buildProgram();
  await program.parseAsync(["node", "scp", "scan-exclusion-admissions", ...args]);
}

/** Warm the dynamic import in a hook rather than charging it to the first `it` — the reason
 *  `outpost-reconcile-precondition.test.ts` gives: the whole CLI module graph is transformed on
 *  first import, which is milliseconds warm and seconds on a cold runner, and vitest's per-test
 *  budget is 5s while `hookTimeout` is 10s. The import must be lazy so the SDK mock above is
 *  installed before the graph is evaluated. */
beforeAll(async () => {
  await import("./cli.js");
}, 30_000);

beforeEach(async () => {
  putCalls.length = 0;
  listCalls.length = 0;
  listed = [admission()];
  configDir = await mkdtemp(path.join(tmpdir(), "scp-admissions-test-"));
  process.env.SCP_CONFIG_DIR = configDir;
  process.env.SCP_OPERATOR_TOKEN = "op-token";
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

describe("scp scan-exclusion-admissions — the declared surface", () => {
  it("both SDK verbs have a command (API -> SDK -> CLI parity)", async () => {
    // The census that would have caught the missing coverage at the time, written as a SET so a
    // future SDK verb with no command fails here rather than in a review round.
    const group = findCommand(await buildProgram(), ["scan-exclusion-admissions"]);
    expect(group, "`scp scan-exclusion-admissions` is missing").toBeDefined();
    expect(group!.commands.map((c) => c.name()).sort()).toEqual(["list", "set"]);
  });

  it("`--class` help offers EXACTLY the classes the API accepts, in both directions", async () => {
    // The N1 drift, on a different enum: help text is the only place an operator learns what to
    // type. A member missing sends them to a value they think does not exist; a member the enum
    // dropped sends them straight into a 400.
    const set = findCommand(await buildProgram(), ["scan-exclusion-admissions", "set"])!;
    const help = set.options.find((o) => o.long === "--class")?.description ?? "";
    const offered = (help.split(/\s+/)[0] ?? "").split("|");
    expect(offered.sort()).toEqual([...ScanExclusionClassSchema.options].sort());
  });

  it("`--tier` is required and names the PARTITION, not the containment domain object", async () => {
    const set = findCommand(await buildProgram(), ["scan-exclusion-admissions", "set"])!;
    const tier = set.options.find((o) => o.long === "--tier");
    expect(tier).toBeDefined();
    expect(tier!.required).toBe(true);
    expect(tier!.description).toMatch(/not the intra-org containment domain/i);
  });
});

describe("scp scan-exclusion-admissions set — what actually reaches the API", () => {
  it("`--tier trust-domain` sends the canonical `trust_domain`, never bare `domain`", async () => {
    // Two different concepts share the word: the ambient federation PARTITION above org (this one)
    // and the intra-org containment `domain` OBJECT below it. The stored literal is `trust_domain`;
    // sending the hyphenated CLI spelling or a bare `domain` writes an admission at a rung the
    // resolver never reads, so the operator's grant is invisible and every clause stays inert.
    await run(["set", "--tier", "trust-domain", "--class", "no_fix_available"]);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0]!.tier).toBe("trust_domain");
  });

  it("`--tier platform` passes through unmapped, and repeated `--class` sends the whole set", async () => {
    await run([
      "set",
      "--tier",
      "platform",
      "--class",
      "no_fix_available",
      "--class",
      "approved_override"
    ]);
    expect(putCalls[0]!.tier).toBe("platform");
    expect(putCalls[0]!.body.classes).toEqual(["no_fix_available", "approved_override"]);
  });

  it("OMITTING --class is now REFUSED, and nothing is sent — the withdrawal needs --revoke-all", async () => {
    // THIS CASE CHANGED DELIBERATELY (owner decision, 2026-08-18), and its previous revision said so
    // in advance: it pinned the silent-revocation default as SHIPPED-BUT-NOT-ENDORSED and named
    // itself as the test that must change if a flag were ever added. This is that change.
    //
    // `set` is still a whole-set REPLACE on the wire — that server contract is right, because an
    // additive verb would make withdrawal the harder operation on a LOOSENING. What changed is that
    // the CLI no longer lets you reach the destructive case by forgetting a flag. `platform` is
    // ALWAYS represented in the monotone AND, so an empty set there makes every exclusion clause on
    // the whole deployment inert, for every org.
    await expect(run(["set", "--tier", "platform"])).rejects.toThrow(/--revoke-all/);
    expect(putCalls).toHaveLength(0);
  });

  it("--revoke-all sends the empty set — the withdrawal path still exists and still works", async () => {
    // The other half. A refusal that left no way to withdraw would be worse than the silent default:
    // an operator who cannot take a loosening back is an operator who stops admitting them at all.
    await run(["set", "--tier", "platform", "--revoke-all"]);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0]!.body.classes).toEqual([]);
  });

  it("--revoke-all alongside --class is REFUSED — the two say contradictory things", async () => {
    await expect(
      run(["set", "--tier", "platform", "--revoke-all", "--class", "vendor_latest"])
    ).rejects.toThrow(/mutually exclusive/);
    expect(putCalls).toHaveLength(0);
  });

  it("a typo'd class is REFUSED before the call, so nothing is written", async () => {
    // The failure this closes is not a 400 an operator would see: an unrecognised class admits
    // NOTHING while reading back as an authored grant. Refused in three places on purpose (here,
    // the route, and 0074's CHECK) — this asserts the first, which is the only one that can name
    // the accepted values back to the person typing.
    await expect(run(["set", "--tier", "platform", "--class", "no_fix_availble"])).rejects.toThrow(
      /--class must be one of/
    );
    expect(putCalls).toHaveLength(0);
  });

  it("an unrecognised tier is REFUSED before the call", async () => {
    await expect(run(["set", "--tier", "domain", "--class", "vendor_latest"])).rejects.toThrow(
      /--tier must be 'platform' or 'trust-domain'/
    );
    expect(putCalls).toHaveLength(0);
  });

  it("without SCP_OPERATOR_TOKEN the command refuses and sends NOTHING", async () => {
    // A tenant login, however privileged inside its own org, must not be able to open a loosening
    // that binds every OTHER org on the deployment. The refusal has to happen before the call, not
    // as a 401 from the server, so that no half-formed request exists.
    delete process.env.SCP_OPERATOR_TOKEN;
    await expect(run(["set", "--tier", "platform", "--class", "vendor_latest"])).rejects.toThrow(
      /SCP_OPERATOR_TOKEN is not set/
    );
    expect(putCalls).toHaveLength(0);
  });

  it("the operator token is FORWARDED, not merely checked for existence", async () => {
    // The mutant this kills reads the env var, passes the precondition, and then sends the tenant
    // token — a check that gates the command without authenticating the call.
    process.env.SCP_OPERATOR_TOKEN = "distinct-operator-token";
    await run(["set", "--tier", "platform", "--class", "declared_fact"]);
    expect(putCalls[0]!.operatorToken).toBe("distinct-operator-token");
  });

  it("`list` is an ordinary authenticated read — no operator token required", async () => {
    // A gate you cannot inspect is not explainable (charter principle 6). Reading must stay open to
    // any authenticated caller, so an empty admitted set is discoverable by the person whose
    // exclusion clause is mysteriously not firing.
    delete process.env.SCP_OPERATOR_TOKEN;
    await run(["list"]);
    expect(listCalls).toHaveLength(1);
  });
});
