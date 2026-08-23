import { useLocation, useParams, useSearch } from "@tanstack/react-router";

/**
 * Loosely-typed param/search accessors (`strict: false`) so route page components don't need to
 * import their own route object from router.tsx — avoids a circular import between router.tsx
 * (which imports every page component) and the pages themselves.
 */

/**
 * Which REGISTRY this page is showing — `components`, `services`, `deployment-targets`, …
 *
 * Falls back to the URL's FIRST SEGMENT when there is no `$basePath` param, which is what lets
 * `RegistryDetailPage` mount at a static path as well as at the generic `/$basePath/$idOrUrn`.
 * `/components/{id}/settings` needs exactly that: `/components/{id}` is a static route (the
 * pipeline, which out-ranks the dynamic one), so its `settings` child has no `$basePath` to read,
 * and without this fallback the alternative is a duplicate copy of a ~570-line page.
 *
 * The segment is not trusted to BE a registry — `findRegistry` still decides that, and returns
 * undefined for `/changes` or `/federation`, which render "Not found" exactly as an unknown
 * `$basePath` always has.
 */
export function useBasePathParam(): string | undefined {
  const param = (useParams({ strict: false }) as { basePath?: string }).basePath;
  const firstSegment = useLocation({ select: (l) => l.pathname.split("/")[1] });
  return param ?? (firstSegment || undefined);
}

export function useIdOrUrnParam(): string | undefined {
  return (useParams({ strict: false }) as { idOrUrn?: string }).idOrUrn;
}

/** `/changes/$id` (M3) — Changes are addressed by id only, never by URN. */
export function useIdParam(): string | undefined {
  return (useParams({ strict: false }) as { id?: string }).id;
}

/** `/graph/service/$serviceId` (coordination-ui-views.md § two-layer graph) — the component layer. */
export function useServiceIdParam(): string | undefined {
  return (useParams({ strict: false }) as { serviceId?: string }).serviceId;
}

/** `/federation/outposts/$peerDomainId` (M16.2 phase B) — an outpost is addressed by its peer
 *  TRUST-DOMAIN id, which is the anchor of the whole authority split (ADR-0022 clause 4): the peer
 *  row's primary key AND the `outpost` config object's binding. Never by the config object's id. */
export function usePeerDomainIdParam(): string | undefined {
  return (useParams({ strict: false }) as { peerDomainId?: string }).peerDomainId;
}

export function useUserCodeSearch(): string | undefined {
  return (useSearch({ strict: false }) as { user_code?: string }).user_code;
}

/** `/admin/decisions?subjectId=…` (Decisions & Audit explorer) — carries the subject an object
 *  page's "Decisions about this object" link (`registry-detail.tsx`) filters on. `decisions.list`
 *  DOES filter by `subjectId` on the wire (`DecisionListQuerySchema`), which is what makes this
 *  link honest rather than a client-side filter posing as a server one. */
export function useSubjectIdSearchForDecisions(): string | undefined {
  return (useSearch({ strict: false }) as { subjectId?: string }).subjectId;
}
