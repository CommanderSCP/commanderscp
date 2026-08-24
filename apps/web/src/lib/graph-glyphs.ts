import {
  ASSEMBLY_STACK_PATHS,
  COMPONENT_CRATE_PATHS,
  SERVICE_GUIDON_PATHS
} from "../components/icons/catalog-marks";
import { COMMANDER_STAR_PATHS, OUTPOST_FORT_PATHS } from "../components/icons/federation-roles";

/**
 * Cytoscape node GLYPHS — the same hand-drawn marks the rest of the UI wears (catalog-marks.tsx,
 * federation-roles.tsx), rasterized into `data:` SVG URIs the canvas can paint inside a node.
 *
 * Cytoscape draws to <canvas>, so it cannot render a React component; `background-image` with an
 * encoded SVG string is the sanctioned path. The path data is IMPORTED from the icon modules —
 * never re-drawn here — so the sidebar icon, the role badge and the graph node are always the
 * same drawing (the wave-target lesson: a slot with its own copy of the truth drifts).
 *
 * Encoding note: a data URI is not a network fetch — the SVG travels inside the bundle, so the
 * air-gap posture is untouched.
 *
 * The glyph SUPPLEMENTS the existing encodings, never replaces them: shape still says type at a
 * distance and colour still says group (graph-visual.ts); the white glyph makes the type legible
 * up close without hovering. Types without a mark simply render as before — an absent glyph is
 * "no mark exists", not an error.
 */

import type { IconNode } from "lucide-react";

type IconNodeLike = IconNode;

const TYPE_MARK_PATHS: Record<string, IconNodeLike> = {
  service: SERVICE_GUIDON_PATHS,
  assembly: ASSEMBLY_STACK_PATHS,
  component: COMPONENT_CRATE_PATHS,
  organization: COMMANDER_STAR_PATHS,
  outpost: OUTPOST_FORT_PATHS
  // No `retrans-relay` entry: census (grep -rna 'retrans-relay' across the whole repo) found the
  // string only as the filename `retrans-relay.ts` and its `retrans-relay-*` Decision kinds — no
  // server code ever creates a graph-object typeId `retrans-relay` (`outpost-binding.ts` mints only
  // `outpost`, and refuses to bind one to a retrans subject at all). A mark with nothing to draw for
  // is dead code, not an honest absence.
};

function serializeNode(node: IconNodeLike): string {
  return node
    .map(([tag, attrs]) => {
      const attributes = Object.entries(attrs as Record<string, string | number>)
        .filter(([name]) => name !== "key")
        .map(([name, value]) => `${name}="${value}"`)
        .join(" ");
      return `<${tag} ${attributes}/>`;
    })
    .join("");
}

/**
 * The mark for a graph-object type as an encoded SVG data URI, white-stroked to sit on the node's
 * group-colour fill. `undefined` when the type has no mark — callers leave the node untouched.
 */
export function glyphForType(typeId: string | undefined): string | undefined {
  if (!typeId) return undefined;
  const node = TYPE_MARK_PATHS[typeId];
  if (!node) return undefined;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ` +
    `stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">` +
    `${serializeNode(node)}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/** Exported for the legend and tests — which types carry a mark at all. */
export function hasGlyph(typeId: string | undefined): boolean {
  return !!typeId && typeId in TYPE_MARK_PATHS;
}
