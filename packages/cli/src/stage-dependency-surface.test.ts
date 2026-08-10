import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import { ChangeStageDependencyStatusSchema } from "@scp/schemas";
import type { ChangeStageDependencyStatus, ChangeStageDependencyVerdict } from "@scp/schemas";
import { buildProgram, formatStageDependencyLines } from "./cli.js";

/**
 * ADR-0028 increment 4 — the CLI half of the hold's operator surfaces.
 *
 * WHAT THIS FILE IS FOR. Until increment 4 a held wave target reached the CLI as exactly one line in
 * `explain`'s flat Decision list, indistinguishable from a gate or a transition, and `scp change
 * wait-status` reported on the OTHER coupling entirely (`requires`) — so the operator best placed to
 * act had to already know to go read a Decision's `inputContext`. These pin the rendering that fixes
 * that: the dependency by name, the stage it is scoped to, and WHICH BRANCH held it, because ADR-0028
 * decision 4 made the branches distinguishable precisely so the remedies could differ.
 *
 * EVERY FIXTURE IS VALIDATED AGAINST `ChangeStageDependencyStatusSchema` ITSELF (`held()` below)
 * rather than hand-typed to match the renderer. A retyped literal is the fixture-that-never-applied
 * failure this repo keeps meeting: it would let a server-side shape change leave this file green
 * while the renderer read a field that no longer arrives.
 *
 * THE ASSERTIONS ARE ON WHAT IS SAID, NOT ON HOW. They check that a name, a place, a branch or a
 * fail-open APPEARS — never that a whole sentence matches, which would pin wording and pass for the
 * wrong reason the moment the sentence was reworded without the field being read at all.
 */

const TARGET_ID = "019f0000-0000-4000-8000-000000000001";
const COMPONENT_ID = "019f0000-0000-4000-8000-000000000002";
const PLACE_ID = "019f0000-0000-4000-8000-000000000003";
const DEPENDENCY_ID = "019f0000-0000-4000-8000-000000000004";

function verdict(overrides: Partial<ChangeStageDependencyVerdict> = {}) {
  return {
    dependsOn: DEPENDENCY_ID,
    dependsOnName: "payments-api",
    branch: "never_deployed" as const,
    satisfied: false,
    summary: `'${DEPENDENCY_ID}' is placed here but has never deployed here`,
    ...overrides
  };
}

/** The fail-open verdict WITH the sentence the server really produces for it — `describeBranch`'s
 *  default arm reads "'<id>' is satisfied here (unscopeable)". Written out because the whole point of
 *  the `unscopeable` cases below is that the renderer must contradict that word. */
function unscopeableVerdict(): ChangeStageDependencyVerdict {
  return verdict({
    branch: "unscopeable",
    satisfied: true,
    summary: `'${DEPENDENCY_ID}' is satisfied here (unscopeable)`
  });
}

/** The indented per-dependency lines only — the target/header/footer lines are asserted separately,
 *  and a mark assertion has to be anchored to the line it marks. */
function dependencyLines(status: ChangeStageDependencyStatus): string[] {
  return formatStageDependencyLines(status, true).filter((line) => line.startsWith("      - "));
}

/** A status carrying one wave target at one place. Parsed through the schema, so a field the server
 *  stopped sending (or started requiring) fails HERE rather than silently reading `undefined`. */
function held(
  dependencies: ChangeStageDependencyVerdict[],
  overrides: Partial<ChangeStageDependencyStatus> = {}
): ChangeStageDependencyStatus {
  return ChangeStageDependencyStatusSchema.parse({
    held: dependencies.some((d) => !d.satisfied),
    waveIndex: 0,
    unenforced: dependencies.some((d) => d.branch === "unscopeable"),
    targets: [
      {
        targetObjectId: TARGET_ID,
        targetName: "checkout-api @ prod-eu",
        componentObjectId: COMPONENT_ID,
        componentName: "checkout-api",
        deploymentTargetObjectId: PLACE_ID,
        deploymentTargetName: "prod-eu",
        held: dependencies.some((d) => !d.satisfied),
        dependencies
      }
    ],
    ...overrides
  });
}

describe("formatStageDependencyLines (ADR-0028 increment 4)", () => {
  it("names the dependency, the stage, AND the branch that held it", () => {
    // The three things an operator needs to act without opening the API: WHO is being waited on,
    // WHERE (a stage-scoped hold that could not say where is no better than the `pending` badge it
    // replaces), and WHY — the branch, because `never_deployed` and `behind` have different remedies.
    const text = formatStageDependencyLines(held([verdict()]), true).join("\n");
    expect(text).toContain("payments-api");
    expect(text).toContain("prod-eu");
    expect(text).toContain("checkout-api");
    expect(text).toContain("never_deployed");
    expect(text).toContain("HELD");
  });

  it("passes the server's own sentence through verbatim, never a CLI re-wording of it", () => {
    // That sentence is `describeStageDependencyHold`'s output — the SAME text the hold Decision's
    // `reasonTree` is built from. Re-phrasing it here would let the CLI and the audit record account
    // for one verdict two different ways, which is the drift ADR-0028's shared describer exists to
    // prevent. A deliberately odd sentence, so this cannot pass by coincidence.
    const sentence = "a sentence only the server could have produced";
    const text = formatStageDependencyLines(held([verdict({ summary: sentence })]), true).join(
      "\n"
    );
    expect(text).toContain(sentence);
  });

  it("marks an `unscopeable` verdict NOT ENFORCED, never 'satisfied' — it carries satisfied: true", () => {
    // THE FAIL-OPEN. `unscopeable` means the wave target names a component rather than a placement,
    // so there was no stage to scope by and the declared coupling was NOT APPLIED. It is satisfied on
    // the wire because the release proceeds; rendering that word would tell an operator their
    // coupling held when nothing was ever checked. ADR-0028 gave it its own branch so it would be
    // findable — this is the CLI honouring that rather than flattening it back into "satisfied".
    //
    // THE FIXTURE CARRIES THE SERVER'S REAL SENTENCE, which itself says "is satisfied here" (that is
    // `describeBranch`'s default arm). A blanket "the line must not contain 'satisfied'" would
    // therefore be a fixture that only passed because it was written unrealistically — so the
    // assertion is on the MARK this renderer chooses, with the server's sentence still printed
    // verbatim beside it.
    const status = held([unscopeableVerdict()]);
    const line = dependencyLines(status)[0]!;
    expect(line).toMatch(/^\s+- NOT ENFORCED \[unscopeable\]/);
    expect(line).toContain("is satisfied here (unscopeable)");
  });

  it("says a coupling went unenforced even when the held/clear line above it reads 'clear'", () => {
    // `unenforced` is the live counterpart of the `stage_dependency_unscoped` warn Decision, and it
    // is the case where saying nothing is worst: the target is NOT held, so every other line on the
    // screen reads like a healthy release.
    const status = held([unscopeableVerdict()]);
    expect(status.held).toBe(false);
    const text = formatStageDependencyLines(status, true).join("\n");
    expect(text).toContain("NOT ENFORCED");
    expect(text).toContain("stage_dependency_unscoped");
  });

  it("marks a satisfied verdict satisfied, and the target clear — the section is not a hold-only view", () => {
    const status = held([
      verdict({
        branch: "succeeded",
        satisfied: true,
        summary: `'${DEPENDENCY_ID}' is satisfied here (succeeded)`
      })
    ]);
    const text = formatStageDependencyLines(status, true).join("\n");
    expect(dependencyLines(status)[0]!).toMatch(/^\s+- satisfied \[succeeded\]/);
    expect(text).toContain("none held");
    expect(text).not.toContain("HELD");
  });

  it("says a target has no placement instead of printing a place called `null`", () => {
    // Both halves null is the legacy-shaped target (`unscopeable`'s cause). `${null} @ ${null}` is
    // the fabrication this refuses — it reads as a real stage named "null".
    const status = held([unscopeableVerdict()], {
      targets: [
        {
          targetObjectId: TARGET_ID,
          targetName: "legacy-target",
          componentObjectId: null,
          componentName: null,
          deploymentTargetObjectId: null,
          deploymentTargetName: null,
          held: false,
          dependencies: [unscopeableVerdict()]
        }
      ]
    });
    const text = formatStageDependencyLines(status, true).join("\n");
    expect(text).not.toContain("null");
    expect(text).toContain("no placement");
  });

  it("falls back to ids when a name does not resolve, and never renders the id AS a name", () => {
    // A deleted component resolves to no name. The id is still actionable; a fabricated name is not.
    const status = held([verdict({ dependsOnName: null })], {
      targets: [
        {
          targetObjectId: TARGET_ID,
          targetName: null,
          componentObjectId: COMPONENT_ID,
          componentName: null,
          deploymentTargetObjectId: PLACE_ID,
          deploymentTargetName: null,
          held: true,
          dependencies: [verdict({ dependsOnName: null })]
        }
      ]
    });
    const text = formatStageDependencyLines(status, true).join("\n");
    expect(text).toContain(COMPONENT_ID);
    expect(text).toContain(PLACE_ID);
  });

  it("distinguishes 'this change coupled nothing' from 'this server said nothing at all'", () => {
    // THE TWO ABSENCES ARE DIFFERENT CLAIMS. `null` is the server reporting no coupling; an omitted
    // key is a pre-increment-4 server, which is contract-legal for an `.optional()` field and passes
    // ADR-0023's response validation untouched. Printing "coupled nothing" for the second would be a
    // fabricated observation about a change that may well be held — the exact class
    // `cli-absent-formatters.test.ts` exists for, arriving here through the SAME door.
    const coupledNothing = formatStageDependencyLines(null, true).join("\n");
    const serverSilent = formatStageDependencyLines(undefined, true).join("\n");
    expect(coupledNothing).not.toEqual(serverSilent);
    expect(coupledNothing).toContain("coupled nothing");
    expect(serverSilent).toContain("predates");
    // Embedded in `explain`, neither absence is worth a line — there is a whole plan below it.
    expect(formatStageDependencyLines(null, false)).toEqual([]);
    expect(formatStageDependencyLines(undefined, false)).toEqual([]);
  });

  it("reports an empty target list as 'nothing awaiting a trigger', not as 'none held'", () => {
    // Distinct situations: every target of the active wave has already been triggered (so no hold can
    // apply), versus targets were evaluated and cleared. "0 targets, none held" would read as the
    // second while meaning the first.
    const status = held([], { held: false, targets: [], unenforced: false });
    const text = formatStageDependencyLines(status, true).join("\n");
    expect(text).toContain("no wave target is awaiting a trigger");
  });

  it("names the wave it is reporting on, and says so when there is none", () => {
    expect(formatStageDependencyLines(held([verdict()]), true).join("\n")).toContain("wave 0");
    const noWave = held([verdict()], { waveIndex: null });
    expect(formatStageDependencyLines(noWave, true).join("\n")).toContain("no active wave");
  });

  it("marks an edge-derived dependency, whose remedy is deleting an edge rather than editing CI", () => {
    const status = held([
      verdict({
        source: "edge",
        summary:
          "'x' has not succeeded here (a `depends_on` edge between two targets of this change)"
      })
    ]);
    expect(formatStageDependencyLines(status, true).join("\n")).toContain("depends_on");
  });
});

describe("`scp change wait-status` covers BOTH couplings (ADR-0028 increment 4)", () => {
  function findCommand(root: Command, path: string[]): Command | undefined {
    let current: Command | undefined = root;
    for (const name of path) {
      current = current?.commands.find((c) => c.name() === name);
      if (current === undefined) return undefined;
    }
    return current;
  }

  it("its help text describes the stage-dependency coupling too, not `requires` alone", () => {
    // THE WORDING TRAP, pinned deliberately. The description was hard-coded to "M12 P4B: print ONLY a
    // Change's coupled-pipeline wait status — which `requires` prerequisites…". Teaching the command
    // a second coupling while leaving that sentence would make the help text FALSE, and it is the
    // only documentation an operator gets at the terminal. This is an assertion about coverage (both
    // couplings are named), not about phrasing.
    const command = findCommand(buildProgram(), ["change", "wait-status"]);
    expect(command).toBeDefined();
    const description = command!.description();
    expect(description).toContain("requires");
    expect(description).toContain("stage dependencies");
  });

  it("`scp decision list` offers --kind beside --subject-id — the coupling is queryable without a change id", () => {
    // The other half of the same operator question. `--subject-id` alone requires already knowing the
    // change; "was my coupling enforced here?" is asked by someone who does not.
    const command = findCommand(buildProgram(), ["decision", "list"]);
    expect(command).toBeDefined();
    const longs = command!.options.map((o) => o.long);
    expect(longs).toContain("--kind");
    expect(longs).toContain("--subject-id");
  });
});
