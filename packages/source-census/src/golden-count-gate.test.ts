import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readStripped } from "./ts.js";

/**
 * ================================================================================================
 * MEDIUM-5 — THE GOLDEN COUNT IN PROSE, MADE A GATE INSTEAD OF A THING RESTATED BY HAND
 * ================================================================================================
 * `docs/BUILD_AND_TEST.md`'s M23.0 bullet has stated the number of `launch-argv.golden.test.ts`
 * cases across the three managed-executor plugins THREE times, and been wrong on at least two of
 * them:
 *   - it said "Fourteen" when the true count (at the time) was fifteen (corrected by commit
 *     e72e629e, itself the ONLY one of the three corrections that actually re-measured);
 *   - it then said "Fifteen (4 iac + 6 scan + 5 dep)" for a full round afterward, including through
 *     a Phase 5 verification pass that reported the line as checked, while commit 39b387d2 had
 *     already added a sixth-then-fifth iac case and a later M23.1e round (bf608300) added a sixth —
 *     the true count by then was seventeen (6 iac + 6 scan + 5 dep).
 *
 * A number in prose that three separate rounds each restated wrongly is a number that must stop
 * living in prose. This file reads BOTH sides — the documented count and the actual `it(` count in
 * the three golden files — and fails the moment they diverge, naming the exact mismatch rather than
 * requiring a fourth human recount.
 *
 * WHY `^\s*it\(`, MIRRORING THE MEASUREMENT THAT FOUND THE DEFECT. Counting top-level `it(` calls is
 * the same method MEDIUM-5's own measurement used ("Counting `^\s*it(` in the three golden files").
 * `readStripped` (not a bare `readFileSync`) is used so a commented-out or described-but-deleted
 * `it(` cannot inflate the count — see `@scp/source-census`'s own module doc for why that distinction
 * is load-bearing rather than decorative.
 *
 * PROVEN BY ADDING A CASE AND WATCHING IT REDDEN — that is this file's own DoD, not merely a claim
 * about it: add a fixture `it(` to any of the three files below (or bump the documented count without
 * touching a file) and this suite fails, naming the file and the two numbers that disagree.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const BUILD_AND_TEST_MD = resolve(REPO_ROOT, "docs/BUILD_AND_TEST.md");

/** The three golden files the M23.0 bullet counts, in the order its prose lists them. */
const GOLDEN_FILES: { label: "iac" | "scan" | "dep"; path: string }[] = [
  { label: "iac", path: "packages/plugins/managed-iac/src/launch-argv.golden.test.ts" },
  { label: "scan", path: "packages/plugins/managed-scan/src/launch-argv.golden.test.ts" },
  { label: "dep", path: "packages/plugins/managed-dep/src/launch-argv.golden.test.ts" }
];

/** One `it(` at the start of a (whitespace-trimmed) line — a top-level test case, not a nested
 *  helper call or a mention inside a string. Mirrors the measurement method MEDIUM-5 itself used. */
const TOP_LEVEL_IT = /^\s*it\(/gm;

function countGoldenCases(relativePath: string): number {
  const source = readStripped(resolve(REPO_ROOT, relativePath));
  return [...source.matchAll(TOP_LEVEL_IT)].length;
}

/** Number words this doc actually uses for small counts (never more than needed — a count this repo
 *  has used above twenty would be a sign this file's own scope grew, not a reason to pad the map). */
const NUMBER_WORDS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20
};

interface DocumentedCount {
  /** The word (or digit string) naming the TOTAL, exactly as the doc spells it. */
  totalWord: string;
  total: number;
  iac: number;
  scan: number;
  dep: number;
}

/**
 * Parses the M23.0 bullet's own count out of `docs/BUILD_AND_TEST.md` — `<word> tests (<n> iac +
 * <n> scan + <n> dep)` — rather than assuming its position. A doc restructure that drops or renames
 * the bullet fails this HERE, naming what could not be found, instead of the count silently going
 * unchecked.
 */
function parseDocumentedCount(docText: string): DocumentedCount {
  const anchor = docText.indexOf("M23.0 The golden Docker argv");
  expect(
    anchor,
    "the M23.0 golden-argv bullet is no longer in docs/BUILD_AND_TEST.md by that name — update this test's anchor, do not delete the gate"
  ).toBeGreaterThanOrEqual(0);

  const window = docText.slice(anchor, anchor + 400);
  const match = /([A-Za-z]+)\s+tests\s*\((\d+)\s*iac\s*\+\s*(\d+)\s*scan\s*\+\s*(\d+)\s*dep\)/.exec(
    window
  );
  expect(
    match,
    `could not find the "<word> tests (<n> iac + <n> scan + <n> dep)" pattern near the M23.0 bullet — ` +
      `the sentence shape changed; update this test's regex to match it, do not delete the gate. ` +
      `Looked in: ${JSON.stringify(window.slice(0, 120))}`
  ).not.toBeNull();

  const [, totalWord, iac, scan, dep] = match!;
  const totalFromWord = NUMBER_WORDS[totalWord!.toLowerCase()];
  expect(
    totalFromWord,
    `the doc's leading count "${totalWord}" is not a number word this test knows — add it to ` +
      `NUMBER_WORDS if the count has genuinely grown, do not silently skip the check`
  ).not.toBeUndefined();

  return {
    totalWord: totalWord!,
    total: totalFromWord!,
    iac: Number(iac),
    scan: Number(scan),
    dep: Number(dep)
  };
}

describe("MEDIUM-5: the golden-argv test count in docs/BUILD_AND_TEST.md must match reality", () => {
  it("the census actually read the doc and all three golden files (non-vacuity)", () => {
    const docText = readFileSync(BUILD_AND_TEST_MD, "utf8");
    expect(docText.length).toBeGreaterThan(1000);
    for (const { path } of GOLDEN_FILES) {
      expect(
        countGoldenCases(path),
        `${path} appears to have no top-level it( cases at all`
      ).toBeGreaterThan(0);
    }
  });

  it("the documented per-file breakdown (iac/scan/dep) matches the actual it( count in each file", () => {
    const docText = readFileSync(BUILD_AND_TEST_MD, "utf8");
    const documented = parseDocumentedCount(docText);
    const actual = Object.fromEntries(
      GOLDEN_FILES.map(({ label, path }) => [label, countGoldenCases(path)])
    ) as Record<"iac" | "scan" | "dep", number>;

    const mismatches = (["iac", "scan", "dep"] as const)
      .filter((label) => documented[label] !== actual[label])
      .map(
        (label) =>
          `${label}: doc says ${documented[label]}, ${GOLDEN_FILES.find((g) => g.label === label)!.path} actually has ${actual[label]}`
      );
    expect(
      mismatches,
      "docs/BUILD_AND_TEST.md's M23.0 bullet's per-file breakdown is stale — update the prose " +
        "(and this is the third time; consider why prose keeps losing this race)"
    ).toStrictEqual([]);
  });

  it("the documented TOTAL (the leading number word) equals the sum of the three files, and equals the sum of the per-file breakdown", () => {
    const docText = readFileSync(BUILD_AND_TEST_MD, "utf8");
    const documented = parseDocumentedCount(docText);
    const actualTotal = GOLDEN_FILES.reduce((sum, { path }) => sum + countGoldenCases(path), 0);
    const documentedBreakdownSum = documented.iac + documented.scan + documented.dep;

    // BOTH ARMS OF THE STALENESS THIS FILE'S OWN HEADER DESCRIBES: the leading word can go stale
    // independently of the parenthetical (that is exactly how "Fifteen (4 iac + ...)" happened —
    // the parenthetical was once right and the word was carried forward unchanged), so both are
    // checked against the SAME ground truth rather than against each other alone.
    expect(
      documented.totalWord.toLowerCase(),
      `the doc's leading word "${documented.totalWord}" claims ${documented.total} tests, but the ` +
        `three golden files actually have ${actualTotal}`
    ).toBe(
      Object.entries(NUMBER_WORDS).find(([, n]) => n === actualTotal)?.[0] ??
        `<no word for ${actualTotal}>`
    );
    expect(
      documentedBreakdownSum,
      "the doc's own parenthetical (iac + scan + dep) does not sum to the doc's own leading word — " +
        "the two halves of one sentence disagree with each other, independent of reality"
    ).toBe(documented.total);
  });
});
