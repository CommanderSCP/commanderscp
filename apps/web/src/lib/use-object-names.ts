import { useQueries } from "@tanstack/react-query";
import { client } from "./client";

/** Resolve object ids to display names, for id-only payloads. See docs/web.md §143. */
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
        client.graph.traverse({
          objectId: id,
          direction: "out",
          relTypes: ["contains"],
          maxDepth: 1
        }),
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
