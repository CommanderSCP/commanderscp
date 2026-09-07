/** @scp/plugin-webhook-control — the webhook-control escape hatch. See docs/plugins.md §551. */
import type {
  ControlOutcome,
  ControlOutcomeStatus,
  ControlPlugin,
  ControlRequest,
  PluginContext
} from "@scp/plugin-api";

export interface WebhookControlConfig {
  /** The org's webhook endpoint — receives `POST { changeId, controlId, context }`. */
  url: string;
  headers?: Record<string, string>;
  /** Wall-clock budget for the remote endpoint to respond. See docs/plugins.md §552. */
  timeoutMs?: number;
}

const KNOWN_STATUSES: ControlOutcomeStatus[] = [
  "pass",
  "fail",
  "warning",
  "skipped",
  "timed_out",
  "expired"
];

function isKnownStatus(value: unknown): value is ControlOutcomeStatus {
  return typeof value === "string" && (KNOWN_STATUSES as string[]).includes(value);
}

function timeout(ms: number): Promise<"timeout"> {
  return new Promise((resolve) => setTimeout(() => resolve("timeout"), ms));
}

export function createWebhookControlPlugin(): ControlPlugin {
  return {
    async evaluate(ctx: PluginContext, req: ControlRequest): Promise<ControlOutcome> {
      const config = ctx.config as WebhookControlConfig;
      const timeoutMs = config.timeoutMs ?? 10_000;

      if (!config.url) {
        return {
          status: "fail",
          detail: "webhook-control: no 'url' configured on this binding",
          evidence: {}
        };
      }

      const call = ctx.http
        .request({
          method: "POST",
          url: config.url,
          headers: { "content-type": "application/json", ...(config.headers ?? {}) },
          body: { changeId: req.changeId, controlId: req.controlId, context: req.context }
        })
        .then((response) => ({ kind: "response" as const, response }))
        .catch((err: unknown) => ({
          kind: "error" as const,
          message: err instanceof Error ? err.message : String(err)
        }));

      const result = await Promise.race([call, timeout(timeoutMs)]);

      if (result === "timeout") {
        return {
          status: "timed_out",
          detail: `webhook-control: no response within ${timeoutMs}ms`,
          evidence: { url: config.url, timeoutMs }
        };
      }
      if (result.kind === "error") {
        return {
          status: "fail",
          detail: `webhook-control: request failed — ${result.message}`,
          evidence: { url: config.url }
        };
      }

      const { response } = result;
      if (response.status < 200 || response.status >= 300) {
        return {
          status: "fail",
          detail: `webhook-control: endpoint returned HTTP ${response.status}`,
          evidence: { url: config.url, httpStatus: response.status, body: response.body }
        };
      }

      const body = response.body as
        { status?: unknown; evidence?: unknown; detail?: unknown } | undefined;
      if (!body || !isKnownStatus(body.status)) {
        return {
          status: "fail",
          detail: "webhook-control: endpoint response did not carry a recognized 'status' field",
          evidence: { url: config.url, body }
        };
      }

      return {
        status: body.status,
        detail: typeof body.detail === "string" ? body.detail : undefined,
        evidence:
          (body.evidence && typeof body.evidence === "object"
            ? (body.evidence as Record<string, unknown>)
            : {}) ?? {}
      };
    }
  };
}
