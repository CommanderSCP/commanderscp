import type { GitProviderEventHint } from "@scp/git-provider-core";
import { githubAdapter } from "@scp/plugin-github";
import { giteaAdapter } from "@scp/plugin-gitea";
import { gitlabAdapter } from "@scp/plugin-gitlab";

/**
 * Per-`sourceKind` webhook ADAPTER REGISTRY (M15.1b — the M15.1a follow-up). Before this, the
 * server's inbound-webhook path hardcoded github in TWO places: `webhook-signature.ts`'s `VERIFIERS`
 * table imported `verifyGithubWebhookSignature` directly, and `webhook-processor.ts`'s `extractHint`
 * special-cased `sourceKind === "github"` to call `mapGithubWebhookEventToHint`. Adding a second
 * git provider (gitea) that signs differently (bare-hex `X-Gitea-Signature`, no `sha256=` prefix)
 * and names its event header differently (`X-Gitea-Event`) made that hardcoding a silent-drop hazard
 * — a gitea delivery would have been verified with the wrong scheme and its events mapped by the
 * wrong parser.
 *
 * This registry is the single seam both paths now resolve through, keyed by `sourceKind`. Each
 * entry couples a provider's `GitProviderAdapter` (the SAME object its `ExecutorPlugin` is built
 * from — `verifyWebhook` + `mapEvent` come straight off it, so the webhook path and the plugin's own
 * `observe()`/status logic can never drift) with the two server-side facts the adapter interface
 * doesn't carry: the HTTP header its signature and its event name arrive in. github resolves here
 * exactly as it did before (same verifier, same `x-hub-signature-256`/`x-github-event` headers, same
 * `mapGithubWebhookEventToHint`) — its behavior is preserved, only the wiring is centralized.
 */
export interface WebhookAdapter {
  sourceKind: string;
  /** HTTP header the provider carries its request authenticator in — an HMAC signature for
   *  github/gitea, or a PLAINTEXT shared-secret token for gitlab (`X-Gitlab-Token`). */
  signatureHeaderName: string;
  /** HTTP header the provider carries its event name in (drives `mapEvent`). */
  eventHeaderName: string;
  /** Fail-closed authentication of the delivery against the RAW request body (HMAC providers) or
   *  by plaintext-token equality (gitlab, which does not sign the body). */
  verify(rawBody: Buffer, headerValue: string | undefined, secret: string): boolean;
  /** Provider event name + payload → correlation hint (null = ignore). */
  mapEvent(eventName: string, payload: unknown): GitProviderEventHint | null;
}

const ADAPTERS: Record<string, WebhookAdapter> = {
  github: {
    sourceKind: "github",
    signatureHeaderName: "x-hub-signature-256",
    eventHeaderName: "x-github-event",
    verify: githubAdapter.verifyWebhook,
    mapEvent: githubAdapter.mapEvent
  },
  gitea: {
    sourceKind: "gitea",
    // Gitea's bare-hex signature header (NO `sha256=` prefix) — resolved to the gitea adapter's own
    // verifier, which is the ONLY one that accepts the bare-hex form.
    signatureHeaderName: "x-gitea-signature",
    eventHeaderName: "x-gitea-event",
    verify: giteaAdapter.verifyWebhook,
    mapEvent: giteaAdapter.mapEvent
  },
  gitlab: {
    sourceKind: "gitlab",
    // GitLab authenticates deliveries with a PLAINTEXT shared-secret TOKEN in `X-Gitlab-Token` — NOT
    // an HMAC over the body. Its verifier does a timing-safe plaintext equality compare, so github's
    // `sha256=<hex>` and gitea's bare-hex verifiers both reject a GitLab token (and vice-versa): the
    // registry is what keeps each provider on its OWN scheme (a miss here is a silent event drop).
    signatureHeaderName: "x-gitlab-token",
    eventHeaderName: "x-gitlab-event",
    verify: gitlabAdapter.verifyWebhook,
    mapEvent: gitlabAdapter.mapEvent
  }
};

/** The webhook adapter for a source kind, or `undefined` for a source kind with no provider-specific
 *  adapter (e.g. `terraform`/a generic first-party reporter) — callers fall back to the generic
 *  `sha256=<hex>` verifier and the flat generic hint shape. */
export function webhookAdapterForSourceKind(sourceKind: string): WebhookAdapter | undefined {
  return ADAPTERS[sourceKind];
}
