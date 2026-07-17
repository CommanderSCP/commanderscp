import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { ScpClient } from "@scp/sdk";
import type { ExecutorType } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import {
  auditEvents,
  changeSourceEvents,
  changeWaveTargets,
  changes,
  decisions,
  objects
} from "../db/schema.js";
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
 * The routing `type` carried SOURCE MAPPING -> CHANGE -> WAVE TARGET -> the executor reconcile
 * triggers (model P4A, migration 0024; renamed from `purpose` to the Type taxonomy in ADR-0007 /
 * migration 0026).
 *
 * P3 made a component able to hold several Types of binding, but left reconcile asking
 * `getExecutorBinding(...)` with no Type — i.e. always the default. A non-default binding was
 * registerable and readable, and could never actually be TRIGGERED (nor, as the observe test below
 * shows, ever polled). This suite is the proof that the wire is connected end to end.
 *
 * The decisive assertion throughout is `change_wave_targets.executor_plugin_id`: reconcile persists
 * the plugin instance it ACTUALLY resolved and triggered, so a wave target reading 'inf-pipeline'
 * is proof the `infrastructure` binding drove the release, not the `configuration` one beside it.
 */
describe("wave target type: a release triggers the matching-Type pipeline", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "wave-type");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  // `fake-executor`: in KNOWN_EXECUTOR_MODULES but manifest-less, so validatePluginConfig skips it —
  // this suite is about Type routing, not any real plugin's config shape (same choice as P3's suite).
  const bind = (targetId: string, type: ExecutorType, instance: string) =>
    admin.executors.putBinding(targetId, {
      pluginModule: "fake-executor",
      pluginInstanceId: instance,
      type,
      config: {}
    });

  /** A component wired for BOTH pipelines — the shape where getting the Type wrong is observable. */
  async function componentWithBothPipelines(name: string): Promise<string> {
    const comp = await createTestComponent(admin, { name: `${name}-${uuidv7().slice(0, 8)}` });
    await bind(comp.id, "configuration", "cfg-pipeline");
    await bind(comp.id, "infrastructure", "inf-pipeline");
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

  it("an INFRASTRUCTURE-mapped source triggers the infrastructure binding — the pipeline P3 could register but never run", async () => {
    const componentId = await componentWithBothPipelines("infra-release");
    const repo = `acme/terraform-${uuidv7().slice(0, 8)}`;
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      createSourceMapping(tx, {
        orgId: org.orgId,
        sourceKind: "generic",
        repoPattern: repo,
        componentIdOrUrn: componentId,
        type: "infrastructure"
      })
    );

    await deliverEvent(repo);
    await tick();

    const targets = await waveTargetsFor(componentId);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.type).toBe("infrastructure");
    // The payoff. A default-typed lookup would read 'cfg-pipeline': the infra repo's release driving
    // the config pipeline — the wrong executor, silently, with no error anywhere.
    expect(targets[0]!.executorPluginId).toBe("inf-pipeline");
  });

  it("a CONFIGURATION-mapped source triggers the configuration binding, with an infrastructure binding present", async () => {
    const componentId = await componentWithBothPipelines("config-release");
    const repo = `acme/app-${uuidv7().slice(0, 8)}`;
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      createSourceMapping(tx, {
        orgId: org.orgId,
        sourceKind: "generic",
        repoPattern: repo,
        componentIdOrUrn: componentId,
        type: "configuration"
      })
    );

    await deliverEvent(repo);
    await tick();

    const targets = await waveTargetsFor(componentId);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.type).toBe("configuration");
    expect(targets[0]!.executorPluginId).toBe("cfg-pipeline");
  });

  it("DEFAULT: a mapping created without a Type drives the configuration pipeline", async () => {
    // The server default: an omitted Type resolves to 'configuration' (DEFAULT in migration 0026).
    const componentId = await componentWithBothPipelines("default-mapping");
    const repo = `acme/default-${uuidv7().slice(0, 8)}`;
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      createSourceMapping(tx, {
        orgId: org.orgId,
        sourceKind: "generic",
        repoPattern: repo,
        componentIdOrUrn: componentId
        // no type — defaults to 'configuration'
      })
    );

    await deliverEvent(repo);
    await tick();

    const targets = await waveTargetsFor(componentId);
    expect(targets[0]!.type).toBe("configuration");
    expect(targets[0]!.executorPluginId).toBe("cfg-pipeline");
  });

  it("a change proposed DIRECTLY against the API can name its Type (no mapping to inherit from)", async () => {
    const componentId = await componentWithBothPipelines("manual-infra");
    const change = await admin.changes.propose({
      name: "manual infra release",
      targets: [componentId],
      type: "infrastructure"
    });
    expect(await changeProperties(change.id)).toMatchObject({ type: "infrastructure" });

    await tick();
    const targets = await waveTargetsFor(componentId);
    expect(targets[0]!.type).toBe("infrastructure");
    expect(targets[0]!.executorPluginId).toBe("inf-pipeline");
  });

  it("DEFAULT: a change proposed without a Type is 'configuration'", async () => {
    const componentId = await componentWithBothPipelines("manual-default");
    const change = await admin.changes.propose({
      name: "unqualified release",
      targets: [componentId]
    });
    expect(await changeProperties(change.id)).toMatchObject({ type: "configuration" });

    await tick();
    const targets = await waveTargetsFor(componentId);
    expect(targets[0]!.executorPluginId).toBe("cfg-pipeline");
  });

  it("a ROLLBACK of an infrastructure change rolls the infrastructure pipeline, not the configuration one", async () => {
    // The nastiest shape the routing key can fail in. `triggerRollback` inherits the original change's
    // targets and topology; before this fix it did NOT inherit the Type, so undoing an infrastructure
    // release would fire the component's CONFIGURATION pipeline — the wrong executor, driven to "undo"
    // something it never did.
    const componentId = await componentWithBothPipelines("rollback-infra");
    const change = await admin.changes.propose({
      name: "infra release to undo",
      targets: [componentId],
      type: "infrastructure"
    });
    await tick(); // -> executing, which is where a rollback becomes legal

    const { rollbackChange } = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      triggerRollback(tx, {
        orgId: org.orgId,
        originalChangeObjectId: change.id,
        actorObjectId: SYSTEM_ACTOR_ID,
        requestId: "test-rollback",
        reason: "type inheritance test"
      })
    );
    expect(await changeProperties(rollbackChange.id)).toMatchObject({ type: "infrastructure" });

    await tick();
    const rollbackTargets = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(changeWaveTargets)
    );
    const rolled = rollbackTargets.filter((t) => t.targetObjectId === componentId);
    // Length FIRST: `[].every(...)` is true, so without this the two assertions below would pass
    // vacuously in exactly the case worth catching — the rollback never getting a plan at all.
    expect(rolled).toHaveLength(2); // the original's wave target + the rollback's
    // Both the original and its rollback drove the infrastructure pipeline — no config trigger anywhere.
    expect(rolled.every((t) => t.type === "infrastructure")).toBe(true);
    expect(rolled.every((t) => t.executorPluginId === "inf-pipeline")).toBe(true);
  });

  it("a CAMPAIGN's Type is stamped on every change it fans out", async () => {
    // A campaign is one intent over many targets ("patch the base AMI everywhere"), so its Type
    // belongs to the campaign and every fanned-out change inherits it. Without this an infrastructure
    // campaign would fire each target's configuration binding.
    const componentId = await componentWithBothPipelines("campaign-infra");
    await admin.campaigns.propose({
      name: `infra campaign ${uuidv7().slice(0, 8)}`,
      targets: [componentId],
      type: "infrastructure"
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
    // Asserted on the VALUE, not on find()-ing a match: a wrong Type here must report what it
    // actually was, rather than an unhelpful "expected undefined to be defined".
    expect((campaignChanges[0]!.properties as Record<string, unknown>)["type"]).toBe("infrastructure");
  });

  it("a Type passed inside `properties` is inherited, not clobbered — the federation-promotion path", async () => {
    // `proposeChange` writes `type` AFTER spreading the caller's properties, so a caller that carries
    // the Type INSIDE properties and doesn't also pass the typed field used to have it silently
    // overwritten with the default. `federation/promotion-repo.ts` is exactly that caller: it replays
    // a promotion bundle's change properties verbatim. An infrastructure release promoted from another
    // domain would have arrived here as 'configuration' and triggered this domain's configuration
    // binding. Asserted at proposeChange rather than through a full two-domain promotion (covered in
    // federation's own suite) — this pins the precedence rule the promotion path relies on.
    const componentId = await componentWithBothPipelines("promoted");
    const { change } = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      proposeChange(tx, {
        orgId: org.orgId,
        actorObjectId: SYSTEM_ACTOR_ID,
        requestId: "test-promotion",
        name: "promoted infra release",
        properties: { type: "infrastructure" }, // as a promotion bundle replays it — no typed field
        targets: [componentId]
      })
    );
    expect(await changeProperties(change.id)).toMatchObject({ type: "infrastructure" });

    await tick();
    const targets = await waveTargetsFor(componentId);
    expect(targets[0]!.executorPluginId).toBe("inf-pipeline");
  });

  it("a Type this version doesn't recognise is REFUSED, not quietly defaulted", async () => {
    // Reachable via version skew: Types are additive, and promotion replays a peer's properties
    // verbatim, so an outpost a version behind can be handed a Type it has never heard of. Coercing it
    // to a default would fire the wrong pipeline for a release that explicitly said otherwise. This is
    // ALSO the hard-cutover safety net (ADR-0007 D3): the retired 'infra'/'software' now hit this
    // throw. Absent still means 'configuration' — covered above.
    const componentId = await componentWithBothPipelines("future-type");
    await expect(
      withTenantTx(server.deps.db, org.orgId, (tx) =>
        proposeChange(tx, {
          orgId: org.orgId,
          actorObjectId: SYSTEM_ACTOR_ID,
          requestId: "test-future-type",
          name: "release from a newer domain",
          properties: { type: "quantum-pipeline" },
          targets: [componentId]
        })
      )
      // `badRequest(detail)` puts the message in `detail`; `.message` is just "Bad Request".
    ).rejects.toMatchObject({ status: 400, detail: expect.stringContaining("does not recognise") });
  });

  it("the retired 'software' value is REFUSED — the hard-cutover version-skew net (ADR-0007 D3)", async () => {
    // A change carrying a pre-cutover routing value is a version-skewed peer, not a right answer;
    // `typeOf` must throw rather than silently mis-route it.
    const componentId = await componentWithBothPipelines("legacy-value");
    await expect(
      withTenantTx(server.deps.db, org.orgId, (tx) =>
        proposeChange(tx, {
          orgId: org.orgId,
          actorObjectId: SYSTEM_ACTOR_ID,
          requestId: "test-legacy-value",
          name: "release carrying the retired 'software' value",
          properties: { type: "software" },
          targets: [componentId]
        })
      )
    ).rejects.toMatchObject({ status: 400, detail: expect.stringContaining("does not recognise") });
  });

  it("OBSERVE polls the infrastructure instance too, not the configuration one twice", async () => {
    // `observeOrgTick` dedupes bindings to one poll per pluginInstanceId, then re-resolves each from
    // its target. Resolving WITHOUT the deduped binding's own Type defaulted to 'configuration', so for
    // a target holding both pipelines the 'infrastructure' entry resolved the CONFIGURATION instance:
    // that instance was polled twice in a tick and the infrastructure instance was never observed at
    // all. Silent, because the resolve succeeds and hands back a perfectly valid instance — the wrong one.
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
    expect(polled).toContain("cfg-pipeline");
    expect(componentId).toBeDefined();
  });

  it("the plan is a SNAPSHOT: a RE-TRIGGER uses the wave target's Type, not the change's current one", async () => {
    // The Type is persisted onto the wave target at plan time rather than re-read from the change at
    // trigger time — the same discipline the topology document already follows. An in-flight release
    // must not switch pipelines because someone edited the change underneath it.
    //
    // Forcing a genuine RE-TRIGGER is what makes this load-bearing. A first tick compiles the plan AND
    // triggers in one pass; a second tick would only take the POLL branch, which can neither recompile
    // (`compileAndPersistPlan` runs only for state 'evaluated') nor re-trigger (`markWaveTargetTriggered`
    // is guarded on status 'triggering'). So merely editing the change and ticking again asserts
    // nothing: it would pass even if the Type WERE re-read from the change. Resetting the target to
    // 'pending' reproduces the real crash-retry path — the one place the snapshot decides which pipeline
    // fires.
    const componentId = await componentWithBothPipelines("snapshot");
    const change = await admin.changes.propose({
      name: "snapshot release",
      targets: [componentId],
      type: "infrastructure"
    });
    await tick();
    expect((await waveTargetsFor(componentId))[0]!.executorPluginId).toBe("inf-pipeline");

    // Re-point the CHANGE at the configuration pipeline, and put its target back where a crash-before-
    // commit leaves one, so the next tick genuinely re-triggers it.
    const before = await changeProperties(change.id);
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await tx
        .update(objects)
        .set({ properties: { ...before, type: "configuration" } })
        .where(eq(objects.id, change.id));
      await tx
        .update(changeWaveTargets)
        .set({ status: "pending", executorPluginId: null, executorRef: null })
        .where(eq(changeWaveTargets.targetObjectId, componentId));
    });
    await tick();

    const targets = await waveTargetsFor(componentId);
    expect(targets).toHaveLength(1);
    // Re-read-from-the-change would give 'cfg-pipeline' here; the snapshot gives 'inf-pipeline'.
    expect(targets[0]!.type).toBe("infrastructure");
    expect(targets[0]!.executorPluginId).toBe("inf-pipeline");
  });

  // -----------------------------------------------------------------------------------------------
  // FAIL-CLOSED on a masking executor-binding gap (docs/adr/0006). A target with >=1 real binding but
  // NONE for the Type being triggered must NOT fake-succeed — it hides a misconfiguration. It must
  // block loudly (Decision + hash-chained audit + `no_executor` terminal) and PARK the change. A
  // target with ZERO bindings keeps fake-succeeding (fake IS its configured rehearsal executor).
  // -----------------------------------------------------------------------------------------------

  /** Query helpers for the fail-closed assertions. */
  const decisionsForChange = (changeId: string) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(decisions).where(eq(decisions.subjectId, changeId))
    );
  const noExecutorAuditFor = (changeId: string) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.subjectId, changeId))
    );
  const changeRow = async (changeId: string) => {
    const [row] = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(changes).where(eq(changes.objectId, changeId))
    );
    return row!;
  };

  it("MASKING GAP (b): an IMAGE release against a target with only a CONFIGURATION binding blocks, does not fake-succeed", async () => {
    // Pre-fix, `getExecutorBinding(image)` returned undefined and reconcile fell back to the shared
    // fake executor, driving this target to `triggered`/`succeeded` under 'fake-executor' with NO
    // Decision, NO audit event, and NO park — a green no-op masking a real misconfiguration. This is
    // the sharpened ADR-0006 wording under Type: "has a `configuration` binding, receives an `image`
    // release." Every assertion below is therefore also the proof this test FAILS on pre-fix code.
    const componentId = await createTestComponent(admin, {
      name: `masking-gap-${uuidv7().slice(0, 8)}`
    }).then((c) => c.id);
    await bind(componentId, "configuration", "cfg-pipeline"); // a REAL binding — but only configuration.

    const change = await admin.changes.propose({
      name: "image release against a configuration-only target",
      targets: [componentId],
      type: "image"
    });

    await tick();

    // 1. The wave target reached the dedicated `no_executor` terminal — NOT `failed`, NOT a fake green.
    const targets = await waveTargetsFor(componentId);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.status).toBe("no_executor");
    // It was never handed to the shared fake executor.
    expect(targets[0]!.executorPluginId).not.toBe("fake-executor");
    expect(targets[0]!.executorRef).toBeNull();

    // 2. A `block` Decision with a decision_id names the gap.
    const changeDecisions = await decisionsForChange(change.id);
    const blockDecision = changeDecisions.find(
      (d) => d.kind === "wave_target" && d.verdict === "block"
    );
    expect(blockDecision).toBeDefined();
    expect(blockDecision!.id).toEqual(expect.any(String));
    expect(blockDecision!.inputContext).toMatchObject({
      requestedType: "image",
      boundTypes: ["configuration"]
    });

    // 3. A hash-chained audit event was written, carrying that decision_id.
    const audit = await noExecutorAuditFor(change.id);
    const noExecEvent = audit.find((e) => e.action === "change.wave_target.no_executor");
    expect(noExecEvent).toBeDefined();
    expect(noExecEvent!.decisionId).toBe(blockDecision!.id);
    expect(noExecEvent!.rowHash).toEqual(expect.any(String)); // linked into the org's hash chain.

    // 4. The change is PARKED: still `executing` (never succeeded/promoted), reconcile_blocked_at set.
    const row = await changeRow(change.id);
    expect(row.state).toBe("executing");
    expect(row.reconcileBlockedAt).not.toBeNull();
  });

  it("INTENDED-FAKE (a) boundary-pin: a ZERO-binding target still fake-succeeds unchanged", async () => {
    // The other side of the split — a target with NO bindings at all is a rehearsal/demo/test target
    // whose configured executor IS the shared fake. This must NOT collapse into the (b) block; pinned
    // so a future refactor can't quietly turn every unbound target into a `no_executor` failure.
    const componentId = await createTestComponent(admin, {
      name: `intended-fake-${uuidv7().slice(0, 8)}`
    }).then((c) => c.id);
    // Deliberately NO bind() call.

    const change = await admin.changes.propose({
      name: "release against a zero-binding rehearsal target",
      targets: [componentId]
    });

    await tick();

    const targets = await waveTargetsFor(componentId);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.status).not.toBe("no_executor");
    expect(["triggered", "observing", "succeeded"]).toContain(targets[0]!.status);
    expect(targets[0]!.executorPluginId).toBe("fake-executor"); // the shared default fallback.

    // No block Decision, no no_executor audit, and NOT parked.
    const changeDecisions = await decisionsForChange(change.id);
    expect(changeDecisions.some((d) => d.kind === "wave_target" && d.verdict === "block")).toBe(
      false
    );
    const audit = await noExecutorAuditFor(change.id);
    expect(audit.some((e) => e.action === "change.wave_target.no_executor")).toBe(false);
    expect((await changeRow(change.id)).reconcileBlockedAt).toBeNull();
  });

  it("IDEMPOTENT: re-ticking after a (b) block appends no second Decision or audit event", async () => {
    const componentId = await createTestComponent(admin, {
      name: `idempotent-block-${uuidv7().slice(0, 8)}`
    }).then((c) => c.id);
    await bind(componentId, "configuration", "cfg-pipeline");

    const change = await admin.changes.propose({
      name: "image release to block twice",
      targets: [componentId],
      type: "image"
    });

    await tick(); // first block
    await tick(); // parked change is excluded from the sweep — must not re-emit anything
    await tick();

    const blockDecisions = (await decisionsForChange(change.id)).filter(
      (d) => d.kind === "wave_target" && d.verdict === "block"
    );
    expect(blockDecisions).toHaveLength(1);

    const noExecEvents = (await noExecutorAuditFor(change.id)).filter(
      (e) => e.action === "change.wave_target.no_executor"
    );
    expect(noExecEvents).toHaveLength(1);
  });
});
