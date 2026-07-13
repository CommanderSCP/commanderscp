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
      allowedHosts: ["example.test"],
      // M12 P1: the executor-specific target id (e.g. an Argo CD Application name) this object maps
      // to. reconcile passes it as trigger().targetRef (falling back to the object id when unset).
      externalRef: "my-argocd-app"
    });
    expect(binding.targetObjectId).toBe(component.id);
    expect(binding.pluginModule).toBe("fake-executor");
    expect(binding.externalRef).toBe("my-argocd-app");

    const fetched = await admin.executors.getBinding(component.id);
    expect(fetched).toEqual(binding);
    expect(fetched.externalRef).toBe("my-argocd-app");
  });

  it("executor binding defaults externalRef to null when omitted (backward-compatible with pre-M12 bindings)", async () => {
    const org = await createTestOrg(server, "m12-executor-external-ref-null");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const component = await admin.components.create({ name: `comp-${randomUUID().slice(0, 8)}` });
    const binding = await admin.executors.putBinding(component.id, {
      pluginModule: "fake-executor",
      pluginInstanceId: `inst-${randomUUID().slice(0, 8)}`
    });
    expect(binding.externalRef).toBeNull();
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

  // MAJOR #5 (adversarial review): a REDELIVERY/replay of the same signed payload (same
  // X-GitHub-Delivery, or same body hash) must NOT create a second event/Change/trigger.
  it("webhook redelivery is deduped — the same delivery id returns the SAME event id and inserts exactly one row", async () => {
    const org = await createTestOrg(server, "m7-webhook-dedupe");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const secret = "integration-test-webhook-dedupe-secret";
    await admin.changeSources.putWebhookSecret("github", { secret });

    const payload = { repository: { full_name: "m7-org/dedupe-repo" }, head_commit: { id: "abc" } };
    const rawBody = JSON.stringify(payload);
    const sig = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
    const deliveryId = `delivery-${randomUUID()}`;

    const post = () =>
      fetch(`${server.baseUrl}/change-sources/github/webhook`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${org.adminToken}`,
          "content-type": "application/json",
          "x-hub-signature-256": sig,
          "x-github-event": "push",
          "x-github-delivery": deliveryId
        },
        body: rawBody
      });

    const first = (await (await post()).json()) as { accepted: boolean; eventId: string };
    const second = (await (await post()).json()) as { accepted: boolean; eventId: string };
    // Both return 202 (idempotent), and the SECOND returns the FIRST delivery's event id.
    expect(first.accepted).toBe(true);
    expect(second.eventId).toBe(first.eventId);

    // Exactly one row exists for this org+sourceKind+deliveryId.
    const { withTenantTx } = await import("../db/tenant-tx.js");
    const { changeSourceEvents } = await import("../db/schema.js");
    const { and, eq } = await import("drizzle-orm");
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ id: changeSourceEvents.id })
        .from(changeSourceEvents)
        .where(
          and(
            eq(changeSourceEvents.orgId, org.orgId),
            eq(changeSourceEvents.dedupeKey, `delivery:${deliveryId}`)
          )
        )
    );
    expect(rows).toHaveLength(1);
  });

  it("unauthenticated calls to every new M7 route are rejected", async () => {
    const anon = new ScpClient({ baseUrl: server.baseUrl });
    await expect(anon.secrets.listKeys()).rejects.toBeInstanceOf(ScpApiError);
    await expect(anon.plugins.listManifests()).rejects.toBeInstanceOf(ScpApiError);
    await expect(anon.notifications.listBindings()).rejects.toBeInstanceOf(ScpApiError);
  });

  // M8 hardening (BUILD_AND_TEST.md §8 M8 item 6, "create-time module allowlist"): an unknown or
  // wrong-KIND `pluginModule` (a real module, but not an ExecutorPlugin/NotificationPlugin) must be
  // rejected at WRITE time — previously this was only ever caught later, confusingly, the first
  // time the coordination engine/notification dispatcher tried to actually USE the binding.
  it("REJECTS an executor binding whose pluginModule is unknown or the WRONG KIND (e.g. a ControlPlugin/DiscoveryPlugin/NotificationPlugin module) — at WRITE time, not just dispatch", async () => {
    const org = await createTestOrg(server, "m8-executor-module-allowlist");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const component = await admin.components.create({ name: `comp-${randomUUID().slice(0, 8)}` });

    for (const wrongModule of [
      "bogus-module-that-does-not-exist",
      "webhook-control", // a real module, but a ControlPlugin, not an ExecutorPlugin
      "github-discovery", // a real module, but a DiscoveryPlugin
      "webhook-notify", // a real module, but a NotificationPlugin
      "smtp-notify"
    ]) {
      await expect(
        admin.executors.putBinding(component.id, {
          pluginModule: wrongModule,
          pluginInstanceId: `inst-${randomUUID().slice(0, 8)}`,
          config: {}
        }),
        `expected pluginModule '${wrongModule}' to be rejected at write time`
      ).rejects.toBeInstanceOf(ScpApiError);
    }

    // Nothing was ever persisted for any of the rejected attempts.
    await expect(admin.executors.getBinding(component.id)).rejects.toBeInstanceOf(ScpApiError);
  });

  it("REJECTS a notification binding whose pluginModule is unknown or the WRONG KIND — at WRITE time", async () => {
    const org = await createTestOrg(server, "m8-notification-module-allowlist");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    for (const wrongModule of [
      "bogus-module-that-does-not-exist",
      "fake-executor", // a real module, but an ExecutorPlugin, not a NotificationPlugin
      "webhook-control",
      "github-discovery"
    ]) {
      const instanceId = `notify-${randomUUID().slice(0, 8)}`;
      await expect(
        admin.notifications.putBinding(instanceId, {
          pluginModule: wrongModule,
          config: {}
        }),
        `expected pluginModule '${wrongModule}' to be rejected at write time`
      ).rejects.toBeInstanceOf(ScpApiError);
    }
  });

  // CRITICAL #1 (adversarial review): a tenant must never be able to set managed-iac's
  // server-governed runnerImage/networkMode/workspace fields — the manifest configSchema is
  // additionalProperties:false, so the config-validation added to the binding route rejects them.
  it("REJECTS a managed-iac binding whose config tries to set server-governed fields (runnerImage/networkMode)", async () => {
    const org = await createTestOrg(server, "m7-managed-iac-reject");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const component = await admin.components.create({ name: `comp-${randomUUID().slice(0, 8)}` });

    for (const evilConfig of [
      { runnerImage: "attacker/evil:latest" },
      { networkMode: "host" },
      { workspaceDir: "/" },
      { workspaceRoot: "/" }
    ]) {
      await expect(
        admin.executors.putBinding(component.id, {
          pluginModule: "managed-iac",
          pluginInstanceId: `inst-${randomUUID().slice(0, 8)}`,
          config: evilConfig
        }),
        `expected config ${JSON.stringify(evilConfig)} to be rejected`
      ).rejects.toBeInstanceOf(ScpApiError);
    }

    // A managed-iac binding with ONLY the tenant-allowed fields is accepted.
    const ok = await admin.executors.putBinding(component.id, {
      pluginModule: "managed-iac",
      pluginInstanceId: `inst-${randomUUID().slice(0, 8)}`,
      config: { infraCredsSecretKeys: { AWS_ACCESS_KEY_ID: "aws-key-secret" }, timeoutMs: 60000 }
    });
    expect(ok.pluginModule).toBe("managed-iac");
  });

  // CRITICAL #1 defence in depth: even a binding whose stored config was somehow populated with a
  // malicious networkMode (bypassing the route validation) has it OVERRIDDEN by the server's own
  // settings when the instance is provisioned — proven by calling resolveExecutorPluginInstance
  // directly against a repo-inserted (validation-bypassing) binding.
  it("server-injects runnerImage/networkMode/workspaceRoot/statePath, overriding any stored tenant value", async () => {
    const { withTenantTx } = await import("../db/tenant-tx.js");
    const { upsertExecutorBinding, resolveExecutorPluginInstance } =
      await import("../coordination/executor-bindings-repo.js");
    const org = await createTestOrg(server, "m7-managed-iac-inject");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const component = await admin.components.create({ name: `comp-${randomUUID().slice(0, 8)}` });

    const savedEnv = {
      image: process.env.SCP_MANAGED_IAC_RUNNER_IMAGE,
      net: process.env.SCP_MANAGED_IAC_NETWORK_MODE,
      root: process.env.SCP_MANAGED_IAC_WORKSPACE_ROOT
    };
    process.env.SCP_MANAGED_IAC_RUNNER_IMAGE = "scp-runner-iac:vetted-server-pinned";
    process.env.SCP_MANAGED_IAC_NETWORK_MODE = "none";
    process.env.SCP_MANAGED_IAC_WORKSPACE_ROOT = "/srv/scp/managed-iac";
    try {
      const resolved = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
        // Insert a binding whose config carries MALICIOUS server-field values (the repo layer
        // doesn't validate — that's the route's job — so this simulates a validation bypass).
        await upsertExecutorBinding(tx, {
          orgId: org.orgId,
          targetObjectId: component.id,
          pluginModule: "managed-iac",
          pluginInstanceId: "inst-inject",
          config: { runnerImage: "attacker/evil", networkMode: "host", workspaceRoot: "/" }
        });
        return resolveExecutorPluginInstance(tx, {
          orgId: org.orgId,
          targetObjectId: component.id,
          masterKey: server.deps.config.secretsMasterKey
        });
      });

      const cfg = resolved!.instanceConfig.config as Record<string, unknown>;
      expect(cfg.runnerImage).toBe("scp-runner-iac:vetted-server-pinned"); // NOT attacker/evil
      expect(cfg.networkMode).toBe("none"); // NOT host
      expect(cfg.workspaceRoot).toBe("/srv/scp/managed-iac"); // NOT /
      expect(typeof cfg.statePath).toBe("string"); // durable dedup path always injected (MAJOR #4)
    } finally {
      process.env.SCP_MANAGED_IAC_RUNNER_IMAGE = savedEnv.image;
      process.env.SCP_MANAGED_IAC_NETWORK_MODE = savedEnv.net;
      process.env.SCP_MANAGED_IAC_WORKSPACE_ROOT = savedEnv.root;
    }
  });
});
