import { Hexagon, Pentagon, Star, type LucideIcon } from "lucide-react";
import { shapeForType } from "../../lib/graph-visual";
import { AssemblyStack, ComponentCrate, ServiceGuidon } from "../icons/catalog-marks";
import { CommanderStar, OutpostFort } from "../icons/federation-roles";

/**
 * Legend for the graph views. Keeps the node/edge encoding legible without cramming a key into the
 * canvas.
 *
 * TWO CHANNELS, TWO SECTIONS. Shape says what a node IS and is fixed; colour says which group it
 * belongs to and is recomputed per view, so a colour swatch per type would be a lie. `shapes`
 * therefore renders neutral-grey glyphs (the shape is the message, the fill is not), and `note`
 * carries the one sentence explaining what colour means in THIS view.
 *
 * Star/hexagon/pentagon were previously approximated with a `clip-path` polygon on a plain div —
 * close enough to read at a glance but visibly not the real shape. Those three now render the
 * actual lucide glyph (§4 Group D); circle and the other clip-path-drawable shapes stay divs since
 * a CSS shape IS the real shape for them (no approximation to fix).
 */
const SHAPE_ICON: Partial<Record<string, LucideIcon>> = {
  hexagon: Hexagon,
  star: Star,
  pentagon: Pentagon
};

/** Types that carry a hand-drawn mark (mirrors lib/graph-glyphs.ts) — the legend shows the mark
 *  itself, since that is what the canvas now paints inside the node. */
const TYPE_MARK: Partial<Record<string, LucideIcon>> = {
  service: ServiceGuidon,
  assembly: AssemblyStack,
  component: ComponentCrate,
  organization: CommanderStar,
  outpost: OutpostFort
};
export interface LegendNodeEntry {
  label: string;
  /** Swatch fill. Only meaningful for entries whose colour is genuinely fixed (external, health). */
  color: string;
  /** Draw the swatch with a dashed outline + hollow fill (external nodes). */
  dashed?: boolean;
}

export interface LegendShapeEntry {
  label: string;
  /** Object type — resolved through the same map the canvas uses, so the two cannot drift. */
  typeId: string;
}

export interface LegendEdgeEntry {
  label: string;
  dashed?: boolean;
}

/** Cytoscape shape name -> a small CSS-drawable equivalent. Shapes covered by `SHAPE_ICON` above
 *  never reach this function's star/hexagon/pentagon cases any more, but the cases are harmless
 *  dead branches to leave in place — a future shape can still fall back to a clip-path div. */
function shapeStyle(shape: string): React.CSSProperties {
  const base: React.CSSProperties = { backgroundColor: "#64748b" };
  switch (shape) {
    case "round-rectangle":
      return { ...base, borderRadius: 3 };
    case "hexagon":
      return { ...base, clipPath: "polygon(25% 0,75% 0,100% 50%,75% 100%,25% 100%,0 50%)" };
    case "diamond":
      return { ...base, clipPath: "polygon(50% 0,100% 50%,50% 100%,0 50%)" };
    case "star":
      return {
        ...base,
        clipPath:
          "polygon(50% 0,61% 35%,98% 35%,68% 57%,79% 91%,50% 70%,21% 91%,32% 57%,2% 35%,39% 35%)"
      };
    case "barrel":
      return { ...base, borderRadius: "50% / 25%" };
    case "pentagon":
      return { ...base, clipPath: "polygon(50% 0,100% 38%,82% 100%,18% 100%,0 38%)" };
    case "rhomboid":
      return { ...base, clipPath: "polygon(25% 0,100% 0,75% 100%,0 100%)" };
    case "tag":
      return { ...base, clipPath: "polygon(0 0,70% 0,100% 50%,70% 100%,0 100%)" };
    case "vee":
      return { ...base, clipPath: "polygon(0 0,50% 60%,100% 0,50% 100%)" };
    default:
      return { ...base, borderRadius: "9999px" };
  }
}

export function GraphLegend({
  shapes,
  nodes,
  edges,
  note
}: {
  shapes?: LegendShapeEntry[];
  nodes?: LegendNodeEntry[];
  edges?: LegendEdgeEntry[];
  note?: string;
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-end gap-1" data-testid="graph-legend">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-slate-600">
        {shapes?.map((s) => {
          const shape = shapeForType(s.typeId);
          const Icon = TYPE_MARK[s.typeId] ?? SHAPE_ICON[shape];
          return (
            <span key={s.label} className="flex items-center gap-1.5">
              {Icon ? (
                <Icon
                  className="size-3 text-slate-500"
                  strokeWidth={2}
                  aria-hidden="true"
                />
              ) : (
                <span className="inline-block h-3 w-3" style={shapeStyle(shape)} />
              )}
              {s.label}
            </span>
          );
        })}
        {nodes?.map((n) => (
          <span key={n.label} className="flex items-center gap-1.5">
            <span
              className="inline-block h-3 w-3 rounded-full"
              style={
                n.dashed
                  ? { backgroundColor: "transparent", border: `2px dashed ${n.color}` }
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
              style={{ borderTop: `2px ${e.dashed ? "dashed" : "solid"} #94a3b8` }}
            />
            {e.label}
          </span>
        ))}
      </div>
      {note && <p className="text-[11px] text-slate-400">{note}</p>}
    </div>
  );
}
