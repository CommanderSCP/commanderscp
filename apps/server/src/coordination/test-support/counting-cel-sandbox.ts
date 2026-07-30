import { CelSandbox, type CelEvalResult, type CelSandboxOptions } from "../../governance/cel-sandbox.js";
import type { PolicyEvaluationEntry } from "../../governance/evaluate.js";

/**
 * THE SUITE-WIDE CEL TIMEOUT FOR DECISION-COUNTING SUITES, AND WHY IT IS NOT THE PRODUCTION 250 ms.
 *
 * `CEL_DEFAULT_TIMEOUT_MS` (250 ms, cel-sandbox.ts) is a SECURITY bound — it caps what an untrusted
 * policy expression can burn on a worker thread — and production is exactly where it belongs. But it
 * is a HARD WALL CLOCK, and a suite that counts Decision ROWS is measured against it while the box
 * is also running every other integration file: a trivial `change.emergency == false` that would
 * evaluate in microseconds can exceed 250 ms of wall clock purely because its worker thread did not
 * get scheduled (observed twice on this machine with no injection at all — the first cold run of both
 * amplification files at `SCP_TEST_MAX_FORKS=2`, and the 80-file suite at forks=8).
 *
 * When that happens the production code does the RIGHT thing, and the row count changes as a result:
 * `governance/evaluate.ts` fails the required contributor closed with a synthetic
 * `kind:"conditionError"` effect, which is a genuinely DIFFERENT reason tree, so
 * `insertDecisionIfChanged` CORRECTLY writes a second row — and a third when the next tick evaluates
 * normally again (block -> conditionError -> block). Asserting "exactly one row" against that is
 * asserting the machine is never busy.
 *
 * So these suites raise the wall clock far above any scheduling hiccup. This weakens NOTHING they
 * test: the timeout wall itself is covered by `governance/cel-sandbox.test.ts`, and the property
 * under test here — a restated verdict does not append a row — is entirely independent of how long
 * an evaluation is allowed to take. The evaluation COUNT assertions (the invariant that the gate is
 * still re-evaluated every tick) are unaffected either way, because a timed-out evaluation is still
 * an evaluation and is still counted.
 */
export const DECISION_COUNT_SUITE_CEL_TIMEOUT_MS = 30_000;

/**
 * A REAL `CelSandbox` (own worker threads, real cel-js) that also records what it was asked to
 * evaluate. Subclassed rather than faked so the gate path under test is byte-for-byte the production
 * one — the recording and the raised timeout are the only additions.
 *
 * Shared by the change-side and campaign-side write-amplification suites so the two cannot drift
 * apart on the flake fix.
 */
export class CountingCelSandbox extends CelSandbox {
  readonly evaluated: string[] = [];

  constructor(options: CelSandboxOptions = {}) {
    super({ timeoutMs: DECISION_COUNT_SUITE_CEL_TIMEOUT_MS, ...options });
  }

  override async evaluate(
    expression: string,
    context: Record<string, unknown>
  ): Promise<CelEvalResult> {
    this.evaluated.push(expression);
    return super.evaluate(expression, context);
  }

  /** How many times a specific policy condition was evaluated. */
  countOf(expression: string): number {
    return this.evaluated.filter((e) => e === expression).length;
  }
}

/**
 * True when this Decision's reason tree is the FAIL-CLOSED CONDITION-ERROR statement rather than an
 * ordinary gate verdict — i.e. at least one policy entry carries the synthetic
 * `kind:"conditionError"` effect, or the `conditionError` annotation, that `governance/evaluate.ts`
 * produces when a contributor's CEL condition could not be evaluated (parse error OR timeout).
 *
 * Structural, not a substring match on the serialized tree, so a renamed field fails the type check
 * instead of silently matching nothing.
 */
export function isConditionErrorReasonTree(reasonTree: unknown): boolean {
  if (reasonTree === null || typeof reasonTree !== "object") return false;
  const policies = (reasonTree as { policies?: unknown }).policies;
  if (!Array.isArray(policies)) return false;
  return policies.some((p) => {
    if (p === null || typeof p !== "object") return false;
    const entry = p as Partial<PolicyEvaluationEntry>;
    if (typeof entry.conditionError === "string") return true;
    return (entry.effects ?? []).some((e) => e.kind === "conditionError");
  });
}

/** The shape both amplification suites read out of `decisions`. */
export interface DecisionContentRow {
  verdict: string;
  inputContext: unknown;
  reasonTree: unknown;
}

/**
 * Split a subject's Decision rows into the ORDINARY gate verdicts and the FAIL-CLOSED condition-error
 * statements a CEL evaluation failure produces.
 *
 * WHY THE COUNTING ASSERTIONS NEED THIS, and why filtering ALONE is not enough — measured, not
 * assumed. Inject one timeout into a parked gate's tick sequence and the persisted rows are:
 *
 *     row 0  block / requireApprovals unmet      (the standing verdict)
 *     row 1  block / conditionError              (fail-closed: a DIFFERENT reason tree)
 *     row 2  block / requireApprovals unmet      (the next normal tick: differs from row 1)
 *
 * Every one of those writes is CORRECT — each differs from the row before it, which is exactly what
 * persist-on-change promises. Dropping row 1 still leaves TWO ordinary rows, so "exactly one row"
 * cannot be asserted on a box where a 250 ms wall clock can be missed by a scheduling hiccup (observed
 * twice here with no injection at all). The suites therefore raise the wall clock far above any
 * hiccup AND assert the bound the fix actually guarantees:
 *
 *     ordinary.length <= conditionErrors.length + 1
 *     and every ordinary row states the SAME thing
 *
 * which is 1 on any healthy run, tolerates exactly the extra statement a timeout legitimately causes,
 * and is completely independent of machine load. It does NOT soften the property under test: removing
 * the dedupe guard appends an ordinary restatement per tick with no condition errors at all, so the
 * bound becomes 20 <= 1 and the assertion goes RED (mutation-proven — T1/T3/T2/U2/U3 all fail).
 */
export function partitionConditionErrors<T extends { reasonTree: unknown }>(
  rows: T[]
): { ordinary: T[]; conditionErrors: T[] } {
  const ordinary: T[] = [];
  const conditionErrors: T[] = [];
  for (const row of rows) {
    (isConditionErrorReasonTree(row.reasonTree) ? conditionErrors : ordinary).push(row);
  }
  return { ordinary, conditionErrors };
}

/**
 * How many DISTINCT statements a set of Decision rows makes — the content key `restatesDecision`
 * compares on (verdict + inputContext + reasonTree), normalized key-order-independently for the same
 * reason it normalizes there: `jsonb` does not preserve the author's key order.
 *
 * This is the assertion that keeps "at most one more row than there were condition errors" from being
 * a loophole: the extra rows a timeout causes must be RESTATEMENTS of the same standing verdict, not
 * new information that persist-on-change lost.
 */
export function distinctDecisionStatements(rows: DecisionContentRow[]): number {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v !== null && typeof v === "object") {
      const src = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(src).sort()) out[key] = sortKeys(src[key]);
      return out;
    }
    return v;
  };
  return new Set(
    rows.map((r) =>
      JSON.stringify(sortKeys({ v: r.verdict, i: r.inputContext, t: r.reasonTree }))
    )
  ).size;
}
