import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { FileSearch } from "lucide-react";
import type { Decision } from "@scp/schemas";
import { client } from "../lib/client";
import { useSubjectIdSearchForDecisions } from "../lib/use-route-params";
import { cn, focusRing } from "../lib/utils";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { EmptyState } from "../components/ui/empty-state";
import { Input } from "../components/ui/input";
import { PageHeader } from "../components/ui/page-header";
import { SectionLabel } from "../components/ui/section-label";
import { SkeletonRows } from "../components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "../components/ui/table";
import { QueryErrorNotice } from "../components/query-error";
import {
  DecisionDetailDialog,
  decisionVerdictBadgeVariant
} from "../components/decision/DecisionDetailDialog";
import { formatRelative } from "./admin-dependencies";

/**
 * ADMIN › DECISIONS — every Decision record browsable, not just the one-at-a-time `WhyLink`
 * (owner-approved 2026-08-23; charter principle 6: "every engine verdict persists a Decision
 * record with its inputs"; server route `GET /api/v1/decisions`,
 * `apps/server/src/routes/changes.ts`; SDK `client.decisions.list/get`).
 *
 * FILTERS AS THE WIRE PROVIDES THEM, no more: `DecisionListQuerySchema`
 * (packages/schemas/src/changes.ts) carries exactly `subjectId` and `kind` besides cursor/limit —
 * both offered here as real server-side filters, nothing client-side pretending to be one. `kind`
 * answers "which mechanism", not "what happened" — several kinds carry more than one verdict
 * against the same subject (see the schema's own doc comment), which is why the verdict badge is
 * still per-row rather than folded into the filter.
 *
 * CURSOR PAGING, ONE PAGE EAGER: the `decisions` table once grew 1.44 GB/day in a production
 * incident (a reconcile loop re-writing a byte-identical Decision every tick) — this page fetches
 * exactly one page on load and one more per explicit "Load more" click, never on a timer and never
 * unbounded.
 *
 * WIRE ORDER, NOT RECENCY: `listDecisions` (`coordination/decisions-repo.ts`) orders ascending by
 * `(createdAt, id)` — the same keyset-ascending convention every list endpoint in this app uses —
 * so this table reads oldest-first within whatever filter is applied; "Load more" reveals LATER
 * rows, not older ones. There is no server-side descending order to request.
 *
 * The Why-style affordance opens `DecisionDetailDialog` (`components/decision/`) — the same
 * `decisionSummary` formatting `change-detail.tsx`/`campaign-detail.tsx` use for their inline
 * timelines, in a standalone viewer keyed by id (see that component's doc for why it is not
 * literally `WhyLink`/`ReasonDialog`).
 *
 * Honest empties: the "No decisions" state renders ONLY after a successful zero-row read, never
 * while pending, and a failed read shows `QueryErrorNotice`'s diagnosis instead of a table.
 */

type DecisionFilters = { subjectId?: string; kind?: string };

function SubjectCell({ subjectId }: { subjectId: string }): React.JSX.Element {
  return (
    <Link
      to="/graph/$idOrUrn"
      params={{ idOrUrn: subjectId }}
      className={cn("font-mono text-xs text-slate-700 underline", focusRing)}
      data-testid="decision-subject-link"
      title={subjectId}
    >
      {subjectId.slice(0, 8)}…
    </Link>
  );
}

function DecisionRow({
  decision,
  onShowReason
}: {
  decision: Decision;
  onShowReason: (decision: Decision) => void;
}): React.JSX.Element {
  return (
    <TableRow data-testid="decision-list-row">
      <TableCell>
        <span title={decision.createdAt} data-testid="decision-created-at">
          {formatRelative(decision.createdAt)}
        </span>
      </TableCell>
      <TableCell className="font-mono text-xs text-slate-700" data-testid="decision-kind">
        {decision.kind}
      </TableCell>
      <TableCell>
        <SubjectCell subjectId={decision.subjectId} />
      </TableCell>
      <TableCell>
        <Badge
          variant={decisionVerdictBadgeVariant(decision.verdict)}
          data-testid="decision-verdict"
        >
          {decision.verdict}
        </Badge>
      </TableCell>
      <TableCell className="font-mono text-xs text-slate-500" title={decision.id}>
        {decision.id.slice(0, 8)}…
      </TableCell>
      <TableCell>
        <button
          type="button"
          className={cn("rounded font-medium text-red-700 underline hover:text-red-900", focusRing)}
          onClick={() => onShowReason(decision)}
          data-testid="decision-why"
        >
          Why?
        </button>
      </TableCell>
    </TableRow>
  );
}

export function AdminDecisionsPage(): React.JSX.Element {
  const searchSubjectId = useSubjectIdSearchForDecisions();
  const [subjectIdInput, setSubjectIdInput] = useState(searchSubjectId ?? "");
  const [kindInput, setKindInput] = useState("");
  const [filters, setFilters] = useState<DecisionFilters>({
    subjectId: searchSubjectId || undefined
  });
  const [shown, setShown] = useState<Decision | null>(null);

  const query = useInfiniteQuery({
    queryKey: ["decisions", "list", filters],
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      client.decisions.list({
        limit: 20,
        ...(filters.subjectId ? { subjectId: filters.subjectId } : {}),
        ...(filters.kind ? { kind: filters.kind } : {}),
        ...(pageParam ? { cursor: pageParam } : {})
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined
  });

  const applyFilters = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setFilters({
      subjectId: subjectIdInput.trim() || undefined,
      kind: kindInput.trim() || undefined
    });
  };

  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const hasFilters = filters.subjectId !== undefined || filters.kind !== undefined;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Decisions"
        description="Every engine verdict this org has written, with its inputs (charter principle 6) — filtered as the API allows, oldest first within a filter."
      />

      <form
        className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-3"
        onSubmit={applyFilters}
        data-testid="decision-filters"
      >
        <label className="flex flex-col gap-1">
          <SectionLabel as="span">Subject id</SectionLabel>
          <Input
            value={subjectIdInput}
            onChange={(e) => setSubjectIdInput(e.target.value)}
            placeholder="object id"
            className="w-72"
            data-testid="decision-filter-subject"
          />
        </label>
        <label className="flex flex-col gap-1">
          <SectionLabel as="span">Kind</SectionLabel>
          <Input
            value={kindInput}
            onChange={(e) => setKindInput(e.target.value)}
            placeholder="e.g. stage_dependency"
            className="w-56"
            data-testid="decision-filter-kind"
          />
        </label>
        <Button type="submit" variant="outline" size="sm" data-testid="decision-filter-apply">
          Filter
        </Button>
      </form>

      {query.isLoading ? (
        <SkeletonRows n={5} />
      ) : query.error ? (
        <QueryErrorNotice error={query.error} what="Decision records" testId="decisions-error" />
      ) : items.length === 0 ? (
        <EmptyState
          icon={FileSearch}
          message={hasFilters ? "No decisions match these filters." : "No decisions yet."}
          data-testid="decisions-empty"
        />
      ) : (
        <div className="flex flex-col gap-3">
          <Table data-testid="decisions-table">
            <TableHeader>
              <TableRow>
                <TableHead>Created</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead>Verdict</TableHead>
                <TableHead>Id</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((decision) => (
                <DecisionRow key={decision.id} decision={decision} onShowReason={setShown} />
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
              data-testid="decisions-load-more"
            >
              {query.isFetchingNextPage ? "Loading…" : `Load more (${items.length} loaded)`}
            </Button>
          )}
        </div>
      )}

      <DecisionDetailDialog
        decision={shown}
        open={shown !== null}
        onOpenChange={(open) => {
          if (!open) setShown(null);
        }}
      />
    </div>
  );
}
