import type { ReactNode } from "react";

/**
 * The gate/approval state of a promotion between two pipeline stages (coordination-ui-views.md §2,
 * Layer A). Deliberately a small closed set the *existing* model can already answer honestly:
 *
 *   open     — the promotion proceeded / the gate evaluates to allow (green)
 *   blocked  — a gate denied it or the upstream wave failed; carries a `decision_id` when the
 *              server produced one (red, charter principle 6 "every block carries a decision_id")
 *   approval — a required manual approval is still pending (amber)
 *   pending  — not yet at this gate / awaiting reconcile, no verdict to show (slate)
 *
 * There is NO "manual operator hold/release" state here on purpose — that record does not exist in
 * the model yet (coordination-ui-views.md Layer B, phase 5), so surfacing it would be fabrication.
 */
export type PromotionState = "open" | "blocked" | "approval" | "pending";

const STATE_STYLES: Record<PromotionState, { bar: string; triangle: string; text: string }> = {
  open: { bar: "bg-green-500", triangle: "border-t-green-500", text: "text-green-700" },
  blocked: { bar: "bg-red-500", triangle: "border-t-red-500", text: "text-red-700" },
  approval: { bar: "bg-amber-500", triangle: "border-t-amber-500", text: "text-amber-700" },
  pending: { bar: "bg-slate-300", triangle: "border-t-slate-300", text: "text-slate-500" }
};

/**
 * A wide, top-to-bottom promotion arrow drawn between two vertically-stacked stage cards. Purely
 * presentational: the parent computes `state`/`label`/`detail`/`why` from real change data (wave
 * status, gate reasonTree, control-run evidence, freeze window, approval quorum) — this component
 * only paints it. `detail` is an optional one-line "why" the parent assembles from that real data
 * (never fabricated — omitted when the model has no reason to show); `why` is an optional node
 * (typically a link to the blocking Decision) the parent supplies so this stays routing-agnostic.
 */
export function PromotionArrow({
  state,
  label,
  detail,
  why
}: {
  state: PromotionState;
  label?: string;
  detail?: string;
  why?: ReactNode;
}): React.JSX.Element {
  const style = STATE_STYLES[state];
  return (
    <div
      className="flex flex-col items-center py-1"
      data-testid="promotion-arrow"
      data-state={state}
      aria-label={`promotion ${state}${label ? `: ${label}` : ""}${detail ? ` — ${detail}` : ""}`}
    >
      <div className={`h-7 w-11 rounded-t-sm ${style.bar}`} />
      <div
        className={`h-0 w-0 border-x-[22px] border-x-transparent border-t-[18px] ${style.triangle}`}
        aria-hidden="true"
      />
      {(label || why) && (
        <div className={`mt-1 flex items-center gap-2 text-xs font-medium ${style.text}`}>
          {label && <span>{label}</span>}
          {why}
        </div>
      )}
      {detail && (
        <p
          className="mt-0.5 max-w-[20rem] text-center text-[11px] font-normal leading-snug text-slate-500"
          title={detail}
          data-testid="promotion-detail"
        >
          {detail}
        </p>
      )}
    </div>
  );
}
