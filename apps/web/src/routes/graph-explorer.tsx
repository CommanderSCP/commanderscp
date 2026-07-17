import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { NamedGraphQuery } from "@scp/schemas";
import { client } from "../lib/client";
import { useIdOrUrnParam } from "../lib/use-route-params";
import { GraphCanvas, type GraphCanvasData } from "../components/graph/GraphCanvas";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "../components/ui/select";

type QuerySelection = NamedGraphQuery | "traverse";

const QUERY_OPTIONS: { value: QuerySelection; label: string }[] = [
  { value: "impact-of", label: "Impact of" },
  { value: "dependents-of", label: "Dependents of" },
  { value: "consumers-of", label: "Consumers of" },
  { value: "owners-of", label: "Owners of" },
  { value: "blast-radius", label: "Blast radius" },
  { value: "traverse", label: "Traverse (outgoing)" }
];

/**
 * `/graph/{idOrUrn}` (BUILD_AND_TEST.md §8 M2 item 2) — object-scoped Cytoscape.js explorer fed by
 * M1's named graph-query endpoints. Reachable from `/graph` (the landing/picker) or from an
 * object's registry-detail page.
 *
 * Edge sourcing: `traverse` already returns the real induced-subgraph edges. The named queries
 * (`impact-of`/`blast-radius`/…) return only the reachable object SET — so we take that set and
 * make a single follow-up `graph.subgraph` call to fetch the REAL relationships among it (root
 * included), rendering the true dependency DAG instead of a synthesized hub-and-spoke star.
 */
export function GraphExplorerPage(): React.JSX.Element {
  const idOrUrn = useIdOrUrnParam();
  const [queryName, setQueryName] = useState<QuerySelection>("impact-of");

  const graphQuery = useQuery<GraphCanvasData>({
    queryKey: ["graph-explorer", queryName, idOrUrn],
    queryFn: async () => {
      if (!idOrUrn) throw new Error("missing object id");
      if (queryName === "traverse") {
        const result = await client.graph.traverse({ objectId: idOrUrn, direction: "out" });
        return {
          objects: result.objects.map((o) => ({ id: o.id, name: o.name, typeId: o.typeId })),
          edges: result.edges.map((e) => ({ id: e.id, fromId: e.fromId, toId: e.toId }))
        };
      }
      const result = await client.graph.query(queryName, { objectId: idOrUrn });
      const objects = result.objects.map((o) => ({ id: o.id, name: o.name, typeId: o.typeId }));
      if (objects.length === 0) return { objects, edges: [] };
      // Named queries return only the reachable node SET; ask for the REAL induced-subgraph edges
      // among that set (plus the root) so the graph shows the true relationship structure.
      const ids = [...new Set([idOrUrn, ...objects.map((o) => o.id)])];
      const sub = await client.graph.subgraph({ objectId: idOrUrn, ids });
      return {
        objects,
        edges: sub.edges.map((e) => ({ id: e.id, fromId: e.fromId, toId: e.toId }))
      };
    },
    enabled: !!idOrUrn
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Graph explorer</h1>
          <p className="font-mono text-xs text-slate-500">{idOrUrn}</p>
        </div>
        <div className="w-56">
          <Select value={queryName} onValueChange={(v) => setQueryName(v as QuerySelection)}>
            <SelectTrigger data-testid="graph-query-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {QUERY_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="relative h-[32rem] rounded-lg border border-slate-200 bg-white">
        {graphQuery.isLoading && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-500">
            Loading graph…
          </div>
        )}
        {graphQuery.isError && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-red-600">
            {graphQuery.error instanceof Error ? graphQuery.error.message : "Failed to load graph"}
          </div>
        )}
        {graphQuery.data && graphQuery.data.objects.length === 0 && (
          <div
            className="absolute inset-0 flex items-center justify-center text-sm text-slate-500"
            data-testid="graph-empty-state"
          >
            No related objects found for this query.
          </div>
        )}
        {idOrUrn && <GraphCanvas data={graphQuery.data ?? { objects: [], edges: [] }} rootId={idOrUrn} />}
      </div>
    </div>
  );
}
