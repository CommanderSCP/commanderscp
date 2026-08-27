import { describe, expect, it } from "vitest";
import { buildEstateManifest, renderEstateProgram, type ServiceSpec } from "@scp/iac";
import type { DesiredStateManifest } from "@scp/schemas";
import { cleanupCompile, compileGeneratedTs } from "./test-support/ts-harness.js";

/**
 * THE CENTREPIECE: export → synth → compare, executed through the REAL TypeScript compiler and the
 * REAL `@scp/iac` package (team-pipeline-iac.md §9's stated correctness property — "exported ts,
 * when synthesized, must produce a manifest equivalent to the json export of the same scope").
 *
 * `@scp/iac`'s own `estate-program.test.ts` covers the two emitters' behavior in isolation; this file
 * proves the stronger claim neither of those tests can: that the rendered TS source ACTUALLY COMPILES
 * against the published `@scp/iac` surface (not just "looks plausible"), and that RUNNING it produces
 * the same manifest `buildEstateManifest` computes directly from the same `ServiceSpec`.
 *
 * MUTATION-WATCHED (restored before commit — see each case's own note):
 *  - dropping a placement from `renderEstateProgram`'s emission turns "round-trips a full export"
 *    RED (the compared manifests stop matching);
 *  - emitting a plausible fabricated `repo` instead of the loud `undefined` placeholder turns
 *    "the placeholder case FAILS to typecheck" RED (the compile would now succeed).
 */

function fullSpec(): ServiceSpec {
  return {
    stackName: "payments",
    serviceName: "Payments",
    serviceUrn: "urn:scp:acme:service:payments",
    components: [
      {
        constructId: "payments-api",
        name: "payments-api",
        urn: "urn:scp:acme:component:payments-api",
        placements: [
          { targetUrn: "urn:scp:acme:deployment-target:pay-blue", infraKind: "cluster" },
          { targetUrn: "urn:scp:acme:deployment-target:legacy-vm" },
          // Deliberately NOT named by any wave below — the only way to prove the mutation test's
          // "dropped placement" actually removes something: a target a pipeline's waves ALSO name
          // would simply be re-added by D8's own wave inference even if its explicit line vanished.
          { targetUrn: "urn:scp:acme:deployment-target:cold-standby" }
        ],
        pipelines: [
          {
            kind: "image",
            source: { sourceKind: "gitea", repoPattern: "payments/payments-api", branch: "main" },
            waves: [
              { name: "staging", targets: ["urn:scp:acme:deployment-target:pay-blue"] },
              { name: "production", targets: ["urn:scp:acme:deployment-target:legacy-vm"] }
            ],
            publishesTo: {
              destinationUrn: "urn:scp:acme:execution-system:org-registry",
              repository: "payments/payments-api"
            }
          }
        ]
      },
      {
        constructId: "payments-infra",
        name: "payments-infra",
        urn: "urn:scp:acme:component:payments-infra",
        placements: [],
        pipelines: [
          {
            kind: "infrastructure",
            source: { repoPattern: "payments/payments-infra" },
            waves: [{ targets: ["urn:scp:acme:deployment-target:commercial-amer-production"] }]
          }
        ]
      }
    ]
  };
}

function specWithMissingSourceMapping(): ServiceSpec {
  const spec = fullSpec();
  return {
    ...spec,
    components: [
      {
        ...spec.components[0]!,
        pipelines: [
          {
            kind: "image",
            waves: [{ targets: ["urn:scp:acme:deployment-target:pay-blue"] }]
            // No `source` — D18's mandatory-repo case.
          }
        ]
      }
    ]
  };
}

/** Strips manifest fields the round-trip comparison should ignore, so the assertion is about
 *  content, not about object identity of an already-deep-equal structure — currently a no-op
 *  passthrough (there are no such fields; `Stack.synth()` is fully deterministic), kept as an
 *  explicit named step so a future non-deterministic field has one obvious place to be excluded. */
function normalizeForCompare(manifest: DesiredStateManifest): unknown {
  return manifest;
}

describe("export/scaffold round-trip: ts, synthesized, equals the direct json build", () => {
  it("a complete estate's rendered ts compiles AND produces the same manifest as buildEstateManifest", async () => {
    const spec = fullSpec();
    const expected = buildEstateManifest(spec);
    expect(expected.placeholderCount).toBe(0);

    const { source, placeholderCount } = renderEstateProgram(spec);
    expect(placeholderCount).toBe(0);

    const compiled = compileGeneratedTs(source, { emit: true });
    try {
      expect(
        compiled.ok,
        `expected the generated ts to typecheck/compile:\n${compiled.output}`
      ).toBe(true);
      const modUrl = `file://${compiled.outDir}/generated.js`;
      const mod = (await import(modUrl)) as { manifest: DesiredStateManifest };
      expect(normalizeForCompare(mod.manifest)).toEqual(normalizeForCompare(expected.manifest));
    } finally {
      cleanupCompile(compiled);
    }
  });

  it("MUTATION PROOF — dropping a placement from the rendered program breaks the round-trip (restored after)", async () => {
    const spec = fullSpec();
    const expected = buildEstateManifest(spec);
    const rendered = renderEstateProgram(spec);

    // Simulate "the emitter forgot a placement": delete the `cold-standby` `.placeAt(...)` call line
    // from the rendered source before compiling it — this is what a broken generator would produce.
    const mutatedSource = rendered.source.replace(
      /.*\.placeAt\(DeploymentTarget\.fromUrn\("urn:scp:acme:deployment-target:cold-standby"\)\);\n/,
      ""
    );
    expect(mutatedSource).not.toBe(rendered.source);

    const compiled = compileGeneratedTs(mutatedSource, { emit: true });
    try {
      expect(compiled.ok).toBe(true);
      const modUrl = `file://${compiled.outDir}/generated.js`;
      const mod = (await import(modUrl)) as { manifest: DesiredStateManifest };
      // BROKEN: should be 4 (matching `expected`) — `cold-standby` is gone with no wave to re-infer it.
      expect(mod.manifest.placements).toHaveLength(3);
      expect(normalizeForCompare(mod.manifest)).not.toEqual(normalizeForCompare(expected.manifest));
    } finally {
      cleanupCompile(compiled);
    }
  });

  it("a pipeline missing its source mapping renders a loud placeholder that FAILS to typecheck", () => {
    const { source, placeholderCount } = renderEstateProgram(specWithMissingSourceMapping());
    expect(placeholderCount).toBe(1);

    const compiled = compileGeneratedTs(source, { emit: false });
    try {
      expect(compiled.ok, "expected the placeholder to make this file fail to typecheck").toBe(
        false
      );
      expect(compiled.output).toMatch(/not assignable/i);
      expect(source).toContain("TODO_MISSING_REPO_1");
    } finally {
      cleanupCompile(compiled);
    }
  });

  it("MUTATION PROOF — a plausible fabricated repo instead of the placeholder WOULD typecheck (restored after)", () => {
    const { source } = renderEstateProgram(specWithMissingSourceMapping());
    // Simulate "the emitter invented a repo instead of failing loudly": replace the loud placeholder
    // with a plausible-looking real value, matching the exact hazard team-pipeline-iac.md §9 names —
    // "silently inventing a repo would produce a stack that applies and points at the wrong source."
    const mutatedSource = source
      .replace(/const TODO_MISSING_REPO_1: undefined = undefined;\n\n/, "")
      .replace(/repo: TODO_MISSING_REPO_1/, 'repo: "payments/payments-api"');
    expect(mutatedSource).not.toBe(source);

    const compiled = compileGeneratedTs(mutatedSource, { emit: false });
    try {
      // This is the failure mode the real placeholder exists to prevent: a plausible fabricated repo
      // typechecks cleanly, so the ONLY thing standing between a reviewer and a stack pointed at the
      // wrong source is noticing it by eye — which is exactly why the real emitter never does this.
      expect(
        compiled.ok,
        `expected a fabricated repo to typecheck cleanly:\n${compiled.output}`
      ).toBe(true);
    } finally {
      cleanupCompile(compiled);
    }
  });
});
