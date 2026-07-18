/**
 * Small legend for the two-layer graph explorer (coordination-ui-views.md § two-layer graph).
 * Keeps the node/edge coloring in `GraphCanvas` legible without cramming a key into the canvas.
 */
export interface LegendNodeEntry {
  label: string;
  /** Swatch fill; matches a `GraphCanvas` typed-node color. */
  color: string;
  /** Draw the swatch with a dashed outline + hollow fill (external nodes). */
  dashed?: boolean;
}

export interface LegendEdgeEntry {
  label: string;
  dashed?: boolean;
}

export function GraphLegend({
  nodes,
  edges
}: {
  nodes: LegendNodeEntry[];
  edges?: LegendEdgeEntry[];
}): React.JSX.Element {
  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-slate-600"
      data-testid="graph-legend"
    >
      {nodes.map((n) => (
        <span key={n.label} className="flex items-center gap-1.5">
          <span
            className="inline-block h-3 w-3 rounded-full"
            style={
              n.dashed
                ? {
                    backgroundColor: "transparent",
                    border: `2px dashed ${n.color}`
                  }
                : { backgroundColor: n.color }
            }
          />
          {n.label}
        </span>
      ))}
      {edges?.map((e) => (
        <span key={e.label} className="flex items-center gap-1.5">
          <span
            className="inline-block w-5"
            style={{
              borderTop: `2px ${e.dashed ? "dashed" : "solid"} #94a3b8`
            }}
          />
          {e.label}
        </span>
      ))}
    </div>
  );
}
