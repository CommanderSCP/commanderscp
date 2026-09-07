/** ABSENT — `null` OR `undefined`, never one of the two. See docs/web.md §113. */
export function isAbsent(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

/** THE SERVER'S DECLARED-UNKNOWN LIST, read safely. See docs/web.md §114. */
export function declaredUnknowns(
  carrier: { unknownFields?: string[] | null } | null | undefined
): string[] {
  return carrier?.unknownFields ?? [];
}
