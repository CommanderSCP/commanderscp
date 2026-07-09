import type { FastifyRequest } from "fastify";
import type { AppDeps } from "../types.js";
import { verifyToken, type AuthContext } from "./local-auth.js";
import { forbidden, unauthorized } from "../errors.js";

export function extractToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length);

  const cookies = request.cookies as Record<string, string | undefined> | undefined;
  const cookieToken = cookies?.scp_session;
  if (cookieToken) {
    const unsigned = request.unsignCookie(cookieToken);
    if (unsigned.valid && unsigned.value) return unsigned.value;
  }
  return null;
}

/** Org is always resolved from the token (DESIGN.md §6); path overrides only assert a match. */
export async function requireAuth(deps: AppDeps, request: FastifyRequest): Promise<AuthContext> {
  const token = extractToken(request);
  if (!token) throw unauthorized("missing bearer token or session cookie");
  const auth = await verifyToken(deps.db, token);
  if (!auth) throw unauthorized("invalid or expired token");
  return auth;
}

/** Explicit `/orgs/{org}` path override (DESIGN.md §6) — asserts it matches the token's org. */
export function assertOrgMatch(auth: AuthContext, pathOrg: string): void {
  if (auth.orgName !== pathOrg && auth.orgId !== pathOrg) {
    throw forbidden(`token is not scoped to org '${pathOrg}'`);
  }
}
