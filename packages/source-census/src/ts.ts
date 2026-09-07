import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** TS and JS source: enumeration, read with comments removed. See docs/source-census.md §34. */

/** Every non-test source file under a directory. See docs/source-census.md §35. */
export function productionSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      out.push(...productionSourceFiles(full));
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

/** The start of an exported function declaration. See docs/source-census.md §36. */
const DECLARATION_START = new RegExp(
  [
    String.raw`export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(?:<[^(]*?>\s*)?\(`,
    String.raw`export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*(?:async\s+)?(?:<[^(]*?>\s*)?\(`
  ].join("|"),
  "g"
);

/** Index of the `)` closing the `(` at `open`, or -1. */
export function matchingParen(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export interface ExportedDeclaration {
  name: string;
  /** Everything after the parameter list's closing `)` — where the return type is, and therefore
   *  what a caller matches on to decide whether this declaration is of the kind it is counting. */
  tail: string;
}

/** Every exported function-shaped declaration in one file's source, with the text that follows its
 *  parameter list. Callers filter by return type; nothing is filtered here. */
export function exportedDeclarations(source: string): ExportedDeclaration[] {
  const found: ExportedDeclaration[] = [];
  for (const match of source.matchAll(DECLARATION_START)) {
    const name = match[1] ?? match[2];
    if (name === undefined) continue;
    const open = match.index + match[0].length - 1;
    const close = matchingParen(source, open);
    if (close === -1) continue;
    found.push({ name, tail: source.slice(close + 1) });
  }
  return found;
}

/** Source with COMMENTS REMOVED. See docs/source-census.md §37. */
export function stripComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === "//") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (two === "/*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    const ch = source[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      out += ch;
      i++;
      while (i < source.length && source[i] !== ch) {
        if (source[i] === "\\") {
          out += source.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += source[i];
        i++;
      }
      out += source[i] ?? "";
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Read + strip in one step. See docs/source-census.md §38. */
export function readStripped(file: string): string {
  return stripComments(readFileSync(file, "utf8"));
}
