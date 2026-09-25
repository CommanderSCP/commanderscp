import type { FastifyRequest } from "fastify";
import type { AppDeps } from "../types.js";
import { verifyToken, type AuthContext } from "./local-auth.js";
import { isPatToken, verifyPat } from "./pat.js";
import { forbidden, unauthorized } from "../errors.js";

/** The fixed prefix every `password_change_required` refusal's `detail` starts with — the ONLY
 *  reliable way to recognize this specific 403 from the wire. A `ProblemError.extensions` field
 *  (e.g. `{code: "..."}`) would NOT survive here: this gate can fire from ANY route, and most
 *  routes declare `403: ProblemSchema` (packages/schemas/src/common.ts) — a plain, non-strict-but-
 *  UNKNOWN-KEY-STRIPPING zod object by default (measured while building this: an extension landed
 *  in `toProblem`'s body, then Fastify's OWN schema-based response serialization for that route
 *  silently dropped it before the wire, because the declared schema never named it). Programmatic
 *  detection should prefer `GET /auth/me`'s `mustChangePassword` (RequireAuth.tsx does); this
 *  prefix is the fallback for a caller that only has the 403 in hand. */
export const PASSWORD_CHANGE_REQUIRED_DETAIL_PREFIX = "password change required:";

/**
 * #422 review fix (SHOULD-FIX 3/4) — the ONLY routes a `mustChangePassword` session may reach.
 * `/auth/password` is how it gets cleared; `/auth/me` is how the UI/CLI discover the state at all
 * (without it, nothing could ever tell the caller WHY every other call refuses); `/auth/logout`
 * lets a caller who doesn't want to change it right now leave instead of being stuck.
 */
const ALLOWED_WHILE_PASSWORD_CHANGE_REQUIRED = new Set([
  "/api/v1/auth/password",
  "/api/v1/auth/me",
  "/api/v1/auth/logout"
]);

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

/** Org is always resolved from the token. See docs/auth.md §39. */
export async function requireAuth(deps: AppDeps, request: FastifyRequest): Promise<AuthContext> {
  const token = extractToken(request);
  if (!token) throw unauthorized("missing bearer token or session cookie");
  const auth = isPatToken(token)
    ? await verifyPat(deps.db, token)
    : await verifyToken(deps.db, token);
  if (!auth) throw unauthorized("invalid or expired token");
  // THE GATE THAT MAKES A BOOTSTRAP/ONE-TIME PASSWORD ACTUALLY RETIRE (#422 review fix). Centralized
  // here — the one place every route already passes through — rather than per-route, so a new route
  // cannot forget it (the property CLAUDE.md's census discipline exists to name and close in one
  // place, not sweep per call site).
  if (
    auth.mustChangePassword &&
    !ALLOWED_WHILE_PASSWORD_CHANGE_REQUIRED.has(request.url.split("?")[0]!)
  ) {
    throw forbidden(
      `${PASSWORD_CHANGE_REQUIRED_DETAIL_PREFIX} this account's password must be changed before ` +
        "anything else — POST /auth/password"
    );
  }
  return auth;
}

/** Explicit `/orgs/{org}` path override (DESIGN.md §6) — asserts it matches the token's org. */
export function assertOrgMatch(auth: AuthContext, pathOrg: string): void {
  if (auth.orgName !== pathOrg && auth.orgId !== pathOrg) {
    throw forbidden(`token is not scoped to org '${pathOrg}'`);
  }
}
