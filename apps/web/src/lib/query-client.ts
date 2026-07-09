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

export const authMeKey = ["auth", "me"];
export const authConfigKey = ["auth", "config"];
