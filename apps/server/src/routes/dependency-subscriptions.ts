import { timingSafeEqual } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import pg from "pg";
import {
  BackfillDependencyInventoryRequestSchema,
  BackfillDependencyInventoryResponseSchema,
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
import { objects } from "../db/schema.js";
import { authorize } from "../authz/resolve.js";
import { badRequest, conflict, forbidden } from "../errors.js";
import { getObjectByIdOrUrn } from "../graph/objects-repo.js";
import { listSourceMappingsForComponents } from "../coordination/source-mappings-repo.js";
import {
  readInstanceSubscriptionUnlock,
  resolveDependencySubscription
} from "../dependencies/subscription-resolution.js";
import { ingestComponentManifests, literalRepoFor } from "../dependencies/inventory-ingestion.js";
import { createGitProviderManifestReader } from "../dependencies/manifest-reader.js";
import { commanderOnlyFederationVerdict } from "../dependencies/commander-only.js";

/**
 * M21.3 — the DEPENDENCY-SUBSCRIPTION ENABLEMENT API (ADR-0032 §3a, §6), API-first per charter
 * principle 3 (API -> SDK -> CLI). The DELIBERATE TWIN of `routes/instance-scan-floors.ts` and
 * `routes/scan-db.ts`: same two-audiences / two-credentials shape, same reasons.
 *
 *  - **The instance unlock's READ is tenant-facing.** A component team whose subscription is inert
 *    because the DEPLOYMENT never opened the feature has been handed an unexplainable verdict
 *    (charter principle 6), so the singleton is readable by any authenticated principal. It runs
 *    inside the ordinary tenant transaction under the table's tenant-read RLS policy — the same path
 *    resolution itself takes, so no derivation ever needs the privileged connection (ADR-0016 §3's
 *    stated reason for preferring this shape). It leaks nothing across tenants because the row holds
 *    NO per-tenant data at all.
 *
 *  - **The instance unlock's WRITE is operator-only, and deliberately NOT an RBAC permission.** The
 *    row binds EVERY org on the deployment, so no tenant role — however privileged inside its own
 *    org — may grant it: the write requires the deployment-level `SCP_OPERATOR_TOKEN`
 *    (`x-scp-operator-token`) and executes over the ADMIN connection, because `scp_app` holds no
 *    write grant and no write RLS policy exists for the table (drizzle/0062 — two independent
 *    barriers). Unset token ⇒ the surface is CLOSED (403), never a fallback to a tenant credential.
 *
 *  - **The resolution READ is tenant-facing and authorized like any other read of the component**
 *    (`object:read` at the component's scope, exactly as `GET /components/:idOrUrn/pipeline` does).
 *
 * THERE IS NO WRITE PATH FOR A SUBSCRIPTION ITSELF HERE, AND ONE MUST NOT BE ADDED. A dependency
 * subscription IS a `dependencySubscription` effect on an ordinary `policy` object (ADR-0032 §3a) —
 * a team subscribes by authoring a policy at their own component through the EXISTING policy routes
 * (`POST /api/v1/policies`, `scp policy register`) and opts one line back out with a second effect at
 * the same or a deeper scope:
 *
 *     effects: [{ dependencySubscription: { enabled: true } }]
 *     effects: [{ dependencySubscription: { coordinate: "@acme/lib", enabled: false } }]
 *
 * A bespoke create/update/delete here would be a SECOND authoring path for one concept, needing its
 * own versioning, its own journal handling and its own scope semantics — and the two would drift.
 * The absence is the design, not an omission.
 *
 * NOTHING HERE COMPUTES THE AND. Both handlers read; the merge lives in exactly one place
 * (`dependencies/subscription-resolution.ts`'s `mergeDependencySubscription`), so a UI verdict, a
 * CLI answer and the M21.4 ingestion work-list cannot disagree.
 */

/** Constant-time comparison of the presented operator token against the configured one — a
 *  length-leaking `===` on a shared secret is exactly the kind of thing a security review flags.
 *  Byte-for-byte the `instance-scan-floors.ts` / `scan-db.ts` helper. */
function operatorTokenMatches(presented: unknown, configured: string | undefined): boolean {
  if (!configured || typeof presented !== "string" || presented.length === 0) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(configured, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function requireOperator(deps: AppDeps, request: FastifyRequest): void {
  if (!deps.config.operatorToken) {
    throw forbidden(
      "the dependency-subscription unlock is operator-authored: SCP_OPERATOR_TOKEN is not configured on this deployment, so the write surface is closed"
    );
  }
  if (!operatorTokenMatches(request.headers["x-scp-operator-token"], deps.config.operatorToken)) {
    throw forbidden(
      "unlocking dependency subscriptions requires the deployment operator token (x-scp-operator-token) — no tenant role can grant this, because the unlock binds every org on the deployment"
    );
  }
}

/**
 * The unlock as the API projects it.
 *
 * `unlocked`/`note` come from `readInstanceSubscriptionUnlock` rather than from a SELECT written
 * here, so NO ROW MEANS LOCKED is decided in exactly ONE place (drizzle/0062's header, pinned by
 * `subscription-resolution.test.ts`). Re-deriving that default in a route is how the API and the
 * resolver would come to disagree about a deployment that has never been configured — the loudest
 * possible bug in the safest-sounding line of code.
 *
 * `updated_at` is the one field the resolver has no use for and so does not return; it is read
 * alongside, in the SAME transaction, purely so an operator can tell "never set" (`null`) from
 * "deliberately re-locked" (a timestamp).
 */
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

  // GET the instance unlock — tenant-readable.
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
      requireOperator(deps, request);

      const body = request.body;
      const pool = new pg.Pool({ connectionString: deps.config.databaseUrl, max: 1 });
      try {
        // Upsert on the pinned singleton key — the CHECK in 0062 makes `'default'` the only row this
        // table can ever hold, so there is no "which unlock" to get wrong.
        await pool.query(
          `INSERT INTO dependency_subscription_unlock (id, unlocked, note, updated_at)
             VALUES ('default', $1, $2, now())
           ON CONFLICT (id) DO UPDATE SET
             unlocked   = EXCLUDED.unlocked,
             note       = EXCLUDED.note,
             updated_at = now()`,
          [body.unlocked, body.note ?? null]
        );
      } finally {
        await pool.end();
      }
      // Read back through the tenant path, so the response is the same projection the GET returns
      // and is produced by the same "no row means locked" reader.
      const unlock = await withTenantTx(deps.db, auth.orgId, readUnlockForApi);
      reply.status(200).send(unlock);
    }
  });

  // GET the effective resolution for one (component, line) pair — THE EXPLAINABILITY SURFACE.
  //
  // An extra `/dependency-subscription` segment, so it never collides with the component registry's
  // `/:idOrUrn` detail route — the same shape as `/components/:idOrUrn/pipeline`.
  //
  // The line arrives as a QUERY, and the query schema IS `DependencyLineKeySchema` — the natural key
  // of a `dependency_lines` row, reused rather than restated, so the bytes an operator asks about
  // are structurally the bytes a line is identified by. A coordinate travels VERBATIM here
  // (`@acme/lib` stays `@acme/lib`): the selector comparison is byte equality, and a normalising
  // surface would answer about a package nobody named.
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
      reply.status(200).send(result);
    }
  });

  // -------------------------------------------------------------------------------------------
  // POST /dependencies/inventory/backfill — M21.2 (ADR-0032 §4).
  //
  // WHY A ROUTE EXISTS AT ALL. Ingestion is event-driven: a correlated, accepted change re-reads its
  // component's dependency manifests. That is the right trigger and it covers only components that
  // release from now on — so on an existing estate the inventory stays EMPTY until each team happens
  // to commit, and every capability above it (the enablement work-list, the version poll, internal
  // detection's manifest-path lookup) resolves over nothing in the meantime. The precedent is
  // `POST /discovery/backfill-source-mappings`, which exists for exactly this class of problem and
  // is operator-triggered, idempotent, and reports every skip.
  //
  // THE GATE IS NOT WEAKER HERE. `ingestComponentManifests` resolves enablement itself, before it
  // touches a repo, so a backfill over the whole org reads nothing for an unsubscribed component —
  // this route cannot pass a flag to skip that, because there is none.
  //
  // THE ACTOR IS THE REQUESTING PRINCIPAL, not the system sentinel, and that is a real difference:
  // `matchPoliciesForTargets` resolves `scope.group` against the actor and the sentinel is a member
  // of nothing (ADR-0032 §6a), so a human running a backfill sees the same enablement the resolution
  // API reports to them.
  //
  // IT IS COMMANDER-ONLY, AND FAIL-CLOSED ON AN UNDECLARED DEPLOYMENT (ADR-0032 §7d, M21.7). This
  // route is the OPERATOR-TRIGGERED half of the same ingestion the loop performs, so it must not be
  // the door the loop's guard is walked around: an outpost that can no longer ingest on an accepted
  // change could otherwise ingest the identical inventory by POSTing here, and the guard would be
  // decorative. The predicate is `commander-only.ts`'s, shared with the four background jobs, so
  // the two doors cannot drift.
  //
  // ONLY THE FEDERATION AXIS, DELIBERATELY. The jobs additionally require an `all`/`worker`
  // `SCP_ROLE`; a ROUTE must not, because in the split topology every HTTP request lands on an
  // `SCP_ROLE=api` process by design — carrying the process axis here would refuse every caller on
  // a perfectly correct commander. See `commanderOnlyFederationVerdict`'s own doc.
  //
  // WHY 409 AND NOT 400/403/404. This is "right request, wrong place": the body is valid, the
  // caller may be entirely entitled, and the resource is not hidden — what is wrong is the
  // DEPLOYMENT the request arrived at. 403 would say the principal lacks permission, which is a
  // different remedy (grant a role) from the real one (call the commander), and this route already
  // spends 403 on the authorization failure it really has. 400 would blame the request, which is
  // well-formed — the sibling `badRequest` below is about THIS PROCESS lacking a plugin host, a
  // narrower "wrong process" the operator fixes by routing to a worker-capable one, and conflating
  // the two would send an outpost operator hunting for a plugin host. 404 would deny the route
  // exists, which is false and unhelpful. 409 Conflict is what this codebase already uses for a
  // request that conflicts with THE STATE OF THIS INSTANCE rather than with the caller's rights —
  // `POST /federation/poke`'s "this instance is not configured for poke-mode from peer X"
  // (routes/federation.ts) is the same shape and the precedent followed here. The detail names why
  // and says WHERE to run it, because a refusal an operator cannot act on is the same as silence.
  // Adding a documented 409 to an existing operation is additive under the /v1 oasdiff gate (a
  // non-success status ADDED is not an ERR-level break; nothing existing is removed and no required
  // response field becomes optional).
  // -------------------------------------------------------------------------------------------
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
        // the same permission and scope `POST /discovery/backfill-source-mappings` requires for the
        // same "create rows onto existing components" shape.
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
      // THE FETCH BUDGET IS SPENT ONLY BY COMPONENTS THAT ACTUALLY FETCHED. An unsubscribed
      // component costs no provider call at all (the gate refuses before a repo is touched), so a
      // whole-org run still reports every component's enablement while bounding the live I/O this
      // one request performs. Without a bound, `componentIdsOrUrns: undefined` walked every
      // component in the org inline, at up to `MAX_MANIFEST_READS` git-provider round trips each.
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
          // THE DESTRUCTIVE HALF, CARRIED THROUGH THE PROJECTION. `ingestComponentManifests`
          // returns `pruned`/`removed` per manifest and this route used to drop both, so a run that
          // deleted a component's whole inventory reported `verdict: "ingested"` and was
          // indistinguishable from a clean one. A receipt that only counts what was added cannot
          // tell an operator they backfilled at the wrong ref.
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
