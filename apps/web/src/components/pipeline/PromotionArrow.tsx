import type { ReactNode } from "react";

/**
 * The gate/approval state of a promotion between two consecutive waves (coordination-ui-views.md §2,
 * Layer A). Deliberately a small closed set the *existing* model can already answer honestly:
 *
 *   open     — the promotion proceeded / the gate evaluates to allow (green)
 *   blocked  — a gate denied it or the upstream wave failed; carries a `decision_id` when the
 *              server produced one (red, charter principle 6 "every block carries a decision_id")
 *   approval — a required manual approval is still pending (amber)
 *   held     — a stage-scoped component coupling is withholding the trigger (ADR-0028): the release
 *              is waiting on ANOTHER COMPONENT reaching this same stage (indigo)
 *   pending  — not yet at this gate / awaiting reconcile, no verdict to show (slate)
 *
 * There is NO "manual operator hold/release" state here on purpose — that record does not exist in
 * the model yet (coordination-ui-views.md Layer B, phase 5), so surfacing it would be fabrication.
 * `held` is NOT that: it is a real server-side verdict re-evaluated on every request, and it exists
 * as its own state because both of the states it could otherwise have borrowed would LIE.
 * `blocked` is red and permanent-reading, and conflating a transient self-clearing wait with a
 * denial is the exact bug ADR-0028 wrote `verdict: "hold"` rather than `"block"` to avoid;
 * `approval` claims a human gate that nobody is standing at. The wait is real, it clears itself,
 * and nothing is wrong — so it gets a colour of its own rather than the alarm or the queue.
 */
export type PromotionState = "open" | "blocked" | "approval" | "held" | "pending";

const STATE_STYLES: Record<PromotionState, { bar: string; triangle: string; text: string }> = {
  open: { bar: "bg-green-500", triangle: "border-t-green-500", text: "text-green-700" },
  blocked: { bar: "bg-red-500", triangle: "border-t-red-500", text: "text-red-700" },
  approval: { bar: "bg-amber-500", triangle: "border-t-amber-500", text: "text-amber-700" },
  held: { bar: "bg-indigo-500", triangle: "border-t-indigo-500", text: "text-indigo-700" },
  pending: { bar: "bg-slate-300", triangle: "border-t-slate-300", text: "text-slate-500" }
};

/**
 * A wide, top-to-bottom promotion arrow drawn between two vertically-stacked wave cards — THE ONLY
 * renderer of wave-to-wave connectors app-wide (design spec §2.13; the `→` literals died with it).
 * `pending` is the plain no-verdict style: connectors with no gate verdict pass it rather than
 * inventing one. Purely
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
  why,
  inert
}: {
  state: PromotionState;
  label?: string;
  detail?: string;
  why?: ReactNode;
  /** Presentation-only, and never a new `PromotionState` (owner ask 2026-08-14): the fan-in arrow
   *  drawn beneath a DISABLED source-mapping tile. The mapping is still declared — `state` stays
   *  whatever the caller passes (normally `"pending"`, since there is no gate verdict here either)
   *  — `inert` only lightens the fill and swaps the aria-label, so it reads as "this connector
   *  carries nothing right now" rather than an ordinary not-yet-evaluated wait. Omitted (the
   *  default), this component is pixel-for-pixel what it always was. */
  inert?: boolean;
}): React.JSX.Element {
  const style = STATE_STYLES[state];
  return (
    <div
      className="flex flex-col items-center py-1"
      data-testid="promotion-arrow"
      data-state={state}
      data-inert={inert ? "true" : undefined}
      aria-label={
        inert
          ? "connector inert (source disabled)"
          : `promotion ${state}${label ? `: ${label}` : ""}${detail ? ` — ${detail}` : ""}`
      }
    >
      <div className={`h-7 w-11 rounded-t-sm ${inert ? "bg-slate-200 opacity-60" : style.bar}`} />
      <div
        className={`h-0 w-0 border-x-[22px] border-x-transparent border-t-[18px] ${inert ? "border-t-slate-200 opacity-60" : style.triangle}`}
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
