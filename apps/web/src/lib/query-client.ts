import { QueryClient } from "@tanstack/react-query";

/**
 * One shared TanStack Query cache for the whole SPA. `useEventStream` (lib/use-event-stream.ts)
 * invalidates specific query keys when an SSE event arrives — that's the live-update mechanism
 * (DESIGN.md §14, BUILD_AND_TEST.md §8 M2 DoD (a)) — so query keys below are deliberately
 * structured (`["registry", basePath, ...]`) to make targeted invalidation straightforward.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The SPA is same-origin with the API — failures are almost always real (401/403/404), not
      // transient network blips worth silently retrying.
      retry: false,
      staleTime: 10_000
    }
  }
});

/** Query key for this instance's own federation identity (`GET /federation/self`) — M16.3 P2's
 *  `useOwnDomainId` (lib/replica-origin.tsx). A single instance's own domain id never changes at
 *  runtime (federation/self-repo.ts: created once, lazily; `role`/`name` may be re-set via `scp
 *  federation init` but `domainId` never is), so this key is intentionally NOT parameterized. */
export function federationSelfKey(): unknown[] {
  return ["federation", "self"];
}

/** Query key for `GET /federation/status` — the whole-instance federation reading (peers, sync
 *  freshness, pending-export figures). Shared by `routes/federation-status.tsx`, the M16.2 phase B
 *  Outposts overview and its per-outpost detail page, so a write on the detail page invalidates the
 *  reading every one of them renders. NOT parameterized: the endpoint takes no arguments. */
export function federationStatusKey(): unknown[] {
  return ["federation", "status"];
}

/** Query key for `GET /federation/outposts` — every `outpost` CONFIG OBJECT (ADR-0022's
 *  commander-declared half), as opposed to the peer ROWS in `federationStatusKey`. The detail page
 *  reads the LIST rather than only its own peer's row because a peer bound to TWO live config
 *  objects is exactly the authority conflict the reconcile verb exists for, and the single-object
 *  `GET` answers with the winner alone — it cannot show a conflict it has already resolved. */
export function outpostConfigListKey(): unknown[] {
  return ["federation", "outposts", "list"];
}

/** Query key for one peer's `outpost` config object (`GET /federation/outposts/{peerDomainId}`). */
export function outpostConfigKey(peerDomainId: string): unknown[] {
  return ["federation", "outposts", "detail", peerDomainId];
}

/** Query key for a registry resource's list view — `useEventStream` invalidates this on create/delete. */
export function registryListKey(basePath: string): unknown[] {
  return ["registry", basePath, "list"];
}

/** Query key for a single object's detail view. */
export function registryDetailKey(basePath: string, idOrUrn: string): unknown[] {
  return ["registry", basePath, "detail", idOrUrn];
}

/** Query key for the Changes list view (M3, BUILD_AND_TEST.md §8 M3 UI requirement). */
export function changeListKey(): unknown[] {
  return ["change", "list"];
}

/** Query key for a single change's `:explain` detail view (change + plan/waves + decisions). */
export function changeDetailKey(id: string): unknown[] {
  return ["change", "detail", id];
}

/** Query key for a change's approval requests (M4, DESIGN §10.2 — approvals materialize per
 *  change; `GET /approvals` is always scoped to one `changeId`, so this lives on the change
 *  detail view rather than a standalone approvals list page). */
export function changeApprovalsKey(changeId: string): unknown[] {
  return ["change", "approvals", changeId];
}

/** Query key for the component-pipeline view's per-target executor-binding + execution-system
 *  lookups (coordination-ui-views.md phase 1 — the per-wave source/executor links). Keyed by change
 *  id: the set of targets is fixed by that change's compiled plan. */
export function changePipelineLinksKey(changeId: string): unknown[] {
  return ["change", "pipeline-links", changeId];
}

/** Query key for the component-pipeline view's live final-gate check (`client.policyEvaluate`), a
 *  side-effect-free promotion verdict used only to color the change-level promotion arrow. */
export function changePipelineGateKey(changeId: string): unknown[] {
  return ["change", "pipeline-gate", changeId];
}

/** Query key for the Service release board (coordination-ui-views.md Phase 2) — a service's
 *  components + each's latest change per-wave status, projected by `GET /services/{id}/board`. */
export function serviceBoardKey(id: string): unknown[] {
  return ["service", "board", id];
}

/** Query keys for one assembly's board — `part` separates the assembly object itself from the
 *  `contains` traversal that lists its components, so the two refetch independently. */
export function assemblyBoardKey(idOrUrn: string, part: "self" | "members"): unknown[] {
  return ["assembly", "board", idOrUrn, part];
}

/** Query key for the Campaigns list view (M5, BUILD_AND_TEST.md §8 M5 UI requirement). */
export function campaignListKey(): unknown[] {
  return ["campaign", "list"];
}

/** Query key for a single campaign's `:explain` detail view (campaign + plan/waves + decisions). */
export function campaignDetailKey(id: string): unknown[] {
  return ["campaign", "detail", id];
}

export const authMeKey = ["auth", "me"];
export const authConfigKey = ["auth", "config"];

/** Query key for a component's PIPELINE (coordination-ui-views.md §2, as corrected 2026-08-03) —
 *  its stages, projected by `GET /components/{id}/pipeline`. Keyed on the COMPONENT, not a change:
 *  the pipeline is durable and exists with nothing in flight. */
export function componentPipelineKey(idOrUrn: string): unknown[] {
  return ["component", "pipeline", idOrUrn];
}

/** Query key for the instance dependency-subscription unlock (`GET /instance/dependency-subscription-unlock`)
 *  — the first conjunct of the enablement chain, one singleton row per deployment, so the key is
 *  not parameterized. Read-only in the tenant UI (the write is an operator-token CLI action). */
export function dependencySubscriptionUnlockKey(): unknown[] {
  return ["dependency-subscriptions", "unlock"];
}

/** Query key for a component's dependency INVENTORY (`GET /components/{id}/dependency-inventory`)
 *  — its declared major lines with each line's head and resolved dependency subscription, plus the
 *  component-level ingestion gate. Invalidated after a policy write authored from the Dependencies
 *  tab (enable / opt out), because the rows' resolutions are read off the server, never recomputed. */
export function componentDependencyInventoryKey(idOrUrn: string): unknown[] {
  return ["component", "dependency-inventory", idOrUrn];
}

/** Query key for the bumps SCP authored for a component (`GET /components/{id}/dependency-bumps`). */
export function componentDependencyBumpsKey(idOrUrn: string): unknown[] {
  return ["component", "dependency-bumps", idOrUrn];
}

/** Query key for the org's dependency PRODUCER declarations (`GET /dependencies/producers`) — one
 *  unpaged, org-level list (ADR-0032 §7e); NOT parameterized by producer: the Admin › Dependencies
 *  page shows all of it and a component's "Produces" strip filters it client-side. Invalidated after
 *  a declare / retract authored from the Admin page. */
export function dependencyProducersKey(): unknown[] {
  return ["dependency-producers"];
}
