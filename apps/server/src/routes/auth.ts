import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  AuthConfigSchema,
  ChangePasswordRequestSchema,
  CurrentUserSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  ProblemSchema
} from "@scp/schemas";
import { changeLocalPassword, invalidateSessionByToken, login } from "../auth/local-auth.js";
import { extractToken, requireAuth } from "../auth/require-auth.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { bindingsAnywhereFor } from "../authz/resolve.js";
import { isPatToken } from "../auth/pat.js";
import { badRequest, unauthorized } from "../errors.js";
import type { AppDeps } from "../types.js";

export function registerAuthRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/api/v1/auth/login",
    schema: {
      body: LoginRequestSchema,
      response: { 200: LoginResponseSchema, 401: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "login",
        summary: "Exchange local-auth credentials for a bearer token",
        tags: ["auth"]
      }
    },
    handler: async (request, reply) => {
      const result = await login(deps.db, request.body.username, request.body.password);
      if (!result) throw unauthorized("invalid username or password");

      // Bearer token for the API/CLI; the same opaque token is also set as a signed HTTP-only
      // cookie for the UI (DESIGN.md §7).
      reply.setCookie("scp_session", result.token, {
        path: "/",
        httpOnly: true,
        signed: true,
        // `Secure` in production so the session cookie is never sent over plaintext HTTP (where a
        // network attacker could capture it). Gated on deploymentMode so the plain-HTTP evaluation
        // / `pnpm dev` stacks — which set SCP_DEPLOYMENT_MODE=evaluation — keep working.
        secure: deps.config.deploymentMode === "production",
        sameSite: "lax",
        expires: result.expiresAt
      });

      reply.status(200).send({
        token: result.token,
        expiresAt: result.expiresAt.toISOString(),
        org: result.orgName
      });
    }
  });

  // Web UI v1 (M2 step 4, BUILD_AND_TEST.md §8 M2 item 2). See docs/routes.md §2.

  typed.route({
    method: "GET",
    url: "/api/v1/auth/me",
    schema: {
      response: { 200: CurrentUserSchema, 401: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "getCurrentUser",
        summary: "The calling user's own identity — how the Web UI discovers its session",
        tags: ["auth"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);

      // role-model.md §5 step 6. Read in ONE transaction so the bindings and the union derived
      // from them cannot disagree — the union is computed from these exact rows rather than by a
      // second query that could see a different snapshot.
      const identity = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const bindings = await bindingsAnywhereFor(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId
        });
        // DENY ROWS ARE EXCLUDED FROM THE UNION AND KEPT IN THE LIST. See docs/routes.md §3.
        const permissionsAnywhere = [
          ...new Set(bindings.filter((b) => b.effect === "allow").flatMap((b) => b.permissions))
        ].sort();
        return {
          roleBindings: bindings.map(({ roleId, roleName, scopeObjectId, effect }) => ({
            roleId,
            roleName,
            scopeObjectId,
            effect
          })),
          permissionsAnywhere
        };
      });

      reply.status(200).send({
        userId: auth.userId,
        orgId: auth.orgId,
        orgName: auth.orgName,
        username: auth.username,
        subjectObjectId: auth.subjectObjectId,
        // outpost-ui.md §9.2 — the serving instance's install-time role, so the web shell can
        // mount the commander site or the smaller outpost site. Read from config, never from
        // federation_self: one deterministic answer per instance.
        instanceRole: deps.config.federationRole,
        mustChangePassword: auth.mustChangePassword,
        roleBindings: identity.roleBindings,
        permissionsAnywhere: identity.permissionsAnywhere
      });
    }
  });

  typed.route({
    method: "POST",
    url: "/api/v1/auth/password",
    schema: {
      body: ChangePasswordRequestSchema,
      response: { 204: z.undefined(), 400: ProblemSchema, 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "changePassword",
        summary:
          "Change the calling local-auth user's own password — the only door that clears mustChangePassword",
        tags: ["auth"]
      }
    },
    handler: async (request, reply) => {
      // requireAuth's own gate (require-auth.ts) explicitly allows THIS route through while
      // mustChangePassword is set — it is the one door that has to stay reachable to clear it.
      const auth = await requireAuth(deps, request);
      // The raw bearer/cookie token identifies THIS session so changeLocalPassword can revoke
      // every OTHER live session without logging the caller out of the request they're making
      // right now (a PAT-authenticated call has no session row to preserve — extractToken still
      // returns the PAT string, which simply matches nothing in `sessions`, so every session-table
      // entry for this user is revoked instead, which is correct: there is no "current session").
      const currentToken = extractToken(request) ?? undefined;
      const result = await changeLocalPassword(
        deps.db,
        auth.userId,
        request.body.currentPassword,
        request.body.newPassword,
        currentToken
      );
      if (result === "no-local-password") {
        throw unauthorized("this account has no local password to change (OIDC-provisioned)");
      }
      if (result === "wrong-current-password") {
        throw unauthorized("current password is incorrect");
      }
      if (result === "same-as-current") {
        throw badRequest(
          "the new password must differ from the current password — #422 review fix: a " +
            "same-password 'change' used to clear mustChangePassword without actually " +
            "retiring the printed one-time password"
        );
      }
      reply.status(204).send(undefined);
    }
  });

  typed.route({
    method: "POST",
    url: "/api/v1/auth/logout",
    schema: {
      // `z.undefined()` models a true empty body (204 No Content) — `openapi/build-document.ts`
      // renders it as a content-less response, and `reply.send(undefined)` makes Fastify skip
      // serialization entirely rather than writing a JSON body, so the wire response really has
      // no body (RFC 9110 §15.3.5 — a 204 MUST NOT carry a message body).
      response: { 204: z.undefined(), 401: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "logout",
        summary:
          "End the calling session (no-op for PAT-authenticated calls) and clear the session cookie",
        tags: ["auth"]
      }
    },
    handler: async (request, reply) => {
      // requireAuth first: a call with no/invalid credentials at all still gets a 401, not a
      // silent 204 — logout only "succeeds" for a caller who was actually authenticated.
      await requireAuth(deps, request);
      const token = extractToken(request);
      // A session token. See docs/routes.md §4.
      if (token && !isPatToken(token)) {
        await invalidateSessionByToken(deps.db, token);
      }
      reply.clearCookie("scp_session", { path: "/" });
      reply.status(204).send(undefined);
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/auth/config",
    schema: {
      response: { 200: AuthConfigSchema }
    },
    config: {
      openapi: {
        operationId: "getAuthConfig",
        summary: "Public auth configuration — which login methods this server offers",
        tags: ["auth"]
      }
    },
    handler: async (_request, reply) => {
      reply.status(200).send({
        localAuthEnabled: true,
        oidcEnabled: deps.config.oidc !== undefined
      });
    }
  });
}
