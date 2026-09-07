import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  BackfillDependencyInventoryRequestSchema,
  BackfillDependencyInventoryResponseSchema,
  ComponentDependencyBumpsResponseSchema,
  ComponentDependencyInventoryResponseSchema,
  ComponentDependencyPageQuerySchema,
  DEFAULT_DEPENDENCY_INVENTORY_BACKFILL_FETCH_BUDGET,
  DependencyLineKeySchema,
  DependencySubscriptionResolutionResponseSchema,
  DependencySubscriptionUnlockSchema,
  ProblemSchema,
  PutDependencySubscriptionUnlockRequestSchema,
  RegistryIdOrUrnParamSchema,
  type DependencyInventoryBackfillComponent,
  type DependencySubscriptionUnlock
} from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx, type TenantTx } from "../db/tenant-tx.js";
import { withOperatorDb } from "./operator-db.js";
import { objects } from "../db/schema.js";
import { authorize } from "../authz/resolve.js";
import { badRequest, conflict } from "../errors.js";
import { getObjectByIdOrUrn } from "../graph/objects-repo.js";
import { listSourceMappingsForComponents } from "../coordination/source-mappings-repo.js";
import {
  readInstanceSubscriptionUnlock,
  resolveDependencySubscription
} from "../dependencies/subscription-resolution.js";
import { ingestComponentManifests, literalRepoFor } from "../dependencies/inventory-ingestion.js";
import { createGitProviderManifestReader } from "../dependencies/manifest-reader.js";
import {
  readComponentDependencyBumps,
  readComponentDependencyInventory
} from "../dependencies/dependency-read-surface.js";
import {
  commanderOnlyFederationVerdict,
  dependencyManagementOf
} from "../dependencies/commander-only.js";
import { findIngestionStampByComponent } from "../dependencies/ingestion-stamp-repo.js";
import { requireInstanceOperator } from "../auth/operator-auth.js";

/** M21.3 — the DEPENDENCY-SUBSCRIPTION ENABLEMENT API. See docs/routes.md §130. */

/** The unlock as the API projects it. See docs/routes.md §131. */
async function readUnlockForApi(tx: TenantTx): Promise<DependencySubscriptionUnlock> {
  const state = await readInstanceSubscriptionUnlock(tx);
  const stamp = await tx.execute<{ updated_at: Date | string }>(sql`
    SELECT updated_at FROM dependency_subscription_unlock WHERE id = 'default'
  `);
  const updatedAt = stamp.rows[0]?.updated_at;
  return {
    unlocked: state.unlocked,
    note: state.note,
    updatedAt:
      updatedAt === undefined
        ? null
        : updatedAt instanceof Date
          ? updatedAt.toISOString()
          : String(updatedAt),
    source: state.source
  };
}

export function registerDependencySubscriptionRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "GET",
    url: "/api/v1/instance/dependency-subscription-unlock",
    schema: {
      response: {
        200: DependencySubscriptionUnlockSchema,
        401: ProblemSchema,
        403: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "getDependencySubscriptionUnlock",
        summary:
          "Get the instance-scoped dependency-subscription unlock — the first conjunct of the enablement AND. It UNLOCKS and never activates: with no enabling policy it subscribes zero components (ADR-0032 §6)",
        tags: ["dependencies"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const unlock = await withTenantTx(deps.db, auth.orgId, readUnlockForApi);
      reply.status(200).send(unlock);
    }
  });

  // PUT the instance unlock — operator-only (admin connection; `scp_app` has no write grant and no
  // write RLS policy on the table — drizzle/0062, two independent barriers).
  typed.route({
    method: "PUT",
    url: "/api/v1/instance/dependency-subscription-unlock",
    schema: {
      body: PutDependencySubscriptionUnlockRequestSchema,
      response: {
        200: DependencySubscriptionUnlockSchema,
        // Declared, because it is REACHABLE and load-bearing: `unlocked` is required, so an omitted
        // flag is a 400 rather than a silent lock. An undeclared status an operator can actually
        // hit is a gap in the contract, not a detail.
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "putDependencySubscriptionUnlock",
        summary:
          "Set the instance-scoped dependency-subscription unlock (operator token required — it binds every org on the deployment; unlocking activates nothing on its own, ADR-0032 §6)",
        tags: ["dependencies"]
      }
    },
    handler: async (request, reply) => {
      // Operator, not tenant. Authenticate the caller as an ordinary principal too, so the write is
      // still attributable and unauthenticated callers never reach the token comparison.
      const auth = await requireAuth(deps, request);
      await requireInstanceOperator(deps, request, "the dependency-subscription unlock");

      const body = request.body;
      // An operator connection, for the sibling door's reason. See docs/routes.md §132.
      await withOperatorDb(deps.config, "the dependency-subscription unlock", async (client) => {
        // Upsert on the pinned singleton key — the CHECK in 0062 makes `'default'` the only row this
        // table can ever hold, so there is no "which unlock" to get wrong.
        await client.query(
          `INSERT INTO dependency_subscription_unlock (id, unlocked, note, updated_at)
             VALUES ('default', $1, $2, now())
           ON CONFLICT (id) DO UPDATE SET
             unlocked   = EXCLUDED.unlocked,
             note       = EXCLUDED.note,
             updated_at = now()`,
          [body.unlocked, body.note ?? null]
        );
      });
      // Read back through the tenant path, so the response is the same projection the GET returns
      // and is produced by the same "no row means locked" reader.
      const unlock = await withTenantTx(deps.db, auth.orgId, readUnlockForApi);
      reply.status(200).send(unlock);
    }
  });

  // GET the effective resolution for one (component, line) pair. See docs/routes.md §133.
  typed.route({
    method: "GET",
    url: "/api/v1/components/:idOrUrn/dependency-subscription",
    schema: {
      params: RegistryIdOrUrnParamSchema,
      querystring: DependencyLineKeySchema,
      response: {
        200: DependencySubscriptionResolutionResponseSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "getComponentDependencySubscription",
        summary:
          "Resolve whether a component is subscribed to one dependency line, with the per-tier contributions that decided it — which level enabled it, and which level turned it off (ADR-0032 §6, charter principle 6)",
        tags: ["dependencies"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const line = request.query;
      const result = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const component = await getObjectByIdOrUrn(
          tx,
          auth.orgId,
          "component",
          request.params.idOrUrn
        );
        // Reading a component's enablement is reading the component — the same permission and the
        // same scope `GET /components/:idOrUrn/pipeline` requires.
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectId: component.id
        });
        const resolution = await resolveDependencySubscription(tx, {
          orgId: auth.orgId,
          componentObjectId: component.id,
          // The acting subject, threaded exactly as the gate threads it — `scope.group` policy
          // matching resolves against it. Its inherited fail-open exposure for a GROUP-scoped
          // opt-out is documented on `GatherSubscriptionCandidatesInput.actorObjectId` and belongs
          // to the matcher, not to this route.
          actorObjectId: auth.subjectObjectId,
          line
        });
        return { componentObjectId: component.id, line, resolution };
      });
      // The verdict is qualified by whether anything here acts. See docs/routes.md §134.
      const dependencyManagement = dependencyManagementOf(deps.config);
      reply.status(200).send({ ...result, dependencyManagement });
    }
  });

  // GET /components/:idOrUrn/dependency-inventory — M21.6 read surface. See docs/routes.md §135.
  typed.route({
    method: "GET",
    url: "/api/v1/components/:idOrUrn/dependency-inventory",
    schema: {
      params: RegistryIdOrUrnParamSchema,
      querystring: ComponentDependencyPageQuerySchema,
      response: {
        200: ComponentDependencyInventoryResponseSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "listComponentDependencyInventory",
        summary:
          "List a component's declared dependency inventory — one row per (major line, dependency manifest) with the line's observed head, its declared producer and its resolved dependency subscription for the caller — plus the per-component ingestion stamp, the component-level ingestion gate and the newest ingestion Decision, qualified by whether dependency management happens on this deployment (ADR-0032 §4/§6/§7d)",
        tags: ["dependencies"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const result = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const component = await getObjectByIdOrUrn(
          tx,
          auth.orgId,
          "component",
          request.params.idOrUrn
        );
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectId: component.id
        });
        const page = await readComponentDependencyInventory(tx, {
          orgId: auth.orgId,
          componentObjectId: component.id,
          actorObjectId: auth.subjectObjectId,
          limit: request.query.limit,
          cursor: request.query.cursor
        });
        // THE STAMP, in the same transaction as the rows it explains. `null` IS "never attempted"
        // (the repo's one reading of a missing row) and is sent as such — never omitted, so a
        // consumer can tell "no stamp" from "a server that predates the stamp".
        const stamp = await findIngestionStampByComponent(tx, auth.orgId, component.id);
        return {
          component: { id: component.id, name: component.name, domainId: component.domainId },
          ingestion:
            stamp === null
              ? null
              : {
                  lastAttemptAt: stamp.lastAttemptAt,
                  source: stamp.source,
                  outcome: stamp.outcome,
                  rowsWritten: stamp.rowsWritten,
                  detail: stamp.detail,
                  manifests: stamp.manifests.map((m) => ({
                    repo: m.repo,
                    path: m.path,
                    outcome: m.outcome,
                    rows: m.rows,
                    at: m.at,
                    ...(m.detail !== undefined ? { detail: m.detail } : {})
                  }))
                },
          lastIngestionDecision: page.lastIngestionDecision,
          componentGate: page.componentGate,
          rows: page.rows,
          nextCursor: page.nextCursor
        };
      });
      // The posture, from the ONE predicate (`dependencyManagementOf`), exactly as the resolve route
      // attaches it. Computed off config, outside the transaction, like there.
      const dependencyManagement = dependencyManagementOf(deps.config);
      reply.status(200).send({ ...result, dependencyManagement });
    }
  });

  // GET /components/:idOrUrn/dependency-bumps — M21.6 read surface. See docs/routes.md §136.
  typed.route({
    method: "GET",
    url: "/api/v1/components/:idOrUrn/dependency-bumps",
    schema: {
      params: RegistryIdOrUrnParamSchema,
      querystring: ComponentDependencyPageQuerySchema,
      response: {
        200: ComponentDependencyBumpsResponseSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "listComponentDependencyBumps",
        summary:
          "List the dependency bumps CommanderSCP authored for a component, newest first — each joined to its change name, its dispatch delivery and the newest merge verdict; pullRequestUrl is the provider's own URL when one was recorded, else null (never composed); qualified by whether dependency management happens on this deployment (ADR-0032 §7d/§8)",
        tags: ["dependencies"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const result = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const component = await getObjectByIdOrUrn(
          tx,
          auth.orgId,
          "component",
          request.params.idOrUrn
        );
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectId: component.id
        });
        const page = await readComponentDependencyBumps(tx, {
          orgId: auth.orgId,
          componentObjectId: component.id,
          limit: request.query.limit,
          cursor: request.query.cursor
        });
        return {
          component: { id: component.id, name: component.name, domainId: component.domainId },
          rows: page.rows,
          nextCursor: page.nextCursor
        };
      });
      const dependencyManagement = dependencyManagementOf(deps.config);
      reply.status(200).send({ ...result, dependencyManagement });
    }
  });

  // POST /dependencies/inventory/backfill — M21.2. See docs/routes.md §137.
  typed.route({
    method: "POST",
    url: "/api/v1/dependencies/inventory/backfill",
    schema: {
      body: BackfillDependencyInventoryRequestSchema,
      response: {
        200: BackfillDependencyInventoryResponseSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema,
        409: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "backfillDependencyInventory",
        summary:
          "Read enabled components' dependency manifests and (re)build their inventory — the backfill for components that have not released since being enabled (ADR-0032 §4). COMMANDER-ONLY: a deployment whose SCP_FEDERATION_ROLE is not an explicitly declared 'commander' answers 409 (ADR-0032 §7d)",
        tags: ["dependencies"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      // Checked BEFORE the plugin-host fail-close, so an outpost is told the true answer ("run it
      // on the commander") rather than being sent to find a plugin-host-capable process it should
      // not be running this on either way. After `requireAuth`, so the route does not become an
      // unauthenticated oracle for this deployment's federation role.
      const commander = commanderOnlyFederationVerdict(
        deps.config,
        "the dependency-inventory backfill"
      );
      if (!commander.allowed) throw conflict(commander.reason);
      const host = deps.pluginHost;
      if (!host) {
        // Reading a manifest is a live plugin call, exactly as `POST /discovery/run` is. `main.ts`
        // constructs a host for every role, so this is reachable only for a `buildApp` handed no
        // host (tests, `openapi:emit`).
        throw badRequest(
          "dependency-inventory backfill requires a plugin-host-capable process: it reads each component's dependency manifests through its git-provider binding"
        );
      }
      const ref = request.body.ref ?? "HEAD";

      // ONE transaction for the authorization and the WORK-LIST, closed before any provider call —
      // a network round trip must not run behind a held, RLS-scoped pooled connection (ADR-0032
      // §7c clause 2).
      const targets = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        // Ingestion WRITES the org's inventory, so it is authorized as a write at the org scope —
        // the same permission and scope `POST /discovery/backfill-source-mappings` required for the
        // same "create rows onto existing components" shape, before that route was retired.
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          scopeObjectId: auth.orgId
        });
        const components: { id: string; name: string }[] = [];
        if (request.body.componentIdsOrUrns === undefined) {
          const rows = await tx
            .select({ id: objects.id, name: objects.name })
            .from(objects)
            .where(
              and(
                eq(objects.orgId, auth.orgId),
                eq(objects.typeId, "component"),
                isNull(objects.deletedAt)
              )
            )
            .orderBy(objects.name, objects.id);
          components.push(...rows);
        } else {
          for (const idOrUrn of request.body.componentIdsOrUrns) {
            // 404 on an unknown component rather than a silent skip: an operator who named a
            // component must not be told "0 ingested" when the name was simply wrong.
            const component = await getObjectByIdOrUrn(tx, auth.orgId, "component", idOrUrn);
            components.push({ id: component.id, name: component.name });
          }
        }
        // The repo comes from DECLARED config — the component's own `source_mappings` — and is
        // `null` when they name none literally, or name two different ones. Resolved here so the
        // fetch phase below opens no transaction of its own.
        const mappings = await listSourceMappingsForComponents(
          tx,
          auth.orgId,
          components.map((c) => c.id)
        );
        return components.map((component) => ({
          ...component,
          repo: literalRepoFor(
            mappings
              .filter((m) => m.componentObjectId === component.id)
              .map((m) => m.repoPattern ?? null)
          )
        }));
      });

      const readManifest = createGitProviderManifestReader({
        db: deps.db,
        host,
        orgId: auth.orgId,
        masterKey: deps.config.secretsMasterKey
      });

      const components: DependencyInventoryBackfillComponent[] = [];
      // The fetch budget is spent only by components that fetched. See docs/routes.md §138.
      const fetchBudget =
        request.body.fetchBudget ?? DEFAULT_DEPENDENCY_INVENTORY_BACKFILL_FETCH_BUDGET;
      let fetched = 0;

      for (const target of targets) {
        if (fetched >= fetchBudget) {
          components.push({
            componentObjectId: target.id,
            name: target.name,
            verdict: "not_attempted",
            detail:
              `the fetch budget of ${fetchBudget} component(s) was spent before this one was ` +
              `reached — nothing was read and nothing was written for it; re-run (or narrow the ` +
              `run with componentIdsOrUrns) to continue`,
            manifestsIngested: 0,
            declarationsRecorded: 0,
            declarationsPruned: 0,
            manifestsRemoved: 0,
            manifestsSkipped: 0,
            reads: 0
          });
          continue;
        }
        const outcome = await ingestComponentManifests(deps.db, auth.orgId, {
          componentObjectId: target.id,
          repo: target.repo ?? undefined,
          ref,
          readManifest,
          actorObjectId: auth.subjectObjectId,
          // WHICH PRODUCER THIS IS, on the component's ingestion stamp (M21.7, drizzle/0065) — so a
          // reader can tell "this inventory is maintained by the component's own releases" from
          // "this inventory is only as fresh as the last time an operator ran a backfill".
          source: "backfill"
        });
        if (outcome.reads > 0) fetched += 1;
        components.push({
          componentObjectId: target.id,
          name: target.name,
          verdict: outcome.verdict,
          detail:
            outcome.verdict === "not_addressable" && target.repo === null
              ? "this component's source_mappings name no single literal repo (none, a glob, or two different repos), so there is no repository to read its dependency manifests from"
              : outcome.detail,
          manifestsIngested: outcome.manifests.length,
          declarationsRecorded: outcome.manifests.reduce((sum, m) => sum + m.declared, 0),
          // THE DESTRUCTIVE HALF, CARRIED THROUGH THE PROJECTION. See docs/routes.md §139.
          declarationsPruned: outcome.manifests.reduce((sum, m) => sum + m.pruned, 0),
          manifestsRemoved: outcome.manifests.filter((m) => m.removed).length,
          manifestsSkipped: outcome.skipped.length,
          reads: outcome.reads
        });
      }

      reply.status(200).send({
        ref,
        components,
        ingested: components.filter((c) => c.verdict === "ingested").length,
        notEnabled: components.filter((c) => c.verdict === "not_enabled").length,
        notAddressable: components.filter((c) => c.verdict === "not_addressable").length,
        superseded: components.filter((c) => c.verdict === "superseded").length,
        notAttempted: components.filter((c) => c.verdict === "not_attempted").length,
        declarationsPruned: components.reduce((sum, c) => sum + c.declarationsPruned, 0)
      });
    }
  });

  // NOTE, for the next reader: there is no POST/PUT/DELETE for a subscription here. See the module
  // doc — a subscription is a `dependencySubscription` effect on an ordinary `policy` object
  // (ADR-0032 §3a) and is authored through the existing policy routes. Adding a bespoke write path
  // would create a second authoring surface for one concept.
  // The unlock is NOT that: it is instance-scoped rather than org-scoped, so it is a singleton table
  // with operator-gated writes (0029/0035/0036 precedent), never a policy.
}
