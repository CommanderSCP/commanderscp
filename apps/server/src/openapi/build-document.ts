import { z } from "zod";
import type { ZodObject, ZodTypeAny } from "zod";
import type { CollectedRoute } from "./registry.js";

/**
 * Fastify `/api/v1/orgs/:org/...` -> OpenAPI `/orgs/{org}/...`. The `/api/v1` prefix is stripped
 * because it's declared once as `servers[0].url` below — paths are relative to that per the
 * OpenAPI spec (and per what the generated SDK client expects: its `baseUrl` type is inferred
 * from `servers[0].url` and is meant to be combined with a *relative* operation path).
 */
function toOpenApiPath(fastifyUrl: string): string {
  const withoutPrefix = fastifyUrl.startsWith("/api/v1") ? fastifyUrl.slice("/api/v1".length) : fastifyUrl;
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
    for (const [status, schema] of Object.entries(route.schema?.response ?? {})) {
      responses[status] = {
        description: status.startsWith("2") ? "Success" : "Error",
        content: {
          [status === "400" || status.startsWith("4")
            ? "application/problem+json"
            : "application/json"]: {
            schema: z.toJSONSchema(schema)
          }
        }
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
