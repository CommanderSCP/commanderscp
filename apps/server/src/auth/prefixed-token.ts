import { randomBytes } from "node:crypto";
import * as argon2 from "argon2";

/**
 * The `<prefix><tokenId>.<secret>` bearer-token shape shared by PATs (`pat.ts`) and instance
 * operator credentials (`operator-auth.ts`): `tokenId` is a cleartext, indexed lookup key (argon2's
 * output is salted/non-comparable, so a presented token can't be found by hashing it and matching a
 * row directly); `secret` is the part that's argon2-hashed at rest and verified on every use.
 *
 * Extracted after `verifyPat`/`verifyOperatorCredential` and their `generate*` helpers were found
 * byte-for-byte duplicated — this is the ONE definition of the parse/verify sequence, so a future
 * fix (e.g. to the ENOENT/expiry/revocation ordering) lands for both token kinds at once.
 */

export function generateTokenId(): string {
  return randomBytes(12).toString("base64url"); // 16 base64url chars
}

export function generateTokenSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** Builds the full `<prefix><tokenId>.<secret>` string shown to the caller once. */
export function mintPrefixedToken(prefix: string, tokenId: string, secret: string): string {
  return `${prefix}${tokenId}.${secret}`;
}

export interface ParsedPrefixedToken {
  tokenId: string;
  secret: string;
}

/** Splits `<prefix><tokenId>.<secret>` into its parts, or `null` for anything malformed. */
export function parsePrefixedToken(prefix: string, presented: string): ParsedPrefixedToken | null {
  if (!presented.startsWith(prefix)) return null;
  const rest = presented.slice(prefix.length);
  const dot = rest.indexOf(".");
  if (dot === -1) return null;
  const tokenId = rest.slice(0, dot);
  const secret = rest.slice(dot + 1);
  if (!tokenId || !secret) return null;
  return { tokenId, secret };
}

/** The columns every prefixed-token-backed row must carry for {@link verifyPrefixedToken} to
 *  apply the shared revoked/expired/secret checks — callers' rows carry more (userId, name, …). */
export interface PrefixedTokenRow {
  id: string;
  tokenHash: string;
  revokedAt: Date | null;
  expiresAt: Date | null;
}

export interface VerifyPrefixedTokenParams<Row extends PrefixedTokenRow> {
  prefix: string;
  presented: string;
  /** Looks up the row by its cleartext `tokenId` (e.g. a `findFirst` on the `token_id` column). */
  findByTokenId: (tokenId: string) => Promise<Row | undefined>;
  /** Best-effort "stamp last_used_at" — its own failure must never fail verification. */
  touchLastUsed: (id: string) => Promise<unknown>;
}

/**
 * Verifies a presented `<prefix><tokenId>.<secret>` token: parse, look up by `tokenId`, reject on
 * revoked/expired, argon2-verify the secret, then best-effort stamp `lastUsedAt`. Returns the row on
 * success so each caller can shape its own result (an `AuthContext` for a PAT, an
 * `OperatorAuthResult` for an operator credential) — never `null` vs. a reason, since neither caller
 * distinguishes "unknown" from "wrong secret" to the presenter.
 */
export async function verifyPrefixedToken<Row extends PrefixedTokenRow>(
  params: VerifyPrefixedTokenParams<Row>
): Promise<Row | null> {
  const parsed = parsePrefixedToken(params.prefix, params.presented);
  if (!parsed) return null;

  const row = await params.findByTokenId(parsed.tokenId);
  if (!row) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;

  const valid = await argon2.verify(row.tokenHash, parsed.secret).catch(() => false);
  if (!valid) return null;

  // Best-effort — must never block/fail auth if this update fails (e.g. transient DB hiccup).
  void params.touchLastUsed(row.id).catch(() => undefined);

  return row;
}
