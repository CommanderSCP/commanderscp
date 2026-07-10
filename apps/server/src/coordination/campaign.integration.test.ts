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

  it("initiative roll-up traversal aggregates member campaign statuses and is org-scoped", async () => {
    const solo = await admin.components.create({ name: "camp-solo-target" });
    const campaign = await admin.campaigns.propose({ name: "solo-target campaign", targets: [solo.id] });

    const memberChangeId = await waitUntil(
      async () => {
        const e = await admin.campaigns.explain(campaign.id);
        return e.plan?.waves[0]?.targets[0]?.memberChangeObjectId ?? undefined;
      },
      { describe: "solo campaign's member change is proposed", timeoutMs: 20_000 }
    );
    await waitUntil(async () => (await admin.changes.get(memberChangeId)).state === "validating" || undefined, {
      describe: `member change ${memberChangeId} reaches 'validating'`,
      timeoutMs: 20_000
    });
    await admin.changes.promote(memberChangeId);
    await waitUntil(
      async () => (await admin.campaigns.get(campaign.id)).status === "completed" || undefined,
      { describe: `campaign ${campaign.id} reaches 'completed'`, timeoutMs: 20_000 }
    );

    const initiative = await admin.initiatives.propose({ name: "solo initiative", campaigns: [campaign.id] });
    const rollup = await admin.initiatives.get(initiative.id);
    expect(rollup.campaigns).toHaveLength(1);
    expect(rollup.campaigns[0]!.status).toBe("completed");
    expect(rollup.rollupStatus).toBe("completed");

    // The SAME derivation is reachable as a genuine named graph query (DESIGN §5/§9.5 — "derived
    // by traversal, a named graph query over the existing engine"), org-scoped like every other
    // named query (runs inside the caller's tenant tx / RLS).
    const graphResult = await admin.graph.query("initiative-rollup", { objectId: initiative.id });
    expect(graphResult.objects.map((o) => o.id)).toEqual([campaign.id]);
    expect(graphResult.counts).toEqual({ "status:completed": 1 });

    // Cross-tenant leakage check: a second org's admin can never see the first org's initiative
    // or its roll-up, even by id (RLS org_isolation — the same defense-in-depth every other M1
    // adversarial probe already covers, re-verified at campaign/initiative scope).
    const otherOrg = await createTestOrg(server, "campaigns-other-org");
    const otherAdmin = new ScpClient({ baseUrl: server.baseUrl, token: otherOrg.adminToken });
    const err = await expectApiError(() => otherAdmin.initiatives.get(initiative.id));
    expect(err.status).toBe(404);
  }, 40_000);

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
});
