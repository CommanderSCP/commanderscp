import type { GitProviderEventHint } from "@scp/git-provider-core";

/** Harbor as a webhook change-source, not an executor. See docs/plugins.md §242. */

/** Harbor's documented `PUSH_ARTIFACT` webhook payload (the subset this mapper reads). A push emits
 *  one artifact event carrying the pushed digest + tag and the repository's `project/repo`
 *  full name — the two facts correlation needs (`repo` → `source_mappings.repoPattern`, `digest` →
 *  the change's `sourceRef.artifact_digest`, the connective tissue the M17.1 scan gate binds to). */
interface HarborWebhookPayload {
  /** Harbor event type: `PUSH_ARTIFACT` (image push), `SCANNING_COMPLETED`, `DELETE_ARTIFACT`, … */
  type?: string;
  event_data?: {
    resources?: Array<{
      digest?: string;
      tag?: string;
      resource_url?: string;
    }>;
    repository?: {
      name?: string;
      namespace?: string;
      /** `project/repo` — the full repository name a `source_mappings.repoPattern` glob matches. */
      repo_full_name?: string;
      repo_type?: string;
    };
  };
}

/** Maps a Harbor event to a provider-neutral hint. See docs/plugins.md §243. */
export function mapHarborWebhookEventToHint(
  eventName: string,
  payload: unknown
): GitProviderEventHint | null {
  // For THIS slice only image pushes become a Change. Recognize other types as known-but-ignored
  // (clean `null`) rather than mis-mapping them — SCANNING_COMPLETED's scan-gate feed is M17.1.
  if (eventName !== "PUSH_ARTIFACT") return null;

  const p = (payload ?? {}) as HarborWebhookPayload;
  const eventData = p.event_data;
  const repo = eventData?.repository?.repo_full_name;
  const resources = eventData?.resources;
  const firstResource = Array.isArray(resources) ? resources[0] : undefined;
  const digest = typeof firstResource?.digest === "string" ? firstResource.digest : undefined;

  // A push event with neither a repo nor a digest carries nothing correlatable — ignore it rather
  // than propose a Change against nothing.
  if (!repo && !digest) return null;

  return {
    repo,
    artifactDigest: digest,
    // Group related events (retag/re-push of the same image) under one CoordinatedChange. Prefer a
    // repo-scoped digest key so the same digest under two repos never cross-links; fall back to the
    // digest alone, then the repo, so a partial payload still yields a stable key.
    correlationKey: digest ? (repo ? `${repo}@${digest}` : digest) : repo
  };
}

/** The webhook-source descriptor the registry consumes. See docs/plugins.md §244. */
export interface HarborWebhookSource {
  readonly sourceKind: "harbor";
  mapEvent(eventName: string, payload: unknown): GitProviderEventHint | null;
}

export const harborWebhookSource: HarborWebhookSource = {
  sourceKind: "harbor",
  mapEvent: mapHarborWebhookEventToHint
};
