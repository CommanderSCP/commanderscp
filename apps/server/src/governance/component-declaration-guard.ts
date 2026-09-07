import { COMPONENT_SECURITY_PROPERTY_KEY, ComponentSecurityPropertySchema } from "@scp/schemas";
import { badRequest } from "../errors.js";

/** The local author's door for a component's declarations. See docs/governance.md §40. */
export function assertValidComponentSecurityDeclarations(args: {
  typeId: string;
  properties: Record<string, unknown>;
}): void {
  // Only `component` declares. A `security` bag on any other type is not read by the gate
  // (`scan-declared-facts.ts` filters on `type_id`), so refusing it here would reject documents that
  // mean nothing rather than documents that mean the wrong thing.
  if (args.typeId !== "component") return;
  const bag = args.properties[COMPONENT_SECURITY_PROPERTY_KEY];
  // ABSENT IS FINE — the overwhelmingly common shape, and the one every component created before
  // this migration is in. This guard constrains what a declaration MAY SAY; it never requires one.
  if (bag === undefined || bag === null) return;
  const parsed = ComponentSecurityPropertySchema.safeParse(bag);
  if (parsed.success) return;
  const detail = parsed.error.issues
    .map((i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("; ");
  throw badRequest(
    `component 'properties.${COMPONENT_SECURITY_PROPERTY_KEY}' is invalid — ${detail}. ` +
      `A security declaration is exactly {"declarations": {"<key>": "<value>"}} (ADR-0033 §6): ` +
      `keys match /^[a-z][a-z0-9_.-]*$/, values are single-line strings, and no other key is ` +
      `accepted, because a misspelled one would be stored and then read by the gate as no ` +
      `declaration at all.`
  );
}
