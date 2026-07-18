import type { ChangeWave, ChangeWaveTarget } from "@scp/sdk";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Badge } from "../ui/badge";
import { formatDate, waveStatusVariant } from "../../routes/change-detail";

/**
 * The real-data source/executor links for one wave target (coordination-ui-views.md Layer A "stage
 * source/executor links"). Every field is optional because it comes from a *separate* lookup that
 * may legitimately be absent:
 *   executorRef       — the binding's `externalRef` (e.g. the Argo CD Application name). NB this is
 *                       sourced from the executor BINDING, never the wave-target's `executorRef`
 *                       (that is a run ref, null until the target triggers — grounding caveat).
 *   executorSystemUrl — the registered `execution-system` object's `serverUrl` (deep-link base).
 *   repoPattern       — the source-mapping `repoPattern` (the git source/config repo).
 */
export interface StageTargetLinks {
  executorRef?: string | undefined;
  executorSystemUrl?: string | undefined;
  repoPattern?: string | undefined;
}

/** `border-t-transparent`-style highlight for the whole stage, mirroring waveCardClass semantics. */
function stageBorderClass(status: string): string {
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
 * A short, human-facing label for a deployed image ref (ADR-0008 signal 1) — the per-stage version.
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
 * One pipeline stage = one compiled wave, rendered top-to-bottom (coordination-ui-views.md view 2,
 * Layer A). Shows the stage's status, its Category/Type pipeline-kind badges, and per-target rows
 * with their status, per-stage version (the observed deployed image tag/digest, revision as
 * secondary detail — ADR-0008 signal 1), and source/executor links. The version is the REAL snapshot
 * reconcile observed from status(); when nothing is observed yet it renders an explicit "—"
 * placeholder, never invented.
 */
export function StageCard({
  wave,
  stageNumber,
  linksFor
}: {
  wave: ChangeWave;
  stageNumber: number;
  linksFor: (target: ChangeWaveTarget) => StageTargetLinks;
}): React.JSX.Element {
  const kinds = pipelineKinds(wave);
  return (
    <Card
      className={`w-full max-w-2xl ${stageBorderClass(wave.status)}`}
      data-testid="stage-card"
      data-stage={stageNumber}
    >
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">
            Stage {stageNumber}
            {wave.name ? `: ${wave.name}` : ` — Wave ${wave.waveIndex}`}
          </CardTitle>
          <Badge variant={waveStatusVariant(wave.status)} data-testid="stage-status-badge">
            {wave.status}
          </Badge>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {kinds.map((k) => (
            <Badge key={`${k.category}::${k.type}`} variant="secondary" data-testid="stage-kind-badge">
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
          return (
            <div
              key={target.id}
              className="rounded border border-slate-200 p-2 text-xs"
              data-testid="stage-target-row"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-slate-900">
                  {target.targetName ?? target.targetUrn ?? target.targetObjectId}
                </span>
                <Badge variant={waveStatusVariant(target.status)}>{target.status}</Badge>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-slate-500">
                <span>{target.category} · {target.type}</span>
                {/* Per-stage version: the REAL snapshot reconcile observed from status(), never
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
                          data-testid="stage-observed-image"
                        >
                          {imageVersionLabel(image)}
                        </span>
                        {revision && (
                          <span
                            className="ml-1 text-slate-400"
                            data-testid="stage-observed-revision"
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
                          data-testid="stage-observed-revision"
                        >
                          {revision.slice(0, 7)}
                        </span>
                      </span>
                    );
                  }
                  return (
                    <span title="per-stage version/digest not observed yet">
                      version <span className="text-slate-400">—</span>
                    </span>
                  );
                })()}
                {links.executorRef && (
                  <span data-testid="stage-executor-link">
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
                  <span className="font-mono text-slate-700" data-testid="stage-repo-link">
                    repo: {links.repoPattern}
                  </span>
                )}
              </div>
            </div>
          );
        })}
        {wave.targets.length === 0 && <p className="text-slate-500">No targets in this stage.</p>}
      </CardContent>
    </Card>
  );
}
