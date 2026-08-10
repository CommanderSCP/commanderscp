import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  buildTestServer,
  createTestOrg,
  createTestUser,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { decisions } from "../db/schema.js";
import {
  CountingCelSandbox,
  distinctDecisionStatements,
  partitionConditionErrors
} from "./test-support/counting-cel-sandbox.js";
import { createInMemoryFakeHost } from "./test-support/fake-plugin-host.js";
import type { PluginHost } from "../plugin-host/contract.js";
import { reconcileCampaignsOrgTick } from "./campaign-reconcile.js";
import { proposeCampaign } from "./campaign-repo.js";
import { createObject, updateObject } from "../graph/objects-repo.js";
import { castApprovalVote, listApprovalRequestsForChange } from "../governance/approvals-repo.js";
import { getLatestCampaignPlan } from "./campaign-plan-service.js";
import { compileAndPersistPlan } from "./plan-service.js";
import { transitionChange } from "./transition.js";
import { triggerCampaignRollback } from "./campaign-rollback.js";
import type { GateDeps } from "./gates.js";
import { SYSTEM_ACTOR_ID } from "./system-actor.js";
import { ensureFederationSelf } from "../federation/self-repo.js";

/**
 * The CAMPAIGN-side half of the same unbounded-Decision-write class (see
 * `decision-write-amplification.integration.test.ts` for the production measurement that motivated
 * the fix, and `decisions-repo.ts`'s `insertDecisionIfChanged` for the shape).
 *
 * Both campaign writers carry 0 rows in the affected deployment ONLY because `campaign_plans` is
 * empty there — neither is fixed by the change-side fix, and one of them is WORSE BY CONSTRUCTION:
 *
 *  U2 the campaign WAVE GATE. Its guard is `pending || blocked` — deliberately re-including
 *     `blocked` so an operator satisfying the policy unblocks the campaign on the next tick — which
 *     means `markCampaignWaveBlocked` does NOT stop re-evaluation the way `markWaveRunning` stops
 *     it on the allow path. Same 1 s tick as the change side.
 *  U3 the `plan_diff` block written on every plan-compile failure ("record why and retry next
 *     tick"). A PERMANENT fault — an unresolvable target, a dependency cycle — re-fails identically
 *     ~43,200 times a day per campaign.
 *
 * Drives `reconcileCampaignsOrgTick` directly so "N ticks" is exactly N. Each case gets its OWN org
 * so one campaign's rows can never be mistaken for another's.
 */

describe("Decision write amplification: the campaign reconciler persists ON CHANGE", () => {
  let server: TestServer;
  let sandbox: CountingCelSandbox;
  let host: PluginHost;

  beforeAll(async () => {
    server = await buildTestServer();
    sandbox = new CountingCelSandbox();
    host = createInMemoryFakeHost({ autoSucceedAfterMs: 60_000 });
  });

  afterAll(async () => {
    await sandbox.stop();
    await server.close();
  });

  async function inject(
    org: TestOrg,
    url: string,
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const res = await server.app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload
    });
    if (res.statusCode >= 300) throw new Error(`POST ${url} -> ${res.statusCode} ${res.body}`);
    return res.json() as Record<string, unknown>;
  }

  /**
   * The Decisions of one `kind` for one subject, oldest first, SPLIT into the ordinary verdicts and
   * the fail-closed condition-error statements — see `partitionConditionErrors` for the measured
   * reason a raw row count cannot be asserted here (a CEL wall-clock miss on a loaded box makes the
   * production code CORRECTLY write a condition-error row AND an ordinary one on the next tick; both
   * are right). The suite's sandbox also raises that wall clock far above any scheduling hiccup.
   */
  async function decisionsOfKind(org: TestOrg, subjectId: string, kind: string) {
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(decisions)
        .where(
          and(
            eq(decisions.orgId, org.orgId),
            eq(decisions.subjectId, subjectId),
            eq(decisions.kind, kind)
          )
        )
        .orderBy(decisions.createdAt, decisions.id)
    );
    return partitionConditionErrors(rows);
  }

  async function tick(org: TestOrg, times: number): Promise<void> {
    // S10: the reconciler drives only campaigns THIS domain is authoritative for, so the tick needs
    // this org's own `federation_self.domain_id` — which is exactly what every locally-created
    // campaign in this suite is stamped with. See `campaign-repo.ts`'s `listActiveCampaignObjectIds`.
    const selfDomainId = (
      await withTenantTx(server.deps.db, org.orgId, (tx) => ensureFederationSelf(tx, org.orgId))
    ).domainId;
    for (let i = 0; i < times; i++) {
      await reconcileCampaignsOrgTick(server.deps.db, org.orgId, host, sandbox, selfDomainId);
    }
  }

  it("U2: a campaign wave parked on a requireApprovals policy writes ONE gate/block Decision over 15 ticks — while still being RE-EVALUATED every tick, and resuming the moment the approval lands", async () => {
    const org = await createTestOrg(server, "campaign-flood-gate");
    const approver = await createTestUser(server, org, [{ role: "Owner", scope: org.orgId }]);
    const condition = "change.emergency == false"; // fires; also the per-evaluation counter

    const service = await inject(org, "/api/v1/services", { name: "svc-camp-gate" });
    const component = await inject(org, "/api/v1/components", {
      name: "comp-camp-gate",
      service: service.id
    });
    await inject(org, "/api/v1/policies", {
      name: "prod-gate-campaign",
      urn: `urn:scp:${org.orgId}:policy:campaign-gate`,
      properties: {
        scope: { objectRef: component.id as string },
        enforcement: "required",
        condition,
        effects: [{ requireApprovals: { count: 1, fromRole: "Owner", scope: "organization" } }]
      }
    });

    const campaignObjectId = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const { campaign } = await proposeCampaign(tx, {
        orgId: org.orgId,
        // A real RBAC subject — `proposeCampaign` authorizes `object:write` at every target.
        actorObjectId: approver.objectId,
        requestId: "campaign-flood-test",
        name: "campaign-parked-on-approval",
        targets: [component.id as string]
      });
      return campaign.id;
    });

    const TICKS = 15;
    const before = sandbox.countOf(condition);
    await tick(org, TICKS);

    // THE FIX: one row, not one per tick — plus at most one more per fail-closed condition-error row,
    // and every ordinary row must be the SAME statement (nothing new was suppressed).
    const blocked = await decisionsOfKind(org, campaignObjectId, "gate");
    expect(blocked.ordinary.length).toBeLessThanOrEqual(blocked.conditionErrors.length + 1);
    expect(distinctDecisionStatements(blocked.ordinary)).toBe(1);
    expect(blocked.ordinary[0]!.verdict).toBe("block");

    // ...and the gate was genuinely re-evaluated on EVERY tick (the first tick compiles the plan and
    // gates it in the same pass). `blocked` stays in the branch's guard deliberately: that is how an
    // operator satisfying the policy unblocks the campaign on the next tick.
    expect(sandbox.countOf(condition) - before).toBe(TICKS);

    const blockedPlan = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      getLatestCampaignPlan(tx, org.orgId, campaignObjectId)
    );
    expect(blockedPlan?.waves[0]?.status).toBe("blocked");

    // RESUMPTION: satisfy the quorum the campaign gate itself materialized; the next tick must both
    // write a NEW Decision and start the wave.
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const requests = await listApprovalRequestsForChange(tx, org.orgId, campaignObjectId);
      expect(requests).toHaveLength(1);
      await castApprovalVote(tx, {
        orgId: org.orgId,
        approvalRequestId: requests[0]!.id,
        voterObjectId: approver.objectId,
        requestId: "campaign-flood-test-vote"
      });
    });

    await tick(org, 1);
    const after = await decisionsOfKind(org, campaignObjectId, "gate");
    const allows = after.ordinary.filter((d) => d.verdict === "allow");
    expect(allows).toHaveLength(1);
    expect(after.ordinary[after.ordinary.length - 1]!.id).toBe(allows[0]!.id);
    const runningPlan = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      getLatestCampaignPlan(tx, org.orgId, campaignObjectId)
    );
    expect(runningPlan?.waves[0]?.status).not.toBe("blocked");
  });

  it("U3: a permanently un-compilable campaign plan writes ONE plan_diff Decision over 12 ticks — and a DIFFERENT fault writes a second", async () => {
    const org = await createTestOrg(server, "campaign-flood-plan");

    // An IaC-authored-shaped campaign whose declared target does not resolve — the documented path
    // `campaign-reconcile.ts` re-resolves `properties.targets` for (an object deleted after the
    // manifest was written, say). Permanent: it fails identically on every tick, forever.
    const missingTarget = randomUUID();
    const campaignObjectId = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const object = await createObject(tx, {
        orgId: org.orgId,
        typeId: "campaign",
        actorObjectId: org.orgId,
        requestId: "campaign-flood-test",
        name: "campaign-with-unresolvable-target",
        properties: { targets: [missingTarget] }
      });
      return object.id;
    });

    await tick(org, 12);

    // Exact counts hold here with no condition-error allowance: a plan-COMPILE failure never reaches
    // the CEL sandbox, so the load-dependent extra statement U2 must tolerate cannot arise. Asserted,
    // not assumed.
    const first = await decisionsOfKind(org, campaignObjectId, "plan_diff");
    expect(first.conditionErrors).toHaveLength(0);
    expect(first.ordinary).toHaveLength(1);
    expect(first.ordinary[0]!.verdict).toBe("block");
    expect(JSON.stringify(first.ordinary[0]!.reasonTree)).toContain(
      "campaign plan compilation failed"
    );
    // AND IT NAMES THE OFFENDING OBJECT (charter principle 6). `getObjectByIdOrUrnAnyType` throws
    // `notFound`, a `ProblemError` whose `message` is the bare HTTP title — this used to record
    // `{ error: "Not Found" }`, which explains nothing and, worse, makes every unresolvable-target
    // fault byte-identical (see U4). `errors.ts`'s `describeError` records `detail`.
    expect((first.ordinary[0]!.inputContext as { error: string }).error).toContain(missingTarget);
    // Nothing was compiled — the retry (and therefore the self-heal) is untouched.
    const plan = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      getLatestCampaignPlan(tx, org.orgId, campaignObjectId)
    );
    expect(plan).toBeNull();

    // A DIFFERENT fault is a different statement and MUST be recorded: content-keyed suppression,
    // never "we already wrote one for this subject". Here: the targets now resolve, but the declared
    // topology is not a `release-topology` object — a distinct, equally permanent compile fault.
    const service = await inject(org, "/api/v1/services", { name: "svc-camp-plan" });
    const component = await inject(org, "/api/v1/components", {
      name: "comp-camp-plan",
      service: service.id
    });
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      updateObject(tx, {
        orgId: org.orgId,
        typeId: "campaign",
        actorObjectId: SYSTEM_ACTOR_ID,
        requestId: "campaign-flood-test",
        idOrUrn: campaignObjectId,
        properties: { targets: [component.id as string], topologyObjectId: component.id as string }
      })
    );

    await tick(org, 4);
    // 2 rows, not 5: the second fault is itself deduped across its own 4 ticks, and it did NOT get
    // swallowed by the first one's row. The recorded content is the compile error itself
    // (`inputContext.error`) — so "different fault" means, exactly and only, "records something
    // different", which is the right key for a record whose whole payload is that message.
    const second = await decisionsOfKind(org, campaignObjectId, "plan_diff");
    expect(second.conditionErrors).toHaveLength(0);
    expect(second.ordinary).toHaveLength(2);
    const recordedErrors = second.ordinary.map((d) => (d.inputContext as { error: string }).error);
    expect(recordedErrors[0]).not.toBe(recordedErrors[1]);
    // The topology-type refusal, NAMED. This used to assert `toContain("Bad Request")` — which is
    // the HTTP TITLE of the `ProblemError`, not its diagnosis: a green assertion over a Decision
    // that told the operator nothing. It passed only because this fault's title happens to differ
    // from the previous fault's ("Not Found"); U4 is the case where they do not.
    expect(recordedErrors[1]).toContain("is not a release-topology object");
    expect(recordedErrors[1]).toContain(component.id as string);
    for (const recorded of recordedErrors) expect(recorded).not.toBe("Bad Request");
    for (const recorded of recordedErrors) expect(recorded).not.toBe("Not Found");
  });

  /**
   * U4 — THE FAULT THE DEDUPE MADE WORSE (PR #153 review Q3).
   *
   * `ProblemError` (`errors.ts`) is constructed `(status, title, opts)` and passes the TITLE to
   * `super()`, so `err.message` is `"Not Found"` / `"Bad Request"` and everything informative lives
   * in `readonly detail`. Recording `message` therefore collapsed EVERY unresolvable-target fault
   * to the identical `{ error: "Not Found" }` — and since `insertDecisionIfChanged` compares
   * CONTENT, the second, genuinely different fault was suppressed as a restatement. The operator
   * kept reading a Decision about a target that is no longer the problem, with no signal that
   * anything had changed. The dedupe is what turned an explainability gap into a CORRECTNESS one,
   * which is why the fix ships here rather than later.
   *
   * U3's second fault has a different HTTP title from its first, so it writes a row either way —
   * this is the case that does not.
   *
   * MUTATION-PROVEN: reverting `campaign-reconcile.ts` to `err instanceof Error ? err.message` takes
   * this to ONE row (`expected 1 to be 2`) — the second fault silently lost.
   */
  it("U4: TWO DIFFERENT faults that share an HTTP title write TWO plan_diff Decisions — the title is not the record", async () => {
    const org = await createTestOrg(server, "campaign-flood-same-title");

    const firstMissing = randomUUID();
    const secondMissing = randomUUID();
    const campaignObjectId = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const object = await createObject(tx, {
        orgId: org.orgId,
        typeId: "campaign",
        actorObjectId: org.orgId,
        requestId: "campaign-flood-test",
        name: "campaign-same-title-faults",
        properties: { targets: [firstMissing] }
      });
      return object.id;
    });

    await tick(org, 3);

    // A DIFFERENT unresolvable target — a different fault about a different object, but the SAME
    // `notFound` and therefore the same HTTP title.
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      updateObject(tx, {
        orgId: org.orgId,
        typeId: "campaign",
        actorObjectId: SYSTEM_ACTOR_ID,
        requestId: "campaign-flood-test",
        idOrUrn: campaignObjectId,
        properties: { targets: [secondMissing] }
      })
    );

    await tick(org, 3);

    const rows = await decisionsOfKind(org, campaignObjectId, "plan_diff");
    expect(rows.conditionErrors).toHaveLength(0);
    // TWO rows over six ticks: each fault deduped across its own three ticks, and the second was
    // NOT swallowed by the first. Pre-fix this was ONE row saying "Not Found", forever.
    expect(rows.ordinary).toHaveLength(2);

    const recordedErrors = rows.ordinary.map((d) => (d.inputContext as { error: string }).error);
    expect(recordedErrors[0]).toContain(firstMissing);
    expect(recordedErrors[1]).toContain(secondMissing);
    expect(recordedErrors[0]).not.toBe(recordedErrors[1]);
  });

  /**
   * U5 — THE OTHER PERSISTED `describeError` SITE ON THE CAMPAIGN SIDE (PR #153 review Q3):
   * `campaign-rollback.ts`'s per-member catch.
   *
   * `triggerCampaignRollback` never aborts the batch — a member whose rollback is refused is
   * recorded in `result.skipped[].reason`, which is BOTH returned to the operator by
   * `POST /campaigns/{id}/rollback` AND persisted verbatim inside the campaign-level
   * `rollback_trigger` Decision's `input_context.skipped`. It is the only account of why that member
   * was not reverted. Every refusal `triggerRollback` raises is a `ProblemError` (`badRequest` for a
   * non-rollbackable state or a change with no recorded targets, `notFound` from `getChangeRow`), so
   * `err.message` recorded the bare HTTP title: three members skipped for three different reasons
   * all read "Bad Request", in the returned payload and in the permanent record alike.
   *
   * Driven at the repo layer (the member change is walked to `executing` with the same manual
   * transitions the rest of this suite uses) so the case is exact and needs no reconcile loop.
   *
   * MUTATION-PROVEN: reverting `campaign-rollback.ts`'s `describeError(err)` to
   * `err instanceof Error ? err.message : String(err)` makes both assertions fail — the recorded
   * reason collapses to "Bad Request".
   */
  it("U5: a member whose rollback is REFUSED records WHY, in the returned result and in the campaign's rollback_trigger Decision", async () => {
    const org = await createTestOrg(server, "campaign-rollback-reason");
    const owner = await createTestUser(server, org, [{ role: "Owner", scope: org.orgId }]);

    const service = await inject(org, "/api/v1/services", { name: "svc-camp-rollback" });
    const component = await inject(org, "/api/v1/components", {
      name: "comp-camp-rollback",
      service: service.id
    });

    const campaignObjectId = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const { campaign } = await proposeCampaign(tx, {
        orgId: org.orgId,
        actorObjectId: owner.objectId,
        requestId: "campaign-rollback-reason-test",
        name: "campaign-with-a-refusing-member",
        targets: [component.id as string]
      });
      return campaign.id;
    });

    // Two ticks: the first compiles the plan and starts wave 0 (no policy, so its gate allows), the
    // second is belt-and-braces for the member change actually existing.
    await tick(org, 2);
    const plan = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      getLatestCampaignPlan(tx, org.orgId, campaignObjectId)
    );
    const memberChangeObjectId = plan!.waves[0]!.targets[0]!.memberChangeObjectId;
    expect(memberChangeObjectId).toBeTruthy();

    const gateDeps: GateDeps = { sandbox, host };
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      // Walk it to `executing` — a ROLLBACK-ELIGIBLE state, so `triggerCampaignRollback`'s own
      // state pre-check passes and the refusal has to come out of `triggerRollback` itself (which is
      // the site under test; the pre-check's reasons are module-written strings, not forwarded ones).
      await compileAndPersistPlan(tx, {
        orgId: org.orgId,
        changeObjectId: memberChangeObjectId!,
        targetObjectIds: [component.id as string],
        topologyObjectId: null,
        topologyVersion: null
      });
      for (const toState of ["evaluated", "coordinated", "executing"] as const) {
        await transitionChange(
          tx,
          {
            orgId: org.orgId,
            changeObjectId: memberChangeObjectId!,
            toState,
            actorObjectId: owner.objectId,
            requestId: "campaign-rollback-reason-test"
          },
          gateDeps
        );
      }
      // ...and leave it with NO recorded targets, the shape `rollback.ts` refuses with
      // `badRequest("change '<id>' has no recorded targets to roll back")` — a `ProblemError` whose
      // `message` is "Bad Request" and whose `detail` names the member.
      await updateObject(tx, {
        orgId: org.orgId,
        typeId: "change",
        actorObjectId: SYSTEM_ACTOR_ID,
        requestId: "campaign-rollback-reason-test",
        idOrUrn: memberChangeObjectId!,
        properties: { targets: [] }
      });
    });

    const result = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      triggerCampaignRollback(tx, {
        orgId: org.orgId,
        campaignObjectId,
        actorObjectId: owner.objectId,
        requestId: "campaign-rollback-reason-test",
        reason: "test: revert this campaign"
      })
    );
    expect(result.rolledBack).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    // (a) THE RETURNED ACCOUNT — what the operator sees.
    expect(result.skipped[0]!.reason).toContain(memberChangeObjectId!);
    expect(result.skipped[0]!.reason).not.toBe("Bad Request");

    // (b) THE PERSISTED ACCOUNT — the same text inside the campaign's `rollback_trigger` Decision,
    // which is what `scp campaign explain` reads back long after the call returned.
    const triggers = await decisionsOfKind(org, campaignObjectId, "rollback_trigger");
    expect(triggers.ordinary).toHaveLength(1);
    const persisted = (triggers.ordinary[0]!.inputContext as { skipped: { reason: string }[] })
      .skipped;
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.reason).toContain(memberChangeObjectId!);
  });
});
