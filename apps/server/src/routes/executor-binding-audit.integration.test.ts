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

/** EXECUTOR-BINDING LIFECYCLE AUDIT EVENTS. See docs/routes.md §159. */
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

  // THE FOURTH-DOOR CASE IS GONE WITH ITS DOOR. See docs/routes.md §160.

  /** Every journal row whose payload names both of those. See docs/routes.md §161. */
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
