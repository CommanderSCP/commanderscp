/** Types whose identity is a pair of other objects. See docs/graph.md §131. */
export const PAIR_BOUND_OBJECT_TYPE_IDS: ReadonlySet<string> = new Set(["placement"]);

export function isPairBoundObjectType(type: string): boolean {
  return PAIR_BOUND_OBJECT_TYPE_IDS.has(type);
}
