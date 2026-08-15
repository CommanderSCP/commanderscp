import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import type {
  DependencySubscriptionContribution,
  DependencySubscriptionResolutionResponse,
  DependencySubscriptionUnlock
} from "@scp/schemas";
import {
  buildProgram,
  dependencySubscriptionContributionRow,
  dependencySubscriptionResolutionRow,
  dependencySubscriptionUnlockRow
} from "./cli.js";

/**
 * M21.3 — THE CLI HALF OF THE ENABLEMENT SURFACE (ADR-0032 §3a/§6).
 *
 * Charter principle 3 is API → SDK → CLI, so a capability that stops at the SDK is a parity hole.
 * Three things need a witness here:
 *
 *  1. **The three commands exist and carry the right shape** — in particular `set-unlock` takes TWO
 *     mutually exclusive flags rather than one defaulted boolean, because absent never means enabled
 *     (ADR-0032 §6) and a defaulted boolean flag is precisely how an omission becomes a value.
 *
 *  2. **There is NO `subscribe` verb, and the help says where to author one instead.** A dependency
 *     subscription IS a `dependencySubscription` policy effect (ADR-0032 §3a); a bespoke CLI verb
 *     would be a second authoring path for one concept. The ABSENCE is the guarantee, and an absence
 *     is exactly what nobody notices regressing.
 *
 *  3. **The formatters are honest about absent values, and about which level decided the verdict.**
 *     They are exported and called DIRECTLY here for the reason `cli-absent-formatters.test.ts`
 *     records at length: a mapper written inline in a Commander `.action()` closure is unreachable
 *     by any test, so its guards are correct and completely unheld.
 */

function findCommand(root: Command, path: string[]): Command | undefined {
  let current: Command | undefined = root;
  for (const name of path) {
    current = current?.commands.find((c) => c.name() === name);
    if (current === undefined) return undefined;
  }
  return current;
}

/** Delete one key: what an older/newer server actually puts on the wire, which no type rules out at
 *  runtime. `null` is the case that already worked — `undefined` is the one that fabricates. */
function without<T, K extends keyof T>(value: T, key: K): T {
  const copy: T = { ...value };
  delete copy[key];
  return copy;
}

describe("scp dependency-subscriptions — the CLI surface (ADR-0032 §6)", () => {
  const program = buildProgram();
  const root = findCommand(program, ["dependency-subscriptions"]);

  it("exists, with exactly the read/operator-write/resolve trio", () => {
    expect(root).toBeDefined();
    const names = root!.commands.map((c) => c.name()).sort();
    expect(names).toEqual(["resolve", "set-unlock", "unlock"]);
  });

  it("has NO subscribe/enable/disable verb — a subscription is a POLICY effect, and the help says so", () => {
    const names = root!.commands.map((c) => c.name());
    for (const forbidden of [
      "subscribe",
      "unsubscribe",
      "enable",
      "disable",
      "create",
      "opt-out"
    ]) {
      expect(names, `a bespoke '${forbidden}' verb is a second authoring path`).not.toContain(
        forbidden
      );
    }
    // The absence is only defensible if the surface points at the real path. The first thing
    // somebody will look for here is the verb that does not exist.
    expect(root!.description()).toMatch(/scp policy create/i);
    expect(root!.description()).toMatch(/dependencySubscription/);
  });

  it("`set-unlock` takes two MUTUALLY EXCLUSIVE flags, not one defaulted boolean", () => {
    const setUnlock = findCommand(program, ["dependency-subscriptions", "set-unlock"]);
    expect(setUnlock).toBeDefined();
    const longs = setUnlock!.options.map((o) => o.long);
    expect(longs).toContain("--unlocked");
    expect(longs).toContain("--locked");
    // A `--unlocked <bool>` with a default is how "the operator said nothing" silently becomes a
    // value. Both flags must be argument-LESS, so there is no value to default.
    for (const long of ["--unlocked", "--locked"]) {
      const option = setUnlock!.options.find((o) => o.long === long);
      expect(option!.flags, `${long} must take no argument`).not.toMatch(/[<[]/);
      expect(option!.defaultValue, `${long} must have no default`).toBeUndefined();
    }
    // OPERATOR ONLY is the surprising part (no tenant role can grant it), so it belongs in the help
    // rather than in a 403 the operator has to interpret.
    expect(setUnlock!.description()).toMatch(/OPERATOR ONLY/);
    expect(setUnlock!.description()).toMatch(/SCP_OPERATOR_TOKEN/);
  });

  it("`resolve` requires the full line key — a partial key would answer about a different line", () => {
    const resolve = findCommand(program, ["dependency-subscriptions", "resolve"]);
    expect(resolve).toBeDefined();
    // `mandatory` (set by `.requiredOption`), NOT `required` — `required` is true for ANY option
    // that takes an argument, so `--base-url <url>` would satisfy it and the assertion would pass
    // no matter which flags were optional.
    const mandatory = resolve!.options
      .filter((o) => o.mandatory)
      .map((o) => o.long)
      .sort();
    expect(mandatory).toEqual(["--component", "--coordinate", "--ecosystem", "--major"]);
    // The coordinate is compared byte-for-byte; an operator who assumes it is normalised will opt
    // out the wrong package (`@acme/lib` and `acme-lib` share a URN slug but are two lines).
    expect(resolve!.options.find((o) => o.long === "--coordinate")?.description).toMatch(
      /verbatim/i
    );
  });
});

describe("the M21.3 CLI formatters", () => {
  const unlock: DependencySubscriptionUnlock = {
    unlocked: false,
    note: null,
    updatedAt: null,
    source: "instance:dependency_subscription_unlock"
  };

  it("prints NEVER SET rather than a blank or a fabricated timestamp when the unlock has no row", () => {
    // The shipped state of every deployment: no row at all. "(never set)" and "deliberately
    // re-locked" are different operator situations and must not render identically.
    expect(dependencySubscriptionUnlockRow(unlock).updatedAt).toBe("(never set)");
    // …including when the key is OMITTED entirely, which is what an older/newer server sends.
    expect(dependencySubscriptionUnlockRow(without(unlock, "updatedAt")).updatedAt).toBe(
      "(never set)"
    );

    // NEGATIVE CONTROL: a real timestamp is printed verbatim, so the guard is about ABSENCE and not
    // a column hardcoded to "(never set)".
    expect(
      dependencySubscriptionUnlockRow({ ...unlock, updatedAt: "2026-08-15T00:00:00.000Z" })
        .updatedAt
    ).toBe("2026-08-15T00:00:00.000Z");
  });

  const enabledResponse: DependencySubscriptionResolutionResponse = {
    componentObjectId: "0198f000-0000-7000-8000-000000000001",
    line: { ecosystem: "npm", coordinate: "@acme/lib", major: "1" },
    resolution: {
      enabled: true,
      reason: "enabled",
      granularity: "patch",
      delivery: "pull_request",
      contributions: []
    }
  };

  it("never prints `undefined` in the DELIVERY column — where the two values are 'open a PR' and 'merge it automatically'", () => {
    const stripped: DependencySubscriptionResolutionResponse = {
      ...enabledResponse,
      resolution: without(without(enabledResponse.resolution, "delivery"), "granularity")
    };
    const row = dependencySubscriptionResolutionRow(stripped);
    expect(row.delivery).toBe("-");
    expect(row.granularity).toBe("-");

    // NEGATIVE CONTROL: present values are printed as themselves.
    const full = dependencySubscriptionResolutionRow(enabledResponse);
    expect(full.delivery).toBe("pull_request");
    expect(full.granularity).toBe("patch");
  });

  it("echoes the coordinate VERBATIM — the byte that decides which package an opt-out named", () => {
    expect(dependencySubscriptionResolutionRow(enabledResponse).coordinate).toBe("@acme/lib");
    expect(
      dependencySubscriptionResolutionRow({
        ...enabledResponse,
        line: { ...enabledResponse.line, coordinate: "acme-lib" }
      }).coordinate
    ).toBe("acme-lib");
  });

  it("renders an ABSENT selector as the wildcard it is, not as a blank that reads 'matched nothing'", () => {
    const wildcard: DependencySubscriptionContribution = {
      tier: "component",
      source: "policy:subscribe-all@0198f000-0000-7000-8000-000000000002",
      contributed: "enable"
    };
    expect(dependencySubscriptionContributionRow(wildcard).selector).toBe("*");

    // NEGATIVE CONTROL: a present selector renders its own keys, so "*" means WILDCARD and not
    // "this formatter always prints a star".
    const scoped: DependencySubscriptionContribution = {
      ...wildcard,
      contributed: "disable",
      selector: { coordinate: "@acme/lib" }
    };
    const row = dependencySubscriptionContributionRow(scoped);
    expect(row.selector).toBe("coordinate=@acme/lib");
    // `contributed` is the column that answers "which level turned this off".
    expect(row.contributed).toBe("disable");
    expect(row.tier).toBe("component");
  });

  it("shows an IGNORED contribution's reason — a malformed opt-out fails OPEN, so it must be visible", () => {
    const ignored: DependencySubscriptionContribution = {
      tier: "org",
      source: "policy:broken@0198f000-0000-7000-8000-000000000003",
      contributed: "ignored",
      ignoredReason: "malformed"
    };
    const row = dependencySubscriptionContributionRow(ignored);
    expect(row.contributed).toBe("ignored");
    expect(row.ignoredReason).toBe("malformed");

    // NEGATIVE CONTROL: the same formatter leaves the column EMPTY when there is no reason, so it
    // is reporting the reason rather than always printing one.
    expect(
      dependencySubscriptionContributionRow(without(ignored, "ignoredReason")).ignoredReason
    ).toBe("");
  });
});
