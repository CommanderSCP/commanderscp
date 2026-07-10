import { useParams, useSearch } from "@tanstack/react-router";

/**
 * Loosely-typed param/search accessors (`strict: false`) so route page components don't need to
 * import their own route object from router.tsx — avoids a circular import between router.tsx
 * (which imports every page component) and the pages themselves.
 */

export function useBasePathParam(): string | undefined {
  return (useParams({ strict: false }) as { basePath?: string }).basePath;
}

export function useIdOrUrnParam(): string | undefined {
  return (useParams({ strict: false }) as { idOrUrn?: string }).idOrUrn;
}

/** `/changes/$id` (M3) — Changes are addressed by id only, never by URN. */
export function useIdParam(): string | undefined {
  return (useParams({ strict: false }) as { id?: string }).id;
}

export function useUserCodeSearch(): string | undefined {
  return (useSearch({ strict: false }) as { user_code?: string }).user_code;
}
