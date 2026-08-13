import { useQueries } from "@tanstack/react-query";
import { client } from "./client";

/**
 * Resolve graph-object ids to display names + types, for surfaces whose payload carries only ids.
 *
 * WHY THIS EXISTS (spec §4C, second pass): the generalized `PipelineWaveCard` grew a `targetName`
 * slot in the overhaul, but the change/campaign wave payloads carry only `targetObjectId` — so the
 * slot sat empty and every wave target still rendered as a raw UUID. The lever existed; nothing
 * pulled it. This hook is the missing supply side, shared by change-detail and campaign-detail.
 *
 * WHY `graph.traverse` AND NOT A TYPED REGISTRY GET: a wave target may be a component, a service,
 * or any other graph object, and the typed clients 404 across types. `traverse` at depth 1 returns
 * the ROOT object itself (name + typeId) regardless of type — the same property the assembly board
 * and registry-detail already lean on — so one bounded call resolves any id without guessing its
 * registry. Results are cached per id by the query key, so revisits are free.
 */
export interface ResolvedObject {
  name: string;
  typeId: string;
}

export function useObjectNames(ids: readonly string[]): Map<string, ResolvedObject> {
  const unique = [...new Set(ids)].sort();
  const queries = useQueries({
    queries: unique.map((id) => ({
      queryKey: ["object-name", id],
      queryFn: () =>
        client.graph.traverse({ objectId: id, direction: "out", relTypes: ["contains"], maxDepth: 1 }),
      staleTime: 60_000
    }))
  });

  const map = new Map<string, ResolvedObject>();
  unique.forEach((id, i) => {
    const root = queries[i]?.data?.objects.find((o) => o.id === id);
    // Unresolved (still loading, or unreadable cross-domain) stays absent — the card's mono-UUID
    // fallback is the honest rendering for "this instance cannot name it", never a blank.
    if (root) map.set(id, { name: root.name, typeId: root.typeId });
  });
  return map;
}
