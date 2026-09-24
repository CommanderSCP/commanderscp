import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  waitUntil,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { auditEvents, changeWaveTargets, decisions } from "../db/schema.js";

/**
 * AN OPS CHANGE THAT DECLARES NO VALID OPERATION IS REFUSED TERMINALLY, WITH A DECISION (ADR-0053 §4).
 *
 * `OpsDeclarationRefused` used to be thrown inside the trigger-claim transaction and caught by the
 * per-target handler, which logged it and retried on the next tick — forever, with no Decision and
 * no audit event, so the only account of the refusal was a log line repeating every second. M28.1
 * gave it the build lane's typed-refusal path. This drives it through the REAL reconcile loop with
 * a real `managed-ops` binding, because the property is about what reconcile does with the throw.
 *
 * `trigger()` is never reached, and that is checkable without instrumenting the plugin: the runner
 * image below does not exist, so a trigger would fail and leave the target retrying rather than
 * terminal — and `executorRef` would be set by any trigger that succeeded.
 *
 * MUTATION (recorded in the M28.1 PR): dropping `.catch(asRefusal)` from the ops-lane call in
 * `reconcile.ts` turns both cases red on the `ops_declaration_refused` wait.
 */
describe("ops-lane declaration refusal is terminal and explained (Testcontainers)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  const envBefore = {
    image: process.env.SCP_MANAGED_OPS_RUNNER_IMAGE,
    key: process.env.SCP_MANAGED_OPS_CATALOG_PUBKEY_SECRET_KEY
  };

  beforeAll(async () => {
    // The class must be ENABLED for the binding to resolve at all — the refusal under test is the
    // declaration's, not the deployment's. The image is deliberately one nothing can pull.
    process.env.SCP_MANAGED_OPS_RUNNER_IMAGE = "scp-runner-ops:never-launched-by-this-test";
    process.env.SCP_MANAGED_OPS_CATALOG_PUBKEY_SECRET_KEY = "ops/catalog-pubkey";
    server = await listenTestServer({
      withEventRelay: true,
      withReconcileLoop: true,
      pluginHostOptions: {
        callTimeoutMs: 8_000,
        restartBackoffBaseMs: 50,
        maxRestartBackoffMs: 300
      }
    });
    org = await createTestOrg(server, "ops-refusal");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    if (envBefore.image === undefined) delete process.env.SCP_MANAGED_OPS_RUNNER_IMAGE;
    else process.env.SCP_MANAGED_OPS_RUNNER_IMAGE = envBefore.image;
    if (envBefore.key === undefined) delete process.env.SCP_MANAGED_OPS_CATALOG_PUBKEY_SECRET_KEY;
    else process.env.SCP_MANAGED_OPS_CATALOG_PUBKEY_SECRET_KEY = envBefore.key;
  });

  async function refusedChange(properties: Record<string, unknown>) {
    const product = await createTestComponent(admin, { name: `fleet-${randomUUID().slice(0, 8)}` });
    await admin.executors.putBinding(product.id, {
      pluginModule: "managed-ops",
      pluginInstanceId: `managed-ops-${randomUUID().slice(0, 8)}`,
      config: {}
    });
    const change = await admin.changes.propose({
      name: `ops ${randomUUID().slice(0, 6)}`,
      targets: [product.id],
      properties
    });
    const target = await waitUntil(
      async () => {
        const [row] = await withTenantTx(server.deps.db, org.orgId, (tx) =>
          tx
            .select()
            .from(changeWaveTargets)
            .where(
              and(
                eq(changeWaveTargets.orgId, org.orgId),
                eq(changeWaveTargets.targetObjectId, product.id)
              )
            )
            .limit(1)
        );
        return row?.status === "ops_declaration_refused" ? row : undefined;
      },
      { describe: "the ops wave target is refused (ops_declaration_refused)", timeoutMs: 30_000 }
    );
    // Never triggered: a trigger that succeeded would have set this, and one that failed would
    // have left the target retrying rather than terminal.
    expect(target.executorRef).toBeNull();

    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(decisions).where(eq(decisions.subjectId, change.id))
    );
    const refusal = rows.find(
      (d) => (d.inputContext as { gate?: string } | null)?.gate === "ops_declaration"
    );
    expect(refusal, "a Decision records the refusal with its inputs (principle 6)").toBeDefined();
    expect(refusal!.verdict).toBe("block");
    const audit = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.subjectId, change.id))
    );
    expect(
      audit.find((a) => a.action === "change.wave_target.ops_declaration_refused")?.decisionId
    ).toBe(refusal!.id);
    return refusal!;
  }

  it("a change that declares NO operation is refused, with the cause named", async () => {
    const refusal = await refusedChange({});
    expect(refusal.inputContext).toMatchObject({
      gate: "ops_declaration",
      reason: "no_declaration",
      role: null,
      hasArguments: false
    });
    expect(JSON.stringify(refusal.reasonTree)).toContain("declares no operation");
  });

  it("a change naming a role OUTSIDE the closed catalog is refused, naming the role", async () => {
    const refusal = await refusedChange({
      ops: { role: "arbitrary_shell", arguments: { cmd: "id" } }
    });
    expect(refusal.inputContext).toMatchObject({
      gate: "ops_declaration",
      reason: "unknown_role",
      role: "arbitrary_shell",
      hasArguments: true
    });
    // The argument VALUES stay out of the Decision — only whether any were given.
    expect(JSON.stringify(refusal.inputContext)).not.toContain("cmd");
    expect(JSON.stringify(refusal.reasonTree)).toContain("not a role in the signed task catalog");
  });
});
