import { createHash } from "node:crypto";
import {
  EffectiveScanExclusionsSchema,
  ScanEvidenceSchema,
  type EffectiveScanExclusions
} from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { canonicalJson } from "../util/canonical-json.js";
import { latestControlRunForGate } from "./controls-repo.js";
import { isUuid } from "../graph/objects-repo.js";

/** M22.7 (ADR-0033 §10) — THE ACTUATOR. See docs/governance.md §316. */

/** The content digest of a resolved exclusion set. See docs/governance.md §317. */
export function scanExclusionSetHash(
  resolved: EffectiveScanExclusions | undefined
): string | undefined {
  if (!resolved || resolved.clauses.length === 0) return undefined;
  return createHash("sha256").update(canonicalJson(resolved)).digest("hex");
}

/** The same digest, taken from a control-run CONTEXT. See docs/governance.md §318. */
export function scanExclusionSetHashOfContext(
  context: Record<string, unknown>
): string | undefined {
  const raw = context.scanExclusions;
  if (raw === undefined) return undefined;
  const parsed = EffectiveScanExclusionsSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  return scanExclusionSetHash(parsed.data);
}

export interface ScanExclusionSetChangedInput {
  orgId: string;
  changeObjectId: string;
  /** Every control the gate is about to ensure — the same list handed to `ensureControlRuns`. */
  controlObjectIds: string[];
  gateKind: "lifecycle_edge" | "wave_boundary";
  gateRef: Record<string, unknown>;
  exclusions: EffectiveScanExclusions | undefined;
}

/** Was any cached outcome produced under a different set. See docs/governance.md §319. */
export async function scanExclusionSetChangedForGate(
  tx: TenantTx,
  input: ScanExclusionSetChangedInput
): Promise<boolean> {
  const expected = scanExclusionSetHash(input.exclusions);
  for (const controlObjectId of input.controlObjectIds) {
    // Same "never hand Postgres a non-uuid" guard as `ensureControlRun`'s: a malformed
    // `requireControls` entry fails closed there and must not turn this read into a 22P02 that
    // aborts the whole gate evaluation.
    if (!isUuid(controlObjectId)) continue;
    const existing = await latestControlRunForGate(
      tx,
      input.orgId,
      input.changeObjectId,
      controlObjectId,
      input.gateKind,
      input.gateRef
    );
    if (!existing) continue;
    const evidence = ScanEvidenceSchema.safeParse(existing.evidence);
    if (!evidence.success) continue;
    // `undefined !== undefined` is false, so nothing-authored-and-nothing-recorded never forces.
    // A pre-M22.7 run with clauses now in force records nothing and IS re-run, once.
    if (evidence.data.exclusionSetHash !== expected) return true;
  }
  return false;
}
