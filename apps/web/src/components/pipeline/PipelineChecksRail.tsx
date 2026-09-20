import { cn } from "../../lib/utils";

/** THE PER-TARGET CHECKS RAIL (2026-09-11 mockup `target-redesign.html`'s `.checks` strip;
 *  docs/proposals/pipeline-mockup-data.md §3; design-system.md §1.6/§1.6a).
 *
 *  FOUR FIXED SLOTS, ALWAYS ALL FOUR, ALWAYS IN PIPELINE ORDER — the server sends them that way
 *  and this component never filters, sorts or hides one. Fixed position is the whole point: the
 *  third cell is always the canary, so an unbroken column of dashed thirds reads instantly as
 *  "nothing here is being watched".
 *
 *  THE RULE THIS FILE EXISTS TO KEEP: **not bound** and **bound but silent** must not look alike.
 *  A hook nobody declared is a STRUCTURAL absence — white, dashed, hollow dot, em-dash, tooltip,
 *  and never amber. A probe somebody promised and that has gone quiet is amber, because an
 *  operator should chase it. Painting both amber rebuilds the wall-of-amber design-system §1.5
 *  exists to prevent; painting both grey hides a broken prober. */

/** One hook's state, structurally — `PipelineHookStateSchema`'s members. Widened with an index
 *  signature on purpose: a server NEWER than this bundle can send a member added by a later
 *  increment (the schema is a union precisely so it can), and `chipFor` renders an unrecognised
 *  `state` as an explicit unknown rather than falling through to anything that looks like a pass. */
export type PipelineHookStateLike = { state: string; hookId: string } & Record<string, unknown>;

export interface WaveTargetCheckSlotLike {
  kind: string;
  /** `per_change` | `per_wave` | `per_target` — WHAT THE RECORD IS KEYED BY. Load-bearing copy:
   *  `pipeline_hook_runs` is keyed `(change, hookId, waveIndex)` and not by target, so a post-merge
   *  or post-deploy chip on a target row is a change-level or wave-level fact repeated across the
   *  wave's rows. The tooltip says so; the rail must never read as "this target's post-deploy
   *  test" (proposal §3.4). */
  grain: string;
  /** EMPTY = NOT DECLARED. */
  hooks: PipelineHookStateLike[];
}

/** `WaveTargetCheckEvidenceOriginSchema` (2026-09-20 owner decision) — present only when this
 *  target's declaring component executes at ANOTHER domain instance. Every slot above is built
 *  from tables local to THIS instance, which is correct when this target executes here but is not
 *  a claim this instance can make about a prober it does not run. This marker is what lets the
 *  rail tell "genuinely never reported, anywhere" apart from "reported elsewhere, just not to us
 *  yet" — the honesty case `chipFor` reads below. */
export type WaveTargetCheckEvidenceOriginLike =
  | { state: "fresh"; ageSeconds: number }
  | { state: "stale"; ageSeconds: number; staleAfterSeconds: number }
  | { state: "not_reported" };

export type WaveTargetChecksLike =
  | {
      basis: "resolved";
      slots: WaveTargetCheckSlotLike[];
      evidenceOrigin?: WaveTargetCheckEvidenceOriginLike;
    }
  | { basis: "unresolvable"; reason: string };

/** The rail's own label for a kind. An unrecognised kind falls back to the raw wire word rather
 *  than being dropped — a fifth kind must show up as itself, not vanish. */
const KIND_LABEL: Record<string, string> = {
  postMerge: "post-merge",
  postDeploy: "post-deploy",
  continuous: "continuous",
  bakeAlarms: "bake"
};

/** What "nobody declared this" means, per kind, in words an operator can act on. The continuous
 *  line names the consequence because it is the one absence that leaves a deployed target with
 *  nothing watching it (the mockup's own legend makes the same point). */
const NOT_DECLARED_TITLE: Record<string, string> = {
  postMerge: "No postMerge hook is declared for this component — nothing gates entry to wave 1.",
  postDeploy:
    "No postDeploy hook is declared for this component — nothing gates promotion out of this wave.",
  continuous:
    "No continuous probe is declared for this component — nothing is watching it after deploy.",
  bakeAlarms:
    "No bakeAlarms hook is declared for this component — no quiet window has to pass before this wave may exit."
};

/** THE GRAIN SENTENCE, appended to every chip whose record is not really per-target. Empty for
 *  `per_target`, where the evidence genuinely is keyed by (component, target, hook). */
function grainSentence(grain: string, kindLabel: string): string {
  if (grain === "per_change")
    return `\nThis is the CHANGE's ${kindLabel} run — hook runs are keyed by (change, hook, wave), so every target of this change shows the same record, not one per target.`;
  if (grain === "per_wave")
    return `\nThis is the WAVE's ${kindLabel} run — hook runs are keyed by (change, hook, wave), so every target of this wave shows the same record, not one per target.`;
  return "";
}

/** The five chip tones. `unbound` and `waiting` share a palette and differ only in the strength of
 *  the value text, which is deliberate: the mockup's rule is "same grey, different word — one is
 *  waiting, the other will never happen", so the WORD carries the distinction and the colour does
 *  not pretend to. */
type ChipTone = "pass" | "fail" | "watch" | "run" | "waiting" | "unbound";

const TONE_CHIP: Record<ChipTone, string> = {
  pass: "border-emerald-200 bg-emerald-50",
  fail: "border-red-200 bg-red-50",
  watch: "border-dashed border-amber-300 bg-amber-50",
  run: "border-blue-200 bg-blue-50",
  waiting: "border-dashed border-slate-200 bg-white",
  unbound: "border-dashed border-slate-200 bg-white"
};
const TONE_DOT: Record<ChipTone, string> = {
  pass: "bg-emerald-500",
  fail: "bg-red-500",
  watch: "bg-amber-500",
  run: "bg-blue-500",
  waiting: "border border-dashed border-slate-400 bg-transparent",
  unbound: "border border-dashed border-slate-300 bg-transparent"
};
const TONE_LABEL: Record<ChipTone, string> = {
  pass: "text-emerald-700",
  fail: "text-red-700",
  watch: "text-amber-700",
  run: "text-blue-700",
  waiting: "text-slate-500",
  unbound: "text-slate-400"
};
const TONE_VALUE: Record<ChipTone, string> = {
  pass: "text-emerald-700",
  fail: "text-red-700",
  watch: "text-amber-700",
  run: "text-blue-700",
  waiting: "text-slate-600",
  unbound: "text-slate-300"
};

function str(state: PipelineHookStateLike, key: string): string | undefined {
  const v = state[key];
  return typeof v === "string" ? v : undefined;
}
function num(state: PipelineHookStateLike, key: string): number | undefined {
  const v = state[key];
  return typeof v === "number" ? v : undefined;
}

/** `40` -> "40 s" / `720` -> "12 min" / `10800` -> "3 h". Shared by `formatEvidenceAge` (which
 *  parses a server instant into seconds) and `evidenceOriginCaveat` (which reads a server-computed
 *  `ageSeconds` directly, the same as `observedFreshness`'s own age already does on this card). */
function formatSecondsAsAge(seconds: number): string {
  if (!Number.isFinite(seconds)) return "unknown age";
  if (seconds < 90) return `${seconds} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} h`;
}

/** `2026-09-19T…` -> "40 s" / "12 min" / "3 h". The client's own clock contextualizes a
 *  server-stated instant; `now` never crosses the API seam (the same rule `hold`'s `staleAfter`
 *  follows). */
export function formatEvidenceAge(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return formatSecondsAsAge(seconds);
}

function formatWindow(seconds: number): string {
  if (seconds < 90) return `${seconds} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} m`;
  return `${Math.round(seconds / 3600)} h`;
}

interface Chip {
  tone: ChipTone;
  value: string;
  title: string;
}

/** THE STATES WHOSE COPY OTHERWISE ASSERTS A FACT ABOUT A PROBER, OR ABOUT PIPELINE/DEPLOY
 *  PROGRESS, THIS INSTANCE CANNOT VOUCH FOR when the target executes at another domain — "nobody
 *  is looking", "nothing has reached it yet", "check that a source is wired up". A `passed` /
 *  `failed` / `running` / `quiet` / `alarm_firing` state is a real reading that arrived by SOME
 *  path (continuous/bake evidence already federates via the older `pipeline_evidence_upsert`
 *  journal) and needs no caveat; these six are the ones an absence can misrepresent as a broken
 *  LOCAL prober rather than an evidence path this instance simply is not on (owner decision
 *  2026-09-20: soften the copy, not add an eighth `PipelineHookStateSchema` member). */
const PROBER_ASSERTION_STATES = new Set([
  "not_run",
  "no_evidence",
  "stale",
  "no_source",
  "window_not_covered",
  "bake_not_started"
]);

/** The honest replacement for the "check the prober" / "nothing has happened" clause, once this
 *  target is known to execute at another domain (`WaveTargetCheckEvidenceOriginLike`). Mirrors
 *  `observedFreshness`'s own vocabulary and the rollout badge's established phrase (this file's
 *  sibling, `PipelineWaveCard.tsx`'s "rolling out elsewhere — not reported to this commander"),
 *  rather than inventing new words for the same fact. */
function evidenceOriginCaveat(origin: WaveTargetCheckEvidenceOriginLike): string {
  if (origin.state === "not_reported") {
    return "This target executes at another domain instance, and nothing has been reported to this commander for it yet — not reported to this commander, not a silent or failed prober.";
  }
  const age = formatSecondsAsAge(origin.ageSeconds);
  const staleSuffix =
    origin.state === "stale"
      ? ` (older than its ${formatWindow(origin.staleAfterSeconds)} freshness bound)`
      : "";
  return `This target executes at another domain instance, which last reported hook activity ${age} ago${staleSuffix} — this slot's own record may not yet reflect it.`;
}

/** ONE HOOK STATE -> ONE CHIP. Every branch is a distinct (tone, word) pair; no two of the six
 *  absences in the schema's doc share both. `evidenceOrigin` is `WaveTargetChecksLike`'s own
 *  target-level marker, present only for a target driven at another domain — see
 *  `PROBER_ASSERTION_STATES` for which branches read it. */
function chipFor(
  state: PipelineHookStateLike,
  kind: string,
  kindLabel: string,
  evidenceOrigin?: WaveTargetCheckEvidenceOriginLike
): Chip {
  const who = `${kindLabel} hook '${state.hookId}'`;
  const caveat =
    evidenceOrigin && PROBER_ASSERTION_STATES.has(state.state)
      ? evidenceOriginCaveat(evidenceOrigin)
      : undefined;
  switch (state.state) {
    case "not_applicable":
      return {
        tone: "unbound",
        value: "n/a",
        // Server-composed reason, rendered verbatim (charter principle 6).
        title: `${who} cannot apply to this target: ${str(state, "reason") ?? "no reason recorded"}`
      };
    case "not_run":
      // DECLARED AND WAITING. The word differs from the em-dash of an undeclared slot precisely
      // because one is waiting and the other will never happen. Elsewhere-driven: "nothing has
      // reached it yet" is a claim about a pipeline this instance does not run — `caveat` replaces
      // it rather than riding alongside it.
      return {
        tone: "waiting",
        value: "not run",
        title: caveat
          ? `${who} is declared. ${caveat}`
          : `${who} is declared and has not run — nothing has reached it yet. This is not "no such check": something promised it.`
      };
    case "running": {
      const runStatus = str(state, "runStatus");
      return {
        tone: "run",
        // `pending` (SCP dispatched it, the executor has not started it) and `running` (it has) are
        // one state and two words — the recorded word travels rather than being flattened.
        value: runStatus === "pending" ? "dispatched" : "running",
        title: `${who} is in flight (recorded status '${runStatus ?? "unknown"}'), dispatched ${str(state, "startedAt") ?? "at an unrecorded time"}.`
      };
    }
    case "passed": {
      const concludedAt = str(state, "concludedAt");
      // The canary's value is its EVIDENCE AGE (the mockup's "40 s") — but the word "pass" travels
      // with it, because colour must never be the only signal (§1.6a's status-word rule).
      const age =
        kind === "continuous" && concludedAt ? ` · ${formatEvidenceAge(concludedAt)}` : "";
      return {
        tone: "pass",
        value: `pass${age}`,
        title: concludedAt
          ? `${who} passed — concluded ${new Date(concludedAt).toLocaleString()}.`
          : `${who} passed. No conclusion instant was recorded for it.`
      };
    }
    case "failed": {
      const runStatus = str(state, "runStatus");
      const concludedAt = str(state, "concludedAt");
      return {
        tone: "fail",
        // ABORTED IS NOT "FAILED". Same colour (it did not pass), its own word, because a run a
        // human cancelled is a different thing to go and look at.
        value: runStatus === "aborted" ? "aborted" : "failed",
        title:
          `${who} did not pass${runStatus ? ` (recorded status '${runStatus}')` : ""}` +
          (concludedAt ? ` — concluded ${new Date(concludedAt).toLocaleString()}.` : ".") +
          (kind === "continuous"
            ? " The probe RAN and reported failure — that is a claim about the target, not about the prober."
            : "")
      };
    }
    case "no_evidence": {
      const maxAge = num(state, "maxAgeSeconds");
      // BOUND, AND NEVER HEARD FROM. Amber, because somebody promised this check. Never the grey
      // em-dash of an undeclared slot.
      return {
        tone: "watch",
        value: "no evidence",
        title: `${who} is declared and has NEVER reported for this target${maxAge === undefined ? "" : ` (it must report at least every ${formatWindow(maxAge)})`}. ${caveat ?? "Nobody is looking — check the prober, not the target."}`
      };
    }
    case "stale": {
      const newest = str(state, "newestEvidenceAt");
      const maxAge = num(state, "maxAgeSeconds");
      // BOUND, REPORTED, THEN WENT QUIET. A different place to look than `no_evidence`, so a
      // different word — and evidence past `maxAgeSeconds` is ABSENT, never a stale pass.
      return {
        tone: "watch",
        value: newest ? `stale · ${formatEvidenceAge(newest)}` : "stale",
        title:
          `${who} last reported ${newest ? new Date(newest).toLocaleString() : "at an unrecorded time"}, which is older than its ${maxAge === undefined ? "declared" : formatWindow(maxAge)} freshness bound. ` +
          (caveat ??
            "Evidence that old is ABSENT, not a pass and not a fail — nobody is looking; check the prober.")
      };
    }
    case "bake_not_started": {
      const window = num(state, "quietWindowSeconds");
      // DECLARED, AND THE WINDOW HAS NOT OPENED. Grey-dashed like an undeclared slot and worded
      // differently, the same "one is waiting, the other will never happen" split.
      return {
        tone: "waiting",
        value: window === undefined ? "not started" : `${formatWindow(window)} — not started`,
        title: caveat
          ? `${who} is declared, and its quiet window has not opened. ${caveat}`
          : `${who} is declared, and its quiet window has not opened: the window starts when this target deploys, and this target has not deployed. Not a pass, and not an undeclared check.`
      };
    }
    case "baking": {
      const endsAt = str(state, "windowEndsAt");
      return {
        tone: "run",
        value: "baking",
        title: `${who}'s quiet window is open and no alarm has fired in it yet${endsAt ? `; it closes ${new Date(endsAt).toLocaleString()}` : ""}. Nothing is established until it closes.`
      };
    }
    case "quiet": {
      const coveredBy = Array.isArray(state.coveredBy)
        ? (state.coveredBy as unknown[]).filter((s): s is string => typeof s === "string")
        : [];
      return {
        tone: "pass",
        value: "clear",
        title:
          `${who}'s quiet window was fully covered with no alarm firing` +
          (coveredBy.length > 0 ? ` (covered by: ${coveredBy.join(", ")}).` : ".")
      };
    }
    case "alarm_firing": {
      const since = str(state, "since");
      return {
        tone: "fail",
        value: "alarm",
        title: `${who}: an alarm fired inside the quiet window${since ? `, first at ${new Date(since).toLocaleString()}` : ""}. The gate is fail-safe on a firing alarm from any source.`
      };
    }
    case "window_not_covered": {
      const endsAt = str(state, "windowEndsAt");
      return {
        tone: "watch",
        value: "window gap",
        title: `${who}'s quiet window${endsAt ? ` (closed ${new Date(endsAt).toLocaleString()})` : ""} elapsed with reports that leave a GAP. ${caveat ?? "Something is reporting and stopped — this is not a pass."}`
      };
    }
    case "no_source":
      return {
        tone: "watch",
        value: "no source",
        title: `${who} is declared and NOTHING reported alarm state for its window at all. ${caveat ?? "A declared bake gate with no evidence source — check that an alarm source is wired up."}`
      };
    default:
      // A STATE THIS BUNDLE DOES NOT KNOW — a server from a later increment. Say so; never fall
      // through to a tone that reads like a verdict.
      return {
        tone: "watch",
        value: String(state.state),
        title: `${who} reported the state '${String(state.state)}', which this version of the UI does not know how to interpret. It is NOT a pass and NOT a failure — upgrade the UI to read it.`
      };
  }
}

function ChecksChip({
  kindLabel,
  chip,
  state,
  kind,
  testIdPrefix
}: {
  kindLabel: string;
  chip: Chip;
  state: string;
  kind: string;
  testIdPrefix: string;
}): React.JSX.Element {
  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-[3px]",
        TONE_CHIP[chip.tone]
      )}
      title={chip.title}
      data-testid={`${testIdPrefix}-check-chip`}
      data-kind={kind}
      data-state={state}
      data-tone={chip.tone}
    >
      <i
        className={cn("size-[7px] shrink-0 rounded-full", TONE_DOT[chip.tone])}
        aria-hidden="true"
      />
      <span className={cn("truncate text-[10.5px]", TONE_LABEL[chip.tone])}>{kindLabel}</span>
      <span
        className={cn("ml-auto whitespace-nowrap text-[10px] font-semibold", TONE_VALUE[chip.tone])}
      >
        {chip.value}
      </span>
    </span>
  );
}

export function PipelineChecksRail({
  checks,
  testIdPrefix
}: {
  checks: WaveTargetChecksLike;
  testIdPrefix: string;
}): React.JSX.Element {
  if (checks.basis === "unresolvable") {
    // NOT "nothing is declared" — this instance could not work out WHAT is declared. Amber-dashed,
    // with the server's own sentence, because an operator should notice it.
    return (
      <div
        className="mt-2 rounded-md border border-dashed border-amber-300 bg-amber-50 px-2 py-1 text-[11px] leading-snug text-amber-700"
        data-testid={`${testIdPrefix}-checks-unresolvable`}
        title="The checks rail could not be computed for this target. This is NOT a statement that no check is declared."
      >
        checks unknown — {checks.reason}
      </div>
    );
  }

  return (
    // 2x2 at card width (mockup `.checks`: `repeat(2, minmax(0,1fr))`, 6px gap, dashed top rule).
    <div
      className="mt-2 grid grid-cols-2 gap-1.5 border-t border-dashed border-slate-200 pt-2"
      data-testid={`${testIdPrefix}-checks-rail`}
      data-evidence-origin={checks.evidenceOrigin?.state}
    >
      {checks.slots.map((slot) => {
        const kindLabel = KIND_LABEL[slot.kind] ?? slot.kind;
        return (
          <div
            key={slot.kind}
            className="flex min-w-0 flex-col gap-1"
            data-testid={`${testIdPrefix}-check-slot`}
            data-kind={slot.kind}
            data-declared={slot.hooks.length > 0 ? "true" : "false"}
          >
            {slot.hooks.length === 0 ? (
              // NOT BOUND. Structural absence: white, dashed, hollow dot, em-dash, tooltip, and
              // NEVER amber — nobody promised this check (design-system §1.6a's quiet-absence rule,
              // and the mockup legend's "two absences that must not look alike").
              <span
                className={cn(
                  "flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-[3px]",
                  TONE_CHIP.unbound
                )}
                title={
                  NOT_DECLARED_TITLE[slot.kind] ??
                  `No ${slot.kind} hook is declared for this component.`
                }
                data-testid={`${testIdPrefix}-check-chip`}
                data-kind={slot.kind}
                data-state="not_declared"
                data-tone="unbound"
              >
                <i
                  className={cn("size-[7px] shrink-0 rounded-full", TONE_DOT.unbound)}
                  aria-hidden="true"
                />
                <span className={cn("truncate text-[10.5px]", TONE_LABEL.unbound)}>
                  {kindLabel}
                </span>
                <span
                  className={cn(
                    "ml-auto whitespace-nowrap text-[10px] font-semibold",
                    TONE_VALUE.unbound
                  )}
                >
                  &mdash;
                </span>
              </span>
            ) : (
              slot.hooks.map((hookState) => {
                const chip = chipFor(hookState, slot.kind, kindLabel, checks.evidenceOrigin);
                return (
                  <ChecksChip
                    key={hookState.hookId}
                    kind={slot.kind}
                    kindLabel={kindLabel}
                    state={hookState.state}
                    chip={{
                      ...chip,
                      // The grain disclaimer rides on every chip whose record is not per-target.
                      title: chip.title + grainSentence(slot.grain, kindLabel)
                    }}
                    testIdPrefix={testIdPrefix}
                  />
                );
              })
            )}
          </div>
        );
      })}
    </div>
  );
}
