import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { ServiceBoardRow, ServiceBoardStage } from "@scp/sdk";
import { client } from "../lib/client";
import { serviceBoardKey } from "../lib/query-client";
import { useIdParam } from "../lib/use-route-params";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "../components/ui/table";
import { stateBadgeVariant } from "./change-list";
import { waveStatusVariant, formatDate } from "./change-detail";
import type { ChangeState } from "@scp/schemas";

/** A "Why?" link into the blocked change's Decisions timeline (its `#decision-<id>` anchor) —
 *  same explainability surface the Phase-1 pipeline view links to (charter principle 6). */
function WhyLink({ changeId, decisionId }: { changeId: string; decisionId: string }): React.JSX.Element {
  return (
    <Link
      to="/changes/$id"
      params={{ id: changeId }}
      hash={`decision-${decisionId}`}
      className="font-medium text-red-700 underline hover:text-red-900"
      data-testid="board-why-link"
    >
      Why?
    </Link>
  );
}

/** The per-stage status badges for a row — one badge per compiled wave, colored by wave status
 *  (reusing the Phase-1 mapping). A partial-failure stage (some targets failed) shows the count. */
function StageStrip({ stages }: { stages: ServiceBoardStage[] }): React.JSX.Element {
  if (stages.length === 0) {
    return <span className="text-xs text-slate-400">no plan compiled</span>;
  }
  return (
    <div className="flex flex-wrap items-center gap-1" data-testid="board-stage-strip">
      {stages.map((s) => (
        <Badge
          key={s.waveIndex}
          variant={waveStatusVariant(s.status)}
          title={`${s.name ?? `Wave ${s.waveIndex}`} — ${s.status} (${s.targetCount} target${s.targetCount === 1 ? "" : "s"}${s.failedTargets > 0 ? `, ${s.failedTargets} failed` : ""})`}
          data-testid="board-stage-badge"
        >
          {s.name ?? `W${s.waveIndex}`}: {s.status}
          {s.failedTargets > 0 ? ` (${s.failedTargets}✗)` : ""}
        </Badge>
      ))}
    </div>
  );
}

/** The attention cell — the BLOCKED signal surfaced in red (with the decision_id "Why?" link where
 *  present), plus awaiting-approval and emergency chips. Stable/clean rows read as a muted dash. */
function AttentionCell({ row }: { row: ServiceBoardRow }): React.JSX.Element {
  const { attention, latestChangeId } = row;
  const clean = !attention.blocked && !attention.awaitingApproval && !attention.emergency;
  if (clean) return <span className="text-slate-400">—</span>;
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="board-attention">
      {attention.blocked && (
        <span
          className="inline-flex items-center gap-1.5 rounded bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-700"
          data-testid="board-blocked"
        >
          Blocked
          {latestChangeId && attention.decisionId && (
            <WhyLink changeId={latestChangeId} decisionId={attention.decisionId} />
          )}
        </span>
      )}
      {attention.awaitingApproval && (
        <Badge variant="secondary" data-testid="board-awaiting">
          Awaiting approval
        </Badge>
      )}
      {attention.emergency && (
        <Badge variant="destructive" data-testid="board-emergency">
          Emergency
        </Badge>
      )}
    </div>
  );
}

/**
 * `/services/{id}/board` — the Service release board (coordination-ui-views.md § "Service release
 * board", Phase 2, Layer A). One scannable table of the service's components: each row shows that
 * component's latest change per-stage status, its current stage, and any attention signal (the
 * BLOCKED component surfaced in red with a decision_id "Why?" link), and opens the Phase-1 component
 * pipeline. A summary strip counts releasing / blocked / stable.
 *
 * Strictly Layer A — real data only. Per-stage image versions/digests and component health are Layer
 * B (not modeled yet); they are shown as an explicit placeholder, never fabricated. Freezes are
 * READ-ONLY status here; declaring/lifting one is a controls-phase concern (Phase 5), so the
 * "Freeze service" affordance is present but disabled.
 */
export function ServiceBoardPage(): React.JSX.Element {
  const id = useIdParam();

  const boardQuery = useQuery({
    queryKey: serviceBoardKey(id ?? ""),
    queryFn: () => client.services.board(id!),
    enabled: !!id,
    refetchInterval: 4000
  });

  if (!id) return <p className="text-sm text-red-600">Not found.</p>;
  if (boardQuery.isLoading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (boardQuery.isError || !boardQuery.data) {
    return (
      <p className="text-sm text-red-600">
        {boardQuery.error instanceof Error ? boardQuery.error.message : "Not found"}
      </p>
    );
  }

  const board = boardQuery.data;
  const { service, rows, summary, serviceFreeze } = board;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold text-slate-900" data-testid="board-service-name">
              {service.name}
            </h1>
            {serviceFreeze && (
              <Badge variant="secondary" title={`Frozen until ${formatDate(serviceFreeze.endsAt)}: ${serviceFreeze.reason}`} data-testid="board-service-freeze">
                Frozen
              </Badge>
            )}
          </div>
          <p className="font-mono text-xs text-slate-500">{service.urn}</p>
          <p className="mt-1 text-sm text-slate-500">Service release board · Layer A (real data only)</p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to="/$basePath/$idOrUrn"
            params={{ basePath: "services", idOrUrn: service.id }}
            className="text-sm font-medium text-slate-600 underline hover:text-slate-900"
            data-testid="board-to-detail-link"
          >
            Service detail →
          </Link>
          {/* Operator control — deferred to the controls phase (Phase 5). Present to match the
              mockup, but intentionally NOT wired to a mutation here (honesty over completeness). */}
          <Button
            variant="outline"
            disabled
            title="Declaring a freeze window is a controls-phase feature (Phase 5) — not available on the read board yet."
            data-testid="board-freeze-service"
          >
            Freeze service
          </Button>
        </div>
      </div>

      {/* Summary strip: releasing / blocked / stable. */}
      <div className="flex flex-wrap gap-3" data-testid="board-summary">
        <SummaryStat label="Releasing" value={summary.releasing} variant="info" />
        <SummaryStat label="Blocked" value={summary.blocked} variant="destructive" />
        <SummaryStat label="Stable" value={summary.stable} variant="success" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Components ({rows.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-sm text-slate-500" data-testid="board-empty">
              This service contains no components.
            </p>
          ) : (
            <Table data-testid="board-table">
              <TableHeader>
                <TableRow>
                  <TableHead>Component</TableHead>
                  <TableHead>Latest change</TableHead>
                  <TableHead>Current stage</TableHead>
                  <TableHead>Stages</TableHead>
                  <TableHead>Attention</TableHead>
                  {/* Layer B — not modeled today; explicit placeholder header. */}
                  <TableHead title="Per-stage image version/digest and health are not captured yet (Layer B)">
                    Version / Health
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.component.id} data-testid="board-row" data-blocked={row.attention.blocked}>
                    <TableCell>
                      <Link
                        to="/$basePath/$idOrUrn"
                        params={{ basePath: "components", idOrUrn: row.component.id }}
                        className="font-medium text-slate-900 hover:underline"
                        data-testid="board-component-link"
                      >
                        {row.component.name}
                      </Link>
                      {row.activeFreeze && (
                        <Badge
                          variant="secondary"
                          className="ml-2"
                          title={`Frozen until ${formatDate(row.activeFreeze.endsAt)}: ${row.activeFreeze.reason}`}
                          data-testid="board-component-freeze"
                        >
                          Frozen
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {row.latestChangeId ? (
                        <div className="flex flex-col gap-0.5">
                          <Link
                            to="/changes/$id/pipeline"
                            params={{ id: row.latestChangeId }}
                            className="font-medium text-slate-700 underline hover:text-slate-900"
                            data-testid="board-pipeline-link"
                          >
                            {row.changeName ?? "Open pipeline"} →
                          </Link>
                          {row.changeState && (
                            <span>
                              <Badge variant={stateBadgeVariant(row.changeState as ChangeState)}>
                                {row.changeState}
                              </Badge>
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-sm text-slate-400" data-testid="board-no-change">
                          no active change
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {row.currentStage ? (
                        <span className="text-sm text-slate-700">{row.currentStage}</span>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <StageStrip stages={row.stages} />
                    </TableCell>
                    <TableCell>
                      <AttentionCell row={row} />
                    </TableCell>
                    <TableCell>
                      {/* Layer B — never a fabricated version/health. */}
                      <span className="text-slate-400" title="Not captured yet (Layer B)">—</span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-slate-400">
        Per-stage image version/digest and component health are not modeled yet (Layer B) and are shown
        as &quot;—&quot;. Freezes are read-only here; declaring or lifting one lands in a later controls
        phase.
      </p>
    </div>
  );
}

function SummaryStat({
  label,
  value,
  variant
}: {
  label: string;
  value: number;
  variant: "info" | "destructive" | "success";
}): React.JSX.Element {
  return (
    <div
      className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2"
      data-testid={`board-summary-${label.toLowerCase()}`}
    >
      <span className="text-2xl font-semibold text-slate-900">{value}</span>
      <Badge variant={variant}>{label}</Badge>
    </div>
  );
}
