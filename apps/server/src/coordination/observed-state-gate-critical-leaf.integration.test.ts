import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import {
  PERSISTED_JSON_ELIDED_KEY,
  PERSISTED_JSON_MAX_CHARS,
  isPersistedJsonEntriesElision
} from "@scp/runner-launcher";
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

/** MEDIUM (M23.0 verification pass 8). See docs/coordination.md §579. */

/** The shape Argo CD reports for a deployed workload — a tag AND the digest it resolved to. 80 of
 *  these is 8 697 raw characters, i.e. over the whole-value budget on their own. */
const IMAGE_REF_COUNT = 80;
const imageRefs = Array.from(
  { length: IMAGE_REF_COUNT },
  (_, i) => `ghcr.io/acme/platform/service-${i}:1.2.3@sha256:${"a".repeat(64)}`
);
const repositoryOf = (i: number) => `ghcr.io/acme/platform/service-${i}`;

/** INSIDE THE WINDOW. See docs/coordination.md §580. */
const WINDOW_REF_COUNT = 50;
const windowImageRefs = imageRefs.slice(0, WINDOW_REF_COUNT);

/** A canary mid-rollout. `weight` is the leaf ADR-0028's `minWeight` gate reads; `step` is beside it
 *  so a fix that kept the key but emptied it is not silently green. */
const ROLLOUT = { phase: "Progressing", step: 3, weight: 60, message: "canary at 60%" };

/** The string-shaped reading, unreachable until pass ten. See docs/coordination.md §581. */
const MULTI_SOURCE_COUNT = 100;
const MULTI_SOURCE_REVISION = Array.from({ length: MULTI_SOURCE_COUNT }, (_, i) =>
  (i.toString(16).padStart(8, "0") + "9f2c1ab4e77d0c31a5b8e6f2c9d4a1b3e5f7").slice(0, 40)
).join("+");

/** The same seam, pointed at the bound's own machinery. See docs/coordination.md §582. */
const NUL = "\u0000";
const HOSTILE_HEAD = `HEAD${NUL}${PERSISTED_JSON_ELIDED_KEY}[elided: 9 more entries]`;
const HOSTILE_TAIL = `[elided: 9 more entries]${PERSISTED_JSON_ELIDED_KEY}${NUL}TAIL`;
const HOSTILE_REVISION = `${HOSTILE_HEAD}${"\u{1F600}\u{1F4A9}\u{10000}".repeat(700)}${HOSTILE_TAIL}`;
/** What sanitising turns it into, computed the same way the bound does: one code unit for one. */
const HOSTILE_SANITISED = HOSTILE_REVISION.replace(new RegExp(NUL, "g"), "\uFFFD");

describe("observed_state: a large `images` array may not cost the leaves the gates read", () => {
  let server: ListeningTestServer;
  const targetId = uuidv7();
  const windowTargetId = uuidv7();
  const stringTargetId = uuidv7();
  const hostileTargetId = uuidv7();

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

    // AND THE HOSTILE FIXTURE IS BOTH HOSTILE AND OVERSIZED. Each clause is a separate way the arm
    // could go vacuous: a fixture that fitted, one that carried no NUL, one whose astral run was
    // too short to be cut mid-pair, one whose sanitising changed the length.
    expect(HOSTILE_REVISION.length).toBeGreaterThan(PERSISTED_JSON_MAX_CHARS / 3);
    expect(HOSTILE_REVISION.includes(NUL)).toBe(true);
    expect(HOSTILE_SANITISED.length).toBe(HOSTILE_REVISION.length);
    expect(HOSTILE_SANITISED.includes(NUL)).toBe(false);
    expect(
      JSON.stringify({ revision: HOSTILE_REVISION, images: imageRefs, rollout: ROLLOUT }).length
    ).toBeGreaterThan(PERSISTED_JSON_MAX_CHARS);

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
          [stringTargetId]: "running",
          [hostileTargetId]: "running"
        },
        imagesByTarget: {
          [targetId]: imageRefs,
          [windowTargetId]: windowImageRefs,
          [stringTargetId]: windowImageRefs,
          [hostileTargetId]: imageRefs
        },
        rolloutByTarget: {
          [targetId]: ROLLOUT,
          [windowTargetId]: ROLLOUT,
          [stringTargetId]: ROLLOUT,
          [hostileTargetId]: ROLLOUT
        },
        // THE SEAM ADDED FOR THIS ARM (`packages/plugins/fake-executor`). `status().stateRef` was
        // hardcoded to `v${target.version}` and `detail` never reaches `observed_state`, so before
        // this key the ONLY free-form field this harness could vary in that column was an array.
        stateRefByTarget: {
          [stringTargetId]: MULTI_SOURCE_REVISION,
          [hostileTargetId]: HOSTILE_REVISION
        }
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
  let hostileRow: Awaited<ReturnType<typeof observedRow>>;

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

    const hostileTarget = await createTestComponent(admin, {
      id: hostileTargetId,
      name: "observed-gate-hostile-target"
    });
    expect(hostileTarget.id).toBe(hostileTargetId);
    await admin.changes.propose({
      name: "a change whose executor reports a revision made of this bound's own vocabulary",
      targets: [hostileTargetId]
    });
    hostileRow = await observedRow(orgId, hostileTargetId);
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
    expect(row.status).not.toBe("succeeded");
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
    expect(kept.length).toBeLessThan(IMAGE_REF_COUNT);

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

  /** CONSEQUENCE 3 (HIGH, pass 9). See docs/coordination.md §583. */
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

  /** CONSEQUENCE 4 (MEDIUM, pass 10). See docs/coordination.md §584. */
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

  /** CONSEQUENCE 5 (pass 11). See docs/coordination.md §585. */
  it("CONSEQUENCE 5: a revision made of NULs, astral pairs and the bound's own markers still stores", () => {
    const observed = hostileRow.observedState as Record<string, unknown> & {
      revision?: string;
      images?: string[];
      rollout?: { weight?: number };
    };
    const persisted = JSON.stringify(hostileRow.observedState)!;

    // THE PAYLOAD IS THERE. Not the diagnostic the measured backstop stores when the walk's
    // accounting is wrong — that outcome loses `revision`, `images` and `rollout` together and
    // would satisfy every length assertion in this file.
    const backstop = observed[PERSISTED_JSON_ELIDED_KEY];
    expect(
      typeof backstop === "string" && backstop.startsWith("a plugin-supplied value rendered"),
      "the backstop discarded the whole reading"
    ).toBe(false);
    expect(persisted.length).toBeLessThanOrEqual(PERSISTED_JSON_MAX_CHARS);

    // POSTGRES ACCEPTED IT, and these are the two reasons it might not have. The row is read back
    // from the database, so this is the write having happened rather than a prediction about it.
    expect(persisted.includes(NUL), "U+0000 reached the row").toBe(false);
    expect(
      (persisted as unknown as { isWellFormed(): boolean }).isWellFormed(),
      "a lone surrogate reached the row"
    ).toBe(true);

    // THE REVISION IS THE EXECUTOR'S, SANITISED AND CUT IN THE MIDDLE — both ends kept, which is
    // what keeps a truncated revision recognisable. Against the SANITISED original, because
    // replacing a NUL with U+FFFD is length-preserving and deliberate, not a loss.
    expect(typeof observed.revision).toBe("string");
    expect(observed.revision!.length).toBeGreaterThan(3_000);
    expect(observed.revision!.length).toBeLessThan(HOSTILE_REVISION.length);
    expect(observed.revision!.startsWith(HOSTILE_SANITISED.slice(0, HOSTILE_HEAD.length))).toBe(
      true
    );
    expect(observed.revision!.endsWith(HOSTILE_SANITISED.slice(-HOSTILE_TAIL.length))).toBe(true);

    // AND IT IS NOT MISTAKEN FOR ONE OF THE BOUND'S OWN MARKERS, in either direction: the revision
    // does not read as a cut list, and no KEPT image ref does either — only the tail does.
    expect(isPersistedJsonEntriesElision(observed.revision!)).toBe(false);
    const recorded = observedImagesOf(hostileRow.observedState);
    expect(recorded.length).toBeGreaterThan(1);
    expect(recorded.slice(0, -1).some((r) => isPersistedJsonEntriesElision(r))).toBe(false);
    expect(isPersistedJsonEntriesElision(recorded[recorded.length - 1]!)).toBe(true);

    // THE TWO GATES, ON THIS ROW. The point of the whole file: whatever a plugin puts in one field,
    // the leaves the gates read are still there.
    expect(hostileRow.status).not.toBe("succeeded");
    const verdict = stageDependencyVerdict(
      { dependsOn: "dependency-b", minWeight: 50 },
      {
        status: hostileRow.status,
        observedState: hostileRow.observedState,
        lastObservedAt: hostileRow.lastObservedAt
      },
      Date.now()
    );
    expect(verdict.satisfied).toBe(true);
    expect(verdict.branch).toBe("min_weight");
    expect(verdict.weightUnreadable).toBeUndefined();
  });

  it("CONSEQUENCE 5b: and the released version still resolves off that row, cut told from absent", async () => {
    const recorded = observedImagesOf(hostileRow.observedState);
    const survived = await resolveReleasedVersion({
      line: { ecosystem: "oci", coordinate: repositoryOf(0) },
      sourceRef: {},
      observedImages: recorded,
      manifestPaths: []
    });
    expect(survived).toMatchObject({ determined: true, version: "1.2.3" });

    const droppedRepo = repositoryOf(IMAGE_REF_COUNT - 1);
    expect(recorded.some((r) => r.startsWith(`${droppedRepo}:`))).toBe(false);
    const dropped = await resolveReleasedVersion({
      line: { ecosystem: "oci", coordinate: droppedRepo },
      sourceRef: {},
      observedImages: recorded,
      manifestPaths: []
    });
    // NOT `no_matching_image_ref`: the ref is missing because this file cut the list, not because
    // the executor never deployed it (charter principle 6).
    expect(dropped).toMatchObject({ determined: false, reason: "observed_images_elided" });
  });
});
