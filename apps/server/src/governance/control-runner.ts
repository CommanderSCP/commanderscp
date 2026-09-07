import type { ControlOutcomeStatus } from "@scp/plugin-api";
import {
  ScanEvidenceSchema,
  scanFindingsRecordFor,
  takeScanFindingsFromTransport,
  type CappedScanFindings,
  type ScanMethod
} from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import type { PluginHost, PluginHostInstanceConfig } from "../plugin-host/contract.js";
import {
  getControlBinding,
  insertControlRun,
  latestControlRun,
  latestControlRunForGate
} from "./controls-repo.js";
import { persistScanFindings } from "./scan-findings-repo.js";
import { scanExclusionSetHashOfContext } from "./scan-exclusion-actuator.js";
import { getObjectByIdOrUrnAnyType, isUuid } from "../graph/objects-repo.js";

// The module is free-form at the schema layer, checked here. See docs/governance.md §42.
const KNOWN_CONTROL_MODULES: PluginHostInstanceConfig["module"][] = [
  "webhook-control",
  "scan-result-control",
  "github-check"
];

function isKnownPluginModule(value: string): value is PluginHostInstanceConfig["module"] {
  return (KNOWN_CONTROL_MODULES as string[]).includes(value);
}

/** Actually RUNS a control. See docs/governance.md §43. */

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

/** How long a cached expired outcome is still treated fresh. See docs/governance.md §44. */
const EXPIRED_RECHECK_INTERVAL_MS = 30_000;

/** Ensures a run row exists for that change and control. See docs/governance.md §45. */
export async function ensureControlRun(
  tx: TenantTx,
  host: PluginHost,
  input: EnsureControlRunInput
): Promise<ControlOutcomeStatus> {
  if (!isUuid(input.controlObjectId)) {
    // An entry that is not even a well-formed object id. See docs/governance.md §46.
    return "fail";
  }

  if (!input.force) {
    // M22.0a — scoped to THIS gate crossing, not to the change. See
    // `latestControlRunForGate`'s doc: keying without gate identity let the run made during
    // `validating` authorize every later wave boundary, which makes an expiring exclusion grant
    // (ADR-0033) unenforceable the moment a change is accepted.
    const existing = await latestControlRunForGate(
      tx,
      input.orgId,
      input.changeObjectId,
      input.controlObjectId,
      input.gateKind,
      input.gateRef
    );
    if (existing) {
      const stillFresh =
        existing.status !== "expired" ||
        Date.now() - existing.createdAt.getTime() < EXPIRED_RECHECK_INTERVAL_MS;
      if (stillFresh) return existing.status;
    }
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
      // NO `pluginModule` — there is no binding, so there is no module. Recording one here would
      // be inventing the answer to "what kind of evidence is this?" for a row that is not evidence.
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
        scopeKey: "default",
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

  // Take the plugin's transported findings off the evidence. See docs/governance.md §47.
  const taken = takeScanFindingsFromTransport(evidence);
  evidence = taken.evidence;
  // WHAT SCANNED decides whether findings may be recorded at all, so the method is read from the
  // evidence the plugin actually produced. A control whose evidence is not a scan verdict
  // (webhook-control, github-check) yields no method, and its payload — if it somehow carried one —
  // is dropped rather than attributed to a scan that did not happen.
  const scanEvidence = ScanEvidenceSchema.safeParse(evidence);
  const scanMethod: ScanMethod | undefined = scanEvidence.success
    ? scanEvidence.data.scanner
    : undefined;
  const capped: CappedScanFindings | undefined = scanMethod ? taken.capped : undefined;
  // ONE pure function decides the marker stamped on the evidence here and the rows written below,
  // because the marker must be on the `control_runs` row at INSERT time while the rows need that
  // row's id. Deriving both from `scanFindingsRecordFor` keeps "the evidence says full, the table
  // says otherwise" unreachable.
  const findingsRecord = scanMethod ? scanFindingsRecordFor(scanMethod, capped) : undefined;
  if (findingsRecord) evidence = { ...evidence, findingsRecord };
  // Stamp the exclusion set this run was produced under. See docs/governance.md §48.
  const exclusionSetHash = scanMethod ? scanExclusionSetHashOfContext(input.context) : undefined;
  if (exclusionSetHash) evidence = { ...evidence, exclusionSetHash };

  const run = await insertControlRun(tx, {
    orgId: input.orgId,
    controlObjectId: input.controlObjectId,
    changeObjectId: input.changeObjectId,
    gateKind: input.gateKind,
    gateRef: input.gateRef,
    status,
    evidence,
    detail,
    // WHAT ACTUALLY RAN, stamped on the run. See docs/governance.md §49.
    pluginModule: binding.pluginModule
  });
  // Same transaction as the verdict they explain. Skipped only when there is no scan verdict here at
  // all — for a scan verdict the call is unconditional, so an `openscap` one would record
  // `unsupported` rather than being quietly passed over.
  if (scanMethod) {
    await persistScanFindings(tx, {
      orgId: input.orgId,
      controlRunId: run.id,
      method: scanMethod,
      capped,
      // M22.2 — the plugin decided which findings an admitted clause excluded; only the server can
      // record that as an ADR-0024 retention class. `takeScanFindingsFromTransport` re-validated
      // these ordinals against the array that actually landed, so a buggy or tampered producer
      // cannot promote a row that does not exist.
      excludedOrdinals: taken.excludedOrdinals
    });
  }
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
    /** Re-run every named control even if a run exists. See docs/governance.md §50. */
    force?: boolean;
  }
): Promise<Record<string, ControlOutcomeStatus>> {
  const outcomes: Record<string, ControlOutcomeStatus> = {};
  for (const controlObjectId of input.controlObjectIds) {
    outcomes[controlObjectId] = await ensureControlRun(tx, host, {
      ...(input.force !== undefined ? { force: input.force } : {}),
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
  controlObjectIds: string[],
  /** M22.0a — the gate crossing being decided. See docs/governance.md §51. */
  gate?: { gateKind: "lifecycle_edge" | "wave_boundary"; gateRef: Record<string, unknown> }
): Promise<Record<string, ControlOutcomeStatus>> {
  const outcomes: Record<string, ControlOutcomeStatus> = {};
  for (const controlObjectId of controlObjectIds) {
    // Same "fail closed, never hit Postgres with a non-uuid" guard as ensureControlRun's — a
    // malformed reference just never has an entry in the returned map, which evaluate.ts already
    // treats as unsatisfied (this function's own doc comment above).
    if (!isUuid(controlObjectId)) continue;
    const run = gate
      ? await latestControlRunForGate(
          tx,
          orgId,
          changeObjectId,
          controlObjectId,
          gate.gateKind,
          gate.gateRef
        )
      : await latestControlRun(tx, orgId, changeObjectId, controlObjectId);
    if (run) outcomes[controlObjectId] = run.status;
  }
  return outcomes;
}

/** Resolves a control object's own graph-side `category` (DESIGN §10.2) for evidence/reason-tree
 *  purposes — best-effort, never throws (a dangling control ref just yields `undefined`). */
export async function tryGetControlCategory(
  tx: TenantTx,
  orgId: string,
  controlObjectId: string
): Promise<string | undefined> {
  try {
    const obj = await getObjectByIdOrUrnAnyType(tx, orgId, controlObjectId);
    const properties = obj.properties as { category?: string };
    return properties.category;
  } catch {
    return undefined;
  }
}
