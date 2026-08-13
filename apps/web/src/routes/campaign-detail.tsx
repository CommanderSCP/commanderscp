import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RollbackCampaignResponse } from "@scp/schemas";
import { client } from "../lib/client";
import { campaignDetailKey, campaignListKey } from "../lib/query-client";
import { useIdParam } from "../lib/use-route-params";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { PageHeader } from "../components/ui/page-header";
import { Skeleton } from "../components/ui/skeleton";
import { QueryErrorNotice } from "../components/query-error";
import { PipelineWaveCard } from "../components/pipeline/PipelineWaveCard";
import { useObjectNames } from "../lib/use-object-names";
import { PromotionArrow } from "../components/pipeline/PromotionArrow";
import { formatDate, wavePromotion } from "../components/pipeline/wave-status";
import { ReasonDialog } from "../components/decision/ReasonDialog";
import { decisionIdOf, decisionSummary } from "../components/decision/decision-format";
import { CampaignStatusBadge } from "./campaign-list";

function RollbackResultBanner({ result }: { result: RollbackCampaignResponse }): React.JSX.Element {
  return (
    <Card data-testid="rollback-result-banner">
      <CardHeader>
        <CardTitle>Rollback result</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <p className="text-slate-600">
          {result.rolledBack.length} rolled back · {result.skipped.length} skipped
        </p>
        {result.rolledBack.length > 0 && (
          <ul className="flex flex-col gap-1" data-testid="rollback-result-rolled-back-list">
            {result.rolledBack.map((entry) => (
              <li key={entry.originalChangeObjectId} className="text-slate-700">
                <Link
                  to="/changes/$id"
                  params={{ id: entry.rollbackChange.id }}
                  className="font-medium hover:underline"
                >
                  {entry.rollbackChange.name}
                </Link>{" "}
                <span className="font-mono text-xs text-slate-500">
                  (rollback of {entry.originalChangeObjectId})
                </span>
              </li>
            ))}
          </ul>
        )}
        {result.skipped.length > 0 && (
          <ul className="flex flex-col gap-1" data-testid="rollback-result-skipped-list">
            {result.skipped.map((entry) => (
              <li key={entry.originalChangeObjectId} className="text-slate-500">
                <span className="font-mono text-xs">{entry.originalChangeObjectId}</span>:{" "}
                {entry.reason}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * `/campaigns/{id}` (BUILD_AND_TEST.md §8 M5 UI requirement: "...+ wave board view") — one
 * `client.campaigns.explain()` call gets the campaign, its compiled plan/waves, and every
 * Decision made about it. Polls every 3s (`refetchInterval`), same reasoning as
 * change-detail.tsx: wave/target progress is written by the server-side reconciliation loop, not
 * user action.
 *
 * Wave board + Decisions render through the shared pipeline/decision module (design spec §2.13),
 * the same one change-detail.tsx uses — `PipelineWaveCard` gives campaign wave targets the same
 * version/executor/rollout detail and target-name resolution a change gets, and `PromotionArrow`
 * is the only wave-to-wave connector app-wide.
 */
export function CampaignDetailPage(): React.JSX.Element {
  const id = useIdParam();
  const queryClient = useQueryClient();
  const detailKey = campaignDetailKey(id ?? "");
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const [rollbackResult, setRollbackResult] = useState<RollbackCampaignResponse | null>(null);

  const explainQuery = useQuery({
    queryKey: detailKey,
    queryFn: () => client.campaigns.explain(id!),
    enabled: !!id,
    refetchInterval: 3000
  });

  async function invalidate(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: detailKey });
    await queryClient.invalidateQueries({ queryKey: campaignListKey() });
  }

  const rollbackMutation = useMutation({
    mutationFn: (reason: string) => client.campaigns.rollback(id!, reason),
    onSuccess: async (result) => {
      setRollbackOpen(false);
      setRollbackResult(result);
      await invalidate();
    },
    // A blocked rollback still wrote a Decision — refetch so the "Why?" link resolves to a row
    // that's actually in the timeline (same reasoning as change-detail.tsx's cancelMutation).
    onError: () => invalidate()
  });

  // Same supply side as change-detail (spec §4C): campaign wave targets are bare ids too.
  const targetNames = useObjectNames(
    (explainQuery.data?.plan?.waves ?? []).flatMap((w) => w.targets.map((t) => t.targetObjectId))
  );

  if (!id) {
    return <p className="text-sm text-red-600">Not found.</p>;
  }
  if (explainQuery.isLoading) {
    return <Skeleton className="h-24 w-full" />;
  }
  if (explainQuery.isError || !explainQuery.data) {
    return <QueryErrorNotice error={explainQuery.error ?? "Not found"} what="this campaign" />;
  }

  const { campaign, plan, decisions } = explainQuery.data;
  const rollbackDecisionId = decisionIdOf(rollbackMutation.error);
  const targetCount = campaign.targets.length;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={<span data-testid="campaign-name">{campaign.name}</span>}
        description={`${campaign.description ?? "No description"} · ${targetCount} target${targetCount === 1 ? "" : "s"}`}
        meta={<CampaignStatusBadge status={campaign.status} />}
        actions={
          <Button
            variant="outline"
            onClick={() => setRollbackOpen(true)}
            data-testid="rollback-campaign-button"
          >
            Roll back campaign
          </Button>
        }
      />

      {rollbackResult && <RollbackResultBanner result={rollbackResult} />}

      <Card>
        <CardHeader>
          <CardTitle>Wave board</CardTitle>
        </CardHeader>
        <CardContent>
          {!plan && (
            <p className="text-sm text-slate-500" data-testid="no-plan-message">
              No plan compiled yet.
            </p>
          )}
          {plan && plan.waves.length === 0 && (
            <p className="text-sm text-slate-500">Plan compiled with no waves.</p>
          )}
          {plan && plan.waves.length > 0 && (
            // Vertical, with PromotionArrow connectors — the same shape as change-detail's wave
            // progression (§2.13: PromotionArrow is the only wave connector app-wide; the
            // generalized PipelineWaveCard means this board never shows less than a change's).
            <div className="flex flex-col items-center gap-1" data-testid="campaign-wave-board">
              {plan.waves.map((wave, index) => {
                const next = plan.waves[index + 1];
                const promo = next ? wavePromotion(wave, next) : undefined;
                return (
                  <div key={wave.id} className="flex w-full flex-col items-center gap-1">
                    {/* `testIdPrefix="campaign-wave"` reproduces the wave board's historical
                        `campaign-wave-card` / `campaign-wave-status-badge` /
                        `campaign-wave-target-row` testids on the same elements. */}
                    <PipelineWaveCard wave={wave} waveNumber={index + 1} testIdPrefix="campaign-wave" nameOf={(tid) => targetNames.get(tid)?.name} />
                    {promo && <PromotionArrow state={promo.state} label={promo.label} />}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Decisions</CardTitle>
        </CardHeader>
        <CardContent>
          {decisions.length === 0 ? (
            <p className="text-sm text-slate-500">No decisions recorded yet.</p>
          ) : (
            <ul className="flex flex-col gap-3" data-testid="campaign-decision-timeline">
              {decisions.map((decision) => {
                const isLinkedFromError = decision.id === rollbackDecisionId;
                return (
                  <li
                    key={decision.id}
                    id={`decision-${decision.id}`}
                    className={`rounded-md border p-3 text-sm ${
                      isLinkedFromError ? "border-red-400 ring-2 ring-red-300" : "border-slate-200"
                    }`}
                    data-testid="campaign-decision-row"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-slate-900">{decision.kind}</span>
                      <Badge variant={decision.verdict === "allow" ? "success" : "danger"}>
                        {decision.verdict}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-slate-500">{formatDate(decision.createdAt)}</p>
                    <p className="mt-1 text-slate-600">{decisionSummary(decision)}</p>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <ReasonDialog
        open={rollbackOpen}
        title="Roll back campaign"
        description="Rolls back every currently-eligible member Change — each becomes its own new rollback Change. A reason is required."
        reasonRequired
        pending={rollbackMutation.isPending}
        errorMessage={
          rollbackMutation.isError
            ? rollbackMutation.error instanceof Error
              ? rollbackMutation.error.message
              : "Failed to roll back"
            : null
        }
        errorDecisionId={rollbackDecisionId}
        onOpenChange={setRollbackOpen}
        onSubmit={(reason) => rollbackMutation.mutate(reason)}
        submitLabel="Roll back"
        testIdPrefix="rollback-campaign"
      />
    </div>
  );
}
