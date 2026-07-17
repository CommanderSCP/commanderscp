import { useEffect, useRef } from "react";
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import { useNavigate } from "@tanstack/react-router";
import { REGISTRIES } from "../../lib/registries";

export interface GraphCanvasNode {
  id: string;
  name: string;
  typeId: string;
}

export interface GraphCanvasEdge {
  id: string;
  fromId: string;
  toId: string;
}

export interface GraphCanvasData {
  objects: GraphCanvasNode[];
  edges: GraphCanvasEdge[];
}

interface GraphCanvasProps {
  data: GraphCanvasData;
  /** Optional root node to emphasize (the object being explored). Added to the node set if it
   *  isn't already present among `data.objects`. */
  rootId?: string;
}

/**
 * Shared Cytoscape.js node-link renderer for both `/graph` (org overview) and `/graph/{idOrUrn}`
 * (object-scoped explorer). Extracted from the original graph-explorer page so the two entry
 * points render identically and the testability hook / click-to-navigate behaviour lives in one
 * place.
 *
 * `window.__cy` is exposed for Playwright (apps/web/e2e) — Cytoscape renders to `<canvas>`, which
 * isn't otherwise inspectable, so the e2e suite asserts on the real rendered node/edge counts via
 * this handle. Gated on `import.meta.env.DEV` OR the runtime `__SCP_E2E__` flag the e2e suite
 * injects (fixtures.ts) — the flag is what actually matters, since the e2e suite runs against the
 * SAME production build (`vite build`) that ships in the Docker image, where `import.meta.env.DEV`
 * is false. Nothing in real production traffic sets `__SCP_E2E__`, so this never activates outside
 * a Playwright-controlled page.
 */
export function GraphCanvas({ data, rootId }: GraphCanvasProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  // Mount Cytoscape exactly once; element data is applied in the effect below so data changes
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
    if (!cy) return;
    cy.elements().remove();

    const byId = new Map(data.objects.map((o) => [o.id, o]));
    const nodeIds = new Set<string>(data.objects.map((o) => o.id));
    if (rootId) nodeIds.add(rootId);

    const elements: ElementDefinition[] = [
      ...[...nodeIds].map((id) => {
        const obj = byId.get(id);
        return {
          data: {
            id,
            label: obj?.name ?? id.slice(0, 8),
            typeId: obj?.typeId,
            root: rootId && id === rootId ? true : undefined
          }
        };
      }),
      // Only render edges whose endpoints are both in the node set — a stray edge to an
      // un-rendered node would make Cytoscape throw.
      ...data.edges
        .filter((edge) => nodeIds.has(edge.fromId) && nodeIds.has(edge.toId))
        .map((edge) => ({
          data: { id: edge.id, source: edge.fromId, target: edge.toId }
        }))
    ];
    cy.add(elements);
    cy.layout({ name: "cose" }).run();
  }, [data, rootId]);

  return <div ref={containerRef} className="h-full w-full" data-testid="cytoscape-container" />;
}
