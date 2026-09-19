import { describe, expect, it } from "vitest";
import { OBSERVED_WEIGHT_FRESHNESS_MS } from "../coordination/stage-dependency-hold.js";
import { isForwardHookRunTransition } from "../coordination/pipeline-hook-runs.js";
import {
  PEER_OBSERVATION_FRESHNESS_MS,
  classifyPeerObservationFreshness,
  isTerminalObservedStatus,
  shouldApplyPeerObservation
} from "./peer-observations-repo.js";

/** The RULES a peer-reported observation is applied and aged by (pipeline-mockup-data.md D3/D4).
 *  Pure functions, so they are pinned here rather than through two Testcontainers databases — the
 *  integration file pins that the import door actually calls them. */

const at = (iso: string) => new Date(iso);

describe("the monotone receiver", () => {
  it("applies the first reading for an identity", () => {
    expect(
      shouldApplyPeerObservation(undefined, {
        subject: "target",
        status: "observing",
        observedAt: at("2026-09-19T10:00:00Z")
      })
    ).toBe(true);
  });

  it("refuses a reading OLDER than the one stored — the air-gap out-of-order case", () => {
    // Two bundle files handed over on removable media can be imported in either order, and the
    // second one to arrive is not necessarily the later one to have been taken.
    expect(
      shouldApplyPeerObservation(
        { subject: "target", status: "observing", observedAt: at("2026-09-19T10:00:00Z") },
        { subject: "target", status: "observing", observedAt: at("2026-09-19T09:00:00Z") }
      )
    ).toBe(false);
  });

  it("applies an EQUAL timestamp — a replayed entry is idempotent, not refused", () => {
    expect(
      shouldApplyPeerObservation(
        { subject: "target", status: "observing", observedAt: at("2026-09-19T10:00:00Z") },
        { subject: "target", status: "observing", observedAt: at("2026-09-19T10:00:00Z") }
      )
    ).toBe(true);
  });

  it("applies a NEWER reading of the SAME status — this is how rollout progress arrives at all", () => {
    // A canary walking 20% -> 40% -> 60% never leaves `observing`. A rule keyed only on status
    // change would show the first weight forever.
    expect(
      shouldApplyPeerObservation(
        { subject: "target", status: "observing", observedAt: at("2026-09-19T10:00:00Z") },
        { subject: "target", status: "observing", observedAt: at("2026-09-19T10:05:00Z") }
      )
    ).toBe(true);
  });

  it("refuses to walk a TERMINAL status back, however new the sender says the reading is", () => {
    expect(
      shouldApplyPeerObservation(
        { subject: "target", status: "succeeded", observedAt: at("2026-09-19T10:00:00Z") },
        { subject: "target", status: "observing", observedAt: at("2026-09-19T23:00:00Z") }
      )
    ).toBe(false);
    expect(
      shouldApplyPeerObservation(
        { subject: "hook_run", status: "failed", observedAt: at("2026-09-19T10:00:00Z") },
        { subject: "hook_run", status: "running", observedAt: at("2026-09-19T23:00:00Z") }
      )
    ).toBe(false);
  });

  it("still allows one terminal reading to correct another (a re-run that failed after succeeding)", () => {
    expect(
      shouldApplyPeerObservation(
        { subject: "hook_run", status: "succeeded", observedAt: at("2026-09-19T10:00:00Z") },
        { subject: "hook_run", status: "failed", observedAt: at("2026-09-19T11:00:00Z") }
      )
    ).toBe(true);
  });

  it("treats a status it cannot rank as NON-terminal: recordable before an outcome, never over one", () => {
    // A peer one migration ahead can name a status this side has never heard of. Keeping the reading
    // is better than dropping it; letting it overwrite a settled outcome is not.
    expect(
      shouldApplyPeerObservation(
        { subject: "target", status: "observing", observedAt: at("2026-09-19T10:00:00Z") },
        {
          subject: "target",
          status: "quantum_superposition",
          observedAt: at("2026-09-19T11:00:00Z")
        }
      )
    ).toBe(true);
    expect(
      shouldApplyPeerObservation(
        { subject: "target", status: "succeeded", observedAt: at("2026-09-19T10:00:00Z") },
        {
          subject: "target",
          status: "quantum_superposition",
          observedAt: at("2026-09-19T11:00:00Z")
        }
      )
    ).toBe(false);
  });
});

describe("terminality is read from the module that owns each vocabulary", () => {
  it("includes the wave-target REFUSAL statuses, which a hand-copied list would have missed", () => {
    // The set has grown twice (`REFUSED_WAVE_TARGET_STATUSES`); these are the members a restated
    // copy would not have.
    expect(isTerminalObservedStatus("target", "no_executor")).toBe(true);
    expect(isTerminalObservedStatus("target", "recipe_managed_executor")).toBe(true);
    expect(isTerminalObservedStatus("target", "succeeded")).toBe(true);
    expect(isTerminalObservedStatus("target", "observing")).toBe(false);
    expect(isTerminalObservedStatus("target", "triggered")).toBe(false);
  });

  it("uses the hook-run vocabulary for a hook run — the two sets are NOT the same", () => {
    expect(isTerminalObservedStatus("hook_run", "aborted")).toBe(true);
    expect(isTerminalObservedStatus("hook_run", "running")).toBe(false);
    // `no_executor` is a wave-target refusal and is not a hook-run status at all, which is why the
    // subject has to pick the vocabulary rather than one predicate serving both.
    expect(isTerminalObservedStatus("hook_run", "no_executor")).toBe(false);
  });
});

describe("the sender's forward-transition test (D3's volume bound)", () => {
  it("reports a step forward", () => {
    expect(isForwardHookRunTransition("pending", "running")).toBe(true);
    expect(isForwardHookRunTransition("running", "succeeded")).toBe(true);
    expect(isForwardHookRunTransition("pending", "failed")).toBe(true);
  });

  it("reports NOTHING for a re-read — the poll path's every-tick case", () => {
    expect(isForwardHookRunTransition("running", "running")).toBe(false);
    expect(isForwardHookRunTransition("pending", "pending")).toBe(false);
  });

  it("reports nothing for a flap or a settled run", () => {
    expect(isForwardHookRunTransition("running", "pending")).toBe(false);
    expect(isForwardHookRunTransition("succeeded", "running")).toBe(false);
    // One terminal to another is not "forward" either: the run reached an outcome, and a second
    // outcome from the same run is a reading to distrust, not to broadcast.
    expect(isForwardHookRunTransition("succeeded", "failed")).toBe(false);
  });

  it("never counts an unrecognised status as progress", () => {
    expect(isForwardHookRunTransition("running", "mystery")).toBe(false);
    // …but a run that somehow holds an unrecognised status can still be seen to start.
    expect(isForwardHookRunTransition("mystery", "pending")).toBe(true);
  });
});

describe("freshness", () => {
  it("is the SAME bound the stage-dependency hold ages an observed weight against", () => {
    // ONE constant. If these ever differ, a commander can call a reading fresh that the hold calls
    // stale, about the same row — and the hold is the one that withholds a release.
    expect(PEER_OBSERVATION_FRESHNESS_MS).toBe(OBSERVED_WEIGHT_FRESHNESS_MS);
  });

  it("calls a reading inside the bound fresh, and reports its age", () => {
    const now = at("2026-09-19T10:05:00Z");
    const verdict = classifyPeerObservationFreshness(at("2026-09-19T10:00:00Z"), now);
    expect(verdict).toEqual({ state: "fresh", ageSeconds: 300 });
  });

  it("calls a reading past the bound stale, and says WHAT bound it used", () => {
    const now = at("2026-09-19T13:00:00Z");
    const verdict = classifyPeerObservationFreshness(at("2026-09-19T10:00:00Z"), now);
    expect(verdict).toEqual({ state: "stale", ageSeconds: 10_800, staleAfterSeconds: 600 });
  });

  it("is fresh exactly ON the bound, not stale — the boundary is stated, not left to a reader", () => {
    const observedAt = at("2026-09-19T10:00:00Z");
    const now = new Date(observedAt.getTime() + PEER_OBSERVATION_FRESHNESS_MS);
    expect(classifyPeerObservationFreshness(observedAt, now).state).toBe("fresh");
    expect(classifyPeerObservationFreshness(observedAt, new Date(now.getTime() + 1)).state).toBe(
      "stale"
    );
  });

  it("never reports a NEGATIVE age when a peer's clock runs ahead of ours", () => {
    // Two domains, two clocks, and no authority over the sender's. A negative age would render as
    // "-3 minutes ago"; it is clamped to zero and still called fresh, which is the honest reading of
    // "as new as anything we have".
    const verdict = classifyPeerObservationFreshness(
      at("2026-09-19T10:05:00Z"),
      at("2026-09-19T10:00:00Z")
    );
    expect(verdict).toEqual({ state: "fresh", ageSeconds: 0 });
  });
});
