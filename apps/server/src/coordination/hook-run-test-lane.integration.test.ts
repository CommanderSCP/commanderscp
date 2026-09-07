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

/** A hook run dispatches on the test lane, else build. See docs/coordination.md §545. */
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

  /** Drives the real trigger path with a real change. See docs/coordination.md §546. */
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
    // The additive property that protects every existing estate. See docs/coordination.md §547.
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
    // THE QUIET SEAM, and the reason it needs its own case. See docs/coordination.md §548.
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
