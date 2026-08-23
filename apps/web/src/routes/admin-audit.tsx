import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ScrollText } from "lucide-react";
import type { AuditEvent, Decision } from "@scp/schemas";
import { client } from "../lib/client";
import { cn, focusRing } from "../lib/utils";
import { Alert } from "../components/ui/alert";
import { EmptyState } from "../components/ui/empty-state";
import { PageHeader } from "../components/ui/page-header";
import { SkeletonRows } from "../components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "../components/ui/table";
import { Button } from "../components/ui/button";
import { QueryErrorNotice } from "../components/query-error";
import { DecisionDetailDialog } from "../components/decision/DecisionDetailDialog";
import { formatRelative } from "./admin-dependencies";

/**
 * ADMIN › AUDIT — the hash-chained audit log, browsable (owner-approved 2026-08-23; charter
 * principle 6: "audit events are hash-chained and written in the same transaction as the action";
 * server route `GET /api/v1/audit-events`, `apps/server/src/routes/audit-events.ts`; SDK
 * `client.auditEvents.list`).
 *
 * WIRE ORDER, STATED HONESTLY: `listAuditEvents` (`audit/audit-repo.ts`) orders ascending by `seq`
 * — "the order `scp audit verify` needs to re-walk the chain" per that module's own doc comment —
 * and the cursor only ever moves forward (`gt(seq, afterSeq)`). There is no descending/newest-first
 * request this API can answer; this table therefore reads OLDEST FIRST, walking the chain from its
 * start, exactly like every consumer of this endpoint. It is not a "recent activity" feed — an org
 * with a long history needs several "Load more" clicks to reach today. Flagged in openQuestions as
 * a real usability gap, not silently reversed client-side: reversing per PAGE (the only thing this
 * cursor lets you fetch) would not produce newest-first order at all, only a scrambled one.
 *
 * INTEGRITY IS NOT PROVEN HERE: the chain hash is verified by `scp audit verify` (the CLI walks
 * `beforeHash`/`afterHash`/`prevHash`/`rowHash`) — this page renders the rows the server returns and
 * makes no claim about the chain's integrity beyond that. Stated in the header, not implied by
 * merely displaying the hash columns.
 *
 * `audit:read` gate (M16.3 offer-the-write — the READ, here — rule): a viewer without the
 * permission gets the server's 403 rendered verbatim by `QueryErrorNotice`, the same as every other
 * admin read in this app; the page issues the one read and shows whatever it says.
 */

function DecisionIdCell({ decisionId }: { decisionId: string }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [error, setError] = useState<unknown>(null);

  const show = () => {
    setOpen(true);
    setError(null);
    client.decisions
      .get(decisionId)
      .then((d) => setDecision(d))
      .catch((e: unknown) => setError(e));
  };

  return (
    <>
      <button
        type="button"
        className={cn("rounded font-medium text-red-700 underline hover:text-red-900", focusRing)}
        onClick={show}
        data-testid="audit-decision-why"
      >
        Why?
      </button>
      <DecisionDetailDialog
        decision={decision}
        error={error}
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setDecision(null);
            setError(null);
          }
        }}
      />
    </>
  );
}

function ReasonCell({ reason }: { reason: string | null }): React.JSX.Element {
  if (reason === null) return <span className="text-slate-400">—</span>;
  const excerpt = reason.length > 80 ? `${reason.slice(0, 80)}…` : reason;
  if (excerpt === reason) {
    return (
      <span className="text-sm text-slate-700" data-testid="audit-reason">
        {reason}
      </span>
    );
  }
  return (
    <details data-testid="audit-reason">
      <summary className="cursor-pointer text-sm text-slate-700" data-testid="audit-reason-excerpt">
        {excerpt}
      </summary>
      <p
        className="mt-1 max-w-md break-words text-sm text-slate-700"
        data-testid="audit-reason-full"
      >
        {reason}
      </p>
    </details>
  );
}

function AuditRow({ event }: { event: AuditEvent }): React.JSX.Element {
  return (
    <TableRow data-testid="audit-list-row">
      <TableCell>
        <span title={event.occurredAt} data-testid="audit-at">
          {formatRelative(event.occurredAt)}
        </span>
      </TableCell>
      <TableCell className="font-mono text-xs text-slate-700" data-testid="audit-action">
        {event.action}
      </TableCell>
      <TableCell className="font-mono text-xs text-slate-600" data-testid="audit-actor">
        {event.actorId}
      </TableCell>
      <TableCell>
        {event.subjectId === null ? (
          <span className="text-slate-400">—</span>
        ) : (
          <Link
            to="/graph/$idOrUrn"
            params={{ idOrUrn: event.subjectId }}
            className={cn("font-mono text-xs text-slate-700 underline", focusRing)}
            data-testid="audit-subject-link"
            title={event.subjectId}
          >
            {event.subjectId.slice(0, 8)}…
          </Link>
        )}
      </TableCell>
      <TableCell>
        <ReasonCell reason={event.reason} />
      </TableCell>
      <TableCell>
        {event.decisionId === null ? (
          <span className="text-slate-400">—</span>
        ) : (
          <DecisionIdCell decisionId={event.decisionId} />
        )}
      </TableCell>
    </TableRow>
  );
}

export function AdminAuditPage(): React.JSX.Element {
  const query = useInfiniteQuery({
    queryKey: ["audit-events", "list"],
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      client.auditEvents.list({ limit: 50, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined
  });

  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  // A 403 is a legitimate outcome of the one read this page issues, not a contract failure — the
  // generic diagnosis in `QueryErrorNotice` names it (`error.message`, RFC 9457 `detail` carried
  // verbatim), so no special-casing is needed beyond making sure it is never swallowed as "empty".

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Audit log"
        description="The hash-chained audit log, walked in chain order from its start (oldest first) — not a recent-activity feed."
      />
      <Alert tone="neutral" data-testid="audit-integrity-note">
        Chain integrity (the hash links between rows) is verified by <code>scp audit verify</code>,
        never by this page — this table only renders what the server returns.
      </Alert>

      {query.isLoading ? (
        <SkeletonRows n={5} />
      ) : query.error ? (
        <QueryErrorNotice error={query.error} what="the audit log" testId="audit-error" />
      ) : items.length === 0 ? (
        <EmptyState icon={ScrollText} message="No audit events yet." data-testid="audit-empty" />
      ) : (
        <div className="flex flex-col gap-3">
          <Table data-testid="audit-table">
            <TableHeader>
              <TableRow>
                <TableHead>At</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Decision</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((event) => (
                <AuditRow key={event.id} event={event} />
              ))}
            </TableBody>
          </Table>
          {query.hasNextPage && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
              data-testid="audit-load-more"
            >
              {query.isFetchingNextPage ? "Loading…" : `Load more (${items.length} loaded)`}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
