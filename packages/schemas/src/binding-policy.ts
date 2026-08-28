import { z } from "zod";
import { ExecutorTypeSchema } from "./executors.js";

/**
 * THE `executorBinding` POLICY EFFECT (ADR-0046 §4; team-pipeline-iac §6, D4, §14 res 2 and 7).
 *
 * ================================================================================================
 * WHAT THIS IS FOR: TEAMS AUTHOR THE WHAT, DOMAINS AUTHOR THE HOW
 * ================================================================================================
 * A team's stack declares services, components, placements and topologies — ordinary graph objects
 * that federate. It does NOT declare which execution system runs them, and it cannot: ADR-0031
 * keeps `executor_bindings` domain-local because that is where credentials and executor addresses
 * live, and the commander must not hold either.
 *
 * So each domain declares, once, which of ITS execution systems serves which targets for which
 * Type. That declaration is a policy EFFECT rather than a new object type, following `scanThreshold`
 * (ADR-0016) and `dependencySubscription` (ADR-0032 §3a): `policy` is built-in on every instance and
 * its upsert shares the importer's `object_upsert` case, so nothing new has to reach a
 * not-yet-migrated outpost. A domain-local reconciler joins the federated WHAT against this local
 * HOW and materializes the binding rows.
 *
 * ================================================================================================
 * THE TEST LANE, AND WHY IT FALLS BACK RATHER THAN DEFAULTS (§14 resolution 7)
 * ================================================================================================
 * Test hooks (D11) should be able to run somewhere other than the deploy executor — a dedicated
 * Argo Workflows instance, typically. That is the `test` lane. A domain that does not declare one
 * FALLS BACK to the build lane, which is what makes the lane additive: an estate that never thinks
 * about lanes behaves exactly as it does today, and one that does gets separation by writing a
 * single extra policy line.
 *
 * FALLBACK IS NOT THE SAME AS A DEFAULT, and the difference is the whole point of §14 res 2's
 * "unbound and loud": falling back means "the build lane's answer, explicitly, because you declared
 * no test lane" — a real declaration, resolvable, attributable to a policy someone wrote. A DEFAULT
 * would mean "some org-tier executor nobody named", which this design refuses to have: a missing
 * (target, Type) policy dispatches NOTHING and says so.
 */

/**
 * Which lane a binding serves. `build` is the ordinary lane every existing binding is in; `test`
 * carries test-hook runs when a domain separates them.
 *
 * A CLOSED ENUM HERE IS SAFE, unlike in a registered JSON Schema on the wire: this type governs the
 * AUTHORING surface, and the policy document itself is validated by the schema a migration
 * registers. See `pipeline-behaviors.ts`'s wave-gate note for the case where a closed enum on the
 * wire would wedge a peer — the same care applies to the document schema, not to this.
 */
export const ExecutorLaneSchema = z.enum(["build", "test"]);
export type ExecutorLane = z.infer<typeof ExecutorLaneSchema>;

/**
 * One `executorBinding` effect: which local execution system serves this scope, for which Type, in
 * which lane.
 *
 * `executionSystemUrn` is a URN rather than an id because the policy document is authored by a
 * human in a domain HOW stack and must survive the object being recreated — the same reason
 * manifest entries address by URN everywhere else.
 */
export const ExecutorBindingEffectSchema = z.object({
  executionSystemUrn: z.string().min(1).max(512),
  /** The routing Type this binding serves (ADR-0007). A target legitimately has several. */
  type: ExecutorTypeSchema,
  /**
   * @default "build" — and DECLARED explicitly by every authoring surface that has one, per D8's
   * inference-at-synth/explicitness-at-apply rule. The default lives here only so a
   * hand-authored document that predates lanes keeps its meaning.
   */
  lane: ExecutorLaneSchema.optional(),
  /** Executor-specific target identifier (`trigger().targetRef`), when the local name differs from
   *  the graph object's. Mirrors `executor_bindings.external_ref`. */
  externalRef: z.string().min(1).max(512).optional()
});
export type ExecutorBindingEffect = z.infer<typeof ExecutorBindingEffectSchema>;

/** The effect as it appears inside a policy document's `effects` array. */
export const ExecutorBindingPolicyEffectSchema = z.object({
  executorBinding: ExecutorBindingEffectSchema
});
export type ExecutorBindingPolicyEffect = z.infer<typeof ExecutorBindingPolicyEffectSchema>;

export function isExecutorBindingPolicyEffect(
  effect: unknown
): effect is ExecutorBindingPolicyEffect {
  return typeof effect === "object" && effect !== null && "executorBinding" in effect;
}
