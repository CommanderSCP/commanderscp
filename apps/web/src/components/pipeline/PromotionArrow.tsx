import type { ReactNode } from "react";

/** The gate and approval state between two waves. See docs/web.md §96. */
export type PromotionState = "open" | "blocked" | "approval" | "held" | "pending";

const STATE_STYLES: Record<PromotionState, { bar: string; triangle: string; text: string }> = {
  open: { bar: "bg-green-500", triangle: "border-t-green-500", text: "text-green-700" },
  blocked: { bar: "bg-red-500", triangle: "border-t-red-500", text: "text-red-700" },
  approval: { bar: "bg-amber-500", triangle: "border-t-amber-500", text: "text-amber-700" },
  held: { bar: "bg-indigo-500", triangle: "border-t-indigo-500", text: "text-indigo-700" },
  pending: { bar: "bg-slate-300", triangle: "border-t-slate-300", text: "text-slate-500" }
};

/** A wide arrow drawn between two stacked wave cards. See docs/web.md §97. */
export function PromotionArrow({
  state,
  label,
  detail,
  why,
  inert,
  onToggle,
  busy,
  toggleTitle
}: {
  state: PromotionState;
  label?: string;
  detail?: string;
  why?: ReactNode;
  /** Presentation-only, and never a new `PromotionState`. See docs/web.md §98. */
  inert?: boolean;
  /** THE ARROW IS THE SWITCH. See docs/web.md §99. */
  onToggle?: () => void;
  busy?: boolean;
  /** Tooltip for the switch — the parent states what a click does and what the colour means. */
  toggleTitle?: string;
}): React.JSX.Element {
  const style = STATE_STYLES[state];
  const isSwitch = typeof onToggle === "function";
  const Wrapper: "button" | "div" = isSwitch ? "button" : "div";
  return (
    <Wrapper
      {...(isSwitch
        ? {
            type: "button" as const,
            onClick: onToggle,
            disabled: busy,
            title: toggleTitle,
            "aria-pressed": !inert
          }
        : {})}
      className={`flex flex-col items-center py-1 ${
        isSwitch
          ? "cursor-pointer rounded-md px-2 transition-opacity hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-army-600 disabled:cursor-progress"
          : ""
      }`}
      data-testid="promotion-arrow"
      data-state={state}
      data-inert={inert ? "true" : undefined}
      data-switch={isSwitch ? (inert ? "closed" : "open") : undefined}
      aria-label={
        inert
          ? isSwitch
            ? "source closed — click to open (enable this mapping)"
            : "connector inert (source disabled)"
          : isSwitch
            ? "source open — click to close (disable this mapping)"
            : `promotion ${state}${label ? `: ${label}` : ""}${detail ? ` — ${detail}` : ""}`
      }
    >
      <div
        className={`h-7 w-11 rounded-t-sm ${
          inert ? (isSwitch ? "bg-red-500" : "bg-slate-200 opacity-60") : style.bar
        }`}
      />
      <div
        className={`h-0 w-0 border-x-[22px] border-x-transparent border-t-[18px] ${
          inert ? (isSwitch ? "border-t-red-500" : "border-t-slate-200 opacity-60") : style.triangle
        }`}
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
      {isSwitch && (
        // The switch says its state in words too — colour alone must not carry it (a11y, and the
        // "closed" slate is close to `pending`'s slate on a bad monitor).
        <span
          className={`mt-0.5 text-[10px] font-medium uppercase tracking-wide ${inert ? "text-red-700" : "text-green-700"}`}
        >
          {busy ? "…" : inert ? "closed" : "open"}
        </span>
      )}
    </Wrapper>
  );
}
