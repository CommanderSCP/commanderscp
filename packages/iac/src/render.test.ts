import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { DesiredStateManifestSchema, type DesiredStateManifest } from "@scp/schemas";
import { Component, DeploymentTarget, Service, Stack } from "./construct.js";
import { Cluster } from "./infra.js";
import { ImagePipeline, InfrastructurePipeline } from "./pipeline.js";
import { waves } from "./waves.js";
import {
  MANIFEST_ONLY_DISCLAIMER,
  RENDER_BEGIN_MARKER,
  RENDER_END_MARKER,
  formatPipelineBlock,
  renderManifestPipelines,
  renderManifestSection,
  updateGeneratedSection
} from "./render.js";

/**
 * D21(d): `scp iac render` shows ALL gates that will apply, including estate-imposed ones the team
 * never declared — "the picture must be the truth, not the team's subset of it." This file proves
 * the two halves of that: what a synthesized manifest's OWN declarations render as (waves, source,
 * publish, declared hooks), and the FIXED, always-present honesty section (`MANIFEST_ONLY_
 * DISCLAIMER` + the estate-imposed gate lines) that `render.ts`'s module doc explains render can and
 * cannot know from a manifest alone.
 */

/** The worked example's own shape (team-pipeline-iac-examples.md §7): one component, an image
 *  pipeline placed at a Cluster its own infrastructure pipeline declares, staging then production. */
function buildManifestClean(): DesiredStateManifest {
  const stack = new Stack("payments-api");
  const svc = new Service(stack, "payments", { name: "Payments" });
  const api = new Component(stack, "payments-api", { name: "payments-api", service: svc });

  const stagingAmer = new DeploymentTarget(stack, "commercial-amer-staging", {
    name: "commercial-amer-staging"
  });
  const prodAmer = new DeploymentTarget(stack, "commercial-amer-production", {
    name: "commercial-amer-production"
  });

  const infra = new InfrastructurePipeline(api, "infra", {
    repo: "payments/payments-infra",
    waves: [[prodAmer]]
  });
  const payBlue = new Cluster(infra, "pay-blue", { name: "pay-blue", within: prodAmer });

  const image = new ImagePipeline(api, {
    repo: "payments/payments-api",
    branch: "main",
    waves: waves.linear([stagingAmer, prodAmer])
  });
  image.placeAt(payBlue);

  const manifest = stack.synth();
  return DesiredStateManifestSchema.parse(manifest);
}

describe("@scp/iac: renderManifestPipelines — what the manifest itself declares", () => {
  it("finds one RenderedPipeline per releases_via relationship, sorted by (componentUrn, kind)", () => {
    const manifest = buildManifestClean();
    const rendered = renderManifestPipelines(manifest);
    expect(rendered.map((r) => r.kind).sort()).toEqual(["image", "infrastructure"]);
    expect(rendered.every((r) => r.name === "payments-api")).toBe(true);
  });

  it("shows source and publish for a build-kind pipeline", () => {
    const manifest = buildManifestClean();
    const image = renderManifestPipelines(manifest).find((r) => r.kind === "image")!;
    expect(image.lines.some((l) => l.includes("payments/payments-api"))).toBe(true);
    expect(image.lines.some((l) => l.startsWith("publish"))).toBe(true);
  });

  it("shows every declared wave and resolves target URNs to human names", () => {
    const manifest = buildManifestClean();
    const image = renderManifestPipelines(manifest).find((r) => r.kind === "image")!;
    expect(image.lines.some((l) => l.includes("commercial-amer-staging"))).toBe(true);
    expect(image.lines.some((l) => l.includes("commercial-amer-production"))).toBe(true);
  });

  it("says explicitly when no hooks are declared, rather than omitting the section", () => {
    const manifest = buildManifestClean();
    const image = renderManifestPipelines(manifest).find((r) => r.kind === "image")!;
    expect(image.lines).toContain("declared hooks: (none declared in this manifest)");
  });

  it("an infrastructure pipeline gets no registry/CDS gate lines — it is never itself placed (D24)", () => {
    const manifest = buildManifestClean();
    const infra = renderManifestPipelines(manifest).find((r) => r.kind === "infrastructure")!;
    expect(infra.lines.join("\n")).not.toMatch(/digest-bound scan/);
    expect(infra.lines.join("\n")).toMatch(/never itself placed/);
  });
});

describe("@scp/iac: renderManifestSection — D21(d)'s all-gates honesty requirement", () => {
  it("ALWAYS includes the manifest-only disclaimer — the honesty line D21(d) requires", () => {
    const manifest = buildManifestClean();
    const section = renderManifestSection(manifest);
    expect(section).toContain(MANIFEST_ONLY_DISCLAIMER);
  });

  it("ALWAYS shows the fixed estate-imposed gates for a build-kind pipeline, even though this manifest never declared them", () => {
    const manifest = buildManifestClean();
    const section = renderManifestSection(manifest);
    // Neither of these strings is anywhere in the fixture manifest's own declarations — they are
    // the FIXED D21/D22 facts render always states, which is the entire D21(d) requirement.
    expect(section).toMatch(/digest-bound scan \+ origin signature/);
    expect(section).toMatch(/commander's crossing signature/);
  });

  it("an empty manifest (no releases_via at all) still renders the disclaimer, not a blank page", () => {
    const stack = new Stack("empty");
    const manifest = DesiredStateManifestSchema.parse(stack.synth());
    const section = renderManifestSection(manifest);
    expect(section).toContain(MANIFEST_ONLY_DISCLAIMER);
    expect(section).toContain("no `releases_via` relationship");
  });

  it("is wrapped in the BEGIN/END markers `updateGeneratedSection` looks for", () => {
    const manifest = buildManifestClean();
    const section = renderManifestSection(manifest);
    expect(section.startsWith(RENDER_BEGIN_MARKER)).toBe(true);
    expect(section.trimEnd().endsWith(RENDER_END_MARKER.trim())).toBe(true);
  });
});

describe("@scp/iac: formatPipelineBlock — the comment-block shape a source file embeds", () => {
  it("every body line is prefixed as a comment continuation", () => {
    const block = formatPipelineBlock({
      componentUrn: "urn:scp:x:component:api",
      name: "api",
      kind: "image",
      lines: ["source     x/y @ main", "", "waves:"]
    });
    expect(block.startsWith("/* ── pipeline: api (image)")).toBe(true);
    expect(block).toContain(" * source     x/y @ main");
    expect(block.endsWith("*/")).toBe(true);
  });
});

describe("@scp/iac: updateGeneratedSection — --write's drift-checkable in-place update", () => {
  it("appends the generated section to a file with no prior marker", () => {
    const result = updateGeneratedSection('import { X } from "y";\n', "GENERATED-CONTENT");
    expect(result).toBe('import { X } from "y";\n\nGENERATED-CONTENT\n');
  });

  it("replaces an existing generated section in place, leaving the hand-written prefix untouched", () => {
    const before = `import { X } from "y";\n\n${RENDER_BEGIN_MARKER}\nOLD STUFF\n${RENDER_END_MARKER}\n`;
    const result = updateGeneratedSection(before, "NEW-CONTENT");
    expect(result).toBe('import { X } from "y";\n\nNEW-CONTENT\n');
    expect(result).not.toContain("OLD STUFF");
  });

  it("running --write TWICE on its own output is a no-op — the drift check's whole premise", () => {
    const manifest = buildManifestClean();
    const section = renderManifestSection(manifest);
    const once = updateGeneratedSection("// hand-written header\n", section);
    const twice = updateGeneratedSection(once, section);
    expect(twice).toBe(once);
  });

  it("handles an empty existing file without a stray leading blank line", () => {
    const result = updateGeneratedSection("", "GENERATED-CONTENT");
    expect(result).toBe("GENERATED-CONTENT\n");
  });
});

describe("@scp/iac: render determinism (fast-check) — the construct.determinism.test.ts pattern", () => {
  it("re-rendering the same manifest twice is byte-identical", () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const manifest = buildManifestClean();
        expect(renderManifestSection(manifest)).toBe(renderManifestSection(manifest));
      }),
      { numRuns: 10 }
    );
  });

  it("two independently-synthesized-but-equivalent manifests (built in reversed construct order) render identically", () => {
    function buildReversed(): DesiredStateManifest {
      const stack = new Stack("payments-api");
      const svc = new Service(stack, "payments", { name: "Payments" });
      const api = new Component(stack, "payments-api", { name: "payments-api", service: svc });
      const stagingAmer = new DeploymentTarget(stack, "commercial-amer-staging", {
        name: "commercial-amer-staging"
      });
      const prodAmer = new DeploymentTarget(stack, "commercial-amer-production", {
        name: "commercial-amer-production"
      });

      // Image pipeline declared FIRST this time (reversed from buildManifestClean).
      const image = new ImagePipeline(api, {
        repo: "payments/payments-api",
        branch: "main",
        waves: waves.linear([stagingAmer, prodAmer])
      });
      const infra = new InfrastructurePipeline(api, "infra", {
        repo: "payments/payments-infra",
        waves: [[prodAmer]]
      });
      const payBlue = new Cluster(infra, "pay-blue", { name: "pay-blue", within: prodAmer });
      image.placeAt(payBlue);

      return DesiredStateManifestSchema.parse(stack.synth());
    }

    expect(renderManifestSection(buildManifestClean())).toBe(
      renderManifestSection(buildReversed())
    );
  });
});
