import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { ScpClient, type ScpApiError } from "@scp/sdk";
import { asTrustDomainId, type ExecutorType, type GraphObject } from "@scp/schemas";
import {
  createTestOrg,
  listenTestServer,
  waitUntil,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { createObject } from "../graph/objects-repo.js";
import { createRelationship } from "../graph/relationships-repo.js";

/**
 * M16.3 P2 (REMEASURED) — WHAT THE SERVER ACTUALLY REFUSES ON A FOREIGN-ORIGIN OBJECT.
 *
 * THE DEFECT THIS FILE EXISTS TO PREVENT: the first cut of `apps/web/src/lib/replica-origin.tsx`
 * disabled a set of UI write controls on the grounds — stated only in a source comment, never
 * measured — that "the server refuses this write on a read-only replica regardless." For half of
 * those controls that claim was simply FALSE: `routes/executors.ts`'s DELETE/PATCH/PUT
 * `/executors/:idOrUrn/binding` authorize `object:write` on the target and never look at the
 * target's `originDomainId` at all (`executor_bindings` has no `origin_domain_id` column —
 * `db/schema.ts` — because a binding is per-org, per-target LOCAL config, not federation-replicated
 * state). Disabling those controls broke the documented multi-region workflow (DESIGN.md §12.6,
 * BUILD_AND_TEST.md M15.6: "a region is a deployment-target ... its per-region Argo CD is an
 * ordinary per-region executor binding") — an outpost binding its OWN local Argo CD to a target
 * that is commander-origin from the outpost's point of view is exactly the intended case.
 *
 * So: this file MEASURES each write the SPA offers against a genuinely foreign-origin object and
 * pins the ACTUAL response. Every `disabled`/`title` gate that survives in
 * `apps/web/src/lib/replica-origin.tsx` and its callers cites a test HERE by name; a gate with no
 * test here is a gate that must not exist.
 *
 * PR #152 REVIEW FIX (E1): the change-lifecycle block below originally only measured accept/
 * rollback against a foreign-origin change sitting in `proposed` — a state neither verb is even
 * legal from (both answer the ordinary wrong-state 409 there, so the arms were indistinguishable
 * from a broken fixture). `validating` is the ONE state `change-detail.tsx`'s `ACCEPTABLE_STATES`
 * (line 42) offers Accept for, and the state the shipped enable-decision actually depends on — so
 * the suite is now extended with a real reconcile loop (`withReconcileLoop`/`withEventRelay` below)
 * to drive a foreign-origin change all the way to `validating` and measure accept/rollback
 * SUCCEEDING there, not merely refusing identically. See "accept SUCCEEDS ... from 'validating'"
 * and "rollback SUCCEEDS ... from 'validating'" near the end of this file.
 *
 * HOW "GENUINELY FOREIGN" IS BUILT: `createObject`/`createRelationship` with a `federationImport`
 * context — the exact, and only, code path `federation/import-repo.ts` uses to land a peer's row
 * after signature/chain verification (`graph/objects-repo.ts`'s `FederationImportContext` doc:
 * "the ONLY way createObject/updateObject/deleteObject will accept/preserve a foreign
 * originDomainId"). The resulting rows are byte-identical to what a real inbound bundle produces,
 * so the guards under test see exactly the production condition.
 */
describe("M16.3 P2 remeasured: which writes the server refuses on a FOREIGN-ORIGIN object", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  /** A domain id that is emphatically NOT this instance's own `federation_self.domain_id`. */
  const FOREIGN = asTrustDomainId(randomUUID());

  beforeAll(async () => {
    // withEventRelay + withReconcileLoop: the `validating` state is only reachable via the real
    // reconcile loop (coordination/reconcile.ts) driving a change through its wave targets against
    // the default fake-executor — see "accept/rollback SUCCEEDS ... from 'validating'" below.
    server = await listenTestServer({
      withEventRelay: true,
      withReconcileLoop: true,
      pluginHostOptions: { callTimeoutMs: 8_000, restartBackoffBaseMs: 50, maxRestartBackoffMs: 300 }
    });
    org = await createTestOrg(server, "foreign-origin-writes");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  /** A replica of another domain's object: same shape a verified inbound bundle lands. */
  async function foreignObject(typeId: string, label: string): Promise<GraphObject> {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      createObject(tx, {
        orgId: org.orgId,
        typeId,
        actorObjectId: org.orgId,
        requestId: `foreign-${label}`,
        name: `${label}-${randomUUID().slice(0, 8)}`,
        properties: {},
        federationImport: { originDomainId: FOREIGN, revision: 1 }
      })
    );
  }

  /** A locally-originated object of the same type, for the control arm of each measurement. */
  async function localObject(typeId: string, label: string): Promise<GraphObject> {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      createObject(tx, {
        orgId: org.orgId,
        typeId,
        actorObjectId: org.orgId,
        requestId: `local-${label}`,
        name: `${label}-${randomUUID().slice(0, 8)}`,
        properties: {}
      })
    );
  }

  const putBinding = (targetId: string, type: ExecutorType) =>
    admin.executors.putBinding(targetId, {
      pluginModule: "fake-executor",
      pluginInstanceId: `inst-${randomUUID().slice(0, 8)}`,
      config: { statePath: "/tmp/x" },
      allowedHosts: [],
      type
    });

  // ---------------------------------------------------------------------------------------------
  // POSITIVE CONTROLS — the fixture really is foreign, and the single-writer guard really does bite
  // where it exists (`graph/objects-repo.ts`'s updateObject/deleteObject). Without these two, every
  // "the server allowed it" result below would be indistinguishable from a broken fixture.
  // ---------------------------------------------------------------------------------------------

  it("CONTROL: updating a foreign-origin object 409s (single-writer authority is real and reachable)", async () => {
    const foreign = await foreignObject("component", "control-update");
    await expect(admin.components.update(foreign.id, { name: "renamed" })).rejects.toMatchObject({
      status: 409
    });
    const self = await admin.federation.self();
    expect((await admin.components.get(foreign.id)).originDomainId).not.toBe(self.domainId);
  });

  it("CONTROL: deleting a foreign-origin object 409s", async () => {
    const foreign = await foreignObject("component", "control-delete");
    await expect(admin.components.delete(foreign.id)).rejects.toMatchObject({ status: 409 });
  });

  // ---------------------------------------------------------------------------------------------
  // EXECUTOR BINDINGS — `registry-detail.tsx`'s TargetBindingsCard (Detach / Repurpose) and
  // `plugins.tsx`'s bind form. MEASURED RESULT: the server ACCEPTS all three on a foreign-origin
  // target. A binding is local operational config keyed by (org, target, type); it carries no
  // origin domain and is never federation-replicated, so single-writer authority has nothing to say
  // about it. THIS IS THE MULTI-REGION WORKFLOW (DESIGN.md §12.6) — the UI must not disable these.
  // ---------------------------------------------------------------------------------------------

  it("PUT /executors/:id/binding SUCCEEDS on a foreign-origin target (multi-region: bind a LOCAL executor to commander-origin config)", async () => {
    const foreign = await foreignObject("deployment-target", "bind-put");
    const binding = await putBinding(foreign.id, "configuration");
    expect(binding.type).toBe("configuration");
    expect(await admin.executors.listBindings(foreign.id)).toHaveLength(1);
  });

  it("DELETE /executors/:id/binding (Detach) SUCCEEDS on a foreign-origin target", async () => {
    const foreign = await foreignObject("deployment-target", "bind-detach");
    await putBinding(foreign.id, "configuration");

    const removed = await admin.executors.deleteBinding(foreign.id, "configuration");
    expect(removed.type).toBe("configuration");
    expect(await admin.executors.listBindings(foreign.id)).toHaveLength(0);
  });

  it("PATCH /executors/:id/binding (Repurpose) SUCCEEDS on a foreign-origin target", async () => {
    const foreign = await foreignObject("deployment-target", "bind-repurpose");
    await putBinding(foreign.id, "configuration");

    const relabelled = await admin.executors.repurposeBinding(foreign.id, "infrastructure");
    expect(relabelled.type).toBe("infrastructure");
  });

  // ---------------------------------------------------------------------------------------------
  // COMPONENT MERGE — `registry-detail.tsx`'s MergeComponentCard. MEASURED RESULT: the SURVIVOR's
  // origin is irrelevant (the only writes against it are `repointExecutorBindingTarget`, an
  // unguarded UPDATE of `executor_bindings.target_object_id`); the LOSER's origin is decisive
  // (`mergeComponents` soft-deletes it via `deleteObject`, which IS single-writer guarded).
  // ---------------------------------------------------------------------------------------------

  it("merge SUCCEEDS when the SURVIVOR is foreign-origin (its bindings are local config, not replicated state)", async () => {
    const survivor = await foreignObject("component", "merge-survivor-foreign");
    const loser = await localObject("component", "merge-loser-local");
    await putBinding(loser.id, "configuration");

    const result = await admin.components.merge(survivor.id, loser.id);
    expect(result.movedBindingTypes).toEqual(["configuration"]);
    expect(await admin.executors.listBindings(survivor.id)).toHaveLength(1);
  });

  it("merge 409s when the LOSER is foreign-origin (deleteObject's single-writer guard) — THE ONE MERGE GATE THAT IS REAL", async () => {
    const survivor = await localObject("component", "merge-survivor-local");
    const loser = await foreignObject("component", "merge-loser-foreign");

    await expect(admin.components.merge(survivor.id, loser.id)).rejects.toMatchObject({
      status: 409
    });
  });

  // ---------------------------------------------------------------------------------------------
  // COMPONENT -> SERVICE — `registry-detail.tsx`'s ComponentServiceCard (Assign / Move). MEASURED
  // RESULT: what decides the outcome is the ORIGIN OF THE `contains` EDGE BEING DELETED, never the
  // origin of the component or of either service. ASSIGN (no existing edge) is a pure
  // `createRelationship`, which stamps THIS domain as the edge's author and never consults the
  // endpoints' origins — it succeeds on a foreign-origin component.
  // ---------------------------------------------------------------------------------------------

  it("ASSIGN (component has no service yet) SUCCEEDS even when the COMPONENT is foreign-origin", async () => {
    const component = await foreignObject("component", "assign-foreign-comp");
    const service = await localObject("service", "assign-target-svc");

    const updated = await admin.components.setService(component.id, service.id);
    expect(updated.id).toBe(component.id);
  });

  it("MOVE across a LOCALLY-originated contains edge SUCCEEDS even when the COMPONENT is foreign-origin", async () => {
    const component = await foreignObject("component", "move-foreign-comp");
    const from = await localObject("service", "move-from-svc");
    const to = await localObject("service", "move-to-svc");
    await admin.components.setService(component.id, from.id); // creates a LOCAL-origin edge

    const updated = await admin.components.setService(component.id, to.id);
    expect(updated.id).toBe(component.id);
  });

  it("MOVE across a FOREIGN-ORIGIN contains edge 409s — the edge, not the component, is what the server guards", async () => {
    const component = await localObject("component", "move-local-comp");
    const from = await localObject("service", "move-fedfrom-svc");
    const to = await localObject("service", "move-fedto-svc");
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      createRelationship(tx, {
        orgId: org.orgId,
        actorObjectId: org.orgId,
        requestId: "foreign-contains",
        typeId: "contains",
        fromId: from.id,
        toId: component.id,
        federationImport: { originDomainId: FOREIGN, revision: 1 }
      })
    );

    await expect(admin.components.setService(component.id, to.id)).rejects.toMatchObject({
      status: 409
    });
  });

  // ---------------------------------------------------------------------------------------------
  // CHANGE LIFECYCLE — `change-detail.tsx`'s Accept / Rollback / Cancel. A `Change` has no live
  // federation path that produces a foreign `originDomainId` today (`import-repo.ts` never creates
  // a local `changes` state-machine row for a synced change object, and `promotion-repo.ts` calls
  // `proposeChange` FRESH so control genuinely transfers) — so the fixture below flips the change
  // object's `origin_domain_id` directly, which is the exact row state a future replication path
  // would produce. MEASURED RESULT: the transition verbs write the `changes` state-machine row and
  // never route through `updateObject`, so they are NOT refused. The UI gate is therefore reporting
  // an enforcement that does not exist.
  //
  // STATE COVERAGE (E1 fix): `cancel`/`accept`/`rollback` below run their FIRST measurement against
  // a change in `proposed` — legal for cancel, but `accept` and `rollback` are not legal from
  // `proposed` at all (transitions.ts), so both arms of those two tests are the ordinary wrong-
  // state refusal and never observe an accept/rollback SUCCEEDING. `validating` is the only state
  // `change-detail.tsx`'s `ACCEPTABLE_STATES` (line 42) offers Accept for, so it is the state the
  // shipped enable-decision actually depends on. The two tests after `outcomeOf`'s definition drive
  // a foreign-origin change to `validating` via the real reconcile loop and assert accept/rollback
  // SUCCEED there — the measurement this suite was missing.
  // ---------------------------------------------------------------------------------------------

  /** Proposes a change in the ordinary way; `foreign` additionally makes its graph object
   *  authoritatively owned by another domain. */
  async function proposeChange(label: string, opts: { foreign: boolean }): Promise<string> {
    const service = await localObject("service", `chg-svc-${label}`);
    const component = await localObject("component", `chg-comp-${label}`);
    await admin.components.setService(component.id, service.id);
    const change = await admin.changes.propose({ name: `${label}-change`, targets: [component.id] });
    if (!opts.foreign) return change.id;

    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.execute(
        sql`update objects set origin_domain_id = ${FOREIGN} where id = ${change.id} and org_id = ${org.orgId}`
      )
    );
    expect((await admin.changes.get(change.id)).originDomainId).toBe(FOREIGN);
    return change.id;
  }

  /** Runs `attempt` and reports what the server actually answered. */
  async function outcomeOf(
    attempt: Promise<unknown>
  ): Promise<{ ok: boolean; status?: number; title?: string; detail?: string }> {
    try {
      await attempt;
      return { ok: true };
    } catch (err) {
      const e = err as ScpApiError;
      return { ok: false, status: e.status, title: e.problem?.title, detail: e.problem?.detail };
    }
  }

  it("cancel SUCCEEDS on a foreign-origin change — the transition verbs carry no single-writer guard", async () => {
    const changeId = await proposeChange("cancel", { foreign: true });
    const cancelled = await admin.changes.cancel(changeId, "measuring");
    expect(cancelled.state).toBe("cancelled");
  });

  it("accept answers a foreign-origin change IDENTICALLY to a local one in the same state — origin plays no part", async () => {
    const local = await outcomeOf(admin.changes.accept(await proposeChange("accept-local", { foreign: false })));
    const foreign = await outcomeOf(admin.changes.accept(await proposeChange("accept-foreign", { foreign: true })));

    expect(foreign.status).toBe(local.status);
    expect(foreign.title).toBe(local.title);
    // Both are the ordinary state-machine refusal, never a single-writer one.
    expect(`${foreign.title ?? ""} ${foreign.detail ?? ""}`).not.toContain("read-only replica");
  });

  it("rollback answers a foreign-origin change IDENTICALLY to a local one in the same state — origin plays no part", async () => {
    const local = await outcomeOf(
      admin.changes.rollback(await proposeChange("rollback-local", { foreign: false }), "measuring")
    );
    const foreign = await outcomeOf(
      admin.changes.rollback(await proposeChange("rollback-foreign", { foreign: true }), "measuring")
    );

    expect(foreign.status).toBe(local.status);
    expect(foreign.title).toBe(local.title);
    expect(`${foreign.title ?? ""} ${foreign.detail ?? ""}`).not.toContain("read-only replica");
  });

  // -------------------------------------------------------------------------------------------
  // E1 FIX — THE STATE THAT MATTERS. Drives a foreign-origin change all the way to `validating`
  // (the real reconcile loop, the default fake-executor instance — see `coupling.integration.
  // test.ts`'s "a change with no requires goes straight to validating" for the same pattern) and
  // measures accept/rollback SUCCEEDING there, not merely refusing identically. This is what pins
  // the shipped decision to leave `change-detail.tsx`'s Accept control ENABLED: a future server-
  // side origin guard on the accept/rollback path would turn THESE two red, where the `proposed`-
  // state tests above would not (both their arms are already 409s regardless of any such guard).
  // -------------------------------------------------------------------------------------------

  async function proposeForeignChangeAtValidating(label: string): Promise<string> {
    const changeId = await proposeChange(label, { foreign: true });
    await waitUntil(async () => (await admin.changes.get(changeId)).state === "validating" || undefined, {
      describe: `change ${changeId} reaches 'validating'`,
      timeoutMs: 20_000
    });
    // Re-confirm the flip survived the reconcile loop's own writes to this row.
    expect((await admin.changes.get(changeId)).originDomainId).toBe(FOREIGN);
    return changeId;
  }

  it("accept SUCCEEDS on a foreign-origin change once it reaches 'validating' — the state change-detail.tsx's Accept control is actually live for", async () => {
    const changeId = await proposeForeignChangeAtValidating("accept-validating");

    const accepted = await admin.changes.accept(changeId);

    expect(accepted.state).toBe("accepted");
  });

  it("rollback SUCCEEDS on a foreign-origin change once it reaches 'validating'", async () => {
    const changeId = await proposeForeignChangeAtValidating("rollback-validating");

    // `POST /changes/:id/rollback` returns the NEW rollback Change it creates (rollback.ts:
    // "creates and returns a NEW Change"), starting at `proposed` — it is not the original change
    // mutated in place. The rollback change then auto-progresses with no human gate
    // (reconcile.ts's `completeExecution`: "rollback changes need no human acceptance gate"),
    // which is what drives the ORIGINAL foreign-origin change to `rolled_back` in the same
    // transaction once the rollback change's own plan finishes.
    const rollbackChange = await admin.changes.rollback(changeId, "measuring");
    expect(rollbackChange.rollbackOfObjectId).toBe(changeId);

    const original = await waitUntil(
      async () => (await admin.changes.get(changeId)).state === "rolled_back" || undefined,
      { describe: `change ${changeId} reaches 'rolled_back'`, timeoutMs: 20_000 }
    );
    expect(original).toBe(true);
  });
});
