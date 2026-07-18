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
 *  lookups (coordination-ui-views.md phase 1 — the stage source/executor links). Keyed by change
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
 *  components + each's latest change per-stage status, projected by `GET /services/{id}/board`. */
export function serviceBoardKey(id: string): unknown[] {
  return ["service", "board", id];
}

/** Query key for the Campaigns list view (M5, BUILD_AND_TEST.md §8 M5 UI requirement). */
export function campaignListKey(): unknown[] {
  return ["campaign", "list"];
}

/** Query key for a single campaign's `:explain` detail view (campaign + plan/waves + decisions). */
export function campaignDetailKey(id: string): unknown[] {
  return ["campaign", "detail", id];
}

/** Query key for the Initiatives list view (M5, BUILD_AND_TEST.md §8 M5 UI requirement). */
export function initiativeListKey(): unknown[] {
  return ["initiative", "list"];
}

/** Query key for a single initiative's roll-up view (initiative + member campaigns + rollupStatus). */
export function initiativeDetailKey(id: string): unknown[] {
  return ["initiative", "detail", id];
}

export const authMeKey = ["auth", "me"];
export const authConfigKey = ["auth", "config"];
