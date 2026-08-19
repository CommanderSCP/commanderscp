import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import { RUNNER_DETAIL_MAX_CHARS } from "@scp/runner-launcher";
import { v7 as uuidv7 } from "uuid";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  waitUntil,
  type ListeningTestServer
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { decisions } from "../db/schema.js";

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
const HUGE_DETAIL = `${CAUSE_HEAD}${"noise from a vendor plugin that logs everything\n".repeat(9_000)}${CAUSE_TAIL}`;

describe("reconcile: a plugin's `detail` is bounded before it becomes a Decision row", () => {
  let server: ListeningTestServer;
  const failingTargetId = uuidv7();

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
        forcePhase: { [failingTargetId]: "failed" },
        detailByTarget: { [failingTargetId]: HUGE_DETAIL }
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

    const change = await admin.changes.propose({
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
        return rows.find((r) => (r.inputContext as { targetObjectId?: string }).targetObjectId === failingTargetId);
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
});
