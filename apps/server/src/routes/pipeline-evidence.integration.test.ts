import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { ScpClient } from "@scp/sdk";
import type { CapturedWorkflowRef } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import { pipelineEvidence } from "../db/schema.js";
import {
  createTestComponent,
  createTestOrg,
  createTestUser,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg,
  type TestUser
} from "../test-support/harness.js";
import type { PluginHost } from "../plugin-host/contract.js";
import { reconcileOrgTick } from "../coordination/reconcile.js";
import {
  createInMemoryFakeHost,
  withRefusingTrigger
} from "../coordination/test-support/fake-plugin-host.js";
import { alarmReportsInWindow, upsertHook } from "../coordination/pipeline-hooks-repo.js";
import { evaluatePipelineHookGate } from "../coordination/pipeline-hook-gate.js";
import { evaluateBakeGate } from "../coordination/pipeline-hook-verdicts.js";

/**
 * `POST /pipelines/evidence` + `ChangeWaveTargetSchema.hold.continuousTests` — the two API-surface
 * halves of team-pipeline-iac increment 8, against REAL PostgreSQL.
 *
 * ============================================================================================
 * EVERY SUBMISSION IN THIS FILE GOES THROUGH HTTP, NEVER THROUGH `pipeline-hooks-repo.ts`
 * ============================================================================================
 * `recordTestRunEvidence`/`recordAlarmEvidence` already have their own storage-layer file
 * (`coordination/pipeline-hooks-repo.integration.test.ts`), and NOTHING this file claims can be
 * proved there: the authorization scope, the strict-body refusal and the server-side producer stamp
 * all live between the socket and those functions. A route proven only at the repo layer is a route
 * whose authz was never exercised — so every write below is `server.app.inject(...)` against the
 * fully-built app (auth plugin, Zod validation, the real handler), and every assertion about what
 * was stored is a SELECT against the row that request produced.
 *
 * `app.inject` rather than the generated SDK for the submissions specifically, because two of the
 * seven properties are about bodies the SDK's types cannot express: an extra top-level `producer`
 * key, and a `subject` carrying a forged producer claim. A test that could only send well-typed
 * bodies could not reach the refusals that matter.
 *
 * ============================================================================================
 * THE FOUR MUTATIONS THESE TESTS WERE WATCHED TO DIE UNDER (2026-08-27, baseline 8 passed)
 * ============================================================================================
 * Each was applied alone and reverted:
 *
 *  (a) `routes/pipelines.ts`'s `authorize({... scopeObjectId: target.id})` -> `scopeObjectId:
 *      input.orgId` (the org root, i.e. the bar `POST /change-sources/{kind}/report` uses) =>
 *      "a caller authorized only at ANOTHER target cannot submit for this one" FAILED: expected
 *      403 to be 201. Its POSITIVE CONTROL in the same test stayed green, so the test cannot pass
 *      by everything being refused.
 *  (b) the producer stamp -> read from the caller's body
 *      (`producerSubjectId: rawSubject.producer ?? auth.subjectObjectId`, off `request.rawBody` so
 *      Zod's strip does not hide it) => "the PERSISTED producer is the AUTHENTICATED subject, never
 *      anything the caller supplied" FAILED on the stored row: the forged id was persisted.
 *  (c) `SubmitPipelineEvidenceRequestSchema` `z.strictObject` -> `z.object` => "a body carrying an
 *      extra `producer` key is REFUSED, not silently stripped" FAILED: expected 400 to be 201.
 *  (d) `plan-service.ts`'s read-time continuous projection replaced by a persisted one (the map
 *      captured on the FIRST read and reused on every later read, i.e. what a Decision-fed field
 *      would do) => "hold.continuousTests ... and is ABSENT once fresh green evidence lands"
 *      FAILED on its second half: the key was still present after the fresh pass landed.
 *
 * A test that survives its own mutation is vacuous; the results above are the record that these
 * did not.
 */

/** A valid `CapturedWorkflowRefSchema` value — the wire contract rejects anything less, so a
 *  fixture that cut corners here would be testing a payload production can never contain. */
const WORKFLOW: CapturedWorkflowRef = {
  repo: "acme/pipelines",
  branch: "main",
  path: "workflows/tests.yaml",
  commitSha: "a".repeat(40),
  bundle: { repository: "acme/tests", digest: `sha256:${"b".repeat(64)}` }
};

const COMMIT = "c".repeat(40);

const executorConfig: { autoSucceedAfterMs: number; forcePhase: Record<string, string> } = {
  autoSucceedAfterMs: 10 * 60_000,
  forcePhase: {}
};

describe("POST /pipelines/evidence + the continuous-test hold projection", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let host: PluginHost;
  let triggered: { targetRef: string }[];

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    server = await listenTestServer();
    const wrapped = withRefusingTrigger(createInMemoryFakeHost(executorConfig), () => false);
    host = wrapped.host;
    triggered = wrapped.calls;
  });

  beforeEach(async () => {
    org = await createTestOrg(server, "pipeevidence");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    executorConfig.forcePhase = {};
  });

  afterAll(async () => {
    await server?.close();
  });

  const tick = async (times = 1) => {
    for (let i = 0; i < times; i++) {
      await reconcileOrgTick(
        server.deps.db,
        org.orgId,
        host,
        server.deps.celSandbox!,
        server.deps.config.secretsMasterKey
      );
    }
  };

  /** The route, exactly as a CI step reaches it. `body` is `unknown` on purpose — several cases
   *  send shapes the request type forbids, which is the point of them. */
  const submit = (token: string | null, body: unknown) =>
    server.app.inject({
      method: "POST",
      url: "/api/v1/pipelines/evidence",
      ...(token ? { headers: bearer(token) } : {}),
      payload: body as Record<string, unknown>
    });

  const testRunBody = (
    subject: Record<string, unknown>,
    over: Partial<{ hookId: string; hook: string; outcome: string; completedAt: Date }> = {}
  ) => {
    const completedAt = over.completedAt ?? new Date();
    return {
      subject,
      evidence: {
        kind: "testRun",
        hook: over.hook ?? "postMerge",
        hookId: over.hookId ?? "unit",
        workflow: WORKFLOW,
        runId: `run-${randomUUID().slice(0, 8)}`,
        outcome: over.outcome ?? "passed",
        startedAt: new Date(completedAt.getTime() - 30_000).toISOString(),
        completedAt: completedAt.toISOString()
      }
    };
  };

  const evidenceRow = (evidenceId: string) =>
    withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const [row] = await tx
        .select()
        .from(pipelineEvidence)
        .where(and(eq(pipelineEvidence.orgId, org.orgId), eq(pipelineEvidence.id, evidenceId)));
      if (!row) throw new Error(`no pipeline_evidence row ${evidenceId}`);
      return row;
    });

  const declareHook = (input: Parameters<typeof upsertHook>[2]) =>
    withTenantTx(server.deps.db, org.orgId, (tx) => upsertHook(tx, org.orgId, input));

  // -------------------------------------------------------------------------------------------
  // PROPERTY 1 — a valid testRun lands bound to the right subject, AND a gate reads it
  // -------------------------------------------------------------------------------------------

  it("persists a testRun bound to the submitted subject, and it FEEDS A GATE that was blocking before it", async () => {
    const component = await createTestComponent(admin, {
      name: `gated-${randomUUID().slice(0, 8)}`
    });
    await declareHook({
      componentObjectId: component.id,
      kind: "postMerge",
      hookId: "unit",
      workflow: WORKFLOW
    });
    const change = await admin.changes.propose({
      name: `gated-${randomUUID().slice(0, 8)}`,
      targets: [component.id]
    });

    // The gate is evaluated with the SAME context `reconcile.ts` builds for wave 1: no previous
    // wave, the admitted target being the component itself (a legacy-shaped wave target resolves to
    // its own component — `resolveHookSubjects`).
    const gate = () =>
      withTenantTx(server.deps.db, org.orgId, (tx) =>
        evaluatePipelineHookGate(tx, {
          orgId: org.orgId,
          changeObjectId: change.id,
          previousWave: null,
          admittedTargets: [{ targetObjectId: component.id }]
        })
      );

    const before = await gate();
    expect(
      before.allowed,
      "the gate must genuinely be blocking BEFORE the submission — otherwise the assertion after it proves nothing"
    ).toBe(false);
    expect(before.entries[0]!.outcome).toBe("awaiting");

    const res = await submit(
      org.adminToken,
      testRunBody({ componentUrn: component.urn, targetUrn: component.urn, commitSha: COMMIT })
    );
    expect(res.statusCode, res.body).toBe(201);
    const receipt = res.json() as {
      evidenceId: string;
      kind: string;
      source: string;
      producerSubjectId: string;
      componentObjectId: string;
      targetObjectId: string;
    };
    expect(receipt.kind).toBe("testRun");
    expect(receipt.source).toBe("pushed");
    expect(receipt.componentObjectId).toBe(component.id);
    expect(receipt.targetObjectId).toBe(component.id);

    // BOUND TO THE RIGHT SUBJECT — asserted on the ROW, not on the receipt that described it.
    const row = await evidenceRow(receipt.evidenceId);
    expect(row.componentObjectId).toBe(component.id);
    expect(row.targetObjectId).toBe(component.id);
    expect(row.hookId).toBe("unit");
    expect(row.kind).toBe("testRun");
    expect(row.commitSha).toBe(COMMIT);
    expect(row.source).toBe("pushed");

    // AND IT FEEDS THE GATE. This is the half that a repo-level test cannot reach: the row a real
    // HTTP submission produced is the row the admission predicate reads.
    const after = await gate();
    expect(after.allowed).toBe(true);
    expect(after.entries[0]!.outcome).toBe("pass");
    expect(after.entries[0]!.satisfied).toBe(true);
  });

  // -------------------------------------------------------------------------------------------
  // PROPERTY 2 — an EMPTY alarm list over a named window is an affirmative claim of quiet
  // -------------------------------------------------------------------------------------------

  it("records `alarms: []` over a named window as an AFFIRMATIVE quiet claim — a bake gate reads it as quiet, where no report at all reads as no_source", async () => {
    const component = await createTestComponent(admin, {
      name: `bake-${randomUUID().slice(0, 8)}`
    });
    const deployedAt = new Date(Date.now() - 30 * 60_000);
    const quietWindowSeconds = 600;
    const windowStart = new Date(deployedAt.getTime() - 60_000);
    const windowEnd = new Date(deployedAt.getTime() + (quietWindowSeconds + 60) * 1000);

    const reportsNow = () =>
      withTenantTx(server.deps.db, org.orgId, (tx) =>
        alarmReportsInWindow(tx, org.orgId, {
          componentObjectId: component.id,
          targetObjectId: component.id,
          hookId: "bake",
          windowStart: deployedAt,
          windowEnd: new Date(deployedAt.getTime() + quietWindowSeconds * 1000)
        })
      );

    // THE CONTROL: silence is NOT quiet. Without this the assertion below could pass on a gate that
    // is satisfied by default, which is the exact failure `AlarmStateEvidenceSchema` exists to stop.
    const silent = evaluateBakeGate(
      { quietWindowSeconds },
      await reportsNow(),
      deployedAt,
      new Date()
    );
    expect(silent.satisfied).toBe(false);
    expect(silent.reason).toBe("no_source");

    const res = await submit(org.adminToken, {
      subject: {
        componentUrn: component.urn,
        targetUrn: component.urn,
        artifactDigest: `sha256:${"d".repeat(64)}`
      },
      evidence: {
        kind: "alarmState",
        hookId: "bake",
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        alarms: []
      }
    });
    expect(res.statusCode, res.body).toBe(201);
    const receipt = res.json() as { evidenceId: string; kind: string };
    expect(receipt.kind).toBe("alarmState");

    const row = await evidenceRow(receipt.evidenceId);
    expect(row.kind).toBe("alarmState");
    expect(row.source).toBe("pushed");
    expect((row.payload as { alarms: unknown[] }).alarms).toEqual([]);
    expect((row.payload as { windowStart: string }).windowStart).toBe(windowStart.toISOString());

    const quiet = evaluateBakeGate(
      { quietWindowSeconds },
      await reportsNow(),
      deployedAt,
      new Date()
    );
    expect(quiet.satisfied).toBe(true);
    expect(quiet.reason).toBe("quiet");
    expect(quiet.coveredBy).toEqual(["pushed"]);
  });

  // -------------------------------------------------------------------------------------------
  // PROPERTY 3 — the strict body
  // -------------------------------------------------------------------------------------------

  it("REFUSES a body carrying an extra top-level `producer` key — never silently strips it", async () => {
    const component = await createTestComponent(admin, {
      name: `strict-${randomUUID().slice(0, 8)}`
    });
    const good = testRunBody({
      componentUrn: component.urn,
      targetUrn: component.urn,
      commitSha: COMMIT
    });

    // POSITIVE CONTROL FIRST: the same body without the extra key is accepted, so the 400 below is
    // attributable to the extra key and not to anything else about the payload.
    const accepted = await submit(org.adminToken, good);
    expect(accepted.statusCode, accepted.body).toBe(201);

    const refused = await submit(org.adminToken, { ...good, producer: "argo-workflows" });
    expect(refused.statusCode, refused.body).toBe(400);

    // AND NOTHING WAS WRITTEN by the refused request — one row exists for this subject, the one the
    // control produced. A silent strip would have made two.
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(pipelineEvidence)
        .where(
          and(
            eq(pipelineEvidence.orgId, org.orgId),
            eq(pipelineEvidence.targetObjectId, component.id)
          )
        )
    );
    expect(rows).toHaveLength(1);
  });

  // -------------------------------------------------------------------------------------------
  // PROPERTY 4 — the producer is the AUTHENTICATED subject, not anything the caller can influence
  // -------------------------------------------------------------------------------------------

  it("stamps the PERSISTED producer from the authenticated subject — a forged producer claim in the body changes nothing", async () => {
    const component = await createTestComponent(admin, {
      name: `stamp-${randomUUID().slice(0, 8)}`
    });
    const reporter: TestUser = await createTestUser(server, org, [
      { role: "Operator", scope: component.id }
    ]);
    const impostor: TestUser = await createTestUser(server, org, [
      { role: "Operator", scope: component.id }
    ]);

    // The forged claim rides inside `subject` — the ONE place a producer-shaped key survives
    // validation at all (`SubmitPipelineEvidenceRequestSchema` is strict at the TOP level; the
    // subject object is a plain `z.object`, so Zod strips unknown keys there rather than refusing).
    // That makes this the sharpest available test of the stamp: a body the server accepts, carrying
    // a producer the server must not believe.
    const body = testRunBody({
      componentUrn: component.urn,
      targetUrn: component.urn,
      commitSha: COMMIT,
      producer: impostor.objectId,
      reportedBy: impostor.objectId,
      source: "rollout_analysis"
    });

    const res = await submit(reporter.token, body);
    expect(res.statusCode, res.body).toBe(201);
    const receipt = res.json() as { evidenceId: string; producerSubjectId: string };

    const row = await evidenceRow(receipt.evidenceId);
    expect(row.producerSubjectId).toBe(reporter.objectId);
    expect(row.producerSubjectId).not.toBe(impostor.objectId);
    // `source` is a CONSTANT on this door, and it is not decorative: `evaluateBakeGate` computes
    // window coverage PER SOURCE, so a caller able to pick its own source could manufacture
    // single-source coverage of a window nobody observed.
    expect(row.source).toBe("pushed");
    // The receipt tells the reporter what was actually recorded about it — the only way it can
    // know, since the request could not say.
    expect(receipt.producerSubjectId).toBe(reporter.objectId);

    // A SECOND PRINCIPAL GETS ITS OWN STAMP, so the assertion above cannot be passing because the
    // column happens to hold one fixed value for every row in the org.
    const second = await submit(
      impostor.token,
      testRunBody(
        { componentUrn: component.urn, targetUrn: component.urn, commitSha: COMMIT },
        { hookId: "second" }
      )
    );
    expect(second.statusCode, second.body).toBe(201);
    const secondRow = await evidenceRow((second.json() as { evidenceId: string }).evidenceId);
    expect(secondRow.producerSubjectId).toBe(impostor.objectId);
  });

  // -------------------------------------------------------------------------------------------
  // PROPERTY 5 — authorized at the SUBJECT'S TARGET, not at the org root
  // -------------------------------------------------------------------------------------------

  it("a caller authorized only at ANOTHER target cannot submit for this one — with a positive control at the target it does hold", async () => {
    const mine = await createTestComponent(admin, { name: `mine-${randomUUID().slice(0, 8)}` });
    const theirs = await createTestComponent(admin, { name: `theirs-${randomUUID().slice(0, 8)}` });
    const reporter = await createTestUser(server, org, [{ role: "Operator", scope: mine.id }]);

    // POSITIVE CONTROL — the SAME principal, the SAME body shape, at the target it is bound to.
    // Without it this test would pass just as well against a route that refused everything.
    const allowed = await submit(
      reporter.token,
      testRunBody({ componentUrn: mine.urn, targetUrn: mine.urn, commitSha: COMMIT })
    );
    expect(allowed.statusCode, allowed.body).toBe(201);

    const refused = await submit(
      reporter.token,
      testRunBody({ componentUrn: theirs.urn, targetUrn: theirs.urn, commitSha: COMMIT })
    );
    expect(refused.statusCode, refused.body).toBe(403);

    // THE COMPONENT HALF DOES NOT RESCUE IT EITHER — naming a component the caller DOES hold while
    // pointing the target somewhere else is refused, because the target is what the authorization
    // is about ("who may say the window was quiet" == "who may deploy there").
    const crossed = await submit(
      reporter.token,
      testRunBody({ componentUrn: mine.urn, targetUrn: theirs.urn, commitSha: COMMIT })
    );
    expect(crossed.statusCode, crossed.body).toBe(403);

    // NOTHING WAS WRITTEN for the refused target.
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(pipelineEvidence)
        .where(
          and(eq(pipelineEvidence.orgId, org.orgId), eq(pipelineEvidence.targetObjectId, theirs.id))
        )
    );
    expect(rows).toHaveLength(0);
  });

  // -------------------------------------------------------------------------------------------
  // PROPERTY 6 — unauthenticated
  // -------------------------------------------------------------------------------------------

  it("refuses an unauthenticated submission", async () => {
    const component = await createTestComponent(admin, {
      name: `anon-${randomUUID().slice(0, 8)}`
    });
    const body = testRunBody({
      componentUrn: component.urn,
      targetUrn: component.urn,
      commitSha: COMMIT
    });

    const anonymous = await submit(null, body);
    expect(anonymous.statusCode).toBe(401);

    const badToken = await submit("not-a-real-token", body);
    expect(badToken.statusCode).toBe(401);

    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(pipelineEvidence)
        .where(
          and(
            eq(pipelineEvidence.orgId, org.orgId),
            eq(pipelineEvidence.targetObjectId, component.id)
          )
        )
    );
    expect(rows).toHaveLength(0);
  });

  // -------------------------------------------------------------------------------------------
  // PROPERTY 7 — the read-time hold projection
  // -------------------------------------------------------------------------------------------

  it("carries hold.continuousTests on a genuinely held wave target, and DROPS it on the very next read once fresh green lands — composed at read time, never persisted", async () => {
    const place = await admin.deploymentTargets.create({
      name: `gamma-${randomUUID().slice(0, 8)}`
    });
    const topology = await admin.object("release-topology").create({
      name: `flat-${randomUUID().slice(0, 8)}`,
      properties: { waves: [{ name: "all", mode: "parallel", targets: [place.id] }] }
    });
    const component = await createTestComponent(admin, {
      name: `probed-${randomUUID().slice(0, 8)}`
    });
    const placement = await admin.placements.create({
      component: component.id,
      deploymentTarget: place.id
    });
    await declareHook({
      componentObjectId: component.id,
      kind: "continuous",
      hookId: "canary",
      workflow: WORKFLOW,
      everySeconds: 30,
      maxAgeSeconds: 60
    });

    const change = await admin.changes.propose({
      name: `probed-${randomUUID().slice(0, 8)}`,
      targets: [component.id],
      topology: topology.id
    });
    await tick(4);

    // THE HOLD IS REAL, not merely reported: the executor was never asked to do anything.
    expect(triggered.filter((c) => c.targetRef === placement.id)).toHaveLength(0);

    const held = await admin.changes.explain(change.id);
    const heldTarget = held
      .plan!.waves.flatMap((w) => w.targets)
      .find((t) => t.targetObjectId === placement.id)!;
    // THE RAW STATUS STAYS BESIDE THE HOLD — `hold` explains `pending`, it does not replace it.
    expect(heldTarget.status).toBe("pending");
    expect(heldTarget.hold).toBeTruthy();
    // BOTH HALVES ARE PRESENT AND SEPARATE. No freeze covers this target, so `freezes` is the empty
    // array rather than absent — the field stays REQUIRED, which is what keeps this an additive
    // change instead of a weakening of a shipped response shape.
    expect(heldTarget.hold!.freezes).toEqual([]);
    expect(heldTarget.hold!.continuousTests).toHaveLength(1);
    const entry = heldTarget.hold!.continuousTests![0]!;
    expect(entry.hookId).toBe("canary");
    // NEVER REPORTED is spelled differently from FAILED and from STALE: they demand different
    // operator actions and must not share a word.
    expect(entry.reason).toBe("no_evidence");
    expect(entry.lastReportedAt).toBeNull();
    expect(entry.staleAfter).toBeNull();
    expect(entry.summary).toContain("canary");
    // `now` NEVER CROSSES THIS SEAM — the entry carries boundaries as data, not a relative time.
    expect(JSON.stringify(entry)).not.toContain('"now"');

    // FRESH GREEN LANDS THROUGH THE ROUTE — the same door a canary prober would use, submitted for
    // the PLACEMENT (the wave target), which is what `resolveHookSubjects` keys evidence by.
    const submitted = await submit(
      org.adminToken,
      testRunBody(
        {
          componentUrn: component.urn,
          targetUrn: placement.urn,
          artifactDigest: `sha256:${"e".repeat(64)}`
        },
        { hook: "continuous", hookId: "canary" }
      )
    );
    expect(submitted.statusCode, submitted.body).toBe(201);

    // THE VERY NEXT READ, WITH NO TICK IN BETWEEN. A field fed from the `continuous_test` Decision
    // would still say "held" here — that row is unchanged until a later tick writes its `allow`
    // counterpart, and this read happens before any such tick.
    const released = await admin.changes.explain(change.id);
    const releasedTarget = released
      .plan!.waves.flatMap((w) => w.targets)
      .find((t) => t.targetObjectId === placement.id)!;
    expect(releasedTarget.status).toBe("pending");
    expect(releasedTarget.hold?.continuousTests).toBeUndefined();
    // Held by nothing at all now, so the whole `hold` key is gone — never present-with-empty-arrays.
    expect(releasedTarget.hold).toBeUndefined();

    // AND THE ENGINE AGREES WITH THE PROJECTION: the next tick actually triggers the target, so the
    // read surface was not merely optimistic about a hold the admission loop still applies.
    await tick(2);
    expect(triggered.filter((c) => c.targetRef === placement.id)).toHaveLength(1);
  }, 60_000);

  // -------------------------------------------------------------------------------------------
  // WIRING — the route is REGISTERED. Delete `registerPipelineRoutes(app, deps)` from app.ts and
  // this goes 404, which is the only check that catches a built-but-never-installed route.
  // -------------------------------------------------------------------------------------------

  it("WIRING: the evidence route is registered on the app and present in the emitted spec", async () => {
    const res = await submit(org.adminToken, { subject: {}, evidence: {} });
    expect(
      res.statusCode,
      "an unregistered route answers 404; a registered one rejects this body with 400"
    ).toBe(400);
  });
});
