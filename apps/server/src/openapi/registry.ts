import type { ZodTypeAny } from "zod";

/** Route metadata captured via Fastify's `onRoute` hook, driving OpenAPI emission. */
export interface CollectedRoute {
  method: string;
  url: string;
  schema?: {
    params?: ZodTypeAny;
    querystring?: ZodTypeAny;
    body?: ZodTypeAny;
    response?: Record<string, ZodTypeAny>;
  };
  openapi?: {
    operationId: string;
    summary: string;
    tags?: string[];
    /**
     * Declares the 200 response as a Server-Sent Events stream whose `data:` frames match this
     * schema, emitted as `content: { "text/event-stream": … }` instead of `application/json`.
     *
     * It lives here rather than in `schema.response[200]` because Fastify's response schema drives
     * SERIALIZATION of a single reply body, and an SSE handler writes frames to `reply.raw` itself
     * — there is no one body for Fastify to serialize. The contract is still a Zod schema from
     * `@scp/schemas`, so the generator produces the same operation, type and `responseValidator`
     * it produces for every JSON response (`hasOperationSse` in `@hey-api/openapi-ts` switches the
     * generated call onto `client.sse.get`).
     */
    eventStream?: ZodTypeAny;
  };
}

declare module "fastify" {
  interface FastifyInstance {
    routeRegistry: CollectedRoute[];
  }
}
