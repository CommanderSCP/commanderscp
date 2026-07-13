import { and, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { TenantTx } from "../db/tenant-tx.js";
import { notificationBindings } from "../db/schema.js";
import type { PluginModule } from "../plugin-host/contract.js";
import { assertNotReservedInstanceId } from "../coordination/executor-bindings-repo.js";

/**
 * `notification_bindings` (DESIGN §11 `NotificationPlugin`, BUILD_AND_TEST.md §8 M7 item 4) — an
 * org's configured notification channels. Unlike `executor_bindings`/`control_bindings` (1:1
 * binding per graph object), this is a plain org-scoped LIST: an org may wire up more than one
 * channel (e.g. a webhook AND an SMTP relay), and every configured channel receives every
 * dispatched message independently (`notify/dispatch.ts`).
 */

export type NotificationSeverity = "info" | "warning" | "critical";
const SEVERITY_RANK: Record<NotificationSeverity, number> = { info: 0, warning: 1, critical: 2 };

export function meetsSeverityThreshold(minSeverity: NotificationSeverity, actual: NotificationSeverity): boolean {
  return SEVERITY_RANK[actual] >= SEVERITY_RANK[minSeverity];
}

export interface NotificationBindingRow {
  id: string;
  orgId: string;
  pluginModule: string;
  pluginInstanceId: string;
  config: unknown;
  secretRefs: Record<string, string>;
  allowedHosts: string[];
  minSeverity: NotificationSeverity;
}

function toRow(row: {
  id: string;
  orgId: string;
  pluginModule: string;
  pluginInstanceId: string;
  config: unknown;
  secretRefs: unknown;
  allowedHosts: unknown;
  minSeverity: string;
}): NotificationBindingRow {
  return {
    id: row.id,
    orgId: row.orgId,
    pluginModule: row.pluginModule,
    pluginInstanceId: row.pluginInstanceId,
    config: row.config,
    secretRefs: (row.secretRefs ?? {}) as Record<string, string>,
    allowedHosts: (row.allowedHosts ?? []) as string[],
    minSeverity: (row.minSeverity as NotificationSeverity) ?? "info"
  };
}

export async function listNotificationBindings(tx: TenantTx, orgId: string): Promise<NotificationBindingRow[]> {
  const rows = await tx.select().from(notificationBindings).where(eq(notificationBindings.orgId, orgId));
  return rows.map(toRow);
}

export interface UpsertNotificationBindingInput {
  orgId: string;
  pluginModule: string;
  pluginInstanceId: string;
  config?: unknown;
  secretRefs?: Record<string, string>;
  allowedHosts?: string[];
  minSeverity?: NotificationSeverity;
}

/** Upserts by `(orgId, pluginInstanceId)` (the table's own unique index) — calling this again with
 *  the same instance id updates that channel's config in place rather than adding a duplicate. */
export async function upsertNotificationBinding(
  tx: TenantTx,
  input: UpsertNotificationBindingInput
): Promise<NotificationBindingRow> {
  // Notification instance ids are caller-supplied (the route takes `:instanceId` straight from the
  // URL) and share ONE flat PluginHost keyspace with executor/control instances — so they must not
  // squat the reserved `execution-system:<id>` namespace, which would silently re-point a real
  // execution-system's coordination traffic (host.start() skips an already-registered id).
  assertNotReservedInstanceId(input.pluginInstanceId);
  const rows = await tx
    .select({ id: notificationBindings.id })
    .from(notificationBindings)
    .where(eq(notificationBindings.pluginInstanceId, input.pluginInstanceId))
    .limit(1);

  if (rows[0]) {
    const [row] = await tx
      .update(notificationBindings)
      .set({
        pluginModule: input.pluginModule,
        config: input.config ?? {},
        secretRefs: input.secretRefs ?? {},
        allowedHosts: input.allowedHosts ?? [],
        minSeverity: input.minSeverity ?? "info",
        updatedAt: new Date()
      })
      .where(eq(notificationBindings.id, rows[0].id))
      .returning();
    return toRow(row!);
  }
  const [row] = await tx
    .insert(notificationBindings)
    .values({
      id: uuidv7(),
      orgId: input.orgId,
      pluginModule: input.pluginModule,
      pluginInstanceId: input.pluginInstanceId,
      config: input.config ?? {},
      secretRefs: input.secretRefs ?? {},
      allowedHosts: input.allowedHosts ?? [],
      minSeverity: input.minSeverity ?? "info"
    })
    .returning();
  return toRow(row!);
}

export async function deleteNotificationBinding(tx: TenantTx, orgId: string, pluginInstanceId: string): Promise<void> {
  await tx
    .delete(notificationBindings)
    .where(and(eq(notificationBindings.pluginInstanceId, pluginInstanceId), eq(notificationBindings.orgId, orgId)));
}

/** Same allowlist discipline as `executor-bindings-repo.ts`'s `KNOWN_EXECUTOR_MODULES` — a free-form
 *  DB column must never reach `host.start()` unchecked. */
export const KNOWN_NOTIFICATION_MODULES: PluginModule[] = ["webhook-notify", "smtp-notify"];

export function isKnownNotificationModule(value: string): value is PluginModule {
  return (KNOWN_NOTIFICATION_MODULES as string[]).includes(value);
}
