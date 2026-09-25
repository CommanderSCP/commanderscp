/** Patch a tag-only image reference (`<coordinate>:<tag>`) wherever it appears in a text file, for a
 *  set of {@link TrackedImage}s. Used for BOTH `deploy/helm-bundled/values.yaml` (a plain YAML file:
 *  `image: quay.io/argoproj/argocd:v3.4.5 # Argo CD (Apache-2.0)`) and
 *  `deploy/airgap/src/bundle-images.ts` (a TS source literal: `defaultRef: "quay.io/argoproj/argocd:
 *  v3.4.5"`) — deliberately a plain textual substitution rather than a YAML/TS-aware edit, the same
 *  choice the chart templates themselves make for the vendored manifests
 *  (`deploy/helm-bundled/templates/argocd.yaml`'s own header: "exactly three byte-level
 *  substitutions — never a fork of the engine"). Both files spell the SAME coordinate+tag string
 *  once each, so an anchored literal replace is exact and a full parser would buy nothing. */
import type { TrackedImage } from "./types.js";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface PatchResult {
  content: string;
  /** Per tracked image, how many occurrences of `<coordinate>:<anyTag>` were replaced. Zero for an
   *  image this file does not mention at all — the caller decides whether that is expected
   *  (`values.yaml`/`bundle-images.ts` MUST mention every tracked image; `images.list` need not). */
  replacedCount: ReadonlyMap<string, number>;
}

/** Replace every `<coordinate>:<tag>` for each tracked image with `<coordinate>:<newTag>` (never a
 *  digest — this file's own convention keeps the CONNECTED default tag-only; digest pinning happens
 *  at bundle-build time, exactly as it already does for every other bundled backend). The tag pattern
 *  stops at whitespace, a quote, or a `#` — the characters that end an image ref in either file. */
export function patchImageRefs(content: string, images: readonly TrackedImage[]): PatchResult {
  let out = content;
  const replacedCount = new Map<string, number>();
  for (const image of images) {
    const coordinate = image.tagRef.slice(0, image.tagRef.lastIndexOf(":"));
    const pattern = new RegExp(`${escapeRegExp(coordinate)}:[^\\s"'#]+`, "g");
    let count = 0;
    out = out.replace(pattern, () => {
      count += 1;
      return image.tagRef;
    });
    replacedCount.set(image.bundleImageName, count);
  }
  return { content: out, replacedCount };
}

/** {@link patchImageRefs}, but REQUIRES every tracked image to have been found at least once — for
 *  `values.yaml` and `bundle-images.ts`, where every tracked image is a load-bearing default and a
 *  silent zero-match means the coordinate moved or the file's shape changed under this tool. */
export function patchImageRefsOrThrow(
  content: string,
  images: readonly TrackedImage[],
  fileLabel: string
): string {
  const { content: patched, replacedCount } = patchImageRefs(content, images);
  const missing = images.filter((i) => (replacedCount.get(i.bundleImageName) ?? 0) === 0);
  if (missing.length > 0) {
    throw new Error(
      `vendor-refresh: ${fileLabel} declares no reference to ` +
        `${missing.map((i) => i.tagRef.slice(0, i.tagRef.lastIndexOf(":"))).join(", ")} — expected an ` +
        "existing default to update. Either the coordinate moved in this file, or it needs a new entry " +
        "(not something this tool does automatically)."
    );
  }
  return patched;
}
