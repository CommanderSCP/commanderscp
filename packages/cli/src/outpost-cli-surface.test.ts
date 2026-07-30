import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import { OutpostTrustTierSchema } from "@scp/schemas";
import type { OutpostConfigReconcileResult } from "@scp/schemas";
import { buildProgram, formatReconcileResultLines } from "./cli.js";

/**
 * M16.2 phase A, REVIEW ROUND 5 — THE CLI HALF OF THE OUTPOST SURFACE (N1, N2).
 *
 * N1 — THE TIER FIX MISSED THE ONLY PLACE AN OPERATOR READS THE LIST. ADR-0022 widened
 * `OutpostTrustTier` from `commercial|fedramp-high|il5` to the glossary's five members, and the
 * schema, the migration header, the proposal and the glossary alignment were all corrected — while
 * `--trust-tier`'s two option descriptions kept printing the OLD THREE. `scp federation outpost
 * declare --help` is the only place an operator learns what to type, so an operator enrolling a
 * GovCloud outpost was told there was no value for it, and pushed to leave the tier unknown or
 * assert `commercial` — the INVENTED POSTURE the whole honest-unknown design exists to prevent.
 * The help text is now DERIVED from the enum; this test is the assertion that keeps documentation
 * and enum from drifting apart again, and it is deliberately written against the ENUM'S OWN
 * MEMBERS rather than a retyped list, so adding a sixth tier cannot leave the help behind.
 *
 * N2 — THE RECOVERY VERB HAD NO CLI. Charter principle 3 is API -> SDK -> CLI -> IaC -> UI, and
 * `reconcileOutpost` shipped in the SDK with no command. It is the verb an operator uses to un-wedge
 * a peer holding duplicate `outpost` objects — and that operator is the one person who cannot reach
 * it through the UI, because the wedged peer is what the UI fails to render.
 */

function findCommand(root: Command, path: string[]): Command | undefined {
  let current: Command | undefined = root;
  for (const name of path) {
    current = current?.commands.find((c) => c.name() === name);
    if (current === undefined) return undefined;
  }
  return current;
}

function trustTierHelp(command: Command): string {
  const option = command.options.find((o) => o.long === "--trust-tier");
  expect(option, `${command.name()} has no --trust-tier option`).toBeDefined();
  return option!.description;
}

describe("scp federation outpost — the operator-facing surface", () => {
  const program = buildProgram();

  it("N1: `outpost declare --trust-tier` documents EVERY tier the API accepts", () => {
    const declare = findCommand(program, ["federation", "outpost", "declare"]);
    expect(declare).toBeDefined();
    const help = trustTierHelp(declare!);
    for (const tier of OutpostTrustTierSchema.options) {
      expect(help, `--trust-tier help omits the accepted tier '${tier}'`).toContain(tier);
    }
  });

  it("N1: `outpost set --trust-tier` documents EVERY tier the API accepts", () => {
    const set = findCommand(program, ["federation", "outpost", "set"]);
    expect(set).toBeDefined();
    const help = trustTierHelp(set!);
    for (const tier of OutpostTrustTierSchema.options) {
      expect(help, `--trust-tier help omits the accepted tier '${tier}'`).toContain(tier);
    }
  });

  it("N1: neither help string offers a tier the API would REJECT", () => {
    // The other direction of the same drift: a help text listing a member the enum dropped would
    // send an operator straight into a 400. Both strings are checked against the enum, so any token
    // that looks like a tier must BE one.
    const accepted = new Set<string>(OutpostTrustTierSchema.options);
    for (const path of [
      ["federation", "outpost", "declare"],
      ["federation", "outpost", "set"]
    ]) {
      const help = trustTierHelp(findCommand(program, path)!);
      const offered = (help.split(/\s+/)[0] ?? "").split("|");
      expect(offered.length).toBeGreaterThan(1);
      for (const token of offered) {
        expect(accepted.has(token), `--trust-tier help offers '${token}', which the API rejects`).toBe(
          true
        );
      }
    }
  });

  it("N2: the recovery verb `outpost reconcile` exists and takes the peer it un-wedges", () => {
    const reconcile = findCommand(program, ["federation", "outpost", "reconcile"]);
    expect(reconcile, "`scp federation outpost reconcile` is missing").toBeDefined();
    const peer = reconcile!.options.find((o) => o.long === "--peer");
    expect(peer).toBeDefined();
    expect(peer!.required).toBe(true);
  });

  it("N2: every SDK federation-outpost verb has a command (API -> SDK -> CLI parity)", () => {
    // The census that would have caught N2 at the time: the four write/read verbs plus the recovery
    // verb. Checked as a SET so a future SDK addition with no command fails here rather than in a
    // review round.
    const outpost = findCommand(program, ["federation", "outpost"]);
    expect(outpost).toBeDefined();
    const names = outpost!.commands.map((c) => c.name()).sort();
    expect(names).toEqual(["declare", "list", "reconcile", "set", "show"]);
  });

  /**
   * M1 (review round 6) — THE RECOVERY COMMAND MUST NOT DESCRIBE A JOURNALED, DOWNSTREAM-PROPAGATING
   * DELETE OF THIS DOMAIN'S OWN CONFIG AS "removed N unverified shadow(s)". That wording is true only
   * for `removedShadowObjectIds` (a stray hand-typed copy this domain never authored — nothing rides
   * the journal). For `removedLocalObjectIds` (the `?keep=` verified-duplicate escape, N9) it is false:
   * the row dropped is this domain's OWN declared config, and the tombstone journals down to the
   * outpost. The two cases must read differently — this test fails if they are ever collapsed back
   * into one bucket/one sentence, which is exactly the regression a `removedObjectIds.length` mutant
   * would reintroduce.
   */
  function fakeConfig() {
    return {
      objectId: "00000000-0000-0000-0000-000000000001",
      urn: "urn:scp:test:outpost:x",
      name: "x",
      peerDomainId: "00000000-0000-0000-0000-000000000002",
      trustTier: null,
      originDomainId: "00000000-0000-0000-0000-000000000003",
      revision: 1,
      version: 1,
      unknownFields: [] as string[],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    } as unknown as OutpostConfigReconcileResult["config"];
  }

  it("M1: a removed SHADOW and a removed LOCAL-ORIGIN row produce DIFFERENT output", () => {
    const shadowRemoval: OutpostConfigReconcileResult = {
      config: fakeConfig(),
      adoptedObjectId: null,
      removedShadowObjectIds: ["shadow-id-1"],
      removedLocalObjectIds: []
    };
    const localRemoval: OutpostConfigReconcileResult = {
      config: fakeConfig(),
      adoptedObjectId: null,
      removedShadowObjectIds: [],
      removedLocalObjectIds: ["local-id-1"]
    };

    const shadowLines = formatReconcileResultLines(shadowRemoval).join("\n");
    const localLines = formatReconcileResultLines(localRemoval).join("\n");

    // The two outputs must differ — pins the M1 fix directly, not just via a substring.
    expect(shadowLines).not.toEqual(localLines);

    // The shadow case must NOT claim a journal/propagation, and must call it a shadow.
    expect(shadowLines).toMatch(/unverified shadow/i);
    expect(shadowLines).not.toMatch(/journal/i);
    expect(shadowLines).not.toMatch(/propagat/i);

    // The local-origin case MUST say plainly that this domain's own row was deleted and that it
    // journals/propagates downstream — an operator must be able to tell the two apart.
    expect(localLines).toMatch(/this domain authored|this domain's own/i);
    expect(localLines).toMatch(/journal/i);
    expect(localLines).toMatch(/propagat/i);
    expect(localLines).not.toMatch(/unverified shadow/i);
  });

  it("M1: with nothing removed, the message says so without naming either bucket", () => {
    const nothing: OutpostConfigReconcileResult = {
      config: fakeConfig(),
      adoptedObjectId: null,
      removedShadowObjectIds: [],
      removedLocalObjectIds: []
    };
    const lines = formatReconcileResultLines(nothing).join("\n");
    expect(lines).toMatch(/nothing/i);
    expect(lines).not.toMatch(/unverified shadow/i);
    expect(lines).not.toMatch(/journal/i);
  });
});
