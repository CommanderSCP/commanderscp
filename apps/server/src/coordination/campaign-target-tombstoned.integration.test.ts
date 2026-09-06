import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  buildTestServer,
  createTestOrg,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { auditEvents, campaignWaveTargets, campaignWaves, decisions } from "../db/schema.js";
import { CountingCelSandbox } from "./test-support/counting-cel-sandbox.js";
import { createInMemoryFakeHost } from "./test-support/fake-plugin-host.js";
import type { PluginHost } from "../plugin-host/contract.js";
import { reconcileOrgTick } from "./reconcile.js";
import { compileAndPersistCampaignPlan } from "./campaign-plan-service.js";
import { WAVE_TARGET_TOMBSTONED_AUDIT_ACTION } from "./target-liveness.js";

/**
 * THE CAMPAIGN TWIN — the same property, a different symptom.
 *
 * On the change side a tombstoned wave target got DEPLOYED. On the campaign side it did not: a
 * campaign wave target's "drive" is `proposeChange`, and `proposeChange` resolves its targets through
 * `getObjectByIdOrUrnAnyType`, which IS live-filtered and throws `notFound`. So the engine already
 * had the right answer — and threw it away.
 *
 * A campaign plan is compiled ONCE. Delete one of its targets afterwards and the throw landed in
 * `logCampaignError`, which prints "will retry next tick" and does exactly that, once a second,
 * forever. `allTerminal` stayed false, so the wave never terminalized;
 * `markCampaignWaveTargetProposed` was never reached, so the target stayed `pending`; and no
 * Decision, no `decision_id`, no audit event and no terminal status were ever written. An operator
 * asking "why has this campaign stopped" got a log line and nothing queryable — which is precisely
 * the silence charter principle 6 forbids, and the reason this fix is about EXPLAINABILITY here
 * rather than about preventing a deploy.
 *
 * `compileAndPersistCampaignPlan` is called directly so the tombstone can land in the window the fix
 * is about: BETWEEN compilation and fan-out. Driving it through the loop instead would delete the
 * target before the plan existed, which exercises the compile-time refusal (a `plan_diff` Decision
 * that already worked) rather than this one.
 */
describe("a tombstoned campaign target is refused with a record, not an infinite retry", () => {
  let server: TestServer;
  let org: TestOrg;
  let sandbox: CountingCelSandbox;
  let host: PluginHost;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "tombstoned-campaign");
    sandbox = new CountingCelSandbox();
    host = createInMemoryFakeHost({ autoSucceedAfterMs: 60_000 });
  }, 120_000);

  afterAll(async () => {
    await sandbox.stop();
    await server?.close();
  });

  async function inject(url: string, payload: Record<string, unknown>) {
    const res = await server.app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload
    });
    if (res.statusCode >= 300) throw new Error(`POST ${url} -> ${res.statusCode} ${res.body}`);
    return res.json() as Record<string, unknown>;
  }

  const tick = () =>
    reconcileOrgTick(server.deps.db, org.orgId, host, sandbox, server.deps.config.secretsMasterKey);

  it("terminalizes the target, writes a block Decision + hash-chained audit event, and fails the wave", async () => {
    const label = `camp-${randomUUID().slice(0, 8)}`;
    const service = await inject("/api/v1/services", { name: `svc-${label}` });
    const component = await inject("/api/v1/components", {
      name: `comp-${label}`,
      service: service.id
    });
    const campaign = await inject("/api/v1/campaigns", {
      name: `campaign-${label}`,
      targets: [component.id as string]
    });

    // Compile the plan while the target is still live — the campaign's own snapshot, exactly as the
    // reconciler would have taken it.
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      compileAndPersistCampaignPlan(tx, {
        orgId: org.orgId,
        campaignObjectId: campaign.id as string,
        targetObjectIds: [component.id as string],
        topologyObjectId: null,
        topologyVersion: null
      })
    );

    // The tombstone, through the public API by an authorized actor, in the window between
    // compilation and fan-out.
    const del = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/components/${component.id}`,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    expect(del.statusCode).toBeLessThan(300);

    await tick();

    const targetRows = () =>
      withTenantTx(server.deps.db, org.orgId, (tx) =>
        tx.select().from(campaignWaveTargets).where(eq(campaignWaveTargets.orgId, org.orgId))
      );
    const mine = async () =>
      (await targetRows()).filter((t) => t.targetObjectId === (component.id as string));

    // TERMINALIZED, not left `pending` for the next second's identical failure. No member change was
    // proposed, which is the same outcome as before — the difference is everything below.
    const [target] = await mine();
    expect(target!.status).toBe("failed");
    expect(target!.memberChangeObjectId).toBeNull();

    // A `block` Decision with a resolvable id, naming the object and how the target reached it.
    const campaignDecisions = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(decisions)
        .where(eq(decisions.subjectId, campaign.id as string))
    );
    const block = campaignDecisions.find((d) => d.kind === "wave_target" && d.verdict === "block");
    expect(block).toBeDefined();
    expect(block!.inputContext).toMatchObject({
      targetObjectId: component.id,
      deadObjectId: component.id,
      deadObjectTypeId: "component",
      gate: "target_deleted",
      liveness: "deleted",
      reachedVia: "target"
    });

    const events = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.subjectId, campaign.id as string))
    );
    const refusal = events.find((e) => e.action === WAVE_TARGET_TOMBSTONED_AUDIT_ACTION);
    expect(refusal).toBeDefined();
    expect(refusal!.decisionId).toBe(block!.id);
    expect(refusal!.rowHash).toEqual(expect.any(String));

    // ONCE ONLY across further ticks — the guarded UPDATE ... RETURNING is what makes that true, and
    // it is the property the old log-only path could not have had. The wave terminalizes on the
    // following tick (the target was still counted in-flight on the tick that refused it), and the
    // campaign then parks in its existing `failed`-wave branch.
    await tick();
    await tick();
    await tick();

    const after = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(decisions)
        .where(eq(decisions.subjectId, campaign.id as string))
    );
    expect(after.filter((d) => d.kind === "wave_target" && d.verdict === "block")).toHaveLength(1);
    const afterEvents = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.subjectId, campaign.id as string))
    );
    expect(
      afterEvents.filter((e) => e.action === WAVE_TARGET_TOMBSTONED_AUDIT_ACTION)
    ).toHaveLength(1);

    const waves = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(campaignWaves)
        .where(and(eq(campaignWaves.orgId, org.orgId), eq(campaignWaves.id, target!.waveId)))
    );
    expect(waves[0]!.status).toBe("failed");
  }, 180_000);

  it("SCOPE GUARD: a LIVE campaign target still fans out into a member change", async () => {
    // Without this arm a liveness read that always answered "not live" would pass the case above
    // while silently breaking every campaign on the instance.
    const label = `live-${randomUUID().slice(0, 8)}`;
    const service = await inject("/api/v1/services", { name: `svc-${label}` });
    const component = await inject("/api/v1/components", {
      name: `comp-${label}`,
      service: service.id
    });
    const campaign = await inject("/api/v1/campaigns", {
      name: `campaign-${label}`,
      targets: [component.id as string]
    });

    await tick();

    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(campaignWaveTargets)
        .where(
          and(
            eq(campaignWaveTargets.orgId, org.orgId),
            eq(campaignWaveTargets.targetObjectId, component.id as string)
          )
        )
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("change_proposed");
    expect(rows[0]!.memberChangeObjectId).not.toBeNull();

    const campaignDecisions = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(decisions)
        .where(eq(decisions.subjectId, campaign.id as string))
    );
    expect(campaignDecisions.some((d) => d.kind === "wave_target" && d.verdict === "block")).toBe(
      false
    );
  }, 180_000);
});
