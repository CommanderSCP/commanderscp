import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../types.js";
import {
  authorize as oidcAuthorize,
  handleCallback,
  provisionOrLoginOidcUser,
  type OidcPkceState
} from "../auth/oidc.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { notFound, sendProblem, unauthorized } from "../errors.js";

const PKCE_COOKIE = "scp_oidc_pkce";
const PKCE_COOKIE_TTL_SECONDS = 600; // ~10 min — short-lived CSRF/replay window, DESIGN.md §7
const PKCE_COOKIE_PATH = "/api/v1/auth/oidc";

/**
 * Generic OIDC login (M2 stage 2 Part B, DESIGN.md §7) — `GET /login` redirects to the IdP,
 * `GET /callback` completes the exchange, JIT-provisions the user, and sets the same session
 * cookie `routes/auth.ts` sets for local-auth. Like `routes/events.ts` (SSE), these are plain
 * browser-redirect routes, not JSON request/response pairs the Zod/OpenAPI contract pipeline
 * models — the success response is a 302 with no body, not a schema-typed payload.
 *
 * SECURITY: never logs the authorization code, PKCE code_verifier, or any token — see
 * auth/oidc.ts's module doc.
 */
export function registerOidcRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/api/v1/auth/oidc/login", async (request, reply) => {
    const oidc = deps.config.oidc;
    if (!oidc) {
      sendProblem(request, reply, notFound("OIDC is not configured on this server"));
      return;
    }

    const { redirectUrl, pkce } = await oidcAuthorize(oidc);
    reply.setCookie(PKCE_COOKIE, JSON.stringify(pkce), {
      path: PKCE_COOKIE_PATH,
      httpOnly: true,
      signed: true,
      sameSite: "lax",
      maxAge: PKCE_COOKIE_TTL_SECONDS
    });
    reply.redirect(redirectUrl, 302);
  });

  app.get("/api/v1/auth/oidc/callback", async (request, reply) => {
    const oidc = deps.config.oidc;
    if (!oidc) {
      sendProblem(request, reply, notFound("OIDC is not configured on this server"));
      return;
    }

    // Thrown ProblemErrors below propagate to app.ts's global `setErrorHandler` (same convention
    // as every other route in this codebase — e.g. routes/objects-generic.ts) which converts them
    // to problem+json; no local try/catch needed.
    const cookies = request.cookies as Record<string, string | undefined>;
    const rawCookie = cookies[PKCE_COOKIE];
    reply.clearCookie(PKCE_COOKIE, { path: PKCE_COOKIE_PATH });
    if (!rawCookie) throw unauthorized("missing or expired OIDC login state");

    const unsigned = request.unsignCookie(rawCookie);
    if (!unsigned.valid || !unsigned.value) throw unauthorized("invalid OIDC login state cookie");

    let pkce: OidcPkceState;
    try {
      pkce = JSON.parse(unsigned.value) as OidcPkceState;
    } catch {
      throw unauthorized("invalid OIDC login state cookie");
    }

    // Explicit CSRF check ahead of the exchange (openid-client's `authorizationCodeGrant` also
    // validates `expectedState` against the callback URL below — belt and braces, neither is
    // decorative).
    const query = request.query as Record<string, string | undefined>;
    if (!query.state || query.state !== pkce.state) {
      throw unauthorized("state parameter mismatch — possible CSRF");
    }

    const currentUrl = new URL(request.url, oidc.redirectUri);
    const claims = await handleCallback(oidc, currentUrl, pkce);

    const provisioned = await provisionOrLoginOidcUser(deps.db, {
      bootstrapOrgName: deps.config.bootstrapOrgName,
      claims
    });

    await withTenantTx(deps.db, provisioned.orgId, (tx) =>
      appendAuditEvent(tx, {
        orgId: provisioned.orgId,
        actorId: provisioned.subjectObjectId,
        action: "user.login.oidc",
        subjectId: provisioned.subjectObjectId,
        requestId: request.id
      })
    );

    reply.setCookie("scp_session", provisioned.session.token, {
      path: "/",
      httpOnly: true,
      signed: true,
      sameSite: "lax",
      expires: provisioned.session.expiresAt
    });
    // Token travels only as a signed httpOnly cookie — never in the redirect URL/query string
    // (avoids leaking it into logs/proxies/browser history).
    reply.redirect("/", 302);
  });
}
