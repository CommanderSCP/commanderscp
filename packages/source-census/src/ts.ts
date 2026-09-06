import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ================================================================================================
 * TS/JS SOURCE — enumeration, and reading with `//` and slash-star comments removed
 * ================================================================================================
 * For `.ts`/`.tsx`/`.js`/`.mjs`/`.cjs`. For Dockerfiles, shell, YAML and `pin.env` see `./hash.ts`
 * — `#` is not a comment here and slash-slash is not a comment there, and using the wrong one
 * strips nothing (silently, which is how this class of bug survives).
 *
 * The limits of ALL of this are in the package's `index.ts`. Read them before believing a result.
 */

/**
 * Every `.ts` file under `dir` that is not a test and not a declaration file.
 *
 * `test-support/*.ts` IS included, deliberately: a census exists to find the instance that does not
 * look like the others, and a fixture parked in `test-support` that declares a router or a loop
 * should fail loudly rather than teach the filter to hide the next real one. `node_modules` and
 * `dist` are skipped because they are copies of the tree, not the tree.
 */
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

/**
 * The start of an exported function declaration, up to and including its opening parenthesis.
 *
 * DECLARATION FORMS THIS HAS TO SURVIVE — censused across `apps/server/src` rather than assumed,
 * because the first version of this regex used `\([^)]*\)` and therefore recognised exactly one
 * form. Forms in use in this tree today:
 *   - `export function name(…): T` on one line, and split across lines (399 of them);
 *   - a parameter that is ITSELF a function — `rand: () => number` (`load-test/stats.ts`), a
 *     dependency-injected clock, `fn: () => Promise<T>` — which `[^)]*` cannot cross, so a router
 *     factory written `export function subscriptionDriftRouter(clock: () => Date): DomainEventRouter`
 *     was invisible to the old census;
 *   - a default value that calls something: `now: Date = new Date()` (`federation/crl-parse.ts`);
 *   - a generic: `export function sampleDistinct<T>(…)` (`load-test/stats.ts`).
 * `export const name = (…) =>` is NOT used for exported functions anywhere in this tree; it is
 * matched anyway, because the point of a census is to find the instance that does not look like
 * the others. `export async function` is matched too — whether an async declaration counts is the
 * CALLER's decision, made on {@link ExportedDeclaration.tail} (a router factory returning
 * `Promise<DomainEventRouter>` does not qualify; a loop starter returning `Promise<XLoopHandle>`
 * does).
 *
 * The parameter list is not matched by this regex at all — {@link matchingParen} walks it — which
 * is what makes the nested-paren forms work.
 */
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

/**
 * Source with COMMENTS REMOVED — both `//` and block comments, and neither inside a string or
 * template literal, where those character pairs are data. The predecessor of this function handled
 * `//` only while its own comment claimed a commented-out registration would not count: a
 * registration inside a block comment still counted as registered, which is precisely the "comment
 * asserting a protection that does not exist" M21.7 was cleaning up.
 *
 * NOT TRACKED: regular-expression literals, so a regex containing a block-comment opener would
 * start a spurious comment. The failure direction is a false RED (text removed, the caller's checks
 * fail loudly), never a silent pass.
 */
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

/**
 * Read + strip in one step. Use this, never a bare `readFileSync`, for any census over TS/JS
 * source — see the package doc for the seven censuses that were measured false-green without it,
 * and for the six things stripping still does NOT prove.
 */
export function readStripped(file: string): string {
  return stripComments(readFileSync(file, "utf8"));
}
