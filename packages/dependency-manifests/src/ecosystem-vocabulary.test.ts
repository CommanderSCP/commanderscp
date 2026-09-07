/** The two ecosystem vocabularies must be one list. See docs/dependency-manifests.md §13. */
import { describe, expect, it } from "vitest";
import { DependencyEcosystemSchema } from "@scp/schemas";

import { parseDockerfile } from "./dockerfile.js";
import { parseKubernetesImages } from "./kubernetes-images.js";
import type { DependencyEcosystem } from "./types.js";

/** Written as values, because `satisfies` is vacuous. See docs/dependency-manifests.md §14. */
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

  /** The end-to-end half. See docs/dependency-manifests.md §15. */
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
