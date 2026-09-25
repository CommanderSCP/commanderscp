import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpApiError, ScpClient } from "@scp/sdk";
import { StackBackendSchema, type PutStackStatusRequest } from "@scp/schemas";
import {
  createTestOrg,
  listenTestServer,
  testDatabaseUrl,
  testOperatorDatabaseUrl,
  testRuntimeDatabaseUrl,
  type ListeningTestServer
} from "../test-support/harness.js";
import { provisionInstallTimePrincipals } from "../db/provision-install.js";
import { STACKD_INSTALL_CREDENTIAL_NAME } from "../auth/operator-auth.js";

/**
 * M29.4 — THE STANDARD STACK'S API, end to end (ADR-0058, E2).
 *
 * The server under test writes through a REAL `scp_operator` login, never the harness superuser:
 * the tables are FORCE-RLS, operator-write, and a superuser would make every write case below pass
 * whether or not drizzle/0126 granted anything.
 */

const BOOTSTRAP_OPERATOR_TOKEN = "m29-4-stack-bootstrap-operator-token";
// A well-formed install-time controller credential, as the chart generates it.
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
        detail: ["deployment scp-argo-events/controller-manager 1/1 available"]
      }
    ],
    ...over
  };
}

describe("M29.4 the Standard Stack API (Testcontainers, real scp_operator writes)", () => {
  let server: ListeningTestServer;
  let tenant: ScpClient;
  /** No session at all — exactly what the stack controller holds. */
  let controller: ScpClient;
  let admin: pg.Pool;

  beforeAll(async () => {
    const operatorDatabaseUrl = await testOperatorDatabaseUrl();
    server = await listenTestServer({
      operatorToken: BOOTSTRAP_OPERATOR_TOKEN,
      operatorDatabaseUrl
    });
    const org = await createTestOrg(server, "m29-4-stack");
    tenant = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    controller = new ScpClient({ baseUrl: server.baseUrl });
    admin = new pg.Pool({ connectionString: testDatabaseUrl(), max: 2 });
    // What the migrations Job does on a Helm install with stackd enabled.
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
    }
    expect(view.controller).toEqual({
      release: null,
      lastSeenAt: null,
      reporting: false,
      observedUpgradeGeneration: null
    });
    expect(view.settings).toEqual({ updatePolicy: "automatic", upgradeGeneration: 0 });
  });

  it("a tenant session alone cannot enable a backend — no org role grants cluster software", async () => {
    const err = await apiError(() =>
      tenant.stack.putBackend("argo-events", { enabled: true }, "not-the-operator-token")
    );
    expect(err.status).toBe(403);
    expect(
      (await tenant.stack.get()).backends.find((b) => b.backend === "argo-events")?.enabled
    ).toBe(false);
  });

  it("an operator enables a backend, and the write lands through scp_operator", async () => {
    const view = await tenant.stack.putBackend(
      "argo-events",
      { enabled: true, sizeTier: "medium" },
      BOOTSTRAP_OPERATOR_TOKEN
    );
    const events = view.backends.find((b) => b.backend === "argo-events");
    expect(events).toMatchObject({ enabled: true, sizeTier: "medium", status: null });
    // Omitting the tier keeps it.
    const again = await tenant.stack.putBackend(
      "argo-events",
      { enabled: true },
      BOOTSTRAP_OPERATOR_TOKEN
    );
    expect(again.backends.find((b) => b.backend === "argo-events")?.sizeTier).toBe("medium");
  });

  it("the controller reads the spec with its install-time credential ALONE — no session", async () => {
    const spec = await controller.stack.spec(STACKD_TOKEN);
    expect(spec.backends).toHaveLength(StackBackendSchema.options.length);
    expect(spec.backends.find((b) => b.backend === "argo-events")).toEqual({
      backend: "argo-events",
      enabled: true,
      sizeTier: "medium"
    });
    expect(spec.settings.updatePolicy).toBe("automatic");
  });

  it("without an operator credential the controller doors are shut", async () => {
    expect((await apiError(() => controller.stack.spec("scp_op_nope.nope"))).status).toBe(403);
    expect(
      (await apiError(() => controller.stack.putStatus(report(), "scp_op_nope.nope"))).status
    ).toBe(403);
  });

  it("a status report lands on the read model, and never changes what is desired", async () => {
    // Report a backend nobody enabled: its status is recorded, its spec stays disabled.
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
            detail: []
          }
        ]
      }),
      STACKD_TOKEN
    );
    const view = await tenant.stack.get();
    expect(view.controller.release).toBe("1.0.0-rc.0");
    expect(view.controller.reporting).toBe(true);
    const events = view.backends.find((b) => b.backend === "argo-events")!;
    expect(events.enabled).toBe(true);
    expect(events.sizeTier).toBe("medium");
    expect(events.status).toMatchObject({ phase: "ready", runningVersion: "1.0.0-rc.0" });
    const gitea = view.backends.find((b) => b.backend === "gitea")!;
    expect(gitea.enabled).toBe(false);
    expect(gitea.status?.phase).toBe("disabled");
  });

  it("the controller's evidence is on the operator-gated diagnostics, not the tenant read", async () => {
    const view = await tenant.stack.get();
    expect(JSON.stringify(view)).not.toContain("controller-manager 1/1");
    expect((await apiError(() => tenant.stack.diagnostics("wrong"))).status).toBe(403);
    const diag = await tenant.stack.diagnostics(BOOTSTRAP_OPERATOR_TOKEN);
    expect(diag.backends.find((b) => b.backend === "argo-events")?.detail).toEqual([
      "deployment scp-argo-events/controller-manager 1/1 available"
    ]);
    expect(diag.stack.backends).toHaveLength(StackBackendSchema.options.length);
  });

  it("a duplicated backend in one report is refused whole", async () => {
    const dup = report();
    dup.backends = [dup.backends[0]!, dup.backends[0]!];
    expect((await apiError(() => controller.stack.putStatus(dup, STACKD_TOKEN))).status).toBe(400);
  });

  it("upgrade bumps the generation the controller acts on; settings switch the update policy", async () => {
    const before = (await tenant.stack.get()).settings.upgradeGeneration;
    const after = await tenant.stack.requestUpgrade(BOOTSTRAP_OPERATOR_TOKEN);
    expect(after.settings.upgradeGeneration).toBe(before + 1);
    const manual = await tenant.stack.putSettings(
      { updatePolicy: "manual" },
      BOOTSTRAP_OPERATOR_TOKEN
    );
    expect(manual.settings.updatePolicy).toBe("manual");
    expect((await controller.stack.spec(STACKD_TOKEN)).settings).toEqual({
      updatePolicy: "manual",
      upgradeGeneration: before + 1
    });
    await tenant.stack.putSettings({ updatePolicy: "automatic" }, BOOTSTRAP_OPERATOR_TOKEN);
  });

  it("the request-serving role cannot write either table — asserted AS scp_app", async () => {
    const app = new pg.Client({ connectionString: testRuntimeDatabaseUrl() });
    await app.connect();
    try {
      await expect(
        app.query("UPDATE stack_backends SET enabled = true WHERE backend = 'argo-events'")
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        app.query("INSERT INTO stack_backends (backend, enabled) VALUES ('gitea', true)")
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        app.query("UPDATE stack_settings SET upgrade_generation = 99")
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await app.end();
    }
  });

  it("re-provisioning is idempotent; replacing the install secret revokes the old credential", async () => {
    const again = await provisionInstallTimePrincipals(admin, server.deps.config, {
      SCP_STACKD_OPERATOR_CREDENTIAL: STACKD_TOKEN
    });
    expect(again).toEqual(["stack controller credential unchanged"]);
    await provisionInstallTimePrincipals(admin, server.deps.config, {
      SCP_STACKD_OPERATOR_CREDENTIAL: STACKD_TOKEN_ROTATED
    });
    expect((await apiError(() => controller.stack.spec(STACKD_TOKEN))).status).toBe(403);
    expect((await controller.stack.spec(STACKD_TOKEN_ROTATED)).backends.length).toBeGreaterThan(0);
    // Exactly one live install-time row, and the plaintext is nowhere in the table.
    const rows = await admin.query<{ token_id: string; token_hash: string; revoked: boolean }>(
      `SELECT token_id, token_hash, revoked_at IS NOT NULL AS revoked
         FROM instance_operator_credentials WHERE name = $1`,
      [STACKD_INSTALL_CREDENTIAL_NAME]
    );
    expect(rows.rows.filter((r) => !r.revoked).map((r) => r.token_id)).toEqual([
      "stackdInstallTok2"
    ]);
    for (const r of rows.rows) {
      expect(r.token_hash).not.toContain("r".repeat(43));
      expect(r.token_hash).not.toContain("s".repeat(43));
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
    const log = await provisionInstallTimePrincipals(admin, server.deps.config, {
      SCP_PROVISION_OPERATOR_ROLE: "1"
    });
    expect(log).toEqual(["scp_operator login provisioned"]);
    await expect(
      provisionInstallTimePrincipals(
        admin,
        { ...server.deps.config, operatorDatabaseUrl: testRuntimeDatabaseUrl() },
        { SCP_PROVISION_OPERATOR_ROLE: "1" }
      )
    ).rejects.toThrow(/refusing to provision 'scp_app'/);
  });

  it("a malformed install credential is refused, never recorded", async () => {
    await expect(
      provisionInstallTimePrincipals(admin, server.deps.config, {
        SCP_STACKD_OPERATOR_CREDENTIAL: "scp_op_short.x"
      })
    ).rejects.toThrow(/not a well-formed/);
  });
});
