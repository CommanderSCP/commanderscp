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

import type { PipelineWaveLike, PipelineWaveTargetLike } from "./PipelineWaveCard";

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
