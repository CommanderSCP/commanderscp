import type { GitProviderEventHint } from "@scp/git-provider-core";
import { githubAdapter } from "@scp/plugin-github";
import { giteaAdapter } from "@scp/plugin-gitea";
import { gitlabAdapter } from "@scp/plugin-gitlab";
import { harborWebhookSource } from "@scp/plugin-harbor";

/** Per-`sourceKind` webhook ADAPTER REGISTRY. See docs/coordination.md §1073. */
export interface WebhookAdapter {
  sourceKind: string;
  /** The header a provider carries its authenticator in. See docs/coordination.md §1074. */
  signatureHeaderName?: string;
  /** HTTP header the provider carries its event name in (drives `mapEvent`). OPTIONAL: an adapter
   *  that carries its event type in the BODY (harbor's `payload.type`, M15.3c) declares none, and
   *  `extractHint` (webhook-processor.ts) derives the event name from the body instead. */
  eventHeaderName?: string;
  /** Fail-closed authentication of the delivery against the RAW request body (HMAC providers) or
   *  by plaintext-token equality (gitlab, which does not sign the body). OPTIONAL: a `Bearer`-PAT-
   *  authed webhook-source (harbor) ships none — see `signatureHeaderName`. */
  verify?(rawBody: Buffer, headerValue: string | undefined, secret: string): boolean;
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
  },
  // Harbor as a WEBHOOK CHANGE-SOURCE. See docs/coordination.md §1075.
  harbor: {
    sourceKind: harborWebhookSource.sourceKind,
    mapEvent: harborWebhookSource.mapEvent
  }
};

/** The webhook adapter for a source kind, or `undefined` for a source kind with no provider-specific
 *  adapter (e.g. `terraform`/a generic first-party reporter) — callers fall back to the generic
 *  `sha256=<hex>` verifier and the flat generic hint shape. */
export function webhookAdapterForSourceKind(sourceKind: string): WebhookAdapter | undefined {
  return ADAPTERS[sourceKind];
}
