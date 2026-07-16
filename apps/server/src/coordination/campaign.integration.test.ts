import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpApiError, ScpClient } from "@scp/sdk";
import type { DesiredStateManifest } from "@scp/schemas";
import {
  createTestOrg,
  createTestUser,
  listenTestServer,
  waitUntil,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { createRelationship } from "../graph/relationships-repo.js";
import { SYSTEM_ACTOR_ID } from "./system-actor.js";

/**
 * Campaign & Initiative integration suite (BUILD_AND_TEST.md §8 M5 DoD, Testcontainers
 * postgres:16) — the campaign-scoped counterpart of coordination.integration.test.ts /
 * governance.integration.test.ts. Drives everything through the real HTTP API via `@scp/sdk`'s
 * `ScpClient`, with a real reconcile loop and a real subprocess plugin host (fake-executor +
 * webhook-control), never mocked. Re-verifies the M3/M4 invariants the M5 DoD calls out
 * explicitly hold at campaign scope: the guarded transition still writes audit+Decision
 * atomically for campaign-driven (member) changes, governance gates still apply, and RLS/RBAC
 * (both-endpoint authz) still gate campaign/initiative objects and their `coordinates` edges.
 */

interface TestWebhookServer {
  url: string;
  close(): Promise<void>;
}

/** Mirrors governance.integration.test.ts's fixture exactly — a real loopback HTTP server the
 *  real `webhook-control` subprocess plugin POSTs to, canned outcome via a request header. */
async function startTestWebhookServer(): Promise<TestWebhookServer> {
  const server = createServer((req, res) => {
    const outcome = (req.headers["x-test-outcome"] as string | undefined) ?? "pass";
    req.on("data", () => undefined);
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: outcome, evidence: { via: "test-webhook" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/webhook`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  };
}

async function createFailingControl(admin: ScpClient, org: TestOrg, urnSuffix: string, webhookUrl: string) {
  const control = await admin.controls.create({
    name: `control-${urnSuffix}`,
    urn: `urn:scp:${org.orgId}:control:${urnSuffix}`,
    properties: { category: "security" }
  });
  await admin.controls.putBinding(control.id, {
    pluginModule: "webhook-control",
    pluginInstanceId: `wh-${control.id}`,
    config: { url: webhookUrl, headers: { "x-test-outcome": "fail" } }
  });
  return control;
}

async function requireControlOn(admin: ScpClient, org: TestOrg, urnSuffix: string, targetObjectId: string, controlId: string) {
  return admin.policies.create({
    name: `policy-${urnSuffix}`,
    urn: `urn:scp:${org.orgId}:policy:${urnSuffix}`,
    properties: {
      scope: { objectRef: targetObjectId },
      enforcement: "required",
      effects: [{ requireControls: [controlId] }]
    }
  });
}

async function expectApiError(fn: () => Promise<unknown>): Promise<ScpApiError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ScpApiError) return err;
    throw err;
  }
  throw new Error("expected the call to throw an ScpApiError, but it completed successfully");
}

describe("campaigns & initiatives (M5)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let webhook: TestWebhookServer;

  beforeAll(async () => {
    server = await listenTestServer({
      withEventRelay: true,
      withReconcileLoop: true,
      pluginHostOptions: { callTimeoutMs: 8_000, restartBackoffBaseMs: 50, maxRestartBackoffMs: 300 }
    });
    org = await createTestOrg(server, "campaigns");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    webhook = await startTestWebhookServer();
  });

  afterAll(async () => {
    await webhook.close();
    await server.close();
  });

  it("compiles per-target member changes with correct wave ordering; wave 1 promotes while wave 2 is blocked by a failing required control; status aggregates; rollback reverts the promoted target", async () => {
    const infra = await admin.components.create({ name: "camp-infra" });
    const app = await admin.components.create({ name: "camp-app" });
    await admin.components.addDependsOn(app.id, infra.id); // app depends_on infra -> infra first

    const failingControl = await createFailingControl(admin, org, "camp-fail-1", webhook.url);
    await requireControlOn(admin, org, "camp-fail-policy-1", app.id, failingControl.id);

    const campaign = await admin.campaigns.propose({
      name: "patch camp-infra and camp-app",
      targets: [app.id, infra.id]
    });
    expect(campaign.status).toBe("proposed");
    expect(new Set(campaign.targets)).toEqual(new Set([app.id, infra.id]));

    // --- wave ordering + member-change linkage -------------------------------------------------
    const explained = await waitUntil(
      async () => {
        const e = await admin.campaigns.explain(campaign.id);
        return e.plan && e.plan.waves.length === 2 ? e : undefined;
      },
      { describe: `campaign ${campaign.id} plan compiles to 2 waves`, timeoutMs: 20_000 }
    );
    const waves = explained.plan!.waves;
    expect(waves[0]!.targets.map((t) => t.targetObjectId)).toEqual([infra.id]);
    expect(waves[1]!.targets.map((t) => t.targetObjectId)).toEqual([app.id]);

    const wave0MemberChangeId = await waitUntil(
      async () => {
        const e = await admin.campaigns.explain(campaign.id);
        return e.plan!.waves[0]!.targets[0]!.memberChangeObjectId ?? undefined;
      },
      { describe: "wave 0's member Change is proposed", timeoutMs: 20_000 }
    );

    // The member change is a REAL M3 Change, linked back via a `coordinates` relationship.
    const memberChange = await admin.changes.get(wave0MemberChangeId);
    expect(memberChange.sourceKind).toBe("campaign");
    const coordinatesEdges = await admin.relationships.list({
      fromId: campaign.id,
      typeId: "coordinates",
      limit: 20
    });
    expect(coordinatesEdges.items.some((e) => e.toId === wave0MemberChangeId)).toBe(true);

    // --- wave 0 (infra, no policy) reaches 'validating', gets promoted by a human ------------
    await waitUntil(async () => (await admin.changes.get(wave0MemberChangeId)).state === "validating" || undefined, {
      describe: `member change ${wave0MemberChangeId} reaches 'validating'`,
      timeoutMs: 20_000
    });
    const promoted = await admin.changes.promote(wave0MemberChangeId);
    expect(promoted.state).toBe("promoted");

    // --- wave 0 succeeds; wave 1 (app) is blocked by the required-but-failing control ---------
    await waitUntil(
      async () => {
        const e = await admin.campaigns.explain(campaign.id);
        return e.plan!.waves[0]!.status === "succeeded" || undefined;
      },
      { describe: "campaign wave 0 marked succeeded", timeoutMs: 20_000 }
    );
    await waitUntil(
      async () => {
        const e = await admin.campaigns.explain(campaign.id);
        return e.plan!.waves[1]!.status === "blocked" || undefined;
      },
      { describe: "campaign wave 1 marked blocked (failing required control)", timeoutMs: 20_000 }
    );
    // Wave 1's own target must NEVER have had a member change proposed — a campaign wave gate is
    // ADDITIONAL, never a substitute, but it must still gate PROGRESS: no member Change should
    // exist for `app` while its wave is blocked.
    const stillBlockedExplain = await admin.campaigns.explain(campaign.id);
    expect(stillBlockedExplain.plan!.waves[1]!.targets[0]!.memberChangeObjectId).toBeNull();
    // A campaign-level gate Decision was written for the block, carrying a resolvable id
    // (DESIGN §6/§10.4: every blocked verdict is explainable).
    const gateBlockDecision = stillBlockedExplain.decisions.find((d) => d.kind === "gate" && d.verdict === "block");
    expect(gateBlockDecision).toBeDefined();

    // --- campaign status aggregates correctly: blocked (the actionable fact), not "active" ----
    const campaignStatus = await admin.campaigns.get(campaign.id);
    expect(campaignStatus.status).toBe("blocked");

    // --- campaign-scoped rollback reverts the PROMOTED target only, each producing a Decision --
    const rollbackResult = await admin.campaigns.rollback(campaign.id, "test: revert wave 0 while wave 1 is blocked");
    expect(rollbackResult.rolledBack).toHaveLength(1);
    expect(rollbackResult.rolledBack[0]!.originalChangeObjectId).toBe(wave0MemberChangeId);
    // app's member change was never promoted (never even proposed) — not eligible, correctly skipped.
    expect(rollbackResult.skipped.some((s) => s.originalChangeObjectId === app.id)).toBe(false);

    await waitUntil(async () => (await admin.changes.get(wave0MemberChangeId)).state === "rolled_back" || undefined, {
      describe: `member change ${wave0MemberChangeId} reaches 'rolled_back'`,
      timeoutMs: 20_000
    });

    const finalStatus = await admin.campaigns.get(campaign.id);
    expect(finalStatus.status).toBe("rolled_back");

    // Both the campaign-level AND the member-change-level rollback trigger each wrote their own
    // Decision (DESIGN §9.4: "every rollback writes a Decision record naming its trigger").
    const finalExplain = await admin.campaigns.explain(campaign.id);
    expect(finalExplain.decisions.some((d) => d.kind === "rollback_trigger")).toBe(true);
    const memberExplain = await admin.changes.explain(wave0MemberChangeId);
    expect(memberExplain.decisions.some((d) => d.kind === "rollback_trigger")).toBe(true);
  }, 60_000);

  // -----------------------------------------------------------------------------------------
  // SAFETY (the headline campaign-ordering invariant): a campaign must never advance PAST a failed
  // wave. Both tests below get their OWN org on purpose — a reconcile pass batches campaigns
  // per-org (campaign-reconcile.ts's BATCH_LIMIT) and the whole proof here is "the reconciler had
  // every opportunity to advance this campaign and did not", which must not depend on where this
  // suite's ~10 other campaigns land in the batch.
  // -----------------------------------------------------------------------------------------

  /** Positive liveness proof that the campaign reconciler completed a full pass over `client`'s org
   *  AFTER the caller's setup: an independent campaign, created now, whose member Change the
   *  reconciler must propose. A pass visits campaigns `updatedAt` ASC (campaign-repo.ts's
   *  `listActiveCampaignObjectIds`), so the older campaign-under-test is always visited BEFORE this
   *  canary in the very pass that proposes the canary's member change — if the engine were going to
   *  advance the campaign under test, it already has by the time this resolves. Without this, the
   *  "nothing shipped" assertions below could pass vacuously against a stalled reconciler. */
  async function awaitReconcilerPass(client: ScpClient, label: string): Promise<void> {
    const canaryTarget = await client.components.create({ name: `${label}-canary-target` });
    const canary = await client.campaigns.propose({ name: `${label} liveness canary`, targets: [canaryTarget.id] });
    await waitUntil(
      async () => {
        const e = await client.campaigns.explain(canary.id);
        return e.plan?.waves[0]?.targets[0]?.memberChangeObjectId ?? undefined;
      },
      { describe: `${label}: liveness canary's member change is proposed (proves the reconciler is ticking this org)`, timeoutMs: 20_000 }
    );
  }

  it("SAFETY: a FAILED wave 0 parks the campaign — wave 1's member change is NEVER proposed, and the plan never reports 'completed'", async () => {
    const failOrg = await createTestOrg(server, "campaign-failed-wave");
    const failAdmin = new ScpClient({ baseUrl: server.baseUrl, token: failOrg.adminToken });

    const infra = await failAdmin.components.create({ name: "failwave-infra" });
    const app = await failAdmin.components.create({ name: "failwave-app" });
    await failAdmin.components.addDependsOn(app.id, infra.id); // app depends_on infra -> infra is wave 0

    const campaign = await failAdmin.campaigns.propose({
      name: "patch failwave-infra then failwave-app",
      targets: [app.id, infra.id]
    });

    const explained = await waitUntil(
      async () => {
        const e = await failAdmin.campaigns.explain(campaign.id);
        return e.plan && e.plan.waves.length === 2 ? e : undefined;
      },
      { describe: `campaign ${campaign.id} plan compiles to 2 waves`, timeoutMs: 20_000 }
    );
    expect(explained.plan!.waves[0]!.targets.map((t) => t.targetObjectId)).toEqual([infra.id]);
    expect(explained.plan!.waves[1]!.targets.map((t) => t.targetObjectId)).toEqual([app.id]);

    const wave0MemberChangeId = await waitUntil(
      async () => {
        const e = await failAdmin.campaigns.explain(campaign.id);
        return e.plan!.waves[0]!.targets[0]!.memberChangeObjectId ?? undefined;
      },
      { describe: "wave 0's (infra) member Change is proposed", timeoutMs: 20_000 }
    );

    // Drive wave 0's member Change to a FAILED outcome. `cancelled` rather than `rolled_back` is
    // deliberate: campaign-reconcile.ts maps BOTH to a failed wave target, but `rolled_back` would
    // additionally make computeCampaignStatus report `rolled_back` (it checks rollback FIRST, ahead
    // of every forward-progress signal), masking the `failed` reading this test is about. Cancel
    // from `validating` — a settled state on the member's own lifecycle, so there is no race with
    // the reconciler concurrently transitioning it.
    await waitUntil(async () => (await failAdmin.changes.get(wave0MemberChangeId)).state === "validating" || undefined, {
      describe: `wave 0 member change ${wave0MemberChangeId} reaches 'validating'`,
      timeoutMs: 20_000
    });
    const cancelled = await failAdmin.changes.cancel(wave0MemberChangeId, "test: wave 0 fails");
    expect(cancelled.state).toBe("cancelled");

    await waitUntil(
      async () => {
        const e = await failAdmin.campaigns.explain(campaign.id);
        return e.plan!.waves[0]!.status === "failed" || undefined;
      },
      { describe: "campaign wave 0 marked failed", timeoutMs: 20_000 }
    );

    // The engine now gets a full, proven pass in which it COULD advance this campaign.
    await awaitReconcilerPass(failAdmin, "failed-wave-2wave");

    const after = await failAdmin.campaigns.explain(campaign.id);
    // (a) NOTHING SHIPPED. Wave 1's member Change was never proposed — the owner's requirement
    // ("the software doesn't get deployed out until the infra gets deployed out") made concrete:
    // infra's wave failed, so app's change must not exist at all. A non-null id here means a real
    // Change for `app` was created and handed to the ordinary change loop to drive to `promoted`.
    expect(after.plan!.waves[1]!.targets[0]!.memberChangeObjectId).toBeNull();
    expect(after.plan!.waves[1]!.status).toBe("pending"); // never even gated, let alone running
    // (b) The plan is NOT completed — it parks `active` (campaign_plans.status has no "parked"
    // value, and 'aborted' is read by the reconciler but written by nothing).
    expect(after.plan!.status).toBe("active");
    // The failure is what the operator sees, derived from the wave (campaign-status.ts).
    expect((await failAdmin.campaigns.get(campaign.id)).status).toBe("failed");
    // No `coordinates` edge to any member change for wave 1's target either — the propose path
    // writes the edge in the same transaction, so its absence double-checks nothing was created.
    const edges = await failAdmin.relationships.list({ fromId: campaign.id, typeId: "coordinates", limit: 50 });
    expect(edges.items).toHaveLength(1); // wave 0's member change, and only that one
    expect(edges.items[0]!.toId).toBe(wave0MemberChangeId);
  }, 60_000);

  it("SAFETY: a campaign whose LAST remaining wave failed reports its plan as parked-'active', never 'completed'", async () => {
    // The second consequence of the same finder: with no later wave to slide to, "skip the failed
    // wave" instead means the search finds NOTHING and the plan is marked completed — a campaign
    // reporting success for work that failed.
    const failOrg = await createTestOrg(server, "campaign-failed-wave-last");
    const failAdmin = new ScpClient({ baseUrl: server.baseUrl, token: failOrg.adminToken });

    const target = await failAdmin.components.create({ name: "failwave-only-target" });
    const campaign = await failAdmin.campaigns.propose({ name: "single-wave campaign that fails", targets: [target.id] });

    const memberChangeId = await waitUntil(
      async () => {
        const e = await failAdmin.campaigns.explain(campaign.id);
        return e.plan?.waves[0]?.targets[0]?.memberChangeObjectId ?? undefined;
      },
      { describe: "the only wave's member Change is proposed", timeoutMs: 20_000 }
    );
    await waitUntil(async () => (await failAdmin.changes.get(memberChangeId)).state === "validating" || undefined, {
      describe: `member change ${memberChangeId} reaches 'validating'`,
      timeoutMs: 20_000
    });
    await failAdmin.changes.cancel(memberChangeId, "test: the only wave fails");

    await waitUntil(
      async () => {
        const e = await failAdmin.campaigns.explain(campaign.id);
        return e.plan!.waves[0]!.status === "failed" || undefined;
      },
      { describe: "the only campaign wave is marked failed", timeoutMs: 20_000 }
    );
    await awaitReconcilerPass(failAdmin, "failed-wave-1wave");

    const after = await failAdmin.campaigns.explain(campaign.id);
    expect(after.plan!.status).toBe("active"); // parked, NOT "completed"
    expect((await failAdmin.campaigns.get(campaign.id)).status).toBe("failed");
  }, 60_000);

  it("initiative roll-up traversal aggregates MULTIPLE campaigns with MIXED statuses (real graph query), via both propose-with-campaigns and add-campaign, and is org-scoped", async () => {
    // Campaign 1 -> completed (its member change promoted).
    const t1 = await admin.components.create({ name: "camp-rollup-completed-target" });
    const completedCampaign = await admin.campaigns.propose({ name: "rollup-completed campaign", targets: [t1.id] });
    const memberChangeId = await waitUntil(
      async () => {
        const e = await admin.campaigns.explain(completedCampaign.id);
        return e.plan?.waves[0]?.targets[0]?.memberChangeObjectId ?? undefined;
      },
      { describe: "completed campaign's member change is proposed", timeoutMs: 20_000 }
    );
    await waitUntil(async () => (await admin.changes.get(memberChangeId)).state === "validating" || undefined, {
      describe: `member change ${memberChangeId} reaches 'validating'`,
      timeoutMs: 20_000
    });
    await admin.changes.promote(memberChangeId);
    await waitUntil(
      async () => (await admin.campaigns.get(completedCampaign.id)).status === "completed" || undefined,
      { describe: `campaign ${completedCampaign.id} reaches 'completed'`, timeoutMs: 20_000 }
    );

    // Campaign 2 -> blocked (a required-but-failing control gates its only wave).
    const t2 = await admin.components.create({ name: "camp-rollup-blocked-target" });
    const failingControl = await createFailingControl(admin, org, "rollup-fail", webhook.url);
    await requireControlOn(admin, org, "rollup-fail-policy", t2.id, failingControl.id);
    const blockedCampaign = await admin.campaigns.propose({ name: "rollup-blocked campaign", targets: [t2.id] });
    await waitUntil(
      async () => (await admin.campaigns.get(blockedCampaign.id)).status === "blocked" || undefined,
      { describe: `campaign ${blockedCampaign.id} reaches 'blocked'`, timeoutMs: 20_000 }
    );

    // Initiative created with campaign 1 up front; campaign 2 added via the DEDICATED,
    // authority-checked `POST /initiatives/{id}/campaigns` path (regression: this is the ONLY
    // remaining way to create an initiative->campaign `coordinates` edge now that the generic
    // endpoint and IaC apply both refuse it).
    const initiative = await admin.initiatives.propose({
      name: "mixed-status initiative",
      campaigns: [completedCampaign.id]
    });
    await admin.initiatives.addCampaign(initiative.id, { campaign: blockedCampaign.id });

    const rollup = await admin.initiatives.get(initiative.id);
    expect(rollup.campaigns).toHaveLength(2);
    const statusById = new Map(rollup.campaigns.map((c) => [c.campaign.id, c.status]));
    expect(statusById.get(completedCampaign.id)).toBe("completed");
    expect(statusById.get(blockedCampaign.id)).toBe("blocked");
    // blocked outranks completed in the roll-up priority (campaign-status.ts's ROLLUP_PRIORITY).
    expect(rollup.rollupStatus).toBe("blocked");

    // The SAME derivation is reachable as a genuine named graph query (DESIGN §5/§9.5 — "derived
    // by traversal, a named graph query over the existing engine"), org-scoped like every other
    // named query — now aggregating TWO campaigns with MIXED statuses through the real traversal.
    const graphResult = await admin.graph.query("initiative-rollup", { objectId: initiative.id });
    expect(new Set(graphResult.objects.map((o) => o.id))).toEqual(new Set([completedCampaign.id, blockedCampaign.id]));
    expect(graphResult.counts).toEqual({ "status:completed": 1, "status:blocked": 1 });

    // Cross-tenant leakage check: a second org's admin can never see the first org's initiative
    // or its roll-up, even by id (RLS org_isolation — the same defense-in-depth every other M1
    // adversarial probe already covers, re-verified at campaign/initiative scope).
    const otherOrg = await createTestOrg(server, "campaigns-other-org");
    const otherAdmin = new ScpClient({ baseUrl: server.baseUrl, token: otherOrg.adminToken });
    const err = await expectApiError(() => otherAdmin.initiatives.get(initiative.id));
    expect(err.status).toBe(404);
  }, 50_000);

  it("SECURITY: a campaign cannot coordinate a target the actor lacks authority over (both closed write paths)", async () => {
    const restrictedTarget = await admin.components.create({ name: "camp-restricted-target" });
    // A Viewer has object:read but not object:write anywhere — cannot even name this target in a
    // campaign, regardless of the fact that member Changes are later proposed by the SYSTEM actor
    // (which would otherwise silently bypass this — see campaign-repo.ts's proposeCampaign doc).
    const viewer = await createTestUser(server, org, [{ role: "Viewer", scope: "self" }]);
    const viewerClient = new ScpClient({ baseUrl: server.baseUrl, token: viewer.token });

    const err = await expectApiError(() =>
      viewerClient.campaigns.propose({ name: "should be forbidden", targets: [restrictedTarget.id] })
    );
    expect(err.status).toBe(403);

    // No campaign object should have been created by the rejected attempt.
    const list = await admin.campaigns.list({ limit: 100 });
    expect(list.items.every((c) => c.name !== "should be forbidden")).toBe(true);
  });

  it("SECURITY: linking a campaign into an initiative requires relationship:write at BOTH endpoints", async () => {
    const t = await admin.components.create({ name: "camp-initiative-authz-target" });
    const campaign = await admin.campaigns.propose({ name: "authz-probe campaign", targets: [t.id] });

    const viewer = await createTestUser(server, org, [{ role: "Viewer", scope: "self" }]);
    const viewerClient = new ScpClient({ baseUrl: server.baseUrl, token: viewer.token });

    const err = await expectApiError(() =>
      viewerClient.initiatives.propose({ name: "should be forbidden", campaigns: [campaign.id] })
    );
    expect(err.status).toBe(403);
  });

  // -----------------------------------------------------------------------------------------
  // M5 security note (BUILD_AND_TEST.md §8 M5): "if a new authority-scoped object type is
  // introduced, it needs the governance-managed-types treatment (generic-endpoint block +
  // plan-apply scope check)". `campaign.properties.targets` is exactly such a DECLARED-authority
  // field (coordination/campaign-scope-authz.ts) — mirrors governance.integration.test.ts's own
  // "generic /objects/policy... both exploits are blocked" + "IaC plan/apply enforces the same...
  // scope-authority binding" pair of tests, applied to `campaign` instead of `policy`.
  // -----------------------------------------------------------------------------------------

  it("SECURITY: the generic /api/v1/objects/campaign endpoint refuses every write verb, even for the org-root admin", async () => {
    const restrictedTarget = await admin.components.create({ name: "camp-generic-bypass-target" });

    // Exploit: an actor with object:write ONLY at a domain they own tries the generic endpoint to
    // plant a campaign targeting an object OUTSIDE their authority — proposeCampaign's per-target
    // check would catch this at /campaigns, so the exploit specifically targets the endpoint that
    // (before this fix) skipped it entirely.
    const domain = await admin.domains.create({ name: "camp-generic-bypass-domain" });
    const narrowActor = await createTestUser(server, org, [{ role: "Administrator", scope: domain.id }]);
    const narrowClient = new ScpClient({ baseUrl: server.baseUrl, token: narrowActor.token });
    const exploit = await expectApiError(() =>
      narrowClient.object("campaign").create({
        name: "sneaky-campaign-via-generic",
        domainId: domain.id,
        properties: { targets: [restrictedTarget.id] }
      })
    );
    expect(exploit.status).toBe(403);

    // Unconditional type-level block — even the org-root admin (who has full authority over the
    // target) is refused via this path, proving it's not a permission gap.
    const adminExploit = await expectApiError(() =>
      admin.object("campaign").create({ name: "still-refused", properties: { targets: [restrictedTarget.id] } })
    );
    expect(adminExploit.status).toBe(403);

    // PATCH/PUT/DELETE refused too, for a campaign that legitimately exists via /campaigns.
    const legit = await admin.campaigns.propose({ name: "legit-for-generic-block-test", targets: [restrictedTarget.id] });
    await expect(
      admin.object("campaign").update(legit.id, { properties: { targets: [restrictedTarget.id] } })
    ).rejects.toMatchObject({ status: 403 });
    await expect(admin.object("campaign").delete(legit.id)).rejects.toMatchObject({ status: 403 });
  });

  it("SECURITY: IaC plan/apply binds a campaign manifest's declared targets to the actor's own authority", async () => {
    const restrictedTarget = await admin.components.create({ name: "camp-iac-bypass-target" });
    const ownDomain = await admin.domains.create({ name: "camp-iac-bypass-own-domain" });
    const ownTarget = await admin.components.create({ name: "camp-iac-bypass-own-target", domainId: ownDomain.id });

    const narrowActor = await createTestUser(server, org, [
      { role: "Viewer", scope: org.orgId }, // POST /plans needs object:read at org root
      { role: "Administrator", scope: ownDomain.id }
    ]);
    const narrowClient = new ScpClient({ baseUrl: server.baseUrl, token: narrowActor.token });

    const stackName = `camp-iac-bypass-${randomUUID().slice(0, 8)}`;
    const campaignUrn = `urn:scp:${stackName}:campaign:evil`;
    function manifestFor(targets: string[]): DesiredStateManifest {
      return {
        stackName,
        objects: [
          {
            urn: campaignUrn,
            typeId: "campaign",
            name: "campaign-via-iac",
            domainId: ownDomain.id,
            properties: { targets }
          }
        ],
        relationships: []
      };
    }

    // Exploit: the manifest's OWN domainId (ownDomain) passes the create-time containment check,
    // but `targets` names an object outside the actor's authority — must still be refused.
    const evilPlan = await narrowClient.plans.create(manifestFor([restrictedTarget.id]));
    await expect(narrowClient.plans.apply(evilPlan.id)).rejects.toMatchObject({ status: 403 });
    await expect(admin.object("campaign").get(campaignUrn)).rejects.toMatchObject({ status: 404 });

    // Non-regression: the SAME actor's apply succeeds when every declared target IS within their
    // authority — IaC still legitimately manages campaigns, just under the same binding
    // `POST /campaigns` enforces.
    const legitPlan = await narrowClient.plans.create(manifestFor([ownTarget.id]));
    const { summary } = await narrowClient.plans.apply(legitPlan.id);
    expect(summary).toMatchObject({ creates: 1 });
    const created = await admin.object("campaign").get(campaignUrn);
    expect(created.properties).toMatchObject({ targets: [ownTarget.id] });
  });

  it("an IaC-authored campaign whose manifest declares targets/topology by URN (not id) still resolves depends_on-based wave ordering correctly", async () => {
    // @scp/iac's Campaign/ReleaseTopology constructs only ever have a deterministically-derived
    // URN at pure/offline synth time (never a real database id) — this reproduces exactly that
    // shape by hand (no @scp/iac dependency needed here — a DesiredStateManifest is plain JSON),
    // proving campaign-reconcile.ts's idOrUrn resolution (added alongside the IaC construct work)
    // makes target/topology resolution creation-path-agnostic: an IaC-authored campaign's implicit
    // depends_on-based auto-sequencing now works exactly like an API-created campaign's does,
    // instead of silently no-oping on URN-shaped target strings (loadDependsOnEdges queries
    // `relationships` by real object id — URN strings would never match).
    const infra = await admin.components.create({ name: "camp-iac-urn-infra" });
    const app = await admin.components.create({ name: "camp-iac-urn-app" });
    await admin.components.addDependsOn(app.id, infra.id); // app depends_on infra -> infra first

    const stackName = `camp-iac-urn-${randomUUID().slice(0, 8)}`;
    const campaignUrn = `urn:scp:${stackName}:campaign:patch`;
    const manifest: DesiredStateManifest = {
      stackName,
      objects: [
        {
          urn: campaignUrn,
          typeId: "campaign",
          name: "campaign-via-iac-urn-targets",
          // Declared by URN, exactly what @scp/iac's `Campaign` construct's `targets:
          // (ResourceConstruct | string)[]` resolves to at synth time — NOT real object ids.
          properties: { targets: [infra.urn, app.urn] }
        }
      ],
      relationships: []
    };
    const plan = await admin.plans.create(manifest);
    const { summary } = await admin.plans.apply(plan.id);
    expect(summary).toMatchObject({ creates: 1 });

    const created = await admin.object("campaign").get(campaignUrn);
    const explained = await waitUntil(
      async () => {
        const e = await admin.campaigns.explain(created.id);
        return e.plan && e.plan.waves.length === 2 ? e : undefined;
      },
      { describe: `IaC-authored campaign ${created.id} plan compiles to 2 waves`, timeoutMs: 20_000 }
    );
    const waves = explained.plan!.waves;
    // If URN resolution were broken, both targets would land in ONE wave (no depends_on edge
    // found between them) instead of two — this is the exact failure mode the fix closes.
    expect(waves[0]!.targets.map((t) => t.targetObjectId)).toEqual([infra.id]);
    expect(waves[1]!.targets.map((t) => t.targetObjectId)).toEqual([app.id]);
  });

  // -----------------------------------------------------------------------------------------
  // M5 CRITICAL (adversarial review of PR #12): campaign/initiative membership must NOT be
  // injectable through the unprotected `coordinates` graph edge. `coordinates` is now
  // system-managed (`graph/system-managed-relationships.ts`) — refused on BOTH the generic
  // `POST /relationships` endpoint and the IaC apply path — and campaign rollback sources
  // membership from the authoritative `campaign_wave_targets`, never raw edges.
  // -----------------------------------------------------------------------------------------

  it("SECURITY: the generic POST /relationships endpoint refuses a `coordinates` edge (system-managed, 403)", async () => {
    const target = await admin.components.create({ name: "camp-coord-block-target" });
    const campaign = await admin.campaigns.propose({ name: "coord-block campaign", targets: [target.id] });
    const someChange = await admin.changes.propose({ name: "coord-block unrelated change", targets: [target.id] });

    // An actor could hold org-wide relationship:write (e.g. an Operator) — the type-level block
    // fires regardless, BEFORE any endpoint authority/type check, exactly like `approves`.
    const err = await expectApiError(() =>
      admin.relationships.create({ typeId: "coordinates", fromId: campaign.id, toId: someChange.id })
    );
    expect(err.status).toBe(403);
  });

  it("SECURITY: an IaC manifest declaring a raw `coordinates` relationship is refused at apply (403)", async () => {
    const target = await admin.components.create({ name: "camp-iac-coord-target" });
    const campaign = await admin.campaigns.propose({ name: "iac-coord campaign", targets: [target.id] });

    const stackName = `camp-iac-coord-${randomUUID().slice(0, 8)}`;
    const manifest: DesiredStateManifest = {
      stackName,
      objects: [],
      // A hand-written manifest could declare any typeId on a relationship entry — must be refused
      // the same way the generic endpoint refuses it (campaign membership goes through the
      // authority-checked `campaign.properties.targets`, never a raw `coordinates` edge).
      relationships: [{ typeId: "coordinates", fromUrn: campaign.urn, toUrn: target.urn }]
    };
    const plan = await admin.plans.create(manifest);
    await expect(admin.plans.apply(plan.id)).rejects.toMatchObject({ status: 403 });
    // No `coordinates` edge was created.
    const edges = await admin.relationships.list({ fromId: campaign.id, typeId: "coordinates", limit: 20 });
    expect(edges.items).toHaveLength(0);
  });

  it("SECURITY: campaign rollback IGNORES a stray/injected `coordinates` edge — only true plan-compiled members are reverted", async () => {
    // The TRUE member: a campaign targeting its own object, promoted (a real, plan-compiled,
    // rollback-eligible member).
    const trueTarget = await admin.components.create({ name: "camp-stray-true-target" });
    const campaign = await admin.campaigns.propose({ name: "stray-edge campaign", targets: [trueTarget.id] });
    const trueMemberChangeId = await waitUntil(
      async () => {
        const e = await admin.campaigns.explain(campaign.id);
        return e.plan?.waves[0]?.targets[0]?.memberChangeObjectId ?? undefined;
      },
      { describe: "true member change proposed", timeoutMs: 20_000 }
    );
    await waitUntil(async () => (await admin.changes.get(trueMemberChangeId)).state === "validating" || undefined, {
      describe: `true member ${trueMemberChangeId} reaches 'validating'`,
      timeoutMs: 20_000
    });
    await admin.changes.promote(trueMemberChangeId);

    // The INJECTED member: a completely unrelated Change, driven to a rollback-eligible state
    // ('validating'), then linked to the victim campaign by a stray `coordinates` edge written
    // straight through the repo (bypassing the now-guarded HTTP endpoint) — exactly simulating a
    // legacy/migrated/future-bug edge that the type-level HTTP+IaC blocks can't retroactively
    // prevent. If campaign rollback trusted raw `coordinates` edges (the pre-fix behavior), this
    // change WOULD be swept into the rollback.
    const injectedTarget = await admin.components.create({ name: "camp-stray-injected-target" });
    const injectedChange = await admin.changes.propose({ name: "injected-not-a-member", targets: [injectedTarget.id] });
    await waitUntil(async () => (await admin.changes.get(injectedChange.id)).state === "validating" || undefined, {
      describe: `injected change ${injectedChange.id} reaches 'validating'`,
      timeoutMs: 20_000
    });
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      createRelationship(tx, {
        orgId: org.orgId,
        actorObjectId: SYSTEM_ACTOR_ID,
        requestId: "test-stray-edge-injection",
        typeId: "coordinates",
        fromId: campaign.id,
        toId: injectedChange.id
      })
    );

    // Roll back the campaign.
    const rollbackResult = await admin.campaigns.rollback(campaign.id, "stray-edge test: revert true members only");

    // The TRUE member is rolled back; the INJECTED change is NOT in the rolledBack set...
    const rolledBackIds = rollbackResult.rolledBack.map((r) => r.originalChangeObjectId);
    expect(rolledBackIds).toContain(trueMemberChangeId);
    expect(rolledBackIds).not.toContain(injectedChange.id);
    // ...and is not even mentioned in `skipped` (it's simply not a member — never enumerated).
    expect(rollbackResult.skipped.map((s) => s.originalChangeObjectId)).not.toContain(injectedChange.id);

    // ...and the injected change never leaves 'validating' (never rolled_back) — the definitive
    // proof it was never touched.
    await waitUntil(async () => (await admin.changes.get(trueMemberChangeId)).state === "rolled_back" || undefined, {
      describe: `true member ${trueMemberChangeId} reaches 'rolled_back'`,
      timeoutMs: 20_000
    });
    const injectedState = (await admin.changes.get(injectedChange.id)).state;
    expect(injectedState).toBe("validating");
  }, 60_000);
});
