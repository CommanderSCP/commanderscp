import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { ScpClient } from "@scp/sdk";
import { withTenantTx } from "../db/tenant-tx.js";
import { syncJournal } from "../db/schema.js";
import {
  createOrphanComponent,
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * EXECUTOR-BINDING LIFECYCLE AUDIT EVENTS (2026-08-25 gap) — PUT/DELETE (and, found by the same
 * census, PATCH-repurpose) wrote NO audit event at all before this. The only executor-ish audit
 * action ever written was `change.wave_target.no_executor`, a READ-time observation that a stage
 * has no binding, never a record of a binding itself CHANGING. `executor-bindings-repo.ts` is the
 * one function every binding write funnels through (the typed routes below, `iac/plans-repo.ts`'s
 * apply-time create/update/prune, and `POST /discovery/accept`'s binding import) — the audit call
 * lives THERE, not duplicated at each call site, so this file exercises it through the routes and
 * trusts the single shared implementation for the non-route doors (a coverage note in
 * `executor-bindings-repo.ts`'s module comments).
 *
 * `component-merge-repo.ts`'s `repointExecutorBindingTarget` — the FOURTH binding-identity write
 * door — used to be left deliberately unaudited on the premise that the merge that reaches it wrote
 * no audit event of its own either, so auditing the repoint alone would look like partial coverage.
 * That premise was false (`mergeComponents` already writes `component.delete` for the loser via
 * `deleteObject`, plus a `transition` Decision for the merge itself) and is now corrected; the
 * repoint is audited too (`executor.binding.repoint`) — see the merge describe block below.
 *
 * `reason` is asserted to carry the Type and plugin module, and NEVER the config/secretRefs payload
 * a binding may carry (charter: audit rows are read by humans and must not become a secrets leak).
 *
 * ALSO EXERCISED HERE: `subjectDomainLocal` (ADR-0031 S2 / M20.2) on every one of these events — a
 * domain-local target's binding lifecycle must write the LOCAL audit row same as any other, but
 * withhold the `audit_segment` journal entry that would otherwise carry its id to a peer. Checked
 * directly against `sync_journal` (single-domain — the withholding happens at `appendAuditEvent`,
 * before export ever runs, so a real cross-domain round trip would only be re-proving M20.2's own
 * test, not this gap).
 */
describe("executor-binding lifecycle audit events", () => {
  let server: ListeningTestServer;

  beforeAll(async () => {
    server = await listenTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it("PUT binding writes exactly one executor.binding.put event, naming the target/type/plugin — never config", async () => {
    const org = await createTestOrg(server, "binding-audit-put");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const component = await createTestComponent(admin, {
      name: `comp-${randomUUID().slice(0, 8)}`
    });

    // `autoSucceedAfterMs: 200` is real, tenant-facing `config` (`fake-executor`'s manifest
    // schema — its `additionalProperties: false` refuses an arbitrary key, so this is the honest
    // way to plant a config VALUE and prove it stays out of the audit row, rather than a field the
    // plugin would never accept in the first place).
    const binding = await admin.executors.putBinding(component.id, {
      pluginModule: "fake-executor",
      pluginInstanceId: `inst-${randomUUID().slice(0, 8)}`,
      config: { autoSucceedAfterMs: 200 }
    });

    const page = await admin.auditEvents.list({ limit: 200 });
    const events = page.items.filter((e) => e.action === "executor.binding.put");
    expect(events).toHaveLength(1);
    expect(events[0]!.subjectId).toBe(component.id);
    expect(events[0]!.reason).toContain(binding.type);
    expect(events[0]!.reason).toContain("fake-executor");
    expect(events[0]!.reason).not.toContain("autoSucceedAfterMs");
    expect(events[0]!.reason).not.toContain("200");
    expect(events[0]!.decisionId).toBeNull();
  });

  it("a repeat PUT (update) writes a SECOND executor.binding.put event — the write happened again", async () => {
    const org = await createTestOrg(server, "binding-audit-put-update");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const component = await createTestComponent(admin, {
      name: `comp-${randomUUID().slice(0, 8)}`
    });
    await admin.executors.putBinding(component.id, {
      pluginModule: "fake-executor",
      pluginInstanceId: `inst-a-${randomUUID().slice(0, 8)}`
    });
    await admin.executors.putBinding(component.id, {
      pluginModule: "fake-executor",
      pluginInstanceId: `inst-b-${randomUUID().slice(0, 8)}`
    });

    const page = await admin.auditEvents.list({ limit: 200 });
    const events = page.items.filter(
      (e) => e.action === "executor.binding.put" && e.subjectId === component.id
    );
    expect(events).toHaveLength(2);
  });

  it("DELETE binding writes exactly one executor.binding.delete event", async () => {
    const org = await createTestOrg(server, "binding-audit-delete");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const component = await createTestComponent(admin, {
      name: `comp-${randomUUID().slice(0, 8)}`
    });
    await admin.executors.putBinding(component.id, {
      pluginModule: "fake-executor",
      pluginInstanceId: `inst-${randomUUID().slice(0, 8)}`
    });

    const deleted = await admin.executors.deleteBinding(component.id);

    const page = await admin.auditEvents.list({ limit: 200 });
    const events = page.items.filter((e) => e.action === "executor.binding.delete");
    expect(events).toHaveLength(1);
    expect(events[0]!.subjectId).toBe(component.id);
    expect(events[0]!.reason).toContain(deleted.type);
    expect(events[0]!.reason).toContain("fake-executor");
  });

  it("a delete that finds nothing (404) writes NO audit event — there is no row to name", async () => {
    const org = await createTestOrg(server, "binding-audit-delete-404");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const component = await createTestComponent(admin, {
      name: `comp-${randomUUID().slice(0, 8)}`
    });

    await expect(admin.executors.deleteBinding(component.id)).rejects.toBeTruthy();

    const page = await admin.auditEvents.list({ limit: 200 });
    const events = page.items.filter(
      (e) => e.action === "executor.binding.delete" && e.subjectId === component.id
    );
    expect(events).toHaveLength(0);
  });

  it("PATCH (repurpose) writes exactly one executor.binding.retype event — the third binding write door this census found", async () => {
    const org = await createTestOrg(server, "binding-audit-retype");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const component = await createTestComponent(admin, {
      name: `comp-${randomUUID().slice(0, 8)}`
    });
    await admin.executors.putBinding(component.id, {
      pluginModule: "fake-executor",
      pluginInstanceId: `inst-${randomUUID().slice(0, 8)}`
    });

    await admin.executors.repurposeBinding(component.id, "infrastructure");

    const page = await admin.auditEvents.list({ limit: 200 });
    const events = page.items.filter((e) => e.action === "executor.binding.retype");
    expect(events).toHaveLength(1);
    expect(events[0]!.subjectId).toBe(component.id);
    expect(events[0]!.reason).toContain("configuration");
    expect(events[0]!.reason).toContain("infrastructure");
    expect(events[0]!.reason).toContain("fake-executor");
  });

  it("an idempotent same-type PATCH no-op writes NO event — nothing changed", async () => {
    const org = await createTestOrg(server, "binding-audit-retype-noop");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const component = await createTestComponent(admin, {
      name: `comp-${randomUUID().slice(0, 8)}`
    });
    await admin.executors.putBinding(component.id, {
      pluginModule: "fake-executor",
      pluginInstanceId: `inst-${randomUUID().slice(0, 8)}`
    });

    await admin.executors.repurposeBinding(component.id, "configuration", "configuration");

    const page = await admin.auditEvents.list({ limit: 200 });
    const events = page.items.filter((e) => e.action === "executor.binding.retype");
    expect(events).toHaveLength(0);
  });

  // THE FOURTH-DOOR CASE IS GONE WITH ITS DOOR (ADR-0047). It proved that `discovery/accept`'s
  // binding import wrote `executor.binding.put` like every other binding-identity write — the point
  // being that the audit call lives in `executor-bindings-repo.ts`, not at each call site. That
  // shared implementation is unchanged and still exercised by the route cases here; one fewer
  // caller does not weaken it.

  /** Every `audit_segment` journal row whose payload names `subjectId` AND an `executor.binding.*`
   *  action — the withholding check has to read the PAYLOAD, not just count rows, since an
   *  unrelated audit_segment naming the SAME subject (the component's own `component.create`,
   *  which journals ahead of any binding write) would otherwise inflate a "shared" control's count
   *  and make it indistinguishable from a real leak. */
  async function auditSegmentJournalRowsNaming(org: TestOrg, subjectId: string) {
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ entryKind: syncJournal.entryKind, payload: syncJournal.payload })
        .from(syncJournal)
        .where(eq(syncJournal.orgId, org.orgId))
    );
    return rows.filter((r) => {
      if (r.entryKind !== "audit_segment") return false;
      const payload = r.payload as { subjectId?: unknown; action?: unknown };
      return (
        payload.subjectId === subjectId &&
        typeof payload.action === "string" &&
        payload.action.startsWith("executor.binding.")
      );
    });
  }

  it("a domainLocal component's binding put+delete write audit events but withhold their audit_segment from the sync journal", async () => {
    const org = await createTestOrg(server, "binding-audit-domainlocal");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const component = await createTestComponent(admin, {
      name: `comp-local-${randomUUID().slice(0, 8)}`,
      domainLocal: true
    });
    expect(component.domainLocal).toBe(true);

    await admin.executors.putBinding(component.id, {
      pluginModule: "fake-executor",
      pluginInstanceId: `inst-${randomUUID().slice(0, 8)}`
    });
    await admin.executors.deleteBinding(component.id);

    // The LOCAL audit trail is complete either way — locality withholds what LEAVES, not what this
    // domain records about itself.
    const page = await admin.auditEvents.list({ limit: 200 });
    expect(
      page.items.filter((e) => e.action === "executor.binding.put" && e.subjectId === component.id)
    ).toHaveLength(1);
    expect(
      page.items.filter(
        (e) => e.action === "executor.binding.delete" && e.subjectId === component.id
      )
    ).toHaveLength(1);

    // But NEITHER wrote an audit_segment journal entry naming the domain-local component's id.
    expect(await auditSegmentJournalRowsNaming(org, component.id)).toHaveLength(0);
  });

  it("a SHARED (non-domainLocal) component's binding put+delete DO journal their audit_segment — the negative control", async () => {
    const org = await createTestOrg(server, "binding-audit-shared-control");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const component = await createTestComponent(admin, {
      name: `comp-shared-${randomUUID().slice(0, 8)}`
    });
    expect(component.domainLocal).toBe(false);

    await admin.executors.putBinding(component.id, {
      pluginModule: "fake-executor",
      pluginInstanceId: `inst-${randomUUID().slice(0, 8)}`
    });
    await admin.executors.deleteBinding(component.id);

    // Proves the withholding test above is not merely "nothing ever journals" — a shared subject's
    // two binding events both cross into the journal, same as any other audited mutation of it.
    expect(await auditSegmentJournalRowsNaming(org, component.id)).toHaveLength(2);
  });
});

describe("executor-binding lifecycle audit events: component merge's repoint (the fourth door)", () => {
  let server: ListeningTestServer;

  beforeAll(async () => {
    server = await listenTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it("merging a component that carries a binding writes exactly one executor.binding.repoint event, named onto the SURVIVOR", async () => {
    const org = await createTestOrg(server, "binding-audit-merge-repoint");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    // ORPHAN, not `createTestComponent` — `mergeComponents` requires a binding-only loser with no
    // live relationships, and `createTestComponent` gives it a `contains` edge from a throwaway
    // service (`components.integration.test.ts`'s own merge describe block uses the same helper).
    const survivor = await createOrphanComponent(server, org, `surv-${randomUUID().slice(0, 8)}`);
    const loser = await createOrphanComponent(server, org, `lose-${randomUUID().slice(0, 8)}`);
    await admin.executors.putBinding(loser.id, {
      pluginModule: "fake-executor",
      pluginInstanceId: `inst-${randomUUID().slice(0, 8)}`
    });

    const result = await admin.components.merge(survivor.id, loser.id);
    expect(result.movedBindingTypes).toEqual(["configuration"]);

    const page = await admin.auditEvents.list({ limit: 200 });
    const events = page.items.filter((e) => e.action === "executor.binding.repoint");
    expect(events).toHaveLength(1);
    expect(events[0]!.subjectId).toBe(survivor.id);
    expect(events[0]!.reason).toContain("fake-executor");
    expect(events[0]!.reason).toContain("configuration");
  });
});
