import { randomBytes } from "node:crypto";
import * as argon2 from "argon2";
import { v7 as uuidv7 } from "uuid";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { personalAccessTokens } from "../db/schema.js";
import { resolveAuthContext, type AuthContext } from "./local-auth.js";

const PAT_PREFIX = "scp_pat_";

/**
 * Personal Access Tokens (M2 stage 2 Part A, BUILD_AND_TEST.md §8 M2 item 3) — hashed at rest
 * (argon2, like local-auth passwords), never stored or returned in plaintext after creation.
 *
 * Token shape: `scp_pat_<tokenId>.<secret>`. `tokenId` (16 random URL-safe base64 chars) is a
 * CLEARTEXT, indexed lookup key — argon2's output is salted/non-comparable, so unlike
 * `sessions.tokenHash`'s SHA-256 equality lookup, a presented PAT can't be found by hashing it and
 * matching a row directly. `secret` (32+ random bytes, base64url) is the part that's actually
 * argon2-hashed into `tokenHash` and verified on every use.
 */

function generateTokenId(): string {
  return randomBytes(12).toString("base64url"); // 16 base64url chars
}

function generateSecret(): string {
  return randomBytes(32).toString("base64url");
}

export interface CreatedPat {
  id: string;
  name: string;
  /** The full `scp_pat_<tokenId>.<secret>` string — shown to the caller ONCE, never retrievable again. */
  token: string;
  createdAt: Date;
  expiresAt: Date | null;
}

export async function createPat(
  db: Db,
  params: { orgId: string; userId: string; name: string; expiresAt?: Date | null }
): Promise<CreatedPat> {
  const tokenId = generateTokenId();
  const secret = generateSecret();
  const tokenHash = await argon2.hash(secret);
  const id = uuidv7();
  const createdAt = new Date();
  const expiresAt = params.expiresAt ?? null;

  await db.insert(personalAccessTokens).values({
    id,
    orgId: params.orgId,
    userId: params.userId,
    name: params.name,
    tokenId,
    tokenHash,
    createdAt,
    expiresAt
  });

  return {
    id,
    name: params.name,
    token: `${PAT_PREFIX}${tokenId}.${secret}`,
    createdAt,
    expiresAt
  };
}

export interface PatMetadata {
  id: string;
  name: string;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
}

function toPatMetadata(row: typeof personalAccessTokens.$inferSelect): PatMetadata {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    lastUsedAt: row.lastUsedAt
  };
}

/** Lists the caller's own PATs — metadata only; `tokenId`/`tokenHash` are never surfaced. */
export async function listPats(
  db: Db,
  params: { orgId: string; userId: string }
): Promise<PatMetadata[]> {
  const rows = await db.query.personalAccessTokens.findMany({
    where: and(
      eq(personalAccessTokens.orgId, params.orgId),
      eq(personalAccessTokens.userId, params.userId)
    )
  });
  return rows.map(toPatMetadata);
}

/**
 * Revokes a PAT owned by `(orgId, userId)`. Returns `null` if no such (unrevoked) PAT exists —
 * callers should turn that into a 404 regardless of whether the id doesn't exist, belongs to
 * someone else, or was already revoked, so existence doesn't leak across users.
 */
export async function revokePat(
  db: Db,
  params: { orgId: string; userId: string; id: string }
): Promise<PatMetadata | null> {
  const [row] = await db
    .update(personalAccessTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(personalAccessTokens.id, params.id),
        eq(personalAccessTokens.orgId, params.orgId),
        eq(personalAccessTokens.userId, params.userId),
        isNull(personalAccessTokens.revokedAt)
      )
    )
    .returning();
  return row ? toPatMetadata(row) : null;
}

/** Cheap shape check — lets `require-auth.ts` route to PAT vs. session-token verification without a DB round trip. */
export function isPatToken(token: string): boolean {
  return token.startsWith(PAT_PREFIX);
}

/**
 * Verifies a `scp_pat_<tokenId>.<secret>` bearer token and resolves it to the exact same
 * `AuthContext` shape a session token would produce for the owning user (same RBAC subject, same
 * org) — a PAT is exactly as permission-scoped as the user's own session, never more.
 */
export async function verifyPat(db: Db, token: string): Promise<AuthContext | null> {
  if (!token.startsWith(PAT_PREFIX)) return null;
  const rest = token.slice(PAT_PREFIX.length);
  const dotIndex = rest.indexOf(".");
  if (dotIndex === -1) return null;
  const tokenId = rest.slice(0, dotIndex);
  const secret = rest.slice(dotIndex + 1);
  if (!tokenId || !secret) return null;

  const row = await db.query.personalAccessTokens.findFirst({
    where: eq(personalAccessTokens.tokenId, tokenId)
  });
  if (!row) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;

  const valid = await argon2.verify(row.tokenHash, secret).catch(() => false);
  if (!valid) return null;

  // Best-effort — must never block/fail auth if this update fails (e.g. transient DB hiccup).
  void db
    .update(personalAccessTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(personalAccessTokens.id, row.id))
    .catch(() => undefined);

  return resolveAuthContext(db, row.userId);
}
