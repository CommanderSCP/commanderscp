/** Patch `tools/ci-mirror/images.list` for a tracked image, best-effort: a bundled backend's image is
 *  listed there only if some CI test actually pulls it (today: only gitea, reused by
 *  `kind-runner-harness`, per that file's own comment) — the other three argoproj images are NOT
 *  there, and staying silent about them is correct, not a miss (see M29 builder rules: "in
 *  tools/ci-mirror/images.list if a test pulls it"). Format: `<digest-pinned-upstream-ref>
 *  <alias>`, two whitespace-separated fields per line (comments and `${VAR}` lines are untouched). */
import type { TrackedImage } from "./types.js";

export interface ImagesListPatchResult {
  content: string;
  /** Tracked images that WERE present (by alias coordinate) and got their pin bumped. */
  updated: readonly string[];
}

export function patchImagesList(
  content: string,
  images: readonly TrackedImage[]
): ImagesListPatchResult {
  const lines = content.split("\n");
  const updated = new Set<string>();

  const patchedLines = lines.map((line) => {
    if (line.trim() === "" || line.trim().startsWith("#")) return line;
    const fields = line.split(/\s+/).filter((f) => f !== "");
    if (fields.length !== 2) return line; // a malformed or `${VAR}`-only line — never this tool's business
    const [, alias] = fields as [string, string];
    const lastColon = alias.lastIndexOf(":");
    if (lastColon < 0) return line; // no tag at all (a bare digest ref, e.g. `repo@sha256:...`)
    const aliasCoordinate = alias.slice(0, lastColon);
    const match = images.find(
      (image) => image.tagRef.slice(0, image.tagRef.lastIndexOf(":")) === aliasCoordinate
    );
    if (match === undefined) return line;
    updated.add(match.bundleImageName);
    const digest = match.resolvedRef.slice(match.resolvedRef.lastIndexOf("@") + 1);
    return `${aliasCoordinate}@${digest}   ${match.tagRef}`;
  });

  return { content: patchedLines.join("\n"), updated: [...updated] };
}
