import { timingSafeEqual } from "node:crypto";
import * as argon2 from "argon2";
import { v7 as uuidv7 } from "uuid";
import { eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { Db } from "../db/client.js";
import type { ServerConfig } from "../config.js";
import { instanceOperatorCredentials } from "../db/schema.js";
import { forbidden } from "../errors.js";
import { withOperatorDb } from "../routes/operator-db.js";
import type { AppDeps } from "../types.js";
import {
  generateTokenId,
  generateTokenSecret,
  mintPrefixedToken,
  verifyPrefixedToken
} from "./prefixed-token.js";

/** INSTANCE-TIER OPERATOR AUTHENTICATION. See docs/auth/operator-auth.md §1. */

const OPERATOR_PREFIX = "scp_op_";

/** How a request was admitted — surfaced so "are we still on the bootstrap token?" is answerable. */
export type OperatorAuthMechanism = "credential" | "bootstrap-env-token";

export interface OperatorAuthResult {
  mechanism: OperatorAuthMechanism;
  /** The credential row's id, or `null` for the env token. */
  credentialId: string | null;
  credentialName: string | null;
}

/** Constant-time comparison for the bootstrap env token. See docs/auth/operator-auth.md §2. */
export function bootstrapTokenMatches(presented: unknown, configured: string | undefined): boolean {
  if (!configured || typeof presented !== "string" || presented.length === 0) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(configured, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface CreatedOperatorCredential {
  id: string;
  name: string;
  /** The full `scp_op_<tokenId>.<secret>` — returned ONCE and never retrievable again. */
  token: string;
  createdAt: Date;
  expiresAt: Date | null;
}

/** Mints a credential. See docs/auth/operator-auth.md §3. */
export async function createOperatorCredential(
  config: ServerConfig,
  input: { name: string; createdByUserId: string | null; expiresAt: Date | null }
): Promise<CreatedOperatorCredential> {
  const tokenId = generateTokenId();
  const secret = generateTokenSecret();
  const tokenHash = await argon2.hash(secret);
  const id = uuidv7();

  const row = await withOperatorDb(config, "instance operator credentials", async (client) => {
    const res = await client.query<{ created_at: Date; expires_at: Date | null }>(
      `INSERT INTO instance_operator_credentials
         (id, name, token_id, token_hash, created_by_user_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING created_at, expires_at`,
      [id, input.name, tokenId, tokenHash, input.createdByUserId, input.expiresAt]
    );
    return res.rows[0]!;
  });

  return {
    id,
    name: input.name,
    token: mintPrefixedToken(OPERATOR_PREFIX, tokenId, secret),
    createdAt: row.created_at,
    expiresAt: row.expires_at
  };
}

export interface OperatorCredentialSummary {
  id: string;
  name: string;
  createdByUserId: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
}

/** Never projects `tokenHash`. The column is not serialized by any route. */
export async function listOperatorCredentials(db: Db): Promise<OperatorCredentialSummary[]> {
  const rows = await db
    .select({
      id: instanceOperatorCredentials.id,
      name: instanceOperatorCredentials.name,
      createdByUserId: instanceOperatorCredentials.createdByUserId,
      createdAt: instanceOperatorCredentials.createdAt,
      expiresAt: instanceOperatorCredentials.expiresAt,
      revokedAt: instanceOperatorCredentials.revokedAt,
      lastUsedAt: instanceOperatorCredentials.lastUsedAt
    })
    .from(instanceOperatorCredentials);
  return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

/** Revokes by stamping `revoked_at`, never by DELETE. See docs/auth/operator-auth.md §4. */
export async function revokeOperatorCredential(config: ServerConfig, id: string): Promise<boolean> {
  return withOperatorDb(config, "instance operator credentials", async (client) => {
    const res = await client.query(
      `UPDATE instance_operator_credentials SET revoked_at = now()
        WHERE id = $1 AND revoked_at IS NULL
        RETURNING id`,
      [id]
    );
    return (res.rowCount ?? 0) > 0;
  });
}

/** Verifies a presented `x-scp-operator-token`. See docs/auth/operator-auth.md §5. */
export async function verifyOperatorCredential(
  db: Db,
  presented: string
): Promise<OperatorAuthResult | null> {
  const row = await verifyPrefixedToken({
    prefix: OPERATOR_PREFIX,
    presented,
    findByTokenId: (tokenId) =>
      db.query.instanceOperatorCredentials.findFirst({
        where: eq(instanceOperatorCredentials.tokenId, tokenId)
      }),
    touchLastUsed: (id) =>
      db
        .update(instanceOperatorCredentials)
        .set({ lastUsedAt: new Date() })
        .where(eq(instanceOperatorCredentials.id, id))
  });
  if (!row) return null;

  return { mechanism: "credential", credentialId: row.id, credentialName: row.name };
}

/**
 * THE ONE DEFINITION of what admits an instance-operator request. Replaces eight hand-written
 * copies.
 *
 * `surface` is the per-door phrase those copies each carried ("instance freezes are
 * operator-authored", "scanner assignments ..."), kept because a refusal that names the door an
 * operator was trying to open is materially more useful than a generic one — that part of the
 * duplication was worth preserving, and it is the only part.
 */
export async function requireInstanceOperator(
  deps: AppDeps,
  request: FastifyRequest,
  surface: string
): Promise<OperatorAuthResult> {
  const presented = request.headers["x-scp-operator-token"];

  if (typeof presented === "string" && presented.length > 0) {
    const viaCredential = await verifyOperatorCredential(deps.db, presented);
    if (viaCredential) return viaCredential;

    if (bootstrapTokenMatches(presented, deps.config.operatorToken)) {
      return { mechanism: "bootstrap-env-token", credentialId: null, credentialName: null };
    }
  }

  // The two failure shapes are told apart ONLY when the deployment has no credential path at all,
  // because that is a deployment fact the operator reading it can act on ("nothing is configured"),
  // not a fact about the presented secret.
  if (!deps.config.operatorToken) {
    const anyCredential = await deps.db.query.instanceOperatorCredentials.findFirst({});
    if (!anyCredential) {
      throw forbidden(
        `${surface} is operator-authored, and this deployment has no operator credential ` +
          `configured: SCP_OPERATOR_TOKEN is unset and no instance operator credential has been ` +
          `minted, so the write surface is closed. Set SCP_OPERATOR_TOKEN once to bootstrap, then ` +
          `mint a credential via POST /api/v1/instance/operator-credentials and unset it.`
      );
    }
  }

  throw forbidden(
    `${surface} requires a deployment operator credential (x-scp-operator-token). No tenant role ` +
      `can grant this — these writes bind every organization on the deployment.`
  );
}
