import { z } from "zod";

/**
 * `governance:move` ENFORCEMENT — the contract for the top-down monotone lattice that decides
 * whether a containment MOVE additionally requires the `governance:move` permission at both ends.
 * (docs/proposals/governance-reach-on-containment-move.md §9.2; owner ruling 2026-08-18; the server
 * substrate is drizzle/0083 and `apps/server/src/governance/move-enforcement.ts`.)
 *
 * THE SEMANTICS A CONSUMER MUST KNOW, because none of them are guessable from the field names:
 *
 *  1. ENFORCEMENT IS AN OR, NOT A LOOKUP. A move is governed iff the INSTANCE rung is enabled, or
 *     any object on the moved object's containment chain, or any object on the destination's chain,
 *     carries a rung. So `GET /objects/{id}/governance-move-enforcement` answers about ONE object's
 *     chain, and a move involving it may be governed by the OTHER end even when this read says
 *     `enforced: false`.
 *  2. THE INSTANCE RUNG ACTIVATES; IT DOES NOT PERMIT (owner decision Q1-A). Enabled at the instance
 *     means enforced for every org on the deployment, and no org may disable it. This is the one
 *     place it differs in meaning from the `dependency_subscription_unlock` whose storage shape it
 *     copies — that one unlocks and activates nothing.
 *  3. AN ENABLEMENT ABOVE CANNOT BE UNDONE BELOW. `DELETE …/rungs/{idOrUrn}` answers 409 while any
 *     upper rung (the instance included) is enabled, naming it — because a disable that left every
 *     move under the subtree still enforced would be a successful-looking no-op.
 *  4. `tier` IS THE LITERAL RECORDED AT WRITE TIME and is explainability only. It is never
 *     recomputed on read, so a rung keeps explaining itself as what it was enabled as.
 *  5. NOTHING IS ENFORCED UNTIL A RUNG IS SET. Every deployment ships with no rungs and no instance
 *     row, and `enforced: false` is the answer everywhere in that state.
 */

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
