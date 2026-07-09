import { createHash, randomBytes } from "node:crypto";
import * as argon2 from "argon2";
import { v7 as uuidv7 } from "uuid";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { orgs, roleBindings, roles, sessions, users } from "../db/schema.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { createObject, getOrgRootObjectId } from "../graph/objects-repo.js";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h — fine for M0/M1's local-auth bootstrap flow.

export interface AuthContext {
  userId: string;
  orgId: string;
  orgName: string;
  username: string;
  /** The graph `user` object this account maps to — the RBAC subject (DESIGN.md §7). */
  subjectObjectId: string;
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
 * Idempotent: safe to call on every boot. Creates the seeded org + graph root object + bootstrap
 * admin (as both an auth row and a graph `user` object bound to the built-in Owner role at the
 * org's root scope) only if they don't exist yet, and prints the one-time password once.
 *
 * Audit events written during bootstrap attribute `actorId = orgId` — a "system" placeholder,
 * since no user (graph subject) exists yet at the point the org root object itself is created.
 */
export interface BootstrapResult {
  orgId: string;
  /** Only set when this call actually created the admin (null if it already existed). */
  oneTimePassword: string | null;
}

export async function ensureBootstrapAdmin(
  db: Db,
  opts: { orgName: string; adminUsername: string },
  log: { info: (msg: string) => void; warn: (msg: string) => void }
): Promise<BootstrapResult> {
  const existingOrg = await db.query.orgs.findFirst({ where: eq(orgs.name, opts.orgName) });
  const org = existingOrg ?? (await createOrg(db, opts.orgName));

  await ensureOrgRootObject(db, org.id);

  // Scoped by org_id (not just username): usernames are only unique per-org
  // (users_org_id_username_key), so two orgs may legitimately both have an "admin".
  const existingAdmin = await db.query.users.findFirst({
    where: and(eq(users.orgId, org.id), eq(users.username, opts.adminUsername))
  });
  if (existingAdmin) {
    log.info(`local-auth: bootstrap admin '${opts.adminUsername}' already exists, skipping.`);
    return { orgId: org.id, oneTimePassword: null };
  }

  const userObjectId = await withTenantTx(db, org.id, async (tx) => {
    const created = await createObject(tx, {
      orgId: org.id,
      typeId: "user",
      actorObjectId: org.id, // system placeholder — see doc comment above
      requestId: "bootstrap",
      name: opts.adminUsername
    });

    const ownerRole = await tx.query.roles.findFirst({
      where: and(isNull(roles.orgId), eq(roles.name, "Owner"))
    });
    if (!ownerRole) throw new Error("built-in 'Owner' role missing — did migrations run?");

    const rootObjectId = await getOrgRootObjectId(tx, org.id);

    await tx.insert(roleBindings).values({
      id: uuidv7(),
      orgId: org.id,
      subjectId: created.id,
      roleId: ownerRole.id,
      scopeObjectId: rootObjectId,
      effect: "allow"
    });

    return created.id;
  });

  const oneTimePassword = randomBytes(18).toString("base64url");
  const passwordHash = await argon2.hash(oneTimePassword);
  await db.insert(users).values({
    id: uuidv7(),
    orgId: org.id,
    username: opts.adminUsername,
    passwordHash,
    objectId: userObjectId
  });

  log.warn(
    `local-auth: created bootstrap admin '${opts.adminUsername}' in org '${opts.orgName}'. ` +
      `One-time password (not stored, shown once): ${oneTimePassword}`
  );

  return { orgId: org.id, oneTimePassword };
}

async function createOrg(db: Db, name: string) {
  const [org] = await db.insert(orgs).values({ id: uuidv7(), name }).returning();
  if (!org) throw new Error(`failed to create bootstrap org '${name}'`);
  return org;
}

/** Every org gets exactly one root `organization` graph object — see graph/objects-repo.ts. */
async function ensureOrgRootObject(db: Db, orgId: string): Promise<void> {
  await withTenantTx(db, orgId, async (tx) => {
    const existing = await tx.query.objects.findFirst({
      where: (t, { eq: eqOp, and: andOp, isNull: isNullOp }) =>
        andOp(eqOp(t.orgId, orgId), eqOp(t.typeId, "organization"), isNullOp(t.domainId))
    });
    if (existing) return;

    await createObject(tx, {
      orgId,
      typeId: "organization",
      actorObjectId: orgId, // system placeholder — no user exists yet
      requestId: "bootstrap",
      id: orgId, // stable, predictable id for the org root object
      name: orgId,
      domainId: null
    });
  });
}

export interface LoginResult {
  token: string;
  expiresAt: Date;
  orgName: string;
}

export interface CreatedSession {
  token: string;
  expiresAt: Date;
}

/**
 * Issues a new opaque bearer/session token for an already-authenticated `(userId, orgId)` pair —
 * shared by every login path (local-auth `login()` below, OIDC `auth/oidc.ts`, device-flow
 * approval `auth/device-flow.ts`) so token generation/hashing/expiry logic lives in exactly one
 * place.
 */
export async function createSession(
  db: Db,
  params: { userId: string; orgId: string }
): Promise<CreatedSession> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({
    id: uuidv7(),
    userId: params.userId,
    orgId: params.orgId,
    tokenHash: hashToken(token),
    expiresAt
  });
  return { token, expiresAt };
}

/** Verifies username/password and issues a new opaque bearer token (also usable as the UI cookie). */
export async function login(
  db: Db,
  username: string,
  password: string
): Promise<LoginResult | null> {
  const user = await db.query.users.findFirst({ where: eq(users.username, username) });
  if (!user) return null;

  // OIDC-provisioned accounts have no local password (db/schema.ts, drizzle/0004) — treat that
  // identically to a wrong password rather than a different error path, so account existence
  // isn't distinguishable from the response.
  if (!user.passwordHash) return null;

  const valid = await argon2.verify(user.passwordHash, password).catch(() => false);
  if (!valid) return null;

  const org = await db.query.orgs.findFirst({ where: eq(orgs.id, user.orgId) });
  if (!org) return null;

  const session = await createSession(db, { userId: user.id, orgId: user.orgId });
  return { token: session.token, expiresAt: session.expiresAt, orgName: org.name };
}

/**
 * Resolves a `users.id` to its full auth context — shared by `verifyToken` below and PAT
 * verification (auth/pat.ts), which both end at "I know the user row, now build the AuthContext"
 * after their own distinct token-lookup step.
 */
export async function resolveAuthContext(db: Db, userId: string): Promise<AuthContext | null> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) return null;
  const org = await db.query.orgs.findFirst({ where: eq(orgs.id, user.orgId) });
  if (!org || !user.objectId) return null;

  return {
    userId: user.id,
    orgId: org.id,
    orgName: org.name,
    username: user.username,
    subjectObjectId: user.objectId
  };
}

/** Resolves a bearer/cookie token to its auth context; org is always resolved from the token (DESIGN.md §6). */
export async function verifyToken(db: Db, token: string): Promise<AuthContext | null> {
  const tokenHash = hashToken(token);
  const session = await db.query.sessions.findFirst({ where: eq(sessions.tokenHash, tokenHash) });
  if (!session) return null;
  if (session.expiresAt.getTime() < Date.now()) return null;

  return resolveAuthContext(db, session.userId);
}

/**
 * `POST /auth/logout` (routes/auth.ts, M2 stage 4) — invalidates the session row a local-auth/
 * OIDC session token resolves to, so it's rejected by `verifyToken` immediately, even if the
 * client kept a copy. Expires it (UPDATE) rather than deleting the row: the runtime `scp_app`
 * login role is only granted SELECT/INSERT/UPDATE on auth-substrate tables, never DELETE (PR #4
 * security review, CRITICAL 3 — `drizzle/0002_rls_rbac_seed.sql` §1) — same externally-observable
 * effect (the token stops working) without widening that grant for a "logout" nicety. No-op if
 * the token doesn't match a live session — callers own deciding whether that's worth surfacing.
 */
export async function invalidateSessionByToken(db: Db, token: string): Promise<void> {
  await db
    .update(sessions)
    .set({ expiresAt: new Date(0) })
    .where(eq(sessions.tokenHash, hashToken(token)));
}
