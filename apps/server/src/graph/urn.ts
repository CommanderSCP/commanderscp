/** URN scheme: `urn:scp:{org}:{type}:{slug-path}`. See docs/graph.md §197. */
export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "object";
}

export function deriveUrn(orgSlug: string, typeId: string, name: string, suffix?: string): string {
  const base = `urn:scp:${orgSlug}:${typeId}:${slugify(name)}`;
  return suffix ? `${base}-${suffix}` : base;
}
