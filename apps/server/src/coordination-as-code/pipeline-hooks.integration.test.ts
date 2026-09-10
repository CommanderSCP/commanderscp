import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import type { DesiredStateManifest, ManifestPipelineHook, PlanDiff } from "@scp/schemas";
import { Component, Service, Stack } from "@scp/coordination-as-code";
import { withTenantTx, type TenantTx } from "../db/tenant-tx.js";
import { listHooksForComponents } from "../coordination/pipeline-hooks-repo.js";
import {
  createTestOrg,
  createTestUser,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/** THE IaC RUNG OF THE PIPELINE-HOOK CONTRACT. See docs/coordination-as-code.md §31. */
describe("iac: pipeline hooks (D11/D21, migration 0096)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  const inOrg = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> =>
    withTenantTx(server.deps.db, org.orgId, fn);

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "iac-pipeline-hooks");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  const applyLatest = async (manifest: DesiredStateManifest) => {
    const plan = await admin.plans.create(manifest);
    await admin.plans.apply(plan.id);
    return plan;
  };

  const workflow = (path: string) => ({
    repo: "acme/pipelines",
    branch: "main",
    path
  });

  /** The live rows, read through the function the loop uses. See docs/coordination-as-code.md §32. */
  const hooksOf = async (componentUrn: string) => {
    const component = await admin.components.get(componentUrn);
    const rows = await inOrg((tx) => listHooksForComponents(tx, org.orgId, [component.id]));
    return rows
      .map((row) => ({
        kind: row.kind,
        hookId: row.hookId,
        workflow: row.workflow ?? null,
        stage: row.stage,
        everySeconds: row.everySeconds,
        maxAgeSeconds: row.maxAgeSeconds,
        quietWindowSeconds: row.quietWindowSeconds
      }))
      .sort((a, b) => `${a.kind}/${a.hookId}`.localeCompare(`${b.kind}/${b.hookId}`));
  };

  /** `(hookKind, hookId)` -> action, for a compact whole-collection assertion. */
  const actions = (diff: PlanDiff): Record<string, string> =>
    Object.fromEntries(
      (diff.pipelineHooks ?? []).map((entry) => [`${entry.hookKind}/${entry.hookId}`, entry.action])
    );

  /** THE PLAN IS THE WHOLE STORY. See docs/coordination-as-code.md §33. */
  const assertPlanExplainsTransition = (
    diff: PlanDiff,
    before: Awaited<ReturnType<typeof hooksOf>>,
    after: Awaited<ReturnType<typeof hooksOf>>
  ) => {
    // KEY ORDER IS NOT CONTENT. `jsonb` returns `workflow`'s keys in its own storage order (length,
    // then bytewise), so a plain `JSON.stringify` of a row and of a manifest declaration differ as
    // strings while being the same object — the same trap `canonicalJson` exists to avoid on the
    // server side, and the reason the diff keys through it rather than through `JSON.stringify`.
    const stable = (value: unknown): string =>
      JSON.stringify(value, (_k, v) =>
        v && typeof v === "object" && !Array.isArray(v)
          ? Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => a.localeCompare(b)))
          : v
      );
    const shape = (row: (typeof before)[number]) => stable(row);
    const entryShape = (entry: NonNullable<PlanDiff["pipelineHooks"]>[number]) =>
      stable({
        kind: entry.hookKind,
        hookId: entry.hookId,
        workflow: entry.workflow,
        stage: entry.stage,
        everySeconds: entry.everySeconds,
        maxAgeSeconds: entry.maxAgeSeconds,
        quietWindowSeconds: entry.quietWindowSeconds
      });

    const beforeShapes = new Set(before.map(shape));
    const afterShapes = new Set(after.map(shape));
    const created = [...afterShapes].filter((s) => !beforeShapes.has(s));
    const removed = [...beforeShapes].filter((s) => !afterShapes.has(s));

    const plannedCreates = new Set(
      (diff.pipelineHooks ?? []).filter((e) => e.action === "create").map(entryShape)
    );
    const plannedDeletes = new Set(
      (diff.pipelineHooks ?? []).filter((e) => e.action === "delete").map(entryShape)
    );

    expect(
      [...created].sort(),
      "every hook the apply CREATED must have been a create line in the reviewed plan"
    ).toEqual([...plannedCreates].sort());
    expect(
      [...removed].sort(),
      "every hook the apply REMOVED must have been a delete line in the reviewed plan"
    ).toEqual([...plannedDeletes].sort());
  };

  /** A stack with one service and component, plus the hooks. See docs/coordination-as-code.md §34. */
  const buildStack = (stackName: string, hooks?: ManifestPipelineHook[]): DesiredStateManifest => {
    const stack = new Stack(stackName);
    const service = new Service(stack, "svc", { name: "Svc" });
    new Component(stack, "api", { name: "api", service });
    const manifest = stack.synth();
    return hooks === undefined ? manifest : { ...manifest, pipelineHooks: hooks };
  };

  const componentUrnOf = (stackName: string) => `urn:scp:${stackName}:component:api`;

  // (1) WIRING — the plan SHOWING a create and the apply PERFORMING one are two claims

  describe("(1) a manifest declaring hooks CREATES them, and re-applying is a no-op", () => {
    it("all four kinds land as rows the gate can read, and the second apply says noop and touches nothing", async () => {
      const stackName = `stack-${randomUUID().slice(0, 8)}`;
      const componentUrn = componentUrnOf(stackName);
      const hooks: ManifestPipelineHook[] = [
        { kind: "postMerge", componentUrn, hookId: "unit", workflow: workflow("wf/unit.yaml") },
        {
          kind: "postDeploy",
          componentUrn,
          hookId: "integration",
          workflow: workflow("wf/integration.yaml"),
          stage: "prod"
        },
        {
          kind: "continuous",
          componentUrn,
          hookId: "probe",
          workflow: workflow("wf/probe.yaml"),
          everySeconds: 300,
          maxAgeSeconds: 900
        },
        { kind: "bakeAlarms", componentUrn, hookId: "bake", quietWindowSeconds: 600 }
      ];

      // The manifest really does carry the collection and the plan really does say `create` four
      // times, so a failure below is about the APPLY and not about the diff.
      const manifest = buildStack(stackName, hooks);
      const plan = await admin.plans.create(manifest);
      expect(actions(plan.diff)).toEqual({
        "postMerge/unit": "create",
        "postDeploy/integration": "create",
        "continuous/probe": "create",
        "bakeAlarms/bake": "create"
      });
      await admin.plans.apply(plan.id);

      // THE ROWS, field for field — the per-kind columns are what the verdict functions read, so a
      // create that dropped `maxAgeSeconds` would leave a probe whose stale-green never holds.
      const live = await hooksOf(componentUrn);
      expect(live).toEqual([
        {
          kind: "bakeAlarms",
          hookId: "bake",
          workflow: null,
          stage: null,
          everySeconds: null,
          maxAgeSeconds: null,
          quietWindowSeconds: 600
        },
        {
          kind: "continuous",
          hookId: "probe",
          workflow: workflow("wf/probe.yaml"),
          stage: null,
          everySeconds: 300,
          maxAgeSeconds: 900,
          quietWindowSeconds: null
        },
        {
          kind: "postDeploy",
          hookId: "integration",
          workflow: workflow("wf/integration.yaml"),
          stage: "prod",
          everySeconds: null,
          maxAgeSeconds: null,
          quietWindowSeconds: null
        },
        {
          kind: "postMerge",
          hookId: "unit",
          workflow: workflow("wf/unit.yaml"),
          stage: null,
          everySeconds: null,
          maxAgeSeconds: null,
          quietWindowSeconds: null
        }
      ]);
      assertPlanExplainsTransition(plan.diff, [], live);

      // IDEMPOTENCE, which for `scp apply` is the ORDINARY case rather than an edge case. A
      // normalization bug — an absent `stage` read back as `null` keying differently from an
      // omitted one — shows up here as a perpetual delete-plus-create, which is a gate that
      // flickers off on every apply.
      const again = await admin.plans.create(buildStack(stackName, hooks));
      expect(actions(again.diff)).toEqual({
        "postMerge/unit": "noop",
        "postDeploy/integration": "noop",
        "continuous/probe": "noop",
        "bakeAlarms/bake": "noop"
      });
      expect(again.diff.summary.deletes).toBe(0);
      await admin.plans.apply(again.id);
      expect(await hooksOf(componentUrn)).toEqual(live);
      assertPlanExplainsTransition(again.diff, live, await hooksOf(componentUrn));
    });
  });

  // (2) THE MEMBER QUESTION — a PRESENT collection is authoritative over its own members

  describe("(2) removing ONE entry from a PRESENT collection prunes THAT hook", () => {
    it("dropping B from [A, B] plans a visible delete line, removes B, and leaves A armed", async () => {
      const stackName = `stack-${randomUUID().slice(0, 8)}`;
      const componentUrn = componentUrnOf(stackName);
      const a: ManifestPipelineHook = {
        kind: "postDeploy",
        componentUrn,
        hookId: "a",
        workflow: workflow("wf/a.yaml")
      };
      const b: ManifestPipelineHook = {
        kind: "postDeploy",
        componentUrn,
        hookId: "b",
        workflow: workflow("wf/b.yaml")
      };

      await applyLatest(buildStack(stackName, [a, b]));
      const before = await hooksOf(componentUrn);
      expect(before.map((h) => h.hookId)).toEqual(["a", "b"]);

      const prune = await admin.plans.create(buildStack(stackName, [a]));
      expect(actions(prune.diff)).toEqual({
        "postDeploy/a": "noop",
        "postDeploy/b": "delete"
      });
      // The delete LINE, not just the count — a prune the operator cannot read is a prune they
      // cannot check, and the whole reason this collection diverges is that a disarmed gate
      // announces itself only by an absence.
      expect(prune.diff.pipelineHooks?.find((e) => e.action === "delete")?.reason).toContain(
        "DISARMS the gate"
      );
      expect(prune.diff.summary.deletes).toBe(1);
      await admin.plans.apply(prune.id);

      const after = await hooksOf(componentUrn);
      expect(
        after.map((h) => h.hookId),
        "the dropped member's hook must be gone"
      ).toEqual(["a"]);
      assertPlanExplainsTransition(prune.diff, before, after);
    });
  });

  // (3) THE RULING — an absent collection is UNMANAGED, not empty

  describe("(3) an ABSENT pipelineHooks key manages NOTHING", () => {
    it("a stack with STANDING hooks, whose manifest omits the key, plans NO hook entries and every hook survives apply", async () => {
      const stackName = `stack-${randomUUID().slice(0, 8)}`;
      const componentUrn = componentUrnOf(stackName);
      const hooks: ManifestPipelineHook[] = [
        {
          kind: "postDeploy",
          componentUrn,
          hookId: "integration",
          workflow: workflow("wf/integration.yaml")
        },
        { kind: "bakeAlarms", componentUrn, hookId: "bake", quietWindowSeconds: 600 }
      ];

      await applyLatest(buildStack(stackName, hooks));
      const before = await hooksOf(componentUrn);
      expect(before).toHaveLength(2);

      // THE ABSENT-KEY MANIFEST. Nothing else about the stack changed, so every OTHER collection is
      // untouched and the only question this plan asks is what an absent `pipelineHooks` means.
      const omitted = buildStack(stackName);
      expect(omitted).not.toHaveProperty("pipelineHooks");

      const plan = await admin.plans.create(omitted);
      await admin.plans.apply(plan.id);

      // THE SUBSTANTIVE ASSERTION FIRST, deliberately: a "fix the inconsistency" edit that makes
      // absent prune fails HERE, on the GATES BEING GONE, rather than on a shape expectation
      // somebody could read as pedantry and update.
      expect(
        await hooksOf(componentUrn),
        "an absent pipelineHooks key manages nothing — the standing hooks must survive"
      ).toEqual(before);

      // And the shape, which catches the same edit one step earlier and catches a WEAKER version of
      // it (emit `[]`, prune nothing) the assertion above cannot see. NOT "summary.deletes === 0":
      // the key is ABSENT, because an empty array means "this stack manages hooks and has nothing
      // to change" — a different, and here wrong, statement.
      expect(plan.diff.pipelineHooks).toBeUndefined();
      expect(plan.diff.summary.deletes).toBe(0);
    });
  });

  // (4) PRESENT-BUT-EMPTY IS A DELIBERATE STATEMENT — and it is the OPPOSITE of absent

  /** The pair is the whole ruling; neither half means anything. See docs/coordination-as-code.md §35. */
  describe("(4) a PRESENT-but-EMPTY pipelineHooks array prunes EVERY hook on a component this stack owns", () => {
    it('`"pipelineHooks": []` plans a delete for each and removes them all', async () => {
      const stackName = `stack-${randomUUID().slice(0, 8)}`;
      const componentUrn = componentUrnOf(stackName);
      const hooks: ManifestPipelineHook[] = [
        { kind: "postMerge", componentUrn, hookId: "unit", workflow: workflow("wf/unit.yaml") },
        { kind: "bakeAlarms", componentUrn, hookId: "bake", quietWindowSeconds: 600 }
      ];

      await applyLatest(buildStack(stackName, hooks));
      const before = await hooksOf(componentUrn);
      expect(before).toHaveLength(2);

      const emptied = buildStack(stackName, []);
      // The KEY IS PRESENT. That is the difference from (3), and it is the entire difference.
      expect(emptied.pipelineHooks).toEqual([]);

      const plan = await admin.plans.create(emptied);
      expect(actions(plan.diff)).toEqual({
        "postMerge/unit": "delete",
        "bakeAlarms/bake": "delete"
      });
      expect(plan.diff.summary.deletes).toBe(2);
      await admin.plans.apply(plan.id);

      const after = await hooksOf(componentUrn);
      expect(after, "present-and-empty means 'I manage hooks and declare none'").toEqual([]);
      assertPlanExplainsTransition(plan.diff, before, after);
    });
  });

  // (5) IDENTITY — a changed hook is a delete PLUS a create, never a silent in-place edit

  describe("(5) a CHANGED hook is a delete plus a create", () => {
    it("renaming the hookId plans both lines, and the old row is gone while the new one is armed", async () => {
      const stackName = `stack-${randomUUID().slice(0, 8)}`;
      const componentUrn = componentUrnOf(stackName);
      const before_: ManifestPipelineHook = {
        kind: "postDeploy",
        componentUrn,
        hookId: "smoke",
        workflow: workflow("wf/smoke.yaml")
      };
      const after_: ManifestPipelineHook = { ...before_, hookId: "smoke-v2" };

      await applyLatest(buildStack(stackName, [before_]));
      const live = await hooksOf(componentUrn);
      expect(live.map((h) => h.hookId)).toEqual(["smoke"]);

      const plan = await admin.plans.create(buildStack(stackName, [after_]));
      expect(actions(plan.diff)).toEqual({
        "postDeploy/smoke": "delete",
        "postDeploy/smoke-v2": "create"
      });
      await admin.plans.apply(plan.id);

      const now = await hooksOf(componentUrn);
      expect(now.map((h) => h.hookId)).toEqual(["smoke-v2"]);
      assertPlanExplainsTransition(plan.diff, live, now);
    });

    /** The payload half, which would go silently wrong. See docs/coordination-as-code.md §36. */
    it("narrowing a postDeploy hook's stage plans both lines too — an identity-keyed diff would call it a noop", async () => {
      const stackName = `stack-${randomUUID().slice(0, 8)}`;
      const componentUrn = componentUrnOf(stackName);
      const everyWave: ManifestPipelineHook = {
        kind: "postDeploy",
        componentUrn,
        hookId: "integration",
        workflow: workflow("wf/integration.yaml")
      };
      const prodOnly: ManifestPipelineHook = { ...everyWave, stage: "prod" };

      await applyLatest(buildStack(stackName, [everyWave]));
      const live = await hooksOf(componentUrn);
      expect(live[0]?.stage, "an absent stage is EVERY wave, stored as null").toBeNull();

      const plan = await admin.plans.create(buildStack(stackName, [prodOnly]));
      const entries = plan.diff.pipelineHooks ?? [];
      expect(entries.map((e) => e.action).sort()).toEqual(["create", "delete"]);
      expect(entries.find((e) => e.action === "delete")?.stage).toBeNull();
      expect(entries.find((e) => e.action === "create")?.stage).toBe("prod");
      await admin.plans.apply(plan.id);

      const now = await hooksOf(componentUrn);
      expect(now.map((h) => h.stage)).toEqual(["prod"]);
      assertPlanExplainsTransition(plan.diff, live, now);
    });
  });

  // (6) OWNERSHIP AND AUTHORITY — a stack may not configure a component it does not own

  describe("(6) a hook on a component this stack does not own is REFUSED", () => {
    it("declaring one against another stack's component fails plan-compute 400, and writes nothing", async () => {
      const ownerStack = `stack-${randomUUID().slice(0, 8)}`;
      const otherStack = `stack-${randomUUID().slice(0, 8)}`;
      await applyLatest(buildStack(ownerStack));
      const foreignUrn = componentUrnOf(ownerStack);

      // The other stack owns its OWN component; what refuses this is that the hook names a
      // component belonging to a stack this manifest never declares. Without the refusal the row
      // would be invisible to the declaring stack's prune pool forever, and the OWNER's next apply
      // would disarm a gate it never armed.
      const manifest = buildStack(otherStack, [
        {
          kind: "postDeploy",
          componentUrn: foreignUrn,
          hookId: "sneaky",
          workflow: workflow("wf/sneaky.yaml")
        }
      ]);
      await expect(admin.plans.create(manifest)).rejects.toMatchObject({ status: 400 });
      expect(await hooksOf(foreignUrn)).toEqual([]);
    });

    /** THE AUTHORITY PAIR, and the two cases are one pair on purpose. See docs/coordination-as-code.md §37. */
    describe("(b) the apply authorizes object:write at the OWNING COMPONENT", () => {
      let viewer: ScpClient;
      let stackName: string;

      beforeAll(async () => {
        stackName = `stack-${randomUUID().slice(0, 8)}`;
        // The ADMIN establishes the objects, so the Viewer's plans are all-noop on every OTHER
        // collection and the hook is the only thing left to authorize.
        await applyLatest(buildStack(stackName));
        const user = await createTestUser(server, org, [{ role: "Viewer", scope: org.orgId }]);
        viewer = new ScpClient({ baseUrl: server.baseUrl, token: user.token });
      });

      it("(a) the Viewer applies the SAME stack with NO hooks — every entry is a noop, so nothing is demanded", async () => {
        const plan = await viewer.plans.create(buildStack(stackName));
        expect(plan.diff.summary.creates).toBe(0);
        expect(plan.diff.summary.updates).toBe(0);
        expect(plan.diff.summary.deletes).toBe(0);
        const { plan: applied } = await viewer.plans.apply(plan.id);
        expect(applied.status).toBe("applied");
      });

      it("(b) …and the SAME Viewer is REFUSED the same stack WITH a hook — arming a gate is a write at the component", async () => {
        const componentUrn = componentUrnOf(stackName);
        const plan = await viewer.plans.create(
          buildStack(stackName, [
            {
              kind: "postDeploy",
              componentUrn,
              hookId: "unauthorized",
              workflow: workflow("wf/unauthorized.yaml")
            }
          ])
        );
        // The PLAN is fine — computing a diff writes nothing, and the authority is per-apply.
        expect(actions(plan.diff)).toEqual({ "postDeploy/unauthorized": "create" });

        await expect(viewer.plans.apply(plan.id)).rejects.toMatchObject({ status: 403 });

        // THE SUBSTANTIVE ASSERTION: no gate was armed. A 403 that let the row through anyway
        // would be a refusal nobody is protected by.
        expect(await hooksOf(componentUrn)).toEqual([]);
      });

      /** The disarm direction, as a separate case. See docs/coordination-as-code.md §38. */
      it("(c) …and is REFUSED a plan that PRUNES one — the authority covers deletes, not just creates", async () => {
        const componentUrn = componentUrnOf(stackName);
        const standing: ManifestPipelineHook = {
          kind: "postDeploy",
          componentUrn,
          hookId: "standing",
          workflow: workflow("wf/standing.yaml")
        };
        // The ADMIN arms the gate — the Viewer never had the authority to arm it, so the prune it
        // attempts below is a prune of somebody else's standing enforcement.
        await applyLatest(buildStack(stackName, [standing]));
        expect((await hooksOf(componentUrn)).map((h) => h.hookId)).toEqual(["standing"]);

        const plan = await viewer.plans.create(buildStack(stackName, []));
        expect(actions(plan.diff)).toEqual({ "postDeploy/standing": "delete" });

        await expect(viewer.plans.apply(plan.id)).rejects.toMatchObject({ status: 403 });

        expect(
          (await hooksOf(componentUrn)).map((h) => h.hookId),
          "a refused apply must leave the standing gate armed"
        ).toEqual(["standing"]);
      });
    });
  });
});
