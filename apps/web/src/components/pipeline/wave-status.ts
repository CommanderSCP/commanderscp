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

/** A wave TARGET row's outline tone (owner mockup, 2026-09-11: "a colored outline indicating
 *  status" replaces the filled-plate badge as the row's primary status carrier — design-system
 *  §1.6a). A hold OUTRANKS the raw status, mirroring the held-badge tone rule PipelineWaveCard
 *  already applies: a freeze/continuous-probe hold is `warning` (operator-declared or a probe gone
 *  quiet — needs attention), a stage-dependency-only hold is `info` (self-clearing). Anything else
 *  falls to the target's own status; `pending`/unrecognised renders `idle` — dashed, never a color
 *  claim, because "nothing has happened yet" is not the same fact as "succeeded" or "failed". */
export type TargetOutlineTone = "success" | "info" | "warning" | "danger" | "idle";

export function targetOutlineTone(
  status: string,
  holdTone: "warning" | "info" | null
): TargetOutlineTone {
  if (holdTone) return holdTone;
  switch (status) {
    case "running":
      return "info";
    case "succeeded":
      return "success";
    case "failed":
      return "danger";
    default:
      return "idle";
  }
}

const TARGET_OUTLINE_BORDER: Record<TargetOutlineTone, string> = {
  success: "border-emerald-400",
  info: "border-blue-400",
  warning: "border-amber-400",
  danger: "border-red-400",
  // Dashed, not just a muted solid: the mockup's `s-idle` rule (target-redesign.html) — an untouched
  // target must not share a border style with a real outcome at low contrast.
  idle: "border-dashed border-slate-300"
};

/** The row's outline classes for one tone. See `TargetOutlineTone`. */
export function targetOutlineBorder(tone: TargetOutlineTone): string {
  return TARGET_OUTLINE_BORDER[tone];
}

const TARGET_RETICLE_TONE: Record<TargetOutlineTone, string> = {
  success: "text-emerald-600",
  info: "text-blue-600",
  warning: "text-amber-600",
  danger: "text-red-600",
  idle: "text-slate-400"
};

/** The TargetReticle mark's color for one tone — "the reticle picks up the same hue" (owner). */
export function targetReticleTone(tone: TargetOutlineTone): string {
  return TARGET_RETICLE_TONE[tone];
}

const TARGET_STATUS_TEXT_TONE: Record<TargetOutlineTone, string> = {
  success: "text-emerald-700",
  info: "text-blue-700",
  warning: "text-amber-800",
  danger: "text-red-700",
  idle: "text-slate-500"
};

/** The kept status WORD's color (colour-blind readers must not rely on the outline alone — the
 *  owner session flagged this and it was never explicitly declined, so the word stays). */
export function targetStatusTextTone(tone: TargetOutlineTone): string {
  return TARGET_STATUS_TEXT_TONE[tone];
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
