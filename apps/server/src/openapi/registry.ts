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
    /** Declares the 200 as an SSE stream rather than a JSON body. See docs/openapi.md §4. */
    eventStream?: ZodTypeAny;
  };
}

declare module "fastify" {
  interface FastifyInstance {
    routeRegistry: CollectedRoute[];
  }
}
