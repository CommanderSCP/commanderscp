import { z } from "zod";

/**
 * INFRASTRUCTURE BUILDOUT FOR AN ENVIRONMENT (M28.3, ADR-0056) — the part of the contract the
 * server, the CLI and the UI all have to agree on.
 *
 * An `infrastructure` change driven through Argo Workflows is one of two PHASES, and the phase is
 * a fact about the change, not about the binding:
 *
 *   - a PLAN change (no declaration) runs the bound plan template; its digest and tally come back
 *     as `observed.plan` evidence on the wave target, and ACCEPTING the change approves that plan;
 *   - an APPLY change declares `properties.infrastructure.applyPlan = <plan change id>`, and the
 *     server triggers the apply template only for a plan that is accepted, still the latest plan
 *     at that target, and not already applied.
 *
 * Carried on `properties` the way `properties.recipe` (ADR-0041) and `properties.ops` (ADR-0052)
 * are: a change declares what it is, and a new concept arrives as data on existing objects rather
 * than as a table (charter principle 2).
 */
export const INFRASTRUCTURE_DECLARATION_PROPERTY = "infrastructure";

export const InfrastructureChangeDeclarationSchema = z
  .object({
    /** The PLAN change whose accepted plan this change applies. */
    applyPlan: z.string().uuid()
  })
  .strict();
export type InfrastructureChangeDeclaration = z.infer<typeof InfrastructureChangeDeclarationSchema>;

/** The shipped catalog pair (deploy/helm-bundled/templates/argo-workflows-catalog.yaml). */
export const INFRA_CATALOG_PLAN_TEMPLATE = "scp-infra-plan-v1";
export const INFRA_CATALOG_APPLY_TEMPLATE = "scp-infra-apply-v1";

/** WHICH TEMPLATE APPLIES WHAT A PLAN TEMPLATE PLANNED. An `infrastructure` binding names its PLAN
 *  template; the apply template is its `-apply` sibling (`scp-infra-plan-v1` → `scp-infra-apply-v1`,
 *  `acme-net-plan` → `acme-net-apply`). A convention, deliberately, rather than a second field on
 *  the binding: one binding per (target, Type) is the model, and a binding that could name any
 *  apply template would let a PLAN change's trigger be pointed at an apply. `null` when the name
 *  has no `-plan` segment to swap — the server refuses that binding with a sentence. */
export function infraApplyTemplateFor(planTemplate: string): string | null {
  const m = /^(.+)-plan(-v[0-9]+)?$/.exec(planTemplate);
  return m ? `${m[1]}-apply${m[2] ?? ""}` : null;
}

/** An execution system's SOURCE-REPO ALLOWLIST (owner ruling R1, 2026-09-24): which repositories
 *  may run with that system's credentials. Written only with `secret:write` at the org root. */
export const SourceAllowlistEntrySchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]+\/([A-Za-z0-9._-]+|\*)$/, "an entry is 'owner/name' or 'owner/*'");

export const PutSourceAllowlistRequestSchema = z.strictObject({
  repos: z.array(SourceAllowlistEntrySchema).max(200)
});
export type PutSourceAllowlistRequest = z.infer<typeof PutSourceAllowlistRequestSchema>;

export const SourceAllowlistSchema = z.object({
  executionSystemId: z.string().uuid(),
  /** Sorted and deduplicated. Empty — or never set — means nothing may run with this system. */
  repos: z.array(z.string()),
  recordedBySubjectId: z.string().uuid().nullable(),
  updatedAt: z.string().datetime().nullable()
});
export type SourceAllowlist = z.infer<typeof SourceAllowlistSchema>;
