import { randomUUID } from "node:crypto";
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpApiError, ScpClient } from "@scp/sdk";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer
} from "../test-support/harness.js";
import { MANIFEST_BY_MODULE } from "../plugin-host/plugin-manifests.js";

/**
 * M7 plugin-configuration surface (routes/executors.ts, routes/change-sources.ts's webhook-secret
 * addition) — real HTTP round trips via the SDK against a real Testcontainers Postgres, on every
 * PR at integration cost, without waiting on the heavier scripts/e2e-m7.sh job. This is the
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
    const component = await createTestComponent(admin, {
      name: `comp-${randomUUID().slice(0, 8)}`
    });

    const binding = await admin.executors.putBinding(component.id, {
      pluginModule: "fake-executor",
      pluginInstanceId: `inst-${randomUUID().slice(0, 8)}`,
      // A real tenant-facing fake-executor key. It used to be `statePath`, which is SERVER-injected
      // for every executor instance and is therefore refused by the plugin's manifest schema now.
      config: { autoSucceedAfterMs: 200 },
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
    const component = await createTestComponent(admin, {
      name: `comp-${randomUUID().slice(0, 8)}`
    });
    const binding = await admin.executors.putBinding(component.id, {
      pluginModule: "fake-executor",
      pluginInstanceId: `inst-${randomUUID().slice(0, 8)}`
    });
    expect(binding.externalRef).toBeNull();
    expect(binding.executionSystemId).toBeNull();
  });

  it("execution-system-backed binding derives module + a SHARED instance id from the system (M12 P2)", async () => {
    const org = await createTestOrg(server, "m12-execution-system");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    // Register the execution system ONCE — token stored separately, referenced by key.
    await admin.secrets.put("argocd-prod-token", { value: "a-scoped-argocd-token" });
    const sys = await admin.object("execution-system").create({
      name: `argocd-prod-${randomUUID().slice(0, 8)}`,
      properties: {
        kind: "fake-executor",
        serverUrl: "https://argocd.example",
        tokenSecretKey: "argocd-prod-token"
      }
    });
    // Bind a component to it — no module/instance/config in the request; all derived from the system.
    const comp1 = await createTestComponent(admin, { name: `svc-${randomUUID().slice(0, 8)}` });
    const b1 = await admin.executors.putBinding(comp1.id, {
      executionSystemId: sys.id,
      externalRef: "my-app"
    });
    expect(b1.executionSystemId).toBe(sys.id);
    expect(b1.pluginModule).toBe("fake-executor"); // from the system's `kind`
    expect(b1.pluginInstanceId).toBe(`execution-system:${sys.id}`); // shared instance key
    expect(b1.externalRef).toBe("my-app");

    // A SECOND component on the SAME system gets the SAME instance id — so they share one observe
    // poll + one trigger instance, without re-specifying the server/token.
    const comp2 = await createTestComponent(admin, { name: `svc2-${randomUUID().slice(0, 8)}` });
    const b2 = await admin.executors.putBinding(comp2.id, { executionSystemId: sys.id });
    expect(b2.pluginInstanceId).toBe(b1.pluginInstanceId);
  });

  it("a gitea execution-system binding is accepted end to end — the M15.1b module census (KNOWN_EXECUTOR_MODULES + the route's kind allowlist) recognizes 'gitea'", async () => {
    const org = await createTestOrg(server, "m15-gitea-binding");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    await admin.secrets.put("gitea-pat", { value: "a-scoped-gitea-pat" });
    const sys = await admin.object("execution-system").create({
      name: `gitea-prod-${randomUUID().slice(0, 8)}`,
      properties: {
        kind: "gitea", // must pass isKnownExecutorModule — the census point a miss would 400
        serverUrl: "https://gitea.example.com",
        tokenSecretKey: "gitea-pat"
      }
    });
    const comp = await createTestComponent(admin, { name: `svc-${randomUUID().slice(0, 8)}` });
    const binding = await admin.executors.putBinding(comp.id, {
      executionSystemId: sys.id,
      externalRef: "widgets"
    });
    expect(binding.pluginModule).toBe("gitea");
    expect(binding.executionSystemId).toBe(sys.id);
  });

  it("a gitlab execution-system binding is accepted end to end — the M15.3b module census (KNOWN_EXECUTOR_MODULES + the route's kind allowlist) recognizes 'gitlab'", async () => {
    const org = await createTestOrg(server, "m15-gitlab-binding");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    await admin.secrets.put("gitlab-pat", { value: "a-scoped-gitlab-pat" });
    const sys = await admin.object("execution-system").create({
      name: `gitlab-prod-${randomUUID().slice(0, 8)}`,
      properties: {
        kind: "gitlab", // must pass isKnownExecutorModule — the census point a miss would 400
        serverUrl: "https://gitlab.example.com",
        tokenSecretKey: "gitlab-pat"
      }
    });
    const comp = await createTestComponent(admin, { name: `svc-${randomUUID().slice(0, 8)}` });
    const binding = await admin.executors.putBinding(comp.id, {
      executionSystemId: sys.id,
      externalRef: "acme/widgets"
    });
    expect(binding.pluginModule).toBe("gitlab");
    expect(binding.executionSystemId).toBe(sys.id);
  });

  it("execution-system binding is REJECTED when the reference is not an execution-system object", async () => {
    const org = await createTestOrg(server, "m12-execution-system-invalid");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const comp = await createTestComponent(admin, { name: `svc-${randomUUID().slice(0, 8)}` });
    // Point executionSystemId at a Component (wrong type) → 400.
    await expect(
      admin.executors.putBinding(comp.id, { executionSystemId: comp.id })
    ).rejects.toBeInstanceOf(ScpApiError);
  });

  // THE `accept` BINDING-IMPORT CASE IS GONE WITH ITS ROUTE (ADR-0047). It proved that importing a
  // proposal ALSO created the proposed execution-system bindings — import and coordinate in one
  // step (M12 P3b). There is no one-step import now: the scaffolder emits a manifest whose
  // `executorBindings` collection lands through `POST /plans` + apply, which
  // `plans.integration.test.ts`'s C1 round trip covers on the door that still exists.

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
        "gitea",
        "gitea-discovery",
        "gitlab",
        "gitlab-discovery",
        "argocd",
        "argocd-discovery",
        "terraform",
        "managed-iac",
        "webhook-notify",
        "smtp-notify"
      ])
    );
  });

  // "…THE ONLY PATH THAT WRITES" WAS TRUE, AND IS NOW TRUE MORE STRONGLY. This case proved that a
  // proposal's objects did not exist until someone explicitly accepted it — discovery alone never
  // wrote. With `POST /discovery/accept` removed (ADR-0047) discovery cannot write AT ALL: the only
  // way a proposal becomes estate is a human committing scaffolded IaC and applying it. The case is
  // removed because its subject is gone, not because the property weakened.

  it("webhook signature verification is fail-closed once a secret is configured: bad signature 401s and is never persisted, a valid one is accepted and correlates", async () => {
    const org = await createTestOrg(server, "m7-webhook-sig");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const component = await createTestComponent(admin, {
      name: `comp-${randomUUID().slice(0, 8)}`
    });
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

  // ---------------------------------------------------------------------------------------
  // Typed first-party report ingress (M12 P4B Phase 1) — the typed, PAT-authenticated counterpart
  // to the raw `/webhook` route (routes/change-sources.ts). Same persist-then-process pipeline,
  // real generated SDK contract, and — critically — NOT subject to the webhook's HMAC gate.
  // ---------------------------------------------------------------------------------------
  it("a typed report persists a change_source_event and correlates into a Change via its source mapping", async () => {
    const org = await createTestOrg(server, "p4b-report-correlates");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const component = await createTestComponent(admin, {
      name: `comp-${randomUUID().slice(0, 8)}`
    });
    const repo = `report-org/${randomUUID().slice(0, 8)}`;
    await admin.changeSources.createMapping("terraform", {
      repoPattern: repo,
      component: component.id
    });

    const res = await admin.changeSources.report("terraform", {
      status: "applied",
      repo,
      correlationKey: "refs/heads/main",
      workspace: "prod",
      artifactDigest: "sha256:deadbeef"
    });
    expect(res.accepted).toBe(true);
    expect(res.eventId).toBeTruthy();

    const { withTenantTx } = await import("../db/tenant-tx.js");
    const { processChangeSourceEvents } = await import("../coordination/webhook-processor.js");
    const { objects } = await import("../db/schema.js");
    const { eq } = await import("drizzle-orm");
    await withTenantTx(server.deps.db, org.orgId, (tx) => processChangeSourceEvents(tx, org.orgId));

    // Exactly the persist-then-process outcome the raw webhook produces: a Change targeting the
    // mapped component. Proves the typed body's top-level `repo` reached `genericHint` correlation.
    const changes = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ id: objects.id, properties: objects.properties })
        .from(objects)
        .where(eq(objects.typeId, "change"))
    );
    const mine = changes.filter(
      (c) =>
        Array.isArray((c.properties as { targets?: unknown }).targets) &&
        (c.properties as { targets: string[] }).targets.includes(component.id)
    );
    expect(mine).toHaveLength(1);
  });

  it("a report succeeds even when a webhook SECRET is configured for that sourceKind — the raw /webhook path would 401", async () => {
    // The latent bug this route fixes: the old report piggy-backed on /webhook, which HMAC-verifies
    // once a secret exists. A report carries no signature, so an org that set a `terraform` webhook
    // secret could not report at all. The typed /report route is PAT-authenticated and skips HMAC.
    const org = await createTestOrg(server, "p4b-report-with-secret");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    await admin.changeSources.putWebhookSecret("terraform", { secret: "a-configured-secret" });

    // The typed route: accepted.
    const res = await admin.changeSources.report("terraform", { status: "planned", repo: "x/y" });
    expect(res.accepted).toBe(true);

    // The SAME body on the raw /webhook path (no signature header): rejected 401, proving the
    // report route genuinely bypasses the gate rather than the secret merely being inert.
    const viaWebhook = await fetch(`${server.baseUrl}/change-sources/terraform/webhook`, {
      method: "POST",
      headers: { authorization: `Bearer ${org.adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ status: "planned", repo: "x/y" })
    });
    expect(viaWebhook.status).toBe(401);
  });

  it("re-reporting the identical result is deduped to one event; a different result is a new event", async () => {
    const org = await createTestOrg(server, "p4b-report-dedupe");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const body = { status: "applied" as const, repo: "dedupe/repo", artifactDigest: "sha256:aaaa" };

    const first = await admin.changeSources.report("terraform", body);
    const again = await admin.changeSources.report("terraform", body); // byte-identical
    expect(again.eventId).toBe(first.eventId); // deduped to the SAME event

    const different = await admin.changeSources.report("terraform", { ...body, status: "errored" });
    expect(different.eventId).not.toBe(first.eventId); // a distinct result is a distinct event

    const { withTenantTx } = await import("../db/tenant-tx.js");
    const { changeSourceEvents } = await import("../db/schema.js");
    const { eq } = await import("drizzle-orm");
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ id: changeSourceEvents.id })
        .from(changeSourceEvents)
        .where(eq(changeSourceEvents.orgId, org.orgId))
    );
    expect(rows).toHaveLength(2); // the identical pair collapsed to one; the errored one is the second
  });

  it("rejects a report with an invalid status — the typed contract the raw webhook lacks", async () => {
    const org = await createTestOrg(server, "p4b-report-invalid");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    await expect(
      admin.changeSources.report("terraform", { status: "bogus" as never, repo: "x/y" })
    ).rejects.toBeInstanceOf(ScpApiError);
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
    const component = await createTestComponent(admin, {
      name: `comp-${randomUUID().slice(0, 8)}`
    });

    for (const wrongModule of [
      "bogus-module-that-does-not-exist",
      "webhook-control", // a real module, but a ControlPlugin, not an ExecutorPlugin
      "github-discovery", // a real module, but a DiscoveryPlugin
      "gitea-discovery", // a real module, but a DiscoveryPlugin (M15.3a — must be excluded too)
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
    const component = await createTestComponent(admin, {
      name: `comp-${randomUUID().slice(0, 8)}`
    });

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

  /** Restore an env var to its prior state. `process.env.X = undefined` stores the STRING
   *  `"undefined"`, which would leak a bogus runtime path into every later test in this file, so an
   *  absent original must be `delete`d rather than assigned. */
  function restoreEnv(key: string, previous: string | undefined): void {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }

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
    const component = await createTestComponent(admin, {
      name: `comp-${randomUUID().slice(0, 8)}`
    });

    const savedEnv = {
      image: process.env.SCP_MANAGED_IAC_RUNNER_IMAGE,
      net: process.env.SCP_MANAGED_IAC_NETWORK_MODE,
      root: process.env.SCP_MANAGED_IAC_WORKSPACE_ROOT,
      // The fourth server-governed knob. It was previously left AMBIENT while the assertion below
      // pinned the literal `"docker"` — so this test failed on any host that had actually
      // configured a runtime (`SCP_MANAGED_RUNNER_DOCKER_BINARY=podman`), which is exactly the
      // RHEL/air-gapped deployment shape the setting exists for. Controlled here like its three
      // siblings, and set to a value that is NOT the default so the assertion proves the value was
      // INJECTED FROM THE KNOB rather than passing vacuously against the fallback.
      runner: process.env.SCP_MANAGED_RUNNER_DOCKER_BINARY
    };
    process.env.SCP_MANAGED_IAC_RUNNER_IMAGE = "scp-runner-iac:vetted-server-pinned";
    process.env.SCP_MANAGED_IAC_NETWORK_MODE = "none";
    process.env.SCP_MANAGED_IAC_WORKSPACE_ROOT = "/srv/scp/managed-iac";
    process.env.SCP_MANAGED_RUNNER_DOCKER_BINARY = "/usr/bin/operator-chosen-runtime";
    try {
      const resolved = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
        // Insert a binding whose config carries MALICIOUS server-field values (the repo layer
        // doesn't validate — that's the route's job — so this simulates a validation bypass).
        await upsertExecutorBinding(tx, {
          orgId: org.orgId,
          targetObjectId: component.id,
          pluginModule: "managed-iac",
          pluginInstanceId: "inst-inject",
          config: { runnerImage: "attacker/evil", networkMode: "host", workspaceRoot: "/" },
          actorObjectId: org.orgId,
          requestId: "test-setup"
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
      // Defence in depth for the key that is now refused AND injected: `dockerBinary` selects the
      // executable this plugin `execFile`s, so the write-door schema is no longer its only guard.
      // Asserted against the OPERATOR'S value, not the `"docker"` fallback — see `savedEnv.runner`.
      expect(cfg.dockerBinary).toBe("/usr/bin/operator-chosen-runtime");
    } finally {
      process.env.SCP_MANAGED_IAC_RUNNER_IMAGE = savedEnv.image;
      process.env.SCP_MANAGED_IAC_NETWORK_MODE = savedEnv.net;
      process.env.SCP_MANAGED_IAC_WORKSPACE_ROOT = savedEnv.root;
      restoreEnv("SCP_MANAGED_RUNNER_DOCKER_BINARY", savedEnv.runner);
    }
  });

  /**
   * ============================================================================================
   * THE OPERATOR'S RUNTIME REACHES *EVERY* MANAGED EXECUTOR — the knob, measured (2026-08-16)
   * ============================================================================================
   * `SCP_MANAGED_RUNNER_DOCKER_BINARY` selects the executable every managed executor `execFile`s.
   * It exists for two reasons, and both are load-bearing:
   *
   *  1. DEPLOYMENT. Regulated, air-gapped and FedRAMP/IL estates are largely RHEL, where a Docker
   *     daemon is frequently disallowed and rootless podman is the sanctioned runtime. Rootless
   *     podman is verified against the real runners (docs/container-runtimes.md) — but ONLY for the
   *     executors the setting actually reaches.
   *  2. DEFENCE IN DEPTH. Injecting it server-side means a future regression in the write-door gate
   *     downgrades from remote code execution to an accepted-but-inert config key (see
   *     `managedRunnerDockerBinary`'s doc). That argument holds only where the injection happens.
   *
   * WHY THIS IS A LOOP OVER AN ENUMERATED LIST rather than one more assertion in the test above.
   * The injection is written once PER MODULE, as a separate `if (pluginModule === …)` arm, so the
   * property is only ever as complete as the last person to add a managed class remembered to make
   * it. When this test was written that had already failed: `managed-iac` and `managed-scan` set
   * `dockerBinary`, and `managed-dep` — added later, and which `execFile`s
   * `config.dockerBinary ?? "docker"` exactly like its siblings — did not, on ANY of its three
   * construction paths. An operator setting the knob got podman for two executors and a silent
   * `docker` for the third: on a podman-only host, dependency bumps fail while everything else
   * works, and the second defence above is simply absent for that class.
   *
   * Adding a fourth managed executor therefore fails HERE until it is wired, which is the point —
   * the list is the census, and a census with no entry for a module is how the third one was missed.
   */
  it("server-injects the operator's runtime binary into EVERY managed executor module", async () => {
    const { withTenantTx } = await import("../db/tenant-tx.js");
    const { upsertExecutorBinding, resolveExecutorPluginInstance } =
      await import("../coordination/executor-bindings-repo.js");

    /** Every charter-enumerated managed class, with the env var that enables it. A managed executor
     *  absent from this list is a managed executor nothing checks. */
    const MANAGED_MODULES = [
      { module: "managed-iac", imageEnv: "SCP_MANAGED_IAC_RUNNER_IMAGE" },
      { module: "managed-scan", imageEnv: "SCP_MANAGED_SCAN_RUNNER_IMAGE" },
      { module: "managed-dep", imageEnv: "SCP_MANAGED_DEP_RUNNER_IMAGE" }
    ] as const;

    const RUNTIME = "/usr/bin/operator-chosen-runtime";
    const saved = new Map<string, string | undefined>();
    const setEnv = (key: string, value: string): void => {
      if (!saved.has(key)) saved.set(key, process.env[key]);
      process.env[key] = value;
    };

    const org = await createTestOrg(server, "managed-runner-binary");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    try {
      setEnv("SCP_MANAGED_RUNNER_DOCKER_BINARY", RUNTIME);
      for (const { imageEnv } of MANAGED_MODULES) setEnv(imageEnv, "vetted-runner:server-pinned");

      for (const { module } of MANAGED_MODULES) {
        // A component each: the binding is UNIQUE per (org, target, type), so three modules on one
        // component would contend for the same slot rather than all being resolvable.
        const component = await createTestComponent(admin, {
          name: `comp-${randomUUID().slice(0, 8)}`
        });

        const resolved = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
          await upsertExecutorBinding(tx, {
            orgId: org.orgId,
            targetObjectId: component.id,
            pluginModule: module,
            pluginInstanceId: `inst-${randomUUID().slice(0, 8)}`,
            // The tenant's own attempt at choosing the executable, to prove the server value WINS
            // rather than merely filling a gap.
            config: { dockerBinary: "/tmp/tenant-chosen-binary" },
            actorObjectId: org.orgId,
            requestId: "test-setup"
          });
          return resolveExecutorPluginInstance(tx, {
            orgId: org.orgId,
            targetObjectId: component.id,
            masterKey: server.deps.config.secretsMasterKey
          });
        });

        const cfg = (resolved?.instanceConfig.config ?? {}) as Record<string, unknown>;
        expect(cfg.dockerBinary, `${module} did not receive the operator's runtime binary`).toBe(
          RUNTIME
        );
      }
    } finally {
      for (const [key, previous] of saved) restoreEnv(key, previous);
    }
  });

  /**
   * THE SAME REFUSAL, FOR THE MODULES THAT NEVER HAD IT. The managed-iac tests above passed while
   * three sibling modules on the very same `KNOWN_EXECUTOR_MODULES` allowlist — `managed-scan`,
   * `pipeline-generic`, `fake-executor` — had no manifest at all, so `validatePluginConfig` found no
   * schema and returned early. Every key of their binding configs was stored unread.
   *
   * `managed-scan` is the one with teeth: `@scp/plugin-managed-scan` runs
   * `execFile(config.dockerBinary ?? "docker", …)`, and `dockerBinary` was NOT among the keys
   * `resolveExecutorPluginInstance` injects — so a tenant `PUT /executors/{id}/binding` naming any
   * host path reached arbitrary code execution on the SCP host, across the exact boundary the plugin
   * sandbox exists to hold. Proven HERE, at the HTTP write door, not only against
   * `validatePluginConfig`: a unit test cannot show that the door still calls it.
   *
   * MUTATION-PROVEN: restoring shipped main for one module — drop `"managed-scan"` from
   * `MANIFEST_BY_MODULE`, restore `validatePluginConfig`'s `if (!manifest) return;`, and disable the
   * `assertEveryModuleHasManifest` boot check — makes this test fail with "promise resolved
   * { …(11) } instead of rejecting": the binding carrying `dockerBinary: "/tmp/pwn.sh"` is STORED.
   */
  it("REJECTS server-governed config on the modules that previously had NO manifest at all", async () => {
    const org = await createTestOrg(server, "manifestless-modules-reject");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const component = await createTestComponent(admin, {
      name: `comp-${randomUUID().slice(0, 8)}`
    });

    const governed = [
      { dockerBinary: "/tmp/pwn.sh" }, // THE escalation: the binary the plugin execFile's
      { runnerImage: "attacker/evil:latest" },
      { networkMode: "host" },
      { workspaceRoot: "/" },
      { statePath: "/etc/scp/anything" }
    ];
    type Module = "managed-scan" | "pipeline-generic" | "fake-executor";
    const cases: { module: Module; base: Record<string, unknown> }[] = [
      { module: "managed-scan", base: {} },
      { module: "pipeline-generic", base: { triggerUrl: "https://ci.example.test/hooks/x" } },
      { module: "fake-executor", base: {} }
    ];

    for (const { module, base } of cases) {
      for (const evil of governed) {
        await expect(
          admin.executors.putBinding(component.id, {
            pluginModule: module,
            pluginInstanceId: `inst-${randomUUID().slice(0, 8)}`,
            config: { ...base, ...evil }
          }),
          `expected ${module} config ${JSON.stringify(evil)} to be rejected`
        ).rejects.toBeInstanceOf(ScpApiError);
      }
    }

    // NEGATIVE CONTROLS — a legitimate config for each is still ACCEPTED. Without these, a schema
    // that refused EVERYTHING (and broke all three executors) would be indistinguishable from a
    // working fix, judging by the refusals alone.
    const legitimate: { module: Module; config: Record<string, unknown> }[] = [
      { module: "managed-scan", config: { timeoutMs: 60_000 } },
      {
        module: "pipeline-generic",
        config: {
          triggerUrl: "https://ci.example.test/hooks/deploy",
          statusUrl: "https://ci.example.test/runs/{externalId}",
          tokenSecretKey: "ci-token",
          runIdField: "id"
        }
      },
      { module: "fake-executor", config: { autoSucceedAfterMs: 50, forcePhase: { t: "failed" } } }
    ];
    for (const { module, config } of legitimate) {
      const ok = await admin.executors.putBinding(component.id, {
        pluginModule: module,
        pluginInstanceId: `inst-${randomUUID().slice(0, 8)}`,
        config
      });
      expect(ok.pluginModule, module).toBe(module);
    }
  });

  /**
   * M23.1c — THE TENANT-SETTABLE RUN BUDGET IS CAPPED, AT THE DOOR, ON EVERY MANAGED CLASS.
   *
   * All three managed manifests shipped `timeoutMs: { type: "integer", minimum: 1000 }` with NO
   * maximum, and the value is settable by any org member with plain `object:write` on a Component.
   * Two consequences, and the second is why the cap is a prerequisite rather than hygiene:
   *
   *  1. `execFile`'s `timeout` is the only thing that stops a wedged `docker start -a`. At 2^31 ms
   *     (24.9 days) the runner is unkillable by its own timeout.
   *  2. The plugin HOST now derives that module's `trigger` RPC budget from the same number
   *     (`plugin-host/call-policy.ts`), so an unbounded config is an unbounded budget — and
   *     `subprocess-entry.ts` answers one RPC at a time, so that instance's `status()`/`observe()`/
   *     `abort()` would head-of-line block behind it for the duration.
   *
   * PROVEN AT THE HTTP WRITE DOOR, not against `validatePluginConfig`: a unit test cannot show that
   * the door still calls it, and "a config schema that is authored but never registered" is exactly
   * how this repo shipped a live RCE (see the `managed-scan` test above).
   *
   * MUTATION-PROVEN: delete `maximum` from `@scp/plugin-managed-iac`'s manifest and this test fails
   * with "promise resolved … instead of rejecting" for that module — the 2^31 binding is STORED.
   */
  it("REJECTS an over-cap timeoutMs at the binding write door, on every managed module", async () => {
    const org = await createTestOrg(server, "managed-timeout-cap");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    type Managed = "managed-iac" | "managed-scan" | "managed-dep";
    const managedModules: Managed[] = ["managed-iac", "managed-scan", "managed-dep"];

    /** The ceiling as the MANIFEST declares it — the one number the host and the door both read. */
    const ceilingFor = (module: string): number => {
      const schema = MANIFEST_BY_MODULE[module]?.configSchema as {
        properties?: { timeoutMs?: { maximum?: unknown } };
      };
      const max = schema?.properties?.timeoutMs?.maximum;
      expect(typeof max, `${module} publishes no timeoutMs maximum`).toBe("number");
      return max as number;
    };

    for (const module of managedModules) {
      const ceiling = ceilingFor(module);
      // Independently bounded, so `maximum: Number.MAX_SAFE_INTEGER` could not pass this test.
      expect(ceiling, `${module}'s ceiling is not a sane duration`).toBeLessThanOrEqual(
        60 * 60_000
      );

      const component = await createTestComponent(admin, {
        name: `comp-${randomUUID().slice(0, 8)}`
      });

      // REFUSED: the concrete value the defect record names, one past the ceiling, and below the
      // floor (the bound that already existed — asserted so a bad edit cannot trade one for the
      // other).
      for (const timeoutMs of [2 ** 31, ceiling + 1, 999]) {
        await expect(
          admin.executors.putBinding(component.id, {
            pluginModule: module,
            pluginInstanceId: `inst-${randomUUID().slice(0, 8)}`,
            config: { timeoutMs }
          }),
          `expected ${module} timeoutMs=${timeoutMs} to be rejected by PUT binding`
        ).rejects.toBeInstanceOf(ScpApiError);
      }

      // ACCEPTED: the ceiling itself is admissible (inclusive), and so is an ordinary value. Without
      // these, a schema that refused EVERY timeoutMs — breaking all three executors — would look
      // identical to a working cap.
      for (const timeoutMs of [ceiling, 60_000]) {
        const ok = await admin.executors.putBinding(component.id, {
          pluginModule: module,
          pluginInstanceId: `inst-${randomUUID().slice(0, 8)}`,
          config: { timeoutMs }
        });
        expect(ok.pluginModule, `${module} timeoutMs=${timeoutMs}`).toBe(module);
      }
    }

    // THE OTHER DOORS ARE THE SAME FUNCTION, and that is deliberate rather than lucky:
    // `validatePluginConfig` is the single gate all four write paths call (this route, the
    // notification upsert, discovery-run, and `iac/plans-repo.ts`'s `assertInlineBindingsValid`),
    // extracted out of this handler precisely because "a gate that lives inside one route handler
    // is a gate the next write path silently doesn't have". The IaC-apply door's own coverage of
    // that call for `managed-iac` is `plans.integration.test.ts`.
  });
});
