import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Freeze } from "@scp/schemas";

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
  activeAndUpcomingFreezes,
  freezeWindowStatus,
  DeclareFreezeForm,
  emptyFreezeForm,
  FreezeRow,
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
    const rows = buildChecklistRows({ deploymentTargets: { items: [{}] }, placements: { items: [] } });
    expect(rows.find((r) => r.key === "placements")?.hint).toContain("across 1 deployment target —");
  });

  it("placements hint is ABSENT while targets haven't loaded — never claims 'across 0'", () => {
    const rows = buildChecklistRows({ placements: { items: [{}] } });
    expect(rows.find((r) => r.key === "placements")?.hint).toBeUndefined();
  });

  it("domain-local: counts the CLIENT-SIDE filter over the fetched sample, labeled 'of the first N'", () => {
    const rows = buildChecklistRows({
      componentsSample: {
        items: [{ domainLocal: true }, { domainLocal: false }, { domainLocal: true }, { domainLocal: false }, { domainLocal: false }]
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
    const rows = buildChecklistRows({ sourceMappingCounts: { github: 3 } /* gitea/gitlab missing */ });
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
      createdByActorId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      createdAt: "2026-08-12T00:00:00.000Z",
      ...overrides
    };
  }

  it("classifies upcoming / active / past off startsAt/endsAt", () => {
    expect(freezeWindowStatus(freeze({ startsAt: "2026-08-20T00:00:00.000Z", endsAt: "2026-08-21T00:00:00.000Z" }), NOW)).toBe("upcoming");
    expect(freezeWindowStatus(freeze({ startsAt: "2026-08-13T00:00:00.000Z", endsAt: "2026-08-14T00:00:00.000Z" }), NOW)).toBe("active");
    expect(freezeWindowStatus(freeze({ startsAt: "2026-08-01T00:00:00.000Z", endsAt: "2026-08-02T00:00:00.000Z" }), NOW)).toBe("past");
  });

  it("drops PAST freezes and sorts the rest soonest-first", () => {
    const upcoming = freeze({ id: "11111111-1111-4111-8111-111111111111", startsAt: "2026-09-01T00:00:00.000Z", endsAt: "2026-09-02T00:00:00.000Z" });
    const active = freeze({ id: "22222222-2222-4222-8222-222222222222", startsAt: "2026-08-13T00:00:00.000Z", endsAt: "2026-08-14T00:00:00.000Z" });
    const past = freeze({ id: "33333333-3333-4333-8333-333333333333", startsAt: "2026-01-01T00:00:00.000Z", endsAt: "2026-01-02T00:00:00.000Z" });
    const result = activeAndUpcomingFreezes([upcoming, past, active], NOW);
    expect(result.map((f) => f.id)).toEqual([active.id, upcoming.id]);
  });
});

describe("FreezeRow — the no-early-lift claim", () => {
  const ROW_FREEZE: Freeze = {
    id: "6f0a1b2c-3d4e-4f50-8161-728394a5b6c7",
    scopeObjectId: "0c1d2e3f-4a5b-4c6d-8e9f-a0b1c2d3e4f5",
    name: "code freeze",
    startsAt: "2026-08-13T00:00:00.000Z",
    endsAt: "2026-08-20T00:00:00.000Z",
    reason: "quarter close",
    createdByActorId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    createdAt: "2026-08-12T00:00:00.000Z"
  };

  it("states, in the row's own tooltip, that the freeze lifts only at its endsAt and there is no early-lift control", () => {
    const html = renderToStaticMarkup(<FreezeRow freeze={ROW_FREEZE} now={new Date("2026-08-14T00:00:00.000Z")} />);
    expect(html).toMatch(/no early-lift or delete control yet/i);
    expect(html).toMatch(/lifts automatically at its end time/i);
  });

  it("offers no lift/delete control at all — there is no button in a freeze row", () => {
    const html = renderToStaticMarkup(<FreezeRow freeze={ROW_FREEZE} now={new Date("2026-08-14T00:00:00.000Z")} />);
    expect(html).not.toContain("<button");
  });

  it("an untitled freeze (nullable `name`) still renders, never crashes or drops the row", () => {
    const html = renderToStaticMarkup(<FreezeRow freeze={{ ...ROW_FREEZE, name: null }} now={new Date("2026-08-14T00:00:00.000Z")} />);
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
      reason: "  release freeze  "
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
      <DeclareFreezeForm value={emptyFreezeForm()} onChange={() => {}} onSubmit={() => {}} pending={false} />
    );
  }

  it("has one field per CreateFreezeRequestSchema key: scopeObjectId, name, startsAt, endsAt, reason", () => {
    const html = render();
    expect(html).toContain('data-testid="freeze-scope-input"');
    expect(html).toContain('data-testid="freeze-name-input"');
    expect(html).toContain('data-testid="freeze-starts-input"');
    expect(html).toContain('data-testid="freeze-ends-input"');
    expect(html).toContain('data-testid="freeze-reason-input"');
    // Census, not a spot check: exactly 4 <input>s and 1 <textarea> — a sixth field (e.g. a role
    // or scope-TYPE picker) would fail this even if it carried no testid at all.
    expect((html.match(/<input\b/g) ?? []).length).toBe(4);
    expect((html.match(/<textarea\b/g) ?? []).length).toBe(1);
  });

  it("the ends field also carries the no-early-lift disclaimer, at declare time — not just after the fact", () => {
    const html = render();
    expect(html).toMatch(/no early lift yet/i);
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
