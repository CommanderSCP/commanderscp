import { describe, expect, it } from "vitest";

import {
  boundPersistedJson,
  PERSISTED_JSON_ELIDED_KEY,
  PERSISTED_JSON_MAX_CHARS
} from "./index.js";

/**
 * ================================================================================================
 * THE DENSE BUDGET SWEEP — M23.0 verification pass 14, and the instrument eleven passes did not
 * have.
 * ================================================================================================
 * BUILD_AND_TEST.md's M23.1f entry records the finding that produced this file: **random shape
 * generation is the wrong instrument for this class**. 6 000 random shapes — widths to 25 x 60,
 * depth 10, arrays to 120, bigints, functions, over-long and colliding keys — found ZERO instances
 * of pass 12's defect against the build that had it, while a structured budget sweep found 49 518.
 * The axis eleven passes never varied is the BUDGET. Every defect this file's family has produced
 * is an arithmetic coincidence between one structure and one budget, and a corpus that samples
 * budgets at three hand-picked values cannot see any of them.
 *
 * So the permanent gate is a SWEEP: a small, named, structured family of shapes, run at EVERY
 * INTEGER BUDGET from 4 upward. `persisted-json-bound.test.ts` and
 * `persisted-json-truncation.test.ts` each carry their own narrower sweep for their own property;
 * this file is the one that asks the three questions that are about the WHOLE bound at once, over
 * the whole family, at every width and at depths 0 to 5.
 *
 *   (1) NO ROW EVER EXCEEDS ITS BUDGET. The row bound is the guarantee the column depends on.
 *   (2) THE BACKSTOP NEVER FIRES above the width of the walk's own shortest honest output. The
 *       backstop discards the WHOLE value — `revision`, `images` and `rollout.weight` gone
 *       together, replaced by a diagnostic sentence, silently, on every tick — so a firing is not
 *       a safety net doing its job, it is the worst loss this file can produce.
 *   (3) A VALUE THAT CAME BACK CHANGED CAME BACK WITH A REPORT (M23.1g), swept here over shapes
 *       `persisted-json-truncation.test.ts`'s own sweep does not carry.
 *
 * WHAT IT CAUGHT, WHICH IS WHY IT EXISTS (pass 14). `walkObjectFields` phase 1 subtracted its
 * `__scpElided` entry's price from a budget it had already spent, with no check that it could be
 * afforded — the identical defect pass 11 found and fixed in the ARRAY's tail marker, one branch
 * away, left standing in the object. An object's overspend multiplies by the tree's width and
 * depth where an array's merely adds, so:
 *
 *     five levels of three fields, 4 483 characters of ordinary content
 *         budget 1200   walk given 1104   rendered 1189   budget.left  -85
 *         budget 3000   walk given 2904   rendered 2917   budget.left  -13
 *     four levels of three fields, 1 486 characters
 *         budget 1200   walk given 1104   rendered 1297   -> 193 OVER -> WHOLE VALUE DISCARDED
 *
 * and the four-level shape was discarded at every budget from 4 to 1 296, the five-level one at
 * every budget up to 3 915. Over this sweep's 145 048 (shape, budget) pairs: **15 982 backstop
 * firings before, 0 above a budget of 31 after**. The retention that bought is measured beside it
 * in `persisted-json-bound.test.ts` -> "AND THE COUNT THAT SURVIVES IS THE LAW'S, NOT THE
 * CUSHION'S".
 *
 * AND THE SHAPE OF THE EVIDENCE MATTERS AS MUCH AS THE COUNT. Before the fix, five of the thirteen
 * places where one more character of BUDGET stored more than 100 characters LESS landed on 145 —
 * the length of the apology. `depth 5 width 3` went from 2 539 stored characters to 145 between
 * budget 3 201 and 3 202. Nine such cliffs remain and NOT ONE of them lands on the backstop; they
 * are the flat-96 seating cliff pass 12 named, which is a different property and a smaller loss.
 */

/** Named, because a witness has to be quotable. Structured, because the trigger is arithmetic. */
type Shape = { name: string; value: unknown };

function family(): Shape[] {
  const out: Shape[] = [];
  const push = (name: string, value: unknown) => out.push({ name, value });

  // THE FAMILY THAT CAUGHT PASS 14: nesting. Every level is an object that must decide whether it
  // can seat its children, and every level that cannot pays for an elision entry.
  const nest = (d: number, w: number): unknown =>
    d === 0
      ? "leaf"
      : Object.fromEntries(Array.from({ length: w }, (_, i) => [`d${d}f${i}`, nest(d - 1, w)]));
  for (let d = 0; d <= 5; d++) for (const w of [1, 2, 3]) push(`depth ${d} width ${w}`, nest(d, w));

  // Pass 12's and pass 13's family: many fields, each a small container.
  for (const n of [1, 2, 3, 5, 8, 13, 21, 40]) {
    push(
      `${n} fields x list(5)`,
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, ["a", "b", "c", "d", "e"]]))
    );
    push(
      `${n} fields x obj(3)`,
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, { a: "1", b: "2", c: "3" }]))
    );
  }

  // Pass 11's family: arrays whose tail marker is the thing that overspends.
  for (const n of [2, 3, 5, 9])
    push(
      `list(${n}) of list(3)`,
      Array.from({ length: n }, () => ["e", "e", "e"])
    );
  for (const n of [2, 6])
    push(
      `${n} fields x list(20 of 12ch)`,
      Object.fromEntries(
        Array.from({ length: n }, (_, i) => [
          `k${i}`,
          Array.from({ length: 20 }, (_, j) => `entry-${j}`.padEnd(12, "z"))
        ])
      )
    );

  // The reading a real Argo CD produces, at the image counts ADR-0028's gate cares about.
  for (const n of [1, 20, 73])
    push(`observedStateFrom(${n} images)`, {
      revision: "9f2c1ab7e4d3095f6a8b2c1d0e9f8a7b6c5d4e3f",
      images: Array.from(
        { length: n },
        (_, i) => `ghcr.io/acme/platform/service-${i}@sha256:${"0123456789abcdef".repeat(4)}`
      ),
      rollout: { phase: "Progressing", step: 3, weight: 60 }
    });

  // Keys past PERSISTED_JSON_MAX_KEY_CHARS, so the seat price is not the key's own width; and
  // alphabets where `jsonCost` is not `.length`, which is where the bisection lives.
  push("3 fields with 200-char keys", {
    ["a-" + "K".repeat(200)]: "v0",
    ["b-" + "K".repeat(200)]: "v1",
    ["c-" + "K".repeat(200)]: "v2"
  });
  for (const [label, ch] of [
    ["backslash", "\\"],
    ["quote", '"'],
    ["C0", "\u0001"],
    ["astral", "\u{1F600}"]
  ] as const)
    push(`60 ${label} chars x3 fields`, {
      a: ch.repeat(60),
      b: ch.repeat(60),
      c: ch.repeat(60)
    });

  // The leaf branches a corpus of strings never reaches — `null`, `undefined`, a function, a
  // non-finite number — which is the family NULL_RENDERED_CHARS was written for.
  push("mixed leaves", {
    n: null,
    u: undefined,
    f: () => 1,
    nan: Number.NaN,
    b: true,
    z: 0,
    list: [null, undefined, () => 1, Number.NaN, true, "s"]
  });
  push("1000 nulls", { a: Array.from({ length: 1000 }, () => null) });

  // Roots that are not plain objects — the one shape with no field names to report under.
  push("bare string 200", "v".repeat(200));
  push(
    "bare list of 40",
    Array.from({ length: 40 }, (_, i) => `e${i}`)
  );

  return out;
}

/**
 * WHAT `JSON.stringify` WOULD WRITE FOR THE INPUT IF A FUNCTION FIELD RENDERED AS `null` THE WAY
 * THE WALK STORES IT. Without this, "the walk changed the value" fires on a difference that is
 * about `JSON.stringify` OMITTING a field rather than about anything being removed — and a gate
 * that fires on a non-loss is a gate whose reds stop being read.
 */
function faithful(value: unknown): unknown {
  if (typeof value === "function" || typeof value === "symbol") return null;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(faithful);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined) continue;
    out[k] = faithful(v);
  }
  return out;
}

const DIAGNOSTIC = "a plugin-supplied value rendered";

/**
 * THE BACKSTOP, AND NOT A TOTAL ELISION — they are the SAME SHAPE and only one of them is a defect.
 * `{__scpElided: "3 more fields"}` is the walk saying, truthfully and within its budget, "every
 * field was cut". The backstop is the walk's whole output being MEASURED over budget and thrown
 * away. An earlier draft of this sweep conflated them and reported 17 284 firings for a build whose
 * real number was 3 483 — the wrong number in the safe direction, which is still the wrong number.
 */
function backstopFired(bounded: unknown, input: unknown): boolean {
  if (bounded === null) return input !== null && input !== undefined;
  if (typeof bounded !== "object" || Array.isArray(bounded)) return false;
  const keys = Object.keys(bounded as object);
  if (keys.length !== 1 || keys[0] !== PERSISTED_JSON_ELIDED_KEY) return false;
  const marker = (bounded as Record<string, unknown>)[PERSISTED_JSON_ELIDED_KEY];
  return marker === true || (typeof marker === "string" && marker.startsWith(DIAGNOSTIC));
}

/**
 * THE FLOOR BELOW WHICH A BACKSTOP FIRING IS NOT A DEFECT. The walk's shortest honest output for a
 * value it had to elide entirely is `{"__scpElided":"<n> more fields"}` — 32 characters for a
 * one-digit count — and there is nothing shorter to store; the widest this family reaches is 47.
 * MEASURED rather than chosen: over this sweep the highest budget at which the backstop fires at
 * all is **31**, so 100 is comfortably clear of it and still two orders of magnitude below the
 * 8 000 the column actually uses. Before pass 14's fix the same number was **3 915**.
 */
const BACKSTOP_FLOOR = 100;

describe("HIGH: the whole bound, swept densely in the BUDGET at every width and depth 0-5", () => {
  it("NO ROW EXCEEDS ITS BUDGET, THE BACKSTOP NEVER FIRES, AND NOTHING IS CUT IN SILENCE", () => {
    const over: string[] = [];
    const discarded: string[] = [];
    const silent: string[] = [];
    const noise: string[] = [];
    let pairs = 0;
    let cut = 0;
    let intact = 0;
    let elided = 0;

    for (const shape of family()) {
      const verbatim = JSON.stringify(faithful(shape.value)) ?? "null";
      // Dense to a little past what the value costs, so the sweep covers the whole transition from
      // "nothing fits" to "everything fits" one character at a time — which is exactly where every
      // defect this family has produced has lived.
      const top = Math.min(Math.max(verbatim.length + 300, 2_000), 9_000);
      for (let budget = 4; budget <= top; budget++) {
        pairs++;
        const result = boundPersistedJson(shape.value, budget);
        const rendered = JSON.stringify(result.value) ?? "null";
        const where = `${shape.name} @ ${budget}`;

        if (rendered.length > budget) over.push(`${where}: rendered ${rendered.length}`);
        if (backstopFired(result.value, shape.value)) {
          if (budget >= BACKSTOP_FLOOR)
            discarded.push(`${where}: ${verbatim.length} characters thrown away`);
          elided++;
        }
        if (rendered === verbatim) {
          intact++;
          if (result.truncation !== undefined) noise.push(where);
        } else {
          cut++;
          if (result.truncation === undefined)
            silent.push(`${where}: ${verbatim.length} -> ${rendered.length}, no report`);
        }
      }
    }

    // NON-VACUITY, ALL FOUR WAYS. A sweep that never cut anything, never kept anything whole, or
    // never drove a value to nothing would be green on a bound that did nothing at all.
    // The measured figures are 116 850 / 41 263 / 75 587 / 1 288; the thresholds sit below them
    // with room for the family to be edited, and above zero for every one of the four.
    expect(pairs, "the sweep did not run").toBeGreaterThan(100_000);
    expect(cut, "nothing was ever cut, so the cut-side assertions are vacuous").toBeGreaterThan(
      30_000
    );
    expect(
      intact,
      "nothing ever came back whole, so the intact-side assertions are vacuous"
    ).toBeGreaterThan(50_000);
    expect(elided, "no budget was ever tight enough to reach the backstop at all").toBeGreaterThan(
      500
    );

    expect(over.slice(0, 5), `${over.length} rows over their budget`).toEqual([]);
    expect(
      discarded.slice(0, 5),
      `${discarded.length} whole values discarded at a budget of ${BACKSTOP_FLOOR} or more`
    ).toEqual([]);
    expect(silent.slice(0, 5), `${silent.length} values cut with no truncation report`).toEqual([]);
    expect(noise.slice(0, 5), `${noise.length} reports on values that lost nothing`).toEqual([]);
    // 2.8s alone; the explicit budget is for the parallel graph, where vitest's 5 000 ms default
    // is what a 116 850-pair sweep hits first. A gate that reds because the machine was busy is a
    // gate people learn to re-run rather than read.
  }, 60_000);

  it("COUNTER-ARM: the sweep's own family reaches the production budget and the real reading", () => {
    // The sweep above stops at 9 000, but its widest shape is far smaller than a saturating
    // reading. The column policy is 8 000 and the shape that
    // matters most is the one a real Argo CD produces, so it is asserted separately rather than
    // left to a reader to assume the sweep covered it.
    const reading = {
      revision: "9f2c1ab7e4d3095f6a8b2c1d0e9f8a7b6c5d4e3f",
      images: Array.from(
        { length: 400 },
        (_, i) => `ghcr.io/acme/platform/service-${i}@sha256:${"0123456789abcdef".repeat(4)}`
      ),
      rollout: { phase: "Progressing", step: 3, weight: 60 }
    };
    const result = boundPersistedJson(reading);
    expect(backstopFired(result.value, reading), "the real reading was discarded").toBe(false);
    const stored = result.value as { rollout?: { weight?: number }; images?: string[] };
    // ADR-0028's `minWeight` gate reads `rollout.weight`, and the whole point of the water-filling
    // rule is that a long image list cannot be the reason it disappears.
    expect(stored.rollout?.weight).toBe(60);
    expect(stored.images?.length).toBeGreaterThan(50);
    expect(JSON.stringify(result.value)!.length).toBeLessThanOrEqual(PERSISTED_JSON_MAX_CHARS);
  });
});
