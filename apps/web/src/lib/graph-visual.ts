/** Graph visual encoding. See docs/web.md §121. */

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

/** Categorical fill palette. See docs/web.md §122. */
export const GROUP_PALETTE = [
  "#2563eb",
  "#7c3aed",
  "#0d9488",
  "#c026d3",
  "#0891b2",
  "#4f46e5",
  "#9333ea",
  "#0284c7",
  "#7e22ce",
  "#1d4ed8" // deep blue
];

/** Nodes with no resolvable group (nothing contains them in this view). */
export const UNGROUPED_COLOR = "#64748b";

/** Which node's colour to inherit, given what is focused. See docs/web.md §123. */
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

/** Stable group -> colour assignment. See docs/web.md §124. */
export function assignGroupColors(groupIds: Iterable<string>): Map<string, string> {
  const unique = [...new Set(groupIds)].sort();
  const colors = new Map<string, string>();
  unique.forEach((id, i) => {
    colors.set(id, GROUP_PALETTE[i % GROUP_PALETTE.length]!);
  });
  return colors;
}
