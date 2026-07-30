import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { FederationPeerStatus } from "@scp/schemas";

/**
 * M16.2 phase B (B1) — THE RENDERING HALF of the Outposts overview's honesty contract, pinned by a
 * check that runs on EVERY PR.
 *
 * WHY A PLAIN VITEST FILE AND NOT A PLAYWRIGHT SPEC (the same reason `service-board-honesty.test.tsx`
 * exists): every E2E job in `.github/workflows/ci.yml` is guarded by `github.event_name == 'push' &&
 * github.ref == 'refs/heads/main'`, so specs are SKIPPED on pull requests. The server half of this
 * contract is gated on PRs by `apps/server/src/federation/status-honesty.integration.test.ts` and
 * `outpost-handfill-wedge.integration.test.ts`; the rendering half — where a browser can paint an
 * unobservable field exactly like an observed one and undo all of it — needs a gate of its own.
 * `renderToStaticMarkup` renders to a string in the Node environment Vitest already uses: no browser,
 * no DOM library, no new dependency.
 *
 * WHAT IT OWNS, one clause per phase-A trap:
 *   1. a peer with NO trust tier renders an explicit unknown, and NEVER `commercial`;
 *   2. an UNVERIFIED (hand-filled shadow) tier is visibly distinguished from a DECLARED one;
 *   3. a peer with NO derivable transport renders an explicit unknown, and NEVER `air-gap`;
 *   4. nothing on the page reads as "the outpost has this" — every outbound string is about what
 *      THIS side exported, and the two promised-but-sourceless fields (applied-at-peer, health)
 *      render as unknowns rather than as blanks.
 *
 * `Link` is stubbed because `@tanstack/react-router`'s `useRouter` throws outside a `RouterProvider`;
 * routing is covered by the E2E spec against the real router.
 */
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>
}));

const {
  OutpostRow,
  TrustTierCell,
  TransportCell,
  PendingExportCell,
  isPeerUnknown,
  isOutpostPeer
} = await import("./outposts");

const PEER_ID = "0e0a1b2c-3d4e-4f5a-8b6c-7d8e9f0a1b2c";

/**
 * The text an operator actually READS — every tag (and therefore every attribute, including the
 * explanatory `title` tooltips) stripped out.
 *
 * This exists because the naive assertion is wrong in a way that matters: a tooltip saying "this is
 * NOT an air-gap posture" contains the string `air-gap`, so a blanket `not.toContain("air-gap")`
 * over the raw markup fails on honest copy while a cell that silently DROPPED the tooltip would
 * pass. The forbidden thing is the CLAIM — the rendered word, and the machine-readable
 * `data-transport-mode`/`data-trust-tier` attributes — which is what these tests assert separately.
 */
function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, " ");
}

/**
 * The markup of exactly ONE `data-testid`-tagged element, tags balanced.
 *
 * This exists because a whole-row `toContain` cannot tell WHICH cell satisfied it. The two sourceless
 * cells are the always-taken branch of `SourcelessCell` (the server declares `appliedAtPeer` and
 * `healthRollup` for every peer on every response), so an assertion that a cell's CONTENT is the
 * unknown marker has to be scoped to that cell — otherwise a sibling cell's marker keeps it green
 * while this one renders a fabricated reading.
 */
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

function renderRow(status: FederationPeerStatus): string {
  return renderToStaticMarkup(
    <table>
      <tbody>
        <OutpostRow status={status} />
      </tbody>
    </table>
  );
}

/**
 * A peer in the state phase A cares most about: PAIRED, with transport configured, but with NO
 * operator-asserted trust tier and NOTHING ever exported to it. Every null below is a null the
 * server explicitly declared, and none of them is an observation.
 */
function basePeer(overrides: Partial<FederationPeerStatus> = {}): FederationPeerStatus {
  return {
    peer: {
      id: PEER_ID,
      name: "amer-prod",
      role: "outpost",
      baseUrl: "https://outpost.example.net",
      syncScope: { mode: "full" },
      publicKey: "AAAA",
      pokeMode: false,
      pairedAt: "2026-07-01T00:00:00.000Z"
    },
    lastAppliedSequence: null,
    lastSyncedAt: null,
    trustTier: null,
    trustTierProvenance: null,
    transportMode: "dialable",
    lastExportedThroughSequence: null,
    lastExportedAt: null,
    lastExportedBundleChecksum: null,
    lastSyncedBundleChecksum: null,
    pendingExportEntryCount: null,
    unknownFields: [
      "trustTier",
      "lastSyncedBundleChecksum",
      "lastExportedThroughSequence",
      "lastExportedBundleChecksum",
      "pendingExportEntryCount",
      "healthRollup",
      "appliedAtPeer"
    ],
    recentTransfers: [],
    ...overrides
  };
}

describe("outposts overview: an unasserted trust tier is never a tier", () => {
  it("renders an explicit unknown — and NOT `commercial` — for a peer with no tier", () => {
    const html = renderToStaticMarkup(<TrustTierCell status={basePeer()} />);

    expect(html).toContain('data-testid="outpost-unknown"');
    expect(html).toContain('data-trust-tier="unknown"');
    expect(html).toContain('data-tier-provenance="none"');
    // THE FABRICATION THIS FORBIDS: the lowest tier is not a default, it is an assertion. Neither
    // that word nor any other enum member may be shown — or machine-readable — for a peer with none.
    expect(visibleText(html)).not.toContain("commercial");
    expect(visibleText(html)).not.toContain("govcloud");
    expect(visibleText(html)).not.toContain("il5");
    expect(html).not.toContain('data-trust-tier="commercial"');
    // …and it must not be a blank cell either: a blank reads as "fine, nothing to say".
    expect(html).toContain("unknown here");
  });

  it("distinguishes an UNVERIFIED hand-filled tier from a DECLARED one — asserted differentially", () => {
    const declared = renderToStaticMarkup(
      <TrustTierCell
        status={basePeer({
          trustTier: "il5",
          trustTierProvenance: "declared",
          unknownFields: ["healthRollup", "appliedAtPeer"]
        })}
      />
    );
    const unverified = renderToStaticMarkup(
      <TrustTierCell
        status={basePeer({
          trustTier: "il5",
          trustTierProvenance: "unverified",
          // The server lists `trustTier` unknown for this case too — the value rides the wire, but it
          // is not an assertion this instance can stand behind.
          unknownFields: ["trustTier", "healthRollup", "appliedAtPeer"]
        })}
      />
    );

    // PREMISE, asserted so this cannot pass vacuously: the declared case really does show the tier.
    expect(declared).toContain("il5");
    expect(declared).toContain('data-tier-provenance="declared"');
    expect(declared).toContain('data-testid="outpost-tier-declared"');

    // THE WHOLE POINT: the same tier string, from a hand-typed shadow, must not look like the
    // commander's own assertion.
    expect(unverified).not.toBe(declared);
    expect(unverified).toContain('data-tier-provenance="unverified"');
    expect(unverified).toContain('data-testid="outpost-tier-unverified"');
    expect(unverified).toContain("unverified");
    expect(unverified).not.toContain('data-testid="outpost-tier-declared"');
    // The declared badge must NOT carry the unverified marker, in the other direction.
    expect(declared).not.toContain("unverified");
  });
});

describe("outposts overview: absent transport is not an air-gap posture", () => {
  it("renders an explicit unknown — and NEVER `air-gap` — when no transport is derivable", () => {
    const html = renderToStaticMarkup(
      <TransportCell
        status={basePeer({
          transportMode: null,
          unknownFields: ["transportMode", "healthRollup", "appliedAtPeer"]
        })}
      />
    );

    expect(html).toContain('data-transport-mode="unknown"');
    expect(html).toContain('data-testid="outpost-unknown"');
    // INFERRING AIR-GAP FROM ABSENT CONFIG IS FABRICATION: a peer with nothing configured (or with a
    // plain-http base URL federation refuses to dial) is a misconfiguration, not a posture. Neither
    // the rendered word nor the machine-readable attribute may say it.
    expect(visibleText(html)).not.toContain("air-gap");
    expect(html).not.toContain('data-transport-mode="air-gap"');
  });

  it("PREMISE: a genuinely air-gapped peer DOES render `air-gap`", () => {
    const html = renderToStaticMarkup(
      <TransportCell
        status={basePeer({
          transportMode: "air-gap",
          unknownFields: ["healthRollup", "appliedAtPeer"]
        })}
      />
    );
    expect(html).toContain('data-transport-mode="air-gap"');
    expect(visibleText(html)).toContain("air-gap");
    expect(html).not.toContain('data-testid="outpost-unknown"');
  });
});

describe("outposts overview: no string claims the outpost has anything", () => {
  /** A peer this side has exported to, with a FULLY CAUGHT-UP backlog — the single most tempting row
   *  to dress as a success, and the one where doing so would be a lie: a zero backlog says only that
   *  this side has bundled everything it authored. */
  const caughtUp = basePeer({
    lastExportedThroughSequence: 42,
    lastExportedAt: "2026-07-29T10:00:00.000Z",
    lastExportedBundleChecksum: "c0ffee1234567890abcdef",
    pendingExportEntryCount: 0,
    unknownFields: ["trustTier", "lastSyncedBundleChecksum", "healthRollup", "appliedAtPeer"]
  });

  it("a ZERO pending-export backlog is never dressed as 'in sync' / 'up to date'", () => {
    const html = renderRow(caughtUp);

    // PREMISE: the row really is the zero-backlog case, and the figure is rendered.
    expect(html).toContain('data-export-state="exported-handoff-unknown"');
    expect(html).toContain('data-testid="outpost-export-backlog"');
    expect(html).toContain("not yet put on the wire");

    // …and none of the reassuring vocabulary is READ anywhere in the row.
    expect(visibleText(html)).not.toMatch(/in sync/i);
    expect(visibleText(html)).not.toMatch(/up to date/i);
    expect(visibleText(html)).not.toMatch(/fully synced/i);
    expect(visibleText(html)).not.toMatch(/delivered/i);
    // No success colour over an export figure. `bg-green-600` is the app's success badge variant
    // (`components/ui/badge.tsx`); a confirmed INBOUND transfer legitimately uses it, and this row
    // has none, so its absence here is about the export cells.
    expect(html).not.toContain("bg-green-600");
  });

  it("renders applied-at-peer and health as explicit unknowns, not blanks — CONTENT, per cell", () => {
    const html = renderRow(caughtUp);

    expect(html).toContain('data-testid="outpost-appliedAtPeer"');
    expect(html).toContain('data-testid="outpost-healthRollup"');
    // Both DECLARED unknown by the server, so both take the unknown branch…
    expect(html).toContain('data-declared="unknown"');
    expect(html).not.toContain('data-declared="undeclared"');

    // …and THIS is the half that actually bites. `status-repo.ts` pushes both field names into
    // `unknownFields` for EVERY peer on EVERY response, so the declared branch is the ALWAYS-TAKEN
    // one — yet asserting only the attributes above leaves the branch's rendered CONTENT entirely
    // unpinned: swap `<UnknownHere/>` for the literal `healthy`, or for a `0`, and every attribute
    // assertion still holds. Scope to each cell and pin what an operator READS.
    for (const field of ["appliedAtPeer", "healthRollup"]) {
      const cell = elementByTestId(html, `outpost-${field}`);
      expect(cell, `${field} took the wrong branch`).toContain('data-declared="unknown"');
      expect(cell, `${field} dropped the unknown marker`).toContain(
        'data-testid="outpost-unknown"'
      );
      // The marker's own text, and nothing else — not a value, not a zero, not a blank.
      expect(visibleText(cell).trim(), `${field} does not read as an unknown`).toBe("unknown here");
      // Named explicitly because these are the two fabrications this cell invites: a health word, or
      // a count that reads as "none outstanding".
      expect(visibleText(cell)).not.toMatch(/healthy|degraded|applied|\d/);
    }
  });

  it("an OLDER server that declares nothing still cannot make a never-exported peer look exported", () => {
    // `unknownFields` is optional on the wire. Keying the export cell ONLY on the declaration would
    // render "exported through #" with an empty number here — a peer nothing was ever sent to,
    // painted as one that was.
    const html = renderToStaticMarkup(
      <PendingExportCell status={basePeer({ unknownFields: [] })} />
    );
    expect(html).toContain('data-export-state="none-recorded"');
    expect(visibleText(html)).not.toContain("exported through");
  });

  it("a field the server stops declaring still never reads as a clean value", () => {
    // Forward-compatibility branch: an older/newer server that omits the name entirely. "not
    // reported" is still not "healthy" and still not a blank cell.
    const html = renderRow(basePeer({ unknownFields: [] }));
    expect(html).toContain('data-declared="undeclared"');
    expect(html).toContain("not reported");
    expect(html).not.toContain("healthy");
  });

  it("a peer NEVER exported to reports 'no export recorded', never a zero", () => {
    const html = renderToStaticMarkup(<PendingExportCell status={basePeer()} />);
    expect(html).toContain('data-export-state="none-recorded"');
    expect(html).toContain("no export recorded");
    // A `0` here would read as "nothing pending", i.e. as if the outpost had everything.
    expect(html).not.toContain('data-testid="outpost-export-backlog"');
    expect(html).not.toContain("0 of this domain");
  });
});

describe("outposts overview: the declaration predicate and the peer filter", () => {
  // THE WIRING, not only the components it feeds — `isPeerUnknown` is the single place a server
  // declaration becomes a rendering decision, and an inline `.includes(...)` is exactly the line a
  // later edit can quietly change with nothing failing.
  it("reads the server's declaration by exact field name", () => {
    const status = basePeer({ unknownFields: ["trustTier"] });
    expect(isPeerUnknown(status, "trustTier")).toBe(true);
    expect(isPeerUnknown(status, "transportMode")).toBe(false);
  });

  it("treats an ABSENT unknownFields (an older server) as declaring nothing", () => {
    const status = basePeer();
    delete (status as { unknownFields?: string[] }).unknownFields;
    expect(isPeerUnknown(status, "trustTier")).toBe(false);
  });

  it("lists outpost and retrans peers, and excludes a commander peer", () => {
    const outpost = basePeer();
    const retrans = basePeer({ peer: { ...basePeer().peer, role: "retrans" } });
    const commander = basePeer({ peer: { ...basePeer().peer, role: "commander" } });
    expect(isOutpostPeer(outpost)).toBe(true);
    expect(isOutpostPeer(retrans)).toBe(true);
    expect(isOutpostPeer(commander)).toBe(false);
  });
});
