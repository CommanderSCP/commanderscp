/**
 * Graph visual encoding — SHAPE says what a node IS, COLOR says which group it BELONGS TO.
 *
 * Keeping those two channels independent is the whole design. Type was previously encoded as
 * colour, which meant colour could say only one thing at a time and a graph of eight components
 * was eight identical purple dots. Shape is a stable, absolute property of a node (a component is
 * a component wherever you look at it), so it belongs on the channel that never changes; group
 * membership is RELATIVE to what you are currently looking at, so it belongs on the channel that
 * is recomputed per view.
 */

/** Cytoscape node shapes, containers angular and leaves round, descending by rung. */
export const NODE_SHAPE_BY_TYPE: Record<string, string> = {
  organization: "star",
  domain: "diamond",
  service: "round-rectangle",
  assembly: "hexagon",
  component: "ellipse",
  "deployment-target": "barrel",
  placement: "tag",
  change: "rhomboid",
  campaign: "pentagon",
  team: "vee",
  group: "vee",
  user: "vee",
  "service-account": "vee"
};

export const DEFAULT_NODE_SHAPE = "ellipse";

/** Size descends with the containment rung so the hierarchy reads even before colour. */
export const NODE_SIZE_BY_TYPE: Record<string, number> = {
  organization: 46,
  domain: 42,
  service: 40,
  assembly: 32,
  component: 24,
  "deployment-target": 28
};

export const DEFAULT_NODE_SIZE = 26;

export function shapeForType(typeId: string | undefined): string {
  return (typeId && NODE_SHAPE_BY_TYPE[typeId]) || DEFAULT_NODE_SHAPE;
}

export function sizeForType(typeId: string | undefined): number {
  return (typeId && NODE_SIZE_BY_TYPE[typeId]) || DEFAULT_NODE_SIZE;
}

/**
 * Categorical fill palette. Deliberately avoids the health ring's green/amber/red so a fill and a
 * ring on the same node are never confusable — health is an overlay on the BORDER, group is the
 * FILL, and the two must stay readable together.
 */
export const GROUP_PALETTE = [
  "#2563eb", // blue
  "#7c3aed", // violet
  "#0d9488", // teal
  "#c026d3", // fuchsia
  "#0891b2", // cyan
  "#4f46e5", // indigo
  "#9333ea", // purple
  "#0284c7", // sky
  "#7e22ce", // deep purple
  "#1d4ed8" // deep blue
];

/** Nodes with no resolvable group (nothing contains them in this view). */
export const UNGROUPED_COLOR = "#64748b";

/**
 * Which node's colour a node should inherit, GIVEN what is currently being looked at.
 *
 * The rule the owner specified (2026-08-10): colour is decided at the highest level IN SCOPE.
 * Looking at the org, every service is a different colour; looking at a service, each assembly or
 * directly-held component is a different colour; looking at an assembly, each component is. All
 * three are the same rule — **walk `contains` upward until you reach a child of the thing you are
 * looking at, and take that ancestor's identity** — so this is one function rather than three
 * special cases, and a future rung inherits it for free.
 *
 * With no `rootId` (an org-level map) the walk goes all the way to the topmost ancestor present,
 * which for a graph of bare services is each service itself.
 *
 * Cycles cannot occur through `contains` (the server refuses `assembly -> assembly` outright, and
 * a component has exactly one parent by unique index), but the walk is still bounded — a
 * hand-authored relationship type could in principle produce one, and a hung layout is a worse
 * failure than a mis-coloured node.
 */
export function deriveGroupIds(
  objects: { id: string }[],
  edges: { fromId: string; toId: string; typeId?: string }[],
  rootId?: string
): Map<string, string> {
  const parentOf = new Map<string, string>();
  for (const e of edges) {
    if (e.typeId === "contains") parentOf.set(e.toId, e.fromId);
  }

  const groups = new Map<string, string>();
  for (const o of objects) {
    let current = o.id;
    let guard = 0;
    while (guard++ < 16) {
      const parent = parentOf.get(current);
      // No parent in this view, or the parent IS what we're looking at -> `current` is the rung
      // whose identity decides the colour.
      if (!parent || parent === rootId) break;
      current = parent;
    }
    groups.set(o.id, current);
  }
  return groups;
}

/**
 * Stable group -> colour assignment. Sorted by group id so the same graph renders the same colours
 * across reloads: keying off insertion order would repaint the whole graph whenever the API
 * returned rows in a different order, which reads as though something changed when nothing did.
 */
export function assignGroupColors(groupIds: Iterable<string>): Map<string, string> {
  const unique = [...new Set(groupIds)].sort();
  const colors = new Map<string, string>();
  unique.forEach((id, i) => {
    colors.set(id, GROUP_PALETTE[i % GROUP_PALETTE.length]!);
  });
  return colors;
}
