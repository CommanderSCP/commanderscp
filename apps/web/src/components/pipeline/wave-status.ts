import type { BadgeProps } from "../ui/badge";
import type { PromotionState } from "./PromotionArrow";

/** THE ONE wave-status vocabulary (design spec §2.13). See docs/web.md §100. */

export function formatDate(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

/** Wave/wave-target `status` -> Badge tone (§1.5). Anything unrecognised falls back to `neutral` —
 *  never a status color the model did not claim. */
export function waveStatusTone(status: string): BadgeProps["variant"] {
  switch (status) {
    case "running":
      return "info";
    case "succeeded":
      return "success";
    case "failed":
      return "danger";
    case "pending":
    default:
      return "neutral";
  }
}

/** @deprecated legacy name — kept only for pre-migration importers (service-board via
 *  routes/change-detail's re-export); use `waveStatusTone`. Deleted at the end of group E. */
export const waveStatusVariant = waveStatusTone;

/** The wave card's border treatment: the currently-active wave (`running`) gets a highlighted
 *  border; `failed` a red one; others muted. Color families follow the §1.5 tones. */
export function waveStatusBorder(status: string): string {
  switch (status) {
    case "running":
      return "border-blue-500 ring-1 ring-blue-500";
    case "failed":
      return "border-red-400";
    case "succeeded":
      return "border-emerald-300";
    case "skipped":
      return "border-slate-200 opacity-60";
    default:
      return "border-slate-200 opacity-80";
  }
}

/** Inter-wave promotion state, derived ONLY from wave status. See docs/web.md §101. */
export function wavePromotion(
  upstream: { status: string },
  downstream: { status: string }
): { state: PromotionState; label?: string } {
  if (upstream.status === "failed") return { state: "blocked", label: "upstream wave failed" };
  if (downstream.status === "failed") return { state: "blocked", label: "wave failed" };
  // KEEP-SENSE (ADR-0021 D2): this is an artifact advancing wave-to-wave — a *promotion*, the
  // genus. It is NOT the change-lifecycle `accept` gate (change-pipeline's `finalGate`).
  if (downstream.status === "running" || downstream.status === "succeeded")
    return { state: "open", label: "promoted" };
  if (downstream.status === "skipped") return { state: "pending", label: "skipped" };
  if (upstream.status === "succeeded" && downstream.status === "pending")
    return { state: "pending", label: "awaiting promotion" };
  return { state: "pending" };
}
