import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { ScpClient } from "@scp/sdk";
import { asTrustDomainId, type DesiredStateManifest } from "@scp/schemas";
import {
  createTestOrg,
  createTestUser,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg,
  type TestUser
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { objects } from "../db/schema.js";
import { upsertObjectByUrn } from "../graph/objects-repo.js";
import { handFillObject } from "../federation/handfill-repo.js";
import { pairPeer } from "../federation/peers-repo.js";
import { initFederationSelf } from "../federation/self-repo.js";
import {
  resolveExecutorPluginInstance,
  upsertExecutorBinding
} from "../coordination/executor-bindings-repo.js";

/**
 * THE EXECUTION-SYSTEM ROUTING DOOR, AT EVERY WRITE DOOR (M28.3 final re-verify, probe E; ADR-0056
 * addendum 3). An execution system's properties route its triggers and name its credential, so
 * writing them needs `secret:write` at the org root. The Operator here holds org-root `object:write`
 * and NOT `secret:write` — the control cases prove the first, so every 403 is about the second.
 */
describe("execution-system routing: secret:write at every write door (Testcontainers)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let operator: TestUser;
  let op: ScpClient;
  /** An admin-registered system the Operator will try to re-point. */
  let systemId = "";
  let systemUrn = "";
  const ROUTED = {
    kind: "argo-workflows",
    serverUrl: "https://argo.sandbox.invalid",
    namespace: "sandbox",
    tokenSecretKey: "argo-sandbox-token"
  };

  async function asOperator(method: "POST" | "PUT" | "PATCH", url: string, payload: unknown) {
    return server.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${operator.token}` },
      payload: payload as Record<string, unknown>
    });
  }

  async function storedProperties(id: string): Promise<Record<string, unknown>> {
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select({ p: objects.properties }).from(objects).where(eq(objects.id, id))
    );
    return (rows[0]?.p ?? {}) as Record<string, unknown>;
  }

  async function liveByUrn(urn: string) {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ id: objects.id })
        .from(objects)
        .where(and(eq(objects.orgId, org.orgId), eq(objects.urn, urn), isNull(objects.deletedAt)))
    );
  }

  const refusal = (p: Promise<unknown>) =>
    p.then(
      () => {
        throw new Error("expected a refusal, but the call succeeded");
      },
      (e: unknown) => e as { status?: number; message?: string; problem?: { detail?: string } }
    );

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "es-routing");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    operator = await createTestUser(server, org, [{ role: "Operator", scope: org.orgId }]);
    op = new ScpClient({ baseUrl: server.baseUrl, token: operator.token });
    const sys = await admin.object("execution-system").create({
      name: `es-${randomUUID().slice(0, 8)}`,
      properties: ROUTED
    });
    systemId = sys.id;
    systemUrn = sys.urn;
    await admin.secrets.put(ROUTED.tokenSecretKey, { value: "sandbox-token" });
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      initFederationSelf(tx, {
        orgId: org.orgId,
        name: `es-routing-${randomUUID().slice(0, 8)}`,
        role: "commander"
      })
    );
  }, 240_000);

  afterAll(async () => {
    await server?.close();
  });

  it("CONTROL: the Operator holds object:write — it may create a bare system and RENAME one", async () => {
    const bare = await asOperator("POST", "/api/v1/objects/execution-system", {
      name: `bare-${randomUUID().slice(0, 8)}`
    });
    expect(bare.statusCode, bare.body).toBe(201);
    const renamed = await asOperator("PATCH", `/api/v1/objects/execution-system/${systemId}`, {
      name: `renamed-${randomUUID().slice(0, 8)}`
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    // …and a full-replacement write that re-sends the properties UNCHANGED is still only a rename.
    const put = await asOperator(
      "PUT",
      `/api/v1/objects/execution-system/${encodeURIComponent(systemUrn)}`,
      { name: `renamed-${randomUUID().slice(0, 8)}`, properties: ROUTED, labels: { team: "ops" } }
    );
    expect(put.statusCode, put.body).toBe(200);
    expect(await storedProperties(systemId)).toEqual(ROUTED);
  });

  it("DOOR 1 — POST /objects/execution-system carrying properties: 403, nothing written", async () => {
    const name = `new-${randomUUID().slice(0, 8)}`;
    const res = await asOperator("POST", "/api/v1/objects/execution-system", {
      name,
      properties: ROUTED
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatch(/secret:write/);
    expect(await liveByUrn(`urn:scp:${org.orgId}:execution-system:${name}`)).toHaveLength(0);
  });

  it("DOOR 2 — PATCH: every property is routing — each key's change, addition and removal is 403", async () => {
    // Not a list of "routing keys": `webUrl` addresses a registry push, `packageFormats` picks
    // what a build publishes there, and a key a future manifest declares is carried into config.
    const variants: Record<string, unknown>[] = [
      { ...ROUTED, serverUrl: "https://argo.prod.invalid" },
      { ...ROUTED, namespace: "prod" },
      { ...ROUTED, tokenSecretKey: "argo-prod-token" },
      { ...ROUTED, kind: "argocd" },
      { ...ROUTED, allowInternalEgress: true },
      { ...ROUTED, authoring: { project: "default" } },
      { ...ROUTED, webUrl: "https://registry.attacker.invalid" },
      { ...ROUTED, packageFormats: ["oci", "rpm"] },
      { ...ROUTED, someFutureDeclaredKey: "x" },
      { kind: ROUTED.kind, serverUrl: ROUTED.serverUrl, namespace: ROUTED.namespace }
    ];
    for (const properties of variants) {
      const res = await asOperator("PATCH", `/api/v1/objects/execution-system/${systemId}`, {
        properties
      });
      expect(res.statusCode, JSON.stringify(properties)).toBe(403);
    }
    expect(await storedProperties(systemId)).toEqual(ROUTED);
  });

  it("DOOR 3 — PUT /objects/execution-system/{urn}: both the upsert's create and update branch are 403", async () => {
    const name = `put-${randomUUID().slice(0, 8)}`;
    const urn = `urn:scp:${org.orgId}:execution-system:${name}`;
    const created = await asOperator(
      "PUT",
      `/api/v1/objects/execution-system/${encodeURIComponent(urn)}`,
      {
        name,
        properties: ROUTED
      }
    );
    expect(created.statusCode).toBe(403);
    expect(await liveByUrn(urn)).toHaveLength(0);
    const updated = await asOperator(
      "PUT",
      `/api/v1/objects/execution-system/${encodeURIComponent(systemUrn)}`,
      { name: "x", properties: { ...ROUTED, serverUrl: "https://argo.prod.invalid" } }
    );
    expect(updated.statusCode).toBe(403);
    expect(await storedProperties(systemId)).toEqual(ROUTED);
  });

  it("DOOR 4 — IaC apply: a manifest creating or re-pointing a system is refused, and writes nothing", async () => {
    const stackName = `es-${randomUUID().slice(0, 8)}`;
    const urn = `urn:scp:${stackName}:execution-system:iac`;
    const create: DesiredStateManifest = {
      stackName,
      objects: [{ urn, typeId: "execution-system", name: "iac", properties: ROUTED }],
      relationships: []
    };
    const plan = await op.plans.create(create);
    const err = await refusal(op.plans.apply(plan.id));
    expect(err.status).toBe(403);
    expect(await liveByUrn(urn)).toHaveLength(0);

    const repoint: DesiredStateManifest = {
      stackName: `${stackName}-b`,
      objects: [
        {
          urn: systemUrn,
          typeId: "execution-system",
          name: (await admin.object("execution-system").get(systemId)).name,
          properties: { ...ROUTED, serverUrl: "https://argo.prod.invalid" }
        }
      ],
      relationships: []
    };
    const plan2 = await op.plans.create(repoint);
    expect((await refusal(op.plans.apply(plan2.id))).status).toBe(403);
    expect(await storedProperties(systemId)).toEqual(ROUTED);
  });

  it("DOOR 5 — POST /federation/overlays: an execution-system overlay is a LOCAL system, so it is 403", async () => {
    const urn = `urn:scp:${org.orgId}:execution-system:overlay-${randomUUID().slice(0, 8)}`;
    const res = await asOperator("POST", "/api/v1/federation/overlays", {
      base: systemId,
      typeId: "execution-system",
      name: "overlay",
      urn,
      properties: { ...ROUTED, serverUrl: "https://argo.prod.invalid" }
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(await liveByUrn(urn)).toHaveLength(0);
  });

  it("DOOR 6 — hand-fill: the door that wears federationImport, and whose shadow can later be ADOPTED", async () => {
    const domainId = asTrustDomainId(randomUUID());
    const { publicKey } = generateKeyPairSync("ed25519");
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      pairPeer(tx, {
        orgId: org.orgId,
        domainId,
        name: `peer-${domainId.slice(0, 8)}`,
        role: "outpost",
        publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64")
      })
    );
    const urn = `urn:scp:${org.orgId}:execution-system:hf-${randomUUID().slice(0, 8)}`;
    const err = await refusal(
      withTenantTx(server.deps.db, org.orgId, (tx) =>
        handFillObject(tx, {
          orgId: org.orgId,
          peerIdOrName: domainId,
          typeId: "execution-system",
          urn,
          name: "hf",
          properties: ROUTED,
          actorObjectId: operator.objectId
        })
      )
    );
    expect(err.status).toBe(403);
    expect(await liveByUrn(urn)).toHaveLength(0);
  });

  it("DOOR 7 — `scp connect`: the Operator can neither store the token nor register a system naming one already stored", async () => {
    // The flow is `secrets.put` then `object("execution-system").create` — both through the API.
    expect((await refusal(op.secrets.put("argo-prod-token", { value: "t" }))).status).toBe(403);
    await admin.secrets.put("argo-prod-token", { value: "t" });
    const err = await refusal(
      op.object("execution-system").create({
        name: `connect-${randomUUID().slice(0, 8)}`,
        properties: { ...ROUTED, tokenSecretKey: "argo-prod-token" }
      })
    );
    expect(err.status).toBe(403);
  });

  it("CONTROL: a secret:write holder writes the same properties at every one of those doors' choke point", async () => {
    const sys = await admin.object("execution-system").create({
      name: `admin-${randomUUID().slice(0, 8)}`,
      properties: ROUTED
    });
    const moved = await admin
      .object("execution-system")
      .update(sys.id, { properties: { ...ROUTED, serverUrl: "https://argo.prod.invalid" } });
    expect(moved.properties).toMatchObject({ serverUrl: "https://argo.prod.invalid" });
  });

  it("FEDERATION — a REPLICATED system is accepted (the origin's authority) but never executable here", async () => {
    // The signed import is the origin domain's write, gated there by this same door. Here its
    // `tokenSecretKey` would resolve THIS instance's secret — so it can be neither bound nor resolved.
    const urn = `urn:scp:${org.orgId}:execution-system:replica-${randomUUID().slice(0, 8)}`;
    const { object: replica } = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      upsertObjectByUrn(tx, {
        orgId: org.orgId,
        typeId: "execution-system",
        actorObjectId: operator.objectId,
        requestId: "replica",
        urn,
        name: "replica",
        properties: { ...ROUTED, tokenSecretKey: "argo-prod-token" },
        federationImport: {
          originDomainId: asTrustDomainId(randomUUID()),
          revision: 1,
          provenance: null
        }
      })
    );
    const target = await admin.deploymentTargets.create({ name: `t-${randomUUID().slice(0, 8)}` });

    // THE WRITE DOOR: binding to it is refused, for the admin too — it is not about who asks.
    const bind = await refusal(
      admin.executors.putBinding(target.id, {
        executionSystemId: replica.id,
        type: "configuration"
      })
    );
    expect(bind.status).toBe(400);
    expect(bind.problem?.detail).toMatch(/replicated/);

    // THE READ DOOR: a binding row that names it anyway (written before this door) resolves to nothing.
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      upsertExecutorBinding(tx, {
        orgId: org.orgId,
        targetObjectId: target.id,
        type: "configuration",
        pluginModule: "argo-workflows",
        pluginInstanceId: `execution-system:${replica.id}`,
        executionSystemId: replica.id,
        actorObjectId: operator.objectId,
        requestId: "replica-binding"
      })
    );
    const resolved = await refusal(
      withTenantTx(server.deps.db, org.orgId, (tx) =>
        resolveExecutorPluginInstance(tx, {
          orgId: org.orgId,
          targetObjectId: target.id,
          masterKey: server.deps.config.secretsMasterKey,
          type: "configuration"
        })
      )
    );
    expect(resolved.message).toMatch(/replicated system is not executable/);

    // CONTROL: the admin's own system binds and resolves — the refusal is about origin.
    await admin.executors.putBinding(target.id, {
      executionSystemId: systemId,
      type: "configuration"
    });
    const own = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      resolveExecutorPluginInstance(tx, {
        orgId: org.orgId,
        targetObjectId: target.id,
        masterKey: server.deps.config.secretsMasterKey,
        type: "configuration"
      })
    );
    expect(own).toBeDefined();
  });
});
