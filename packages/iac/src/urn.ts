/** Tiny vendored copy of `apps/server/src/graph/urn.ts`'s `slugify`. See docs/iac.md §318. */
export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "resource";
}

/** The deterministic urn for a construct without an explicit one. See docs/iac.md §319. */
export function deriveConstructUrn(stackName: string, typeId: string, constructId: string): string {
  return `urn:scp:${slugify(stackName)}:${typeId}:${slugify(constructId)}`;
}
