import type { GitProviderEventHint } from "@scp/git-provider-core";

/**
 * `@scp/plugin-harbor` — Harbor as a **webhook CHANGE-SOURCE**, NOT an executor (M15.3c,
 * WEBHOOK-SOURCE shape). A container registry is a passive artifact STORE that SCP observes; it is
 * never triggered, never deployed to, never held as an execution-system credential. So — unlike the
 * git providers (`@scp/plugin-github`/`-gitea`/`-gitlab`), which are full `ExecutorPlugin`s built on
 * `@scp/git-provider-core` — this package is DELIBERATELY tiny: a single pure event-mapper and a
 * webhook-source descriptor. There is no `ExecutorPlugin`, no `GitProviderAdapter` (no
 * trigger/observe/status/abort/verify), no manifest, no `KNOWN_EXECUTOR_MODULES` entry. A registry
 * webhook-source only needs to turn a pushed image event into a correlation hint; everything else on
 * the inbound path (auth, persist-then-process, `source_mappings` correlation, Change proposal) is
 * the SAME server machinery every other webhook source already flows through — Harbor is just a new
 * open `sourceKind` string, not a new object type (charter principle 2, graph-native).
 *
 * COORDINATE-NOT-EXECUTE (charter principle 1): SCP RECEIVES Harbor's push and correlates it; it
 * never calls Harbor. This is exactly like a git webhook, one artifact-shaped event further along.
 *
 * CONNECTED registries only. Harbor PUSHES `PUSH_ARTIFACT` events to SCP's webhook ingress. The
 * air-gap PULL direction (SCP POLLING a registry that cannot reach out) is a DEFERRED, non-binding
 * poll-driver follow-on — out of scope here (see docs/BUILD_AND_TEST.md §8 M15.3c).
 *
 * OPERATOR SETUP (why there is no `verify`): Harbor's webhook policy exposes a single **Auth
 * Header** field — the full `Authorization` header value it sends on every delivery. The operator
 * sets it to `Bearer <a scoped SCP PAT>`, so the platform's existing `requireAuth` authenticates the
 * push. Harbor cannot send a SEPARATE HMAC-signature header, so an HMAC verifier would be moot — do
 * NOT configure a change-source webhook secret for `harbor`. This adapter therefore has NO `verify`
 * function; it is `mapEvent`-only.
 *
 * EVENT NAME IN THE BODY (why there is no `eventHeaderName`): Harbor carries its event type in the
 * BODY (`payload.type`), not an HTTP header — unlike github/gitea/gitlab, which name their event in
 * a header (`X-GitHub-Event` etc.). The server's `extractHint` (webhook-processor.ts) derives the
 * event name from `payload.type` for any adapter that declares no `eventHeaderName`.
 */

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

/**
 * Maps a Harbor webhook event NAME + payload to a provider-neutral correlation hint (null = ignore),
 * reusing the SAME `GitProviderEventHint` shape the git providers emit — which already carries
 * `artifactDigest` (ADR-0013), the field a registry push is fundamentally about.
 *
 * ONLY `PUSH_ARTIFACT` (a new image landed in the registry) maps to a hint for THIS slice — that is
 * the event that represents a releasable artifact. Every other Harbor event type is IGNORED CLEANLY
 * (returns `null`, never throws, never a silent mis-map): `SCANNING_COMPLETED` (which carries
 * `event_data.scan_overview`) is RECOGNIZED as a known type but its scan-gate feed is a NOTED
 * FOLLOW-ON (M17.1), and `DELETE_ARTIFACT`/replication/quota events are simply not release signals.
 *
 * Correlation is on REPO, via the existing `source_mappings` globs — the digest is threaded through
 * as `artifactDigest` (→ the change's `sourceRef.artifact_digest`) and folded into `correlationKey`
 * for grouping, exactly as the gitea package-push path does; it is NOT a new correlation DIMENSION.
 */
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
  const digest =
    typeof firstResource?.digest === "string" ? firstResource.digest : undefined;

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

/**
 * The Harbor WEBHOOK-SOURCE descriptor consumed by the server's per-`sourceKind` adapter registry
 * (`apps/server/src/coordination/webhook-adapters.ts`). Intentionally NOT a `GitProviderAdapter`:
 * a registry webhook-source has NO signature header (`Bearer`-PAT authed, no HMAC), NO event header
 * (event name is in `payload.type`), and NO trigger/observe/verify verbs — only `sourceKind` +
 * `mapEvent`. The server treats a missing `verify`/`eventHeaderName` accordingly (generic-verifier
 * fallback — never exercised, since harbor configures no secret — and body-derived event name).
 */
export interface HarborWebhookSource {
  readonly sourceKind: "harbor";
  mapEvent(eventName: string, payload: unknown): GitProviderEventHint | null;
}

export const harborWebhookSource: HarborWebhookSource = {
  sourceKind: "harbor",
  mapEvent: mapHarborWebhookEventToHint
};
