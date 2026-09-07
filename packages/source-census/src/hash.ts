import { readFileSync } from "node:fs";

/** `#`-comment sources: the TS stripper fails here silently. See docs/source-census.md §10. */

/** Escape a literal so it can be embedded in a RegExp source. */
function escapeLiteral(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `pattern`, re-anchored to the START of a line. See docs/source-census.md §11. */
export function atLineStart(pattern: string | RegExp): RegExp {
  const source = typeof pattern === "string" ? escapeLiteral(pattern) : pattern.source;
  const flags = typeof pattern === "string" ? "m" : new Set([...pattern.flags, "m"]);
  return new RegExp(String.raw`^[ \t]*(?:${source})`, [...flags].join(""));
}

/** `source` with whole-line `#` comments removed. See docs/source-census.md §12. */
export function stripHashComments(source: string): string {
  return source
    .split("\n")
    .map((line) => (line.trimStart().startsWith("#") ? "" : line))
    .join("\n");
}

/** Read + strip in one step, for a Dockerfile / shell script / YAML / `pin.env`. */
export function readHashStripped(file: string): string {
  return stripHashComments(readFileSync(file, "utf8"));
}
