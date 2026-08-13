import { useEffect, useRef } from "react";
import cytoscape, { type Core, type ElementDefinition, type LayoutOptions } from "cytoscape";
import { useNavigate } from "@tanstack/react-router";
import { Maximize, ZoomIn, ZoomOut } from "lucide-react";
import { REGISTRIES } from "../../lib/registries";
import {
  assignGroupColors,
  deriveGroupIds,
  shapeForType,
  sizeForType,
  UNGROUPED_COLOR
} from "../../lib/graph-visual";
import { glyphForType } from "../../lib/graph-glyphs";
import { Button } from "../ui/button";

export interface GraphCanvasNode {
  id: string;
  name: string;
  typeId: string;
  /** Marks a node that lives OUTSIDE the current scope — e.g. a component owned by a different
   *  service in the component-layer view. Rendered with a dashed outline. Backward-compatible:
   *  undefined = the normal solid treatment. */
  external?: boolean;
  /** OPTIONAL pushed health (observe-enrichment signal 4) — rendered as a colored border ring when
   *  the health overlay is toggled on. Undefined = no health fetched/toggled; the node renders
   *  exactly as before (backward-compatible). `unknown` (or no pushed record) renders grey — SCP
   *  never fabricates a health it wasn't given. */
  health?: "healthy" | "degraded" | "down" | "unknown";
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
/** A graph smaller than the viewport should render at life size, not be blown up to fill it. */
const MAX_AUTOFIT_ZOOM = 1.4;

/** How much one click of the zoom in/out control changes the zoom level. */
const ZOOM_STEP_FACTOR = 1.25;

/**
 * FIT, THEN CLAMP — shared by the auto-fit-on-layout effect and the Maximize control (§4 Group D)
 * so the two never drift into two different "fit" behaviours. `fit` frames the graph with padding;
 * the clamp stops a small graph being magnified past life size, and re-centres after clamping so
 * the content stays put rather than drifting to a corner.
 */
function fitAndClamp(cy: Core): void {
  cy.fit(undefined, 48);
  if (cy.zoom() > MAX_AUTOFIT_ZOOM) {
    cy.zoom(MAX_AUTOFIT_ZOOM);
    cy.center();
  }
}

/**
 * Per-layout spacing. Cytoscape's defaults are tuned for dense graphs and pack a handful of nodes
 * into a tight cluster where the labels (rendered BELOW each node) overlap each other and the
 * neighbouring shapes — so a five-service org map was unreadable despite having room to spare.
 * These widen the spacing enough for a label to sit under its own node; `avoidOverlap`/`nodeOverlap`
 * stop shapes colliding outright.
 */
const LAYOUT_OPTIONS: Record<string, Record<string, unknown>> = {
  concentric: { minNodeSpacing: 70, avoidOverlap: true, padding: 40 },
  cose: { idealEdgeLength: 130, nodeRepulsion: 14000, nodeOverlap: 24, padding: 40, animate: false },
  breadthfirst: { spacingFactor: 1.5, padding: 40 },
  grid: { avoidOverlap: true, spacingFactor: 1.4, padding: 40 },
  circle: { avoidOverlap: true, spacingFactor: 1.3, padding: 40 }
};

/**
 * Cytoscape types `LayoutOptions` as a UNION of per-layout option shapes keyed on a literal
 * `name`, so a config assembled from a runtime string cannot be narrowed to one member. The cast
 * is at the boundary and the option bag above is the only thing that reaches it; an unknown layout
 * name falls back to bare padding rather than passing something Cytoscape would reject.
 */
function layoutConfig(name: string): LayoutOptions {
  return { name, ...(LAYOUT_OPTIONS[name] ?? { padding: 40 }) } as unknown as LayoutOptions;
}

export function GraphCanvas({
  data,
  rootId,
  layout,
  onNodeTap
}: GraphCanvasProps): React.JSX.Element {
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
        // GLYPH = type up close (lib/graph-glyphs.ts): the same hand-drawn mark the sidebar and
        // badges wear, white-stroked over the group fill. Attribute selector, so nodes whose type
        // has no mark match nothing and render exactly as before.
        {
          selector: "node[glyph]",
          style: {
            "background-image": "data(glyph)",
            "background-fit": "none",
            "background-width": "58%",
            "background-height": "58%",
            "background-clip": "node"
          }
        },
        // SHAPE = type, COLOUR = group (lib/graph-visual.ts). Both are computed per node and
        // handed to Cytoscape as data, so there is one style rule instead of one per type — a new
        // object type gets a shape by adding a row to `NODE_SHAPE_BY_TYPE`, not a selector here.
        // This replaced fixed per-type colours (service blue, component purple), which spent the
        // colour channel on something shape already says and left a graph of N components as N
        // identical dots.
        {
          selector: "node",
          style: {
            shape: "data(shape)" as unknown as cytoscape.Css.NodeShape,
            "background-color": "data(groupColor)",
            width: "data(size)",
            height: "data(size)"
          }
        },
        // External node — a component owned by a DIFFERENT service in the component-layer view.
        // Keeps its type color but gets a dashed outline + reduced fill so it reads as off-scope.
        {
          selector: "node[?external]",
          style: {
            "border-width": 2,
            "border-color": "#94a3b8",
            "border-style": "dashed",
            "background-opacity": 0.4,
            "background-image-opacity": 0.4
          }
        },
        // Health overlay (observe-enrichment signal 4) — a colored border ring keyed on the
        // OPTIONAL `health` node-data field, using the same attribute-selector technique as
        // `node[?external]`/`node[?root]`. A `node[health=...]` selector out-ranks the base `node`
        // rule and is undefined-safe: nodes without health (overlay off, or nothing pushed) match
        // none of these and render exactly as before. Grey = unknown/no push (never fabricated).
        {
          selector: 'node[health="healthy"]',
          style: { "border-width": 4, "border-color": "#16a34a", "border-opacity": 1 }
        },
        {
          selector: 'node[health="degraded"]',
          style: { "border-width": 4, "border-color": "#d97706", "border-opacity": 1 }
        },
        {
          selector: 'node[health="down"]',
          style: { "border-width": 4, "border-color": "#dc2626", "border-opacity": 1 }
        },
        {
          selector: 'node[health="unknown"]',
          style: { "border-width": 4, "border-color": "#94a3b8", "border-opacity": 1 }
        },
        // Root emphasis. Deliberately NOT a fill override any more: fill now means "which group",
        // and repainting the root would state a group membership it does not have. A dark ring and
        // a bolder label say "this is what you are looking at" without touching the colour channel.
        {
          selector: "node[?root]",
          style: {
            "border-width": 3,
            "border-color": "#0f172a",
            "border-style": "solid",
            "font-weight": "bold",
            "font-size": 11
          }
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
      layout: layoutConfig(layoutRef.current),
      minZoom: 0.2,
      maxZoom: 2.5
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

    // Colour groups are RELATIVE to what is being looked at, so they are recomputed on every data
    // change rather than baked into the node set by the caller — every view gets the owner's rule
    // (colour decided at the highest level in scope) without each page re-implementing it.
    const groupIds = deriveGroupIds(
      [...nodeIds].map((id) => ({ id })),
      data.edges,
      rootId
    );
    const groupColors = assignGroupColors(groupIds.values());

    const elements: ElementDefinition[] = [
      ...[...nodeIds].map((id) => {
        const obj = byId.get(id);
        return {
          data: {
            id,
            label: obj?.name ?? id.slice(0, 8),
            typeId: obj?.typeId,
            shape: shapeForType(obj?.typeId),
            size: sizeForType(obj?.typeId) + (rootId && id === rootId ? 8 : 0),
            // An external node belongs to a group OUTSIDE this view by definition, so it never
            // takes a palette colour — colouring it would imply a membership the view cannot see.
            groupColor: obj?.external
              ? UNGROUPED_COLOR
              : (groupColors.get(groupIds.get(id) ?? id) ?? UNGROUPED_COLOR),
            glyph: glyphForType(obj?.typeId),
            external: obj?.external ? true : undefined,
            health: obj?.health,
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
    const runLayout = cy.layout(layoutConfig(layoutRef.current));
    // Cytoscape's default is to fill the viewport with whatever it was given, so a two-node graph
    // rendered as two enormous circles with everything else empty — the nodes were not oversized,
    // the ZOOM was. See `fitAndClamp` above (also reused by the Maximize control).
    runLayout.one("layoutstop", () => fitAndClamp(cy));
    runLayout.run();
  }, [data, rootId]);

  function handleZoomStep(factor: number): void {
    const cy = cyRef.current;
    const container = containerRef.current;
    if (!cy || !container) return;
    const level = Math.min(Math.max(cy.zoom() * factor, cy.minZoom()), cy.maxZoom());
    // Zoom centred on the viewport, not the graph's top-left origin — `cy.zoom(level)` alone keeps
    // pan fixed, which walks the content out from under a corner-anchored control.
    cy.zoom({
      level,
      renderedPosition: { x: container.clientWidth / 2, y: container.clientHeight / 2 }
    });
  }

  function handleFit(): void {
    const cy = cyRef.current;
    if (cy) fitAndClamp(cy);
  }

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" data-testid="cytoscape-container" />
      {/* Zoom controls (§4 Group D) — a separate DOM subtree layered on top via `absolute`, not a
       *  child of the Cytoscape mount, so a click here can never reach Cytoscape's own drag/pan
       *  listeners underneath. */}
      <div className="absolute right-2 top-2 flex gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          icon={ZoomIn}
          aria-label="Zoom in"
          onClick={() => handleZoomStep(ZOOM_STEP_FACTOR)}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          icon={ZoomOut}
          aria-label="Zoom out"
          onClick={() => handleZoomStep(1 / ZOOM_STEP_FACTOR)}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          icon={Maximize}
          aria-label="Fit to screen"
          onClick={handleFit}
        />
      </div>
    </div>
  );
}
