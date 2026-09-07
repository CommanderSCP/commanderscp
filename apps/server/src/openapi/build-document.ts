import { z } from "zod";
import type { ZodObject, ZodTypeAny } from "zod";
import type { CollectedRoute } from "./registry.js";

/** Fastify `/api/v1/orgs/:org/...` -> OpenAPI `/orgs/{org}/...`. See docs/openapi.md §2. */
function toOpenApiPath(fastifyUrl: string): string {
  const withoutPrefix = fastifyUrl.startsWith("/api/v1")
    ? fastifyUrl.slice("/api/v1".length)
    : fastifyUrl;
  return withoutPrefix.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function isZodObject(schema: ZodTypeAny): schema is ZodObject<Record<string, ZodTypeAny>> {
  return "shape" in schema;
}

function paramsToParameters(schema: ZodTypeAny | undefined, location: "path" | "query"): unknown[] {
  if (!schema || !isZodObject(schema)) return [];
  return Object.entries(schema.shape).map(([name, fieldSchema]) => {
    const isOptional = fieldSchema.safeParse(undefined).success;
    return {
      name,
      in: location,
      required: location === "path" ? true : !isOptional,
      schema: z.toJSONSchema(fieldSchema as ZodTypeAny)
    };
  });
}

/** Assembles the committed OpenAPI 3.1 document from routes collected via Fastify's `onRoute` hook. */
export function buildOpenApiDocument(routes: CollectedRoute[]): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of routes) {
    if (!route.openapi) continue; // internal routes (e.g. static assets) opt out of the spec
    const path = toOpenApiPath(route.url);
    const method = route.method.toLowerCase();
    paths[path] ??= {};

    const parameters = [
      ...paramsToParameters(route.schema?.params, "path"),
      ...paramsToParameters(route.schema?.querystring, "query")
    ];

    const responses: Record<string, unknown> = {};

    // An SSE 200 is a text/event-stream of frames, not a JSON body. See docs/openapi.md §3.
    if (route.openapi.eventStream) {
      responses["200"] = {
        description: "Server-Sent Events stream",
        content: { "text/event-stream": { schema: z.toJSONSchema(route.openapi.eventStream) } }
      };
    }

    for (const [status, schema] of Object.entries(route.schema?.response ?? {})) {
      // `z.void()`/`z.undefined()` model a body-less response (e.g. 204 No Content) and can't be
      // represented as JSON Schema (`z.toJSONSchema` throws) — OpenAPI 3.1 models "no body" as a
      // response object with no `content` key at all, not an empty schema, so that's what a
      // conversion failure here falls back to.
      let content: Record<string, unknown> | undefined;
      try {
        content = {
          [status === "400" || status.startsWith("4")
            ? "application/problem+json"
            : "application/json"]: {
            schema: z.toJSONSchema(schema)
          }
        };
      } catch {
        content = undefined;
      }
      responses[status] = {
        description: status.startsWith("2") ? "Success" : "Error",
        ...(content ? { content } : {})
      };
    }

    paths[path][method] = {
      operationId: route.openapi.operationId,
      summary: route.openapi.summary,
      tags: route.openapi.tags ?? [],
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(route.schema?.body
        ? {
            requestBody: {
              required: true,
              content: { "application/json": { schema: z.toJSONSchema(route.schema.body) } }
            }
          }
        : {}),
      responses,
      security: [{ bearerAuth: [] }]
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "CommanderSCP API",
      version: "0.0.0",
      summary: "Federated Systems Coordination Platform — v1 API (M0 walking skeleton subset)."
    },
    servers: [{ url: "/api/v1" }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" }
      }
    },
    paths
  };
}
