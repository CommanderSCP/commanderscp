import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { ScpClient } from "@scp/sdk";
import { withTenantTx } from "../db/tenant-tx.js";
import { changeSourceEvents, changes, objects } from "../db/schema.js";
import { processChangeSourceEvents } from "./webhook-processor.js";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/** Harbor as a webhook change-source, end to end. See docs/coordination.md §544. */
describe("harbor webhook-source: a PUSH_ARTIFACT correlates end-to-end into a Change carrying the image digest", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "harbor-webhook");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  it("a Bearer-PAT-authed Harbor PUSH_ARTIFACT (no signature header) proposes a Change correlated to the mapped component with sourceRef.artifact_digest set", async () => {
    const component = await createTestComponent(admin, {
      name: `harbor-comp-${randomUUID().slice(0, 8)}`
    });
    const repo = `acme/${randomUUID().slice(0, 8)}`;
    const digest = "sha256:" + "ab".repeat(32);

    // Bind the Harbor repo (project/repo) to the component. NO webhook secret is configured for
    // harbor — the push authenticates by its Bearer PAT alone (the documented Harbor Auth Header
    // model), so createMapping is the ONLY setup needed on the SCP side.
    await admin.changeSources.createMapping("harbor", {
      repoPattern: repo,
      component: component.id
    });

    // A realistic Harbor PUSH_ARTIFACT delivery. Event type is in the BODY (`type`), not a header —
    // and there is NO signature header (harbor is Bearer-PAT authed). A direct fetch (not the SDK)
    // so we control exactly the headers Harbor would actually send.
    const payload = {
      type: "PUSH_ARTIFACT",
      occur_at: 1_700_000_000,
      operator: "robot$ci",
      event_data: {
        resources: [{ digest, tag: "v1.4.2", resource_url: `harbor.example.com/${repo}:v1.4.2` }],
        repository: {
          name: repo.split("/")[1],
          namespace: repo.split("/")[0],
          repo_full_name: repo,
          repo_type: "private"
        }
      }
    };

    const response = await fetch(`${server.baseUrl}/change-sources/harbor/webhook`, {
      method: "POST",
      headers: {
        // The Harbor "Auth Header" model: Bearer <scoped SCP PAT>. No x-*-signature header exists.
        authorization: `Bearer ${org.adminToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    expect(response.status).toBe(202);
    const { eventId } = (await response.json()) as { accepted: boolean; eventId: string };

    // Run the reconcile-tick processor (this test server isn't running the loop — same technique as
    // the other coordination processing tests).
    await withTenantTx(server.deps.db, org.orgId, (tx) => processChangeSourceEvents(tx, org.orgId));

    const eventRow = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(changeSourceEvents).where(eq(changeSourceEvents.id, eventId))
    );
    expect(eventRow[0]!.processedAt).not.toBeNull();
    const changeObjectId = eventRow[0]!.resultingChangeObjectId;
    expect(changeObjectId).not.toBeNull();

    // The Change TARGETS the mapped component (correlation on repo succeeded)...
    const objectRow = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(objects).where(eq(objects.id, changeObjectId!))
    );
    const props = objectRow[0]!.properties as { targets?: string[] };
    expect(props.targets).toContain(component.id);

    // ...and carries the pushed image digest in sourceRef.artifact_digest (the M17.1 scan-gate hook).
    const changeRow = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(changes).where(eq(changes.objectId, changeObjectId!))
    );
    expect(changeRow[0]!.sourceKind).toBe("harbor");
    const sourceRef = changeRow[0]!.sourceRef as { artifact_digest?: string; type?: string };
    expect(sourceRef.artifact_digest).toBe(digest);
    // The raw payload is preserved verbatim alongside the lifted digest.
    expect(sourceRef.type).toBe("PUSH_ARTIFACT");
  });

  it("a non-mappable Harbor event (SCANNING_COMPLETED) is ingested but proposes NO Change — its scan-gate feed is a deferred M17.1 follow-on, not silently mis-mapped", async () => {
    const component = await createTestComponent(admin, {
      name: `harbor-scan-${randomUUID().slice(0, 8)}`
    });
    const repo = `acme/${randomUUID().slice(0, 8)}`;
    const digest = "sha256:" + "ef".repeat(32);
    await admin.changeSources.createMapping("harbor", {
      repoPattern: repo,
      component: component.id
    });

    const payload = {
      type: "SCANNING_COMPLETED",
      event_data: {
        repository: { repo_full_name: repo },
        resources: [{ digest, tag: "v1.4.2" }],
        scan_overview: {}
      }
    };
    const response = await fetch(`${server.baseUrl}/change-sources/harbor/webhook`, {
      method: "POST",
      headers: { authorization: `Bearer ${org.adminToken}`, "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    expect(response.status).toBe(202);
    const { eventId } = (await response.json()) as { eventId: string };

    await withTenantTx(server.deps.db, org.orgId, (tx) => processChangeSourceEvents(tx, org.orgId));

    // Ingested + marked processed (persist-then-process), but NO Change proposed: SCANNING_COMPLETED
    // maps to null, so there's nothing to correlate. The event is not stuck; it's cleanly ignored.
    const eventRow = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(changeSourceEvents).where(eq(changeSourceEvents.id, eventId))
    );
    expect(eventRow[0]!.processedAt).not.toBeNull();
    expect(eventRow[0]!.resultingChangeObjectId).toBeNull();
  });
});
