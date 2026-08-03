import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { ComponentPipelineStage } from "@scp/sdk";
import { client } from "../lib/client";
import { componentPipelineKey } from "../lib/query-client";
import { useIdOrUrnParam } from "../lib/use-route-params";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { PromotionArrow, type PromotionState } from "../components/pipeline/PromotionArrow";

/**
 * THE COMPONENT PIPELINE — the default view of a component (coordination-ui-views.md §2, corrected
 * 2026-08-03).
 *
 * A pipeline is a durable property of a component; artifacts move THROUGH it. The surface this
 * replaces was keyed on a CHANGE, so a component with nothing in flight had no pipeline to open at
 * all. Here the stages come from the component's PLACEMENTS, so the view is well-defined for a
 * component that has never released — that is the acceptance criterion, not a nicety.
 *
 * The change-scoped view is retained as what it always was: the RUN detail, reachable from whichever
 * stage a change last touched.
 */

/** A stage's promotion state, from what the SERVER could observe — never invented.
 *
 *  `pending` (grey) is the honest default: it means "nothing has released here", which is a real and
 *  common state for a placement, NOT a failure. Only an actually-failed target goes red. */
function stateOf(stage: ComponentPipelineStage): PromotionState {
  if (!stage.current) return "pending";
  const status = stage.current.targetStatus ?? "";
  if (status === "failed" || status === "blocked") return "blocked";
  if (stage.current.changeState === "waiting") return "approval";
  if (status === "succeeded") return "open";
  return "pending";
}

/** Exported ONLY for `component-pipeline-continuous.test.tsx`, which renders it directly: the
 *  presentational contract (unknown-vs-blank, unbound-is-loud) is what that test owns, and rendering
 *  the whole page would drag in the query client for no added coverage. */
export function StageCardForTest({ stage }: { stage: ComponentPipelineStage }): JSX.Element {
  return <StageCard stage={stage} />;
}

function StageCard({ stage }: { stage: ComponentPipelineStage }): JSX.Element {
  const versionUnknown = stage.unknownFields.includes("version");
  return (
    <Card className="min-w-[15rem] flex-1" data-testid="pipeline-stage">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-2 text-sm">
          <span data-testid="stage-name">{stage.stageName ?? stage.deploymentTarget.name}</span>
          {!stage.binding && (
            // An unbound placement FAKE-SUCCEEDS under stage-shaped compilation (ADR-0006 case (a)).
            // It must be loud, not absent.
            <Badge variant="destructive" data-testid="stage-unbound">
              No executor
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-xs text-slate-600">
        <div>
          <span className="text-slate-400">Place</span> {stage.deploymentTarget.name}
        </div>
        {stage.binding && (
          <div data-testid="stage-executor">
            <span className="text-slate-400">Executes</span>{" "}
            <span className="font-mono">{stage.binding.externalRef ?? "—"}</span>
            {stage.binding.executionSystemName ? ` @ ${stage.binding.executionSystemName}` : ""}
          </div>
        )}
        <div data-testid="stage-version">
          <span className="text-slate-400">Version</span>{" "}
          {versionUnknown ? (
            // NOT a blank. The server says this is unobserved (Phase 4a is unbuilt), and an empty
            // cell would read as "no version deployed" — a claim nobody has made.
            <span
              className="italic text-slate-400"
              title="No version signal is captured yet — coordination-ui-views.md Phase 4a."
            >
              not observed yet
            </span>
          ) : (
            <span className="font-mono">{stage.version}</span>
          )}
        </div>
        <div data-testid="stage-current">
          <span className="text-slate-400">Last release</span>{" "}
          {stage.current ? (
            <Link
              to="/changes/$id/pipeline"
              params={{ id: stage.current.changeId }}
              className="underline hover:text-slate-900"
              data-testid="stage-run-link"
            >
              {stage.current.changeName ?? stage.current.changeId.slice(0, 8)} →
            </Link>
          ) : (
            <span className="text-slate-400">nothing has released here</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function ComponentPipelinePage(): JSX.Element {
  const idOrUrn = useIdOrUrnParam();
  const query = useQuery({
    queryKey: componentPipelineKey(idOrUrn ?? ""),
    queryFn: () => client.components.pipeline(idOrUrn!),
    enabled: Boolean(idOrUrn)
  });

  if (query.isLoading) return <p className="text-sm text-slate-500">Loading pipeline…</p>;
  if (query.error) {
    return (
      <p className="text-sm text-red-600" data-testid="pipeline-error">
        {(query.error as Error).message}
      </p>
    );
  }
  const data = query.data;
  if (!data) return <p className="text-sm text-slate-500">No pipeline.</p>;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold" data-testid="component-name">
            {data.component.name}
          </h1>
          <p className="font-mono text-xs text-slate-500">{data.component.urn}</p>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/graph/$idOrUrn" params={{ idOrUrn: data.component.id }}>
            <Button variant="outline">Open in graph explorer</Button>
          </Link>
        </div>
      </div>

      {/* WHY this component releases this way (charter principle 6). Without it, someone attaching a
          topology to a SERVICE silently changes every component under it and nothing says so. */}
      <p className="text-xs text-slate-500" data-testid="pipeline-source">
        {data.pipeline ? (
          <>
            Pipeline{" "}
            <span className="font-medium">{data.pipeline.topologyName ?? "(unnamed)"}</span>,
            inherited from the {data.pipeline.rung}
            {data.pipeline.attachedToName ? ` “${data.pipeline.attachedToName}”` : ""}.
          </>
        ) : (
          <>No release topology is attached — releases compile to a single anonymous wave.</>
        )}
      </p>

      {data.stages.length === 0 ? (
        // Not an error, and deliberately explicit about the consequence: a component placed nowhere
        // cannot be deployed by anything, which is exactly what an operator needs told.
        <Card data-testid="pipeline-empty">
          <CardContent className="py-6 text-sm text-slate-600">
            This component has no placements, so it runs nowhere and nothing can deploy it. Declare
            a placement to give it a stage.
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-wrap items-stretch gap-2" data-testid="pipeline-stages">
          {data.stages.map((stage, i) => (
            <div key={stage.placement.id} className="flex flex-1 items-center gap-2">
              <StageCard stage={stage} />
              {i < data.stages.length - 1 && (
                <PromotionArrow state={stateOf(data.stages[i + 1]!)} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
