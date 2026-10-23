import { sql } from "drizzle-orm";
import { z } from "zod";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  ProblemSchema,
  PutStackBackendRequestSchema,
  PutStackSettingsRequestSchema,
  PutStackStatusRequestSchema,
  PutStackWiringRequestSchema,
  PutStackAuthoringRequestSchema,
  STACK_CONTROLLER_STALE_AFTER_MS,
  Sha256HexSchema,
  StackBackendParamSchema,
  StackBackendSchema,
  StackDiagnosticsSchema,
  StackNeedSchema,
  StackSizeTierSchema,
  StackSpecDocumentSchema,
  StackUpdatePolicySchema,
  StackBackendPhaseSchema,
  StackOrgParamSchema,
  StackServedOrgListSchema,
  StackViewSchema,
  StackWireableBackendSchema,
  type InstanceActor,
  type StackBackendView,
  type StackDiagnostics,
  type StackNeed,
  type StackServedOrgList,
  type StackSpecDocument,
  type StackView
} from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import {
  appendInstanceAudit,
  requireInstanceAuthority,
  requireStackControllerCredential
} from "../auth/instance-authority.js";
import { verifyOperatorCredential } from "../auth/operator-auth.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { badRequest, conflict } from "../errors.js";
import { withOperatorTx } from "./instance-operators.js";
import {
  attachServedOrg,
  detachServedOrg,
  dropWiring,
  isWireableBackend,
  listServedOrgs,
  readWiringsOnClient,
  reconcileStackRegistrations,
  stackServesOrg,
  storeWiring,
  validateWiring,
  wiringOf,
  SELECT_WIRINGS,
  type Wiring,
  type WiringRow
} from "../stack/wiring.js";
import {
  AUTHORING_BACKENDS,
  SELECT_AUTHORING,
  authoringRowOf,
  readStackAuthoringOnClient,
  stackAuthoringView,
  storeAuthoring,
  withdrawAuthoring,
  type StackAuthoringRow
} from "../stack/authoring.js";

/**
 * THE STANDARD STACK's API (M29.4, ADR-0058). Two audiences, two kinds of door:
 *
 * - People read the stack with their ordinary session, and CHANGE it with instance authority: the
 *   instance-operator role on that same session (owner decision 2026-09-25 — the browser holds no
 *   credential), or a full operator credential for machines and scripts. Every change — and every
 *   diagnostics download — appends to the instance audit chain in the same transaction.
 * - The stack controller is a member of no org. It uses exactly two doors, with its install-time
 *   `stack-controller`-scoped credential: read the spec, write the status. Only that credential
 *   may write status.
 *
 * Every write goes through the operator connection; `scp_app` holds SELECT only (drizzle/0126).
 */

interface BackendRow extends Record<string, unknown> {
  backend: string;
  enabled: boolean;
  size_tier: string;
  purge_generation: number;
  rotate_generation: number;
  phase: string | null;
  running_version: string | null;
  target_version: string | null;
  last_error: string | null;
  needs: unknown;
  detail: unknown;
  last_good_sha256: string | null;
  inventory_sha256: string | null;
  status_observed_at: Date | string | null;
}

interface SettingsRow extends Record<string, unknown> {
  update_policy: string;
  upgrade_generation: number;
  controller_release: string | null;
  controller_observed_upgrade_generation: number | null;
  controller_seen_at: Date | string | null;
}

interface StackRows {
  backends: BackendRow[];
  settings: SettingsRow | undefined;
  /** M29.2 — the controller's hand-offs (non-secret facts; tokens live elsewhere). */
  wirings: Wiring[];
  /** M29.2 — whether the stack serves the reader's org; null when no org is reading. */
  servesThisOrg: boolean | null;
  /** M29.3 — the controller's canary-authoring hand-off. */
  authoring: StackAuthoringRow;
}

const iso = (v: Date | string | null): string | null =>
  v === null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString();

/** Parsed defensively: a stored value outside today's vocabulary is dropped, never served. */
function parseNeeds(raw: unknown): StackNeed[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((n) => {
    const parsed = StackNeedSchema.safeParse(n);
    return parsed.success ? [parsed.data] : [];
  });
}

function parseDetail(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((d): d is string => typeof d === "string") : [];
}

const hexOrNull = (v: string | null): string | null =>
  v !== null && Sha256HexSchema.safeParse(v).success ? v : null;

/** Every backend, always — an absent row is the never-configured default. */
function backendViews(rows: BackendRow[], wirings: Wiring[]): StackBackendView[] {
  const byName = new Map(rows.map((r) => [r.backend, r]));
  const wired = new Map(wirings.map((w) => [w.backend as string, w]));
  return StackBackendSchema.options.map((backend) => {
    const row = byName.get(backend);
    const w = wired.get(backend);
    const tier = StackSizeTierSchema.safeParse(row?.size_tier);
    const phase = StackBackendPhaseSchema.safeParse(row?.phase);
    return {
      backend,
      enabled: row?.enabled === true,
      sizeTier: tier.success ? tier.data : "small",
      purgeGeneration: row?.purge_generation ?? 0,
      status:
        row && phase.success && row.status_observed_at !== null
          ? {
              phase: phase.data,
              runningVersion: row.running_version,
              targetVersion: row.target_version,
              lastError: row.last_error,
              needs: parseNeeds(row.needs),
              observedAt: iso(row.status_observed_at)!
            }
          : null,
      rotateGeneration: row?.rotate_generation ?? 0,
      wiring: isWireableBackend(backend)
        ? {
            wired: w !== undefined,
            serverUrl: w?.serverUrl ?? null,
            caSha256: hexOrNull(w?.caSha256 ?? null),
            account: w?.account ?? null,
            wiredAt: w?.wiredAt ?? null,
            rotationGeneration: w?.rotationGeneration ?? null
          }
        : null
    };
  });
}

function settingsOf(row: SettingsRow | undefined): StackView["settings"] {
  const policy = StackUpdatePolicySchema.safeParse(row?.update_policy);
  return {
    updatePolicy: policy.success ? policy.data : "automatic",
    upgradeGeneration: row?.upgrade_generation ?? 0
  };
}

export function stackViewOf(rows: StackRows, now: Date = new Date()): StackView {
  const seenAt = iso(rows.settings?.controller_seen_at ?? null);
  return {
    settings: settingsOf(rows.settings),
    controller: {
      release: rows.settings?.controller_release ?? null,
      lastSeenAt: seenAt,
      reporting:
        seenAt !== null && now.getTime() - Date.parse(seenAt) <= STACK_CONTROLLER_STALE_AFTER_MS,
      observedUpgradeGeneration: rows.settings?.controller_observed_upgrade_generation ?? null
    },
    backends: backendViews(rows.backends, rows.wirings),
    servesThisOrg: rows.servesThisOrg,
    authoring: stackAuthoringView(rows.authoring, rows.wirings)
  };
}

/** The controller's input: enumerated values, plus the hashes of its OWN state as it last
 *  reported them (see stack-spec-census). */
export function stackSpecOf(rows: StackRows): StackSpecDocument {
  const byName = new Map(rows.backends.map((r) => [r.backend, r]));
  return {
    settings: settingsOf(rows.settings),
    backends: backendViews(rows.backends, rows.wirings).map(
      ({ backend, enabled, sizeTier, purgeGeneration, rotateGeneration }) => ({
        backend,
        enabled,
        sizeTier,
        purgeGeneration,
        rotateGeneration
      })
    ),
    integrity: StackBackendSchema.options.map((backend) => ({
      backend,
      lastGoodSha256: hexOrNull(byName.get(backend)?.last_good_sha256 ?? null),
      inventorySha256: hexOrNull(byName.get(backend)?.inventory_sha256 ?? null)
    })),
    // A hash and a counter per backend — never the endpoint, the CA or the token (the census).
    wiring: StackBackendSchema.options.map((backend) => {
      const w = rows.wirings.find((x) => x.backend === backend);
      return {
        backend,
        factsSha256: hexOrNull(w?.factsSha256 ?? null),
        rotationGeneration: w?.rotationGeneration ?? null
      };
    }),
    // M29.3: a hash, never the revision or the cluster names (the census).
    authoring: {
      factsSha256: rows.authoring.revision ? hexOrNull(rows.authoring.factsSha256) : null
    }
  };
}

type Executor = (query: ReturnType<typeof sql>) => Promise<Record<string, unknown>[]>;

const SELECT_BACKENDS = sql`
  SELECT backend, enabled, size_tier, purge_generation, rotate_generation, phase, running_version,
         target_version,
         last_error, needs, detail, last_good_sha256, inventory_sha256, status_observed_at
    FROM stack_backends`;
const SELECT_SETTINGS = sql`
  SELECT update_policy, upgrade_generation, controller_release,
         controller_observed_upgrade_generation, controller_seen_at
    FROM stack_settings WHERE id = 'instance'`;

async function readStackRows(
  exec: Executor,
  servesThisOrg: boolean | null = null
): Promise<StackRows> {
  const backends = (await exec(SELECT_BACKENDS)) as BackendRow[];
  const settings = (await exec(SELECT_SETTINGS)) as SettingsRow[];
  const wirings = ((await exec(sql.raw(SELECT_WIRINGS))) as WiringRow[]).flatMap(
    (r) => wiringOf(r) ?? []
  );
  const authoring = authoringRowOf(
    ((await exec(sql.raw(SELECT_AUTHORING))) as Parameters<typeof authoringRowOf>[0][])[0]
  );
  return { backends, settings: settings[0], wirings, servesThisOrg, authoring };
}

/** Reads through the request-serving pool; the tables' `tenant_read` policy is `USING (true)`. */
async function readStackUnscoped(deps: AppDeps): Promise<StackRows> {
  return readStackRows(async (q) => (await deps.db.execute(q)).rows);
}

async function readStackAsTenant(deps: AppDeps, orgId: string): Promise<StackRows> {
  return withTenantTx(deps.db, orgId, async (tx) =>
    readStackRows(async (q) => (await tx.execute(q)).rows, await stackServesOrg(tx, orgId))
  );
}

/** The same read, on the operator transaction the change ran in. */
async function readStackOnClient(client: pg.PoolClient): Promise<StackRows> {
  const backends = (
    await client.query<BackendRow>(
      `SELECT backend, enabled, size_tier, purge_generation, rotate_generation, phase,
              running_version, target_version, last_error, needs, detail, last_good_sha256,
              inventory_sha256, status_observed_at FROM stack_backends`
    )
  ).rows;
  const settings = (
    await client.query<SettingsRow>(
      `SELECT update_policy, upgrade_generation, controller_release,
              controller_observed_upgrade_generation, controller_seen_at
         FROM stack_settings WHERE id = 'instance'`
    )
  ).rows[0];
  return {
    backends,
    settings,
    wirings: await readWiringsOnClient(client),
    servesThisOrg: null,
    authoring: await readStackAuthoringOnClient(client)
  };
}

const SURFACE = "the Standard Stack";

/** One audited change: authority, the write and its audit link in one transaction, then the view. */
async function auditedChange(
  deps: AppDeps,
  requestId: string,
  actor: InstanceActor,
  audit: { action: string; subject: string | null },
  write: (client: pg.PoolClient) => Promise<Record<string, unknown>>
): Promise<StackView> {
  const rows = await withOperatorTx(deps.config, SURFACE, async (client) => {
    const detail = await write(client);
    await appendInstanceAudit(client, {
      action: audit.action,
      actor,
      subject: audit.subject,
      detail,
      requestId
    });
    return readStackOnClient(client);
  });
  return stackViewOf(rows);
}

export function registerStackRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const changeResponses = {
    200: StackViewSchema,
    400: ProblemSchema,
    401: ProblemSchema,
    403: ProblemSchema,
    409: ProblemSchema
  };

  typed.route({
    method: "GET",
    url: "/api/v1/instance/stack",
    schema: { response: { 200: StackViewSchema, 401: ProblemSchema } },
    config: {
      openapi: {
        operationId: "getStack",
        summary:
          "The Standard Stack: each bundled backend's desired state and the stack controller's last report (health, version, what it still needs) (ADR-0058)",
        tags: ["stack"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      reply.status(200).send(stackViewOf(await readStackAsTenant(deps, auth.orgId)));
    }
  });

  typed.route({
    method: "PUT",
    url: "/api/v1/instance/stack/backends/:backend",
    schema: {
      params: StackBackendParamSchema,
      body: PutStackBackendRequestSchema,
      response: changeResponses
    },
    config: {
      openapi: {
        operationId: "putStackBackend",
        summary:
          "Enable or disable one Standard Stack backend, and set its sizing tier (instance-operator role or operator credential; audited)",
        tags: ["stack"]
      }
    },
    handler: async (request, reply) => {
      const actor = await requireInstanceAuthority(deps, request, SURFACE);
      const { backend } = request.params;
      const { enabled, sizeTier } = request.body;
      const view = await auditedChange(
        deps,
        request.id,
        actor,
        { action: enabled ? "stack.backend.enable" : "stack.backend.disable", subject: backend },
        async (client) => {
          const before = await client.query<{ enabled: boolean; size_tier: string }>(
            "SELECT enabled, size_tier FROM stack_backends WHERE backend = $1",
            [backend]
          );
          await client.query(
            `INSERT INTO stack_backends (backend, enabled, size_tier, spec_updated_at)
               VALUES ($1, $2, COALESCE($3, 'small'), now())
             ON CONFLICT (backend) DO UPDATE SET
               enabled         = EXCLUDED.enabled,
               size_tier       = COALESCE($3, stack_backends.size_tier),
               spec_updated_at = now()`,
            [backend, enabled, sizeTier ?? null]
          );
          const b = before.rows[0];
          // M29.3: canary authoring stands on Argo CD, Gitea and Argo Rollouts. Disabling any of
          // them withdraws it IN THIS TRANSACTION — a canary asked for from this moment is refused,
          // never rolled out plainly while the controller catches up.
          const authoringWithdrawn =
            !enabled && (AUTHORING_BACKENDS as readonly string[]).includes(backend)
              ? await withdrawAuthoring(client, {
                  actor,
                  requestId: request.id,
                  reason: `${backend} was disabled`
                })
              : false;
          return {
            before: b ? { enabled: b.enabled, sizeTier: b.size_tier } : null,
            after: { enabled, sizeTier: sizeTier ?? b?.size_tier ?? "small" },
            ...(authoringWithdrawn ? { authoringWithdrawn: true } : {})
          };
        }
      );
      reply.status(200).send(view);
    }
  });

  typed.route({
    method: "POST",
    url: "/api/v1/instance/stack/backends/:backend/purge",
    schema: { params: StackBackendParamSchema, response: changeResponses },
    config: {
      openapi: {
        operationId: "purgeStackBackend",
        summary:
          "Delete a DISABLED backend's retained data — its volumes and generate-once secrets. Irreversible (instance-operator role or operator credential; audited)",
        tags: ["stack"]
      }
    },
    handler: async (request, reply) => {
      const actor = await requireInstanceAuthority(deps, request, SURFACE);
      const { backend } = request.params;
      const view = await auditedChange(
        deps,
        request.id,
        actor,
        { action: "stack.backend.purge", subject: backend },
        async (client) => {
          const row = await client.query<{ enabled: boolean }>(
            "SELECT enabled FROM stack_backends WHERE backend = $1",
            [backend]
          );
          if (row.rows[0]?.enabled) {
            throw conflict(`${backend} is enabled — disable it before purging its data`);
          }
          const res = await client.query<{ purge_generation: number }>(
            `INSERT INTO stack_backends (backend, purge_generation) VALUES ($1, 1)
             ON CONFLICT (backend) DO UPDATE SET purge_generation = stack_backends.purge_generation + 1
             RETURNING purge_generation`,
            [backend]
          );
          return { purgeGeneration: res.rows[0]!.purge_generation };
        }
      );
      reply.status(200).send(view);
    }
  });

  typed.route({
    method: "PUT",
    url: "/api/v1/instance/stack/settings",
    schema: { body: PutStackSettingsRequestSchema, response: changeResponses },
    config: {
      openapi: {
        operationId: "putStackSettings",
        summary:
          "Set whether a new SCP release's stack versions roll out automatically or wait for an upgrade request (instance-operator role or operator credential; audited)",
        tags: ["stack"]
      }
    },
    handler: async (request, reply) => {
      const actor = await requireInstanceAuthority(deps, request, SURFACE);
      const view = await auditedChange(
        deps,
        request.id,
        actor,
        { action: "stack.settings.put", subject: null },
        async (client) => {
          await client.query(
            `INSERT INTO stack_settings (id, update_policy, updated_at) VALUES ('instance', $1, now())
             ON CONFLICT (id) DO UPDATE SET update_policy = EXCLUDED.update_policy, updated_at = now()`,
            [request.body.updatePolicy]
          );
          return { updatePolicy: request.body.updatePolicy };
        }
      );
      reply.status(200).send(view);
    }
  });

  typed.route({
    method: "POST",
    url: "/api/v1/instance/stack/upgrade",
    schema: { response: changeResponses },
    config: {
      openapi: {
        operationId: "requestStackUpgrade",
        summary:
          "Ask the stack controller to roll every enabled backend onto the versions this SCP release carries — approves a held upgrade, or retries one that was rolled back (instance-operator role or operator credential; audited)",
        tags: ["stack"]
      }
    },
    handler: async (request, reply) => {
      const actor = await requireInstanceAuthority(deps, request, SURFACE);
      const view = await auditedChange(
        deps,
        request.id,
        actor,
        { action: "stack.upgrade.request", subject: null },
        async (client) => {
          const res = await client.query<{ upgrade_generation: number }>(
            `INSERT INTO stack_settings (id, upgrade_generation, updated_at) VALUES ('instance', 1, now())
             ON CONFLICT (id) DO UPDATE SET
               upgrade_generation = stack_settings.upgrade_generation + 1,
               updated_at         = now()
             RETURNING upgrade_generation`
          );
          return { upgradeGeneration: res.rows[0]!.upgrade_generation };
        }
      );
      reply.status(200).send(view);
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/instance/stack/diagnostics",
    schema: { response: { 200: StackDiagnosticsSchema, 401: ProblemSchema, 403: ProblemSchema } },
    config: {
      openapi: {
        operationId: "getStackDiagnostics",
        summary:
          "Download the Standard Stack support bundle: the read model plus the controller's evidence per backend (instance-operator role or operator credential; audited)",
        tags: ["stack"]
      }
    },
    handler: async (request, reply) => {
      const actor = await requireInstanceAuthority(deps, request, "the stack diagnostics");
      // A READ, audited anyway: it hands out the controller's evidence about every backend.
      const rows = await withOperatorTx(deps.config, SURFACE, async (client) => {
        const r = await readStackOnClient(client);
        await appendInstanceAudit(client, {
          action: "stack.diagnostics.read",
          actor,
          subject: null,
          detail: {},
          requestId: request.id
        });
        return r;
      });
      const byName = new Map(rows.backends.map((r) => [r.backend, r]));
      const body: StackDiagnostics = {
        generatedAt: new Date().toISOString(),
        stack: stackViewOf(rows),
        backends: StackBackendSchema.options.map((backend) => ({
          backend,
          detail: parseDetail(byName.get(backend)?.detail)
        }))
      };
      reply.status(200).send(body);
    }
  });

  // ---- The controller's two doors ------------------------------------------------------------

  typed.route({
    method: "GET",
    url: "/api/v1/instance/stack/spec",
    schema: { response: { 200: StackSpecDocumentSchema, 401: ProblemSchema, 403: ProblemSchema } },
    config: {
      openapi: {
        operationId: "getStackSpec",
        summary:
          "The stack controller's input: every backend's enabled flag, sizing tier and purge generation, the update settings, and its own state hashes — enumerated values only (the controller's credential, or instance authority; ADR-0058)",
        tags: ["stack"]
      }
    },
    handler: async (request, reply) => {
      // The controller reads it; so may an instance operator (it is what they declared).
      const presented = request.headers["x-scp-operator-token"];
      const controller =
        typeof presented === "string" &&
        (await verifyOperatorCredential(deps.db, presented))?.scope === "stack-controller";
      if (!controller) await requireInstanceAuthority(deps, request, SURFACE);
      reply.status(200).send(stackSpecOf(await readStackUnscoped(deps)));
    }
  });

  typed.route({
    method: "PUT",
    url: "/api/v1/instance/stack/status",
    schema: {
      body: PutStackStatusRequestSchema,
      response: { 204: z.undefined(), 400: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "putStackStatus",
        summary:
          "The stack controller's report: per-backend phase, running and target version, last error, needs and state hashes, plus its heartbeat (the stack controller's credential ONLY; ADR-0058)",
        tags: ["stack"]
      }
    },
    handler: async (request, reply) => {
      const controllerActor = await requireStackControllerCredential(deps, request);
      const body = request.body;
      const names = body.backends.map((b) => b.backend);
      if (new Set(names).size !== names.length) {
        throw badRequest("each backend may appear at most once in a status report");
      }
      await withOperatorTx(deps.config, SURFACE, async (client) => {
        await client.query(
          `INSERT INTO stack_settings
             (id, controller_release, controller_observed_upgrade_generation, controller_seen_at)
             VALUES ('instance', $1, $2, now())
           ON CONFLICT (id) DO UPDATE SET
             controller_release                     = EXCLUDED.controller_release,
             controller_observed_upgrade_generation = EXCLUDED.controller_observed_upgrade_generation,
             controller_seen_at                     = now()`,
          [body.release, body.observedUpgradeGeneration]
        );
        for (const b of body.backends) {
          // Status columns ONLY. A report can never change what is desired.
          await client.query(
            `INSERT INTO stack_backends
               (backend, phase, running_version, target_version, last_error, needs, detail,
                last_good_sha256, inventory_sha256, status_observed_at)
               VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, now())
             ON CONFLICT (backend) DO UPDATE SET
               phase              = EXCLUDED.phase,
               running_version    = EXCLUDED.running_version,
               target_version     = EXCLUDED.target_version,
               last_error         = EXCLUDED.last_error,
               needs              = EXCLUDED.needs,
               detail             = EXCLUDED.detail,
               last_good_sha256   = EXCLUDED.last_good_sha256,
               inventory_sha256   = EXCLUDED.inventory_sha256,
               status_observed_at = now()`,
            [
              b.backend,
              b.phase,
              b.runningVersion,
              b.targetVersion,
              b.lastError,
              JSON.stringify(b.needs),
              JSON.stringify(b.detail),
              b.lastGoodSha256,
              b.inventorySha256
            ]
          );
        }
      });
      // M29.2: converge the registrations on the controller's heartbeat, so an org served (or a
      // registration object lost) between hand-offs is repaired within a tick. Debounced: the
      // controller reports after every backend, and once a minute is plenty for convergence.
      await convergeRegistrations(deps, request.id, controllerActor);
      reply.status(204).send();
    }
  });

  // ---- M29.2: wiring (ADR-0061) --------------------------------------------------------------

  typed.route({
    method: "PUT",
    url: "/api/v1/instance/stack/backends/:backend/wiring",
    schema: {
      params: StackBackendParamSchema,
      body: PutStackWiringRequestSchema,
      response: { 204: z.undefined(), 400: ProblemSchema, 403: ProblemSchema, 409: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "putStackWiring",
        summary:
          "The stack controller's hand-off after a backend is healthy: its in-cluster endpoint, the CA that endpoint chains to, the scoped account and the token just minted there. scpd keeps the token encrypted at the instance tier and registers the execution system in every organization the stack serves (the stack controller's credential ONLY; audited; ADR-0061)",
        tags: ["stack"]
      }
    },
    handler: async (request, reply) => {
      const actor = await requireStackControllerCredential(deps, request);
      const { backend } = request.params;
      if (!isWireableBackend(backend)) {
        throw badRequest(
          `${backend} is not wired into SCP: SCP reads rollout state through Argo CD and never calls it (ADR-0008 §3)`
        );
      }
      validateWiring(backend, request.body);
      await withOperatorTx(deps.config, SURFACE, async (client) => {
        const row = await client.query<{ enabled: boolean }>(
          "SELECT enabled FROM stack_backends WHERE backend = $1 FOR SHARE",
          [backend]
        );
        // The spec is the authority: a hand-off for a backend an operator has since disabled is
        // refused, and the controller unwires it on its next tick.
        if (!row.rows[0]?.enabled) throw conflict(`${backend} is not enabled`);
        await storeWiring(client, {
          backend,
          body: request.body,
          masterKey: deps.config.secretsMasterKey,
          actor,
          requestId: request.id,
          bootstrapOrgName: deps.config.bootstrapOrgName
        });
      });
      // The hand-off SUCCEEDED once the token is stored: the controller revokes the old token on
      // this 204, so registering (a separate, per-org step) must not be able to turn it into an
      // error. What did not converge is logged and retried on the next status report.
      await convergeAfterCommit(deps, request.id, actor);
      reply.status(204).send();
    }
  });

  typed.route({
    method: "DELETE",
    url: "/api/v1/instance/stack/backends/:backend/wiring",
    schema: {
      params: StackBackendParamSchema,
      response: { 204: z.undefined(), 403: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "deleteStackWiring",
        summary:
          "The stack controller unwires a backend it is disabling: its token and wiring are dropped, and every registration of it refuses to resolve until it is wired again (the stack controller's credential ONLY; audited; ADR-0061)",
        tags: ["stack"]
      }
    },
    handler: async (request, reply) => {
      const actor = await requireStackControllerCredential(deps, request);
      const { backend } = request.params;
      if (isWireableBackend(backend)) {
        await withOperatorTx(deps.config, SURFACE, (client) =>
          dropWiring(client, { backend, actor, requestId: request.id })
        );
      }
      reply.status(204).send();
    }
  });

  // ---- M29.3: canary authoring (ADR-0062) -------------------------------------------------------

  typed.route({
    method: "PUT",
    url: "/api/v1/instance/stack/authoring",
    schema: {
      body: PutStackAuthoringRequestSchema,
      response: { 204: z.undefined(), 400: ProblemSchema, 403: ProblemSchema, 409: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "putStackAuthoring",
        summary:
          "The stack controller's canary-authoring hand-off, once Argo CD, Gitea and Argo Rollouts are ready: the carrier chart's commit in the bundled Gitea and the registered clusters Rollouts is installed in. scpd derives the registered Argo CD's authoring from these and release constants (the stack controller's credential ONLY; audited; ADR-0062)",
        tags: ["stack"]
      }
    },
    handler: async (request, reply) => {
      const actor = await requireStackControllerCredential(deps, request);
      await withOperatorTx(deps.config, SURFACE, (client) =>
        storeAuthoring(client, { body: request.body, actor, requestId: request.id })
      );
      reply.status(204).send();
    }
  });

  typed.route({
    method: "DELETE",
    url: "/api/v1/instance/stack/authoring",
    schema: { response: { 204: z.undefined(), 403: ProblemSchema } },
    config: {
      openapi: {
        operationId: "deleteStackAuthoring",
        summary:
          "The stack controller withdraws canary authoring (Argo Rollouts disabled, or a backend it needs is gone): from then on a component asking for a canary is refused with a Decision (the stack controller's credential ONLY; audited; ADR-0062)",
        tags: ["stack"]
      }
    },
    handler: async (request, reply) => {
      const actor = await requireStackControllerCredential(deps, request);
      await withOperatorTx(deps.config, SURFACE, (client) =>
        withdrawAuthoring(client, {
          actor,
          requestId: request.id,
          reason: "withdrawn by the stack controller"
        })
      );
      reply.status(204).send();
    }
  });

  typed.route({
    method: "POST",
    url: "/api/v1/instance/stack/backends/:backend/rotate",
    schema: { params: StackBackendParamSchema, response: changeResponses },
    config: {
      openapi: {
        operationId: "rotateStackBackend",
        summary:
          "Rotate a wired backend's credentials: the stack controller mints a new scoped token (and, for Argo Workflows, a new server certificate), hands it to scpd and revokes the old one (instance-operator role or operator credential; audited; ADR-0061)",
        tags: ["stack"]
      }
    },
    handler: async (request, reply) => {
      const actor = await requireInstanceAuthority(deps, request, SURFACE);
      const { backend } = request.params;
      if (!StackWireableBackendSchema.safeParse(backend).success) {
        throw badRequest(`${backend} holds no credential SCP uses, so there is nothing to rotate`);
      }
      const view = await auditedChange(
        deps,
        request.id,
        actor,
        { action: "stack.backend.rotate", subject: backend },
        async (client) => {
          const res = await client.query<{ rotate_generation: number; enabled: boolean }>(
            `UPDATE stack_backends SET rotate_generation = rotate_generation + 1
              WHERE backend = $1 AND enabled RETURNING rotate_generation, enabled`,
            [backend]
          );
          if (!res.rows[0])
            throw conflict(`${backend} is not enabled — there is nothing to rotate`);
          return { rotateGeneration: res.rows[0].rotate_generation };
        }
      );
      reply.status(200).send(view);
    }
  });

  // ---- M29.2: the organizations the stack serves --------------------------------------------

  const orgList = async (client: pg.PoolClient): Promise<StackServedOrgList> => ({
    items: (await listServedOrgs(client)).map((r) => ({
      orgId: r.org_id,
      orgName: r.org_name,
      attachedAt: iso(r.attached_at)!,
      attachedBy: r.attached_by
    }))
  });
  const orgResponses = {
    200: StackServedOrgListSchema,
    400: ProblemSchema,
    401: ProblemSchema,
    403: ProblemSchema,
    409: ProblemSchema
  };

  typed.route({
    method: "GET",
    url: "/api/v1/instance/stack/orgs",
    schema: { response: orgResponses },
    config: {
      openapi: {
        operationId: "listStackServedOrgs",
        summary:
          "The organizations the Standard Stack serves — its wired backends are registered in each as execution systems, all driving the same scoped accounts (instance-operator role or operator credential; ADR-0061)",
        tags: ["stack"]
      }
    },
    handler: async (request, reply) => {
      await requireInstanceAuthority(deps, request, SURFACE);
      reply.status(200).send(await withOperatorTx(deps.config, SURFACE, orgList));
    }
  });

  typed.route({
    method: "PUT",
    url: "/api/v1/instance/stack/orgs/:orgId",
    schema: { params: StackOrgParamSchema, response: orgResponses },
    config: {
      openapi: {
        operationId: "attachStackServedOrg",
        summary:
          "Serve an organization with the Standard Stack: every wired backend is registered there. Until M29.6 builds per-organization isolation on the shared backends, ONE organization is served at a time — a second is refused (409); detach the served one first to move the stack. An instance decision, never an org's own (instance-operator role or operator credential; audited; ADR-0061)",
        tags: ["stack"]
      }
    },
    handler: async (request, reply) => {
      const actor = await requireInstanceAuthority(deps, request, SURFACE);
      const body = await withOperatorTx(deps.config, SURFACE, async (client) => {
        await attachServedOrg(client, {
          orgId: request.params.orgId,
          actor,
          requestId: request.id
        });
        return orgList(client);
      });
      // Attached is attached: a registration that fails to converge is logged and retried, never
      // reported as a 409 for an attach that committed.
      await convergeAfterCommit(deps, request.id, actor);
      reply.status(200).send(body);
    }
  });

  typed.route({
    method: "DELETE",
    url: "/api/v1/instance/stack/orgs/:orgId",
    schema: { params: StackOrgParamSchema, response: orgResponses },
    config: {
      openapi: {
        operationId: "detachStackServedOrg",
        summary:
          "Stop serving an organization: its registrations stay (with their bindings) but refuse to resolve, and its tenant transactions can no longer read any stack token (instance-operator role or operator credential; audited; ADR-0061)",
        tags: ["stack"]
      }
    },
    handler: async (request, reply) => {
      const actor = await requireInstanceAuthority(deps, request, SURFACE);
      const body = await withOperatorTx(deps.config, SURFACE, async (client) => {
        await detachServedOrg(client, {
          orgId: request.params.orgId,
          actor,
          requestId: request.id
        });
        return orgList(client);
      });
      reply.status(200).send(body);
    }
  });
}

/** Registration after a committed write: never throws (per-org needs are logged in the reconcile). */
async function convergeAfterCommit(
  deps: AppDeps,
  requestId: string,
  actor: InstanceActor
): Promise<void> {
  try {
    await reconcileStackRegistrations(deps, requestId, actor);
  } catch (err) {
    request_log(err);
  }
}

/** Last convergence per process — the status door's debounce (the hand-off and attach doors
 *  reconcile unconditionally). */
let lastConvergedAt = 0;
const CONVERGE_EVERY_MS = 60_000;

async function convergeRegistrations(
  deps: AppDeps,
  requestId: string,
  actor: InstanceActor
): Promise<void> {
  if (Date.now() - lastConvergedAt < CONVERGE_EVERY_MS) return;
  lastConvergedAt = Date.now();
  try {
    await reconcileStackRegistrations(deps, requestId, actor);
  } catch (err) {
    // The report itself is recorded; a registration that could not be repaired is retried next
    // time and must not turn the controller's heartbeat into an error.
    request_log(err);
  }
}

function request_log(err: unknown): void {
  console.error(
    "[stack] registration convergence failed:",
    err instanceof Error ? err.message : String(err)
  );
}
