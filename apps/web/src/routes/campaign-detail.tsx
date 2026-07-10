import { useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ScpApiError } from "@scp/sdk";
// M5 types: @scp/schemas, not @scp/sdk — same reasoning as campaign-list.tsx's header comment.
import type {
  CampaignWave,
  CampaignWaveTarget,
  Decision,
  RollbackCampaignResponse
} from "@scp/schemas";
import { client } from "../lib/client";
import { campaignDetailKey, campaignListKey } from "../lib/query-client";
import { useIdParam } from "../lib/use-route-params";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge, type BadgeProps } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "../components/ui/dialog";
import { campaignStatusBadgeVariant } from "./campaign-list";

function formatDate(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

/** Wave/wave-target `status` -> Badge variant. Values are free-form strings server-side
 *  (CampaignWaveSchema/CampaignWaveTargetSchema, same convention as change-detail.tsx's
 *  waveStatusVariant), but the reconciliation loop only ever writes pending/running/succeeded/
 *  failed — anything else falls back to `secondary`. */
function campaignWaveStatusVariant(status: string): BadgeProps["variant"] {
  switch (status) {
    case "running":
      return "info";
    case "succeeded":
      return "success";
    case "failed":
      return "destructive";
    case "pending":
      return "outline";
    default:
      return "secondary";
  }
}

function campaignWaveCardClass(status: string): string {
  switch (status) {
    case "running":
      return "border-blue-500 ring-1 ring-blue-500";
    case "failed":
      return "border-red-400";
    case "succeeded":
      return "border-green-300";
    default:
      return "border-slate-200 opacity-75";
  }
}

function CampaignWaveCard({ wave }: { wave: CampaignWave }): React.JSX.Element {
  return (
    <Card
      className={`w-80 shrink-0 ${campaignWaveCardClass(wave.status)}`}
      data-testid="campaign-wave-card"
    >
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">
            Wave {wave.waveIndex}
            {wave.name ? `: ${wave.name}` : ""}
          </CardTitle>
          <Badge
            variant={campaignWaveStatusVariant(wave.status)}
            data-testid="campaign-wave-status-badge"
          >
            {wave.status}
          </Badge>
        </div>
        <p className="text-xs text-slate-500">
          Started {formatDate(wave.startedAt)} · Completed {formatDate(wave.completedAt)}
          {wave.requiresFanIn ? " · requires fan-in" : ""}
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {wave.targets.length === 0 && <p className="text-sm text-slate-500">No targets.</p>}
        {wave.targets.map((target: CampaignWaveTarget) => (
          <div
            key={target.id}
            className="rounded border border-slate-200 p-2 text-xs"
            data-testid="campaign-wave-target-row"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-slate-900">
                {target.targetUrn ?? target.targetName ?? target.targetObjectId}
              </span>
              <Badge variant={campaignWaveStatusVariant(target.status)}>{target.status}</Badge>
            </div>
            {/* The wave target's real unit of work is an actual Change — link straight to it
                (DESIGN §9.5: campaign waves fan out into per-target member Changes). */}
            {target.memberChangeObjectId && (
              <p className="mt-1">
                <Link
                  to="/changes/$id"
                  params={{ id: target.memberChangeObjectId }}
                  className="text-slate-600 hover:underline"
                  data-testid="campaign-wave-target-change-link"
                >
                  View Change →
                </Link>
              </p>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function decisionSummary(decision: Decision): string {
  const summary = decision.reasonTree.summary;
  if (typeof summary === "string") return summary;
  return JSON.stringify(decision.reasonTree);
}

/** Same explainability plumbing as change-detail.tsx's `decisionIdOf`/`WhyLink` — every gate/
 *  policy block surfaces as a 4xx carrying `decision_id` (DESIGN §6/§10.4). */
function decisionIdOf(error: unknown): string | undefined {
  return error instanceof ScpApiError ? error.problem?.decision_id : undefined;
}

function WhyLink({ decisionId }: { decisionId: string }): React.JSX.Element {
  return (
    <a
      href={`#decision-${decisionId}`}
      className="font-medium text-red-700 underline hover:text-red-900"
      data-testid="why-link"
      onClick={() => {
        document
          .getElementById(`decision-${decisionId}`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      }}
    >
      Why?
    </a>
  );
}

/** The one reason-carrying transition a campaign has (rollback) — mirrors change-detail.tsx's
 *  `TransitionReasonDialog`, simplified to the single required-reason case. */
function RollbackCampaignDialog({
  open,
  pending,
  errorMessage,
  errorDecisionId,
  onOpenChange,
  onSubmit
}: {
  open: boolean;
  pending: boolean;
  errorMessage: string | null;
  errorDecisionId?: string | undefined;
  onOpenChange: (open: boolean) => void;
  onSubmit: (reason: string) => void;
}): React.JSX.Element {
  const [reason, setReason] = useState("");

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmed = reason.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setReason("");
        onOpenChange(next);
      }}
    >
      <DialogContent data-testid="rollback-campaign-dialog">
        <DialogHeader>
          <DialogTitle>Roll back campaign</DialogTitle>
          <DialogDescription>
            Rolls back every currently-eligible member Change — each becomes its own new rollback
            Change. A reason is required.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="rollback-campaign-reason" className="text-sm font-medium text-slate-700">
              Reason
            </label>
            <Input
              id="rollback-campaign-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
              data-testid="rollback-campaign-reason-input"
            />
          </div>
          {errorMessage && (
            <p className="text-sm text-red-600">
              {errorMessage}
              {errorDecisionId && (
                <>
                  {" "}
                  <WhyLink decisionId={errorDecisionId} />
                </>
              )}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={pending || reason.trim().length === 0}
              data-testid="rollback-campaign-submit"
            >
              {pending ? "Submitting…" : "Roll back"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

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

  if (!id) {
    return <p className="text-sm text-red-600">Not found.</p>;
  }
  if (explainQuery.isLoading) {
    return <p className="text-sm text-slate-500">Loading…</p>;
  }
  if (explainQuery.isError || !explainQuery.data) {
    return (
      <p className="text-sm text-red-600">
        {explainQuery.error instanceof Error ? explainQuery.error.message : "Not found"}
      </p>
    );
  }

  const { campaign, plan, decisions } = explainQuery.data;
  const rollbackDecisionId = decisionIdOf(rollbackMutation.error);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold text-slate-900" data-testid="campaign-name">
              {campaign.name}
            </h1>
            <Badge
              variant={campaignStatusBadgeVariant(campaign.status)}
              data-testid="campaign-status-badge"
            >
              {campaign.status}
            </Badge>
          </div>
          <p className="text-sm text-slate-500">
            {campaign.description ?? "No description"} · {campaign.targets.length} target
            {campaign.targets.length === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            variant="outline"
            onClick={() => setRollbackOpen(true)}
            data-testid="rollback-campaign-button"
          >
            Roll back campaign
          </Button>
        </div>
      </div>

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
            <div className="flex gap-4 overflow-x-auto pb-2" data-testid="campaign-wave-board">
              {plan.waves.map((wave, index) => (
                <div key={wave.id} className="flex items-center gap-4">
                  <CampaignWaveCard wave={wave} />
                  {index < plan.waves.length - 1 && (
                    <span className="shrink-0 text-xl text-slate-300" aria-hidden="true">
                      →
                    </span>
                  )}
                </div>
              ))}
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
                    className={`rounded border p-3 text-sm ${
                      isLinkedFromError ? "border-red-400 ring-2 ring-red-300" : "border-slate-200"
                    }`}
                    data-testid="campaign-decision-row"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-slate-900">{decision.kind}</span>
                      <Badge variant={decision.verdict === "allow" ? "success" : "destructive"}>
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

      <RollbackCampaignDialog
        open={rollbackOpen}
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
      />
    </div>
  );
}
