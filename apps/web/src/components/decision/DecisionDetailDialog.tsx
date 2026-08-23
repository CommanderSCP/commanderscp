import type { Decision } from "@scp/schemas";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "../ui/dialog";
import { decisionSummary } from "./decision-format";

/**
 * The shared FULL-RECORD view of one Decision (charter principle 6) — opened from a Why-style
 * affordance on `/admin/decisions` and `/admin/audit`. Every gate/policy engine writes a Decision
 * with its `verdict`, `reasonTree` and `inputContext`; this is the one place all three render,
 * so a future adopter reuses it rather than re-implementing reason formatting.
 *
 * NOT `WhyLink`/`ReasonDialog`: `WhyLink` anchors within a change's OWN Decisions timeline (or
 * navigates to one) — it has nothing to scroll to on a standalone Decisions/Audit list, which shows
 * every subject's Decisions in one table, not one change's. `ReasonDialog` is the REASON-INPUT
 * dialog behind cancel/rollback, a different concept entirely (it collects a reason, it does not
 * render one). This dialog is the missing third piece: a stand-alone viewer, keyed by id, reusing
 * `decisionSummary` (`decision-format.ts`) for the one-line summary exactly as the change/campaign
 * timelines do — "one renderer for reasons, everywhere" holds at the FORMATTING layer even though
 * the container is new.
 *
 * `decision === null` covers the fetch-in-flight and fetch-failed states (`error` is rendered
 * verbatim by the caller, never invented here) so this component never shows a stale record under a
 * new id.
 */

/** `allow` is the only verdict every gate agrees reads as "unblocked" — `verdict` is a free string
 *  (packages/schemas/src/changes.ts), not a bounded enum, so anything else renders as `danger`
 *  rather than guessing a third tone for strings this UI has never seen. Matches the existing rule
 *  in `routes/change-detail.tsx` and `routes/campaign-detail.tsx`. */
export function decisionVerdictBadgeVariant(verdict: string): "success" | "danger" {
  return verdict === "allow" ? "success" : "danger";
}

export function DecisionDetailDialog({
  decision,
  open,
  error,
  onOpenChange
}: {
  decision: Decision | null;
  open: boolean;
  /** Set when the fetch-by-id failed (the audit page's WhyLink-equivalent fetches on demand). */
  error?: unknown;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="decision-detail-dialog">
        <DialogHeader>
          <DialogTitle>{decision ? decision.kind : "Decision"}</DialogTitle>
          <DialogDescription>
            {decision ? (
              <span title={decision.createdAt}>
                {new Date(decision.createdAt).toLocaleString()}
              </span>
            ) : error !== undefined && error !== null ? (
              "Could not load this Decision."
            ) : (
              "Loading…"
            )}
          </DialogDescription>
        </DialogHeader>
        {decision && (
          <div className="flex flex-col gap-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant={decisionVerdictBadgeVariant(decision.verdict)}
                data-testid="decision-detail-verdict"
              >
                {decision.verdict}
              </Badge>
              <span className="font-mono text-xs text-slate-500" data-testid="decision-detail-id">
                {decision.id}
              </span>
            </div>
            <p className="text-slate-700" data-testid="decision-detail-summary">
              {decisionSummary(decision)}
            </p>
            <details className="rounded-md border border-slate-200 p-2">
              <summary className="cursor-pointer text-xs font-medium text-slate-600">
                Full reason tree
              </summary>
              <pre
                className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs text-slate-600"
                data-testid="decision-detail-reason-tree"
              >
                {JSON.stringify(decision.reasonTree, null, 2)}
              </pre>
            </details>
            <details className="rounded-md border border-slate-200 p-2">
              <summary className="cursor-pointer text-xs font-medium text-slate-600">
                Input context
              </summary>
              <pre
                className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs text-slate-600"
                data-testid="decision-detail-input-context"
              >
                {JSON.stringify(decision.inputContext, null, 2)}
              </pre>
            </details>
          </div>
        )}
        {!decision && error !== undefined && error !== null && (
          <p className="break-words text-sm text-red-600" data-testid="decision-detail-error">
            {error instanceof Error ? error.message : String(error)}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
