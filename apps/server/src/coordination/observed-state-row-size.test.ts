import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readStripped } from "@scp/source-census";
import {
  PERSISTED_JSON_MAX_CHARS,
  PERSISTED_JSON_TRUNCATION_MAX_CHARS,
  boundPersistedJson
} from "@scp/runner-launcher";
import { observedStateFrom } from "./wave-targets-repo.js";

/**
 * ================================================================================================
 * THE ROW IS NOT THE BOUND'S OUTPUT — M23.0 verification pass 11, the coupling nothing named.
 * ================================================================================================
 * `boundPersistedJson`'s guarantee is about ITS OWN RETURN VALUE:
 * `JSON.stringify(boundPersistedJson(v)).length <= PERSISTED_JSON_MAX_CHARS`. Every assertion in
 * `packages/runner-launcher/src/persisted-json-bound.test.ts` — 55 of them — measures exactly that.
 *
 * WHAT REACHES POSTGRES IS SOMETHING ELSE. `updateWaveTargetObserved` writes
 *
 *     { ...boundPluginJson(observedState), observedAt: now.toISOString() }
 *
 * and stamps `observedAt` AFTER the bound, deliberately: the timestamp is the server's, and a
 * chatty plugin must not be able to spend the budget that carries it. Correct — and it means the
 * ROW is up to 40 characters wider than anything the bound's own suite ever measures. The policy
 * "an `observed_state` row is at most `PERSISTED_JSON_MAX_CHARS`" is therefore true only because a
 * SECOND number in a DIFFERENT package happens to be larger than the stamp:
 *
 *     widest walk output   PERSISTED_JSON_MAX_CHARS - PERSISTED_JSON_MIN_LEAF   =  7 904
 *     the stamp            `,"observedAt":"2026-08-19T17:44:33.123Z"`           =     40
 *     the widest row                                                              7 944  (of 8 000)
 *
 * i.e. 56 characters of headroom, held by `PERSISTED_JSON_MIN_LEAF`, which is a private constant
 * whose documented job is "enough for a short marker" and has nothing to do with timestamps. Set it
 * to 32 — a plausible retune, since it is three times what the marker actually needs — and the
 * widest row becomes 8 008. Measured: `{revision, images, rollout}` reaches 8 008 of 8 000.
 *
 * ================================================================================================
 * AND THE SECOND THING STAMPED AFTER THE BOUND — M23.1g, and it is PAID FOR RATHER THAN TOLERATED.
 * ================================================================================================
 * `truncation` (what the bound removed, per field) is stamped beside `observedAt`. That is a second
 * escapee of exactly the shape this file was written to catch, so it is NOT allowed to escape:
 * `updateWaveTargetObserved` hands the bound `OBSERVED_STATE_VALUE_MAX_CHARS`, which is
 * `PERSISTED_JSON_MAX_CHARS` minus a reserve the report is then measured against. The row policy
 * does not move; the value's share of it does.
 *
 *     widest walk output   OBSERVED_STATE_VALUE_MAX_CHARS - PERSISTED_JSON_MIN_LEAF   =  7 584
 *     the report           PERSISTED_JSON_TRUNCATION_MAX_CHARS + `,"truncation":`     =    302
 *     the stamp            `,"observedAt":"…"`                                        =     40
 *     the widest row                                                                     7 926
 *
 * The arms below are unchanged in what they assert — the ROW, against `PERSISTED_JSON_MAX_CHARS` —
 * and that is the point: a reserve that was NOT taken out of the value's budget would show up here
 * as a row over the policy, on exactly the saturating shapes that now carry a report.
 *
 * The runner-launcher suite DOES redden on that mutation today, but for an unrelated reason: five
 * of its arms pin the literal `budget - 96`. Someone retuning the constant on purpose updates those
 * five and ships — the numbers move together and say nothing about a timestamp. This file is the
 * one assertion that would still be red, stated in the unit that matters: THE ROW.
 *
 * NOT A DEFECT TODAY. The headroom is real and positive; this is the gate that keeps it so.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "wave-targets-repo.ts");

/** Re-derived here rather than imported, because `wave-targets-repo.ts` keeps it private and the
 *  arm below reads the repository's own arithmetic out of the source to check this copy. */
const OBSERVED_STATE_VALUE_MAX_CHARS =
  PERSISTED_JSON_MAX_CHARS - (PERSISTED_JSON_TRUNCATION_MAX_CHARS + 32);

/** Exactly what `updateWaveTargetObserved` composes, minus the database — the value, the truncation
 *  report when there is one, and the stamp, in that order. */
function persistedRow(status: Parameters<typeof observedStateFrom>[0], at: Date): string {
  const observedState = observedStateFrom(status);
  if (!observedState) return "";
  const bounded = boundPersistedJson(observedState, OBSERVED_STATE_VALUE_MAX_CHARS);
  return JSON.stringify({
    ...(bounded.value as object),
    ...(bounded.truncation ? { truncation: bounded.truncation } : {}),
    observedAt: at.toISOString()
  });
}

const imageRefs = (n: number) =>
  Array.from(
    { length: n },
    (_, i) => `ghcr.io/acme/platform/service-${i}@sha256:${"a".repeat(64)}`
  );
const ROLLOUT = { phase: "Progressing", step: 3, weight: 60, message: "canary at 60%" };

describe("observed_state: the ROW, not the bound's return value, is what must fit", () => {
  it("THE COMPOSITION THIS FILE MODELS IS STILL THE ONE IN THE REPOSITORY", () => {
    // Without this the arms below are a test of a composition that used to exist. Read from source
    // rather than restated, for the reason the fake-executor parity gate is: a hand-typed copy has
    // the same blind spot as the code it copies.
    const source = readStripped(REPO);
    expect(source).toContain("boundPluginJson(observedState, OBSERVED_STATE_VALUE_MAX_CHARS)");
    expect(source).toContain("...bounded.value,");
    expect(source).toContain("...(bounded.truncation ? { truncation: bounded.truncation } : {}),");
    expect(source).toContain("observedAt: now.toISOString()");
    // …and BOTH stamps really are applied AFTER the bound, which is the whole reason this file
    // exists — `observedAt` since M23.1f's round, `truncation` since M23.1g.
    expect(source.indexOf("...bounded.value,")).toBeLessThan(
      source.indexOf("...(bounded.truncation ? { truncation: bounded.truncation } : {}),")
    );
    expect(source.indexOf("...bounded.value,")).toBeLessThan(
      source.indexOf("observedAt: now.toISOString()")
    );
    // AND THE RESERVE THIS FILE RE-DERIVES IS THE REPOSITORY'S OWN. A copy that drifted would make
    // every arm below a measurement of a budget the product does not use.
    expect(source).toContain(
      "const OBSERVED_STATE_TRUNCATION_RESERVE = PERSISTED_JSON_TRUNCATION_MAX_CHARS + 32;"
    );
    expect(source).toContain("PERSISTED_JSON_MAX_CHARS - OBSERVED_STATE_TRUNCATION_RESERVE;");
  });

  it("EVERY SATURATING SHAPE REALLY CARRIES A REPORT, so the arm above measures the row WITH it", () => {
    // NON-VACUITY FOR THE RESERVE. If the saturating fixtures stopped being truncated, the row
    // would fit for a reason that has nothing to do with the reserve being paid for, and a
    // regression that let the report escape the budget would go unnoticed.
    const bounded = boundPersistedJson(
      observedStateFrom({
        stateRef: "r".repeat(50_000),
        observed: { images: imageRefs(400), rollout: ROLLOUT }
      })!,
      OBSERVED_STATE_VALUE_MAX_CHARS
    );
    expect(bounded.truncation).toBeDefined();
    expect(JSON.stringify({ truncation: bounded.truncation }).length).toBeLessThanOrEqual(
      PERSISTED_JSON_TRUNCATION_MAX_CHARS + 32
    );
  });

  it("EVERY SHAPE THAT SATURATES THE BUDGET still fits the column policy WITH the stamp", () => {
    const at = new Date("2026-08-19T17:44:33.123Z");
    // ALL OF THESE CARRY A LIST, and that is not a stylistic choice: see the arm below — no
    // single-string reading can saturate this budget, because every string is separately capped.
    const saturating: [string, Parameters<typeof observedStateFrom>[0]][] = [
      [
        "a revision, 400 refs and a rollout",
        {
          stateRef: "r".repeat(50_000),
          observed: { images: imageRefs(400), rollout: ROLLOUT }
        }
      ],
      ["400 refs alone", { observed: { images: imageRefs(400) } }],
      [
        "an astral revision and 400 refs",
        {
          stateRef: "\u{1F600}".repeat(30_000),
          observed: { images: imageRefs(400), rollout: ROLLOUT }
        }
      ],
      [
        "a backslash revision and 400 refs",
        { stateRef: "\\".repeat(50_000), observed: { images: imageRefs(400) } }
      ],
      [
        "a C0-control revision and 400 refs",
        { stateRef: "\u0001".repeat(50_000), observed: { images: imageRefs(400) } }
      ]
    ];
    for (const [name, status] of saturating) {
      const row = persistedRow(status, at);
      // NON-VACUITY: each of these really does saturate, so "it fits" is a fact about the headroom
      // and not about a small value. 7 500 is comfortably above anything a realistic reading
      // produces and comfortably below the cap.
      expect(
        row.length,
        `${name}: no longer saturates, so it no longer tests the headroom`
      ).toBeGreaterThan(7_500);
      expect(row.length, `${name}: the ROW is over the column policy`).toBeLessThanOrEqual(
        PERSISTED_JSON_MAX_CHARS
      );
    }
  });

  it("WHY EVERY ARM ABOVE CARRIES A LIST: no single-string reading can saturate the budget", () => {
    // `RUNNER_DETAIL_MAX_CHARS` caps EVERY string at 4 000 before the whole-value budget is
    // consulted, so a 50 000-character revision alone renders to about 4 055 with the stamp — half
    // the column. Stated here rather than left as a surprise, because it is the same fact that
    // makes `observed-state-gate-critical-leaf.integration.test.ts` say "a long revision does NOT
    // reach the threshold — an array is the only route in", and a future arm written without it
    // would be silently vacuous, exactly the way this file's first draft was.
    const at = new Date("2026-08-19T17:44:33.123Z");
    const row = persistedRow({ stateRef: "r".repeat(50_000) }, at);
    // Measured 4 055: 4 000 characters of revision, its quotes and key, and the stamp.
    expect(row.length).toBeGreaterThan(4_000);
    expect(row.length).toBeLessThan(4_200);
  });

  it("A REALISTIC READING is untouched by any of it, stamp included", () => {
    const at = new Date("2026-08-19T17:44:33.123Z");
    const row = persistedRow(
      {
        stateRef: "9f2c1ab4e77d0c31a5b8e6f2c9d4a1b3e5f70982",
        observed: {
          images: ["ghcr.io/org/app:1.2.3", `ghcr.io/org/sidecar@sha256:${"a".repeat(64)}`],
          rollout: { phase: "Progressing", step: 2, weight: 25, message: "canary at 25%" }
        }
      },
      at
    );
    expect(JSON.parse(row)).toEqual({
      revision: "9f2c1ab4e77d0c31a5b8e6f2c9d4a1b3e5f70982",
      images: ["ghcr.io/org/app:1.2.3", `ghcr.io/org/sidecar@sha256:${"a".repeat(64)}`],
      rollout: { phase: "Progressing", step: 2, weight: 25, message: "canary at 25%" },
      observedAt: at.toISOString()
    });
  });
});
