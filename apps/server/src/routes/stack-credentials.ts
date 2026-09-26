import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  AckStackCredentialDeliveryRequestSchema,
  ProblemSchema,
  PutStackCredentialRequestSchema,
  PutStackCredentialSealingKeyRequestSchema,
  PutStackWorkloadIdentityRequestSchema,
  StackCredentialDeliveryListSchema,
  StackCredentialDeliveryParamSchema,
  StackCredentialKeyViewSchema,
  StackCredentialParamSchema,
  StackCredentialsViewSchema,
  StackWorkloadIdentityParamSchema
} from "@scp/schemas";
import type { AppDeps } from "../types.js";
import {
  requireInstanceAuthority,
  requireStackControllerCredential
} from "../auth/instance-authority.js";
import { withOperatorTx } from "./instance-operators.js";
import {
  ackDelivery,
  credentialsView,
  declareWorkloadIdentity,
  listPendingDeliveries,
  publishSealingKey,
  requestCredentialChange
} from "../stack/credentials.js";

/**
 * CREDENTIALS THROUGH SCP — the API (M29.5, ADR-0063). WRITE-ONLY: a value goes in through
 * `PUT …/credentials/{backend}/{secretName}/{key}` and never comes back out. The read model is
 * metadata (which keys are set, by whom, delivered when); the only response that carries anything
 * derived from a value is the controller's delivery list, which carries SEALED envelopes, to the
 * controller's own credential. `stack-credential-no-read.test.ts` holds every response schema of
 * the whole API to that.
 *
 * Instance authority for people (the instance-operator role on a session, or a full operator
 * credential); the stack controller's `stack-controller` credential alone for its three doors.
 */

const SURFACE = "the Standard Stack's credentials";

export function registerStackCredentialRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const problems = {
    400: ProblemSchema,
    401: ProblemSchema,
    403: ProblemSchema,
    409: ProblemSchema
  };

  typed.route({
    method: "GET",
    url: "/api/v1/instance/stack/credentials",
    schema: { response: { 200: StackCredentialsViewSchema, ...problems } },
    config: {
      openapi: {
        operationId: "listStackCredentials",
        summary:
          "The credentials the Standard Stack's backends take, and their state: which keys are set, pending or failed, who entered them and when they were delivered — never a value (instance-operator role or operator credential; ADR-0063)",
        tags: ["stack"]
      }
    },
    handler: async (request, reply) => {
      await requireInstanceAuthority(deps, request, SURFACE);
      reply.status(200).send(await withOperatorTx(deps.config, SURFACE, credentialsView));
    }
  });

  typed.route({
    method: "PUT",
    url: "/api/v1/instance/stack/credentials/:backend/:secretName/:key",
    schema: {
      params: StackCredentialParamSchema,
      body: PutStackCredentialRequestSchema,
      response: { 202: StackCredentialKeyViewSchema, ...problems }
    },
    config: {
      openapi: {
        operationId: "setStackCredential",
        summary:
          "Enter (or rotate) one credential a Standard Stack backend needs. The value is sealed to the stack controller's key and written by the controller into the backend's own Secret; SCP keeps no copy and has no way to read it back. A re-set replaces the value (instance-operator role or operator credential; audited without the value; ADR-0063)",
        tags: ["stack"]
      }
    },
    handler: async (request, reply) => {
      const actor = await requireInstanceAuthority(deps, request, SURFACE);
      const { backend, secretName, key } = request.params;
      const view = await withOperatorTx(deps.config, SURFACE, (client) =>
        requestCredentialChange(client, {
          backend,
          secretName,
          key,
          op: "set",
          value: request.body.value,
          actor,
          requestId: request.id
        })
      );
      reply.status(202).send(view);
    }
  });

  typed.route({
    method: "DELETE",
    url: "/api/v1/instance/stack/credentials/:backend/:secretName/:key",
    schema: {
      params: StackCredentialParamSchema,
      response: { 202: StackCredentialKeyViewSchema, ...problems }
    },
    config: {
      openapi: {
        operationId: "deleteStackCredential",
        summary:
          "Remove one credential key from a Standard Stack backend's Secret — the stack controller deletes it (instance-operator role or operator credential; audited; ADR-0063)",
        tags: ["stack"]
      }
    },
    handler: async (request, reply) => {
      const actor = await requireInstanceAuthority(deps, request, SURFACE);
      const { backend, secretName, key } = request.params;
      const view = await withOperatorTx(deps.config, SURFACE, (client) =>
        requestCredentialChange(client, {
          backend,
          secretName,
          key,
          op: "delete",
          actor,
          requestId: request.id
        })
      );
      reply.status(202).send(view);
    }
  });

  typed.route({
    method: "PUT",
    url: "/api/v1/instance/stack/workload-identities/:backend/:serviceAccount",
    schema: {
      params: StackWorkloadIdentityParamSchema,
      body: PutStackWorkloadIdentityRequestSchema,
      response: { 200: StackCredentialsViewSchema, ...problems }
    },
    config: {
      openapi: {
        operationId: "putStackWorkloadIdentity",
        summary:
          "Declare that a Standard Stack ServiceAccount gets its cloud authority from workload identity (AWS IRSA, GKE Workload Identity, Azure Workload Identity): the stack controller sets the provider's annotation, so no credential needs entering (instance-operator role or operator credential; audited; ADR-0063)",
        tags: ["stack"]
      }
    },
    handler: async (request, reply) => {
      const actor = await requireInstanceAuthority(deps, request, SURFACE);
      const view = await withOperatorTx(deps.config, SURFACE, async (client) => {
        await declareWorkloadIdentity(client, {
          ...request.params,
          binding: request.body,
          actor,
          requestId: request.id
        });
        return credentialsView(client);
      });
      reply.status(200).send(view);
    }
  });

  typed.route({
    method: "DELETE",
    url: "/api/v1/instance/stack/workload-identities/:backend/:serviceAccount",
    schema: {
      params: StackWorkloadIdentityParamSchema,
      response: { 200: StackCredentialsViewSchema, ...problems }
    },
    config: {
      openapi: {
        operationId: "deleteStackWorkloadIdentity",
        summary:
          "Withdraw a workload-identity declaration: the stack controller removes the provider's annotation from the ServiceAccount (instance-operator role or operator credential; audited; ADR-0063)",
        tags: ["stack"]
      }
    },
    handler: async (request, reply) => {
      const actor = await requireInstanceAuthority(deps, request, SURFACE);
      const view = await withOperatorTx(deps.config, SURFACE, async (client) => {
        await declareWorkloadIdentity(client, {
          ...request.params,
          binding: null,
          actor,
          requestId: request.id
        });
        return credentialsView(client);
      });
      reply.status(200).send(view);
    }
  });

  // ---- the controller's three doors (its credential ONLY) ----------------------------------

  typed.route({
    method: "PUT",
    url: "/api/v1/instance/stack/credential-sealing-key",
    schema: {
      body: PutStackCredentialSealingKeyRequestSchema,
      response: { 204: z.undefined(), 400: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "putStackCredentialSealingKey",
        summary:
          "The stack controller publishes the X25519 public key credentials entered through SCP are sealed to; its private half never leaves the controller's namespace (the stack controller's credential ONLY; audited; ADR-0063)",
        tags: ["stack"]
      }
    },
    handler: async (request, reply) => {
      const actor = await requireStackControllerCredential(deps, request);
      await withOperatorTx(deps.config, SURFACE, (client) =>
        publishSealingKey(client, request.body, actor, request.id)
      );
      reply.status(204).send();
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/instance/stack/credential-deliveries",
    schema: {
      response: { 200: StackCredentialDeliveryListSchema, 403: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "listStackCredentialDeliveries",
        summary:
          "The sealed credential envelopes waiting for the stack controller to write into a backend's Secret — sealed to the controller's key, which scpd does not hold (the stack controller's credential ONLY; ADR-0063)",
        tags: ["stack"]
      }
    },
    handler: async (request, reply) => {
      await requireStackControllerCredential(deps, request);
      const items = await withOperatorTx(deps.config, SURFACE, (client) =>
        listPendingDeliveries(client)
      );
      reply.status(200).send({ items });
    }
  });

  typed.route({
    method: "POST",
    url: "/api/v1/instance/stack/credential-deliveries/:deliveryId/ack",
    schema: {
      params: StackCredentialDeliveryParamSchema,
      body: AckStackCredentialDeliveryRequestSchema,
      response: { 204: z.undefined(), 400: ProblemSchema, 403: ProblemSchema, 409: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "ackStackCredentialDelivery",
        summary:
          "The stack controller confirms a delivery — written into the backend's Secret, or refused (tampered, replayed, expired, wrong key) — and scpd drops the sealed envelope (the stack controller's credential ONLY; audited; ADR-0063)",
        tags: ["stack"]
      }
    },
    handler: async (request, reply) => {
      const actor = await requireStackControllerCredential(deps, request);
      await withOperatorTx(deps.config, SURFACE, (client) =>
        ackDelivery(client, request.params.deliveryId, request.body, actor, request.id)
      );
      reply.status(204).send();
    }
  });
}
