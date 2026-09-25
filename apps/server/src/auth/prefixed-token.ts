import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * `sha256:<hex>` — the hash of a MACHINE-GENERATED secret (M29.4, ADR-0058: the stack controller's
 * install-time credential). argon2 exists to slow the guessing of a low-entropy password; a
 * 43-character random secret has nothing to guess, and a sha256 is what Helm can compute at render
 * time — which is what keeps the plaintext out of every namespace but the controller's own. Only
 * install-time provisioning writes this form; every minted credential and PAT stays argon2.
 */
export const SHA256_HASH_PREFIX = "sha256:";

export function sha256HashOf(secret: string): string {
  return SHA256_HASH_PREFIX + createHash("sha256").update(secret, "utf8").digest("hex");
}

export function sha256HashMatches(stored: string, secret: string): boolean {
  const a = Buffer.from(stored, "utf8");
  const b = Buffer.from(sha256HashOf(secret), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
import { verifyPasswordHashLimited } from "./argon2-limiter.js";

/** The `<prefix><tokenId>.<secret>` bearer-token shape shared by PATs. See docs/auth.md §37. */

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

/** Verifies a presented `<prefix><tokenId>.<secret>` token. See docs/auth.md §38. */
export async function verifyPrefixedToken<Row extends PrefixedTokenRow>(
  params: VerifyPrefixedTokenParams<Row>
): Promise<Row | null> {
  const parsed = parsePrefixedToken(params.prefix, params.presented);
  if (!parsed) return null;

  const row = await params.findByTokenId(parsed.tokenId);
  if (!row) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;

  // Through the concurrency gate (argon2-limiter.ts) — same libuv-threadpool-saturation defense as
  // login. A saturation 429 propagates to the caller; a wrong secret is `false`, as before.
  const valid = row.tokenHash.startsWith(SHA256_HASH_PREFIX)
    ? sha256HashMatches(row.tokenHash, parsed.secret)
    : await verifyPasswordHashLimited(row.tokenHash, parsed.secret);
  if (!valid) return null;

  // Best-effort — must never block/fail auth if this update fails (e.g. transient DB hiccup).
  void params.touchLastUsed(row.id).catch(() => undefined);

  return row;
}
