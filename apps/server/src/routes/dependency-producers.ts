import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  DeclareDependencyLineProducerRequestSchema,
  DependencyLineProducerVerbResponseSchema,
  ListDependencyLineProducersQuerySchema,
  ListDependencyLineProducersResponseSchema,
  ProblemSchema,
  RetractDependencyLineProducerRequestSchema,
  type DependencyLineProducerKey,
  type DependencyProducerOpenBump
} from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx, type TenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
import { badRequest, conflict } from "../errors.js";
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import {
  getDependencyLineProducer,
  listDependencyLineProducers
} from "../dependencies/dependency-inventory-repo.js";
import {
  authorizeDependencyProducerWrite,
  declareProducerWithEffects,
  projectLineImpacts,
  readProducerBlastRadius,
  retractProducerWithEffects,
  viewsOfDeclarations
} from "../dependencies/producer-declaration.js";
import {
  commanderOnlyFederationVerdict,
  dependencyManagementOf
} from "../dependencies/commander-only.js";

/**
 * Re-exported so `GET /decisions?kind=…` consumers and this route's own tests keep one import site.
 * The constant, and the WHOLE ACT it labels, now live in `dependencies/producer-declaration.ts`
 * because IaC apply is a second door into the same table — see that module's header.
 */
export { PRODUCER_DECISION_KIND } from "../dependencies/producer-declaration.js";

/** THE PRODUCER DECLARATION'S AUTHORING SURFACE. See docs/routes/dependency-producers.md §1. */

/**
 * Resolve the caller-supplied producer to a LIVE, NON-DELETED, IN-ORG `component`.
 *
 * Three refusals, each with its own remedy, because collapsing them would send an operator hunting
 * for the wrong thing:
 *   - not resolvable in this org -> 404 from `getObjectByIdOrUrnAnyType` (which excludes deleted
 *     rows and scopes by `orgId`, so the cross-tenant and tombstone cases land here);
 *   - a `service` -> 400 naming the first-cut refusal and what it would silently do;
 *   - any other type (a deployment-target, a user) -> 400 naming what was found.
 */
async function assertDeclarableProducer(
  tx: TenantTx,
  orgId: string,
  producerIdOrUrn: string
): Promise<{ id: string; name: string }> {
  const object = await getObjectByIdOrUrnAnyType(tx, orgId, producerIdOrUrn);
  if (object.typeId === "service") {
    throw badRequest(
      `'${producerIdOrUrn}' is a service, and a SERVICE-valued producer declaration is refused in ` +
        `the first cut (ADR-0032 §7e): internal head derivation reads the COMPONENT a production ` +
        `placement names, so a service declaration would remove this coordinate from third-party ` +
        `polling and derive no head at all — the harmful half without the useful one. Declare the ` +
        `component that publishes the artifact.`
    );
  }
  if (object.typeId !== "component") {
    throw badRequest(
      `a producer must be a component; '${producerIdOrUrn}' is a ${object.typeId}. The declaration ` +
        `says "this component's production releases are where this coordinate's versions come from", ` +
        `which only a component can be.`
    );
  }
  return { id: object.id, name: object.name };
}

export function registerDependencyProducerRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // POST /dependencies/producers — DECLARE. See docs/routes/dependency-producers.md §2.
  typed.route({
    method: "POST",
    url: "/api/v1/dependencies/producers",
    schema: {
      body: DeclareDependencyLineProducerRequestSchema,
      response: {
        200: DependencyLineProducerVerbResponseSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema,
        409: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "declareDependencyLineProducer",
        summary:
          "Declare that a component produces one dependency coordinate — the ONE way a coordinate becomes internal, so its versions are derived from the org's own production releases instead of a public index (ADR-0032 §7e). Requires 'policy:write' at the ORG ROOT: the declaration changes behaviour for every component in the org that depends on the coordinate. Returns the blast radius; `dryRun` returns it without writing. COMMANDER-ONLY: a deployment whose SCP_FEDERATION_ROLE is not an explicitly declared 'commander' answers 409",
        tags: ["dependencies"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      // Before the work and after authentication, so an outpost is told the true answer ("run it on
      // the commander") and the route is not an unauthenticated oracle for this deployment's role.
      const commander = commanderOnlyFederationVerdict(
        deps.config,
        "declaring a dependency-line producer"
      );
      if (!commander.allowed) throw conflict(commander.reason);

      const body = request.body;
      const key: DependencyLineProducerKey = {
        ecosystem: body.ecosystem,
        coordinate: body.coordinate
      };
      const dryRun = body.dryRun === true;

      const result = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        // ORG-WIDE BLAST RADIUS -> ORG-ROOT AUTHORITY, read from the ONE definition IaC apply also
        // reads (`dependencyProducerScopeCheck`) so the two doors cannot come to require different
        // things. The org root object id is the org id (bootstrap invariant).
        await authorizeDependencyProducerWrite(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId
        });
        const producer = await assertDeclarableProducer(tx, auth.orgId, body.producerIdOrUrn);
        const before = await readProducerBlastRadius(tx, auth.orgId, key, auth.subjectObjectId);

        if (dryRun) {
          return {
            // NO PROJECTED DECLARATION. See docs/routes/dependency-producers.md §3.
            declaration: null,
            lines: projectLineImpacts(before),
            decisionId: null
          };
        }

        // THE WHOLE ACT — the row, the head-clearing, the Decision and the audit event — is
        // `declareProducerWithEffects`, shared with the IaC apply door. Three of those four used to
        // be written out here, which is exactly how a second door comes to perform a fraction of a
        // verb; see `dependencies/producer-declaration.ts` for what each one is load-bearing for.
        const { declaration, lines, decisionId } = await declareProducerWithEffects(tx, {
          orgId: auth.orgId,
          actorObjectId: auth.subjectObjectId,
          requestId: request.id,
          key,
          producerObjectId: producer.id
        });

        // NAMED for the wire (the view) — the producer's and the declarer's names, one batched read
        // (dependency-subscription-ui.md §12.6 Q1). Inside the same transaction as the write, so the
        // names are the ones the declaration was made against.
        const [view] = await viewsOfDeclarations(tx, auth.orgId, [declaration]);
        return { declaration: view ?? null, lines, decisionId };
      });

      reply.status(200).send({
        ecosystem: key.ecosystem,
        coordinate: key.coordinate,
        action: "declare" as const,
        dryRun,
        declaration: result.declaration,
        lines: result.lines,
        // Declaring stops nothing that is already in flight; the list belongs to retraction.
        openBumpAuthorships: [],
        decisionId: result.decisionId,
        dependencyManagement: dependencyManagementOf(deps.config)
      });
    }
  });

  // -------------------------------------------------------------------------------------------
  // POST /dependencies/producers/retract — the peer verb.
  //
  // A SEPARATE PATH RATHER THAN A `producerIdOrUrn: null`. The two acts have different bodies (a
  // retraction names no producer), different reports (only a retraction can have bumps in flight)
  // and different Decisions, and a nullable field that switches a verb between two meanings is how
  // an omitted key becomes a destructive default.
  // -------------------------------------------------------------------------------------------
  typed.route({
    method: "POST",
    url: "/api/v1/dependencies/producers/retract",
    schema: {
      body: RetractDependencyLineProducerRequestSchema,
      response: {
        200: DependencyLineProducerVerbResponseSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema,
        409: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "retractDependencyLineProducer",
        summary:
          "Retract a producer declaration and return the coordinate to third-party polling (ADR-0032 §7e). Clears every covered line's observed head — a head the org's own releases put there would otherwise wedge the line, and is a security-gate input. Reports the bumps still in flight, which SCP does NOT close. Requires 'policy:write' at the ORG ROOT. COMMANDER-ONLY (409 elsewhere)",
        tags: ["dependencies"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const commander = commanderOnlyFederationVerdict(
        deps.config,
        "retracting a dependency-line producer"
      );
      if (!commander.allowed) throw conflict(commander.reason);

      const body = request.body;
      const key: DependencyLineProducerKey = {
        ecosystem: body.ecosystem,
        coordinate: body.coordinate
      };
      const dryRun = body.dryRun === true;

      const result = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorizeDependencyProducerWrite(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId
        });
        const existing = await getDependencyLineProducer(tx, auth.orgId, key);
        if (existing === null) {
          // 400, not 404: the ROUTE exists and the request is addressed at this org's inventory —
          // what is wrong is that the caller believes a declaration exists that does not. A 404
          // would read as "no such endpoint" to a CLI user.
          throw badRequest(
            `no producer is declared for ${key.ecosystem} '${key.coordinate}' in this org, so there ` +
              `is nothing to retract. The coordinate is already polled as third-party.`
          );
        }
        const before = await readProducerBlastRadius(tx, auth.orgId, key, auth.subjectObjectId);

        if (dryRun) {
          return {
            declaration: null,
            lines: projectLineImpacts(before),
            openBumps: [] as DependencyProducerOpenBump[],
            decisionId: null
          };
        }

        // THE WHOLE ACT, shared with the IaC apply door — the row's removal, the head-clearing (a
        // SECURITY fix in this direction: a stale internal head is an M22 vendor-scan-rule input),
        // the open-bump report, the Decision and the audit event. See
        // `dependencies/producer-declaration.ts`.
        const { lines, openBumps, decisionId } = await retractProducerWithEffects(tx, {
          orgId: auth.orgId,
          actorObjectId: auth.subjectObjectId,
          requestId: request.id,
          key,
          existing
        });

        return { declaration: null, lines, openBumps, decisionId };
      });

      reply.status(200).send({
        ecosystem: key.ecosystem,
        coordinate: key.coordinate,
        action: "retract" as const,
        dryRun,
        declaration: null,
        lines: result.lines,
        openBumpAuthorships: result.openBumps.map((b) => ({
          changeObjectId: b.changeObjectId,
          componentObjectId: b.componentObjectId,
          repo: b.repo,
          manifestPath: b.manifestPath,
          fromVersion: b.fromVersion,
          toVersion: b.toVersion,
          ...(b.pullRequestUrl !== undefined ? { pullRequestUrl: b.pullRequestUrl } : {})
        })),
        decisionId: result.decisionId,
        dependencyManagement: dependencyManagementOf(deps.config)
      });
    }
  });

  // GET /dependencies/producers — the read. See docs/routes/dependency-producers.md §4.
  typed.route({
    method: "GET",
    url: "/api/v1/dependencies/producers",
    schema: {
      querystring: ListDependencyLineProducersQuerySchema,
      response: {
        200: ListDependencyLineProducersResponseSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "listDependencyLineProducers",
        summary:
          "List this org's declared dependency-line producers — which components the org declares it publishes which coordinates from (ADR-0032 §7e). Narrowable by ecosystem, or to one exact coordinate (compared VERBATIM). Read the `dependencyManagement` envelope: on a field outpost this list is empty BY DESIGN, because declarations live at the commander",
        tags: ["dependencies"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const producers = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        // Reading the org's declarations is reading org-scoped configuration — `object:read` at the
        // org root, the ordinary tenant read. It is deliberately NOT the org-root `policy:write`
        // the writes require: seeing which coordinates the org claims is not authority to change
        // which ones it claims.
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectId: auth.orgId
        });
        const rows = await listDependencyLineProducers(tx, auth.orgId, {
          ...(request.query.ecosystem !== undefined ? { ecosystem: request.query.ecosystem } : {}),
          ...(request.query.coordinate !== undefined
            ? { coordinate: request.query.coordinate }
            : {})
        });
        // NAMED for the wire — producer + declarer, one batched `objects` read for the whole list
        // (dependency-subscription-ui.md §12.6 Q1, owner 2026-08-18): the reader that needs a name
        // (a page, an operator at a terminal) gets it in the same round trip, and no client pays
        // N+1 reads it may not be authorized to make (a user object is readable by few).
        return viewsOfDeclarations(tx, auth.orgId, rows);
      });
      reply.status(200).send({
        producers,
        dependencyManagement: dependencyManagementOf(deps.config)
      });
    }
  });
}
