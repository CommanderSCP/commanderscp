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

/** HIGH (M23.0 verification pass 7). See docs/coordination.md §733. */

/** 432 KB of plugin-supplied noise with a recognisable byte at each end, so the test can tell a
 *  BOUND (both ends kept, middle elided) from a TRUNCATION (tail lost) from no bound at all. */
const CAUSE_HEAD = "THIRD-PARTY-EXECUTOR-SAID:";
const CAUSE_TAIL = "the deployment was rejected by the admission webhook";
const NOISE_UNIT = "noise from a vendor plugin that logs everything\n";
const NOISE_TIMES = 9_000;
/** Sent as a RECIPE, not a literal. See docs/coordination.md §734. */
const HUGE_DETAIL = `${CAUSE_HEAD}${NOISE_UNIT.repeat(NOISE_TIMES)}${CAUSE_TAIL}`;

/** THE SAME SIZE, BUT MADE OF ASTRAL CHARACTERS. See docs/coordination.md §735. */
const ASTRAL_HEAD = "THIRD-PARTY-EXECUTOR-SAID:";
const ASTRAL_TAIL = "the rollout was rejected 🙂";
const ASTRAL_DETAIL = `${ASTRAL_HEAD}${"🙂🙃🚀🧨".repeat(3_000)}${ASTRAL_TAIL}`;

/** PLUGIN-CHOSEN TEXT ON `status().observed.images`. See docs/coordination.md §736. */
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
  /** HIGH REGRESSION (verification pass 7 -> fixed pass 8). See docs/coordination.md §737. */
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

  /** MEDIUM (verification pass 7, finding M2). See docs/coordination.md §738. */
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
