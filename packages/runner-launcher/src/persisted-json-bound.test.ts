import { describe, expect, it } from "vitest";
import {
  PERSISTED_JSON_ELIDED_KEY,
  PERSISTED_JSON_MAX_CHARS,
  PERSISTED_JSON_MAX_DEPTH,
  boundPersistedJson as boundPersistedJsonWithReport,
  isPersistedJsonEntriesElision
} from "./index.js";

/**
 * THE VALUE ALONE. `boundPersistedJson` returns `{ value, truncation }` since M23.1g — deliberately
 * inseparable, so no caller can obtain the bounded value without being handed the report — and
 * every arm below this line is about the VALUE. The report has its own file,
 * `persisted-json-truncation.test.ts`, because it is a different property: these arms measure what
 * survives, those measure whether we say what did not.
 */
const boundPersistedJson = (value: unknown, maxChars?: number): unknown =>
  maxChars === undefined
    ? boundPersistedJsonWithReport(value).value
    : boundPersistedJsonWithReport(value, maxChars).value;

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
  { name: "undefined", value: undefined },
  // M23.0 verification pass 11. Every array above holds STRINGS or INTEGERS, and both of those are
  // charged exactly, so no arm of this corpus could reach the three leaf branches that return
  // something rendering as `null`. Two of the three charged nothing for it.
  { name: "a list of 2 000 nulls", value: { images: Array(2_000).fill(null) } },
  { name: "a list of 2 000 undefineds", value: { images: Array(2_000).fill(undefined) } },
  {
    name: "a list of 2 000 functions",
    value: { images: Array.from({ length: 2_000 }, () => () => 1) }
  },
  // …and every array above is cut at most ONCE per value, so no arm could reach the case where
  // several tail markers are charged against a budget that has nothing left for them.
  {
    name: "four lists the budget cannot finish",
    value: {
      a: ["x".repeat(9_000), "x".repeat(9_000)],
      b: ["x".repeat(9_000), "x".repeat(9_000)],
      c: ["x".repeat(9_000), "x".repeat(9_000)],
      d: ["x".repeat(9_000), "x".repeat(9_000)]
    }
  }
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
   * PROPERTY (1), AS PASS 10 STATED IT AND AS PASS 12 MEASURED IT.
   *
   * Pass 10 charged the keys before any value is walked, so the seating decision read KEY COSTS
   * ONLY, and it pinned exactly that here: "a value's size changed which keys were seated" was the
   * failure message. The property was true. What it did not ask is what a KEY COSTS TO SEAT — a
   * flat {@link PERSISTED_JSON_MIN_LEAF}, whatever was behind it — and that is what the first arm
   * measures now: 200 keys whose every value is `"v"` hold 4 091 characters and were seated 71 at
   * a budget of 8 000, the other 129 replaced by a marker. The seat is now priced at what the
   * field needs, so all 200 seat and the value comes back byte-identical.
   *
   * WHAT THAT COSTS IN STRICTNESS, STATED RATHER THAN GLOSSED. The rule now reads values, so pass
   * 10's absolute form is gone: a sibling large enough to need the whole floor CAN be the reason a
   * later key is elided. It can only ever go one way — `admissionCost <= PERSISTED_JSON_MIN_LEAF`
   * by construction — so the seated set is a SUPERSET of the flat rule's, which is the third arm.
   */
  it("WHAT A FIELD NEEDS, NOT A FLAT 96, decides which keys are seated", () => {
    const keys = Array.from({ length: 200 }, (_, i) => `key-number-${i}`);
    const tinyValued = Object.fromEntries(keys.map((k) => [k, "v"]));
    const seatedKeys = (values: string) =>
      Object.keys(boundPersistedJson(Object.fromEntries(keys.map((k) => [k, values]))) as object);
    const withTinyValues = seatedKeys("v");
    const withHugeValues = seatedKeys("v".repeat(9_000));

    // THE DEFECT: 200 keys of one character each are 4 091 rendered characters against a budget of
    // 8 000, and 129 of them used to be a marker because each seat cost 96 whatever it held.
    expect(JSON.stringify(tinyValued)!.length, "the fixture stopped being small").toBe(4_091);
    expect(withTinyValues, "a field of one character was charged 96 to sit down").not.toContain(
      PERSISTED_JSON_ELIDED_KEY
    );
    expect(withTinyValues.length).toBe(200);
    expect(JSON.stringify(boundPersistedJson(tinyValued))).toBe(JSON.stringify(tinyValued));

    // NON-VACUITY, AND THE UNCHANGED HALF: values too big to price still reserve the whole floor,
    // so 200 of THEM is still the elision regime and still seats roughly the flat rule's 71.
    expect(withHugeValues).toContain(PERSISTED_JSON_ELIDED_KEY);
    // 69 fields plus the marker. It was 70 + the marker until pass 14 made the object BUY its
    // elision entry before phase 1 seats anything (see `fieldsElisionCost`): those 30 characters
    // used to be spent out of the row's backstop cushion, and one seat is exactly what they buy.
    // The measurement that says the trade is worth making is in that comment — 15 982 whole-value
    // discards over a 145 048-pair budget sweep, gone above a budget of 31.
    expect(withHugeValues.length).toBe(70);

    // ONE-WAY: every key the large-valued object seated is seated by the small-valued one too.
    // `admissionCost` is capped at PERSISTED_JSON_MIN_LEAF, so pricing a seat can only add keys.
    const huge = new Set(withHugeValues);
    huge.delete(PERSISTED_JSON_ELIDED_KEY);
    expect([...huge].every((key) => withTinyValues.includes(key))).toBe(true);

    // THE RESIDUE, STATED. The seated set is a PREFIX, so an object whose fields differ wildly in
    // what they need does still seat different keys at different orders. Documented on the
    // allocator as the one carve-out from property (2); pinned here so it stays exactly one.
    const longKey = "L".repeat(5_000);
    const longFirst = boundPersistedJson({ [longKey]: "v", s1: "v", s2: "v" }, 200) as object;
    const longLast = boundPersistedJson({ s1: "v", s2: "v", [longKey]: "v" }, 200) as object;
    expect(Object.keys(longFirst)).toEqual([PERSISTED_JSON_ELIDED_KEY]);
    expect(Object.keys(longLast)).toEqual(["s1", "s2", PERSISTED_JSON_ELIDED_KEY]);
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
    // Measured 6 651 of 8 000 = 83.1 %, up from pass 10's 4 554 (56.9 %) — the difference is the
    // flat 96 a one-character value used to reserve, which pass 12 prices at what it needs. The
    // floor is set just under the CURRENT figure: this arm fails if a future edit makes the elision
    // regime worse, and its magnitude is stated here rather than argued.
    expect(longRow / PERSISTED_JSON_MAX_CHARS).toBeGreaterThan(0.82);
    expect(longRow).toBeLessThanOrEqual(PERSISTED_JSON_MAX_CHARS);

    // AND WHAT THE RESIDUE BUYS: every seated field carries its whole value, rather than 792 keys
    // whose value is the empty string. This is the half pass 9 scored worse on.
    const manyKeys = Object.fromEntries(
      Array.from({ length: 5_000 }, (_, i) => [`k${i}`, "v".repeat(50)])
    );
    const out = boundPersistedJson(manyKeys) as Record<string, unknown>;
    const fields = Object.keys(out).filter((key) => key !== PERSISTED_JSON_ELIDED_KEY);
    expect(fields.length).toBeGreaterThan(50); // 76 at pass 10, 133 once the seat is priced
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

/**
 * ================================================================================================
 * MEDIUM (M23.0 verification pass 11) — WHAT THE WALK CHARGES MUST BE WHAT IT RENDERS, AND IN TWO
 * PLACES IT WAS NOT. BOTH ENDED IN THE SAME LOSS: THE WHOLE ROW.
 * ================================================================================================
 * `boundPersistedJson` measures its own output and, when the walk's accounting turns out to be
 * wrong, replaces the payload with a diagnostic sentence. Every round so far has read that as a
 * safety net and asserted only that the ROW stays inside the budget. It does. What it costs when it
 * fires had never been asked: `revision`, `images` and `rollout.weight` all disappear TOGETHER,
 * silently, on a write that runs every tick — strictly worse than the truncation
 * {@link isPersistedJsonEntriesElision} exists to make legible, and the exact fail-silent shape
 * this whole file was written to prevent.
 *
 * Measured over 12 000 random mixed shapes at budgets 100…8 000, the backstop fired for pass 7 on
 * 697, for pass 9 on 30 and for pass 10 on 238 — the redistribution rounds pass 10 added made the
 * total-loss case EIGHT TIMES more likely than the round before it, which no assertion in this file
 * could see because each one only ever asked whether the row fitted.
 *
 * THE TWO CAUSES, BOTH "a leaf/marker rendered characters nobody charged for":
 *
 *   1. `null`, `undefined` and a function/symbol all render as the four characters `null`. The
 *      non-finite-number branch charged for that; the other two charged NOTHING. A `null` in a list
 *      therefore cost 1 (its comma) and rendered 5, and since an array element is admitted while
 *      the budget is merely non-trivial, free elements DEFEAT the array guard outright: 1 599 of
 *      them overflow the 8 000 budget with nothing else in the value.
 *
 *   2. An array's tail marker was charged after the elements had already spent everything. The
 *      element admitted at exactly `PERSISTED_JSON_MIN_LEAF` may take all of it — a string is
 *      bounded to whatever is left, by construction — so EVERY CUT ARRAY overspent by exactly the
 *      marker, and four of them anywhere in one value put the row past the single reserve
 *      `boundPersistedJson` holds back. `PERSISTED_JSON_MIN_LEAF`'s own comment claims the opposite
 *      in as many words ("so the elision itself can never be what pushes the row over") — a
 *      well-written comment naming a hazard is a signal to sweep, not evidence it was handled.
 *
 * WHY THE CORPUS ABOVE COULD NOT SEE EITHER. Every array in it holds strings or integers, both
 * charged exactly, and every value in it is cut at most once. A fixture cannot witness a defect in
 * a branch it never reaches — the same mechanical blindness that hid the string-shaped defects for
 * three rounds, one shape further along.
 */
describe("MEDIUM: what the walk charges is what it renders — every leaf, and every marker", () => {
  /** Did the measured backstop replace the payload? That is the loss, not the row length. */
  function wasDiscarded(bounded: unknown): boolean {
    return (
      bounded !== null &&
      typeof bounded === "object" &&
      typeof (bounded as Record<string, unknown>)[PERSISTED_JSON_ELIDED_KEY] === "string" &&
      String((bounded as Record<string, unknown>)[PERSISTED_JSON_ELIDED_KEY]).startsWith(
        "a plugin-supplied value rendered"
      )
    );
  }
  const discarded = (value: unknown, budget?: number): boolean =>
    wasDiscarded(
      budget === undefined ? boundPersistedJson(value) : boundPersistedJson(value, budget)
    );

  it("A LIST OF NULLS IS STORED, NOT DISCARDED — and the leaves beside it survive with it", () => {
    // Shaped like a real reading, because the point is what a gate can still read afterwards.
    const reading = {
      revision: "9f2c1ab4e77d0c31a5b8e6f2c9d4a1b3e5f70982",
      images: Array.from(
        { length: 20 },
        (_, i) => `ghcr.io/acme/p/s-${i}@sha256:${"a".repeat(64)}`
      ),
      rollout: { phase: "Progressing", step: 3, weight: 60, message: "canary at 60%" },
      probes: Array(1_700).fill(null)
    };
    expect(discarded(reading), "the backstop discarded the whole reading").toBe(false);
    const out = boundPersistedJson(reading) as typeof reading;
    expect(out.revision).toBe(reading.revision);
    expect(out.rollout.weight, "ADR-0028's gate leaf went with the row").toBe(60);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(PERSISTED_JSON_MAX_CHARS);
  });

  it("THE MEASURED THRESHOLD: 1 598 nulls fitted and 1 599 took the whole value with them", () => {
    // Pinned as the exact number rather than "a lot", because it is what makes the magnitude
    // checkable: five characters each, against an 8 000-character column.
    expect(discarded({ a: Array(1_598).fill(null) }), "1 598 nulls").toBe(false);
    expect(discarded({ a: Array(1_599).fill(null) }), "1 599 nulls").toBe(false);
    expect(discarded({ a: Array(100_000).fill(null) }), "100 000 nulls").toBe(false);
    // …and the list is CUT rather than kept whole, so the guard is doing its job on them now.
    const out = boundPersistedJson({ a: Array(100_000).fill(null) }) as { a: unknown[] };
    expect(isPersistedJsonEntriesElision(String(out.a[out.a.length - 1]))).toBe(true);
  });

  it("ALL THREE BRANCHES THAT RENDER AS `null`, not just the one that was already charged", () => {
    // The census, by property rather than by symptom: every leaf `walk` can return that
    // `JSON.stringify` writes as `null`. A fix to one of these that missed the others would pass
    // the arm above and fail here.
    const branches: Record<string, unknown> = {
      null: null,
      undefined: undefined,
      function: () => 1,
      "non-finite number": Number.NaN
    };
    for (const [name, leaf] of Object.entries(branches)) {
      expect(discarded({ a: Array(3_000).fill(leaf) }), `a list of 3 000 x ${name}`).toBe(false);
    }
  });

  it("A CUT LIST PAYS FOR ITS OWN TAIL MARKER — four cuts in one value used to cost the value", () => {
    // Four fields whose values are each a list the budget cannot finish. Under the defect the walk
    // rendered 8 009 of an 8 000 budget — nine characters, four markers, and the whole reading.
    const huge = "x".repeat(9_000);
    const value = { a: [huge, huge], b: [huge, huge], c: [huge, huge], d: [huge, huge] };
    expect(discarded(value)).toBe(false);
    const out = boundPersistedJson(value) as Record<string, string[]>;
    for (const key of ["a", "b", "c", "d"]) {
      expect(out[key], `${key} was dropped entirely`).toBeDefined();
      expect(
        isPersistedJsonEntriesElision(out[key]![out[key]!.length - 1]!),
        `${key} was cut without saying so`
      ).toBe(true);
    }
  });

  it("A COMPLETE LIST IS CHARGED NOTHING FOR A MARKER IT NEVER NEEDS", () => {
    // The counter-arm: a reserve that were kept rather than released would show up here as a
    // reading that no longer comes back byte-identical, and as retention lost on every array in
    // the product.
    const reading = {
      revision: "9f2c1ab4e77d0c31a5b8e6f2c9d4a1b3e5f70982",
      images: ["ghcr.io/org/app:1.2.3", `ghcr.io/org/sidecar@sha256:${"a".repeat(64)}`],
      rollout: { phase: "Progressing", step: 2, weight: 25, message: "canary at 25%" }
    };
    expect(JSON.stringify(boundPersistedJson(reading))).toBe(JSON.stringify(reading));
    // …and the 400-ref reading keeps exactly what it kept before the reserve existed.
    const out = boundPersistedJson({
      revision: "9f2c1ab4e77d0c31a5b8e6f2c9d4a1b3e5f70982",
      images: Array.from(
        { length: 400 },
        (_, i) => `ghcr.io/acme/platform/service-${i}@sha256:${"a".repeat(64)}`
      ),
      rollout: { phase: "Progressing", step: 3, weight: 60, message: "canary at 60%" }
    }) as { images: string[] };
    expect(out.images[out.images.length - 1]).toBe("[elided: 328 more entries]");
  });

  it("THE RESERVE IS HANDED BACK, not quietly kept — a sibling gets to spend it", () => {
    // The arm above cannot see this: it has slack, so a reserve that were never released would
    // cost it nothing visible. Here the budget is spent to the last character, which is the only
    // regime in which "released" and "held" differ. A COMPLETE list beside a string that wants
    // everything: the row must still be exactly `budget - PERSISTED_JSON_MIN_LEAF`.
    for (const budget of [4_000, 1_000]) {
      const value = { list: ["ref-0", "ref-1", "ref-2"], text: "x".repeat(20_000) };
      const row = JSON.stringify(boundPersistedJson(value, budget))!.length;
      expect(row, `budget ${budget}: the completed list kept its tail reserve`).toBe(budget - 96);
    }
  });

  /**
   * THE SWEEP THAT WOULD HAVE CAUGHT BOTH, AND WHICH THE HAND-PICKED CORPUS ABOVE CANNOT BE.
   * Deterministic (a fixed seed, no `Math.random`), so a failure is reproducible and a green is not
   * luck. It asserts the two facts every hand-picked arm asserts — the row fits, and the backstop
   * did not fire — over shapes nobody chose.
   *
   * SIZED DELIBERATELY, AND SMALLER THAN THE FIRST DRAFT. 2 000 shapes with 6 000-character strings
   * ran for 5.5 SECONDS, which is not free in a suite whose slowest FILE (`whole-run-budget.ts`,
   * 9.9s) measures real subprocess deadlines in a sibling worker — a CPU-bound arm is a
   * wall-clock hazard to a timing arm running beside it, which is a bad trade for a property test.
   * 800 shapes with 2 500-character strings runs in ~0.7s and still reddens on both pass-11
   * defects: removing the tail reserve fails it at `case 9 at budget 6000`, removing the `null`
   * charge fails four other arms in this file. Raise the count when hunting, not in the committed
   * suite; 30 000-case sweeps over five seeds were run out of tree for this round and found nothing
   * this one does not.
   */
  it(
    "800 GENERATED SHAPES: the row fits AND the payload is never discarded",
    { timeout: 60_000 },
    () => {
      let seed = 0x51ab77;
      const rnd = () => {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        seed >>>= 0;
        return seed / 0x1_0000_0000;
      };
      const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
      const C0 = String.fromCharCode(1, 2, 7, 9, 10, 13, 27, 31);
      const ALPHABETS = [
        "abcdefghijklmnopqrstuvwxyz0123456789./:@-_",
        "\\",
        '"',
        C0,
        "\u{1F600}\u{1F4A9}\u{10000}",
        `a\\b"cd${C0}\u{1F600}`,
        " \t\n",
        "\uD800",
        `${PERSISTED_JSON_ELIDED_KEY}[elided: 5 more entries]`
      ];
      const str = (maxLen: number) => {
        const a = pick(ALPHABETS);
        const n = int(0, maxLen);
        let out = "";
        while (out.length < n) out += a;
        return out.slice(0, n);
      };
      const leaf = (depth: number): unknown => {
        const r = rnd();
        if (r < 0.45) return str(rnd() < 0.5 ? int(0, 200) : int(0, 2_500));
        if (r < 0.53) return int(-1e9, 1e9);
        if (r < 0.57) return rnd() < 0.5;
        if (r < 0.63) return null;
        if (r < 0.67) return undefined;
        if (r < 0.7) return Number.NaN;
        if (r < 0.85 && depth < 5) return Array.from({ length: int(0, 40) }, () => leaf(depth + 1));
        if (depth < 5) {
          const o: Record<string, unknown> = {};
          for (let i = 0; i < int(0, 8); i++) o[str(int(1, 12)) || `k${i}`] = leaf(depth + 1);
          return o;
        }
        return str(int(0, 200));
      };
      const budgets = [8_000, 6_000, 4_000, 2_000, 1_000, 500, 200, 100, 64, 16, 4];

      let nonTrivial = 0;
      for (let c = 0; c < 800; c++) {
        const value: Record<string, unknown> = {};
        for (let i = 0; i < int(1, 6); i++) value[str(int(1, 14)) || `f${i}`] = leaf(0);
        const budget = pick(budgets);
        const bounded = boundPersistedJson(value, budget);
        const rendered = JSON.stringify(bounded);
        const label = `case ${c} at budget ${budget}`;
        expect(rendered === undefined || rendered.length <= budget, `${label}: over budget`).toBe(
          true
        );
        expect(wasDiscarded(bounded), `${label}: the backstop discarded the payload`).toBe(false);
        if (rendered !== undefined && rendered.length > 100) nonTrivial++;
      }
      // NON-VACUITY: the generator really does produce values with something in them, so a green
      // here is not 800 empty objects. (Measured: well over half.)
      expect(nonTrivial, "the generated corpus is trivial").toBeGreaterThan(300);
    }
  );
});
/**
 * HIGH (M23.0 verification pass 12) — WHAT A REFUSAL HOLDS BACK MUST BE WHAT THE CONTENT COSTS.
 *
 * Two places decided whether to keep the next thing, and both reserved a flat
 * `PERSISTED_JSON_MIN_LEAF` (96) for it without asking what it was worth: `walkObjectFields` phase
 * 1 seating a key, and the array loop admitting an element. A third — pass 11's tail reserve — took
 * the marker's price out of every list, including the ones that demonstrably never need a marker.
 *
 * NONE OF IT IS VISIBLE IN THE ROW'S LENGTH, which is why eleven passes did not find it: the row
 * comes out THOUSANDS OF CHARACTERS SHORT of the budget while content is being thrown away, and in
 * the worst cases LARGER than the value it damaged, because `__scpElided: "1 more fields"` is 30
 * characters and `"version":"v1.4.2"` is 18. Measured before the fix, at the production budget:
 *
 *   {resources: {30 x {status, health, version}}}   input 2 495 -> stored 2 825, LOSSY
 *   the same at 80 resources                        input 6 645 -> stored 3 684, LOSSY (54 % of
 *                                                   the column abandoned)
 *   {svc-i: {c-k: {ready, restarts, image}}} 8 x 4  input 1 553 -> stored 2 097, LOSSY
 *   {a: ["a"]}                                      eleven characters, cut at every budget to 133
 *
 * The unit each arm asserts in is therefore RETENTION, never length.
 */
describe("HIGH: a refusal must be priced at what the content costs, not at a flat 96", () => {
  const resources = (n: number) =>
    Object.fromEntries(
      Array.from({ length: n }, (_, i) => [
        `apps/Deployment/svc-${i}`,
        { status: "Synced", health: "Healthy", version: "v1.4.2" }
      ])
    );

  it("A READING THE BUDGET HOLDS THREE TIMES OVER IS STORED VERBATIM", () => {
    // THE REPORTED CASE. Argo CD's per-resource health map is the ordinary shape here — uniform
    // siblings, every one of them tiny — and uniform is the worst case, because when every sibling
    // clips for the same reason `walkObjectFields` breaks at round 0 and the pool is never re-offered.
    const thirty = { resources: resources(30) };
    expect(JSON.stringify(thirty)!.length, "the fixture stopped being small").toBe(2_495);
    expect(JSON.stringify(boundPersistedJson(thirty))).toBe(JSON.stringify(thirty));

    // …and at every size up to the point the budget really is the constraint. 80 resources is
    // 6 645 characters of an 8 000 budget and used to store 3 684 of them.
    for (const n of [20, 30, 40, 50, 60, 70, 80]) {
      const reading = { resources: resources(n) };
      expect(
        JSON.stringify(boundPersistedJson(reading)),
        `${n} resources came back damaged inside a budget that holds them`
      ).toBe(JSON.stringify(reading));
    }

    // THE SAME DISEASE ONE LEVEL DEEPER, because the flat reservation multiplied down the tree:
    // 96 x (keys at that level) at EVERY level, so three levels of tiny objects was hopeless.
    const containers = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [
        `svc-${i}`,
        Object.fromEntries(
          Array.from({ length: 4 }, (_, k) => [`c${k}`, { ready: true, restarts: 0, image: "v1" }])
        )
      ])
    );
    expect(JSON.stringify(containers)!.length).toBe(1_553);
    expect(JSON.stringify(boundPersistedJson(containers))).toBe(JSON.stringify(containers));

    // NON-VACUITY, AND THE DIRECTION THAT MATTERS: the bound is still a bound. A resource map the
    // budget genuinely cannot hold is still cut, and still says so.
    const overflowing = { resources: resources(200) };
    expect(JSON.stringify(overflowing)!.length).toBeGreaterThan(PERSISTED_JSON_MAX_CHARS);
    const cut = JSON.stringify(boundPersistedJson(overflowing))!;
    expect(cut.length).toBeLessThanOrEqual(PERSISTED_JSON_MAX_CHARS);
    expect(cut).toContain(PERSISTED_JSON_ELIDED_KEY);
  });

  /**
   * THE LAW'S DOMAIN, WHICH PASS 13 FOUND MISSING AND PASS 14 MEASURED.
   *
   * "L + 96 IS THE WHOLE LAW" was pinned over atoms whose largest string is 300 characters, so it
   * sampled only where the claim happens to hold. It is FALSE for a string past
   * {@link RUNNER_DETAIL_MAX_CHARS}, and false for four other reasons the atoms never reached. The
   * law is not wrong — it has a DOMAIN, and an unstated domain is a law that goes false silently
   * the first time somebody writes a fixture outside it. Measured, `{a: <atom>}`, searching every
   * budget to 60 000 for the first at which the value comes back byte-identical:
   *
   *     atom                              L      verbatim at
   *     string of 4 000                4 008    L + 96
   *     string of 4 001                4 009    NEVER          <- boundStringToCost caps at 4 000
   *     key of 126 characters            140    L + 96
   *     key of 127 characters            141    NEVER          <- the 128 is a RENDERED cost, and
   *                                                               two quotes leave room for 126
   *     seven levels of nesting           54    L + 96
   *     eight levels of nesting           60    NEVER          <- PERSISTED_JSON_MAX_DEPTH
   *     "a\u{1F600}b"                      12    L + 96
   *     a string carrying U+0000          16    NEVER          <- sanitised to U+FFFD
   *     a lone surrogate                  16    NEVER          <- sanitised to U+FFFD
   *     a function-valued field            2    NEVER          <- stored as null, omitted by
   *                                                               JSON.stringify
   *     a `__proto__` key                 27    NEVER          <- refused, see isUnsafePersistedKey
   *
   * AND THE DOMAIN IS ABOUT THE ATOMS, NOT THE TOTAL, which is the half pass 13's wording missed.
   * Two 4 000-character strings side by side are 8 021 characters and obey the law exactly; 400
   * image refs are 35 897 characters and obey it exactly. "False past 4 008 characters" is not the
   * boundary — "false past a 4 000-character STRING" is.
   */
  /**
   * WHAT THE WATER-FILLING CAP IS WORTH, AND WHY IT IS FIVE — M23.0 verification pass 14.
   *
   * `PERSISTED_JSON_SHARE_ROUNDS` was 4, and pass 13 recorded that 3 and 8 both SURVIVED the whole
   * suite: a constant nothing could distinguish in either direction. Neither survives measurement.
   * Instrumenting the loop over 182 365 (shape, budget) pairs found 5 290 that run four rounds and
   * 527 that run FIVE, so 4 was truncating real work; and against a 64-round ceiling the retention
   * cost of each cap is 1: -29.04 %, 2: -0.60 %, 3: -0.047 %, 4: -0.0028 %, 5 and above: zero.
   *
   * FIVE IS THE FIXED POINT — the smallest cap at which raising it changes no output anywhere. The
   * shape below is the witness the round-demand instrument found, and it separates every cap from
   * 1 to 5, which is what makes an exact byte count here a gate rather than a golden:
   *
   *     ladder n=10 base=4 delta=40, L = 1 921, at a budget of 1 978
   *         1 round  1 401     3 rounds  1 855     5 rounds  1 882
   *         2 rounds 1 777     4 rounds  1 881     8 and 64  1 882
   *
   * WHY THE LADDER. Rounds are demanded only when exactly ONE field becomes satisfied per round —
   * fields whose sizes are close enough together that a share satisfies one at a time. Geometric
   * sizes (the family the constant's own comment names) satisfy several at once and never reach
   * round four; this is the shape eleven passes' corpora did not contain.
   */
  /**
   * THE TWO MARKER CHARGES, PRICED TO THE CHARACTER — M23.0 verification pass 14, and the two
   * mutations pass 13 recorded as surviving all 227 tests.
   *
   * `tailMarkerCost` reserves `jsonCost(marker) + 1`; `fieldsElisionCost` reserves
   * `jsonCost(marker) + jsonCost(__scpElided) + 2`. The trailing terms are PUNCTUATION — the comma
   * that separates an array's marker from the entries before it, and the `:` and comma that attach
   * an object's elision entry — and punctuation is the kind of term a reader deletes as noise. A
   * reserve short by N is not "N characters of retention"; it is a container that spends N more
   * than it was allocated, and those overspends COMPOUND across siblings until the row's own
   * 96-character cushion is gone and the backstop discards the whole reading.
   *
   * NEITHER IS PINNED BY A BYTE COUNT HERE, because a byte count says nothing about WHY. A reserve
   * short by N shifts the budget at which the next thing becomes affordable by EXACTLY N, and that
   * is both a sharper statement and a two-sided one. Measured over every budget 4…400:
   *
   *     list(3) of list(3), first sub-list survives at   base 138    with `+ 1` deleted  137
   *     3 fields x list(2), first field seated at        base 142    with `+ 2` deleted  140
   */
  it("THE ARRAY'S TAIL MARKER COSTS ITS COMMA: one character of budget, exactly", () => {
    const value = [
      ["e", "e", "e"],
      ["e", "e", "e"],
      ["e", "e", "e"]
    ];
    const wholeSubLists = (budget: number): number => {
      const out = boundPersistedJson(value, budget);
      expect(
        JSON.stringify(out)!.length,
        `budget ${budget}: over the row bound`
      ).toBeLessThanOrEqual(budget);
      return Array.isArray(out) ? out.filter((e) => Array.isArray(e)).length : -1;
    };
    // The threshold, both sides of it. A reserve one character short admits the first sub-list at
    // 137 — spending one character more than the array was allocated, which is the defect.
    expect(wholeSubLists(137), "the tail marker's comma was not reserved").toBe(0);
    expect(wholeSubLists(138), "the reserve is one character too wide").toBe(1);
    // NON-VACUITY at both ends: below, the marker alone; above, the whole list.
    expect(JSON.stringify(boundPersistedJson(value, 137))).toBe('["[elided: 3 more entries]"]');
    expect(JSON.stringify(boundPersistedJson(value, 139))).toBe(JSON.stringify(value));
  });

  it("THE OBJECT'S ELISION ENTRY COSTS ITS COLON AND COMMA: two characters, exactly", () => {
    const value = { k0: ["a", "a"], k1: ["a", "a"], k2: ["a", "a"] };
    const seated = (budget: number): number => {
      const out = boundPersistedJson(value, budget) as Record<string, unknown> | null;
      expect(
        JSON.stringify(out)!.length,
        `budget ${budget}: over the row bound`
      ).toBeLessThanOrEqual(budget);
      return out === null || Array.isArray(out)
        ? -1
        : Object.keys(out).filter((k) => k !== PERSISTED_JSON_ELIDED_KEY).length;
    };
    // Two characters short seats a field at 140 that the object cannot pay for — and unlike the
    // array's, this overspend happens once per ELIDING OBJECT, so it multiplies by the tree.
    expect(seated(140), "the elision entry's punctuation was not reserved").toBe(0);
    expect(seated(141), "the elision entry's punctuation was not reserved").toBe(0);
    expect(seated(142), "the reserve is two characters too wide").toBe(3);
    // NON-VACUITY: below the threshold the object really is nothing but its marker, and above it
    // the value really is whole.
    expect(JSON.stringify(boundPersistedJson(value, 140))).toBe('{"__scpElided":"3 more fields"}');
    expect(JSON.stringify(boundPersistedJson(value, 142))).toBe(JSON.stringify(value));

    // AND THE CONSEQUENCE, WHICH IS NOT TWO CHARACTERS. An object's overspend happens once per
    // ELIDING OBJECT, and at depth 6 width 3 there are 1 093 of them, so two characters each is
    // 2 186 — past the row's 96-character cushion many times over. Measured with the `+ 2` deleted:
    // this 9 103-character value is DISCARDED WHOLE at 2 062 budgets, the lowest 3 907; the current
    // build discards it at none. This band is the cheap part of that measurement (300 budgets,
    // ~0.4 s) rather than the whole of it.
    const deep = (k: number): unknown =>
      k === 0
        ? "l"
        : Object.fromEntries(Array.from({ length: 3 }, (_, i) => [`f${i}`, deep(k - 1)]));
    const nested = deep(6);
    expect(JSON.stringify(nested)!.length, "the deep witness moved").toBe(9_103);
    let widest = 0;
    let narrowest = Number.POSITIVE_INFINITY;
    for (let budget = 3_800; budget <= 4_100; budget++) {
      const out = boundPersistedJson(nested, budget) as Record<string, unknown> | null;
      const rendered = JSON.stringify(out) ?? "null";
      expect(
        String(out === null ? "null" : (out[PERSISTED_JSON_ELIDED_KEY] ?? "")),
        `budget ${budget}: the whole 9 103-character reading was discarded`
      ).not.toContain("a plugin-supplied");
      expect(rendered.length, `budget ${budget}: over the row bound`).toBeLessThanOrEqual(budget);
      widest = Math.max(widest, rendered.length);
      narrowest = Math.min(narrowest, rendered.length);
    }
    // NON-VACUITY: the band has to be one where real content is being stored, or "not discarded"
    // is green on a build that stores a marker and nothing else. Measured 1 084…3 919, mean 2 410
    // — the apology the backstop stores in its place is 145.
    expect(narrowest, "the band stores nothing, so the discard arm is vacuous").toBeGreaterThan(
      500
    );
    expect(widest, "the band never approaches its budget").toBeGreaterThan(3_000);
  });

  it("FIVE ROUNDS IS THE FIXED POINT: the water-filling cap is the smallest that loses nothing", () => {
    const ladder = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`k${i}`, "v".repeat(4 + i * 40)])
    );
    expect(JSON.stringify(ladder)!.length, "the witness shape moved").toBe(1_921);
    const stored = JSON.stringify(boundPersistedJson(ladder, 1_978))!;
    // 1 882, not the 1 881 four rounds reached and not the 1 855 three reached. A LOWER cap fails
    // this; a higher one cannot, because five is where the value stops moving — recorded as an
    // asymmetry rather than papered over.
    expect(stored.length, "a lower water-filling cap is truncating real work").toBe(1_882);
    expect(stored.length, "over budget").toBeLessThanOrEqual(1_978);

    // NON-VACUITY: the shape must genuinely be in the redistribution regime. If it fitted whole, or
    // if nothing were cut, every cap would agree and the count above would pin nothing.
    expect(stored).not.toBe(JSON.stringify(ladder));
    expect(stored).not.toContain(PERSISTED_JSON_ELIDED_KEY);
    const kept = JSON.parse(stored) as Record<string, string>;
    expect(
      Object.keys(kept),
      "a key was elided, so this is not the redistribution regime"
    ).toHaveLength(10);
    // …and the fields really do end up at DIFFERENT lengths, which is what water-filling means:
    // the small ones keep everything and the large ones share what is left.
    expect(kept.k0).toBe("v".repeat(4));
    expect(kept.k9!.length).toBeLessThan(364);
    expect(new Set(Object.values(kept).map((v) => v.length)).size).toBeGreaterThan(3);
  });

  it("THE LAW'S DOMAIN: each boundary is verbatim on one side and NEVER verbatim on the other", () => {
    const nestObj = (d: number): unknown => (d === 0 ? "leaf" : { n: nestObj(d - 1) });
    const nestList = (d: number): unknown => (d === 0 ? "leaf" : [nestList(d - 1)]);
    const key = (n: number, value: unknown) => Object.fromEntries([["K".repeat(n), value]]);

    /** The smallest budget above L at which `{a: value}` comes back byte-identical, or -1 when no
     *  budget in `[L, L + extra]` does. Dense, because the whole point is that the answer is an
     *  exact budget and not a region. */
    const lawBudget = (value: unknown, extra = 300): number => {
      const want = JSON.stringify({ a: value })!;
      for (let b = want.length; b <= want.length + extra; b++)
        if (JSON.stringify(boundPersistedJson({ a: value }, b)) === want) return b - want.length;
      return -1;
    };

    // INSIDE THE DOMAIN — the law holds, and holds at sizes far past where it was ever sampled.
    const inside: [string, unknown][] = [
      ["a 4 000-character string, the widest boundStringToCost keeps", "x".repeat(4_000)],
      ["a 4 000-character string inside a list", ["x".repeat(4_000)]],
      ["a 126-character key", key(126, "v")],
      ["seven levels of objects", nestObj(7)],
      ["seven levels of lists", nestList(7)],
      ["a well-formed astral pair", "a\u{1F600}b"],
      [
        "two 4 000-character strings, 8 021 rendered",
        { p: "x".repeat(4_000), q: "y".repeat(4_000) }
      ],
      [
        "400 image refs, 35 897 rendered",
        Array.from({ length: 400 }, (_, i) => `ghcr.io/a/s-${i}@sha256:${"0".repeat(64)}`)
      ]
    ];
    for (const [name, value] of inside) {
      expect(lawBudget(value), `${name}: the law does not hold here`).toBe(96);
      const want = JSON.stringify({ a: value })!;
      expect(
        JSON.stringify(boundPersistedJson({ a: value }, want.length + 95)),
        `${name}: verbatim at L + 95, so the law is looser than it says`
      ).not.toBe(want);
    }

    // OUTSIDE IT — not "verbatim later", but verbatim at NO budget at all, which is the statement
    // that makes the domain a boundary rather than an inconvenience.
    const outside: [string, unknown][] = [
      ["a 4 001-character string", "x".repeat(4_001)],
      ["a 4 001-character string inside a list", ["x".repeat(4_001)]],
      ["a 127-character key", key(127, "v")],
      ["eight levels of objects", nestObj(8)],
      ["eight levels of lists", nestList(8)],
      ["a string carrying U+0000", "a\u0000b"],
      ["a lone high surrogate", "a\uD83Db"],
      ["a function-valued field", { f: () => 1 }],
      ["a `__proto__` key", JSON.parse('{"__proto__":{"p":1}}')]
    ];
    for (const [name, value] of outside) {
      expect(lawBudget(value), `${name}: the law holds here after all`).toBe(-1);
      // AND NOT MERELY LATER. The dense scan above covers L…L+300; these are the budgets a caller
      // could plausibly reach for, including four times the column policy. Every one of these
      // boundaries is an absolute cap rather than a share, so no budget can buy past it.
      const want = JSON.stringify({ a: value })!;
      for (const budget of [
        want.length + 1_000,
        want.length + 10_000,
        PERSISTED_JSON_MAX_CHARS,
        PERSISTED_JSON_MAX_CHARS * 4
      ])
        expect(
          JSON.stringify(boundPersistedJson({ a: value }, budget)),
          `${name}: verbatim at ${budget}, so the boundary is a share and not a cap`
        ).not.toBe(want);
    }

    // NON-VACUITY: `lawBudget` must be capable of returning 96, or every "outside" arm is green on
    // a helper that always returns -1.
    expect(lawBudget("x".repeat(300))).toBe(96);
  });

  it("L + 96 IS THE WHOLE LAW: a value of L characters survives verbatim at L + 96, and not before", () => {
    // ONE LAW FOR EVERY SHAPE. `boundPersistedJson` reserves PERSISTED_JSON_MIN_LEAF from the row
    // as its overspend backstop and the walk gets the rest, so a field that costs L wants exactly
    // L + 96 — and that was true of scalars and objects while ARRAYS wanted `L + 96 + the tail
    // marker's price`, a marker the complete list never stores. Measured before the fix:
    //
    //     {a: ["a"]}          L 11    verbatim from 134, not 107
    //     {a: [40 entries]}   L 237   verbatim from 361, not 333
    //
    // Stated as a two-sided law so it cannot be satisfied by simply reserving more: verbatim at
    // L + 96, and NOT verbatim at L + 95.
    const atoms: [string, unknown][] = [
      ["the empty string", ""],
      ["a 200-character string", "x".repeat(200)],
      // AT THE BOUNDARY, not comfortably inside it — 300 was the widest atom, and the domain arm
      // above is what says why 4 000 is the last width that works.
      ["a 4 000-character string", "x".repeat(4_000)],
      ["a 126-character key", Object.fromEntries([["K".repeat(126), "v"]])],
      ["seven levels of nesting", { a: { b: { c: { d: { e: { f: { g: "deep" } } } } } } }],
      ["50 backslashes", "\\".repeat(50)],
      ["30 astral characters", "\u{1F600}".repeat(30)],
      ["a number", 1_234_567_890_123],
      ["a boolean", true],
      ["null", null],
      ["the empty list", []],
      ["a one-element list", ["a"]],
      ["a 40-element list", Array.from({ length: 40 }, (_, i) => `e${i}`)],
      ["a 400-element list", Array.from({ length: 400 }, (_, i) => `e${i}`)],
      ["a list of objects", Array.from({ length: 20 }, (_, i) => ({ id: i, ref: `r-${i}` }))],
      ["a rollout", { phase: "Progressing", step: 3, weight: 60 }],
      ["four levels of nesting", { a: { b: { c: { d: "deep" } } } }],
      [
        "a string, a list and an object together",
        { r: "x".repeat(60), l: ["a", "b", 1, null, true], o: { w: 60 } }
      ]
    ];
    for (const [name, value] of atoms) {
      const wrapped = { a: value };
      const verbatim = JSON.stringify(wrapped)!;
      const L = verbatim.length;
      expect(
        JSON.stringify(boundPersistedJson(wrapped, L + 96)),
        `${name}: not verbatim at L + 96`
      ).toBe(verbatim);
      expect(
        JSON.stringify(boundPersistedJson(wrapped, L + 95)),
        `${name}: verbatim at L + 95, so the law is looser than it says`
      ).not.toBe(verbatim);
    }
  });

  it("A LIST THAT FITS IS NOT CHARGED FOR A MARKER IT CANNOT NEED", () => {
    // The narrow arm for pass 11's tail reserve, which its own author flagged as the half only they
    // had reviewed ("an array whose reserve is released on one path and not the other"). The
    // reserve is real money taken from what the ELEMENTS may spend, so a one-character list stored
    // a 26-character apology instead of itself.
    const value = { a: ["a"] };
    expect(JSON.stringify(boundPersistedJson(value, 107))).toBe('{"a":["a"]}');
    // …and the marker is still bought when the list really is cut, which is the arm that stops the
    // fix from being "stop reserving". A cut list may never render past its budget.
    for (const budget of [40, 60, 80, 100, 106]) {
      const rendered = JSON.stringify(boundPersistedJson({ a: ["a"] }, budget))!;
      expect(rendered.length, `budget ${budget}`).toBeLessThanOrEqual(budget);
    }
    const cutList = { a: Array.from({ length: 400 }, () => "x".repeat(80)) };
    const out = boundPersistedJson(cutList) as { a: string[] };
    expect(isPersistedJsonEntriesElision(out.a[out.a.length - 1]!)).toBe(true);
    expect(JSON.stringify(out)!.length).toBeLessThanOrEqual(PERSISTED_JSON_MAX_CHARS);
  });

  it("RETENTION IS MONOTONE IN THE BUDGET while the stored key structure is unchanged", () => {
    /** How much CONTENT survived: characters of real string, real numbers, real keys. A marker
     *  scores nothing, because a marker is what a reader gets INSTEAD of content. */
    const score = (v: unknown): number => {
      if (v === null || v === undefined) return 0;
      if (typeof v === "string")
        return isPersistedJsonEntriesElision(v) || v.startsWith("[elided: nesting deeper")
          ? 0
          : v.length;
      if (typeof v === "number" || typeof v === "boolean") return 1;
      if (Array.isArray(v)) return v.reduce<number>((a, x) => a + score(x), 0);
      let total = 0;
      for (const [key, x] of Object.entries(v as Record<string, unknown>)) {
        if (key === PERSISTED_JSON_ELIDED_KEY) continue;
        total += key.length + score(x);
      }
      return total;
    };
    /** WHICH keys are stored, at every level. A budget that seats one MORE key legitimately trades
     *  characters of a large field for it — that is property (1) working, not a regression — so the
     *  comparison below is made only between budgets that stored the same key structure. */
    const shape = (v: unknown): string => {
      if (Array.isArray(v)) return "[]";
      if (v !== null && typeof v === "object")
        return `{${Object.entries(v as Record<string, unknown>)
          .map(([k, x]) => `${k}${shape(x)}`)
          .sort()
          .join(",")}}`;
      return "";
    };

    const shapes: [string, unknown][] = [
      [
        "a reading with 40 image refs",
        {
          revision: "9f2c1ab4e77d0c31a5b8e6f2c9d4a1b3e5f70982",
          images: Array.from({ length: 40 }, (_, i) => `ghcr.io/a/b-${i}@sha256:${"a".repeat(64)}`),
          rollout: { phase: "P", step: 3, weight: 60 }
        }
      ],
      [
        "a reading with a nested meta block",
        {
          r: "x".repeat(200),
          images: Array.from({ length: 100 }, (_, i) => `img-${i}-${"x".repeat(50)}`),
          meta: { a: "x".repeat(300), b: Array.from({ length: 20 }, () => 12_345) },
          w: 60
        }
      ],
      ["30 resources", { resources: resources(30) }]
    ];
    for (const [name, value] of shapes) {
      let previous = -1;
      let previousShape = "";
      let previousBudget = 0;
      for (let budget = 100; budget <= 1_400; budget++) {
        const bounded = boundPersistedJson(value, budget);
        const now = score(bounded);
        const nowShape = shape(bounded);
        if (nowShape === previousShape)
          expect(
            now,
            `${name}: budget ${previousBudget} stored ${previous} characters of content and budget ${budget} stored ${now}`
          ).toBeGreaterThanOrEqual(previous);
        previous = now;
        previousShape = nowShape;
        previousBudget = budget;
      }
    }

    // THE MEASURED CLIFF, pinned as the exact numbers rather than as "it got better". One more
    // character of budget seated a third key, every field's share fell to the flat 96, `images`
    // could no longer afford a single entry, and the row fell from 300 to 148 of the 418 available.
    const reading = shapes[0]![1];
    for (const budget of [416, 417, 418, 419, 420]) {
      const out = boundPersistedJson(reading, budget) as {
        images: string[];
        rollout: { weight: number };
      };
      expect(
        out.images.filter((x) => !isPersistedJsonEntriesElision(x)),
        `budget ${budget}`
      ).toHaveLength(2);
      expect(out.rollout.weight, `budget ${budget}: ADR-0028's gate leaf`).toBe(60);
    }
  });
});

/**
 * HIGH (M23.0 verification pass 13) — A SEAT PHASE 1 PAID FOR IS A SHARE PHASE 2 MUST HONOUR.
 *
 * A REGRESSION IN PASS 12'S OWN FIX, not a pre-existing defect. Pass 12 replaced a flat
 * `PERSISTED_JSON_MIN_LEAF` seat price with the value's exact cost and argued the change was safe
 * because it "can only admit content the old rule refused" — a statement about the seated SET. The
 * flat 96 was also the guarantee that a seated field would be HANDED 96 characters, which is what
 * that constant's own comment says it is for ("enough for a short marker and its punctuation").
 * Phase 2 kept dividing the pool equally, so a field could be offered less than the value it was
 * seated for costs, and the value then emitted a marker nobody had costed:
 * `[elided: N more entries]` is 26 rendered characters where the list it replaced was 5.
 *
 * Measured on the shipped build, over 197 934 (shape, budget) pairs:
 *
 *   pass 11        0 / 197 934 whole values discarded by the backstop
 *   pass 12 pre    0 / 197 934
 *   pass 12 as shipped   34 900 / 197 934, at budgets up to 13 981 — INCLUDING the production
 *                        8 000 with no explicit budget argument
 *
 * THE UNIT HERE IS THE BACKSTOP, not the row length. Every arm below is green on a function that
 * stores nothing at all; the last one is the counter-arm for that.
 *
 * WHY IT IS A DENSE BUDGET SWEEP AND NOT A RANDOM CORPUS. The trigger is an arithmetic coincidence
 * — phase 1 must refuse exactly enough fields for the `__scpElided` charge to push the pool under
 * what the survivors were seated for. 6 000 random shapes (widths to 25 x 60, depth 10, arrays to
 * 120, bigints, functions, over-long and colliding keys) found ZERO instances against the broken
 * build; this sweep finds 49 518 of 335 496. Random shape generation is the wrong instrument, and
 * that is the reason eleven passes of it went past this.
 */
describe("HIGH: a seat phase 1 paid for is a share phase 2 must honour", () => {
  const DIAGNOSTIC = "a plugin-supplied value rendered";
  /** The backstop threw the payload away — the loss this whole file exists to prevent. */
  const discarded = (bounded: unknown): boolean =>
    bounded !== null &&
    typeof bounded === "object" &&
    String((bounded as Record<string, unknown>)[PERSISTED_JSON_ELIDED_KEY] ?? "").startsWith(
      DIAGNOSTIC
    );

  /** `n` fields at one level, each holding the same small value — the family the defect lives in,
   *  because every survivor is small enough to have been seated at its exact cost. */
  const wide = (n: number, make: (i: number) => unknown): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < n; i++) out[`k${i}`] = make(i);
    return out;
  };
  const KINDS: [string, (i: number) => unknown][] = [
    ["a one-element list", () => ["a"]],
    ["a five-element list", () => ["a", "b", "c", "d", "e"]],
    ["a one-field object", () => ({ x: 1 })]
  ];

  it("THE MINIMAL CASE: five one-element lists at 143 are lists, not a diagnostic sentence", () => {
    // 56 characters of content. Before the fix the walk rendered 167 for a budget of 143 and the
    // backstop replaced the whole value; the four lists it kept had each become a 26-character
    // apology for one character of content.
    const value = wide(5, () => ["a"]);
    const bounded = boundPersistedJson(value, 143) as Record<string, string[]>;
    expect(discarded(bounded), "the backstop discarded five one-element lists").toBe(false);
    // RETENTION, not length: whatever survived has to be a whole list and not a cut one. The COUNT
    // that survives is deliberately not asserted here — see the arm below for why it moved and for
    // the two-sided statement that replaced it.
    const kept = Object.entries(bounded).filter(([key]) => key !== PERSISTED_JSON_ELIDED_KEY);
    expect(kept.length, "no field survived at all").toBeGreaterThanOrEqual(1);
    for (const [key, list] of kept) {
      expect(list, `${key} is not a list`).toEqual(["a"]);
    }
  });

  it("AND THE COUNT THAT SURVIVES IS THE LAW'S, NOT THE CUSHION'S — pass 14", () => {
    // WHAT MOVED AND WHY IT IS THE RIGHT DIRECTION. Pass 13 asserted four of the five lists survive
    // at 143. One does now, and the four were being paid for out of the row's backstop cushion: the
    // walk is handed `143 - PERSISTED_JSON_MIN_LEAF` = 47 characters, and four lists plus their keys
    // plus a 30-character elision entry is 75. Pass 14 made the object BUY that entry before phase 1
    // seats anything (`fieldsElisionCost`), so the walk now spends what it was given. Measured over
    // every budget in 100…175, both builds:
    //
    //     budget   108   119   130   141   149   152
    //     pass 13    1     2     3     4     4     5   <- borrowing from the cushion
    //     pass 14    0     0     0     1     2     5
    //
    // The borrowing is what produced 15 982 whole-value discards over the pass-14 sweep, five of
    // which are CLIFFS: one more character of budget took `depth 5 width 3` from 2 539 stored
    // characters to 145 of apology. Nine cliffs remain in the fixed build and NOT ONE of them lands
    // on the backstop.
    const value = wide(5, () => ["a"]);
    const L = JSON.stringify(value)!.length;
    expect(L).toBe(56);

    // THE LAW IS WHERE IT ALWAYS WAS, and that is the two-sided statement retention gets instead of
    // a hand-picked count: everything at L + 96, not everything at L + 95.
    expect(JSON.stringify(boundPersistedJson(value, L + 96))).toBe(JSON.stringify(value));
    expect(JSON.stringify(boundPersistedJson(value, L + 95))).not.toBe(JSON.stringify(value));

    // AND BELOW THE LAW, RETENTION IS MONOTONE AND NEVER A DIAGNOSTIC. That is the property the
    // count was standing in for, and unlike the count it cannot be satisfied by borrowing.
    let previous = 0;
    for (let budget = 4; budget <= L + 96; budget++) {
      const out = boundPersistedJson(value, budget);
      const rendered = JSON.stringify(out) ?? "null";
      expect(rendered.length, `budget ${budget}: over the row bound`).toBeLessThanOrEqual(budget);
      // 32 is the width of `{"__scpElided":"5 more fields"}` — the walk's SHORTEST honest output
      // for this value, so below it the backstop is not a defect but the only thing left. At and
      // above it the backstop must never fire, in any of its three forms.
      if (budget < 32) continue;
      expect(discarded(out), `budget ${budget}: the backstop fired`).toBe(false);
      expect(out, `budget ${budget}: the backstop returned null`).not.toBeNull();
      expect(rendered.length, `budget ${budget}: retention fell`).toBeGreaterThanOrEqual(previous);
      previous = rendered.length;
    }
  });

  it("AT THE PRODUCTION BUDGET, no explicit argument: 300 small lists are stored, not discarded", () => {
    // `boundPersistedJson(value)` — the call `wave-targets-repo.ts` actually makes. 8 591
    // characters of ordinary per-resource reading came back as 145 characters of apology.
    const value = wide(300, () => ["a", "b", "c", "d", "e"]);
    const bounded = boundPersistedJson(value);
    expect(discarded(bounded), "the whole reading was discarded at the default budget").toBe(false);
    const rendered = JSON.stringify(bounded)!;
    expect(rendered.length).toBeLessThanOrEqual(PERSISTED_JSON_MAX_CHARS);
    // …and it is not merely SHORT: most of the column is real content, not markers.
    expect(rendered.length, "the column was abandoned").toBeGreaterThan(
      PERSISTED_JSON_MAX_CHARS - 200
    );
  });

  it("EVERY BUDGET 100…900, three depths, six widths, three field kinds: the backstop never fires", () => {
    // The defect is per-OBJECT, so the same family is buried at increasing depth — a share that
    // breaks phase 1's promise does it wherever the object sits, not only at the root.
    const bury = (value: unknown, depth: number): unknown => {
      let out = value;
      for (let i = 0; i < depth; i++) out = { [`d${i}`]: out };
      return out;
    };
    const failures: string[] = [];
    let swept = 0;
    for (const depth of [0, 1, 2]) {
      for (const width of [5, 8, 13, 21, 34, 55]) {
        for (const [kindName, make] of KINDS) {
          const value = bury(wide(width, make), depth);
          for (let budget = 100; budget <= 900; budget++) {
            swept++;
            const bounded = boundPersistedJson(value, budget);
            if (discarded(bounded))
              failures.push(`depth ${depth}, ${width} x ${kindName}, budget ${budget}`);
            const rendered = JSON.stringify(bounded);
            if (rendered !== undefined && rendered.length > budget)
              failures.push(
                `OVER BUDGET: depth ${depth}, ${width} x ${kindName}, budget ${budget} -> ${rendered.length}`
              );
          }
        }
      }
    }
    // NON-VACUITY: the sweep really did run the shapes it says it ran.
    expect(swept, "the sweep is empty").toBe(3 * 6 * 3 * 801);
    expect(
      failures.slice(0, 8),
      `${failures.length} of ${swept} shapes lost their payload`
    ).toEqual([]);
  });

  it("COUNTER-ARM: the same sweep on a function that stores nothing would be green", () => {
    // Every arm above is satisfied by `() => ({})`. So the family is also asserted to come back
    // VERBATIM once the budget can hold it — which is the `L + 96` law, restated at width.
    for (const width of [5, 8, 13, 21, 34, 55]) {
      for (const [kindName, make] of KINDS) {
        const value = wide(width, make);
        const verbatim = JSON.stringify(value)!;
        expect(
          JSON.stringify(boundPersistedJson(value, verbatim.length + 96)),
          `${width} x ${kindName}: not verbatim at L + 96`
        ).toBe(verbatim);
      }
    }
  });
});
