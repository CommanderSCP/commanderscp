import { createHash } from "node:crypto";
import type pg from "pg";
import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { FastifyRequest } from "fastify";
import type { InstanceActor, InstanceAuditEvent } from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { forbidden } from "../errors.js";
import { requireAuth } from "./require-auth.js";
import { bootstrapTokenMatches, verifyOperatorCredential } from "./operator-auth.js";

/**
 * INSTANCE-OPERATOR AUTHORITY (owner decision 2026-09-25, ADR-0058).
 *
 * Instance-tier authority is a ROLE granted to a user and checked server-side against their normal
 * login session — the browser never holds a deployment credential. Machines (the CLI in a script,
 * the stack controller) keep presenting operator credentials. So a door that accepts "instance
 * authority" admits EITHER:
 *   - a `full`-scope operator credential or the bootstrap env token (`x-scp-operator-token`), or
 *   - a session whose user holds a live `instance_operator_grants` row.
 * A `stack-controller`-scoped credential is neither: it opens the controller's two doors only.
 */

export class InstanceAuthorityError extends Error {}

function actorOf(
  mechanism: InstanceActor["mechanism"],
  fields: Partial<Omit<InstanceActor, "mechanism">> = {}
): InstanceActor {
  return {
    mechanism,
    orgId: fields.orgId ?? null,
    userId: fields.userId ?? null,
    username: fields.username ?? null,
    credentialId: fields.credentialId ?? null
  };
}

/** Whether (orgId, userId) holds a live instance-operator grant — read inside the tenant tx, under
 *  the grants table's own-org read policy. */
export async function sessionHoldsInstanceOperator(
  deps: AppDeps,
  auth: { orgId: string; userId: string }
): Promise<boolean> {
  return withTenantTx(deps.db, auth.orgId, async (tx) => {
    const res = await tx.execute(sql`
      SELECT 1 FROM instance_operator_grants
       WHERE org_id = ${auth.orgId} AND user_id = ${auth.userId} AND revoked_at IS NULL
       LIMIT 1`);
    return res.rows.length > 0;
  });
}

/** Credential header first (machines), else the session's role. */
export async function requireInstanceAuthority(
  deps: AppDeps,
  request: FastifyRequest,
  surface: string
): Promise<InstanceActor> {
  const presented = request.headers["x-scp-operator-token"];
  if (typeof presented === "string" && presented.length > 0) {
    const cred = await verifyOperatorCredential(deps.db, presented);
    if (cred && cred.scope === "full") {
      return actorOf("credential", { credentialId: cred.credentialId });
    }
    if (bootstrapTokenMatches(presented, deps.config.operatorToken)) {
      return actorOf("bootstrap-env-token");
    }
    throw forbidden(
      `${surface} needs the instance-operator role or a deployment operator credential; the ` +
        "presented x-scp-operator-token is neither (a stack-controller credential opens only the " +
        "controller's own doors)"
    );
  }
  const auth = await requireAuth(deps, request);
  if (await sessionHoldsInstanceOperator(deps, auth)) {
    return actorOf("session-role", {
      orgId: auth.orgId,
      userId: auth.userId,
      username: auth.username
    });
  }
  throw forbidden(
    `${surface} changes software for every organization on this deployment, so it needs the ` +
      "instance-operator role. No org role grants it; an instance operator grants it " +
      "(Admin › Stack, `scp instance-operator grant`)."
  );
}

/** The stack controller's credential, and only it (ADR-0058, review N1). */
export async function requireStackControllerCredential(
  deps: AppDeps,
  request: FastifyRequest
): Promise<InstanceActor> {
  const presented = request.headers["x-scp-operator-token"];
  if (typeof presented === "string" && presented.length > 0) {
    const cred = await verifyOperatorCredential(deps.db, presented);
    if (cred && cred.scope === "stack-controller") {
      return actorOf("credential", { credentialId: cred.credentialId });
    }
  }
  throw forbidden(
    "only the stack controller's own install-time credential may write stack status — not an " +
      "operator's credential, and not a session"
  );
}

// ---- THE INSTANCE AUDIT CHAIN -------------------------------------------------------------------

export const INSTANCE_AUDIT_GENESIS = "0".repeat(64);

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

export function instanceAuditRowHash(e: Omit<InstanceAuditEvent, "rowHash">): string {
  return createHash("sha256")
    .update(e.prevHash)
    .update(
      canonical({
        id: e.id,
        seq: e.seq,
        action: e.action,
        actor: e.actor,
        subject: e.subject,
        detail: e.detail,
        requestId: e.requestId,
        occurredAt: e.occurredAt,
        prevHash: e.prevHash
      })
    )
    .digest("hex");
}

export interface InstanceAuditInput {
  action: string;
  actor: InstanceActor;
  subject: string | null;
  detail: Record<string, unknown>;
  requestId: string;
}

/**
 * Appends one link, IN THE CALLER'S TRANSACTION on the operator connection — the act and its
 * audit event commit or roll back together (principle 6). Serialized by a transaction-scoped
 * advisory lock so two writers cannot both extend the same tail.
 */
export async function appendInstanceAudit(
  client: pg.PoolClient,
  input: InstanceAuditInput
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('scp-instance-audit'))");
  const tail = await client.query<{ seq: string; row_hash: string }>(
    "SELECT seq, row_hash FROM instance_audit_events ORDER BY seq DESC LIMIT 1"
  );
  const prevHash = tail.rows[0]?.row_hash ?? INSTANCE_AUDIT_GENESIS;
  const seq = Number(tail.rows[0]?.seq ?? 0) + 1;
  const event: Omit<InstanceAuditEvent, "rowHash"> = {
    id: uuidv7(),
    seq,
    action: input.action,
    actor: input.actor,
    subject: input.subject,
    detail: input.detail,
    requestId: input.requestId,
    occurredAt: new Date().toISOString(),
    prevHash
  };
  await client.query(
    `INSERT INTO instance_audit_events
       (id, seq, action, actor, subject, detail, request_id, occurred_at, prev_hash, row_hash)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7, $8, $9, $10)`,
    [
      event.id,
      seq,
      event.action,
      JSON.stringify(event.actor),
      event.subject,
      JSON.stringify(event.detail),
      event.requestId,
      event.occurredAt,
      prevHash,
      instanceAuditRowHash(event)
    ]
  );
}

/** Re-walks the whole chain. */
export function verifyInstanceAuditChain(events: InstanceAuditEvent[]): {
  valid: boolean;
  brokenAt: string | null;
} {
  let prev = INSTANCE_AUDIT_GENESIS;
  for (const e of events) {
    if (e.prevHash !== prev || instanceAuditRowHash(e) !== e.rowHash) {
      return { valid: false, brokenAt: e.id };
    }
    prev = e.rowHash;
  }
  return { valid: true, brokenAt: null };
}

interface AuditRow extends Record<string, unknown> {
  id: string;
  seq: string | number;
  action: string;
  actor: InstanceActor;
  subject: string | null;
  detail: Record<string, unknown>;
  request_id: string;
  occurred_at: Date | string;
  prev_hash: string;
  row_hash: string;
}

export async function readInstanceAudit(client: pg.PoolClient): Promise<InstanceAuditEvent[]> {
  const res = await client.query<AuditRow>(
    `SELECT id, seq, action, actor, subject, detail, request_id, occurred_at, prev_hash, row_hash
       FROM instance_audit_events ORDER BY seq`
  );
  return res.rows.map((r) => ({
    id: r.id,
    seq: Number(r.seq),
    action: r.action,
    actor: r.actor,
    subject: r.subject,
    detail: r.detail,
    requestId: r.request_id,
    occurredAt: r.occurred_at instanceof Date ? r.occurred_at.toISOString() : String(r.occurred_at),
    prevHash: r.prev_hash,
    rowHash: r.row_hash
  }));
}
