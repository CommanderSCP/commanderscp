import type pg from "pg";
import { sql } from "drizzle-orm";
import {
  STACK_AUTHORING,
  type ArgoCdAuthoring,
  type InstanceActor,
  type PutStackAuthoringRequest,
  type StackAuthoringView
} from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { appendInstanceAudit } from "../auth/instance-authority.js";
import { conflict } from "../errors.js";
import type { Wiring } from "./wired-routing.js";

/**
 * CANARY AUTHORING WHEN THE STANDARD STACK SERVES IT (M29.3, ADR-0062).
 *
 * Once Argo CD, Gitea and Argo Rollouts are all enabled, ready and wired, the stack controller
 * pushes ADR-0055's carrier chart into a Gitea repository only it writes, creates the dedicated
 * AppProject (and its own project for the Rollouts install on every target cluster), and hands scpd
 * two facts through a door only its credential opens: the carrier COMMIT, and the clusters besides
 * in-cluster that Rollouts is healthy in. From those, and constants fixed by the release, scpd
 * derives the whole `authoring` document the deploy lane and the argocd plugin read for the
 * registered Argo CD — never from that object's properties (ADR-0061 §5: a registration's routing
 * is the wiring's), so nothing a tenant writes chooses the carrier repository, the project, the
 * destination clusters or the namespace. The repository URL comes from the Gitea WIRING, which
 * scpd already pins to Gitea's own Service.
 *
 * Withdrawn by the controller (DELETE) when Rollouts is disabled, and by scpd itself, in the same
 * transaction, whenever an operator disables Argo CD, Gitea or Argo Rollouts, or either wiring is
 * dropped — so a component asking for a canary is refused from that moment, never rolled out
 * plainly (`deploy-lane-trigger-parameters.ts`, cause `no_authoring`).
 */

/** The backends authoring needs — disabling any one of them withdraws it. */
export const AUTHORING_BACKENDS = ["argocd", "gitea", "argo-rollouts"] as const;

export interface StackAuthoringRow {
  revision: string | null;
  clusters: string[];
  factsSha256: string | null;
  configuredAt: string | null;
}

interface RawAuthoringRow extends Record<string, unknown> {
  authoring_revision: string | null;
  authoring_clusters: unknown;
  authoring_facts_sha256: string | null;
  authoring_configured_at: Date | string | null;
}

export const SELECT_AUTHORING = `SELECT authoring_revision, authoring_clusters, authoring_facts_sha256,
                                        authoring_configured_at
                                   FROM stack_settings WHERE id = 'instance'`;

export function authoringRowOf(raw: RawAuthoringRow | undefined): StackAuthoringRow {
  const clusters = Array.isArray(raw?.authoring_clusters)
    ? raw.authoring_clusters.filter((c): c is string => typeof c === "string")
    : [];
  const at = raw?.authoring_configured_at ?? null;
  return {
    revision: raw?.authoring_revision ?? null,
    clusters,
    factsSha256: raw?.authoring_facts_sha256 ?? null,
    configuredAt: at === null ? null : (at instanceof Date ? at : new Date(at)).toISOString()
  };
}

/** The carrier's repository — Gitea's wired endpoint and the release's fixed path, nothing else. */
export function carrierRepoUrl(giteaServerUrl: string): string {
  return `${giteaServerUrl.replace(/\/+$/, "")}/${STACK_AUTHORING.giteaOrg}/${STACK_AUTHORING.giteaRepo}.git`;
}

/** The `authoring` document for the registered Argo CD, or null when authoring is not configured
 *  (no hand-off, or Gitea is not wired). */
export function stackAuthoringDocument(
  row: StackAuthoringRow,
  wirings: Wiring[]
): ArgoCdAuthoring | null {
  if (!row.revision) return null;
  const gitea = wirings.find((w) => w.backend === "gitea");
  const argocd = wirings.find((w) => w.backend === "argocd");
  if (!gitea?.serverUrl || !argocd?.serverUrl) return null;
  return {
    repoURL: carrierRepoUrl(gitea.serverUrl),
    path: STACK_AUTHORING.carrierPath,
    targetRevision: row.revision,
    project: STACK_AUTHORING.project,
    namespaces: [STACK_AUTHORING.namespace],
    ...(row.clusters.length > 0 ? { clusters: [...row.clusters] } : {})
  };
}

export async function readStackAuthoringAsTenant(tx: TenantTx): Promise<StackAuthoringRow> {
  const res = await tx.execute(sql.raw(SELECT_AUTHORING));
  return authoringRowOf(res.rows[0] as RawAuthoringRow | undefined);
}

export function stackAuthoringView(row: StackAuthoringRow, wirings: Wiring[]): StackAuthoringView {
  const configured = stackAuthoringDocument(row, wirings) !== null;
  return {
    configured,
    project: STACK_AUTHORING.project,
    namespace: STACK_AUTHORING.namespace,
    carrierRevision: configured ? row.revision : null,
    clusters: configured ? row.clusters : [],
    configuredAt: configured ? row.configuredAt : null
  };
}

export async function readStackAuthoringOnClient(
  client: pg.PoolClient
): Promise<StackAuthoringRow> {
  const res = await client.query<RawAuthoringRow>(SELECT_AUTHORING);
  return authoringRowOf(res.rows[0]);
}

/** Persists the controller's hand-off, with its audit link — one operator tx. */
export async function storeAuthoring(
  client: pg.PoolClient,
  input: { body: PutStackAuthoringRequest; actor: InstanceActor; requestId: string }
): Promise<void> {
  const enabled = await client.query<{ backend: string }>(
    `SELECT backend FROM stack_backends WHERE enabled AND backend = ANY($1::text[]) FOR SHARE`,
    [[...AUTHORING_BACKENDS]]
  );
  const on = new Set(enabled.rows.map((r) => r.backend));
  const missing = AUTHORING_BACKENDS.filter((b) => !on.has(b));
  if (missing.length > 0) {
    // The spec is the authority: a hand-off racing an operator's disable is refused, and the
    // controller withdraws on its next tick.
    throw conflict(`canary authoring needs ${missing.join(", ")} enabled`);
  }
  const wired = await client.query<{ backend: string }>(
    `SELECT backend FROM stack_backend_wirings WHERE backend IN ('argocd', 'gitea')`
  );
  if (wired.rows.length < 2) {
    throw conflict("canary authoring needs Argo CD and Gitea wired into SCP first");
  }
  const before = await readStackAuthoringOnClient(client);
  const clusters = [...new Set(input.body.clusters)].sort();
  await client.query(
    `INSERT INTO stack_settings (id, authoring_revision, authoring_clusters, authoring_facts_sha256,
                                 authoring_configured_at)
       VALUES ('instance', $1, $2::jsonb, $3, now())
     ON CONFLICT (id) DO UPDATE SET
       authoring_revision = EXCLUDED.authoring_revision,
       authoring_clusters = EXCLUDED.authoring_clusters,
       authoring_facts_sha256 = EXCLUDED.authoring_facts_sha256,
       authoring_configured_at = now()`,
    [input.body.carrierRevision, JSON.stringify(clusters), input.body.factsSha256]
  );
  await appendInstanceAudit(client, {
    action: "stack.authoring.configure",
    actor: input.actor,
    subject: "argocd",
    detail: {
      before: before.revision ? { revision: before.revision, clusters: before.clusters } : null,
      after: { revision: input.body.carrierRevision, clusters }
    },
    requestId: input.requestId
  });
}

/** Withdraws authoring (the controller's DELETE, or an operator disabling a backend it needs).
 *  Audited only when something was configured. */
export async function withdrawAuthoring(
  client: pg.PoolClient,
  input: { actor: InstanceActor; requestId: string; reason: string }
): Promise<boolean> {
  const res = await client.query(
    `UPDATE stack_settings SET authoring_revision = NULL, authoring_clusters = '[]'::jsonb,
            authoring_facts_sha256 = NULL, authoring_configured_at = NULL
      WHERE id = 'instance' AND authoring_revision IS NOT NULL`
  );
  const withdrawn = (res.rowCount ?? 0) > 0;
  if (withdrawn) {
    await appendInstanceAudit(client, {
      action: "stack.authoring.withdraw",
      actor: input.actor,
      subject: "argocd",
      detail: { reason: input.reason },
      requestId: input.requestId
    });
  }
  return withdrawn;
}
