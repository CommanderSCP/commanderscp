import { COMPONENT_SECURITY_PROPERTY_KEY, ComponentSecurityPropertySchema } from "@scp/schemas";
import { badRequest } from "../errors.js";

/**
 * M22.5 (ADR-0033 §6 guard 3; owner decision D2) — THE LOCAL AUTHOR'S DOOR for a component's
 * security declarations.
 *
 * ===========================================================================================
 * WHY THIS EXISTS SEPARATELY FROM THE REGISTERED `property_schema`
 * ===========================================================================================
 * drizzle/0067 registers `component.properties.security.declarations` as TYPED BUT OPEN, and it has
 * to be: `federation/import-repo.ts`'s `object_upsert` branch Ajv-validates an incoming object
 * against the registered schema with NO try/catch, so ONE rejection aborts a peer's ENTIRE signed
 * bundle and wedges the channel. A closed schema in the registry would turn every future property
 * addition — including one made by a NEWER peer talking to an OLDER receiver — into a fail-closed
 * version-skew hazard.
 *
 * So the strictness moves HERE, to the local author's door, where a refusal costs one 400 and
 * nobody's bundle. That is 0043's "strict at the operator's door, open on the wire" rule, and
 * ADR-0033 §6 names `z.strictObject` on the request body as the specific mechanism.
 *
 * ===========================================================================================
 * WHY IT IS INSTALLED AT `objects-repo.ts` AND NOT IN `routes/components.ts`
 * ===========================================================================================
 * BUILD_AND_TEST.md §4.4's rule, and the measured precedent right beside it: ADR-0032 §6a's
 * authoring guard was installed at ONE typed route and a filterless census then found THREE more
 * doors reaching `createObject` with a free-form `typeId` and free-form `properties` — IaC apply,
 * federation hand-fill, and the federation overlay route. Installing this at the component routes
 * would repeat that exactly, and the fourth door would miss it again. `createObject`/`updateObject`
 * are the one choke point every LOCAL write door funnels through, so that is where it goes, sharing
 * the `federationImport` exemption and its two-module census (`import-repo.ts` and
 * `handfill-repo.ts`) with the guards already installed there.
 *
 * ===========================================================================================
 * WHAT A REFUSAL ACTUALLY PREVENTS — it is not a typo check
 * ===========================================================================================
 * `{"declarationz": {...}}` or `{"declarations": {...}, "egress": "none"}` would otherwise be stored
 * happily, read by the gate as NO declarations, and the component owner would believe they had
 * declared something. For a LOOSENING that mistake is always fail-closed, so it would never show up
 * as a security incident — it would show up as a rule that mysteriously does not fire, and the author
 * would have no way to discover why. A refusal at the door is the only outcome that leaves nobody
 * with a false belief.
 *
 * NEVER `labels`, and that is an absolute rather than a preference: labels are tenant-writable, carry
 * no schema, have no reserved namespace, and are already a live evasion path for selector-scoped
 * policies (PR #247). Nothing in this file or in the gate reads them.
 */
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
