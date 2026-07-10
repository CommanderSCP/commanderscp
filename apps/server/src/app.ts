import path from "node:path";
import { readFile } from "node:fs/promises";
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
import { getSharedCelSandbox } from "./governance/cel-sandbox.js";
import { badRequest, ProblemError, sendProblem } from "./errors.js";
import type { CollectedRoute } from "./openapi/registry.js";
import "./openapi/registry.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerPatRoutes } from "./routes/pats.js";
import { registerOidcRoutes } from "./routes/oidc.js";
import { registerDeviceFlowRoutes } from "./routes/device-flow.js";
import { registerObjectRoutes } from "./routes/objects.js";
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
import { registerPlanRoutes } from "./routes/plans.js";
import { registerChangeRoutes } from "./routes/changes.js";
import { registerChangeSourceRoutes } from "./routes/change-sources.js";

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
  // M4: every request-serving process needs a CEL sandbox for gate evaluation (types.ts's doc
  // comment on `AppDeps.celSandbox`) — defaulted here so every pre-M4 `buildApp({db, config})`
  // call site keeps compiling and behaving identically.
  deps.celSandbox ??= getSharedCelSandbox();

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
  // M2 stage 2: AuthN expansion (BUILD_AND_TEST.md §8 M2 item 3) — PATs, generic OIDC, and the
  // CLI device-authorization flow, alongside local-auth (unchanged) above.
  registerPatRoutes(app, deps);
  registerOidcRoutes(app, deps);
  registerDeviceFlowRoutes(app, deps);
  registerObjectRoutes(app, deps); // M0 legacy /objects/service contract (unchanged)
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
  // M2 stage 3: `@scp/iac` server-side plan/apply (BUILD_AND_TEST.md §8 M2 item 4).
  registerPlanRoutes(app, deps);
  // M3: the Change lifecycle + Decision records (BUILD_AND_TEST.md §8 M3) — propose/list/get/
  // cancel/promote/rollback/explain, plus the standalone `/decisions` sub-resource.
  registerChangeRoutes(app, deps);
  // M3: webhook ingress (persist-then-process) + source_mappings correlation config.
  registerChangeSourceRoutes(app, deps);

  app.get("/healthz", async () => ({ status: "ok" }));

  // M2 stage 4 (BUILD_AND_TEST.md §8 M2 item 2, DESIGN.md §14): the built Web UI v1 SPA
  // (apps/web/dist) — superseding the M0 `/ui` server-rendered stub, which is deleted (see
  // routes/typed-registries.ts and friends for the real API this now talks to via @scp/sdk).
  // `wildcard: false` makes this registration glob `apps/web/dist` once at boot and register one
  // route per real file (e.g. `/assets/index-*.js`) instead of a dynamic wildcard — the SPA
  // client-side-routing fallback below handles everything else. `decorateReply: false` avoids
  // colliding with the `/static/` registration above, which already added `reply.sendFile`.
  const webDistRoot = path.resolve(__dirname, "../../web/dist");
  await app.register(fastifyStatic, {
    root: webDistRoot,
    prefix: "/",
    wildcard: false,
    decorateReply: false
  });

  const webIndexHtmlPath = path.join(webDistRoot, "index.html");
  let cachedIndexHtml: string | undefined;

  // Low-priority catch-all: find-my-way (Fastify's router) always prefers the exact/static
  // routes @fastify/static just registered over this wildcard, for any request that lands here
  // at all — so real built assets are served directly, and this only ever runs for SPA
  // client-side routes (`/services`, `/graph/abc`, ...) that have no matching file on disk. The
  // explicit `/api/`, `/static/`, `/healthz` guard is belt-and-braces on top of that route
  // precedence, so an unmatched API path still 404s as JSON rather than getting served HTML.
  app.get("/*", async (request, reply) => {
    if (
      request.url.startsWith("/api/") ||
      request.url.startsWith("/static/") ||
      request.url === "/healthz"
    ) {
      reply.callNotFound();
      return;
    }
    try {
      cachedIndexHtml ??= await readFile(webIndexHtmlPath, "utf8");
    } catch {
      reply
        .status(503)
        .send("Web UI is not built — run `pnpm --filter @scp/web build` (apps/web/dist missing).");
      return;
    }
    reply.type("text/html").send(cachedIndexHtml);
  });

  return app;
}
