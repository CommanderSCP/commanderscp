import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Freeze, InstanceFreeze } from "@scp/schemas";

/**
 * G5 (`docs/proposals/outpost-ui.md` §4 close, owner decision 2026-08-13) — the setup landing.
 *
 * `Link` is stubbed as a bare `<a href>` (the `outposts-honesty.test.tsx` house pattern): every
 * link on this page is a STATIC destination (no `params`), so the simpler stub — the one
 * `service-board-honesty.test.tsx`/`outposts-honesty.test.tsx` use, not `domain-local.test.tsx`'s
 * param-interpolating one — is the honest fit here.
 */
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ to, children }: { to?: string; children?: React.ReactNode }) => (
    <a href={to}>{children}</a>
  )
}));

const {
  buildChecklistRows,
  buildCreateFreezePayload,
  buildUpdateWindowPayload,
  toDatetimeLocalValue,
  activeAndUpcomingFreezes,
  freezeWindowStatus,
  platformFreezeMatchLabel,
  DeclareFreezeForm,
  emptyFreezeForm,
  FreezeRow,
  PlatformFreezeCard,
  PlatformFreezeRow,
  SetupChecklistCard
} = await import("./setup");

function elementByTestId(html: string, testId: string): string {
  const attr = html.indexOf(`data-testid="${testId}"`);
  expect(attr, `no element carries data-testid="${testId}"`).toBeGreaterThanOrEqual(0);
  const open = html.lastIndexOf("<", attr);
  const tag = /^<([a-zA-Z0-9-]+)/.exec(html.slice(open))?.[1];
  if (!tag) throw new Error(`could not read the tag name for data-testid="${testId}"`);
  const scan = new RegExp(`<${tag}(?=[\\s/>])|</${tag}>`, "g");
  scan.lastIndex = open;
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = scan.exec(html)) !== null) {
    depth += match[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(open, match.index + match[0].length);
  }
  throw new Error(`unbalanced <${tag}> around data-testid="${testId}"`);
}

// -------------------------------------------------------------------------------------------
// Checklist: the honesty math (pure), then the rendering (real destinations + no fabricated 0s).
// -------------------------------------------------------------------------------------------

describe("buildChecklistRows — the honesty math behind every count", () => {
  it("a row whose call hasn't answered yet reports an UNDEFINED count, never a fabricated 0", () => {
    const rows = buildChecklistRows({});
    for (const row of rows) expect(row.count).toBeUndefined();
  });

  it("execution systems / deployment targets: plain counts off the list call's own items", () => {
    const rows = buildChecklistRows({
      executionSystems: { items: [{}, {}, {}] },
      deploymentTargets: { items: [{}] }
    });
    expect(rows.find((r) => r.key === "execution-systems")?.count).toBe(3);
    expect(rows.find((r) => r.key === "deployment-targets")?.count).toBe(1);
  });

  it("placements: shows the raw count plus a hint naming targets — and explicitly disclaims being an unplaced-components count", () => {
    const rows = buildChecklistRows({
      deploymentTargets: { items: [{}, {}, {}, {}] },
      placements: { items: [{}, {}, {}, {}, {}, {}, {}] }
    });
    const row = rows.find((r) => r.key === "placements")!;
    expect(row.count).toBe(7);
    expect(row.hint).toContain("across 4 deployment targets");
    expect(row.hint).toMatch(/not a count of components still missing one/i);
  });

  it("placements hint pluralizes a single target correctly (copy rule 6)", () => {
    const rows = buildChecklistRows({
      deploymentTargets: { items: [{}] },
      placements: { items: [] }
    });
    expect(rows.find((r) => r.key === "placements")?.hint).toContain(
      "across 1 deployment target —"
    );
  });

  it("placements hint is ABSENT while targets haven't loaded — never claims 'across 0'", () => {
    const rows = buildChecklistRows({ placements: { items: [{}] } });
    expect(rows.find((r) => r.key === "placements")?.hint).toBeUndefined();
  });

  it("domain-local: counts the CLIENT-SIDE filter over the fetched sample, labeled 'of the first N'", () => {
    const rows = buildChecklistRows({
      componentsSample: {
        items: [
          { domainLocal: true },
          { domainLocal: false },
          { domainLocal: true },
          { domainLocal: false },
          { domainLocal: false }
        ]
      }
    });
    const row = rows.find((r) => r.key === "domain-local")!;
    expect(row.count).toBe(2);
    expect(row.hint).toBe("of the first 5 components fetched");
  });

  it("domain-local hint is absent while the sample hasn't loaded (loading != a labeled zero)", () => {
    const rows = buildChecklistRows({});
    expect(rows.find((r) => r.key === "domain-local")?.hint).toBeUndefined();
  });

  it("source mappings: the total is withheld until EVERY kind has resolved — no partial under-report", () => {
    const rows = buildChecklistRows({
      sourceMappingCounts: { github: 3 } /* gitea/gitlab missing */
    });
    // Caller (SetupPage) only ever passes `sourceMappingCounts` once every kind resolved — but this
    // pure function still reduces over MISSING keys as 0 rather than throwing, so a caller mistake
    // degrades to an undercount instead of a crash. The intended, fully-resolved shape is asserted
    // in the next case.
    expect(rows.find((r) => r.key === "source-mappings")?.count).toBe(3);
  });

  it("source mappings: total sums every kind and the hint breaks each one out by name", () => {
    const rows = buildChecklistRows({ sourceMappingCounts: { github: 3, gitea: 1, gitlab: 0 } });
    const row = rows.find((r) => r.key === "source-mappings")!;
    expect(row.count).toBe(4);
    expect(row.hint).toBe("3 github · 1 gitea · 0 gitlab");
  });

  it("every row's destination is a REAL, routable surface — not `/connect/$kind` with no kind, not a page that doesn't exist", () => {
    const rows = buildChecklistRows({});
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.to]));
    expect(byKey["execution-systems"]).toBe("/connect/argocd");
    expect(byKey["deployment-targets"]).toBe("/deployment-targets");
    expect(byKey["placements"]).toBe("/components");
    expect(byKey["domain-local"]).toBe("/components");
    expect(byKey["source-mappings"]).toBe("/components");
  });
});

describe("SetupChecklistCard — rendering", () => {
  it("renders each row's count from the data it was handed, and each row's link resolves to its real destination href", () => {
    const html = renderToStaticMarkup(
      <SetupChecklistCard
        data={{
          executionSystems: { items: [{}, {}] },
          deploymentTargets: { items: [{}, {}, {}] },
          placements: { items: [{}] },
          componentsSample: { items: [{ domainLocal: true }, { domainLocal: false }] },
          sourceMappingCounts: { github: 2, gitea: 0, gitlab: 1 }
        }}
      />
    );

    const execRow = elementByTestId(html, "setup-row-execution-systems");
    expect(execRow).toContain('href="/connect/argocd"');
    expect(elementByTestId(execRow, "setup-row-execution-systems-count")).toContain(">2<");

    const targetsRow = elementByTestId(html, "setup-row-deployment-targets");
    expect(targetsRow).toContain('href="/deployment-targets"');
    expect(elementByTestId(targetsRow, "setup-row-deployment-targets-count")).toContain(">3<");

    const placementsRow = elementByTestId(html, "setup-row-placements");
    expect(placementsRow).toContain('href="/components"');
    expect(elementByTestId(placementsRow, "setup-row-placements-count")).toContain(">1<");

    const domainLocalRow = elementByTestId(html, "setup-row-domain-local");
    expect(domainLocalRow).toContain('href="/components"');
    expect(elementByTestId(domainLocalRow, "setup-row-domain-local-count")).toContain(">1<");
    expect(domainLocalRow).toContain("of the first 2 components fetched");

    const mappingsRow = elementByTestId(html, "setup-row-source-mappings");
    expect(mappingsRow).toContain('href="/components"');
    expect(elementByTestId(mappingsRow, "setup-row-source-mappings-count")).toContain(">3<");
    expect(mappingsRow).toContain("2 github");
  });

  it("a row with no data yet renders a skeleton placeholder, never a fabricated 0", () => {
    const html = renderToStaticMarkup(<SetupChecklistCard data={{}} />);
    const execRow = elementByTestId(html, "setup-row-execution-systems");
    expect(execRow).not.toContain('data-testid="setup-row-execution-systems-count"');
    expect(execRow).toContain("animate-pulse");
  });
});

// -------------------------------------------------------------------------------------------
// Freeze card — active/upcoming filtering, the no-early-lift claim, and the create form's field
// census against `CreateFreezeRequestSchema`.
// -------------------------------------------------------------------------------------------

describe("freezeWindowStatus / activeAndUpcomingFreezes", () => {
  const NOW = new Date("2026-08-13T12:00:00.000Z");
  function freeze(overrides: Partial<Freeze>): Freeze {
    return {
      id: "6f0a1b2c-3d4e-4f50-8161-728394a5b6c7",
      scopeObjectId: "0c1d2e3f-4a5b-4c6d-8e9f-a0b1c2d3e4f5",
      name: null,
      startsAt: "2026-08-13T00:00:00.000Z",
      endsAt: "2026-08-14T00:00:00.000Z",
      reason: "maintenance",
      atomic: false,
      liftedAt: null,
      liftedByActorId: null,
      liftReason: null,
      createdByActorId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      createdAt: "2026-08-12T00:00:00.000Z",
      // M25.7 — a freeze declared HERE and nowhere else, which is the default. Window status is
      // computed from `startsAt`/`endsAt` alone and is deliberately blind to federation: an imported
      // freeze is active in exactly the same window as a locally-declared one.
      objectId: null,
      ...overrides
    };
  }

  it("classifies upcoming / active / past off startsAt/endsAt", () => {
    expect(
      freezeWindowStatus(
        freeze({ startsAt: "2026-08-20T00:00:00.000Z", endsAt: "2026-08-21T00:00:00.000Z" }),
        NOW
      )
    ).toBe("upcoming");
    expect(
      freezeWindowStatus(
        freeze({ startsAt: "2026-08-13T00:00:00.000Z", endsAt: "2026-08-14T00:00:00.000Z" }),
        NOW
      )
    ).toBe("active");
    expect(
      freezeWindowStatus(
        freeze({ startsAt: "2026-08-01T00:00:00.000Z", endsAt: "2026-08-02T00:00:00.000Z" }),
        NOW
      )
    ).toBe("past");
  });

  it("drops PAST freezes and sorts the rest soonest-first", () => {
    const upcoming = freeze({
      id: "11111111-1111-4111-8111-111111111111",
      startsAt: "2026-09-01T00:00:00.000Z",
      endsAt: "2026-09-02T00:00:00.000Z"
    });
    const active = freeze({
      id: "22222222-2222-4222-8222-222222222222",
      startsAt: "2026-08-13T00:00:00.000Z",
      endsAt: "2026-08-14T00:00:00.000Z"
    });
    const past = freeze({
      id: "33333333-3333-4333-8333-333333333333",
      startsAt: "2026-01-01T00:00:00.000Z",
      endsAt: "2026-01-02T00:00:00.000Z"
    });
    const result = activeAndUpcomingFreezes([upcoming, past, active], NOW);
    expect(result.map((f) => f.id)).toEqual([active.id, upcoming.id]);
  });
});

describe("FreezeRow — the lift claim, and the state a lift leaves behind", () => {
  const ROW_FREEZE: Freeze = {
    id: "6f0a1b2c-3d4e-4f50-8161-728394a5b6c7",
    scopeObjectId: "0c1d2e3f-4a5b-4c6d-8e9f-a0b1c2d3e4f5",
    name: "code freeze",
    startsAt: "2026-08-13T00:00:00.000Z",
    endsAt: "2026-08-20T00:00:00.000Z",
    reason: "quarter close",
    createdByActorId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    createdAt: "2026-08-12T00:00:00.000Z",
    atomic: false,
    liftedAt: null,
    liftedByActorId: null,
    liftReason: null,
    // M25.7 — a locally-declared, non-federating freeze: the one an operator on THIS instance can
    // actually lift. (A freeze whose object is a foreign replica is refused with a 409 by
    // `freezes-repo.ts`'s `lockFreezeRow`; rendering that distinction is the UI session's.)
    objectId: null
  };

  // DELIBERATE INVERSION (M25.1). Until `DELETE /api/v1/freezes/{id}` shipped, these two cases
  // pinned the OPPOSITE claim: that the tooltip said "no early-lift or delete control yet" and
  // that a freeze row contained no `<button>` at all. That reasoning was CORRECT for the server it
  // was written against — the API genuinely had create/list/get and nothing else, and pinning the
  // absence stopped the UI from implying a control that did not exist. M25.1 made it false, so the
  // pins are flipped in the same change that wires the control, never before and never after.
  //
  // Non-vacuity: revert `LIFT_SENTENCE` to the retired wording and the first case goes red; drop
  // the `onLift` branch from `FreezeRow` and the second goes red.
  it("states, in the row's own tooltip, that the freeze can be lifted early and that a reason is needed", () => {
    const html = renderToStaticMarkup(
      <FreezeRow freeze={ROW_FREEZE} now={new Date("2026-08-14T00:00:00.000Z")} />
    );
    expect(html).toMatch(/unless it is lifted early/i);
    expect(html).toMatch(/needs a reason/i);
    expect(html).not.toMatch(/no early-lift or delete control yet/i);
  });

  it("offers no lift control when the caller passes no `onLift` — a read-only render stays read-only", () => {
    const html = renderToStaticMarkup(
      <FreezeRow freeze={ROW_FREEZE} now={new Date("2026-08-14T00:00:00.000Z")} />
    );
    expect(html).not.toContain("<button");
  });

  it("offers Lift, with a REQUIRED reason field, when `onLift` is supplied", () => {
    const html = renderToStaticMarkup(
      <FreezeRow
        freeze={ROW_FREEZE}
        now={new Date("2026-08-14T00:00:00.000Z")}
        onLift={() => undefined}
      />
    );
    expect(html).toContain("<button");
    expect(html).toContain("freeze-lift-reason-input");
    expect(html).toMatch(/required/);
  });

  it("a LIFTED freeze reads as lifted, keeps its row, and stops offering Lift", () => {
    const html = renderToStaticMarkup(
      <FreezeRow
        freeze={{
          ...ROW_FREEZE,
          liftedAt: "2026-08-15T09:00:00.000Z",
          liftedByActorId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
          liftReason: "incident resolved"
        }}
        now={new Date("2026-08-16T00:00:00.000Z")}
        onLift={() => undefined}
      />
    );
    // The row SURVIVES the lift: the reason and instant are the record an operator came back for,
    // and a `freeze_admission` Decision still cites this freeze's id (charter principle 6).
    expect(html).toContain("Lifted");
    expect(html).toContain("incident resolved");
    // ...and offers no second lift.
    expect(html).not.toContain("<button");
  });

  it("`freezeWindowStatus` lets a lift OUTRANK the window — a lifted-but-unexpired freeze is not `active`", () => {
    const midWindow = new Date("2026-08-14T00:00:00.000Z");
    expect(freezeWindowStatus(ROW_FREEZE, midWindow)).toBe("active");
    expect(
      freezeWindowStatus({ ...ROW_FREEZE, liftedAt: "2026-08-13T12:00:00.000Z" }, midWindow)
    ).toBe("lifted");
  });

  it("an untitled freeze (nullable `name`) still renders, never crashes or drops the row", () => {
    const html = renderToStaticMarkup(
      <FreezeRow
        freeze={{ ...ROW_FREEZE, name: null }}
        now={new Date("2026-08-14T00:00:00.000Z")}
      />
    );
    expect(html).toContain("Untitled freeze");
  });
});

describe("buildCreateFreezePayload", () => {
  it("converts <input type=datetime-local> values to ISO instants and trims the reason/scope", () => {
    const payload = buildCreateFreezePayload({
      scopeObjectId: "  urn:scp:default:domain:amer  ",
      name: "",
      startsAt: "2026-08-20T09:30",
      endsAt: "2026-08-21T09:30",
      reason: "  release freeze  ",
      atomic: false
    });
    expect(payload.scopeObjectId).toBe("urn:scp:default:domain:amer");
    expect(payload.reason).toBe("release freeze");
    expect(payload.startsAt).toBe(new Date("2026-08-20T09:30").toISOString());
    expect(payload.endsAt).toBe(new Date("2026-08-21T09:30").toISOString());
    // `name` optional per `CreateFreezeRequestSchema` — a blank field must be OMITTED, not sent
    // as an empty string (the schema's own convention every other omit-blank form here follows).
    expect("name" in payload).toBe(false);
  });

  it("keeps a non-blank name", () => {
    const payload = buildCreateFreezePayload({
      ...emptyFreezeForm(),
      startsAt: "2026-08-20T09:30",
      endsAt: "2026-08-21T09:30",
      reason: "x",
      name: "  quarter close  "
    });
    expect(payload.name).toBe("quarter close");
  });
});

describe("DeclareFreezeForm — exactly CreateFreezeRequest's fields, nothing invented", () => {
  function render(): string {
    return renderToStaticMarkup(
      <DeclareFreezeForm
        value={emptyFreezeForm()}
        onChange={() => {}}
        onSubmit={() => {}}
        pending={false}
      />
    );
  }

  it("has one field per CreateFreezeRequestSchema key: scopeObjectId, name, startsAt, endsAt, reason, atomic", () => {
    const html = render();
    expect(html).toContain('data-testid="freeze-scope-input"');
    expect(html).toContain('data-testid="freeze-name-input"');
    expect(html).toContain('data-testid="freeze-starts-input"');
    expect(html).toContain('data-testid="freeze-ends-input"');
    expect(html).toContain('data-testid="freeze-reason-input"');
    expect(html).toContain('data-testid="freeze-atomic-input"');
    // Census, not a spot check: exactly 5 <input>s and 1 <textarea> — a seventh field (e.g. a role
    // or scope-TYPE picker) would fail this even if it carried no testid at all.
    //
    // The count moved 4 -> 5 with M25.2's `atomic`, and the count is the POINT of this case: it is
    // what makes the form's field set track `CreateFreezeRequestSchema` rather than drift from it.
    // `atomic` is a real key on that schema, so it belongs here; bumping the number is the correct
    // response, and inventing a field that is NOT on the schema still fails.
    //
    // M25.7 ADDED TWO SCHEMA KEYS AND THIS COUNT DELIBERATELY DID NOT MOVE — recorded rather than
    // left to be rediscovered as drift. `federate` and `domainLocal` are gated on `federation:write`
    // at the freeze's scope, not on the `freeze:write` this page's audience holds, and this form has
    // no way to know whether the viewer holds it; an inert checkbox that 403s on submit is worse
    // than no checkbox. Freeze authoring UI is the UI session's surface (coordinated in
    // docs/proposals/campaigns-rework.md §2.3), and `scp freeze create --federate` is the door until
    // then. So the invariant this case pins is now "one field per schema key the form OFFERS, and no
    // field that is not on the schema" — inventing an off-schema field still fails, and adding
    // `federate` later means bumping this to 6 with a testid above.
    expect((html.match(/<input\b/g) ?? []).length).toBe(5);
    expect((html.match(/<textarea\b/g) ?? []).length).toBe(1);
  });

  // DELIBERATE INVERSION (M25.1) — the retired pin asserted this field said "no early lift yet",
  // which was true until `DELETE /api/v1/freezes/{id}` shipped. The disclaimer's PURPOSE survives
  // the inversion and is what is re-pinned here: the declare-time copy must still tell the operator
  // what the end time actually means, rather than going silent because the old sentence went stale.
  it("the ends field states, at declare time, that the window can be cut short — not just after the fact", () => {
    const html = render();
    expect(html).toMatch(/unless lifted early/i);
    expect(html).not.toMatch(/no early lift yet/i);
  });

  it("offers `atomic` OFF by default — per-target admission is the normal behaviour", () => {
    const html = render();
    // An unchecked checkbox renders without the `checked` attribute; the payload builder is what
    // actually carries the value, and `buildCreateFreezePayload` is pinned separately below.
    expect(html).toContain('data-testid="freeze-atomic-input"');
    expect(html).not.toMatch(/data-testid="freeze-atomic-input"[^>]*checked/);
  });

  it("offers exactly one control: the submit button — no separate lift/delete/edit affordance", () => {
    const html = render();
    expect((html.match(/<button\b/g) ?? []).length).toBe(1);
    expect(html).toContain("Declare freeze");
  });

  it("renders the server's refusal verbatim when the mutation errors, with no invented decision_id link", () => {
    const html = renderToStaticMarkup(
      <DeclareFreezeForm
        value={emptyFreezeForm()}
        onChange={() => {}}
        onSubmit={() => {}}
        pending={false}
        error={new Error("freeze endsAt must be after startsAt")}
      />
    );
    expect(html).toContain('data-testid="declare-freeze-error"');
    expect(html).toContain("freeze endsAt must be after startsAt");
  });
});

// -------------------------------------------------------------------------------------------
// FreezeRow — the window-edit control (M25.UI increment 3, PATCH /freezes/{id}).
// -------------------------------------------------------------------------------------------

describe("FreezeRow — 'Adjust window'", () => {
  const ROW_FREEZE: Freeze = {
    id: "6f0a1b2c-3d4e-4f50-8161-728394a5b6c7",
    scopeObjectId: "0c1d2e3f-4a5b-4c6d-8e9f-a0b1c2d3e4f5",
    name: "code freeze",
    startsAt: "2026-08-13T00:00:00.000Z",
    endsAt: "2026-08-20T00:00:00.000Z",
    reason: "quarter close",
    createdByActorId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    createdAt: "2026-08-12T00:00:00.000Z",
    atomic: false,
    liftedAt: null,
    liftedByActorId: null,
    liftReason: null,
    // M25.7 (D6) — `null` is the HONEST value here, not merely the one that compiles: this fixture
    // never declared `federate: true`, so no `freeze` graph object exists for it, and `objectId` is
    // precisely "does a wire form of this freeze exist". The control under test is the WINDOW edit,
    // which federation does not change.
    objectId: null
  };
  const NOW = new Date("2026-08-14T00:00:00.000Z");

  it("offers no window-edit control when the caller passes no `onUpdateWindow` — read-only stays read-only", () => {
    const html = renderToStaticMarkup(<FreezeRow freeze={ROW_FREEZE} now={NOW} />);
    expect(html).not.toContain('data-testid="freeze-window-toggle"');
  });

  it("offers the 'Adjust window' toggle when `onUpdateWindow` is supplied, on an UNLIFTED row", () => {
    const html = renderToStaticMarkup(
      <FreezeRow freeze={ROW_FREEZE} now={NOW} onUpdateWindow={() => undefined} />
    );
    expect(html).toContain('data-testid="freeze-window-toggle"');
    expect(html).toContain("Adjust window");
    // Collapsed by default — the form itself is not in the DOM until toggled.
    expect(html).not.toContain('data-testid="freeze-window-form"');
  });

  it("does NOT offer the toggle on a LIFTED row, even with `onUpdateWindow` supplied", () => {
    const html = renderToStaticMarkup(
      <FreezeRow
        freeze={{ ...ROW_FREEZE, liftedAt: "2026-08-15T00:00:00.000Z", liftReason: "resolved" }}
        now={new Date("2026-08-16T00:00:00.000Z")}
        onUpdateWindow={() => undefined}
      />
    );
    expect(html).not.toContain('data-testid="freeze-window-toggle"');
  });

  it("`buildUpdateWindowPayload` converts the local datetime value and trims the reason — mandatory reason enforced client-side like Lift", () => {
    const payload = buildUpdateWindowPayload("2026-08-25T09:30", "  incident over  ");
    expect(payload.endsAt).toBe(new Date("2026-08-25T09:30").toISOString());
    expect(payload.reason).toBe("incident over");
  });

  it("`toDatetimeLocalValue` round-trips through `Date` — the field an operator sees is the field submitted", () => {
    const local = toDatetimeLocalValue("2026-08-20T09:30:00.000Z");
    // Not asserting an exact clock-dependent string (the conversion is LOCAL time, which varies by
    // CI timezone) — asserting the round trip: re-parsing what was rendered reproduces the same
    // instant `Date` would parse it as, which is exactly what the submit handler does downstream.
    expect(new Date(local).getTime()).toBe(new Date("2026-08-20T09:30:00.000Z").getTime());
  });
});

// -------------------------------------------------------------------------------------------
// Platform freezes card (M25.UI increment 3) — read-only, structural match-coordinate rendering,
// retracted state, and the CLI/HTTP pointer.
// -------------------------------------------------------------------------------------------

describe("platformFreezeMatchLabel", () => {
  it("renders 'All environments' for a deployment-wide match", () => {
    expect(
      platformFreezeMatchLabel({ allEnvironments: true, environment: null, region: null })
    ).toBe("All environments");
  });

  it("renders 'environment (every region)' when no region narrows it", () => {
    expect(
      platformFreezeMatchLabel({ allEnvironments: false, environment: "prod", region: null })
    ).toBe("prod (every region)");
  });

  it("renders 'environment / region' when narrowed", () => {
    expect(
      platformFreezeMatchLabel({ allEnvironments: false, environment: "prod", region: "amer" })
    ).toBe("prod / amer");
  });
});

describe("PlatformFreezeRow", () => {
  const PLATFORM_FREEZE: InstanceFreeze = {
    id: "7a8b9c0d-1e2f-4a3b-9c4d-5e6f7a8b9c0d",
    key: "incident-2026-08",
    name: "incident freeze",
    startsAt: "2026-08-13T00:00:00.000Z",
    endsAt: "2026-08-20T00:00:00.000Z",
    reason: "platform-wide incident",
    match: { allEnvironments: true, environment: null, region: null },
    atomic: true,
    overridable: false,
    note: null,
    liftedAt: null,
    liftReason: null,
    updatedAt: "2026-08-13T00:00:00.000Z"
  };
  const NOW = new Date("2026-08-14T00:00:00.000Z");

  it("renders key, name, match coordinate, window, reason, and the atomic/overridable badges", () => {
    const html = renderToStaticMarkup(<PlatformFreezeRow freeze={PLATFORM_FREEZE} now={NOW} />);
    expect(html).toContain("incident-2026-08");
    expect(html).toContain("incident freeze");
    expect(html).toContain("All environments");
    expect(html).toContain("atomic");
    // `overridable: false` on this fixture — its badge must NOT render.
    expect(html).not.toContain(">overridable<");
    expect(html).toContain("platform-wide incident");
  });

  it("an untitled freeze (nullable `name`) still renders as 'Untitled', never crashes or drops the row", () => {
    const html = renderToStaticMarkup(
      <PlatformFreezeRow freeze={{ ...PLATFORM_FREEZE, name: null }} now={NOW} />
    );
    expect(html).toContain("Untitled");
  });

  it("a RETRACTED row renders distinctly — never disappears, never confused with an active one", () => {
    const html = renderToStaticMarkup(
      <PlatformFreezeRow
        freeze={{
          ...PLATFORM_FREEZE,
          liftedAt: "2026-08-15T00:00:00.000Z",
          liftReason: "incident resolved early"
        }}
        now={new Date("2026-08-16T00:00:00.000Z")}
      />
    );
    expect(html).toContain('data-testid="platform-freeze-lifted-note"');
    expect(html).toContain("incident resolved early");
    expect(html).toContain("Lifted");
    // Still no write control anywhere on this row — it is read-only regardless of lift state.
    expect(html).not.toContain("<button");
  });

  it("renders no `<button>` ever — this card is read-only by construction", () => {
    const html = renderToStaticMarkup(<PlatformFreezeRow freeze={PLATFORM_FREEZE} now={NOW} />);
    expect(html).not.toContain("<button");
  });
});

describe("PlatformFreezeCard — the empty state and the operator's CLI/HTTP pointer", () => {
  const NOW = new Date("2026-08-14T00:00:00.000Z");

  it("renders the empty state without error when the list is empty — not conflated with 'still loading'", () => {
    const html = renderToStaticMarkup(
      <PlatformFreezeCard freezes={[]} isLoading={false} isError={false} now={NOW} />
    );
    expect(html).toContain("No platform freezes declared.");
    expect(html).not.toContain('data-testid="platform-freeze-row"');
    // The CLI pointer still renders beneath an empty list — an operator reading an empty card is
    // exactly who needs to be told where the write door is.
    expect(html).toContain('data-testid="platform-freeze-cli-pointer"');
  });

  it("renders a loading skeleton, never the empty-state honesty text, while the call is in flight", () => {
    const html = renderToStaticMarkup(
      <PlatformFreezeCard freezes={undefined} isLoading={true} isError={false} now={NOW} />
    );
    expect(html).not.toContain("No platform freezes declared.");
    expect(html).toContain("animate-pulse");
  });

  it("renders the server's refusal verbatim through QueryErrorNotice on error", () => {
    const html = renderToStaticMarkup(
      <PlatformFreezeCard
        freezes={undefined}
        isLoading={false}
        isError={true}
        error={new Error("upstream unavailable")}
        now={NOW}
      />
    );
    expect(html).toContain('data-testid="platform-freezes-error"');
    expect(html).toContain("upstream unavailable");
  });

  it("the CLI-pointer copy is pinned: both routes, both methods, and the operator-token header, never a browser-write claim", () => {
    const html = renderToStaticMarkup(
      <PlatformFreezeCard freezes={[]} isLoading={false} isError={false} now={NOW} />
    );
    expect(html).toContain("Operator-only, never a browser write");
    expect(html).toContain("PUT /v1/instance/freezes/{key}");
    expect(html).toContain("DELETE /v1/instance/freezes/{key}");
    expect(html).toContain("x-scp-operator-token");
    // No pressable write control anywhere on this card, in any query state.
    expect(html).not.toContain("<button");
  });
});

// -------------------------------------------------------------------------------------------
// The role-gating census (outpost-ui.md §2 / CLAUDE.md's property-census rule): this page must
// never key ANY rendering decision on the instance's federation role. A source-level assertion,
// same spirit as replica-origin's own census tests — here it's the file's own text rather than a
// derived predicate, because "reads federation.self" has no runtime signal to assert on short of
// grepping the source.
// -------------------------------------------------------------------------------------------

describe("setup.tsx never reads the instance's federation role", () => {
  it("the source contains no federation.self / federationSelfKey / role-branch usage", () => {
    const source = readFileSync(fileURLToPath(new URL("./setup.tsx", import.meta.url)), "utf-8");
    expect(source).not.toMatch(/federation\.self/);
    expect(source).not.toMatch(/federationSelfKey/);
    expect(source).not.toMatch(/SCP_FEDERATION_ROLE/);
    expect(source).not.toMatch(/role\s*===\s*["'](commander|outpost|retrans)["']/);
  });
});
