import type { ChangeStageDependencyTarget, ChangeWave, ChangeWaveTarget } from "@scp/sdk";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Badge } from "../ui/badge";
import { formatDate, waveStatusVariant } from "../../routes/change-detail";

/**
 * The real-data source/executor links for one wave target (coordination-ui-views.md Layer A, where
 * they are called "Stage source/executor links" — the wave sense of that word, ADR-0021 D6).
 * Every field is optional because it comes from a *separate* lookup that
 * may legitimately be absent:
 *   executorRef       — the binding's `externalRef` (e.g. the Argo CD Application name). NB this is
 *                       sourced from the executor BINDING, never the wave-target's `executorRef`
 *                       (that is a run ref, null until the target triggers — grounding caveat).
 *   executorSystemUrl — the registered `execution-system` object's `serverUrl` (deep-link base).
 *   repoPattern       — the source-mapping `repoPattern` (the git source/config repo).
 */
export interface PipelineWaveTargetLinks {
  executorRef?: string | undefined;
  executorSystemUrl?: string | undefined;
  repoPattern?: string | undefined;
}

/** `border-t-transparent`-style highlight for the whole wave, mirroring waveCardClass semantics. */
function pipelineWaveBorderClass(status: string): string {
  switch (status) {
    case "running":
      return "border-blue-500 ring-1 ring-blue-500";
    case "failed":
      return "border-red-400";
    case "succeeded":
      return "border-green-300";
    case "skipped":
      return "border-slate-200 opacity-60";
    default:
      return "border-slate-200 opacity-80";
  }
}

/** Distinct `category · type` pipeline-kind pairs across a wave's targets (ADR-0007). Both fields
 *  are already server-derived on the wave-target response, so no client-side Category map needed. */
function pipelineKinds(wave: ChangeWave): { category: string; type: string }[] {
  const seen = new Map<string, { category: string; type: string }>();
  for (const t of wave.targets) {
    seen.set(`${t.category}::${t.type}`, { category: t.category, type: t.type });
  }
  return [...seen.values()];
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * A short, human-facing label for a deployed image ref (ADR-0008 signal 1) — the per-wave version.
 * Prefers the tag (`ghcr.io/x/y:1.2.3` → `1.2.3`); falls back to a git-style short digest
 * (`...@sha256:abcdef0…` → `sha256:abcdef0`); then to the image name. NEVER fabricates — the input
 * is the REAL ref reconcile observed from the executor. The `:`-that-is-a-tag is the last colon
 * AFTER the last `/` (so a `registry:5000/x/y` port is not mistaken for a tag).
 */
export function imageVersionLabel(image: string): string {
  const atIdx = image.indexOf("@");
  const digest = atIdx >= 0 ? image.slice(atIdx + 1) : undefined;
  const repoAndTag = atIdx >= 0 ? image.slice(0, atIdx) : image;

  const lastSlash = repoAndTag.lastIndexOf("/");
  const lastColon = repoAndTag.lastIndexOf(":");
  if (lastColon > lastSlash) {
    const tag = repoAndTag.slice(lastColon + 1);
    if (tag.length > 0) return tag;
  }

  if (digest) {
    const colon = digest.indexOf(":");
    if (colon > 0) {
      const algo = digest.slice(0, colon);
      const hex = digest.slice(colon + 1);
      return hex.length > 0 ? `${algo}:${hex.slice(0, 7)}` : digest;
    }
    return digest.slice(0, 12);
  }

  const name = repoAndTag.slice(lastSlash + 1);
  return name.length > 0 ? name : image;
}

/**
 * One compiled wave — one ordered step of the plan, the set of stages advanced at once (ADR-0021 D6)
 * — rendered top-to-bottom (coordination-ui-views.md view 2,
 * Layer A). Shows the wave's status, its Category/Type pipeline-kind badges, and per-target rows
 * with their status, per-wave version (the observed deployed image tag/digest, revision as
 * secondary detail — ADR-0008 signal 1), and source/executor links. The version is the REAL snapshot
 * reconcile observed from status(); when nothing is observed yet it renders an explicit "—"
 * placeholder, never invented.
 */
/**
 * WHAT IS WITHHOLDING ONE WAVE TARGET'S TRIGGER (ADR-0028 increment 4) — the change-pipeline's half
 * of the same fix the component-pipeline view got.
 *
 * The defect in one sentence: a held target's `change_wave_targets.status` IS `pending`, and so is
 * the status of a target the wave has not reached yet. Rendering the raw column and nothing else
 * made "waiting on something NAMED" and "nothing is happening here" the same picture — on the page
 * an operator opens first when a release is not moving.
 *
 * It names the dependency, because a badge saying only "held" moves the question from "why is this
 * pending?" to "why is this held?" and no further. Each line is the server's own
 * `describeStageDependencyHold` sentence, the same one the hold Decision's `reasonTree` carries.
 *
 * The RAW STATUS IS KEPT beside it rather than replaced: the column really does say `pending`, and
 * a view that quietly rewrote it would be lying in the other direction.
 */
function HeldTargetLine({ held }: { held: ChangeStageDependencyTarget }): React.JSX.Element {
  return (
    <div
      className="mt-1 border-l-2 border-indigo-200 pl-2 text-[11px] leading-snug text-indigo-800"
      data-testid="pipeline-wave-target-hold"
    >
      <span
        className="text-indigo-400"
        title="A stage-scoped component coupling (ADR-0028): this target's trigger is being withheld until another component reaches this same stage. It clears itself — no operator action releases it."
      >
        Never triggered — held by a stage dependency:
      </span>
      <div className="mt-0.5">
        {held.dependencies
          // ONLY THE UNSATISFIED ones, like the server's own projection: a target held by one of
          // three declared dependencies is held by that one, and listing the two that are met
          // beside it buries the answer in the question.
          .filter((dependency) => !dependency.satisfied)
          .map((dependency) => (
            <div key={dependency.dependsOn} data-testid="pipeline-wave-target-hold-dependency">
              <span className="font-medium" title={dependency.dependsOn}>
                {dependency.dependsOnName ?? dependency.dependsOn}
              </span>{" "}
              <span className="text-indigo-500">— {dependency.summary}</span>
              {dependency.source === "edge" && (
                // The remedy differs and must be visible: this coupling came from a `depends_on`
                // edge between two of the change's own targets, not from a declaration, so it is
                // deleted in the graph rather than edited in a pipeline.
                <span className="text-indigo-400" data-testid="pipeline-wave-target-hold-from-edge">
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

export function PipelineWaveCard({
  wave,
  waveNumber,
  linksFor,
  holdFor
}: {
  wave: ChangeWave;
  waveNumber: number;
  linksFor: (target: ChangeWaveTarget) => PipelineWaveTargetLinks;
  /** ADR-0028 increment 4 — the live stage-dependency verdict for this target, or null. OPTIONAL,
   *  and its absence means "this caller does not know", which renders exactly as the card did
   *  before: a caller that has not loaded `explain.stageDependencyStatus` must not thereby assert
   *  that nothing is held. */
  holdFor?: (target: ChangeWaveTarget) => ChangeStageDependencyTarget | null;
}): React.JSX.Element {
  const kinds = pipelineKinds(wave);
  return (
    <Card
      className={`w-full max-w-2xl ${pipelineWaveBorderClass(wave.status)}`}
      data-testid="pipeline-wave-card"
      data-wave={waveNumber}
    >
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">
            Wave {waveNumber}
            {wave.name ? `: ${wave.name}` : ` (index ${wave.waveIndex})`}
          </CardTitle>
          <Badge variant={waveStatusVariant(wave.status)} data-testid="pipeline-wave-status-badge">
            {wave.status}
          </Badge>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {kinds.map((k) => (
            <Badge
              key={`${k.category}::${k.type}`}
              variant="secondary"
              data-testid="pipeline-wave-kind-badge"
            >
              {k.category} · {k.type}
            </Badge>
          ))}
          {kinds.length === 0 && <span className="text-xs text-slate-400">no targets</span>}
        </div>
        <p className="mt-1 text-xs text-slate-500">
          Started {formatDate(wave.startedAt)} · Completed {formatDate(wave.completedAt)}
          {wave.requiresFanIn ? " · requires fan-in" : ""}
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {wave.targets.map((target) => {
          const links = linksFor(target);
          const held = holdFor?.(target) ?? null;
          return (
            <div
              key={target.id}
              className="rounded border border-slate-200 p-2 text-xs"
              data-testid="pipeline-wave-target-row"
              data-held={held ? "true" : undefined}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-slate-900">
                  {target.targetName ?? target.targetUrn ?? target.targetObjectId}
                </span>
                {/* BOTH, not one instead of the other. `held` is the headline because it is what
                    the operator needs to read first; the raw column stays beside it because this
                    is the change's own plan view, where `pending` is a real recorded value and
                    substituting it would be a second kind of lie. */}
                {held && (
                  <Badge
                    variant="outline"
                    className="border-indigo-300 bg-indigo-50 text-indigo-700"
                    data-testid="pipeline-wave-target-held-badge"
                  >
                    held
                  </Badge>
                )}
                <Badge variant={waveStatusVariant(target.status)}>{target.status}</Badge>
              </div>
              {held && <HeldTargetLine held={held} />}
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-slate-500">
                <span>
                  {target.category} · {target.type}
                </span>
                {/* Per-wave version: the REAL snapshot reconcile observed from status(), never
                    fabricated. Prefer the deployed image tag/digest (ADR-0008 signal 1) — a better
                    human version than the git SHA — and demote the synced git revision (decision 1)
                    to a secondary detail. When neither is observed yet, keep the explicit
                    placeholder. */}
                {(() => {
                  const image = target.observed?.images?.[0];
                  const revision = target.observed?.revision;
                  if (image) {
                    return (
                      <span title={revision ? `${image}\nrevision ${revision}` : image}>
                        version{" "}
                        <span
                          className="font-mono text-slate-700"
                          data-testid="pipeline-wave-observed-image"
                        >
                          {imageVersionLabel(image)}
                        </span>
                        {revision && (
                          <span
                            className="ml-1 text-slate-400"
                            data-testid="pipeline-wave-observed-revision"
                          >
                            (rev {revision.slice(0, 7)})
                          </span>
                        )}
                      </span>
                    );
                  }
                  if (revision) {
                    return (
                      <span title={`observed revision ${revision}`}>
                        version{" "}
                        <span
                          className="font-mono text-slate-700"
                          data-testid="pipeline-wave-observed-revision"
                        >
                          {revision.slice(0, 7)}
                        </span>
                      </span>
                    );
                  }
                  return (
                    <span title="per-wave version/digest not observed yet">
                      version <span className="text-slate-400">—</span>
                    </span>
                  );
                })()}
                {/* OBSERVE-ONLY progressive-delivery indicator (ADR-0008: rollout state is OBSERVED,
                    NOT DRIVEN). Display-only — phase · step N · weight% as the executor reported it,
                    with NO promote/abort/resume controls (SCP coordinates, never drives). Only the
                    fields the executor actually provided are shown; omitted when no rollout is
                    observed (the version placeholder above already covers "nothing observed"). */}
                {(() => {
                  const rollout = target.observed?.rollout;
                  if (!rollout) return null;
                  const parts: string[] = [];
                  if (rollout.phase) parts.push(rollout.phase);
                  if (typeof rollout.step === "number") parts.push(`step ${rollout.step}`);
                  if (typeof rollout.weight === "number") parts.push(`weight ${rollout.weight}%`);
                  if (parts.length === 0) return null;
                  return (
                    <span
                      className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-slate-600"
                      data-testid="pipeline-wave-observed-rollout"
                      title={
                        rollout.message
                          ? `rollout: ${rollout.message}`
                          : "observed rollout state (read-only)"
                      }
                    >
                      rollout {parts.join(" · ")}
                    </span>
                  );
                })()}
                {links.executorRef && (
                  <span data-testid="pipeline-wave-executor-link">
                    executor:{" "}
                    {links.executorSystemUrl ? (
                      <a
                        href={links.executorSystemUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-slate-700 underline hover:text-slate-900"
                        title={`${links.executorRef} on ${links.executorSystemUrl}`}
                      >
                        {links.executorRef} ↗ {hostOf(links.executorSystemUrl)}
                      </a>
                    ) : (
                      <span className="font-mono text-slate-700">{links.executorRef}</span>
                    )}
                  </span>
                )}
                {links.repoPattern && (
                  <span className="font-mono text-slate-700" data-testid="pipeline-wave-repo-link">
                    repo: {links.repoPattern}
                  </span>
                )}
              </div>
            </div>
          );
        })}
        {wave.targets.length === 0 && <p className="text-slate-500">No targets in this wave.</p>}
      </CardContent>
    </Card>
  );
}
