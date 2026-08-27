import { describe, expect, it } from "vitest";
import {
  PLACEHOLDER_REPO_MARKER,
  buildEstateManifest,
  renderEstateProgram,
  type ServiceSpec
} from "./estate-program.js";

/**
 * Unit-level coverage for the shared `scp iac export`/`scp iac scaffold` emitter
 * (team-pipeline-iac.md §9/§7). The stronger, whole-file proofs — "the rendered TS actually
 * compiles against the real `@scp/iac` package" and "export → synth → compare" executed through a
 * real `tsc` — live in `@scp/cli`'s `iac-estate-program.roundtrip.test.ts`, because only a package
 * that already depends on `@scp/iac` (a real `node_modules` symlink, not a source-relative import)
 * can compile generated code AGAINST the published surface the way a real team's repo would. This
 * file covers the two pure functions' own behavior in isolation: what they build/render for a given
 * `ServiceSpec`, and the placeholder count they agree on.
 */

function completeSpec(): ServiceSpec {
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
          { targetUrn: "urn:scp:acme:deployment-target:legacy-vm" }
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
      }
    ]
  };
}

function specMissingSourceMapping(): ServiceSpec {
  const spec = completeSpec();
  return {
    ...spec,
    components: [
      {
        ...spec.components[0]!,
        pipelines: [
          {
            kind: "image",
            // No `source` — the D18 case this whole mechanism exists for.
            waves: [{ name: "staging", targets: ["urn:scp:acme:deployment-target:pay-blue"] }]
          }
        ]
      }
    ]
  };
}

describe("buildEstateManifest", () => {
  it("emits the service, component (adopted by explicit urn), placements and pipeline attachment", () => {
    const { manifest, placeholderCount } = buildEstateManifest(completeSpec());
    expect(placeholderCount).toBe(0);

    const component = manifest.objects.find((o) => o.typeId === "component");
    expect(component?.urn).toBe("urn:scp:acme:component:payments-api");

    expect(manifest.placements).toHaveLength(2);
    const targetUrns = (manifest.placements ?? []).map((p) => p.deploymentTargetUrn).sort();
    expect(targetUrns).toEqual([
      "urn:scp:acme:deployment-target:legacy-vm",
      "urn:scp:acme:deployment-target:pay-blue"
    ]);

    const releasesVia = manifest.relationships.find((r) => r.typeId === "releases_via");
    expect(releasesVia).toBeDefined();
    expect(releasesVia?.properties?.["type"]).toBe("image");

    expect(manifest.sourceMappings).toHaveLength(1);
    expect(manifest.sourceMappings?.[0]?.repoPattern).toBe("payments/payments-api");

    const publishesTo = manifest.relationships.find((r) => r.typeId === "publishes_to");
    expect(publishesTo?.properties?.["repository"]).toBe("payments/payments-api");
  });

  it("does NOT duplicate a placement a pipeline's waves would also infer (D8 dedup)", () => {
    const { manifest } = buildEstateManifest(completeSpec());
    // Both live placements are also named by the pipeline's waves — `hasPlacement` must have
    // deduped, so there is still exactly one placement per pair, not two.
    expect(manifest.placements).toHaveLength(2);
  });

  it("counts one placeholder per pipeline with no source mapping, and gives it a loud, non-empty repo", () => {
    const { manifest, placeholderCount } = buildEstateManifest(specMissingSourceMapping());
    expect(placeholderCount).toBe(1);
    // `PipelineBase` still writes a source mapping (D8, component-scoped) — its `repoPattern` is
    // exactly the placeholder marker, so a reviewer scanning the applied manifest sees the same loud
    // signal the generated code does, not a silently-omitted mapping.
    expect(manifest.sourceMappings).toHaveLength(1);
    expect(manifest.sourceMappings?.[0]?.repoPattern).toContain(PLACEHOLDER_REPO_MARKER);
    const releasesVia = manifest.relationships.find((r) => r.typeId === "releases_via");
    expect(releasesVia).toBeDefined();
  });
});

describe("renderEstateProgram", () => {
  it("renders valid-looking construct calls and imports only what it used", () => {
    const { source, placeholderCount } = renderEstateProgram(completeSpec());
    expect(placeholderCount).toBe(0);
    expect(source).toContain(
      'import { Cluster, Component, DeploymentTarget, ExecutionSystem, ImagePipeline, Service, Stack } from "@scp/iac";'
    );
    expect(source).toContain("Service.fromUrn(");
    expect(source).toContain('urn: "urn:scp:acme:component:payments-api"');
    expect(source).toContain("Cluster.fromUrn(");
    expect(source).toContain("DeploymentTarget.fromUrn(");
    expect(source).toContain("new ImagePipeline(");
    expect(source).toContain("export const manifest = stack.synth();");
    expect(source).not.toContain(PLACEHOLDER_REPO_MARKER);
  });

  it("agrees with buildEstateManifest on placeholderCount for the same spec", () => {
    const spec = specMissingSourceMapping();
    expect(renderEstateProgram(spec).placeholderCount).toBe(
      buildEstateManifest(spec).placeholderCount
    );
  });

  // MUTATION-WATCHED: if the `repo:` branch below were changed to emit a plausible fabricated string
  // (e.g. `${slug}/${component}`) instead of the `undefined` placeholder constant, this case goes red
  // (the marker text and `TODO_MISSING_REPO_1` both vanish) — and `@scp/cli`'s
  // `iac-estate-program.roundtrip.test.ts` placeholder case goes red too, because the emitted file
  // would then typecheck when it must not. Restoring the `undefined` constant turns both green again.
  it("emits a loud, unmissable placeholder block — never a plausible-looking invented repo", () => {
    const { source, placeholderCount } = renderEstateProgram(specMissingSourceMapping());
    expect(placeholderCount).toBe(1);
    expect(source).toContain("SCP-EXPORT PLACEHOLDER");
    expect(source).toContain("const TODO_MISSING_REPO_1: undefined = undefined;");
    expect(source).toContain("repo: TODO_MISSING_REPO_1");
    // Never a value shaped like a real repo path standing in unlabeled.
    expect(source).not.toMatch(/repo: "payments\/payments-api"/);
  });
});
