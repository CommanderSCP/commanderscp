import { useEffect, useRef } from "react";
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import { useNavigate } from "@tanstack/react-router";
import { REGISTRIES } from "../../lib/registries";

export interface GraphCanvasNode {
  id: string;
  name: string;
  typeId: string;
  /** Marks a node that lives OUTSIDE the current scope — e.g. a component owned by a different
   *  service in the component-layer view. Rendered with a dashed outline. Backward-compatible:
   *  undefined = the normal solid treatment. */
  external?: boolean;
}

export interface GraphCanvasEdge {
  id: string;
  fromId: string;
  toId: string;
  /** Relationship type (`consumes` / `depends_on` / `contains` / …). Forwarded to Cytoscape so
   *  edges can be styled by type; optional for backward-compat. */
  typeId?: string;
  /** Marks an edge that leaves the current scope (a component→component link across services).
   *  Rendered dashed. Backward-compatible: undefined = a normal solid edge. */
  crossService?: boolean;
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
  /** Cytoscape layout name — defaults to `cose`. The two-layer views pass a deliberate layout. */
  layout?: string;
  /** Overrides the default click-to-registry-detail navigation. When provided, a node tap calls
   *  this instead — the service-layer view uses it to drill into a service's component graph. */
  onNodeTap?: (node: { id: string; typeId?: string; external?: boolean }) => void;
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
export function GraphCanvas({ data, rootId, layout, onNodeTap }: GraphCanvasProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const onNodeTapRef = useRef(onNodeTap);
  onNodeTapRef.current = onNodeTap;
  const layoutRef = useRef(layout ?? "cose");
  layoutRef.current = layout ?? "cose";

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
            "border-width": 0,
            label: "data(label)",
            color: "#334155",
            "font-size": 10,
            "text-valign": "bottom",
            "text-margin-y": 6,
            width: 24,
            height: 24
          }
        },
        // Typed node coloring (Phase 3, coordination-ui-views.md § two-layer graph). Attribute
        // selectors out-rank the bare `node` rule; `typeId` is already on every node's data.
        {
          selector: 'node[typeId="service"]',
          style: { "background-color": "#2563eb" }
        },
        {
          selector: 'node[typeId="component"]',
          style: { "background-color": "#7c3aed" }
        },
        // External node — a component owned by a DIFFERENT service in the component-layer view.
        // Keeps its type color but gets a dashed outline + reduced fill so it reads as off-scope.
        {
          selector: "node[?external]",
          style: {
            "border-width": 2,
            "border-color": "#94a3b8",
            "border-style": "dashed",
            "background-opacity": 0.4
          }
        },
        // Root emphasis stays last so it wins over the typed colors for the explored object.
        {
          selector: "node[?root]",
          style: { "background-color": "#2563eb", width: 32, height: 32, "border-width": 0 }
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
        },
        // Cross-service edge — a component link whose endpoints are in different services.
        {
          selector: "edge[?crossService]",
          style: {
            "line-style": "dashed",
            "line-color": "#cbd5e1",
            "target-arrow-color": "#cbd5e1"
          }
        }
      ],
      layout: { name: layoutRef.current }
    });
    cy.on("tap", "node", (event) => {
      const typeId = event.target.data("typeId") as string | undefined;
      const external = event.target.data("external") as boolean | undefined;
      const id = event.target.id();
      // A caller-supplied handler (the service layer's drill-into-components) takes precedence over
      // the default click-to-registry-detail navigation.
      if (onNodeTapRef.current) {
        onNodeTapRef.current({ id, typeId, external });
        return;
      }
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
            external: obj?.external ? true : undefined,
            root: rootId && id === rootId ? true : undefined
          }
        };
      }),
      // Only render edges whose endpoints are both in the node set — a stray edge to an
      // un-rendered node would make Cytoscape throw. (Cross-service views must therefore
      // materialize the external target node before the edge will render.)
      ...data.edges
        .filter((edge) => nodeIds.has(edge.fromId) && nodeIds.has(edge.toId))
        .map((edge) => ({
          data: {
            id: edge.id,
            source: edge.fromId,
            target: edge.toId,
            typeId: edge.typeId,
            crossService: edge.crossService ? true : undefined
          }
        }))
    ];
    cy.add(elements);
    cy.layout({ name: layoutRef.current }).run();
  }, [data, rootId]);

  return <div ref={containerRef} className="h-full w-full" data-testid="cytoscape-container" />;
}
