/**
 * THE TWO ECOSYSTEM VOCABULARIES MUST BE THE SAME LIST.
 *
 * This test exists because they were not. M21.2's parsers and its schema/migration were built in
 * parallel by separate agents, and the container ecosystem was named `"image"` in
 * `dependency-manifests/types.ts` and `"oci"` in `@scp/schemas/dependencies`. Both sides were fully
 * green: the parsers proved they emit what they say, and the repo layer proved it stores what it
 * accepts. Neither test crossed the boundary, so nothing failed — until ingestion (M21.3) would have
 * tried to write a Dockerfile-derived row and been rejected by the Zod enum and the DB check
 * constraint at the same time. Every `FROM` line in the estate, silently unsubscribable.
 *
 * That is the "vacuous tests" failure mode in its cross-package form: a suite that is green for the
 * wrong reason because the property it asserts is *local* while the property that matters is a
 * *contract between two modules*. The fix is not to have renamed one constant — it is this file,
 * which makes the next divergence a red test instead of a runtime rejection.
 *
 * WHY THE RUNTIME IMPORT IS DEV-ONLY. `@scp/dependency-manifests` is deliberately dependency-free at
 * runtime: the parsers are pure string->data functions, which is what lets them be unit-tested with
 * no database, no network and no plugin host. Importing `@scp/schemas` for real would drag Zod into
 * that. So the schema is a devDependency and appears only here, in the one place whose whole job is
 * to compare the two lists.
 *
 * `oci`, NOT `image`, is the agreed spelling: `image` is already a value of the executor `type` enum
 * (`packages/schemas/src/executors.ts:32`) meaning "a build that PRODUCES an image artifact", where
 * this axis records what a component CONSUMES. That is the same collision class as bare
 * `subscription` (notification_bindings) and bare `manifest` (the promotion manifest), both settled
 * in GLOSSARY.md.
 */
import { describe, expect, it } from "vitest";
import { DependencyEcosystemSchema } from "@scp/schemas";

import { parseDockerfile } from "./dockerfile.js";
import { parseKubernetesImages } from "./kubernetes-images.js";
import type { DependencyEcosystem } from "./types.js";

/**
 * The parser package's list, written out as VALUES rather than derived from the type.
 *
 * A `satisfies`-only check would be vacuous: TypeScript erases at runtime, so a type-level assertion
 * proves nothing about what `parseDockerfile` actually puts in the field. The `satisfies` clause below
 * still earns its place — it makes this array fail to COMPILE if someone adds a member to
 * `DependencyEcosystem` without adding it here — so the two mechanisms cover different halves:
 * compile-time catches a missing member, the runtime comparison catches a renamed one.
 */
const PARSER_ECOSYSTEMS = [
  "npm",
  "go",
  "maven",
  "python",
  "oci"
] as const satisfies readonly DependencyEcosystem[];

describe("ecosystem vocabulary", () => {
  it("is the identical set on both sides of the parser/schema boundary", () => {
    const schemaValues = [...DependencyEcosystemSchema.options].sort();
    const parserValues = [...PARSER_ECOSYSTEMS].sort();

    // Compared as SETS, not as a length or a subset: a subset check would pass while the parser
    // emitted a value the schema rejects, which is the exact defect this file was written for.
    expect(parserValues).toEqual(schemaValues);
  });

  it("agrees specifically on the container ecosystem, which is the one that drifted", () => {
    expect(DependencyEcosystemSchema.options).toContain("oci");
    expect(DependencyEcosystemSchema.options).not.toContain("image");
    expect(PARSER_ECOSYSTEMS).not.toContain("image" as DependencyEcosystem);
  });

  /**
   * The end-to-end half. The two checks above compare two hand-written lists, which drift together
   * if someone edits both and still gets the value wrong. This one takes the value out of the
   * PARSER'S ACTUAL OUTPUT and pushes it through the SCHEMA'S ACTUAL VALIDATOR — the same two pieces
   * that will meet in M21.3's ingestion path.
   */
  it("accepts the ecosystem the Dockerfile parser really emits", () => {
    const deps = parseDockerfile("FROM alpine:1.0\n");
    expect(deps).toHaveLength(1);

    const emitted = deps[0]?.ecosystem;
    expect(emitted).toBe("oci");
    // Would have thrown on `"image"`. This is the assertion that fails first if the rename regresses.
    expect(() => DependencyEcosystemSchema.parse(emitted)).not.toThrow();
  });

  it("the SECOND image parser emits the SAME ecosystem — a values file is not a sixth vocabulary", () => {
    // M21.7 added a second producer of `oci` rows. The whole design rests on an image pinned in a
    // chart's `values.yaml` being the SAME `dependency_lines` row as the same image pinned in a
    // `FROM`; a parser that spelled it anything else would mint a parallel, unmatchable set of
    // lines — this file's own drift, arriving from a new direction.
    const deps = parseKubernetesImages("image: acme/api:1.2.3\n");
    expect(deps).toHaveLength(1);
    expect(deps[0]?.ecosystem).toBe("oci");
    expect(() => DependencyEcosystemSchema.parse(deps[0]?.ecosystem)).not.toThrow();
  });

  /**
   * NEGATIVE CONTROL. Everything above asserts that something is ACCEPTED; on its own that is
   * satisfied by a validator that accepts everything, which would make the whole file vacuous.
   */
  it("rejects an ecosystem neither side declares", () => {
    expect(() => DependencyEcosystemSchema.parse("cargo")).toThrow();
    expect(() => DependencyEcosystemSchema.parse("image")).toThrow();
  });
});
