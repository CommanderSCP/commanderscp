import type {
  DeliveryResult,
  NotificationMessage,
  NotificationPlugin,
  PluginContext,
  PluginManifest
} from "@scp/plugin-api";

/**
 * `@scp/plugin-webhook-notify` — the generic `NotificationPlugin` escape hatch (M7,
 * BUILD_AND_TEST.md §8 M7 item 4), the notification-side sibling of `@scp/plugin-webhook-control`
 * (M4's generic `ControlPlugin` escape hatch — same shape, same reasoning): POST the message to a
 * configured URL, treat any non-2xx or a timeout as a failed delivery, never throw for a
 * downstream failure (a bad webhook target must never crash the caller — the watchdog sweep and
 * governance gate-block seams that call `send()` treat notification delivery as best-effort).
 */

export interface WebhookNotifyConfig {
  url: string;
  /** ms before an unresponsive endpoint is treated as a failed delivery. Default 10s (matches
   *  `webhook-control`'s own default — same escape-hatch shape, same timeout posture). */
  timeoutMs?: number;
  /** Extra headers to send with every delivery — non-secret routing metadata only. A header that
   *  needs a real credential (e.g. `Authorization`) should be resolved by the binding's
   *  `secretRefs` and merged in server-side before this plugin ever sees it — this v1 escape hatch
   *  does no template interpolation of its own. */
  headers?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 10_000;

function asConfig(config: unknown): WebhookNotifyConfig {
  const c = config as Partial<WebhookNotifyConfig> | undefined;
  if (!c?.url) {
    throw new Error("webhook-notify: config.url is required");
  }
  return { url: c.url, timeoutMs: c.timeoutMs, headers: c.headers };
}

async function send(ctx: PluginContext, msg: NotificationMessage): Promise<DeliveryResult> {
  const config = asConfig(ctx.config);
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const timeoutPromise = new Promise<DeliveryResult>((resolve) => {
    setTimeout(
      () => resolve({ delivered: false, detail: `webhook-notify: timed out after ${timeoutMs}ms` }),
      timeoutMs
    );
  });

  const requestPromise = (async (): Promise<DeliveryResult> => {
    try {
      const response = await ctx.http.request({
        method: "POST",
        url: config.url,
        headers: { "content-type": "application/json", ...(config.headers ?? {}) },
        body: {
          subject: msg.subject,
          body: msg.body,
          severity: msg.severity,
          context: msg.context ?? {}
        }
      });
      if (response.status >= 200 && response.status < 300) {
        return { delivered: true };
      }
      return {
        delivered: false,
        detail: `webhook-notify: endpoint returned HTTP ${response.status}`
      };
    } catch (err) {
      return {
        delivered: false,
        detail: `webhook-notify: request failed — ${err instanceof Error ? err.message : String(err)}`
      };
    }
  })();

  return Promise.race([requestPromise, timeoutPromise]);
}

export const webhookNotifyPlugin: NotificationPlugin = { send };

export function createWebhookNotifyPlugin(): NotificationPlugin {
  return webhookNotifyPlugin;
}

export const manifest: PluginManifest = {
  id: "webhook-notify",
  kind: "notification",
  version: "0.1.0",
  configSchema: {
    type: "object",
    required: ["url"],
    properties: {
      url: { type: "string", format: "uri" },
      timeoutMs: { type: "integer", minimum: 100, default: 10_000 },
      headers: { type: "object", additionalProperties: { type: "string" } }
    }
  }
};

export default webhookNotifyPlugin;
