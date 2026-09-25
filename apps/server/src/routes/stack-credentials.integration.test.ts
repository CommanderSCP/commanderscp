import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpApiError, ScpClient } from "@scp/sdk";
import type { StackCredentialsView } from "@scp/schemas";
import {
  KubeClient,
  installCredentialHooks,
  type ControllerDeps,
  type CredentialApi,
  type KubeObject,
  type KubeRequest,
  type KubeResponse,
  type KubeTransport,
  type StackRelease
} from "@scp/stackd";
import {
  createTestOrg,
  listenTestServer,
  testDatabaseUrl,
  testOperatorDatabaseUrl,
  testRuntimeDatabaseUrl,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { provisionInstallTimePrincipals } from "../db/provision-install.js";

/**
 * M29.5 — CREDENTIALS THROUGH SCP, end to end on real Postgres (ADR-0062). A real scpd writing
 * through a real `scp_operator` login; the stack controller's REAL delivery hook (`@scp/stackd`,
 * `installCredentialHooks`) speaking to scpd with its own install-time credential, and writing
 * into a small in-memory Kubernetes API. scpd SEALS with its own code; the controller OPENS with
 * its own — two independent halves of one construction, meeting here.
 *
 * The DoD lines this file holds:
 *   - the plaintext appears in NO SCP table (a real `pg_dump` of the database, scanned while the
 *     sealed envelope is pending AND after delivery), NO log line (every line the server logs, at
 *     trace level) and NO audit payload (the instance audit rows) — scanned for the value, its
 *     base64 and its hex;
 *   - a REPLAYED envelope (an older row restored) and a REDIRECTED one (its target rewritten in
 *     the table) are refused, and nothing is written;
 *   - the controller's doors open to its credential only; scp_app cannot read the table at all.
 */

const OPERATOR_TOKEN = "m29-5-credentials-operator-token";
const STACKD_TOKEN = "scp_op_stackdCredsTok0001." + "c".repeat(43);
const WF_NS = "scp-argo-workflows";
const exec = promisify(execFile);

async function apiError(fn: () => Promise<unknown>): Promise<ScpApiError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ScpApiError) return err;
    throw err;
  }
  throw new Error("expected an ScpApiError, but the call succeeded");
}

/** The smallest Kubernetes API the delivery needs: Secrets, get / server-side apply / merge patch.
 *  Server-side apply is modelled per field manager for Secret data, the way the API server owns
 *  fields (the kind suite proves the real one). */
class SecretsOnlyKube implements KubeTransport {
  readonly secrets = new Map<string, KubeObject>();
  readonly writes: { namespace: string; name: string; manager: string }[] = [];
  async request(req: KubeRequest): Promise<KubeResponse> {
    const url = new URL(req.path, "https://kube");
    if (url.pathname === "/api/v1") {
      return {
        status: 200,
        body: JSON.stringify({ resources: [{ name: "secrets", kind: "Secret", namespaced: true }] })
      };
    }
    const m = /^\/api\/v1\/namespaces\/([^/]+)\/secrets\/([^/]+)$/.exec(url.pathname);
    if (!m) return { status: 404, body: "{}" };
    const key = `${m[1]}/${m[2]}`;
    const prev = this.secrets.get(key);
    if (req.method === "GET") {
      return prev ? { status: 200, body: JSON.stringify(prev) } : { status: 404, body: "{}" };
    }
    const body = JSON.parse(req.body ?? "{}") as KubeObject;
    const manager = url.searchParams.get("fieldManager") ?? "";
    this.writes.push({ namespace: m[1]!, name: m[2]!, manager });
    if (req.contentType === "application/merge-patch+json") {
      if (!prev) return { status: 404, body: "{}" };
      const data = { ...((prev["data"] as Record<string, string>) ?? {}) };
      for (const [k, v] of Object.entries((body["data"] as Record<string, string | null>) ?? {})) {
        if (v === null) delete data[k];
        else data[k] = v;
      }
      this.secrets.set(key, { ...prev, data });
      return { status: 200, body: "{}" };
    }
    const merged = manager.startsWith("scp-stackd-credential.")
      ? {
          ...((prev?.["data"] as Record<string, string>) ?? {}),
          ...((body["data"] as object) ?? {})
        }
      : ((body["data"] as Record<string, string>) ?? {});
    this.secrets.set(key, { ...body, data: merged });
    return { status: 200, body: "{}" };
  }
  value(name: string, key: string, namespace = WF_NS): string | undefined {
    const raw = (this.secrets.get(`${namespace}/${name}`)?.["data"] as Record<string, string>)?.[
      key
    ];
    return raw === undefined ? undefined : Buffer.from(raw, "base64").toString("utf8");
  }
}

const release: StackRelease = {
  version: "1.0.0",
  chartDir: "chart",
  imageOverrides: {},
  chartValues: {
    bundledExecutor: {
      argocd: { namespace: "scp-argocd" },
      argoWorkflows: { namespace: WF_NS },
      argoEvents: { namespace: "scp-argo-events" },
      argoRollouts: { namespace: "scp-argo-rollouts" },
      gitea: { namespace: "scp-gitea" }
    }
  }
};

describe("M29.5 credentials through SCP (Testcontainers, real scp_operator, the controller's real delivery)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: pg.Pool;
  let people: ScpClient;
  let tenant: ScpClient;
  let controllerClient: ScpClient;
  let kube: SecretsOnlyKube;
  let deps: ControllerDeps;
  const logLines: string[] = [];
  const controllerLog: string[] = [];

  const PLAINTEXT = `gitea-push-${randomBytes(12).toString("hex")}`;
  const forms = (v: string) => [
    v,
    Buffer.from(v).toString("base64"),
    Buffer.from(v).toString("hex"),
    // base64 as the Kubernetes API would carry it, and without padding.
    Buffer.from(v).toString("base64").replace(/=+$/, "")
  ];

  const spec = () => controllerClient.stack.spec(STACKD_TOKEN);
  const tick = async () => deps.credentials!.deliver((await spec()).credentialSealingKeySha256);
  const target = {
    backend: "argo-workflows" as const,
    secretName: "scp-build-registry" as const,
    key: "registryPassword" as const
  };
  const keyState = (v: StackCredentialsView, key: string, secretName = "scp-build-registry") =>
    v.secrets.find((s) => s.secretName === secretName)!.keys.find((k) => k.key === key)!;

  /** A real pg_dump of this worker's database, from inside the Testcontainers postgres. */
  async function pgDump(): Promise<string> {
    const url = new URL(testDatabaseUrl());
    const { stdout: ps } = await exec("docker", ["ps", "--format", "{{.ID}} {{.Ports}}"]);
    const id = ps
      .split("\n")
      .find((l) => l.includes(`:${url.port}->5432/tcp`))
      ?.split(" ")[0];
    if (!id) throw new Error(`no container publishes ${url.port}`);
    const { stdout } = await exec(
      "docker",
      ["exec", id, "pg_dump", "-U", decodeURIComponent(url.username), "-d", url.pathname.slice(1)],
      { maxBuffer: 512 * 1024 * 1024 }
    );
    return stdout;
  }

  const expectNowhere = async (value: string, when: string) => {
    const dump = await pgDump();
    // Known-positive control: the dump is the real database — it contains this org's name.
    expect(dump, "the dump is not of this database").toContain(org.orgName);
    const audit = JSON.stringify(
      (await admin.query("SELECT * FROM instance_audit_events ORDER BY seq")).rows
    );
    expect(audit).toContain("stack.credential.set");
    for (const f of forms(value)) {
      expect(
        dump.includes(f),
        `${when}: the database dump contains the value (${f.slice(0, 6)}…)`
      ).toBe(false);
      expect(logLines.join("\n").includes(f), `${when}: a server log line contains the value`).toBe(
        false
      );
      expect(
        controllerLog.join("\n").includes(f),
        `${when}: a controller log line contains the value`
      ).toBe(false);
      expect(audit.includes(f), `${when}: an audit row contains the value`).toBe(false);
    }
  };

  beforeAll(async () => {
    server = await listenTestServer({
      operatorToken: OPERATOR_TOKEN,
      operatorDatabaseUrl: await testOperatorDatabaseUrl(),
      logSink: { write: (line: string) => logLines.push(line) }
    });
    admin = new pg.Pool({ connectionString: testDatabaseUrl(), max: 2 });
    await provisionInstallTimePrincipals(admin, server.deps.config, {
      SCP_STACKD_OPERATOR_CREDENTIAL: STACKD_TOKEN
    });
    await admin.query("TRUNCATE stack_credentials, stack_workload_identities");
    await admin.query(
      `UPDATE stack_settings SET credential_sealing_key = NULL, credential_sealing_key_sha256 = NULL
        WHERE id = 'instance'`
    );
    org = await createTestOrg(server, "m29-5-creds");
    people = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    tenant = people;
    controllerClient = new ScpClient({ baseUrl: server.baseUrl });
    kube = new SecretsOnlyKube();
    // Exactly the three operations `stackApiFor` builds for them (controller.ts).
    const api: CredentialApi = {
      putSealingKey: (req) => controllerClient.stack.putSealingKey(req, STACKD_TOKEN),
      credentialDeliveries: () => controllerClient.stack.credentialDeliveries(STACKD_TOKEN),
      ackCredentialDelivery: (id, req) =>
        controllerClient.stack.ackCredentialDelivery(id, req, STACKD_TOKEN)
    };
    deps = {
      api,
      kube: new KubeClient(kube),
      release,
      log: (line: string) => controllerLog.push(line)
    } as unknown as ControllerDeps;
    installCredentialHooks(deps, "scp-stackd");
  });

  afterAll(async () => {
    await server?.close();
    await admin?.end();
  });

  it("before the controller has published its key, a value is refused — there is nowhere safe to put it", async () => {
    const err = await apiError(() => people.stack.setCredential(target, PLAINTEXT, OPERATOR_TOKEN));
    expect(err.status).toBe(409);
    expect(err.problem?.detail).toMatch(/sealing key/);
  });

  it("the controller's doors open to its credential only", async () => {
    for (const presented of [OPERATOR_TOKEN, undefined]) {
      const c = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
      expect((await apiError(() => c.stack.credentialDeliveries(presented as string))).status).toBe(
        403
      );
      expect(
        (
          await apiError(() =>
            c.stack.putSealingKey(
              { publicKey: Buffer.alloc(32, 9).toString("base64"), keyId: "a".repeat(64) },
              presented as string
            )
          )
        ).status
      ).toBe(403);
    }
    // A key whose id is not its sha256 is refused even from the controller.
    expect(
      (
        await apiError(() =>
          controllerClient.stack.putSealingKey(
            { publicKey: Buffer.alloc(32, 9).toString("base64"), keyId: "a".repeat(64) },
            STACKD_TOKEN
          )
        )
      ).status
    ).toBe(400);
  });

  it("a value entered through the API is sealed, delivered by the controller into the backend's Secret, and appears in NO table, log line or audit payload", async () => {
    await tick(); // publishes the controller's key
    const view = await people.stack.credentials(OPERATOR_TOKEN);
    expect(view.sealingKey.published).toBe(true);

    // A session WITHOUT the instance-operator role (an org admin) cannot enter one.
    expect((await apiError(() => tenant.stack.setCredential(target, "x"))).status).toBe(403);
    // A target outside the catalog is refused (enum-valid names, not a catalog pair).
    expect(
      (
        await apiError(() =>
          people.stack.setCredential({ ...target, key: "AWS_REGION" }, "x", OPERATOR_TOKEN)
        )
      ).status
    ).toBe(400);

    const pending = await people.stack.setCredential(target, PLAINTEXT, OPERATOR_TOKEN);
    expect(pending).toMatchObject({ state: "pending", pendingOp: "set" });
    expect(pending.requestedBy?.mechanism).toBe("bootstrap-env-token");
    // WHILE PENDING: the sealed envelope is in the database; the value is not.
    const row = (
      await admin.query("SELECT envelope FROM stack_credentials WHERE key = 'registryPassword'")
    ).rows[0] as { envelope: unknown };
    expect(row.envelope).not.toBeNull();
    await expectNowhere(PLAINTEXT, "while pending");

    await tick();
    expect(kube.value("scp-build-registry", "registryPassword")).toBe(PLAINTEXT);
    expect(kube.writes.filter((w) => w.namespace === WF_NS)).toEqual([
      {
        namespace: WF_NS,
        name: "scp-build-registry",
        manager: "scp-stackd-credential.registryPassword"
      }
    ]);
    const after = keyState(await people.stack.credentials(OPERATOR_TOKEN), "registryPassword");
    expect(after).toMatchObject({ state: "set", pendingOp: null, error: null });
    expect(after.deliveredAt).not.toBeNull();
    // Delivered: the envelope is gone too.
    expect(
      (await admin.query("SELECT envelope FROM stack_credentials WHERE key = 'registryPassword'"))
        .rows[0]
    ).toEqual({ envelope: null });
    await expectNowhere(PLAINTEXT, "after delivery");

    // The audit chain names who, which backend, Secret and key — and never the value.
    const links = (
      await admin.query<{ action: string; subject: string; detail: Record<string, unknown> }>(
        "SELECT action, subject, detail FROM instance_audit_events WHERE action LIKE 'stack.credential.%' ORDER BY seq"
      )
    ).rows;
    expect(links.map((l) => l.action)).toEqual([
      "stack.credential.sealing-key",
      "stack.credential.set",
      "stack.credential.delivered"
    ]);
    expect(Object.keys(links[1]!.detail).sort()).toEqual(
      ["backend", "deliveryId", "key", "secretName", "seq"].sort()
    );
    expect(links[1]!.subject).toBe("argo-workflows/scp-build-registry/registryPassword");
  });

  it("no read path: every stack read an operator can make carries no value", async () => {
    const bodies = JSON.stringify([
      await people.stack.credentials(OPERATOR_TOKEN),
      await people.stack.get(),
      await people.stack.diagnostics(OPERATOR_TOKEN),
      await spec(),
      await controllerClient.stack.credentialDeliveries(STACKD_TOKEN)
    ]);
    for (const f of forms(PLAINTEXT)) expect(bodies.includes(f)).toBe(false);
  });

  it("scp_app — every tenant request's role — cannot read the table at all", async () => {
    const app = new pg.Pool({ connectionString: testRuntimeDatabaseUrl(), max: 1 });
    try {
      await expect(app.query("SELECT * FROM stack_credentials")).rejects.toThrow(
        /permission denied/
      );
    } finally {
      await app.end();
    }
  });

  it("a REPLAYED envelope — an older, genuinely sealed row restored into the table — is refused, and the newer value stays", async () => {
    await people.stack.setCredential(target, "older-value", OPERATOR_TOKEN);
    const older = (
      await admin.query(
        "SELECT delivery_id, seq, sealed_to, not_after, envelope FROM stack_credentials WHERE key = 'registryPassword'"
      )
    ).rows[0] as Record<string, unknown>;
    await tick();
    await people.stack.setCredential(target, "newer-value", OPERATOR_TOKEN);
    await tick();
    expect(kube.value("scp-build-registry", "registryPassword")).toBe("newer-value");
    // Someone with the table (a restored backup, a database writer) puts the older row back.
    await admin.query(
      `UPDATE stack_credentials SET state = 'pending', pending_op = 'set', delivery_id = $1, seq = $2,
              sealed_to = $3, not_after = $4, envelope = $5::jsonb WHERE key = 'registryPassword'`,
      [
        older["delivery_id"],
        older["seq"],
        older["sealed_to"],
        older["not_after"],
        JSON.stringify(older["envelope"])
      ]
    );
    await tick();
    expect(kube.value("scp-build-registry", "registryPassword")).toBe("newer-value");
    const v = keyState(await people.stack.credentials(OPERATOR_TOKEN), "registryPassword");
    expect(v.state).toBe("failed");
    expect(v.error).toMatch(/replay/);
  });

  it("a REDIRECTED envelope — its target rewritten in the table to another Secret and key — fails its tag and is refused; nothing is written there", async () => {
    await people.stack.setCredential(
      { ...target, key: "registryUsername" },
      "redirect-me",
      OPERATOR_TOKEN
    );
    await admin.query(
      `UPDATE stack_credentials SET secret_name = 'scp-infra-apply-credentials', key = 'AWS_SECRET_ACCESS_KEY'
        WHERE secret_name = 'scp-build-registry' AND key = 'registryUsername'`
    );
    await tick();
    expect(kube.secrets.has(`${WF_NS}/scp-infra-apply-credentials`)).toBe(false);
    const v = keyState(
      await people.stack.credentials(OPERATOR_TOKEN),
      "AWS_SECRET_ACCESS_KEY",
      "scp-infra-apply-credentials"
    );
    expect(v.state).toBe("failed");
    expect(v.error).toMatch(/altered/);
    expect(controllerLog.join("\n")).toMatch(/refused: tampered/);
  });

  it("deletion: the controller removes just that key; rotation (a re-set) replaced the value above", async () => {
    await people.stack.setCredential({ ...target, key: "registryHost" }, "h:3000", OPERATOR_TOKEN);
    await tick();
    expect(kube.value("scp-build-registry", "registryHost")).toBe("h:3000");
    const pending = await people.stack.deleteCredential(target, OPERATOR_TOKEN);
    expect(pending).toMatchObject({ state: "pending", pendingOp: "delete" });
    await tick();
    expect(kube.value("scp-build-registry", "registryPassword")).toBeUndefined();
    expect(kube.value("scp-build-registry", "registryHost")).toBe("h:3000");
    expect(keyState(await people.stack.credentials(OPERATOR_TOKEN), "registryPassword").state).toBe(
      "unset"
    );
  });

  it("a controller whose key changed strands what was sealed to the old one — marked failed, to be entered again", async () => {
    await people.stack.setCredential({ ...target, key: "gitToken" }, "g-1", OPERATOR_TOKEN);
    // The controller's key Secret is lost (its namespace recreated): it generates and publishes anew.
    kube.secrets.delete("scp-stackd/scp-stackd-sealing-key");
    await tick();
    const v = keyState(await people.stack.credentials(OPERATOR_TOKEN), "gitToken");
    expect(v.state).toBe("failed");
    expect(v.error).toMatch(/sealing key changed/);
    expect(kube.value("scp-build-registry", "gitToken")).toBeUndefined();
  });

  it("workload identity: declared through the API, handed to the controller in its spec; a free identifier or a non-slot account is refused", async () => {
    await people.stack.putWorkloadIdentity(
      { backend: "argo-workflows", serviceAccount: "scp-infra-plan" },
      { provider: "aws-irsa", identifier: "arn:aws:iam::123456789012:role/scp-plan" },
      OPERATOR_TOKEN
    );
    expect((await spec()).workloadIdentities).toEqual([
      {
        backend: "argo-workflows",
        serviceAccount: "scp-infra-plan",
        provider: "aws-irsa",
        identifier: "arn:aws:iam::123456789012:role/scp-plan"
      }
    ]);
    expect(
      (
        await apiError(() =>
          people.stack.putWorkloadIdentity(
            { backend: "argo-workflows", serviceAccount: "scp-infra-plan" },
            { provider: "aws-irsa", identifier: "arn:aws:iam::1:role/x\nkind: ClusterRoleBinding" },
            OPERATOR_TOKEN
          )
        )
      ).status
    ).toBe(400);
    expect(
      (
        await apiError(() =>
          people.stack.putWorkloadIdentity(
            { backend: "argo-workflows", serviceAccount: "argocd-server" },
            { provider: "aws-irsa", identifier: "arn:aws:iam::123456789012:role/x" },
            OPERATOR_TOKEN
          )
        )
      ).status
    ).toBe(400);
    const view = await people.stack.deleteWorkloadIdentity(
      { backend: "argo-workflows", serviceAccount: "scp-infra-plan" },
      OPERATOR_TOKEN
    );
    expect(view.workloadIdentities.every((w) => w.binding === null)).toBe(true);
    expect((await spec()).workloadIdentities).toEqual([]);
  });
});
