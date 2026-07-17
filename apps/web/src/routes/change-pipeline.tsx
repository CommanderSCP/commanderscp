import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { Change, ChangeWave, ChangeWaveTarget, Decision, ExecutorBinding } from "@scp/sdk";
// M4 governance types live in @scp/schemas (not re-exported from @scp/sdk) — importing them here is
// within the apps/web import boundary (eslint.config.mjs allows @scp/sdk + @scp/schemas), matching
// routes/change-detail.tsx.
import type { ApprovalRequest } from "@scp/schemas";
import { client } from "../lib/client";
import {
  changeApprovalsKey,
  changeDetailKey,
  changePipelineGateKey,
  changePipelineLinksKey
} from "../lib/query-client";
import { useIdParam } from "../lib/use-route-params";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { stateBadgeVariant } from "./change-list";
import { PromotionArrow, type PromotionState } from "../components/pipeline/PromotionArrow";
import { StageCard, type StageTargetLinks } from "../components/pipeline/StageCard";

interface PromotionVerdict {
  state: PromotionState;
  label?: string;
  decisionId?: string;
}

/**
 * Inter-wave promotion state, derived ONLY from wave status (coordination-ui-views.md Layer A).
 * Wave-to-wave promotion is automatic server-side reconcile — the gate/approval machinery is a
 * change-level concern surfaced on the FINAL arrow, so we do not attribute an approval/deny to a
 * specific inter-wave arrow (that would be inventing a per-wave gate the model does not have).
 */
function wavePromotion(upstream: ChangeWave, downstream: ChangeWave): PromotionVerdict {
  if (upstream.status === "failed") return { state: "blocked", label: "upstream wave failed" };
  if (downstream.status === "running" || downstream.status === "succeeded")
    return { state: "open", label: "promoted" };
  if (downstream.status === "skipped") return { state: "pending", label: "skipped" };
  if (upstream.status === "succeeded" && downstream.status === "pending")
    return { state: "pending", label: "awaiting promotion" };
  return { state: "pending" };
}

/**
 * The change-level (final) promotion gate — validating → promoted. Colored from REAL state the
 * change-detail page already loads: a pending ApprovalRequest (amber), a block Decision or a live
 * side-effect-free policyEvaluate `block` verdict (red, with the Decision's `decision_id` when one
 * exists — charter principle 6), else open/pending by change state.
 */
function finalGate(
  change: Change,
  approvals: ApprovalRequest[],
  decisions: Decision[],
  gateVerdict: "allow" | "block" | undefined
): PromotionVerdict {
  const pendingApproval = approvals.find((a) => a.status !== "satisfied");
  if (change.state === "promoted") return { state: "open", label: "promoted" };
  if (change.state === "validating") {
    if (pendingApproval)
      return {
        state: "approval",
        label: `awaiting approval (${pendingApproval.voteCount}/${pendingApproval.requiredCount} from ${pendingApproval.fromRole})`
      };
    if (gateVerdict === "block") {
      const block = [...decisions].reverse().find((d) => d.verdict === "block");
      return { state: "blocked", label: "gate denies promotion", decisionId: block?.id };
    }
    return { state: "open", label: gateVerdict === "allow" ? "gate open" : "ready to promote" };
  }
  if (pendingApproval)
    return {
      state: "approval",
      label: `awaiting approval (${pendingApproval.voteCount}/${pendingApproval.requiredCount})`
    };
  return { state: "pending", label: "not yet at final gate" };
}

/** A "Why?" link into the change-detail Decisions timeline (its `#decision-<id>` anchor). Keeps the
 *  full explainability surface in one place rather than duplicating the timeline on this view. */
function WhyLink({ changeId, decisionId }: { changeId: string; decisionId: string }): React.JSX.Element {
  return (
    <Link
      to="/changes/$id"
      params={{ id: changeId }}
      hash={`decision-${decisionId}`}
      className="font-medium text-red-700 underline hover:text-red-900"
      data-testid="pipeline-why-link"
    >
      Why?
    </Link>
  );
}

/**
 * `/changes/{id}/pipeline` — the component pipeline view (coordination-ui-views.md view 2, phase 1,
 * Layer A). Renders the change's compiled plan as top-to-bottom stages (one per wave) with wide
 * promotion arrows between them colored by real gate/approval state. Strictly Layer A: no invented
 * canary %, scan verdicts, per-stage versions, or health — those are Layer B and shown as explicit
 * placeholders. Reuses the same `explain()` cache key as change-detail so the two views stay in sync.
 */
export function ChangePipelinePage(): React.JSX.Element {
  const id = useIdParam();

  const explainQuery = useQuery({
    queryKey: changeDetailKey(id ?? ""),
    queryFn: () => client.changes.explain(id!),
    enabled: !!id,
    refetchInterval: 3000
  });

  const approvalsQuery = useQuery({
    queryKey: changeApprovalsKey(id ?? ""),
    queryFn: () => client.approvals.list({ changeId: id!, limit: 20 }),
    enabled: !!id,
    refetchInterval: 5000
  });

  const change = explainQuery.data?.change;
  const plan = explainQuery.data?.plan ?? null;
  const targetIds = plan
    ? [...new Set(plan.waves.flatMap((w) => w.targets.map((t) => t.targetObjectId)))]
    : [];
  const sourceKind = change?.sourceKind ?? undefined;

  // Stage source/executor links: bindings per target (externalRef = Argo app), execution-system
  // serverUrls (deep-link base), and source-mapping repoPatterns. All best-effort — a missing
  // binding/mapping just omits that link, it never blocks the view.
  const linksQuery = useQuery({
    queryKey: changePipelineLinksKey(id ?? ""),
    enabled: !!id && targetIds.length > 0,
    queryFn: async () => {
      const bindingLists = await Promise.all(
        targetIds.map(
          async (tid) =>
            [tid, await client.executors.listBindings(tid).catch(() => [] as ExecutorBinding[])] as const
        )
      );
      const bindingsByTarget: Record<string, ExecutorBinding[]> = Object.fromEntries(bindingLists);

      const execIds = [
        ...new Set(
          Object.values(bindingsByTarget)
            .flat()
            .map((b) => b.executionSystemId)
            .filter((x): x is string => !!x)
        )
      ];
      const execUrlById: Record<string, string> = {};
      await Promise.all(
        execIds.map(async (eid) => {
          try {
            const obj = await client.object("execution-system").get(eid);
            const url = obj.properties?.serverUrl;
            if (typeof url === "string") execUrlById[eid] = url;
          } catch {
            /* execution-system unreadable — omit the deep link */
          }
        })
      );

      const repoByKey: Record<string, string> = {};
      if (sourceKind) {
        try {
          const mappings = await client.changeSources.listMappings(sourceKind);
          for (const m of mappings.items) {
            if (m.repoPattern) repoByKey[`${m.componentObjectId}::${m.type}`] = m.repoPattern;
          }
        } catch {
          /* mappings unreadable — omit repo links */
        }
      }

      return { bindingsByTarget, execUrlById, repoByKey };
    }
  });

  // Side-effect-free promotion verdict (no transition) purely to color the final gate arrow.
  const gateQuery = useQuery({
    queryKey: changePipelineGateKey(id ?? ""),
    queryFn: () => client.policyEvaluate(id!),
    enabled: !!id && change?.state === "validating",
    refetchInterval: 5000
  });

  if (!id) return <p className="text-sm text-red-600">Not found.</p>;
  if (explainQuery.isLoading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (explainQuery.isError || !explainQuery.data || !change) {
    return (
      <p className="text-sm text-red-600">
        {explainQuery.error instanceof Error ? explainQuery.error.message : "Not found"}
      </p>
    );
  }

  const { decisions, waitStatus } = explainQuery.data;
  const approvals = approvalsQuery.data?.items ?? [];

  function linksFor(target: ChangeWaveTarget): StageTargetLinks {
    const data = linksQuery.data;
    if (!data) return {};
    const bindings = data.bindingsByTarget[target.targetObjectId] ?? [];
    // A target holds at most one binding per Type (ADR-0007) — pick the one matching this stage's
    // Type; fall back to the first binding so a legacy single-binding target still links.
    const binding = bindings.find((b) => b.type === target.type) ?? bindings[0];
    const executorSystemUrl = binding?.executionSystemId
      ? data.execUrlById[binding.executionSystemId]
      : undefined;
    return {
      executorRef: binding?.externalRef ?? undefined,
      executorSystemUrl,
      repoPattern: data.repoByKey[`${target.targetObjectId}::${target.type}`]
    };
  }

  const gate = finalGate(change, approvals, decisions, gateQuery.data?.verdict);
  const waves = plan?.waves ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold text-slate-900" data-testid="pipeline-change-name">
              {change.name}
            </h1>
            <Badge variant={stateBadgeVariant(change.state)}>{change.state}</Badge>
            {change.emergency && <Badge variant="destructive">Emergency</Badge>}
          </div>
          <p className="text-sm text-slate-500">
            Component pipeline · Layer A (real data only)
            {change.correlationKey ? ` · Correlation key: ${change.correlationKey}` : ""}
          </p>
        </div>
        <Link
          to="/changes/$id"
          params={{ id }}
          className="text-sm font-medium text-slate-600 underline hover:text-slate-900"
          data-testid="pipeline-to-detail-link"
        >
          Full change detail →
        </Link>
      </div>

      {/* Upstream cross-change prerequisites (provides/requires + correlationKey). Real edges from
          explain.waitStatus — each links to the upstream change that satisfies it. */}
      {waitStatus && waitStatus.requirements.length > 0 && (
        <Card data-testid="pipeline-upstream-card">
          <CardHeader>
            <CardTitle className="text-base">
              Upstream prerequisites {waitStatus.waiting ? "· waiting" : "· satisfied"}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {waitStatus.requirements.map((req) => (
              <div
                key={`${req.key}@${req.at}`}
                className="flex items-center justify-between gap-4 text-sm"
                data-testid="pipeline-upstream-req"
              >
                <span className="font-mono text-slate-700">
                  {req.key} @ {req.atName ?? req.at}
                </span>
                {req.satisfied ? (
                  <Badge variant="success">
                    satisfied
                    {req.satisfiedByChangeId && (
                      <>
                        {" · "}
                        <Link to="/changes/$id" params={{ id: req.satisfiedByChangeId }} className="underline">
                          by change
                        </Link>
                      </>
                    )}
                  </Badge>
                ) : (
                  <Badge variant="secondary">outstanding</Badge>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {!plan && (
        <p className="text-sm text-slate-500" data-testid="pipeline-no-plan">
          No plan compiled yet — nothing to render as pipeline stages.
        </p>
      )}
      {plan && waves.length === 0 && (
        <p className="text-sm text-slate-500">Plan compiled with no waves.</p>
      )}

      {waves.length > 0 && (
        <div className="flex flex-col items-center gap-1" data-testid="pipeline-stages">
          {/* Arrow into the first stage: colored by upstream prerequisite satisfaction. */}
          {waitStatus && waitStatus.requirements.length > 0 && (
            <PromotionArrow
              state={waitStatus.waiting ? "pending" : "open"}
              label={waitStatus.waiting ? "waiting on prerequisite" : "prerequisites satisfied"}
            />
          )}
          {waves.map((wave, index) => {
            const isLast = index === waves.length - 1;
            const next = waves[index + 1];
            const promo = next ? wavePromotion(wave, next) : undefined;
            return (
              <div key={wave.id} className="flex w-full flex-col items-center gap-1">
                <StageCard wave={wave} stageNumber={index + 1} linksFor={linksFor} />
                {promo && <PromotionArrow state={promo.state} label={promo.label} />}
                {isLast && (
                  <PromotionArrow
                    state={gate.state}
                    label={gate.label}
                    why={
                      gate.decisionId ? <WhyLink changeId={id} decisionId={gate.decisionId} /> : undefined
                    }
                  />
                )}
              </div>
            );
          })}
          {/* Terminal marker so the final gate arrow reads as "→ Promoted". */}
          <Badge
            variant={change.state === "promoted" ? "success" : "outline"}
            data-testid="pipeline-terminal"
          >
            {change.state === "promoted" ? "Promoted" : "Promotion target"}
          </Badge>
        </div>
      )}
    </div>
  );
}
