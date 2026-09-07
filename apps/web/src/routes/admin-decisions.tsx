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

/** ADMIN › DECISIONS. See docs/web.md §168. */

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
