import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpApiError, ScpClient } from "@scp/sdk";
import { StackBackendSchema, type PutStackStatusRequest } from "@scp/schemas";
import {
  createTestOrg,
  createTestUser,
  listenTestServer,
  testDatabaseUrl,
  testOperatorDatabaseUrl,
  testRuntimeDatabaseUrl,
  type ListeningTestServer
} from "../test-support/harness.js";
import { provisionInstallTimePrincipals } from "../db/provision-install.js";
import { STACKD_INSTALL_CREDENTIAL_NAME, createOperatorCredential } from "../auth/operator-auth.js";
import { grantBootstrapInstanceOperator } from "./instance-operators.js";

/**
 * M29.4 — THE STANDARD STACK'S API, end to end (ADR-0058, E2, and the review round's owner
 * decision: instance authority is a ROLE on a normal session, or a full operator credential for
 * machines; the controller's credential opens only its two doors; every change is audited in the
 * instance chain, in the same transaction).
 *
 * The server under test writes through a REAL `scp_operator` login, never the harness superuser.
 */

const BOOTSTRAP_OPERATOR_TOKEN = "m29-4-stack-bootstrap-operator-token";
const STACKD_TOKEN = "scp_op_stackdInstallTok1." + "s".repeat(43);
const STACKD_TOKEN_ROTATED = "scp_op_stackdInstallTok2." + "r".repeat(43);

async function apiError(fn: () => Promise<unknown>): Promise<ScpApiError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ScpApiError) return err;
    throw err;
  }
  throw new Error("expected an ScpApiError, but the call succeeded");
}

const H = "a".repeat(64);

function report(over: Partial<PutStackStatusRequest> = {}): PutStackStatusRequest {
  return {
    release: "1.0.0-rc.0",
    observedUpgradeGeneration: 0,
    backends: [
      {
        backend: "argo-events",
        phase: "ready",
        runningVersion: "1.0.0-rc.0",
        targetVersion: "1.0.0-rc.0",
        lastError: null,
        needs: [],
        detail: ["deployment scp-argo-events/controller-manager 1/1 available"],
        lastGoodSha256: H,
        inventorySha256: H
      }
    ],
    ...over
  };
}

describe("M29.4 the Standard Stack API (Testcontainers, real scp_operator writes)", () => {
  let server: ListeningTestServer;
  /** An OrgAdmin session with NO instance-operator grant. */
  let tenant: ScpClient;
  /** A session that will be granted the role. */
  let operatorUser: ScpClient;
  /** No session at all — exactly what the stack controller holds. */
  let controller: ScpClient;
  let orgId: string;
  let operatorUserId: string;
  let admin: pg.Pool;

  const auditActions = async () =>
    (await tenant.instanceOperators.auditEvents(BOOTSTRAP_OPERATOR_TOKEN)).items.map(
      (e) => e.action
    );

  beforeAll(async () => {
    const operatorDatabaseUrl = await testOperatorDatabaseUrl();
    server = await listenTestServer({
      operatorToken: BOOTSTRAP_OPERATOR_TOKEN,
      operatorDatabaseUrl
    });
    const org = await createTestOrg(server, "m29-4-stack");
    orgId = org.orgId;
    tenant = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const user = await createTestUser(server, org, []);
    operatorUser = new ScpClient({ baseUrl: server.baseUrl, token: user.token });
    operatorUserId = (await operatorUser.auth.me()).userId;
    controller = new ScpClient({ baseUrl: server.baseUrl });
    admin = new pg.Pool({ connectionString: testDatabaseUrl(), max: 2 });
    await provisionInstallTimePrincipals(admin, server.deps.config, {
      SCP_STACKD_OPERATOR_CREDENTIAL: STACKD_TOKEN
    });
  });

  afterAll(async () => {
    await admin?.end();
    await server?.close();
  });

  it("a tenant session reads every backend, each disabled and unreported, and a silent controller", async () => {
    const view = await tenant.stack.get();
    expect(view.backends.map((b) => b.backend)).toEqual(StackBackendSchema.options);
    for (const b of view.backends) {
      expect(b.enabled).toBe(false);
      expect(b.status).toBeNull();
      expect(b.purgeGeneration).toBe(0);
    }
    expect(view.controller.reporting).toBe(false);
  });

  it("an OrgAdmin session without the instance-operator role cannot change the stack", async () => {
    const err = await apiError(() => tenant.stack.putBackend("argo-events", { enabled: true }));
    expect(err.status).toBe(403);
    expect(err.problem?.detail).toMatch(/instance-operator role/);
  });

  it("the FIRST grant needs no SQL: the bootstrap credential grants the role to a user (audited)", async () => {
    expect(await operatorUser.instanceOperators.self()).toBe(false);
    const grant = await tenant.instanceOperators.grant(
      { orgId, userId: operatorUserId },
      BOOTSTRAP_OPERATOR_TOKEN
    );
    expect(grant.grantedBy.mechanism).toBe("bootstrap-env-token");
    expect(await operatorUser.instanceOperators.self()).toBe(true);
    expect(await auditActions()).toContain("instance.operator.grant");
    // A second live grant for the same user is a 409, not a silent duplicate.
    expect(
      (
        await apiError(() =>
          tenant.instanceOperators.grant(
            { orgId, userId: operatorUserId },
            BOOTSTRAP_OPERATOR_TOKEN
          )
        )
      ).status
    ).toBe(409);
  });

  it("a session holding the role enables a backend with NO credential, and the change is audited in the same tx", async () => {
    const view = await operatorUser.stack.putBackend("argo-events", {
      enabled: true,
      sizeTier: "medium"
    });
    expect(view.backends.find((b) => b.backend === "argo-events")).toMatchObject({
      enabled: true,
      sizeTier: "medium"
    });
    const events = (await tenant.instanceOperators.auditEvents(BOOTSTRAP_OPERATOR_TOKEN)).items;
    const last = events.at(-1)!;
    expect(last.action).toBe("stack.backend.enable");
    expect(last.subject).toBe("argo-events");
    expect(last.actor).toMatchObject({ mechanism: "session-role", userId: operatorUserId });
    expect(last.detail).toMatchObject({ after: { enabled: true, sizeTier: "medium" } });
  });

  it("the controller reads the spec with its credential ALONE — and nothing else opens with it", async () => {
    const spec = await controller.stack.spec(STACKD_TOKEN);
    expect(spec.backends.find((b) => b.backend === "argo-events")).toEqual({
      backend: "argo-events",
      enabled: true,
      sizeTier: "medium",
      purgeGeneration: 0
    });
    expect(spec.integrity).toHaveLength(StackBackendSchema.options.length);
    // N1: the stack-controller scope does not open a human door, nor any other instance door.
    expect(
      (await apiError(() => tenant.stack.putBackend("gitea", { enabled: true }, STACKD_TOKEN)))
        .status
    ).toBe(403);
    expect((await apiError(() => tenant.operatorCredentials.list(STACKD_TOKEN))).status).toBe(403);
  });

  it("ONLY the controller's credential writes status — not a full operator credential, not a role-holding session", async () => {
    expect(
      (await apiError(() => controller.stack.putStatus(report(), BOOTSTRAP_OPERATOR_TOKEN))).status
    ).toBe(403);
    const minted = await createOperatorCredential(server.deps.config, {
      name: "a-human",
      createdByUserId: null,
      expiresAt: null
    });
    expect((await apiError(() => controller.stack.putStatus(report(), minted.token))).status).toBe(
      403
    );
    expect(
      (await apiError(() => controller.stack.putStatus(report(), "scp_op_nope.nope"))).status
    ).toBe(403);
  });

  it("a status report lands on the read model with its hashes, and never changes what is desired", async () => {
    await controller.stack.putStatus(
      report({
        backends: [
          ...report().backends,
          {
            backend: "gitea",
            phase: "disabled",
            runningVersion: null,
            targetVersion: "1.0.0-rc.0",
            lastError: null,
            needs: [],
            detail: [],
            lastGoodSha256: null,
            inventorySha256: null
          }
        ]
      }),
      STACKD_TOKEN
    );
    const view = await tenant.stack.get();
    expect(view.controller.release).toBe("1.0.0-rc.0");
    expect(view.controller.reporting).toBe(true);
    const events = view.backends.find((b) => b.backend === "argo-events")!;
    expect(events).toMatchObject({ enabled: true, sizeTier: "medium" });
    expect(events.status).toMatchObject({ phase: "ready" });
    expect(view.backends.find((b) => b.backend === "gitea")?.enabled).toBe(false);
    const spec = await controller.stack.spec(STACKD_TOKEN);
    expect(spec.integrity.find((i) => i.backend === "argo-events")).toEqual({
      backend: "argo-events",
      lastGoodSha256: H,
      inventorySha256: H
    });
  });

  it("diagnostics carry the controller's evidence, are role- or credential-gated, and are themselves audited", async () => {
    expect(JSON.stringify(await tenant.stack.get())).not.toContain("controller-manager 1/1");
    expect((await apiError(() => tenant.stack.diagnostics())).status).toBe(403);
    const diag = await operatorUser.stack.diagnostics();
    expect(diag.backends.find((b) => b.backend === "argo-events")?.detail).toEqual([
      "deployment scp-argo-events/controller-manager 1/1 available"
    ]);
    expect((await auditActions()).at(-1)).toBe("stack.diagnostics.read");
  });

  it("purge is refused while enabled (and leaves no audit link), and bumps the generation once disabled", async () => {
    const before = (await auditActions()).length;
    expect((await apiError(() => operatorUser.stack.purge("argo-events"))).status).toBe(409);
    expect((await auditActions()).length).toBe(before);
    await operatorUser.stack.putBackend("argo-events", { enabled: false });
    const view = await operatorUser.stack.purge("argo-events");
    expect(view.backends.find((b) => b.backend === "argo-events")?.purgeGeneration).toBe(1);
    expect((await auditActions()).slice(-2)).toEqual([
      "stack.backend.disable",
      "stack.backend.purge"
    ]);
    await operatorUser.stack.putBackend("argo-events", { enabled: true, sizeTier: "medium" });
  });

  it("upgrade and settings are audited; the chain re-verifies end to end", async () => {
    const before = (await tenant.stack.get()).settings.upgradeGeneration;
    expect((await operatorUser.stack.requestUpgrade()).settings.upgradeGeneration).toBe(before + 1);
    await operatorUser.stack.putSettings({ updatePolicy: "manual" });
    await operatorUser.stack.putSettings({ updatePolicy: "automatic" });
    const list = await tenant.instanceOperators.auditEvents(BOOTSTRAP_OPERATOR_TOKEN);
    expect(list.chainValid).toBe(true);
    expect(list.items.map((e) => e.action)).toEqual(
      expect.arrayContaining(["stack.upgrade.request", "stack.settings.put"])
    );
    expect(list.items.map((e) => e.seq)).toEqual(list.items.map((_, i) => i + 1));
  });

  it("a tampered link is detected — the chain is not decorative", async () => {
    await admin.query(
      "UPDATE instance_audit_events SET detail = '{\"forged\": true}'::jsonb WHERE seq = 1"
    );
    const list = await tenant.instanceOperators.auditEvents(BOOTSTRAP_OPERATOR_TOKEN);
    expect(list.chainValid).toBe(false);
    expect(list.brokenAt).toBe(list.items[0]!.id);
  });

  it("the audit chain is append-only even for scp_operator, and invisible to scp_app", async () => {
    const op = new pg.Client({ connectionString: await testOperatorDatabaseUrl() });
    await op.connect();
    const app = new pg.Client({ connectionString: testRuntimeDatabaseUrl() });
    await app.connect();
    try {
      await expect(op.query("UPDATE instance_audit_events SET action = 'x'")).rejects.toMatchObject(
        {
          code: "42501"
        }
      );
      await expect(op.query("DELETE FROM instance_audit_events")).rejects.toMatchObject({
        code: "42501"
      });
      await expect(app.query("SELECT 1 FROM instance_audit_events")).rejects.toMatchObject({
        code: "42501"
      });
    } finally {
      await op.end();
      await app.end();
    }
  });

  it("a revoked grant stops opening the door", async () => {
    const list = await tenant.instanceOperators.list(BOOTSTRAP_OPERATOR_TOKEN);
    const live = list.items.find((g) => g.userId === operatorUserId && g.revokedAt === null)!;
    await operatorUser.instanceOperators.revoke(live.id);
    expect((await apiError(() => operatorUser.stack.requestUpgrade())).status).toBe(403);
    expect(await operatorUser.instanceOperators.self()).toBe(false);
    expect((await auditActions()).at(-1)).toBe("instance.operator.revoke");
  });

  it("the request-serving role cannot write the stack or grant the role — asserted AS scp_app", async () => {
    const app = new pg.Client({ connectionString: testRuntimeDatabaseUrl() });
    await app.connect();
    try {
      for (const q of [
        "UPDATE stack_backends SET enabled = true WHERE backend = 'argo-events'",
        "INSERT INTO stack_backends (backend, enabled) VALUES ('gitea', true)",
        "UPDATE stack_settings SET upgrade_generation = 99",
        `INSERT INTO instance_operator_grants (id, org_id, user_id, granted_by)
           VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), '{}')`
      ]) {
        await expect(app.query(q), q).rejects.toMatchObject({ code: "42501" });
      }
    } finally {
      await app.end();
    }
  });

  it("THE M29.1 SEAM: the bootstrap admin is granted the role only when asked, and only while no grant is live", async () => {
    const org = await createTestOrg(server, "m29-4-seam");
    const skipped = await grantBootstrapInstanceOperator(
      server.deps,
      { orgId: org.orgId, username: org.adminUsername },
      {}
    );
    expect(skipped).toBe("skipped");
    // All grants are revoked at this point (the case above), so the seam grants.
    const granted = await grantBootstrapInstanceOperator(
      server.deps,
      { orgId: org.orgId, username: org.adminUsername },
      { SCP_BOOTSTRAP_INSTANCE_OPERATOR: "1" }
    );
    expect(granted).toBe("granted");
    const seamAdmin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    expect(await seamAdmin.instanceOperators.self()).toBe(true);
    expect(
      await grantBootstrapInstanceOperator(
        server.deps,
        { orgId: org.orgId, username: org.adminUsername },
        { SCP_BOOTSTRAP_INSTANCE_OPERATOR: "1" }
      )
    ).toBe("exists");
    const last = (await seamAdmin.instanceOperators.auditEvents()).items.at(-1)!;
    expect(last).toMatchObject({
      action: "instance.operator.grant",
      actor: { mechanism: "install" }
    });
  });

  it("re-provisioning is idempotent; a new install secret revokes the old credential BY ID", async () => {
    expect(
      await provisionInstallTimePrincipals(admin, server.deps.config, {
        SCP_STACKD_OPERATOR_CREDENTIAL: STACKD_TOKEN
      })
    ).toEqual(["stack controller credential unchanged"]);
    // A person mints a credential with the install credential's NAME: rotation must not touch it.
    const lookalike = await createOperatorCredential(server.deps.config, {
      name: STACKD_INSTALL_CREDENTIAL_NAME,
      createdByUserId: null,
      expiresAt: null
    });
    await provisionInstallTimePrincipals(admin, server.deps.config, {
      SCP_STACKD_CREDENTIAL_TOKEN_ID: "stackdInstallTok2",
      SCP_STACKD_CREDENTIAL_SHA256: (await import("node:crypto"))
        .createHash("sha256")
        .update("r".repeat(43))
        .digest("hex")
    });
    expect((await apiError(() => controller.stack.spec(STACKD_TOKEN))).status).toBe(403);
    expect((await controller.stack.spec(STACKD_TOKEN_ROTATED)).backends.length).toBeGreaterThan(0);
    const lookalikeRow = await admin.query<{ revoked_at: Date | null }>(
      "SELECT revoked_at FROM instance_operator_credentials WHERE id = $1",
      [lookalike.id]
    );
    expect(lookalikeRow.rows[0]!.revoked_at).toBeNull();
    const rows = await admin.query<{ token_hash: string; scope: string }>(
      "SELECT token_hash, scope FROM instance_operator_credentials WHERE token_id LIKE 'stackdInstallTok%'"
    );
    for (const r of rows.rows) {
      expect(r.scope).toBe("stack-controller");
      expect(r.token_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(r.token_hash).not.toContain("r".repeat(43));
    }
  });

  it("an operator's revocation survives the next upgrade's provisioning", async () => {
    await admin.query(
      "UPDATE instance_operator_credentials SET revoked_at = now() WHERE token_id = 'stackdInstallTok2'"
    );
    const log = await provisionInstallTimePrincipals(admin, server.deps.config, {
      SCP_STACKD_OPERATOR_CREDENTIAL: STACKD_TOKEN_ROTATED
    });
    expect(log[0]).toContain("REVOKED");
    expect((await apiError(() => controller.stack.spec(STACKD_TOKEN_ROTATED))).status).toBe(403);
  });

  it("the chart-generated scp_operator login is provisioned only on request, and only for scp_operator", async () => {
    expect(
      await provisionInstallTimePrincipals(admin, server.deps.config, {
        SCP_PROVISION_OPERATOR_ROLE: "1"
      })
    ).toEqual(["scp_operator login provisioned"]);
    await expect(
      provisionInstallTimePrincipals(
        admin,
        { ...server.deps.config, operatorDatabaseUrl: testRuntimeDatabaseUrl() },
        { SCP_PROVISION_OPERATOR_ROLE: "1" }
      )
    ).rejects.toThrow(/refusing to provision 'scp_app'/);
  });

  it("malformed install material is refused, never recorded", async () => {
    await expect(
      provisionInstallTimePrincipals(admin, server.deps.config, {
        SCP_STACKD_OPERATOR_CREDENTIAL: "scp_op_short.x"
      })
    ).rejects.toThrow(/not a well-formed/);
    await expect(
      provisionInstallTimePrincipals(admin, server.deps.config, {
        SCP_STACKD_CREDENTIAL_TOKEN_ID: "stackdInstallTok9",
        SCP_STACKD_CREDENTIAL_SHA256: "not-hex"
      })
    ).rejects.toThrow(/not well-formed/);
  });
});
