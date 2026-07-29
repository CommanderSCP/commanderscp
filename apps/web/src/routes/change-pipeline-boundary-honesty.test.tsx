import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { BoundarySegment } from "@scp/sdk";

/**
 * The RENDERING half of the M16.1 boundary segment's honesty rule, pinned by a check that runs on
 * EVERY PR.
 *
 * Same reasoning — and same mechanism — as `service-board-honesty.test.tsx`: the Playwright specs
 * in `.github/workflows/ci.yml` are guarded by `github.event_name == 'push' && github.ref ==
 * 'refs/heads/main'` and are SKIPPED on pull requests, so a browser-only guard would let the UI
 * regress into `main` with both required checks green. The server half of this rule is pinned by
 * `apps/server/src/coordination/boundary-segment.integration.test.ts` (two federated domains, real
 * Postgres); this file owns the presentational half — given a segment response, does the UI keep
 * "cannot see" and "observed" visually distinct, and does it refuse to dress either as a pass?
 * It runs in the existing unit-test job (plain `vitest run` + `react-dom/server`), needs no browser
 * and no DOM library, and takes milliseconds.
 *
 * VOCABULARY (ADR-0021 D6): a boundary SEGMENT of two boundary PHASES. Never a "stage" (a
 * deployment place) and never a "wave" (the set of stages advanced at once).
 *
 * `Link` is stubbed because `@tanstack/react-router`'s `useRouter` throws outside a
 * `RouterProvider`; routing is not what is under test here.
 */
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>
}));

const { BoundarySegmentStrip, NoBoundarySegment, isBoundaryUnknown } = await import(
  "../components/pipeline/BoundarySegmentStrip"
);

const PEER_DOMAIN_ID = "9a8b7c6d-5e4f-4a3b-8c1d-2e3f4a5b6c7d";
const DECISION_ID = "1b2c3d4e-5f6a-4b8c-9d0e-1f2a3b4c5d6e";

/** The one success paint in the whole component. Asserted as a PREMISE wherever a test claims its
 *  absence, so a renamed success variant fails loudly instead of passing vacuously. */
const SUCCESS_CLASS = "bg-green-600";

function render(segment: BoundarySegment): string {
  return renderToStaticMarkup(<BoundarySegmentStrip segment={segment} />);
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * THE COMMANDER SIDE. It exported the promotion bundle; its own ledger row is (and by construction
 * stays) `created`; and it has no data path to the receiving outpost's verification outcome. Both
 * facts are declared by the server in `unknownFields`.
 */
const commanderSegment: BoundarySegment = {
  transfer: {
    state: "exported",
    hops: [
      {
        direction: "export",
        status: "created",
        peerDomainId: PEER_DOMAIN_ID,
        checksum: "a".repeat(64),
        observedAt: "2026-07-29T10:00:00.000Z"
      }
    ],
    observedAt: "2026-07-29T10:00:00.000Z"
  },
  validate: {
    state: "not_reported",
    decisionId: null,
    observedAt: null,
    verifiedArtifactCount: null
  },
  unknownFields: ["transfer.handoff", "validate.state"]
};

/** THE RECEIVING OUTPOST, after its own pre-deploy artifact verify recorded an `allow`. */
const outpostVerifiedSegment: BoundarySegment = {
  transfer: {
    state: "received",
    hops: [
      {
        direction: "import",
        status: "confirmed",
        peerDomainId: PEER_DOMAIN_ID,
        checksum: "a".repeat(64),
        observedAt: "2026-07-29T10:05:00.000Z"
      }
    ],
    observedAt: "2026-07-29T10:05:00.000Z"
  },
  validate: {
    state: "verified",
    decisionId: DECISION_ID,
    observedAt: "2026-07-29T10:06:00.000Z",
    verifiedArtifactCount: 2
  },
  unknownFields: []
};

/** THE RECEIVING OUTPOST, bundle arrived, no verdict yet — a real local observation of an absence
 *  (this is also where a metadata-only promotion lands, because the pre-deploy gate's vacuous exits
 *  deliberately record nothing rather than a pass over zero artifacts). */
const outpostPendingSegment: BoundarySegment = {
  ...outpostVerifiedSegment,
  validate: {
    state: "not_yet_verified",
    decisionId: null,
    observedAt: null,
    verifiedArtifactCount: null
  }
};

/** THE RECEIVING OUTPOST, verification refused (fail-closed block Decision). */
const outpostRefusedSegment: BoundarySegment = {
  ...outpostVerifiedSegment,
  validate: {
    state: "refused",
    decisionId: DECISION_ID,
    observedAt: "2026-07-29T10:06:00.000Z",
    verifiedArtifactCount: 1
  }
};

describe("boundary segment: the commander never paints a validation it cannot see", () => {
  it("renders the exporting side's unreported outcome as an explicit unknown, never as a pass", () => {
    const html = render(commanderSegment);

    // Two unknowns, two facts it genuinely cannot observe: the handoff and the verdict.
    expect(occurrences(html, 'data-testid="boundary-unknown"')).toBe(2);
    expect(html).toContain("outcome not reported back");
    expect(html).toContain("handoff unknown here");

    // THE LOAD-BEARING ASSERTION. No success paint anywhere — and the premise is asserted below, so
    // this cannot pass merely because the success class was renamed.
    expect(html).not.toContain(SUCCESS_CLASS);
    expect(html).not.toContain("signatures verified");
    // "unknown", never a machine-readable NOT-VERIFIED assertion over a field in unknownFields.
    expect(html).toContain('data-verified="unknown"');
    expect(html).not.toContain('data-verified="false"');
    expect(html).not.toContain('data-verified="true"');
  });

  it("shows the transfer it DID observe — exported — without claiming the peer received it", () => {
    const html = render(commanderSegment);

    expect(html).toContain('data-testid="boundary-phase-transfer"');
    expect(html).toContain('data-state="exported"');
    expect(html).toContain(">exported</div>");
    // The insert-only ledger cannot say either of these on the exporting side. Asserted against the
    // BADGE, which is what an operator reads at a glance (the unknown marker's explanatory tooltip
    // legitimately uses the words "submitted/confirmed" to explain why they are not observable).
    const badgeStart = html.indexOf('data-testid="boundary-transfer-badge"');
    expect(badgeStart).toBeGreaterThan(-1);
    const badge = html.slice(badgeStart, html.indexOf("</div>", badgeStart));
    expect(badge).not.toContain("received here");
    expect(badge).not.toContain("confirmed");
    expect(badge).not.toContain("submitted");
  });
});

describe("boundary segment: a real outpost verdict IS rendered, and the two never look alike", () => {
  it("paints `verified` as the success state — the premise for every negative assertion above", () => {
    const html = render(outpostVerifiedSegment);

    expect(html).toContain(SUCCESS_CLASS); // premise: the success paint really is this class
    expect(html).toContain("signatures verified");
    expect(html).toContain('data-verified="true"');
    expect(html).toContain('data-state="verified"');
    expect(html).toContain("2 authorized artifacts");
    // A verdict this instance HAS is not an unknown.
    expect(occurrences(html, 'data-testid="boundary-unknown"')).toBe(0);
  });

  it("keeps 'not yet verified' distinct from BOTH a pass and a can't-see", () => {
    const html = render(outpostPendingSegment);

    // Not a pass...
    expect(html).not.toContain("signatures verified");
    expect(html).toContain('data-verified="false"');
    // ...and not the amber unknown marker either: this instance can SEE that no verdict exists.
    // (A metadata-only promotion lands here, and must not read as a verification that succeeded.)
    expect(occurrences(html, 'data-testid="boundary-unknown"')).toBe(0);
    expect(html).toContain("not yet verified");
    expect(html).toContain('data-state="not_yet_verified"');
    // The RECEIVED transfer is still a real observation and keeps its success paint...
    expect(html).toContain("received here");
    // ...so assert the VALIDATE phase specifically carries none.
    const validateStart = html.indexOf('data-testid="boundary-phase-validate"');
    expect(validateStart).toBeGreaterThan(-1);
    expect(html.slice(validateStart)).not.toContain(SUCCESS_CLASS);
  });

  it("paints a refused verification as a refusal, never as an unknown or a pass", () => {
    const html = render(outpostRefusedSegment);

    expect(html).toContain("verification refused");
    expect(html).toContain('data-state="refused"');
    expect(html).toContain('data-verified="false"');
    expect(occurrences(html, 'data-testid="boundary-unknown"')).toBe(0);
    const validateStart = html.indexOf('data-testid="boundary-phase-validate"');
    expect(html.slice(validateStart)).not.toContain(SUCCESS_CLASS);
  });
});

describe("boundary segment: the absent case is stated, not silently green", () => {
  it("renders an explicit 'no boundary segment' for a change that never crossed a boundary", () => {
    const html = renderToStaticMarkup(<NoBoundarySegment />);

    expect(html).toContain('data-testid="boundary-segment-absent"');
    expect(html).toContain("has not crossed a domain boundary");
    expect(html).not.toContain(SUCCESS_CLASS);
    expect(html).not.toContain("signatures verified");
  });
});

describe("boundary segment: the wiring, by exact field name", () => {
  // The unknown markers are only as honest as the predicate that derives them from the server's
  // `unknownFields`. That derivation is an `.includes(...)` a later edit could change with nothing
  // failing, silently retiring the marker. These pin the field names themselves.
  it("derives each unknown independently, by exact dotted path", () => {
    expect(isBoundaryUnknown(commanderSegment, "validate.state")).toBe(true);
    expect(isBoundaryUnknown(commanderSegment, "transfer.handoff")).toBe(true);
    expect(isBoundaryUnknown(outpostVerifiedSegment, "validate.state")).toBe(false);
    // A neighbouring unknown must not satisfy the other: a commander that could somehow observe the
    // handoff would still not be able to see the outpost's verdict, and vice versa.
    expect(
      isBoundaryUnknown({ ...commanderSegment, unknownFields: ["transfer.handoff"] }, "validate.state")
    ).toBe(false);
    expect(
      isBoundaryUnknown({ ...commanderSegment, unknownFields: ["validate.state"] }, "transfer.handoff")
    ).toBe(false);
  });

  it("a segment whose validate.state is unknown NEVER renders as verified, whatever state rides along", () => {
    // Defence in depth against a server bug or a hostile/skewed payload: even if `validate.state`
    // arrived as the literal `verified` while `unknownFields` says it is unobservable, the UI must
    // side with the declaration. The unknown wins; nothing green is painted.
    const contradictory: BoundarySegment = {
      ...outpostVerifiedSegment,
      transfer: commanderSegment.transfer,
      unknownFields: ["validate.state"]
    };
    const html = render(contradictory);

    expect(html).toContain('data-verified="unknown"');
    expect(html).not.toContain("signatures verified");
    const validateStart = html.indexOf('data-testid="boundary-phase-validate"');
    expect(html.slice(validateStart)).not.toContain(SUCCESS_CLASS);
  });
});
