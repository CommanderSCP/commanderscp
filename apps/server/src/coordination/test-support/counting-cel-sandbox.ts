import {
  CelSandbox,
  type CelEvalResult,
  type CelSandboxOptions
} from "../../governance/cel-sandbox.js";
import type { PolicyEvaluationEntry } from "../../governance/evaluate.js";
import { canonicalJson } from "../../util/canonical-json.js";

/** The suite-wide CEL timeout, not the production one. See docs/coordination.md §987. */
export const DECISION_COUNT_SUITE_CEL_TIMEOUT_MS = 30_000;

/** A REAL `CelSandbox`. See docs/coordination.md §988. */
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

/** True when this reason tree is the fail-closed statement. See docs/coordination.md §989. */
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

/** Splits ordinary gate verdicts from condition errors. See docs/coordination.md §990. */
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

/** How many DISTINCT statements a set of Decision rows makes. See docs/coordination.md §991. */
export function distinctDecisionStatements(rows: DecisionContentRow[]): number {
  // `@scp/schemas/canonical-json`, not a local copy of the sort. See docs/coordination.md §992.
  return new Set(
    rows.map((r) => canonicalJson({ v: r.verdict, i: r.inputContext, t: r.reasonTree }))
  ).size;
}
