import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { ScpClient } from "@scp/sdk";
import { withTenantTx } from "../db/tenant-tx.js";
import { pipelineHookRuns } from "../db/schema.js";
import { createObject } from "../graph/objects-repo.js";
import { upsertExecutorBinding } from "./executor-bindings-repo.js";
import { upsertHook } from "./pipeline-hooks-repo.js";
import {
  ensureHookRunTriggered,
  isTerminalHookRunStatus,
  pollNonTerminalHookRuns,
  HOOK_RUN_EXECUTOR_TYPE
} from "./pipeline-hook-runs.js";
import {
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * §14 RESOLUTION 7 — A HOOK RUN DISPATCHES ON THE `test` LANE, FALLING BACK TO `build`.
 *
 * ============================================================================================
 * WHAT THIS CLOSES, AND THE PART THAT IS EASY TO GET HALF-RIGHT
 * ============================================================================================
 * A hook run resolved its executor with no lane at all, so a coordinated test always ran on the
 * DEPLOY target's executor and pointing tests at a separate Argo Workflows instance was not
 * expressible. Increment 5 (rounds B1/B2) landed the lane column, `resolveLaneBinding`'s read-time
 * fallback, and a lane-aware `resolveExecutorPluginInstance`; this is the consuming half.
 *
 * THERE ARE TWO SEAMS, NOT ONE, and wiring only the obvious one is worse than wiring neither:
 *   - `resolveExecutorPluginInstance` decides WHICH PLUGIN INSTANCE the run executes on;
 *   - the binding lookup beside it supplies the `externalRef` the run is claimed with.
 * Passing the lane to the second and not the first produces a run whose row says `test` while it
 * executes on the build lane's instance — two halves of one dispatch disagreeing, silently, in a
 * shape that reads as correct in the database. Case 2 asserts the INSTANCE for exactly that reason;
 * asserting the row alone would pass against that bug.
 *
 * THE THIRD SEAM IS THE POLL, and its failure is quiet rather than loud: the poll re-resolves from
 * the same derived carrier and REFUSES to poll an instance that is not the one the run was claimed
 * under. A trigger on `test` with a poll on the default `build` would not error — it would decide
 * the binding had changed and leave every run in flight forever, logging once per tick.
 *
 * ============================================================================================
 * THE FIXTURE WARNING THAT SHAPED THIS FILE
 * ============================================================================================
 * The increment-5 session measured that a lane test whose fixture declares NO HOOK never reaches
 * the guard it means to prove — their own mutation deleting the guard SURVIVED because of it, and
 * they fixed the test rather than the log. Every case here declares a real hook and drives the real
 * `ensureHookRunTriggered`, and every assertion names WHICH instance resolved rather than that the
 * call succeeded.
 */
describe("hook runs dispatch on the test lane (§14 res 7)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    // `withPluginHost` is REQUIRED, not decoration: without it `server.deps.pluginHost` is
    // undefined and `ensureHookRunTriggered` fails on `ctx.host.start` with a TypeError that looks
    // like a bug in the code under test rather than an unstarted fixture. Measured — that is how
    // this file first failed.
    server = await listenTestServer({ withPluginHost: true });
    org = await createTestOrg(server, "hook-lane");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  const label = () => randomUUID().slice(0, 8);

  const inOrg = <T>(fn: Parameters<typeof withTenantTx<T>>[2]) =>
    withTenantTx(server.deps.db, org.orgId, fn);

  const WORKFLOW = { repo: "acme/pipelines", branch: "main", path: "workflows/it.yaml" };

  /** Binds `subject` on one lane, returning the plugin instance id that lane would dispatch to. */
  async function bind(
    subjectId: string,
    lane: "build" | "test",
    phase: "running" | "succeeded" = "running"
  ): Promise<string> {
    const pluginInstanceId = `fake-${lane}-${label()}`;
    const externalRef = `run-${label()}`;
    await inOrg((tx) =>
      upsertExecutorBinding(tx, {
        orgId: org.orgId,
        targetObjectId: subjectId,
        pluginModule: "fake-executor",
        pluginInstanceId,
        externalRef,
        config: { forcePhase: { [externalRef]: phase } },
        actorObjectId: org.orgId,
        requestId: `lane-setup-${lane}`,
        lane
      })
    );
    return pluginInstanceId;
  }

  /** A deployment target with a REAL declared `postDeploy` hook. Declaring the hook is not
   *  incidental — see the fixture warning in this file's header. */
  async function subjectWithHook(): Promise<{ subjectId: string; hookId: string }> {
    const subject = await admin.object("deployment-target").create({
      name: `lane-${label()}`,
      properties: { environment: "prod" }
    });
    const hookId = `it-${label()}`;
    await inOrg((tx) =>
      upsertHook(tx, org.orgId, {
        componentObjectId: subject.id,
        kind: "postDeploy",
        hookId,
        workflow: WORKFLOW
      })
    );
    return { subjectId: subject.id, hookId };
  }

  /** Drives the REAL trigger path and returns the persisted run row.
   *
   *  A REAL `change` OBJECT, not a synthetic uuid. The first draft of this helper used
   *  `randomUUID()` on the reading that `change_object_id` carried no foreign key — the column is
   *  declared without an inline `references()`, so a grep of `schema.ts` says so. It was wrong:
   *  `pipeline_hook_runs_change_object_id_fkey` exists and the INSERT failed 23503. Recorded rather
   *  than quietly corrected, because the general shape is the one this repo keeps paying for — the
   *  absence of a thing in the place you looked is not its absence, and Postgres was the second
   *  implementation that settled it.
   *
   *  Minted through `createObject` rather than the report ingress: the ingress would need the
   *  reconcile loop and a second thing to wait on, and this file asserts nothing about correlation. */
  async function trigger(subjectId: string, hookId: string) {
    const change = await inOrg((tx) =>
      createObject(tx, {
        orgId: org.orgId,
        typeId: "change",
        actorObjectId: org.orgId,
        requestId: `lane-change-${label()}`,
        name: `lane-change-${label()}`,
        properties: {}
      })
    );
    await ensureHookRunTriggered(
      server.deps.db,
      {
        orgId: org.orgId,
        masterKey: server.deps.config.secretsMasterKey,
        host: server.deps.pluginHost!
      } as Parameters<typeof ensureHookRunTriggered>[1],
      {
        hook: {
          componentObjectId: subjectId,
          kind: "postDeploy",
          hookId,
          workflow: WORKFLOW
        },
        change: { objectId: change.id },
        target: { objectId: subjectId },
        waveIndex: 0
      } as Parameters<typeof ensureHookRunTriggered>[2]
    );
    const rows = await inOrg((tx) =>
      tx.select().from(pipelineHookRuns).where(eq(pipelineHookRuns.hookId, hookId))
    );
    return rows[0]!;
  }

  it("1. FALLBACK: with only a BUILD binding, the run still dispatches — on the build instance", async () => {
    // THE ADDITIVE PROPERTY, and the case that protects every estate in existence. The fallback is
    // read-time and the reconciler deliberately does NOT materialise a test row, so a hand-authored
    // estate carries build rows only. Without the fallback this asks for a lane nothing declares,
    // `resolveExecutorPluginInstance` returns undefined, and `ensureHookRunTriggered` throws its
    // loud-unbound refusal on EVERY hook run in the estate.
    const { subjectId, hookId } = await subjectWithHook();
    const buildInstance = await bind(subjectId, "build");

    const run = await trigger(subjectId, hookId);

    expect(run).toBeTruthy();
    expect(run.pluginInstanceId).toBe(buildInstance);
  });

  it("2. SEPARATION: with BOTH lanes bound, the run dispatches on the TEST instance", async () => {
    // The feature itself. Asserted on `pluginInstanceId` — the thing the run actually executes on —
    // rather than on the binding row, because wiring only the `externalRef` lookup and leaving
    // `resolveExecutorPluginInstance` on its build default produces a run that looks correctly
    // test-laned while running on the deploy executor. That bug passes a row-shaped assertion.
    const { subjectId, hookId } = await subjectWithHook();
    const buildInstance = await bind(subjectId, "build");
    const testInstance = await bind(subjectId, "test");

    const run = await trigger(subjectId, hookId);

    expect(run.pluginInstanceId).toBe(testInstance);
    expect(run.pluginInstanceId).not.toBe(buildInstance);
  });

  it("3. the two lanes are genuinely different rows — the fixture proves a separation exists to find", async () => {
    // A control for case 2. If `upsertExecutorBinding` had collapsed the two lanes onto one row
    // (the identity-widening defect increment 5 fixed in `deleteExecutorBinding`), case 2 would
    // compare an instance against itself and pass while proving nothing.
    const { subjectId } = await subjectWithHook();
    const buildInstance = await bind(subjectId, "build");
    const testInstance = await bind(subjectId, "test");
    expect(testInstance).not.toBe(buildInstance);

    const { resolveLaneBinding } = await import("./executor-bindings-repo.js");
    const asTest = await inOrg((tx) =>
      resolveLaneBinding(tx, org.orgId, subjectId, HOOK_RUN_EXECUTOR_TYPE, "test")
    );
    const asBuild = await inOrg((tx) =>
      resolveLaneBinding(tx, org.orgId, subjectId, HOOK_RUN_EXECUTOR_TYPE, "build")
    );
    // Both resolve, to DIFFERENT rows, and the test lane did not arrive via fallback — otherwise
    // case 2's "separation" would be the fallback wearing a separation's clothes.
    expect(asTest?.viaLaneFallback).toBe(false);
    expect(asBuild?.viaLaneFallback).toBe(false);
    expect(asTest?.row.pluginInstanceId).not.toBe(asBuild?.row.pluginInstanceId);
  });

  it("4. the fallback is FLAGGED as a fallback when only the build lane is declared", async () => {
    // `viaLaneFallback` is what lets the reconciler avoid reporting a spurious test-lane gap. If it
    // ever returned false here, a build-only estate would read as having declared a test lane.
    const { subjectId } = await subjectWithHook();
    await bind(subjectId, "build");

    const { resolveLaneBinding } = await import("./executor-bindings-repo.js");
    const resolved = await inOrg((tx) =>
      resolveLaneBinding(tx, org.orgId, subjectId, HOOK_RUN_EXECUTOR_TYPE, "test")
    );
    expect(resolved).toBeTruthy();
    expect(resolved!.viaLaneFallback).toBe(true);
  });

  it("6. THE POLL resolves the same lane the trigger claimed — otherwise the run sits in flight forever", async () => {
    // THE QUIET SEAM, and the reason it needs its own case: the poll re-resolves the instance from
    // the derived carrier and REFUSES to poll one that is not the instance the run was claimed
    // under. A poll on the default `build` while the trigger claimed on `test` therefore does not
    // error — it decides the binding changed, logs once, and leaves the run non-terminal FOREVER.
    //
    // MEASURED: unwiring the poll's lane alone left all five earlier cases GREEN. This case is what
    // makes that mutation fail, and without it the seam was wired on faith.
    const { subjectId, hookId } = await subjectWithHook();
    await bind(subjectId, "build");
    const testInstance = await bind(subjectId, "test", "succeeded");

    const run = await trigger(subjectId, hookId);
    expect(run.pluginInstanceId).toBe(testInstance);
    expect(
      isTerminalHookRunStatus(run.status as Parameters<typeof isTerminalHookRunStatus>[0])
    ).toBe(false);

    await pollNonTerminalHookRuns(server.deps.db, {
      orgId: org.orgId,
      masterKey: server.deps.config.secretsMasterKey,
      host: server.deps.pluginHost!
    } as Parameters<typeof pollNonTerminalHookRuns>[1]);

    const [after] = await inOrg((tx) =>
      tx.select().from(pipelineHookRuns).where(eq(pipelineHookRuns.hookId, hookId))
    );
    // TERMINAL is the proof the poll actually reached the executor. Asserting "no error" would pass
    // against the bug, because the bug's whole shape is a silent `continue`.
    expect(
      isTerminalHookRunStatus(after!.status as Parameters<typeof isTerminalHookRunStatus>[0])
    ).toBe(true);
  });

  it("5. LOUD-UNBOUND survives: no binding on either lane still refuses, it does not fall back to nothing", async () => {
    // §14 res 2. The fallback must not soften this into a silent no-op — a hook run that cannot
    // address an executor is not a run that quietly succeeds, and this repo has already measured
    // what an unbound placement that fake-succeeds costs.
    const { subjectId, hookId } = await subjectWithHook();

    await expect(trigger(subjectId, hookId)).rejects.toThrow(/executor binding/);
  });
});
