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
  };
}

declare module "fastify" {
  interface FastifyInstance {
    routeRegistry: CollectedRoute[];
  }
}
