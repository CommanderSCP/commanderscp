import { sql } from "drizzle-orm";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  ProblemSchema,
  PutStackBackendRequestSchema,
  PutStackSettingsRequestSchema,
  PutStackStatusRequestSchema,
  STACK_CONTROLLER_STALE_AFTER_MS,
  StackBackendParamSchema,
  StackBackendSchema,
  StackDiagnosticsSchema,
  StackNeedSchema,
  StackSizeTierSchema,
  StackSpecDocumentSchema,
  StackUpdatePolicySchema,
  StackBackendPhaseSchema,
  StackViewSchema,
  type StackBackendView,
  type StackDiagnostics,
  type StackNeed,
  type StackSpecDocument,
  type StackView
} from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { requireInstanceOperator } from "../auth/operator-auth.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { badRequest } from "../errors.js";
import { withOperatorDb } from "./operator-db.js";

/**
 * THE STANDARD STACK's API (M29.4, ADR-0058). Two audiences, two kinds of door:
 *
 * - People read the stack with their ordinary session (tenant-read, like scanner assignments) and
 *   change it with an operator credential on top of it: enabling a backend installs cluster-scoped
 *   software for every org on the deployment, which no tenant role can grant.
 * - The stack controller is not a member of any org. It authenticates with its install-time
 *   operator credential ALONE, and uses exactly two doors: read the spec, write the status.
 *
 * Every write goes through the operator connection; `scp_app` holds SELECT only (drizzle/0126).
 */

interface BackendRow extends Record<string, unknown> {
  backend: string;
  enabled: boolean;
  size_tier: string;
  phase: string | null;
  running_version: string | null;
  target_version: string | null;
  last_error: string | null;
  needs: unknown;
  detail: unknown;
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

/** Every backend, always — an absent row is the never-configured default. */
function backendViews(rows: BackendRow[]): StackBackendView[] {
  const byName = new Map(rows.map((r) => [r.backend, r]));
  return StackBackendSchema.options.map((backend) => {
    const row = byName.get(backend);
    const tier = StackSizeTierSchema.safeParse(row?.size_tier);
    const phase = StackBackendPhaseSchema.safeParse(row?.phase);
    return {
      backend,
      enabled: row?.enabled === true,
      sizeTier: tier.success ? tier.data : "small",
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
  const seen = rows.settings?.controller_seen_at ?? null;
  const seenAt = iso(seen);
  return {
    settings: settingsOf(rows.settings),
    controller: {
      release: rows.settings?.controller_release ?? null,
      lastSeenAt: seenAt,
      reporting:
        seenAt !== null && now.getTime() - Date.parse(seenAt) <= STACK_CONTROLLER_STALE_AFTER_MS,
      observedUpgradeGeneration: rows.settings?.controller_observed_upgrade_generation ?? null
    },
    backends: backendViews(rows.backends)
  };
}

/** The controller's input. Only enabled / sizeTier / the two settings — see stack-spec-census. */
export function stackSpecOf(rows: StackRows): StackSpecDocument {
  return {
    settings: settingsOf(rows.settings),
    backends: backendViews(rows.backends).map(({ backend, enabled, sizeTier }) => ({
      backend,
      enabled,
      sizeTier
    }))
  };
}

type Executor = (query: ReturnType<typeof sql>) => Promise<Record<string, unknown>[]>;

async function readStackRows(exec: Executor): Promise<StackRows> {
  const backends = (await exec(sql`
    SELECT backend, enabled, size_tier, phase, running_version, target_version, last_error,
           needs, detail, status_observed_at
      FROM stack_backends`)) as BackendRow[];
  const settings = (await exec(sql`
    SELECT update_policy, upgrade_generation, controller_release,
           controller_observed_upgrade_generation, controller_seen_at
      FROM stack_settings WHERE id = 'instance'`)) as SettingsRow[];
  return { backends, settings: settings[0] };
}

/** Reads through the request-serving pool. The tables' `tenant_read` policy is `USING (true)`
 *  (instance-wide rows, no per-tenant data), so no org context is needed — which is what lets the
 *  controller, a member of no org, read the spec without a privileged connection. */
async function readStackUnscoped(deps: AppDeps): Promise<StackRows> {
  return readStackRows(async (q) => (await deps.db.execute(q)).rows);
}

async function readStackAsTenant(deps: AppDeps, orgId: string): Promise<StackRows> {
  return withTenantTx(deps.db, orgId, (tx) =>
    readStackRows(async (q) => (await tx.execute(q)).rows)
  );
}

const SURFACE = "the Standard Stack";

export function registerStackRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

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
      response: { 200: StackViewSchema, 400: ProblemSchema, 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "putStackBackend",
        summary:
          "Enable or disable one Standard Stack backend, and set its sizing tier (operator credential required — the stack controller installs or removes it for every org on the deployment)",
        tags: ["stack"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      await requireInstanceOperator(deps, request, SURFACE);
      const { backend } = request.params;
      const { enabled, sizeTier } = request.body;
      await withOperatorDb(deps.config, SURFACE, (client) =>
        client.query(
          `INSERT INTO stack_backends (backend, enabled, size_tier, spec_updated_at)
             VALUES ($1, $2, COALESCE($3, 'small'), now())
           ON CONFLICT (backend) DO UPDATE SET
             enabled         = EXCLUDED.enabled,
             size_tier       = COALESCE($3, stack_backends.size_tier),
             spec_updated_at = now()`,
          [backend, enabled, sizeTier ?? null]
        )
      );
      reply.status(200).send(stackViewOf(await readStackAsTenant(deps, auth.orgId)));
    }
  });

  typed.route({
    method: "PUT",
    url: "/api/v1/instance/stack/settings",
    schema: {
      body: PutStackSettingsRequestSchema,
      response: { 200: StackViewSchema, 400: ProblemSchema, 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "putStackSettings",
        summary:
          "Set whether a new SCP release's stack versions roll out automatically or wait for an upgrade request (operator credential required)",
        tags: ["stack"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      await requireInstanceOperator(deps, request, SURFACE);
      await withOperatorDb(deps.config, SURFACE, (client) =>
        client.query(
          `INSERT INTO stack_settings (id, update_policy, updated_at) VALUES ('instance', $1, now())
           ON CONFLICT (id) DO UPDATE SET update_policy = EXCLUDED.update_policy, updated_at = now()`,
          [request.body.updatePolicy]
        )
      );
      reply.status(200).send(stackViewOf(await readStackAsTenant(deps, auth.orgId)));
    }
  });

  typed.route({
    method: "POST",
    url: "/api/v1/instance/stack/upgrade",
    schema: {
      response: { 200: StackViewSchema, 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "requestStackUpgrade",
        summary:
          "Ask the stack controller to roll every enabled backend onto the versions this SCP release carries — approves a held upgrade, or retries one that was rolled back (operator credential required)",
        tags: ["stack"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      await requireInstanceOperator(deps, request, SURFACE);
      await withOperatorDb(deps.config, SURFACE, (client) =>
        client.query(
          `INSERT INTO stack_settings (id, upgrade_generation, updated_at) VALUES ('instance', 1, now())
           ON CONFLICT (id) DO UPDATE SET
             upgrade_generation = stack_settings.upgrade_generation + 1,
             updated_at         = now()`
        )
      );
      reply.status(200).send(stackViewOf(await readStackAsTenant(deps, auth.orgId)));
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
          "Download the Standard Stack support bundle: the read model plus the controller's evidence per backend (operator credential required)",
        tags: ["stack"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      await requireInstanceOperator(deps, request, SURFACE);
      const rows = await readStackAsTenant(deps, auth.orgId);
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

  // ---- The controller's two doors: operator credential ALONE ----------------------------------

  typed.route({
    method: "GET",
    url: "/api/v1/instance/stack/spec",
    schema: { response: { 200: StackSpecDocumentSchema, 403: ProblemSchema } },
    config: {
      openapi: {
        operationId: "getStackSpec",
        summary:
          "The stack controller's input: every backend's enabled flag and sizing tier, and the update settings — enumerated values only (operator credential required; ADR-0058)",
        tags: ["stack"]
      }
    },
    handler: async (request, reply) => {
      await requireInstanceOperator(deps, request, SURFACE);
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
          "The stack controller's report: per-backend phase, running and target version, last error and needs, plus its heartbeat (operator credential required; ADR-0058)",
        tags: ["stack"]
      }
    },
    handler: async (request, reply) => {
      await requireInstanceOperator(deps, request, SURFACE);
      const body = request.body;
      const names = body.backends.map((b) => b.backend);
      if (new Set(names).size !== names.length) {
        throw badRequest("each backend may appear at most once in a status report");
      }
      await withOperatorDb(deps.config, SURFACE, async (client) => {
        await client.query("BEGIN");
        try {
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
            // Status columns ONLY. A report can never change what is desired: the spec columns are
            // left to their defaults on a first insert and untouched on conflict.
            await client.query(
              `INSERT INTO stack_backends
                 (backend, phase, running_version, target_version, last_error, needs, detail,
                  status_observed_at)
                 VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, now())
               ON CONFLICT (backend) DO UPDATE SET
                 phase              = EXCLUDED.phase,
                 running_version    = EXCLUDED.running_version,
                 target_version     = EXCLUDED.target_version,
                 last_error         = EXCLUDED.last_error,
                 needs              = EXCLUDED.needs,
                 detail             = EXCLUDED.detail,
                 status_observed_at = now()`,
              [
                b.backend,
                b.phase,
                b.runningVersion,
                b.targetVersion,
                b.lastError,
                JSON.stringify(b.needs),
                JSON.stringify(b.detail)
              ]
            );
          }
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw err;
        }
      });
      reply.status(204).send();
    }
  });
}
