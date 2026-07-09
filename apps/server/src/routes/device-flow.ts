import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { eq } from "drizzle-orm";
import {
  DeviceApproveRequestSchema,
  DeviceApproveResponseSchema,
  DeviceStartResponseSchema,
  DeviceTokenErrorSchema,
  DeviceTokenRequestSchema,
  LoginResponseSchema,
  ProblemSchema,
  type DeviceFlowErrorCode
} from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { approveDeviceAuth, pollDeviceAuth, startDeviceAuth } from "../auth/device-flow.js";
import { orgs } from "../db/schema.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { notFound } from "../errors.js";

function sendDeviceFlowError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: DeviceFlowErrorCode
): void {
  reply.status(400).header("content-type", "application/problem+json").send({
    type: "about:blank",
    title: "Bad Request",
    status: 400,
    detail: error,
    instance: request.url,
    error
  });
}

/**
 * SCP's own RFC 8628-shaped device-authorization flow for the CLI (M2 stage 2 Part C) — see
 * auth/device-flow.ts's module doc for why this is SCP's own flow rather than a proxy to the
 * upstream IdP's device grant. `verificationUri` points at this server's own web UI/API (the
 * browser-side approval page itself lands with the Web UI in a later M2 stage — this API is
 * fully exercisable headlessly in the meantime, per BUILD_AND_TEST.md §8 M2 item 3).
 */
export function registerDeviceFlowRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/api/v1/auth/device/start",
    schema: {
      response: { 200: DeviceStartResponseSchema }
    },
    config: {
      openapi: {
        operationId: "startDeviceAuth",
        summary: "Start a device authorization request (RFC 8628-shaped, SCP-hosted)",
        tags: ["auth"]
      }
    },
    handler: async (_request, reply) => {
      const started = await startDeviceAuth(deps.db);
      const verificationUri = `${deps.config.internalBaseUrl.replace(/\/api\/v1\/?$/, "")}/device`;
      reply.status(200).send({
        deviceCode: started.deviceCode,
        userCode: started.userCode,
        verificationUri,
        expiresIn: started.expiresIn,
        interval: started.interval
      });
    }
  });

  typed.route({
    method: "POST",
    url: "/api/v1/auth/device/approve",
    schema: {
      body: DeviceApproveRequestSchema,
      response: { 200: DeviceApproveResponseSchema, 401: ProblemSchema, 404: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "approveDeviceAuth",
        summary: "Approve a pending device authorization request (browser-authenticated human)",
        tags: ["auth"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const approved = await approveDeviceAuth(deps.db, {
        userCode: request.body.userCode,
        orgId: auth.orgId,
        userId: auth.userId
      });
      if (!approved) throw notFound("no pending device authorization request for that code");

      await withTenantTx(deps.db, auth.orgId, (tx) =>
        appendAuditEvent(tx, {
          orgId: auth.orgId,
          actorId: auth.subjectObjectId,
          action: "device_flow.approve",
          requestId: request.id
        })
      );

      reply.status(200).send({ approved: true });
    }
  });

  typed.route({
    method: "POST",
    url: "/api/v1/auth/device/token",
    schema: {
      body: DeviceTokenRequestSchema,
      response: { 200: LoginResponseSchema, 400: DeviceTokenErrorSchema }
    },
    config: {
      openapi: {
        operationId: "pollDeviceAuthToken",
        summary: "Poll for the device authorization result (RFC 8628 token endpoint shape)",
        tags: ["auth"]
      }
    },
    handler: async (request, reply) => {
      const result = await pollDeviceAuth(deps.db, request.body.deviceCode);
      if (result.kind === "error") {
        sendDeviceFlowError(request, reply, result.error);
        return;
      }

      const org = await deps.db.query.orgs.findFirst({ where: eq(orgs.id, result.orgId) });
      reply.status(200).send({
        token: result.token,
        expiresAt: result.expiresAt.toISOString(),
        org: org?.name ?? result.orgId
      });
    }
  });
}
