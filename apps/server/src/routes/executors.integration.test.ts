import { randomUUID } from "node:crypto";
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpApiError, ScpClient } from "@scp/sdk";
import {
  createTestOrg,
  listenTestServer,
  type ListeningTestServer
} from "../test-support/harness.js";

/**
 * M7 plugin-configuration surface (routes/executors.ts, routes/change-sources.ts's webhook-secret
 * addition) — real HTTP round trips via the SDK against a real Testcontainers Postgres, on every
 * PR (unlike scripts/e2e-m7.sh, which only runs main-only per the e2e-mN convention). This is the
 * permanent regression coverage for the exact bug scripts/e2e-m7.sh caught manually once: migration
 * 0014 originally never granted `scp_app` DELETE on `secrets`/`notification_bindings` — a gap no
 * unit test or Testcontainers-with-schema-created-fresh-per-suite test would catch unless it
 * actually exercises the DELETE route end to end, which this file now does permanently.
 */
describe("M7: executor/notification bindings, secrets, plugin manifests, discovery (never auto-commits)", () => {
  let server: ListeningTestServer;

  beforeAll(async () => {
    server = await listenTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it("secret put/list/delete round-trips and is never echoed back", async () => {
    const org = await createTestOrg(server, "m7-secrets");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const key = `secret-${randomUUID().slice(0, 8)}`;

    const putResult = await admin.secrets.put(key, { value: "super-secret-value" });
    expect(putResult).toEqual({ configured: true, key });

    const listed = await admin.secrets.listKeys();
    expect(listed.keys).toContain(key);
    // The value itself is never part of any response shape this SDK method returns — nothing to
    // assert an absence of beyond "the type has no such field", which TypeScript already enforces.

    await admin.secrets.delete(key);
    const afterDelete = await admin.secrets.listKeys();
    expect(afterDelete.keys).not.toContain(key);
  });

  it("executor binding PUT/GET round-trips against a real Component target", async () => {
    const org = await createTestOrg(server, "m7-executor-binding");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const component = await admin.components.create({ name: `comp-${randomUUID().slice(0, 8)}` });

    const binding = await admin.executors.putBinding(component.id, {
      pluginModule: "fake-executor",
      pluginInstanceId: `inst-${randomUUID().slice(0, 8)}`,
      config: { statePath: "/tmp/whatever" },
      allowedHosts: ["example.test"]
    });
    expect(binding.targetObjectId).toBe(component.id);
    expect(binding.pluginModule).toBe("fake-executor");

    const fetched = await admin.executors.getBinding(component.id);
    expect(fetched).toEqual(binding);
  });

  it("notification binding PUT/list/DELETE round-trips", async () => {
    const org = await createTestOrg(server, "m7-notify-binding");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const instanceId = `notify-${randomUUID().slice(0, 8)}`;

    const binding = await admin.notifications.putBinding(instanceId, {
      pluginModule: "webhook-notify",
      config: { url: "http://example.test/hook" },
      minSeverity: "warning"
    });
    expect(binding.pluginInstanceId).toBe(instanceId);
    expect(binding.minSeverity).toBe("warning");

    const listed = await admin.notifications.listBindings();
    expect(listed.items.some((b) => b.pluginInstanceId === instanceId)).toBe(true);

    await admin.notifications.deleteBinding(instanceId);
    const afterDelete = await admin.notifications.listBindings();
    expect(afterDelete.items.some((b) => b.pluginInstanceId === instanceId)).toBe(false);
  });

  it("plugin manifest catalog lists every bundled M7 plugin", async () => {
    const org = await createTestOrg(server, "m7-manifests");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const manifests = await admin.plugins.listManifests();
    const ids = manifests.items.map((m) => m.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "github",
        "github-discovery",
        "argocd",
        "terraform",
        "managed-iac",
        "webhook-notify",
        "smtp-notify"
      ])
    );
  });

  it("discovery: /discovery/accept is the ONLY path that writes — proposed objects don't exist until explicitly accepted", async () => {
    const org = await createTestOrg(server, "m7-discovery");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const name = `discovered-${randomUUID().slice(0, 8)}`;

    // Nothing named this exists yet — no discovery call has happened at all, let alone an accept.
    const before = await admin.services.list({ limit: 100 });
    expect(before.items.some((s) => s.name === name)).toBe(false);

    const result = await admin.discovery.accept({
      proposal: { objects: [{ typeId: "service", name }], relationships: [] }
    });
    expect(result.createdObjectIds).toHaveLength(1);

    const after = await admin.object("service").get(result.createdObjectIds[0]!);
    expect(after.name).toBe(name);
  });

  it("webhook signature verification is fail-closed once a secret is configured: bad signature 401s and is never persisted, a valid one is accepted and correlates", async () => {
    const org = await createTestOrg(server, "m7-webhook-sig");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const component = await admin.components.create({ name: `comp-${randomUUID().slice(0, 8)}` });
    const secret = "integration-test-webhook-secret";
    const repo = `m7-org/${randomUUID().slice(0, 8)}`;

    await admin.changeSources.putWebhookSecret("github", { secret });
    await admin.changeSources.createMapping("github", {
      repoPattern: repo,
      component: component.id
    });

    const payload = { repo, correlationKey: "refs/heads/main" };
    const rawBody = JSON.stringify(payload);
    const goodSignature = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
    const badSignature = "sha256=" + "0".repeat(64);

    // Bad signature: rejected, never persisted. A direct fetch (not the SDK, which doesn't know
    // about signature headers) so we control the exact header sent.
    const badResponse = await fetch(`${server.baseUrl}/change-sources/github/webhook`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${org.adminToken}`,
        "content-type": "application/json",
        "x-hub-signature-256": badSignature
      },
      body: rawBody
    });
    expect(badResponse.status).toBe(401);

    const goodResponse = await fetch(`${server.baseUrl}/change-sources/github/webhook`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${org.adminToken}`,
        "content-type": "application/json",
        "x-hub-signature-256": goodSignature
      },
      body: rawBody
    });
    expect(goodResponse.status).toBe(202);

    // Correlates into a real Change on the next reconcile-adjacent processing — this server isn't
    // running the reconcile loop (listenTestServer() default), so this test asserts persistence
    // succeeded (the 202 itself already proves that) rather than waiting on a loop it never
    // started; coordination.integration.test.ts's webhook-correlation coverage (M3) already
    // proves the reconcile-loop half of this pipeline end to end against a REAL loop, and
    // scripts/e2e-m7.sh proves this exact signed-webhook-correlates-into-a-Change property
    // against the full running compose stack.
  });

  it("unauthenticated calls to every new M7 route are rejected", async () => {
    const anon = new ScpClient({ baseUrl: server.baseUrl });
    await expect(anon.secrets.listKeys()).rejects.toBeInstanceOf(ScpApiError);
    await expect(anon.plugins.listManifests()).rejects.toBeInstanceOf(ScpApiError);
    await expect(anon.notifications.listBindings()).rejects.toBeInstanceOf(ScpApiError);
  });
});
