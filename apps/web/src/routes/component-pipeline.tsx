import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Check,
  Circle,
  CircleAlert,
  CircleDashed,
  ExternalLink,
  GitBranch,
  Package,
  Plus,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Unlink,
  Wrench,
  X,
  type LucideIcon
} from "lucide-react";
import { CommanderStar, OutpostFort } from "../components/icons/federation-roles";
import type {
  ComponentPipelineResponse,
  ComponentPipelineStage,
  ComponentPipelineUnplacedStage,
  CreateSourceMappingRequest
} from "@scp/sdk";
// A1/B2 (docs/proposals/outpost-ui.md §3/§4): `@scp/sdk`'s index only re-exports the M3-era
// change-sources types (`CreateSourceMappingRequest`); the delete-tuple and placement-create
// shapes never got an SDK re-export block. `@scp/schemas` directly is within eslint's own
// restricted-imports allowance ("apps/web/src may import only @scp/sdk and @scp/schemas"),
// matching `registry-detail.tsx`'s `ExecutorTypeSchema` import.
import {
  ExecutorTypeSchema,
  PipelineClassificationSchema,
  type CreatePlacementRequest,
  type DeleteSourceMappingRequest,
  type ExecutorType,
  type GraphObject,
  type InstanceRole,
  type PipelineClassification
} from "@scp/schemas";
import { client } from "../lib/client";
import { useAuth } from "../lib/auth-context";
import { componentPipelineKey } from "../lib/query-client";
import { useIdOrUrnParam } from "../lib/use-route-params";
import { cn, focusRing } from "../lib/utils";
import { Card, CardContent, CardHeader } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { PageHeader } from "../components/ui/page-header";
import { SectionLabel } from "../components/ui/section-label";
import { Skeleton } from "../components/ui/skeleton";
import { Alert } from "../components/ui/alert";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "../components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "../components/ui/dialog";
import { QueryErrorNotice } from "../components/query-error";
import { PromotionArrow, type PromotionState } from "../components/pipeline/PromotionArrow";

/**
 * THE COMPONENT PIPELINE — the default view of a component (coordination-ui-views.md §2, corrected
 * 2026-08-03).
 *
 * A pipeline is a durable property of a component; artifacts move THROUGH it. Two corrections got it
 * here, and this file must keep BOTH:
 *
 *   1. The surface this replaces was keyed on a CHANGE, so a component with nothing in flight had no
 *      pipeline to open at all. Nothing here may be gated on `stage.current`.
 *   2. The first version of the replacement drew one card per PLACEMENT, so a stage the component is
 *      NOT placed at rendered nowhere — on the live estate, a two-wave topology showed one card and
 *      prod was simply absent. The journey is the topology's WAVES, and a stage with no placement is
 *      drawn greyed and explicitly "not placed" rather than omitted.
 *
 * "Not placed" and "placed, nothing released yet" are deliberately different pictures. The second is
 * ordinary (a new placement); the first says this component's releases never reach that stage, which
 * is usually the most important thing on the page.
 *
 * Waves stack VERTICALLY with a `PromotionArrow` between them — the same shape `change-pipeline.tsx`
 * uses, and the one that component was drawn for (its arrow points down). Targets inside one wave sit
 * side by side, because that is what a parallel wave means.
 */

/**
 * WHICH OF THIS STAGE'S PIPELINES THE HOLD IS ABOUT (ADR-0028 increment 4).
 *
 * `stages[].hold` is keyed on the PLACEMENT — the coupling is evaluated per wave target and a wave
 * target's `target_object_id` is the placement — so it says "a release is being withheld here"
 * without saying which lane. That distinction matters: a change can hold this place's
 * `configuration` target while the infrastructure pipeline here is simply idle, and painting the
 * infra lane "held" would claim a pipeline is waiting when nothing of it is running at all.
 *
 * The join is the one the response already carries: the hold names its `changeId`, and each lane's
 * `current` names the change whose release is in that lane. The status check is what keeps it exact
 * — a target already handed to an executor is past the hold, whatever another target of the same
 * change at the same place is doing.
 */
function holdFor(
  stage: ComponentPipelineStage,
  lane: Lane
): NonNullable<ComponentPipelineStage["hold"]> | null {
  const hold = stage.hold;
  if (!hold) return null;
  const current = currentFor(stage, lane);
  if (!current || current.changeId !== hold.changeId) return null;
  if (current.targetStatus !== "pending" && current.targetStatus !== "triggering") return null;
  return hold;
}

/** A stage's promotion state, from what the SERVER could observe — never invented.
 *
 *  `pending` (grey) is the honest default: it means "nothing has released here", which is a real and
 *  common state for a placement, NOT a failure. Only an actually-failed target goes red.
 *
 *  `held` sits between the two and is the reason this function grew a second argument. A held wave
 *  target's status is and stays `pending` — the server's hold `continue`s before it is ever handed
 *  to an executor — so without the hold it painted identically to "the wave has not reached here
 *  yet". Those are opposite facts: one is waiting on something NAMED, the other on nothing. */
function stateOf(
  current: ComponentPipelineStage["current"],
  hold: ComponentPipelineStage["hold"] = null
): PromotionState {
  if (!current) return "pending";
  const status = current.targetStatus ?? "";
  if (status === "failed" || status === "blocked") return "blocked";
  // Before the `waiting` check, not after: the two cannot co-occur (a stage-dependency hold applies
  // to a change in `executing`), and reading the more specific fact first keeps it that way if they
  // ever could.
  if (hold) return "held";
  if (current.changeState === "waiting") return "approval";
  if (status === "succeeded") return "open";
  return "pending";
}

/**
 * THE LANES — a component runs SEVERAL pipelines, and they are not stages of one another.
 *
 * The software pipeline builds an artifact and syncs config; the infrastructure pipeline stands up
 * the substrate underneath it. They have their own executors, their own source repos and their own
 * release histories, and drawing them as one list of stages says a component has a single pipeline
 * when it has two (owner, 2026-08-10: "Each component needs 2 pipelines: infra & software").
 *
 * Lane membership is by ADR-0007 CATEGORY, which the server derives from the routing Type and sends
 * on the wire — so this file holds no copy of the Type→Category map. `build` and `configuration`
 * share the software lane because that is what `coordination-ui-views.md` §2's "App release" lane
 * is: `Build & test` → `Image registry` → `Config bump` → the deploy stages.
 *
 * BOTH LANES ALWAYS RENDER. A component with no infrastructure pipeline says so in words; leaving
 * the lane out would make "no infra pipeline is declared" indistinguishable from "this view does not
 * show infra", which is the distinction the whole page is built around.
 */
interface Lane {
  key: string;
  label: string;
  /** Every Category this lane owns — for "does this lane exist for this component at all?". */
  categories: readonly string[];
  /** Which bindings EXECUTE at a deploy stage. A `build` binding is a step BEFORE the stages, not
   *  something that happens at each of them, so it is hoisted into its own node. */
  stageCategories: readonly string[];
  /** Bindings hoisted out of the stages into a single node ahead of them. */
  buildCategories: readonly string[];
  /** Does this lane produce a stored, digest-addressed artifact between build and deploy? */
  hasRegistry: boolean;
  /** What its absence MEANS — stated per lane, because the two absences are not the same fact. */
  absent: string;
}

export const LANES: readonly Lane[] = [
  {
    key: "software",
    label: "Delivery pipeline",
    categories: ["build", "configuration"],
    stageCategories: ["configuration"],
    buildCategories: ["build"],
    hasRegistry: true,
    absent:
      "No build or configuration pipeline is bound for this component, so nothing delivers its application or configuration."
  },
  {
    key: "infrastructure",
    label: "Infrastructure pipeline",
    categories: ["infrastructure"],
    // GLOSSARY: an infrastructure pipeline is plan → gate → apply. Plan and apply are the SAME
    // executor acting at each place, and the gate is the governance verdict on the way in — so there
    // is no hoisted node here, and inventing one would draw a step nothing runs.
    stageCategories: ["infrastructure"],
    buildCategories: [],
    hasRegistry: false,
    absent:
      "No infrastructure pipeline is bound for this component — its substrate is managed elsewhere, or not by CommanderSCP."
  }
];

/** The per-site registry (pipeline-substrate-registry-scan.md §9.2) — optional on the wire because
 *  it shipped after `/v1` did; absent/null means an OLDER SERVER, not "none" (`state: "none"` is
 *  itself a value the server always emits once it knows the field). */
type ComponentPipelineRegistry = NonNullable<ComponentPipelineResponse["registry"]>;

/**
 * THE ARTIFACT and its change-scoped facts (§9.3) — optional on the wire for the same reason as
 * `registry`. Three readings, and this file keeps them apart everywhere it renders one:
 *   `undefined` — an OLDER SERVER; nothing is known either way (the pre-§9.3 "not observed" copy);
 *   `null`      — the server SAYS no change of this component carries an artifact digest ("no
 *                 artifact yet" — a stated absence);
 *   an object   — the pick, stated (`changeId`/`changeName`), and every fact read from it.
 */
type ComponentPipelineArtifact = NonNullable<ComponentPipelineResponse["artifact"]>;
type ArtifactOnWire = ComponentPipelineArtifact | null | undefined;
type PromotionExport = ComponentPipelineArtifact["signing"]["promotionExports"][number];
type SbomRef = NonNullable<ComponentPipelineArtifact["sbom"]>;

/** The target's substrate facet as the wire carries it on both stage shapes (§9.1). */
type DeploymentTargetFacet = Pick<
  ComponentPipelineStage["deploymentTarget"],
  "substrate" | "account" | "region" | "cluster"
>;

/**
 * THE SUBSTRATE FACET VALUES that are actually DECLARED on a target, in the fixed order
 * substrate · account · region · cluster — e.g. `["aws", "210987654321", "us-east-1", "prod-eks"]`.
 *
 * Only PRESENT values are kept: null is an absence of a declaration, not an unknown observation, so
 * it earns neither a `—` nor a badge (`ComponentPipelineStageSchema.deploymentTarget.substrate`).
 * An empty string is treated the same way — there is nothing to show, and ` · aws` would draw a
 * separator for a value that has no width.
 * `name` is deliberately not in the input type: fixture names like `us-east-1-prod (k8s)` look
 * parseable and are exactly the trap — every rendered value here is READ from the target's own
 * declared properties, never derived from what it is called.
 *
 * Exported for `component-pipeline-continuous.test.tsx`.
 */
export function targetFacetValues(target: DeploymentTargetFacet): string[] {
  return [target.substrate, target.account, target.region, target.cluster].filter(
    (value): value is string => typeof value === "string" && value.length > 0
  );
}

/** The facet as a quiet line BESIDE a stage's hint (`deploys to …` / `declared at …`), joined
 *  with ` · `. Renders NOTHING when nothing is declared — no element at all, so an undeclared
 *  target's header is byte-identical to what it was before the facet existed. */
function TargetFacet({ target }: { target: DeploymentTargetFacet }): React.JSX.Element | null {
  const values = targetFacetValues(target);
  if (values.length === 0) return null;
  return (
    <span className="ml-1.5 text-slate-400" data-testid="pipeline-target-facet">
      {values.join(" · ")}
    </span>
  );
}

/** One entry of the journey — the two response arrays rejoined and discriminated. */
type JourneyEntry =
  | { placed: true; order: number; waveIndex: number | null; stage: ComponentPipelineStage }
  | {
      placed: false;
      order: number;
      waveIndex: number;
      stage: ComponentPipelineUnplacedStage;
    };

/** Consecutive journey entries that share a wave — a parallel wave is drawn as one row. */
interface JourneyWave {
  waveIndex: number | null;
  name: string | null;
  entries: JourneyEntry[];
}

/**
 * Rebuilds the single ordered pipeline from the response's two arrays.
 *
 * `stages` and `unplacedStages` are disjoint and `order` is contiguous across their union, so this
 * is a concatenate-and-sort with no inference — see `ComponentPipelineResponseSchema.unplacedStages`
 * for why the wire splits them (widening `placement` to nullable is an oasdiff ERR).
 *
 * Exported for `component-pipeline-continuous.test.tsx`: the rejoin is the one piece of real logic
 * on this page, so it is tested directly rather than through the DOM.
 */
export function buildJourney(data: {
  stages: ComponentPipelineStage[];
  unplacedStages: ComponentPipelineUnplacedStage[];
}): JourneyWave[] {
  const entries: JourneyEntry[] = [
    ...data.stages.map((stage): JourneyEntry => ({
      placed: true,
      order: stage.order,
      waveIndex: stage.wave?.index ?? null,
      stage
    })),
    ...data.unplacedStages.map((stage): JourneyEntry => ({
      placed: false,
      order: stage.order,
      waveIndex: stage.wave.index,
      stage
    }))
  ].sort((a, b) => a.order - b.order);

  const waves: JourneyWave[] = [];
  for (const entry of entries) {
    const name = entry.placed ? (entry.stage.wave?.name ?? null) : entry.stage.wave.name;
    const last = waves[waves.length - 1];
    // Grouping is on the wave INDEX, never the name: two waves may share a name (or have none), and
    // merging those would draw a parallel wave where the topology declared a sequence. The null
    // index — placed somewhere no wave names — groups with itself into ONE trailing row, which is
    // what the server's ordering already puts there.
    if (last && last.waveIndex === entry.waveIndex) {
      last.entries.push(entry);
    } else {
      waves.push({ waveIndex: entry.waveIndex, name, entries: [entry] });
    }
  }
  return waves;
}

/** This stage's pipelines that belong to `lane`. */
function bindingsFor(
  stage: ComponentPipelineStage,
  lane: Lane
): ComponentPipelineStage["bindings"] {
  return stage.bindings.filter((b) => lane.stageCategories.includes(b.category));
}

/** This stage's last release IN THIS LANE — never the newest across all lanes, which would credit
 *  one pipeline with another's release. Newest first within the lane when it spans two Categories. */
function currentFor(stage: ComponentPipelineStage, lane: Lane): ComponentPipelineStage["current"] {
  return stage.currents.find((c) => lane.stageCategories.includes(c.category)) ?? null;
}

/** Exported ONLY for `component-pipeline-continuous.test.tsx`, which renders it directly: the
 *  presentational contract (unknown-vs-blank, unbound-is-loud) is what that test owns, and rendering
 *  the whole page would drag in the query client for no added coverage. `pipelineKey` is optional
 *  and defaults to absent, same reason: a caller that never passes it (every pre-B2 test) gets
 *  the exact pre-B2 markup back, with no query client required — the remove-placement affordance
 *  (B2) only mounts, and only then needs `useMutation`'s context, once a caller opts in. */
export function StageCardForTest({
  stage,
  lane = LANES[0]!,
  pipelineKey
}: {
  stage: ComponentPipelineStage;
  lane?: Lane;
  pipelineKey?: unknown[];
}): React.JSX.Element {
  return <StageCard stage={stage} lane={lane} pipelineKey={pipelineKey} />;
}

/** Exported for the same reason as `StageCardForTest` — the "not placed" treatment is a contract.
 *  `componentId`/`pipelineKey` are optional for the same backward-compatibility reason: absent,
 *  the B2 "Place at target…" affordance does not mount and no query client is required. */
export function UnplacedStageCardForTest({
  stage,
  componentId,
  pipelineKey
}: {
  stage: ComponentPipelineUnplacedStage;
  componentId?: string;
  pipelineKey?: unknown[];
}): React.JSX.Element {
  return <UnplacedStageCard stage={stage} componentId={componentId} pipelineKey={pipelineKey} />;
}

/** Exported for `component-pipeline-continuous.test.tsx` — the ONE-TILE-PER-SOURCE rule (owner,
 *  2026-08-14) is a contract: N inputs render as N tiles side by side, never as one list. */
export function SourceNodeForTest(props: {
  label: string;
  sources: ComponentPipelineResponse["sources"];
  componentId?: string;
  pipelineKey?: unknown[];
  upstream: ComponentPipelineResponse["component"]["maintainedBy"];
  domainLocal: boolean;
}): React.JSX.Element {
  return (
    <SourceNode
      label={props.label}
      sources={props.sources}
      componentId={props.componentId ?? "component"}
      pipelineKey={props.pipelineKey ?? ["pipeline"]}
      upstream={props.upstream}
      domainLocal={props.domainLocal}
    />
  );
}

/** Exported for `component-pipeline-continuous.test.tsx` — a wave's LABEL is a contract: a
 *  declared wave says "Wave N", an unordered placement row must say it is NOT a wave (owner,
 *  2026-08-14: side-by-side targets under a wave-looking label read as "released to all at once"). */
export function WaveRowForTest(props: {
  wave: JourneyWave;
  lane?: Lane;
  componentId?: string;
  pipelineKey?: unknown[];
}): React.JSX.Element {
  return (
    <WaveRow
      wave={props.wave}
      lane={props.lane ?? LANES[0]!}
      componentId={props.componentId ?? "component"}
      pipelineKey={props.pipelineKey ?? ["pipeline"]}
    />
  );
}

/** Exported for `component-pipeline-continuous.test.tsx` — the open/close dialog's contract (the
 *  duration choices, the consequence copy, the confirm) is pinned by rendering it OPEN, since
 *  Radix portals nothing while closed under renderToStaticMarkup. */
export function SourceOpenCloseDialogForTest(props: {
  source: ComponentPipelineResponse["sources"][number];
  currentlyOpen: boolean;
}): React.JSX.Element {
  return (
    <SourceOpenCloseBody
      source={props.source}
      currentlyOpen={props.currentlyOpen}
      busy={false}
      error={null}
      onConfirm={() => {}}
      onCancel={() => {}}
    />
  );
}

/** THE STAGE'S CURRENT STATE AT A GLANCE — the deployment outcome as a pill beside its name.
 *
 *  Deliberately says "never deployed" rather than rendering nothing: an empty header would read as
 *  "fine", and a place a release has never reached is the fact the whole view exists to surface. */
/**
 * WHO MAINTAINS THIS PLACE — shown on every stage, placed or not.
 *
 * The commander gives the go-ahead; the OUTPOST still runs and maintains its own targets (owner,
 * 2026-08-04) — ADR-0017 §2 devolves execution to the originating outpost and leaves the commander
 * owning only the cross-boundary gate, and ADR-0011 has the receiving outpost validate every deploy
 * inside its own domain. A stage drawn with no domain on it invites the reading that the commander
 * deploys it, which is the one thing charter principle 1 says it does not do.
 *
 * An UNKNOWN domain renders as unknown rather than as ours: on a replica whose peer row has not
 * arrived, claiming a place is maintained here would be the exact misreading this exists to stop.
 */
function MaintainerLine({
  maintainedBy
}: {
  maintainedBy: ComponentPipelineStage["maintainedBy"];
}): React.JSX.Element {
  const { name, isSelf, role } = maintainedBy;
  return (
    <div className="text-slate-400" data-testid="stage-maintainer">
      Maintained by{" "}
      {name === null ? (
        <span className="italic" title={maintainedBy.domainId ?? undefined}>
          an unrecognised domain
        </span>
      ) : (
        <>
          <span className="font-medium text-slate-600">{name}</span>
          {role ? ` (${role})` : ""}
          {!isSelf && " — this instance coordinates it; that domain runs it"}
        </>
      )}
    </div>
  );
}

function StatusPill({
  current,
  hold
}: {
  current: ComponentPipelineStage["current"];
  hold?: ComponentPipelineStage["hold"];
}): React.JSX.Element {
  const status = current?.targetStatus ?? null;
  // Deployment outcome -> §1.5 tone, with the ADR-0028 hold override (#226): a held target's raw
  // status IS `pending`, and saying so is the bug — here "pending" would mean not "the wave has
  // not reached this stage" but "the wave IS here and something named is withholding it". The hold
  // takes the headline (`held`, info tone — waiting, not wrong); the raw column stays on the wire
  // and in the Deployment row below. Otherwise: in-flight/unrecognised is `warning`, and "never
  // deployed" is `neutral` — a real and ordinary state, not an alarm.
  const tone = hold
    ? "info"
    : status === "succeeded"
      ? "success"
      : status === "failed" || status === "blocked"
        ? "danger"
        : status
          ? "warning"
          : "neutral";
  return (
    <Badge
      variant={tone}
      className="whitespace-nowrap"
      data-testid="stage-status-pill"
      data-held={hold ? "true" : undefined}
    >
      {hold ? "held" : (status ?? "never deployed")}
    </Badge>
  );
}

/**
 * WHAT IS WITHHOLDING THIS STAGE'S RELEASE — a subnode of the stage, beside its entry gate.
 *
 * A subnode rather than a node of the pipeline, for exactly the reason the gate is one: this is a
 * condition on entering ONE place, not a step the release passes through on its way somewhere.
 *
 * IT NAMES THE DEPENDENCY, which is the entire point of the increment. A badge saying only "held"
 * would move the operator from "why is this pending?" to "why is this held?" and no further, and
 * the answer is not discoverable from anywhere else on this page. Each line is the server's own
 * `describeStageDependencyHold` sentence — the same one the hold Decision's `reasonTree` carries —
 * so the page and the audit record cannot describe the same verdict differently.
 *
 * The dependency renders by NAME with the id only as a tooltip, and falls back to the id when the
 * server sent no name (a deleted component, or an `undeclarable` entry whose raw JSON never had an
 * id to resolve). It is never an id dressed up as a name.
 */
function HoldSubnode({
  hold
}: {
  hold: NonNullable<ComponentPipelineStage["hold"]>;
}): React.JSX.Element {
  return (
    <div
      className="border-l-2 border-indigo-200 pl-2 text-[11px] leading-snug text-indigo-800"
      data-testid="stage-hold"
    >
      <span className="text-indigo-400">Held here</span>{" "}
      <span title="A stage-scoped component coupling (ADR-0028): this release is waiting for another component to reach this same stage. It clears itself — no operator action releases it.">
        the release{" "}
        <span className="font-medium">{hold.changeName ?? hold.changeId.slice(0, 8)}</span> is
        waiting on:
      </span>
      <div className="mt-0.5">
        {hold.dependencies.map((dependency) => (
          <div key={dependency.dependsOn} data-testid="stage-hold-dependency">
            <span className="font-medium" title={dependency.dependsOn}>
              {dependency.dependsOnName ?? dependency.dependsOn}
            </span>{" "}
            <span className="text-indigo-500">— {dependency.summary}</span>
            {dependency.source === "edge" && (
              // The remedy differs and must be visible: this coupling came from a `depends_on` edge
              // between two of the change's own targets, not from a declaration, so it is deleted in
              // the graph rather than edited in a pipeline.
              <span className="text-indigo-400" data-testid="stage-hold-from-edge">
                {" "}
                (from a <span className="font-mono">depends_on</span> edge, not a declaration)
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * THE REMOVE-PLACEMENT CONFIRM'S COPY (B2) — exported for the same portal reason as
 * `DeleteMappingConfirmBody`. Names the actual consequence rather than a euphemism: the component
 * loses this stage (no release reaches it until placed again), and states the coordination/
 * execution boundary explicitly (charter principle 1) — removing the placement withdraws SCP's
 * OWN coordination record, it does not touch whatever is already running at the target.
 */
export function RemovePlacementConfirmBody({ stageName }: { stageName: string }): React.JSX.Element {
  // Plain `<p>`, not Radix's `DialogDescription` (house pattern: `domain-local.tsx`'s
  // `PublishConfirmBody`) — `DialogDescription` reads Radix's Dialog context, which is absent when
  // this renders standalone under `renderToStaticMarkup` for the confirm-copy tests.
  return (
    <p className="text-sm text-slate-500" data-testid="remove-placement-confirm-body">
      This component loses its {stageName} stage — no release reaches it here again until it is
      placed once more. Nothing here is undeployed: SCP coordinates deploys, it does not run them,
      so whatever is already running at {stageName} keeps running until something else changes it.
    </p>
  );
}

/** The quiet remove-placement affordance on a PLACED stage (B2) — `placements.delete` matches the
 *  placement by id, so (unlike the source-mapping delete) this is never ambiguous about which row
 *  it removes; the Dialog confirm exists because the CONSEQUENCE, not the target, needs stating. */
function RemovePlacementButton({
  stage,
  pipelineKey
}: {
  stage: ComponentPipelineStage;
  pipelineKey: unknown[];
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const stageName = stage.stageName ?? stage.deploymentTarget.name;
  const deleteMutation = useMutation({
    mutationFn: () => client.placements.delete(stage.placement.id),
    onSuccess: async () => {
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: pipelineKey });
    }
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-1 pt-1 text-slate-400 hover:text-red-700",
            focusRing
          )}
          data-testid="remove-placement-button"
        >
          <Unlink className="size-3.5" strokeWidth={2} aria-hidden="true" />
          Remove placement
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove this placement?</DialogTitle>
        </DialogHeader>
        <RemovePlacementConfirmBody stageName={stageName} />
        {deleteMutation.isError && (
          <Alert tone="danger">
            {deleteMutation.error instanceof Error
              ? deleteMutation.error.message
              : "Failed to remove the placement."}
          </Alert>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={deleteMutation.isPending}
            onClick={() => deleteMutation.mutate()}
            data-testid="remove-placement-confirm"
          >
            {deleteMutation.isPending ? "Removing…" : "Remove"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StageCard({
  stage,
  lane,
  pipelineKey
}: {
  stage: ComponentPipelineStage;
  lane: Lane;
  /** B2 (docs/proposals/outpost-ui.md §4) — optional so the pre-B2 test callers (no query client
   *  in scope) keep rendering exactly as before; the remove-placement affordance mounts only when
   *  the real page supplies it. */
  pipelineKey?: unknown[];
}): React.JSX.Element {
  const versionUnknown = stage.unknownFields.includes("version");
  const bindings = bindingsFor(stage, lane);
  const current = currentFor(stage, lane);
  const hold = holdFor(stage, lane);
  return (
    <Card className="min-w-[15rem] flex-1" data-testid="pipeline-stage">
      <CardHeader className="pb-2">
        <NodeHeading
          kind="stage"
          title={stage.stageName ?? stage.deploymentTarget.name}
          hint={
            <>
              deploys to {stage.deploymentTarget.name}
              <TargetFacet target={stage.deploymentTarget} />
            </>
          }
          right={
            <span className="flex items-center gap-1.5">
              <StatusPill current={current} hold={hold} />
              {stage.bindings.length === 0 && (
                // An unbound placement FAKE-SUCCEEDS under stage-shaped compilation (ADR-0006 case (a)).
                // It must be loud, not absent. Gated on the WHOLE stage, not on this lane: a stage with a
                // software pipeline and no infra one is ordinary (its substrate is managed elsewhere),
                // while a stage bound to NOTHING is the alarm. Also never gated on `binding`, which is
                // merely `bindings[0]` — reading it would be the same mistake this file just stopped
                // making.
                <Badge variant="danger" data-testid="stage-unbound">
                  No executor
                </Badge>
              )}
            </span>
          }
        />
      </CardHeader>
      <CardContent className="space-y-2 pl-[3.4rem] text-xs text-slate-600">
        <MaintainerLine maintainedBy={stage.maintainedBy} />
        <GateSubnode gate={stage.gate} />
        {hold && <HoldSubnode hold={hold} />}
        {/* ONE ROW PER PIPELINE. A stage runs a build, an infra plan/apply and a config sync as
            separate pipelines (ADR-0007 Type), and rendering only the first hides the others. The
            Type is shown, not implied: "agentkit-bootstrap @ homelab-argo" says nothing about
            whether that is the thing that BUILDS or the thing that DEPLOYS. */}
        {bindings.map((binding) => (
          <div key={binding.type} data-testid="stage-executor">
            <span className="text-slate-400">{binding.type}</span>{" "}
            <ConsoleLink href={binding.url} testid="stage-executor-link">
              <span className="font-mono">{binding.externalRef || "—"}</span>
              {binding.executionSystemName ? ` @ ${binding.executionSystemName}` : ""}
            </ConsoleLink>
            {/* The ladder's provenance (ADR-0029), rendered verbatim — "via component" is the
                owner's own-infra case, "via service"/"via assembly" the inherited rungs (shared-
                infrastructure proposal §5's attribution). Silent when bound on the placement
                itself: that is the unremarkable direct case. */}
            {binding.resolvedVia && binding.resolvedVia !== "placement" && (
              <span
                className="ml-1 text-slate-400"
                data-testid="stage-executor-provenance"
                title={`This pipeline is not bound on this stage's placement — the resolver found it ${binding.resolvedVia === "organization" ? "at the org rung" : `on the ${binding.resolvedVia}`} (nearest-wins ancestor ladder), and a release here will use it.`}
              >
                via {binding.resolvedVia}
              </span>
            )}
          </div>
        ))}
        {stage.bindings.length > 0 && bindings.length === 0 && (
          // Bound at this place, but not by THIS pipeline. Muted and factual — it is not the
          // ADR-0006 alarm, and dressing it up as one would cry wolf on every component whose
          // substrate someone else manages.
          <div className="text-slate-400" data-testid="stage-lane-unmanaged">
            not managed by this pipeline here
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
        <div data-testid="stage-deployment">
          <span className="text-slate-400">Deployment</span>{" "}
          {current ? (
            // `change_wave_targets.status` IS the deployment outcome at this place. The arrow into
            // the stage already uses it for colour; showing it in words is what makes "deployed and
            // succeeded" distinguishable from "deployed and failed" without reading a colour.
            //
            // The RAW value is kept even when held — this row is the one place the column is
            // reported verbatim, and a held target really is `pending` — with the reason appended
            // rather than substituted, so the two facts stay separable. Reading `pending` here and
            // nothing else was the whole defect.
            <span
              className={
                current.targetStatus === "failed" || current.targetStatus === "blocked"
                  ? "font-medium text-red-700"
                  : hold
                    ? "font-medium text-indigo-700"
                    : current.targetStatus === "succeeded"
                      ? "font-medium text-green-700"
                      : "text-slate-500"
              }
            >
              {current.targetStatus ?? "unknown"}
              {hold ? " — never triggered: a stage dependency is withholding it" : ""}
              {current.waveName ? ` · wave ${current.waveName}` : ""}
            </span>
          ) : (
            <span className="text-slate-400">never deployed here</span>
          )}
        </div>
        <div data-testid="stage-current">
          <span className="text-slate-400">Last release</span>{" "}
          {current ? (
            <Link
              to="/changes/$id/pipeline"
              params={{ id: current.changeId }}
              className={cn(
                "inline-flex items-center gap-1 rounded underline hover:text-slate-900",
                focusRing
              )}
              data-testid="stage-run-link"
            >
              {current.changeName ?? current.changeId.slice(0, 8)}
              <ArrowRight className="size-3.5" strokeWidth={2} aria-hidden="true" />
            </Link>
          ) : (
            <span className="text-slate-400">nothing has released here</span>
          )}
        </div>
        {/* B2: a quiet, deliberately unobtrusive removal — this is not the primary action on a
            placed, healthy stage, so it does not compete with the rows above for attention. */}
        {pipelineKey && <RemovePlacementButton stage={stage} pipelineKey={pipelineKey} />}
      </CardContent>
    </Card>
  );
}

/**
 * PLACE AT TARGET (B2, docs/proposals/outpost-ui.md §4) — the affordance that replaces the
 * formerly-inert "Declare a placement…" prose. Two call sites, two shapes of the same picker:
 *
 *   - `UnplacedStageCard` already knows its own `deploymentTarget` (that IS the stage), so it
 *     pre-selects it — the picker still lists every target, because an operator opening it here
 *     may want a DIFFERENT one, but the common case is one click.
 *   - The whole-page empty state (`pipeline-empty`) knows no target at all, so it opens blank.
 *
 * Closed by default (just the button) — the list of deployment targets is fetched lazily
 * (`enabled: open`) so a page with several unplaced stages does not fire the query once per card.
 */
export function PlaceAtTargetPicker({
  componentId,
  pipelineKey,
  defaultTargetId
}: {
  componentId: string;
  pipelineKey: unknown[];
  defaultTargetId?: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [targetId, setTargetId] = useState(defaultTargetId ?? "");
  const queryClient = useQueryClient();

  const targetsQuery = useQuery({
    queryKey: ["deployment-targets", "place-at-target-picker"],
    queryFn: () => client.deploymentTargets.list({ limit: 100 }),
    enabled: open
  });

  const createMutation = useMutation({
    mutationFn: () => {
      const req: CreatePlacementRequest = { component: componentId, deploymentTarget: targetId };
      return client.placements.create(req);
    },
    onSuccess: async () => {
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: pipelineKey });
    }
  });

  if (!open) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        icon={Plus}
        onClick={() => setOpen(true)}
        data-testid="place-at-target-button"
      >
        Place at target…
      </Button>
    );
  }

  const targets: GraphObject[] = targetsQuery.data?.items ?? [];
  return (
    <div className="flex flex-col gap-2" data-testid="place-at-target-form">
      <Select value={targetId} onValueChange={setTargetId}>
        <SelectTrigger data-testid="place-at-target-select">
          <SelectValue
            placeholder={targetsQuery.isLoading ? "Loading targets…" : "Select a deployment target…"}
          />
        </SelectTrigger>
        <SelectContent>
          {targets.map((t) => (
            <SelectItem key={t.id} value={t.id}>
              {t.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {createMutation.isError && (
        <Alert tone="danger">
          {createMutation.error instanceof Error
            ? createMutation.error.message
            : "Failed to create the placement."}
        </Alert>
      )}
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!targetId || createMutation.isPending}
          onClick={() => createMutation.mutate()}
          data-testid="place-at-target-submit"
        >
          {createMutation.isPending ? "Placing…" : "Place"}
        </Button>
      </div>
    </div>
  );
}

/**
 * A DECLARED STAGE THIS COMPONENT NEVER REACHES.
 *
 * Greyed and dashed so it reads as an outline of a stage rather than a stage, and it says "not
 * placed" in words — the colour alone would be indistinguishable from "quiet". It deliberately shows
 * NO executor row, NO version row and NO last-release row: those are keyed on a placement that does
 * not exist, and an empty "Executes" line here would read as the ADR-0006 case (a) alarm ("bound to
 * nothing, would fake-succeed") over what is only an absence of a placement.
 */
function UnplacedStageCard({
  stage,
  componentId,
  pipelineKey
}: {
  stage: ComponentPipelineUnplacedStage;
  /** B2 — optional so pre-B2 callers (no query client in scope) render exactly as before; see
   *  `UnplacedStageCardForTest`. */
  componentId?: string;
  pipelineKey?: unknown[];
}): React.JSX.Element {
  return (
    <Card
      className="min-w-[15rem] flex-1 border-dashed bg-slate-50/60 shadow-none"
      data-testid="pipeline-stage-unplaced"
    >
      <CardHeader className="pb-2">
        <NodeHeading
          kind="unplaced"
          title={stage.stageName ?? stage.deploymentTarget.name}
          hint={
            <>
              declared at {stage.deploymentTarget.name}
              <TargetFacet target={stage.deploymentTarget} />
            </>
          }
          muted
          right={
            <Badge variant="neutral" className="text-slate-500" data-testid="stage-not-placed">
              Not placed
            </Badge>
          }
        />
      </CardHeader>
      <CardContent className="space-y-2 pl-[3.4rem] text-xs text-slate-400">
        <MaintainerLine maintainedBy={stage.maintainedBy} />
        <p>This component has no placement here, so its releases never reach this stage.</p>
        {componentId && pipelineKey && (
          <PlaceAtTargetPicker
            componentId={componentId}
            pipelineKey={pipelineKey}
            defaultTargetId={stage.deploymentTarget.id}
          />
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The arrow INTO a wave, coloured by what that wave can honestly claim.
 *
 * Exported for `component-pipeline-continuous.test.tsx`: the precedence ladder is a contract, and a
 * new state has to be PLACED in it deliberately rather than fall through to whatever is left.
 */
export function arrowInto(
  wave: JourneyWave,
  lane: Lane
): { state: PromotionState; label: string; detail?: string } {
  const placed = wave.entries.flatMap((e) => (e.placed ? [e.stage] : []));
  const states = placed.map((stage) => stateOf(currentFor(stage, lane), holdFor(stage, lane)));
  if (states.length === 0) {
    // Not `blocked` — nothing failed and no gate denied anything. There is simply nowhere for the
    // release to land, which is a configuration fact, not a verdict.
    return { state: "pending", label: "not placed — releases stop before here" };
  }
  if (states.includes("blocked")) return { state: "blocked", label: "blocked" };
  // ABOVE `approval` and below `blocked`. A wave with one failed target and one held one has
  // already gone wrong, and the failure is the thing to act on — the server agrees, and stops
  // holding on a failed wave for exactly that reason. But a hold outranks `approval` and `pending`:
  // it is the only one of the three that names a specific other thing to go and look at.
  if (states.includes("held")) {
    // The dependency BY NAME on the arrow itself, so the reason survives without opening a stage —
    // for a parallel wave whose targets are held by different things, all of them, de-duplicated.
    const names = [
      ...new Set(
        placed.flatMap(
          (stage) =>
            holdFor(stage, lane)?.dependencies.map(
              (dependency) => dependency.dependsOnName ?? dependency.dependsOn
            ) ?? []
        )
      )
    ];
    return {
      state: "held",
      label: "held",
      detail: `waiting for ${names.join(", ")} at this stage`
    };
  }
  if (states.includes("approval")) return { state: "approval", label: "awaiting approval" };
  if (states.every((s) => s === "open")) return { state: "open", label: "released" };
  return { state: "pending", label: "nothing released yet" };
}

/**
 * THE NODES OF ONE PIPELINE, in the order the GLOSSARY defines them.
 *
 * > **pipeline.** The ordered path a release travels for one executor Type — **build → registry →
 * > config → gamma → prod** for a software pipeline; **plan → gate → apply** for an infrastructure
 * > pipeline. (docs/GLOSSARY.md)
 *
 * So a pipeline is a CHAIN OF NODES, not a list of deploy stages with some metadata attached: the
 * source repo is a node, the registry is a node, each deploy stage is a node. Rendering the repos as
 * a sidebar of one card said they were context for the pipeline rather than the first step of it.
 *
 * Two nodes are deliberately CONDITIONAL, because drawing them unconditionally would draw steps that
 * nothing runs:
 *
 *   - **build** appears only when this component actually has a build pipeline (a `build`-Category
 *     binding or source rule). All 148 source mappings on the live estate are `configuration`, so
 *     for most components today the software pipeline genuinely starts at a config change, and a
 *     permanently-empty "Build" box would be decoration.
 *   - **registry** appears when the component builds here OR when a registry is DECLARED here
 *     (`data.registry.state !== "none"` — pipeline-substrate-registry-scan.md §9.2): an outpost
 *     builds nothing, but its registry still receives the promoted image, and leaving the node out
 *     there would say the image lands nowhere. The node carries the per-site `registry` fact so
 *     `RegistryNode` can NAME it; its body is the latest artifact digest when §9.3 projected one,
 *     else the explicit "no artifact digest recorded yet" — the same unknown/absence-not-blank rule
 *     the version cell follows.
 *   - **scan-sign** (§9.3, owner §7.2) appears ONLY on the COMMANDER — the scan at source is what
 *     authorises a cross-boundary transfer (ADR-0013), and the commander alone signs a promotion
 *     manifest; an outpost neither scans at source nor signs, so drawing the node there would claim
 *     a step this site never performs. It sits after Registry and before Config, and is drawn where
 *     a registry node is (something produces or receives an artifact here) or where an artifact is
 *     already projected — a software lane that starts at a config change and holds no artifact
 *     would otherwise carry a permanently-"no artifact yet" box, the same decoration argument that
 *     keeps Build conditional. `instanceRole` is a PARAMETER (read by the page off `useAuth()`, the
 *     way `router.tsx`/`AppShell.tsx` do) so this stays a pure function the tests can drive.
 */
type LaneNode =
  | { kind: "source"; key: string; label: string; sources: ComponentPipelineResponse["sources"] }
  | {
      kind: "build";
      key: string;
      bindings: ComponentPipelineStage["bindings"];
      artifact: ArtifactOnWire;
    }
  | {
      kind: "registry";
      key: string;
      registry: ComponentPipelineRegistry | null;
      artifact: ArtifactOnWire;
    }
  | { kind: "scan-sign"; key: string; artifact: ArtifactOnWire }
  | { kind: "wave"; key: string; wave: JourneyWave };

/**
 * Builds one lane's node chain. Exported for `component-pipeline-continuous.test.tsx` — which nodes
 * appear, and in what order, is the contract this view now IS. `registry` and `artifact` are
 * optional on the wire (older servers), so a caller may omit them: the pre-§9.2 chain then comes
 * back unchanged. `instanceRole` omitted/undefined reads as "not known to be the commander" — the
 * Scan & sign node is never drawn on a guess.
 */
export function laneNodes(
  data: Pick<ComponentPipelineResponse, "sources" | "stages" | "registry" | "artifact">,
  waves: JourneyWave[],
  lane: Lane,
  instanceRole?: InstanceRole | undefined
): LaneNode[] {
  const sourcesIn = (categories: readonly string[]) =>
    data.sources.filter((s) => categories.includes(s.category));
  const buildBindings = data.stages
    .flatMap((s) => s.bindings)
    .filter((b) => lane.buildCategories.includes(b.category));
  // Deduped: a build binding repeated at every placement is ONE build step, not one per place.
  const uniqueBuilds = [
    ...new Map(buildBindings.map((b) => [`${b.type}:${b.externalRef}`, b])).values()
  ];

  const nodes: LaneNode[] = [];
  const buildSources = sourcesIn(lane.buildCategories);
  const buildsHere = uniqueBuilds.length > 0 || buildSources.length > 0;
  const registry = data.registry ?? null;
  // Declared here, at this site. `none` is the server SAYING there is no `publishes_to` edge — a
  // stated absence, which does not draw a node on its own; a null/absent field is an older server,
  // which likewise draws nothing beyond what `buildsHere` earns.
  const registryDeclaredHere = registry !== null && registry.state !== "none";
  // `undefined` (older server) is carried through as-is: each node states "not known" for it,
  // which is a different sentence from `null`'s "no artifact yet".
  const artifact: ArtifactOnWire = data.artifact;

  if (buildsHere) {
    nodes.push({ kind: "source", key: "src-build", label: "Source code", sources: buildSources });
    nodes.push({ kind: "build", key: "build", bindings: uniqueBuilds, artifact });
  }
  // Between build and config, where the GLOSSARY puts it — and only in a lane that has one at all
  // (infra produces no registry artifact to advance by digest).
  const drawsRegistry = lane.hasRegistry && (buildsHere || registryDeclaredHere);
  if (drawsRegistry) {
    nodes.push({ kind: "registry", key: "registry", registry, artifact });
  }
  // Scan & sign — commander only, and only where an artifact exists or can (see the doc above).
  // `lane.hasRegistry` keeps it out of the infra lane on its own: nothing there is scanned at
  // source or signed into a promotion manifest as an OCI/blob artifact.
  if (
    lane.hasRegistry &&
    instanceRole === "commander" &&
    (drawsRegistry || (artifact !== null && artifact !== undefined))
  ) {
    nodes.push({ kind: "scan-sign", key: "scan-sign", artifact });
  }

  const stageSources = sourcesIn(lane.stageCategories);
  nodes.push({
    kind: "source",
    key: "src-stage",
    // GLOSSARY's "config" node for the software lane — the commit that triggers the deploy. For the
    // infra lane this is simply the infrastructure repo.
    label: buildsHere ? "Config" : "Source code",
    sources: stageSources
  });

  for (const wave of waves)
    nodes.push({ kind: "wave", key: `wave-${wave.waveIndex ?? "off"}`, wave });
  return nodes;
}

/**
 * Whether the lane renderer's SHARED connector before `nodes[i]` should draw. A "source" node now
 * fans in: each of its tiles carries its own `PromotionArrow` beneath it (owner, 2026-08-14), so the
 * shared connector immediately after it would be an EXTRA arrow, not the transition's only one —
 * suppressed here so a source's transition is drawn exactly once, at the tile(s). Every other
 * adjacent pair is untouched: `i > 0` is still the whole rule. Exported so the suppression itself is
 * assertable without standing up the fetching page around it.
 */
export function sharedConnectorVisible(nodes: readonly Pick<LaneNode, "kind">[], i: number): boolean {
  return i > 0 && nodes[i - 1]?.kind !== "source";
}

/**
 * THE HEAD OF A LANE — the repos a push to which releases this component through this pipeline.
 *
 * This is the durable RULE (`source_mappings`), not release history, so it answers "does a change
 * there affect this?" for a component that has never released — the same property the stages have.
 */
/**
 * A node's link OUT of CommanderSCP — to the repo, the Argo CD application, the Actions tab.
 *
 * `href` is null whenever the server could not KNOW the address (see `console-urls.ts`), and the
 * label then renders as plain text. That is the whole contract: a node is clickable exactly when
 * there is somewhere real to go, so a link never has to be tried to find out.
 *
 * `rel="noreferrer"` because these are operator-configured URLs pointing at systems outside this
 * app; `target="_blank"` because losing the pipeline view to navigate to Argo CD is a bad trade.
 */
function ConsoleLink({
  href,
  children,
  testid
}: {
  href: string | null;
  children: React.ReactNode;
  testid?: string;
}): React.JSX.Element {
  if (!href) return <span data-testid={testid}>{children}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={cn(
        "inline-flex items-center gap-1 rounded underline decoration-slate-300 underline-offset-2 hover:decoration-slate-900",
        focusRing
      )}
      data-testid={testid}
      title={href}
    >
      {children}
      {/* §1.6: this leaves CommanderSCP — ExternalLink at size-3.5, always after the text. */}
      <ExternalLink className="size-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
    </a>
  );
}

/**
 * PIPELINE NODE ICONS — one distinct glyph per node KIND, from the lucide vocabulary (design spec
 * §1.6/§4C's kinds map; the hand-rolled inline SVG set this replaces is gone — one icon system).
 *
 * Every node previously rendered as an identical white rectangle, so the chain read as a stack of
 * boxes and the KIND of each step was carried only by its title text. The glyph is what makes
 * "repo, build, registry, deploy" legible at a glance (owner, 2026-08-10). The `data-node-icon`
 * attribute is the distinctness contract `component-pipeline-continuous.test.tsx` pins.
 */
type NodeKind = "source" | "config" | "build" | "registry" | "scan-sign" | "stage" | "unplaced";

const NODE_ICON: Record<NodeKind, { icon: LucideIcon; tint: string }> = {
  source: { icon: GitBranch, tint: "bg-sky-50 text-sky-700" },
  config: { icon: SlidersHorizontal, tint: "bg-teal-50 text-teal-700" },
  build: { icon: Wrench, tint: "bg-amber-50 text-amber-700" },
  registry: { icon: Package, tint: "bg-violet-50 text-violet-700" },
  // shield-check — the scan at source that AUTHORISES a crossing, and the manifest the commander
  // signs to attest it (§9.3). Emerald, so it does not borrow the registry's violet or a stage's slate.
  "scan-sign": { icon: ShieldCheck, tint: "bg-emerald-50 text-emerald-700" },
  stage: { icon: Server, tint: "bg-slate-100 text-slate-600" },
  // dashed circle — declared, never reached (§1.6's "structurally not-yet" family)
  unplaced: { icon: CircleDashed, tint: "bg-slate-50 text-slate-400" }
};

function PipelineIcon({ kind }: { kind: NodeKind }): React.JSX.Element {
  const { icon: Icon, tint } = NODE_ICON[kind];
  return (
    <span
      className={`flex size-7 shrink-0 items-center justify-center rounded-md ${tint}`}
      aria-hidden="true"
      data-node-icon={kind}
    >
      <Icon className="size-4" strokeWidth={2} />
    </span>
  );
}

/** The header every node shares: its glyph, its name, and one line saying what the step DOES —
 *  so a node is self-explanatory without the reader already knowing the pipeline model. */
function NodeHeading({
  kind,
  title,
  hint,
  muted,
  right
}: {
  kind: NodeKind;
  title: string;
  /** A node's one-line "what this step DOES". A ReactNode so a stage can hang its target's
   *  substrate facet (`TargetFacet`) beside the sentence without a second row. */
  hint: React.ReactNode;
  muted?: boolean;
  right?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-2.5">
      <PipelineIcon kind={kind} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className={`text-sm font-medium ${muted ? "text-slate-400" : "text-slate-900"}`}>
            {title}
          </span>
          {right}
        </div>
        <p className="text-xs leading-snug text-slate-500">{hint}</p>
      </div>
    </div>
  );
}

/**
 * A node's REVIEW affordance (§9.3, owner §7.2: "clickable only once the fact exists"). When
 * `review` is given the tile IS a click target — a `Review` button in its header carrying the
 * `aria-label` the tests pin, and the card body opens the same dialog on click (links and other
 * buttons inside keep their own behaviour). When it is omitted there is NO affordance at all: no
 * button, no pointer, no hover — a tile with nothing to review must not look like one that has.
 */
interface NodeReview {
  ariaLabel: string;
  onOpen: () => void;
}

function NodeShell({
  kind,
  title,
  hint,
  testid,
  muted,
  review,
  children
}: {
  kind: NodeKind;
  title: string;
  hint: React.ReactNode;
  testid: string;
  muted?: boolean;
  review?: NodeReview;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Card
      className={cn(
        "w-full",
        muted && "border-dashed bg-slate-50/60 shadow-none",
        review && "cursor-pointer transition-colors hover:border-slate-400"
      )}
      data-testid={testid}
      data-reviewable={review ? "true" : undefined}
      onClick={
        review
          ? (event) => {
              // A click on a link or a button inside the tile is THAT control's click, not the
              // tile's — the review button below is the accessible control for the same action.
              if ((event.target as HTMLElement).closest("a,button")) return;
              review.onOpen();
            }
          : undefined
      }
    >
      <CardHeader className="pb-2">
        <NodeHeading
          kind={kind}
          title={title}
          hint={hint}
          muted={muted}
          right={
            review ? (
              <Button
                variant="outline"
                size="sm"
                aria-label={review.ariaLabel}
                title={review.ariaLabel}
                onClick={review.onOpen}
                data-testid={`${testid}-review`}
              >
                Review
              </Button>
            ) : undefined
          }
        />
      </CardHeader>
      <CardContent className="space-y-1 pl-[3.4rem] text-xs text-slate-600">{children}</CardContent>
    </Card>
  );
}

/**
 * THE CHANGE-SOURCE KINDS THIS PAGE OFFERS (A1, docs/proposals/outpost-ui.md §3). `sourceKind` is
 * an open string on the wire (`ChangeSourceEventParamSchema` is `z.string().min(1)`) — but only
 * these three carry a signature verifier in the webhook-adapter registry
 * (`apps/server/src/coordination/webhook-adapters.ts`'s `ADAPTERS`), so offering a fourth here
 * would create a mapping whose deliveries can never authenticate (falls back to the generic HMAC
 * scheme, which is a real but DIFFERENT configuration step, not "this kind works out of the box").
 */
const SOURCE_KINDS = ["github", "gitea", "gitlab"] as const;
type SourceKind = (typeof SOURCE_KINDS)[number];

/**
 * Shapes the `POST /change-sources/{sourceKind}/mappings` body — pure so the omit-blanks rule is
 * testable without a live mutation. Optional patterns are OMITTED, never sent as `""`: the schema
 * distinguishes "no filter" (omitted) from an actual empty-string pattern, and a blank input means
 * the operator left the field alone, not that they declared an empty rule. `type` is always sent,
 * deliberately — the whole point of A1/A2 is that "which pipeline" stops being a silent default.
 */
export function buildCreateMappingPayload(form: {
  repoPattern: string;
  pathPattern: string;
  refPattern: string;
  component: string;
  type: ExecutorType;
  classification: PipelineClassification | "";
  /** outpost-ui.md §9.3a — declared "this repo mirrors a commander-shared source". Sent only when
   *  true (omitted = domain-specific, the server default), mirroring `classification`'s
   *  omit-when-empty so an unticked box changes nothing on the wire. */
  mirrorOfShared?: boolean;
}): Omit<CreateSourceMappingRequest, "sourceKind"> {
  return {
    component: form.component,
    repoPattern: form.repoPattern.trim() || undefined,
    pathPattern: form.pathPattern.trim() || undefined,
    refPattern: form.refPattern.trim() || undefined,
    type: form.type,
    classification: form.classification || undefined,
    ...(form.mirrorOfShared ? { mirrorOfShared: true } : {})
  };
}

/**
 * ADD SOURCE MAPPING (A1) — offers exactly `CreateSourceMappingRequestSchema`'s fields, minus
 * `component`: this page already IS the component, so asking for it again would be asking the
 * operator to re-type something the URL already answers. `sourceKind` is a path segment on the
 * wire, not free text — see `SOURCE_KINDS`.
 */
export function SourceMappingForm({
  componentId,
  pipelineKey,
  onDone
}: {
  componentId: string;
  pipelineKey: unknown[];
  onDone: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [sourceKind, setSourceKind] = useState<SourceKind>("github");
  const [repoPattern, setRepoPattern] = useState("");
  const [pathPattern, setPathPattern] = useState("");
  const [refPattern, setRefPattern] = useState("");
  const [type, setType] = useState<ExecutorType>("configuration");
  const [classification, setClassification] = useState<PipelineClassification | "">("");
  const [mirrorOfShared, setMirrorOfShared] = useState(false);

  const createMutation = useMutation({
    mutationFn: () =>
      client.changeSources.createMapping(
        sourceKind,
        buildCreateMappingPayload({
          repoPattern,
          pathPattern,
          refPattern,
          component: componentId,
          type,
          classification,
          mirrorOfShared
        })
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: pipelineKey });
      onDone();
    }
  });

  return (
    <form
      className="flex flex-col gap-3 rounded-md border border-slate-200 bg-white p-3"
      onSubmit={(e) => {
        e.preventDefault();
        createMutation.mutate();
      }}
      data-testid="source-mapping-form"
    >
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor="mapping-source-kind" className="text-xs font-medium text-slate-600">
            Source kind
          </label>
          <Select value={sourceKind} onValueChange={(v) => setSourceKind(v as SourceKind)}>
            <SelectTrigger id="mapping-source-kind" data-testid="mapping-source-kind-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SOURCE_KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {k}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="mapping-type" className="text-xs font-medium text-slate-600">
            Type
          </label>
          <Select value={type} onValueChange={(v) => setType(v as ExecutorType)}>
            <SelectTrigger id="mapping-type" data-testid="mapping-type-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ExecutorTypeSchema.options.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="mapping-repo" className="text-xs font-medium text-slate-600">
          Repo pattern
        </label>
        <Input
          id="mapping-repo"
          value={repoPattern}
          onChange={(e) => setRepoPattern(e.target.value)}
          placeholder="org/repo"
          data-testid="mapping-repo-input"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="mapping-path" className="text-xs font-medium text-slate-600">
          Path pattern
        </label>
        <Input
          id="mapping-path"
          value={pathPattern}
          onChange={(e) => setPathPattern(e.target.value)}
          placeholder="empty matches the whole repo"
          data-testid="mapping-path-input"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="mapping-ref" className="text-xs font-medium text-slate-600">
          Ref pattern
        </label>
        <Input
          id="mapping-ref"
          value={refPattern}
          onChange={(e) => setRefPattern(e.target.value)}
          placeholder="refs/heads/main"
          data-testid="mapping-ref-input"
        />
        <p className="text-xs text-slate-500">
          Empty matches any branch — the amber &ldquo;any branch&rdquo; warning below exists
          because that is a genuinely broad rule, not a display quirk. There is no edit for a
          mapping once created: to narrow this later, delete it and add the narrower one.
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="mapping-classification" className="text-xs font-medium text-slate-600">
          Classification
        </label>
        <Select
          value={classification || "__unclassified"}
          onValueChange={(v) =>
            setClassification(v === "__unclassified" ? "" : (v as PipelineClassification))
          }
        >
          <SelectTrigger id="mapping-classification" data-testid="mapping-classification-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__unclassified">unclassified</SelectItem>
            {PipelineClassificationSchema.options.map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {/* outpost-ui.md §9.3a — DECLARED provenance. A domain often holds a COPY of a repo whose
          source of truth is the commander (shared ASG/instance-type IaC) right beside repos that
          are genuinely this domain's own (network config, CIDR bands). Nothing can tell them apart
          from the repo host — the operator declares it, and the source lane groups by it. */}
      <label className="flex items-start gap-2 text-xs text-slate-700">
        <input
          type="checkbox"
          className="mt-0.5 accent-army-600"
          checked={mirrorOfShared}
          onChange={(e) => setMirrorOfShared(e.target.checked)}
          data-testid="mapping-mirror-of-shared"
        />
        <span>
          <span className="font-medium">This repo is a mirror of a commander-shared source</span>
          <span className="block text-slate-500">
            Tick when this domain holds a copy of a repo the commander owns (shared infrastructure
            that is the same everywhere). Leave unticked for a domain-specific repo tracked only
            here. Declared, never inferred; it grants and withholds nothing.
          </span>
        </span>
      </label>
      {createMutation.isError && (
        <Alert tone="danger">
          {createMutation.error instanceof Error
            ? createMutation.error.message
            : "Failed to create the mapping."}
        </Alert>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={createMutation.isPending}
          data-testid="mapping-create-submit"
        >
          {createMutation.isPending ? "Adding…" : "Add mapping"}
        </Button>
      </div>
    </form>
  );
}

/**
 * Shapes the `DELETE /change-sources/{sourceKind}/mappings` body — the full IDENTITY TUPLE
 * (`DeleteSourceMappingRequestSchema`'s own doc: the table has no unique constraint, so a by-id
 * delete would leave a byte-identical survivor still correlating). Pure, so the tuple-not-id claim
 * is testable without a live mutation.
 */
export function buildDeleteMappingPayload(
  source: Pick<
    ComponentPipelineResponse["sources"][number],
    "repoPattern" | "pathPattern" | "refPattern" | "type"
  >,
  componentId: string
): DeleteSourceMappingRequest {
  return {
    component: componentId,
    repoPattern: source.repoPattern,
    pathPattern: source.pathPattern,
    refPattern: source.refPattern,
    // The pipeline projection widens Type to a plain string (components.ts's own comment: it
    // "carries the same type/category as a binding"); the server only ever writes a validated
    // ExecutorType into this column, so narrowing it back here is safe.
    type: source.type as ExecutorType
  };
}

/**
 * THE DELETE CONFIRM'S COPY — exported so the honesty claim is assertable directly (Radix's
 * `DialogContent` portals its children, which render nothing under `renderToStaticMarkup`; see
 * `domain-local.test.tsx`'s precedent). States the server's actual behavior rather than a
 * comfortable simplification: EVERY row matching this tuple goes, including duplicates
 * `discovery accept` can leave behind, and there is no edit — only delete and recreate.
 */
export function DeleteMappingConfirmBody({
  source
}: {
  source: Pick<ComponentPipelineResponse["sources"][number], "sourceKind" | "type">;
}): React.JSX.Element {
  // Plain `<p>`, not Radix's `DialogDescription` — see `RemovePlacementConfirmBody`'s comment.
  return (
    <p className="text-sm text-slate-500" data-testid="delete-mapping-confirm-body">
      Deletes every {source.sourceKind} mapping with this exact repo, path, ref, and{" "}
      {source.type} Type — if duplicate rows exist (discovery-accepted mappings can leave them),
      ALL of them go at once, not just this one. This cannot be undone, and there is no edit: to
      change a pattern, delete it and add the new one.
    </p>
  );
}

/** A single mapping row's delete affordance — a Dialog confirm, never a bare click-to-delete,
 *  because the consequence (`DeleteMappingConfirmBody`) is not obvious from the row alone. */
function DeleteMappingButton({
  source,
  componentId,
  pipelineKey
}: {
  source: ComponentPipelineResponse["sources"][number];
  componentId: string;
  pipelineKey: unknown[];
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const deleteMutation = useMutation({
    mutationFn: () =>
      client.changeSources.deleteMapping(source.sourceKind, buildDeleteMappingPayload(source, componentId)),
    onSuccess: async () => {
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: pipelineKey });
    }
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className={cn(
            "ml-1 inline-flex items-center gap-0.5 rounded text-slate-400 hover:text-red-700",
            focusRing
          )}
          title="There is no edit for a mapping — to change its pattern, delete it and add the new one."
          data-testid="delete-mapping-button"
        >
          <Trash2 className="size-3.5" strokeWidth={2} aria-hidden="true" />
          <span className="sr-only">Delete this mapping</span>
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete source mapping</DialogTitle>
        </DialogHeader>
        <DeleteMappingConfirmBody source={source} />
        {deleteMutation.isError && (
          <Alert tone="danger">
            {deleteMutation.error instanceof Error
              ? deleteMutation.error.message
              : "Failed to delete the mapping."}
          </Alert>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={deleteMutation.isPending}
            onClick={() => deleteMutation.mutate()}
            data-testid="delete-mapping-confirm"
          >
            {deleteMutation.isPending ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A disabled mapping is a DECLARED rule the correlation matcher skips, not a deleted one (owner,
 *  2026-08-14: "a toggle is theatre" unless something downstream honours it — migration 0063's
 *  `matchComponentForSource` is that something). Reads `!== false` rather than a bare `!source.enabled`
 *  so a value this component genuinely never received (an older cached response, a hand-built test
 *  fixture) still reads as enabled rather than silently muting every tile on the page. */
function isMappingEnabled(
  source: Pick<ComponentPipelineResponse["sources"][number], "enabled" | "effectivelyEnabled">
): boolean {
  // The READ-TIME truth, not the declared intent: a timed close whose bound has passed is OPEN
  // again (the matcher routes it) even though `enabled` still reads false. Painting from `enabled`
  // alone would show a shut arrow on a rule that is, right now, live.
  return source.effectivelyEnabled ?? source.enabled !== false;
}

/** A SOURCE NODE — the repos a push to which starts this pipeline. Durable rules, so it answers
 *  "does a change there affect this?" for a component that has never released. */
function SourceNode({
  label,
  sources,
  componentId,
  pipelineKey,
  upstream,
  domainLocal
}: {
  label: string;
  sources: ComponentPipelineResponse["sources"];
  componentId: string;
  pipelineKey: unknown[];
  /** Who maintains this component (outpost-ui.md §9.3a) — read from the response, never inferred. */
  upstream: ComponentPipelineResponse["component"]["maintainedBy"];
  domainLocal: boolean;
}): React.JSX.Element {
  const [adding, setAdding] = useState(false);
  // §9.3a (owner, 2026-08-14) — ONE pipeline, mixed-provenance inputs. When another domain
  // maintains this component (on an outpost: the commander), the commander is an OPAQUE PEER
  // INPUT to this pipeline: its shared repos (ASGs, instance types, …) are known only there — this
  // domain never learns them and must not pretend to. Alongside it, this domain's own mappings
  // are its DOMAIN-SPECIFIC inputs (network config, CIDR bands that stay in-domain), tracked only
  // here. Domain-local component: no commander input at all — its repos are the whole source. A
  // domain-local component cannot have a commander input by construction (it never journaled),
  // so the data and the rule agree; the UI states the shape rather than deciding it.
  const hasCommanderInput = !upstream.isSelf && upstream.domainId !== null && !domainLocal;
  // ONE TILE PER SOURCE (owner rule, 2026-08-14: "each source and target must be in its own tile
  // — commander and outposts alike"). This mirrors what the wave side already does — one
  // StageCard per target, side by side under a wave label — so a lane reads as a chain of tiles
  // at BOTH ends: N source tiles → build → registry → M target tiles per wave. Grouped by declared
  // provenance (mirror-of-shared before domain-specific), each tile carrying its own provenance
  // eyebrow, so three kinds of input read as three tiles rather than one list.
  const mirrors = sources.filter((s) => s.mirrorOfShared);
  const domainSpecific = sources.filter((s) => !s.mirrorOfShared);
  const showProvenance = hasCommanderInput || domainLocal;
  const tileCount = (hasCommanderInput ? 1 : 0) + sources.length;

  return (
    <div className="w-full" data-testid="pipeline-node-source">
      <SectionLabel className="mb-1 text-center">
        {label}
        <span className="ml-1 font-normal normal-case tracking-normal text-slate-400">
          {label === "Config"
            ? "— a commit here bumps the deployed configuration"
            : "— a push matching one of these rules starts a release"}
        </span>
      </SectionLabel>
      {tileCount === 0 ? (
        // The source-side twin of an unplaced stage: no push to any repo can start this pipeline,
        // so it only ever runs if someone raises a change by hand. Still carries its own downward
        // arrow (fan-in of one, drawn even when the "one" is empty) so the chain never reads as
        // having stopped here — a domain-local component with zero mappings (rare, ADR-0031) omits
        // the card itself but keeps the connector, since it has no "no repo mapped" claim to make.
        <div className="flex flex-col items-center gap-1">
          {!domainLocal && (
            <Card
              className="w-full border-dashed bg-slate-50/60 shadow-none"
              data-testid="pipeline-source-tile-none"
            >
              <CardContent className="py-3 text-xs text-slate-400" data-testid="pipeline-no-sources">
                No repo is mapped to this component here, so no push can trigger this pipeline.
              </CardContent>
            </Card>
          )}
          <PromotionArrow state="pending" />
        </div>
      ) : (
        <div className="flex flex-wrap items-stretch justify-center gap-2" data-testid="pipeline-source-row">
          {hasCommanderInput && (
            // THE COMMANDER AS AN OPAQUE INPUT — its own tile, named from maintainedBy (name null
            // = origin matches no known peer; say the id rather than guess). Deliberately NO repo,
            // host, path or ref: this domain does not know them, and a tile that showed any would
            // be an invention. Its own fan-in arrow too (owner, 2026-08-14: "each source should
            // have its own arrow") — plain `pending`, since there is no per-mapping enable/disable
            // concept for an input this domain does not own.
            <div className="flex min-w-[14rem] flex-1 basis-[14rem] flex-col items-center gap-1">
              <Card
                className="w-full"
                data-testid="pipeline-source-commander-input"
                title={`Shared inputs to this pipeline — the repos that are the same in every domain — are authored and tracked at ${upstream.name ?? upstream.domainId}. This domain does not see them; it only knows their source is the commander.`}
              >
                <CardHeader className="pb-1">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-slate-400">
                    Global — source: the commander
                  </p>
                  <div className="flex items-center gap-1.5 text-sm font-medium text-slate-900">
                    {upstream.role === "commander" ? (
                      <CommanderStar className="size-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
                    ) : (
                      <OutpostFort className="size-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
                    )}
                    {upstream.name ?? upstream.domainId}
                  </div>
                </CardHeader>
                <CardContent className="pt-0 text-xs text-slate-500">
                  repos not visible in this domain
                </CardContent>
              </Card>
              <PromotionArrow state="pending" />
            </div>
          )}
          {[...mirrors, ...domainSpecific].map((source) => (
            <SourceTile
              key={source.id}
              source={source}
              provenance={
                !showProvenance ? null : source.mirrorOfShared ? "mirror" : domainLocal ? "local" : "domain"
              }
              componentId={componentId}
              pipelineKey={pipelineKey}
            />
          ))}
        </div>
      )}
      {domainLocal && (
        // Domain-local component (ADR-0031, valid but rare): no commander input at all — its
        // repos are the whole source. Stated, so an operator comparing two pipelines sees WHY one
        // has a commander tile and the other does not.
        <p className="mt-1 text-center text-xs text-slate-500" data-testid="pipeline-source-no-upstream">
          Domain-local — this repo is the source of truth; nothing upstream of it.
        </p>
      )}
      <div className="mt-2 flex justify-center">
        {adding ? (
          <SourceMappingForm
            componentId={componentId}
            pipelineKey={pipelineKey}
            onDone={() => setAdding(false)}
          />
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            icon={Plus}
            onClick={() => setAdding(true)}
            data-testid="add-source-mapping-button"
          >
            Add source mapping
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * ONE SOURCE TILE — one repo rule, its own card, sitting beside its siblings in the source row, and
 * (owner, 2026-08-14) its own downward arrow beneath it: `tile, then arrow` in one column, so N
 * tiles read as N converging fan-in lines rather than one shared connector for the whole row.
 * `provenance` is the declared kind (outpost-ui.md §9.3a): "mirror" = a local copy of a commander-
 * shared repo; "domain" = domain-specific, tracked only here; "local" = a repo of a domain-local
 * component (nothing upstream); null = don't label (the commander's own site, where these are
 * simply its repos). The row body below is the pre-existing per-mapping rendering, unchanged —
 * every testid it carried still carries.
 */
function SourceTile({
  source,
  provenance,
  componentId,
  pipelineKey
}: {
  source: ComponentPipelineResponse["sources"][number];
  provenance: "mirror" | "domain" | "local" | null;
  componentId: string;
  pipelineKey: unknown[];
}): React.JSX.Element {
  // THE ARROW IS THE SWITCH (owner, 2026-08-14). The mapping's own fan-in arrow carries its
  // enable/disable: click flips it, colour states it — green = open (a push matching this rule
  // starts a release), shut slate = closed (declared, routes nothing). The mutation lives here so
  // the arrow stays a dumb renderer; a server refusal renders as an Alert after the click, never
  // as a pre-disabled control (M16.3's rule).
  // NOT one click (owner, 2026-08-14: "it shouldn't be one-click to enable/disable"). The arrow
  // OPENS A DIALOG. Closing offers a choice — for a period, or until re-opened by hand — and
  // confirms; opening confirms too. Enabled is the default; a routing rule is not something to flip
  // by a mis-click. The dialog owns the mutation; the arrow stays a dumb renderer.
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const toggleMutation = useMutation({
    mutationFn: (input: { enabled: boolean; disabledUntil: string | null }) =>
      client.changeSources.setMappingEnabled(source.sourceKind, source.id, input.enabled, input.disabledUntil),
    onSuccess: async () => {
      setDialogOpen(false);
      await queryClient.invalidateQueries({ queryKey: pipelineKey });
    }
  });
  const enabled = isMappingEnabled(source);
  const eyebrow =
    provenance === "mirror"
      ? { text: "Mirror of global — held in this domain", title: "A local COPY of a source the commander owns — declared by the operator at create, never inferred from the repo host. Its source of truth is the commander." }
      : provenance === "domain"
        ? { text: "Domain-specific — tracked only here", title: "Tracked only by this domain's outpost — network configuration, CIDR bands, anything that stays in-domain for classification. Its source of truth is here." }
        : provenance === "local"
          ? { text: "Domain-local", title: "A domain-local component's repo (ADR-0031): the whole source of truth, nothing upstream." }
          : null;
  const testid =
    provenance === "mirror"
      ? "pipeline-source-tile-mirror"
      : provenance === "domain" || provenance === "local"
        ? "pipeline-source-tile-domain-specific"
        : "pipeline-source-tile";
  const hasHeader = Boolean(eyebrow) || !enabled;
  return (
    <div className="flex min-w-[14rem] flex-1 basis-[14rem] flex-col items-center gap-1">
      <Card
        className={cn("w-full", !enabled && "border-dashed bg-slate-50/60 shadow-none")}
        data-testid={testid}
      >
        {hasHeader && (
          <CardHeader className="pb-1">
            {eyebrow && (
              <p className="text-[10px] font-medium uppercase tracking-wide text-slate-400" title={eyebrow.title}>
                {eyebrow.text}
              </p>
            )}
            {!enabled && (
              // The muted card alone reads as "quiet" — this says WHY: the rule is still declared,
              // it simply matches nothing right now. Distinct wording from delete on purpose (owner,
              // 2026-08-14: "routes nothing" is not "gone").
              <p
                className="text-[10px] font-medium uppercase tracking-wide text-amber-700"
                title="Disabled mappings stay declared but route nothing — a push matching this rule starts no release. Distinct from delete."
                data-testid="pipeline-source-tile-disabled-badge"
              >
                {source.disabledUntil
                  ? `closed until ${new Date(source.disabledUntil).toLocaleString()} — routes nothing`
                  : "closed until re-opened — routes nothing"}
              </p>
            )}
          </CardHeader>
        )}
        <CardContent className={`text-xs text-slate-600 ${hasHeader ? "pt-0" : "pt-4"}`}>
          {(() => {
            const sources = [source];
            void sources;
            const renderRow = (source: ComponentPipelineResponse["sources"][number]) => (

            <div key={source.id} data-testid="pipeline-source-mapping">
              <span className="text-slate-400">{source.sourceKind}</span>{" "}
              <ConsoleLink href={source.url} testid="pipeline-source-link">
                <span className="font-mono">{source.repoPattern ?? "(any repo)"}</span>
              </ConsoleLink>{" "}
              {source.pathPattern ? (
                <span className="font-mono text-slate-500">{source.pathPattern}</span>
              ) : (
                // A null path matches EVERY file in the repo — a far broader rule than a blank cell
                // suggests, and on the live estate a real one worth noticing.
                <span
                  className="text-amber-700"
                  title="This mapping has no path filter, so any commit anywhere in the repo releases this component."
                  data-testid="pipeline-source-whole-repo"
                >
                  whole repo
                </span>
              )}{" "}
              {source.refPattern ? (
                <span className="font-mono text-slate-500">{source.refPattern}</span>
              ) : (
                // The ref-side twin of "whole repo" above, and broad for the same reason: a null ref
                // matches EVERY branch. Rendering it is what keeps two mappings that route `dev` and
                // `main` to different pipelines from looking identical here (ADR-0030 §1 — the
                // dev-branch-pipelines ADR, not this branch's ADR-0032).
                <span
                  className="text-amber-700"
                  title="This mapping has no ref filter, so a push to any branch releases this component."
                  data-testid="pipeline-source-any-branch"
                >
                  any branch
                </span>
              )}{" "}
              {source.classification && (
                // Declared by the operator, never inferred from the branch name — and inert for
                // enforcement (ADR-0030 §3), so this is a label and nothing more.
                <span
                  className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600"
                  title="Operator-declared pipeline classification. UI/reporting only — it grants no scan exemption."
                  data-testid="pipeline-source-classification"
                >
                  {source.classification}
                </span>
              )}{" "}
              {/* §1.6: the forward glyph is ArrowRight — the rendered `→` literal stays dead. */}
              <span className="inline-flex items-center gap-1 text-slate-400">
                <ArrowRight className="size-3.5" strokeWidth={2} aria-hidden="true" />
                {source.type}
              </span>
              {/* A1: no edit exists on this table, so the row's only write is delete (see the
                  confirm's own copy for why it is never a bare click). */}
              <DeleteMappingButton source={source} componentId={componentId} pipelineKey={pipelineKey} />
            </div>
            );
            return renderRow(source);
          })()}
        </CardContent>
      </Card>
      <PromotionArrow
        state={enabled ? "open" : "pending"}
        inert={!enabled}
        onToggle={() => setDialogOpen(true)}
        busy={toggleMutation.isPending}
        toggleTitle={
          enabled
            ? "Open — a push matching this rule starts a release. Click to close it (you'll choose for how long, and confirm)."
            : source.disabledUntil
              ? `Closed until ${new Date(source.disabledUntil).toLocaleString()} — then opens again automatically. Click to open it now (confirm).`
              : "Closed until re-opened by hand — declared, but a push matching this rule starts nothing. Click to open it (confirm)."
        }
      />
      <SourceOpenCloseDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        source={source}
        currentlyOpen={enabled}
        busy={toggleMutation.isPending}
        error={toggleMutation.isError ? toggleMutation.error : null}
        onConfirm={(input) => toggleMutation.mutate(input)}
      />
    </div>
  );
}

/** How long a close lasts — the choices offered before confirming. `null` = until re-opened. */
const CLOSE_DURATIONS: { key: string; label: string; ms: number | null }[] = [
  { key: "1h", label: "1 hour", ms: 3_600_000 },
  { key: "4h", label: "4 hours", ms: 4 * 3_600_000 },
  { key: "24h", label: "24 hours", ms: 24 * 3_600_000 },
  { key: "7d", label: "7 days", ms: 7 * 24 * 3_600_000 },
  { key: "manual", label: "Until I re-open it", ms: null }
];

/**
 * THE OPEN/CLOSE DIALOG (owner, 2026-08-14) — the confirmation every flip goes through.
 *
 * CLOSING asks two things: for how long (a period, after which the rule opens again automatically
 * — evaluated at read time like a freeze window, no timer job — or until re-opened by hand), and
 * then a confirm that names the consequence: while closed, a push matching this rule starts no
 * release. OPENING is one confirm, naming what re-opens. Both are one deliberate click past the
 * arrow, never zero. Server refusals render inside the dialog, at the point of action.
 */
function SourceOpenCloseDialog({
  open,
  onOpenChange,
  source,
  currentlyOpen,
  busy,
  error,
  onConfirm
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: ComponentPipelineResponse["sources"][number];
  currentlyOpen: boolean;
  busy: boolean;
  error: unknown;
  onConfirm: (input: { enabled: boolean; disabledUntil: string | null }) => void;
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="source-open-close-dialog">
        <DialogHeader>
          <DialogTitle>{currentlyOpen ? "Close this source?" : "Open this source?"}</DialogTitle>
        </DialogHeader>
        <SourceOpenCloseBody
          source={source}
          currentlyOpen={currentlyOpen}
          busy={busy}
          error={error}
          onConfirm={onConfirm}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * The dialog's CONTENT, portal-free — exported for the test (Radix portals nothing under
 * renderToStaticMarkup, even when open; same reason domain-local.tsx exports PublishConfirmBody).
 * Owns the duration choice; the confirm is the ONLY thing that fires the mutation.
 */
export function SourceOpenCloseBody({
  source,
  currentlyOpen,
  busy,
  error,
  onConfirm,
  onCancel
}: {
  source: ComponentPipelineResponse["sources"][number];
  currentlyOpen: boolean;
  busy: boolean;
  error: unknown;
  onConfirm: (input: { enabled: boolean; disabledUntil: string | null }) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [duration, setDuration] = useState<string>("manual");
  const chosen = CLOSE_DURATIONS.find((d) => d.key === duration) ?? CLOSE_DURATIONS[CLOSE_DURATIONS.length - 1]!;
  const repo = source.repoPattern ?? "(any repo)";
  return (
    <>
      {/* The visible title lives in the shell's DialogTitle (Radix a11y wiring); this sr-only copy
          keeps the body self-describing when rendered portal-free. */}
      <span className="sr-only">{currentlyOpen ? "Close this source?" : "Open this source?"}</span>
      <div className="flex flex-col gap-3 text-sm text-slate-600">
        <p>
          <span className="font-mono text-slate-900">{repo}</span>
          {source.pathPattern ? <span className="font-mono text-slate-500"> {source.pathPattern}</span> : null}
          {" — "}
          <span className="text-slate-500">{source.type}</span>
        </p>
        {currentlyOpen ? (
          <>
            <p>
              While closed, <strong>a push matching this rule starts no release</strong>. The mapping
              stays declared — this is not a delete — and re-opens either automatically when the period
              ends, or when you open it again here.
            </p>
            <fieldset className="flex flex-col gap-1.5" data-testid="close-duration">
              <legend className="text-xs font-medium text-slate-700">Close for</legend>
              {CLOSE_DURATIONS.map((d) => (
                <label key={d.key} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="close-duration"
                    value={d.key}
                    className="accent-army-600"
                    checked={duration === d.key}
                    onChange={() => setDuration(d.key)}
                    data-testid={`close-duration-${d.key}`}
                  />
                  {d.label}
                </label>
              ))}
            </fieldset>
            <p className="text-xs text-slate-500">
              {chosen.ms === null
                ? "It stays closed until someone opens it again — no automatic re-open."
                : `It re-opens automatically at ${new Date(Date.now() + chosen.ms).toLocaleString()} — no timer to fail: every push checks the clock.`}
            </p>
          </>
        ) : (
          <p>
            Opening means <strong>a push matching this rule starts a release again</strong>, from the
            next matching push onward.
            {source.disabledUntil
              ? ` It was due to re-open automatically at ${new Date(source.disabledUntil).toLocaleString()}; opening now brings that forward.`
              : ""}
          </p>
        )}
        {error !== null && (
          <Alert tone="danger" data-testid="source-open-close-error">
            {error instanceof Error ? error.message : "Failed to update the mapping."}
          </Alert>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant={currentlyOpen ? "destructive" : "default"}
          disabled={busy}
          onClick={() =>
            onConfirm(
              currentlyOpen
                ? {
                    enabled: false,
                    disabledUntil: chosen.ms === null ? null : new Date(Date.now() + chosen.ms).toISOString()
                  }
                : { enabled: true, disabledUntil: null }
            )
          }
          data-testid="source-open-close-confirm"
        >
          {busy ? "…" : currentlyOpen ? `Close ${chosen.ms === null ? "until re-opened" : `for ${chosen.label}`}` : "Open"}
        </Button>
      </DialogFooter>
    </>
  );
}

/* ------------------------------------------------------------------------------------------------
 * ARTIFACT FACTS — small readers shared by the Build, Registry and Scan & sign tiles (§9.3).
 * Every helper READS a stored value or states its absence; none derives a value from a name.
 * ---------------------------------------------------------------------------------------------- */

/** A digest short enough for a tile row — `sha256:0123456789ab…`. The FULL value always travels in
 *  the element's `title`, so nothing is lost, only folded. */
export function shortDigest(digest: string): string {
  const [algo, hex] = digest.includes(":") ? digest.split(/:(.+)/, 2) : [null, digest];
  const head = (hex ?? "").slice(0, 12);
  const folded = (hex ?? "").length > 12 ? `${head}…` : (hex ?? "");
  return algo ? `${algo}:${folded}` : folded;
}

/** A short key fingerprint — the first 16 hex characters, folded. */
function shortFingerprint(fingerprint: string): string {
  return fingerprint.length > 16 ? `${fingerprint.slice(0, 16)}…` : fingerprint;
}

/** A timestamp for a tile ROW: the browser's locale form when the value parses as a date, else the
 *  stored string verbatim. Callers put the raw value in `title` — the dialogs render it verbatim. */
function whenLabel(value: string): string {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? value : new Date(ms).toLocaleString();
}

/** The digest a tile calls "the latest" — the LAST one the change's `sourceRef` lists (the array is
 *  carried verbatim; `promotionExports` follows the same newest-last convention). Null when the
 *  change lists none — a stated absence the tiles say out loud. */
export function latestDigest(artifact: ComponentPipelineArtifact): string | null {
  return artifact.digests.length > 0 ? (artifact.digests[artifact.digests.length - 1] ?? null) : null;
}

/** The newest export stamp — newest LAST (`signing.promotionExports` is append order, §9.4). */
export function latestExport(artifact: ComponentPipelineArtifact): PromotionExport | null {
  const exports = artifact.signing.promotionExports;
  return exports.length > 0 ? (exports[exports.length - 1] ?? null) : null;
}

/** `location` as an `href` ONLY when it parses as an http(s) URL — an OCI referrer ref or an
 *  artifact-store URI is stored verbatim and rendered as text, never guessed into a link. */
export function sbomLocationHref(location: string): string | null {
  try {
    const url = new URL(location);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** The SBOM tile line — `format specVersion · scanner scannerVersion · generatedAt`, joining ONLY
 *  the parts the reference carries (every field but `format` is optional on `SbomRefSchema`). */
export function sbomLine(sbom: SbomRef): string {
  const parts = [
    [sbom.format, sbom.specVersion].filter(Boolean).join(" "),
    [sbom.scanner, sbom.scannerVersion].filter(Boolean).join(" "),
    sbom.generatedAt ?? ""
  ].filter((part) => part.length > 0);
  return parts.join(" · ");
}

/** The peer an export was signed FOR — its `name` when the server still knew one, else its domain
 *  id verbatim (a stored identifier, not a guess). */
function peerLabel(entry: PromotionExport): string {
  return entry.peerName ?? entry.peerDomainId;
}

/** Whether a Build tile has anything to REVIEW: an SBOM reference or at least one signed export. */
export function buildHasReview(artifact: ArtifactOnWire): boolean {
  return Boolean(artifact && (artifact.sbom !== null || artifact.signing.promotionExports.length > 0));
}

/** Whether a Scan & sign tile has anything to REVIEW: at least one scan row or one signed export. */
export function scanSignHasReview(artifact: ArtifactOnWire): boolean {
  return Boolean(artifact && (artifact.scans.length > 0 || artifact.signing.promotionExports.length > 0));
}

/** One line per rule; the field labels are the wire's own names. */
function ArtifactFieldList({
  rows,
  testid
}: {
  rows: readonly { label: string; value: React.ReactNode; mono?: boolean }[];
  testid?: string;
}): React.JSX.Element {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs" data-testid={testid}>
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <dt className="text-slate-500">{row.label}</dt>
          <dd className={cn("min-w-0 text-slate-800", row.mono && "break-all font-mono")}>
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/* ------------------------------------------------------------------------------------------------
 * BUILD
 * ---------------------------------------------------------------------------------------------- */

/**
 * A BUILD NODE — what turns the source into an artifact. Hoisted out of the deploy stages: a build
 * happens once per release, not once per place, whatever scope its binding happens to hang off.
 *
 * §9.3 (owner §7.2) hangs two ARTIFACT facts under the executor line, each present or stated absent:
 *   - SBOM — the reference the first-party change report carried (`sourceRef.sbom`; SCP never
 *     generates one and stores no bytes), or "no SBOM reported for this artifact";
 *   - PM   — the promotion manifest the commander signed at the newest export (§9.4), or, on the
 *     commander, "not created — a promotion manifest is created at export to a peer". On an outpost
 *     the imported manifest (`sourceRef.promotionManifest`, written by the importer) is NOT on this
 *     wire — the tile says so ("imported manifest not projected yet") rather than inventing one.
 * The tile is clickable ONLY when an SBOM or a signed export exists (`buildHasReview`); the review
 * dialog renders both verbatim.
 */
function BuildNode({
  bindings,
  artifact,
  instanceRole
}: {
  bindings: ComponentPipelineStage["bindings"];
  artifact: ArtifactOnWire;
  instanceRole: InstanceRole | undefined;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const reviewable = buildHasReview(artifact);
  return (
    <>
      <NodeShell
        kind="build"
        title="Build"
        hint="turns the source into an artifact — runs once per release, not once per place"
        testid="pipeline-node-build"
        muted={bindings.length === 0 && !reviewable}
        review={
          reviewable
            ? { ariaLabel: "Review SBOM and promotion manifest", onOpen: () => setOpen(true) }
            : undefined
        }
      >
        {bindings.length === 0 ? (
          <p className="text-slate-400">
            No build executor is bound — this component&rsquo;s artifact is built upstream of
            CommanderSCP.
          </p>
        ) : (
          bindings.map((binding) => (
            <div key={`${binding.type}:${binding.externalRef}`} data-testid="pipeline-build-executor">
              <span className="text-slate-400">{binding.type}</span>{" "}
              <ConsoleLink href={binding.url} testid="pipeline-build-link">
                <span className="font-mono">{binding.externalRef || "—"}</span>
                {binding.executionSystemName ? ` @ ${binding.executionSystemName}` : ""}
              </ConsoleLink>
            </div>
          ))
        )}
        <BuildArtifactLines artifact={artifact} instanceRole={instanceRole} />
      </NodeShell>
      {artifact ? (
        <BuildReviewDialog open={open} onOpenChange={setOpen} artifact={artifact} />
      ) : null}
    </>
  );
}

/** The SBOM and PM lines of the Build tile — see `BuildNode`. */
function BuildArtifactLines({
  artifact,
  instanceRole
}: {
  artifact: ArtifactOnWire;
  instanceRole: InstanceRole | undefined;
}): React.JSX.Element | null {
  if (artifact === undefined) {
    // Older server: the `artifact` field is not on the wire, so neither fact is known either way.
    return null;
  }
  if (artifact === null) {
    return (
      <p className="text-slate-400" data-testid="pipeline-build-artifact" data-artifact-state="none">
        no artifact yet — no change of this component reports an artifact digest
      </p>
    );
  }
  const newest = latestExport(artifact);
  return (
    <>
      <p data-testid="pipeline-build-sbom" data-sbom-state={artifact.sbom ? "present" : "absent"}>
        <span className="text-slate-400">SBOM</span>{" "}
        {artifact.sbom ? (
          (() => {
            const href = sbomLocationHref(artifact.sbom.location);
            const line = sbomLine(artifact.sbom);
            return href ? (
              <ConsoleLink href={href} testid="pipeline-build-sbom-link">
                {line}
              </ConsoleLink>
            ) : (
              <span title={artifact.sbom.location}>{line}</span>
            );
          })()
        ) : (
          <span className="text-slate-400">no SBOM reported for this artifact</span>
        )}
      </p>
      <p data-testid="pipeline-build-pm" data-pm-state={newest ? "signed" : "absent"}>
        <span className="text-slate-400">PM</span>{" "}
        {newest ? (
          <span title={`Promotion manifest signed at export ${newest.exportedAt} for peer ${newest.peerDomainId}.`}>
            signed for <span className="font-mono">{peerLabel(newest)}</span> · {whenLabel(newest.exportedAt)} ·{" "}
            {newest.manifest.artifacts.length} artifact{newest.manifest.artifacts.length === 1 ? "" : "s"}
          </span>
        ) : instanceRole === "commander" ? (
          <span className="text-slate-400">
            not created — a promotion manifest is created at export to a peer
          </span>
        ) : (
          // The importer stores `sourceRef.promotionManifest` + `manifestSignature` (§8 "PM"), but
          // the component-pipeline wire carries no field for them yet — so this is an honest
          // "not projected", never a claim about whether one was imported.
          <span
            className="text-slate-400"
            title="This site's imported promotion manifest (sourceRef.promotionManifest) is not projected on the component pipeline yet — the wire has no field for it, so nothing is claimed either way."
          >
            imported manifest not projected yet
          </span>
        )}
      </p>
    </>
  );
}

/** The Build tile's review dialog — the Radix shell around `BuildReviewBody`. */
function BuildReviewDialog({
  open,
  onOpenChange,
  artifact
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  artifact: ComponentPipelineArtifact;
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" data-testid="build-review-dialog">
        <DialogHeader>
          <DialogTitle>SBOM and promotion manifest</DialogTitle>
        </DialogHeader>
        <BuildReviewBody artifact={artifact} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * The Build review dialog's CONTENT, portal-free — exported for the test (Radix portals nothing
 * under renderToStaticMarkup; same reason `SourceOpenCloseBody` is exported). Every field is the
 * stored value VERBATIM: the SBOM reference as reported, and each signed export's manifest as the
 * commander stamped it — the manifest, whether a signature is present, and the key fingerprint.
 */
export function BuildReviewBody({ artifact }: { artifact: ComponentPipelineArtifact }): React.JSX.Element {
  const exports = artifact.signing.promotionExports;
  return (
    <div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto text-sm text-slate-700">
      <span className="sr-only">SBOM and promotion manifest</span>
      <p className="text-xs text-slate-500">
        change <span className="font-mono">{artifact.changeName ?? artifact.changeId}</span>
      </p>
      <section data-testid="build-review-sbom">
        <SectionLabel>SBOM reference</SectionLabel>
        {artifact.sbom ? (
          <ArtifactFieldList
            rows={[
              { label: "format", value: artifact.sbom.format },
              { label: "specVersion", value: artifact.sbom.specVersion ?? "—" },
              { label: "digest", value: artifact.sbom.digest, mono: true },
              {
                label: "location",
                value: (() => {
                  const href = sbomLocationHref(artifact.sbom.location);
                  return href ? (
                    <ConsoleLink href={href}>{artifact.sbom.location}</ConsoleLink>
                  ) : (
                    artifact.sbom.location
                  );
                })(),
                mono: true
              },
              { label: "mediaType", value: artifact.sbom.mediaType ?? "—" },
              { label: "signatureRef", value: artifact.sbom.signatureRef ?? "—", mono: true },
              { label: "scanner", value: artifact.sbom.scanner ?? "—" },
              { label: "scannerVersion", value: artifact.sbom.scannerVersion ?? "—" },
              { label: "generatedAt", value: artifact.sbom.generatedAt ?? "—", mono: true }
            ]}
          />
        ) : (
          <p className="text-xs text-slate-400">no SBOM reported for this artifact</p>
        )}
      </section>
      <section data-testid="build-review-pm">
        <SectionLabel>Promotion manifest{exports.length > 1 ? "s" : ""}</SectionLabel>
        {exports.length === 0 ? (
          <p className="text-xs text-slate-400">
            not created — a promotion manifest is created at export to a peer
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {exports.map((entry) => (
              <div
                key={`${entry.peerDomainId}:${entry.exportedAt}:${entry.checksum}`}
                className="rounded-md border border-slate-200 p-3"
                data-testid="build-review-export"
              >
                <ArtifactFieldList
                  rows={[
                    { label: "manifestVersion", value: entry.manifest.manifestVersion, mono: true },
                    { label: "createdAt", value: entry.manifest.createdAt, mono: true },
                    { label: "exporterDomainId", value: entry.manifest.exporterDomainId, mono: true },
                    {
                      label: "peer",
                      value: (
                        <>
                          {entry.peerName ? <>{entry.peerName} · </> : null}
                          <span className="font-mono">{entry.manifest.peerDomainId}</span>
                        </>
                      )
                    },
                    { label: "changeUrn", value: entry.manifest.changeUrn, mono: true },
                    { label: "exportedAt", value: entry.exportedAt, mono: true },
                    {
                      label: "signature",
                      value: entry.manifestSignature.length > 0 ? "present" : "absent"
                    },
                    {
                      label: "keyFingerprint",
                      value: entry.keyFingerprint ?? "not recorded",
                      mono: true
                    }
                  ]}
                />
                <Table className="mt-2">
                  <TableHeader>
                    <TableRow>
                      <TableHead>type</TableHead>
                      <TableHead>digest</TableHead>
                      <TableHead>signatureRef</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {entry.manifest.artifacts.map((a) => (
                      <TableRow key={`${a.type}:${a.digest}`} data-testid="build-review-artifact">
                        <TableCell>{a.type}</TableCell>
                        <TableCell className="break-all font-mono text-xs">{a.digest}</TableCell>
                        <TableCell className="break-all font-mono text-xs">
                          {a.signatureRef ?? "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/** Exported ONLY for `component-pipeline-continuous.test.tsx`. */
export function BuildNodeForTest(props: {
  bindings: ComponentPipelineStage["bindings"];
  artifact: ArtifactOnWire;
  instanceRole?: InstanceRole;
}): React.JSX.Element {
  return <BuildNode bindings={props.bindings} artifact={props.artifact} instanceRole={props.instanceRole} />;
}

/* ------------------------------------------------------------------------------------------------
 * REGISTRY
 * ---------------------------------------------------------------------------------------------- */

/**
 * A REGISTRY NODE — where the built artifact lands, and what promotion advances by digest.
 *
 * The HEADER names the registry this component publishes to AT THIS SITE, read off the response's
 * `registry` (pipeline-substrate-registry-scan.md §9.2 — the component's `publishes_to` edge to a
 * domain-local execution-system, never the `image` executor binding, whose Type says what BUILDS
 * the artifact rather than where it lands). Three states, each STATED rather than chosen:
 *
 *   - `declared`  — `name (kind) · repository`, the name a console link to the registry's base URL
 *                   when the server knew one (base only: no registry deep-link shape is known here,
 *                   and a guessed path is a lie);
 *   - `ambiguous` — more than one `publishes_to` edge. The server does not pick, so neither does
 *                   this node: it says how many, in the design system's amber "operator should
 *                   notice" tone, and the tooltip says what to do about it;
 *   - `none`      — "no registry declared for this component here". An absence, not an unknown —
 *                   the node only appears in this state because the component BUILDS here.
 *
 * A null/absent `registry` is an older server; the header then falls back to the pre-§9.2 sentence.
 *
 * The BODY is the latest artifact digest (§9.3): the last digest the picked change's `sourceRef`
 * lists, folded with the full value in `title`, and WHICH change it came from. Absent, it says so —
 * "no artifact digest recorded yet" when the server projected `artifact` and found none (a stated
 * absence), or the pre-§9.3 "not observed" when the field is not on the wire at all (an unknown).
 */
function RegistryNode({
  registry,
  artifact
}: {
  registry: ComponentPipelineRegistry | null;
  artifact: ArtifactOnWire;
}): React.JSX.Element {
  const digest = artifact ? latestDigest(artifact) : null;
  return (
    <NodeShell
      kind="registry"
      title="Registry"
      hint={<RegistryHeadline registry={registry} />}
      testid="pipeline-node-registry"
      muted={digest === null}
    >
      {digest !== null && artifact ? (
        <p data-testid="pipeline-registry-digest">
          <span
            className="font-mono text-slate-800"
            title={
              artifact.digests.length > 1
                ? `${digest} — the last of ${artifact.digests.length} digests this change lists: ${artifact.digests.join(", ")}`
                : digest
            }
          >
            {shortDigest(digest)}
          </span>
          {artifact.digests.length > 1 ? (
            <span className="text-slate-400"> +{artifact.digests.length - 1} more</span>
          ) : null}{" "}
          <span className="text-slate-500">
            from change <span className="font-mono">{artifact.changeName ?? artifact.changeId}</span>
          </span>
        </p>
      ) : artifact === undefined ? (
        <p
          className="italic text-slate-400"
          data-testid="pipeline-registry-digest"
          data-artifact-state="unknown"
          title="This server does not project the artifact on the component pipeline, so nothing is known here either way."
        >
          not observed yet — no artifact digest or scan verdict is captured
        </p>
      ) : (
        <p
          className="text-slate-400"
          data-testid="pipeline-registry-digest"
          data-artifact-state="none"
          title="No change of this component carries an artifact digest in its sourceRef — the first-party change report is the sole way one arrives."
        >
          no artifact digest recorded yet
        </p>
      )}
    </NodeShell>
  );
}

/** Exported ONLY for `component-pipeline-continuous.test.tsx` — the three-state header is a
 *  contract, and rendering the whole page would drag in the query client for no added coverage. */
export function RegistryNodeForTest({
  registry,
  artifact
}: {
  registry: ComponentPipelineRegistry | null;
  artifact?: ArtifactOnWire;
}): React.JSX.Element {
  return <RegistryNode registry={registry} artifact={artifact} />;
}

/* ------------------------------------------------------------------------------------------------
 * SCAN & SIGN — commander only
 * ---------------------------------------------------------------------------------------------- */

/** The E6 verdict as the tile words it — `not_run` reads as "not run", the others verbatim. */
function exportGateLabel(gate: ComponentPipelineArtifact["exportGate"]): string {
  return gate === "not_run" ? "not run" : gate;
}

/**
 * THE SCAN & SIGN NODE (§9.3, owner §7.2) — the commander's scan AT SOURCE, which is what authorises
 * a cross-boundary transfer (ADR-0013), and the promotion manifest it SIGNS at export (§9.4). Two
 * independent "not yet" facts, each stated on its own line, never merged into one status.
 *
 * States, top to bottom:
 *   - artifact `null`  → "no artifact yet — nothing to scan";
 *   - no scan rows     → "not run — no scan result recorded for <digest>";
 *   - rows             → one per (scanner, digest): `scanner version · digest · status · C H M L ·
 *                        when`, the commander's own managed step marked "managed" (the wire's ONE
 *                        discriminator; never inferred from the scanner);
 *   then "export gate (E6): pass|fail|not run" (E6's own predicate, applied read-only), then the
 *   sign lines — one per export "manifest signed for <peer> <when> (key <fp>)", or "not signed
 *   yet — the promotion manifest is signed at export to a peer" — and the origin-signature line,
 *   "not recorded" unless a `signatureRef` exists (SCP never signs an origin artifact, ADR-0015).
 * Clickable ONLY when a scan row or an export exists (`scanSignHasReview`); the review dialog holds
 * the full tables and a link to the change for the raw evidence. No CVE rows anywhere: none are
 * stored (§8 "Scan").
 */
function ScanSignNode({ artifact }: { artifact: ArtifactOnWire }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const reviewable = scanSignHasReview(artifact);
  return (
    <>
      <NodeShell
        kind="scan-sign"
        title="Scan & sign"
        hint="at source — authorises cross-boundary transfer"
        testid="pipeline-node-scan-sign"
        muted={!reviewable}
        review={
          reviewable
            ? { ariaLabel: "Review scan and signing results", onOpen: () => setOpen(true) }
            : undefined
        }
      >
        <ScanSignLines artifact={artifact} />
      </NodeShell>
      {artifact ? (
        <ScanSignReviewDialog open={open} onOpenChange={setOpen} artifact={artifact} />
      ) : null}
    </>
  );
}

function ScanSignLines({ artifact }: { artifact: ArtifactOnWire }): React.JSX.Element {
  if (artifact === undefined) {
    return (
      <p
        className="italic text-slate-400"
        data-testid="pipeline-scan-state"
        data-scan-state="unknown"
        title="This server does not project the artifact on the component pipeline, so nothing is known here either way."
      >
        not observed — this server does not project scan or signing results
      </p>
    );
  }
  if (artifact === null) {
    return (
      <p className="text-slate-400" data-testid="pipeline-scan-state" data-scan-state="no-artifact">
        no artifact yet — nothing to scan
      </p>
    );
  }
  const digest = latestDigest(artifact);
  const exports = artifact.signing.promotionExports;
  return (
    <>
      {artifact.scans.length === 0 ? (
        <p className="text-slate-400" data-testid="pipeline-scan-state" data-scan-state="not-run">
          not run — no scan result recorded for{" "}
          {digest ? (
            <span className="font-mono" title={digest}>
              {shortDigest(digest)}
            </span>
          ) : (
            "this artifact"
          )}
        </p>
      ) : (
        <ul className="space-y-0.5" data-testid="pipeline-scan-state" data-scan-state="rows">
          {artifact.scans.map((scan) => (
            <li key={scan.controlRunId} data-testid="pipeline-scan-row" data-managed={scan.managed}>
              <span className="text-slate-800">
                {scan.scanner ?? scan.method} {scan.scannerVersion}
              </span>
              {" · "}
              <span className="font-mono" title={scan.digest}>
                {shortDigest(scan.digest)}
              </span>
              {" · "}
              <span className={scan.status === "pass" ? "text-emerald-700" : scan.status === "fail" ? "text-red-700" : "text-amber-700"}>
                {scan.status}
              </span>
              {" · "}
              {scan.counts ? (
                <span title="critical / high / medium / low counts, as the scanner reported them">
                  C{scan.counts.critical} H{scan.counts.high} M{scan.counts.medium} L{scan.counts.low}
                </span>
              ) : (
                <span className="text-slate-400">counts not recorded</span>
              )}
              {" · "}
              <span title={scan.evaluatedAt}>{whenLabel(scan.evaluatedAt)}</span>
              {scan.managed ? (
                <>
                  {" "}
                  <span
                    className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600"
                    title="Run by the commander's own promotion scan step at export — not an org-pipeline control."
                  >
                    managed
                  </span>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <p data-testid="pipeline-scan-export-gate" data-export-gate={artifact.exportGate}>
        <span className="text-slate-400">export gate (E6):</span>{" "}
        <span
          className={
            artifact.exportGate === "pass"
              ? "text-emerald-700"
              : artifact.exportGate === "fail"
                ? "text-red-700"
                : "text-slate-500"
          }
          title="E6's own predicate, applied read-only: passes when a digest-bound pass row exists for every non-blob artifact."
        >
          {exportGateLabel(artifact.exportGate)}
        </span>
      </p>
      {exports.length === 0 ? (
        <p className="text-slate-400" data-testid="pipeline-sign-state" data-sign-state="not-signed">
          not signed yet — the promotion manifest is signed at export to a peer
        </p>
      ) : (
        <ul className="space-y-0.5" data-testid="pipeline-sign-state" data-sign-state="signed">
          {exports.map((entry) => (
            <li
              key={`${entry.peerDomainId}:${entry.exportedAt}:${entry.checksum}`}
              data-testid="pipeline-sign-row"
            >
              manifest signed for <span className="font-mono">{peerLabel(entry)}</span>{" "}
              <span title={entry.exportedAt}>{whenLabel(entry.exportedAt)}</span>
              {entry.keyFingerprint ? (
                <>
                  {" "}
                  <span className="text-slate-500" title={entry.keyFingerprint}>
                    (key <span className="font-mono">{shortFingerprint(entry.keyFingerprint)}</span>)
                  </span>
                </>
              ) : (
                <span className="text-slate-400"> (key fingerprint not recorded)</span>
              )}
            </li>
          ))}
        </ul>
      )}
      <p data-testid="pipeline-origin-signature">
        <span className="text-slate-400">origin artifact signature:</span>{" "}
        {artifact.signing.originSignatureRefs.length === 0 ? (
          <span className="text-slate-400">not recorded</span>
        ) : (
          <span className="break-all font-mono">{artifact.signing.originSignatureRefs.join(", ")}</span>
        )}
      </p>
    </>
  );
}

/** The Scan & sign review dialog — the Radix shell around `ScanSignReviewBody`. */
function ScanSignReviewDialog({
  open,
  onOpenChange,
  artifact
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  artifact: ComponentPipelineArtifact;
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl" data-testid="scan-sign-review-dialog">
        <DialogHeader>
          <DialogTitle>Scan and signing results</DialogTitle>
        </DialogHeader>
        <ScanSignReviewBody artifact={artifact} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * The Scan & sign review dialog's CONTENT, portal-free — exported for the test. A scan table with
 * every `ScanRunSummary` field (threshold as its JSON when present, digest match, managed), an
 * exports table, and a link to the change's detail page, which renders every control run's raw
 * evidence JSON (`change-detail.tsx`) — the one place the underlying rows live.
 */
export function ScanSignReviewBody({ artifact }: { artifact: ComponentPipelineArtifact }): React.JSX.Element {
  const exports = artifact.signing.promotionExports;
  return (
    <div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto text-sm text-slate-700">
      <span className="sr-only">Scan and signing results</span>
      <p className="text-xs text-slate-500">
        change <span className="font-mono">{artifact.changeName ?? artifact.changeId}</span> · export
        gate (E6): <span data-testid="scan-review-export-gate">{exportGateLabel(artifact.exportGate)}</span>
      </p>
      <section data-testid="scan-review-scans">
        <SectionLabel>Scan results</SectionLabel>
        {artifact.scans.length === 0 ? (
          <p className="text-xs text-slate-400">not run — no scan result recorded</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>method</TableHead>
                <TableHead>scanner</TableHead>
                <TableHead>digest</TableHead>
                <TableHead>digestMatch</TableHead>
                <TableHead>status</TableHead>
                <TableHead>counts</TableHead>
                <TableHead>threshold</TableHead>
                <TableHead>evaluatedAt</TableHead>
                <TableHead>managed</TableHead>
                <TableHead>controlRunId</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {artifact.scans.map((scan) => (
                <TableRow key={scan.controlRunId} data-testid="scan-review-row">
                  <TableCell>{scan.method}</TableCell>
                  <TableCell>
                    {scan.scanner} {scan.scannerVersion}
                  </TableCell>
                  <TableCell className="break-all font-mono text-xs">{scan.digest}</TableCell>
                  <TableCell>
                    {scan.digestMatch === null ? "not recorded" : scan.digestMatch ? "true" : "false"}
                  </TableCell>
                  <TableCell>{scan.status}</TableCell>
                  <TableCell>
                    {scan.counts
                      ? `C${scan.counts.critical} H${scan.counts.high} M${scan.counts.medium} L${scan.counts.low}`
                      : "not recorded"}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {scan.threshold ? JSON.stringify(scan.threshold) : "—"}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{scan.evaluatedAt}</TableCell>
                  <TableCell>{scan.managed ? "managed" : "org pipeline"}</TableCell>
                  <TableCell className="font-mono text-xs">{scan.controlRunId}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
      <section data-testid="scan-review-exports">
        <SectionLabel>Signed exports</SectionLabel>
        {exports.length === 0 ? (
          <p className="text-xs text-slate-400">
            not signed yet — the promotion manifest is signed at export to a peer
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>peer</TableHead>
                <TableHead>exportedAt</TableHead>
                <TableHead>checksum</TableHead>
                <TableHead>keyFingerprint</TableHead>
                <TableHead>signature</TableHead>
                <TableHead>artifacts</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {exports.map((entry) => (
                <TableRow
                  key={`${entry.peerDomainId}:${entry.exportedAt}:${entry.checksum}`}
                  data-testid="scan-review-export-row"
                >
                  <TableCell>
                    {entry.peerName ? <>{entry.peerName} · </> : null}
                    <span className="font-mono text-xs">{entry.peerDomainId}</span>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{entry.exportedAt}</TableCell>
                  <TableCell className="break-all font-mono text-xs">{entry.checksum}</TableCell>
                  <TableCell className="break-all font-mono text-xs">
                    {entry.keyFingerprint ?? "not recorded"}
                  </TableCell>
                  <TableCell>{entry.manifestSignature.length > 0 ? "present" : "absent"}</TableCell>
                  <TableCell>{entry.manifest.artifacts.length}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
      <p data-testid="scan-review-origin-signature" className="text-xs">
        <span className="text-slate-500">origin artifact signature:</span>{" "}
        {artifact.signing.originSignatureRefs.length === 0 ? (
          <span className="text-slate-400">not recorded</span>
        ) : (
          <span className="break-all font-mono">{artifact.signing.originSignatureRefs.join(", ")}</span>
        )}
      </p>
      <p className="text-xs">
        <Link
          to="/changes/$id"
          params={{ id: artifact.changeId }}
          className={cn("underline decoration-slate-300 underline-offset-2 hover:decoration-slate-900", focusRing)}
          data-testid="scan-review-change-link"
        >
          raw evidence on the change
        </Link>
      </p>
    </div>
  );
}

/** Exported ONLY for `component-pipeline-continuous.test.tsx`. */
export function ScanSignNodeForTest({ artifact }: { artifact: ArtifactOnWire }): React.JSX.Element {
  return <ScanSignNode artifact={artifact} />;
}

/** The registry node's one-line header — see `RegistryNode` for the three states. */
function RegistryHeadline({
  registry
}: {
  registry: ComponentPipelineRegistry | null;
}): React.JSX.Element {
  if (registry === null) {
    // Older server: the field is not on the wire, so nothing here is known either way.
    return <>where the built artifact lands — promotion advances the same digest</>;
  }
  if (registry.state === "ambiguous") {
    return (
      <span
        className="text-amber-700"
        data-testid="pipeline-registry-state"
        data-registry-state="ambiguous"
        title={`This component has ${registry.edgeCount} publishes_to edges here. The projection states that rather than picking one — remove the extra edge(s) so the Delivery lane can name the registry.`}
      >
        {registry.edgeCount} registries declared — ambiguous
      </span>
    );
  }
  if (registry.state === "none") {
    return (
      <span data-testid="pipeline-registry-state" data-registry-state="none">
        no registry declared for this component here
      </span>
    );
  }
  return (
    <span data-testid="pipeline-registry-state" data-registry-state="declared">
      <span data-testid="pipeline-registry-name">
        <ConsoleLink href={registry.url} testid="pipeline-registry-link">
          {registry.name ?? "—"}
          {registry.kind ? ` (${registry.kind})` : ""}
        </ConsoleLink>
      </span>
      {registry.repository ? (
        <>
          {" · "}
          <span className="font-mono">{registry.repository}</span>
        </>
      ) : null}
    </span>
  );
}

/**
 * THE GATE INTO A STAGE — what must pass before a release may move here.
 *
 * A REQUIREMENT, not a verdict: it is resolved from durable `policy` objects, so it renders for a
 * component with nothing in flight. A verdict belongs to a change and carries a `decision_id`; the
 * change-scoped pipeline view owns that.
 *
 * "No automated checks" is stated OUT LOUD rather than left blank. Measured 2026-08-10, every live
 * policy has an empty `requireControls` and the estate holds 0 control bindings and 0 control runs
 * — so a silent gate node would be indistinguishable from a view that cannot see checks, when the
 * truth is that none are configured.
 */
/**
 * THE ENTRY GATE OF ONE STAGE — a SUBNODE of the stage, not a node of the pipeline.
 *
 * A gate is not a step a release passes through on its way somewhere; it is a condition on ENTERING
 * one place. Drawn as its own full-width node it doubled the length of every pipeline and implied
 * the release stops somewhere between two stages, which is not where it stops — it stops at the
 * door of the next one (owner, 2026-08-10). Attached to the stage it governs, it also stops needing
 * to merge several placements' policies into one wave-level gate: each target keeps its own.
 *
 * Resolved from the `policy` objects matching this placement (DESIGN §10.1) — the SAME resolution
 * the wave-boundary gate runs, so this view cannot disagree with the engine about what is required.
 * It is a REQUIREMENT, not a verdict: a verdict belongs to a change in flight and carries a
 * `decision_id`.
 *
 * "No automated check" is stated rather than left blank. Measured 2026-08-10: every live policy has
 * an empty `requireControls`, and the estate holds 0 control bindings and 0 control runs — so a
 * silent gate would be indistinguishable from a view that cannot see checks, when the truth is that
 * none are configured.
 */
/**
 * A CHECK'S STATE, as a mark PLUS a word — never a mark alone.
 *
 * The two absences are what a naive rendering loses, and they are the whole point: `not_started`
 * means nothing is at this gate for the check to run against; `pending` means a release IS here and
 * the check has not reported. One is idle, the other is the thing you are waiting on. A single grey
 * dot for both is exactly the confusion this view exists to remove.
 *
 * WHY NOT A PROGRESS BAR: there is no progress to draw. `control_runs.status` is terminal (pass |
 * fail | warning | skipped | timed_out | expired) and a control that has not reported has no row at
 * all — no start time, no percentage, no expected duration. A bar filling up would be an animation
 * over a number SCP does not have.
 */
const CHECK_LABEL: Record<string, string> = {
  not_started: "not started — nothing is at this gate",
  pending: "in progress — no outcome reported yet",
  pass: "passed",
  fail: "failed",
  warning: "passed with warnings",
  skipped: "skipped",
  timed_out: "timed out",
  expired: "expired — its evidence is too old"
};

function CheckMark({ status }: { status: string }): React.JSX.Element {
  // Lucide per §1.6/§4C (the unicode ✓ ✗ ! ◐ ○ set is gone): pass Check, fail X, warning
  // CircleAlert, in-progress CircleDashed, not-started Circle — same state colors as before.
  const mark: { icon: LucideIcon; className: string } =
    status === "pass"
      ? { icon: Check, className: "text-green-600" }
      : status === "fail" || status === "timed_out"
        ? { icon: X, className: "text-red-600" }
        : status === "warning"
          ? { icon: CircleAlert, className: "text-amber-600" }
          : status === "pending"
            ? { icon: CircleDashed, className: "text-slate-500" }
            : { icon: Circle, className: "text-slate-300" };
  const Icon = mark.icon;
  return (
    <span
      className={`inline-flex align-middle ${mark.className}`}
      aria-label={status}
      data-status={status}
    >
      <Icon className="size-3.5" strokeWidth={2} aria-hidden="true" />
    </span>
  );
}

function GateSubnode({ gate }: { gate: ComponentPipelineStage["gate"] }): React.JSX.Element {
  const policies = gate.policies;
  const approvals = policies.flatMap((p) => p.requireApprovals);

  return (
    <div
      className="border-l-2 border-slate-200 pl-2 text-xs leading-snug text-slate-500"
      data-testid="stage-gate"
    >
      <span className="text-slate-400">Entry gate</span>{" "}
      {policies.length === 0 ? (
        <span data-testid="gate-none">
          none — a release enters as soon as the previous stage succeeds
        </span>
      ) : (
        // The 2-column mini key-value list (spec §4C): requirement | verdict-with-icon, replacing
        // the ` · `/`; `-joined prose block. Rows, not a paragraph, so each requirement and its
        // state line up and scan.
        <div className="mt-0.5 grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-0.5">
          {approvals.length > 0 && (
            <>
              <span className="text-slate-400">Approval</span>
              <span data-testid="gate-approval">
                {approvals.map((a) => `${a.count}× ${a.fromRole} approval (${a.scope})`).join(", ")}
              </span>
            </>
          )}
          <span className="text-slate-400">Policy</span>
          <span data-testid="gate-policies">
            {policies.map((p) => `${p.name} · ${p.enforcement}`).join("; ")}
          </span>
          <span className="text-slate-400">Checks</span>
          <span data-testid="gate-checks" className="flex flex-col gap-0.5">
            {gate.checks.length === 0 ? (
              // Measured 2026-08-10: EVERY live policy is like this, and the estate holds 0 control
              // bindings and 0 control runs. Said out loud, because a missing list would read as
              // "this view cannot see checks" when the truth is that none are configured.
              <span className="italic text-slate-400">no automated check required</span>
            ) : (
              gate.checks.map((check) => (
                <span key={check.controlId} data-testid="gate-check">
                  <CheckMark status={check.status} />{" "}
                  <span className={check.status === "fail" ? "text-red-700" : undefined}>
                    {check.name ?? (
                      // A policy requiring a control that no longer exists blocks every release.
                      <span className="text-red-700" title={check.controlId}>
                        (missing control)
                      </span>
                    )}
                  </span>{" "}
                  <span className="text-slate-400">{CHECK_LABEL[check.status]}</span>
                </span>
              ))
            )}
          </span>
        </div>
      )}
    </div>
  );
}

function WaveRow({
  wave,
  lane,
  componentId,
  pipelineKey
}: {
  wave: JourneyWave;
  lane: Lane;
  componentId: string;
  pipelineKey: unknown[];
}): React.JSX.Element {
  return (
    <div className="w-full" data-testid="pipeline-wave">
      <SectionLabel className="mb-1 text-center">
        {wave.waveIndex === null ? (
          // Placed somewhere the topology never mentions. Real state — hidden by neither the server
          // nor here — but honestly separated from the declared journey, which is the ordered part.
          //
          // The label must carry the ORDER claim, not just the membership one (owner, 2026-08-14:
          // "why would we deploy to gamma and prod in parallel?"). Several targets side by side
          // read as one wave that fans out — which is a real and legitimate thing (us-east-1-prod ∥
          // us-west-1-prod) — so a row that is NOT a wave has to say it is not: these are places
          // the component is placed, with no declared ordering among them.
          <span
            title="This component is placed here, but no wave of its release topology names these places — so no ORDER among them is declared. Side by side here means 'placed at each', not 'released to all at once'. Attach a release topology to state the journey (e.g. gamma in its own wave, then prod fanning out to every prod region)."
            data-testid="pipeline-wave-unordered"
          >
            Placed, no wave order declared
          </span>
        ) : (
          <>
            Wave {wave.waveIndex + 1}
            {wave.name ? ` · ${wave.name}` : ""}
          </>
        )}
      </SectionLabel>
      <div className="flex flex-wrap items-stretch justify-center gap-2">
        {wave.entries.map((entry) =>
          entry.placed ? (
            <StageCard
              key={`p-${entry.stage.placement.id}`}
              stage={entry.stage}
              lane={lane}
              pipelineKey={pipelineKey}
            />
          ) : (
            <UnplacedStageCard
              key={`u-${entry.stage.deploymentTarget.id}`}
              stage={entry.stage}
              componentId={componentId}
              pipelineKey={pipelineKey}
            />
          )
        )}
      </div>
    </div>
  );
}

/** `/components/$id/infrastructure` — the infrastructure pipeline tab. */
export function ComponentInfrastructurePage(): React.JSX.Element {
  return <ComponentPipelinePage lane={LANES[1]!} />;
}

/** `/components/$id` — the SOFTWARE pipeline, and a component's default view. Each pipeline is its
 *  own tab (see `routes/component-detail.tsx`): they are independent pipelines with their own repos,
 *  executors and histories, and side by side they competed for the width each node chain needs. */
export function ComponentPipelinePage({
  lane = LANES[0]!
}: { lane?: Lane } = {}): React.JSX.Element {
  const idOrUrn = useIdOrUrnParam();
  // WHICH SITE THIS IS — the install-time `instanceRole` off `/auth/me`, read the way `router.tsx`
  // and `AppShell.tsx` read it (§8 "Commander-only signal"). It decides whether the Scan & sign
  // node is drawn at all and how the Build tile words an absent promotion manifest. Deliberately
  // NOT `component.maintainedBy.role`, which is the object's origin, not this instance's role.
  const { user } = useAuth();
  const instanceRole = user?.instanceRole;
  const pipelineKey = componentPipelineKey(idOrUrn ?? "");
  const query = useQuery({
    queryKey: pipelineKey,
    queryFn: () => client.components.pipeline(idOrUrn!),
    enabled: Boolean(idOrUrn)
  });

  if (query.isLoading) return <Skeleton className="h-24 w-full" />;
  if (query.error) {
    return (
      <QueryErrorNotice
        error={query.error}
        what="this component's pipeline"
        testId="pipeline-error"
      />
    );
  }
  const data = query.data;
  if (!data) return <p className="text-sm text-slate-500">No pipeline yet.</p>;

  const waves = buildJourney(data);
  const reaches = data.stages.filter((s) => s.wave !== null).length;
  const declared = reaches + data.unplacedStages.length;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={<span data-testid="component-name">{data.component.name}</span>}
        description={
          <span className="font-mono text-xs text-slate-500">{data.component.urn}</span>
        }
        actions={
          <Link to="/graph/$idOrUrn" params={{ idOrUrn: data.component.id }}>
            <Button variant="outline" size="sm">
              Open in graph explorer
              <ArrowRight className="size-4" strokeWidth={2} aria-hidden="true" />
            </Button>
          </Link>
        }
        meta={
          // WHY this component releases this way (charter principle 6). Without it, someone
          // attaching a topology to a SERVICE silently changes every component under it and nothing
          // says so. Compressed to fragments per §4C/copy rule 1 — each full sentence lives in the
          // fragment's `title` tooltip.
          <span
            className="flex flex-wrap items-center gap-2 text-xs text-slate-500"
            data-testid="pipeline-source"
          >
            {data.pipeline ? (
              <>
                <Badge
                  variant="neutral"
                  title={`Pipeline ${data.pipeline.topologyName ?? "(unnamed)"}, inherited from the ${data.pipeline.rung}${data.pipeline.attachedToName ? ` “${data.pipeline.attachedToName}”` : ""}.`}
                >
                  Topology: {data.pipeline.topologyName ?? "(unnamed)"}
                </Badge>
                <span>
                  inherited from the {data.pipeline.rung}
                  {data.pipeline.attachedToName ? ` “${data.pipeline.attachedToName}”` : ""}
                </span>
                {data.stageSource === "topology" ? (
                  <span
                    title={`Reaches ${reaches} of its ${declared} declared stage${declared === 1 ? "" : "s"}.`}
                  >
                    reaches {reaches}/{declared} declared stage{declared === 1 ? "" : "s"}
                  </span>
                ) : (
                  // The topology resolved but declares no journey over PLACES, so the stages below
                  // are just the placements. Saying so is the difference between "reaches
                  // everything" and "we cannot tell" — the response's `stageSource` exists for
                  // exactly this fragment.
                  <span title="Its waves name no deployment-targets, so the stages below are its placements only.">
                    waves name no deployment-targets — placements only
                  </span>
                )}
              </>
            ) : (
              <span title="No release topology is attached, so no journey is declared: releases compile to a single anonymous wave over every placement at once, and the stages below are shown as placements with no order among them. Attach a topology to state the order — typically gamma in its own wave, then prod fanning out to every prod region in parallel.">
                no release topology attached — no wave order; releases go to every placement at once
              </span>
            )}
          </span>
        }
      />

      {waves.length === 0 ? (
        // Not an error, and deliberately explicit about the consequence: a component placed nowhere,
        // with no topology to declare where it should go, cannot be deployed by anything. B2: the
        // old "Declare a placement to give it a stage." sentence — the exact inert prose
        // docs/proposals/outpost-ui.md §4 names — is gone, replaced by the actual write.
        <Card data-testid="pipeline-empty">
          <CardContent className="flex flex-col items-start gap-3 py-6 text-sm text-slate-600">
            <p>
              This component has no placements and no release topology declaring any stages, so
              it runs nowhere and nothing can deploy it.
            </p>
            <PlaceAtTargetPicker componentId={data.component.id} pipelineKey={pipelineKey} />
          </CardContent>
        </Card>
      ) : (
        (() => {
          const laneBound = data.stages.some((st) =>
            st.bindings.some((b) => lane.categories.includes(b.category))
          );
          const nodes = laneNodes(data, waves, lane, instanceRole);
          return (
            <section
              className="mx-auto flex max-w-2xl flex-col items-center gap-1"
              data-testid={`pipeline-lane-${lane.key}`}
            >
              {!laneBound && (
                // The nodes still render below. Absence of a pipeline is a fact about this
                // component, not a reason to hide the places it runs — and an empty tab would be
                // indistinguishable from a view that simply does not show infra.
                <p
                  className="w-full py-1 text-xs text-slate-500"
                  data-testid={`pipeline-lane-absent-${lane.key}`}
                >
                  {lane.absent}
                </p>
              )}
              {nodes.map((node, i) => {
                // Computed ONCE. It was called twice inline for `state` and `label`, and a third
                // call for `detail` would have made the duplication the shape of the code.
                const arrow = node.kind === "wave" ? arrowInto(node.wave, lane) : null;
                return (
                  <div key={node.key} className="flex w-full flex-col items-center gap-1">
                    {sharedConnectorVisible(nodes, i) && (
                      // Between two nodes, the connector is only a verdict where the model HAS one: a
                      // promotion into a deploy stage. Everywhere else it is a plain link, because
                      // colouring build→registry green would invent a gate nobody evaluated. A
                      // "source" node draws its OWN arrow per tile instead (`sharedConnectorVisible`),
                      // so this one is skipped right after it rather than adding a duplicate.
                      <PromotionArrow
                        state={arrow?.state ?? "pending"}
                        label={arrow?.label ?? ""}
                        detail={arrow?.detail}
                      />
                    )}
                    {node.kind === "source" && (
                      <SourceNode
                        label={node.label}
                        sources={node.sources}
                        componentId={data.component.id}
                        pipelineKey={pipelineKey}
                        upstream={data.component.maintainedBy}
                        domainLocal={data.component.domainLocal}
                      />
                    )}
                    {node.kind === "build" && (
                      <BuildNode
                        bindings={node.bindings}
                        artifact={node.artifact}
                        instanceRole={instanceRole}
                      />
                    )}
                    {node.kind === "registry" && (
                      <RegistryNode registry={node.registry} artifact={node.artifact} />
                    )}
                    {node.kind === "scan-sign" && <ScanSignNode artifact={node.artifact} />}
                    {node.kind === "wave" && (
                      <WaveRow
                        wave={node.wave}
                        lane={lane}
                        componentId={data.component.id}
                        pipelineKey={pipelineKey}
                      />
                    )}
                  </div>
                );
              })}
            </section>
          );
        })()
      )}
    </div>
  );
}
