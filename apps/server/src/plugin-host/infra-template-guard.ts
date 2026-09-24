import type { ScheduleSpec, TriggerIntent } from "@scp/plugin-api";

/**
 * THE ONE DOOR FOR THE SHIPPED INFRA TEMPLATES (M28.3, ADR-0056 §5).
 *
 * `scp-infra-plan-v*` runs a repository's code with the operator's cloud credentials, and
 * `scp-infra-apply-v*` changes infrastructure. The infrastructure lane is the only thing entitled
 * to submit either — for a declared target, and for an apply only through its gate. But a template
 * NAME is just a string, and several server paths send one to an executor: the wave-target trigger
 * (`reconcile.ts`), declared-hook runs (`pipeline-hook-runs.ts`), continuous probes' schedules
 * (`continuous-probe-driver.ts`), dependency bumps (`bump-dispatch.ts`, `bump-gate.ts`). A guard at
 * each of them is a census that the next caller escapes; this is the plugin host's executor client,
 * which EVERY one of them goes through (`SubprocessPluginHost.executor`).
 *
 * The authority is the intent OBJECT the lane built, held in a WeakSet — nothing that can ride in a
 * parameter, a recipe, a binding or a replicated row, so no data can forge it. A schedule naming an
 * infra template is always refused: a plan or an apply on a cron is never the lane's.
 */

export const INFRA_CATALOG_TEMPLATE = /^scp-infra-(plan|apply)-v[0-9]+$/;

const authorized = new WeakSet<object>();

/** The infrastructure lane marks the exact intent it derived. Called from `reconcile.ts` only
 *  (`infra-lane-reachability.test.ts` holds that). */
export function authorizeInfraLaneIntent<T extends TriggerIntent>(intent: T): T {
  authorized.add(intent);
  return intent;
}

export class InfraTemplateOutsideLane extends Error {
  constructor(templateRef: string, via: "trigger" | "ensureSchedule") {
    super(
      `refusing to ${via === "trigger" ? "submit" : "schedule"} '${templateRef}': the shipped ` +
        `infrastructure templates are submitted only by the infrastructure lane (ADR-0056 §5)`
    );
    this.name = "InfraTemplateOutsideLane";
  }
}

export function assertInfraTemplateTrigger(intent: TriggerIntent): void {
  const ref = intent.targetRef;
  if (ref !== undefined && INFRA_CATALOG_TEMPLATE.test(ref) && !authorized.has(intent)) {
    throw new InfraTemplateOutsideLane(ref, "trigger");
  }
}

export function assertInfraTemplateSchedule(spec: ScheduleSpec): void {
  if (INFRA_CATALOG_TEMPLATE.test(spec.targetRef)) {
    throw new InfraTemplateOutsideLane(spec.targetRef, "ensureSchedule");
  }
}
