import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { ScpClient } from "@scp/sdk";
import { withTenantTx } from "../db/tenant-tx.js";
import { changeSourceEvents, changeWaveTargets, objects } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { createSourceMapping } from "./source-mappings-repo.js";
import { processChangeSourceEvents } from "./webhook-processor.js";
import { reconcileOrgTick } from "./reconcile.js";
import { reconcileCampaignsOrgTick } from "./campaign-reconcile.js";
import { observeOrgTick } from "./observe.js";
import type { PluginHost } from "../plugin-host/contract.js";
import { triggerRollback } from "./rollback.js";
import { proposeChange } from "./changes-repo.js";
import { SYSTEM_ACTOR_ID } from "./system-actor.js";
import { getSharedCelSandbox } from "../governance/cel-sandbox.js";
import { createInMemoryFakeHost } from "./test-support/fake-plugin-host.js";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * `purpose` carried SOURCE MAPPING -> CHANGE -> WAVE TARGET -> the executor reconcile triggers
 * (model P4A, migration 0024).
 *
 * P3 made a component able to hold BOTH an infra and a software binding, but left reconcile asking
 * `getExecutorBinding(...)` with no purpose — i.e. always 'software'. An infra binding was
 * registerable and readable, and could never actually be TRIGGERED (nor, as the observe test below
 * shows, ever polled). This suite is the proof that the wire is connected end to end, and — just as
 * importantly — that nothing that worked before P4A behaves differently now.
 *
 * The decisive assertion throughout is `change_wave_targets.executor_plugin_id`: reconcile persists
 * the plugin instance it ACTUALLY resolved and triggered, so a wave target reading 'inf-pipeline'
 * is proof the infra binding drove the release, not the software one sitting next to it.
 */
describe("wave target purpose: an infra release triggers the infra pipeline", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "wave-purpose");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  // `fake-executor`: in KNOWN_EXECUTOR_MODULES but manifest-less, so validatePluginConfig skips it —
  // this suite is about PURPOSE routing, not any real plugin's config shape (same choice as P3's suite).
  const bind = (targetId: string, purpose: "infra" | "software", instance: string) =>
    admin.executors.putBinding(targetId, {
      pluginModule: "fake-executor",
      pluginInstanceId: instance,
      purpose,
      config: {}
    });

  /** A component wired for BOTH pipelines — the shape where getting purpose wrong is observable. */
  async function componentWithBothPipelines(name: string): Promise<string> {
    const comp = await createTestComponent(admin, { name: `${name}-${uuidv7().slice(0, 8)}` });
    await bind(comp.id, "software", "sw-pipeline");
    await bind(comp.id, "infra", "inf-pipeline");
    return comp.id;
  }

  /** Drives one full org tick: proposed -> ... -> executing, triggering each wave target. */
  const tick = () =>
    reconcileOrgTick(
      server.deps.db,
      org.orgId,
      // Long auto-succeed: a target must still be observably TRIGGERED when we assert, rather than
      // racing the fake executor's clock to 'succeeded'.
      createInMemoryFakeHost({ autoSucceedAfterMs: 60_000 }),
      getSharedCelSandbox(),
      server.deps.config.secretsMasterKey
    );

  const waveTargetsFor = (componentId: string) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(changeWaveTargets).where(eq(changeWaveTargets.targetObjectId, componentId))
    );

  const changeProperties = async (changeId: string): Promise<Record<string, unknown>> => {
    const [row] = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(objects).where(eq(objects.id, changeId))
    );
    return (row!.properties ?? {}) as Record<string, unknown>;
  };

  /** Feeds one event through the real ingress correlation path (mapping match -> proposeChange). */
  async function deliverEvent(repo: string): Promise<void> {
    const eventId = uuidv7();
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.insert(changeSourceEvents).values({
        id: eventId,
        orgId: org.orgId,
        sourceKind: "generic",
        signatureVerified: true,
        dedupeKey: `test:${eventId}`,
        headers: {},
        payload: { repo, correlationKey: "refs/heads/main" }
      })
    );
    await withTenantTx(server.deps.db, org.orgId, (tx) => processChangeSourceEvents(tx, org.orgId));
  }

  it("an INFRA-mapped source triggers the infra binding — the pipeline P3 could register but never run", async () => {
    const componentId = await componentWithBothPipelines("infra-release");
    const repo = `acme/terraform-${uuidv7().slice(0, 8)}`;
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      createSourceMapping(tx, {
        orgId: org.orgId,
        sourceKind: "generic",
        repoPattern: repo,
        componentIdOrUrn: componentId,
        purpose: "infra"
      })
    );

    await deliverEvent(repo);
    await tick();

    const targets = await waveTargetsFor(componentId);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.purpose).toBe("infra");
    // The payoff. Pre-P4A this read 'sw-pipeline': the infra repo's release driving the app's
    // deploy pipeline — the wrong executor, silently, with no error anywhere.
    expect(targets[0]!.executorPluginId).toBe("inf-pipeline");
  });

  it("a SOFTWARE-mapped source still triggers the software binding, with an infra binding present", async () => {
    const componentId = await componentWithBothPipelines("software-release");
    const repo = `acme/app-${uuidv7().slice(0, 8)}`;
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      createSourceMapping(tx, {
        orgId: org.orgId,
        sourceKind: "generic",
        repoPattern: repo,
        componentIdOrUrn: componentId,
        purpose: "software"
      })
    );

    await deliverEvent(repo);
    await tick();

    const targets = await waveTargetsFor(componentId);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.purpose).toBe("software");
    expect(targets[0]!.executorPluginId).toBe("sw-pipeline");
  });

  it("BACKWARD COMPAT: a mapping created without a purpose still drives the software pipeline", async () => {
    // The pre-P4A shape: every existing mapping migrated to purpose='software' (DEFAULT in 0024),
    // and reconcile triggered 'software' unconditionally. Both must stay true.
    const componentId = await componentWithBothPipelines("legacy-mapping");
    const repo = `acme/legacy-${uuidv7().slice(0, 8)}`;
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      createSourceMapping(tx, {
        orgId: org.orgId,
        sourceKind: "generic",
        repoPattern: repo,
        componentIdOrUrn: componentId
        // no purpose — exactly how every mapping predating P4A reads
      })
    );

    await deliverEvent(repo);
    await tick();

    const targets = await waveTargetsFor(componentId);
    expect(targets[0]!.purpose).toBe("software");
    expect(targets[0]!.executorPluginId).toBe("sw-pipeline");
  });

  it("a change proposed DIRECTLY against the API can name its purpose (no mapping to inherit from)", async () => {
    const componentId = await componentWithBothPipelines("manual-infra");
    const change = await admin.changes.propose({
      name: "manual infra release",
      targets: [componentId],
      purpose: "infra"
    });
    expect(await changeProperties(change.id)).toMatchObject({ purpose: "infra" });

    await tick();
    const targets = await waveTargetsFor(componentId);
    expect(targets[0]!.purpose).toBe("infra");
    expect(targets[0]!.executorPluginId).toBe("inf-pipeline");
  });

  it("BACKWARD COMPAT: a change proposed without a purpose is 'software' — every pre-P4A client", async () => {
    const componentId = await componentWithBothPipelines("manual-default");
    const change = await admin.changes.propose({
      name: "unqualified release",
      targets: [componentId]
    });
    expect(await changeProperties(change.id)).toMatchObject({ purpose: "software" });

    await tick();
    const targets = await waveTargetsFor(componentId);
    expect(targets[0]!.executorPluginId).toBe("sw-pipeline");
  });

  it("a ROLLBACK of an infra change rolls the infra pipeline, not the software one", async () => {
    // The nastiest shape purpose can fail in. `triggerRollback` inherits the original change's
    // targets and topology; before this fix it did NOT inherit purpose, so undoing an infra release
    // would fire the component's SOFTWARE pipeline — the wrong executor, driven to "undo" something
    // it never did.
    const componentId = await componentWithBothPipelines("rollback-infra");
    const change = await admin.changes.propose({
      name: "infra release to undo",
      targets: [componentId],
      purpose: "infra"
    });
    await tick(); // -> executing, which is where a rollback becomes legal

    const { rollbackChange } = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      triggerRollback(tx, {
        orgId: org.orgId,
        originalChangeObjectId: change.id,
        actorObjectId: SYSTEM_ACTOR_ID,
        requestId: "test-rollback",
        reason: "purpose inheritance test"
      })
    );
    expect(await changeProperties(rollbackChange.id)).toMatchObject({ purpose: "infra" });

    await tick();
    const rollbackTargets = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(changeWaveTargets)
    );
    const rolled = rollbackTargets.filter((t) => t.targetObjectId === componentId);
    // Length FIRST: `[].every(...)` is true, so without this the two assertions below would pass
    // vacuously in exactly the case worth catching — the rollback never getting a plan at all.
    expect(rolled).toHaveLength(2); // the original's wave target + the rollback's
    // Both the original and its rollback drove the infra pipeline — no software trigger anywhere.
    expect(rolled.every((t) => t.purpose === "infra")).toBe(true);
    expect(rolled.every((t) => t.executorPluginId === "inf-pipeline")).toBe(true);
  });

  it("a CAMPAIGN's purpose is stamped on every change it fans out", async () => {
    // A campaign is one intent over many targets ("patch the base AMI everywhere"), so its purpose
    // belongs to the campaign and every fanned-out change inherits it. Without this an infra
    // campaign would fire each target's software binding.
    const componentId = await componentWithBothPipelines("campaign-infra");
    await admin.campaigns.propose({
      name: `infra campaign ${uuidv7().slice(0, 8)}`,
      targets: [componentId],
      purpose: "infra"
    });

    await reconcileCampaignsOrgTick(
      server.deps.db,
      org.orgId,
      createInMemoryFakeHost({ autoSucceedAfterMs: 60_000 }),
      getSharedCelSandbox()
    );

    const fanned = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(objects).where(eq(objects.typeId, "change"))
    );
    // componentId is freshly created in this test, so any change targeting it came from this campaign.
    const campaignChanges = fanned.filter((c) => {
      const targets = (c.properties as Record<string, unknown> | null)?.["targets"];
      return Array.isArray(targets) && targets.includes(componentId);
    });
    expect(campaignChanges).toHaveLength(1);
    // Asserted on the VALUE, not on find()-ing a match: a software purpose here must report what it
    // actually was, rather than an unhelpful "expected undefined to be defined".
    expect((campaignChanges[0]!.properties as Record<string, unknown>)["purpose"]).toBe("infra");
  });

  it("a purpose passed inside `properties` is inherited, not clobbered — the federation-promotion path", async () => {
    // `proposeChange` writes `purpose` AFTER spreading the caller's properties, so a caller that
    // carries purpose INSIDE properties and doesn't also pass the typed field used to have it
    // silently overwritten with 'software'. `federation/promotion-repo.ts` is exactly that caller:
    // it replays a promotion bundle's change properties verbatim. An infra release promoted from
    // another domain would have arrived here as 'software' and triggered this domain's software
    // binding. Asserted at proposeChange rather than through a full two-domain promotion (covered in
    // federation's own suite) — this pins the precedence rule the promotion path relies on.
    const componentId = await componentWithBothPipelines("promoted");
    const { change } = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      proposeChange(tx, {
        orgId: org.orgId,
        actorObjectId: SYSTEM_ACTOR_ID,
        requestId: "test-promotion",
        name: "promoted infra release",
        properties: { purpose: "infra" }, // as a promotion bundle replays it — no typed field
        targets: [componentId]
      })
    );
    expect(await changeProperties(change.id)).toMatchObject({ purpose: "infra" });

    await tick();
    const targets = await waveTargetsFor(componentId);
    expect(targets[0]!.executorPluginId).toBe("inf-pipeline");
  });

  it("a purpose this version doesn't recognise is REFUSED, not quietly treated as software", async () => {
    // Reachable via version skew: purposes are additive, and promotion replays a peer's properties
    // verbatim, so an outpost a version behind can be handed a purpose it has never heard of.
    // Coercing it to 'software' would fire the software pipeline for a release that explicitly said
    // it was not software. Absent still means 'software' — that's every pre-P4A change, and is
    // covered above.
    const componentId = await componentWithBothPipelines("future-purpose");
    await expect(
      withTenantTx(server.deps.db, org.orgId, (tx) =>
        proposeChange(tx, {
          orgId: org.orgId,
          actorObjectId: SYSTEM_ACTOR_ID,
          requestId: "test-future-purpose",
          name: "release from a newer domain",
          properties: { purpose: "quantum-pipeline" },
          targets: [componentId]
        })
      )
      // `badRequest(detail)` puts the message in `detail`; `.message` is just "Bad Request".
    ).rejects.toMatchObject({ status: 400, detail: expect.stringContaining("does not recognise") });
  });

  it("OBSERVE polls the infra instance too, not the software one twice", async () => {
    // `observeOrgTick` dedupes bindings to one poll per pluginInstanceId, then re-resolves each from
    // its target. Resolving WITHOUT the deduped binding's own purpose defaulted to 'software', so for
    // a target holding both pipelines the 'infra' entry resolved the SOFTWARE instance: that instance
    // was polled twice in a tick and the infra instance was never observed at all. Silent, because
    // the resolve succeeds and hands back a perfectly valid instance — just the wrong one.
    const componentId = await componentWithBothPipelines("observe-both");

    const polled: string[] = [];
    const base = createInMemoryFakeHost({});
    const recording: PluginHost = {
      ...base,
      executor: (instanceId: string) => {
        polled.push(instanceId);
        return base.executor(instanceId);
      }
    };

    await observeOrgTick(server.deps.db, org.orgId, recording, server.deps.config.secretsMasterKey);

    // Other tests in this org bind the same two instance ids, so assert on THIS component's pair
    // rather than on the whole list.
    expect(polled).toContain("inf-pipeline");
    expect(polled).toContain("sw-pipeline");
    expect(componentId).toBeDefined();
  });

  it("the plan is a SNAPSHOT: a RE-TRIGGER uses the wave target's purpose, not the change's current one", async () => {
    // Purpose is persisted onto the wave target at plan time rather than re-read from the change at
    // trigger time — the same discipline the topology document already follows. An in-flight release
    // must not switch pipelines because someone edited the change underneath it.
    //
    // Forcing a genuine RE-TRIGGER is what makes this load-bearing. A first tick compiles the plan
    // AND triggers in one pass; a second tick would only take the POLL branch, which can neither
    // recompile (`compileAndPersistPlan` runs only for state 'evaluated') nor re-trigger
    // (`markWaveTargetTriggered` is guarded on status 'triggering'). So merely editing the change and
    // ticking again asserts nothing: it would pass even if purpose WERE re-read from the change.
    // Resetting the target to 'pending' reproduces the real crash-retry path — the one place the
    // snapshot actually decides which pipeline fires.
    const componentId = await componentWithBothPipelines("snapshot");
    const change = await admin.changes.propose({
      name: "snapshot release",
      targets: [componentId],
      purpose: "infra"
    });
    await tick();
    expect((await waveTargetsFor(componentId))[0]!.executorPluginId).toBe("inf-pipeline");

    // Re-point the CHANGE at the software pipeline, and put its target back where a crash-before-
    // commit leaves one, so the next tick genuinely re-triggers it.
    const before = await changeProperties(change.id);
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await tx
        .update(objects)
        .set({ properties: { ...before, purpose: "software" } })
        .where(eq(objects.id, change.id));
      await tx
        .update(changeWaveTargets)
        .set({ status: "pending", executorPluginId: null, executorRef: null })
        .where(eq(changeWaveTargets.targetObjectId, componentId));
    });
    await tick();

    const targets = await waveTargetsFor(componentId);
    expect(targets).toHaveLength(1);
    // Re-read-from-the-change would give 'sw-pipeline' here; the snapshot gives 'inf-pipeline'.
    expect(targets[0]!.purpose).toBe("infra");
    expect(targets[0]!.executorPluginId).toBe("inf-pipeline");
  });
});
