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
import { badRequest, frameworkClientProblem, ProblemError, sendProblem } from "./errors.js";
import { assertNoPrototypePoisoning, PrototypePoisoningError } from "./util/safe-json.js";
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
  // stringify round trip is not guaranteed byte-identical (whitespace, key order). This REPLACES
  // Fastify's default parser rather than adding a second, route-scoped one, because Fastify
  // content-type parsers are registered per content-type globally, not per-route — so whatever
  // this function does or fails to do applies to EVERY route in the process.
  //
  // THIS COMMENT USED TO CLAIM the replacement "behaves identically to Fastify's own default JSON
  // parser for every OTHER route". It was false in three ways, all measured against the base
  // commit, and the first was a live vulnerability:
  //
  //   1. Fastify's default is `secure-json-parse` with `onProtoPoisoning: "error"` and
  //      `onConstructorPoisoning: "error"`. The replacement was a bare `JSON.parse`, so prototype-
  //      poisoning rejection was absent from every route in the application — and, since nothing
  //      else in this codebase ever mentioned `secure-json-parse`, from the codebase entirely.
  //      `POST /services` with `properties: {"ok":1,"__proto__":{…}}` returned 201 Created and
  //      stored `{"ok":1}`: accepted, silently partially discarded, reported as success. Restored
  //      below via `util/safe-json.ts`, which reimplements the same two rules (that module's doc
  //      comment records why the library itself cannot be added as a dependency here: it is in the
  //      pnpm store but not the offline metadata mirror, so a direct dependency edge would need a
  //      network fetch at install time, which charter principle 5 forbids).
  //   2. A JSON syntax error did NOT surface as `FST_ERR_CTP_INVALID_JSON_BODY`. That error carries
  //      `statusCode: 400`; a raw `SyntaxError` carries none, so `setErrorHandler` below fell
  //      through to its catch-all and answered a client typo with 500 Internal Server Error
  //      (measured: `{not json` -> 500). Both failure modes now produce a 400 problem+json via
  //      `badRequest`, which is this codebase's own equivalent of that Fastify error.
  //
  //      THAT SENTENCE NAMES A PROPERTY, AND THIS PARSER WAS ONE MEMBER OF IT. `setErrorHandler`
  //      ignored `err.statusCode` for EVERY error, not only for parser errors, so every other
  //      pre-handler refusal Fastify raises was a 500 too — an unsupported media type, an
  //      oversized body, a mismatched `content-length`. Fixing the parser and leaving those is the
  //      exact shape CLAUDE.md's census-by-property rule exists to prevent, so the handler now
  //      honours the status instead: see `frameworkClientProblem` in `errors.ts` for the
  //      measured census of the whole class and `error-handler-status.test.ts` for its pins.
  //   3. An empty body does NOT match Fastify's default — the default replies
  //      `FST_ERR_CTP_EMPTY_JSON_BODY`. Parsing it to `undefined` is a DELIBERATE divergence that
  //      routes here rely on, so it is kept, and now labelled as a divergence rather than as parity.
  //
  // One further known divergence, left as-is: Fastify's default strips a leading UTF-8 BOM before
  // parsing and this does not, so a BOM-prefixed body is a 400 here. Narrowing behaviour is safe;
  // it is recorded rather than silently "fixed" because widening it is a functional change.
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
    // A FRAMEWORK-RAISED CLIENT ERROR KEEPS THE STATUS THE FRAMEWORK GAVE IT. Everything Fastify
    // refuses before a route handler runs — unsupported media type, oversized body, a
    // `content-length` that does not match the bytes — arrived here with a correct `statusCode`
    // that this handler used to drop on the floor, answering 415/413/400 conditions with 500.
    // `frameworkClientProblem` (errors.ts) carries the full census, and the reason it is narrower
    // than a bare `err.statusCode` read: `undici`'s errors carry an UPSTREAM response's status
    // under that same property name.
    //
    // Logged at `info`, not `error`: these are the caller's mistakes, and the whole harm of the
    // old behaviour was that a client typo looked like a server fault to everything downstream of
    // the logs as well as to the client.
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
  // THE PRODUCER DECLARATION'S AUTHORING SURFACE (ADR-0032 §7e). Without this line
  // `declareDependencyLineProducer` has no non-test caller, `dependency_line_producers` stays
  // empty, and the INTERNAL half of dependency subscriptions cannot fire in production at all —
  // that is the defect the route exists to close, so deleting this registration must turn
  // `dependency-producers.integration.test.ts`'s "WIRING" case red rather than merely removing a
  // convenience.
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

  // M2 step 4 (BUILD_AND_TEST.md §8 M2 item 2, DESIGN.md §14): the built Web UI v1 SPA
  // (apps/web/dist) — superseding the M0 `/ui` server-rendered stub, which is deleted (see
  // routes/typed-registries.ts and friends for the real API this now talks to via @scp/sdk).
  // `wildcard: false` makes this registration glob `apps/web/dist` once at boot and register one
  // route per real file (e.g. `/assets/index-*.js`) instead of a dynamic wildcard — the SPA
  // client-side-routing fallback below handles everything else. `decorateReply: false` avoids
  // colliding with the `/static/` registration above, which already added `reply.sendFile`.
  //
  // M16.3 P3 (owner decision 2026-07-29): a `role: retrans` relay MUST NOT serve this — the
  // profile is "no local Gitea/registry, no executor coordination, no deploy machinery, no UI"
  // (BUILD_AND_TEST.md M13.1), and a retrans sits at the most sensitive point in the topology (a
  // CDS boundary). Gated on `deps.config.federationRole` — the install-time/deployment-wide axis
  // (`config.ts`'s doc comment on `federationRole` explains why THIS axis, not `SCP_ROLE` and not
  // the per-org `self_domain.role`, governs here). Every other value (the `commander`/`outpost`
  // defaults every pre-M16.3 deployment already has) preserves the unconditional-serve behavior
  // byte-for-byte.
  if (deps.config.federationRole !== "retrans") {
    const webDistRoot = path.resolve(__dirname, "../../web/dist");
    await app.register(fastifyStatic, {
      root: webDistRoot,
      prefix: "/",
      wildcard: false,
      decorateReply: false
    });

    const webIndexHtmlPath = path.join(webDistRoot, "index.html");

    // Low-priority catch-all: find-my-way (Fastify's router) always prefers the exact/static
    // routes @fastify/static just registered over this wildcard, for any request that lands here
    // at all — so real built assets are served directly, and this only ever runs for SPA
    // client-side routes (`/services`, `/graph/abc`, ...) that have no matching file on disk. The
    // explicit `/api/`, `/static/`, `/healthz` guard is belt-and-braces on top of that route
    // precedence, so an unmatched API path still 404s as JSON rather than getting served HTML.
    //
    // READ FROM DISK EVERY TIME, DELIBERATELY. This used to memoize into a
    // `let cachedIndexHtml: string | undefined` for the lifetime of the process, which made ONE
    // document served from TWO sources under TWO different caching policies: `GET /` comes from
    // @fastify/static, which reads the file per request, while every SPA deep link came from a
    // snapshot taken at the first such request. Rebuild the web app under a running server — the
    // ordinary local loop — and Vite emits new content-hashed asset names and deletes the old
    // ones, so `/` correctly referenced the new bundle while `/services/anything` kept handing out
    // HTML pointing at files that no longer existed: two 404s and a blank page, with nothing in
    // the server log. The asymmetry was the defect, not the staleness; the fix is to make both
    // paths agree, and agreeing on "fresh" is the only option that is never wrong.
    //
    // The cost is one ~400-byte `readFile` per SPA DOCUMENT request — not per client-side
    // navigation (those never reach the server) and not per asset (@fastify/static already reads
    // those from disk per request). Next to the DB-backed API calls the page makes on load it does
    // not register. Pinned by `routes/spa-index-freshness.integration.test.ts`.
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
