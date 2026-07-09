import { useEffect, useRef, useState } from "react";
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { NamedGraphQuery } from "@scp/schemas";
import { client } from "../lib/client";
import { REGISTRIES } from "../lib/registries";
import { useIdOrUrnParam } from "../lib/use-route-params";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";

type QuerySelection = NamedGraphQuery | "traverse";

const QUERY_OPTIONS: { value: QuerySelection; label: string }[] = [
  { value: "impact-of", label: "Impact of" },
  { value: "dependents-of", label: "Dependents of" },
  { value: "consumers-of", label: "Consumers of" },
  { value: "owners-of", label: "Owners of" },
  { value: "blast-radius", label: "Blast radius" },
  { value: "traverse", label: "Traverse (outgoing)" }
];

interface GraphData {
  objects: { id: string; name: string; typeId: string }[];
  edges: { id: string; fromId: string; toId: string }[];
}

/**
 * `/graph/{idOrUrn}` (BUILD_AND_TEST.md §8 M2 item 2) — Cytoscape.js explorer fed by M1's named
 * graph-query endpoints. `window.__cy` is exposed in dev builds only (`import.meta.env.DEV`) so
 * the Playwright suite (apps/web/e2e) can assert on rendered node/edge counts without depending
 * on Cytoscape's canvas internals.
 */
export function GraphExplorerPage(): React.JSX.Element {
  const idOrUrn = useIdOrUrnParam();
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const [queryName, setQueryName] = useState<QuerySelection>("impact-of");

  const graphQuery = useQuery<GraphData>({
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
      // Named queries (graph/named-queries.ts) return the reachable object set, not an edge
      // list — synthesize a hub-and-spoke edge from the root to each result so the graph always
      // renders connected. `traverse` (above) is the option that returns real edges.
      return {
        objects: result.objects.map((o) => ({ id: o.id, name: o.name, typeId: o.typeId })),
        edges: result.objects.map((o) => ({
          id: `${idOrUrn}->${o.id}`,
          fromId: idOrUrn,
          toId: o.id
        }))
      };
    },
    enabled: !!idOrUrn
  });

  // Mount Cytoscape exactly once; element data is applied in the effect below so query changes
  // don't tear down/recreate the renderer.
  useEffect(() => {
    if (!containerRef.current) return undefined;
    const cy = cytoscape({
      container: containerRef.current,
      style: [
        {
          selector: "node",
          style: {
            "background-color": "#0f172a",
            label: "data(label)",
            color: "#334155",
            "font-size": 10,
            "text-valign": "bottom",
            "text-margin-y": 6,
            width: 24,
            height: 24
          }
        },
        {
          selector: "node[?root]",
          style: { "background-color": "#2563eb", width: 32, height: 32 }
        },
        {
          selector: "edge",
          style: {
            width: 1.5,
            "line-color": "#94a3b8",
            "target-arrow-color": "#94a3b8",
            "target-arrow-shape": "triangle",
            "curve-style": "bezier"
          }
        }
      ],
      layout: { name: "cose" }
    });
    cy.on("tap", "node", (event) => {
      const typeId = event.target.data("typeId") as string | undefined;
      const id = event.target.id();
      const registry = REGISTRIES.find((r) => r.typeId === typeId);
      if (registry) {
        void navigateRef.current({
          to: "/$basePath/$idOrUrn",
          params: { basePath: registry.basePath, idOrUrn: id }
        });
      }
    });
    cyRef.current = cy;
    // Dev/test-only testability hook so Playwright can assert on the real rendered node/edge
    // counts (Cytoscape renders to <canvas>, which isn't otherwise inspectable). Gated on
    // `import.meta.env.DEV` (true under `vite`/`vite preview`) OR a runtime flag the e2e suite
    // injects via Playwright's `page.addInitScript` (apps/web/e2e/fixtures.ts) — the flag
    // approach is what actually matters here: the e2e suite runs against the SAME production
    // build (`vite build`, `import.meta.env.DEV === false`) that ships in the Docker image, so a
    // DEV-only gate alone would never fire in that build. Nothing in real production traffic
    // ever sets `window.__SCP_E2E__`, so this never activates outside a Playwright-controlled
    // page.
    if (import.meta.env.DEV || (window as unknown as { __SCP_E2E__?: boolean }).__SCP_E2E__) {
      (window as unknown as { __cy?: Core }).__cy = cy;
    }
    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, []);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !graphQuery.data || !idOrUrn) return;
    cy.elements().remove();

    const byId = new Map(graphQuery.data.objects.map((o) => [o.id, o]));
    const nodeIds = new Set<string>([idOrUrn, ...graphQuery.data.objects.map((o) => o.id)]);

    const elements: ElementDefinition[] = [
      ...[...nodeIds].map((id) => {
        const obj = byId.get(id);
        return {
          data: {
            id,
            label: obj?.name ?? id.slice(0, 8),
            typeId: obj?.typeId,
            root: id === idOrUrn ? true : undefined
          }
        };
      }),
      ...graphQuery.data.edges.map((edge) => ({
        data: { id: edge.id, source: edge.fromId, target: edge.toId }
      }))
    ];
    cy.add(elements);
    cy.layout({ name: "cose" }).run();
  }, [graphQuery.data, idOrUrn]);

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
        <div ref={containerRef} className="h-full w-full" data-testid="cytoscape-container" />
      </div>
    </div>
  );
}
