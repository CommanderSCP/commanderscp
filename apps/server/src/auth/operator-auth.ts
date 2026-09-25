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
import type pg from "pg";
import {
  generateTokenId,
  generateTokenSecret,
  mintPrefixedToken,
  SHA256_HASH_PREFIX,
  verifyPrefixedToken
} from "./prefixed-token.js";

/** INSTANCE-TIER OPERATOR AUTHENTICATION. See docs/auth.md §25. */

const OPERATOR_PREFIX = "scp_op_";

/** How a request was admitted — surfaced so "are we still on the bootstrap token?" is answerable. */
export type OperatorAuthMechanism = "credential" | "bootstrap-env-token";

export interface OperatorAuthResult {
  mechanism: OperatorAuthMechanism;
  /** `full` for every door; `stack-controller` only for the stack controller's two (ADR-0058). */
  scope: "full" | "stack-controller";
  /** The credential row's id, or `null` for the env token. */
  credentialId: string | null;
  credentialName: string | null;
}

/** Constant-time comparison for the bootstrap env token. See docs/auth.md §26. */
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

/** Mints a credential. See docs/auth.md §27. */
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

/** Revokes by stamping `revoked_at`, never by DELETE. See docs/auth.md §28. */
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

/** The name the install-time stack-controller credential is recorded under (M29.4, ADR-0058). */
export const STACKD_INSTALL_CREDENTIAL_NAME = "scp-stackd (install-time)";

/** Advisory-lock class for install-credential provisioning, distinct from provision.ts's. */
const INSTALL_CREDENTIAL_LOCK_CLASSID = 0x5c_70_57_ad;

/**
 * INSTALL-TIME OPERATOR CREDENTIAL for the stack controller (M29.4, ADR-0058).
 *
 * The chart generates the whole `scp_op_<tokenId>.<secret>` once and mounts it into exactly two
 * pods: the stack controller, which presents it, and the migrations Job, which calls this with its
 * ADMIN connection to record the argon2 hash. The api/worker pods never hold the plaintext, and no
 * route returns it: `listOperatorCredentials` never projects a secret or a hash.
 *
 * Idempotent on every upgrade. A token id already present with a matching secret is left alone; a
 * present id whose secret does NOT verify is refused rather than overwritten, because that row is
 * somebody else's; a present row an operator REVOKED stays revoked. When the chart's Secret is replaced (a deliberate rotation), the previous
 * install-time row is revoked in the same transaction — only rows this function wrote (bootstrap-
 * minted, carrying this name), never a credential a person minted.
 */
export async function provisionInstallOperatorCredential(
  adminPool: pg.Pool,
  input: { name: string; tokenId: string; secretSha256: string }
): Promise<"created" | "unchanged" | "revoked"> {
  const tokenId = input.tokenId.trim();
  const sha = input.secretSha256.trim().toLowerCase();
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(tokenId) || !/^[0-9a-f]{64}$/.test(sha)) {
    throw new Error(
      `the install-time operator credential for '${input.name}' is not well-formed ` +
        "(a token id of 16-64 URL-safe characters and a sha256 in hex) — refusing to record it"
    );
  }
  const tokenHash = `${SHA256_HASH_PREFIX}${sha}`;
  const client = await adminPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [
      INSTALL_CREDENTIAL_LOCK_CLASSID,
      input.name
    ]);
    const existing = await client.query<{
      id: string;
      token_hash: string;
      revoked_at: Date | null;
      scope: string;
    }>(
      "SELECT id, token_hash, revoked_at, scope FROM instance_operator_credentials WHERE token_id = $1",
      [tokenId]
    );
    let outcome: "created" | "unchanged" | "revoked" = "unchanged";
    let id: string;
    const row = existing.rows[0];
    if (row) {
      if (row.token_hash !== tokenHash || row.scope !== "stack-controller") {
        throw new Error(
          `an operator credential with this token id already exists and does not match ` +
            `'${input.name}' — refusing to overwrite it; replace the install secret`
        );
      }
      id = row.id;
      // A revocation is an operator's decision and survives every upgrade: never resurrected here.
      if (row.revoked_at !== null) outcome = "revoked";
    } else {
      id = uuidv7();
      await client.query(
        `INSERT INTO instance_operator_credentials
           (id, name, token_id, token_hash, created_by_user_id, scope)
         VALUES ($1, $2, $3, $4, NULL, 'stack-controller')`,
        [id, input.name, tokenId, tokenHash]
      );
      outcome = "created";
    }
    // ROTATION REVOKES BY ID. The previous install-time credential is the one this deployment
    // recorded, never "whatever else carries this name" (a person can mint any name).
    const previous = await client.query<{ controller_credential_id: string | null }>(
      "SELECT controller_credential_id FROM stack_settings WHERE id = 'instance'"
    );
    const previousId = previous.rows[0]?.controller_credential_id ?? null;
    if (previousId !== null && previousId !== id) {
      await client.query(
        "UPDATE instance_operator_credentials SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL",
        [previousId]
      );
    }
    await client.query(
      `INSERT INTO stack_settings (id, controller_credential_id) VALUES ('instance', $1)
       ON CONFLICT (id) DO UPDATE SET controller_credential_id = EXCLUDED.controller_credential_id`,
      [id]
    );
    await client.query("COMMIT");
    return outcome;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Verifies a presented `x-scp-operator-token`. See docs/auth.md §29. */
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

  return {
    mechanism: "credential",
    scope: row.scope === "stack-controller" ? "stack-controller" : "full",
    credentialId: row.id,
    credentialName: row.name
  };
}

/** THE ONE DEFINITION of what admits an instance-operator request. See docs/auth.md §30. */
export async function requireInstanceOperator(
  deps: AppDeps,
  request: FastifyRequest,
  surface: string
): Promise<OperatorAuthResult> {
  const presented = request.headers["x-scp-operator-token"];

  if (typeof presented === "string" && presented.length > 0) {
    const viaCredential = await verifyOperatorCredential(deps.db, presented);
    // A stack-controller-scoped credential opens the controller's two doors and nothing else
    // (ADR-0058, review N1): it is refused here exactly like an unknown one.
    if (viaCredential && viaCredential.scope === "full") return viaCredential;

    if (bootstrapTokenMatches(presented, deps.config.operatorToken)) {
      return {
        mechanism: "bootstrap-env-token",
        scope: "full",
        credentialId: null,
        credentialName: null
      };
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
