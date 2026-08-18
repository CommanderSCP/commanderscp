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

// `control_bindings.plugin_module` is a free-form string at the schema layer
// (CreateControlBindingRequestSchema — z.string().min(1)), so THIS check is the only thing
// standing between an attacker-controlled binding and `host.start()` provisioning an arbitrary
// module. Deliberately just the real ControlPlugin modules — "fake-executor" is an
// ExecutorPlugin (subprocess-entry.ts's `loadPlugin`), not a ControlPlugin, so accepting it here
// would only ever produce a safe-but-confusing RPC "unknown method 'evaluate'" failure; excluding
// it keeps this allowlist an honest description of what a control binding can actually reach.
// M17.1 adds "scan-result-control" (a ControlPlugin sibling of webhook-control that turns a
// coordinated Trivy scan verdict into gate evidence). M10.4 adds "github-check" (a third
// ControlPlugin sibling: turns a GitHub Check Run/status verdict for the change's own commit into
// gate evidence — the concrete "CI green for digest X" wave-gate control, BUILD_AND_TEST.md §8
// M10.4).
const KNOWN_CONTROL_MODULES: PluginHostInstanceConfig["module"][] = [
  "webhook-control",
  "scan-result-control",
  "github-check"
];

function isKnownPluginModule(value: string): value is PluginHostInstanceConfig["module"] {
  return (KNOWN_CONTROL_MODULES as string[]).includes(value);
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
 * M10.4 — how long a cached `"expired"` outcome is treated as still-fresh before `ensureControlRun`
 * calls the plugin again. `"expired"` is `github-check`'s "CI has not concluded yet, please
 * re-check later" signal: a wave gate is often asked before CI on the target commit has even
 * started, and returning `"fail"` for that would be WRONG — `"fail"`/`"pass"`/every other status
 * below is cached FOREVER (this function's own doc comment: "a control result is a historical
 * fact, not continuously re-polled"), which would PERMANENTLY deadlock the wave the instant this
 * control was ever asked before CI concluded.
 *
 * Without this cooldown, exempting `"expired"` from caching entirely would re-run the plugin (and
 * insert a new `control_runs` row) on EVERY reconcile tick — the exact unbounded-growth pattern
 * `coordination/reconcile.ts`'s wave-gate Decision persistence already hit and fixed
 * (`insertDecisionIfChanged`: 1.44 GB/day from a byte-identical row every ~2s tick). This bounds
 * both the `control_runs` growth rate and the external API call rate to at most once per interval
 * per pending change, while still eventually noticing CI concluding. Every OTHER status
 * (`pass`/`fail`/`warning`/`skipped`/`timed_out`) is unaffected — cached forever, unchanged from
 * M4/M17.1, since only `github-check` ever produces `"expired"`.
 */
const EXPIRED_RECHECK_INTERVAL_MS = 30_000;

/**
 * Ensures a `control_runs` row exists for (changeObjectId, controlObjectId) — running it via its
 * bound ControlPlugin instance if no run exists yet (or `force`, or a cached `"expired"` outcome
 * older than `EXPIRED_RECHECK_INTERVAL_MS`). Never throws for a plugin-side failure: an
 * unreachable/erroring binding produces a `fail` outcome (with the error captured in evidence)
 * rather than propagating, so one bad control binding can't abort an entire gate evaluation the
 * way an uncaught exception would.
 */
export async function ensureControlRun(
  tx: TenantTx,
  host: PluginHost,
  input: EnsureControlRunInput
): Promise<ControlOutcomeStatus> {
  if (!isUuid(input.controlObjectId)) {
    // A policy's `requireControls` entry that isn't even a well-formed object id (a stale
    // reference, a hand-authored-JSON typo — `control_bindings`/`control_runs` both key on a
    // `uuid` column, so this could never correspond to a real binding or a real graph object
    // either way) must fail closed exactly like "no binding configured" below, NOT reach the
    // database with a value Postgres will reject as 22P02 (invalid input syntax for type uuid).
    // Before this check, that raw DB error propagated out of `evaluateWaveGate` uncaught, which
    // wedged the offending change's wave-boundary gate every reconcile tick forever (caught only
    // by reconcile.ts's outermost per-change try/catch, which just logs and retries — the SAME
    // crash, forever). No `control_runs` row is written here (unlike "no binding configured") —
    // there is no valid uuid to write one under.
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

  // M22.1b (ADR-0033 §7) — TAKE the plugin's transported findings OFF the evidence before anything
  // persists it. A ControlPlugin has no `DATABASE_URL` and cannot write `scan_findings` itself, so
  // `scan-result-control` hands its capped findings back on the outcome's evidence record; this is
  // the server-side half of that seam.
  //
  // THE STRIP IS NOT OPTIONAL AND IT IS NOT COSMETIC. `federation/promotion-repo.ts` projects
  // `{controlUrn, status, evidence, detail}` for every control run and copies `evidence` VERBATIM
  // into the signed promotion bundle. Findings left on that column would both bloat every bundle and
  // federate accepted-risk detail that ADR-0033 §8 confines to grants — the bundle keeps counts.
  // `takeScanFindingsFromTransport` extracts and strips in ONE call precisely so a caller cannot
  // obtain the findings and forget the strip. It also RE-VALIDATES and re-caps the payload: the
  // producer is a separate process and must not be able to steer what lands in the database.
  //
  // Runs for EVERY control, not just scan controls: a transport key must never survive onto a
  // persisted row, whichever plugin put it there.
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
  // M22.7 (ADR-0033 §10) — STAMP THE EXCLUSION SET THIS RUN WAS PRODUCED UNDER, so the next
  // evaluation can tell whether the cached outcome is still current. Written by the SERVER, from the
  // context it actually threaded, for the same reason `findingsRecord` above is: the producer is a
  // separate process and this is a statement about what the GATE resolved, not about what the plugin
  // did with it.
  //
  // Gated on `scanMethod` exactly like `findingsRecord`: only a scan verdict can have exclusions
  // applied to it, and only a scan verdict is compared by `scanExclusionSetChangedForGate`. Stamping
  // a webhook control's evidence with a hash nothing ever reads would be noise; failing to stamp a
  // scan verdict's would make it look permanently stale and re-run it every tick.
  //
  // An `openscap` verdict IS stamped, and that is deliberate: its exclusions are refused for a
  // structural reason (`unsupported`), not because no set was in force, and leaving it unstamped
  // would force a pointless re-scan on every set change forever.
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
    // WHAT ACTUALLY RAN, stamped on the run (0063). Taken from the binding THIS call resolved, not
    // looked up later: a binding re-pointed afterwards must not be able to re-narrate what this row
    // evidenced. Recorded even on the catch path above — a `fail` from `github-check` is still a
    // `github-check` verdict, and dropping the module there would turn an own-check objection into
    // an unattributable one.
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
    /** M22.0a — re-run every named control even if a run already exists for THIS gate.
     *
     *  This parameter did not exist before: `ensureControlRun` (singular) had always declared
     *  `force`, but the plural entry point every production call site actually uses could not
     *  express it, so nothing in the tree could ever request a re-evaluation. That is what made the
     *  re-evaluation story a signal with no lever — ADR-0033 §10's actuator has to pass this when
     *  the resolved exclusion set no longer matches the hash recorded in the cached run's evidence,
     *  or a revoked/expired grant is never noticed. */
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
  /** M22.0a — the gate crossing being decided. Host-less callers (the read-only
   *  `POST /policy-evaluate` preview and the accept edge, which has no plugin host of its own) must
   *  read the run made FOR THIS CROSSING, for the same reason `ensureControlRun` now does: a run
   *  made during `validating` is not evidence that a production wave boundary was authorized.
   *
   *  Optional, and gate-agnostic when omitted, so a caller that genuinely wants "the newest outcome
   *  for this control on this change, wherever it came from" still has that — but every
   *  authorization path passes it. */
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
