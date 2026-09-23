import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import {
  KNOWN_EXECUTOR_MODULES,
  managedOpsServerSettings,
  resolveExecutorPluginInstance
} from "./executor-bindings-repo.js";

/**
 * M27.7 WIRING — can an operator actually bind `managed-ops`, and does the binding carry the bound?
 *
 * Six registration edits and a plugin file are the classic "built but never installed" shape: each
 * one looks right in isolation, and the executor is still unreachable if any is missing. So this
 * goes through the real binding path rather than asserting that a list contains a string.
 *
 * The two REFUSALS matter more than the success. This is the only class that holds host
 * login-grade credentials, so the interesting question is not "does it start" but "what does it
 * refuse to start without".
 */
describe("managed-ops binding (Testcontainers)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let targetId: string;

  const envBefore = {
    image: process.env.SCP_MANAGED_OPS_RUNNER_IMAGE,
    key: process.env.SCP_MANAGED_OPS_CATALOG_PUBKEY_SECRET_KEY
  };

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "managed-ops-binding");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const component = await createTestComponent(admin, { name: `ops-${randomUUID().slice(0, 8)}` });
    targetId = component.id;
  }, 180_000);

  afterEach(() => {
    delete process.env.SCP_MANAGED_OPS_RUNNER_IMAGE;
    delete process.env.SCP_MANAGED_OPS_CATALOG_PUBKEY_SECRET_KEY;
  });

  afterAll(async () => {
    if (envBefore.image) process.env.SCP_MANAGED_OPS_RUNNER_IMAGE = envBefore.image;
    if (envBefore.key) process.env.SCP_MANAGED_OPS_CATALOG_PUBKEY_SECRET_KEY = envBefore.key;
    await server?.close();
  });

  it("is a known executor module — the registration census, from the list the server uses", () => {
    expect(KNOWN_EXECUTOR_MODULES).toContain("managed-ops");
  });

  it("UNSET IMAGE: the settings report the class as off", () => {
    // "Managed execution is never a default" (ADR-0006), for the class holding host credentials.
    expect(managedOpsServerSettings().runnerImage).toBeUndefined();
  });

  it("carries the image AND the catalog key once both are configured", () => {
    process.env.SCP_MANAGED_OPS_RUNNER_IMAGE = "scp-runner-ops:test";
    process.env.SCP_MANAGED_OPS_CATALOG_PUBKEY_SECRET_KEY = "ops/catalog-pubkey";
    const settings = managedOpsServerSettings();
    expect(settings.runnerImage).toBe("scp-runner-ops:test");
    expect(settings.catalogPubkeySecretKey).toBe("ops/catalog-pubkey");
    expect(settings.workspaceRoot.length).toBeGreaterThan(0);
  });

  it("HAS NO networkMode SETTING AT ALL — the absence is the charter, not an omission", () => {
    // `managedDepServerSettings` carries none because its clause is an unqualified `--network
    // none`. This one carries none because its clause is QUALIFIED and the scope is the per-run
    // egress allowlist derived from observed membership (M27.6b) — a knob here could only widen
    // it. Asserted, because "we chose not to add a field" is invisible in a diff a year from now.
    process.env.SCP_MANAGED_OPS_RUNNER_IMAGE = "scp-runner-ops:test";
    process.env.SCP_MANAGED_OPS_CATALOG_PUBKEY_SECRET_KEY = "ops/catalog-pubkey";
    expect(Object.keys(managedOpsServerSettings())).not.toContain("networkMode");
  });

  async function resolveWithBinding(): Promise<unknown> {
    await admin.executors.putBinding(targetId, {
      pluginModule: "managed-ops",
      pluginInstanceId: "managed-ops-wiring",
      type: "configuration",
      config: {}
    });
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      resolveExecutorPluginInstance(tx, {
        orgId: org.orgId,
        targetObjectId: targetId,
        masterKey: server.deps.config.secretsMasterKey,
        type: "configuration"
      })
    );
  }

  it("REFUSES a binding when the runner image is unset", async () => {
    await expect(resolveWithBinding()).rejects.toThrow(
      /host-reaching managed execution is not enabled/
    );
  });

  it("REFUSES a binding when the image is set but no CATALOG KEY is", async () => {
    // ADR-0050 makes the signed catalog the thing that bounds what a run can DO. An image without
    // a verification key would run an unverified catalog with host credentials — the whole hazard,
    // not a rough edge. This is the refusal most likely to be dropped as "an extra check".
    process.env.SCP_MANAGED_OPS_RUNNER_IMAGE = "scp-runner-ops:test";
    await expect(resolveWithBinding()).rejects.toThrow(/no catalog verification key is configured/);
  });

  it("RESOLVES, and injects the bound, once both are configured", async () => {
    process.env.SCP_MANAGED_OPS_RUNNER_IMAGE = "scp-runner-ops:test";
    process.env.SCP_MANAGED_OPS_CATALOG_PUBKEY_SECRET_KEY = "ops/catalog-pubkey";
    const resolved = (await resolveWithBinding()) as
      { instanceConfig: { config: Record<string, unknown> } } | undefined;
    expect(resolved).toBeDefined();
    const config = resolved!.instanceConfig.config;
    expect(config["runnerImage"]).toBe("scp-runner-ops:test");
    expect(config["catalogPubkeySecretKey"]).toBe("ops/catalog-pubkey");
    // NOT injected — see the charter note above.
    expect(config).not.toHaveProperty("networkMode");
  });
});
