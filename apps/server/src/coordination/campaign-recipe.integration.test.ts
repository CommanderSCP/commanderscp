import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { ScpClient } from "@scp/sdk";
import type { TriggerIntent } from "@scp/plugin-api";
import { withTenantTx } from "../db/tenant-tx.js";
import { auditEvents, decisions } from "../db/schema.js";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import type { PluginHost } from "../plugin-host/contract.js";
import { getLatestPlanForChange } from "./plan-service.js";
import { reconcileOrgTick } from "./reconcile.js";
import { createInMemoryFakeHost, withRecordedIntents } from "./test-support/fake-plugin-host.js";
import {
  WAVE_TARGET_RECIPE_MANAGED_EXECUTOR_STATUS,
  WAVE_TARGET_RECIPE_UNREADABLE_STATUS,
  WAVE_TARGET_RECIPE_UNSUPPORTED_STATUS
} from "./campaign-recipe.js";

/**
 * M25.4 — THE CAMPAIGN RECIPE AT THE ACTUATOR, end to end against real Postgres (ADR-0041).
 *
 * The guarantee under test: *what the author wrote reaches the tenant's own executor verbatim, or
 * nothing reaches it at all and an operator is told why.* There is no third outcome, and the
 * absence of a third outcome is the entire increment.
 *
 * WHY EVERY ASSERTION IS AGAINST THE RECORDED `TriggerIntent` AND NOT AGAINST A STATUS COLUMN.
 * `github` and `gitea` resolve `intent.parameters?.workflowId ?? config.defaultWorkflowId`. So a
 * recipe that is silently dropped does not error — it dispatches the target's ORDINARY workflow,
 * that run succeeds, the wave target goes `succeeded`, and the campaign reports a migration that
 * never happened. A test asserting "the target succeeded" would pass against exactly that bug. The
 * only assertion that distinguishes the two is what the executor was actually handed, so
 * `withRecordedIntents` keeps the WHOLE intent (the existing `FiredTriggerCall` wrapper keeps only
 * `targetRef`/`idempotencyKey`, which cannot see `kind` or `parameters` at all).
 *
 * DRIVES `reconcileOrgTick` DIRECTLY, no pg-boss loop — `withPluginHost`, never
 * `withReconcileLoop`. A live loop is a COMPETING CONSUMER of the very rows these cases read back
 * (`SKIP LOCKED` makes an inline call a silent no-op), and "N ticks" must mean exactly N for the
 * zero-trigger assertions to be real rather than racy.
 *
 * A FRESH ORG PER CASE, for the reason `freeze-admission.integration.test.ts` measured:
 * `advanceExecutingChanges` serves `ORDER BY reconcile_cursor_at ASC LIMIT 25`, and every refusal
 * case here deliberately leaves a TERMINAL target behind, so on a shared org "tick(2)" would decay
 * from "two evaluations of my change" into "two sweeps in which my change may have had a turn".
 *
 * NO FIXED SLEEPS. Every wait is a tick count, which is a positive signal the engine writes.
 */

/** The motivating campaign: python2 -> python3 across an estate. `github`-shaped keys, and they
 *  cross to the executor UNTRANSLATED — see the no-translation case. */
const PY3_RECIPE = {
  version: 1,
  trigger: {
    kind: "workflow_dispatch",
    parameters: {
      workflowId: "migrate-py3.yml",
      ref: "main",
      inputs: { fromVersion: "2.7", toVersion: "3.12", dryRun: false }
    }
  },
  guidance: { title: "python2 -> python3" }
} as const;

describe("campaign recipes: verbatim to the executor, or refused with a decision_id (M25.4)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let host: PluginHost;
  let intents: TriggerIntent[];

  /** Narrows what EVERY executor in the suite declares it can do, for the capability-refusal case.
   *  `undefined` leaves `@scp/plugin-fake-executor`'s real declaration (all four kinds) alone —
   *  which is why no other case can accidentally trip the refusal. */
  let declaredTriggerKinds: TriggerIntent["kind"][] | undefined;

  beforeAll(async () => {
    const recorded = withRecordedIntents(
      // Long auto-succeed: a target that IS triggered stays durably in flight rather than racing
      // the assertions to completion, so the recorded intent is read while it is still the truth.
      createInMemoryFakeHost({ autoSucceedAfterMs: 10 * 60_000 }),
      () => declaredTriggerKinds
    );
    host = recorded.host;
    intents = recorded.intents;
    server = await listenTestServer({});
  }, 180_000);

  beforeEach(async () => {
    declaredTriggerKinds = undefined;
    intents.length = 0;
    org = await createTestOrg(server, "recipe");
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

  const component = (label: string) =>
    createTestComponent(admin, { name: `${label}-${randomUUID().slice(0, 8)}` });

  /** A change proposed directly against a component, optionally carrying a recipe in `properties`.
   *  Reconcile reads the recipe off the CHANGE (`campaign-reconcile.ts` copies it there at
   *  fan-out), so this drives the identical actuator path a campaign member change takes — and it
   *  is also the shape a PROMOTED change arrives in. */
  const release = (label: string, targetId: string, recipe?: unknown) =>
    admin.changes.propose({
      name: `${label}-${randomUUID().slice(0, 8)}`,
      targets: [targetId],
      ...(recipe === undefined ? {} : { properties: { recipe } })
    });

  const intentsFor = (targetId: string) => intents.filter((i) => i.targetRef === targetId);

  async function waveTargetStatus(changeId: string, targetId: string): Promise<string> {
    const plan = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      getLatestPlanForChange(tx, org.orgId, changeId)
    );
    const target = plan!.waves.flatMap((w) => w.targets).find((t) => t.targetObjectId === targetId);
    if (!target) throw new Error(`no wave target for ${targetId}`);
    return target.status;
  }

  const blockDecisions = (changeId: string) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(decisions)
        .where(
          and(
            eq(decisions.orgId, org.orgId),
            eq(decisions.subjectId, changeId),
            eq(decisions.kind, "wave_target")
          )
        )
        .orderBy(decisions.createdAt, decisions.id)
    );

  // A — THE CHANNEL. This is the increment; if it regresses, everything else here is decoration.
  it("carries the recipe's parameters to the executor VERBATIM, and uses the recipe's kind", async () => {
    const app = await component("py3");
    const change = await release("py3", app.id, PY3_RECIPE);

    await tick(2);

    const fired = intentsFor(app.id);
    expect(fired.length, "the recipe's target must actually be triggered").toBe(1);
    // THE KIND CAME FROM THE RECIPE. Pre-M25.4 this line was `kind = "sync"` unconditionally, so
    // asserting the kind is what separates a wired channel from a decorative one.
    expect(fired[0]!.kind).toBe("workflow_dispatch");
    // BYTE-FOR-BYTE. Not "contains", not "matches the keys it understands" — the whole bag,
    // including the nested `inputs` object and the `false` that a lossy copy turns into a string.
    expect(fired[0]!.parameters).toEqual(PY3_RECIPE.trigger.parameters);
    expect(await waveTargetStatus(change.id, app.id)).not.toMatch(/^recipe_/);
  });

  /**
   * NO CROSS-PROVIDER TRANSLATION (ADR-0041 §6), asserted as the absence of a rewrite.
   *
   * A bag carrying BOTH `github` vocabulary (`inputs`) and `gitlab` vocabulary (`variables`) plus a
   * key no adapter models at all must arrive with all three intact and nothing renamed, added or
   * dropped. `inputs` and `variables` are not the same thing — GitHub validates inputs against the
   * workflow's declared `workflow_dispatch.inputs`, GitLab variables are free-form CI variables —
   * so any mapping between them is a guess about semantics, and a wrong guess does not fail: it
   * triggers the wrong automation in the tenant's own repository.
   */
  it("performs NO cross-provider translation — foreign and unknown keys arrive untouched", async () => {
    const mixed = {
      version: 1,
      trigger: {
        kind: "custom",
        parameters: {
          inputs: { target: "3.12" },
          variables: { TARGET: "3.12" },
          targetRevision: "release-2026",
          somethingNoAdapterModels: { nested: [1, "two", null] }
        }
      }
    };
    const app = await component("mixed");
    await release("mixed", app.id, mixed);

    await tick(2);

    const fired = intentsFor(app.id);
    expect(fired.length).toBe(1);
    expect(fired[0]!.kind).toBe("custom");
    expect(fired[0]!.parameters).toEqual(mixed.trigger.parameters);
    // The exact key SET, so an added translation (e.g. deriving `workflowId` from `inputs`) fails
    // here even though every original key still deep-equals.
    expect(Object.keys(fired[0]!.parameters!).sort()).toEqual([
      "inputs",
      "somethingNoAdapterModels",
      "targetRevision",
      "variables"
    ]);
  });

  /**
   * B — A RECIPE-LESS CHANGE IS BYTE-IDENTICAL TO PRE-M25.4.
   *
   * `parameters` must be ABSENT, not `{}`. `pipeline-generic` passes the bag straight through to a
   * tenant's own HTTP endpoint, so an empty object newly appearing on every trigger on the instance
   * is a wire change, not a no-op. `toEqual(undefined)` would NOT catch this — an own property
   * whose value is `undefined` passes that and still serializes differently — so the assertion is
   * on key presence.
   */
  it("leaves `parameters` ABSENT (not empty) and the kind `sync` when the change carries no recipe", async () => {
    const app = await component("plain");
    await release("plain", app.id);

    await tick(2);

    const fired = intentsFor(app.id);
    expect(fired.length).toBe(1);
    expect(fired[0]!.kind).toBe("sync");
    expect(Object.prototype.hasOwnProperty.call(fired[0]!, "parameters")).toBe(false);
  });

  // C — THE CAPABILITY REFUSAL. Zero trigger() calls is the assertion the DoD names.
  it("REFUSES a recipe the bound executor cannot serve: zero trigger() calls, terminal row, resolvable decision_id", async () => {
    // `argocd`'s real declared set, so the case is exercised against a shape production produces
    // rather than an invented one. It is DISJOINT from `workflow_dispatch`.
    declaredTriggerKinds = ["sync", "rollback"];
    const app = await component("nosuchverb");
    const change = await release("nosuchverb", app.id, PY3_RECIPE);

    await tick(2);

    // THE ASSERTION THE MILESTONE IS JUDGED ON. Not "it failed" — that a bare sync was never
    // substituted for the migration the author asked for.
    expect(intentsFor(app.id).length).toBe(0);
    expect(await waveTargetStatus(change.id, app.id)).toBe(WAVE_TARGET_RECIPE_UNSUPPORTED_STATUS);

    const blocked = await blockDecisions(change.id);
    expect(blocked.length).toBe(1);
    expect(blocked[0]!.verdict).toBe("block");
    // RESOLVABLE, not merely present — charter principle 6 promises an operator can reach the
    // reasons from the id, so the id is followed rather than asserted to be a uuid.
    const explained = await admin.decisions.get(blocked[0]!.id);
    expect(explained.verdict).toBe("block");
    expect(JSON.stringify(explained.inputContext)).toContain("workflow_dispatch");
    // The executor's OWN declared set reaches the operator, so the remedy is actionable.
    expect(JSON.stringify(explained.inputContext)).toContain("sync");

    // Hash-chained audit event, written in the same transaction as the refusal.
    const audits = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.orgId, org.orgId),
            eq(auditEvents.action, "change.wave_target.recipe_unsupported")
          )
        )
    );
    expect(audits.length).toBe(1);
  });

  it("does NOT refuse when the executor declares the recipe's kind — the refusal is discriminating, not blanket", async () => {
    // The control for the case above. Without it, a refusal that fired on EVERY recipe would pass
    // every zero-trigger assertion in this file and look like a working feature.
    declaredTriggerKinds = ["sync", "workflow_dispatch"];
    const app = await component("hasverb");
    const change = await release("hasverb", app.id, PY3_RECIPE);

    await tick(2);

    expect(intentsFor(app.id).length).toBe(1);
    expect(await waveTargetStatus(change.id, app.id)).not.toMatch(/^recipe_/);
    expect(await blockDecisions(change.id)).toEqual([]);
  });

  // D — A RECIPE THAT DOES NOT PARSE IS A REFUSAL, NEVER AN ABSENCE.
  it("REFUSES an unparseable recipe rather than degrading to a bare sync", async () => {
    // Reaches the actuator through a door the authoring guard deliberately does not cover: a change
    // is not guarded (a 400 on the promotion path is DEFERRED AND RETRIED FOREVER by
    // `inbox-loop.ts`, which would wedge a peer's bundle silently). This is the shape a promoted
    // change from a peer speaking a newer recipe vocabulary arrives in.
    const app = await component("unreadable");
    const change = await release("unreadable", app.id, { version: 2, trigger: { kind: "sync" } });

    await tick(2);

    // If this ever regresses to "no recipe", the target triggers a bare sync, that run SUCCEEDS,
    // and the campaign goes green having coordinated nothing. That is the whole reason the resolver
    // has three outcomes instead of two.
    expect(intentsFor(app.id).length).toBe(0);
    expect(await waveTargetStatus(change.id, app.id)).toBe(WAVE_TARGET_RECIPE_UNREADABLE_STATUS);
    const blocked = await blockDecisions(change.id);
    expect(blocked.length).toBe(1);
    expect(blocked[0]!.verdict).toBe("block");
  });

  // E — OQ-5: A RECIPE MAY NOT DRIVE ONE OF COMMANDERSCP'S OWN ACTUATORS.
  /**
   * The hazard M25.4 CREATED and this refusal closes. `managed-dep` truthfully declares
   * `triggerKinds: ["custom"]`, so the capability check above passes it — and reconcile would then
   * hand author-controlled `parameters` to the actuator that writes commits into a tenant
   * repository under a narrow charter grant. Before the `parameters` channel was wired, that path
   * was inert: `managed-dep.trigger()` threw on its own missing-`action` check because nothing ever
   * populated `parameters`. Wiring the channel is what made it live.
   *
   * OQ-5 is UNRULED, so the fail-closed default is a refusal.
   *
   * THE ENV VAR IS THE POINT, not a workaround: `resolveExecutorPluginInstance` throws unless
   * `SCP_MANAGED_DEP_RUNNER_IMAGE` is set, and with it set this is exactly the supported
   * "managed-dep binding an operator creates by hand" that `executor-bindings-repo.ts` documents.
   * Without it the case would prove only that an unconfigured instance errors, which is a different
   * fact.
   */
  it("REFUSES a recipe aimed at a managed actuator, even though that actuator declares the kind (OQ-5)", async () => {
    const previous = process.env.SCP_MANAGED_DEP_RUNNER_IMAGE;
    process.env.SCP_MANAGED_DEP_RUNNER_IMAGE = "scp-runner-dep:test";
    try {
      const app = await component("managed");
      await admin.executors.putBinding(app.id, {
        pluginModule: "managed-dep",
        pluginInstanceId: `managed-dep-${randomUUID().slice(0, 8)}`
      });
      // `custom` is a kind `managed-dep` genuinely serves, and the parameters are the real bump
      // descriptor — so the ONLY thing standing between this document and the actuator is the
      // module refusal. A recipe naming a kind it could not serve would be refused by the
      // capability check instead, and would prove nothing about OQ-5.
      const change = await release("managed", app.id, {
        version: 1,
        trigger: { kind: "custom", parameters: { action: "bump", delivery: "auto_merge" } }
      });

      await tick(2);

      expect(intentsFor(app.id).length).toBe(0);
      expect(await waveTargetStatus(change.id, app.id)).toBe(
        WAVE_TARGET_RECIPE_MANAGED_EXECUTOR_STATUS
      );
      const blocked = await blockDecisions(change.id);
      expect(blocked.length).toBe(1);
      const explained = await admin.decisions.get(blocked[0]!.id);
      expect(JSON.stringify(explained.inputContext)).toContain("managed-dep");
    } finally {
      if (previous === undefined) delete process.env.SCP_MANAGED_DEP_RUNNER_IMAGE;
      else process.env.SCP_MANAGED_DEP_RUNNER_IMAGE = previous;
    }
  });

  // F — THE FAN-OUT. One authored intent, N targets: the "1-click" claim itself.
  it("copies the campaign's recipe onto EVERY member change it fans out — the '1-click' claim itself", async () => {
    const targets = await Promise.all([component("fan-a"), component("fan-b"), component("fan-c")]);
    const campaign = await admin.campaigns.propose({
      name: `py3-estate-${randomUUID().slice(0, 8)}`,
      targets: targets.map((t) => t.id),
      recipe: PY3_RECIPE
    });

    // Read back through the API, so the response CONTRACT carries the recipe rather than it living
    // only in a properties blob no SDK consumer can see (charter principle 3).
    expect((await admin.campaigns.get(campaign.id)).recipe).toEqual(PY3_RECIPE);

    // `reconcileOrgTick` drives `reconcileCampaignsOrgTick` itself (reconcile.ts:2740), so ticking
    // compiles the plan and fans the wave out. Ticked until member changes EXIST — a positive
    // signal the engine writes, never a sleep.
    const members = await waitFor(async () => {
      await tick();
      const explained = await admin.campaigns.explain(campaign.id);
      const ids = (explained.plan?.waves ?? [])
        .flatMap((w) => w.targets)
        .map((t) => t.memberChangeObjectId)
        .filter((id): id is string => id !== null);
      return ids.length > 0 ? ids : undefined;
    }, "the campaign fans out at least one member change");

    // EVERY member change carries the recipe, by value. One authored intent; N governed changes.
    for (const memberId of members) {
      const member = await admin.changes.get(memberId);
      expect(
        (member.properties as Record<string, unknown> | null)?.recipe,
        `member change ${memberId} must carry the campaign's recipe`
      ).toEqual(PY3_RECIPE);
    }

    // And it is a real fan-out, not one change that happened to be first: the campaign's own
    // targets are the population the recipe reached.
    expect(new Set(campaign.targets)).toEqual(new Set(targets.map((t) => t.id)));
  });

  /** Polls a positive signal the engine writes. No fixed sleep: the deadline exists only so a
   *  loaded box fails with THIS message rather than an inscrutable assertion later. */
  async function waitFor<T>(
    read: () => Promise<T | undefined>,
    describe: string,
    timeoutMs = 20_000
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const got = await read();
      if (got !== undefined) return got;
      if (Date.now() > deadline) throw new Error(`timed out waiting for: ${describe}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }
});
