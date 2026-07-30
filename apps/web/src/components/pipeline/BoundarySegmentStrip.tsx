import type { ReactNode } from "react";
import type { BoundarySegment } from "@scp/sdk";
import { Badge } from "../ui/badge";
import { isAbsent } from "../../lib/absent";

/**
 * M16.1 — THE UNIVERSAL BOUNDARY SEGMENT, rendered (ADR-0011; vocabulary fixed by ADR-0021 D6).
 *
 * A boundary SEGMENT composed of two boundary PHASES — *transferred* and *validated*. It is NOT a
 * "stage" (a stage is a deployment PLACE, `<domain>[-<location>]-<env>`) and NOT a "wave" (a wave
 * is the set of stages advanced at once). Purely presentational: the server
 * (`coordination/boundary-segment.ts`) computes every state from real ledger rows and real
 * Decisions; this paints them and drives nothing.
 *
 * ## Why a sibling component rather than widening `PromotionState`
 *
 * `PromotionArrow.tsx`'s own doc comment defines `PromotionState` as the gate/approval state of a
 * promotion **between two consecutive waves**, and says it is "deliberately a small closed set the
 * *existing* model can already answer honestly" — it then refuses a hold/release state on exactly
 * that ground. Adding `unknown` to it would (a) hand every inter-wave arrow, where the model CAN
 * always answer, a way to shrug, and (b) reuse inter-wave promotion vocabulary for a domain-crossing
 * segment that ADR-0021 D6 gives its own words. So `PromotionState` is left untouched and the
 * segment gets its own two-phase vocabulary here.
 *
 * ## The honesty contract (same rule the service board follows)
 *
 * `segment.unknownFields` names, by dotted path, every field this instance CANNOT OBSERVE. Those
 * fields still carry a zero value on the wire for shape stability — but a zero is not an
 * observation, and it must never be painted like one. Concretely: an exporting instance can never
 * see the receiving outpost's validation outcome, so `validate.state` arrives as `not_reported` AND
 * is named unknown; painting that as anything other than an explicit unknown would be a fabricated
 * pass. Pinned by `apps/web/src/routes/change-pipeline-boundary-honesty.test.tsx`.
 */

/** True when the server explicitly told us this field is NOT observable here — as opposed to
 *  observed-and-negative. The two must never render the same way. Mirrors `service-board.tsx`'s
 *  `isUnknown` deliberately: one honesty pattern in this codebase, not two. */
export function isBoundaryUnknown(segment: BoundarySegment, field: string): boolean {
  return segment.unknownFields.includes(field);
}

/** The honest-unknown marker — same visual language as the board's `UnknownHere`: dashed amber,
 *  never a success colour and never the muted dash used for observed-and-empty. */
function UnknownHere({ title, label }: { title: string; label: string }): React.JSX.Element {
  return (
    <span
      className="inline-flex items-center gap-1 rounded border border-dashed border-amber-400 bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-800"
      title={title}
      data-testid="boundary-unknown"
    >
      {label}
    </span>
  );
}

/** One phase card. `verified` is the ONLY thing this component ever paints with the success
 *  variant, and the parent only ever passes it for a real `allow` verdict. */
function PhaseCard({
  testid,
  title,
  state,
  badge,
  detail,
  extra
}: {
  testid: string;
  title: string;
  state: string;
  badge: ReactNode;
  detail?: string;
  extra?: ReactNode;
}): React.JSX.Element {
  return (
    <div
      className="flex min-w-[13rem] flex-col items-center gap-1 rounded border border-slate-200 bg-white px-3 py-2"
      data-testid={testid}
      data-state={state}
    >
      <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        {title}
      </span>
      {badge}
      {detail && (
        <p className="max-w-[16rem] text-center text-[11px] leading-snug text-slate-500" title={detail}>
          {detail}
        </p>
      )}
      {extra}
    </div>
  );
}

/** The connector between the two phases. Deliberately inert slate — the segment's meaning lives in
 *  the two phase cards, and a coloured connector would imply a verdict about the pair. */
function PhaseLink(): React.JSX.Element {
  return <div className="h-px w-8 bg-slate-300 sm:w-12" aria-hidden="true" />;
}

function TransferPhase({ segment }: { segment: BoundarySegment }): React.JSX.Element {
  const { transfer } = segment;
  // R1: `bundle_transfers` is INSERT-only and every submitted/confirmed row is written by a LATER
  // hop's own database, so an exporting instance's row is and stays `created`. The server names
  // `transfer.handoff` unknown in exactly that case; we must show the handoff as unknown, never as
  // a delivery.
  const handoffUnknown = isBoundaryUnknown(segment, "transfer.handoff");
  const hopCount = transfer.hops.length;
  const hopDetail =
    hopCount > 0
      ? `${hopCount} bundle hop${hopCount === 1 ? "" : "s"} observed here`
      : undefined;

  const badge =
    transfer.state === "received" ? (
      <Badge variant="success" data-testid="boundary-transfer-badge">
        received here
      </Badge>
    ) : transfer.state === "exported" ? (
      <Badge variant="info" data-testid="boundary-transfer-badge">
        exported
      </Badge>
    ) : (
      <Badge variant="outline" data-testid="boundary-transfer-badge">
        no transfer observed
      </Badge>
    );

  return (
    <PhaseCard
      testid="boundary-phase-transfer"
      title="Transferred"
      state={transfer.state}
      badge={badge}
      detail={hopDetail}
      extra={
        handoffUnknown ? (
          <UnknownHere
            label="handoff unknown here"
            title={
              "This instance produced the bundle and recorded it as `created`. The transfer ledger " +
              "is insert-only and per-instance: any submitted/confirmed row for a later hop is " +
              "written in that hop's own database, so whether the peer received this bundle is not " +
              "observable from here."
            }
          />
        ) : undefined
      }
    />
  );
}

function ValidatePhase({
  segment,
  why
}: {
  segment: BoundarySegment;
  why?: ReactNode;
}): React.JSX.Element {
  const { validate } = segment;
  // R2: the exporting instance has no data path to the receiving outpost's verdict. When the server
  // says so, this renders an explicit unknown — NOT a neutral-looking "not reported" chip that a
  // tired operator could read as "fine".
  const stateUnknown = isBoundaryUnknown(segment, "validate.state");
  // `isAbsent`, not `!== null`: `authorizedArtifactCount` is required-NULLABLE and the generated SDK
  // validates no response, so a server that omits the key reached this branch with `undefined` and
  // printed the literal `undefined authorized artifacts`. Same class as the federation cells.
  const artifactDetail = isAbsent(validate.authorizedArtifactCount)
    ? undefined
    : `${validate.authorizedArtifactCount} authorized artifact${validate.authorizedArtifactCount === 1 ? "" : "s"}`;

  let badge: ReactNode;
  if (stateUnknown) {
    badge = (
      <UnknownHere
        label="outcome not reported back"
        title={
          "Validation happens at the receiving outpost. No federation journal entry kind carries a " +
          "verification outcome back to the exporting instance, and imported audit segments are " +
          "discarded — so this instance genuinely cannot know the result. It is not a pass."
        }
      />
    );
  } else if (validate.state === "verified") {
    // The ONLY success paint in this component, and it requires a real `allow` Decision recorded by
    // this instance's own pre-deploy artifact verify.
    badge = (
      <Badge variant="success" data-testid="boundary-validate-badge">
        signatures verified
      </Badge>
    );
  } else if (validate.state === "refused") {
    badge = (
      <Badge variant="destructive" data-testid="boundary-validate-badge">
        verification refused
      </Badge>
    );
  } else {
    // `not_yet_verified` — a REAL local observation (we received it; no verdict yet). Deliberately
    // not the amber unknown marker: this instance can see the absence, it is not blind to it.
    badge = (
      <Badge variant="outline" data-testid="boundary-validate-badge">
        not yet verified
      </Badge>
    );
  }

  return (
    <PhaseCard
      testid="boundary-phase-validate"
      title="Validated"
      state={validate.state}
      badge={badge}
      detail={stateUnknown ? undefined : artifactDetail}
      extra={why}
    />
  );
}

/**
 * The always-shown two-phase boundary segment for one change.
 *
 * `data-verified` is the machine-readable summary, and it is "unknown" — never "false" — whenever
 * the server declared `validate.state` unobservable. A bare `data-verified="false"` over a field
 * listed in `unknownFields` would reintroduce in the DOM exactly the confusion the response shape
 * removes on the wire (the same reasoning as `service-board.tsx`'s `data-blocked`).
 */
export function BoundarySegmentStrip({
  segment,
  why
}: {
  segment: BoundarySegment;
  why?: ReactNode;
}): React.JSX.Element {
  const stateUnknown = isBoundaryUnknown(segment, "validate.state");
  return (
    <div
      className="flex flex-wrap items-center justify-center gap-2"
      data-testid="boundary-segment"
      data-verified={stateUnknown ? "unknown" : String(segment.validate.state === "verified")}
      aria-label={`boundary segment: transferred ${segment.transfer.state}, validated ${stateUnknown ? "unknown here" : segment.validate.state}`}
    >
      <TransferPhase segment={segment} />
      <PhaseLink />
      <ValidatePhase segment={segment} why={why} />
    </div>
  );
}

/**
 * What the pipeline shows when `explain` returned `boundarySegment: null` — a change that has not
 * crossed a domain boundary. Stated explicitly rather than rendered as an empty/green segment: the
 * segment is ALWAYS SHOWN, and its absence is itself the honest answer (ADR-0013's domain-local
 * exemption / "domain-local changes have a shorter pipeline").
 */
export function NoBoundarySegment(): React.JSX.Element {
  return (
    <div
      className="flex items-center justify-center rounded border border-dashed border-slate-300 px-3 py-2 text-xs text-slate-500"
      data-testid="boundary-segment-absent"
    >
      No boundary segment — this change has not crossed a domain boundary.
    </div>
  );
}
