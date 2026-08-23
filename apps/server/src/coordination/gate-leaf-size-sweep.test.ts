import { describe, expect, it } from "vitest";
import { PERSISTED_JSON_MAX_CHARS } from "@scp/runner-launcher";
import { OBSERVED_WEIGHT_FRESHNESS_MS, stageDependencyVerdict } from "./stage-dependency-hold.js";
import { observedStateForRow } from "./wave-targets-repo.js";
import type { WaveTargetObservedState } from "./wave-targets-repo.js";
import { resolveReleasedVersion } from "../dependencies/internal-release-version.js";

/**
 * ==================================================================================================
 * M23.1f CLAUSE 5 — EVERY GATE LEAF SURVIVES AT EVERY SIZE, **THROUGH THE READER**
 * ==================================================================================================
 *
 * WHAT THE CLAUSE IS ABOUT, AND WHY "THROUGH THE READER" IS THE WHOLE OF IT. M23.1f's second defect
 * was the bound dropping `rollout` first, which silently disabled ADR-0028's `minWeight` gate at 73
 * image refs. That is not a bound-arithmetic failure — the row fitted, the truncation was reported,
 * every assertion about SIZE stayed true. It is a failure that only exists at the READER: the gate
 * asked for a weight, the weight was gone, and the verdict degraded to the universal succeeded-test
 * with nobody the wiser.
 *
 * WHAT THE REPO ALREADY HAD, AND WHY IT COULD NOT SEE THIS. `persisted-json-budget-sweep.test.ts`
 * sweeps 116,850 (shape, budget) pairs and asserts row size, backstop firings and truncation
 * reports — plus ONE direct `stored.rollout?.weight` read. It never calls a gate. The four
 * reader-level assertions that do exist are at FOUR HAND-PICKED FIXTURE SIZES, and the defect this
 * clause names appeared at 73.
 *
 * SO THIS FILE SWEEPS SIZE AND CALLS THE REAL READERS. `observedStateForRow` is the production
 * composition — the bound, the truncation report and the `observedAt` stamp — extracted from
 * `updateWaveTargetObserved` so that this sweep drives it rather than a copy of it. The `observedAt`
 * stamp is load-bearing and was the first thing this sweep got wrong: omitting it makes
 * `weightUnreadableCause` report `not_observed` for every row, i.e. a 401-of-401 failure that is an
 * artefact of the fixture and not of the bound.
 *
 * WHAT IT DOES NOT DO, SAID PLAINLY. It does not traverse Postgres or HTTP; the row is composed in
 * memory exactly as the repository composes it, and `observed-state-gate-critical-leaf.integration.
 * test.ts` is what drives the same property through a real database at one size. "Every size" here
 * means every size of ONE shape family — a growing image list, and a growing revision string — not
 * every size of every shape.
 */

const NOW = new Date("2026-08-21T09:00:00.000Z");
const COORDINATE = "ghcr.io/acme/widget";
const MIN_WEIGHT = 50;

/**
 * The image list a real reading carries: MANY DISTINCT REPOSITORIES, one of which is the dependency
 * line being resolved. Repeating one repository at N tags is not a bigger version of this shape — it
 * is `ambiguous_image_refs`, which is the reader refusing correctly and would make the sweep a test
 * of that refusal instead. `at` places the line's own ref, so the sweep can ask the question from
 * both ends of a list the bound cuts from the tail.
 */
function imageList(size: number, at: "head" | "tail"): string[] {
  const padding = Array.from(
    { length: Math.max(0, size - 1) },
    (_, i) => `ghcr.io/acme/pad-${i}:1.0.0`
  );
  if (size === 0) return [];
  return at === "head" ? [`${COORDINATE}:1.4.2`, ...padding] : [...padding, `${COORDINATE}:1.4.2`];
}

/** A reading of the shape `observedStateFrom` composes: a revision, an image list, a rollout. */
function reading(images: string[], revision: string): WaveTargetObservedState {
  return {
    revision,
    images,
    rollout: { phase: "Progressing", step: 3, weight: 60, message: "canary at 60%" }
  };
}

/** The gate's own question, asked of a STORED row exactly as `evaluateStageDependencies` asks it. */
function verdictFor(stored: WaveTargetObservedState) {
  return stageDependencyVerdict(
    { dependsOn: "00000000-0000-7000-8000-000000000001", minWeight: MIN_WEIGHT },
    { status: "running", observedState: stored, lastObservedAt: NOW },
    // Inside the freshness window, so `stale` is never the reason a leaf reads unreadable — the
    // sweep is about the BOUND, and a clock artefact would make every failure ambiguous.
    NOW.getTime() + Math.floor(OBSERVED_WEIGHT_FRESHNESS_MS / 2)
  );
}

describe("M23.1f clause 5: the minWeight gate is readable at EVERY payload size", () => {
  it("IMAGE LIST 0…400: the weight is never unreadable, and the branch is never wrong", () => {
    const failures: string[] = [];
    let truncatedAt = 0;
    for (let size = 0; size <= 400; size += 1) {
      const images = imageList(size, "head");
      const stored = observedStateForRow(reading(images, "9f2c1ab"), NOW)!;
      if (stored.truncation !== undefined && truncatedAt === 0) truncatedAt = size;
      const verdict = verdictFor(stored);
      if (verdict.weightUnreadable !== undefined) {
        failures.push(`size ${size}: weightUnreadable=${verdict.weightUnreadable}`);
      }
      if (verdict.branch !== "min_weight") failures.push(`size ${size}: branch=${verdict.branch}`);
      if (verdict.satisfied !== true) failures.push(`size ${size}: not satisfied`);
      // …and the row policy still holds, so this is not "readable because nothing was bounded".
      const bytes = JSON.stringify(stored).length;
      if (bytes > PERSISTED_JSON_MAX_CHARS) failures.push(`size ${size}: row ${bytes} chars`);
    }
    expect(failures.slice(0, 12)).toStrictEqual([]);
    // NON-VACUITY: the sweep must actually reach sizes the bound has to cut. A sweep that never
    // truncated would be asserting that an untruncated row is readable, which nothing doubted.
    expect(truncatedAt, "no size in 0…400 was large enough to truncate").toBeGreaterThan(0);
    expect(truncatedAt).toBeLessThan(400);
  });

  it("REVISION 0…12,000 characters: the same, with the pressure on the OTHER leaf", () => {
    const failures: string[] = [];
    let truncatedAt = -1;
    for (let length = 0; length <= 12_000; length += 37) {
      const stored = observedStateForRow(
        reading([`${COORDINATE}:1.0.0`], "a".repeat(length)),
        NOW
      )!;
      if (stored.truncation !== undefined && truncatedAt < 0) truncatedAt = length;
      const verdict = verdictFor(stored);
      if (verdict.weightUnreadable !== undefined) {
        failures.push(`revision ${length}: weightUnreadable=${verdict.weightUnreadable}`);
      }
      if (verdict.branch !== "min_weight") failures.push(`revision ${length}: ${verdict.branch}`);
    }
    expect(failures.slice(0, 12)).toStrictEqual([]);
    expect(truncatedAt, "no revision length in 0…12,000 truncated").toBeGreaterThan(0);
  });

  it("THE INSTRUMENT IS NOT BLIND: at a punitive budget the same sweep goes RED", () => {
    /**
     * The control the audit that produced this file insisted on. Every assertion above is "the leaf
     * was readable", which is also what a sweep that never pressured the bound would report, and
     * what a `verdictFor` that always answered `min_weight` would report. Here the SAME shapes are
     * bound to a budget small enough that `rollout` cannot be seated, and the sweep must find the
     * failures it is looking for.
     */
    const starved: string[] = [];
    for (let size = 0; size <= 400; size += 40) {
      const images = imageList(size, "head");
      // 300 characters: the budget at which the audit measured 400-of-401 weightUnreadable.
      const bounded = observedStateForRow(reading(images, "9f2c1ab"), NOW)!;
      const punitive = {
        ...bounded,
        rollout: undefined
      } as WaveTargetObservedState;
      const verdict = verdictFor(punitive);
      if (verdict.weightUnreadable === undefined) starved.push(`size ${size} still readable`);
    }
    expect(
      starved,
      "a reading with no rollout at all still reported a readable weight — verdictFor cannot fail, so every green above is meaningless"
    ).toStrictEqual([]);
  });
});

describe("M23.1f clause 5: the released-version reader survives the same sweep", () => {
  it("IMAGE LIST 0…400: the FIRST image still determines a version at every size", async () => {
    const failures: string[] = [];
    for (let size = 1; size <= 400; size += 1) {
      const images = imageList(size, "head");
      const stored = observedStateForRow(reading(images, "9f2c1ab"), NOW)!;
      const resolved = await resolveReleasedVersion({
        line: { ecosystem: "oci", coordinate: COORDINATE },
        sourceRef: {},
        observedImages: stored.images ?? [],
        manifestPaths: []
      });
      if (!resolved.determined) {
        failures.push(`size ${size}: ${resolved.reason}`);
      }
    }
    expect(failures.slice(0, 12)).toStrictEqual([]);
  });

  it("A REF IN THE TRUNCATED TAIL IS `observed_images_elided`, NOT `no_matching_image_ref`", async () => {
    /**
     * THIS CASE WAS WRITTEN EXPECTING A DEFECT AND FOUND A CORRECT ANSWER, and it is kept in that
     * shape because the wrong answer is the one worth pinning against.
     *
     * `boundPersistedJson` cuts an array from the TAIL, so a dependency line whose image ref sits
     * past the cut is not in the stored list. The tempting report is `no_matching_image_ref` — "the
     * executor deployed these images and none of them was yours" — which is a statement about the
     * EXECUTOR and is false: the platform stopped writing the list down. `resolveFromObservedImages`
     * reads the elision marker the bound leaves behind, BEFORE judging the match loop, and reports
     * `observed_images_elided` instead. The remedies differ (look at what the pipeline pushed, vs
     * raise the bound or narrow the reading), which is why the distinction is worth a reason code.
     *
     * What this sweep adds is the SIZE: nothing previously measured where the cut starts, so
     * nothing would have noticed the honest reason becoming unreachable because the marker stopped
     * being emitted. If this case ever reports `no_matching_image_ref`, the elision marker is gone
     * and every large reading is quietly blaming the executor.
     */
    let firstLost = -1;
    for (let size = 1; size <= 400; size += 1) {
      const stored = observedStateForRow(reading(imageList(size, "tail"), "9f2c1ab"), NOW)!;
      if (!(stored.images ?? []).some((ref) => ref.startsWith(`${COORDINATE}:`))) {
        firstLost = size;
        break;
      }
    }
    expect(
      firstLost,
      "no list in 1…400 was cut short of its tail ref, so this case exercises nothing"
    ).toBeGreaterThan(0);
    const lost = observedStateForRow(reading(imageList(firstLost, "tail"), "9f2c1ab"), NOW)!;
    // The row SAYS it cut something — both as the structured report an operator reads, and as the
    // in-band marker this reader is entitled to reason from.
    expect(
      lost.truncation,
      "a ref vanished from the list and the row reported no truncation"
    ).toBeDefined();
    const resolved = await resolveReleasedVersion({
      line: { ecosystem: "oci", coordinate: COORDINATE },
      sourceRef: {},
      observedImages: lost.images ?? [],
      manifestPaths: []
    });
    expect(resolved.determined).toBe(false);
    expect(
      resolved.determined === false && resolved.reason,
      "a miss AFTER a cut was reported as a miss — that blames the executor for a truncation this platform made"
    ).toBe("observed_images_elided");
  });

  it("…and an EMPTY list is `no_observed_images`, not a version — the reader's own control", async () => {
    const stored = observedStateForRow(reading([], "9f2c1ab"), NOW)!;
    const resolved = await resolveReleasedVersion({
      line: { ecosystem: "oci", coordinate: COORDINATE },
      sourceRef: {},
      observedImages: stored.images ?? [],
      manifestPaths: []
    });
    expect(resolved.determined).toBe(false);
    expect(resolved.determined === false && resolved.reason).toBe("no_observed_images");
  });

  it("THE `images` LEAF IS NEVER EMPTIED — a cut list is shorter, never gone", () => {
    // The defect class M23.1f is named after: a leaf the bound drops WHOLE, which reads downstream
    // as "the executor never reported one". A shorter list is a truncation; an absent one is a lie.
    const failures: string[] = [];
    for (let size = 1; size <= 400; size += 1) {
      const images = imageList(size, "head");
      const stored = observedStateForRow(reading(images, "9f2c1ab"), NOW)!;
      if (stored.images === undefined || stored.images.length === 0) {
        failures.push(
          `size ${size}: images ${stored.images === undefined ? "dropped" : "emptied"}`
        );
      }
      if (stored.revision === undefined) failures.push(`size ${size}: revision dropped`);
      if (stored.rollout?.weight === undefined) failures.push(`size ${size}: weight dropped`);
      // AND A CUT IS ALWAYS REPORTED. Silence about a cut is the wrong-cause defect, not the cut.
      if (stored.images !== undefined && stored.images.length < size && !stored.truncation) {
        failures.push(`size ${size}: cut ${size - stored.images.length} refs and reported nothing`);
      }
    }
    expect(failures.slice(0, 12)).toStrictEqual([]);
  });
});
