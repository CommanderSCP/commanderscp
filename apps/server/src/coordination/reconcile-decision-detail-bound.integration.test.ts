import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import { PERSISTED_JSON_MAX_CHARS, RUNNER_DETAIL_MAX_CHARS } from "@scp/runner-launcher";
import { v7 as uuidv7 } from "uuid";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  waitUntil,
  type ListeningTestServer
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { changeWaveTargets, decisions } from "../db/schema.js";

/**
 * HIGH (M23.0 verification pass 7) — AN UNBOUNDED `detail` IS AN UNBOUNDED DATABASE ROW, ONE PER
 * FAILING POLL, and this is the arm that proves the bound is INSTALLED rather than merely written.
 *
 * The failure-tail fix bounds `detail` at the port, which covers the three managed plugins. It does
 * NOT cover this write. `ExecutionStatus.detail` is free-form `string` on the plugin contract, so a
 * third-party executor — an org's own ArgoCD wrapper, a vendor's plugin — can return a megabyte,
 * and `reconcileExecutingChange` writes it into a `Decision`'s `inputContext` every time a wave
 * target reports `failed` or `aborted`. A `Decision` is permanent governed state (charter principle
 * 6). This repository has a production incident in exactly that family: unbounded `Decision` growth
 * at 1.44 GB/day, from a row rewritten every tick.
 *
 * WHY THE WITNESS HAS TO BE THE FAKE EXECUTOR. Every in-repo executor that produces a long `detail`
 * bounds its own at composition, enforced by `BoundedDetail` on its outcome store — so for all
 * three of them this write is the IDENTITY, and a test driven through any of them would pass with
 * the bound deleted. The case the bound exists for is a plugin this repository does not compose the
 * string for, and `detailByTarget` (added alongside this test, mirroring `forcePhase`) is the only
 * stand-in for one.
 *
 * DELETE-THE-WIRING, MEASURED: remove `boundDetail(...)` from `reconcile.ts`'s `inputContext` and
 * this test fails on `an unbounded plugin detail became an unbounded Decision row: expected 432078
 * to be less than or equal to 4000` — the whole 432 KB, in the row.
 */

/** 432 KB of plugin-supplied noise with a recognisable byte at each end, so the test can tell a
 *  BOUND (both ends kept, middle elided) from a TRUNCATION (tail lost) from no bound at all. */
const CAUSE_HEAD = "THIRD-PARTY-EXECUTOR-SAID:";
const CAUSE_TAIL = "the deployment was rejected by the admission webhook";
const NOISE_UNIT = "noise from a vendor plugin that logs everything\n";
const NOISE_TIMES = 9_000;
/**
 * Sent as a RECIPE, not a literal. The plugin host passes plugin config on the subprocess ARGV
 * (`host.ts` `spawnInstance`), and Linux caps a single argument at MAX_ARG_STRLEN (128 KiB),
 * answering `spawn E2BIG` past it. macOS does not, so the 432 KB literal this test used to send
 * passed locally for weeks and failed the first time CI's integration shard actually ran it.
 * `detailRepeatByTarget` expands in-process, so the size under test never crosses the transport.
 */
const HUGE_DETAIL = `${CAUSE_HEAD}${NOISE_UNIT.repeat(NOISE_TIMES)}${CAUSE_TAIL}`;

/**
 * THE SAME SIZE, BUT MADE OF ASTRAL CHARACTERS — the HIGH regression arm. `boundDetail` slices at
 * UTF-16 CODE-UNIT offsets, so a cut lands mid-surrogate-pair and the bounded string is ill-formed.
 * `isWellFormed()` says so in a unit test; POSTGRES is the authority, and this is where it rules:
 * `jsonb` refuses the value, the throw happens inside `reconcileExecutingChange`'s `withTenantTx`,
 * the whole transaction — Decision AND `updateWaveTargetObserved` — rolls back, and the poll
 * re-throws every tick forever behind a `console.error`. So the assertion that matters here is not
 * that the row is well-formed; it is that THE ROW EXISTS AT ALL.
 */
const ASTRAL_HEAD = "THIRD-PARTY-EXECUTOR-SAID:";
const ASTRAL_TAIL = "the rollout was rejected 🙂";
const ASTRAL_DETAIL = `${ASTRAL_HEAD}${"🙂🙃🚀🧨".repeat(3_000)}${ASTRAL_TAIL}`;

/**
 * PLUGIN-CHOSEN TEXT ON `status().observed.images` — the SIBLING field, three lines from the one
 * the previous round bounded, written into `change_wave_targets.observed_state` on EVERY poll
 * including the non-terminal `observing` ones. Verification pass 7 measured this same seam at
 * `persistedImageChars=500017`; the fixture is 120 000 characters rather than 500 000 only because
 * the plugin host passes instance config to the subprocess on spawn and three half-megabyte
 * fixtures in one config is `spawn E2BIG`. 120 000 is still 15x the whole-payload budget, which is
 * what the arm measures.
 */
const IMAGE_HEAD = "ghcr.io/vendor/app:";
const IMAGE_TAG_LEN = 60_000;
/** Sent as a recipe (see HUGE_DETAIL) — 2 x 60 KB cannot cross the spawn argv on Linux. */
const HUGE_IMAGE_REF = `${IMAGE_HEAD}${"t".repeat(IMAGE_TAG_LEN)}`;

describe("reconcile: a plugin's `detail` is bounded before it becomes a Decision row", () => {
  let server: ListeningTestServer;
  const failingTargetId = uuidv7();
  const astralTargetId = uuidv7();
  const observedTargetId = uuidv7();

  beforeAll(async () => {
    expect(HUGE_DETAIL.length).toBe(432_078);
    server = await listenTestServer({
      withEventRelay: true,
      withReconcileLoop: true,
      pluginHostOptions: {
        callTimeoutMs: 8_000,
        restartBackoffBaseMs: 50,
        maxRestartBackoffMs: 300
      },
      // Explicit target id, so the boot-time config names a target created later — the same seam
      // the observed-images and rollback suites use.
      fakeExecutorConfig: {
        forcePhase: { [failingTargetId]: "failed", [astralTargetId]: "failed" },
        detailRepeatByTarget: {
          [failingTargetId]: {
            head: CAUSE_HEAD,
            unit: NOISE_UNIT,
            times: NOISE_TIMES,
            tail: CAUSE_TAIL
          }
        },
        // A LITERAL, deliberately: this one is small, and the point of the arm is the exact bytes.
        detailByTarget: { [astralTargetId]: ASTRAL_DETAIL },
        // The sibling field, on a target that SUCCEEDS — so this arm exercises the branch the
        // previous round never looked at: `observed_state` is written on the succeeded and
        // observing paths too, not only when a Decision is being cut.
        imagesRepeatByTarget: {
          [observedTargetId]: { head: IMAGE_HEAD, unit: "t", times: IMAGE_TAG_LEN, count: 2 }
        }
      }
    });
  });

  afterAll(async () => {
    await server?.close();
  });

  it("a 432 KB `status().detail` reaches `insertDecision` bounded, keeping BOTH ends", async () => {
    const org = await createTestOrg(server, "decision-detail-bound");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    const target = await createTestComponent(admin, {
      id: failingTargetId,
      name: "decision-detail-bound-target"
    });
    expect(target.id).toBe(failingTargetId);

    await admin.changes.propose({
      name: "a run whose executor is chatty and fails",
      targets: [failingTargetId]
    });

    // The `wave_target` block Decision is written in the SAME transaction as the target's status
    // update, so waiting on the row itself is waiting on the write under test — not on a proxy for
    // it that could be satisfied while the Decision never lands.
    const row = await waitUntil(
      async () => {
        const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
          tx
            .select()
            .from(decisions)
            .where(and(eq(decisions.orgId, org.orgId), eq(decisions.kind, "wave_target")))
        );
        return rows.find(
          (r) => (r.inputContext as { targetObjectId?: string }).targetObjectId === failingTargetId
        );
      },
      { describe: `a wave_target Decision for ${failingTargetId}`, timeoutMs: 30_000 }
    );

    const ctx = row.inputContext as { phase?: string; detail?: string | null };
    expect(ctx.phase).toBe("failed");
    expect(typeof ctx.detail).toBe("string");

    // THE BOUND, as a fact about the persisted row rather than about the value reconcile computed.
    expect(
      ctx.detail!.length,
      "an unbounded plugin detail became an unbounded Decision row"
    ).toBeLessThanOrEqual(RUNNER_DETAIL_MAX_CHARS);

    // BOTH ENDS SURVIVED. A plain truncation would keep the head and lose the diagnosis, which is
    // the defect this whole fix is about; asserting only the length would pass under one.
    expect(ctx.detail!.startsWith(CAUSE_HEAD)).toBe(true);
    expect(ctx.detail!.endsWith(CAUSE_TAIL)).toBe(true);
    expect(ctx.detail).toContain("characters elided");
  });
  /**
   * HIGH REGRESSION (verification pass 7 -> fixed pass 8). THE ASSERTION IS THAT THE ROW EXISTS.
   *
   * Before the fix this test does not fail on a length or a shape — it TIMES OUT, because no
   * `wave_target` Decision is ever written for this target and none ever will be. The measured
   * failure, on every tick:
   *
   *   [reconcile] … poll failed (will retry next tick):
   *     DrizzleQueryError: Failed query: insert into "decisions" (…, "input_context", …) values …
   *       detail: 'Unicode low surrogate must follow a high surrogate.'
   *
   * This is the arm that checks the MODEL against the AUTHORITY. `isWellFormed()` is what the unit
   * sweep asserts; whether Postgres agrees is a fact about Postgres, and only a real insert settles
   * it.
   */
  it("an ASTRAL `detail` still lands — the bound's own cut used to make the row unstorable", async () => {
    const org = await createTestOrg(server, "decision-detail-astral");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    const target = await createTestComponent(admin, {
      id: astralTargetId,
      name: "decision-detail-astral-target"
    });
    expect(target.id).toBe(astralTargetId);

    await admin.changes.propose({
      name: "a run whose executor prints emoji and fails",
      targets: [astralTargetId]
    });

    const row = await waitUntil(
      async () => {
        const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
          tx
            .select()
            .from(decisions)
            .where(and(eq(decisions.orgId, org.orgId), eq(decisions.kind, "wave_target")))
        );
        return rows.find(
          (r) => (r.inputContext as { targetObjectId?: string }).targetObjectId === astralTargetId
        );
      },
      {
        describe: `a wave_target Decision for ${astralTargetId} — if this times out, jsonb refused the row`,
        timeoutMs: 30_000
      }
    );

    const ctx = row.inputContext as { detail?: string | null };
    expect(typeof ctx.detail).toBe("string");
    // POSTGRES ALREADY AGREED by returning the row; these say WHAT came back, so a future change
    // that keeps the insert working by discarding the detail is not silently green.
    expect(ctx.detail!.length).toBeLessThanOrEqual(4_000);
    expect(ctx.detail!.startsWith(ASTRAL_HEAD)).toBe(true);
    expect(ctx.detail!.endsWith(ASTRAL_TAIL)).toBe(true);
    expect(
      (ctx.detail as unknown as { isWellFormed(): boolean }).isWellFormed(),
      "Postgres stored it, so this can only fail if the driver re-encoded it"
    ).toBe(true);

    // AND THE TERMINALISATION THE SAME TRANSACTION CARRIES. This is the half the regression really
    // cost: the rollback took `updateWaveTargetObserved` with it, so the wave target stayed
    // non-terminal forever while the Decision was missing. Asserting only the Decision would pass
    // for a future variant that lands the row outside that transaction.
    const targetRow = await waitUntil(
      async () => {
        const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
          tx
            .select()
            .from(changeWaveTargets)
            .where(
              and(
                eq(changeWaveTargets.orgId, org.orgId),
                eq(changeWaveTargets.targetObjectId, astralTargetId)
              )
            )
        );
        return rows.find((r) => r.status === "failed");
      },
      { describe: `wave target ${astralTargetId} terminalised`, timeoutMs: 30_000 }
    );
    expect(targetRow.status).toBe("failed");
  });

  /**
   * MEDIUM (verification pass 7, finding M2) — THE SIBLING FIELD ON THE SAME UNTRUSTED OBJECT.
   *
   * `observedStateFrom` reads `stateRef` and `observed.images` off the same free-form
   * `ExecutionStatus` the round declared untrusted, three lines above the field it bounded, and
   * `updateWaveTargetObserved` writes them on the succeeded, failed/aborted AND observing branches —
   * every tick. Measured through this same `imagesByTarget` seam with no product code modified:
   * `persistedImageChars=500017`, `rowJsonBytes=500093`.
   *
   * The assertion is on the SIZE OF THE PERSISTED ROW rather than on the images field, because the
   * defect is about what a row costs, and because a bound expressed per-field is the thing that
   * went stale: `ExecutionStatus.observed` is documented as additive, so the next signal an
   * executor contributes lands here unbounded unless the bound is on the whole value.
   */
  it("120 KB of `observed.images` becomes a bounded `observed_state` row, not a verbatim one", async () => {
    const org = await createTestOrg(server, "observed-state-bound");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    const target = await createTestComponent(admin, {
      id: observedTargetId,
      name: "observed-state-bound-target"
    });
    expect(target.id).toBe(observedTargetId);

    await admin.changes.propose({
      name: "a run whose executor reports enormous image refs",
      targets: [observedTargetId]
    });

    const row = await waitUntil(
      async () => {
        const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
          tx
            .select()
            .from(changeWaveTargets)
            .where(
              and(
                eq(changeWaveTargets.orgId, org.orgId),
                eq(changeWaveTargets.targetObjectId, observedTargetId)
              )
            )
        );
        return rows.find((r) => r.observedState !== null);
      },
      { describe: `an observed_state for ${observedTargetId}`, timeoutMs: 30_000 }
    );

    const persisted = JSON.stringify(row.observedState);
    // NON-VACUITY FIRST: the plugin really did offer a megabyte. Without this the assertion below
    // is satisfied by a fixture that never applied — a mode this repository has shipped before.
    expect(HUGE_IMAGE_REF.length * 2).toBeGreaterThan(100_000);
    expect(
      persisted.length,
      "the whole plugin-supplied observed_state went into the row verbatim"
    ).toBeLessThanOrEqual(PERSISTED_JSON_MAX_CHARS);
    // Stated against an absolute literal too, for the reason the magnitude tests exist: an
    // assertion against the constant that defines the bound cannot notice the constant moving.
    expect(persisted.length).toBeLessThanOrEqual(8_000);

    // AND THE READING SURVIVED — a bound that emptied the payload would pass everything above,
    // and ADR-0028's freshness gate reads these fields.
    const observed = row.observedState as {
      revision?: string;
      images?: string[];
      observedAt?: string;
    };
    expect(observed.revision).toMatch(/^v\d+$/);
    expect(observed.images?.length).toBeGreaterThan(0);
    expect(observed.images![0]!.startsWith("ghcr.io/vendor/app:")).toBe(true);
    // `observedAt` is stamped by the store AFTER the bound, so a plugin's budget can never spend it.
    expect(typeof observed.observedAt).toBe("string");
  });
});
