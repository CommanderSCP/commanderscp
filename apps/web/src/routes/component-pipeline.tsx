import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type {
  ComponentPipelineResponse,
  ComponentPipelineStage,
  ComponentPipelineUnplacedStage
} from "@scp/sdk";
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

/** A stage's promotion state, from what the SERVER could observe — never invented.
 *
 *  `pending` (grey) is the honest default: it means "nothing has released here", which is a real and
 *  common state for a placement, NOT a failure. Only an actually-failed target goes red. */
function stateOf(current: ComponentPipelineStage["current"]): PromotionState {
  if (!current) return "pending";
  const status = current.targetStatus ?? "";
  if (status === "failed" || status === "blocked") return "blocked";
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
 * when it has two (owner, 2026-08-03: "Each component needs 2 pipelines: infra & software").
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
    label: "Software pipeline",
    categories: ["build", "configuration"],
    stageCategories: ["configuration"],
    buildCategories: ["build"],
    hasRegistry: true,
    absent:
      "No build or configuration pipeline is bound for this component, so nothing releases its software."
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
 *  the whole page would drag in the query client for no added coverage. */
export function StageCardForTest({
  stage,
  lane = LANES[0]!
}: {
  stage: ComponentPipelineStage;
  lane?: Lane;
}): React.JSX.Element {
  return <StageCard stage={stage} lane={lane} />;
}

/** Exported for the same reason as `StageCardForTest` — the "not placed" treatment is a contract. */
export function UnplacedStageCardForTest({
  stage
}: {
  stage: ComponentPipelineUnplacedStage;
}): React.JSX.Element {
  return <UnplacedStageCard stage={stage} />;
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
  current
}: {
  current: ComponentPipelineStage["current"];
}): React.JSX.Element {
  const status = current?.targetStatus ?? null;
  const style =
    status === "succeeded"
      ? "bg-green-50 text-green-700"
      : status === "failed" || status === "blocked"
        ? "bg-red-50 text-red-700"
        : status
          ? "bg-amber-50 text-amber-700"
          : "bg-slate-100 text-slate-500";
  return (
    <span
      className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-medium ${style}`}
      data-testid="stage-status-pill"
    >
      {status ?? "never deployed"}
    </span>
  );
}

function StageCard({
  stage,
  lane
}: {
  stage: ComponentPipelineStage;
  lane: Lane;
}): React.JSX.Element {
  const versionUnknown = stage.unknownFields.includes("version");
  const bindings = bindingsFor(stage, lane);
  const current = currentFor(stage, lane);
  return (
    <Card className="min-w-[15rem] flex-1" data-testid="pipeline-stage">
      <CardHeader className="pb-2">
        <NodeHeading
          kind="stage"
          title={stage.stageName ?? stage.deploymentTarget.name}
          hint={`deploys to ${stage.deploymentTarget.name}`}
          right={
            <span className="flex items-center gap-1.5">
              <StatusPill current={current} />
              {stage.bindings.length === 0 && (
                // An unbound placement FAKE-SUCCEEDS under stage-shaped compilation (ADR-0006 case (a)).
                // It must be loud, not absent. Gated on the WHOLE stage, not on this lane: a stage with a
                // software pipeline and no infra one is ordinary (its substrate is managed elsewhere),
                // while a stage bound to NOTHING is the alarm. Also never gated on `binding`, which is
                // merely `bindings[0]` — reading it would be the same mistake this file just stopped
                // making.
                <Badge variant="destructive" data-testid="stage-unbound">
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
            <span
              className={
                current.targetStatus === "failed" || current.targetStatus === "blocked"
                  ? "font-medium text-red-700"
                  : current.targetStatus === "succeeded"
                    ? "font-medium text-green-700"
                    : "text-slate-500"
              }
            >
              {current.targetStatus ?? "unknown"}
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
              className="underline hover:text-slate-900"
              data-testid="stage-run-link"
            >
              {current.changeName ?? current.changeId.slice(0, 8)} →
            </Link>
          ) : (
            <span className="text-slate-400">nothing has released here</span>
          )}
        </div>
      </CardContent>
    </Card>
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
  stage
}: {
  stage: ComponentPipelineUnplacedStage;
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
          hint={`declared at ${stage.deploymentTarget.name}`}
          muted
          right={
            <Badge variant="outline" className="text-slate-500" data-testid="stage-not-placed">
              Not placed
            </Badge>
          }
        />
      </CardHeader>
      <CardContent className="space-y-2 pl-[3.4rem] text-xs text-slate-400">
        <MaintainerLine maintainedBy={stage.maintainedBy} />
        <p title="Declare a placement for this component at this deployment-target to give it a stage here.">
          This component has no placement here, so its releases never reach this stage.
        </p>
      </CardContent>
    </Card>
  );
}

/** The arrow INTO a wave, coloured by what that wave can honestly claim. */
function arrowInto(wave: JourneyWave, lane: Lane): { state: PromotionState; label: string } {
  const states = wave.entries.flatMap((e) =>
    e.placed ? [stateOf(currentFor(e.stage, lane))] : []
  );
  if (states.length === 0) {
    // Not `blocked` — nothing failed and no gate denied anything. There is simply nowhere for the
    // release to land, which is a configuration fact, not a verdict.
    return { state: "pending", label: "not placed — releases stop before here" };
  }
  if (states.includes("blocked")) return { state: "blocked", label: "blocked" };
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
 *   - **build + registry** appear only when this component actually has a build pipeline (a
 *     `build`-Category binding or source rule). All 148 source mappings on the live estate are
 *     `configuration`, so for most components today the software pipeline genuinely starts at a
 *     config change, and a permanently-empty "Build" box would be decoration.
 *   - **registry** is drawn as EXPLICITLY UNKNOWN even when it does appear. There is no `artifact`
 *     object type in the graph, and the digest and scan verdict that give the node its value are
 *     `coordination-ui-views.md` Layer B — unbuilt. It renders as a named, empty node saying so,
 *     which is the same unknown-not-blank rule the version cell follows.
 */
type LaneNode =
  | { kind: "source"; key: string; label: string; sources: ComponentPipelineResponse["sources"] }
  | { kind: "build"; key: string; bindings: ComponentPipelineStage["bindings"] }
  | { kind: "registry"; key: string }
  | { kind: "wave"; key: string; wave: JourneyWave };

/**
 * Builds one lane's node chain. Exported for `component-pipeline-continuous.test.tsx` — which nodes
 * appear, and in what order, is the contract this view now IS.
 */
export function laneNodes(
  data: Pick<ComponentPipelineResponse, "sources" | "stages">,
  waves: JourneyWave[],
  lane: Lane
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

  if (buildsHere) {
    nodes.push({ kind: "source", key: "src-build", label: "Source code", sources: buildSources });
    nodes.push({ kind: "build", key: "build", bindings: uniqueBuilds });
    if (lane.hasRegistry) nodes.push({ kind: "registry", key: "registry" });
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
      className="underline decoration-slate-300 underline-offset-2 hover:decoration-slate-900"
      data-testid={testid}
      title={href}
    >
      {children} ↗
    </a>
  );
}

/**
 * PIPELINE NODE ICONS — one distinct glyph per node KIND.
 *
 * Inline SVG rather than an icon package: adding a dependency for six glyphs means a lockfile
 * change and another thing to vendor for an air-gapped build (charter principle 5), and these never
 * need to change independently of this file. Stroke-based at 16px to sit with the existing type.
 *
 * Every node previously rendered as an identical white rectangle, so the chain read as a stack of
 * boxes and the KIND of each step was carried only by its title text. The glyph is what makes
 * "repo, build, registry, deploy" legible at a glance (owner, 2026-08-04).
 */
type NodeKind = "source" | "config" | "build" | "registry" | "stage" | "unplaced";

const NODE_ICON: Record<NodeKind, { path: React.ReactNode; tint: string }> = {
  // a git branch
  source: {
    path: (
      <>
        <circle cx="6" cy="4" r="2" />
        <circle cx="6" cy="16" r="2" />
        <circle cx="15" cy="8" r="2" />
        <path d="M6 6v8M8 16h3a4 4 0 0 0 4-4v-2" />
      </>
    ),
    tint: "bg-sky-50 text-sky-700"
  },
  // sliders — a config change
  config: {
    path: (
      <>
        <path d="M3 6h7M14 6h4M3 14h4M11 14h7" />
        <circle cx="12" cy="6" r="2" />
        <circle cx="9" cy="14" r="2" />
      </>
    ),
    tint: "bg-teal-50 text-teal-700"
  },
  // a hammer
  build: {
    path: (
      <>
        <path d="M11 4l5 5-2 2-5-5z" />
        <path d="M9 8l-5 5 3 3 5-5" />
      </>
    ),
    tint: "bg-amber-50 text-amber-700"
  },
  // a box / package
  registry: {
    path: (
      <>
        <path d="M10 3l7 4v6l-7 4-7-4V7z" />
        <path d="M3 7l7 4 7-4M10 11v7" />
      </>
    ),
    tint: "bg-violet-50 text-violet-700"
  },
  // a server
  stage: {
    path: (
      <>
        <rect x="3" y="4" width="14" height="5" rx="1" />
        <rect x="3" y="11" width="14" height="5" rx="1" />
        <path d="M6 6.5h.01M6 13.5h.01" />
      </>
    ),
    tint: "bg-slate-100 text-slate-600"
  },
  // a crossed-out circle — declared, never reached
  unplaced: {
    path: (
      <>
        <circle cx="10" cy="10" r="7" strokeDasharray="3 2" />
        <path d="M6 14L14 6" />
      </>
    ),
    tint: "bg-slate-50 text-slate-400"
  }
};

function PipelineIcon({ kind }: { kind: NodeKind }): React.JSX.Element {
  const icon = NODE_ICON[kind];
  return (
    <span
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${icon.tint}`}
      aria-hidden="true"
      data-node-icon={kind}
    >
      <svg
        viewBox="0 0 20 20"
        className="h-4 w-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {icon.path}
      </svg>
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
  hint: string;
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
        <p className="text-[11px] leading-snug text-slate-400">{hint}</p>
      </div>
    </div>
  );
}

function NodeShell({
  kind,
  title,
  hint,
  testid,
  muted,
  children
}: {
  kind: NodeKind;
  title: string;
  hint: string;
  testid: string;
  muted?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Card
      className={`w-full ${muted ? "border-dashed bg-slate-50/60 shadow-none" : ""}`}
      data-testid={testid}
    >
      <CardHeader className="pb-2">
        <NodeHeading kind={kind} title={title} hint={hint} muted={muted} />
      </CardHeader>
      <CardContent className="space-y-1 pl-[3.4rem] text-xs text-slate-600">{children}</CardContent>
    </Card>
  );
}

/** A SOURCE NODE — the repos a push to which starts this pipeline. Durable rules, so it answers
 *  "does a change there affect this?" for a component that has never released. */
function SourceNode({
  label,
  sources
}: {
  label: string;
  sources: ComponentPipelineResponse["sources"];
}): React.JSX.Element {
  return (
    <NodeShell
      kind={label === "Config" ? "config" : "source"}
      title={label}
      hint={
        label === "Config"
          ? "a commit here bumps the deployed configuration"
          : "a push matching one of these rules starts a release"
      }
      testid="pipeline-node-source"
      muted={sources.length === 0}
    >
      {sources.length === 0 ? (
        // The source-side twin of an unplaced stage: no push to any repo can start this pipeline,
        // so it only ever runs if someone raises a change by hand.
        <p className="text-slate-400" data-testid="pipeline-no-sources">
          No repo is mapped to this component here, so no push can trigger this pipeline.
        </p>
      ) : (
        sources.map((source) => (
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
            <span className="text-slate-400">→ {source.type}</span>
          </div>
        ))
      )}
    </NodeShell>
  );
}

/** A BUILD NODE — what turns the source into an artifact. Hoisted out of the deploy stages: a build
 *  happens once per release, not once per place, whatever scope its binding happens to hang off. */
function BuildNode({
  bindings
}: {
  bindings: ComponentPipelineStage["bindings"];
}): React.JSX.Element {
  return (
    <NodeShell
      kind="build"
      title="Build"
      hint="turns the source into an artifact — runs once per release, not once per place"
      testid="pipeline-node-build"
      muted={bindings.length === 0}
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
    </NodeShell>
  );
}

/**
 * A REGISTRY NODE — where the built artifact lands, and what promotion advances by digest.
 *
 * It renders as a NAMED EMPTY node on purpose. The glossary puts `registry` between build and
 * config, so leaving it out would misdraw the pipeline; but everything that would give it content —
 * the digest, the scan verdict — is `coordination-ui-views.md` Layer B and uncaptured, and there is
 * no `artifact` object type to read from. Saying "not observed" is the same rule the version cell
 * follows: an explicit unknown, never a confident blank.
 */
function RegistryNode(): React.JSX.Element {
  return (
    <NodeShell
      kind="registry"
      title="Registry"
      hint="where the built artifact lands — promotion advances the same digest"
      testid="pipeline-node-registry"
      muted
    >
      <p
        className="italic text-slate-400"
        title="The artifact digest and its scan verdict are observe-enrichment signals SCP does not capture yet — coordination-ui-views.md Layer B."
      >
        not observed yet — no artifact digest or scan verdict is captured
      </p>
    </NodeShell>
  );
}

/**
 * THE GATE INTO A STAGE — what must pass before a release may move here.
 *
 * A REQUIREMENT, not a verdict: it is resolved from durable `policy` objects, so it renders for a
 * component with nothing in flight. A verdict belongs to a change and carries a `decision_id`; the
 * change-scoped pipeline view owns that.
 *
 * "No automated checks" is stated OUT LOUD rather than left blank. Measured 2026-08-04, every live
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
 * door of the next one (owner, 2026-08-04). Attached to the stage it governs, it also stops needing
 * to merge several placements' policies into one wave-level gate: each target keeps its own.
 *
 * Resolved from the `policy` objects matching this placement (DESIGN §10.1) — the SAME resolution
 * the wave-boundary gate runs, so this view cannot disagree with the engine about what is required.
 * It is a REQUIREMENT, not a verdict: a verdict belongs to a change in flight and carries a
 * `decision_id`.
 *
 * "No automated check" is stated rather than left blank. Measured 2026-08-04: every live policy has
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
  const mark =
    status === "pass"
      ? { glyph: "✓", className: "text-green-600" }
      : status === "fail" || status === "timed_out"
        ? { glyph: "✗", className: "text-red-600" }
        : status === "warning"
          ? { glyph: "!", className: "text-amber-600" }
          : status === "pending"
            ? { glyph: "◐", className: "text-slate-500" }
            : { glyph: "○", className: "text-slate-300" };
  return (
    <span className={`font-medium ${mark.className}`} aria-label={status} data-status={status}>
      {mark.glyph}
    </span>
  );
}

function GateSubnode({ gate }: { gate: ComponentPipelineStage["gate"] }): React.JSX.Element {
  const policies = gate.policies;
  const approvals = policies.flatMap((p) => p.requireApprovals);

  return (
    <div
      className="border-l-2 border-slate-200 pl-2 text-[11px] leading-snug text-slate-500"
      data-testid="stage-gate"
    >
      <span className="text-slate-400">Entry gate</span>{" "}
      {policies.length === 0 ? (
        <span data-testid="gate-none">
          none — a release enters as soon as the previous stage succeeds
        </span>
      ) : (
        <>
          {approvals.length > 0 && (
            <span data-testid="gate-approval">
              {approvals.map((a) => `${a.count}× ${a.fromRole} approval (${a.scope})`).join(", ")}
            </span>
          )}
          {approvals.length > 0 && " · "}
          <span className="text-slate-400" data-testid="gate-policies">
            ({policies.map((p) => `${p.name} · ${p.enforcement}`).join("; ")})
          </span>
          <div data-testid="gate-checks" className="mt-0.5">
            {gate.checks.length === 0 ? (
              // Measured 2026-08-04: EVERY live policy is like this, and the estate holds 0 control
              // bindings and 0 control runs. Said out loud, because a missing list would read as
              // "this view cannot see checks" when the truth is that none are configured.
              <span className="italic text-slate-400">no automated check required</span>
            ) : (
              gate.checks.map((check) => (
                <div key={check.controlId} data-testid="gate-check">
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
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

function WaveRow({ wave, lane }: { wave: JourneyWave; lane: Lane }): React.JSX.Element {
  return (
    <div className="w-full" data-testid="pipeline-wave">
      <p className="mb-1 text-center text-xs font-medium uppercase tracking-wide text-slate-400">
        {wave.waveIndex === null ? (
          // Placed somewhere the topology never mentions. Real state — hidden by neither the server
          // nor here — but honestly separated from the declared journey, which is the ordered part.
          <span title="This component is placed here, but no wave of its release topology names this place.">
            Outside the pipeline definition
          </span>
        ) : (
          <>
            Wave {wave.waveIndex + 1}
            {wave.name ? ` · ${wave.name}` : ""}
          </>
        )}
      </p>
      <div className="flex flex-wrap items-stretch justify-center gap-2">
        {wave.entries.map((entry) =>
          entry.placed ? (
            <StageCard key={`p-${entry.stage.placement.id}`} stage={entry.stage} lane={lane} />
          ) : (
            <UnplacedStageCard key={`u-${entry.stage.deploymentTarget.id}`} stage={entry.stage} />
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

  const waves = buildJourney(data);
  const reaches = data.stages.filter((s) => s.wave !== null).length;
  const declared = reaches + data.unplacedStages.length;

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
            {data.stageSource === "topology" ? (
              <>
                {" "}
                Reaches {reaches} of its {declared} declared stage
                {declared === 1 ? "" : "s"}.
              </>
            ) : (
              // The topology resolved but declares no journey over PLACES, so the stages below are
              // just the placements. Saying so is the difference between "reaches everything" and
              // "we cannot tell" — the response's `stageSource` exists for exactly this sentence.
              <>
                {" "}
                Its waves name no deployment-targets, so the stages below are its placements only.
              </>
            )}
          </>
        ) : (
          <>No release topology is attached — releases compile to a single anonymous wave.</>
        )}
      </p>

      {waves.length === 0 ? (
        // Not an error, and deliberately explicit about the consequence: a component placed nowhere,
        // with no topology to declare where it should go, cannot be deployed by anything.
        <Card data-testid="pipeline-empty">
          <CardContent className="py-6 text-sm text-slate-600">
            This component has no placements and no release topology declaring any stages, so it
            runs nowhere and nothing can deploy it. Declare a placement to give it a stage.
          </CardContent>
        </Card>
      ) : (
        (() => {
          const laneBound = data.stages.some((st) =>
            st.bindings.some((b) => lane.categories.includes(b.category))
          );
          const nodes = laneNodes(data, waves, lane);
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
              {nodes.map((node, i) => (
                <div key={node.key} className="flex w-full flex-col items-center gap-1">
                  {i > 0 && (
                    // Between two nodes, the connector is only a verdict where the model HAS one: a
                    // promotion into a deploy stage. Everywhere else it is a plain link, because
                    // colouring build→registry green would invent a gate nobody evaluated.
                    <PromotionArrow
                      state={node.kind === "wave" ? arrowInto(node.wave, lane).state : "pending"}
                      label={node.kind === "wave" ? arrowInto(node.wave, lane).label : ""}
                    />
                  )}
                  {node.kind === "source" && (
                    <SourceNode label={node.label} sources={node.sources} />
                  )}
                  {node.kind === "build" && <BuildNode bindings={node.bindings} />}
                  {node.kind === "registry" && <RegistryNode />}
                  {node.kind === "wave" && <WaveRow wave={node.wave} lane={lane} />}
                </div>
              ))}
            </section>
          );
        })()
      )}
    </div>
  );
}
