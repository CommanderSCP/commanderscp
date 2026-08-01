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
  // would produce.
  //
  // S10 (`tracked-security-followups`'s "CHANGE TRANSITIONS BYPASS THE SINGLE-WRITER GUARD"):
  // MEASURED RESULT NOW FLIPPED. `coordination/transition.ts`'s `transitionChange` and
  // `coordination/rollback.ts`'s `triggerRollback` — the ONLY writers of `changes.state` and the
  // only initiators of a rollback — now check `enforceLocalChangeAuthority` FIRST, before any
  // state-machine/gate logic, keyed on the change object's `originDomainId` (never
  // `importedFromDomain` — see that function's doc comment). Every operator-initiated verb below
  // is refused with a 409 + `decision_id` on a foreign-origin change, in EVERY state, including
  // `proposed` where the un-guarded state machine would otherwise have refused for an unrelated
  // reason (illegal edge) — the authority check masks that reason now, which is itself part of
  // what the tests below pin.
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
  async function outcomeOf(attempt: Promise<unknown>): Promise<{
    ok: boolean;
    status?: number;
    title?: string;
    detail?: string;
    decisionId?: string;
  }> {
    try {
      await attempt;
      return { ok: true };
    } catch (err) {
      const e = err as ScpApiError;
      return {
        ok: false,
        status: e.status,
        title: e.problem?.title,
        detail: e.problem?.detail,
        decisionId: e.problem?.decision_id
      };
    }
  }

  it("cancel is REFUSED on a foreign-origin change — single-writer authority, with a decision_id", async () => {
    const changeId = await proposeChange("cancel", { foreign: true });
    const outcome = await outcomeOf(admin.changes.cancel(changeId, "measuring"));
    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe(409);
    expect(outcome.detail).toContain("authoritatively owned");
    expect(outcome.decisionId).toBeTruthy();
    // Never transitioned — still sitting exactly where it was proposed.
    expect((await admin.changes.get(changeId)).state).toBe("proposed");
  });

  it("accept is REFUSED on a foreign-origin change with the single-writer reason — the LOCAL control still gets the ordinary state-machine refusal", async () => {
    const local = await outcomeOf(admin.changes.accept(await proposeChange("accept-local", { foreign: false })));
    const foreign = await outcomeOf(admin.changes.accept(await proposeChange("accept-foreign", { foreign: true })));

    // Local: both changes sit in 'proposed', where accept is illegal regardless — the ordinary
    // state-machine refusal, never mentioning authority.
    expect(local.status).toBe(409);
    expect(local.detail ?? "").not.toContain("authoritatively owned");

    // Foreign: the single-writer guard fires FIRST (before the state-machine check even runs),
    // so the reason is authority, not illegal-edge — and it carries a decision_id (charter
    // principle 6: every blocked response is explainable).
    expect(foreign.status).toBe(409);
    expect(foreign.detail).toContain("authoritatively owned");
    expect(foreign.decisionId).toBeTruthy();
  });

  it("rollback is REFUSED on a foreign-origin change with the single-writer reason — the LOCAL control still succeeds once eligible", async () => {
    // rollback is only legal from executing/validating/accepted — 'proposed' 400s regardless of
    // origin for a local change, so the local control arm here is the ordinary bad-request case,
    // not a 409; what matters is that the FOREIGN arm is refused for authority, not state.
    const foreign = await outcomeOf(
      admin.changes.rollback(await proposeChange("rollback-foreign", { foreign: true }), "measuring")
    );
    expect(foreign.status).toBe(409);
    expect(foreign.detail).toContain("authoritatively owned");
    expect(foreign.decisionId).toBeTruthy();
  });

  // -------------------------------------------------------------------------------------------
  // S10 ENGINE-SIDE SKIP — the reconcile engine (coordination/reconcile.ts) now filters a
  // foreign-origin change out of every advance* candidate batch BEFORE ever attempting a
  // transition, so it SKIPS such a change rather than driving it (and rather than parking/
  // blocking it, which would wedge it in a Decision-flood nothing could ever resolve). Before S10
  // this test drove a foreign-origin change all the way to `validating` via the real reconcile
  // loop and measured accept/rollback SUCCEEDING there — that path no longer exists BY
  // CONSTRUCTION: `advanceProposedChanges` never even attempts the `proposed -> evaluated` edge
  // for it, so it can never leave `proposed` at all.
  // -------------------------------------------------------------------------------------------

  it("a foreign-origin change never leaves 'proposed' — the reconcile engine SKIPS it (no Decision, no park) rather than driving it", async () => {
    const foreignId = await proposeChange("engine-skip-foreign", { foreign: true });
    // Control: the engine is genuinely running and would have driven the foreign change too, if
    // it were going to — a change proposed at the same time, targeting the same kind of object,
    // reaches 'validating' well within this window (coupling.integration.test.ts's "a change with
    // no requires goes straight to validating" exercises the identical no-coupling path).
    const localId = await proposeChange("engine-skip-local-control", { foreign: false });
    await waitUntil(
      async () => (await admin.changes.get(localId)).state === "validating" || undefined,
      {
        describe: `control change ${localId} reaches 'validating'`,
        timeoutMs: 20_000
      }
    );

    // The foreign-origin change was never touched by the engine: state unchanged, and the ONLY
    // Decision on record is `proposeChange`'s own `trigger: "propose"` one — unlike a genuine
    // proposed->evaluated attempt, which would add a SECOND Decision on its very first tick, a
    // skip adds nothing at all (a block/park would also have added one, just a `block`-verdict
    // one instead — this distinguishes "skipped" from either "advanced" or "blocked").
    const foreign = await admin.changes.get(foreignId);
    expect(foreign.state).toBe("proposed");
    expect(foreign.originDomainId).toBe(FOREIGN); // the flip survived untouched
    const decisions = await admin.decisions.list({ subjectId: foreignId, limit: 20 });
    expect(decisions.items).toHaveLength(1);
    expect(decisions.items[0]!.inputContext.trigger).toBe("propose");
  });
});
