/**
 * URN scheme: `urn:scp:{org}:{type}:{slug-path}` (DESIGN.md §4.1). Callers may supply their own
 * URN (federation imports, IaC, deliberate naming); when omitted, one is derived from the
 * object's name so `POST /objects/{type}` never requires the caller to think about it.
 */
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
