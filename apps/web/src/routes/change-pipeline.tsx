import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import type {
  ApprovalRequest,
  Change,
  ControlRun,
  Decision,
  ExecutorBinding,
  PolicyEvaluateResponse
} from "@scp/sdk";
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
import { Button } from "../components/ui/button";
import { PageHeader } from "../components/ui/page-header";
import { Skeleton } from "../components/ui/skeleton";
import { QueryErrorNotice } from "../components/query-error";
import { stateBadgeVariant } from "../lib/change-format";
import { formatDate, wavePromotion } from "../components/pipeline/wave-status";
import { WhyLink } from "../components/decision/WhyLink";
import { PromotionArrow, type PromotionState } from "../components/pipeline/PromotionArrow";
import {
  BoundarySegmentStrip,
  NoBoundarySegment
} from "../components/pipeline/BoundarySegmentStrip";
import {
  PipelineWaveCard,
  type PipelineWaveTargetLike,
  type PipelineWaveTargetLinks
} from "../components/pipeline/PipelineWaveCard";

interface PromotionVerdict {
  state: PromotionState;
  label?: string;
  /** A one-line human "why", assembled ONLY from real data already on the wire (gate reasonTree
   *  summary, freeze window, joined failing control-run evidence). Omitted when there is nothing
   *  real to say — never a fabricated reason (observe-enrichment.md signal 3, ADR-0008). */
  detail?: string;
  decisionId?: string;
}

// -------------------------------------------------------------------------------------------
// Reason assembly (signal 3): the block reason is REUSED from data the view already fetches — the
// side-effect-free `policyEvaluate` reasonTree/inputContext (identical in shape to a real block
// Decision, governance.ts:143) plus the `explain.controlRuns[]` evidence. The Decision's opaque
// reasonTree/inputContext are read defensively (they are typed `z.record` on the wire) — any
// missing/oddly-shaped field just drops that fragment, it never invents one.
// -------------------------------------------------------------------------------------------

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

/** The freeze end time lives ONLY on `inputContext.freeze.endsAt` (the gate short-circuits a freeze
 *  to a block before policy evaluation; reasonTree.freeze carries the reason but not the time). */
function freezeEndsAt(inputContext: Record<string, unknown> | undefined): string | undefined {
  const freeze = inputContext?.freeze;
  if (freeze && typeof freeze === "object") {
    const endsAt = (freeze as Record<string, unknown>).endsAt;
    if (typeof endsAt === "string") return endsAt;
  }
  return undefined;
}

/** Control object ids that a required policy needs but that did NOT pass, dug out of
 *  reasonTree.policies[].effects[] (kind "requireControls", satisfied false). Joined against
 *  explain.controlRuns[] by controlObjectId to pull the actual outcome + free-text detail. */
function failingControlObjectIds(reasonTree: Record<string, unknown> | undefined): string[] {
  const ids: string[] = [];
  const policies = reasonTree?.policies;
  if (!Array.isArray(policies)) return ids;
  for (const policy of policies) {
    if (!policy || typeof policy !== "object") continue;
    const effects = (policy as Record<string, unknown>).effects;
    if (!Array.isArray(effects)) continue;
    for (const effect of effects) {
      if (!effect || typeof effect !== "object") continue;
      const eff = effect as Record<string, unknown>;
      if (eff.kind !== "requireControls" || eff.satisfied !== false) continue;
      const detail = eff.detail;
      if (detail && typeof detail === "object") {
        const cid = (detail as Record<string, unknown>).controlObjectId;
        if (typeof cid === "string" && !ids.includes(cid)) ids.push(cid);
      }
    }
  }
  return ids;
}

/** Assemble the one-line block "why" from real gate + control-run data. Takes reasonTree/inputContext
 *  directly so the caller can pass the PERSISTED block Decision's (accurate — real control outcomes)
 *  in preference to the side-effect-free dry-run's (whose empty controlOutcomes can over-name a
 *  control). Returns undefined when there is nothing real to show, so the arrow stays a bare colored
 *  bar rather than carrying an invented reason. */
function blockDetail(
  reasonTree: Record<string, unknown> | undefined,
  inputContext: Record<string, unknown> | undefined,
  controlRuns: ControlRun[]
): string | undefined {
  const parts: string[] = [];
  const summary = stringField(reasonTree, "summary");
  if (summary) parts.push(summary);

  const endsAt = freezeEndsAt(inputContext);
  if (endsAt) parts.push(`window closed until ${formatDate(endsAt)}`);

  for (const controlId of failingControlObjectIds(reasonTree)) {
    const run = controlRuns.find((r) => r.controlObjectId === controlId);
    if (run && run.status !== "pass") {
      parts.push(`control ${run.status}${run.detail ? `: ${run.detail}` : ""}`);
    }
  }

  return parts.length > 0 ? parts.join(" — ") : undefined;
}

/** The awaiting-approval quorum, in the spec's "N/M · <role>" shape (observe-enrichment.md signal
 *  3), from the ApprovalRequest the view already loads — voteCount/requiredCount/fromRole. */
function approvalQuorum(approval: ApprovalRequest): string {
  return `${approval.voteCount}/${approval.requiredCount} · ${approval.fromRole}`;
}

/**
 * The change-level (final) ACCEPTANCE gate — validating → accepted (ADR-0021 D5; this is the one
 * gate that is NOT a promotion — it is a human decision about a change). Colored from REAL state the
 * change-detail page already loads: a pending ApprovalRequest (amber), a block Decision or a live
 * side-effect-free policyEvaluate `block` verdict (red, with the Decision's `decision_id` when one
 * exists — charter principle 6), else open/pending by change state. The `detail` "why" is assembled
 * ONLY from real data already on the wire (gate reasonTree summary, freeze window from inputContext,
 * joined failing control-run evidence, approval quorum) — never fabricated (ADR-0008, signal 3).
 */
function finalGate(
  change: Change,
  approvals: ApprovalRequest[],
  decisions: Decision[],
  gate: PolicyEvaluateResponse | undefined,
  controlRuns: ControlRun[]
): PromotionVerdict {
  const pendingApproval = approvals.find((a) => a.status !== "satisfied");
  if (change.state === "accepted") return { state: "open", label: "accepted" };
  if (change.state === "validating") {
    if (pendingApproval)
      return {
        state: "approval",
        label: "awaiting approval",
        detail: approvalQuorum(pendingApproval)
      };
    if (gate?.verdict === "block") {
      const block = [...decisions].reverse().find((d) => d.verdict === "block");
      // Prefer the persisted block Decision's reasonTree/inputContext (accurate — real control
      // outcomes) over the live dry-run gate's (empty controlOutcomes can over-name a control);
      // fall back to the dry-run for a would-block preview when no promotion was attempted yet.
      return {
        state: "blocked",
        label: "gate denies promotion",
        detail: blockDetail(
          block?.reasonTree ?? gate?.reasonTree,
          block?.inputContext ?? gate?.inputContext,
          controlRuns
        ),
        decisionId: block?.id
      };
    }
    return { state: "open", label: gate?.verdict === "allow" ? "gate open" : "ready to accept" };
  }
  if (pendingApproval)
    return {
      state: "approval",
      label: "awaiting approval",
      detail: approvalQuorum(pendingApproval)
    };
  return { state: "pending", label: "not yet at final gate" };
}

/**
 * `/changes/{id}/pipeline` — the component pipeline view (coordination-ui-views.md view 2, phase 1;
 * everything rendered is real Layer A data — the "Layer A (real data only)" caveat that used to sit
 * in the subtitle lives here now, not in chrome (copy rule 2)). Renders the change's compiled plan
 * as top-to-bottom wave cards with wide promotion arrows between them colored by real gate/approval
 * state. The per-wave version renders the REAL synced revision reconcile observed from status()
 * (ADR-0008 decision 1), or an explicit placeholder until observed — never a fabricated version.
 * Other Layer B signals (canary %, scan verdicts, health) remain explicit placeholders. Reuses the
 * same `explain()` cache key as change-detail so the two views stay in sync.
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

  // Wave source/executor links: bindings per target (externalRef = Argo app), execution-system
  // serverUrls (deep-link base), and source-mapping repoPatterns. All best-effort — a missing
  // binding/mapping just omits that link, it never blocks the view.
  const linksQuery = useQuery({
    queryKey: changePipelineLinksKey(id ?? ""),
    enabled: !!id && targetIds.length > 0,
    queryFn: async () => {
      const bindingLists = await Promise.all(
        targetIds.map(
          async (tid) =>
            [
              tid,
              await client.executors.listBindings(tid).catch(() => [] as ExecutorBinding[])
            ] as const
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
  if (explainQuery.isLoading) return <Skeleton className="h-24 w-full" />;
  if (explainQuery.isError || !explainQuery.data || !change) {
    return <QueryErrorNotice error={explainQuery.error ?? "Not found"} what="this change" />;
  }

  const { decisions, controlRuns, waitStatus } = explainQuery.data;
  // M16.1 — the boundary segment. `undefined` only from a pre-M16.1 server (the field is additive
  // and optional); `null` from a current server means "this change never crossed a boundary".
  const boundarySegment = explainQuery.data.boundarySegment ?? null;
  const approvals = approvalsQuery.data?.items ?? [];

  function linksFor(target: PipelineWaveTargetLike): PipelineWaveTargetLinks {
    const data = linksQuery.data;
    if (!data) return {};
    const bindings = data.bindingsByTarget[target.targetObjectId] ?? [];
    // A target holds at most one binding per Type (ADR-0007) — pick the one matching this wave's
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

  const gate = finalGate(change, approvals, decisions, gateQuery.data, controlRuns);
  const waves = plan?.waves ?? [];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={<span data-testid="pipeline-change-name">{change.name}</span>}
        description={
          <>
            Component pipeline
            {change.correlationKey && (
              <>
                {" · Correlation key: "}
                <span className="break-all font-mono text-xs text-slate-600">{change.correlationKey}</span>
              </>
            )}
          </>
        }
        meta={
          <>
            <Badge variant={stateBadgeVariant(change.state)}>{change.state}</Badge>
            {change.emergency && <Badge variant="danger">Emergency</Badge>}
          </>
        }
        actions={
          <Link to="/changes/$id" params={{ id }} data-testid="pipeline-to-detail-link">
            <Button variant="outline" size="sm">
              Full change detail
              <ArrowRight className="size-4" strokeWidth={2} aria-hidden="true" />
            </Button>
          </Link>
        }
      />

      {/* Upstream cross-change prerequisites (provides/requires + correlationKey). Real edges from
          explain.waitStatus — each links to the upstream change that satisfies it. */}
      {waitStatus && waitStatus.requirements.length > 0 && (
        <Card size="compact" data-testid="pipeline-upstream-card">
          <CardHeader>
            <CardTitle>
              Upstream prerequisites {waitStatus.waiting ? "· waiting" : "· satisfied"}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {waitStatus.requirements.map((req) => (
              <div
                key={`${req.key}@${req.at}`}
                className="flex min-w-0 items-center justify-between gap-4 text-sm"
                data-testid="pipeline-upstream-req"
              >
                <span className="min-w-0 break-all font-mono text-slate-700">
                  {req.key} @ {req.atName ?? req.at}
                </span>
                {req.satisfied ? (
                  <Badge variant="success">
                    satisfied
                    {req.satisfiedByChangeId && (
                      <>
                        {" · "}
                        <Link
                          to="/changes/$id"
                          params={{ id: req.satisfiedByChangeId }}
                          className="underline"
                        >
                          by change
                        </Link>
                      </>
                    )}
                  </Badge>
                ) : (
                  <Badge variant="neutral">outstanding</Badge>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* M16.1 — THE UNIVERSAL BOUNDARY SEGMENT (ADR-0011, ADR-0021 D6). ALWAYS SHOWN: either the
          two real phases, or an explicit statement that this change never crossed a boundary. It
          sits where the proposal places it — after build/config, before the deploy waves — and it
          drives nothing. Every state comes from the server's real ledger rows and Decisions. */}
      <Card data-testid="pipeline-boundary-card">
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle>Domain boundary</CardTitle>
            <span className="inline-flex items-center gap-1 text-xs text-slate-500">
              transferred
              <ArrowRight className="size-3.5" strokeWidth={2} aria-hidden="true" />
              validated
            </span>
          </div>
        </CardHeader>
        <CardContent>
          {boundarySegment ? (
            <BoundarySegmentStrip
              segment={boundarySegment}
              why={
                boundarySegment.validate.decisionId ? (
                  boundarySegment.validate.state === "refused" ? (
                    <WhyLink
                      changeId={id}
                      decisionId={boundarySegment.validate.decisionId}
                      data-testid="pipeline-why-link"
                    />
                  ) : (
                    <Link
                      to="/changes/$id"
                      params={{ id }}
                      hash={`decision-${boundarySegment.validate.decisionId}`}
                      className="text-xs font-medium text-slate-600 underline hover:text-slate-900"
                      data-testid="boundary-decision-link"
                    >
                      Decision
                    </Link>
                  )
                ) : undefined
              }
            />
          ) : (
            <NoBoundarySegment />
          )}
        </CardContent>
      </Card>

      {!plan && (
        <p className="text-sm text-slate-500" data-testid="pipeline-no-plan">
          No plan compiled yet.
        </p>
      )}
      {plan && waves.length === 0 && (
        <p className="text-sm text-slate-500">Plan compiled with no waves.</p>
      )}

      {waves.length > 0 && (
        <div className="flex flex-col items-center gap-1" data-testid="pipeline-waves">
          {/* Arrow into the first wave: colored by upstream prerequisite satisfaction. */}
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
                <PipelineWaveCard wave={wave} waveNumber={index + 1} linksFor={linksFor} />
                {promo && <PromotionArrow state={promo.state} label={promo.label} />}
                {isLast && (
                  <PromotionArrow
                    state={gate.state}
                    label={gate.label}
                    detail={gate.detail}
                    why={
                      gate.decisionId ? (
                        <WhyLink
                          changeId={id}
                          decisionId={gate.decisionId}
                          data-testid="pipeline-why-link"
                        />
                      ) : undefined
                    }
                  />
                )}
              </div>
            );
          })}
          {/* Terminal marker so the final gate arrow reads as "→ Accepted". */}
          <Badge
            variant={change.state === "accepted" ? "success" : "neutral"}
            data-testid="pipeline-terminal"
          >
            {change.state === "accepted" ? "Accepted" : "Acceptance target"}
          </Badge>
        </div>
      )}
    </div>
  );
}
