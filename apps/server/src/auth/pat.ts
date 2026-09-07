import * as argon2 from "argon2";
import { v7 as uuidv7 } from "uuid";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { personalAccessTokens } from "../db/schema.js";
import { resolveAuthContext, type AuthContext } from "./local-auth.js";
import {
  generateTokenId,
  generateTokenSecret,
  mintPrefixedToken,
  verifyPrefixedToken
} from "./prefixed-token.js";

const PAT_PREFIX = "scp_pat_";

/** Personal Access Tokens. See docs/auth.md §33. */

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
  const secret = generateTokenSecret();
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
    token: mintPrefixedToken(PAT_PREFIX, tokenId, secret),
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

/** Revokes a PAT owned by `(orgId, userId)`. See docs/auth.md §34. */
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

/** A PAT resolves to the user's own context, never a broader one. See docs/auth.md §35. */
export async function verifyPat(db: Db, token: string): Promise<AuthContext | null> {
  const row = await verifyPrefixedToken({
    prefix: PAT_PREFIX,
    presented: token,
    findByTokenId: (tokenId) =>
      db.query.personalAccessTokens.findFirst({
        where: eq(personalAccessTokens.tokenId, tokenId)
      }),
    touchLastUsed: (id) =>
      db
        .update(personalAccessTokens)
        .set({ lastUsedAt: new Date() })
        .where(eq(personalAccessTokens.id, id))
  });
  if (!row) return null;

  return resolveAuthContext(db, row.userId);
}
