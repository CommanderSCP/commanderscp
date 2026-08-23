import { describe, expect, it } from "vitest";
import { RUNNER_DETAIL_MAX_CHARS, RUNNER_DETAIL_TAIL_CHARS, boundDetail } from "./index.js";

/**
 * HIGH REGRESSION — `boundDetail` CUT SURROGATE PAIRS, POSTGRES REFUSED THE ROW, AND THE WAVE NEVER
 * TERMINALISED (M23.0 verification pass 7, fixed pass 8).
 *
 * THE MECHANISM, END TO END. `boundDetail` slices at UTF-16 CODE-UNIT offsets. An astral character
 * (any emoji, any CJK extension, any of the mathematical alphanumerics a Terraform provider is
 * perfectly capable of printing) occupies TWO code units, so either cut — the head at `headShare`
 * or the tail at `length - RUNNER_DETAIL_TAIL_CHARS` — can land between them and leave a LONE
 * SURROGATE. The result is an ill-formed string. `jsonb` refuses it. The refusal is thrown by the
 * `insertDecision` inside `reconcileExecutingChange`'s `withTenantTx`, which ALSO holds that tick's
 * `updateWaveTargetObserved` — so the whole transaction rolls back:
 *
 *   [reconcile] … poll failed (will retry next tick):
 *     DrizzleQueryError: Failed query: insert into "decisions" (…, "input_context", …) values …
 *       detail: 'Unicode low surrogate must follow a high surrogate.'
 *
 * No Decision, no `observed_state`, no terminal wave — every tick, forever, behind a green health
 * check and a single `console.error`. That is the shape of this repository's own worked example
 * (BUILD_AND_TEST.md §4.4a), where 231 changes went unevaluated for 13 days.
 *
 * WHAT THE DATABASE ACTUALLY REFUSES — measured against a real `postgres:16`, not modelled:
 *
 *   lone high surrogate  -> jsonb FAIL "invalid input syntax for type json"     | text OK
 *   lone low surrogate   -> jsonb FAIL "invalid input syntax for type json"     | text OK
 *   U+0000               -> jsonb FAIL "unsupported Unicode escape sequence"    | text FAIL
 *   U+FFFD, U+FFFF, C0, DEL, combining marks, astral pairs -> OK everywhere
 *
 * NOTE THE SECOND ROW OF THAT TABLE, because it is the reason this file does not simply assert
 * `isWellFormed()`. `String.prototype.isWellFormed()` returns TRUE for a string carrying `U+0000`,
 * and `jsonb` refuses it anyway. `isWellFormed()` is a MODEL of what Postgres rejects and it is an
 * incomplete one; the database is the authority. So every arm here asserts BOTH halves, and
 * `reconcile-decision-detail-bound.integration.test.ts` drives the astral case through a real
 * `insert` so the model is checked against the authority at least once.
 *
 * AND IT IS A PROPERTY, NOT A STRING. A hand-picked input pins the offset it happens to produce; the
 * defect is about WHERE THE CUT LANDS, so the arms below sweep the cut across every alignment by
 * shifting a single-code-unit pad in front of an adversarial alphabet. One example would have been
 * green against a `boundDetail` that repaired only the head cut, which was the first fix tried.
 */

/** V8's own answer, reached through a cast because this repository compiles against `lib: ES2023`
 *  and `isWellFormed` is ES2024. Using the ENGINE's implementation rather than re-deriving the
 *  product's regex is the point: a test that reimplements the thing under test proves nothing. */
function isWellFormed(s: string): boolean {
  return (s as unknown as { isWellFormed(): boolean }).isWellFormed();
}

/** Written as an escape: a LITERAL NUL in a tracked source file is dropped, silently, by every
 *  recursive search this repository runs (CLAUDE.md). */
const NUL = "\u0000";

/** The predicate the database actually enforces, per the measurement in the header. */
function isPersistable(s: string): boolean {
  return isWellFormed(s) && !s.includes(NUL);
}

/**
 * Adversarial alphabets. Each is a repeating unit; `unitLength` is deliberately NOT all 1, because
 * an alphabet of single-code-unit characters can never expose the defect — that is exactly why the
 * round's own 100 000-character `"x".repeat(...)` fixture was green.
 */
const ALPHABETS: ReadonlyArray<{ name: string; unit: string }> = [
  // Two code units each. The headline case: any emoji in a `tofu`, Trivy or npm error.
  { name: "astral (emoji, 2 code units)", unit: "\u{1F600}" },
  // Two code units, but a SUPPLEMENTARY-PLANE letter rather than a pictograph — a CJK Extension B
  // ideograph, which arrives from a real filename far more often than an emoji does.
  { name: "astral (CJK Ext-B, 2 code units)", unit: "\u{20000}" },
  // Already ill-formed BEFORE we touch it: a plugin can hand us a detail decoded from a byte
  // stream. `text.length <= MAX` used to be a straight pass-through for this.
  { name: "lone HIGH surrogates in the input", unit: "a\uD83Db" },
  { name: "lone LOW surrogates in the input", unit: "a\uDE00b" },
  // Legal, must SURVIVE untouched — the counter-arm that stops the fix from being "delete anything
  // that looks unusual". A combining sequence may be split by a cut and that is fine: both halves
  // are well-formed code points and Postgres stores them.
  { name: "combining marks", unit: "\u0229\u0301\u0302" },
  // Legal UTF-16, refused by Postgres anyway. The row `isWellFormed()` gets wrong.
  { name: "NUL-carrying", unit: `a${NUL}b` },
  // Everything at once, at co-prime-ish widths so the alignments do not resonate.
  { name: "mixed adversarial", unit: `x\u{1F600}${NUL}y\uD83Dz\u{20000}\uDE00é` }
];

/**
 * Pads shift the whole payload by 0..5 single code units, which walks BOTH cuts across every
 * alignment relative to a two-unit character. Six is enough to cover a width-2 alphabet several
 * times over and is not a multiple of any unit length above.
 */
const PADS = [0, 1, 2, 3, 4, 5] as const;

/**
 * Lengths chosen to exercise the three regimes separately: comfortably under the cap (no slice at
 * all — the pass-through the short path used to be), straddling the cap by a few units, and far
 * over it (both cuts active, middle elided). Expressed in COPIES of the unit, so each alphabet
 * lands at its own set of code-unit lengths.
 */
function copyCountsFor(unitLength: number): number[] {
  const atCap = Math.ceil(RUNNER_DETAIL_MAX_CHARS / unitLength);
  return [
    1,
    Math.floor(atCap / 2),
    atCap - 2,
    atCap - 1,
    atCap,
    atCap + 1,
    atCap + 2,
    atCap * 3,
    atCap * 25
  ].filter((n) => n >= 1);
}

describe("HIGH: every bounded detail is something Postgres will accept, at every cut alignment", () => {
  for (const { name, unit } of ALPHABETS) {
    it(`${name}: persistable and within budget at every pad and length`, () => {
      const checked: string[] = [];
      for (const pad of PADS) {
        for (const copies of copyCountsFor(unit.length)) {
          const input = `${"P".repeat(pad)}${unit.repeat(copies)}END`;
          const bounded = boundDetail(input);
          const where = `${name} pad=${pad} copies=${copies} inputLen=${input.length}`;

          expect(isPersistable(bounded), `${where}: Postgres would refuse this row`).toBe(true);
          // The two halves separately, so a failure names WHICH one — they have different causes
          // and different fixes.
          expect(isWellFormed(bounded), `${where}: a cut left a lone surrogate`).toBe(true);
          expect(bounded.includes(NUL), `${where}: U+0000 survived into a jsonb value`).toBe(false);
          expect(bounded.length, `${where}: over budget`).toBeLessThanOrEqual(
            RUNNER_DETAIL_MAX_CHARS
          );
          checked.push(where);
        }
      }
      // NON-VACUITY: an arm that swept zero inputs would pass every assertion above. `.length` is
      // asserted rather than `toBeGreaterThan(0)` so a change to PADS/copyCountsFor that quietly
      // shrinks the sweep is visible.
      expect(checked.length).toBe(PADS.length * copyCountsFor(unit.length).length);
      expect(checked.length).toBeGreaterThanOrEqual(48);
    });
  }

  it("NON-VACUITY: the unfixed bound really does fail these inputs", () => {
    // The control. If this assertion ever goes red, the sweep above is no longer testing anything —
    // it would mean a code-unit slice of these inputs is well-formed by accident, and every arm
    // would be green for the wrong reason. This is the exact slice `boundDetail` performed before
    // the fix, reproduced here rather than referenced, so the control survives refactors of the
    // product.
    const input = `HEAD${"\u{1F600}".repeat(10_000)}TAIL`;
    const marker = ` …[${input.length} characters elided]… `;
    const headShare = RUNNER_DETAIL_MAX_CHARS - RUNNER_DETAIL_TAIL_CHARS - marker.length;
    const unrepaired =
      input.slice(0, headShare) + marker + input.slice(input.length - RUNNER_DETAIL_TAIL_CHARS);
    expect(isWellFormed(unrepaired), "the pre-fix slice was well-formed — sweep is vacuous").toBe(
      false
    );
    // …and the real function is not.
    expect(isWellFormed(boundDetail(input))).toBe(true);
  });

  it("BOTH cuts are repaired — the head one AND the tail one, each proved on its own", () => {
    // A HEAD-ONLY REPAIR WAS THE FIRST FIX TRIED, AND THE OBVIOUS FIXTURE CANNOT TELL. With a body
    // of nothing but emoji, the TAIL cut is aligned no matter what: the cut sits at
    // `len - RUNNER_DETAIL_TAIL_CHARS`, the reserve is EVEN, so the cut's parity always equals the
    // body's start parity and never lands inside a pair. Shifting a leading pad moves the HEAD cut
    // and leaves the tail cut aligned every time — a 2x2 with an empty column.
    //
    // So the alignment of each cut is steered independently: `headPad` (leading single-unit
    // characters) moves the head cut, and an ODD-length trailing run moves the tail cut, because
    // the tail offset shifts by the trailing run's length mod 2. Each of the four cells asserts the
    // two halves separately, split AT the elision marker so `head` ends exactly where the head cut
    // landed and `tail` begins exactly where the tail cut landed.
    const emoji = "\u{1F600}";
    const seen: string[] = [];
    for (const headPad of [0, 1]) {
      for (const tailPad of [0, 1]) {
        const input = `${"P".repeat(headPad)}${emoji.repeat(20_000)}${"T".repeat(tailPad)}`;
        const bounded = boundDetail(input);
        const at = / …\[\d+ characters elided\]… /.exec(bounded);
        expect(at, `headPad=${headPad} tailPad=${tailPad}: no elision happened`).not.toBeNull();
        const markerAt = bounded.indexOf(at![0]);
        const head = bounded.slice(0, markerAt);
        const tail = bounded.slice(markerAt + at![0].length);
        expect(tail.length).toBe(RUNNER_DETAIL_TAIL_CHARS);
        const cell = `headPad=${headPad} tailPad=${tailPad}`;
        expect(isWellFormed(head), `${cell}: the HEAD cut left a lone surrogate`).toBe(true);
        expect(isWellFormed(tail), `${cell}: the TAIL cut left a lone surrogate`).toBe(true);
        seen.push(cell);
      }
    }
    expect(seen.length).toBe(4);

    // AND THE 2x2 HAS NO EMPTY CELL — asserted, not assumed. This recomputes, from the raw slice
    // offsets alone, which cut each cell actually misaligns, and requires that across the four
    // cells the head cut is misaligned at least once and the tail cut is misaligned at least once.
    // Without this the block above is satisfiable by a fixture where neither cut ever splits a
    // pair, which is precisely the state it was written in and shipped in.
    let headMisaligned = 0;
    let tailMisaligned = 0;
    for (const headPad of [0, 1]) {
      for (const tailPad of [0, 1]) {
        const input = `${"P".repeat(headPad)}${emoji.repeat(20_000)}${"T".repeat(tailPad)}`;
        const marker = ` …[${input.length} characters elided]… `;
        const headShare = RUNNER_DETAIL_MAX_CHARS - RUNNER_DETAIL_TAIL_CHARS - marker.length;
        if (!isWellFormed(input.slice(0, headShare))) headMisaligned++;
        if (!isWellFormed(input.slice(input.length - RUNNER_DETAIL_TAIL_CHARS))) tailMisaligned++;
      }
    }
    expect(headMisaligned, "no cell misaligns the HEAD cut — the column is empty").toBeGreaterThan(
      0
    );
    expect(tailMisaligned, "no cell misaligns the TAIL cut — the column is empty").toBeGreaterThan(
      0
    );
  });

  it("the repair is LENGTH-PRESERVING, so the elision count stays arithmetically honest", () => {
    // U+FFFD is one code unit replacing one code unit. If it were not, the stated drop count would
    // be wrong for exactly the inputs this fix exists for, and a reader would be back to not
    // trusting the number — the diagnostic hazard the marker exists to remove.
    const input = `HEAD${"\u{1F600}".repeat(10_000)}TAIL`;
    const bounded = boundDetail(input);
    const marker = / …\[(\d+) characters elided\]… /.exec(bounded);
    expect(marker).not.toBeNull();
    const keptHead = bounded.indexOf(marker![0]);
    const keptTail = bounded.length - keptHead - marker![0].length;
    expect(keptHead + Number(marker![1]) + keptTail).toBe(input.length);
  });

  it("LEGAL TEXT IS NOT MANGLED: a well-formed detail passes through byte-identical", () => {
    // The counter-arm. A sanitiser that replaced too much would satisfy every assertion above.
    const legal = `déjà vu \u{1F600} 中文 é ${"ok ".repeat(100)}`;
    expect(legal.length).toBeLessThan(RUNNER_DETAIL_MAX_CHARS);
    expect(boundDetail(legal)).toBe(legal);
    // …and no U+FFFD was introduced anywhere in a long, legal, sliced string either.
    const longLegal = `HEAD${"中文 ".repeat(50_000)}\u{1F600}TAIL`;
    const bounded = boundDetail(longLegal);
    expect(
      bounded.includes("\uFFFD"),
      "the sanitiser replaced a character it should not have"
    ).toBe(false);
    expect(bounded.startsWith("HEAD")).toBe(true);
    expect(bounded.endsWith("TAIL")).toBe(true);
  });

  it("IDEMPOTENT over adversarial input too", () => {
    for (const { unit } of ALPHABETS) {
      const once = boundDetail(`${unit.repeat(30_000)}END`);
      expect(boundDetail(once)).toBe(once);
    }
  });
});
