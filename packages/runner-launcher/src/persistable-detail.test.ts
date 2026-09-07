import { describe, expect, it } from "vitest";
import { RUNNER_DETAIL_MAX_CHARS, RUNNER_DETAIL_TAIL_CHARS, boundDetail } from "./index.js";

/** The bound cut surrogate pairs and Postgres refused. See docs/runner-launcher.md §340. */

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

/** Adversarial alphabets, each a repeating unit. See docs/runner-launcher.md §341. */
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

/** Pads shift the payload so both cuts walk across. See docs/runner-launcher.md §342. */
const PADS = [0, 1, 2, 3, 4, 5] as const;

/** Lengths chosen to exercise the three regimes separately. See docs/runner-launcher.md §343. */
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
    // The control: if this reddens, the sweep tests nothing. See docs/runner-launcher.md §344.
    const input = `HEAD${"\u{1F600}".repeat(10_000)}TAIL`;
    const marker = ` …[${input.length} characters elided]… `;
    const headShare = RUNNER_DETAIL_MAX_CHARS - RUNNER_DETAIL_TAIL_CHARS - marker.length;
    const unrepaired =
      input.slice(0, headShare) + marker + input.slice(input.length - RUNNER_DETAIL_TAIL_CHARS);
    expect(isWellFormed(unrepaired), "the pre-fix slice was well-formed — sweep is vacuous").toBe(
      false
    );
    expect(isWellFormed(boundDetail(input))).toBe(true);
  });

  it("BOTH cuts are repaired — the head one AND the tail one, each proved on its own", () => {
    // A head-only repair was tried first, and this catches it. See docs/runner-launcher.md §345.
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

    // AND THE 2x2 HAS NO EMPTY CELL. See docs/runner-launcher.md §346.
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
