import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import { and, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { TestRunEvidenceSchema, type CapturedWorkflowRef } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import { pipelineEvidence, pipelineHookRuns } from "../db/schema.js";
import { isUniqueViolation, unwrapDriverError } from "../db/pg-errors.js";
import { upsertExecutorBinding } from "./executor-bindings-repo.js";
import { latestTestRunEvidence } from "./pipeline-hooks-repo.js";
import { evaluatePostDeployGate } from "./pipeline-hook-verdicts.js";
import {
  applyHookRunObservation,
  ensureHookRunTriggered,
  findHookRun,
  hookRunIdempotencyKey,
  listNonTerminalHookRuns
} from "./pipeline-hook-runs.js";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  waitUntil,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * `pipeline_hook_runs` (migration 0097) and its claim/trigger/poll driver, against REAL PostgreSQL.
 *
 * ============================================================================================
 * WHAT EACH CLAIM IS PROVED **WITH**, BECAUSE THE METHOD IS THE POINT HERE
 * ============================================================================================
 * Every property below is one that a test can appear to check while checking something else, so the
 * instrument is chosen per claim rather than by habit:
 *
 *   - THE TRIGGER GUARD is proved by making PostgreSQL REJECT a RAW insert that bypasses
 *     `claimHookRun` entirely, and by asserting the SQLSTATE-backed CONSTRAINT NAME. Asserting that
 *     `ensureHookRunTriggered` checks-before-inserting would prove a property of that function; the
 *     race it exists to stop happens between two callers of it, where no amount of checking helps.
 *     Only the table can refuse that, so only the table is asked.
 *
 *   - THE NULL `wave_index` CASE gets its own test for the same tuple, because that is the one a
 *     plain UNIQUE silently lets through: `NULL <> NULL` under the default `NULLS DISTINCT`, so a
 *     `postMerge` run would duplicate freely while every other hook kind stayed guarded. A test that
 *     only exercised a numeric wave index would be green on the broken schema.
 *
 *   - RLS is proved by an UNFILTERED `select()` under a second tenant. A query with a `where
 *     org_id = ...` passes identically with and without a policy, which is the whole class of test
 *     that makes a missing policy invisible — and the owning tenant runs the SAME unfiltered query
 *     and DOES see rows, so an empty result cannot be an empty table mistaken for isolation.
 *
 *   - THE TERMINAL EDGE is driven THROUGH THE RECONCILE LOOP, not by calling the poll inline. The
 *     loop is a live competitor for exactly this work, so an inline call under a running loop proves
 *     nothing about what the loop does — and it is the loop that runs in production.
 *
 *   - THE ROUND TRIP feeds the evidence row this path produced into `evaluatePostDeployGate`
 *     UNRESHAPED. Two shapes that "look the same" is how a producer and its consumer drift; the only
 *     check that catches it is running one into the other, with no adapter in between.
 */
describe("pipeline hook runs", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let otherOrg: TestOrg;
  let otherAdmin: ScpClient;

  beforeAll(async () => {
    // The reconcile loop is ON: the terminal-edge tests below are driven by it, because it is the
    // thing that actually runs `pollNonTerminalHookRuns` in production.
    //
    // `withEventRelay` IS REQUIRED, not decorative — the harness nests the reconcile-loop start
    // INSIDE the relay block (it is the relay's pg-boss the loop schedules its tick on). Omitting it
    // starts no loop and no error: the trigger still fires, nothing ever polls, and every
    // loop-driven assertion below fails as a 15s timeout that reads like a slow engine rather than
    // an absent one.
    server = await listenTestServer({ withEventRelay: true, withReconcileLoop: true });
    org = await createTestOrg(server, "hook-runs");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    otherOrg = await createTestOrg(server, "hook-runs-other");
    otherAdmin = new ScpClient({ baseUrl: server.baseUrl, token: otherOrg.adminToken });
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  const label = () => randomUUID().slice(0, 8);

  const inOrg = <T>(fn: Parameters<typeof withTenantTx<T>>[2], orgId = org.orgId) =>
    withTenantTx(server.deps.db, orgId, fn);

  /**
   * A component + the deployment target a hook run is ABOUT + a real proposed Change.
   *
   * ============================================================================================
   * THE CHANGE DELIBERATELY NAMES A **DIFFERENT** TARGET THAN THE HOOK RUN DOES
   * ============================================================================================
   * This is a fixture constraint, not a product one, and it cost a debugging round to find because
   * it fails SILENTLY. The reconcile loop is live in this suite, so a proposed Change is really
   * coordinated: `advanceExecutingChanges` triggers each of its wave targets through THAT target's
   * executor binding. `@scp/plugin-fake-executor` keys its state by `targetRef` and keeps ONE run per
   * target, so a wave-target trigger on the same binding SUPERSEDES the hook run's `externalId` — and
   * `status()` for a superseded ref returns `phase: "pending"`, by design, rather than throwing.
   *
   * The result is a hook run that never terminalizes, with no error anywhere: the poll runs, the
   * executor answers, and the answer is "still pending" forever. Separating the two targets keeps the
   * engine's own deploys off the binding this suite's runs are polled through.
   *
   * A real executor does not behave this way — Argo Workflows tracks runs by id, not one-per-target —
   * so nothing here is compensating for a defect in the driver.
   */
  async function subject(client: ScpClient, orgLabel: string) {
    const component = await createTestComponent(client, { name: `comp-${orgLabel}-${label()}` });
    const target = await client.object("deployment-target").create({
      name: `tgt-${orgLabel}-${label()}`,
      properties: { environment: "prod" }
    });
    const changeTarget = await client.object("deployment-target").create({
      name: `chgtgt-${orgLabel}-${label()}`,
      properties: { environment: "prod" }
    });
    const change = await client.changes.propose({
      name: `chg-${orgLabel}-${label()}`,
      targets: [changeTarget.id]
    });
    return {
      componentObjectId: component.id,
      targetObjectId: target.id,
      changeObjectId: change.id
    };
  }

  /**
   * A raw insert, DELIBERATELY BYPASSING `claimHookRun`'s `ON CONFLICT DO NOTHING`. This is what
   * makes the constraint — rather than the function's politeness — the thing under test.
   */
  function rawInsert(
    s: { componentObjectId: string; targetObjectId: string | null; changeObjectId: string },
    over: { hookId: string; waveIndex: number | null; kind?: string },
    orgId = org.orgId
  ) {
    return inOrg(
      (tx) =>
        tx.insert(pipelineHookRuns).values({
          id: uuidv7(),
          orgId,
          componentObjectId: s.componentObjectId,
          targetObjectId: s.targetObjectId,
          changeObjectId: s.changeObjectId,
          hookId: over.hookId,
          kind: over.kind ?? "postDeploy",
          waveIndex: over.waveIndex,
          status: "pending",
          pluginInstanceId: `inst-${label()}`
        }),
      orgId
    );
  }

  /** The D23 pin. Fabricated HERE, in a fixture, because nothing in the tree produces one yet —
   *  which is precisely why the production path writes NO evidence when it is absent instead of
   *  inventing this. A test may supply a fixture; the server may not invent a fact. */
  const captured = (over: Partial<CapturedWorkflowRef> = {}): CapturedWorkflowRef => ({
    repo: "acme/pipelines",
    branch: "main",
    path: "workflows/integration.yaml",
    commitSha: "a".repeat(40),
    bundle: { repository: "acme/tests", digest: `sha256:${"b".repeat(64)}` },
    ...over
  });

  // -------------------------------------------------------------------------------------------
  // 1. The trigger-idempotency guard IS the constraint
  // -------------------------------------------------------------------------------------------

  it("the (org, change, hookId, waveIndex) UNIQUE constraint REJECTS a second run — proved by a raw insert Postgres refuses, named by its constraint", async () => {
    const s = await subject(admin, "guard");
    await rawInsert(s, { hookId: "integration", waveIndex: 2 });

    // The second concurrent tick. It carries a fresh `id` and is in every other way a legal row —
    // only the identity tuple collides.
    const second = rawInsert(s, { hookId: "integration", waveIndex: 2 });
    await expect(second).rejects.toSatisfy((err: unknown) =>
      isUniqueViolation(err, "pipeline_hook_runs_identity")
    );

    // POSITIVE CONTROLS, so the refusal above cannot be "this insert never works". A DIFFERENT wave,
    // a DIFFERENT hook and a DIFFERENT change are each a genuinely different run.
    await rawInsert(s, { hookId: "integration", waveIndex: 3 });
    await rawInsert(s, { hookId: "smoke", waveIndex: 2 });
    const otherChange = await subject(admin, "guard-2");
    await rawInsert(
      { ...s, changeObjectId: otherChange.changeObjectId },
      { hookId: "integration", waveIndex: 2 }
    );

    const rows = await inOrg((tx) =>
      tx
        .select()
        .from(pipelineHookRuns)
        .where(
          and(
            eq(pipelineHookRuns.orgId, org.orgId),
            eq(pipelineHookRuns.changeObjectId, s.changeObjectId)
          )
        )
    );
    expect(rows).toHaveLength(3);
  });

  it("the guard covers the NULL wave_index case too — the one a plain UNIQUE silently lets through, because NULL <> NULL under the default NULLS DISTINCT", async () => {
    const s = await subject(admin, "postmerge");
    // `postMerge` is not target-specific and belongs to no wave, so BOTH nullable identity inputs
    // are NULL here — the exact shape that a default `NULLS DISTINCT` constraint fails to guard.
    const postMerge = { ...s, targetObjectId: null };

    await rawInsert(postMerge, { hookId: "unit", waveIndex: null, kind: "postMerge" });

    const second = rawInsert(postMerge, { hookId: "unit", waveIndex: null, kind: "postMerge" });
    await expect(
      second,
      "a NULL wave_index MUST still collide — NULLS NOT DISTINCT is what makes this true"
    ).rejects.toSatisfy((err: unknown) =>
      isUniqueViolation(err, "pipeline_hook_runs_identity")
    );

    // POSITIVE CONTROL: a NULL wave_index under a DIFFERENT hookId is a different run and inserts
    // fine. Without this, the assertion above would also pass on a schema that refused every
    // NULL-wave insert for some unrelated reason.
    await rawInsert(postMerge, { hookId: "lint", waveIndex: null, kind: "postMerge" });

    // ... and NULL does not collide with 0. They are different waves, and a `coalesce(x, -1)`-style
    // normalisation is exactly where that distinction gets quietly lost.
    await rawInsert(postMerge, { hookId: "unit", waveIndex: 0, kind: "postDeploy" });

    const rows = await inOrg((tx) =>
      tx
        .select()
        .from(pipelineHookRuns)
        .where(
          and(
            eq(pipelineHookRuns.orgId, org.orgId),
            eq(pipelineHookRuns.changeObjectId, s.changeObjectId)
          )
        )
    );
    expect(rows).toHaveLength(3);

    // And the loser of the race can FIND the winner's row — `findHookRun` matches a NULL
    // `waveIndex` with `IS NULL`, not `= NULL`, which would silently find nothing and make the
    // loser think its row had vanished.
    const found = await inOrg((tx) =>
      findHookRun(tx, {
        orgId: org.orgId,
        changeObjectId: s.changeObjectId,
        hookId: "unit",
        waveIndex: null
      })
    );
    expect(found?.waveIndex).toBeNull();
    expect(found?.kind).toBe("postMerge");
  });

  // -------------------------------------------------------------------------------------------
  // 2. The idempotency key
  // -------------------------------------------------------------------------------------------

  it("the idempotency key is IDENTICAL across two separate calls for one run identity, and different for every neighbouring identity", async () => {
    const identity = {
      orgId: org.orgId,
      changeObjectId: randomUUID(),
      hookId: "integration",
      waveIndex: 2
    };

    // The property the contract demands: "IDENTICAL every time ... including after a crash/resume
    // where the engine can't tell whether the previous call's side effect actually fired".
    expect(hookRunIdempotencyKey(identity)).toBe(hookRunIdempotencyKey({ ...identity }));

    // And DIFFERENT for a genuinely different run, in every axis of the identity — otherwise a
    // conformant executor would dedup two runs that must both happen, which is the same defect
    // wearing the opposite sign.
    const keys = new Set([
      hookRunIdempotencyKey(identity),
      hookRunIdempotencyKey({ ...identity, waveIndex: 3 }),
      hookRunIdempotencyKey({ ...identity, waveIndex: 0 }),
      // `null` (postMerge) MUST NOT collide with `0` (the first wave). They are different runs.
      hookRunIdempotencyKey({ ...identity, waveIndex: null }),
      hookRunIdempotencyKey({ ...identity, hookId: "smoke" }),
      hookRunIdempotencyKey({ ...identity, changeObjectId: randomUUID() }),
      hookRunIdempotencyKey({ ...identity, orgId: randomUUID() })
    ]);
    expect(keys.size).toBe(7);

    // It crosses a JSON-RPC boundary into third-party plugin code, so it stays in a charset and
    // length that no executor's own run-name rules can reject.
    expect(hookRunIdempotencyKey(identity)).toMatch(/^scp-hook-[a-f0-9]{64}$/);
  });

  // -------------------------------------------------------------------------------------------
  // 3. Trigger -> poll -> evidence, driven by the reconcile loop
  // -------------------------------------------------------------------------------------------

  /** Binds a fake executor to `targetObjectId` and returns the `targetRef` its `forcePhase` keys on.
   *  A UNIQUE instance id per case, because `statePath` is derived from it and stale state from a
   *  neighbouring test would otherwise answer this one's `status()` calls. */
  async function bindFakeExecutor(
    targetObjectId: string,
    phase: "succeeded" | "failed" | "running"
  ): Promise<string> {
    const externalRef = `hook-run-${label()}`;
    await inOrg((tx) =>
      upsertExecutorBinding(tx, {
        orgId: org.orgId,
        targetObjectId,
        pluginModule: "fake-executor",
        pluginInstanceId: `fake-hook-${label()}`,
        externalRef,
        // `forcePhase` is deterministic regardless of elapsed time — no sleep, no timing window.
        config: { forcePhase: { [externalRef]: phase } },
        actorObjectId: org.orgId,
        requestId: "hook-run-test-setup"
      })
    );
    return externalRef;
  }

  async function triggerRun(
    s: Awaited<ReturnType<typeof subject>>,
    over: {
      hookId: string;
      waveIndex: number | null;
      capturedWorkflow?: CapturedWorkflowRef | null;
      artifactDigest?: string | null;
    }
  ) {
    return ensureHookRunTriggered(
      server.deps.db,
      {
        orgId: org.orgId,
        host: server.deps.pluginHost!,
        masterKey: server.deps.config.secretsMasterKey
      },
      {
        hook: {
          componentObjectId: s.componentObjectId,
          kind: "postDeploy",
          hookId: over.hookId,
          workflow: { repo: "acme/pipelines", branch: "main", path: "workflows/integration.yaml" }
        },
        change: { objectId: s.changeObjectId },
        target: { objectId: s.targetObjectId },
        waveIndex: over.waveIndex,
        artifactDigest: over.artifactDigest ?? `sha256:${"c".repeat(64)}`,
        capturedWorkflow: over.capturedWorkflow === undefined ? captured() : over.capturedWorkflow
      }
    );
  }

  /** The evidence rows this (component, target, hook) holds — read with an explicit filter, because
   *  the claim here is a COUNT and a count needs a scoped query. */
  function evidenceRows(s: { targetObjectId: string }, hookId: string) {
    return inOrg((tx) =>
      tx
        .select()
        .from(pipelineEvidence)
        .where(
          and(
            eq(pipelineEvidence.orgId, org.orgId),
            eq(pipelineEvidence.targetObjectId, s.targetObjectId),
            eq(pipelineEvidence.hookId, hookId),
            eq(pipelineEvidence.kind, "testRun")
          )
        )
    );
  }

  it("a second ensureHookRunTriggered for the same identity returns the FIRST run and dispatches nothing new", async () => {
    const s = await subject(admin, "once");
    await bindFakeExecutor(s.targetObjectId, "running");

    const first = await triggerRun(s, { hookId: "integration", waveIndex: 1 });
    const second = await triggerRun(s, { hookId: "integration", waveIndex: 1 });

    expect(second.id).toBe(first.id);
    // The external run identity is the same too — the second call did not mint a second dispatch.
    expect(second.externalRunId).toBe(first.externalRunId);
    expect(first.externalRunId).not.toBeNull();

    // One row in the table, not two. The constraint is what makes this true, not the branch above.
    const rows = await inOrg((tx) =>
      tx
        .select()
        .from(pipelineHookRuns)
        .where(
          and(
            eq(pipelineHookRuns.orgId, org.orgId),
            eq(pipelineHookRuns.changeObjectId, s.changeObjectId),
            eq(pipelineHookRuns.hookId, "integration")
          )
        )
    );
    expect(rows).toHaveLength(1);
  });

  it("a run reaching a terminal phase writes EXACTLY ONE pipeline_evidence row with the right binding — driven by the reconcile loop, and observing it twice does not write a second", async () => {
    const s = await subject(admin, "terminal");
    await bindFakeExecutor(s.targetObjectId, "succeeded");
    const digest = `sha256:${"d".repeat(64)}`;

    const run = await triggerRun(s, {
      hookId: "integration",
      waveIndex: 1,
      artifactDigest: digest
    });
    expect(run.status).toBe("running");

    // THROUGH THE LOOP. Nothing below calls `pollNonTerminalHookRuns` — the running reconcile tick
    // does, which is the only version of this code path that exists in production.
    const rows = await waitUntil(
      async () => {
        const found = await evidenceRows(s, "integration");
        return found.length > 0 ? found : undefined;
      },
      { describe: "the reconcile loop to poll the hook run and write its evidence" }
    );
    expect(rows).toHaveLength(1);

    const stored = rows[0]!;
    // THE BINDING. Unbound evidence is not evidence — it would be read as covering whatever deploys
    // next — so the digest the run carried must be the digest the evidence carries.
    expect(stored.artifactDigest).toBe(digest);
    expect(stored.componentObjectId).toBe(s.componentObjectId);
    expect(stored.targetObjectId).toBe(s.targetObjectId);
    // SERVER-STAMPED provenance: this row came from SCP observing an executor, and no human
    // principal stands behind it.
    expect(stored.source).toBe("executor_observed");
    expect(stored.producerSubjectId).toBeNull();

    // The run itself is terminal and is therefore no longer in the poll's work list — which is the
    // property that stops the next tick re-triggering the suite.
    const terminal = await inOrg((tx) =>
      findHookRun(tx, {
        orgId: org.orgId,
        changeObjectId: s.changeObjectId,
        hookId: "integration",
        waveIndex: 1
      })
    );
    expect(terminal?.status).toBe("succeeded");
    expect(terminal?.lastObservedAt).not.toBeNull();
    const nonTerminal = await inOrg((tx) => listNonTerminalHookRuns(tx, org.orgId));
    expect(nonTerminal.some((r) => r.id === run.id)).toBe(false);

    // REACHING IT TWICE. The run is already terminal, so the reconcile loop will never look at it
    // again — this drives the edge guard DIRECTLY, which is safe precisely because the loop has
    // stopped competing for this row. A second terminal observation must move nothing and write
    // nothing.
    const repeat = await inOrg((tx) =>
      applyHookRunObservation(tx, org.orgId, terminal!, "succeeded", new Date())
    );
    expect(repeat.becameTerminal).toBe(false);
    expect(repeat.evidenceId).toBeUndefined();
    expect(await evidenceRows(s, "integration")).toHaveLength(1);
  }, 40_000);

  it("a terminal run with NO captured workflow records its status and writes NO evidence — D23's capture step does not exist, and a fabricated bundle digest would bind evidence to bytes nobody verified", async () => {
    const s = await subject(admin, "uncaptured");
    await bindFakeExecutor(s.targetObjectId, "succeeded");

    // `capturedWorkflow: null` is the state of EVERY run in this tree today.
    const run = await triggerRun(s, {
      hookId: "uncaptured",
      waveIndex: 1,
      capturedWorkflow: null
    });

    const terminal = await waitUntil(
      async () => {
        const found = await inOrg((tx) =>
          findHookRun(tx, {
            orgId: org.orgId,
            changeObjectId: s.changeObjectId,
            hookId: "uncaptured",
            waveIndex: 1
          })
        );
        return found && found.status === "succeeded" ? found : undefined;
      },
      { describe: "the reconcile loop to terminalize the uncaptured hook run" }
    );
    expect(terminal.id).toBe(run.id);
    // The run concluded; the evidence did not appear, and that is the designed outcome rather than
    // a failure — `pollNonTerminalHookRuns` logs the named reason.
    expect(await evidenceRows(s, "uncaptured")).toHaveLength(0);
  }, 40_000);

  // -------------------------------------------------------------------------------------------
  // 4. The round trip — the shapes match, rather than resembling each other
  // -------------------------------------------------------------------------------------------

  it("ROUND TRIP: the evidence this path produces feeds evaluatePostDeployGate UNRESHAPED — pass, fail, and an in-flight run as awaiting", async () => {
    const hook = { hookId: "integration" } as const;
    const now = new Date();

    // (a) IN FLIGHT -> `awaiting`. This is the state the whole increment exists to make survivable:
    // there is no evidence, the gate correctly says `awaiting`, AND a run row exists so the next
    // tick does not re-dispatch. Both halves are asserted, because either alone is the old bug.
    const flying = await subject(admin, "await");
    await bindFakeExecutor(flying.targetObjectId, "running");
    const flyingRun = await triggerRun(flying, { hookId: "integration", waveIndex: 1 });

    const noEvidence = await inOrg((tx) =>
      latestTestRunEvidence(tx, org.orgId, {
        componentObjectId: flying.componentObjectId,
        targetObjectId: flying.targetObjectId,
        hookId: "integration"
      })
    );
    expect(noEvidence).toBeNull();
    expect(evaluatePostDeployGate(hook, null, now)).toEqual({ outcome: "awaiting" });
    const stillFlying = await inOrg((tx) => listNonTerminalHookRuns(tx, org.orgId));
    expect(
      stillFlying.some((r) => r.id === flyingRun.id),
      "an in-flight run must stay in the poll's work list — that is what stops the re-trigger"
    ).toBe(true);

    // (b) PASS and (c) FAIL, each end to end through the loop.
    for (const [phase, expected] of [
      ["succeeded", "pass"],
      ["failed", "fail"]
    ] as const) {
      const s = await subject(admin, `rt-${phase}`);
      await bindFakeExecutor(s.targetObjectId, phase);
      const digest = `sha256:${phase === "succeeded" ? "e".repeat(64) : "f".repeat(64)}`;
      await triggerRun(s, { hookId: "integration", waveIndex: 1, artifactDigest: digest });

      const stored = await waitUntil(
        async () =>
          (await inOrg((tx) =>
            latestTestRunEvidence(tx, org.orgId, {
              componentObjectId: s.componentObjectId,
              targetObjectId: s.targetObjectId,
              hookId: "integration",
              artifactDigest: digest
            })
          )) ?? undefined,
        { describe: `the reconcile loop to write ${phase} evidence` }
      );

      // The stored payload is CONTRACT-VALID, not merely shaped like it. Parsing here is what proves
      // the driver wrote a `TestRunEvidence` rather than something that happens to have the keys —
      // the regexes on `commitSha` and `bundle.digest` are the pin's whole value.
      const parsed = TestRunEvidenceSchema.parse(stored.payload);

      // UNRESHAPED: the parsed evidence object goes straight in. No adapter, no field-picking, no
      // second spelling of `outcome` — if the producer and the consumer ever disagree about this
      // shape, this line stops compiling or stops passing.
      expect(evaluatePostDeployGate(hook, parsed, now)).toEqual({ outcome: expected });

      // ... and the pin really is the one the run carried.
      expect(parsed.workflow.commitSha).toBe(captured().commitSha);
      expect(parsed.workflow.bundle.digest).toBe(captured().bundle.digest);
      expect(parsed.hook).toBe("postDeploy");
      expect(parsed.runId.length).toBeGreaterThan(0);
    }
  }, 60_000);

  // -------------------------------------------------------------------------------------------
  // 5. RLS
  // -------------------------------------------------------------------------------------------

  it("RLS: a second org reads NONE of the first org's hook runs — proved by an UNFILTERED select under the other tenant, with the owner running the same query and seeing rows", async () => {
    const mine = await subject(admin, "rls");
    await rawInsert(mine, { hookId: `secret-${label()}`, waveIndex: 1 });

    // The other tenant holds rows of its own, so an empty result below cannot be an empty TABLE
    // mistaken for isolation.
    const theirs = await subject(otherAdmin, "rls-other");
    await rawInsert(theirs, { hookId: "theirs", waveIndex: 1 }, otherOrg.orgId);

    // NO `where` AT ALL. Anything this returns, RLS let through.
    const seenByOther = await inOrg((tx) => tx.select().from(pipelineHookRuns), otherOrg.orgId);
    expect(seenByOther.length, "the query works; it is not silently empty").toBeGreaterThan(0);
    expect(seenByOther.every((r) => r.orgId === otherOrg.orgId)).toBe(true);
    expect(seenByOther.some((r) => r.changeObjectId === mine.changeObjectId)).toBe(false);

    // The SAME unfiltered query from the OWNING tenant: present. Without this, the assertion above
    // is satisfied by a broken write path just as well as by a working policy.
    const seenByOwner = await inOrg((tx) => tx.select().from(pipelineHookRuns));
    expect(seenByOwner.some((r) => r.changeObjectId === mine.changeObjectId)).toBe(true);
    expect(seenByOwner.every((r) => r.orgId === org.orgId)).toBe(true);
  });

  it("RLS WITH CHECK: a tenant cannot WRITE a hook run stamped with another org's id", async () => {
    const mine = await subject(admin, "rls-write");
    const refusal = await inOrg(
      (tx) =>
        // A valid session for its OWN org, simply naming another org on the row. The FK to `objects`
        // is org-unbound and would happily accept the foreign ids; the policy's WITH CHECK half is
        // the only thing standing here.
        tx.insert(pipelineHookRuns).values({
          id: uuidv7(),
          orgId: org.orgId,
          componentObjectId: mine.componentObjectId,
          targetObjectId: mine.targetObjectId,
          changeObjectId: mine.changeObjectId,
          hookId: "forged",
          kind: "postDeploy",
          waveIndex: 1,
          status: "pending",
          pluginInstanceId: "forged"
        }),
      otherOrg.orgId
    ).then(
      () => null,
      (err: unknown) => unwrapDriverError(err)
    );
    // The SQLSTATE is asserted rather than "it threw": this insert carries NOT NULL columns, three
    // foreign keys, a primary key, a CHECK and a unique constraint, so a bare `.rejects.toThrow()`
    // would stay green if the policy were dropped and something unrelated failed instead. `42501`
    // is the policy refusing.
    expect(refusal, "WITH CHECK must refuse a cross-org INSERT").not.toBeNull();
    expect((refusal as { code?: string }).code).toBe("42501");

    const landed = await inOrg((tx) =>
      findHookRun(tx, {
        orgId: org.orgId,
        changeObjectId: mine.changeObjectId,
        hookId: "forged",
        waveIndex: 1
      })
    );
    expect(landed).toBeUndefined();
  });

  it("the status CHECK constraint refuses a phase that is not an ExecutionPhase member", async () => {
    const s = await subject(admin, "status-check");
    const refusal = await rawInsert(s, { hookId: "bad-status", waveIndex: 1 })
      .then(() => null)
      .catch(() => null);
    expect(refusal).toBeNull(); // the control: a legal status inserts.

    const bad = inOrg((tx) =>
      tx.insert(pipelineHookRuns).values({
        id: uuidv7(),
        orgId: org.orgId,
        componentObjectId: s.componentObjectId,
        targetObjectId: s.targetObjectId,
        changeObjectId: s.changeObjectId,
        hookId: "bad-status-2",
        kind: "postDeploy",
        waveIndex: 1,
        // No Zod schema stands over this column — `ExecutionPhase` is a TS union in a package with
        // no `@scp/schemas` dependency — so the constraint is the only guard there is.
        status: "in_progress",
        pluginInstanceId: "x"
      })
    );
    await expect(bad).rejects.toSatisfy((err: unknown) => {
      const pg = unwrapDriverError(err) as { code?: string; constraint?: string };
      return pg.code === "23514" && pg.constraint === "pipeline_hook_runs_status_check";
    });
  });
});
