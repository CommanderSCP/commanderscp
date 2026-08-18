import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import type { DependencyProducerLineImpact, DependencyProducerOpenBump } from "@scp/schemas";
import {
  buildProgram,
  dependencyProducerLineRow,
  dependencyProducerListRow,
  dependencyProducerManagementNote,
  dependencyProducerOpenBumpRow
} from "./cli.js";

/**
 * `scp dependency-producers` — THE CLI HALF OF THE PRODUCER DECLARATION (ADR-0032 §7e).
 *
 * Charter principle 3 is API → SDK → CLI, so a capability that stops at the SDK is a parity hole.
 * What only this layer can hold:
 *
 *  1. **THE THREE VERBS EXIST, AND `--dry-run` IS ARGUMENT-LESS ON BOTH WRITES.** A
 *     `--dry-run <bool>` with a default is how "the operator said nothing" silently becomes a value,
 *     and here the two values are "look" and "change every subscriber's upstream". The list is
 *     CLOSED, because a fourth verb that quietly retracted (a `--producer none`) would be exactly
 *     the destructive default the API refused to build.
 *
 *  2. **THE FORMATTERS ARE HONEST ABOUT ABSENCE AND ABOUT WHAT WAS LOST.** They are exported and
 *     called DIRECTLY here for the reason `cli-absent-formatters.test.ts` records at length: a
 *     mapper written inline in a Commander `.action()` closure is unreachable by any test, so its
 *     guards are correct and completely unheld.
 *
 *  3. **THE `dependencyManagement` CAVEAT IS HELD IN BOTH DIRECTIONS.** M21.7's measured failure was
 *     an inline note whose condition, when inverted, warned the healthy deployment and went SILENT
 *     on the one it exists for — with the whole suite green. A conditional caveat is only held when
 *     both arms are pinned.
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

describe("scp dependency-producers — the CLI surface (ADR-0032 §7e)", () => {
  const program = buildProgram();
  const root = findCommand(program, ["dependency-producers"]);

  it("exists, with exactly the list/declare/retract trio", () => {
    expect(root).toBeDefined();
    // A CLOSED list. `declare` and `retract` are separate verbs on purpose: a single verb switched
    // by a nullable producer is how an omitted value becomes a destructive default.
    expect(root!.commands.map((c) => c.name()).sort()).toEqual(["declare", "list", "retract"]);
  });

  it("says out loud that this needs ORG-ROOT authority, and why", () => {
    // The surprising part — the producing component's own team is deliberately NOT enough — belongs
    // in the help, not in a 403 the operator has to interpret.
    expect(root!.description()).toMatch(/ORG ROOT/);
    expect(root!.description()).toMatch(/policy:write/);
  });

  it("`declare` requires the coordinate, the ecosystem AND the producer — a partial key declares the wrong package", () => {
    const declare = findCommand(program, ["dependency-producers", "declare"]);
    expect(declare).toBeDefined();
    // `mandatory` (set by `.requiredOption`), NOT `required` — `required` is true for ANY option
    // that takes an argument, so `--base-url <url>` would satisfy it and the assertion would pass
    // no matter which flags were optional.
    const mandatory = declare!.options
      .filter((o) => o.mandatory)
      .map((o) => o.long)
      .sort();
    expect(mandatory).toEqual(["--coordinate", "--ecosystem", "--producer"]);
    // The coordinate is compared byte-for-byte on the server; an operator who assumes it is
    // normalised will declare a package nobody named.
    expect(declare!.options.find((o) => o.long === "--coordinate")?.description).toMatch(
      /verbatim/i
    );
  });

  it("`--dry-run` takes NO argument and has NO default, on BOTH write verbs", () => {
    for (const verb of ["declare", "retract"]) {
      const command = findCommand(program, ["dependency-producers", verb]);
      const option = command!.options.find((o) => o.long === "--dry-run");
      expect(option, `${verb} must offer --dry-run`).toBeDefined();
      expect(option!.flags, "--dry-run must take no argument").not.toMatch(/[<[]/);
      expect(option!.defaultValue, "--dry-run must have no default").toBeUndefined();
    }
  });

  it("has NO verb that retracts by omission — `--producer` is required, never nullable", () => {
    const declare = findCommand(program, ["dependency-producers", "declare"]);
    const producer = declare!.options.find((o) => o.long === "--producer");
    expect(producer!.mandatory).toBe(true);
    // ...and no alias for "none"/"clear" crept in beside it.
    for (const forbidden of ["--none", "--clear", "--unset", "--no-producer"]) {
      expect(declare!.options.map((o) => o.long)).not.toContain(forbidden);
    }
  });

  it("`retract` says that SCP does not close the bumps already in flight", () => {
    // The single most surprising consequence of retracting, and the one an operator must act on by
    // hand. A help text that omitted it would let someone believe retraction recalled the PRs.
    const retract = findCommand(program, ["dependency-producers", "retract"]);
    expect(retract!.description()).toMatch(/does NOT close/i);
  });
});

describe("the producer-declaration CLI formatters", () => {
  const impact: DependencyProducerLineImpact = {
    lineId: "0198f000-0000-7000-8000-000000000001",
    major: "2",
    tagPattern: null,
    headBefore: {
      latestVersion: "2.7.0",
      latestDigest: null,
      latestObservedAt: "2026-08-17T00:00:00.000Z"
    },
    headCleared: true,
    subscribedComponentObjectIds: [
      "0198f000-0000-7000-8000-000000000002",
      "0198f000-0000-7000-8000-000000000003"
    ],
    subscribedComponents: [
      { objectId: "0198f000-0000-7000-8000-000000000002", name: "checkout-api" },
      { objectId: "0198f000-0000-7000-8000-000000000003", name: "billing-worker" }
    ]
  };

  it("prints WHAT WAS LOST and WHOSE repositories this reaches — the two facts the request never names", () => {
    const row = dependencyProducerLineRow(impact);
    expect(row.headWas).toBe("2.7.0");
    expect(row.headCleared).toBe("true");
    // The blast radius. The declarer names one coordinate and affects components they cannot see.
    expect(row.subscribers).toBe("2");
    expect(row.major).toBe("2");
  });

  it("renders a line with NOTHING observed as `-`, and distinguishes it from one that was cleared", () => {
    // `-`, never a blank and never "none": absent means NOT OBSERVED, which is not the same claim
    // as "no newer version exists" (ADR-0032 §7's reading of the nullable head).
    const untouched = dependencyProducerLineRow({
      ...impact,
      headBefore: { latestVersion: null, latestDigest: null, latestObservedAt: null },
      headCleared: false
    });
    expect(untouched.headWas).toBe("-");
    // AND the two situations are distinguishable, which is why `headCleared` is its own column:
    // printing only `headWas` would render "there was a head and it is gone" identically to "there
    // was nothing to clear".
    expect(untouched.headCleared).toBe("false");
    expect(dependencyProducerLineRow(impact).headCleared).toBe("true");
  });

  it("NAMES the subscribers beside the count — the teams whose repositories this act reaches", () => {
    // Server-side names (dependency-subscription-ui.md §12.6 Q1): the operator confirming a
    // declaration is about to affect these repositories, and an id is not a name they can act on.
    expect(dependencyProducerLineRow(impact).subscribedNames).toBe("checkout-api, billing-worker");
    // A name the server could not resolve (`""` — see `namesForObjectIds`) falls back to the ID,
    // never to a blank that would make the list shorter than the count.
    expect(
      dependencyProducerLineRow({
        ...impact,
        subscribedComponents: [
          { objectId: "0198f000-0000-7000-8000-000000000002", name: "" },
          { objectId: "0198f000-0000-7000-8000-000000000003", name: "billing-worker" }
        ]
      }).subscribedNames
    ).toBe("0198f000-0000-7000-8000-000000000002, billing-worker");
    // An OLDER server (no names array) or an EMPTY radius prints `-`, not a fabricated list.
    expect(dependencyProducerLineRow(without(impact, "subscribedComponents")).subscribedNames).toBe(
      "-"
    );
    expect(
      dependencyProducerLineRow({ ...impact, subscribedComponentObjectIds: [], subscribedComponents: [] })
        .subscribedNames
    ).toBe("-");
  });

  it("the list row prints the producer's and the declarer's NAMES, ids beside them, id when unnamed", () => {
    const row = dependencyProducerListRow({
      orgId: "0198f000-0000-7000-8000-0000000000aa",
      ecosystem: "npm",
      coordinate: "@acme/lib",
      producerObjectId: "0198f000-0000-7000-8000-000000000002",
      declaredAt: "2026-08-18T00:00:00.000Z",
      declaredByObjectId: "0198f000-0000-7000-8000-0000000000bb",
      producer: { objectId: "0198f000-0000-7000-8000-000000000002", name: "checkout-api" },
      declaredBy: { objectId: "0198f000-0000-7000-8000-0000000000bb", name: "admin" }
    });
    expect(row.producer).toBe("checkout-api");
    expect(row.producerId).toBe("0198f000-0000-7000-8000-000000000002");
    expect(row.declaredBy).toBe("admin");
    // The coordinate is VERBATIM — `@acme/lib`, never a slug.
    expect(row.coordinate).toBe("@acme/lib");
    // Unnamed (the server could not resolve the row) -> the id, never a blank cell.
    expect(
      dependencyProducerListRow({
        orgId: "0198f000-0000-7000-8000-0000000000aa",
        ecosystem: "npm",
        coordinate: "@acme/lib",
        producerObjectId: "0198f000-0000-7000-8000-000000000002",
        declaredAt: "2026-08-18T00:00:00.000Z",
        declaredByObjectId: "0198f000-0000-7000-8000-0000000000bb",
        producer: { objectId: "0198f000-0000-7000-8000-000000000002", name: "" },
        declaredBy: { objectId: "0198f000-0000-7000-8000-0000000000bb", name: "" }
      }).producer
    ).toBe("0198f000-0000-7000-8000-000000000002");
  });

  it("never fabricates a subscriber count when the server omitted the array", () => {
    expect(
      dependencyProducerLineRow(without(impact, "subscribedComponentObjectIds")).subscribers
    ).toBe("0");
    // NEGATIVE CONTROL: a present array is counted, so the guard is about ABSENCE and not a column
    // hardcoded to zero.
    expect(dependencyProducerLineRow(impact).subscribers).toBe("2");
  });

  it("prints an in-flight bump's URL only when the server recorded one — never a composed guess", () => {
    // `repo` + a PR number composes a URL for github.com and for nothing else, and the row does not
    // record which provider authored the bump. A guessed link an operator clicks and cannot find is
    // worse than a `-`.
    const bump: DependencyProducerOpenBump = {
      changeObjectId: "0198f000-0000-7000-8000-000000000010",
      componentObjectId: "0198f000-0000-7000-8000-000000000011",
      repo: "acme/api",
      manifestPath: "package.json",
      fromVersion: "2.1.0",
      toVersion: "2.7.0"
    };
    expect(dependencyProducerOpenBumpRow(bump).url).toBe("-");
    expect(dependencyProducerOpenBumpRow(bump).bump).toBe("2.1.0 -> 2.7.0");

    // NEGATIVE CONTROL: a recorded URL is printed verbatim.
    expect(
      dependencyProducerOpenBumpRow({ ...bump, pullRequestUrl: "https://example.test/pr/7" }).url
    ).toBe("https://example.test/pr/7");
  });

  describe("the dependencyManagement caveat", () => {
    it("APPEARS when nothing here manages dependencies, and says an empty list is not evidence", () => {
      const note = dependencyProducerManagementNote({ managedHere: false, reason: "outpost" });
      expect(note).toBeDefined();
      // The posture, so the operator knows WHICH refusal this is — `outpost` and `role_undeclared`
      // have different remedies (call the commander vs set one env var).
      expect(note).toContain("outpost");
      expect(note).toMatch(/COMMANDER/);
      // The actual trap: on a field outpost the table is empty BY DESIGN.
      expect(note).toMatch(/not evidence/i);

      // `role_undeclared` is the branch whose config VALUE reads `commander`; it must reach the
      // note as itself or the sentence names the opposite of the truth.
      expect(
        dependencyProducerManagementNote({ managedHere: false, reason: "role_undeclared" })
      ).toContain("role_undeclared");
    });

    it("is SILENT on a declared commander — the direction whose inversion was fully green in M21.7", () => {
      // A caveat printed on every invocation is one nobody reads, so its absence here is as
      // load-bearing as its presence above.
      expect(
        dependencyProducerManagementNote({ managedHere: true, reason: "commander" })
      ).toBeUndefined();
    });

    it("is SILENT when the server omitted the envelope — absent is not a refusal", () => {
      // A server that predates the field claims no posture, and asserting one it never claimed is
      // the same fabrication the `-` columns exist to avoid. `=== false`, never falsy.
      expect(dependencyProducerManagementNote(undefined)).toBeUndefined();
    });
  });
});
