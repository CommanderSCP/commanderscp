import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpApiError, ScpClient } from "@scp/sdk";
import {
  createTestOrg,
  createTestUser,
  listenTestServer,
  waitUntil,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { changes, changeWaveTargets, decisions } from "../db/schema.js";

/**
 * THE M15.6 REGION GATE'S MATCH KEY IS NO LONGER WRITABLE BY ITS OWN SUBJECT.
 *
 * `coordination/region-membership-guard.ts` has the full write-up; this file is the proof that the
 * guard RUNS, at real doors, against a real subject — the distinction a unit test cannot make and
 * that this project's dominant defect (a component built, unit-tested green, never installed) turns
 * on. Every refusal below is driven by `owner`, a user holding the built-in Operator role bound AT
 * THE TARGET OBJECT ONLY — `object:write` on the target it owns, and no binding at the org root.
 *
 * MEASURED BEFORE THE FIX (the same three doors, same harness, guard absent):
 *
 *   control: declared `{environment, region}`, unbound  -> `no_executor`, parked, 1 block Decision
 *   V1: PATCH `properties: {environment}`               -> `triggered` on `fake-executor`, 0 blocks
 *   V2: PATCH `properties: {}`                          -> `triggered` on `fake-executor`, 0 blocks
 *   V3: DELETE the target after the change is proposed  -> `triggered` on `fake-executor`, 0 blocks
 *
 * MUTATION LOG — each applied ALONE against a green suite, the run recorded, then reverted:
 *
 *   | # | mutation                                                        | cases that died                 |
 *   |---|-----------------------------------------------------------------|---------------------------------|
 *   | 1 | delete `assertMayUndeclareRegionMembership` from `updateObject`  | V1, V2, TYPED-PUT               |
 *   | 2 | delete it from `deleteObject`                                    | V3                              |
 *   | 3 | swap `before`/`after` at the `updateObject` call site            | V1, V2, TYPED-PUT, DECLARE-IS-FREE |
 *   | 4 | delete the `typeId !== "deployment-target"` early return         | SCOPE-GUARD (non-target)        |
 *
 * Two of these are the point rather than bookkeeping. **#1 does not kill V3 and #2 does** — the
 * measured proof that `deleteObject` runs the refusal for itself rather than inheriting a choke
 * point it never passes through; removing the ROW withdraws the target just as surely as blanking
 * the property, and it is a different function. **#3 kills DECLARE-IS-FREE**, which is the control
 * that the asymmetry is real: a delta read backwards makes ADDING a region declaration the
 * privileged act and leaves REMOVING one free — the defect, inverted, and V3 stays green throughout
 * so the suite would still look 10/11 healthy.
 *
 * RE-VERIFIED AFTER THE REBASE ONTO #249, which installs a containment-reach recorder in the SAME
 * two functions. Two things now share `deleteObject`, so "my case is green" stopped being evidence
 * that MY hook is the reason — and the two mutations below say which is which, each run alone on
 * the rebased tree:
 *
 *   | mutation                                     | died                          | stayed green        |
 *   |----------------------------------------------|-------------------------------|---------------------|
 *   | remove THIS guard from `deleteObject`        | V3, and V3 alone              | #249's 9 CASEs      |
 *   | neuter #249's route-3 reach capture          | #249's CASE 4, and it alone   | all 11 cases here   |
 *
 * Neither guard is carrying the other. The refusal is ordered FIRST in `deleteObject` so a rejected
 * un-declaration pays no containment walk; see the call site for why that ordering is free to make.
 */
describe("M15.6: un-declaring a region is an authority act, not a field edit", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer({
      withEventRelay: true,
      withReconcileLoop: true,
      pluginHostOptions: {
        callTimeoutMs: 8_000,
        restartBackoffBaseMs: 50,
        maxRestartBackoffMs: 300
      }
    });
    org = await createTestOrg(server, "m15-6-undeclare");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  }, 120_000);

  afterAll(async () => {
    await server?.close();
  });

  const env = `prod-undeclare-${randomUUID().slice(0, 6)}`;

  async function createRegionTarget(region: string, environment = env) {
    return admin.object("deployment-target").create({
      name: `${environment}-${region}-${randomUUID().slice(0, 8)}`,
      properties: { environment, region }
    });
  }

  /** A client for the target's OWN OWNER: Operator (`object:write`) bound at the target, and
   *  nothing at the org root. This is the permission the evasion was available at. */
  async function ownerOf(targetId: string): Promise<ScpClient> {
    const user = await createTestUser(server, org, [{ role: "Operator", scope: targetId }]);
    return new ScpClient({ baseUrl: server.baseUrl, token: user.token });
  }

  async function refusalFrom(action: Promise<unknown>): Promise<ScpApiError> {
    const err = await action.then(
      () => null,
      (e: unknown) => e
    );
    if (!(err instanceof ScpApiError)) {
      throw new Error(`expected an ScpApiError refusal, got: ${String(err)}`);
    }
    return err;
  }

  async function waveTargetRow(targetId: string) {
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(changeWaveTargets)
        .where(
          and(
            eq(changeWaveTargets.orgId, org.orgId),
            eq(changeWaveTargets.targetObjectId, targetId)
          )
        )
        .limit(1)
    );
    return rows[0];
  }

  const changeRow = async (changeId: string) => {
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(changes).where(eq(changes.objectId, changeId))
    );
    return rows[0]!;
  };

  const blockDecisionsFor = async (changeId: string) =>
    (
      await withTenantTx(server.deps.db, org.orgId, (tx) =>
        tx.select().from(decisions).where(eq(decisions.subjectId, changeId))
      )
    ).filter((d) => d.verdict === "block");

  /** Propose a change at `targetId`, drive it through the REAL reconcile loop, and report how the
   *  wave target terminalized — refused by the gate, or dispatched against an executor. */
  async function driveAndObserve(targetId: string, label: string) {
    const change = await admin.changes.propose({ name: label, targets: [targetId] });
    const row = await waitUntil(
      async () => {
        const r = await waveTargetRow(targetId);
        return r && (r.status === "no_executor" || r.executorPluginId) ? r : undefined;
      },
      { describe: `${label}: wave target terminalized`, timeoutMs: 30_000 }
    );
    return {
      status: row.status,
      executorPluginId: row.executorPluginId,
      parked: (await changeRow(change.id)).reconcileBlockedAt !== null,
      blockDecisions: await blockDecisionsFor(change.id)
    };
  }

  beforeAll(async () => {
    // A bound sibling region, so `env` is a genuinely multi-region prod environment.
    const apacSys = await admin.object("execution-system").create({
      name: `argocd-apac-${randomUUID().slice(0, 8)}`,
      properties: { kind: "fake-executor", serverUrl: "https://apac.argocd.example" }
    });
    const apac = await createRegionTarget("apac");
    await admin.executors.putBinding(apac.id, { executionSystemId: apacSys.id });
  }, 60_000);

  // The control: the constraint being evaded is real and fires.

  it("CONTROL: a declared, unbound region target is refused — the gate this guard protects fires", async () => {
    const amer = await createRegionTarget("amer");
    const observed = await driveAndObserve(amer.id, "control");

    expect(observed.status).toBe("no_executor");
    expect(observed.executorPluginId).toBeNull();
    expect(observed.parked).toBe(true);
    expect(observed.blockDecisions).toHaveLength(1);
    expect(observed.blockDecisions[0]!.inputContext).toMatchObject({
      environment: env,
      region: "amer",
      gate: "regional_argocd_silent_deploy"
    });
  }, 90_000);

  // The three measured evasion vectors, each at a real door, each as the target's own owner.

  it("V1: the owner cannot remove 'properties.region' — and the gate still fires afterwards", async () => {
    const target = await createRegionTarget("emea");
    const owner = await ownerOf(target.id);

    const err = await refusalFrom(
      owner.object("deployment-target").update(target.id, { properties: { environment: env } })
    );
    expect(err.status).toBe(403);
    expect(err.problem?.detail).toContain("no-silent-deploy gate");
    expect(err.problem?.detail).toContain("'properties.region'");

    // The row still declares the region — the refusal is not cosmetic.
    expect((await admin.object("deployment-target").get(target.id)).properties).toMatchObject({
      environment: env,
      region: "emea"
    });

    // END TO END: the escape is closed where it mattered — the gate still refuses the deploy.
    const observed = await driveAndObserve(target.id, "v1");
    expect(observed.status).toBe("no_executor");
    expect(observed.blockDecisions).toHaveLength(1);
  }, 90_000);

  it("V2: the owner cannot clear BOTH properties (a full-replacement PUT that omits them)", async () => {
    const target = await createRegionTarget("latam");
    const owner = await ownerOf(target.id);

    const err = await refusalFrom(
      owner.object("deployment-target").update(target.id, { properties: {} })
    );
    expect(err.status).toBe(403);
    expect(err.problem?.detail).toContain("'properties.environment'");
    expect(err.problem?.detail).toContain("'properties.region'");

    const observed = await driveAndObserve(target.id, "v2");
    expect(observed.status).toBe("no_executor");
  }, 90_000);

  it("V3: the owner cannot DELETE a declared region target (removing the row withdraws it too)", async () => {
    const target = await createRegionTarget("afri");
    const owner = await ownerOf(target.id);

    const err = await refusalFrom(owner.object("deployment-target").delete(target.id));
    expect(err.status).toBe(403);
    expect(err.problem?.detail).toContain("deleting deployment-target");

    expect((await admin.object("deployment-target").get(target.id)).deletedAt).toBeNull();
  }, 60_000);

  it("TYPED-PUT: the same refusal at the typed upsert door, which reaches updateObject without the generic route", async () => {
    const target = await createRegionTarget("oce");
    const stored = await admin.object("deployment-target").get(target.id);
    const owner = await ownerOf(target.id);

    // `PUT /deployment-targets/:urn` -> `upsertObjectByUrn` -> `updateObject`. A full replacement
    // that names the environment but not the region is the identical withdrawal by another door —
    // which is why the guard is at the repo choke point and not on the generic route's handler.
    const err = await refusalFrom(
      owner.deploymentTargets.upsertByUrn(stored.urn, {
        name: stored.name,
        properties: { environment: env }
      })
    );
    expect(err.status).toBe(403);
  }, 60_000);

  // The guard must not over-fire — these are the controls that fail if the namespace is too wide.

  it("DECLARE-IS-FREE: the owner may ADD a region declaration (a declaration only ever adds constraint)", async () => {
    const plain = await admin.object("deployment-target").create({
      name: `plain-declare-${randomUUID().slice(0, 8)}`,
      properties: {}
    });
    const owner = await ownerOf(plain.id);

    const updated = await owner
      .object("deployment-target")
      .update(plain.id, { properties: { environment: env, region: "arctic" } });
    expect(updated.properties).toMatchObject({ environment: env, region: "arctic" });
  }, 60_000);

  it("RENAME-IS-FREE: the owner may re-label the region — it stays a declared region target", async () => {
    const target = await createRegionTarget("nordics");
    const owner = await ownerOf(target.id);

    const updated = await owner
      .object("deployment-target")
      .update(target.id, { properties: { environment: env, region: "nordics-2" } });
    expect(updated.properties).toMatchObject({ region: "nordics-2" });

    // Still governed — renaming did not buy an escape.
    const observed = await driveAndObserve(target.id, "rename");
    expect(observed.status).toBe("no_executor");
  }, 90_000);

  it("PATCH-WITHOUT-PROPERTIES: an update that never mentions properties withdraws nothing", async () => {
    const target = await createRegionTarget("iberia");
    const owner = await ownerOf(target.id);

    const renamed = await owner
      .object("deployment-target")
      .update(target.id, { name: `renamed-${randomUUID().slice(0, 8)}` });
    expect(renamed.properties).toMatchObject({ environment: env, region: "iberia" });
  }, 60_000);

  it("SCOPE-GUARD: a plain (non-region) target is untouched — its owner may still edit and delete it", async () => {
    const plain = await admin.object("deployment-target").create({
      name: `plain-${randomUUID().slice(0, 8)}`,
      properties: { note: "no environment, no region" }
    });
    const owner = await ownerOf(plain.id);

    await owner.object("deployment-target").update(plain.id, { properties: {} });
    const deleted = await owner.object("deployment-target").delete(plain.id);
    expect(deleted.deletedAt).not.toBeNull();
  }, 60_000);

  it("SCOPE-GUARD: a NON-deployment-target carrying the same two properties is untouched", async () => {
    const svc = await admin.object("service").create({
      name: `svc-${randomUUID().slice(0, 8)}`,
      properties: { environment: env, region: "amer" }
    });
    const owner = await ownerOf(svc.id);

    const updated = await owner.object("service").update(svc.id, { properties: {} });
    expect(updated.properties).toEqual({});
  }, 60_000);

  // -------------------------------------------------------------------------------------------
  // The escape hatch: this is a permission bar, not a wall. Decommissioning a region stays possible
  // for an actor holding the org-root bar the M15.6 read surface itself takes.
  // -------------------------------------------------------------------------------------------

  it("AUTHORIZED: an org-root 'object:write' holder MAY un-declare a region, and the target then leaves the gate's scope", async () => {
    const target = await createRegionTarget("decom");

    // The bootstrap admin holds Owner at the org root — the bar `getRegionalExecutors` reads at.
    const updated = await admin
      .object("deployment-target")
      .update(target.id, { properties: { environment: env } });
    expect(updated.properties).toEqual({ environment: env });

    // Genuinely decommissioned: the gate no longer claims it, so it falls back to case (a) — the
    // pre-existing intended-fake behaviour for an unbound plain target. This is the behaviour the
    // refusals above were withholding from the SUBJECT, not removing from the system.
    const observed = await driveAndObserve(target.id, "authorized-decom");
    expect(observed.executorPluginId).toBe("fake-executor");
    expect(observed.blockDecisions).toHaveLength(0);
  }, 90_000);
});
