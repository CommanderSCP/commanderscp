import { Link } from "@tanstack/react-router";
import { ArrowRight, ExternalLink } from "lucide-react";
import type { ChangeStageDependencyTarget } from "@scp/sdk";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Badge } from "../ui/badge";
import { cn, focusRing } from "../../lib/utils";
import { formatDate, waveStatusBorder, waveStatusTone } from "./wave-status";

/**
 * THE ONE WAVE CARD (design spec §2.13) — one compiled wave, one ordered step of a plan, the set of
 * stages advanced at once (ADR-0021 D6), rendered top-to-bottom with `PromotionArrow` connectors.
 *
 * MODULE CONTRACT — generalized so change surfaces use it today and campaign-detail.tsx migrates
 * onto it later WITHOUT changes here:
 *   - `wave` is the narrow STRUCTURAL `PipelineWaveLike` below, which both `ChangeWave` and
 *     `CampaignWave` already satisfy (they mirror). Deliberately not a union of the SDK types: a
 *     type-only structural prop keeps campaign schemas out of this module's import graph entirely,
 *     so bundling/tree-shaking cannot drag them in.
 *   - `testIdPrefix` drives every testid: `${prefix}-card`, `${prefix}-status-badge`,
 *     `${prefix}-kind-badge`, `${prefix}-target-row`, `${prefix}-observed-image`,
 *     `${prefix}-observed-revision`, `${prefix}-observed-rollout`, `${prefix}-executor-link`,
 *     `${prefix}-repo-link`, `${prefix}-target-change-link`. Defaults `pipeline-wave` (the change
 *     pipeline view); change detail passes `wave` (its historical ids); campaigns pass
 *     `campaign-wave`, which reproduces the wave board's pinned ids exactly.
 *   - Change-only detail (category/type kinds, attempt, observed version/rollout) and campaign-only
 *     detail (`memberChangeObjectId` → the member-Change link) are optional fields: each renders
 *     exactly when the data is present, so campaigns get version/executor/rollout parity the moment
 *     their wire type carries the fields.
 *   - `linksFor` is optional — surfaces that don't fetch binding/source links simply omit it.
 */

/** A wave target, structurally — the intersection-with-options of ChangeWaveTarget and
 *  CampaignWaveTarget. */
export interface PipelineWaveTargetLike {
  id: string;
  targetObjectId: string;
  targetUrn?: string | undefined;
  targetName?: string | undefined;
  status: string;
  /** Change targets (ADR-0007): WHICH pipeline this target rolls, and its derived Category. */
  type?: string;
  category?: string;
  attempt?: number;
  lastObservedAt?: string | null;
  /** The snapshot reconcile observed from status() (ADR-0008) — never fabricated. */
  observed?: {
    revision?: string | undefined;
    images?: string[] | undefined;
    rollout?:
      | {
          phase?: string | undefined;
          step?: number | undefined;
          weight?: number | undefined;
          message?: string | undefined;
        }
      | undefined;
  } | null;
  /** Campaign targets: the per-target member Change the wave fanned out into (DESIGN §9.5). */
  memberChangeObjectId?: string | null;
}

/** A compiled wave, structurally — satisfied by both ChangeWave and CampaignWave. */
export interface PipelineWaveLike {
  id: string;
  waveIndex: number;
  name: string | null;
  requiresFanIn: boolean;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  targets: PipelineWaveTargetLike[];
}

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

/** Distinct `category · type` pipeline-kind pairs across a wave's targets (ADR-0007). Both fields
 *  are server-derived on the change wave-target response; campaign targets don't carry them yet,
 *  so a wave with none simply shows no kind badges. */
function pipelineKinds(wave: PipelineWaveLike): { category: string; type: string }[] {
  const seen = new Map<string, { category: string; type: string }>();
  for (const t of wave.targets) {
    if (t.category && t.type)
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
 * The target's display name, hyperlinked to its component page (spec §4C: resolve wave-target
 * UUIDs — a bare UUID renders only as the mono LAST resort, when the server sent neither name nor
 * URN). This is the one renderer of a wave target's identity; every wave surface goes through it.
 */
function TargetName({
  target,
  nameOf
}: {
  target: PipelineWaveTargetLike;
  nameOf?: ((targetObjectId: string) => string | undefined) | undefined;
}): React.JSX.Element {
  // Payload-supplied name first, then the caller's resolver (use-object-names.ts), then URN; the
  // mono UUID stays the last resort for "this instance cannot name it".
  const label = target.targetName ?? nameOf?.(target.targetObjectId) ?? target.targetUrn;
  return (
    <Link
      to="/components/$idOrUrn"
      params={{ idOrUrn: target.targetObjectId }}
      className={cn(
        "min-w-0 break-all rounded font-medium text-slate-900 underline-offset-2 hover:underline",
        focusRing
      )}
    >
      {label ?? (
        <span className="break-all font-mono text-xs text-slate-600">{target.targetObjectId}</span>
      )}
    </Link>
  );
}

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
      className="mt-1 border-l-2 border-blue-200 pl-2 text-[11px] leading-snug text-blue-800"
      data-testid="pipeline-wave-target-hold"
    >
      <span
        className="text-blue-500"
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
              <span className="text-blue-600">— {dependency.summary}</span>
              {dependency.source === "edge" && (
                // The remedy differs and must be visible: this coupling came from a `depends_on`
                // edge between two of the change's own targets, not from a declaration, so it is
                // deleted in the graph rather than edited in a pipeline.
                <span className="text-blue-500" data-testid="pipeline-wave-target-hold-from-edge">
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
  nameOf,
  holdFor,
  testIdPrefix = "pipeline-wave"
}: {
  wave: PipelineWaveLike;
  waveNumber: number;
  linksFor?: (target: PipelineWaveTargetLike) => PipelineWaveTargetLinks;
  testIdPrefix?: string;
  /** Optional id->name resolver for payloads that carry only ids (lib/use-object-names.ts). */
  nameOf?: (targetObjectId: string) => string | undefined;
  /** ADR-0028 increment 4 — the live stage-dependency verdict for this target, or null. OPTIONAL,
   *  and its absence means "this caller does not know", which renders exactly as the card did
   *  before: a caller that has not loaded `explain.stageDependencyStatus` must not thereby assert
   *  that nothing is held. Structurally typed like every other prop of the generalized card. */
  holdFor?: (target: PipelineWaveTargetLike) => ChangeStageDependencyTarget | null;
}): React.JSX.Element {
  const kinds = pipelineKinds(wave);
  return (
    <Card
      className={`w-full max-w-2xl ${waveStatusBorder(wave.status)}`}
      data-testid={`${testIdPrefix}-card`}
      data-wave={waveNumber}
    >
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>
            Wave {waveNumber}
            {wave.name ? `: ${wave.name}` : ""}
          </CardTitle>
          <Badge variant={waveStatusTone(wave.status)} data-testid={`${testIdPrefix}-status-badge`}>
            {wave.status}
          </Badge>
        </div>
        {kinds.length > 0 && (
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {kinds.map((k) => (
              <Badge
                key={`${k.category}::${k.type}`}
                variant="neutral"
                data-testid={`${testIdPrefix}-kind-badge`}
              >
                {k.category} · {k.type}
              </Badge>
            ))}
          </div>
        )}
        <p className="mt-1 text-xs text-slate-500">
          Started {formatDate(wave.startedAt)} · Completed {formatDate(wave.completedAt)}
          {wave.requiresFanIn ? " · requires fan-in" : ""}
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {wave.targets.map((target) => {
          const links = linksFor?.(target) ?? {};
          const held = holdFor?.(target) ?? null;
          return (
            <div
              key={target.id}
              className="rounded border border-slate-200 p-2 text-xs"
              data-testid={`${testIdPrefix}-target-row`}
              data-held={held ? "true" : undefined}
            >
              <div className="flex min-w-0 items-center justify-between gap-2">
                <TargetName target={target} nameOf={nameOf} />
                {/* BOTH, not one instead of the other (ADR-0028 increment 4). `held` is the
                    headline; the raw status stays beside it because `pending` is a real recorded
                    value and substituting it would be a second kind of lie. */}
                {held && (
                  <Badge variant="info" data-testid="pipeline-wave-target-held-badge">
                    held
                  </Badge>
                )}
                <Badge variant={waveStatusTone(target.status)}>{target.status}</Badge>
              </div>
              {held && <HeldTargetLine held={held} />}
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-slate-500">
                {target.category && target.type && (
                  <span>
                    {target.category} · {target.type}
                  </span>
                )}
                {/* Per-wave version: the REAL snapshot reconcile observed from status(), never
                    fabricated. Prefer the deployed image tag/digest (ADR-0008 signal 1) — a better
                    human version than the git SHA — and demote the synced git revision (decision 1)
                    to a secondary detail. When neither is observed yet, keep the explicit
                    placeholder. Rendered for change targets (recognisable by their ADR-0007
                    `type`, which their wire type always carries) and for anything that reports an
                    `observed` snapshot — a wire type with neither makes no version claim, so a
                    campaign target shows no fabricated placeholder. */}
                {(target.observed !== undefined || target.type !== undefined) &&
                  (() => {
                    const image = target.observed?.images?.[0];
                    const revision = target.observed?.revision;
                    if (image) {
                      return (
                        <span title={revision ? `${image}\nrevision ${revision}` : image}>
                          version{" "}
                          <span
                            className="font-mono text-slate-700"
                            data-testid={`${testIdPrefix}-observed-image`}
                          >
                            {imageVersionLabel(image)}
                          </span>
                          {revision && (
                            <span
                              className="ml-1 text-slate-400"
                              data-testid={`${testIdPrefix}-observed-revision`}
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
                            data-testid={`${testIdPrefix}-observed-revision`}
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
                      data-testid={`${testIdPrefix}-observed-rollout`}
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
                {typeof target.attempt === "number" && (
                  <span>
                    attempt {target.attempt}
                    {target.lastObservedAt
                      ? ` · last observed ${formatDate(target.lastObservedAt)}`
                      : ""}
                  </span>
                )}
                {links.executorRef && (
                  <span data-testid={`${testIdPrefix}-executor-link`}>
                    executor:{" "}
                    {links.executorSystemUrl ? (
                      <a
                        href={links.executorSystemUrl}
                        target="_blank"
                        rel="noreferrer"
                        className={cn(
                          "inline-flex items-center gap-1 rounded font-mono text-slate-700 underline hover:text-slate-900",
                          focusRing
                        )}
                        title={`${links.executorRef} on ${links.executorSystemUrl}`}
                      >
                        {links.executorRef} on {hostOf(links.executorSystemUrl)}
                        <ExternalLink className="size-3.5" strokeWidth={2} aria-hidden="true" />
                      </a>
                    ) : (
                      <span className="break-all font-mono text-slate-700">
                        {links.executorRef}
                      </span>
                    )}
                  </span>
                )}
                {links.repoPattern && (
                  <span
                    className="break-all font-mono text-slate-700"
                    data-testid={`${testIdPrefix}-repo-link`}
                  >
                    repo: {links.repoPattern}
                  </span>
                )}
              </div>
              {/* The wave target's real unit of work is an actual Change — link straight to it
                  (DESIGN §9.5: campaign waves fan out into per-target member Changes). */}
              {target.memberChangeObjectId && (
                <p className="mt-1">
                  <Link
                    to="/changes/$id"
                    params={{ id: target.memberChangeObjectId }}
                    className={cn(
                      "inline-flex items-center gap-1 rounded text-slate-600 hover:underline",
                      focusRing
                    )}
                    data-testid={`${testIdPrefix}-target-change-link`}
                  >
                    View Change
                    <ArrowRight className="size-3.5" strokeWidth={2} aria-hidden="true" />
                  </Link>
                </p>
              )}
            </div>
          );
        })}
        {wave.targets.length === 0 && (
          <p className="text-xs text-slate-500">No targets in this wave.</p>
        )}
      </CardContent>
    </Card>
  );
}
