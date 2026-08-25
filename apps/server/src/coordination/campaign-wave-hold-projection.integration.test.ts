import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import type { CampaignExplainResponse } from "@scp/schemas";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import type { PluginHost } from "../plugin-host/contract.js";
import { createInMemoryFakeHost } from "./test-support/fake-plugin-host.js";
import { reconcileOrgTick } from "./reconcile.js";

/**
 * THE CAMPAIGN-LAYER WAVE-TARGET HOLD PROJECTION (M25.UI) — through the real HTTP `:explain`
 * route, the campaign-side sibling of the change-wave layer's freeze-hold projection
 * (`wave-target-freeze-hold.integration.test.ts`), which this file's own NOT-COVERED note named as
 * the gap: "`campaigns.ts`'s own `getLatestCampaignPlan`/`CampaignWaveTarget` projection — a
 * structurally separate schema, out of this increment's stated scope."
 *
 * `CampaignWaveTargetSchema.hold` / `CampaignWaveSchema.heldTargetCount` are composed by the SAME
 * `resolveActiveCampaignWaveFreezeHolds` / `toWaveTargetHold` / `activeWaveOf` machinery the change
 * side uses (`campaign-plan-service.ts`, `plan-service.ts`) — this file is the one place that
 * exercises it end to end against real Postgres, mirroring `freeze-admission.integration.test.ts`'s
 * own campaign-fan-out fixture (case F) for freeze creation/targeting.
 *
 * DRIVES `reconcileOrgTick` DIRECTLY, never a live loop — same two reasons
 * `freeze-admission.integration.test.ts` states: "N ticks" must mean exactly N, and a live loop
 * competes for the same rows these cases read back.
 *
 * NOT COVERED here, stated rather than left to be discovered:
 *   * a stage-dependency half of a hold — a campaign wave target has none (ADR-0028 is a
 *     Change-only coupling; `CampaignWaveTargetSchema.hold` is already the WHOLE hold, freeze-only).
 *   * more than one wave simultaneously `running` — `resolveActiveCampaignWaveFreezeHolds` assumes
 *     sequential wave admission, the same assumption `campaign-repo.ts`'s own M25.2 comment states
 *     ("Only the active wave fans out"); no fixture here forces two waves running at once because
 *     nothing in `campaign-wave-targets-repo.ts` appears able to produce that state.
 *   * a federation/cross-domain fixture — the same gap `component-pipeline-correlated-infra.
 *     integration.test.ts` and `component-pipeline.integration.test.ts` record for `maintainedBy`.
 */
describe("campaign wave-target hold projection (M25.UI): HTTP-layer parity with the change-wave layer", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let host: PluginHost;

  beforeAll(async () => {
    // Long auto-succeed, same reasoning as `freeze-admission.integration.test.ts`: a member Change
    // that DOES get minted must sit durably in flight rather than racing the assertions to a
    // terminal state that would flip a wave's status out from under the fixture.
    host = createInMemoryFakeHost({ autoSucceedAfterMs: 10 * 60_000 });
    server = await listenTestServer();
  });

  beforeEach(async () => {
    org = await createTestOrg(server, "campaign-hold-projection");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
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

  const freezeAt = (scopeObjectId: string, name: string) =>
    admin.freezes.create({
      scopeObjectId,
      name,
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 3_600_000).toISOString(),
      reason: `${name}: integration fixture`
    });

  async function explain(campaignId: string): Promise<CampaignExplainResponse> {
    const res = await server.app.inject({
      method: "GET",
      url: `/api/v1/campaigns/${campaignId}/explain`,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    expect(res.statusCode, "the explain route must answer").toBe(200);
    return res.json();
  }

  it("held campaign targets carry the hold verbatim, unheld siblings carry none, and heldTargetCount matches exactly", async () => {
    const heldA = await createTestComponent(admin, { name: `held-a-${randomUUID().slice(0, 8)}` });
    const heldB = await createTestComponent(admin, { name: `held-b-${randomUUID().slice(0, 8)}` });
    const free = await createTestComponent(admin, { name: `free-${randomUUID().slice(0, 8)}` });
    const freezeA = await freezeAt(heldA.id, "campaign-hold-projection-freeze-a");
    const freezeB = await freezeAt(heldB.id, "campaign-hold-projection-freeze-b");

    const campaign = await admin.campaigns.propose({
      name: `campaign-${randomUUID().slice(0, 8)}`,
      targets: [heldA.id, heldB.id, free.id]
    });

    await tick(3);

    const result = await explain(campaign.id);
    const wave = result.plan!.waves[0]!;
    expect(
      wave.status,
      "fixture check: a partially-frozen wave stays running (M25.2), not whole-wave blocked"
    ).toBe("running");
    expect(wave.heldTargetCount, "exactly two of three targets are held").toBe(2);

    const heldATarget = wave.targets.find((t) => t.targetObjectId === heldA.id)!;
    const heldBTarget = wave.targets.find((t) => t.targetObjectId === heldB.id)!;
    const freeTarget = wave.targets.find((t) => t.targetObjectId === free.id)!;

    expect(heldATarget.hold, "the held target's hold rides the wire").toBeDefined();
    expect(heldATarget.hold!.freezes).toHaveLength(1);
    expect(heldATarget.hold!.freezes[0]!.freezeId).toBe(freezeA.id);
    expect(heldATarget.hold!.freezes[0]!.scope).toEqual({ objectId: heldA.id, name: heldA.name });
    expect(typeof heldATarget.hold!.freezes[0]!.summary).toBe("string");
    expect(heldATarget.hold!.freezes[0]!.summary.length).toBeGreaterThan(0);
    expect(heldATarget.hold!.freezes[0]!.endsAt).toBe(freezeA.endsAt);

    expect(heldBTarget.hold!.freezes[0]!.freezeId).toBe(freezeB.id);

    expect(freeTarget.hold, "the unfrozen sibling carries no hold at all").toBeUndefined();
  });

  it("lifting the freeze clears the target's hold, and the wave's heldTargetCount, on the very next read", async () => {
    const held = await createTestComponent(admin, { name: `held-${randomUUID().slice(0, 8)}` });
    const free = await createTestComponent(admin, { name: `free-${randomUUID().slice(0, 8)}` });
    const freeze = await freezeAt(held.id, "campaign-hold-projection-lift-fixture");

    const campaign = await admin.campaigns.propose({
      name: `campaign-${randomUUID().slice(0, 8)}`,
      targets: [held.id, free.id]
    });

    await tick(3);
    const before = await explain(campaign.id);
    const beforeWave = before.plan!.waves[0]!;
    expect(
      beforeWave.targets.find((t) => t.targetObjectId === held.id)!.hold,
      "fixture check: the target really is held before the lift"
    ).toBeDefined();

    await admin.freezes.lift(freeze.id, { reason: "integration: hold-projection lift fixture" });
    await tick(1);

    const after = await explain(campaign.id);
    const afterWave = after.plan!.waves[0]!;
    expect(
      afterWave.targets.find((t) => t.targetObjectId === held.id)!.hold,
      "a lifted freeze is simply absent on the next read — never a stale `held`"
    ).toBeUndefined();
    expect(
      afterWave.heldTargetCount,
      "evaluated, genuinely nothing held — 0, not absent (the wave is still the one admission governs)"
    ).toBe(0);
  });

  it("a wave admission has not reached yet carries no heldTargetCount and no per-target hold, even though its own target sits under an active freeze", async () => {
    const first = await createTestComponent(admin, {
      name: `wave0-${randomUUID().slice(0, 8)}`
    });
    const second = await createTestComponent(admin, {
      name: `wave1-${randomUUID().slice(0, 8)}`
    });
    // `second` depends_on `first` -> `first` is wave 0, `second` is wave 1 (the same convention
    // `campaign-deadline.integration.test.ts` and `campaign.integration.test.ts` fixtures use).
    await admin.components.addDependsOn(second.id, first.id);
    // Freeze the SECOND wave's own target too — the point of this case is that admission has not
    // reached it yet, not that nothing would hold it once it did.
    await freezeAt(second.id, "campaign-hold-projection-unreached-wave-freeze");

    const campaign = await admin.campaigns.propose({
      name: `campaign-${randomUUID().slice(0, 8)}`,
      targets: [first.id, second.id]
    });

    await tick(3);

    const result = await explain(campaign.id);
    const wave0 = result.plan!.waves.find((w) => w.waveIndex === 0)!;
    const wave1 = result.plan!.waves.find((w) => w.waveIndex === 1)!;
    expect(
      wave0.status,
      "fixture check: wave 0's own target is unfrozen, so it is running (fanned out), not blocked"
    ).toBe("running");
    expect(
      wave1.status,
      "fixture check: wave 1 has not been reached — wave 0's member Change never terminates within this fixture's ticks"
    ).toBe("pending");

    expect(
      wave1.heldTargetCount,
      "absent, not a fabricated zero: the evaluation never looked at wave 1 at all"
    ).toBeUndefined();
    expect(
      wave1.targets.find((t) => t.targetObjectId === second.id)!.hold,
      "never evaluated, so never rendered held — even though an active freeze genuinely covers it"
    ).toBeUndefined();
  });
});
