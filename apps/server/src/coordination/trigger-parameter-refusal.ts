/**
 * A TRIGGER-PARAMETER DERIVATION THAT REFUSES (M28.1, ADR-0053).
 *
 * `buildLaneTriggerParameters` and `opsLaneTriggerParameters` both run inside the trigger-claim
 * transaction and can conclude that the trigger must not happen: a build whose declared registry
 * cannot hold what it builds, an ops change that declares no operation. Both used to (or would)
 * THROW a bare error there — which the per-target catch in `reconcile.ts` logged and retried on the
 * next tick, forever, with no Decision and no audit event. A refusal that re-fires every second and
 * explains itself only in a log line is not a refusal an operator can see (principle 6).
 *
 * So a refusal is typed. `reconcile.ts` catches THIS class, and only this class, and terminalises
 * the wave target through `blockWaveTarget` — the same Decision + hash-chained audit + parked change
 * every other refusal there produces. Any other error still takes the retry path, because an
 * unexpected throw is not a verdict.
 */

/** Terminal status: the component's declared destination cannot hold what its Type builds. */
export const WAVE_TARGET_DESTINATION_REFUSED_STATUS = "destination_refused";
export const WAVE_TARGET_DESTINATION_REFUSED_AUDIT_ACTION =
  "change.wave_target.destination_refused";

/** Terminal status: a host-reaching change whose declared operation cannot be derived into material. */
export const WAVE_TARGET_OPS_DECLARATION_REFUSED_STATUS = "ops_declaration_refused";
export const WAVE_TARGET_OPS_DECLARATION_REFUSED_AUDIT_ACTION =
  "change.wave_target.ops_declaration_refused";

/** Terminal status (M28.3, ADR-0056): an `infrastructure` change the Argo lane cannot derive a plan
 *  trigger for — no environment on the target, no pinned commit, a binding with no plan template. */
export const WAVE_TARGET_INFRA_DECLARATION_REFUSED_STATUS = "infra_declaration_refused";
export const WAVE_TARGET_INFRA_DECLARATION_REFUSED_AUDIT_ACTION =
  "change.wave_target.infra_declaration_refused";

/** Terminal status (M28.3, ADR-0056): an APPLY whose plan is not approved, not current, not this
 *  target's, or already being applied. The apply template is never triggered. */
export const WAVE_TARGET_INFRA_APPLY_REFUSED_STATUS = "infra_apply_refused";
export const WAVE_TARGET_INFRA_APPLY_REFUSED_AUDIT_ACTION =
  "change.wave_target.infra_apply_refused";

/** Terminal status (M28.3, ADR-0053 addendum): a build whose source repo is not one the component
 *  declares — built with the operator's push credentials, it would publish someone else's code. */
export const WAVE_TARGET_SOURCE_REFUSED_STATUS = "source_refused";
export const WAVE_TARGET_SOURCE_REFUSED_AUDIT_ACTION = "change.wave_target.source_refused";

export type TriggerParameterRefusalStatus =
  | typeof WAVE_TARGET_DESTINATION_REFUSED_STATUS
  | typeof WAVE_TARGET_SOURCE_REFUSED_STATUS
  | typeof WAVE_TARGET_OPS_DECLARATION_REFUSED_STATUS
  | typeof WAVE_TARGET_INFRA_DECLARATION_REFUSED_STATUS
  | typeof WAVE_TARGET_INFRA_APPLY_REFUSED_STATUS;

export abstract class TriggerParameterRefusal extends Error {
  abstract readonly status: TriggerParameterRefusalStatus;
  abstract readonly action: string;
  /** What the operator does about it. Defaults to the message itself, which for the ops lane
   *  already reads as an instruction. */
  readonly remediation: string;
  /** Persisted on the Decision, so the verdict carries its inputs (principle 6). */
  readonly inputContext: Record<string, unknown>;

  constructor(
    message: string,
    options: { remediation?: string; inputContext?: Record<string, unknown> } = {}
  ) {
    super(message);
    this.name = new.target.name;
    this.remediation = options.remediation ?? message;
    this.inputContext = options.inputContext ?? {};
  }
}
