import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  ServiceBoardAsOf,
  ServiceBoardAssembly,
  ServiceBoardRow,
  ServiceBoardSummary
} from "@scp/sdk";

/** The rendering half of the board's federation-honesty rule. See docs/web.md §470. */
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>
}));

const {
  BoardAsOfLabel,
  BoardAssemblies,
  BoardRow,
  PipelineChips,
  BoardSummary,
  changeVisibilityUnknownOf,
  freezeVisibilityUnknownOf
} = await import("./service-board");

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
    pipelines: [],
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
    // "none", NOT "true". This fixture's `driver` is null. See docs/web.md §471.
    expect(html).toContain('data-driven-here="none"');
    expect(html).not.toContain('data-driven-here="true"');
  });

  it("distinguishes NO DRIVER from a driver that IS this domain — three states, not two", () => {
    const locallyDriven: ServiceBoardRow = {
      ...baseRow("checkout-api"),
      latestChangeId: "0c3f8a1e-2b4d-4c6f-8a90-1b2c3d4e5f60",
      changeName: "local rollout",
      driver: { drivenHere: true, originDomainId: null }
    };
    const noDriver = renderRow(drivenRow);
    const driven = renderRow(locallyDriven);

    expect(driven).toContain('data-driven-here="true"');
    expect(noDriver).toContain('data-driven-here="none"');
    // PREMISE: the distinction is the attribute's, not a side effect of the rows differing anyway.
    expect(driven).not.toContain('data-driven-here="none"');
    // ...and neither is the not-driven-here case, which stays exactly as it was.
    expect(renderRow(replicaRow)).toContain('data-driven-here="false"');
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
    expect(
      statMarkup(html, "board-summary-stable"),
      "premise: Stable really is the success variant"
    ).toContain("bg-emerald-50");
    expect(statMarkup(html, "board-summary-not-driven-here")).not.toContain("bg-emerald-50");
    expect(html).toContain(">Not driven here</div>");
  });

  it("drops the success styling from 'Stable' when the server declares the count unobservable", () => {
    const html = renderToStaticMarkup(<BoardSummary summary={summary} stableUnknown={true} />);

    // On a change-blind deployment the stable count mixes settled components with components whose
    // change was simply never sent — a green badge over it is the fabricated all-clear in its
    // purest form.
    expect(statMarkup(html, "board-summary-stable")).not.toContain("bg-emerald-50");
    expect(html).not.toContain("bg-emerald-50");
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

  /** Y4 — THE X7 CLASS, CLOSED FOR `unknownFields` ITSELF. See docs/web.md §472. */
  it("a row with NO unknownFields key renders instead of killing the board", () => {
    const row: Partial<ServiceBoardRow> = baseRow("no-honesty-list");
    delete row.unknownFields;
    const html = renderRow(row as ServiceBoardRow);

    expect(html).toContain("no-honesty-list");
    // nothing is claimed unknown, because nothing was declared unknown
    expect(html).not.toContain('data-testid="board-unknown"');
  });

  it("the two board-level predicates treat an ABSENT list as no declaration, not as a crash", () => {
    const board = {} as { unknownFields: string[] };
    expect(changeVisibilityUnknownOf(board)).toBe(false);
    expect(freezeVisibilityUnknownOf(board)).toBe(false);
  });
});

/** The as-of label, and its paired ban on presenting stale. See docs/web.md §473. */
describe("a service whose components live in an assembly is never reported as empty", () => {
  const zero: ServiceBoardSummary = { releasing: 0, blocked: 0, stable: 0, notDrivenHere: 0 };

  /** `rows` is direct-children-only by decision. See docs/web.md §474. */
  it("qualifies the four zeroes instead of letting them read as 'nothing here'", () => {
    const html = renderToStaticMarkup(
      <BoardSummary summary={zero} stableUnknown={false} componentsBelowAssemblies={2} />
    );
    expect(html).toContain("board-summary-scope-note");
    expect(html).toMatch(/directly-held components only/);
    expect(html).toContain("2 more in");
  });

  it("adds NO qualifier when every component really is held directly", () => {
    const html = renderToStaticMarkup(
      <BoardSummary summary={zero} stableUnknown={false} componentsBelowAssemblies={0} />
    );
    expect(html).not.toContain("board-summary-scope-note");
    expect(html).not.toMatch(/directly-held components only/);
  });
});

describe("service board as-of label: a snapshot is never painted as live status", () => {
  const base = {
    peerDomainId: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
    peerName: "commander-1",
    at: "2026-07-25T11:59:55.000Z",
    ageSeconds: 5,
    expectedWithinSeconds: 60,
    // NOT the cadence — the age at which `stale` actually flips (cadence × the server's grace
    // factor). The two are different numbers and the tooltip must never present one as the other.
    staleAfterSeconds: 120
  };

  it("renders nothing at all for a single-domain board — there is no upstream to label", () => {
    expect(renderToStaticMarkup(<BoardAsOfLabel asOf={null} />)).toBe("");
  });

  it("a fresh upstream is a quiet timestamp, not a warning", () => {
    const html = renderToStaticMarkup(
      <BoardAsOfLabel asOf={{ ...base, via: "live-pull", stale: false }} />
    );
    expect(html).toContain("As of");
    expect(html).not.toContain("STALE");
    expect(html).toContain("commander-1");
    // An always-shouting label trains an operator to ignore the one case that matters.
    expect(html).not.toContain("text-amber-700");
  });

  it("an OVERDUE upstream says so in the label itself, not only in a tooltip", () => {
    const html = renderToStaticMarkup(
      <BoardAsOfLabel asOf={{ ...base, ageSeconds: 3600, via: "bundle", stale: true }} />
    );
    // Visible text, so it survives a reader who never hovers.
    expect(html).toContain("STALE");
    expect(html).toContain("text-amber-700");
  });

  /** THE TOOLTIP MUST NOT QUOTE THE CADENCE AS THE BOUND. See docs/web.md §475. */
  it("a not-overdue reading OLDER than one cadence states the real threshold, not the cadence", () => {
    const html = renderToStaticMarkup(
      <BoardAsOfLabel asOf={{ ...base, ageSeconds: 90, via: "live-pull", stale: false }} />
    );
    expect(html).toContain("120s");
    // ...and it is never claimed that 90s sits inside the 60s cadence.
    expect(html).not.toContain("Within commander-1&#x27;s effective sync cadence");
    expect(html).toMatch(/not counted late until 120s/);
    // The cadence is still shown, named as the cadence rather than as the bound.
    expect(html).toContain("effective sync cadence is 60s");
  });

  it("an AIR-GAPPED upstream (`stale: null`) still gets the label, and is never dressed as fresh", () => {
    const html = renderToStaticMarkup(
      <BoardAsOfLabel
        asOf={{
          ...base,
          ageSeconds: 604_800,
          via: "bundle",
          expectedWithinSeconds: null,
          staleAfterSeconds: null,
          stale: null
        }}
      />
    );
    // §13's whole bounded guarantee for an air-gapped domain IS this line.
    expect(html).toContain("As of");
    expect(html).toContain("bundle import");
    // `null` is not `false`: it must not be warned about, and it must not claim currency either.
    expect(html).not.toContain("STALE");
    expect(html).toContain("not live status");
  });

  /** Y3(b) — THE PIN THE `isAbsent` FIX NEVER GOT. See docs/web.md §476. */
  it("an OMITTED `stale` takes the no-schedule branch, NEVER the not-overdue reassurance", () => {
    const asOf: Partial<ServiceBoardAsOf> = {
      ...base,
      peerName: "amer-prod",
      ageSeconds: 10,
      staleAfterSeconds: 60,
      via: "bundle"
    };
    delete asOf.stale;
    const html = renderToStaticMarkup(<BoardAsOfLabel asOf={asOf as ServiceBoardAsOf} />);

    expect(html).toContain("no pull schedule");
    expect(html).toContain("not live status");
    // THE MUTANT'S OUTPUT — a freshness statement with nothing behind it
    expect(html).not.toContain("Not overdue");
    expect(html).not.toContain("not counted late until");
    // and an absent verdict is still not a STALE warning either
    expect(html).not.toContain("STALE");
  });
});

describe("a board row shows EVERY pipeline, not one status for all of them", () => {
  // Owner, 2026-08-04: the board's default job is the high-level state of the various pipelines. It
  // was change-anchored — one `latestChangeId` per component — so whichever pipeline moved most
  // recently spoke for all of them, and one that had never run looked like one that just succeeded.
  const withPipelines = (pipelines: ServiceBoardRow["pipelines"]) =>
    renderToStaticMarkup(<PipelineChips row={{ ...baseRow("svc-a"), pipelines }} />);

  it("keeps each pipeline's state separate", () => {
    const html = withPipelines([
      { category: "build", bound: true, status: "succeeded", changeId: null, bindings: [] },
      { category: "infrastructure", bound: true, status: "failed", changeId: null, bindings: [] },
      { category: "configuration", bound: true, status: null, changeId: null, bindings: [] }
    ]);
    expect(html).toContain("succeeded");
    expect(html).toContain("failed");
    expect(
      html,
      "a bound pipeline that has never run says so — it must not borrow a sibling's status"
    ).toContain("never run");
  });

  it("renders NOT BOUND rather than omitting the pipeline", () => {
    // An absent chip would read as "this board does not show infra", when the truth is that no
    // executor is bound for it — the same rule the component pipeline's lanes follow.
    const html = withPipelines([
      { category: "infrastructure", bound: false, status: null, changeId: null, bindings: [] }
    ]);
    expect(html).toContain("not bound");
    expect(html).toContain('data-bound="false"');
  });
});

/** The mutation log, each applied alone and then reverted. See docs/web.md §477. */
describe("an assembly child is shown, and its count is never dressed as a status", () => {
  // Before migration 0055 the board's child filter was `typeId === "component"`, so an assembly child
  // — and every component beneath it — was silently absent while the board still rendered. D3 chose
  // DIRECT children plus a per-child summary over flattening, so the count must appear AND the
  // assembly must stay out of the status columns.
  const render = (assemblies: ServiceBoardAssembly[]) =>
    renderToStaticMarkup(<BoardAssemblies assemblies={assemblies} />);

  const one = (over: Partial<ServiceBoardAssembly> = {}): ServiceBoardAssembly => ({
    id: "11111111-1111-1111-1111-111111111111",
    urn: "urn:scp:assembly:control-plane",
    name: "control-plane",
    componentCount: 7,
    ...over
  });

  it("names the assembly and its component count", () => {
    const html = render([one()]);
    expect(html).toContain("control-plane");
    expect(html, "the count is the summary D3 asked for").toContain("7 components");
    expect(html).toContain("Assemblies (1)");
  });

  it("renders NOTHING when there are none — an empty card would imply a level that isn't used", () => {
    // Deliberately unlike the pipeline chips, where an absent chip would read as "not shown here".
    expect(render([])).toBe("");
  });

  it("pluralises one component correctly, so the summary does not read as broken", () => {
    expect(render([one({ componentCount: 1 })])).toContain("1 component<");
  });

  it("shows a ZERO count as zero — an empty assembly is a real, reportable state", () => {
    // Not filtered out and not blank: an assembly with nothing under it is exactly the thing an
    // operator needs to see, and hiding it would repeat the absence bug one level down.
    const html = render([one({ componentCount: 0 })]);
    expect(html).toContain("control-plane");
    expect(html).toContain("0 components");
  });
});
