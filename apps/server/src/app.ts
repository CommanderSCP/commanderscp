import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import {
  serializerCompiler,
  validatorCompiler,
  hasZodFastifySchemaValidationErrors
} from "fastify-type-provider-zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { AppDeps } from "./types.js";
import { badRequest, ProblemError, sendProblem } from "./errors.js";
import type { CollectedRoute } from "./openapi/registry.js";
import "./openapi/registry.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerObjectRoutes } from "./routes/objects.js";
import { registerUiRoutes } from "./routes/ui.js";
import { registerTypeRegistryRoutes } from "./routes/type-registry.js";
import { registerObjectRoutes as registerGenericObjectRoutes } from "./routes/objects-generic.js";
import { registerRelationshipRoutes } from "./routes/relationships.js";
import {
  registerTypedRegistryRoutes,
  TYPED_REGISTRY_RESOURCES
} from "./routes/typed-registries.js";
import { registerOwnershipRoutes } from "./routes/ownership.js";
import { registerGraphRoutes } from "./routes/graph.js";
import { registerAuditEventRoutes } from "./routes/audit-events.js";
import { registerEventStreamRoute } from "./routes/events.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface BuildAppOptions {
  /** Suppresses request logging noise for openapi:emit / tests. */
  logger?: boolean;
}

/**
 * Builds (but does not start listening on) the Fastify app. Never touches the database at
 * construction time — `pg.Pool` connects lazily — so `openapi:emit` can boot route definitions
 * without a DB (BUILD_AND_TEST.md §8 M0).
 */
export async function buildApp(
  deps: AppDeps,
  options: BuildAppOptions = {}
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? true
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const routeRegistry: CollectedRoute[] = [];
  app.decorate("routeRegistry", routeRegistry);
  app.addHook("onRoute", (routeOptions) => {
    const methods = Array.isArray(routeOptions.method)
      ? routeOptions.method
      : [routeOptions.method];
    for (const method of methods) {
      if (method === "HEAD" || method === "OPTIONS") continue;
      routeRegistry.push({
        method,
        url: routeOptions.url,
        schema: routeOptions.schema as CollectedRoute["schema"],
        openapi: (routeOptions.config as { openapi?: CollectedRoute["openapi"] } | undefined)
          ?.openapi
      });
    }
  });

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof ProblemError) {
      sendProblem(request, reply, err);
      return;
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      sendProblem(request, reply, badRequest(err.message));
      return;
    }
    request.log.error(err);
    sendProblem(request, reply, new ProblemError(500, "Internal Server Error"));
  });

  await app.register(cookie, { secret: deps.config.cookieSecret });
  await app.register(fastifyStatic, {
    root: path.resolve(__dirname, "../public"),
    prefix: "/static/"
  });

  registerAuthRoutes(app, deps);
  registerObjectRoutes(app, deps); // M0 legacy /objects/service contract (unchanged)
  registerUiRoutes(app, deps);
  registerTypeRegistryRoutes(app, deps);
  registerGenericObjectRoutes(app, deps); // M1 generic /objects/{type}
  registerRelationshipRoutes(app, deps);
  // M2: typed convenience endpoints over the same graph substrate (BUILD_AND_TEST.md §8 M2 item
  // 1) — one route-factory function invoked per resource; see routes/typed-registries.ts.
  for (const resource of TYPED_REGISTRY_RESOURCES) {
    registerTypedRegistryRoutes(app, deps, resource);
  }
  // M2: owns/consumes/depends_on sub-resource ergonomics over the typed resources above
  // (routes/ownership.ts module doc).
  registerOwnershipRoutes(app, deps);
  registerGraphRoutes(app, deps);
  registerAuditEventRoutes(app, deps);
  registerEventStreamRoute(app, deps);

  app.get("/healthz", async () => ({ status: "ok" }));

  return app;
}
