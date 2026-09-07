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
import { GLOBAL_BODY_LIMIT_BYTES } from "./http-limits.js";
import { getSharedCelSandbox } from "./governance/cel-sandbox.js";
import { badRequest, frameworkClientProblem, ProblemError, sendProblem } from "./errors.js";
import { assertNoPrototypePoisoning, PrototypePoisoningError } from "./util/safe-json.js";
import type { CollectedRoute } from "./openapi/registry.js";
import "./openapi/registry.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerPatRoutes } from "./routes/pats.js";
import { registerOidcRoutes } from "./routes/oidc.js";
import { registerDeviceFlowRoutes } from "./routes/device-flow.js";
import { registerRoleBindingRoutes } from "./routes/role-bindings.js";
import { registerAuthzRoutes } from "./routes/authz.js";
import { registerOperatorCredentialRoutes } from "./routes/operator-credentials.js";
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
import { registerPlacementRoutes } from "./routes/placements.js";
import { registerServiceRoutes } from "./routes/services.js";
import { registerChangeSourceRoutes } from "./routes/change-sources.js";
import { registerPipelineRoutes } from "./routes/pipelines.js";
import { registerCampaignRoutes } from "./routes/campaigns.js";
import { registerFederationRoutes } from "./routes/federation.js";
import { registerExecutorRoutes } from "./routes/executors.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerDoctorRoutes } from "./routes/doctor.js";
import { registerInstanceScanFloorRoutes } from "./routes/instance-scan-floors.js";
import { registerInstanceFreezeRoutes } from "./routes/instance-freezes.js";
import { registerInstanceScanExclusionAdmissionRoutes } from "./routes/instance-scan-exclusion-admissions.js";
import { registerScannerAssignmentRoutes } from "./routes/scanner-assignments.js";
import { registerScanOverrideGrantRoutes } from "./routes/scan-override-grants.js";
import { registerScanDbRoutes } from "./routes/scan-db.js";
import { registerDependencySubscriptionRoutes } from "./routes/dependency-subscriptions.js";
import { registerDependencyProducerRoutes } from "./routes/dependency-producers.js";
import { registerGovernanceMoveRoutes } from "./routes/governance-move.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** M7 (routes/change-sources.ts, coordination/webhook-signature.ts). See docs/server.md §2. */
declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export interface BuildAppOptions {
  logger?: boolean;
}

/** Builds (but does not start listening on) the Fastify app. See docs/server.md §3. */
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
    // Global body ceiling. See docs/server.md §4.
    bodyLimit: GLOBAL_BODY_LIMIT_BYTES,
    // M9.3 (ADR-0001, `docs/adr/0001-in-app-federation-mtls.md`). See docs/server.md §5.
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

  // Captures the raw request bytes for signature checking. See docs/server.md §6.
  app.addContentTypeParser<Buffer>(
    "application/json",
    { parseAs: "buffer" },
    (request, body, done) => {
      request.rawBody = body;
      if (body.length === 0) {
        done(null, undefined);
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        done(badRequest("Malformed JSON body"), undefined);
        return;
      }
      try {
        assertNoPrototypePoisoning(parsed);
      } catch (err) {
        // Refuse the whole request. NOT `protoAction: "remove"`: stripping the key would accept a
        // request while silently discarding part of it, which is exactly the behaviour that made
        // the original defect invisible.
        done(
          badRequest(
            err instanceof PrototypePoisoningError
              ? err.message
              : "Object contains forbidden prototype property"
          ),
          undefined
        );
        return;
      }
      done(null, parsed);
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
    // A framework-raised client error keeps its own status. See docs/server.md §7.
    const clientProblem = frameworkClientProblem(err);
    if (clientProblem) {
      request.log.info({ err }, "request refused");
      sendProblem(request, reply, clientProblem);
      return;
    }
    request.log.error(err);
    // NEVER `err.message` here. Honouring `statusCode` must not slide into honouring the message
    // of a fault we did not anticipate: a 5xx body is the fixed title and nothing else.
    sendProblem(request, reply, new ProblemError(500, "Internal Server Error"));
  });

  await app.register(cookie, { secret: deps.config.cookieSecret });
  await app.register(fastifyStatic, {
    root: path.resolve(__dirname, "../public"),
    prefix: "/static/"
  });

  registerAuthRoutes(app, deps);
  // M2 step 2: AuthN expansion (BUILD_AND_TEST.md §8 M2 item 3) — PATs, generic OIDC, and the
  // CLI device-authorization flow, alongside local-auth (unchanged) above.
  registerPatRoutes(app, deps);
  registerOidcRoutes(app, deps);
  registerDeviceFlowRoutes(app, deps);
  // role-model.md §5 step 5 — `GET /roles` + `GET/POST/DELETE /role-bindings`, the door that makes
  // `role_binding:write` mean something after gating ZERO call sites since drizzle/0002. Pinned by
  // `routes/rbac-role-binding-door.integration.test.ts`'s WIRING case: delete this line and the
  // roles read 404s, which is what "built, never installed" looks like from the outside.
  registerRoleBindingRoutes(app, deps);
  registerAuthzRoutes(app, deps);
  registerOperatorCredentialRoutes(app, deps);
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
  // ADR-0026: `placement` is NOT a template resource either, for the mirror reason — it needs a
  // create that requires BOTH endpoints and writes the two derived edges atomically
  // (routes/placements.ts).
  registerPlacementRoutes(app, deps);
  // Phase 2 coordination UI: service-scoped read projections (release board). Registered after the
  // typed-registry `/services` CRUD; the `/board` path segment keeps it clear of the `/:idOrUrn` route.
  registerServiceRoutes(app, deps);
  // M2: owns/consumes/depends_on sub-resource ergonomics over the typed resources above
  // (routes/ownership.ts module doc).
  registerOwnershipRoutes(app, deps);
  registerGraphRoutes(app, deps);
  registerAuditEventRoutes(app, deps);
  registerEventStreamRoute(app, deps);
  // M2 step 3: `@scp/iac` server-side plan/apply (BUILD_AND_TEST.md §8 M2 item 4).
  registerPlanRoutes(app, deps);
  // M3: the Change lifecycle + Decision records (BUILD_AND_TEST.md §8 M3) — propose/list/get/
  // cancel/accept/rollback/explain, plus the standalone `/decisions` sub-resource.
  registerChangeRoutes(app, deps);
  // M3: webhook ingress (persist-then-process) + source_mappings correlation config.
  registerChangeSourceRoutes(app, deps);
  // team-pipeline-iac increment 8: the PUSHED pipeline-evidence door (test runs, alarm state).
  // Pinned by `routes/pipeline-evidence.integration.test.ts`'s WIRING case: delete this line and
  // the submission that feeds a gate 404s instead of 201-ing.
  registerPipelineRoutes(app, deps);
  // M4: Policy/Control typed-registry resources (routes/typed-registries.ts's module doc) +
  // control bindings/runs, approvals, freezes, and `scp policy evaluate` (BUILD_AND_TEST.md §8 M4).
  for (const resource of GOVERNANCE_TYPED_REGISTRY_RESOURCES) {
    registerTypedRegistryRoutes(app, deps, resource);
  }
  registerGovernanceRoutes(app, deps);
  // The governance:move lattice — the opt-in second bar on a containment MOVE, plus its instance
  // rung (proposal governance-reach-on-containment-move.md §9.2, owner ruling 2026-08-18). Pinned by
  // `governance/move-enforcement.integration.test.ts`'s WIRING case: delete this line and the
  // explain read 404s, which is what "built, never installed" looks like from the outside.
  registerGovernanceMoveRoutes(app, deps);
  registerInstanceScanFloorRoutes(app, deps); // M17.5 instance-scoped scan floors (ADR-0016)
  // M25.3 instance-scoped (platform) freezes (drizzle/0086, campaigns-rework §2, owner decision
  // D1) — the freeze tier ABOVE org. Pinned by `governance/instance-freeze-admission
  // .integration.test.ts`'s WIRING case: delete this line and the list read 404s, which is what
  // "built, never installed" looks like from the outside.
  registerInstanceFreezeRoutes(app, deps);
  // M22.9 instance-scoped exclusion admissions (ADR-0033 §1/§7a) — the `platform` and
  // `trust_domain` rungs of the monotone AND, which no policy can ever contribute.
  registerInstanceScanExclusionAdmissionRoutes(app, deps);
  registerScannerAssignmentRoutes(app, deps); // M13.3a instance-scoped scanner assignments (ADR-0020)
  registerScanDbRoutes(app, deps); // M13.3b-ii offline scanner-DB cache: status/staleness/refresh/load (ADR-0020)
  registerDependencySubscriptionRoutes(app, deps); // M21.3 instance unlock + (component, line) enablement resolution (ADR-0032 §6)
  // THE PRODUCER DECLARATION'S AUTHORING SURFACE. See docs/server.md §8.
  registerDependencyProducerRoutes(app, deps);
  registerScanOverrideGrantRoutes(app, deps); // M22.6 standing, expiring scan override grants (ADR-0033 §6a)
  // M5: Campaigns (BUILD_AND_TEST.md §8 M5, DESIGN.md §9.5) — coordinate many
  // Changes over the same M3/M4 machinery; no new engine, see coordination/campaign-status.ts.
  registerCampaignRoutes(app, deps);
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
  // `scp doctor` — read-only operational self-checks for the caller's org. Distinct from `/healthz`
  // below in both senses that matter: it asks "is this instance's state COHERENT" rather than "is
  // this process up", and it is exactly the class of condition a green liveness probe hides.
  registerDoctorRoutes(app, deps);

  app.get("/healthz", async () => ({ status: "ok" }));

  // M2 step 4 (BUILD_AND_TEST.md §8 M2 item 2, DESIGN.md §14). See docs/server.md §9.
  if (deps.config.federationRole !== "retrans") {
    const webDistRoot = path.resolve(__dirname, "../../web/dist");
    await app.register(fastifyStatic, {
      root: webDistRoot,
      prefix: "/",
      wildcard: false,
      decorateReply: false
    });

    const webIndexHtmlPath = path.join(webDistRoot, "index.html");

    // Low-priority catch-all: find-my-way. See docs/server.md §10.
    app.get("/*", async (request, reply) => {
      if (
        request.url.startsWith("/api/") ||
        request.url.startsWith("/static/") ||
        request.url === "/healthz"
      ) {
        reply.callNotFound();
        return;
      }
      let indexHtml: string;
      try {
        indexHtml = await readFile(webIndexHtmlPath, "utf8");
      } catch {
        reply
          .status(503)
          .send(
            "Web UI is not built — run `pnpm --filter @scp/web build` (apps/web/dist missing)."
          );
        return;
      }
      reply.type("text/html").send(indexHtml);
    });
  } else {
    // A retrans instance still needs the API (`/api/*`) and `/healthz` to work — only the UI/static
    // surface is withheld. Anything that isn't `/api/*`/`/healthz` 404s as JSON here (never HTML),
    // same shape the guarded catch-all above already used for a bad API path.
    app.get("/*", async (request, reply) => {
      reply.callNotFound();
    });
  }

  return app;
}
