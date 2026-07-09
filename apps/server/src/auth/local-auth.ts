import { createHash, randomBytes } from "node:crypto";
import * as argon2 from "argon2";
import { v7 as uuidv7 } from "uuid";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { orgs, sessions, users } from "../db/schema.js";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h — fine for M0's local-auth bootstrap flow.

export interface AuthContext {
  userId: string;
  orgId: string;
  orgName: string;
  username: string;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Local-auth bootstrap (DESIGN.md §7, §3 `packages/plugins/local-auth`). The full IdentityPlugin
 * subprocess-isolated implementation arrives once the plugin host exists (M3); until then this
 * logic lives directly in the server, behind the same argon2 bootstrap-admin behavior the
 * plugin will eventually provide.
 *
 * Idempotent: safe to call on every boot. Creates the seeded org + bootstrap admin only if
 * neither exists yet, and prints the one-time password to logs exactly once.
 */
export async function ensureBootstrapAdmin(
  db: Db,
  opts: { orgName: string; adminUsername: string },
  log: { info: (msg: string) => void; warn: (msg: string) => void }
): Promise<void> {
  const existingOrg = await db.query.orgs.findFirst({ where: eq(orgs.name, opts.orgName) });
  const org = existingOrg ?? (await createOrg(db, opts.orgName));

  const existingAdmin = await db.query.users.findFirst({
    where: eq(users.username, opts.adminUsername)
  });
  if (existingAdmin) {
    log.info(`local-auth: bootstrap admin '${opts.adminUsername}' already exists, skipping.`);
    return;
  }

  const oneTimePassword = randomBytes(18).toString("base64url");
  const passwordHash = await argon2.hash(oneTimePassword);
  await db.insert(users).values({
    id: uuidv7(),
    orgId: org.id,
    username: opts.adminUsername,
    passwordHash
  });

  log.warn(
    `local-auth: created bootstrap admin '${opts.adminUsername}' in org '${opts.orgName}'. ` +
      `One-time password (not stored, shown once): ${oneTimePassword}`
  );
}

async function createOrg(db: Db, name: string) {
  const [org] = await db.insert(orgs).values({ id: uuidv7(), name }).returning();
  if (!org) throw new Error(`failed to create bootstrap org '${name}'`);
  return org;
}

export interface LoginResult {
  token: string;
  expiresAt: Date;
  orgName: string;
}

/** Verifies username/password and issues a new opaque bearer token (also usable as the UI cookie). */
export async function login(
  db: Db,
  username: string,
  password: string
): Promise<LoginResult | null> {
  const user = await db.query.users.findFirst({ where: eq(users.username, username) });
  if (!user) return null;

  const valid = await argon2.verify(user.passwordHash, password).catch(() => false);
  if (!valid) return null;

  const org = await db.query.orgs.findFirst({ where: eq(orgs.id, user.orgId) });
  if (!org) return null;

  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({
    id: uuidv7(),
    userId: user.id,
    orgId: user.orgId,
    tokenHash: hashToken(token),
    expiresAt
  });

  return { token, expiresAt, orgName: org.name };
}

/** Resolves a bearer/cookie token to its auth context; org is always resolved from the token (DESIGN.md §6). */
export async function verifyToken(db: Db, token: string): Promise<AuthContext | null> {
  const tokenHash = hashToken(token);
  const session = await db.query.sessions.findFirst({ where: eq(sessions.tokenHash, tokenHash) });
  if (!session) return null;
  if (session.expiresAt.getTime() < Date.now()) return null;

  const user = await db.query.users.findFirst({ where: eq(users.id, session.userId) });
  const org = await db.query.orgs.findFirst({ where: eq(orgs.id, session.orgId) });
  if (!user || !org) return null;

  return { userId: user.id, orgId: org.id, orgName: org.name, username: user.username };
}
