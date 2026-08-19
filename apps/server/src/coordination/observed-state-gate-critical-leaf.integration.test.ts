import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import { PERSISTED_JSON_MAX_CHARS, isPersistedJsonEntriesElision } from "@scp/runner-launcher";
import { v7 as uuidv7 } from "uuid";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  waitUntil,
  type ListeningTestServer
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { changeWaveTargets } from "../db/schema.js";
import { stageDependencyVerdict } from "./stage-dependency-hold.js";
import { observedImagesOf } from "../dependencies/internal-release-detection.js";
import { resolveReleasedVersion } from "../dependencies/internal-release-version.js";

/**
 * MEDIUM (M23.0 verification pass 8) — THE BOUND SPENT ITS BUDGET IN INSERTION ORDER, AND THE FIELD
 * TWO GATES READ WAS WRITTEN LAST.
 *
 * `observedStateFrom` composes `{revision, images, rollout}` in that order. The persisted-JSON walk
 * charged each field as it went and, once the remainder fell under its per-leaf minimum, replaced
 * every still-unwalked field with `__scpElided` — so `rollout`, always last, was always the first
 * thing dropped. Measured through this same seam before the fix, with 80 image refs and a canary at
 * weight 60:
 *
 *   before  images, rollout, revision, observedAt      weight 60   min_weight         satisfied TRUE
 *   after   images, revision, observedAt, __scpElided  undefined   weight_unreadable  satisfied FALSE
 *
 * ============================================================================================
 * WHY THIS FILE EXISTS SEPARATELY FROM `persisted-json-bound.test.ts`
 * ============================================================================================
 * A LENGTH ASSERTION ON THE ROW CANNOT SEE THIS DEFECT — which is exactly how it shipped. The row
 * got SMALLER (8 701 -> 7 926 bytes) and every bound the previous round asserted stayed true; what
 * changed was WHICH KEY was in it. So the assertions here are made THROUGH THE GATE FUNCTIONS, over
 * a row a real executor plugin really produced and real Postgres really stored:
 *
 *   consequence 1  `stageDependencyVerdict` (`stage-dependency-hold.ts`) reads
 *                  `observed_state.rollout.weight`. Absent -> `no_weight` -> `weight_unreadable` ->
 *                  the dependency degrades to the universal `succeeded` test and HOLDS. Fail-closed,
 *                  so nothing wrong ships — but ADR-0028's headline case (`minWeight`, "release
 *                  while the dependency is still rolling out") stops working for exactly the large
 *                  applications it exists for, a correct configuration waits indefinitely, and the
 *                  recorded cause BLAMES THE EXECUTOR: `no_weight` is documented as "a non-ArgoCD
 *                  executor, or a blue/green Rollout". A wrong provenance label on a Decision is its
 *                  own defect here (charter principle 6).
 *   consequence 2  `resolveReleasedVersion` (`internal-release-version.ts`) scans
 *                  `observed_state.images` for the ref whose repository is a dependency line's
 *                  coordinate. Past the threshold the tail becomes a marker, and a matching ref in
 *                  the dropped tail used to yield `no_matching_image_ref` — the internal release's
 *                  `latest_version` never determined, dependants never bumped. Fail-SILENT.
 *
 * ============================================================================================
 * WHY THE FIXTURE IS NOT HOSTILE INPUT
 * ============================================================================================
 * `status.summary.images` on an Argo CD Application is the image list across every managed
 * resource, uncapped. An umbrella app with 73+ images that contains a Rollout is ordinary, and 73
 * is the measured threshold. A long `revision` does NOT reach it — each string is separately capped
 * — so an array is the only route in, which is why reading the code did not surface it.
 *
 * ============================================================================================
 * MUTATION LOG — applied, watched fail, reverted, watched pass
 * ============================================================================================
 * | Mutation | Result |
 * |---|---|
 * | `walkField(...)` -> a plain `walk(...)` in `@scp/runner-launcher` — the share, deleted | CONSEQUENCE 1 FAILS: `rollout` is gone, the verdict is `weight_unreadable`, `satisfied` is false |
 * | `boundPluginJson` -> `boundPersistedJson(value, 400)` | CONSEQUENCE 1 FAILS: at that budget `rollout` cannot be seated at all |
 * | `const elided = false` in `resolveFromObservedImages` | CONSEQUENCE 2 FAILS: back to `no_matching_image_ref` |
 * | `walkObjectFields`' pass-2 redistribution loop, deleted | CONSEQUENCE 3 FAILS: `expected 36 to be 50` (35 refs plus the cut marker), and with that assertion lifted, `index 49 did not resolve: expected { determined: false, … }` — the fail-silent path itself. CONSEQUENCES 1 AND 2 STAY GREEN, which is the blindness this arm exists to remove |
 * | The HALVING restored in `boundStringToCost` (`width = Math.floor(width / 2)`) | CONSEQUENCE 4 FAILS: `the revision stored roughly half of the share it was given: expected 1950 to be greater than 3000` — 1 950 of 4 099, row 5 917 (74.0 %). CONSEQUENCES 1, 2 AND 3 STAY GREEN, because none of them varies a STRING |
 * | `stateRefByTarget` dropped from the fake executor's `status()` | CONSEQUENCE 4 FAILS with `expected 2 to be greater than 3000` — the revision is back to `v0`. That is the seam itself: without it this arm measures the hardcoded version string, which is the state four rounds ran in |
 *
 * NEITHER OF THE FIRST TWO REDDENS CONSEQUENCE 2, and that is correct rather than a gap: shrinking
 * the budget moves WHERE the cut falls, and both of that arm's coordinates stay on their own side of
 * it — the one at index 0 survives, the one at index 79 does not. That arm is about the REASON a
 * miss is reported under, so its mutation is the third row. Conversely `const elided = false` leaves
 * consequence 1 green, because the weight has nothing to do with how a missing ref is explained. Two
 * defects, two levers, one row.
 *
 * ============================================================================================
 * CONSEQUENCE 3 AND WHY IT IS A SECOND TARGET RATHER THAN A SECOND ASSERTION — HIGH, PASS 9
 * ============================================================================================
 * The fix above shipped the share as a CEILING with unspent budget flowing forward only, and
 * `images` sits in the MIDDLE of `{revision, images, rollout}`: it was capped at ~1/2 the budget
 * while `revision` + `rollout` spent ~110 of the ~3 950 they were handed, and those characters were
 * never returned. That broke a window that had NEVER been broken — every list of roughly 35…69 refs,
 * which FITS the budget whole and was previously stored whole:
 *
 *   n = 50, raw 5 787 chars       pass 7   50/50 kept   index 49 -> determined, 1.2.3
 *                                 pass 8   34/50 kept   index 49 -> observed_images_elided
 *                                 pass 9   50/50 kept   index 49 -> determined, 1.2.3
 *
 * THE 80-REF TARGET ABOVE CANNOT SEE IT. At 80 both designs truncate, and both leave the coordinate
 * at index 79 in the dropped tail, so every assertion in this file stayed green while the population
 * of applications where internal-release detection silently stops roughly DOUBLED (the threshold
 * moved from 70 refs to 35). A second target, sized inside the window, is the only fixture that
 * distinguishes them.
 *
 * ============================================================================================
 * CONSEQUENCE 4 AND THE STRUCTURAL REASON FOUR ROUNDS RAN BLIND — MEDIUM, PASS 10
 * ============================================================================================
 * Every arm above varies ONE thing: `imagesByTarget`, an ARRAY. That was not a choice. The fake
 * executor's `status()` hardcoded `stateRef` to `v${target.version}` and `detail` never enters
 * `observed_state`, so of the four hooks the plugin exposed — `imagesByTarget`, `rolloutByTarget`,
 * `detailByTarget`, `forcePhase` — an array was the ONLY free-form field this harness could put
 * into that column.
 *
 * The persisted-JSON bound cuts an array and a string by DIFFERENT rules (entries dropped from the
 * tail vs. a per-string width bound), so every string-shaped defect in it was unreachable end to end
 * BY CONSTRUCTION — and one lived there for three rounds: `boundStringToCost` recovered the two
 * characters `JSON.stringify` spends on quotes by HALVING the width, storing half of every share.
 *
 * The fix is a seam, not another fixture: `stateRefByTarget`, mirroring the other three hooks, so
 * `observed_state.revision` is something a test can vary. Consequence 4 drives it.
 */

/** The shape Argo CD reports for a deployed workload — a tag AND the digest it resolved to. 80 of
 *  these is 8 697 raw characters, i.e. over the whole-value budget on their own. */
const IMAGE_REF_COUNT = 80;
const imageRefs = Array.from(
  { length: IMAGE_REF_COUNT },
  (_, i) => `ghcr.io/acme/platform/service-${i}:1.2.3@sha256:${"a".repeat(64)}`
);
const repositoryOf = (i: number) => `ghcr.io/acme/platform/service-${i}`;

/**
 * INSIDE THE WINDOW: many enough refs that a HALF-budget ceiling cuts the list (the pass-8 cap was
 * ~3 950 characters and `images` alone is ~5 640 here), few enough that the WHOLE value fits in
 * 8 000 and nothing should be cut at all. Both halves are asserted in `beforeAll` rather than
 * trusted — a fixture that drifted out of the window on either side would make consequence 3 green
 * for the wrong reason.
 */
const WINDOW_REF_COUNT = 50;
const windowImageRefs = imageRefs.slice(0, WINDOW_REF_COUNT);

/** A canary mid-rollout. `weight` is the leaf ADR-0028's `minWeight` gate reads; `step` is beside it
 *  so a fix that kept the key but emptied it is not silently green. */
const ROLLOUT = { phase: "Progressing", step: 3, weight: 60, message: "canary at 60%" };

/**
 * THE STRING-SHAPED READING, which this harness could not produce until pass 10.
 *
 * An Argo CD MULTI-SOURCE application reports one revision per source and the executor joins them —
 * `observe.ts`'s own dedup comment documents `stateRef: "7d34ef12+ff3fd8a3"` for exactly this shape.
 * 100 sources is 4 099 characters. Not hostile input: an umbrella app with a source per component.
 *
 * `observedStateFrom` puts this on `observed_state.revision`, so it is a STRING competing with
 * `images` (an ARRAY) and `rollout` (an OBJECT) for the same 8 000 characters — the production
 * composition, in the one shape no fixture in this repository had ever driven end to end.
 */
const MULTI_SOURCE_COUNT = 100;
const MULTI_SOURCE_REVISION = Array.from({ length: MULTI_SOURCE_COUNT }, (_, i) =>
  (i.toString(16).padStart(8, "0") + "9f2c1ab4e77d0c31a5b8e6f2c9d4a1b3e5f7").slice(0, 40)
).join("+");

describe("observed_state: a large `images` array may not cost the leaves the gates read", () => {
  let server: ListeningTestServer;
  const targetId = uuidv7();
  const windowTargetId = uuidv7();
  const stringTargetId = uuidv7();

  beforeAll(async () => {
    // NON-VACUITY, ASSERTED BEFORE THE SERVER BOOTS: if the fixture ever stopped overflowing the
    // budget, everything below would pass for the wrong reason — the mode this repository has
    // shipped before (a green suite whose fixture silently never applied).
    expect(
      JSON.stringify({ revision: "v1", images: imageRefs, rollout: ROLLOUT }).length
    ).toBeGreaterThan(PERSISTED_JSON_MAX_CHARS);

    // AND THE WINDOW FIXTURE IS INSIDE THE WINDOW, both edges. Over half the budget, so a ceiling
    // cuts it; under the whole budget, so nothing should be cut. Either edge drifting silently makes
    // consequence 3 a test of a different case than the one it names.
    const windowRaw = JSON.stringify({
      revision: "v1",
      images: windowImageRefs,
      rollout: ROLLOUT
    }).length;
    expect(windowRaw).toBeLessThan(PERSISTED_JSON_MAX_CHARS);
    expect(windowRaw).toBeGreaterThan(PERSISTED_JSON_MAX_CHARS / 2);

    // AND THE STRING FIXTURE OVERFLOWS ON ITS OWN, with the revision alone over the one-third share
    // three fields divide the budget into. Either edge drifting makes consequence 4 a test of a
    // string that simply fitted.
    expect(
      JSON.stringify({
        revision: MULTI_SOURCE_REVISION,
        images: windowImageRefs,
        rollout: ROLLOUT
      }).length
    ).toBeGreaterThan(PERSISTED_JSON_MAX_CHARS);
    expect(MULTI_SOURCE_REVISION.length).toBeGreaterThan(PERSISTED_JSON_MAX_CHARS / 3);

    server = await listenTestServer({
      withEventRelay: true,
      withReconcileLoop: true,
      fakeExecutorConfig: {
        // HELD NON-TERMINAL ON PURPOSE. `stageDependencyVerdict` short-circuits on
        // `status = 'succeeded'` — the universal test — so a succeeded row would never reach the
        // `minWeight` branch at all and the arm would be vacuous. `running` makes reconcile write
        // `observing`, which is the state a dependency mid-canary is actually in.
        forcePhase: {
          [targetId]: "running",
          [windowTargetId]: "running",
          [stringTargetId]: "running"
        },
        imagesByTarget: {
          [targetId]: imageRefs,
          [windowTargetId]: windowImageRefs,
          [stringTargetId]: windowImageRefs
        },
        rolloutByTarget: {
          [targetId]: ROLLOUT,
          [windowTargetId]: ROLLOUT,
          [stringTargetId]: ROLLOUT
        },
        // THE SEAM ADDED FOR THIS ARM (`packages/plugins/fake-executor`). `status().stateRef` was
        // hardcoded to `v${target.version}` and `detail` never reaches `observed_state`, so before
        // this key the ONLY free-form field this harness could vary in that column was an array.
        stateRefByTarget: { [stringTargetId]: MULTI_SOURCE_REVISION }
      }
    });
  });

  afterAll(async () => {
    await server?.close();
  });

  /** The persisted row for a target, once reconcile has polled it at least once. */
  async function observedRow(orgId: string, forTargetId: string) {
    return waitUntil(
      async () => {
        const rows = await withTenantTx(server.deps.db, orgId, (tx) =>
          tx
            .select()
            .from(changeWaveTargets)
            .where(
              and(
                eq(changeWaveTargets.orgId, orgId),
                eq(changeWaveTargets.targetObjectId, forTargetId)
              )
            )
        );
        return rows.find((r) => r.observedState !== null);
      },
      { describe: `an observed_state for ${forTargetId}`, timeoutMs: 30_000 }
    );
  }

  let orgId: string;
  let row: Awaited<ReturnType<typeof observedRow>>;
  let windowRow: Awaited<ReturnType<typeof observedRow>>;
  let stringRow: Awaited<ReturnType<typeof observedRow>>;

  beforeAll(async () => {
    const org = await createTestOrg(server, "observed-gate-leaves");
    orgId = org.orgId;
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const target = await createTestComponent(admin, {
      id: targetId,
      name: "observed-gate-leaves-target"
    });
    expect(target.id).toBe(targetId);
    await admin.changes.propose({
      name: "a change whose executor reports 80 images and a canary",
      targets: [targetId]
    });
    row = await observedRow(orgId, targetId);

    const windowTarget = await createTestComponent(admin, {
      id: windowTargetId,
      name: "observed-gate-window-target"
    });
    expect(windowTarget.id).toBe(windowTargetId);
    await admin.changes.propose({
      name: `a change whose executor reports ${WINDOW_REF_COUNT} images and a canary`,
      targets: [windowTargetId]
    });
    windowRow = await observedRow(orgId, windowTargetId);

    const stringTarget = await createTestComponent(admin, {
      id: stringTargetId,
      name: "observed-gate-string-target"
    });
    expect(stringTarget.id).toBe(stringTargetId);
    await admin.changes.propose({
      name: `a change whose executor reports a ${MULTI_SOURCE_COUNT}-source revision`,
      targets: [stringTargetId]
    });
    stringRow = await observedRow(orgId, stringTargetId);
  });

  it("CONSEQUENCE 1: `stageDependencyVerdict` still reads the weight off the bounded row", () => {
    // The row really was bounded — otherwise this arm is about an unbounded payload, not about the
    // budget's allocation.
    const persisted = JSON.stringify(row.observedState);
    expect(persisted.length).toBeLessThanOrEqual(PERSISTED_JSON_MAX_CHARS);
    expect(persisted.length).toBeLessThanOrEqual(8_000);
    // And the images array really was cut, so `rollout` really was competing for the last of it.
    const images = observedImagesOf(row.observedState);
    expect(images.length).toBeLessThan(IMAGE_REF_COUNT);

    // THE LEVER, NOT THE SIGNAL. This is the real gate function over the real row: a length
    // assertion on `row.observedState` is blind to the defect, because the defect made the row
    // SMALLER while changing which key was in it.
    expect(row.status).not.toBe("succeeded"); // else the universal test short-circuits the gate
    const verdict = stageDependencyVerdict(
      { dependsOn: "dependency-b", minWeight: 50 },
      { status: row.status, observedState: row.observedState, lastObservedAt: row.lastObservedAt },
      Date.now()
    );
    expect(verdict.satisfied).toBe(true);
    expect(verdict.branch).toBe("min_weight");
    // Named explicitly: `weight_unreadable`/`no_weight` is what the defect produced, and it reads as
    // an executor fault rather than as the bound.
    expect(verdict.weightUnreadable).toBeUndefined();
  });

  it("CONSEQUENCE 2: a ref past the cut is `observed_images_elided`, not the executor's fault", async () => {
    const recorded = observedImagesOf(row.observedState);
    // The reader keeps the truncation marker, and that is what makes the distinction below
    // possible — see `observedImagesOf`.
    expect(recorded.length).toBeGreaterThan(1);
    const kept = recorded.filter((r) => r.startsWith("ghcr.io/"));
    expect(kept.length).toBeLessThan(IMAGE_REF_COUNT); // the list really was cut

    // THE POSITIVE CONTROL FIRST: a coordinate whose ref survived the cut still determines a
    // version. Without this, an implementation that refused everything would pass the arm below.
    const survived = await resolveReleasedVersion({
      line: { ecosystem: "oci", coordinate: repositoryOf(0) },
      sourceRef: {},
      observedImages: recorded,
      manifestPaths: []
    });
    expect(survived).toMatchObject({ determined: true, version: "1.2.3" });

    // AND THE ONE THE DEFECT WAS ABOUT: a coordinate whose ref is in the DROPPED TAIL. Non-vacuity
    // first — it must actually be absent from what was recorded, or this asserts nothing.
    const droppedRepo = repositoryOf(IMAGE_REF_COUNT - 1);
    expect(kept.some((r) => r.startsWith(`${droppedRepo}:`))).toBe(false);
    const dropped = await resolveReleasedVersion({
      line: { ecosystem: "oci", coordinate: droppedRepo },
      sourceRef: {},
      observedImages: recorded,
      manifestPaths: []
    });
    expect(dropped).toMatchObject({ determined: false, reason: "observed_images_elided" });
  });

  /**
   * CONSEQUENCE 3 (HIGH, pass 9) — A LIST THAT FITS THE BUDGET IS STORED WHOLE, and the coordinate
   * at the very END of it still determines a version.
   *
   * This is the window the pass-8 ceiling broke and no arm in this file could see: at 50 refs the
   * whole reading is 5 787 characters, comfortably inside 8 000, and was stored verbatim before
   * pass 8 and after pass 9 — but pass 8 capped `images` at ~1/2 the budget and kept 34, putting
   * index 49 in a dropped tail. `resolveReleasedVersion` then returns `determined: false`,
   * `latest_version` is never determined, and dependants are never bumped. Fail-SILENT, on a
   * configuration that had always worked.
   *
   * DELETE-THE-WIRING: remove the pass-2 redistribution loop from `walkObjectFields` and this arm
   * fails on the first assertion (34 of 50) — while every arm above stays green.
   */
  it("CONSEQUENCE 3: a list that FITS is not truncated, and its last coordinate resolves", async () => {
    const recorded = observedImagesOf(windowRow.observedState);
    // NOTHING WAS CUT. Stated as the exact count rather than "greater than 34", so a future budget
    // change that quietly starts trimming this list cannot pass by staying above the old defect.
    expect(recorded.length).toBe(WINDOW_REF_COUNT);
    expect(recorded.some((r) => isPersistedJsonEntriesElision(r))).toBe(false);
    // Byte-for-byte what the executor reported, in order — the strongest form of "not truncated",
    // and it also catches a per-STRING bound that shortened each ref instead of dropping any.
    expect(recorded).toEqual(windowImageRefs);

    // AND THE ROW REALLY WENT THROUGH THE BOUND rather than round-tripping some other way.
    const persisted = JSON.stringify(windowRow.observedState);
    expect(persisted.length).toBeLessThanOrEqual(PERSISTED_JSON_MAX_CHARS);
    // Over half the budget: this is the fixture the pass-8 ceiling cut, not a small one that would
    // have survived any allocation policy.
    expect(persisted.length).toBeGreaterThan(PERSISTED_JSON_MAX_CHARS / 2);

    // THE LEVER. The coordinate at the END of the list is the one pass 8 lost; index 0 is the
    // positive control that an implementation refusing everything would fail.
    for (const index of [0, WINDOW_REF_COUNT - 1]) {
      const resolved = await resolveReleasedVersion({
        line: { ecosystem: "oci", coordinate: repositoryOf(index) },
        sourceRef: {},
        observedImages: recorded,
        manifestPaths: []
      });
      expect(resolved, `index ${index} did not resolve`).toMatchObject({
        determined: true,
        version: "1.2.3"
      });
    }

    // The leaf the other gate reads is untouched by any of this — the two properties compose rather
    // than trading off, which is the thing a redistribution pass could plausibly have broken.
    const verdict = stageDependencyVerdict(
      { dependsOn: "dependency-b", minWeight: 50 },
      {
        status: windowRow.status,
        observedState: windowRow.observedState,
        lastObservedAt: windowRow.lastObservedAt
      },
      Date.now()
    );
    expect(verdict.satisfied).toBe(true);
    expect(verdict.branch).toBe("min_weight");
  });

  /**
   * CONSEQUENCE 4 (MEDIUM, pass 10) — THE STRING PATH, WHICH THIS HARNESS COULD NOT REACH.
   *
   * `observedStateFrom` composes `{revision, images, rollout}`: a STRING, an ARRAY and an OBJECT.
   * The persisted-JSON bound cuts the three by DIFFERENT rules — an array by dropping entries, a
   * string by a per-string width bound — and until pass 10 the fake executor hardcoded
   * `status().stateRef` to `v${target.version}` and never put `detail` into `observed_state`. So
   * `imagesByTarget` was the only free-form field this file could vary, the array rule was the only
   * one under test, and the string rule was unreachable END TO END BY CONSTRUCTION.
   *
   * What lived there: `boundStringToCost` recovered the two characters `JSON.stringify` spends on
   * quotes by HALVING the width, so every string stored half of what it was given. Over this exact
   * row, with a 4 099-character multi-source revision beside 50 image refs and a canary:
   *
   *   halving   revision 1 950 of 4 099   row 5 917   (74.0 % of the budget)
   *   search    revision 3 898 of 4 099   row 7 865   (98.3 %)
   *
   * A revision is what an operator reads to answer "which commit is actually deployed", and it is
   * the discriminator `observe.ts` dedupes multi-source Argo CD events on. Half of it is not half
   * an answer.
   *
   * THIS ARM IS ALSO THE STRING-SHAPED UTILISATION ASSERTION, over a row a real plugin produced and
   * real Postgres stored — the unit file's equivalent is `persisted-json-bound.test.ts` ->
   * "BUDGET UTILISATION, STRING-SHAPED".
   */
  it("CONSEQUENCE 4: a long revision keeps its whole share, and the other two gates still read the same row", async () => {
    const observed = stringRow.observedState as {
      revision?: string;
      images?: string[];
      rollout?: { weight?: number };
    };

    // THE STRING PATH. Measured 3 898 of 4 099; 1 950 under the halving. The threshold sits between
    // them so the arm reddens on the defect without pinning a byte count an elision marker's
    // wording could move.
    expect(typeof observed.revision).toBe("string");
    expect(
      observed.revision!.length,
      "the revision stored roughly half of the share it was given"
    ).toBeGreaterThan(3_000);
    // NON-VACUITY: it really was cut, so the arm is about the bound and not about a string that fit.
    expect(observed.revision!.length).toBeLessThan(MULTI_SOURCE_REVISION.length);
    // AND IT IS THE EXECUTOR'S REVISION, cut in the middle — both ends kept, which is what makes a
    // truncated revision still recognisable to the operator reading the row. A bound that stored
    // some other string of the right length would pass the length assertion alone.
    expect(observed.revision!.startsWith(MULTI_SOURCE_REVISION.slice(0, 500))).toBe(true);
    expect(observed.revision!.endsWith(MULTI_SOURCE_REVISION.slice(-500))).toBe(true);

    // UTILISATION, STRING-SHAPED, ON A REAL ROW. 7 906 of 8 000 measured (the payload plus the
    // server-stamped `observedAt`); 5 958 under the halving.
    const persisted = JSON.stringify(stringRow.observedState);
    expect(persisted.length).toBeLessThanOrEqual(PERSISTED_JSON_MAX_CHARS);
    expect(persisted.length / PERSISTED_JSON_MAX_CHARS).toBeGreaterThan(0.9);

    // THE OTHER TWO GATES, ON THE SAME ROW. A large string sibling must not cost them their leaves
    // any more than a large array sibling does — the properties compose rather than trade off.
    expect(stringRow.status).not.toBe("succeeded");
    const verdict = stageDependencyVerdict(
      { dependsOn: "dependency-b", minWeight: 50 },
      {
        status: stringRow.status,
        observedState: stringRow.observedState,
        lastObservedAt: stringRow.lastObservedAt
      },
      Date.now()
    );
    expect(verdict.satisfied).toBe(true);
    expect(verdict.branch).toBe("min_weight");
    expect(verdict.weightUnreadable).toBeUndefined();

    const recorded = observedImagesOf(stringRow.observedState);
    expect(recorded.length).toBeGreaterThan(1);
    const resolved = await resolveReleasedVersion({
      line: { ecosystem: "oci", coordinate: repositoryOf(0) },
      sourceRef: {},
      observedImages: recorded,
      manifestPaths: []
    });
    expect(resolved).toMatchObject({ determined: true, version: "1.2.3" });
  });
});
