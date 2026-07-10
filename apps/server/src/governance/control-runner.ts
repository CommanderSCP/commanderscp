import type { ControlOutcomeStatus } from "@scp/plugin-api";
import type { TenantTx } from "../db/tenant-tx.js";
import type { PluginHost, PluginHostInstanceConfig } from "../plugin-host/contract.js";
import { getControlBinding, insertControlRun, latestControlRun } from "./controls-repo.js";
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";

const KNOWN_CONTROL_MODULES: PluginHostInstanceConfig["module"][] = ["webhook-control"];

function isKnownPluginModule(value: string): value is PluginHostInstanceConfig["module"] {
  return (KNOWN_CONTROL_MODULES as string[]).includes(value) || value === "fake-executor";
}

/**
 * Actually RUNS a control (DESIGN §10.2) via the subprocess plugin host — the one piece of
 * governance evaluation that needs `PluginHost`, and therefore only ever runs on a process that
 * has one (the `role=worker`/`role=all` reconciliation loop — DESIGN §16's api/worker split means
 * a pure `role=api` process has no plugin host at all). See `coordination/gates.ts`'s module doc
 * for how the lifecycle-edge (human-route) gate avoids needing this: it only ever READS
 * already-persisted `control_runs`, never triggers one inline.
 */

export interface EnsureControlRunInput {
  orgId: string;
  changeObjectId: string;
  controlObjectId: string;
  gateKind: "lifecycle_edge" | "wave_boundary";
  gateRef: Record<string, unknown>;
  context: Record<string, unknown>;
  /** Re-run even if a prior run exists (default false — the first outcome for this change/control
   *  pair is treated as authoritative once produced, matching DESIGN's "evidence... referenced by
   *  Decisions" — a control result is a historical fact, not continuously re-polled). */
  force?: boolean;
}

/**
 * Ensures a `control_runs` row exists for (changeObjectId, controlObjectId) — running it via its
 * bound ControlPlugin instance if no run exists yet (or `force`). Never throws for a plugin-side
 * failure: an unreachable/erroring binding produces a `fail` outcome (with the error captured in
 * evidence) rather than propagating, so one bad control binding can't abort an entire gate
 * evaluation the way an uncaught exception would.
 */
export async function ensureControlRun(
  tx: TenantTx,
  host: PluginHost,
  input: EnsureControlRunInput
): Promise<ControlOutcomeStatus> {
  if (!input.force) {
    const existing = await latestControlRun(tx, input.orgId, input.changeObjectId, input.controlObjectId);
    if (existing) return existing.status;
  }

  const binding = await getControlBinding(tx, input.orgId, input.controlObjectId);
  if (!binding) {
    await insertControlRun(tx, {
      orgId: input.orgId,
      controlObjectId: input.controlObjectId,
      changeObjectId: input.changeObjectId,
      gateKind: input.gateKind,
      gateRef: input.gateRef,
      status: "fail",
      evidence: {},
      detail: `control '${input.controlObjectId}' has no ControlPlugin binding configured`
    });
    return "fail";
  }

  let status: ControlOutcomeStatus;
  let evidence: Record<string, unknown> = {};
  let detail: string | undefined;
  try {
    if (!isKnownPluginModule(binding.pluginModule)) {
      throw new Error(`unknown control plugin module '${binding.pluginModule}'`);
    }
    // Lazily provisions this binding's plugin instance on the host if it isn't already running
    // (M4 has no plugin-instance-configuration API yet, same documented gap
    // `coordination/executor-config.ts` has for executors) — idempotent per instance id
    // (plugin-host/host.ts's `start()` doc comment), so calling this on every evaluation is safe.
    await host.start([
      {
        id: binding.pluginInstanceId,
        module: binding.pluginModule,
        orgId: input.orgId,
        domainId: "default",
        config: binding.config
      }
    ]);
    const outcome = await host.control(binding.pluginInstanceId).evaluate({
      changeId: input.changeObjectId,
      controlId: input.controlObjectId,
      context: input.context
    });
    status = outcome.status;
    evidence = outcome.evidence ?? {};
    detail = outcome.detail;
  } catch (err) {
    status = "fail";
    detail = `control plugin call failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  await insertControlRun(tx, {
    orgId: input.orgId,
    controlObjectId: input.controlObjectId,
    changeObjectId: input.changeObjectId,
    gateKind: input.gateKind,
    gateRef: input.gateRef,
    status,
    evidence,
    detail
  });
  return status;
}

/** Runs every control in `controlObjectIds` that has no existing outcome yet for this change,
 *  returning a `controlObjectId -> latest status` map ready for `governance/evaluate.ts`'s
 *  `PolicyEvaluationContext.controlOutcomes`. */
export async function ensureControlRuns(
  tx: TenantTx,
  host: PluginHost,
  input: {
    orgId: string;
    changeObjectId: string;
    controlObjectIds: string[];
    gateKind: "lifecycle_edge" | "wave_boundary";
    gateRef: Record<string, unknown>;
    context: Record<string, unknown>;
  }
): Promise<Record<string, ControlOutcomeStatus>> {
  const outcomes: Record<string, ControlOutcomeStatus> = {};
  for (const controlObjectId of input.controlObjectIds) {
    outcomes[controlObjectId] = await ensureControlRun(tx, host, {
      orgId: input.orgId,
      changeObjectId: input.changeObjectId,
      controlObjectId,
      gateKind: input.gateKind,
      gateRef: input.gateRef,
      context: input.context
    });
  }
  return outcomes;
}

/** Read-only counterpart used by the host-less lifecycle-edge gate (coordination/gates.ts): looks
 *  up whatever outcomes already exist without ever attempting to run one. Controls with no run
 *  yet are simply absent from the returned map (evaluate.ts treats an absent entry as unsatisfied
 *  — DESIGN's "fails closed", never a silent pass). */
export async function readExistingControlOutcomes(
  tx: TenantTx,
  orgId: string,
  changeObjectId: string,
  controlObjectIds: string[]
): Promise<Record<string, ControlOutcomeStatus>> {
  const outcomes: Record<string, ControlOutcomeStatus> = {};
  for (const controlObjectId of controlObjectIds) {
    const run = await latestControlRun(tx, orgId, changeObjectId, controlObjectId);
    if (run) outcomes[controlObjectId] = run.status;
  }
  return outcomes;
}

/** Resolves a control object's own graph-side `category` (DESIGN §10.2) for evidence/reason-tree
 *  purposes — best-effort, never throws (a dangling control ref just yields `undefined`). */
export async function tryGetControlCategory(tx: TenantTx, orgId: string, controlObjectId: string): Promise<string | undefined> {
  try {
    const obj = await getObjectByIdOrUrnAnyType(tx, orgId, controlObjectId);
    const properties = obj.properties as { category?: string };
    return properties.category;
  } catch {
    return undefined;
  }
}
