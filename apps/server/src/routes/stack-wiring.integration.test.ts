import { createHash } from "node:crypto";
import pg from "pg";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpApiError, ScpClient } from "@scp/sdk";
import type { PutStackWiringRequest } from "@scp/schemas";
import { mintSelfSignedCertificate } from "@scp/stackd";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  testDatabaseUrl,
  testOperatorDatabaseUrl,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { provisionInstallTimePrincipals } from "../db/provision-install.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { resolveExecutorPluginInstance } from "../coordination/executor-bindings-repo.js";
import { STACK_TOKEN_SECRET_FIELD } from "../stack/wired-routing.js";

/**
 * M29.2 — THE STANDARD STACK'S WIRING, server side (ADR-0061). A real scpd on Testcontainers
 * Postgres writing through a real `scp_operator` login; the controller is played by its own
 * install-time credential and nothing else. What this file proves, each against the M28 class
 * ("a value that decides WHERE work goes or WITH WHAT AUTHORITY, writable by someone who cannot
 * grant it"):
 *
 *   - only the controller's credential hands a wiring over (not a full operator credential, not a
 *     session), and the token lands encrypted at the instance tier — never in an org's secret
 *     store, never in the audit chain;
 *   - the hand-off registers an execution system in the bootstrap org by default, and in another org
 *     only once an instance operator serves it;
 *   - a binding to that system is routed by the WIRING: endpoint, token, CA, and an internal-egress
 *     allowance pinned to the endpoint's host with no SCP_INTERNAL_EGRESS_HOSTS entry;
 *   - a tenant's attempt to re-point it, re-trust it or delete it is REFUSED — and a property
 *     rewritten anyway (by any path) still routes nowhere else;
 *   - a tenant system aimed at the bundled endpoint gets neither the token nor the egress;
 *   - an unserved org can read no stack token, even inside its own tenant transaction;
 *   - unwiring (disable) makes the registration refuse to resolve.
 */

const BOOTSTRAP_OPERATOR_TOKEN = "m29-2-wiring-bootstrap-operator-token";
const STACKD_TOKEN = "scp_op_stackdWiringTok01." + "w".repeat(43);
const MINTED = "argocd-scoped-token-DO-NOT-LEAK-6f1c";
const ARGOCD_URL = "http://argocd-server.scp-argocd.svc";
const WORKFLOWS_URL = "https://argo-server.scp-argo-workflows.svc:2746";

async function apiError(fn: () => Promise<unknown>): Promise<ScpApiError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ScpApiError) return err;
    throw err;
  }
  throw new Error("expected an ScpApiError, but the call succeeded");
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function argocdWiring(over: Partial<PutStackWiringRequest> = {}): PutStackWiringRequest {
  return {
    serverUrl: ARGOCD_URL,
    namespace: null,
    caPem: null,
    account: "scp-coordinator",
    token: MINTED,
    factsSha256: sha("argocd-facts-1"),
    rotationGeneration: 0,
    ...over
  };
}

describe("M29.2 the Standard Stack wires its backends into SCP (Testcontainers, real scp_operator)", () => {
  let server: ListeningTestServer;
  let bootstrap: TestOrg;
  let other: TestOrg;
  let tenant: ScpClient;
  let otherTenant: ScpClient;
  let controller: ScpClient;
  let admin: pg.Pool;
  const ca = mintSelfSignedCertificate({
    commonName: "argo-server.scp-argo-workflows.svc",
    dnsNames: ["argo-server.scp-argo-workflows.svc"],
    validDays: 30
  });

  const view = async (c: ScpClient = tenant) => c.stack.get();
  const registrationIdIn = async (orgId: string, backend: string): Promise<string | undefined> =>
    (
      await admin.query<{ object_id: string }>(
        "SELECT object_id FROM stack_backend_registrations WHERE org_id = $1 AND backend = $2",
        [orgId, backend]
      )
    ).rows[0]?.object_id;
  const resolveFor = (orgId: string, targetObjectId: string) =>
    withTenantTx(server.deps.db, orgId, (tx) =>
      resolveExecutorPluginInstance(tx, {
        orgId,
        targetObjectId,
        masterKey: server.deps.config.secretsMasterKey
      })
    );

  beforeAll(async () => {
    server = await listenTestServer({
      operatorToken: BOOTSTRAP_OPERATOR_TOKEN,
      operatorDatabaseUrl: await testOperatorDatabaseUrl()
    });
    admin = new pg.Pool({ connectionString: testDatabaseUrl(), max: 2 });
    await provisionInstallTimePrincipals(admin, server.deps.config, {
      SCP_STACKD_OPERATOR_CREDENTIAL: STACKD_TOKEN
    });
    bootstrap = await createTestOrg(server, "m29-2-bootstrap");
    other = await createTestOrg(server, "m29-2-other");
    // This org IS the deployment's bootstrap org for the default-serve rule.
    server.deps.config.bootstrapOrgName = bootstrap.orgName;
    tenant = new ScpClient({ baseUrl: server.baseUrl, token: bootstrap.adminToken });
    otherTenant = new ScpClient({ baseUrl: server.baseUrl, token: other.adminToken });
    controller = new ScpClient({ baseUrl: server.baseUrl });
    // A clean instance tier: another file in this worker may have used the stack.
    await admin.query(
      "TRUNCATE stack_backend_wirings, stack_backend_tokens, stack_served_orgs, stack_backend_registrations"
    );
    await admin.query(
      "UPDATE stack_settings SET served_orgs_initialized = false WHERE id = 'instance'"
    );
    for (const b of ["argocd", "argo-workflows", "argo-events"] as const) {
      await tenant.stack.putBackend(b, { enabled: true }, BOOTSTRAP_OPERATOR_TOKEN);
    }
  });

  afterAll(async () => {
    await admin?.end();
    await server?.close();
  });

  it("only the controller's own credential hands a wiring over — not an operator credential, not a session", async () => {
    const asOperator = await apiError(() =>
      tenant.stack.putWiring("argocd", argocdWiring(), BOOTSTRAP_OPERATOR_TOKEN)
    );
    expect(asOperator.status).toBe(403);
    const asSession = await apiError(() =>
      tenant.stack.putWiring("argocd", argocdWiring(), "not-a-credential")
    );
    expect(asSession.status).toBe(403);
    expect((await admin.query("SELECT 1 FROM stack_backend_wirings")).rows).toHaveLength(0);
  });

  it("the hand-off is refused when it names anything but an in-cluster Service, or the wrong shape", async () => {
    for (const bad of [
      argocdWiring({ serverUrl: "https://attacker.example.com" }),
      argocdWiring({ serverUrl: "http://argocd-server.scp-argocd.svc/path" }),
      argocdWiring({ serverUrl: "http://user:pw@argocd-server.scp-argocd.svc" }),
      argocdWiring({ token: null }),
      argocdWiring({
        caPem: "not a certificate",
        serverUrl: "https://argocd-server.scp-argocd.svc"
      })
    ]) {
      expect(
        (await apiError(() => controller.stack.putWiring("argocd", bad, STACKD_TOKEN))).status
      ).toBe(400);
    }
    // Argo Rollouts is not wired (SCP never calls it), and Argo Events carries no endpoint/token.
    expect(
      (
        await apiError(() =>
          controller.stack.putWiring("argo-rollouts", argocdWiring(), STACKD_TOKEN)
        )
      ).status
    ).toBe(400);
    expect(
      (
        await apiError(() =>
          controller.stack.putWiring("argo-events", argocdWiring(), STACKD_TOKEN)
        )
      ).status
    ).toBe(400);
    // A backend an operator has disabled is not wired, whatever the controller says.
    expect(
      (
        await apiError(() =>
          controller.stack.putWiring(
            "gitea",
            argocdWiring({ serverUrl: "http://scp-gitea-http.scp-gitea.svc:3000" }),
            STACKD_TOKEN
          )
        )
      ).status
    ).toBe(409);
  });

  it("wires Argo CD: token encrypted at the instance tier, bootstrap org served, execution system registered — nothing printed, nothing stored in the org", async () => {
    await controller.stack.putWiring("argocd", argocdWiring(), STACKD_TOKEN);

    const tok = await admin.query<{ ciphertext: string }>(
      "SELECT ciphertext FROM stack_backend_tokens WHERE backend = 'argocd'"
    );
    expect(tok.rows).toHaveLength(1);
    expect(tok.rows[0]!.ciphertext).not.toContain(MINTED);
    // Never in any org's secret store, never in any table as plaintext, never in the audit chain.
    const dump = await admin.query<{ t: string }>(
      `SELECT string_agg(t::text, ' ') AS t FROM (
         SELECT row_to_json(s)::text AS t FROM secrets s
         UNION ALL SELECT row_to_json(w)::text FROM stack_backend_wirings w
         UNION ALL SELECT row_to_json(a)::text FROM instance_audit_events a
         UNION ALL SELECT row_to_json(o)::text FROM objects o) x`
    );
    expect(dump.rows[0]!.t).not.toContain(MINTED);
    const audit = (await tenant.instanceOperators.auditEvents(BOOTSTRAP_OPERATOR_TOKEN)).items;
    expect(audit.map((e) => e.action)).toEqual(
      expect.arrayContaining([
        "stack.backend.wire",
        "stack.org.attach",
        "stack.registration.create"
      ])
    );

    const served = await tenant.stack.orgs(BOOTSTRAP_OPERATOR_TOKEN);
    expect(served.items.map((o) => o.orgId)).toEqual([bootstrap.orgId]);
    expect(served.items[0]!.attachedBy.mechanism).toBe("install");

    const sysId = await registrationIdIn(bootstrap.orgId, "argocd");
    expect(sysId).toBeDefined();
    const sys = await tenant.object("execution-system").get(sysId!);
    expect(sys.properties).toMatchObject({
      kind: "argocd",
      serverUrl: ARGOCD_URL,
      allowInternalEgress: true,
      stack: { backend: "argocd", managedBy: "scp-stackd" }
    });
    expect(sys.properties).not.toHaveProperty("tokenSecretKey");

    const v = await view();
    expect(v.servesThisOrg).toBe(true);
    const argocd = v.backends.find((b) => b.backend === "argocd")!;
    expect(argocd.wiring).toMatchObject({
      wired: true,
      serverUrl: ARGOCD_URL,
      account: "scp-coordinator"
    });
    expect(v.backends.find((b) => b.backend === "argo-rollouts")!.wiring).toBeNull();
    // The controller sees a hash and a counter — never the endpoint or the token.
    const spec = await controller.stack.spec(STACKD_TOKEN);
    expect(spec.wiring.find((w) => w.backend === "argocd")).toEqual({
      backend: "argocd",
      factsSha256: sha("argocd-facts-1"),
      rotationGeneration: 0
    });
    expect(JSON.stringify(spec)).not.toContain(ARGOCD_URL);
  });

  it("a binding to the registration is routed by the WIRING — endpoint, token, egress pinned to its host — with no SCP_INTERNAL_EGRESS_HOSTS entry", async () => {
    expect(process.env.SCP_INTERNAL_EGRESS_HOSTS ?? "").not.toContain("argocd-server");
    const sysId = (await registrationIdIn(bootstrap.orgId, "argocd"))!;
    const comp = await createTestComponent(tenant, { name: "wired-comp" });
    await tenant.executors.putBinding(comp.id, { executionSystemId: sysId });
    const resolved = await resolveFor(bootstrap.orgId, comp.id);
    expect(resolved!.instanceConfig).toMatchObject({
      module: "argocd",
      id: `execution-system:${sysId}`,
      allowedHosts: ["argocd-server.scp-argocd.svc"],
      allowInternalEgress: true,
      secrets: { [STACK_TOKEN_SECRET_FIELD]: MINTED }
    });
    expect(resolved!.instanceConfig.config).toMatchObject({
      serverUrl: ARGOCD_URL,
      tokenSecretKey: STACK_TOKEN_SECRET_FIELD
    });
    expect(resolved!.instanceConfig.trustedCaPem).toBeUndefined();
  });

  it("the Argo Workflows wiring carries its CA and namespace, and the resolver hands the CA to that instance only", async () => {
    await controller.stack.putWiring(
      "argo-workflows",
      {
        serverUrl: WORKFLOWS_URL,
        namespace: "scp-argo-workflows",
        caPem: ca.certPem,
        account: "scp-coordinator",
        token: "sa-token-for-scp-coordinator",
        factsSha256: sha("wf-facts-1"),
        rotationGeneration: 0
      },
      STACKD_TOKEN
    );
    const sysId = (await registrationIdIn(bootstrap.orgId, "argo-workflows"))!;
    const comp = await createTestComponent(tenant, { name: "wf-comp" });
    await tenant.executors.putBinding(comp.id, { executionSystemId: sysId });
    const resolved = (await resolveFor(bootstrap.orgId, comp.id))!.instanceConfig;
    expect(resolved.trustedCaPem).toBe(ca.certPem);
    expect(resolved.config).toMatchObject({
      serverUrl: WORKFLOWS_URL,
      namespace: "scp-argo-workflows"
    });
    expect(resolved.allowedHosts).toEqual(["argo-server.scp-argo-workflows.svc"]);
    const w = (await view()).backends.find((b) => b.backend === "argo-workflows")!.wiring!;
    expect(w.caSha256).toBe(sha(ca.certPem.trim()));
  });

  it("Argo Events registers with no endpoint and no token — nothing can be bound to it", async () => {
    await controller.stack.putWiring(
      "argo-events",
      {
        serverUrl: null,
        namespace: null,
        caPem: null,
        account: null,
        token: null,
        factsSha256: sha("events"),
        rotationGeneration: 0
      },
      STACKD_TOKEN
    );
    const sysId = (await registrationIdIn(bootstrap.orgId, "argo-events"))!;
    const sys = await tenant.object("execution-system").get(sysId);
    expect(sys.properties).toEqual({
      kind: "argo-events",
      stack: { backend: "argo-events", managedBy: "scp-stackd" }
    });
    const comp = await createTestComponent(tenant, { name: "events-comp" });
    expect(
      (await apiError(() => tenant.executors.putBinding(comp.id, { executionSystemId: sysId })))
        .status
    ).toBe(400);
  });

  it("a TENANT cannot re-point, re-trust or delete a wired system — an OrgAdmin with secret:write included", async () => {
    const sysId = (await registrationIdIn(bootstrap.orgId, "argocd"))!;
    const sys = await tenant.object("execution-system").get(sysId);
    const repoint = await apiError(() =>
      tenant.object("execution-system").update(sysId, {
        properties: { ...(sys.properties as object), serverUrl: "http://evil.attacker.svc" },
        version: sys.version
      })
    );
    expect(repoint.status).toBe(409);
    expect(repoint.problem?.detail).toMatch(/Standard Stack's registration of the bundled argocd/);
    const retrust = await apiError(() =>
      tenant.object("execution-system").update(sysId, {
        properties: { ...(sys.properties as object), caPem: ca.certPem, tokenSecretKey: "mine" },
        version: sys.version
      })
    );
    expect(retrust.status).toBe(409);
    expect((await apiError(() => tenant.object("execution-system").delete(sysId))).status).toBe(
      409
    );
    const after = await tenant.object("execution-system").get(sysId);
    expect(after.properties).toEqual(sys.properties);
  });

  it("…and a property rewritten ANYWAY (any write path, even raw SQL) still routes only where the wiring says", async () => {
    const sysId = (await registrationIdIn(bootstrap.orgId, "argocd"))!;
    await admin.query(
      `UPDATE objects SET properties = properties || '{"serverUrl":"http://evil.attacker.svc","tokenSecretKey":"stolen","allowInternalEgress":true}'::jsonb
        WHERE id = $1`,
      [sysId]
    );
    const comp = await createTestComponent(tenant, { name: "rewritten-comp" });
    await tenant.executors.putBinding(comp.id, { executionSystemId: sysId });
    const resolved = (await resolveFor(bootstrap.orgId, comp.id))!.instanceConfig;
    expect(resolved.config).toMatchObject({ serverUrl: ARGOCD_URL });
    expect(resolved.allowedHosts).toEqual(["argocd-server.scp-argocd.svc"]);
    expect(resolved.secrets).toEqual({ [STACK_TOKEN_SECRET_FIELD]: MINTED });
  });

  it("a tenant's OWN system aimed at the bundled endpoint gets neither the token nor the internal egress", async () => {
    await tenant.secrets.put("mine", { value: "tenant-token" });
    const own = await tenant.object("execution-system").create({
      name: "my-argocd",
      properties: {
        kind: "argocd",
        serverUrl: ARGOCD_URL,
        tokenSecretKey: STACK_TOKEN_SECRET_FIELD,
        allowInternalEgress: true
      }
    });
    const comp = await createTestComponent(tenant, { name: "own-comp" });
    await tenant.executors.putBinding(comp.id, { executionSystemId: own.id });
    const resolved = (await resolveFor(bootstrap.orgId, comp.id))!.instanceConfig;
    // No layer-1 allowlist entry for it: the bundled host is allowed only to the registration.
    expect(resolved.allowInternalEgress).toBe(false);
    expect(resolved.secrets).toEqual({});
    expect(resolved.trustedCaPem).toBeUndefined();
  });

  it("a DISCOVERY run against the registration takes the endpoint, token, CA and egress from the wiring — a caller's baseUrl/serverUrl/token are dropped", async () => {
    const sysId = (await registrationIdIn(bootstrap.orgId, "argocd"))!;
    const started: Record<string, unknown>[] = [];
    const previous = server.deps.pluginHost;
    server.deps.pluginHost = {
      start: async (instances: Record<string, unknown>[]) => {
        started.push(...instances);
      },
      discovery: () => ({ discover: async () => ({ objects: [], relationships: [] }) })
    } as never;
    try {
      await tenant.discovery.run({
        pluginModule: "argocd-discovery",
        pluginInstanceId: "wiring-discovery-probe",
        config: {
          executionSystemId: sysId,
          baseUrl: "http://evil.attacker.svc",
          serverUrl: "http://evil.attacker.svc",
          token: "tenant-chosen",
          tokenSecretKey: "mine",
          // Not on the denylist the first cut used — an ALLOWLIST drops it anyway.
          privateKeySecretKey: STACK_TOKEN_SECRET_FIELD
        }
      });
      // A different module against the registration is refused, not run with the stack token.
      const wrongModule = await apiError(() =>
        tenant.discovery.run({
          pluginModule: "github-discovery",
          pluginInstanceId: "wiring-discovery-probe",
          config: { executionSystemId: sysId, owner: "x", repo: "y" }
        } as never)
      );
      expect(wrongModule.status).toBe(400);
      expect(wrongModule.problem?.detail).toMatch(/runs 'argocd-discovery'/);
    } finally {
      server.deps.pluginHost = previous;
    }
    expect(started).toHaveLength(1);
    // The host's instance id is the server's, namespaced by org: the same caller id from another
    // org is another instance, never this one's config and token.
    expect((started[0] as { id: string }).id).toBe(
      `discovery:${bootstrap.orgId}:wiring-discovery-probe`
    );
    expect((started[0] as { config: object }).config).not.toHaveProperty("privateKeySecretKey");
    const inst = started[0] as {
      config: Record<string, unknown>;
      secrets: Record<string, string>;
      allowedHosts: string[];
      allowInternalEgress: boolean;
    };
    expect(inst.config).toMatchObject({
      serverUrl: ARGOCD_URL,
      tokenSecretKey: STACK_TOKEN_SECRET_FIELD,
      executionSystemId: sysId
    });
    expect(inst.config).not.toHaveProperty("baseUrl");
    expect(inst.config).not.toHaveProperty("token");
    expect(inst.secrets).toEqual({ [STACK_TOKEN_SECRET_FIELD]: MINTED });
    expect(inst.allowedHosts).toEqual(["argocd-server.scp-argocd.svc"]);
    expect(inst.allowInternalEgress).toBe(true);
  });

  it("another org is NOT served until an instance operator serves it — and cannot read a stack token even in its own tenant tx", async () => {
    expect(await registrationIdIn(other.orgId, "argocd")).toBeUndefined();
    expect((await view(otherTenant)).servesThisOrg).toBe(false);
    const rls = await withTenantTx(server.deps.db, other.orgId, (tx) =>
      tx.execute(sql`SELECT backend FROM stack_backend_tokens`)
    );
    expect(rls.rows).toHaveLength(0);
    // An org cannot serve itself: the door needs instance authority.
    expect((await apiError(() => otherTenant.stack.attachOrg(other.orgId))).status).toBe(403);

    // ONE SERVED ORG UNTIL M29.6 (owner decision 2026-09-25): the backends' accounts are shared,
    // so a second org is refused with the reason, and nothing is registered there.
    const refused = await apiError(() =>
      tenant.stack.attachOrg(other.orgId, BOOTSTRAP_OPERATOR_TOKEN)
    );
    expect(refused.status).toBe(409);
    expect(refused.problem?.detail).toMatch(/M29\.6/);
    expect(refused.problem?.detail).toMatch(/same Argo CD account and Gitea identity/);
    expect(await registrationIdIn(other.orgId, "argocd")).toBeUndefined();
    expect((await view(otherTenant)).servesThisOrg).toBe(false);

    // MOVING the stack is allowed: detach the served org, then serve the other.
    await tenant.stack.detachOrg(bootstrap.orgId, BOOTSTRAP_OPERATOR_TOKEN);
    await tenant.stack.attachOrg(other.orgId, BOOTSTRAP_OPERATOR_TOKEN);
    const sysId = await registrationIdIn(other.orgId, "argocd");
    expect(sysId).toBeDefined();
    expect((await view(otherTenant)).servesThisOrg).toBe(true);
    const comp = await createTestComponent(otherTenant, { name: "other-comp" });
    await otherTenant.executors.putBinding(comp.id, { executionSystemId: sysId! });
    expect((await resolveFor(other.orgId, comp.id))!.instanceConfig.config).toMatchObject({
      serverUrl: ARGOCD_URL
    });

    await tenant.stack.detachOrg(other.orgId, BOOTSTRAP_OPERATOR_TOKEN);
    await expect(resolveFor(other.orgId, comp.id)).rejects.toThrow(
      /does not serve this organization/
    );
    const after = await withTenantTx(server.deps.db, other.orgId, (tx) =>
      tx.execute(sql`SELECT backend FROM stack_backend_tokens`)
    );
    expect(after.rows).toHaveLength(0);
    await tenant.stack.attachOrg(bootstrap.orgId, BOOTSTRAP_OPERATOR_TOKEN);
  });

  it("rotation is an audited operator request the controller sees as a counter; the next hand-off satisfies it", async () => {
    const v = await tenant.stack.rotate("argocd", BOOTSTRAP_OPERATOR_TOKEN);
    expect(v.backends.find((b) => b.backend === "argocd")!.rotateGeneration).toBe(1);
    const spec = await controller.stack.spec(STACKD_TOKEN);
    expect(spec.backends.find((b) => b.backend === "argocd")!.rotateGeneration).toBe(1);
    expect(spec.wiring.find((w) => w.backend === "argocd")!.rotationGeneration).toBe(0);
    await controller.stack.putWiring(
      "argocd",
      argocdWiring({ token: "rotated-token", rotationGeneration: 1 }),
      STACKD_TOKEN
    );
    const sysId = (await registrationIdIn(bootstrap.orgId, "argocd"))!;
    const comp = await createTestComponent(tenant, { name: "rotated-comp" });
    await tenant.executors.putBinding(comp.id, { executionSystemId: sysId });
    expect((await resolveFor(bootstrap.orgId, comp.id))!.instanceConfig.secrets).toEqual({
      [STACK_TOKEN_SECRET_FIELD]: "rotated-token"
    });
    // Rotating a backend that holds no credential SCP uses, or a disabled one, is refused.
    expect(
      (await apiError(() => tenant.stack.rotate("argo-rollouts", BOOTSTRAP_OPERATOR_TOKEN))).status
    ).toBe(400);
    expect(
      (await apiError(() => tenant.stack.rotate("gitea", BOOTSTRAP_OPERATOR_TOKEN))).status
    ).toBe(409);
  });

  it("unwiring (the controller disabling it) drops the token; the registration stays and refuses to resolve", async () => {
    const sysId = (await registrationIdIn(bootstrap.orgId, "argocd"))!;
    const comp = await createTestComponent(tenant, { name: "unwired-comp" });
    await tenant.executors.putBinding(comp.id, { executionSystemId: sysId });
    await controller.stack.deleteWiring("argocd", STACKD_TOKEN);
    expect(
      (await admin.query("SELECT 1 FROM stack_backend_tokens WHERE backend = 'argocd'")).rows
    ).toHaveLength(0);
    await expect(resolveFor(bootstrap.orgId, comp.id)).rejects.toThrow(/is not wired/);
    expect((await tenant.object("execution-system").get(sysId)).id).toBe(sysId);
    expect((await view()).backends.find((b) => b.backend === "argocd")!.wiring!.wired).toBe(false);
    // Only the controller may unwire.
    expect(
      (await apiError(() => tenant.stack.deleteWiring("argo-workflows", BOOTSTRAP_OPERATOR_TOKEN)))
        .status
    ).toBe(403);
  });

  it("scp_app — every tenant request — can write none of the wiring tables", async () => {
    for (const stmt of [
      "INSERT INTO stack_backend_wirings (backend, facts_sha256) VALUES ('gitea', 'x')",
      "INSERT INTO stack_backend_tokens (backend, ciphertext, nonce, key_version) VALUES ('gitea','x','y',1)",
      `INSERT INTO stack_served_orgs (org_id, attached_by) VALUES ('${other.orgId}', '{}')`,
      `INSERT INTO stack_backend_registrations (org_id, backend, object_id) VALUES ('${other.orgId}', 'gitea', gen_random_uuid())`,
      "UPDATE stack_backend_wirings SET server_url = 'http://evil.x.svc'"
    ]) {
      const client = await admin.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE scp_app");
        await client.query(`SELECT set_config('app.current_org_id', '${bootstrap.orgId}', true)`);
        await expect(client.query(stmt), stmt).rejects.toThrow(/permission denied/);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    }
  });

  // ---- M29.2 review (the #423 adversarial pass) -------------------------------------------------

  it("the wiring URL is PINNED to the backend's own Service — another in-cluster Service is refused", async () => {
    for (const [backend, bad] of [
      ["argocd", argocdWiring({ serverUrl: "http://argo-server.scp-argo-workflows.svc" })],
      ["argocd", argocdWiring({ serverUrl: "http://argocd-server.tenant-ns.svc" })],
      ["argocd", argocdWiring({ serverUrl: "https://argocd-server.scp-argocd.svc" })],
      [
        "argo-workflows",
        argocdWiring({ serverUrl: WORKFLOWS_URL, namespace: "tenant-ns", caPem: ca.certPem })
      ]
    ] as const) {
      const e = await apiError(() => controller.stack.putWiring(backend, bad, STACKD_TOKEN));
      expect(e.status, JSON.stringify(bad)).toBe(400);
      expect(e.problem?.detail, JSON.stringify(bad)).toMatch(
        /must name its own Service|namespace is the bundled one/
      );
    }
  });

  it("a Standard Stack registration cannot be PUBLISHED — it would journal the in-cluster endpoint to peers", async () => {
    await controller.stack.putWiring("argocd", argocdWiring(), STACKD_TOKEN);
    const id = (await registrationIdIn(bootstrap.orgId, "argocd"))!;
    const e = await apiError(() => tenant.object("execution-system").publish(id));
    expect(e.status).toBe(409);
    expect(e.problem?.detail).toMatch(/Standard Stack's registration/);
    const row = await admin.query("SELECT domain_local FROM objects WHERE id = $1", [id]);
    expect(row.rows[0].domain_local).toBe(true);
  });

  it("one org's registration that cannot converge neither fails the hand-off nor stops another org converging", async () => {
    await controller.stack.putWiring("argocd", argocdWiring(), STACKD_TOKEN);
    // Two served orgs — a state the attach door now refuses to create, seeded directly: the
    // reconcile must isolate orgs whatever the door allows.
    await admin.query(
      "INSERT INTO stack_served_orgs (org_id, attached_by) VALUES ($1, '{}') ON CONFLICT DO NOTHING",
      [other.orgId]
    );
    await controller.stack.putWiring(
      "argocd",
      argocdWiring({ factsSha256: sha("iso-1") }),
      STACKD_TOKEN
    );
    // The reconcile visits orgs in id order: wedge the FIRST, watch the second.
    const [first, second] = [bootstrap.orgId, other.orgId].sort();
    const wedged = (await registrationIdIn(first!, "argocd"))!;
    const healthy = (await registrationIdIn(second!, "argocd"))!;
    await admin.query("UPDATE objects SET deleted_at = now() WHERE id = $1", [wedged]);
    await admin.query(
      `UPDATE objects SET properties = jsonb_set(properties, '{serverUrl}', '"http://drift.x.svc"') WHERE id = $1`,
      [healthy]
    );
    try {
      // A rotation hand-off: the controller revokes the old token on this success, so it must
      // succeed once the token is stored, whatever registering does afterwards.
      await controller.stack.putWiring(
        "argocd",
        argocdWiring({ token: "after-wedge", factsSha256: sha("iso-2") }),
        STACKD_TOKEN
      );
      const stored = await admin.query(
        "SELECT facts_sha256 FROM stack_backend_wirings WHERE backend = 'argocd'"
      );
      expect(stored.rows[0].facts_sha256).toBe(sha("iso-2"));
      const props = await admin.query("SELECT properties FROM objects WHERE id = $1", [healthy]);
      expect(props.rows[0].properties.serverUrl).toBe(ARGOCD_URL);
    } finally {
      await admin.query("UPDATE objects SET deleted_at = NULL WHERE id = $1", [wedged]);
      await admin.query("DELETE FROM stack_served_orgs WHERE org_id = $1", [other.orgId]);
    }
  });

  it("an attach that COMMITTED reports success even when that org's registration cannot converge", async () => {
    await controller.stack.putWiring("argocd", argocdWiring(), STACKD_TOKEN);
    // `other` holds a registration (from the move above) whose object is wedged.
    const wedged = (await registrationIdIn(other.orgId, "argocd"))!;
    await admin.query("UPDATE objects SET deleted_at = now() WHERE id = $1", [wedged]);
    await tenant.stack.detachOrg(bootstrap.orgId, BOOTSTRAP_OPERATOR_TOKEN);
    try {
      const served = await tenant.stack.attachOrg(other.orgId, BOOTSTRAP_OPERATOR_TOKEN);
      expect(JSON.stringify(served)).toContain(other.orgId);
    } finally {
      await admin.query("UPDATE objects SET deleted_at = NULL WHERE id = $1", [wedged]);
      await admin.query("DELETE FROM stack_served_orgs WHERE org_id = $1", [other.orgId]);
      await tenant.stack.attachOrg(bootstrap.orgId, BOOTSTRAP_OPERATOR_TOKEN);
    }
  });
});
