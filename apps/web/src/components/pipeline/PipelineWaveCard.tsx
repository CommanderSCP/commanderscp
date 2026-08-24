import { Link } from "@tanstack/react-router";
import { ArrowRight, ExternalLink, TriangleAlert } from "lucide-react";
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

/**
 * ONE FIELD'S ENTRY IN `observed.truncation` — mirrors `PersistedJsonFieldTruncation`
 * (`packages/runner-launcher/src/index.ts`) as surfaced through `ChangeWaveTargetSchema`
 * (`packages/schemas/src/changes.ts:346` on #264). `dropped: true` means the field is not in the
 * stored value AT ALL, and that is the persistence bound's doing, not the executor's silence —
 * the whole reason this module cannot keep treating "absent" and "cut" as the same pixels
 * (docs/proposals/observed-truncation-ui.md, charter principle 6).
 */
export interface ObservedTruncationEntry {
  dropped: boolean;
  droppedCharacters?: number;
  droppedEntries?: number;
  droppedFields?: number;
}

/** One covering freeze on a wave target's `hold.freezes` (`ChangeWaveTargetSchema.hold` —
 *  packages/schemas/src/changes.ts, campaigns-rework.md's "wave-target hold projection"). Every
 *  field is exactly as the server composed it — `summary` is a rendered-verbatim sentence
 *  (charter principle 6: this module composes no copy from raw fields), `scope` is already
 *  enriched to `{objectId, name}` (`null` for a platform-tier freeze), and `endsAt` is the
 *  window's real boundary, never `now`. */
export interface WaveTargetFreezeEntry {
  freezeId: string;
  scope: { objectId: string; name: string | null } | null;
  summary: string;
  endsAt: string;
}

/** A wave target, structurally — the intersection-with-options of ChangeWaveTarget and
 *  CampaignWaveTarget. */
export interface PipelineWaveTargetLike {
  id: string;
  targetObjectId: string;
  targetUrn?: string | undefined;
  targetName?: string | undefined;
  /** The FREEZE-HOLD half of `ChangeWaveTargetSchema.hold` — present only while the target is
   *  genuinely held by an active freeze, composed at read time (a lifted freeze is simply absent
   *  on the next read). CampaignWaveTarget does not carry this yet, so it is optional and a
   *  campaign wave simply renders no freeze line — never a fabricated one. The STAGE-DEPENDENCY
   *  half of a hold rides a SEPARATE channel (`holdFor` below) for the reason that field's own
   *  doc states: it is not part of this schema. */
  hold?: { freezes: WaveTargetFreezeEntry[] } | undefined;
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
    /** WHAT THE PERSISTENCE BOUND REMOVED, KEYED BY ROOT FIELD (M23.1g, ChangeWaveTargetSchema —
     *  packages/schemas/src/changes.ts:346 on #264). Additive-optional: absent means "nothing was
     *  cut" — the only honest reading for a pre-M23.1g row, which cannot be backfilled because the
     *  content itself is gone. See `truncationOf` below for the one place this is read. */
    truncation?: Record<string, ObservedTruncationEntry> | undefined;
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
  /** SERVER-COMPUTED (`ChangeWaveSchema.heldTargetCount`) — freeze-held plus stage-dependency-held
   *  targets of this wave. NEVER RECOMPUTED HERE: a client tally from `targets[].hold` alone would
   *  undercount by exactly the stage-dependency half, which this component has no way to see
   *  unless the page also threads `holdFor` — this field is the server's answer regardless of
   *  which optional props a given page passes. CampaignWave does not carry it yet, so it is
   *  optional and the chip simply does not render for a campaign wave. */
  heldTargetCount?: number | undefined;
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

type ObservedLike = PipelineWaveTargetLike["observed"];

/**
 * THE ONE HELPER EVERY `observed.truncation` READ GOES THROUGH (proposal §3 rule 4,
 * docs/proposals/observed-truncation-ui.md) — a future read site that calls this instead of
 * indexing `target.observed?.truncation` directly inherits the honesty rule for free, rather than
 * having a chance to re-introduce the "cut looks like absent" lie. Returns the RAW entry
 * (`dropped` may be `false`, e.g. a tail-cut array whose field survived) — callers decide what a
 * `dropped: true` versus a merely-shortened field means for their own slot; see `droppedEntry`
 * below for the common "was this field's own presence removed" case.
 */
function truncationOf(observed: ObservedLike, field: string): ObservedTruncationEntry | undefined {
  return observed?.truncation?.[field];
}

/** `truncationOf`, narrowed to "the field itself is not in the stored value at all" — the bit that
 *  actually separates a platform cut from executor silence (see `ObservedTruncationEntry`). */
function droppedEntry(observed: ObservedLike, field: string): ObservedTruncationEntry | undefined {
  const entry = truncationOf(observed, field);
  return entry?.dropped === true ? entry : undefined;
}

/**
 * THE REAL, EXECUTOR-REPORTED PREFIX OF `images` — strips the store's marker slot when a cut
 * happened, using the record's `droppedEntries` COUNT and the array's own length, never the
 * marker's own text. The proposal is explicit that a consumer must not pattern-match the stored
 * value (§1: "a cut array's last element is a literal elision-marker string that must never be
 * pattern-matched OR rendered") — the marker is content-shaped and a plugin can legally put those
 * exact characters in a real image ref. When a cut removed every real entry, the stored array is
 * the marker ALONE (`entriesElisionMarker`, `@scp/runner-launcher`) with `dropped` still `false`
 * (the field itself survived); this returns `[]` for that case too, so index 0 is only ever a real
 * entry, structurally guaranteed rather than sniffed.
 */
function realImages(observed: ObservedLike): string[] {
  const images = observed?.images;
  if (!images) return [];
  const entry = truncationOf(observed, "images");
  if (typeof entry?.droppedEntries !== "number" || entry.droppedEntries <= 0) return images;
  return images.slice(0, -1);
}

function droppedCountsSuffix(entry: ObservedTruncationEntry): string {
  const parts: string[] = [];
  if (typeof entry.droppedFields === "number") {
    parts.push(`${entry.droppedFields} field${entry.droppedFields === 1 ? "" : "s"}`);
  }
  if (typeof entry.droppedCharacters === "number") {
    parts.push(`${entry.droppedCharacters} char${entry.droppedCharacters === 1 ? "" : "s"}`);
  }
  if (typeof entry.droppedEntries === "number") {
    parts.push(`${entry.droppedEntries} entr${entry.droppedEntries === 1 ? "y" : "ies"}`);
  }
  return parts.length > 0 ? ` (${parts.join(" / ")} removed)` : "";
}

/** The honesty-pill tooltip sentence (proposal §3 rules 1/2): what was cut, counted from the
 *  record when it says, and the wrong cause it heads off — an operator must not read a
 *  platform-side cut as "the executor never reported this". */
function elisionSentence(report: string, notClaim: string, entry: ObservedTruncationEntry): string {
  return `The executor's ${report} exceeded the stored bound and was elided${droppedCountsSuffix(entry)}. This is not "${notClaim}".`;
}

const WHOLE_STATE_FALLBACK_SENTENCE =
  'The executor\'s status report exceeded the stored bound and could not be preserved. This is not "not observed yet".';

/** Rung 1's diagnostic sentence (proposal §1, measured against #264: `boundPersistedJson`'s
 *  fallback ladder is `{__scpElided: "<sentence>"}` -> `{__scpElided: true}` -> `null`, so this
 *  value is `string | true`). NOT part of the declared SDK shape — `ChangeWaveTargetSchema.observed`
 *  names only revision/images/rollout/truncation, so this reads the wire object loosely and on
 *  purpose. COPY ONLY: never the guard for the pill (that is §3 rule 5's `truncation`-only key),
 *  because `true` and "absent" both mean "no extra sentence available", not "not truncated". */
function wholeStateDiagnostic(observed: ObservedLike): string | undefined {
  const elided = (observed as Record<string, unknown> | null | undefined)?.__scpElided;
  return typeof elided === "string" ? elided : undefined;
}

/** The observed rollout's renderable parts (phase / step N / weight%), shared by the version
 *  slot's whole-state check and the rollout slot's own render so the two can never disagree about
 *  whether "the executor reported a rollout" is true. */
function rolloutParts(rollout: NonNullable<ObservedLike>["rollout"]): string[] {
  if (!rollout) return [];
  const parts: string[] = [];
  if (rollout.phase) parts.push(rollout.phase);
  if (typeof rollout.step === "number") parts.push(`step ${rollout.step}`);
  if (typeof rollout.weight === "number") parts.push(`weight ${rollout.weight}%`);
  return parts;
}

/** THE honesty pill (design spec: amber-dashed `Badge unknown`) — proposal §3's rule, restated:
 *  it appears exactly where a rendered claim would otherwise be false. Never for a cut that left
 *  the shown value still true (that goes in a tooltip line instead, rule 3). */
function TruncatedBadge({
  label,
  title,
  testId
}: {
  label: string;
  title: string;
  testId: string;
}): React.JSX.Element {
  return (
    <Badge variant="unknown" title={title} data-testid={testId}>
      {label}
    </Badge>
  );
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

/**
 * THE FREEZE HALF OF A TARGET'S HOLD (`ChangeWaveTargetSchema.hold`) — one line per covering
 * freeze, mirroring `HeldTargetLine` above (ADR-0028's stage-dependency line) so a target held by
 * BOTH kinds at once renders two lines under the one `held` badge rather than one kind winning.
 * Amber, not blue: a freeze is a governance instrument (design spec §1.5 `warning` tone —
 * "needs attention, degraded, frozen"), where the stage-dependency line's blue is informational
 * ("this clears itself"). `summary` is rendered VERBATIM — server-composed, no client copy.
 *
 * THE BOLD LABEL ONLY APPEARS WHEN THERE IS A REAL NAME TO SHOW (M25.UI review minor finding 2).
 * `scope: null` means PLATFORM tier (`plan-service.ts`'s `toWaveTargetHold`), not "every org on
 * this instance" — a platform freeze addresses a stage coordinate (environment/region), which can
 * be as narrow as one region, and that wire shape carries no `match` to say which. Composing
 * "instance-wide" here claimed a scope the freeze may not have; `freeze.summary` already states
 * the tier and the coordinate it matched verbatim ("… (platform tier) …"), so a `scope: null` or
 * unresolved-name freeze renders that sentence ALONE rather than a client-invented label beside it.
 */
function FreezeHoldLines({ freezes }: { freezes: WaveTargetFreezeEntry[] }): React.JSX.Element {
  return (
    <div
      className="mt-1 border-l-2 border-amber-300 pl-2 text-[11px] leading-snug text-amber-800"
      data-testid="pipeline-wave-target-freeze-hold"
    >
      {freezes.map((freeze) => (
        // `endsAt` is on the wire precisely so the CLIENT's clock can contextualize it (the
        // schema's stated reason for carrying it; the server summary states the same instant in
        // raw UTC). A title tooltip keeps the verbatim-summary rule: no client-composed prose in
        // the rendered line itself, local time on hover (§ structural conventions — title is the
        // honesty channel tests can see).
        <div
          key={freeze.freezeId}
          data-testid="pipeline-wave-target-freeze-hold-line"
          title={`freeze window ends ${new Date(freeze.endsAt).toLocaleString()}`}
        >
          {freeze.scope?.name ? (
            <>
              <span className="font-medium">{freeze.scope.name}</span>{" "}
              <span>— {freeze.summary}</span>
            </>
          ) : (
            <span>{freeze.summary}</span>
          )}
        </div>
      ))}
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
          <div className="flex items-center gap-1.5">
            {/* SERVER-COMPUTED (`ChangeWaveSchema.heldTargetCount`), never derived from `wave.
                targets` here — a page without `holdFor` threaded would undercount the
                stage-dependency half if this were a client tally. Amber `warning` tone (design
                spec §1.5 — "needs attention, degraded, frozen"), never red: a hold is not a
                failure, it is governance withholding a trigger that will still fire. */}
            {typeof wave.heldTargetCount === "number" && wave.heldTargetCount > 0 && (
              <Badge
                variant="warning"
                icon={TriangleAlert}
                data-testid={`${testIdPrefix}-held-count-badge`}
                title={`${wave.heldTargetCount} of this wave's targets ${wave.heldTargetCount === 1 ? "is" : "are"} withheld — by an active freeze, a stage dependency, or both. See each target's own hold line for which.`}
              >
                {wave.heldTargetCount} held
              </Badge>
            )}
            <Badge
              variant={waveStatusTone(wave.status)}
              data-testid={`${testIdPrefix}-status-badge`}
            >
              {wave.status}
            </Badge>
          </div>
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
          // The FREEZE half of a hold, read straight off the target — no closure prop needed,
          // because `ChangeWaveTargetSchema.hold` rides the target itself rather than a side
          // channel (unlike the stage-dependency half above). A target can carry BOTH kinds at
          // once; `anyHeld` is the union that drives the shared badge/border, and each kind gets
          // its own line below rather than one silently winning.
          const freezeHold =
            target.hold && target.hold.freezes.length > 0 ? target.hold.freezes : null;
          const anyHeld = held !== null || freezeHold !== null;
          // Computed ONCE per target and shared by both observed slots below, so "did the executor
          // report a rollout" and "did the whole state get elided" can never disagree between the
          // version slot and the rollout slot (proposal §3 rule 5: one pill covers both when the
          // whole reading is gone; two independently-derived answers could let that promise drift).
          const realImage = realImages(target.observed)[0];
          const imagesEntry = truncationOf(target.observed, "images");
          // "Lost" is broader than `dropped === true`: a tail cut that removed every surviving
          // entry leaves the field present as the store's marker alone (`realImages` above already
          // strips it), which is the same operator-facing fact — no real image survived — even
          // though the field itself was not removed.
          const imagesFullyLost =
            imagesEntry !== undefined && realImages(target.observed).length === 0;
          const revision = target.observed?.revision;
          const rolloutContentParts = rolloutParts(target.observed?.rollout);
          const rolloutDropped = droppedEntry(target.observed, "rollout") !== undefined;
          const versionEmpty = !realImage && !revision;
          const wholeStateElided =
            versionEmpty && rolloutContentParts.length === 0 && imagesFullyLost && rolloutDropped;
          return (
            <div
              key={target.id}
              className="rounded border border-slate-200 p-2 text-xs"
              data-testid={`${testIdPrefix}-target-row`}
              data-held={anyHeld ? "true" : undefined}
            >
              <div className="flex min-w-0 items-center justify-between gap-2">
                <TargetName target={target} nameOf={nameOf} />
                {/* BOTH, not one instead of the other (ADR-0028 increment 4, extended to the
                    freeze half). `held` is the headline; the raw status stays beside it because
                    `pending` is a real recorded value and substituting it would be a second kind
                    of lie. */}
                {anyHeld && (
                  <Badge variant="info" data-testid="pipeline-wave-target-held-badge">
                    held
                  </Badge>
                )}
                <Badge variant={waveStatusTone(target.status)}>{target.status}</Badge>
              </div>
              {held && <HeldTargetLine held={held} />}
              {freezeHold && <FreezeHoldLines freezes={freezeHold} />}
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
                    // RULE 5 (whole-state elision) — nothing renderable survives in EITHER slot and
                    // the record explains both absences at once; ONE pill, not the generic
                    // placeholder and not a second "rollout truncated" pill (the rollout slot below
                    // stays silent in exactly this case).
                    if (wholeStateElided) {
                      return (
                        <TruncatedBadge
                          label="observed state truncated"
                          title={
                            wholeStateDiagnostic(target.observed) ?? WHOLE_STATE_FALLBACK_SENTENCE
                          }
                          testId={`${testIdPrefix}-observed-elided`}
                        />
                      );
                    }
                    // RULE 2 — the version slot's own content is gone because the persistence
                    // bound cut it, not because the executor never reported it; the generic
                    // "not observed yet" placeholder would state a false cause.
                    if (versionEmpty && imagesFullyLost) {
                      return (
                        <TruncatedBadge
                          label="version truncated"
                          title={elisionSentence("image list", "not observed yet", imagesEntry!)}
                          testId={`${testIdPrefix}-observed-version-truncated`}
                        />
                      );
                    }
                    if (realImage) {
                      // RULE 3 — the rendered value is a real PREFIX of what the executor sent, so
                      // the claim shown stays true: no pill, only a tooltip line about the tail.
                      const tailCutLine =
                        typeof imagesEntry?.droppedEntries === "number"
                          ? `\nimage list truncated — ${imagesEntry.droppedEntries} more entr${
                              imagesEntry.droppedEntries === 1 ? "y" : "ies"
                            } removed`
                          : "";
                      return (
                        <span
                          title={
                            (revision ? `${realImage}\nrevision ${revision}` : realImage) +
                            tailCutLine
                          }
                        >
                          version{" "}
                          <span
                            className="font-mono text-slate-700"
                            data-testid={`${testIdPrefix}-observed-image`}
                          >
                            {imageVersionLabel(realImage)}
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
                      // RULE 6 (deliberate asymmetry, proposal §1) — `revision` carries no
                      // truncation signal by design (its reader is the plugin, not an operator);
                      // it renders as-is even when it was itself bounded/shortened.
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
                    // RULE 6 — absent with no truncation key at all: exactly today's rendering.
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
                  if (rolloutContentParts.length > 0) {
                    const rollout = target.observed!.rollout!;
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
                        rollout {rolloutContentParts.join(" · ")}
                      </span>
                    );
                  }
                  // RULE 5's other half — the version slot already rendered the single whole-state
                  // pill; a second one here would repeat the same fact under a different label.
                  if (wholeStateElided) return null;
                  // RULE 1 — the executor's rollout report is why this slot is empty, not silence:
                  // `dropped: true` renders as nothing today, which is the exact truncated-as-absent
                  // lie the version slot's placeholder used to tell (charter principle 6).
                  if (rolloutDropped) {
                    return (
                      <TruncatedBadge
                        label="rollout truncated"
                        title={elisionSentence(
                          "rollout report",
                          "no rollout observed",
                          truncationOf(target.observed, "rollout")!
                        )}
                        testId={`${testIdPrefix}-observed-rollout-truncated`}
                      />
                    );
                  }
                  // RULE 6 — no rollout and no truncation key: exactly today's rendering (omitted).
                  return null;
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
