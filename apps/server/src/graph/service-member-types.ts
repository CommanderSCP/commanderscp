/** Object types that MUST belong to a service (M12 P5a). See docs/graph.md §191. */
export const SERVICE_MEMBER_OBJECT_TYPE_IDS: ReadonlySet<string> = new Set(["component"]);

export function isServiceMemberObjectType(type: string): boolean {
  return SERVICE_MEMBER_OBJECT_TYPE_IDS.has(type);
}
