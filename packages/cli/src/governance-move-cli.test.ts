import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import type {
  GovernanceMoveEnforcement,
  GovernanceMoveInstanceRung,
  GovernanceMoveRung,
  GovernanceMoveRungWriteResponse
} from "@scp/schemas";
import {
  buildProgram,
  governanceMoveEnforcementRow,
  governanceMoveInstanceRow,
  governanceMoveRungRow,
  governanceMoveRungWriteRow
} from "./cli.js";

/**
 * `scp governance move-enforcement …` — THE CLI HALF OF THE `governance:move` LATTICE
 * (governance-reach-on-containment-move.md §9.2, owner ruling 2026-08-18; SDK facade
 * `client.governanceMove` in `packages/sdk/src/client.ts`).
 *
 * What this file pins, and why it is not readable from `governance-move-cli-wire.test.ts` alone:
 *
 *  1. **A closed verb list**, both at `move-enforcement` and at `instance` — mirrors
 *     `dependency-subscription-cli.test.ts`'s reasoning: a verb silently added or dropped from the
 *     command tree is invisible to every other test in the package.
 *  2. **`instance set` takes `--enabled <bool>`, mandatory** — an omitted flag must be a CLI-level
 *     error before any SDK call, not a defaulted `false` that silently disables enforcement.
 *  3. **The formatters are honest about absent values**, called DIRECTLY here (never through a
 *     Commander `.action()` closure, which no test can reach — `cli-absent-formatters.test.ts`'s
 *     standing reason).
 */

function findCommand(root: Command, path: string[]): Command | undefined {
  let current: Command | undefined = root;
  for (const name of path) {
    current = current?.commands.find((c) => c.name() === name);
    if (current === undefined) return undefined;
  }
  return current;
}

describe("scp governance move-enforcement — the command tree", () => {
  const program = buildProgram();
  const root = findCommand(program, ["governance", "move-enforcement"]);

  it("exists, with exactly status/rungs/enable/disable/instance — a CLOSED list", () => {
    expect(root).toBeDefined();
    const names = root!.commands.map((c) => c.name()).sort();
    expect(names).toEqual(["disable", "enable", "instance", "rungs", "status"]);
  });

  it("`instance` carries exactly get/set — a CLOSED list", () => {
    const instance = findCommand(program, ["governance", "move-enforcement", "instance"]);
    expect(instance).toBeDefined();
    const names = instance!.commands.map((c) => c.name()).sort();
    expect(names).toEqual(["get", "set"]);
  });

  it("`instance set` requires --enabled, and its description says OPERATOR ONLY / SCP_OPERATOR_TOKEN", () => {
    const set = findCommand(program, ["governance", "move-enforcement", "instance", "set"]);
    expect(set).toBeDefined();
    const mandatory = set!.options.filter((o) => o.mandatory).map((o) => o.long);
    expect(mandatory).toEqual(["--enabled"]);
    expect(set!.description()).toMatch(/OPERATOR ONLY/);
    expect(set!.description()).toMatch(/SCP_OPERATOR_TOKEN/);
  });

  it("`instance get` takes no mandatory options — it is an ordinary tenant read", () => {
    const get = findCommand(program, ["governance", "move-enforcement", "instance", "get"]);
    expect(get).toBeDefined();
    expect(get!.options.filter((o) => o.mandatory)).toEqual([]);
  });

  it("`enable`/`disable` take a positional idOrUrn and no mandatory flags — `enable` offers --note", () => {
    const enable = findCommand(program, ["governance", "move-enforcement", "enable"]);
    const disable = findCommand(program, ["governance", "move-enforcement", "disable"]);
    expect(enable).toBeDefined();
    expect(disable).toBeDefined();
    expect(enable!.options.filter((o) => o.mandatory)).toEqual([]);
    expect(enable!.options.map((o) => o.long)).toContain("--note");
    expect(enable!.description()).toMatch(/policy:write/);
    expect(disable!.description()).toMatch(/409/);
  });

  it("has NO bespoke destination-picking verb (moves stay ordinary object writes) — the description says so", () => {
    // A move is still made through object(type).update / setService / relationships contains /
    // an IaC apply — never a verb here. There must be no verb that suggests otherwise.
    const names = root!.commands.map((c) => c.name());
    for (const forbidden of ["move", "authorize-move"]) {
      expect(names).not.toContain(forbidden);
    }
  });
});

// -------------------------------------------------------------------------------------------
// Formatters — direct unit pins.
// -------------------------------------------------------------------------------------------

function without<T, K extends keyof T>(value: T, key: K): T {
  const copy: T = { ...value };
  delete copy[key];
  return copy;
}

const RUNG_WITH_DEPTH: GovernanceMoveRung = {
  tier: "service",
  subjectObjectId: "019f0000-0000-7000-8000-00000000a001",
  name: "checkout",
  enabledAt: "2026-08-18T00:00:00.000Z",
  enabledByObjectId: "019f0000-0000-7000-8000-00000000ad01",
  depth: 2
};

describe("governanceMoveRungRow", () => {
  it("prints every field, and `depth` as its number when present", () => {
    const row = governanceMoveRungRow(RUNG_WITH_DEPTH);
    expect(row).toEqual({
      tier: "service",
      subject: "checkout",
      subjectObjectId: "019f0000-0000-7000-8000-00000000a001",
      depth: "2",
      enabledAt: "2026-08-18T00:00:00.000Z",
      enabledByObjectId: "019f0000-0000-7000-8000-00000000ad01"
    });
  });

  it("prints `-` for depth when ABSENT — the org-wide `rungs` list walks no chain (mutation: `String(rung.depth)` unguarded would print `undefined`)", () => {
    const row = governanceMoveRungRow(without(RUNG_WITH_DEPTH, "depth"));
    expect(row.depth).toBe("-");
    expect(row.depth).not.toBe("undefined");
  });
});

const ENFORCEMENT: GovernanceMoveEnforcement = {
  enforced: true,
  instance: { enabled: false },
  rungs: [RUNG_WITH_DEPTH]
};

describe("governanceMoveEnforcementRow", () => {
  it("prints the verdict, the instance rung's state in words, and the chain's rung count", () => {
    expect(governanceMoveEnforcementRow(ENFORCEMENT)).toEqual({
      enforced: "true",
      instanceRung: "disabled",
      rungsOnChain: "1"
    });
  });

  it("says 'enabled' when the instance rung is on, and reports zero rungs honestly", () => {
    const row = governanceMoveEnforcementRow({
      enforced: true,
      instance: { enabled: true },
      rungs: []
    });
    expect(row.instanceRung).toBe("enabled");
    expect(row.rungsOnChain).toBe("0");
  });
});

const INSTANCE_SET: GovernanceMoveInstanceRung = {
  enabled: true,
  updatedAt: "2026-08-18T00:00:00.000Z"
};

describe("governanceMoveInstanceRow", () => {
  it("prints the deliberately-set state", () => {
    expect(governanceMoveInstanceRow(INSTANCE_SET)).toEqual({
      enabled: "true",
      updatedAt: "2026-08-18T00:00:00.000Z"
    });
  });

  it("prints '(never set)' for a null updatedAt — the shipped default, distinct from a deliberate re-disable (mutation: `instance.updatedAt` unguarded would print the literal null/blank)", () => {
    const row = governanceMoveInstanceRow({ enabled: false, updatedAt: null });
    expect(row.updatedAt).toBe("(never set)");
    expect(row.enabled).toBe("false");
  });
});

const WRITE_RESPONSE: GovernanceMoveRungWriteResponse = {
  subjectObjectId: "019f0000-0000-7000-8000-00000000a001",
  tier: "service",
  enabled: true,
  enforcement: ENFORCEMENT,
  decisionId: "019f0000-0000-7000-8000-00000000d001"
};

describe("governanceMoveRungWriteRow", () => {
  it("prints the subject, tier, resulting state, and the Decision id (charter principle 6)", () => {
    expect(governanceMoveRungWriteRow(WRITE_RESPONSE)).toEqual({
      subjectObjectId: "019f0000-0000-7000-8000-00000000a001",
      tier: "service",
      enabled: "true",
      decisionId: "019f0000-0000-7000-8000-00000000d001"
    });
  });

  it("prints `enabled: false` for a disable response — the column is the outcome, not the verb", () => {
    expect(governanceMoveRungWriteRow({ ...WRITE_RESPONSE, enabled: false }).enabled).toBe("false");
  });
});
