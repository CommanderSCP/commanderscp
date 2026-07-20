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
  GOVERNANCE_TYPED_REGISTRY_RESOURCES,
  registerTypedRegistryRoutes,
  TYPED_REGISTRY_RESOURCES
} from "./routes/typed-registries.js";
import { registerGovernanceRoutes } from "./routes/governance.js";
import { registerOwnershipRoutes } from "./routes/ownership.js";
import { registerGraphRoutes } from "./routes/graph.js";
import { registerAuditEventRoutes } from "./routes/audit-events.js";
import { registerEventStreamRoute } from "./routes/events.js";
import { registerPlanRoutes } from "./routes/plans.js";
import { registerChangeRoutes } from "./routes/changes.js";
import { registerComponentRoutes } from "./routes/components.js";
import { registerServiceRoutes } from "./routes/services.js";
import { registerChangeSourceRoutes } from "./routes/change-sources.js";
import { registerCampaignRoutes } from "./routes/campaigns.js";
import { registerInitiativeRoutes } from "./routes/initiatives.js";
import { registerFederationRoutes } from "./routes/federation.js";
import { registerExecutorRoutes } from "./routes/executors.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerInstanceScanFloorRoutes } from "./routes/instance-scan-floors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * M7 (routes/change-sources.ts, coordination/webhook-signature.ts): every inbound webhook source
 * (GitHub, TFC/Atlantis, ...) signs over the RAW request bytes, not a re-serialized
 * JSON.parse/stringify round trip — whitespace/key-order differences would break the HMAC. Fastify
 * augmented here with the one extra field the signature-verification path needs.
 */
declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

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
    logger: options.logger ?? true,
    // M6 (DESIGN.md §13 — bundle-parser robustness, M6 PR body "SECURITY-SENSITIVE" flag):
    // `.scpbundle` files POST straight to /federation/imports as one JSON body; Fastify's
    // built-in default (1 MiB) would reject legitimate multi-thousand-entry bundles, but an
    // UNBOUNDED limit is exactly the oversized-payload DoS surface a bundle parser must defend
    // against. 64 MiB is a generous, explicit, non-infinite ceiling — enforced by Fastify BEFORE
    // the body is ever handed to JSON.parse or any federation code.
    bodyLimit: 64 * 1024 * 1024,
    // M9.3 (ADR-0001, `docs/adr/0001-in-app-federation-mtls.md`) — when in-app federation mTLS is
    // configured, the WHOLE process listens as HTTPS (there is only ever one Fastify instance /
    // one `.listen()` call — main.ts), not just the federation routes: Node has no per-route TLS
    // concept, only per-listener. `requestCert: true, rejectUnauthorized: false` is mandatory, not
    // a relaxed default — this SAME listener also serves browsers/CLI/SDK traffic that must NOT be
    // required to present a client certificate; `rejectUnauthorized: false` asks for a cert but
    // never refuses the HANDSHAKE over its absence, so enforcement happens per-route instead
    // (`federation/mtls-enforcement.ts`'s `enforceFederationMtls`, called explicitly as the first
    // statement in each of the three federation transport routes' handlers in
    // `routes/federation.ts` — see that module's doc comment for why this is a plain function
    // call rather than a registered Fastify hook). When `federationServerMtls` is unset (the
    // default), `https` is omitted entirely and Fastify builds a plain `http.Server`, byte-for-byte
    // the pre-M9.3 behavior.
    ...(deps.config.federationServerMtls
      ? {
          https: {
            key: deps.config.federationServerMtls.key,
            cert: deps.config.federationServerMtls.cert,
            ca: deps.config.federationServerMtls.ca,
            crl: deps.config.federationServerMtls.crl,
            requestCert: true,
            rejectUnauthorized: false
          }
        }
      : {})
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // M7 (coordination/webhook-signature.ts): captures the RAW request bytes onto `request.rawBody`
  // BEFORE JSON-parsing them — every webhook signature scheme (GitHub's `X-Hub-Signature-256`, the
  // generic `sha256=` fallback) is computed over those exact bytes, and a JSON.parse -> JSON.
  // stringify round trip is not guaranteed byte-identical (whitespace, key order). Behaves
  // identically to Fastify's own default JSON parser for every OTHER route — this replaces it
  // wholesale rather than adding a second, route-scoped parser, since Fastify content-type parsers
  // are registered per content-type globally, not per-route. An empty body parses to `undefined`
  // (matches Fastify's default), and a JSON syntax error surfaces as the same `FST_ERR_CTP_INVALID_
  // JSON_BODY`-shaped error the default parser produces (rethrown as-is so the existing error
  // handling table is unaffected).
  app.addContentTypeParser<Buffer>(
    "application/json",
    { parseAs: "buffer" },
    (request, body, done) => {
      request.rawBody = body;
      if (body.length === 0) {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(body.toString("utf8")));
      } catch (err) {
        done(err as Error, undefined);
      }
    }
  );

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
  // M12 P5a: `component` is NOT a template resource (it needs a strict, service-requiring create
  // that writes the `contains` edge atomically) — its routes are bespoke (routes/components.ts).
  registerComponentRoutes(app, deps);
  // Phase 2 coordination UI: service-scoped read projections (release board). Registered after the
  // typed-registry `/services` CRUD; the `/board` path segment keeps it clear of the `/:idOrUrn` route.
  registerServiceRoutes(app, deps);
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
  // M4: Policy/Control typed-registry resources (routes/typed-registries.ts's module doc) +
  // control bindings/runs, approvals, freezes, and `scp policy evaluate` (BUILD_AND_TEST.md §8 M4).
  for (const resource of GOVERNANCE_TYPED_REGISTRY_RESOURCES) {
    registerTypedRegistryRoutes(app, deps, resource);
  }
  registerGovernanceRoutes(app, deps);
  registerInstanceScanFloorRoutes(app, deps); // M17.5 instance-scoped scan floors (ADR-0016)
  // M5: Campaigns & Initiatives (BUILD_AND_TEST.md §8 M5, DESIGN.md §9.5) — coordinate many
  // Changes over the same M3/M4 machinery; no new engine, see coordination/campaign-status.ts.
  registerCampaignRoutes(app, deps);
  registerInitiativeRoutes(app, deps);
  // M6: Federation Basics (BUILD_AND_TEST.md §8 M6, DESIGN.md §13) — sync journal export/import,
  // peer pairing, Promotion Bundles, overlays, hand-fill. See routes/federation.ts's module doc.
  registerFederationRoutes(app, deps);
  // M7: Real Executor Integrations (BUILD_AND_TEST.md §8 M7, DESIGN.md §11/§12) — executor/
  // notification bindings, encrypted secrets, plugin manifests, DiscoveryPlugin run/accept.
  registerExecutorRoutes(app, deps);
  // Observe-enrichment signal 4 (ADR-0008 decision 4): owner PUSH-IN of latest object health +
  // read paths (single object read, and the batch graph node-payload join). SCP stores pushed
  // health; it never probes/polls/computes it (charter principle 1). Stored graph-natively as an
  // object-referencing projection row (DESIGN §4.1), not a new top-level table (principle 2).
  registerHealthRoutes(app, deps);

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
