import { z } from "zod";

/** The contract for the top-down monotone move lattice. See docs/schemas.md §258. */

/** Which kind of container a rung sits on. `org` is the org ROOT object (ADR-0021 D4 makes it an
 *  ordinary object whose id equals the org id); `containment_domain` is the intra-org domain, NEVER
 *  a trust domain (ADR-0016 terminology). */
export const GovernanceMoveTierSchema = z.enum([
  "org",
  "containment_domain",
  "service",
  "assembly"
]);
export type GovernanceMoveTier = z.infer<typeof GovernanceMoveTierSchema>;

/** One enabled rung. `name` is the subject container's name, carried so a UI, a CLI printer and a
 *  refusal sentence can all name the rung rather than print a bare uuid at somebody. */
export const GovernanceMoveRungSchema = z.object({
  tier: GovernanceMoveTierSchema,
  subjectObjectId: z.string().uuid(),
  name: z.string(),
  enabledAt: z.string(),
  /** Principle 6: the principal that enabled it, stamped from the authenticated subject. */
  enabledByObjectId: z.string().uuid(),
  /** Depth on the walked containment chain — 0 = org root, increasing toward the object. Present
   *  only on the per-object explain read, which is the only response that walks a chain. */
  depth: z.number().int().optional()
});
export type GovernanceMoveRung = z.infer<typeof GovernanceMoveRungSchema>;

/** The explain read for ONE object: is the lattice reaching it, and through which rungs.
 *  `rungs` is ordered org-root-first. See semantics note 1 — a move has two ends. */
export const GovernanceMoveEnforcementSchema = z.object({
  enforced: z.boolean(),
  instance: z.object({ enabled: z.boolean() }),
  rungs: z.array(GovernanceMoveRungSchema)
});
export type GovernanceMoveEnforcement = z.infer<typeof GovernanceMoveEnforcementSchema>;

/** The list read: every rung this org has enabled, plus the instance rung's state, so one call
 *  renders the whole lattice an admin can act on. */
export const GovernanceMoveRungListSchema = z.object({
  instance: z.object({ enabled: z.boolean() }),
  rungs: z.array(GovernanceMoveRungSchema)
});
export type GovernanceMoveRungList = z.infer<typeof GovernanceMoveRungListSchema>;

/** The response to a rung write: the resolved enforcement AT THE SUBJECT after the write, plus the
 *  `decisionId` the write recorded (principle 6 — every governance write explains itself). */
export const GovernanceMoveRungWriteResponseSchema = z.object({
  subjectObjectId: z.string().uuid(),
  tier: GovernanceMoveTierSchema,
  enabled: z.boolean(),
  enforcement: GovernanceMoveEnforcementSchema,
  decisionId: z.string().uuid()
});
export type GovernanceMoveRungWriteResponse = z.infer<typeof GovernanceMoveRungWriteResponseSchema>;

/** The instance rung as the API projects it. `updatedAt` is `null` for the never-set (disabled)
 *  default, which is the state a deployment ships in — that distinguishes "never configured" from
 *  "deliberately turned back off", exactly as the dependency-subscription unlock's does. */
export const GovernanceMoveInstanceRungSchema = z.object({
  enabled: z.boolean(),
  updatedAt: z.string().nullable()
});
export type GovernanceMoveInstanceRung = z.infer<typeof GovernanceMoveInstanceRungSchema>;

/** The operator write. `enabled` is REQUIRED: an omitted flag is a 400 rather than a silent
 *  disable of a deployment-wide switch. */
export const PutGovernanceMoveInstanceRungRequestSchema = z.object({
  enabled: z.boolean()
});
export type PutGovernanceMoveInstanceRungRequest = z.infer<
  typeof PutGovernanceMoveInstanceRungRequestSchema
>;

/** The rung enable body. Empty today and deliberately an object rather than nothing: the enable is
 *  a PUT with a body-shaped future (a note, an expiry), and adding a field to an object is additive
 *  while growing a body from none is not. */
export const PutGovernanceMoveRungRequestSchema = z.object({
  /** Why the rung was enabled — carried into the Decision, so the enablement explains itself. */
  note: z.string().max(1000).optional()
});
export type PutGovernanceMoveRungRequest = z.infer<typeof PutGovernanceMoveRungRequestSchema>;
