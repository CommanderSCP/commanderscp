import type { NotificationMessage } from "@scp/plugin-api";
import type { TenantTx } from "../db/tenant-tx.js";
import type { PluginHost } from "../plugin-host/contract.js";
import { resolveSecretRefs } from "../secrets/secrets-repo.js";
import {
  isKnownNotificationModule,
  listNotificationBindings,
  meetsSeverityThreshold
} from "./notification-bindings-repo.js";

/**
 * Fans `msg` out to every one of `orgId`'s configured notification channels that meets its own
 * `minSeverity` threshold (`notification_bindings`) — the concrete implementation behind the seam
 * `coordination/watchdog.ts`'s "escalation" doc comment and `governance/gate-orchestrator.ts`'s
 * freeze-block path have named as "M7" since M3/M4. Best-effort per channel: one channel's
 * misconfiguration or downstream failure is caught and logged, never allowed to propagate — a
 * notification is inherently side-channel (DESIGN §11's `DeliveryResult` already models "did it
 * send" as data, not a thrown error), and the engine action that triggered this (a watchdog flag,
 * a freeze block) must never fail BECAUSE a notification channel is down.
 */
export async function dispatchNotification(
  tx: TenantTx,
  host: PluginHost,
  orgId: string,
  masterKey: Buffer,
  msg: NotificationMessage
): Promise<void> {
  const bindings = await listNotificationBindings(tx, orgId);
  for (const binding of bindings) {
    if (!meetsSeverityThreshold(binding.minSeverity, msg.severity)) continue;
    if (!isKnownNotificationModule(binding.pluginModule)) {
      console.error(
        `[notify] org ${orgId} binding ${binding.id} references unknown plugin module '${binding.pluginModule}' — skipped`
      );
      continue;
    }
    try {
      const resolvedSecrets = await resolveSecretRefs(tx, orgId, binding.secretRefs, masterKey);
      await host.start([
        {
          id: binding.pluginInstanceId,
          module: binding.pluginModule,
          orgId,
          domainId: "default",
          config: binding.config,
          secrets: resolvedSecrets,
          allowedHosts: binding.allowedHosts
        }
      ]);
      const result = await host.notification(binding.pluginInstanceId).send(msg);
      if (!result.delivered) {
        console.error(`[notify] org ${orgId} binding ${binding.id} delivery failed: ${result.detail ?? "no detail"}`);
      }
    } catch (err) {
      console.error(`[notify] org ${orgId} binding ${binding.id} threw:`, err);
    }
  }
}
