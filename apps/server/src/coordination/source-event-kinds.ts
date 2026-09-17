import { webhookAdapterForSourceKind } from "./webhook-adapters.js";

/**
 * WHICH INGESTED EVENTS MAY PROPOSE A RELEASE — the one allowlist (owner decision 2026-09-16,
 * docs/proposals/run-events-are-not-releases.md option C).
 *
 * A change IS a release (GLOSSARY): a versioned unit of change. Only an event that says "the
 * source moved" can be one. A CI run concluding, a pipeline finishing, an Argo CD reconcile, a
 * deployment report or a pull request being opened says something ABOUT a release, never that one
 * exists. Before this gate, `processChangeSourceEvents` never looked at the event kind, so every
 * such event whose repo matched a mapping became a release. Measured on the homelab: 87 CI runs
 * became changes and drove 40 real Argo CD syncs.
 *
 * ALLOWLIST, NOT DENYLIST. An event kind nobody listed here (a new provider event, a plugin's
 * invented `custom` meaning, a header GitHub adds next year) proposes nothing. Adding a source
 * kind is a one-line, reviewed edit here. Forgetting to deny one is not a mistake anyone can make.
 *
 * WHAT THIS DOES NOT GATE. It runs AFTER the M21.5 provenance attach route, which legitimately
 * consumes `pull_request` and `workflow_run` events to attach them to the bump change SCP authored.
 * Ingestion, dedupe and observe watermarks are untouched: a non-source event is still stored
 * verbatim in `change_source_events`. That is what the component view's "built upstream" line
 * reads (`observed-run-facts.ts`).
 */

/** The classification of one stored `change_source_events` row. */
export interface SourceEventClassification {
  /** How the event's kind was read: a provider webhook header (or harbor's in-body `type`), an
   *  `observe()` poll's `ExecutorEvent.kind`, or neither (a first-party report / flat payload). */
  via: "webhook" | "observed" | "report";
  /** The provider event name or `ExecutorEvent.kind`; null for a report. */
  eventKind: string | null;
  /** True iff this event may reach `matchComponentsForSource` → `proposeChange`. */
  proposesChange: boolean;
}

/** Provider webhook event names that mean "the source moved", per source kind. Every name a
 *  provider adapter's `mapEvent` recognises and that is NOT listed here is a non-source event:
 *  github `pull_request`/`workflow_run`/`deployment`; gitea `pull_request`; gitlab
 *  `Merge Request Hook`/`Pipeline Hook`. */
const SOURCE_WEBHOOK_EVENTS: Readonly<Record<string, ReadonlySet<string>>> = {
  github: new Set(["push", "release"]),
  gitea: new Set(["push", "release", "package"]),
  gitlab: new Set(["Push Hook", "Tag Push Hook"]),
  harbor: new Set(["PUSH_ARTIFACT"])
};

/** `ExecutorEvent.kind` values (plugin-api `ExecutorEventKind`) that mean "the source moved".
 *  `custom` is the closed vocabulary's DESIGNATED catch-all and the kind gitea's package poll files
 *  a package/OCI push under (plugin-api has no `package` member). Listing it is the owner's
 *  "package push". Excluded: `workflow_run` (github/gitea/gitlab `pollRuns`, argo-workflows
 *  `observe`), `sync` (argocd `observe`), `pull_request`, `deployment`. */
const SOURCE_OBSERVED_KINDS: ReadonlySet<string> = new Set(["push", "release", "custom"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Classify one stored event, from the SAME three inputs `extractHint` reads, so what is gated is
 * byte-for-byte what would be correlated. Order matters:
 *
 * 1. A provider adapter with its event-name header present: a real provider delivery. The event
 *    name decides.
 * 2. An adapter that names its event in the body (harbor's `type`): same, read from the body.
 * 3. `payload._observed === true`: `observe.ts#ingestObservedEvents` wrote it, with `headers: {}`,
 *    and the event's `kind` beside it. The kind decides. This is the path the homelab takes.
 * 4. Anything else is the flat first-party shape (`scp change-source report`, or a hand-built
 *    `/webhook` body for a source kind with no adapter). It is an explicit report that a release
 *    happened, so it proposes, exactly as before.
 *
 * A caller could forge `_observed: true` on a report body, but only to suppress its own report. The
 * gate can only make an event propose LESS.
 */
export function classifySourceEvent(
  sourceKind: string,
  headers: unknown,
  payload: unknown
): SourceEventClassification {
  const adapter = webhookAdapterForSourceKind(sourceKind);
  const allowed = SOURCE_WEBHOOK_EVENTS[sourceKind];
  if (adapter) {
    let eventName: unknown;
    if (adapter.eventHeaderName) {
      eventName = isRecord(headers) ? headers[adapter.eventHeaderName] : undefined;
    } else if (isRecord(payload)) {
      eventName = payload.type;
    }
    if (typeof eventName === "string") {
      return {
        via: "webhook",
        eventKind: eventName,
        proposesChange: allowed?.has(eventName) ?? false
      };
    }
  }
  if (isRecord(payload) && payload._observed === true) {
    const kind = typeof payload.kind === "string" ? payload.kind : null;
    return {
      via: "observed",
      eventKind: kind,
      proposesChange: kind !== null && SOURCE_OBSERVED_KINDS.has(kind)
    };
  }
  return { via: "report", eventKind: null, proposesChange: true };
}
