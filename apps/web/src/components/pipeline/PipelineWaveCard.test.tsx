import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * `observed.truncation` HONESTY (docs/proposals/observed-truncation-ui.md §3, M23.1g) — the
 * card must not let a platform-side persistence cut render as "the executor never reported this".
 *
 * MUTATION-SENSITIVITY, stated up front rather than left implicit: every pill assertion below goes
 * RED if the corresponding `dropped: true` in its fixture is flipped to `false` (the field then
 * "renders" instead of being reported truncated) or deleted (the truncation key vanishes, which is
 * rule 6 territory and is pinned separately as its own case). The marker-text assertion goes RED if
 * `realImages`/`imageVersionLabel` is bypassed and `images[0]` is rendered directly again — that is
 * the actual regression this proposal exists to prevent, not a hypothetical.
 *
 * Same harness as `change-pipeline-hold.test.tsx`: `renderToStaticMarkup`, no jsdom, `Link` stubbed
 * to a bare anchor since it throws outside a `RouterProvider`.
 */

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>
}));

const { PipelineWaveCard } = await import("./PipelineWaveCard");

import type {
  PipelineWaveLike,
  PipelineWaveTargetLike,
  WaveTargetFreezeEntry
} from "./PipelineWaveCard";
import type { ChangeStageDependencyTarget } from "@scp/sdk";

const BASE_TARGET: PipelineWaveTargetLike = {
  id: "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f",
  targetObjectId: "5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f",
  targetName: "agentkit-bootstrap @ gamma",
  status: "succeeded",
  category: "deploy",
  type: "configuration",
  attempt: 1
};

function waveWith(target: PipelineWaveTargetLike): PipelineWaveLike {
  return {
    id: "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e",
    waveIndex: 0,
    name: "gamma",
    status: "succeeded",
    requiresFanIn: false,
    startedAt: "2026-08-10T10:01:00.000Z",
    completedAt: "2026-08-10T10:05:00.000Z",
    targets: [target]
  };
}

function renderCard(target: PipelineWaveTargetLike): string {
  return renderToStaticMarkup(<PipelineWaveCard wave={waveWith(target)} waveNumber={1} />);
}

describe("PipelineWaveCard: observed.truncation honesty (proposal §3)", () => {
  it("rule 1 — a dropped rollout gets the pill and the wire-record counts, not silence", () => {
    const html = renderCard({
      ...BASE_TARGET,
      observed: {
        images: ["ghcr.io/x/agentkit:1.4.2"],
        truncation: { rollout: { dropped: true, droppedFields: 3 } }
      }
    });

    expect(html).toContain('data-testid="pipeline-wave-observed-rollout-truncated"');
    expect(html).toContain("rollout truncated");
    expect(html).toContain("3 fields");
    expect(html).toContain("This is not &quot;no rollout observed&quot;");
    // The version slot is untouched — this cut is scoped to rollout alone.
    expect(html).toContain('data-testid="pipeline-wave-observed-image"');
    expect(html).not.toContain("observed state truncated");
  });

  it("rule 1, negative — an UNDROPPED rollout renders exactly as it did before (no pill, no lie)", () => {
    // The half that makes the case above mean something: mutate `dropped: true` -> `false` here and
    // this test still passes while the one above goes red, proving the guard is the flag and not
    // something else that happened to co-occur with it.
    const html = renderCard({
      ...BASE_TARGET,
      observed: { rollout: { phase: "Progressing", step: 2, weight: 50 } }
    });

    expect(html).toContain('data-testid="pipeline-wave-observed-rollout"');
    expect(html).toContain("rollout Progressing");
    expect(html).not.toContain("rollout-truncated");
  });

  it("rule 2 — images fully dropped renders 'version truncated', never the 'not observed yet' placeholder", () => {
    const html = renderCard({
      ...BASE_TARGET,
      observed: {
        truncation: { images: { dropped: true, droppedCharacters: 500093 } }
      }
    });

    expect(html).toContain('data-testid="pipeline-wave-observed-version-truncated"');
    expect(html).toContain("version truncated");
    expect(html).toContain("500093 chars");
    // THE DEFECT THIS PINS: without the fix, `images` undefined + `revision` undefined falls
    // straight to the em-dash placeholder below, blaming the executor for a cut this platform made.
    // (The pill's own tooltip legitimately says '...is not "not observed yet"', so the placeholder
    // is identified by its distinguishing title text, not the bare phrase.)
    expect(html).not.toContain("per-wave version/digest not observed yet");
    expect(html).not.toContain('data-testid="pipeline-wave-observed-image"');
  });

  it("rule 2 does not fire when revision still renders a true claim", () => {
    // Images alone being gone does not make the slot's SHOWN claim false when revision covers it —
    // the pill rule is "where a rendered claim would otherwise be false", and here it would not be.
    const html = renderCard({
      ...BASE_TARGET,
      observed: {
        revision: "abcdef01234",
        truncation: { images: { dropped: true } }
      }
    });

    expect(html).not.toContain("version-truncated");
    expect(html).toContain('data-testid="pipeline-wave-observed-revision"');
    expect(html).toContain("abcdef0");
  });

  it("rule 3 — a tail-cut images array renders images[0] unchanged, tooltip gains one line, no pill", () => {
    const html = renderCard({
      ...BASE_TARGET,
      observed: {
        images: ["ghcr.io/x/agentkit:1.4.2", "[elided: 4 more entries]"],
        truncation: { images: { dropped: false, droppedEntries: 4 } }
      }
    });

    expect(html).toContain('data-testid="pipeline-wave-observed-image"');
    expect(html).toContain("1.4.2");
    expect(html).toContain("image list truncated");
    expect(html).toContain("4 more entries removed");
    // NO PILL — the claim shown ("version 1.4.2") is still true.
    expect(html).not.toContain("version-truncated");
    expect(html).not.toContain("observed state truncated");
  });

  it("MARKER SAFETY — a planted elision-marker string never appears anywhere in the DOM", () => {
    // The literal marker text the store would append is deliberately distinctive so a leak of any
    // kind (rendered value, title attribute, anywhere) is unambiguous.
    const marker = "[elided: 7 more entries]";
    const html = renderCard({
      ...BASE_TARGET,
      observed: {
        images: [marker],
        truncation: { images: { dropped: false, droppedEntries: 7 } }
      }
    });

    expect(html).not.toContain(marker);
    // Zero real entries survived the cut, so this collapses to rule 2's honest pill, not a
    // rendered (fake) version.
    expect(html).toContain('data-testid="pipeline-wave-observed-version-truncated"');
    expect(html).not.toContain('data-testid="pipeline-wave-observed-image"');
  });

  it("rule 5 — whole-state elision renders ONE pill, with rung 1's diagnostic in the tooltip, and suppresses the separate rollout pill", () => {
    const diagnostic =
      "a plugin-supplied value rendered to 9001 characters after bounding, over the 7584-character budget, and was not stored verbatim";
    const html = renderCard({
      ...BASE_TARGET,
      observed: {
        // @ts-expect-error -- `__scpElided` is not part of the declared SDK shape (proposal §1);
        // the fixture plants it anyway because the wire can carry it and the UI reads it loosely.
        __scpElided: diagnostic,
        truncation: {
          images: { dropped: true },
          rollout: { dropped: true }
        }
      }
    });

    expect(html).toContain('data-testid="pipeline-wave-observed-elided"');
    expect(html).toContain("observed state truncated");
    expect(html).toContain(diagnostic);
    // THE FIX: without it, this renders BOTH a placeholder/pill in the version slot AND a second,
    // independent "rollout truncated" pill — two labels for the one lost reading.
    expect(html).not.toContain("rollout-truncated");
    expect(html).not.toContain("version-truncated");
  });

  it("rule 5 falls back to a generic sentence when rung 1's diagnostic is absent (rung 2/3 shape)", () => {
    const html = renderCard({
      ...BASE_TARGET,
      observed: {
        // @ts-expect-error -- see the note above.
        __scpElided: true,
        truncation: { images: { dropped: true }, rollout: { dropped: true } }
      }
    });

    expect(html).toContain('data-testid="pipeline-wave-observed-elided"');
    expect(html).toContain("could not be preserved");
  });

  it("rule 6 — absent truncation key renders exactly today's placeholder, no pill (pre-M23.1g rows)", () => {
    const html = renderCard({ ...BASE_TARGET, observed: null });

    expect(html).toContain("not observed yet");
    expect(html).not.toContain("truncated");
  });

  it("rule 6 — an older row with images/revision but no truncation key at all is unaffected", () => {
    const html = renderCard({
      ...BASE_TARGET,
      observed: { images: ["ghcr.io/x/agentkit:1.4.2"], revision: "abcdef01234" }
    });

    expect(html).toContain('data-testid="pipeline-wave-observed-image"');
    expect(html).toContain('data-testid="pipeline-wave-observed-revision"');
    expect(html).not.toContain("truncated");
  });

  it("revision renders as-is even though it is bounded — deliberate asymmetry, no signal by design", () => {
    // `revision` carries no truncation entry on the wire by design (proposal §1); a stray
    // `truncation.revision` key (which the real server never emits) must not change how it renders
    // either — the card does not special-case revision at all.
    const html = renderCard({
      ...BASE_TARGET,
      observed: {
        revision: "abcdef01234",
        // The server never emits this key (revision carries no truncation signal by design); the
        // record's type is a `Record<string, ...>` so the fixture can still plant it, to pin that
        // the UI ignores it too rather than merely never receiving it.
        truncation: { revision: { dropped: true } }
      }
    });

    expect(html).toContain('data-testid="pipeline-wave-observed-revision"');
    expect(html).toContain("abcdef0");
    expect(html).not.toContain("truncated");
  });
});

/**
 * `ChangeWaveTargetSchema.hold` / `ChangeWaveSchema.heldTargetCount` (M25.UI increment 2) — the
 * freeze half of a target's hold, read straight off the target rather than a `holdFor` closure
 * (unlike the stage-dependency half, which mirrors `change-pipeline-hold.test.tsx`'s own reasoning
 * for testing at THIS altitude: the card is the thing that owns rendering it once handed the
 * field, and `wave={wave}` on every real page already carries `targets[].hold` straight from the
 * `explain` response — no page-level plumbing is needed for the freeze half at all).
 */
const FREEZE_ENTRY: WaveTargetFreezeEntry = {
  freezeId: "8b9c0d1e-2f3a-4b5c-9d6e-7f8a9b0c1d2e",
  scope: { objectId: "9c0d1e2f-3a4b-4c5d-8e9f-0a1b2c3d4e5f", name: "amer" },
  // No `'` in the fixture summary itself (the real server-composed sentence uses them, but
  // `renderToStaticMarkup` HTML-escapes them to `&#x27;` — asserting on a quote-free sentence
  // keeps these cases about "is the summary rendered verbatim", not about React's escaping).
  summary: "freeze amer-incident at amer until 2026-08-24T12:00:00.000Z",
  endsAt: "2026-08-24T12:00:00.000Z"
};

const STAGE_DEP_HELD: ChangeStageDependencyTarget = {
  targetObjectId: BASE_TARGET.targetObjectId,
  targetName: BASE_TARGET.targetName ?? null,
  componentObjectId: "3d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f6a",
  componentName: "agentkit-bootstrap",
  deploymentTargetObjectId: "4e5f6a7b-8c9d-4e0f-9a1b-2c3d4e5f6a7b",
  deploymentTargetName: "homelab-gamma",
  held: true,
  dependencies: [
    {
      dependsOn: "7a8b9c0d-1e2f-4a3b-9c4d-5e6f7a8b9c0d",
      dependsOnName: "agentkit-api",
      branch: "never_deployed",
      satisfied: false,
      summary: "'7a8b9c0d-1e2f-4a3b-9c4d-5e6f7a8b9c0d' is placed here but has never deployed here"
    }
  ]
};

const PROBE_ENTRY = {
  hookId: "canary",
  reason: "stale" as const,
  summary: "canary last reported 2026-08-27T23:40:00.000Z, stale after 2026-08-27T23:55:00.000Z",
  staleAfter: "2026-08-27T23:55:00.000Z",
  lastReportedAt: "2026-08-27T23:40:00.000Z"
};

/**
 * THE CONTINUOUS-PROBE HALF OF A TARGET'S HOLD (team-pipeline-iac D21/D11, increment 8).
 *
 * WHAT WAS BROKEN: `ChangeWaveTargetSchema.hold.continuousTests` has been on the wire since
 * increment 8 and this component read only `hold.freezes`. A target held SOLELY by a stale or
 * failed probe therefore rendered a `held` badge with NOTHING beneath it — the operator could see
 * that the wave was stuck and not why, for a reason the server had already composed and sent. It is
 * the same shape as the truncated-as-absent lie this card had to fix once before: the data arrived
 * and the UI dropped it.
 *
 * Case 1 is the load-bearing one. It asserts the LINE, not merely the badge — a test that only
 * checked for `held` would have passed against the broken build, since the badge came from the
 * freeze half and the stage-dependency half all along.
 */
describe("PipelineWaveCard: the continuous-probe hold half (increment 8, D21)", () => {
  it("a probe-ONLY held target renders the reason, not a badge with nothing under it", () => {
    const html = renderCard({
      ...BASE_TARGET,
      status: "pending",
      hold: { freezes: [], continuousTests: [PROBE_ENTRY] }
    });

    expect(html).toContain('data-testid="pipeline-wave-target-held-badge"');
    expect(html).toContain('data-testid="pipeline-wave-target-continuous-hold"');
    expect(html).toContain('data-testid="pipeline-wave-target-continuous-hold-line"');
    // The hook's own id — an estate runs several probes and "a probe is stale" does not say which.
    expect(html).toContain("canary");
    // The server's sentence, VERBATIM. This module composes no copy from raw fields.
    expect(html).toContain(PROBE_ENTRY.summary);
  });

  it("a probe-only hold takes AMBER, not the self-clearing blue", () => {
    // The variant encodes "does this clear itself", not "who holds it". A stage dependency clears
    // when the dependency lands; a probe hold does NOT — a human fixes the prober or the target, so
    // rendering it blue would promise self-clearing to the one kind that can sit there forever.
    const html = renderCard({
      ...BASE_TARGET,
      status: "pending",
      hold: { freezes: [], continuousTests: [PROBE_ENTRY] }
    });
    const badge = html.match(/<div[^>]*pipeline-wave-target-held-badge[^>]*>/)?.[0];
    expect(badge).toContain("bg-amber-50");
    expect(badge).not.toContain("bg-blue-50");
  });

  it("renders the routing reason for each of the three states, from a fixed lookup", () => {
    // The three hold identically and mean different things: no_evidence/stale send an operator to
    // the PROBER, failed sends them to the TARGET. Collapsing them to "held" makes the badge honest
    // and the page useless.
    for (const [reason, label] of [
      ["no_evidence", "never reported"],
      ["stale", "stale"],
      ["failed", "failing"]
    ] as const) {
      const html = renderCard({
        ...BASE_TARGET,
        status: "pending",
        hold: { freezes: [], continuousTests: [{ ...PROBE_ENTRY, reason }] }
      });
      expect(html, reason).toContain(label);
    }
  });

  it("a target held by BOTH a freeze and a probe renders BOTH lines — neither kind wins", () => {
    // The union rule the freeze half already follows. One kind silently swallowing the other is how
    // an operator fixes the freeze, sees the target still stuck, and has nothing to read.
    const html = renderCard({
      ...BASE_TARGET,
      status: "pending",
      hold: { freezes: [FREEZE_ENTRY], continuousTests: [PROBE_ENTRY] }
    });

    expect(html).toContain('data-testid="pipeline-wave-target-freeze-hold-line"');
    expect(html).toContain('data-testid="pipeline-wave-target-continuous-hold-line"');
    expect(html).toContain(FREEZE_ENTRY.summary);
    expect(html).toContain(PROBE_ENTRY.summary);
  });

  it("carries the freshness boundary as a LOCAL-clock tooltip — `now` never crosses the seam", () => {
    // `staleAfter`/`lastReportedAt` are on the wire precisely so the client's clock contextualizes
    // them. Rendering a relative time in the line itself would put `now` on the server's side of a
    // boundary the schema keeps it off.
    const html = renderCard({
      ...BASE_TARGET,
      status: "pending",
      hold: { freezes: [], continuousTests: [PROBE_ENTRY] }
    });
    expect(html).toMatch(/title="last reported [^"]+stale after [^"]+"/);
  });

  it("a probe that has NEVER reported says so, rather than formatting a null date", () => {
    const html = renderCard({
      ...BASE_TARGET,
      status: "pending",
      hold: {
        freezes: [],
        continuousTests: [
          { ...PROBE_ENTRY, reason: "no_evidence", lastReportedAt: null, staleAfter: null }
        ]
      }
    });
    expect(html).toContain("no result has ever been reported");
    expect(html).not.toContain("Invalid Date");
  });

  it("ABSENT continuousTests renders no probe line at all — absence is not an empty hold", () => {
    // The field is optional and never sent as `[]`, so undefined means "no probe holds this",
    // not "we did not look". A fabricated empty line would be the inverse of the bug being fixed.
    const html = renderCard({
      ...BASE_TARGET,
      status: "pending",
      hold: { freezes: [FREEZE_ENTRY] }
    });
    expect(html).not.toContain('data-testid="pipeline-wave-target-continuous-hold"');
  });
});

describe("PipelineWaveCard: the freeze-hold field (ChangeWaveTargetSchema.hold, M25.UI)", () => {
  it("a stage-dependency-ONLY held target keeps the informational blue badge — it clears itself; amber is the freeze's", () => {
    const html = renderToStaticMarkup(
      <PipelineWaveCard
        wave={waveWith({ ...BASE_TARGET, status: "pending" })}
        waveNumber={1}
        holdFor={() => ({
          targetObjectId: BASE_TARGET.targetObjectId,
          targetName: "agentkit-bootstrap @ gamma",
          componentObjectId: null,
          componentName: null,
          deploymentTargetObjectId: null,
          deploymentTargetName: null,
          held: true,
          dependencies: [
            {
              dependsOn: "platform-core",
              dependsOnName: "platform-core",
              branch: "never_deployed",
              satisfied: false,
              summary: "held until platform-core reaches gamma"
            }
          ]
        })}
      />
    );
    const heldBadgeTag = html.match(/<div[^>]*pipeline-wave-target-held-badge[^>]*>/)?.[0];
    expect(heldBadgeTag).toBeDefined();
    expect(heldBadgeTag).toContain("bg-blue-50");
    expect(heldBadgeTag).not.toContain("bg-amber-50");
  });

  it("a freeze-held target shows the held badge and the freeze line, rendered VERBATIM", () => {
    const html = renderCard({
      ...BASE_TARGET,
      status: "pending",
      hold: { freezes: [FREEZE_ENTRY] }
    });

    expect(html).toContain('data-held="true"');
    expect(html).toContain('data-testid="pipeline-wave-target-held-badge"');
    expect(html).toContain('data-testid="pipeline-wave-target-freeze-hold"');
    expect(html).toContain('data-testid="pipeline-wave-target-freeze-hold-line"');
    // The line carries the freeze window's end as a LOCAL-clock tooltip (the wire's `endsAt`,
    // which exists exactly so the client's clock can contextualize it) — renderToStaticMarkup
    // includes title attributes, the established honesty-copy channel.
    expect(html).toMatch(/title="freeze window ends [^"]+"/);
    // The scope name, then the server-composed summary verbatim — "{scope.name} — {summary}".
    expect(html).toContain("amer");
    expect(html).toContain(FREEZE_ENTRY.summary);
    // The raw status stays beside the hold — it is not overwritten.
    expect(html).toContain("pending");
    // TONE FOLLOWS THE HOLD KIND (design-system §1.5): a freeze hold is an operator-declared
    // needs-attention state — the held badge renders `warning` (amber), never the informational
    // blue a self-clearing stage-dependency hold gets. Element-scoped so no other amber in the
    // render can satisfy it.
    const heldBadgeTag = html.match(/<div[^>]*pipeline-wave-target-held-badge[^>]*>/)?.[0];
    expect(heldBadgeTag).toBeDefined();
    expect(heldBadgeTag).toContain("bg-amber-50");
    // The stage-dependency line was not asked for and must not appear.
    expect(html).not.toContain('data-testid="pipeline-wave-target-hold"');
  });

  it("a platform-tier freeze's null scope renders the server's summary alone — no invented scope label (M25.UI review minor finding 2)", () => {
    const html = renderCard({
      ...BASE_TARGET,
      status: "pending",
      hold: { freezes: [{ ...FREEZE_ENTRY, scope: null }] }
    });

    // The server's own sentence (which states the tier and the coordinate it matched) is what
    // renders — never a client-composed "instance-wide" label, which claims a scope a platform
    // freeze scoped to one region does not have.
    expect(html).toContain(FREEZE_ENTRY.summary);
    expect(html).not.toContain("instance-wide");
  });

  it("a target held by BOTH kinds at once lists both lines under the one badge", () => {
    const html = renderToStaticMarkup(
      <PipelineWaveCard
        wave={waveWith({ ...BASE_TARGET, status: "pending", hold: { freezes: [FREEZE_ENTRY] } })}
        waveNumber={1}
        holdFor={() => STAGE_DEP_HELD}
      />
    );

    // ONE badge, not two — `anyHeld` is a union, never a second "held" pill.
    expect((html.match(/pipeline-wave-target-held-badge/g) ?? []).length).toBe(1);
    expect(html).toContain('data-testid="pipeline-wave-target-hold"');
    expect(html).toContain("agentkit-api");
    expect(html).toContain('data-testid="pipeline-wave-target-freeze-hold"');
    expect(html).toContain(FREEZE_ENTRY.summary);
  });

  it("leaves an ordinary target untouched — `hold` absent is not an empty claim", () => {
    // The boundary every response predating this field, and every unheld target, must clear:
    // no `hold` key at all (as opposed to `{freezes: []}`) renders exactly as before.
    const html = renderCard({ ...BASE_TARGET, status: "succeeded" });

    expect(html).not.toContain('data-held="true"');
    expect(html).not.toContain('data-testid="pipeline-wave-target-held-badge"');
    expect(html).not.toContain('data-testid="pipeline-wave-target-freeze-hold"');
  });

  it("an EMPTY `hold.freezes` array (the shape the schema forbids in practice) still renders as unheld", () => {
    // Defensive: `toWaveTargetHold` never emits an empty array server-side, but the card must not
    // assume that — `target.hold` truthy with zero entries is not a hold either.
    const html = renderCard({ ...BASE_TARGET, status: "pending", hold: { freezes: [] } });

    expect(html).not.toContain('data-held="true"');
    expect(html).not.toContain('data-testid="pipeline-wave-target-freeze-hold"');
  });
});

describe("PipelineWaveCard: the wave-level 'N held' chip (ChangeWaveSchema.heldTargetCount)", () => {
  function renderWave(wave: PipelineWaveLike): string {
    return renderToStaticMarkup(<PipelineWaveCard wave={wave} waveNumber={1} />);
  }

  it("renders the chip in amber `warning` tone, never red, when heldTargetCount > 0", () => {
    const html = renderWave({ ...waveWith(BASE_TARGET), heldTargetCount: 2 });

    expect(html).toContain('data-testid="pipeline-wave-held-count-badge"');
    expect(html).toContain("2 held");
    expect(html).toContain("bg-amber-50");
    expect(html).not.toContain("bg-red-50");
  });

  it("carries a title tooltip naming what 'held' means", () => {
    const html = renderWave({ ...waveWith(BASE_TARGET), heldTargetCount: 1 });

    expect(html).toContain('data-testid="pipeline-wave-held-count-badge"');
    expect(html).toMatch(/title="[^"]*withheld[^"]*"/);
  });

  it("the chip is absent when heldTargetCount is 0", () => {
    const html = renderWave({ ...waveWith(BASE_TARGET), heldTargetCount: 0 });
    expect(html).not.toContain('data-testid="pipeline-wave-held-count-badge"');
  });

  it("the chip is absent when heldTargetCount is undefined — omission is not zero, but renders the same", () => {
    const html = renderWave(waveWith(BASE_TARGET));
    expect(html).not.toContain('data-testid="pipeline-wave-held-count-badge"');
  });

  it("wave-status.ts stays keyed on `status` alone — the chip does not change the status badge's tone", () => {
    const withoutChip = renderWave(waveWith(BASE_TARGET));
    const withChip = renderWave({ ...waveWith(BASE_TARGET), heldTargetCount: 3 });
    const statusBadge = (html: string) =>
      html.match(/data-testid="pipeline-wave-status-badge"[^>]*>[^<]*/)?.[0];
    // Same wave `status` ("succeeded" per `waveWith`), so the status badge's own classes/text must
    // be identical with or without the held chip beside it.
    expect(statusBadge(withChip)).toBe(statusBadge(withoutChip));
  });
});
