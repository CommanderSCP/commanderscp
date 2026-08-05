import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import { StageDependencySchema } from "@scp/schemas";
import { buildProgram, parseStageDependenciesFlags } from "./cli.js";

/**
 * ADR-0028 increment 1 — the CLI half of the declaration channel (charter principle 3: API → SDK →
 * CLI → IaC → UI). `scp change-source report` is THE channel a microservice's CI declares through,
 * so the flags are the surface an engineer actually types.
 *
 * Every parse result is validated against `StageDependencySchema` itself rather than a retyped
 * literal, so a future schema change cannot leave the flag parser emitting a shape the API refuses.
 */
function findCommand(root: Command, path: string[]): Command | undefined {
  let current: Command | undefined = root;
  for (const name of path) {
    current = current?.commands.find((c) => c.name() === name);
    if (current === undefined) return undefined;
  }
  return current;
}

describe("--stage-depends-on / --stage-depends-at (ADR-0028)", () => {
  it("both flags exist on BOTH declaration commands — propose and change-source report", () => {
    // The report command is the headline path (a microservice's CI), but a coupling declared through
    // `POST /changes` must be typeable too, or the CLI half of parity is only half done.
    const program = buildProgram();
    for (const path of [
      ["change", "propose"],
      ["change-source", "report"]
    ]) {
      const command = findCommand(program, path);
      expect(command, `${path.join(" ")} is missing`).toBeDefined();
      const longs = command!.options.map((o) => o.long);
      expect(longs, path.join(" ")).toContain("--stage-depends-on");
      expect(longs, path.join(" ")).toContain("--stage-depends-at");
    }
  });

  it("omitting --stage-depends-on sends nothing at all — the field stays absent, not an empty array", () => {
    // An empty array would be a DECLARATION of "no dependencies"; absence is "did not say". They
    // must not be conflated on a field whose whole job is to declare.
    expect(parseStageDependenciesFlags(undefined, undefined)).toBeUndefined();
  });

  it("parses a bare list of component references", () => {
    const parsed = parseStageDependenciesFlags("comp-b, urn:scp:acme:component:c", undefined);
    expect(parsed).toEqual([{ dependsOn: "comp-b" }, { dependsOn: "urn:scp:acme:component:c" }]);
    for (const entry of parsed!) expect(StageDependencySchema.parse(entry)).toEqual(entry);
  });

  it("parses the @minWeight qualifier, splitting on the LAST '@' so a URN survives", () => {
    // A URN carries ':' but never '@' — the same reasoning `parseRequiresFlag` is built on.
    const parsed = parseStageDependenciesFlags(
      "urn:scp:acme:component:c@10, comp-b@100",
      undefined
    );
    expect(parsed).toEqual([
      { dependsOn: "urn:scp:acme:component:c", minWeight: 10 },
      { dependsOn: "comp-b", minWeight: 100 }
    ]);
    for (const entry of parsed!) expect(StageDependencySchema.parse(entry)).toEqual(entry);
  });

  it("--stage-depends-at scopes EVERY entry to the same deployment targets", () => {
    const parsed = parseStageDependenciesFlags("comp-b@10, comp-c", "dt-gamma, dt-prod");
    expect(parsed).toEqual([
      { dependsOn: "comp-b", minWeight: 10, atTargets: ["dt-gamma", "dt-prod"] },
      { dependsOn: "comp-c", atTargets: ["dt-gamma", "dt-prod"] }
    ]);
  });

  it("a present-but-unparseable weight is a LOUD error, never a silent drop to 'no qualifier'", () => {
    // Dropping it would quietly WIDEN the hold: the author asked to proceed at 10%, and would
    // instead wait for the dependency's whole stage deploy to finish.
    for (const bad of ["comp-b@", "comp-b@abc", "comp-b@0", "comp-b@101", "comp-b@10.5", "@10"]) {
      expect(() => parseStageDependenciesFlags(bad, undefined), bad).toThrow(
        /--stage-depends-on entry/
      );
    }
  });

  it("--stage-depends-at without --stage-depends-on is refused rather than silently ignored", () => {
    // Scoping nothing is a typo every time, and accepting it would report success for a coupling
    // the operator believes they declared.
    expect(() => parseStageDependenciesFlags(undefined, "dt-gamma")).toThrow(
      /no effect without --stage-depends-on/
    );
  });
});
