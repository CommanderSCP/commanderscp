import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer
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
 * `executor-bindings-repo.ts`'s module comments; `component-merge-repo.ts`'s `repointExecutorBindingTarget`
 * is the one write door left deliberately unaudited, and says why beside it).
 *
 * `reason` is asserted to carry the Type and plugin module, and NEVER the config/secretRefs payload
 * a binding may carry (charter: audit rows are read by humans and must not become a secrets leak).
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

  it("discovery accept's bindings import writes executor.binding.put too — the fourth door this census found (M12 P3b)", async () => {
    const org = await createTestOrg(server, "binding-audit-discovery-accept");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    await admin.secrets.put("sys-token", { value: "t" });
    const sys = await admin.object("execution-system").create({
      name: `sys-${randomUUID().slice(0, 8)}`,
      properties: {
        kind: "fake-executor",
        serverUrl: "https://argocd.x",
        tokenSecretKey: "sys-token"
      }
    });
    const appName = `imported-app-${randomUUID().slice(0, 8)}`;

    const result = await admin.discovery.accept({
      proposal: {
        objects: [
          { typeId: "component", name: appName, properties: { argocdApplication: appName } }
        ],
        relationships: [],
        bindings: [{ objectName: appName, executionSystemId: sys.id, externalRef: appName }]
      }
    });

    const page = await admin.auditEvents.list({ limit: 200 });
    const events = page.items.filter(
      (e) => e.action === "executor.binding.put" && e.subjectId === result.createdObjectIds[0]
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.reason).toContain("fake-executor");
  });
});
