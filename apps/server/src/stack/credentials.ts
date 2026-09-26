import {
  createCipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
  type KeyObject
} from "node:crypto";
import type pg from "pg";
import {
  STACK_CREDENTIAL_CATALOG,
  STACK_CREDENTIAL_ENVELOPE_TTL_MS,
  STACK_CREDENTIAL_HKDF_INFO,
  STACK_WORKLOAD_IDENTITY_SLOTS,
  StackCredentialDeliverySchema,
  StackWorkloadIdentitySpecSchema,
  credentialEnvelopeAad,
  isCatalogTarget,
  isWorkloadIdentitySlot,
  type AckStackCredentialDeliveryRequest,
  type InstanceActor,
  type PutStackCredentialSealingKeyRequest,
  type StackCredentialDelivery,
  type StackCredentialEnvelope,
  type StackCredentialKeyView,
  type StackCredentialOp,
  type StackCredentialsView,
  type StackWorkloadIdentityBinding,
  type StackWorkloadIdentityView,
  type StackWorkloadIdentitySpec
} from "@scp/schemas";
import { appendInstanceAudit } from "../auth/instance-authority.js";
import { badRequest, conflict } from "../errors.js";

/**
 * CREDENTIALS THROUGH SCP — scpd's half (M29.5, ADR-0063; charter "Managed Standard Stack":
 * "CommanderSCP brokers them in, it does not hold them").
 *
 * A value entered through the API lives in scpd for exactly one request: it is SEALED — X25519
 * with an ephemeral key, HKDF-SHA256, AES-256-GCM — to the public key the stack controller
 * published through its own door, and only the envelope is stored. scpd holds no private key, so
 * nothing scpd has (its database, its memory after the request, its master key) opens it. The
 * controller polls for envelopes, opens them, writes the value into the backend namespace's
 * Secret, and confirms; the envelope is then nulled. No route returns a value or an envelope to
 * anyone but the controller's own credential, and the audit link names the actor, backend,
 * Secret and key — never the value.
 *
 * THE M28 CLASS, answered for the envelope:
 *  - WHO CAN READ IT: `stack_credentials` has no `scp_app` grant (drizzle/0130); only
 *    `scp_operator` reads it, and what it reads is ciphertext sealed to a key held in the
 *    controller's own namespace, which no scpd identity can read (ADR-0058 §6).
 *  - WHO CAN REPLAY IT: every envelope carries its sealing time (as `notAfter`, the time plus a
 *    fixed TTL) and a unique sequence, both bound into the GCM additional data; the controller
 *    refuses an envelope sealed no later than the last it applied to that target, and any past
 *    `notAfter`. (Ordered by time, not sequence: a restored or rebuilt database restarts the
 *    sequence, never the clock.)
 *  - WHO CAN REDIRECT IT: the target (backend, Secret, key) is in the additional data, so a row
 *    whose columns were rewritten fails the tag; the controller also holds the target to the
 *    catalog it carries and derives the NAMESPACE from the backend itself — it is never sent.
 *  - WHO CAN FORGE ONE: anyone with the public key can seal SOMETHING, but the only writer of the
 *    table is `scp_operator`, which is instance authority already (the same authority the API
 *    door requires). Stated in ADR-0063, not hidden.
 */

const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

const rawToPublicKey = (raw: Buffer): KeyObject =>
  createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });

const sha256Hex = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

/** Seals `plaintext` to the controller's public key, with `aad` as the GCM additional data. */
export function sealCredential(
  recipientRawB64: string,
  aad: string,
  plaintext: Buffer
): StackCredentialEnvelope {
  const recipientRaw = Buffer.from(recipientRawB64, "base64");
  const recipient = rawToPublicKey(recipientRaw);
  const eph = generateKeyPairSync("x25519");
  const epk = (eph.publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(
    X25519_SPKI_PREFIX.length
  );
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: recipient });
  const key = Buffer.from(
    hkdfSync("sha256", shared, Buffer.concat([epk, recipientRaw]), STACK_CREDENTIAL_HKDF_INFO, 32)
  );
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  shared.fill(0);
  key.fill(0);
  return {
    v: 1,
    epk: epk.toString("base64"),
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: tag.toString("base64")
  };
}

// ---- the controller's sealing key ---------------------------------------------------------------

export interface SealingKey {
  publicKey: string;
  keyId: string;
}

async function currentSealingKey(client: pg.PoolClient, lock: boolean): Promise<SealingKey | null> {
  const row = (
    await client.query<{ k: string | null; id: string | null }>(
      `SELECT credential_sealing_key AS k, credential_sealing_key_sha256 AS id
         FROM stack_settings WHERE id = 'instance'${lock ? " FOR UPDATE" : ""}`
    )
  ).rows[0];
  return row?.k && row.id ? { publicKey: row.k, keyId: row.id } : null;
}

/**
 * The controller publishes (or re-publishes) its public key. A CHANGED key strands every envelope
 * sealed to the old one — scpd cannot re-seal what it never kept — so those are marked failed,
 * with the reason, for the operator to enter again.
 */
export async function publishSealingKey(
  client: pg.PoolClient,
  req: PutStackCredentialSealingKeyRequest,
  actor: InstanceActor,
  requestId: string
): Promise<void> {
  const raw = Buffer.from(req.publicKey, "base64");
  if (sha256Hex(raw) !== req.keyId) {
    throw badRequest("keyId must be the sha256 of the public key's 32 raw bytes");
  }
  // A key that is not a point X25519 accepts is refused here rather than at the first seal.
  try {
    rawToPublicKey(raw);
  } catch {
    throw badRequest("publicKey is not an X25519 public key");
  }
  await client.query(
    "INSERT INTO stack_settings (id) VALUES ('instance') ON CONFLICT (id) DO NOTHING"
  );
  const before = await currentSealingKey(client, true);
  if (before?.keyId === req.keyId) return;
  await client.query(
    `UPDATE stack_settings SET credential_sealing_key = $1, credential_sealing_key_sha256 = $2,
            credential_sealing_key_at = now() WHERE id = 'instance'`,
    [req.publicKey, req.keyId]
  );
  const stranded = await client.query(
    `UPDATE stack_credentials
        SET state = 'failed', pending_op = NULL, envelope = NULL, delivery_id = NULL,
            last_error = 'the stack controller''s sealing key changed before this was delivered; enter the value again'
      WHERE state = 'pending' AND sealed_to IS DISTINCT FROM $1`,
    [req.keyId]
  );
  await appendInstanceAudit(client, {
    action: "stack.credential.sealing-key",
    actor,
    subject: null,
    detail: { before: before?.keyId ?? null, after: req.keyId, stranded: stranded.rowCount ?? 0 },
    requestId
  });
}

// ---- requests (instance authority) --------------------------------------------------------------

export interface CredentialTarget {
  backend: string;
  secretName: string;
  key: string;
}

function assertTarget(t: CredentialTarget): void {
  if (!isCatalogTarget(t.backend, t.secretName, t.key)) {
    throw badRequest(
      `${t.backend} has no credential ${t.secretName}/${t.key} — the Secrets and keys a value may be written to are a fixed catalog (GET /instance/stack/credentials lists it)`
    );
  }
}

/**
 * Seals a set (with the value) or a delete (with nothing) for one catalog target and stores the
 * envelope, in the caller's operator transaction, with its audit link. The value is copied into a
 * Buffer that is zeroed once sealed; the request body's own string is the one copy this process
 * cannot scrub, and it goes when the request does.
 */
export async function requestCredentialChange(
  client: pg.PoolClient,
  input: CredentialTarget & {
    op: StackCredentialOp;
    value?: string;
    actor: InstanceActor;
    requestId: string;
    now?: Date;
  }
): Promise<StackCredentialKeyView> {
  assertTarget(input);
  const key = await currentSealingKey(client, false);
  if (!key) {
    throw conflict(
      "the stack controller has not published its sealing key yet, so there is nowhere safe to send a value — is the controller running? (Admin › Stack shows whether it reports)"
    );
  }
  const seq = Number(
    (await client.query<{ n: string }>("SELECT nextval('stack_credential_seq') AS n")).rows[0]!.n
  );
  const deliveryId = randomUUID();
  const notAfter = new Date(
    (input.now ?? new Date()).getTime() + STACK_CREDENTIAL_ENVELOPE_TTL_MS
  ).toISOString();
  const aad = credentialEnvelopeAad({
    deliveryId,
    seq,
    backend: input.backend,
    secretName: input.secretName,
    key: input.key,
    op: input.op,
    keyId: key.keyId,
    notAfter
  });
  const plaintext = input.op === "set" ? Buffer.from(input.value ?? "", "utf8") : Buffer.alloc(0);
  let envelope: StackCredentialEnvelope;
  try {
    envelope = sealCredential(key.publicKey, aad, plaintext);
  } finally {
    plaintext.fill(0);
  }
  await client.query(
    `INSERT INTO stack_credentials
       (backend, secret_name, key, state, pending_op, delivery_id, seq, sealed_to, not_after,
        envelope, requested_by, requested_at, last_error)
       VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, now(), NULL)
     ON CONFLICT (backend, secret_name, key) DO UPDATE SET
       state = 'pending', pending_op = EXCLUDED.pending_op, delivery_id = EXCLUDED.delivery_id,
       seq = EXCLUDED.seq, sealed_to = EXCLUDED.sealed_to, not_after = EXCLUDED.not_after,
       envelope = EXCLUDED.envelope, requested_by = EXCLUDED.requested_by,
       requested_at = now(), last_error = NULL`,
    [
      input.backend,
      input.secretName,
      input.key,
      input.op,
      deliveryId,
      seq,
      key.keyId,
      notAfter,
      JSON.stringify(envelope),
      JSON.stringify(input.actor)
    ]
  );
  // THE AUDIT LINK: who, which backend, Secret and key, and the delivery — never the value.
  await appendInstanceAudit(client, {
    action: input.op === "set" ? "stack.credential.set" : "stack.credential.delete",
    actor: input.actor,
    subject: `${input.backend}/${input.secretName}/${input.key}`,
    detail: {
      backend: input.backend,
      secretName: input.secretName,
      key: input.key,
      deliveryId,
      seq
    },
    requestId: input.requestId
  });
  const view = (await readCredentialRows(client)).get(targetKey(input));
  return keyView(input, view);
}

// ---- the controller's doors ----------------------------------------------------------------------

interface CredentialRow extends Record<string, unknown> {
  backend: string;
  secret_name: string;
  key: string;
  state: string;
  pending_op: string | null;
  delivery_id: string | null;
  seq: string | number | null;
  sealed_to: string | null;
  not_after: Date | string | null;
  envelope: unknown;
  requested_by: InstanceActor | null;
  requested_at: Date | string | null;
  delivered_at: Date | string | null;
  last_error: string | null;
}

const iso = (v: Date | string | null): string | null =>
  v === null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString();

/** Every pending envelope. Each is parsed against its schema; a row that does not parse (edited
 *  out of band) is not handed to the controller at all. */
export async function listPendingDeliveries(
  client: pg.PoolClient
): Promise<StackCredentialDelivery[]> {
  const rows = (
    await client.query<CredentialRow>(
      `SELECT * FROM stack_credentials WHERE state = 'pending' ORDER BY seq`
    )
  ).rows;
  return rows.flatMap((r) => {
    const parsed = StackCredentialDeliverySchema.safeParse({
      deliveryId: r.delivery_id,
      seq: r.seq === null ? null : Number(r.seq),
      backend: r.backend,
      secretName: r.secret_name,
      key: r.key,
      op: r.pending_op,
      keyId: r.sealed_to,
      notAfter: iso(r.not_after),
      envelope: r.envelope
    });
    return parsed.success ? [parsed.data] : [];
  });
}

const REFUSAL_TEXT: Record<string, string> = {
  tampered:
    "the stack controller refused the sealed value: its envelope or header had been altered",
  "wrong-key":
    "the stack controller refused the sealed value: it was sealed to a key it does not hold",
  replayed:
    "the stack controller refused the sealed value as a replay (a newer value was already applied)",
  expired: "the stack controller received the sealed value after it expired; enter it again",
  "not-in-catalog": "the stack controller refused the target: not in the catalog it carries"
};

/** The controller confirms a delivery: the envelope is dropped whatever the outcome, and only the
 *  delivery it names — a newer request for the same target is never cleared by an older ack. */
export async function ackDelivery(
  client: pg.PoolClient,
  deliveryId: string,
  ack: AckStackCredentialDeliveryRequest,
  actor: InstanceActor,
  requestId: string
): Promise<void> {
  const res =
    ack.outcome === "applied"
      ? await client.query<CredentialRow>(
          `UPDATE stack_credentials
              SET state = CASE pending_op WHEN 'set' THEN 'set' ELSE 'unset' END,
                  pending_op = NULL, envelope = NULL, delivered_at = now(), last_error = NULL
            WHERE delivery_id = $1 AND seq = $2 AND state = 'pending'
            RETURNING backend, secret_name, key`,
          [deliveryId, ack.seq]
        )
      : await client.query<CredentialRow>(
          `UPDATE stack_credentials
              SET state = 'failed', pending_op = NULL, envelope = NULL, last_error = $3
            WHERE delivery_id = $1 AND seq = $2 AND state = 'pending'
            RETURNING backend, secret_name, key`,
          [deliveryId, ack.seq, REFUSAL_TEXT[ack.reason] ?? ack.reason]
        );
  const row = res.rows[0];
  if (!row) {
    throw conflict(
      "no pending delivery matches that id and sequence (superseded by a newer request, or already confirmed)"
    );
  }
  await appendInstanceAudit(client, {
    action: ack.outcome === "applied" ? "stack.credential.delivered" : "stack.credential.refused",
    actor,
    subject: `${row.backend}/${row.secret_name}/${row.key}`,
    detail: {
      backend: row.backend,
      secretName: row.secret_name,
      key: row.key,
      deliveryId,
      seq: ack.seq,
      ...(ack.outcome === "refused" ? { reason: ack.reason } : {})
    },
    requestId
  });
}

// ---- the read model (metadata only) --------------------------------------------------------------

const targetKey = (t: CredentialTarget) => `${t.backend}\u0000${t.secretName}\u0000${t.key}`;

async function readCredentialRows(client: pg.PoolClient): Promise<Map<string, CredentialRow>> {
  // Every column but the envelope: the read model never carries it.
  const rows = (
    await client.query<CredentialRow>(
      `SELECT backend, secret_name, key, state, pending_op, requested_by, requested_at,
              delivered_at, last_error FROM stack_credentials`
    )
  ).rows;
  return new Map(
    rows.map((r) => [targetKey({ backend: r.backend, secretName: r.secret_name, key: r.key }), r])
  );
}

function keyView(t: CredentialTarget, row: CredentialRow | undefined): StackCredentialKeyView {
  const secret = (
    STACK_CREDENTIAL_CATALOG as Record<string, Record<string, { keys: Record<string, string> }>>
  )[t.backend]![t.secretName]!;
  return {
    backend: t.backend as StackCredentialKeyView["backend"],
    secretName: t.secretName as StackCredentialKeyView["secretName"],
    key: t.key as StackCredentialKeyView["key"],
    description: secret.keys[t.key]!,
    state: (row?.state as StackCredentialKeyView["state"] | undefined) ?? "unset",
    pendingOp: (row?.pending_op as StackCredentialOp | null | undefined) ?? null,
    requestedBy: row?.requested_by ?? null,
    requestedAt: iso(row?.requested_at ?? null),
    deliveredAt: iso(row?.delivered_at ?? null),
    error: row?.last_error ?? null
  };
}

interface WorkloadIdentityRow extends Record<string, unknown> {
  backend: string;
  service_account: string;
  provider: string;
  identifier: string;
  declared_by: InstanceActor;
  declared_at: Date | string;
}

const SELECT_WORKLOAD_IDENTITIES = `SELECT backend, service_account, provider, identifier, declared_by, declared_at
    FROM stack_workload_identities ORDER BY backend, service_account`;

/** The declared workload identities as the controller's spec carries them. A row that no longer
 *  parses (a slot or pattern the schema has since narrowed) is dropped, never rendered. */
export function workloadIdentitySpecs(
  rows: Record<string, unknown>[]
): StackWorkloadIdentitySpec[] {
  return rows.flatMap((r) => {
    const parsed = StackWorkloadIdentitySpecSchema.safeParse({
      backend: r["backend"],
      serviceAccount: r["service_account"],
      provider: r["provider"],
      identifier: r["identifier"]
    });
    return parsed.success && isWorkloadIdentitySlot(parsed.data.backend, parsed.data.serviceAccount)
      ? [parsed.data]
      : [];
  });
}

export { SELECT_WORKLOAD_IDENTITIES };

export async function credentialsView(client: pg.PoolClient): Promise<StackCredentialsView> {
  const rows = await readCredentialRows(client);
  const settings = (
    await client.query<{ k: string | null; at: Date | string | null }>(
      `SELECT credential_sealing_key AS k, credential_sealing_key_at AS at
         FROM stack_settings WHERE id = 'instance'`
    )
  ).rows[0];
  const wi = new Map(
    (await client.query<WorkloadIdentityRow>(SELECT_WORKLOAD_IDENTITIES)).rows.map((r) => [
      `${r.backend}/${r.service_account}`,
      r
    ])
  );
  return {
    secrets: Object.entries(STACK_CREDENTIAL_CATALOG).flatMap(([backend, secrets]) =>
      Object.entries(secrets).map(([secretName, s]) => ({
        backend: backend as StackCredentialKeyView["backend"],
        secretName: secretName as StackCredentialKeyView["secretName"],
        purpose: s.purpose,
        keys: Object.keys(s.keys).map((key) =>
          keyView({ backend, secretName, key }, rows.get(targetKey({ backend, secretName, key })))
        )
      }))
    ),
    workloadIdentities: Object.entries(STACK_WORKLOAD_IDENTITY_SLOTS).flatMap(([backend, slots]) =>
      Object.entries(slots).map(([serviceAccount, description]) => {
        const r = wi.get(`${backend}/${serviceAccount}`);
        const binding = r ? (workloadIdentitySpecs([r])[0] ?? null) : null;
        return {
          backend: backend as keyof typeof STACK_WORKLOAD_IDENTITY_SLOTS,
          serviceAccount: serviceAccount as StackWorkloadIdentityView["serviceAccount"],
          description,
          binding: binding
            ? ({
                provider: binding.provider,
                identifier: binding.identifier
              } as StackWorkloadIdentityBinding)
            : null,
          declaredBy: r?.declared_by ?? null,
          declaredAt: iso(r?.declared_at ?? null)
        };
      })
    ),
    sealingKey: { published: Boolean(settings?.k), publishedAt: iso(settings?.at ?? null) }
  };
}

// ---- workload identity (instance authority) -----------------------------------------------------

export async function declareWorkloadIdentity(
  client: pg.PoolClient,
  input: {
    backend: string;
    serviceAccount: string;
    binding: StackWorkloadIdentityBinding | null;
    actor: InstanceActor;
    requestId: string;
  }
): Promise<void> {
  if (!isWorkloadIdentitySlot(input.backend, input.serviceAccount)) {
    throw badRequest(
      `${input.serviceAccount} is not a ServiceAccount of ${input.backend} a workload identity may be declared for`
    );
  }
  const before = (
    await client.query<{ provider: string; identifier: string }>(
      `SELECT provider, identifier FROM stack_workload_identities
        WHERE backend = $1 AND service_account = $2 FOR UPDATE`,
      [input.backend, input.serviceAccount]
    )
  ).rows[0];
  if (input.binding) {
    await client.query(
      `INSERT INTO stack_workload_identities
         (backend, service_account, provider, identifier, declared_by, declared_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, now())
       ON CONFLICT (backend, service_account) DO UPDATE SET
         provider = EXCLUDED.provider, identifier = EXCLUDED.identifier,
         declared_by = EXCLUDED.declared_by, declared_at = now()`,
      [
        input.backend,
        input.serviceAccount,
        input.binding.provider,
        input.binding.identifier,
        JSON.stringify(input.actor)
      ]
    );
  } else {
    await client.query(
      "DELETE FROM stack_workload_identities WHERE backend = $1 AND service_account = $2",
      [input.backend, input.serviceAccount]
    );
  }
  await appendInstanceAudit(client, {
    action: input.binding ? "stack.workload-identity.declare" : "stack.workload-identity.remove",
    actor: input.actor,
    subject: `${input.backend}/${input.serviceAccount}`,
    // An identifier names a cloud identity, not a secret: it is recorded, before and after.
    detail: { before: before ?? null, after: input.binding },
    requestId: input.requestId
  });
}
