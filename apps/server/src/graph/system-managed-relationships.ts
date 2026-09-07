/** Relationship types the ENGINE owns end to end. See docs/graph.md §193. */
export const SYSTEM_MANAGED_RELATIONSHIP_TYPE_IDS: ReadonlySet<string> = new Set([
  "approves",
  "coordinates",
  "annotates"
]);

export function isSystemManagedRelationshipType(typeId: string): boolean {
  return SYSTEM_MANAGED_RELATIONSHIP_TYPE_IDS.has(typeId);
}
