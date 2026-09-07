import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { ScpClient } from "@scp/sdk";
import { withTenantTx } from "../db/tenant-tx.js";
import { changeSourceEvents, changes, pipelineEvidence, pipelineHookRuns } from "../db/schema.js";
import { upsertExecutorBinding } from "./executor-bindings-repo.js";
import { upsertHook } from "./pipeline-hooks-repo.js";
import { evaluatePipelineHookGate } from "./pipeline-hook-gate.js";
import { deriveCapturedWorkflow, ensureHookRunTriggered } from "./pipeline-hook-runs.js";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  waitUntil,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/** D23 — THE TEST-BUNDLE PATH, END TO END. See docs/coordination.md §985. */
describe("D23 test bundle: report -> capture -> evidence -> gate", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    // `withEventRelay` IS REQUIRED, not decorative — the harness nests the reconcile-loop start
    // inside the relay block (it is the relay's pg-boss the loop schedules its tick on). Omitting it
    // starts no loop and no error, and every loop-driven assertion below becomes a timeout that
    // reads like a slow engine rather than an absent one.
    server = await listenTestServer({ withEventRelay: true, withReconcileLoop: true });
    org = await createTestOrg(server, "test-bundle");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const label = () => randomUUID().slice(0, 8);

  const inOrg = <T>(fn: Parameters<typeof withTenantTx<T>>[2]) =>
    withTenantTx(server.deps.db, org.orgId, fn);

  const BUNDLE_DIGEST = `sha256:${"7c".repeat(32)}`;
  const IMAGE_DIGEST = `sha256:${"1f".repeat(32)}`;
  const BUILT_COMMIT = "9".repeat(40);
  /** The DECLARED half — repo, branch, path within the pipeline's own source (`WorkflowRefSchema`).
   *  On its own it is "a pointer into whatever the cluster holds right now", which is exactly what
   *  D23 refuses to gate on; the pin needs the built commit and the bundle beside it. */
  const DECLARED_WORKFLOW = {
    repo: "acme/pipelines",
    branch: "main",
    path: "workflows/integration.yaml"
  };

  /** Reports a build through the REAL typed ingress and returns the change it produced. */
  async function reportBuild(body: Record<string, unknown>): Promise<string> {
    const component = await createTestComponent(admin, { name: `bundle-comp-${label()}` });
    const repo = `acme/${label()}`;
    await admin.changeSources.createMapping("terraform", {
      repoPattern: repo,
      component: component.id
    });
    const { eventId } = await admin.changeSources.report("terraform", {
      status: "applied",
      repo,
      ...body
    } as Parameters<typeof admin.changeSources.report>[1]);

    // The loop's own processor will get to this event; driving it here makes the case deterministic
    // rather than adding a second thing to wait on.
    return await waitUntil(
      async () => {
        const rows = await inOrg((tx) =>
          tx.select().from(changeSourceEvents).where(eq(changeSourceEvents.id, eventId))
        );
        return rows[0]?.resultingChangeObjectId ?? undefined;
      },
      { describe: `the reported build to produce a Change (event ${eventId})` }
    );
  }

  async function readSourceRef(changeObjectId: string): Promise<Record<string, unknown>> {
    const rows = await inOrg((tx) =>
      tx.select().from(changes).where(eq(changes.objectId, changeObjectId))
    );
    return (rows[0]!.sourceRef ?? {}) as Record<string, unknown>;
  }

  /** The hook's SUBJECT — see the fixture note in this file's header. `forcePhase` is deterministic
   *  regardless of elapsed time, so nothing below sleeps or races a timer. */
  async function hookSubject(phase: "succeeded" | "running") {
    const subject = await admin.object("deployment-target").create({
      name: `hooked-${label()}`,
      properties: { environment: "prod" }
    });
    const externalRef = `bundle-run-${label()}`;
    await inOrg((tx) =>
      upsertExecutorBinding(tx, {
        orgId: org.orgId,
        targetObjectId: subject.id,
        pluginModule: "fake-executor",
        pluginInstanceId: `fake-bundle-${label()}`,
        externalRef,
        config: { forcePhase: { [externalRef]: phase } },
        actorObjectId: org.orgId,
        requestId: "test-bundle-setup"
      })
    );
    return subject.id;
  }

  /** Declares a real `postDeploy` hook on the subject — no `stage`, which per D21(a) gates EVERY
   *  wave's exit (adding a `stage` REMOVES gates; the strict end is the default). */
  const declareHook = (subjectId: string, hookId: string) =>
    inOrg((tx) =>
      upsertHook(tx, org.orgId, {
        componentObjectId: subjectId,
        kind: "postDeploy",
        hookId,
        workflow: DECLARED_WORKFLOW
      })
    );

  /** The declared-hook contribution to the wave-boundary gate, for the exit of a wave this subject
   *  deployed in. This is a READ-ONLY predicate — no engine work, nothing for the running loop to
   *  race — so calling it directly asks exactly the question `evaluateWaveGate` asks. */
  const gateFor = (changeObjectId: string, subjectId: string) =>
    inOrg((tx) =>
      evaluatePipelineHookGate(tx, {
        orgId: org.orgId,
        changeObjectId,
        previousWave: {
          waveIndex: 0,
          stage: null,
          targets: [{ targetObjectId: subjectId, deployedAt: new Date().toISOString() }]
        },
        admittedTargets: []
      })
    );

  const triggerHookRun = (changeObjectId: string, subjectId: string, hookId: string) =>
    ensureHookRunTriggered(
      server.deps.db,
      {
        orgId: org.orgId,
        host: server.deps.pluginHost!,
        masterKey: server.deps.config.secretsMasterKey
      },
      {
        hook: {
          componentObjectId: subjectId,
          kind: "postDeploy",
          hookId,
          workflow: DECLARED_WORKFLOW
        },
        change: { objectId: changeObjectId },
        target: { objectId: subjectId },
        waveIndex: 0,
        artifactDigest: IMAGE_DIGEST
        // `capturedWorkflow` is DELIBERATELY NOT PASSED. The pin is derived inside the claim
        // transaction from the change's own `source_ref`, which is the whole point: a caller cannot
        // forget it and silently get a run that writes no evidence.
      }
    );

  const evidenceRows = (subjectId: string, hookId: string) =>
    inOrg((tx) =>
      tx
        .select()
        .from(pipelineEvidence)
        .where(
          and(
            eq(pipelineEvidence.orgId, org.orgId),
            eq(pipelineEvidence.targetObjectId, subjectId),
            eq(pipelineEvidence.hookId, hookId),
            eq(pipelineEvidence.kind, "testRun")
          )
        )
    );

  const runRow = (runId: string) =>
    inOrg(async (tx) => {
      const rows = await tx
        .select()
        .from(pipelineHookRuns)
        .where(and(eq(pipelineHookRuns.orgId, org.orgId), eq(pipelineHookRuns.id, runId)));
      return rows[0]!;
    });

  it("a build's report carrying a TEST BUNDLE reference lands it on the change's sourceRef.testBundle — reference only, nothing minted", async () => {
    const changeObjectId = await reportBuild({
      artifactDigest: IMAGE_DIGEST,
      commitSha: BUILT_COMMIT,
      testBundle: { repository: "acme/api-tests", digest: BUNDLE_DIGEST }
    });

    const sourceRef = await readSourceRef(changeObjectId);
    expect(sourceRef.testBundle).toEqual({
      repository: "acme/api-tests",
      digest: BUNDLE_DIGEST
    });

    // A REFERENCE: two short strings naming WHERE the bundle lives and WHAT it hashes to. SCP holds
    // no bundle bytes, has no column that could, and builds and signs nothing.
    for (const [key, value] of Object.entries(sourceRef.testBundle as Record<string, unknown>)) {
      expect(typeof value, `testBundle.${key} must be a string reference field`).toBe("string");
      expect((value as string).length).toBeLessThan(512);
    }

    // ADR-0045 D2 — REPORTING MINTS NOTHING. See docs/coordination.md §986.
    const artifacts = await admin.object("artifact").list();
    expect(artifacts.items.map((a) => (a.properties as { digest?: string }).digest)).not.toContain(
      BUNDLE_DIGEST
    );
  });

  it("a report WITHOUT a testBundle is unaffected — the field is optional and purely additive, so every existing reporter keeps reporting", async () => {
    const changeObjectId = await reportBuild({
      artifactDigest: IMAGE_DIGEST,
      workspace: "prod"
    });

    const sourceRef = await readSourceRef(changeObjectId);
    // Absent, not an invented empty object — the same "nothing invented" contract `sbom` holds.
    expect(sourceRef.testBundle).toBeUndefined();
    expect(sourceRef.testBundle_invalid).toBeUndefined();
    // ...and everything the pre-D23 reporter sent still lands exactly where it did.
    expect(sourceRef.artifact_digest).toBe(IMAGE_DIGEST);
    expect(sourceRef.workspace).toBe("prod");
  });

  it("an UNDECLARED key on the report body is still REFUSED (400), not silently stripped — which is why testBundle had to be declared rather than merely read", async () => {
    const repo = `acme/${label()}`;
    const before = await inOrg((tx) => tx.select().from(changeSourceEvents));

    // Raw HTTP, not the SDK: the SDK's types cannot express a field the contract does not define.
    const response = await fetch(`${server.baseUrl}/change-sources/terraform/report`, {
      method: "POST",
      headers: { authorization: `Bearer ${org.adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        status: "applied",
        repo,
        // Plausible, adjacent, and NOT the declared name. Under a non-strict object this would 202
        // and vanish, and every hook run of every such build would skip evidence with
        // `no_captured_workflow` — the exact silent failure this increment exists to close.
        testBundleRef: { repository: "acme/api-tests", digest: BUNDLE_DIGEST }
      })
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(JSON.stringify(body)).toContain("testBundleRef");

    // Refused OUTRIGHT — no event row, so there is no half-persisted trace to reason about later.
    const after = await inOrg((tx) => tx.select().from(changeSourceEvents));
    expect(after.length).toBe(before.length);
  });

  // -------------------------------------------------------------------------------------------
  // 3. THE CLOSE — the property the whole increment exists for
  // -------------------------------------------------------------------------------------------

  it("THE END-TO-END CLOSE: a build reports a bundle -> the hook run captures it -> the reconcile loop terminalizes it -> evidence is written -> the gate that was BLOCKING is satisfied", async () => {
    const hookId = `integration-${label()}`;
    const subjectId = await hookSubject("succeeded");
    await declareHook(subjectId, hookId);

    const changeObjectId = await reportBuild({
      artifactDigest: IMAGE_DIGEST,
      commitSha: BUILT_COMMIT,
      testBundle: { repository: "acme/api-tests", digest: BUNDLE_DIGEST }
    });

    // (a) THE GATE IS BLOCKING. A declared postDeploy hook with no evidence is `awaiting`, and a
    // wave whose exit it gates does not widen. Asserted BEFORE anything runs, so the pass at the end
    // is a change of state rather than a gate that was never blocking in the first place.
    const blocking = await gateFor(changeObjectId, subjectId);
    expect(blocking.allowed).toBe(false);
    expect(blocking.entries).toHaveLength(1);
    expect(blocking.entries[0]).toMatchObject({
      kind: "postDeploy",
      hookId,
      outcome: "awaiting",
      satisfied: false
    });

    // (b) THE CAPTURE. Three facts, all read: the DECLARED workflow off the hook, the BUILT commit
    // off the change, and the bundle the build REPORTED. Nothing here was passed in by the caller —
    // `triggerHookRun` supplies no `capturedWorkflow`.
    const run = await triggerHookRun(changeObjectId, subjectId, hookId);
    expect(run.status).toBe("running");
    expect(run.capturedWorkflow).toEqual({
      ...DECLARED_WORKFLOW,
      commitSha: BUILT_COMMIT,
      bundle: { repository: "acme/api-tests", digest: BUNDLE_DIGEST }
    });

    // (c) THROUGH THE LOOP. Nothing below calls `pollNonTerminalHookRuns` — the running reconcile
    // tick does, which is the only version of this path that runs in production.
    const written = await waitUntil(
      async () => {
        const rows = await evidenceRows(subjectId, hookId);
        return rows.length > 0 ? rows : undefined;
      },
      { describe: "the reconcile loop to poll the captured hook run and write its evidence" }
    );
    expect(written).toHaveLength(1);
    const stored = written[0]!;
    // The evidence carries the D23 pin VERBATIM — this is what makes "which tests gated this wave"
    // answerable as a statement about specific bytes, identically in a domain that has never seen
    // the repo.
    expect((stored.payload as { workflow?: unknown }).workflow).toEqual({
      ...DECLARED_WORKFLOW,
      commitSha: BUILT_COMMIT,
      bundle: { repository: "acme/api-tests", digest: BUNDLE_DIGEST }
    });
    // ...and it is BOUND: to the digest the run carried, under server-stamped provenance.
    expect(stored.artifactDigest).toBe(IMAGE_DIGEST);
    expect(stored.source).toBe("executor_observed");
    expect(stored.producerSubjectId).toBeNull();

    // (d) THE GATE NOW PASSES. Same context, same subject, same change — only the evidence moved.
    const satisfied = await gateFor(changeObjectId, subjectId);
    expect(satisfied.allowed).toBe(true);
    expect(satisfied.entries[0]).toMatchObject({ hookId, outcome: "pass", satisfied: true });
  }, 60_000);

  // -------------------------------------------------------------------------------------------
  // 4. NO BUNDLE REPORTED — today's behaviour, unchanged and still loud
  // -------------------------------------------------------------------------------------------

  it("with NO testBundle reported, captured_workflow stays NULL, NO evidence is written, the named reason is logged, and the gate keeps holding", async () => {
    const hookId = `uncaptured-${label()}`;
    const subjectId = await hookSubject("succeeded");
    await declareHook(subjectId, hookId);

    // Everything a run needs EXCEPT the bundle: a real commit, a real digest, a real declared
    // workflow. Two of the three facts is not a pin.
    const changeObjectId = await reportBuild({
      artifactDigest: IMAGE_DIGEST,
      commitSha: BUILT_COMMIT
    });

    const logged: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => String(a)).join(" "));
    });

    const run = await triggerHookRun(changeObjectId, subjectId, hookId);
    // NOT fabricated. Not the branch tip for the commit, not a zero digest, not a bundle repository
    // guessed from the image repository — a location SCP invented would bind a gate verdict to bytes
    // nobody verified.
    expect(run.capturedWorkflow).toBeNull();

    // The run still concludes: the status is recorded, which is what stops the next tick
    // re-dispatching the suite forever.
    const terminal = await waitUntil(
      async () => {
        const row = await runRow(run.id);
        return row.status === "succeeded" ? row : undefined;
      },
      { describe: "the reconcile loop to terminalize the uncaptured hook run" }
    );
    expect(terminal.capturedWorkflow).toBeNull();

    // NO evidence — the designed outcome, not a failure.
    expect(await evidenceRows(subjectId, hookId)).toHaveLength(0);

    // ...and the operator is TOLD, by name, on the channel `pollNonTerminalHookRuns` actually uses.
    // A gate that stays `awaiting` after its suite finished is otherwise a mystery hang, and the
    // reason matters because the operator's next action differs per reason.
    await waitUntil(
      async () =>
        logged.some((line) => line.includes(run.id) && line.includes("no_captured_workflow")),
      { describe: "the poll driver to name why no evidence was written" }
    );

    // The gate is therefore STILL holding — which is the honest end state for a suite whose result
    // cannot be pinned to anything.
    const gate = await gateFor(changeObjectId, subjectId);
    expect(gate.allowed).toBe(false);
    expect(gate.entries[0]).toMatchObject({ hookId, outcome: "awaiting", satisfied: false });
  }, 60_000);

  // 4b. The derivation's refusals, stated one at a time

  it("deriveCapturedWorkflow refuses each missing fact INDIVIDUALLY, and refuses a non-canonical one — no partial pin exists", () => {
    const full = {
      commit: BUILT_COMMIT,
      commitSha: BUILT_COMMIT,
      artifact_digest: IMAGE_DIGEST,
      testBundle: { repository: "acme/api-tests", digest: BUNDLE_DIGEST }
    };

    // The positive control first — without it every refusal below could be "this never works".
    expect(deriveCapturedWorkflow(DECLARED_WORKFLOW, full)).toEqual({
      ...DECLARED_WORKFLOW,
      commitSha: BUILT_COMMIT,
      bundle: { repository: "acme/api-tests", digest: BUNDLE_DIGEST }
    });

    // 1. No declared workflow (a hook that names none).
    expect(deriveCapturedWorkflow(null, full)).toBeNull();
    expect(deriveCapturedWorkflow({ repo: "acme/pipelines" }, full)).toBeNull();
    // 2. No built commit — and NOT the branch tip instead.
    expect(deriveCapturedWorkflow(DECLARED_WORKFLOW, { testBundle: full.testBundle })).toBeNull();
    // 3. No reported bundle — and NOT one inferred by convention from the image repository.
    expect(deriveCapturedWorkflow(DECLARED_WORKFLOW, { commitSha: BUILT_COMMIT })).toBeNull();
    // 4. A bundle whose digest is not canonical `sha256:<64-lowercase-hex>`. Parsed, not assembled:
    //    a value that merely has the right KEYS is not a pin, because the regexes are what make the
    //    evidence a statement about specific bytes rather than about the word "passed".
    expect(
      deriveCapturedWorkflow(DECLARED_WORKFLOW, {
        ...full,
        testBundle: { repository: "acme/api-tests", digest: "latest" }
      })
    ).toBeNull();
    // 5. A short commit sha. Same reason.
    expect(
      deriveCapturedWorkflow(DECLARED_WORKFLOW, { ...full, commitSha: BUILT_COMMIT.slice(0, 7) })
    ).toBeNull();
  });
});
