import { describe, expect, it } from "vitest";
import {
  PERSISTED_JSON_ELIDED_KEY,
  PERSISTED_JSON_MAX_CHARS,
  PERSISTED_JSON_MAX_DEPTH,
  boundPersistedJson,
  isPersistedJsonEntriesElision
} from "./index.js";

/**
 * MEDIUM (M23.0 verification pass 7, findings M2 and M3) — BOUND THE STRUCTURE, NOT A LIST OF ITS
 * FIELDS.
 *
 * WHY THIS FUNCTION EXISTS RATHER THAN FOUR MORE `boundDetail` CALLS. The previous round bounded
 * `ExecutionStatus.detail` and missed `stateRef` and `observed.images` — the same untrusted object,
 * three lines away, on a write that runs EVERY tick rather than only on failure. Measured through
 * an unmodified test seam: 500 093 bytes of plugin-chosen text, verbatim, in
 * `change_wave_targets.observed_state`. `ExecutionStatus.observed` is documented as "optional and
 * additive", so a per-field patch list is a list that goes stale on the next signal an executor
 * contributes. The guarantee here is therefore about the WHOLE VALUE and is stated in the unit the
 * column is measured in:
 *
 *   JSON.stringify(boundPersistedJson(v)).length <= PERSISTED_JSON_MAX_CHARS,  for every v
 *
 * The sweep below is the evidence for "every v" that a hand-picked object cannot be. Note the last
 * two arms in particular: a REALISTIC reading has to come back byte-identical, and the internal
 * overflow fallback must never fire — either would make the guarantee true for a useless reason.
 */

/** An escape, not a literal: a NUL byte in a tracked source file is dropped by every
 *  recursive search this repository runs (CLAUDE.md). */
const NUL = "\u0000";
const MAX = PERSISTED_JSON_MAX_CHARS;

function isWellFormed(s: string): boolean {
  return (s as unknown as { isWellFormed(): boolean }).isWellFormed();
}

function deepChain(depth: number): unknown {
  const root: Record<string, unknown> = {};
  let cursor = root;
  for (let i = 0; i < depth; i++) {
    const next: Record<string, unknown> = {};
    cursor.next = next;
    cursor = next;
  }
  cursor.leaf = "the bottom";
  return root;
}

function selfReferential(): unknown {
  const o: Record<string, unknown> = { a: 1 };
  o.self = o;
  return o;
}

/** Every one of these is something an `ExecutionStatus` off the JSON-RPC boundary can actually be:
 *  the host types that response with a BARE CAST — `call<ExecutionStatus>("status", …)` — with no
 *  runtime validation anywhere on the path, so "the plugin promised a `string[]`" is not a fact. */
const ADVERSARIAL: ReadonlyArray<{ name: string; value: unknown }> = [
  { name: "a few enormous strings", value: { images: [`ghcr.io/x/y:${"a".repeat(100_000)}`] } },
  {
    name: "very many small strings",
    value: { images: Array.from({ length: 5_000 }, (_, i) => `ghcr.io/x/y:${i}`) }
  },
  { name: "one 2 MB revision", value: { revision: "r".repeat(2_000_000) } },
  {
    name: "astral characters at every cut",
    value: { revision: "\u{1F600}".repeat(100_000), images: ["\u{1F600}".repeat(50_000)] }
  },
  { name: "lone surrogates", value: { revision: `a\uD83Db`, images: [`x\uDE00`] } },
  { name: "NUL bytes", value: { revision: `a${NUL}b`, images: [`x${NUL}`] } },
  { name: "worst-case escapes (backslashes)", value: { s: "\\".repeat(200_000) } },
  { name: "worst-case escapes (C0 controls)", value: { s: "\u0001".repeat(200_000) } },
  { name: "worst-case escapes (quotes)", value: { s: '"'.repeat(200_000) } },
  {
    name: "5 000 keys",
    value: Object.fromEntries(Array.from({ length: 5_000 }, (_, i) => [`k${i}`, "v".repeat(50)]))
  },
  {
    name: "50 enormous KEYS",
    value: Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [`${"k".repeat(5_000)}${i}`, "v"])
    )
  },
  { name: "a 100 000-element array", value: Array.from({ length: 100_000 }, (_, i) => i) },
  { name: "200 levels of nesting", value: deepChain(200) },
  { name: "a self-referential object", value: selfReferential() },
  { name: "non-finite numbers", value: { a: NaN, b: Infinity, c: -Infinity, d: 1.5 } },
  { name: "a bigint", value: { n: 10n ** 40n } },
  { name: "a bare enormous string", value: "s".repeat(1_000_000) },
  { name: "null", value: null },
  { name: "undefined", value: undefined }
];

describe("MEDIUM: boundPersistedJson bounds a whole plugin-supplied value, not a list of its fields", () => {
  it.each(ADVERSARIAL.map((c) => [c.name, c.value] as const))(
    "%s: renders within the budget and is something Postgres will store",
    (name, value) => {
      const bounded = boundPersistedJson(value);
      const rendered = JSON.stringify(bounded);
      if (rendered === undefined) {
        // Only `undefined` reaches here, and it is the one input with nothing to bound.
        expect(value).toBeUndefined();
        return;
      }
      expect(rendered.length, `${name}: over the whole-value budget`).toBeLessThanOrEqual(MAX);
      // Stated against the literal as well, for the reason the magnitude tests exist: an assertion
      // against the constant that defines the bound cannot notice the constant moving.
      expect(rendered.length).toBeLessThanOrEqual(8_000);
      expect(isWellFormed(rendered), `${name}: a lone surrogate reached the row`).toBe(true);
      expect(rendered.includes(NUL), `${name}: U+0000 reached the row`).toBe(false);
    }
  );

  it("NON-VACUITY: the inputs really are over budget before bounding", () => {
    // Without this the sweep above is satisfiable by a fixture that never applied. Three of the
    // arms are deliberately SMALL (null, undefined, non-finite numbers), so this counts rather than
    // requiring all of them.
    const over = ADVERSARIAL.filter(({ value }) => {
      let raw: string | undefined;
      try {
        raw = JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? String(v) : v));
      } catch {
        return true; // a cycle — `JSON.stringify` throws, which is as over-budget as it gets
      }
      return raw !== undefined && raw.length > MAX;
    });
    expect(over.length, "the adversarial sweep is not adversarial").toBeGreaterThanOrEqual(12);
  });

  it("A REALISTIC READING IS RETURNED BYTE-IDENTICAL — the bound is a ceiling, not a filter", () => {
    // The counter-arm. A function that returned `{}` would satisfy every assertion above, and this
    // payload is what an actual Argo CD poll produces; ADR-0028's freshness gate reads these fields.
    const reading = {
      revision: "9f2c1ab4e77d0c31a5b8e6f2c9d4a1b3e5f70982",
      images: ["ghcr.io/org/app:1.2.3", "ghcr.io/org/sidecar@sha256:" + "a".repeat(64)],
      rollout: { phase: "Progressing", step: 2, weight: 25, message: "canary at 25%" }
    };
    expect(JSON.stringify(boundPersistedJson(reading))).toBe(JSON.stringify(reading));
  });

  it("THE INTERNAL OVERFLOW FALLBACK NEVER FIRES for any of the adversarial inputs", () => {
    // `boundPersistedJson` measures its own output and, if the walk's accounting were ever wrong,
    // replaces the payload with a small diagnostic. That backstop is deliberate — a lost payload
    // beats a stalled loop — but if it were firing routinely the sweep above would be green while
    // the function did nothing useful. So it is asserted NOT to fire.
    for (const { name, value } of ADVERSARIAL) {
      const bounded = boundPersistedJson(value);
      const fellBack =
        bounded !== null &&
        typeof bounded === "object" &&
        typeof (bounded as Record<string, unknown>)[PERSISTED_JSON_ELIDED_KEY] === "string" &&
        String((bounded as Record<string, unknown>)[PERSISTED_JSON_ELIDED_KEY]).startsWith(
          "a plugin-supplied value rendered"
        );
      expect(fellBack, `${name}: the walk's accounting was wrong and the backstop caught it`).toBe(
        false
      );
    }
  });

  it("A CYCLE IS SURVIVED, not thrown on — the values here come from a subprocess we do not control", () => {
    // `JSON.stringify` throws on a cycle, and a throw on this path is the stall the whole family of
    // fixes exists to prevent: it happens inside the write transaction.
    const bounded = boundPersistedJson(selfReferential());
    expect(() => JSON.stringify(bounded)).not.toThrow();
    expect(JSON.stringify(bounded)).toContain("nesting deeper than");
  });

  it("depth is capped at PERSISTED_JSON_MAX_DEPTH, and the cap is where the marker appears", () => {
    const bounded = boundPersistedJson(deepChain(200)) as Record<string, unknown>;
    let cursor: unknown = bounded;
    let depth = 0;
    while (cursor !== null && typeof cursor === "object" && "next" in cursor) {
      cursor = (cursor as { next: unknown }).next;
      depth++;
    }
    expect(depth).toBe(PERSISTED_JSON_MAX_DEPTH);
    expect(typeof cursor).toBe("string");
  });

  it("a smaller explicit budget is honoured too", () => {
    // The parameter is not decoration: `observed_state` and a future caller with a tighter column
    // are the same function at different widths.
    for (const max of [64, 200, 1_000]) {
      const rendered = JSON.stringify(
        boundPersistedJson({ images: Array.from({ length: 100 }, () => "x".repeat(5_000)) }, max)
      );
      expect(rendered!.length, `budget ${max}`).toBeLessThanOrEqual(max);
      expect(isWellFormed(rendered!)).toBe(true);
    }
  });

  /**
   * SMALL (M23.0 verification pass 9) — THE OVERFLOW FALLBACK WAS THE ONE VALUE THIS FUNCTION
   * RETURNED WITHOUT MEASURING IT.
   *
   * "The guarantee is CHECKED, not argued" is the function's own headline, and the escape hatch out
   * of the check was itself unchecked: at `maxChars = 0` the diagnostic object rendered to 140
   * characters. Latent today — `boundPluginJson` always passes 8 000 — but an unmeasured branch
   * inside a measured function is where the next one lives. Swept down to and past the stated
   * precondition.
   */
  it("EVERY budget down to 1 is honoured, fallback included — no unmeasured escape hatch", () => {
    for (let max = 4; max <= 400; max++) {
      const rendered = JSON.stringify(boundPersistedJson({ images: ["x".repeat(5_000)] }, max));
      expect(rendered, `budget ${max}: nothing at all was returned`).not.toBeUndefined();
      expect(rendered!.length, `budget ${max}`).toBeLessThanOrEqual(max);
      expect(isWellFormed(rendered!)).toBe(true);
    }
  });

  it("THE STATED PRECONDITION, pinned: under 4 characters no JSON value exists, and `null` is it", () => {
    // `null` is the shortest thing `JSON.stringify` can produce. A budget of 0..3 cannot be honoured
    // by ANY value, so the doc states it as a precondition rather than the function pretending. This
    // arm exists so a future edit that quietly returns a 140-character diagnostic here goes red.
    for (const max of [0, 1, 2, 3]) {
      expect(JSON.stringify(boundPersistedJson({ a: "x".repeat(500) }, max))).toBe("null");
    }
    // And at exactly 4 the guarantee is real again.
    expect(
      JSON.stringify(boundPersistedJson({ a: "x".repeat(500) }, 4))!.length
    ).toBeLessThanOrEqual(4);
  });
});

/**
 * MEDIUM (M23.0 verification pass 8) — THE BUDGET USED TO BE SPENT IN INSERTION ORDER, SO THE FIELD
 * A GATE READS WAS DECIDED BY SOURCE-LINE ORDER IN AN UNRELATED FUNCTION.
 *
 * `observedStateFrom` composes `{revision, images, rollout}` in that order. The walk charged each
 * field as it went and, once the remainder fell under the per-leaf minimum, replaced EVERY
 * still-unwalked field with `__scpElided` — so `rollout`, always last, was always the first thing
 * dropped. Measured end to end against real Postgres through the ordinary fake-executor seam, with
 * 80 image refs of the shape an Argo CD Application actually reports:
 *
 *   before  images, rollout, revision, observedAt   weight 60     min_weight         satisfied TRUE
 *   after   images, revision, observedAt, __scpElided  undefined  weight_unreadable  satisfied FALSE
 *
 * `rollout.weight` is the leaf ADR-0028's `minWeight` gate reads (`stage-dependency-hold.ts`), and
 * losing it degrades the dependency to the universal `succeeded` test — fail-CLOSED, so nothing
 * wrong ships, but a correct configuration holds indefinitely and the recorded cause (`no_weight`)
 * blames the executor for what the bound did.
 *
 * THE ARMS BELOW ARE ORDER-INDEPENDENT ON PURPOSE. A test that only pinned `{revision, images,
 * rollout}` would be satisfied by the alternative fix — reordering the composition — which makes
 * source-line order a load-bearing contract that the next person reorders innocently. The property
 * is about the WALK: no key is lost because a SIBLING was large, whatever order they arrive in.
 */
describe("MEDIUM: one large field may not spend a sibling's budget", () => {
  /** The shape an Argo CD Application reports: `status.summary.images` is the image list across
   *  every managed resource, uncapped, and 73 of these already exceed the whole-value budget. This
   *  is not hostile input — it is an umbrella app. */
  const imageRefs = (n: number) =>
    Array.from(
      { length: n },
      (_, i) => `ghcr.io/acme/platform/service-${i}@sha256:${"a".repeat(64)}`
    );
  const ROLLOUT = { phase: "Progressing", step: 3, weight: 60, message: "canary at 60%" };
  const REVISION = "9f2c1ab4e77d0c31a5b8e6f2c9d4a1b3e5f70982";

  type Reading = { revision?: string; images?: string[]; rollout?: typeof ROLLOUT };
  const bound = (v: Reading) => boundPersistedJson(v) as Reading & Record<string, unknown>;

  it("NON-VACUITY: 80 ordinary image refs really do overflow the budget on their own", () => {
    // Without this the arms below are satisfiable by a fixture the bound never touched — the mode
    // this repository has shipped before (a green test whose fixture silently never applied).
    expect(JSON.stringify({ images: imageRefs(80) }).length).toBeGreaterThan(
      PERSISTED_JSON_MAX_CHARS
    );
    // And the arms are not sitting on the boundary: the measured threshold at which the old
    // insertion-order walk started dropping `rollout` was 73 refs — the point where `images` alone
    // has spent effectively the whole budget, leaving the field walked after it nothing. 7 948 raw
    // characters, measured; the arms below use 80.
    expect(
      JSON.stringify({ revision: REVISION, images: imageRefs(73), rollout: ROLLOUT }).length
    ).toBeGreaterThan(PERSISTED_JSON_MAX_CHARS - 100);
  });

  it("THE REPORTED CASE: 80 image refs beside a canary rollout leave `rollout.weight` readable", () => {
    const out = bound({ revision: REVISION, images: imageRefs(80), rollout: ROLLOUT });
    // The leaf the gate reads. `weightUnreadableCause` requires a FINITE NUMBER here; anything else
    // is `no_weight`, which degrades the dependency and blames the executor.
    expect(out.rollout?.weight).toBe(60);
    expect(out.rollout?.step).toBe(3);
    // And the whole key is there, not a marker standing in for it.
    expect(out[PERSISTED_JSON_ELIDED_KEY]).toBeUndefined();
    expect(out.revision).toBe(REVISION);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(PERSISTED_JSON_MAX_CHARS);
  });

  /** All six permutations of the three fields `observedStateFrom` composes. */
  const ORDERS = [
    ["revision", "images", "rollout"], // <- what `observedStateFrom` actually produces
    ["revision", "rollout", "images"],
    ["images", "revision", "rollout"],
    ["images", "rollout", "revision"],
    ["rollout", "revision", "images"],
    ["rollout", "images", "revision"]
  ] as const;

  const inOrder = (order: readonly string[], source: Record<string, unknown>) => {
    const value: Record<string, unknown> = {};
    for (const key of order) value[key] = source[key];
    return value;
  };

  it("AT EVERY FIELD ORDER — the fix is in the walk, not in how the value happens to be composed", () => {
    const source: Record<string, unknown> = {
      revision: REVISION,
      images: imageRefs(80),
      rollout: ROLLOUT
    };
    for (const order of ORDERS) {
      const out = boundPersistedJson(inOrder(order, source)) as Reading & Record<string, unknown>;
      expect(out.rollout?.weight, `order ${order.join(",")}: the gate's leaf was elided`).toBe(60);
      expect(out.revision, `order ${order.join(",")}: revision was elided`).toBe(REVISION);
      expect(
        out.images?.length,
        `order ${order.join(",")}: images vanished entirely`
      ).toBeGreaterThan(1);
      expect(
        out[PERSISTED_JSON_ELIDED_KEY],
        `order ${order.join(",")}: a whole field was dropped for a sibling`
      ).toBeUndefined();
      expect(JSON.stringify(out).length).toBeLessThanOrEqual(PERSISTED_JSON_MAX_CHARS);
    }
  });

  /**
   * HIGH (M23.0 verification pass 9) — WHICH KEYS SURVIVE IS NOT THE WHOLE PROPERTY. HOW MUCH OF
   * EACH SURVIVES IS PART OF IT.
   *
   * The allocator's doc (on `PERSISTED_JSON_SHARE_ROUNDS`) rejects the reorder alternative (order
   * `rollout` before `images` in `observedStateFrom`) because it "makes source-line order in an
   * unrelated function a load-bearing contract". Pass 8's own design had that disease on a different
   * observable: every arm above was green while the same three fields kept
   *
   *   revision, images, rollout (SHIPPED)  ->  39 refs, row 4 065
   *   revision, rollout, images            ->  77 refs, row 7 864
   *   images, revision, rollout            ->  26 refs, row 2 765
   *
   * — a 3x spread decided by nothing but insertion order. A rejection argument the chosen design
   * also fails is not a rejection argument, so the property is pinned here rather than asserted in a
   * comment: retention is IDENTICAL, not merely "nonzero", across all six permutations.
   */
  it("ORDER-INDEPENDENT RETENTION: all six permutations keep the SAME number of entries", () => {
    const source: Record<string, unknown> = {
      revision: REVISION,
      images: imageRefs(80),
      rollout: ROLLOUT
    };
    const readings = ORDERS.map((order) => {
      const out = boundPersistedJson(inOrder(order, source)) as Reading;
      return {
        order: order.join(","),
        kept: out.images!.length,
        row: JSON.stringify(out).length
      };
    });
    // NON-VACUITY: if the fixture stopped overflowing, every permutation would keep all 80 and the
    // arm would be about nothing.
    expect(readings.every((r) => r.kept < 80)).toBe(true);
    const first = readings[0]!;
    for (const reading of readings) {
      expect(reading.kept, `retention varies with field order: ${JSON.stringify(readings)}`).toBe(
        first.kept
      );
      expect(reading.row, `row size varies with field order: ${JSON.stringify(readings)}`).toBe(
        first.row
      );
    }
  });

  /**
   * HIGH (M23.0 verification pass 9) — THE SHARE IS A FLOOR, NOT A CEILING; UNSPENT BUDGET COMES
   * BACK.
   *
   * Pass 8 handed each field `floor(left / unwalkedSiblings)` as a CAP and never returned the
   * remainder to a field already walked. `images` sits in the MIDDLE of `{revision, images, rollout}`,
   * so it was capped at ~1/2 the budget while `revision` + `rollout` spent ~110 of the ~3 950 they
   * were handed. Utilisation fell from 99.4 % to 50.6 %, and end to end that turned
   * `resolveReleasedVersion` from `determined` into `observed_images_elided` for every list of
   * 35…69 refs — a window that had never been broken.
   *
   * DELETE-THE-WIRING for pass 2: remove the redistribution loop in `walkObjectFields` and this arm
   * fails at n = 40 (34 of 40 kept) and on utilisation (~50 %).
   */
  it("NO TRUNCATION AT ALL while the whole value fits — the 35…69 window pass 8 broke", () => {
    for (let n = 30; n <= 69; n++) {
      const value = { revision: REVISION, images: imageRefs(n), rollout: ROLLOUT };
      const raw = JSON.stringify(value);
      // NON-VACUITY: the window is defined by "fits the budget", so assert that rather than assume
      // it. If a future fixture change pushed n = 69 over 8 000 this loop would be checking that an
      // overflowing value is not truncated, which is impossible and would fail loudly.
      expect(raw.length, `n=${n} no longer fits the budget`).toBeLessThanOrEqual(
        PERSISTED_JSON_MAX_CHARS
      );
      const out = boundPersistedJson(value) as Reading;
      expect(out.images?.length, `n=${n}: the list was cut although the whole value fits`).toBe(n);
      expect(JSON.stringify(out), `n=${n}: a value that fits came back changed`).toBe(raw);
    }
  });

  it("BUDGET UTILISATION: an overflowing value spends what it was given, not half of it", () => {
    const out = boundPersistedJson({
      revision: REVISION,
      images: imageRefs(400),
      rollout: ROLLOUT
    });
    const row = JSON.stringify(out).length;
    // Pass 7 (one budget, insertion order) reached 99.4 %; pass 8 (share as ceiling) reached 50.6 %.
    // 90 % is comfortably above the defect and below the exact figure, so this arm reddens on the
    // regression without pinning a byte count that a marker's wording could move.
    expect(row / PERSISTED_JSON_MAX_CHARS).toBeGreaterThan(0.9);
    expect(row).toBeLessThanOrEqual(PERSISTED_JSON_MAX_CHARS);
  });

  it("THE SAME PROPERTY ON `executor_ref`, where losing a leaf strands the target for good", () => {
    // `markWaveTargetTriggered` bounds `trigger()`'s whole `ExternalRunRef`, and reconcile polls
    // with it verbatim — `client.status(target.executorRef)`. Every executor plugin reads
    // `ref.externalId` out of it. A chatty plugin that puts a big field FIRST used to take that
    // leaf with it, and a target whose ref can no longer be interpreted is polled as an unknown run
    // forever, on every tick, with nothing in the row to say why.
    const ref = {
      logs: Array.from({ length: 500 }, (_, i) => `worker ${i} said something at length. `),
      externalId: "run-42",
      url: "https://argo.internal/applications/acme/api"
    };
    const out = boundPersistedJson(ref) as Record<string, unknown>;
    expect(out.externalId).toBe("run-42");
    expect(out.url).toBe("https://argo.internal/applications/acme/api");
    expect(out[PERSISTED_JSON_ELIDED_KEY]).toBeUndefined();
  });

  /**
   * THE ARM THAT SHOULD HAVE CAUGHT PASS 8's DEFECT AND DID NOT, now expressed in the field order
   * production actually produces — AT EVERY ORDER, so it cannot go blind that way again.
   *
   * It used to build `{revision, rollout, images}` with `images` LAST. That is the ONE permutation
   * where the old per-field share short-circuited (`if (unwalkedSiblings <= 1) return walk(...)` —
   * the last field was handed the whole remainder) and no share was ever applied, so the arm
   * measured the one layout that could not fail. Against its own 0.8 threshold, on pass 8's code:
   *
   *   alone (images only)                        : 79
   *   this arm's old order {revision,rollout,images}: 78   ratio 0.987  PASSED
   *   PRODUCTION order {revision,images,rollout}    : 39   ratio 0.494  FAILS
   */
  it("a field that is SMALL costs a large sibling nothing — AT EVERY ORDER, production's included", () => {
    const alone = boundPersistedJson({ images: imageRefs(400) }) as Reading;
    const source: Record<string, unknown> = {
      revision: "v1",
      rollout: ROLLOUT,
      images: imageRefs(400)
    };
    for (const order of ORDERS) {
      const withSiblings = boundPersistedJson(inOrder(order, source)) as Reading;
      expect(
        withSiblings.images!.length,
        `order ${order.join(",")}: two tiny siblings cost the array its budget`
      ).toBeGreaterThan(alone.images!.length * 0.8);
    }
  });

  it("MORE FIELDS THAN THE BUDGET CAN SEAT still elides — and that is a different fact", () => {
    // The honest limit of the property. Fair sharing does not create budget: 8 000 characters will
    // not hold 5 000 fields however it is divided. What it guarantees is that a key is never lost
    // BECAUSE A SIBLING WAS LARGE — and when one is lost for the other reason, `__scpElided` says so
    // in the row rather than leaving a reader to infer it from a suspiciously short value.
    const many = Object.fromEntries(
      Array.from({ length: 5_000 }, (_, i) => [`k${i}`, "v".repeat(50)])
    );
    const out = boundPersistedJson(many) as Record<string, unknown>;
    expect(typeof out[PERSISTED_JSON_ELIDED_KEY]).toBe("string");
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(PERSISTED_JSON_MAX_CHARS);
  });
});

/**
 * MEDIUM (M23.0 verification pass 10) — THE PER-STRING BOUND HALVED ON A TWO-CHARACTER OVERSHOOT,
 * AND EVERY ARM THAT COULD HAVE SEEN IT WAS SHAPED LIKE AN ARRAY.
 *
 * `boundText` bounds a CHARACTER count; the budget is measured in RENDERED characters, and the
 * difference for an unescaped string is exactly the two quotes `JSON.stringify` adds. The old loop
 * recovered those two characters by HALVING the width, so every plain-ASCII string — every image
 * ref, digest, revision, URL and branch name a real executor reports — stored half of what it was
 * given:
 *
 *   share    stored   rendered   utilisation
 *     400      200       202       50.5 %
 *    2634     1317      1319       50.1 %   <- one field's share of the 8 000 budget
 *    3900     1950      1952       50.1 %
 *
 * WHY NO EXISTING ARM SAW IT, AND WHY THAT IS STRUCTURAL. Every fixture in this file whose field is
 * large enough to be cut is an ARRAY (`images`), and an array is cut by dropping ENTRIES — the
 * halving never runs on the array itself, only on entries that individually fit. The integration
 * harness could not reach it either: the fake executor's only free-form `observed` field was
 * `imagesByTarget`, an array. So the one shape the defect lives in was unreachable end to end BY
 * CONSTRUCTION, in the unit tests and in the integration tests alike. The arms below are the
 * string-shaped half of every property this file already states about arrays.
 *
 * MUTATION LOG — applied, watched fail, reverted, watched pass.
 *
 * | Mutation | Result |
 * |---|---|
 * | The pass-9 HALVING restored in `boundStringToCost` (`width = Math.floor(width / 2)`) | 5 of the 6 arms below fail: `budget - 96` at its first budget (`{budget: 400, row: 160}`), every escape density at 0.40, string-shaped utilisation at 0.497, key seating, and the elision residue at 0.43 |
 * | The pass-9 IN-LOOP KEY CHARGING restored in `walkObjectFields` (each field walked against `floor(budget.left / unwalkedSiblings)` as the loop decrements `budget.left`, the last field handed the remainder) | 3 arms fail: order-independence with 3 distinct payloads, key seating (200 keys all seated at a one-character sliver), and the elision residue (`expected 792 to be 0` — 792 fields whose stored value is the empty string) |
 *
 * The two mutations redden DIFFERENT arms, with the seating arms overlapping: order-independence is
 * blind to the halving and the utilisation arms are blind to the allocation. Two defects, two
 * levers.
 */
describe("MEDIUM: a string field spends its share, not half of it", () => {
  /** Longer than any share this file can hand out, so it ALWAYS overflows and the arms are never
   *  measuring a string that simply fitted. */
  const OVERFLOWING = "r".repeat(50_000);

  /**
   * `boundPersistedJson` reserves PERSISTED_JSON_MIN_LEAF = 96 characters of the budget up front,
   * and that reserve is the whole of the `O(small)`. Written as the literal 96 rather than imported,
   * for the reason the magnitude arms in this repository exist: an assertion against the constant
   * that defines the bound cannot notice the constant moving.
   */
  const MIN_LEAF_RESERVE = 96;

  it("A SINGLE STRING FIELD STORES `budget - 96` AT EVERY BUDGET 400…3 900, never `budget / 2`", () => {
    // Every integer budget in the window, not a sample: the defect is arithmetic, and a sample is
    // how a fixture ends up sitting on the one budget where the arithmetic happens to be right.
    const offBy: { budget: number; row: number }[] = [];
    for (let budget = 400; budget <= 3_900; budget++) {
      const row = JSON.stringify(boundPersistedJson({ revision: OVERFLOWING }, budget))!.length;
      if (row !== budget - MIN_LEAF_RESERVE) offBy.push({ budget, row });
      // The guarantee itself, restated at every budget — the arm must not buy utilisation by
      // going over.
      expect(row, `budget ${budget}: over the budget`).toBeLessThanOrEqual(budget);
    }
    expect(offBy.slice(0, 5), "a string field did not spend its whole share").toEqual([]);
    // NON-VACUITY: the window stops at 3 900 because RUNNER_DETAIL_MAX_CHARS caps any single string
    // at 4 000 characters, so above ~4 100 the row is decided by that cap and not by the share.
    // Asserted, so a future cap change turns this comment into a failure rather than a lie.
    expect(
      JSON.stringify(boundPersistedJson({ revision: OVERFLOWING }, 8_000))!.length
    ).toBeLessThan(8_000 - MIN_LEAF_RESERVE);
  });

  it("EVERY ESCAPE DENSITY, not just the plain ASCII the defect was found on", () => {
    // The old comment claimed the halving existed to make ESCAPES fit — "the worst escape expansion
    // is 6x". It was not serving that case either: a power of two is not where the boundary sits
    // for any particular density. Measured at share 3 900, C0 controls: 487 characters rendering to
    // 2 779 (71 %) under halving, 673 rendering to 3 895 (99.9 %) under the search.
    const alphabets: [string, string][] = [
      ["plain ASCII", "r"],
      ["backslashes (2x)", "\\"],
      ["quotes (2x)", '"'],
      // An escape, not a literal, for the reason NUL is one above. It renders as six characters.
      ["C0 controls (6x)", "\u0001"],
      ["astral (surrogate pairs)", "\u{1F600}"]
    ];
    for (const [name, unit] of alphabets) {
      const text = unit.repeat(20_000);
      for (let budget = 400; budget <= 3_900; budget += 17) {
        const rendered = JSON.stringify(boundPersistedJson({ revision: text }, budget))!;
        expect(rendered.length, `${name} at budget ${budget}: over the budget`).toBeLessThanOrEqual(
          budget
        );
        // Halving reaches 0.39 on the C0 arm and ~0.505 on the rest; the search never drops below
        // 0.749. A single threshold at 0.70 therefore reddens on the defect for EVERY density
        // without pinning a byte count a marker's wording could move.
        expect(
          rendered.length / budget,
          `${name} at budget ${budget}: half the share was discarded`
        ).toBeGreaterThan(0.7);
        expect(isWellFormed(rendered), `${name} at budget ${budget}`).toBe(true);
      }
    }
  });

  /**
   * THE STRING-SHAPED HALF OF "BUDGET UTILISATION", which the array fixture cannot express.
   *
   * `{revision, images, rollout}` with a big `images` is the only overflowing composition this file
   * had, and an array overflows by dropping whole entries — a path the per-string bound never
   * touches. Two truncated STRINGS beside two small fields is the same property in the shape the
   * defect lives in. Measured: 7 904 of 8 000 (98.8 %); under the halving, 3 976 (49.7 %).
   *
   * WHY THE STRINGS ARE 50 000 CHARACTERS AND NOT 4 000, which took a mutation run to discover.
   * At 4 000 the halving DOES NOT FIRE at this budget, and the arm would have been green under the
   * defect. The elision marker is sized against the widest count it could ever carry
   * (`text.length`), so when the ACTUAL dropped count has fewer digits the result comes back a
   * character or two under the requested width — and at a share of 3 931, dropping 97 of 4 000
   * leaves exactly the two characters the quotes need. At 50 000 the dropped count has the same
   * five digits as the length, there is no slack, and the first attempt misses by two. A
   * utilisation arm that cannot see the defect is the "green for the wrong reason" mode this
   * repository keeps shipping, so the fixture is chosen against the MEASURED mutation, not by
   * eye.
   */
  it("BUDGET UTILISATION, STRING-SHAPED — the composition the array fixture cannot express", () => {
    const out = boundPersistedJson({
      a: "a".repeat(50_000),
      b: "b".repeat(50_000),
      phase: "Progressing",
      step: 3
    });
    const row = JSON.stringify(out)!.length;
    expect(row / PERSISTED_JSON_MAX_CHARS).toBeGreaterThan(0.9);
    expect(row).toBeLessThanOrEqual(PERSISTED_JSON_MAX_CHARS);
    // NON-VACUITY: both strings really were cut, so the budget really was the constraint.
    const bounded = out as { a: string; b: string };
    expect(bounded.a.length).toBeLessThan(50_000);
    expect(bounded.b.length).toBeLessThan(50_000);
    // And the two small siblings were not sacrificed to pay for it.
    expect((out as { phase: string; step: number }).phase).toBe("Progressing");
    expect((out as { phase: string; step: number }).step).toBe(3);
  });

  /**
   * HIGH (M23.0 verification pass 10) — PROPERTY (2), ON STRING CONTENTS, WHERE PASSES 8 AND 9 BOTH
   * STILL FAILED IT.
   *
   * The allocator's doc rejects "reorder the composition" as an alternative BECAUSE it makes
   * source-line order a load-bearing contract. Pass 8 failed that test on array contents and pass 9
   * fixed it there; pass 9 then failed it on STRING contents, because it computed each field's share
   * from the budget REMAINING mid-loop and handed the LAST field the entire remainder. All 24
   * permutations of the fixture above, on pass 9 plus this round's width search:
   *
   *   a 3 858 / b 4 000    4 orders     row 7 904
   *   a 3 929 / b 3 929   16 orders     row 7 904   <- the fair answer
   *   a 4 000 / b 3 858    4 orders     row 7 904
   *
   * THE ROW IS THE SAME SIZE IN ALL THREE. No length assertion, and no utilisation assertion,
   * can see this — which is why it is asserted on the PAYLOAD, byte for byte.
   *
   * AND WHY THIS FIXTURE IS 4 000 CHARACTERS WHERE THE UTILISATION ARM ABOVE IS 50 000. The spread
   * exists because one of the two strings can be SATISFIED — handed the whole remainder as the last
   * field, it fits entirely and keeps its spend out of the redistribution pool. A string long
   * enough never to be satisfied (50 000) makes every order agree even on pass 9, so the arm would
   * have been green under the defect. Each fixture is sized against the mutation it has to see.
   *
   * DELETE-THE-WIRING: move the key charging back inside the value loop in `walkObjectFields` (so
   * phase 2's pool is read from a `budget.left` the walk is still decrementing) and this arm fails
   * with 3 distinct payloads.
   */
  it("ORDER-INDEPENDENT RETENTION, TWO TRUNCATED STRINGS: 24 orders, one byte-identical answer", () => {
    const source: Record<string, unknown> = {
      a: "a".repeat(4_000),
      b: "b".repeat(4_000),
      phase: "Progressing",
      step: 3
    };
    const orders: string[][] = [];
    const permute = (rest: string[], taken: string[]) => {
      if (rest.length === 0) return void orders.push(taken);
      for (let i = 0; i < rest.length; i++) {
        permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...taken, rest[i]!]);
      }
    };
    permute(Object.keys(source), []);
    expect(orders.length).toBe(24);

    const payloads = new Set<string>();
    for (const order of orders) {
      const value: Record<string, unknown> = {};
      for (const key of order) value[key] = source[key];
      const out = boundPersistedJson(value) as Record<string, unknown>;
      // The KEYS come back in insertion order, which is not the property — how much of each field
      // survived is. Compare a canonically ordered projection so the arm is about retention.
      payloads.add(
        JSON.stringify(Object.keys(source).map((key) => [key, out[key]] as const)) +
          `|row=${JSON.stringify(out)!.length}`
      );
    }
    expect(
      [...payloads],
      "how much of each field survived still depends on insertion order"
    ).toHaveLength(1);
    // NON-VACUITY: if the fixture stopped overflowing, all 24 would trivially agree.
    expect(JSON.stringify(source).length).toBeGreaterThan(PERSISTED_JSON_MAX_CHARS);
  });

  /**
   * PROPERTY (1), STRENGTHENED AND THEN HONESTLY QUALIFIED (M23.0 verification pass 10).
   *
   * Charging the keys before any value is walked means the seating decision reads KEY COSTS ONLY.
   * So a key is now never elided because a sibling's VALUE was large, at any budget — the first arm.
   * What it does still depend on is how long the KEYS are, because the seated set is a prefix in
   * insertion order: the second arm pins that residue rather than leaving it to be discovered.
   */
  it("KEY LENGTH, NOT VALUE SIZE, decides which keys are seated", () => {
    const keys = Array.from({ length: 200 }, (_, i) => `key-number-${i}`);
    const seatedKeys = (values: string) =>
      Object.keys(boundPersistedJson(Object.fromEntries(keys.map((k) => [k, values]))) as object);
    const withTinyValues = seatedKeys("v");
    const withHugeValues = seatedKeys("v".repeat(9_000));
    // NON-VACUITY: 200 keys cannot be seated at 96 characters each, so this IS the elision regime.
    expect(withTinyValues).toContain(PERSISTED_JSON_ELIDED_KEY);
    expect(withTinyValues.length).toBeLessThan(200);
    // The property: growing every value by four orders of magnitude moves nothing.
    expect(withHugeValues, "a value's size changed which keys were seated").toEqual(withTinyValues);

    // THE RESIDUE, STATED. The seated set is a PREFIX, so an object whose keys differ wildly in
    // LENGTH does still seat different keys at different orders. Documented on the allocator as the
    // one carve-out from property (2); pinned here so "the one carve-out" stays exactly one.
    const longKey = "L".repeat(5_000);
    const longFirst = boundPersistedJson({ [longKey]: "v", s1: "v", s2: "v" }, 300) as object;
    const longLast = boundPersistedJson({ s1: "v", s2: "v", [longKey]: "v" }, 300) as object;
    expect(Object.keys(longFirst)).toEqual([PERSISTED_JSON_ELIDED_KEY]);
    expect(Object.keys(longLast)).toEqual(["s1", PERSISTED_JSON_ELIDED_KEY]);
  });

  /**
   * THE PRICE OF THE FLOOR, PINNED AS A FLOOR OF ITS OWN.
   *
   * Phase 1 seats a key only while PERSISTED_JSON_MIN_LEAF of budget remains for it AND for every
   * key already seated. A field that then wants less than 96 characters leaves the difference
   * unspent, so in the ELISION regime — and only there — utilisation drops. Pass 9's sliver rule
   * scored higher on this number and lower on every other: 5 000 fields of `"v".repeat(50)` seated
   * 792 fields, EVERY ONE OF THEM THE EMPTY STRING, for a row of 7 844. An empty value in a governed
   * row reads as an observation, not as a cut (charter principle 6).
   *
   * Property (3) in the allocator's doc is narrowed to say so. This arm is what stops the residue
   * growing quietly afterwards.
   */
  it("THE ELISION REGIME'S UTILISATION RESIDUE, pinned as a floor so it cannot silently grow", () => {
    const longKeys = Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [`${"k".repeat(5_000)}${i}`, "v"])
    );
    const longRow = JSON.stringify(boundPersistedJson(longKeys))!.length;
    // Measured 4 554 of 8 000 = 56.9 %. The floor is set just under it: this arm fails if a future
    // edit makes the elision regime WORSE, and its magnitude is stated here rather than argued.
    expect(longRow / PERSISTED_JSON_MAX_CHARS).toBeGreaterThan(0.55);
    expect(longRow).toBeLessThanOrEqual(PERSISTED_JSON_MAX_CHARS);

    // AND WHAT THE RESIDUE BUYS: every seated field carries its whole value, rather than 792 keys
    // whose value is the empty string. This is the half pass 9 scored worse on.
    const manyKeys = Object.fromEntries(
      Array.from({ length: 5_000 }, (_, i) => [`k${i}`, "v".repeat(50)])
    );
    const out = boundPersistedJson(manyKeys) as Record<string, unknown>;
    const fields = Object.keys(out).filter((key) => key !== PERSISTED_JSON_ELIDED_KEY);
    expect(fields.length).toBeGreaterThan(50);
    expect(
      fields.filter((key) => out[key] === "").length,
      "a seated field stored the empty string, which reads as an observation rather than a cut"
    ).toBe(0);
    expect(fields.every((key) => out[key] === "v".repeat(50))).toBe(true);
    expect(typeof out[PERSISTED_JSON_ELIDED_KEY]).toBe("string");
  });
});

/**
 * A CUT LIST AND A COMPLETE ONE MUST BE TELLABLE APART. `internal-release-version.ts` scans
 * `observed_state.images` for the ref whose repository is a dependency line's coordinate; after a
 * cut, a miss is not evidence of absence, and reporting it as `no_matching_image_ref` blames the
 * executor for what this file did (charter principle 6).
 */
describe("MEDIUM: the array elision marker is recognisable by the readers that scan the array", () => {
  it("what the walk emits is what the recogniser matches — one fact, pinned from both ends", () => {
    const out = boundPersistedJson({
      images: Array.from({ length: 400 }, (_, i) => `ghcr.io/acme/api-${i}:1.2.3`)
    }) as { images: string[] };
    const last = out.images[out.images.length - 1]!;
    // If the marker's wording is edited without the recogniser, THIS is what goes red — rather than
    // a reader silently deciding a truncated list was complete.
    expect(isPersistedJsonEntriesElision(last)).toBe(true);
    expect(out.images.slice(0, -1).some(isPersistedJsonEntriesElision)).toBe(false);
  });

  it("a real image ref is never mistaken for a cut", () => {
    for (const ref of [
      "ghcr.io/acme/api:1.2.3",
      `ghcr.io/acme/api@sha256:${"a".repeat(64)}`,
      "registry.internal:5000/acme/api:1.2.3",
      "[elided: nesting deeper than the persisted-JSON depth limit]",
      "",
      "[elided: many more entries]"
    ]) {
      expect(isPersistedJsonEntriesElision(ref), ref).toBe(false);
    }
  });
});
