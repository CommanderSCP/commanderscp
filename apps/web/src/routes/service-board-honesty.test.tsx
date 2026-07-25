import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ServiceBoardRow, ServiceBoardSummary } from "@scp/sdk";

/**
 * The RENDERING half of the service board's federation-honesty rule, pinned by a check that runs on
 * EVERY PR.
 *
 * WHY THIS FILE EXISTS ALONGSIDE `apps/web/e2e/service-board-honesty.spec.ts`, which asserts the same
 * distinction end-to-end. That spec lives in the Playwright suite, and every E2E job in
 * `.github/workflows/ci.yml` is guarded by `github.event_name == 'push' && github.ref ==
 * 'refs/heads/main'` — they are SKIPPED on pull requests, and branch protection requires only the
 * integration-aggregation and codegen-drift contexts. So the server half of this rule (named in
 * `unknownFields`) was gated on PRs by `apps/server/src/coordination/service-board-*.integration.
 * test.ts`, while the rendering half — where a browser can still paint an unobservable field exactly
 * like an observed-and-empty one and undo the whole thing — could regress into `main` with both
 * required checks green. This file closes that: it runs in the existing "4. Unit tests" job (plain
 * `vitest run`, transitively required), needs no browser, no DOM library and no new dependency —
 * `react-dom/server`'s `renderToStaticMarkup` renders to a string in the Node environment Vitest
 * already uses — and takes milliseconds.
 *
 * It deliberately does NOT replace the E2E spec, which additionally proves the real route, real
 * authz and the real generated SDK type reach the browser at all. What it owns is the pure
 * presentational contract: given a board response, does the UI keep "cannot see" and "nothing to
 * report" visually distinct, and does it refuse to dress either as a success.
 *
 * `Link` is stubbed because `@tanstack/react-router`'s `useRouter` throws outside a `RouterProvider`;
 * routing is not what is under test here (the E2E spec covers it against the real router).
 */
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>
}));

const { BoardRow, BoardSummary, changeVisibilityUnknownOf, freezeVisibilityUnknownOf } =
  await import("./service-board");

const ORIGIN_DOMAIN_ID = "2c1d3e4f-5a6b-4c8d-9e0f-1a2b3c4d5e6f";
const REPLICA_CHANGE_ID = "5f6b4a2c-1d3e-4f8a-9b0c-2d4e6f8a0b1c";

/** The muted dash used for OBSERVED-and-empty. Exact markup, so it cannot be confused with the
 *  Layer-B placeholder dash (which carries a `title`) in the same row. */
const MUTED_DASH = '<span class="text-slate-400">—</span>';

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function renderRow(row: ServiceBoardRow): string {
  return renderToStaticMarkup(
    <table>
      <tbody>
        <BoardRow row={row} />
      </tbody>
    </table>
  );
}

function baseRow(name: string): ServiceBoardRow {
  return {
    component: { id: `id-${name}`, urn: `urn:scp:component:${name}`, name },
    latestChangeId: null,
    changeState: null,
    changeName: null,
    currentWave: null,
    waves: [],
    attention: { blocked: false, decisionId: null, awaitingApproval: false, emergency: false },
    activeFreeze: null,
    driver: null,
    unknownFields: []
  };
}

/** A row this instance DRIVES whose empties are real observations. */
const drivenRow: ServiceBoardRow = baseRow("checkout-web");

/** A row whose latest change is another domain's read-only replica: every detail field declared
 *  unobservable by the server (`coordination/service-board.ts`, not-driven-here branch). */
const replicaRow: ServiceBoardRow = {
  ...baseRow("checkout-worker"),
  latestChangeId: REPLICA_CHANGE_ID,
  changeName: "commander rollout",
  driver: { drivenHere: false, originDomainId: ORIGIN_DOMAIN_ID },
  unknownFields: [
    "changeState",
    "currentWave",
    "waves",
    "attention.blocked",
    "attention.decisionId",
    "attention.awaitingApproval",
    "attention.emergency",
    "activeFreeze"
  ]
};

/** A row with NO change found on a CHANGE-BLIND deployment — a peer's sync scope does not carry
 *  change objects, so "no active change" is not an observation (`scope-filter.ts`'s
 *  `scopeCarriesChangeObjects`). The board's most confident all-clear built on the least evidence. */
const changeBlindRow: ServiceBoardRow = {
  ...baseRow("checkout-cache"),
  unknownFields: [
    "latestChangeId",
    "changeState",
    "currentWave",
    "waves",
    "attention.blocked",
    "attention.decisionId",
    "attention.awaitingApproval",
    "attention.emergency"
  ]
};

describe("service board rendering: an unobservable field is never painted as a clean one", () => {
  it("marks every field the server declared unobservable on a not-driven-here row", () => {
    const html = renderRow(replicaRow);

    // Four cells, four markers: lifecycle state, current wave, wave strip, attention.
    expect(occurrences(html, 'data-testid="board-unknown"')).toBe(4);
    expect(html).toContain("unknown here");
    expect(html).toContain('data-testid="board-not-driven-here"');
    expect(html).toContain('data-driven-here="false"');
    // "unknown", never a machine-readable NOT-BLOCKED assertion over a field in unknownFields.
    expect(html).toContain('data-blocked="unknown"');
    expect(html).not.toContain('data-blocked="false"');
  });

  it("keeps the muted dash for a row this instance drives, whose empties ARE observations", () => {
    const html = renderRow(drivenRow);

    // THE WHOLE POINT: the two rows must not look alike. Same all-false attention on the wire as
    // the replica row above — and here it renders as a dash, because here it is a fact.
    expect(occurrences(html, 'data-testid="board-unknown"')).toBe(0);
    expect(html).toContain(MUTED_DASH);
    expect(html).toContain('data-testid="board-no-change"');
    expect(html).toContain('data-blocked="false"');
    expect(html).toContain('data-driven-here="true"');
  });

  it("refuses to render 'no active change' when change visibility itself is unobservable", () => {
    const html = renderRow(changeBlindRow);

    // The empty latest-change cell becomes an explicit unknown; four markers either way,
    // never the reassuring "no active change".
    expect(html).not.toContain('data-testid="board-no-change"');
    expect(occurrences(html, 'data-testid="board-unknown"')).toBe(4);
    expect(html).toContain('data-blocked="unknown"');
    // ...and no muted dash sneaks back in as a substitute for the marker.
    expect(html).not.toContain(MUTED_DASH);
  });
});

describe("service board summary: an unassessable count is never dressed as a success", () => {
  const summary: ServiceBoardSummary = { releasing: 0, blocked: 0, stable: 1, notDrivenHere: 1 };

  /** The badge markup for one stat, from the strip's rendered HTML. The Badge primitive renders a
   *  `<div class="…">` inside the stat container, so the slice from the stat's testid to the end of
   *  that stat's container carries its variant classes. */
  function statMarkup(html: string, testid: string): string {
    const start = html.indexOf(`data-testid="${testid}"`);
    expect(start, `stat ${testid} is rendered`).toBeGreaterThan(-1);
    const end = html.indexOf("</div></div>", start);
    return html.slice(start, end === -1 ? undefined : end);
  }

  it("styles 'Not driven here' differently from 'Stable' — asserted differentially", () => {
    const html = renderToStaticMarkup(<BoardSummary summary={summary} stableUnknown={false} />);

    // The premise is asserted too: if the success styling itself were renamed, this test must fail
    // rather than pass vacuously.
    expect(statMarkup(html, "board-summary-stable"), "premise: Stable really is the success variant")
      .toContain("bg-green-600");
    expect(statMarkup(html, "board-summary-not-driven-here")).not.toContain("bg-green-600");
    expect(html).toContain(">Not driven here</div>");
  });

  it("drops the success styling from 'Stable' when the server declares the count unobservable", () => {
    const html = renderToStaticMarkup(<BoardSummary summary={summary} stableUnknown={true} />);

    // On a change-blind deployment the stable count mixes settled components with components whose
    // change was simply never sent — a green badge over it is the fabricated all-clear in its
    // purest form.
    expect(statMarkup(html, "board-summary-stable")).not.toContain("bg-green-600");
    expect(html).not.toContain("bg-green-600");
  });

  // THE WIRING, not just the components it feeds. `stableUnknown` and the caveat banner are only as
  // honest as the predicate that derives them from the server's `unknownFields`. That derivation was
  // an inline `.includes("summary.stable")` — a line a later edit could change with nothing failing,
  // silently retiring the caveat. These pin the field names themselves.
  it("derives change-visibility blindness from the server's declaration, by exact field name", () => {
    expect(changeVisibilityUnknownOf({ unknownFields: ["summary.stable"] })).toBe(true);
    expect(changeVisibilityUnknownOf({ unknownFields: [] })).toBe(false);
    // Must NOT be satisfied by a neighbouring unknown — the two board-level caveats are independent,
    // and a freeze-blind instance is not thereby change-blind.
    expect(changeVisibilityUnknownOf({ unknownFields: ["rows[].activeFreeze"] })).toBe(false);
  });

  it("derives freeze-visibility blindness independently, by exact field name", () => {
    expect(freezeVisibilityUnknownOf({ unknownFields: ["rows[].activeFreeze"] })).toBe(true);
    expect(freezeVisibilityUnknownOf({ unknownFields: ["summary.stable"] })).toBe(false);
    expect(freezeVisibilityUnknownOf({ unknownFields: [] })).toBe(false);
  });
});
