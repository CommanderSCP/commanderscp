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

  it("AT EVERY FIELD ORDER — the fix is in the walk, not in how the value happens to be composed", () => {
    const source: Record<string, unknown> = {
      revision: REVISION,
      images: imageRefs(80),
      rollout: ROLLOUT
    };
    const orders = [
      ["revision", "images", "rollout"],
      ["revision", "rollout", "images"],
      ["images", "revision", "rollout"],
      ["images", "rollout", "revision"],
      ["rollout", "revision", "images"],
      ["rollout", "images", "revision"]
    ];
    for (const order of orders) {
      const value: Record<string, unknown> = {};
      for (const key of order) value[key] = source[key];
      const out = boundPersistedJson(value) as Reading & Record<string, unknown>;
      expect(out.rollout?.weight, `order ${order.join(",")}: the gate's leaf was elided`).toBe(60);
      expect(out.revision, `order ${order.join(",")}: revision was elided`).toBe(REVISION);
      expect(out.images?.length, `order ${order.join(",")}: images vanished entirely`).toBeGreaterThan(
        1
      );
      expect(
        out[PERSISTED_JSON_ELIDED_KEY],
        `order ${order.join(",")}: a whole field was dropped for a sibling`
      ).toBeUndefined();
      expect(JSON.stringify(out).length).toBeLessThanOrEqual(PERSISTED_JSON_MAX_CHARS);
    }
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

  it("a field that is SMALL costs a large sibling nothing — the share is a cap, not an allocation", () => {
    // The counter-arm to fair sharing: if unspent share did not flow forward, this would keep a
    // third of what a single-budget walk kept, and the bound would have become a filter.
    const withSiblings = boundPersistedJson({
      revision: "v1",
      rollout: ROLLOUT,
      images: imageRefs(400)
    }) as Reading;
    const alone = boundPersistedJson({ images: imageRefs(400) }) as Reading;
    expect(withSiblings.images!.length).toBeGreaterThan(alone.images!.length * 0.8);
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
