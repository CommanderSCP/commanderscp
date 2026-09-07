import { z } from "zod";
import { ExecutorTypeSchema } from "./executors.js";

/** THE `executorBinding` POLICY EFFECT. See docs/schemas.md §10. */

/** Which lane a binding serves. See docs/schemas.md §11. */
export const ExecutorLaneSchema = z.enum(["build", "test"]);
export type ExecutorLane = z.infer<typeof ExecutorLaneSchema>;

/** One `executorBinding` effect. See docs/schemas.md §12. */
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
