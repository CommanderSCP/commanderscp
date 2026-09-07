import type { NotificationMessage } from "@scp/plugin-api";
import type { TenantTx } from "../db/tenant-tx.js";
import type { PluginHost } from "../plugin-host/contract.js";
import { resolveSecretRefs } from "../secrets/secrets-repo.js";
import {
  isKnownNotificationModule,
  listNotificationBindings,
  meetsSeverityThreshold
} from "./notification-bindings-repo.js";

/** Fans a message to every channel meeting its own minSeverity. See docs/notify.md §1. */
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
          scopeKey: "default",
          config: binding.config,
          secrets: resolvedSecrets,
          allowedHosts: binding.allowedHosts
        }
      ]);
      const result = await host.notification(binding.pluginInstanceId).send(msg);
      if (!result.delivered) {
        console.error(
          `[notify] org ${orgId} binding ${binding.id} delivery failed: ${result.detail ?? "no detail"}`
        );
      }
    } catch (err) {
      console.error(`[notify] org ${orgId} binding ${binding.id} threw:`, err);
    }
  }
}
