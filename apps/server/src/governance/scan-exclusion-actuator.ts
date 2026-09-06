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

/**
 * M22.7 (ADR-0033 §10) — THE ACTUATOR. The lever behind the signal.
 *
 * WHY THIS FILE EXISTS. Everything M22 built up to here produces a *fact*: a clause is admitted, a
 * grant is approved, a declaration is made. None of it moves anything, because a control outcome is
 * cached and deliberately treated as a historical fact (`control-runner.ts`'s own doc: "a control
 * result is a historical fact, not continuously re-polled"). So a grant approved five minutes after a
 * change's gate ran is **inert on that change forever** — the operator sees an approved grant, the
 * gate keeps refusing, and nothing in the system connects the two. ADR-0033 §10 calls this out as the
 * blocking prerequisite and BUILD_AND_TEST.md §8 M22 names it "the increment this project most
 * reliably forgets".
 *
 * THE MECHANISM, IN ONE SENTENCE: the gate hashes the exclusion set it resolved, the server stamps
 * that hash onto the run's evidence, and the next evaluation re-resolves, re-hashes, and passes
 * `force: true` to `ensureControlRuns` when the two differ.
 *
 * THREE PROPERTIES THIS FILE IS RESPONSIBLE FOR, none of them optional:
 *
 *  1. **The hash is over the RESOLVED SET, never over inputs including a clock.** A grant's
 *     `expiresAt` is a *stored* value and hashes stably; `now` is not, and hashing anything derived
 *     from it would make a clause sitting near an expiry boundary re-run the control on EVERY
 *     reconcile tick — the measured 1.44 GB/day write-amplification pattern (ADR-0024 §D0) reproduced
 *     in `control_runs` instead of `decisions`. {@link scanExclusionSetHash} therefore takes the
 *     resolved object and nothing else.
 *
 *  2. **Nothing authored ⇒ no hash ⇒ no forcing, ever.** An empty clause list yields `undefined`, the
 *     stamp writes no key, and the comparison finds `undefined === undefined`. A deployment that has
 *     authored no exclusion is byte-identical to pre-M22 and pays not one extra control run.
 *
 *  3. **A stable set must settle after ONE re-run.** The value compared against is written by the
 *     same call the comparison triggers, from the same resolved object, through the same function —
 *     so a set that stops changing stops forcing. Two functions computing "the hash" is precisely the
 *     shape where the stamp and the comparison drift and the loop never converges; there is one.
 */

/**
 * The content digest of a resolved exclusion set, or `undefined` when nothing was admitted.
 *
 * `canonicalJson` sorts object keys recursively and PRESERVES array order — which is safe here for
 * the same measured reason `scanThresholdForDecision` relies on: the resolver already returns
 * `clauses` (and every fact array) sorted by content, so two identical resolutions serialize
 * identically. If a future field is added to `EffectiveScanExclusions`, the question to ask is not
 * "is it useful?" but "would two identical evaluations produce it identically?" — a field that would
 * not must be excluded here, or this becomes a re-run generator.
 */
export function scanExclusionSetHash(
  resolved: EffectiveScanExclusions | undefined
): string | undefined {
  if (!resolved || resolved.clauses.length === 0) return undefined;
  return createHash("sha256").update(canonicalJson(resolved)).digest("hex");
}

/**
 * The same digest, taken from a control-run CONTEXT — the shape `buildControlContext` produced and
 * `ensureControlRun` was handed.
 *
 * This is the STAMPING side, and it reads the context rather than accepting the resolved object as an
 * argument on purpose: `ensureControlRun` is reached from several call sites with a `context` bag and
 * no typed exclusion parameter, and threading a second, parallel argument alongside the one already
 * inside the bag is how the two come to disagree. What is stamped is exactly what was sent.
 *
 * A context carrying no `scanExclusions`, or one whose value does not parse, yields no hash. The
 * second case cannot arise from the gate (which builds the object from the resolver's own output),
 * and if it ever did the honest answer is "this run records no exclusion set", not a hash of
 * something unvalidated.
 */
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

/**
 * Whether any cached SCAN outcome for this gate crossing was produced against a DIFFERENT exclusion
 * set than the one just resolved — i.e. whether `ensureControlRuns` must be forced.
 *
 * READS THE SAME ROW THE CACHE WOULD RETURN. `latestControlRunForGate` is deliberately the same
 * lookup `ensureControlRun` performs (M22.0a, keyed on gate identity), so this answers "is the run
 * that would be reused stale?" rather than "does some run somewhere disagree?". A control with no run
 * yet for this crossing is not consulted at all — it will run regardless.
 *
 * ONLY A SCAN VERDICT IS COMPARED, identified by `ScanEvidenceSchema.safeParse` — the same shape test
 * `federation/promotion-repo.ts` uses to recognise scan evidence, never a control-id or module
 * allowlist. This matters in both directions:
 *
 *   - A `webhook-control`/`github-check` run carries no `exclusionSetHash` and never will. Comparing
 *     it against a non-empty expected hash would force it to re-run on every single tick for as long
 *     as any exclusion clause exists anywhere in the org — a permanent re-run storm on controls that
 *     have nothing to do with scanning.
 *   - A scan run whose plugin call FAILED has `evidence: {}` (the catch path in `ensureControlRun`),
 *     which does not parse either, so a broken binding is retried on its own existing schedule rather
 *     than hammered by this.
 *
 * FORCING IS ALL-OR-NOTHING for the crossing, because `ensureControlRuns` takes one `force` for the
 * whole list. One stale scan verdict therefore re-runs the non-scan controls beside it too. That is
 * accepted and bounded: it happens only when the resolved set actually CHANGED (an approval, a
 * revocation, an expiry, an admission edit), which is a human-rate event, and never on a steady tick.
 */
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
