import { randomBytes } from "node:crypto";
import * as client from "openid-client";
import { and, eq, isNull } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Db } from "../db/client.js";
import type { ServerConfig } from "../config.js";
import { orgs, roleBindings, roles, users } from "../db/schema.js";
import type { TenantTx } from "../db/tenant-tx.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { createObject, getOrgRootObjectId } from "../graph/objects-repo.js";
import { isUniqueViolation } from "../db/pg-errors.js";
import { createSession, type CreatedSession } from "./local-auth.js";
import { unauthorized } from "../errors.js";

type OidcConfig = NonNullable<ServerConfig["oidc"]>;

/** Generic OIDC (Authorization Code + PKCE via `openid-client`). See docs/auth.md §20. */

// Discovery is a network round trip — cache the resulting Configuration per issuer rather than
// re-discovering on every /oidc/login request. A failed discovery is never cached (so a
// transient IdP outage doesn't wedge the server until restart).
const configCache = new Map<string, Promise<client.Configuration>>();

async function getOidcConfiguration(oidc: OidcConfig): Promise<client.Configuration> {
  const cached = configCache.get(oidc.issuer);
  if (cached) return cached;

  const issuerUrl = new URL(oidc.issuer);
  const promise = client.discovery(
    issuerUrl,
    oidc.clientId,
    oidc.clientSecret ? { client_secret: oidc.clientSecret } : undefined,
    oidc.clientSecret ? undefined : client.None(),
    // Keycloak/etc. in dev/test fixtures run over plain HTTP; production issuers are expected to
    // be HTTPS, so this only relaxes the transport check when the configured issuer itself is
    // HTTP (BUILD_AND_TEST.md §8 M2 DoD (c) — the Testcontainers Keycloak fixture).
    issuerUrl.protocol === "http:" ? { execute: [client.allowInsecureRequests] } : undefined
  );
  configCache.set(oidc.issuer, promise);
  promise.catch(() => configCache.delete(oidc.issuer));
  return promise;
}

export interface OidcPkceState {
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface AuthorizeResult {
  redirectUrl: string;
  pkce: OidcPkceState;
}

/** The authorize URL plus the PKCE triple the caller must persist. See docs/auth.md §21. */
export async function authorize(oidc: OidcConfig): Promise<AuthorizeResult> {
  const configuration = await getOidcConfiguration(oidc);

  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const state = client.randomState();
  const nonce = client.randomNonce();

  const redirectUrl = client.buildAuthorizationUrl(configuration, {
    redirect_uri: oidc.redirectUri,
    scope: oidc.scopes,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    nonce
  });

  return { redirectUrl: redirectUrl.href, pkce: { state, nonce, codeVerifier } };
}

export interface OidcClaims {
  sub: string;
  /** The full validated claim set, so `auth/identity-sync.ts` can read whichever claim this
   *  deployment configured (`SCP_OIDC_ROLE_CLAIM`) without this module knowing its name. Carries
   *  no token or code — `tokens.claims()` is the decoded, signature- and nonce-verified ID token
   *  payload, and the SECURITY note above still forbids logging any of it. */
  raw: Record<string, unknown>;
  email?: string;
  preferredUsername?: string;
  name?: string;
}

/** Exchanges the callback for tokens and validates state and nonce. See docs/auth.md §22. */
export async function handleCallback(
  oidc: OidcConfig,
  currentUrl: URL,
  pkce: OidcPkceState
): Promise<OidcClaims> {
  const configuration = await getOidcConfiguration(oidc);

  const tokens = await client.authorizationCodeGrant(configuration, currentUrl, {
    pkceCodeVerifier: pkce.codeVerifier,
    expectedState: pkce.state,
    expectedNonce: pkce.nonce
  });

  const claims = tokens.claims();
  if (!claims?.sub) throw unauthorized("OIDC provider did not return a subject claim");

  return {
    sub: claims.sub,
    raw: claims as unknown as Record<string, unknown>,
    email: typeof claims.email === "string" ? claims.email : undefined,
    preferredUsername:
      typeof claims.preferred_username === "string" ? claims.preferred_username : undefined,
    name: typeof claims.name === "string" ? claims.name : undefined
  };
}

async function uniqueUsername(tx: TenantTx, orgId: string, desired: string): Promise<string> {
  let candidate = desired;
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await tx.query.users.findFirst({
      where: and(eq(users.orgId, orgId), eq(users.username, candidate))
    });
    if (!existing) return candidate;
    candidate = `${desired}-${randomBytes(3).toString("hex")}`;
  }
  return `${desired}-${uuidv7().slice(0, 8)}`;
}

/** JIT-provisions the user row, graph object and Viewer binding. See docs/auth.md §23. */
async function provisionNewOidcUser(
  db: Db,
  orgId: string,
  claims: OidcClaims
): Promise<{ userId: string; subjectObjectId: string }> {
  const { userObjectId, username } = await withTenantTx(db, orgId, async (tx) => {
    const desired = claims.email ?? claims.preferredUsername ?? claims.name ?? claims.sub;
    const uname = await uniqueUsername(tx, orgId, desired);

    const userObject = await createObject(tx, {
      orgId,
      typeId: "user",
      actorObjectId: orgId, // system placeholder — no acting graph subject yet, mirrors ensureBootstrapAdmin
      requestId: "oidc-jit-provision",
      name: uname
    });

    const viewerRole = await tx.query.roles.findFirst({
      where: and(isNull(roles.orgId), eq(roles.name, "Viewer"))
    });
    if (!viewerRole) throw new Error("built-in 'Viewer' role missing — did migrations run?");

    const rootObjectId = await getOrgRootObjectId(tx, orgId);
    await tx.insert(roleBindings).values({
      id: uuidv7(),
      orgId,
      subjectId: userObject.id,
      roleId: viewerRole.id,
      scopeObjectId: rootObjectId,
      effect: "allow"
    });

    return { userObjectId: userObject.id, username: uname };
  });

  try {
    const [row] = await db
      .insert(users)
      .values({
        id: uuidv7(),
        orgId,
        username,
        passwordHash: null,
        oidcSubject: claims.sub,
        objectId: userObjectId
      })
      .returning({ id: users.id });
    if (!row) throw new Error("failed to insert OIDC-provisioned user");
    return { userId: row.id, subjectObjectId: userObjectId };
  } catch (err) {
    if (isUniqueViolation(err, "users_org_id_oidc_subject_key")) {
      const winner = await db.query.users.findFirst({
        where: and(eq(users.orgId, orgId), eq(users.oidcSubject, claims.sub))
      });
      if (winner?.objectId) return { userId: winner.id, subjectObjectId: winner.objectId };
    }
    throw err;
  }
}

export interface JitProvisionResult {
  orgId: string;
  orgName: string;
  userId: string;
  /** The graph `user` object id — the RBAC subject and audit actor (DESIGN.md §7). */
  subjectObjectId: string;
  session: CreatedSession;
}

/** Later logins issue a session and never touch role bindings. See docs/auth.md §24. */
export async function provisionOrLoginOidcUser(
  db: Db,
  params: { bootstrapOrgName: string; claims: OidcClaims }
): Promise<JitProvisionResult> {
  const org = await db.query.orgs.findFirst({ where: eq(orgs.name, params.bootstrapOrgName) });
  if (!org) {
    throw new Error(`bootstrap org '${params.bootstrapOrgName}' does not exist — did boot run?`);
  }

  const existing = await db.query.users.findFirst({
    where: and(eq(users.orgId, org.id), eq(users.oidcSubject, params.claims.sub))
  });

  const { userId, subjectObjectId } =
    existing?.objectId != null
      ? { userId: existing.id, subjectObjectId: existing.objectId }
      : await provisionNewOidcUser(db, org.id, params.claims);

  const session = await createSession(db, { userId, orgId: org.id });
  return { orgId: org.id, orgName: org.name, userId, subjectObjectId, session };
}
