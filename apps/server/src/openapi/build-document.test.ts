import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ProblemSchema, RelayedEventSchema } from "@scp/schemas";
import { buildOpenApiDocument } from "./build-document.js";
import type { CollectedRoute } from "./registry.js";

/**
 * The SSE contract declaration (ADR-0025), guarded where it is actually load-bearing.
 *
 * `text/event-stream` is not decoration: it is the exact key `@hey-api/openapi-ts` keys off
 * (`hasOperationSse`) to emit a streaming operation instead of a request/response one. If the
 * emitter ever fell back to `application/json` for this route the spec would still look plausible,
 * `pnpm gen` would still succeed, and the SDK would silently regress to a one-shot GET that never
 * yields an event — so the media type is asserted directly, in both the synthetic and the real
 * committed document.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface ResponseObject {
  description?: string;
  content?: Record<string, { schema?: Record<string, unknown> }>;
}

interface OperationObject {
  operationId?: string;
  responses?: Record<string, ResponseObject>;
}

function operationAt(
  doc: Record<string, unknown>,
  apiPath: string,
  method: string
): OperationObject {
  const paths = doc.paths as Record<string, Record<string, OperationObject>>;
  const item = paths[apiPath];
  if (!item?.[method]) throw new Error(`no ${method.toUpperCase()} ${apiPath} in the document`);
  return item[method];
}

describe("buildOpenApiDocument: streaming responses", () => {
  const sseRoute: CollectedRoute = {
    method: "GET",
    url: "/api/v1/events/stream",
    schema: { response: { 401: ProblemSchema } },
    openapi: {
      operationId: "streamEvents",
      summary: "Live event stream",
      tags: ["events"],
      eventStream: RelayedEventSchema
    }
  };

  it("emits the 200 as text/event-stream carrying the frame schema", () => {
    const operation = operationAt(buildOpenApiDocument([sseRoute]), "/events/stream", "get");
    const success = operation.responses?.["200"];

    expect(Object.keys(success?.content ?? {})).toEqual(["text/event-stream"]);
    // The frames are the contract, so the schema must be the FRAME schema, not an empty stub.
    const schema = success?.content?.["text/event-stream"]?.schema;
    expect(Object.keys((schema?.properties as Record<string, unknown>) ?? {}).sort()).toEqual([
      "createdAt",
      "data",
      "id",
      "orgId",
      "source",
      "subject",
      "type"
    ]);
  });

  it("keeps the Fastify-serialized ERROR responses alongside the stream", () => {
    // The 200 is declared out-of-band; the 4xx are ordinary response schemas. Emitting one must
    // not drop the other.
    const operation = operationAt(buildOpenApiDocument([sseRoute]), "/events/stream", "get");
    expect(Object.keys(operation.responses ?? {}).sort()).toEqual(["200", "401"]);
    expect(Object.keys(operation.responses?.["401"]?.content ?? {})).toEqual([
      "application/problem+json"
    ]);
  });

  it("leaves ordinary routes on application/json — the switch is per-route, not global", () => {
    const jsonRoute: CollectedRoute = {
      method: "GET",
      url: "/api/v1/things",
      schema: { response: { 200: z.object({ ok: z.boolean() }) } },
      openapi: { operationId: "listThings", summary: "Things", tags: [] }
    };
    const operation = operationAt(buildOpenApiDocument([jsonRoute]), "/things", "get");
    expect(Object.keys(operation.responses?.["200"]?.content ?? {})).toEqual(["application/json"]);
  });

  it("the COMMITTED contract really declares the stream — not just this synthetic route", () => {
    // Reads the emitted artifact the SDK is generated from and the no-bypass sweep matches
    // against, so a regression that stopped registering the route fails here and not only in a
    // E2E job (main-only when this was written; it runs on PRs now).
    const doc = JSON.parse(
      readFileSync(path.resolve(__dirname, "../../../../tools/openapi/openapi.v1.json"), "utf8")
    ) as Record<string, unknown>;
    const operation = operationAt(doc, "/events/stream", "get");

    expect(operation.operationId).toBe("streamEvents");
    expect(Object.keys(operation.responses?.["200"]?.content ?? {})).toEqual(["text/event-stream"]);
  });
});
