import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { LoginRequestSchema, LoginResponseSchema, ProblemSchema } from "@scp/schemas";
import { login } from "../auth/local-auth.js";
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
}
