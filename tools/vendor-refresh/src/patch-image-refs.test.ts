import { describe, expect, it } from "vitest";
import { patchImageRefs, patchImageRefsOrThrow } from "./patch-image-refs.js";
import type { TrackedImage } from "./types.js";

const ARGOCD: TrackedImage = {
  bundleImageName: "argocd",
  tagRef: "quay.io/argoproj/argocd:v3.5.0",
  resolvedRef: `quay.io/argoproj/argocd:v3.5.0@sha256:${"a".repeat(64)}`
};

describe("patchImageRefs", () => {
  it("replaces a values.yaml-style default, keeping the surrounding line intact", () => {
    const content = "    image: quay.io/argoproj/argocd:v3.4.5 # Argo CD (Apache-2.0)\n";
    const { content: patched, replacedCount } = patchImageRefs(content, [ARGOCD]);
    expect(patched).toBe("    image: quay.io/argoproj/argocd:v3.5.0 # Argo CD (Apache-2.0)\n");
    expect(replacedCount.get("argocd")).toBe(1);
  });

  it("replaces a bundle-images.ts-style quoted literal", () => {
    const content = '    defaultRef: "quay.io/argoproj/argocd:v3.4.5",\n';
    const { content: patched } = patchImageRefs(content, [ARGOCD]);
    expect(patched).toBe('    defaultRef: "quay.io/argoproj/argocd:v3.5.0",\n');
  });

  it("replaces every occurrence when the same default appears more than once", () => {
    const content = [
      "argocd-server: quay.io/argoproj/argocd:v3.4.5",
      "argocd-repo-server: quay.io/argoproj/argocd:v3.4.5"
    ].join("\n");
    const { content: patched, replacedCount } = patchImageRefs(content, [ARGOCD]);
    expect(patched).toBe(
      [
        "argocd-server: quay.io/argoproj/argocd:v3.5.0",
        "argocd-repo-server: quay.io/argoproj/argocd:v3.5.0"
      ].join("\n")
    );
    expect(replacedCount.get("argocd")).toBe(2);
  });

  it("never touches an unrelated coordinate that only shares a prefix", () => {
    const content = "image: quay.io/argoproj/argocd-extra:v1.0.0\n";
    const { content: patched, replacedCount } = patchImageRefs(content, [ARGOCD]);
    expect(patched).toBe(content);
    expect(replacedCount.get("argocd")).toBe(0);
  });

  it("returns zero replacements (not an error) when the file does not mention the image at all", () => {
    const { replacedCount } = patchImageRefs("nothing here", [ARGOCD]);
    expect(replacedCount.get("argocd")).toBe(0);
  });
});

describe("patchImageRefsOrThrow", () => {
  it("throws when a tracked image is not found — values.yaml/bundle-images.ts must already declare it", () => {
    expect(() => patchImageRefsOrThrow("nothing here", [ARGOCD], "values.yaml")).toThrow(
      /values\.yaml declares no reference to quay\.io\/argoproj\/argocd/
    );
  });

  it("returns the patched content when every tracked image is found", () => {
    const content = "image: quay.io/argoproj/argocd:v3.4.5\n";
    expect(patchImageRefsOrThrow(content, [ARGOCD], "values.yaml")).toBe(
      "image: quay.io/argoproj/argocd:v3.5.0\n"
    );
  });
});
