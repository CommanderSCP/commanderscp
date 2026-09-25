import { createHash, X509Certificate } from "node:crypto";
import type pg from "pg";
import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { InstanceActor, PutStackWiringRequest } from "@scp/schemas";
import type { AppDeps } from "../types.js";
import type { TenantTx } from "../db/tenant-tx.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { appendInstanceAudit } from "../auth/instance-authority.js";
import { withOperatorTx } from "../routes/instance-operators.js";
import { badRequest, conflict } from "../errors.js";
import { encryptSecretValue } from "../secrets/crypto.js";
import { SYSTEM_ACTOR_ID } from "../coordination/system-actor.js";
import { createObject, updateObject } from "../graph/objects-repo.js";
import { canonicalJson } from "../util/canonical-json.js";
import {
  CALLED_BACKENDS,
  REGISTRATION_KIND,
  SELECT_WIRINGS,
  wiringOf,
  type WireableBackend,
  type Wiring,
  type WiringRow
} from "./wired-routing.js";

export * from "./wired-routing.js";

/**
 * THE STANDARD STACK'S WIRING INTO SCP (M29.2, ADR-0060).
 *
 * After the stack controller brings a bundled backend to ready, it hands scpd ONE document through
 * a door only its own credential opens (`PUT /instance/stack/backends/{b}/wiring`): the in-cluster
 * endpoint from its own render, the CA that endpoint's certificate chains to, the scoped account,
 * and the token it just minted there. From that one hand-off, and nothing else, scpd:
 *
 *   1. keeps the token, encrypted with the secrets master key, at the INSTANCE tier
 *      (`stack_backend_tokens`) — never in an org's secret store, which tenant-writable
 *      execution-system properties address by key;
 *   2. registers an `execution-system` object in every organization the stack serves
 *      (`reconcileStackRegistrations`), allocating its id FIRST in `stack_backend_registrations` so
 *      no object a tenant made can become one;
 *   3. and, whenever a binding or a discovery run uses such a system, takes its endpoint, token,
 *      CA and application egress from the wiring (`stackWiredRouting`) — never from the object's
 *      properties, which the routing door also refuses to let anyone but this module write.
 *
 * So nothing a tenant writes decides which endpoint a minted token is sent to, which CA scpd trusts
 * for it, or which host its internal egress opens to (the M28 class). Every write here is audited
 * in `instance_audit_events` in the same transaction.
 */

export const sha256Hex = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

// ---- the hand-off -------------------------------------------------------------------------------

/** What each backend's hand-off must and must not carry. The schema already bounds every string;
 *  this is the per-backend shape, plus a real certificate parse of the CA. */
export function validateWiring(backend: WireableBackend, body: PutStackWiringRequest): void {
  const called = CALLED_BACKENDS.includes(backend);
  if (called) {
    for (const [field, value] of [
      ["serverUrl", body.serverUrl],
      ["account", body.account],
      ["token", body.token]
    ] as const) {
      if (value === null) throw badRequest(`a ${backend} wiring must carry ${field}`);
    }
  } else if (
    body.serverUrl !== null ||
    body.token !== null ||
    body.caPem !== null ||
    body.account !== null
  ) {
    throw badRequest(
      `${backend} is not a system SCP calls, so its wiring carries no endpoint, account, CA or token`
    );
  }
  if (backend === "argo-workflows" && body.namespace === null) {
    throw badRequest("an argo-workflows wiring must name the namespace its workflows run in");
  }
  if (backend !== "argo-workflows" && body.namespace !== null) {
    throw badRequest(`a ${backend} wiring carries no namespace`);
  }
  if (body.caPem !== null) {
    try {
      new X509Certificate(body.caPem);
    } catch {
      throw badRequest("caPem is not a PEM certificate");
    }
  }
  if (body.serverUrl !== null) {
    const url = new URL(body.serverUrl);
    if (url.protocol === "http:" && body.caPem !== null) {
      throw badRequest("a CA was handed over for a plain-http endpoint");
    }
  }
}

/** Every wiring, read on the operator connection. */
export async function readWiringsOnClient(client: pg.PoolClient): Promise<Wiring[]> {
  const rows = (await client.query<WiringRow>(SELECT_WIRINGS)).rows;
  return rows.flatMap((r) => wiringOf(r) ?? []);
}

/** Persists one hand-off: facts, then the token (encrypted), then the audit link — one tx. */
export async function storeWiring(
  client: pg.PoolClient,
  input: {
    backend: WireableBackend;
    body: PutStackWiringRequest;
    masterKey: Buffer;
    actor: InstanceActor;
    requestId: string;
    bootstrapOrgName: string;
  }
): Promise<void> {
  const { backend, body } = input;
  const caSha256 = body.caPem === null ? null : sha256Hex(body.caPem.trim());
  const before = await client.query<WiringRow>(`${SELECT_WIRINGS} WHERE backend = $1`, [backend]);
  await client.query(
    `INSERT INTO stack_backend_wirings
       (backend, server_url, namespace, ca_pem, ca_sha256, account, facts_sha256,
        rotation_generation, wired_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (backend) DO UPDATE SET
       server_url = EXCLUDED.server_url, namespace = EXCLUDED.namespace, ca_pem = EXCLUDED.ca_pem,
       ca_sha256 = EXCLUDED.ca_sha256, account = EXCLUDED.account,
       facts_sha256 = EXCLUDED.facts_sha256, rotation_generation = EXCLUDED.rotation_generation,
       wired_at = now()`,
    [
      backend,
      body.serverUrl,
      body.namespace,
      body.caPem,
      caSha256,
      body.account,
      body.factsSha256,
      body.rotationGeneration
    ]
  );
  if (body.token !== null) {
    const enc = encryptSecretValue(body.token, input.masterKey);
    await client.query(
      `INSERT INTO stack_backend_tokens (backend, ciphertext, nonce, key_version, minted_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (backend) DO UPDATE SET ciphertext = EXCLUDED.ciphertext,
         nonce = EXCLUDED.nonce, key_version = EXCLUDED.key_version, minted_at = now()`,
      [backend, enc.ciphertext, enc.nonce, enc.keyVersion]
    );
  } else {
    await client.query("DELETE FROM stack_backend_tokens WHERE backend = $1", [backend]);
  }
  const prior = before.rows[0] ? wiringOf(before.rows[0]) : null;
  // The token itself never reaches the audit row — only THAT one was minted, and its fingerprint.
  await appendInstanceAudit(client, {
    action: "stack.backend.wire",
    actor: input.actor,
    subject: backend,
    detail: {
      before: prior
        ? {
            serverUrl: prior.serverUrl,
            caSha256: prior.caSha256,
            account: prior.account,
            rotationGeneration: prior.rotationGeneration
          }
        : null,
      after: {
        serverUrl: body.serverUrl,
        namespace: body.namespace,
        caSha256,
        account: body.account,
        rotationGeneration: body.rotationGeneration,
        factsSha256: body.factsSha256,
        tokenSha256Prefix: body.token === null ? null : sha256Hex(body.token).slice(0, 12)
      }
    },
    requestId: input.requestId
  });
  await ensureDefaultServedOrg(client, {
    bootstrapOrgName: input.bootstrapOrgName,
    requestId: input.requestId
  });
}

/** Drops one backend's wiring and its token (disable, or a controller that can no longer wire). */
export async function dropWiring(
  client: pg.PoolClient,
  input: { backend: WireableBackend; actor: InstanceActor; requestId: string }
): Promise<boolean> {
  const res = await client.query("DELETE FROM stack_backend_wirings WHERE backend = $1", [
    input.backend
  ]);
  await client.query("DELETE FROM stack_backend_tokens WHERE backend = $1", [input.backend]);
  const dropped = (res.rowCount ?? 0) > 0;
  if (dropped) {
    await appendInstanceAudit(client, {
      action: "stack.backend.unwire",
      actor: input.actor,
      subject: input.backend,
      detail: {},
      requestId: input.requestId
    });
  }
  return dropped;
}

// ---- the organizations the stack serves ---------------------------------------------------------

const INSTALL_ACTOR: InstanceActor = {
  mechanism: "install",
  orgId: null,
  userId: null,
  username: null,
  credentialId: null
};

/**
 * THE DEFAULT: on the first wiring, the deployment's bootstrap organization is served — the
 * single-org install is wired end to end with no step. Once, ever (`served_orgs_initialized`): an
 * operator who detaches it later is not overruled by the next wiring.
 */
export async function ensureDefaultServedOrg(
  client: pg.PoolClient,
  input: { bootstrapOrgName: string; requestId: string }
): Promise<void> {
  const settings = await client.query<{ served_orgs_initialized: boolean }>(
    "SELECT served_orgs_initialized FROM stack_settings WHERE id = 'instance' FOR UPDATE"
  );
  if (settings.rows[0]?.served_orgs_initialized) return;
  const org = await client.query<{ id: string }>("SELECT id FROM orgs WHERE name = $1", [
    input.bootstrapOrgName
  ]);
  const orgId = org.rows[0]?.id;
  if (orgId) {
    const inserted = await client.query(
      `INSERT INTO stack_served_orgs (org_id, attached_by) VALUES ($1, $2::jsonb)
       ON CONFLICT (org_id) DO NOTHING`,
      [orgId, JSON.stringify(INSTALL_ACTOR)]
    );
    if ((inserted.rowCount ?? 0) > 0) {
      await appendInstanceAudit(client, {
        action: "stack.org.attach",
        actor: INSTALL_ACTOR,
        subject: orgId,
        detail: { reason: "the deployment's bootstrap organization is served by default" },
        requestId: input.requestId
      });
    }
  }
  // Marked even when no bootstrap org exists yet: a deployment without one has had its orgs made
  // some other way, and which of them the stack serves is then an operator's decision.
  await client.query(
    `INSERT INTO stack_settings (id, served_orgs_initialized) VALUES ('instance', true)
     ON CONFLICT (id) DO UPDATE SET served_orgs_initialized = true`
  );
}

export interface ServedOrgRow extends Record<string, unknown> {
  org_id: string;
  org_name: string;
  attached_at: Date | string;
  attached_by: InstanceActor;
}

export async function listServedOrgs(client: pg.PoolClient): Promise<ServedOrgRow[]> {
  return (
    await client.query<ServedOrgRow>(
      `SELECT s.org_id, o.name AS org_name, s.attached_at, s.attached_by
         FROM stack_served_orgs s JOIN orgs o ON o.id = s.org_id ORDER BY s.attached_at`
    )
  ).rows;
}

export async function attachServedOrg(
  client: pg.PoolClient,
  input: { orgId: string; actor: InstanceActor; requestId: string }
): Promise<void> {
  const org = await client.query("SELECT 1 FROM orgs WHERE id = $1", [input.orgId]);
  if (org.rows.length === 0) throw badRequest(`no organization '${input.orgId}'`);
  const inserted = await client.query(
    `INSERT INTO stack_served_orgs (org_id, attached_by) VALUES ($1, $2::jsonb)
     ON CONFLICT (org_id) DO NOTHING`,
    [input.orgId, JSON.stringify(input.actor)]
  );
  if ((inserted.rowCount ?? 0) === 0)
    throw conflict(`organization '${input.orgId}' is already served`);
  // Attaching counts as the operator having decided: the default never fires after this.
  await client.query(
    `INSERT INTO stack_settings (id, served_orgs_initialized) VALUES ('instance', true)
     ON CONFLICT (id) DO UPDATE SET served_orgs_initialized = true`
  );
  await appendInstanceAudit(client, {
    action: "stack.org.attach",
    actor: input.actor,
    subject: input.orgId,
    detail: {},
    requestId: input.requestId
  });
}

export async function detachServedOrg(
  client: pg.PoolClient,
  input: { orgId: string; actor: InstanceActor; requestId: string }
): Promise<void> {
  const res = await client.query("DELETE FROM stack_served_orgs WHERE org_id = $1", [input.orgId]);
  if ((res.rowCount ?? 0) === 0) throw conflict(`organization '${input.orgId}' is not served`);
  await client.query(
    `INSERT INTO stack_settings (id, served_orgs_initialized) VALUES ('instance', true)
     ON CONFLICT (id) DO UPDATE SET served_orgs_initialized = true`
  );
  await appendInstanceAudit(client, {
    action: "stack.org.detach",
    actor: input.actor,
    subject: input.orgId,
    detail: {},
    requestId: input.requestId
  });
}

// ---- registrations ------------------------------------------------------------------------------

/** What a registration's `execution-system` object says. Descriptive: the resolver never routes by
 *  it (`stackWiredRouting` reads the wiring), and only this module may write it. Deliberately
 *  STABLE across a disable/enable of the same endpoint — no "wired" flag — because the source
 *  allowlists fingerprint the whole properties object (`executionSystemRoutingFingerprint`), and
 *  switching a backend off and on must not void an org's allowlist decisions. Whether it is wired
 *  right now is the Stack page's to say; a binding to an unwired one is refused at resolve. */
export function registrationProperties(
  backend: WireableBackend,
  wiring: Wiring
): Record<string, unknown> {
  return {
    kind: REGISTRATION_KIND[backend],
    ...(wiring.serverUrl ? { serverUrl: wiring.serverUrl, allowInternalEgress: true } : {}),
    ...(wiring.namespace ? { namespace: wiring.namespace } : {}),
    stack: { backend, managedBy: "scp-stackd" }
  };
}

const registrationName = (backend: WireableBackend): string => `scp-stack-${backend}`;

async function upsertRegisteredObject(
  tx: TenantTx,
  input: {
    orgId: string;
    objectId: string;
    backend: WireableBackend;
    properties: Record<string, unknown>;
    requestId: string;
  }
): Promise<"created" | "updated" | "unchanged"> {
  const existing = await tx.execute(sql`
    SELECT properties FROM objects
     WHERE org_id = ${input.orgId} AND id = ${input.objectId} AND deleted_at IS NULL`);
  const row = existing.rows[0] as { properties?: unknown } | undefined;
  if (!row) {
    for (const name of [
      registrationName(input.backend),
      `${registrationName(input.backend)}-${input.objectId.slice(-8)}`
    ]) {
      try {
        // A savepoint: a name collision aborts only this attempt, not the whole transaction.
        await tx.transaction(async (sp) =>
          createObject(sp, {
            orgId: input.orgId,
            typeId: "execution-system",
            id: input.objectId,
            name,
            properties: input.properties,
            labels: {},
            actorObjectId: SYSTEM_ACTOR_ID,
            requestId: input.requestId,
            // This instance's own backend: never journaled to a peer, which could not reach it.
            domainLocal: true,
            stackManagedWrite: true
          })
        );
        return "created";
      } catch (err) {
        // A tenant's object may already hold the name; the registration takes the suffixed one.
        if (!(err instanceof Error && /already in use/.test(err.message))) throw err;
      }
    }
    throw conflict(`could not register ${input.backend} in org ${input.orgId}: its name is taken`);
  }
  if (canonicalJson(row.properties) === canonicalJson(input.properties)) return "unchanged";
  await updateObject(tx, {
    orgId: input.orgId,
    typeId: "execution-system",
    idOrUrn: input.objectId,
    properties: input.properties,
    actorObjectId: SYSTEM_ACTOR_ID,
    requestId: input.requestId,
    stackManagedWrite: true
  });
  return "updated";
}

/**
 * Makes every served org's registrations match the wiring: one `execution-system` per wired
 * backend, its id allocated FIRST (operator tx), then the object (that org's tenant tx). A backend
 * that is not wired, or an org no longer served, keeps its object and its bindings; what stops them
 * working is the resolver, which refuses a registration without a wiring or a served org. Idempotent
 * — called after every hand-off, attach and detach, and on every controller status report, so an org
 * served (or re-created) between hand-offs converges on the next tick.
 */
export async function reconcileStackRegistrations(
  deps: AppDeps,
  requestId: string,
  actor: InstanceActor
): Promise<{ changed: number }> {
  const plan = await withOperatorTx(deps.config, "the Standard Stack", async (client) => {
    const wirings = await readWiringsOnClient(client);
    const served = (
      await client.query<{ org_id: string }>("SELECT org_id FROM stack_served_orgs")
    ).rows.map((r) => r.org_id);
    const out: { orgId: string; wiring: Wiring; objectId: string }[] = [];
    for (const orgId of served) {
      for (const wiring of wirings) {
        const inserted = await client.query<{ object_id: string }>(
          `INSERT INTO stack_backend_registrations (org_id, backend, object_id) VALUES ($1, $2, $3)
           ON CONFLICT (org_id, backend) DO NOTHING RETURNING object_id`,
          [orgId, wiring.backend, uuidv7()]
        );
        if (inserted.rows[0]) {
          await appendInstanceAudit(client, {
            action: "stack.registration.create",
            actor,
            subject: `${wiring.backend}@${orgId}`,
            detail: { orgId, backend: wiring.backend, objectId: inserted.rows[0].object_id },
            requestId
          });
        }
        const reg = await client.query<{ object_id: string }>(
          "SELECT object_id FROM stack_backend_registrations WHERE org_id = $1 AND backend = $2",
          [orgId, wiring.backend]
        );
        out.push({ orgId, wiring, objectId: reg.rows[0]!.object_id });
      }
    }
    return out;
  });
  let changed = 0;
  for (const { orgId, wiring, objectId } of plan) {
    const outcome = await withTenantTx(deps.db, orgId, (tx) =>
      upsertRegisteredObject(tx, {
        orgId,
        objectId,
        backend: wiring.backend,
        properties: registrationProperties(wiring.backend, wiring),
        requestId
      })
    );
    if (outcome !== "unchanged") changed += 1;
  }
  return { changed };
}
