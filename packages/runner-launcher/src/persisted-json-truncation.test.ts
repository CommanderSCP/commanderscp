import { describe, expect, it } from "vitest";
import {
  PERSISTED_JSON_ELIDED_KEY,
  PERSISTED_JSON_MAX_CHARS,
  PERSISTED_JSON_MAX_DEPTH,
  PERSISTED_JSON_TRUNCATION_MAX_CHARS,
  boundPersistedJson
} from "./index.js";

/** M23.1g — THE BOUND CUT SOMETHING AND SAID SO. See docs/runner-launcher.md §383. */

const imageRefs = (n: number) =>
  Array.from(
    { length: n },
    (_, i) => `ghcr.io/acme/platform/service-${i}@sha256:${"a".repeat(64)}`
  );
const ROLLOUT = { phase: "Progressing", step: 3, weight: 60, message: "canary at 60%" };

describe("M23.1g: what the bound removed comes back with what it kept", () => {
  it("AN HONEST READING CARRIES NO SIGNAL AT ALL", () => {
    // The most important arm in the file. A truncation signal that is present on readings that lost
    // nothing is a signal every consumer learns to ignore, and then the one that matters is missed.
    const reading = {
      revision: "9f2c1ab4e77d0c31a5b8e6f2c9d4a1b3e5f70982",
      images: ["ghcr.io/org/app:1.2.3", `ghcr.io/org/sidecar@sha256:${"a".repeat(64)}`],
      rollout: { phase: "Progressing", step: 2, weight: 25, message: "canary at 25%" }
    };
    const bounded = boundPersistedJson(reading);
    expect(JSON.stringify(bounded.value)).toBe(JSON.stringify(reading));
    expect(bounded.truncation).toBeUndefined();
  });

  it("A FIELD THE BOUND REFUSED IS `dropped`, NAMED — the wrong-cause defect, directly", () => {
    // The composer builds those fields in that order. See docs/runner-launcher.md §384.
    const bounded = boundPersistedJson({ revision: "v1", images: ["a"], rollout: ROLLOUT }, 160);
    const stored = bounded.value as Record<string, unknown>;
    expect(stored.revision).toBe("v1"); // …the siblings really did survive, so this is not a
    expect(stored.images).toEqual(["a"]);
    expect(stored.rollout).toBeUndefined();
    expect(bounded.truncation?.rollout).toEqual({ dropped: true });

    // AND THE NAME IS NOT RECOVERABLE FROM THE ROW. `__scpElided` is a COUNT; the report is the only
    // place the name survives, which is the whole reason it is a return value.
    expect(stored[PERSISTED_JSON_ELIDED_KEY]).toBe("1 more fields");
    expect(JSON.stringify(stored)).not.toContain("rollout");
  });

  it("A LIST CUT AT THE TAIL REPORTS THE SAME NUMBER ITS MARKER CARRIES", () => {
    const bounded = boundPersistedJson({ images: imageRefs(400) });
    const stored = bounded.value as { images: string[] };
    const marker = stored.images[stored.images.length - 1]!;
    const inMarker = Number(/^\[elided: (\d+) more entries\]$/.exec(marker)![1]);
    // Two readers, one cut: one has the marker, one has the report. Telling them different numbers
    // is the provenance-label defect in miniature.
    expect(bounded.truncation?.images?.droppedEntries).toBe(inMarker);
    expect(stored.images.length - 1 + inMarker).toBe(400);
    expect(bounded.truncation?.images?.dropped).toBe(false);
  });

  it("A SHORTENED STRING REPORTS ITS CHARACTERS, AND `dropped` STAYS FALSE", () => {
    const revision = "r".repeat(50_000);
    const bounded = boundPersistedJson({ revision });
    const stored = bounded.value as { revision: string };
    const entry = bounded.truncation?.revision;
    expect(entry?.dropped).toBe(false); // it is THERE; it is just not all of it
    expect(entry?.droppedCharacters).toBeGreaterThan(45_000);
    // The count is arithmetically honest against the stored head+tail, elision marker excluded —
    // which is exactly why `boundTextWithLoss` returns it instead of leaving a caller to parse the
    // marker out of the value.
    expect(entry!.droppedCharacters!).toBeLessThan(revision.length);
    expect(stored.revision.length).toBeLessThan(revision.length);
  });

  it("SANITISING IS NOT TRUNCATION: a NUL-carrying revision that FITS reports nothing", () => {
    // U+0000 is replaced by U+FFFD one code unit for one — `jsonb` refuses the row otherwise, and
    // that refusal is BUILD_AND_TEST.md §4.4a's 13-day stall. Nothing is REMOVED, the value stays
    // readable, and reporting it as truncation would fire the signal on a reading that lost none of
    // its content. `clipped` and `loss` are set on different conditions for exactly this.
    const NUL = "\u0000"; // an ESCAPE: a literal NUL in a tracked source file is invisible to every
    // recursive search this repository runs and fails `pnpm nul-census` (CLAUDE.md).
    const bounded = boundPersistedJson({ revision: `abc${NUL}def` });
    expect(bounded.value).toEqual({ revision: "abc�def" });
    expect(bounded.truncation).toBeUndefined();
  });

  it("THE DEPTH LIMIT REPORTS WHAT IT REPLACED, in the unit it replaced it in", () => {
    // Not a budget clip. See docs/runner-launcher.md §385.
    let deep: Record<string, unknown> = { a: 1, b: 2, c: 3 };
    for (let i = 0; i < PERSISTED_JSON_MAX_DEPTH; i++) deep = { next: deep };
    const bounded = boundPersistedJson(deep);
    expect(JSON.stringify(bounded.value)).toContain("nesting deeper than");
    expect(bounded.truncation?.next?.droppedFields).toBe(3);
  });

  it("THE DEPTH LIMIT'S OTHER BRANCH: an over-deep ARRAY reports its ENTRIES, and the count is real", () => {
    // M23.0 verification pass 15. See docs/runner-launcher.md §386.
    const ENTRY_COUNT = 40;
    let deep: unknown = Array.from({ length: ENTRY_COUNT }, (_, i) => `entry-${i}`);
    for (let i = 0; i < PERSISTED_JSON_MAX_DEPTH; i++) deep = { next: deep };
    const bounded = boundPersistedJson(deep);
    // NON-VACUITY: the limit really is what removed the list — not the budget, which is untouched
    // here. Without this the arm would pass on a shape the depth limit never reached.
    expect(JSON.stringify(bounded.value)).toContain("nesting deeper than");
    expect(bounded.truncation?.next?.droppedEntries).toBe(ENTRY_COUNT);
    // …and it is reported as ENTRIES, not as fields: the unit is part of the claim, and the two
    // branches write to different counters.
    expect(bounded.truncation?.next?.droppedFields).toBeUndefined();
    // NOT a budget clip — `dropped` stays false, because more budget would not bring it back.
    expect(bounded.truncation?.next?.dropped).toBe(false);
  });

  it("THE BACKSTOP — the worst loss this file can produce — reports EVERY root field dropped", () => {
    // When the walk's own measurement says the row is over budget, the payload is discarded whole
    // and a diagnostic sentence stored in its place: `revision`, `images` and `rollout.weight` gone
    // together, silently, on every tick. That silence is what an operator saw.
    const bounded = boundPersistedJson({ revision: "v1", images: ["x"], rollout: ROLLOUT }, 4);
    expect(bounded.value).toBeNull();
    expect(bounded.truncation).toEqual({
      revision: { dropped: true },
      images: { dropped: true },
      rollout: { dropped: true }
    });
  });

  it("A VALUE WHOSE ROOT IS NOT AN OBJECT reports under the empty key rather than silently", () => {
    // `boundPersistedJson` takes `unknown`, and `walkObjectFields` is the only thing that fills the
    // per-field map — so without the root-loss clause the ONE shape with no field names would lose
    // content and report nothing at all.
    const bounded = boundPersistedJson("r".repeat(50_000), 500);
    expect(bounded.truncation?.[""]?.droppedCharacters).toBeGreaterThan(49_000);
    const list = boundPersistedJson(imageRefs(400), 500);
    expect(list.truncation?.[""]?.droppedEntries).toBeGreaterThan(0);
  });

  it("THE REPORT IS ITSELF BOUNDED, and its overflow is a LEGAL entry rather than a marker string", () => {
    // The report's only plugin-chosen component is the root field NAMES, and how many of them there
    // are is unbounded. A report that could grow without limit would be a second unbounded
    // plugin-influenced write on the same row — the finding this whole family of rounds began with.
    const wide = Object.fromEntries(
      Array.from({ length: 400 }, (_, i) => [`field-${i}`, "v".repeat(200)])
    );
    const bounded = boundPersistedJson(wide);
    const report = bounded.truncation!;
    expect(JSON.stringify(report).length).toBeLessThanOrEqual(PERSISTED_JSON_TRUNCATION_MAX_CHARS);
    // The entries that did not fit are ONE entry carrying their count — a legal
    // `PersistedJsonFieldTruncation`, because the API schema is a record OF THOSE and a bare marker
    // string there is a response the serializer refuses, i.e. a stall.
    const overflow = report[PERSISTED_JSON_ELIDED_KEY]!;
    expect(overflow.dropped).toBe(true);
    expect(overflow.droppedFields).toBeGreaterThan(0);
    for (const entry of Object.values(report)) expect(typeof entry.dropped).toBe("boolean");
  });

  it("A RE-WALKED FIELD REPORTS ITS CUT ONCE — phase 2 walks a field up to four times", () => {
    // The water-filling loop re-walks a clipped field at a larger share, so a loss accumulator
    // shared across attempts reports the same cut two, three and four times over. Two large
    // siblings guarantee at least one redistribution round.
    const bounded = boundPersistedJson({ a: imageRefs(200), b: imageRefs(200) }, 4_000);
    const stored = bounded.value as { a: string[]; b: string[] };
    for (const key of ["a", "b"] as const) {
      const kept = stored[key].filter((entry) => entry.startsWith("ghcr.io/")).length;
      // The number the report gives is the number actually missing — not a multiple of it.
      expect(bounded.truncation?.[key]?.droppedEntries).toBe(200 - kept);
    }
  });
});

describe("M23.1g GATE: the bound may not remove content without emitting the signal", () => {
  /** A DENSE BUDGET SWEEP over a structured family. See docs/runner-launcher.md §387. */
  const family: [string, unknown][] = [
    ["a revision alone", { revision: "r".repeat(4_000) }],
    ["a list alone", { images: imageRefs(60) }],
    ["the production composition", { revision: "v1", images: imageRefs(60), rollout: ROLLOUT }],
    ["a rollout with a long message", { rollout: { ...ROLLOUT, message: "m".repeat(3_000) } }],
    [
      "nested per-resource readings",
      {
        revision: "v1",
        resources: Object.fromEntries(
          Array.from({ length: 20 }, (_, i) => [
            `svc-${i}`,
            { status: "Synced", health: "Healthy", image: `ghcr.io/acme/svc-${i}:1.2.3` }
          ])
        )
      }
    ],
    [
      "many one-element lists",
      Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, ["a"]]))
    ],
    [
      "a wide flat object",
      Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`field-${i}`, "v".repeat(40)]))
    ]
  ];

  it("EVERY (SHAPE, BUDGET): a value that came back changed came back WITH A REPORT", () => {
    let cut = 0;
    let intact = 0;
    for (const [name, value] of family) {
      const verbatim = JSON.stringify(value)!;
      for (let budget = 100; budget <= 9_000; budget += 13) {
        const bounded = boundPersistedJson(value, budget);
        const rendered = JSON.stringify(bounded.value);
        if (rendered === verbatim) {
          intact++;
          // AND THE CONVERSE FOR THE ONE CASE IT HOLDS IN: a byte-identical value lost nothing, so
          // a report here would be the false-positive half of the same defect.
          expect(
            bounded.truncation,
            `${name} @ ${budget}: came back byte-identical and still claims truncation`
          ).toBeUndefined();
          continue;
        }
        cut++;
        expect(
          bounded.truncation,
          `${name} @ ${budget}: the bound removed content and said nothing — stored ${rendered?.length} of ${verbatim.length}`
        ).toBeDefined();
        // …and the report is not empty ceremony: at least one entry says something happened.
        const entries = Object.values(bounded.truncation!);
        expect(entries.length, `${name} @ ${budget}: an empty report`).toBeGreaterThan(0);
        expect(
          entries.some(
            (e) =>
              e.dropped ||
              (e.droppedCharacters ?? 0) > 0 ||
              (e.droppedEntries ?? 0) > 0 ||
              (e.droppedFields ?? 0) > 0
          ),
          `${name} @ ${budget}: a report that names no loss`
        ).toBe(true);
        // …and it fits its own bound, at every budget, not only at the production one.
        expect(JSON.stringify(bounded.truncation).length).toBeLessThanOrEqual(
          PERSISTED_JSON_TRUNCATION_MAX_CHARS
        );
      }
    }
    // NON-VACUITY, BOTH WAYS. A sweep that never cut anything would pass the implication trivially;
    // a sweep that always cut would never exercise the "no signal" half.
    expect(cut, "the sweep never truncated anything").toBeGreaterThan(1_000);
    expect(intact, "the sweep never left anything intact").toBeGreaterThan(100);
  });

  it("AT THE PRODUCTION BUDGET the signal still fires on the shapes production actually sees", () => {
    // The sweep above ranges over budgets the product never uses. This is the one it does.
    const saturating = {
      revision: "9f2c1ab4e77d0c31a5b8e6f2c9d4a1b3e5f70982",
      images: imageRefs(400),
      rollout: ROLLOUT
    };
    const bounded = boundPersistedJson(saturating, PERSISTED_JSON_MAX_CHARS);
    expect(bounded.truncation?.images?.droppedEntries).toBeGreaterThan(300);
    expect(bounded.truncation?.revision).toBeUndefined();
    expect(bounded.truncation?.rollout).toBeUndefined(); // and the gate's leaf survives
  });
});
