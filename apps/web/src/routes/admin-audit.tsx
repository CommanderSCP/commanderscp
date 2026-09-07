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

/** ADMIN › AUDIT. See docs/web.md §166. */

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
