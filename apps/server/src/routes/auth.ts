import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  AuthConfigSchema,
  CurrentUserSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  ProblemSchema
} from "@scp/schemas";
import { invalidateSessionByToken, login } from "../auth/local-auth.js";
import { extractToken, requireAuth } from "../auth/require-auth.js";
import { isPatToken } from "../auth/pat.js";
import { unauthorized } from "../errors.js";
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

  // -------------------------------------------------------------------------------------------
  // Web UI v1 (M2 stage 4, BUILD_AND_TEST.md §8 M2 item 2) — the SPA has no way to read the
  // httpOnly `scp_session` cookie itself, so it discovers "am I logged in" via `/auth/me` and
  // ends its session via `/auth/logout`. `/auth/config` is public so the login page can decide
  // whether to render "Continue with SSO" before the visitor has any credentials.
  // -------------------------------------------------------------------------------------------

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
      reply.status(200).send({
        userId: auth.userId,
        orgId: auth.orgId,
        orgName: auth.orgName,
        username: auth.username,
        subjectObjectId: auth.subjectObjectId
      });
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
        summary: "End the calling session (no-op for PAT-authenticated calls) and clear the session cookie",
        tags: ["auth"]
      }
    },
    handler: async (request, reply) => {
      // requireAuth first: a call with no/invalid credentials at all still gets a 401, not a
      // silent 204 — logout only "succeeds" for a caller who was actually authenticated.
      await requireAuth(deps, request);
      const token = extractToken(request);
      // A session token (local-auth or OIDC — both create rows via auth/local-auth.ts
      // `createSession`) gets its row deleted, so it stops working immediately. A PAT is a
      // separate, longer-lived credential the caller may be using from a non-browser context
      // (e.g. the CLI) — "logging out" a PAT isn't a coherent operation (there is no session to
      // end), so that case just no-ops successfully rather than deleting/revoking the PAT itself.
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
