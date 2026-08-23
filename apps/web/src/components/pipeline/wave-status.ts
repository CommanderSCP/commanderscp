import type { BadgeProps } from "../ui/badge";
import type { PromotionState } from "./PromotionArrow";

/**
 * THE ONE wave-status vocabulary (design spec §2.13) — shared by the change detail wave
 * progression, the change pipeline view, and (after its own migration) the campaign wave board.
 *
 * MODULE CONTRACT for consumers that are migrated later (campaign-detail.tsx): everything here is
 * structural — helpers take a bare `status` string (wave/wave-target `status` is free-form on the
 * wire; the reconciliation loop only ever writes pending/running/succeeded/failed, DESIGN.md §9.3)
 * or a `{ status: string }`-shaped pair, so ChangeWave and CampaignWave both satisfy the inputs
 * without this module importing either type. No changes here are needed to adopt it.
 */

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

/**
 * Inter-wave promotion state, derived ONLY from wave status (coordination-ui-views.md Layer A).
 * Wave-to-wave promotion is automatic server-side reconcile — the gate/approval machinery is a
 * change-level concern surfaced on the FINAL arrow, so we do not attribute an approval/deny to a
 * specific inter-wave arrow (that would be inventing a per-wave gate the model does not have).
 * `pending` is the plain no-verdict connector (§2.13): nothing failed and nothing was denied,
 * there is simply no verdict to paint.
 */
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
