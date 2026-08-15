import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpApiError, ScpClient } from "@scp/sdk";
import {
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * THE ROUTE-1 ORPHAN GUARD (objects-repo.ts::deleteObject, measured incident 2026-08-13).
 *
 * Deleting a domain whose live children name it via `objects.domain_id` used to succeed — and
 * every such child then 403'd on UPDATE and DELETE forever (org-root admin included), because the
 * authz scope expansion joins parents on `deleted_at IS NULL` and a `domain_id` chain has exactly
 * one upward path: the tombstone dead-ends it. Two API calls to permanent, admin-proof garbage.
 *
 * The guard refuses the delete with the blockers NAMED. Route 2 (`contains` edges) keeps its
 * pre-existing CASCADE semantics — that difference is deliberate (an edge can be tombstoned with
 * its object; a column cannot without silently re-parenting the children), and the control test
 * below pins it so this guard cannot quietly widen into refusing ordinary container deletes.
 */
describe("domain delete orphan guard (route-1 containment)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  const uniq = (p: string) => `${p}-${randomUUID().slice(0, 8)}`;

  /** The RFC-9457 `detail` off a rejected call — `ScpApiError.message` carries only the TITLE
   *  ("Conflict"), so asserting refusal COPY means reading `problem.detail`. */
  async function refusalDetail(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
    } catch (e) {
      if (e instanceof ScpApiError) return String(e.problem?.detail ?? e.message);
      return String(e);
    }
    throw new Error("expected the call to be refused, but it succeeded");
  }

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "orphan-guard");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  }, 120_000);

  afterAll(async () => {
    await server?.close();
  });

  it("refuses deleting a domain with a live domain_id child, naming the child", async () => {
    const parent = await admin.object("domain").create({ name: uniq("guard-parent") });
    const child = await admin
      .object("domain")
      .create({ name: uniq("guard-child"), domainId: parent.id });

    const detail = await refusalDetail(admin.object("domain").delete(parent.id));
    // The blocker is NAMED (the child's urn carries its name) …
    expect(detail).toContain("guard-child");
    // … and the refusal says WHY — the orphaning consequence, not just "Conflict".
    expect(detail).toContain("orphan");
    expect(detail).toContain("domain_id");

    // The load-bearing half of the incident: the child must REMAIN administrable after the
    // refused delete — this is the exact write that 403'd forever before the guard.
    const updated = await admin
      .object("domain")
      .update(child.id, { labels: { touched: "yes" } });
    expect(updated.labels.touched).toBe("yes");
  });

  it("allows the delete once the children are gone — the guard names blockers, not a ban", async () => {
    const parent = await admin.object("domain").create({ name: uniq("clear-parent") });
    const child = await admin
      .object("domain")
      .create({ name: uniq("clear-child"), domainId: parent.id });

    const detail = await refusalDetail(admin.object("domain").delete(parent.id));
    expect(detail).toContain("still name it");
    await admin.object("domain").delete(child.id);
    const gone = await admin.object("domain").delete(parent.id);
    expect(gone.id).toBe(parent.id);
  });

  it("CONTROL: route-2 (contains) children still CASCADE — deleting a service with components succeeds", async () => {
    // Pins that the guard did not widen: `contains` children have deliberate cascade semantics
    // (the edge dies with the object, reader-side filter as backstop), and a service delete with
    // live components was legal before this guard and must remain so. If this test starts
    // failing, the guard grew past route 1 — that would need its own decision, not a drive-by.
    const service = await admin.services.create({ name: uniq("cascade-svc") });
    const component = await admin.components.create({
      name: uniq("cascade-comp"),
      service: service.id
    });
    const deleted = await admin.services.delete(service.id);
    expect(deleted.id).toBe(service.id);
    // And the component stays administrable — its domain_id never pointed at the service.
    const touched = await admin.components.update(component.id, { labels: { ok: "1" } });
    expect(touched.labels.ok).toBe("1");
  });
});
