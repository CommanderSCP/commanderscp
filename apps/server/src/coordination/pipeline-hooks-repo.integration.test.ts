import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import { and, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { AlarmStateEvidence, TestRunEvidence } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import { pipelineEvidence, pipelineHooks } from "../db/schema.js";
import { isUniqueViolation, unwrapDriverError } from "../db/pg-errors.js";
import {
  alarmReportsInWindow,
  deleteHook,
  latestTestRunEvidence,
  listHooksForComponents,
  recordAlarmEvidence,
  recordTestRunEvidence,
  upsertHook
} from "./pipeline-hooks-repo.js";
import { evaluateBakeGate } from "./pipeline-hook-verdicts.js";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * `pipeline_hooks` / `pipeline_evidence` (migration 0096) against REAL PostgreSQL.
 *
 * Every claim this file makes is one the storage layer could get wrong SILENTLY, so each is proved
 * by executing a query rather than by reading the code that builds one:
 *
 *   - the identity UNIQUE constraint is proved by making PostgreSQL REJECT a duplicate tuple, from a
 *     raw insert that bypasses `upsertHook` entirely. Proving only that `upsertHook` avoids a
 *     duplicate would prove a property of `upsertHook`, not of the table — and the table is what the
 *     next write door will meet.
 *   - RLS isolation is proved by SELECTing with NO org filter at all from a second tenant's
 *     transaction. A query that filtered by `org_id` would pass whether or not RLS existed, which is
 *     the whole class of test that makes a missing policy invisible.
 *   - the round-trip test feeds a row written by `recordAlarmEvidence` straight into
 *     `evaluateBakeGate`. Two shapes that "look the same" are how a repo and its consumer drift; the
 *     only check that catches it is running one into the other.
 */
describe("pipeline hooks + evidence storage", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  /** A SECOND tenant on the same database — the counterparty for every RLS claim below. */
  let otherOrg: TestOrg;
  let otherAdmin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "pipeline-hooks");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    otherOrg = await createTestOrg(server, "pipeline-hooks-other");
    otherAdmin = new ScpClient({ baseUrl: server.baseUrl, token: otherOrg.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  const label = () => randomUUID().slice(0, 8);

  async function subject(client: ScpClient, orgLabel: string) {
    const component = await createTestComponent(client, { name: `comp-${orgLabel}-${label()}` });
    const target = await client.object("deployment-target").create({
      name: `tgt-${orgLabel}-${label()}`,
      properties: { environment: "prod" }
    });
    return { componentObjectId: component.id, targetObjectId: target.id };
  }

  const testRun = (over: Partial<TestRunEvidence> = {}): TestRunEvidence => ({
    kind: "testRun",
    hook: "postDeploy",
    hookId: "integration",
    workflow: {
      repo: "acme/pipelines",
      branch: "main",
      path: "workflows/integration.yaml",
      commitSha: "a".repeat(40),
      bundle: { repository: "acme/tests", digest: `sha256:${"b".repeat(64)}` }
    },
    runId: "integration-abc123",
    outcome: "passed",
    startedAt: "2026-08-26T10:00:00.000Z",
    completedAt: "2026-08-26T10:05:00.000Z",
    ...over
  });

  const alarmState = (
    windowStart: Date,
    windowEnd: Date,
    alarms: AlarmStateEvidence["alarms"] = []
  ): AlarmStateEvidence => ({
    kind: "alarmState",
    hookId: "bake",
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    alarms
  });

  it("the (org, component, kind, hookId) UNIQUE constraint REJECTS a duplicate tuple — proved by making Postgres refuse a raw insert, not by trusting upsertHook", async () => {
    const { componentObjectId } = await subject(admin, "identity");

    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      upsertHook(tx, org.orgId, {
        componentObjectId,
        kind: "continuous",
        hookId: "canary",
        everySeconds: 60,
        maxAgeSeconds: 300,
        workflow: { repo: "acme/pipelines", branch: "main", path: "workflows/canary.yaml" }
      })
    );

    // A RAW insert of the same tuple, deliberately bypassing `upsertHook`'s ON CONFLICT. This is the
    // constraint under test; `upsertHook` merely happens to be one caller that respects it.
    const raw = withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.insert(pipelineHooks).values({
        id: uuidv7(),
        orgId: org.orgId,
        componentObjectId,
        kind: "continuous",
        hookId: "canary",
        everySeconds: 999,
        maxAgeSeconds: 999
      })
    );
    await expect(raw).rejects.toSatisfy((err: unknown) =>
      isUniqueViolation(err, "pipeline_hooks_identity")
    );

    // ... and the SAME hookId under a DIFFERENT kind is a different hook, not a collision: identity
    // is the whole tuple, so a component may carry a `continuous` and a `postDeploy` named alike.
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      upsertHook(tx, org.orgId, { componentObjectId, kind: "postDeploy", hookId: "canary" })
    );
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      listHooksForComponents(tx, org.orgId, [componentObjectId])
    );
    expect(rows.map((r) => r.kind).sort()).toEqual(["continuous", "postDeploy"]);
  });

  it("upsertHook updates the payload beside the identity, and deleteHook removes exactly one hook", async () => {
    const { componentObjectId } = await subject(admin, "upsert");

    const first = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      upsertHook(tx, org.orgId, {
        componentObjectId,
        kind: "bakeAlarms",
        hookId: "bake",
        quietWindowSeconds: 600
      })
    );
    const second = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      upsertHook(tx, org.orgId, {
        componentObjectId,
        kind: "bakeAlarms",
        hookId: "bake",
        quietWindowSeconds: 1800,
        stage: "prod"
      })
    );
    expect(second.id).toBe(first.id); // same row, converged — not a second row
    expect(second.quietWindowSeconds).toBe(1800);
    expect(second.stage).toBe("prod");
    // bakeAlarms triggers nothing, so it carries no workflow — the column stays NULL through both.
    expect(second.workflow).toBeNull();

    const deleted = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      deleteHook(tx, org.orgId, { componentObjectId, kind: "bakeAlarms", hookId: "bake" })
    );
    expect(deleted?.id).toBe(first.id);
    // A repeat delete is a no-op, not an error: apply-time prune legitimately re-asks.
    const again = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      deleteHook(tx, org.orgId, { componentObjectId, kind: "bakeAlarms", hookId: "bake" })
    );
    expect(again).toBeUndefined();
  });

  it("RLS: a second org reads NEITHER the first org's hooks NOR its evidence — proved by an UNFILTERED select under the other tenant", async () => {
    const mine = await subject(admin, "rls");
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await upsertHook(tx, org.orgId, {
        componentObjectId: mine.componentObjectId,
        kind: "continuous",
        hookId: `secret-${label()}`,
        everySeconds: 60,
        maxAgeSeconds: 300
      });
      await recordTestRunEvidence(tx, org.orgId, {
        ...mine,
        hookId: "integration",
        commitSha: "c".repeat(40),
        source: "executor_observed",
        evidence: testRun()
      });
    });

    // The other tenant also holds rows, so an empty result below cannot be an empty TABLE mistaken
    // for isolation.
    const theirs = await subject(otherAdmin, "rls-other");
    await withTenantTx(server.deps.db, otherOrg.orgId, async (tx) => {
      await upsertHook(tx, otherOrg.orgId, {
        componentObjectId: theirs.componentObjectId,
        kind: "continuous",
        hookId: "theirs",
        everySeconds: 60,
        maxAgeSeconds: 300
      });
      await recordTestRunEvidence(tx, otherOrg.orgId, {
        ...theirs,
        hookId: "integration",
        commitSha: "d".repeat(40),
        source: "executor_observed",
        evidence: testRun()
      });
    });

    // NO `where` AT ALL. Anything this returns, RLS let through.
    const seenByOther = await withTenantTx(server.deps.db, otherOrg.orgId, async (tx) => ({
      hooks: await tx.select().from(pipelineHooks),
      evidence: await tx.select().from(pipelineEvidence)
    }));
    expect(seenByOther.hooks.length).toBeGreaterThan(0); // the query works; it is not silently empty
    expect(seenByOther.hooks.every((h) => h.orgId === otherOrg.orgId)).toBe(true);
    expect(seenByOther.hooks.some((h) => h.componentObjectId === mine.componentObjectId)).toBe(
      false
    );
    expect(seenByOther.evidence.length).toBeGreaterThan(0);
    expect(seenByOther.evidence.every((e) => e.orgId === otherOrg.orgId)).toBe(true);
    expect(seenByOther.evidence.some((e) => e.targetObjectId === mine.targetObjectId)).toBe(false);

    // Same rows, same unfiltered query, from the OWNING tenant: present. Without this the assertion
    // above is satisfied by a broken write path just as well as by a working policy.
    const seenByOwner = await withTenantTx(server.deps.db, org.orgId, async (tx) => ({
      hooks: await tx.select().from(pipelineHooks),
      evidence: await tx.select().from(pipelineEvidence)
    }));
    expect(seenByOwner.hooks.some((h) => h.componentObjectId === mine.componentObjectId)).toBe(
      true
    );
    expect(seenByOwner.evidence.some((e) => e.targetObjectId === mine.targetObjectId)).toBe(true);
  });

  it("RLS WITH CHECK: a tenant cannot WRITE a row stamped with another org's id", async () => {
    const mine = await subject(admin, "rls-write");
    const refusal = await withTenantTx(server.deps.db, otherOrg.orgId, (tx) =>
      // The forger holds a valid session for its OWN org and simply names another org on the row.
      // The policy's WITH CHECK half is the only thing standing here — the FK to `objects` is
      // org-unbound and would happily accept the foreign component id.
      tx.insert(pipelineHooks).values({
        id: uuidv7(),
        orgId: org.orgId,
        componentObjectId: mine.componentObjectId,
        kind: "postMerge",
        hookId: "forged"
      })
    ).then(
      () => null,
      (err: unknown) => unwrapDriverError(err)
    );
    // The SQLSTATE is asserted rather than "it threw": this insert carries NOT NULL columns, a
    // foreign key, a primary key and a unique constraint, so a bare `.rejects.toThrow()` would stay
    // green if the policy were dropped and something unrelated failed instead. `42501` is the
    // policy refusing.
    expect(refusal, "WITH CHECK must refuse a cross-org INSERT").not.toBeNull();
    expect((refusal as { code?: string }).code).toBe("42501");

    // And nothing landed — the owning org, which CAN see its own rows, has no such hook.
    const landed = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      listHooksForComponents(tx, org.orgId, [mine.componentObjectId])
    );
    expect(landed).toHaveLength(0);
  });

  it("test-run evidence SUPERSEDES: two records for one key leave exactly ONE row, the newer — including a newer FAIL displacing an older pass", async () => {
    const s = await subject(admin, "supersede");
    const digest = `sha256:${"e".repeat(64)}`;

    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      recordTestRunEvidence(tx, org.orgId, {
        ...s,
        hookId: "integration",
        artifactDigest: digest,
        source: "executor_observed",
        evidence: testRun({ runId: "run-1", outcome: "passed" })
      })
    );
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      recordTestRunEvidence(tx, org.orgId, {
        ...s,
        hookId: "integration",
        artifactDigest: digest,
        source: "executor_observed",
        evidence: testRun({
          runId: "run-2",
          outcome: "failed",
          completedAt: "2026-08-26T11:05:00.000Z"
        })
      })
    );

    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(pipelineEvidence)
        .where(
          and(
            eq(pipelineEvidence.orgId, org.orgId),
            eq(pipelineEvidence.targetObjectId, s.targetObjectId),
            eq(pipelineEvidence.kind, "testRun")
          )
        )
    );
    expect(rows).toHaveLength(1);
    expect((rows[0]!.payload as TestRunEvidence).runId).toBe("run-2");

    const latest = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      latestTestRunEvidence(tx, org.orgId, { ...s, hookId: "integration", artifactDigest: digest })
    );
    // The direction that matters for ADR-0033: a newer FAIL displaces an older pass outright.
    expect((latest!.payload as TestRunEvidence).outcome).toBe("failed");
    expect(latest!.source).toBe("executor_observed");

    // A DIFFERENT binding is a different question and does not supersede: the same hook's verdict
    // about other bytes must not be overwritten by this one.
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      recordTestRunEvidence(tx, org.orgId, {
        ...s,
        hookId: "integration",
        artifactDigest: `sha256:${"f".repeat(64)}`,
        source: "executor_observed",
        evidence: testRun({ runId: "run-3" })
      })
    );
    const bothBindings = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(pipelineEvidence)
        .where(
          and(
            eq(pipelineEvidence.orgId, org.orgId),
            eq(pipelineEvidence.targetObjectId, s.targetObjectId),
            eq(pipelineEvidence.kind, "testRun")
          )
        )
    );
    expect(bothBindings).toHaveLength(2);
  });

  it("alarm evidence does NOT supersede: two records for one key leave TWO rows, because a window's coverage is computed from the history", async () => {
    const s = await subject(admin, "accumulate");
    const t0 = new Date("2026-08-26T12:00:00.000Z");
    const mid = new Date(t0.getTime() + 30 * 60_000);
    const t1 = new Date(t0.getTime() + 60 * 60_000);

    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await recordAlarmEvidence(tx, org.orgId, {
        ...s,
        hookId: "bake",
        artifactDigest: `sha256:${"1".repeat(64)}`,
        source: "pushed",
        evidence: alarmState(t0, mid)
      });
      await recordAlarmEvidence(tx, org.orgId, {
        ...s,
        hookId: "bake",
        artifactDigest: `sha256:${"1".repeat(64)}`,
        source: "pushed",
        evidence: alarmState(mid, t1)
      });
    });

    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(pipelineEvidence)
        .where(
          and(
            eq(pipelineEvidence.orgId, org.orgId),
            eq(pipelineEvidence.targetObjectId, s.targetObjectId),
            eq(pipelineEvidence.kind, "alarmState")
          )
        )
    );
    expect(rows).toHaveLength(2);
  });

  // Window queries and the round trip into the verdict function

  it("alarmReportsInWindow returns OVERLAPPING reports and excludes non-overlapping ones", async () => {
    const s = await subject(admin, "window");
    const t0 = new Date("2026-08-26T14:00:00.000Z");
    const requiredEnd = new Date(t0.getTime() + 60 * 60_000);

    const write = (start: Date, end: Date, hookId = "bake") =>
      withTenantTx(server.deps.db, org.orgId, (tx) =>
        recordAlarmEvidence(tx, org.orgId, {
          ...s,
          hookId,
          source: "pushed",
          artifactDigest: `sha256:${"2".repeat(64)}`,
          evidence: { ...alarmState(start, end), hookId }
        })
      );

    // Straddles the start (overlap), sits inside (overlap), straddles the end (overlap).
    await write(new Date(t0.getTime() - 30 * 60_000), new Date(t0.getTime() + 10 * 60_000));
    await write(new Date(t0.getTime() + 20 * 60_000), new Date(t0.getTime() + 30 * 60_000));
    await write(
      new Date(requiredEnd.getTime() - 5 * 60_000),
      new Date(requiredEnd.getTime() + 60_000)
    );
    // Entirely BEFORE and entirely AFTER — no overlap, must not come back.
    await write(new Date(t0.getTime() - 3 * 60 * 60_000), new Date(t0.getTime() - 2 * 60 * 60_000));
    await write(
      new Date(requiredEnd.getTime() + 60 * 60_000),
      new Date(requiredEnd.getTime() + 90 * 60_000)
    );
    // A different hook on the same target — same window, still must not come back.
    await write(t0, requiredEnd, "other-bake");

    const reports = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      alarmReportsInWindow(tx, org.orgId, {
        componentObjectId: s.componentObjectId,
        targetObjectId: s.targetObjectId,
        hookId: "bake",
        windowStart: t0,
        windowEnd: requiredEnd
      })
    );
    expect(reports).toHaveLength(3);
    expect(reports.every((r) => r.source === "pushed")).toBe(true);
    // Boundary-touching counts as overlap: a report ending exactly at the required start still
    // covers the instant the window opens, and dropping it would manufacture a gap.
    expect(
      reports.some(
        (r) => r.evidence.windowStart === new Date(t0.getTime() - 30 * 60_000).toISOString()
      )
    ).toBe(true);
  });

  it("ROUND TRIP: rows written by recordAlarmEvidence feed evaluateBakeGate unchanged and produce the expected verdicts", async () => {
    const quiet = await subject(admin, "roundtrip-quiet");
    const deployedAt = new Date("2026-08-26T16:00:00.000Z");
    const quietWindowSeconds = 3600;
    const mid = new Date(deployedAt.getTime() + 30 * 60_000);
    const end = new Date(deployedAt.getTime() + 60 * 60_000);

    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await recordAlarmEvidence(tx, org.orgId, {
        ...quiet,
        hookId: "bake",
        source: "pushed",
        artifactDigest: `sha256:${"3".repeat(64)}`,
        evidence: alarmState(deployedAt, mid)
      });
      await recordAlarmEvidence(tx, org.orgId, {
        ...quiet,
        hookId: "bake",
        source: "pushed",
        artifactDigest: `sha256:${"3".repeat(64)}`,
        evidence: alarmState(mid, end)
      });
    });

    // NOTHING is reshaped between the repo and the verdict function — the array goes straight in.
    // That is the point of the test: it is the only check that catches the repo and its consumer
    // agreeing in appearance and disagreeing in fact.
    const reports = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      alarmReportsInWindow(tx, org.orgId, {
        componentObjectId: quiet.componentObjectId,
        targetObjectId: quiet.targetObjectId,
        hookId: "bake",
        windowStart: deployedAt,
        windowEnd: end
      })
    );
    const verdict = evaluateBakeGate({ quietWindowSeconds }, reports, deployedAt, new Date());
    expect(verdict).toEqual({
      satisfied: true,
      reason: "quiet",
      firingAlarms: [],
      coveredBy: ["pushed"]
    });

    // A GAP IS NOT COVERAGE — same two sources, one slice missing, and the gate stays closed.
    const gapped = await subject(admin, "roundtrip-gap");
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await recordAlarmEvidence(tx, org.orgId, {
        ...gapped,
        hookId: "bake",
        source: "pushed",
        artifactDigest: `sha256:${"4".repeat(64)}`,
        evidence: alarmState(deployedAt, new Date(deployedAt.getTime() + 10 * 60_000))
      });
      await recordAlarmEvidence(tx, org.orgId, {
        ...gapped,
        hookId: "bake",
        source: "pushed",
        artifactDigest: `sha256:${"4".repeat(64)}`,
        evidence: alarmState(new Date(deployedAt.getTime() + 50 * 60_000), end)
      });
    });
    const gappedReports = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      alarmReportsInWindow(tx, org.orgId, {
        componentObjectId: gapped.componentObjectId,
        targetObjectId: gapped.targetObjectId,
        hookId: "bake",
        windowStart: deployedAt,
        windowEnd: end
      })
    );
    expect(gappedReports).toHaveLength(2);
    expect(
      evaluateBakeGate({ quietWindowSeconds }, gappedReports, deployedAt, new Date()).reason
    ).toBe("window_not_covered");

    // A firing alarm inside the window beats coverage outright, and the alarm survives the jsonb
    // round trip with its fields intact.
    const firing = await subject(admin, "roundtrip-firing");
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      recordAlarmEvidence(tx, org.orgId, {
        ...firing,
        hookId: "bake",
        source: "rollout_analysis",
        artifactDigest: `sha256:${"5".repeat(64)}`,
        evidence: alarmState(deployedAt, end, [
          {
            name: "http-5xx-rate",
            severity: "critical",
            firedAt: new Date(deployedAt.getTime() + 5 * 60_000).toISOString()
          }
        ])
      })
    );
    const firingReports = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      alarmReportsInWindow(tx, org.orgId, {
        componentObjectId: firing.componentObjectId,
        targetObjectId: firing.targetObjectId,
        hookId: "bake",
        windowStart: deployedAt,
        windowEnd: end
      })
    );
    const firingVerdict = evaluateBakeGate(
      { quietWindowSeconds },
      firingReports,
      deployedAt,
      new Date()
    );
    expect(firingVerdict.satisfied).toBe(false);
    expect(firingVerdict.reason).toBe("alarm_firing");
    expect(firingVerdict.firingAlarms).toEqual([
      {
        name: "http-5xx-rate",
        severity: "critical",
        firedAt: new Date(deployedAt.getTime() + 5 * 60_000).toISOString()
      }
    ]);
  });

  it("latestTestRunEvidence returns null when nothing has ever arrived — ABSENCE, not a stale pass", async () => {
    const s = await subject(admin, "absent");
    const latest = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      latestTestRunEvidence(tx, org.orgId, { ...s, hookId: "canary" })
    );
    expect(latest).toBeNull();
  });
});
