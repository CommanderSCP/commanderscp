import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { BundleTransfer, FederationPeerStatus } from "@scp/schemas";

/**
 * M16.2 phase B (B1) — THE RENDERING HALF of the Outposts overview's honesty contract, pinned by a
 * check that runs on EVERY PR.
 *
 * WHY A PLAIN VITEST FILE AND NOT A PLAYWRIGHT SPEC (the same reason `service-board-honesty.test.tsx`
 * exists): originally because every E2E job was `main`-only and SKIPPED on pull requests. E2E now
 * runs on PRs and 5z requires it, so the reason is no longer coverage but COST and ALTITUDE — this
 * is milliseconds, needs no browser, and fails with a diff. The server half of this
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
  SelfDomainPanel,
  TrustTierCell,
  TransportCell,
  PendingExportCell,
  RecentTransfersCell,
  attentionLevel,
  isPeerUnknown,
  isOutpostPeer,
  trustTierMark
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
  it("an UNVERIFIED tier with NO provenance field still never renders as a commander assertion", () => {
    // `status-repo.ts` emits TWO signals for this one case — `trustTierProvenance: "unverified"` AND
    // `"trustTier"` in `unknownFields` — and `trustTierProvenance` is `.nullable().optional()`, so a
    // response carrying the tier and the declaration but not the provenance is well-formed. Keyed on
    // provenance alone, such a row fell through to the DECLARED badge and was byte-identical to a
    // tier this commander actually asserted.
    const noProvenance = basePeer({
      trustTier: "commercial",
      unknownFields: ["trustTier", "healthRollup", "appliedAtPeer"]
    });
    delete (noProvenance as { trustTierProvenance?: unknown }).trustTierProvenance;

    const html = renderToStaticMarkup(<TrustTierCell status={noProvenance} />);
    const declared = renderToStaticMarkup(
      <TrustTierCell
        status={basePeer({
          trustTier: "commercial",
          trustTierProvenance: "declared",
          unknownFields: ["healthRollup", "appliedAtPeer"]
        })}
      />
    );

    expect(html).not.toBe(declared);
    expect(html).toContain('data-tier-provenance="unverified"');
    expect(html).toContain('data-testid="outpost-tier-unverified"');
    expect(html).not.toContain('data-testid="outpost-tier-declared"');
    expect(visibleText(html)).toContain("unverified");
    // PREMISE, so this cannot pass by the declared case having regressed instead: the genuinely
    // declared tier still renders as a plain commander assertion.
    expect(declared).toContain('data-tier-provenance="declared"');
    expect(visibleText(declared)).not.toContain("unverified");
  });

  /**
   * THE ROW ATTRIBUTE, WHICH THE PREVIOUS ROUND'S CENSUS WALKED PAST (round 3).
   *
   * Every test above renders `<TrustTierCell>` DIRECTLY, so `<OutpostRow>`'s own
   * `data-trust-tier` was asserted for no tier case at all — and it was bare
   * (`status.trustTier ?? "unknown"`), with no provenance qualifier beside it. This suite's own
   * stated rule (top of this file) is that the forbidden thing is the CLAIM: the rendered word AND
   * the machine-readable `data-*` attribute. So an unverified peer and a declared one emitted a
   * BYTE-IDENTICAL `<tr … data-trust-tier="commercial">`, which is exactly what an E2E selector or
   * any other DOM consumer keys on.
   */
  it("the ROW's machine-readable tier claim carries its qualifier, not just the cell's", () => {
    const unverifiedRow = renderRow(
      basePeer({
        trustTier: "commercial",
        trustTierProvenance: "unverified",
        unknownFields: ["trustTier", "healthRollup", "appliedAtPeer"]
      })
    );
    const declaredRow = renderRow(
      basePeer({
        trustTier: "commercial",
        trustTierProvenance: "declared",
        unknownFields: ["healthRollup", "appliedAtPeer"]
      })
    );

    const rowTag = (html: string): string => {
      const at = html.indexOf('data-testid="outpost-row"');
      return html.slice(html.lastIndexOf("<", at), html.indexOf(">", at) + 1);
    };

    // PREMISE: both rows really do carry the same tier, so the difference below is the qualifier
    // and not a difference in the value.
    expect(rowTag(unverifiedRow)).toContain('data-trust-tier="commercial"');
    expect(rowTag(declaredRow)).toContain('data-trust-tier="commercial"');
    // THE GUARANTEE: the ROW TAG ITSELF distinguishes them.
    expect(rowTag(unverifiedRow)).not.toBe(rowTag(declaredRow));
    expect(rowTag(unverifiedRow)).toContain('data-tier-provenance="unverified"');
    expect(rowTag(declaredRow)).toContain('data-tier-provenance="declared"');
    // …and a peer with NO tier says so on the row too, rather than carrying an enum member.
    expect(rowTag(renderRow(basePeer()))).toContain('data-trust-tier="unknown"');
    expect(rowTag(renderRow(basePeer()))).toContain('data-tier-provenance="none"');
  });

  /**
   * A `retrans` peer is a STRONGER claim than "unobservable": this instance can SOURCE the
   * inapplicability itself — `POST /federation/outposts` refuses (400) to bind an `outpost` config
   * object to any peer whose role is not `outpost` (`outpost-binding.ts`, ADR-0004; measured
   * `outpost-object.integration.test.ts`). So a retrans row must NOT wear the same amber
   * unknown-pill a genuinely undecided outpost tier wears — that would understate what is known.
   */
  it("a retrans peer renders the §1.5 structural-absence dash, never the unknown pill", () => {
    const retrans = basePeer({ peer: { ...basePeer().peer, role: "retrans" } });
    const html = renderToStaticMarkup(<TrustTierCell status={retrans} />);

    expect(html).toContain('data-testid="retrans-tier-na"');
    expect(html).toContain('data-trust-tier="not-applicable"');
    expect(html).toContain('data-tier-provenance="not-applicable"');
    // The §1.5 dash idiom for STRUCTURALLY-EXPECTED absence: visible `—` in text-slate-400, with
    // the honesty sentence riding the title — NOT a badge (pills stay reserved for signal; a
    // column of "not applicable" badges on every retrans row is the wall-of-pills reborn).
    expect(visibleText(html)).toContain("—");
    expect(html).toContain("text-slate-400");
    expect(html).toContain("Not applicable: this peer");
    expect(visibleText(html)).not.toContain("not applicable");
    // …and it must NOT reuse the outpost unknown marker's own testid — the two suites, and the two
    // claims, must not be able to pass on each other's markup.
    expect(html).not.toContain('data-testid="outpost-unknown"');

    // PREMISE, so this cannot pass by the outpost case having regressed into the dash too: an
    // outpost peer with no tier still wears the ordinary unknown pill, byte-identically to before.
    const outpost = renderToStaticMarkup(<TrustTierCell status={basePeer()} />);
    expect(outpost).toContain('data-testid="outpost-unknown"');
    expect(outpost).not.toContain('data-testid="retrans-tier-na"');
    expect(outpost).not.toContain("Not applicable");
  });

  it("trustTierMark agrees with the cell for a retrans peer — one derivation, not applicable", () => {
    const retrans = basePeer({ peer: { ...basePeer().peer, role: "retrans" } });
    expect(trustTierMark(retrans)).toEqual({
      tier: "not-applicable",
      provenance: "not-applicable"
    });
    // …and the ROW carries the same claim, not the bare "unknown" a role-blind derivation would give.
    const rowHtml = renderRow(retrans);
    const at = rowHtml.indexOf('data-testid="outpost-row"');
    const rowTag = rowHtml.slice(rowHtml.lastIndexOf("<", at), rowHtml.indexOf(">", at) + 1);
    expect(rowTag).toContain('data-trust-tier="not-applicable"');
    expect(rowTag).toContain('data-tier-provenance="not-applicable"');
  });

  it("the row and the cell read ONE derivation — they cannot disagree", () => {
    // `trustTierMark` is the single source both consume. Asserted as a function so a future edit
    // that reintroduces a second, bare copy of the claim in either place has to fight this too.
    const noProvenance = basePeer({
      trustTier: "govcloud",
      unknownFields: ["trustTier", "healthRollup", "appliedAtPeer"]
    });
    delete (noProvenance as { trustTierProvenance?: unknown }).trustTierProvenance;

    expect(trustTierMark(basePeer())).toEqual({ tier: "unknown", provenance: "none" });
    expect(trustTierMark(noProvenance)).toEqual({ tier: "govcloud", provenance: "unverified" });
    expect(
      trustTierMark(
        basePeer({
          trustTier: "govcloud",
          trustTierProvenance: "declared",
          unknownFields: ["healthRollup", "appliedAtPeer"]
        })
      )
    ).toEqual({ tier: "govcloud", provenance: "declared" });

    // …and the ROW paints exactly what that derivation says, for the provenance-omitted case which
    // is the one the previous round's fix was about.
    const html = renderRow(noProvenance);
    const at = html.indexOf('data-testid="outpost-row"');
    const rowTag = html.slice(html.lastIndexOf("<", at), html.indexOf(">", at) + 1);
    expect(rowTag).toContain('data-tier-provenance="unverified"');
  });
});

describe("outposts overview: the attention dot triages, it does not cry wolf", () => {
  /**
   * Red requires a signal that something SET UP to work is not working. The one such signal in
   * this payload is poke-mode enabled with no poke ever received. Transport-unknown is amber, not
   * red — a freshly enrolled peer has no transport yet and a genuinely air-gapped peer may never
   * have one (bundles move by hand, a supported shape, not a failure). The first QA pass shipped
   * transport-unknown as red and every fresh row lit up like a fire drill; this pins the repair.
   */
  it("a never-synced, transportless peer is WARNING, never danger", () => {
    const status = basePeer({ transportMode: null });
    expect(attentionLevel(status)).toBe("warning");
  });

  it("poke-mode enabled with no poke ever received is DANGER", () => {
    const status = basePeer({ peer: { ...basePeer().peer, pokeMode: true } });
    expect(attentionLevel(status)).toBe("danger");
  });

  it("declared tier + derivable transport is NOMINAL", () => {
    // `basePeer` declares "trustTier" in `unknownFields`, and `trustTierMark` treats that as a
    // second unverified signal (the OR in outposts.tsx) — a nominal fixture must clear both.
    const status = basePeer({
      trustTier: "il5",
      trustTierProvenance: "declared",
      unknownFields: (basePeer().unknownFields ?? []).filter((f) => f !== "trustTier")
    });
    expect(attentionLevel(status)).toBe("nominal");
  });

  it("the dot renders its level as data-attention for the styling to key on", () => {
    const html = renderRow(basePeer({ transportMode: null }));
    const dot = elementByTestId(html, "outpost-attention");
    expect(dot).toContain('data-attention="warning"');
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
    // No success colour over an export figure. `bg-emerald-50` is the app's success badge tone
    // (`components/ui/badge.tsx`, design spec §1.5); a confirmed INBOUND transfer legitimately
    // uses it, and this row has none, so its absence here is about the export cells.
    expect(html).not.toContain("bg-emerald-50");
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

  it("an ABSENT (not null) backlog count is an unknown, never a blank number", () => {
    // `pendingExportEntryCount` is `.nullable().OPTIONAL()`, so `undefined` is as legal on the wire as
    // `null` — and ADR-0023 does NOT close this one: an omitted OPTIONAL key is contract-legal and
    // passes the SDK's response validation untouched, so this guard is still the only thing between
    // the renderer and `undefined`. Keying the guard on `=== null` alone let
    // that value through and rendered
    //   `<span data-testid="outpost-export-backlog"> of this domain's own journal entries…</span>`
    // — an EMPTY number inside confident copy, reading as "nothing pending".
    const exported = basePeer({
      lastExportedThroughSequence: 42,
      lastExportedAt: "2026-07-29T10:00:00.000Z",
      lastExportedBundleChecksum: "c0ffee1234567890abcdef",
      unknownFields: []
    });
    delete (exported as { pendingExportEntryCount?: number | null }).pendingExportEntryCount;

    const html = renderToStaticMarkup(<PendingExportCell status={exported} />);

    // PREMISE: this really is the exported branch, so the backlog line is reached at all.
    expect(html).toContain('data-export-state="exported-handoff-unknown"');
    expect(html).toContain("exported through #42");
    // THE GUARANTEE: an unknown marker, and no half-rendered backlog sentence.
    expect(html).toContain('data-testid="outpost-unknown"');
    expect(html).not.toContain('data-testid="outpost-export-backlog"');
    expect(visibleText(html)).not.toContain("not yet put on the wire");
  });

  it("an ABSENT (not null) exported sequence is 'no export recorded', never 'through # on never'", () => {
    // THE GUARD THAT ORIGINATED THIS WHOLE CLASS, LEFT HALF-PINNED. `lastExportedThroughSequence` is
    // `.nullable().OPTIONAL()`, but no test ever gave it `undefined` — only `null` and `42` — so
    // reverting `isAbsent(...)` to `=== null` kept the suite green while the mutant rendered
    //   `<div data-export-state="exported-handoff-unknown">exported through # on never</div>`
    // — the exact fabrication the guard exists to prevent, and worse than the null case because it
    // asserts an export event with no sequence and no date. Its sibling `pendingExportEntryCount`
    // was pinned for BOTH absent forms; this is the other half.
    const absentSequence = basePeer({ unknownFields: [] });
    delete (absentSequence as { lastExportedThroughSequence?: number | null })
      .lastExportedThroughSequence;
    // `unknownFields: []` is load-bearing: with the declaration present, `isPeerUnknown` alone would
    // carry this branch and the value guard would go untested exactly as before.
    expect(isPeerUnknown(absentSequence, "lastExportedThroughSequence")).toBe(false);

    const html = renderToStaticMarkup(<PendingExportCell status={absentSequence} />);

    expect(html).toContain('data-export-state="none-recorded"');
    expect(html).toContain("no export recorded");
    expect(html).not.toContain('data-export-state="exported-handoff-unknown"');
    expect(visibleText(html)).not.toContain("exported through");
    expect(visibleText(html)).not.toContain("on never");
  });

  it("the backlog-unknown marker does not explain itself with a reason this branch rules out", () => {
    // The marker is only reachable AFTER `neverExported` returned false — i.e. something HAS been
    // exported to this peer — so copy blaming "nothing has been exported yet" states, as the reason,
    // the one fact this code path has already excluded.
    const html = renderToStaticMarkup(
      <PendingExportCell
        status={basePeer({
          lastExportedThroughSequence: 42,
          lastExportedAt: "2026-07-29T10:00:00.000Z",
          pendingExportEntryCount: null,
          unknownFields: ["pendingExportEntryCount"]
        })}
      />
    );
    expect(html).toContain("backlog unknown");
    // THE REASON ITSELF, scoped to the marker's own tooltip and matched LOOSELY. The previous form
    // (`not.toMatch(/Nothing has been exported to this peer yet/)`) pinned one exact sentence, so
    // restoring the untrue explanation in any other wording — "Nothing has been exported yet, so
    // there is no pending-export backlog." — left the suite green. This PR's own thesis is that the
    // COPY IS THE GUARANTEE, so the copy is what is asserted.
    const marker = elementByTestId(html, "outpost-unknown");
    const title = /title="([^"]*)"/.exec(marker)?.[1] ?? "";
    expect(title, "the marker explains itself").not.toBe("");
    expect(title).not.toMatch(/nothing has been exported/i);
    expect(title).not.toMatch(/no export/i);
    // PREMISE: it does still give the reason that IS true here.
    expect(title).toMatch(/did not report a count|cannot observe/i);
    // …and it still must not read as a reassurance about the backlog itself.
    expect(visibleText(html)).not.toMatch(/nothing is pending|no backlog|caught up/i);
  });

  it("a row survives a response that omits recentTransfers — an unknown, never a white screen", () => {
    // FAIL LOUD BEATS FAIL DISHONEST, BUT A WHITE SCREEN IS NEITHER. `recentTransfers` is
    // required-not-optional and BEFORE ADR-0023 the SDK validated no response, so a server that
    // omitted it made `transfers.length` throw a TypeError that took down the ENTIRE table — every
    // honest unknown on every other row with it, which is strictly worse than the fabrication these
    // tests forbid.
    //
    // WHAT THIS CASE PINS NOW. It renders the ROW directly, so it pins the row's OWN guard and
    // nothing else — which is still the right level for it: the SDK boundary is one source of a
    // `FederationPeerStatus`, not the only one, and reverting the `?? []` must stay red. What it
    // deliberately does NOT claim is anything about the page: since ADR-0023 this body never reaches
    // the row through `client.federation.status()` (it rejects), and what `/outposts` does with that
    // rejection is pinned end-to-end, against the real SDK, in `outposts-crash.test.tsx`.
    const noTransfers = basePeer();
    delete (noTransfers as { recentTransfers?: unknown }).recentTransfers;

    const html = renderRow(noTransfers as FederationPeerStatus);
    expect(html).toContain('data-testid="outpost-transfers-none"');
    // …and the rest of the row is still rendered honestly rather than half-torn-down.
    expect(html).toContain('data-trust-tier="unknown"');
    expect(html).toContain('data-testid="outpost-export"');
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

describe("outposts overview: the shared sourceless-column copy is role-neutral", () => {
  // `APPLIED_AT_PEER_TITLE`/`HEALTH_ROLLUP_TITLE` back the SHARED table column of a table that mixes
  // outpost AND retrans rows (`outposts.tsx`) — and are re-used verbatim by the per-peer detail page
  // (`outpost-detail.tsx`'s `OutpostStatusCard`). Naming "the outpost" there is a claim about a
  // specific row that a shared column cannot make honestly for a retrans one.
  it("names 'the peer', never 'the outpost', in the shared unknown-column tooltips", async () => {
    const { APPLIED_AT_PEER_TITLE, HEALTH_ROLLUP_TITLE } = await import("./outposts");
    expect(APPLIED_AT_PEER_TITLE).toContain("what the peer applied");
    expect(APPLIED_AT_PEER_TITLE).not.toContain("outpost");
    expect(HEALTH_ROLLUP_TITLE).toContain("per-peer health signal");
    expect(HEALTH_ROLLUP_TITLE).not.toContain("outpost");
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

/**
 * THIS DOMAIN as an outpost — ADR-0026 §9.2 / owner decision D3.
 *
 * The trap this section owns is the mirror of the peer traps above. This domain has NO
 * `federation_peers` row and NO `outpost` object (ADR-0022 splits those two authorities and self
 * holds neither), so every sync-shaped field is unsourceable for it. Rendering it as a table row
 * would mean blanking seven columns — and a blank is exactly what this file exists to forbid. The
 * panel therefore must not print those fields at all, and must not read as a paired peer.
 */
const SELF = {
  domainId: "11111111-2222-4333-8444-555555555555",
  name: "commercial",
  role: "commander" as const,
  publicKey: "ed25519-pub"
};

describe("the self-domain panel", () => {
  it("names this domain and its declared role", () => {
    const html = renderToStaticMarkup(<SelfDomainPanel self={SELF} />);
    expect(visibleText(html)).toContain("commercial");
    expect(html).toContain('data-testid="self-domain-role"');
  });

  it("never renders a sync, transport, trust-tier or health figure for self", () => {
    // The load-bearing assertion. Self has no peer row to source ANY of these from, so the honest
    // rendering is to omit them — not to print a blank, a zero, or an "unknown" that implies the
    // field could one day be filled for this domain.
    const text = visibleText(renderToStaticMarkup(<SelfDomainPanel self={SELF} />));
    for (const forbidden of [
      "Last sync",
      "Exported",
      "Applied at outpost",
      "Trust tier",
      "Transport",
      "Health",
      "Recent transfers"
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("says plainly that this domain is NOT a paired peer", () => {
    // Without this the panel reads as just another outpost, and an operator would reasonably expect
    // it to sync — the exact confusion the exemption exists to prevent.
    expect(visibleText(renderToStaticMarkup(<SelfDomainPanel self={SELF} />))).toContain(
      "not a paired peer"
    );
  });

  it("an UNSET role is called out as undesignated, not printed as a role", () => {
    // `unset` is the lazily-minted default, not something anyone chose. Printing the literal makes
    // it read like a fourth role beside commander/outpost/retrans.
    const text = visibleText(
      renderToStaticMarkup(<SelfDomainPanel self={{ ...SELF, role: "unset" as const }} />)
    );
    expect(text).toContain("not designated");
    expect(text).toContain("scp federation init");
  });

  it("renders nothing at all when the server reports no self", () => {
    // `FederationStatusResponse.self` is nullable. A half-rendered panel with an empty name would
    // assert a domain identity the server did not give us.
    expect(renderToStaticMarkup(<SelfDomainPanel self={null} />)).toBe("");
  });
});

/**
 * drizzle/0087 — THE BYTE-RELAY TAG, and the honesty pin that keeps it a READ, never an INFERENCE.
 *
 * `channel` is the one place a retrans byte-relay hop is distinguished from an ordinary metadata
 * `.scpbundle` handoff (`BundleTransferSchema`'s doc). The forbidden shortcut is deriving it from
 * anything else already on the row — `checksum === null` or the peer's role both correlate with
 * `channel: 'bytes'` in today's fixtures without being it, and a UI that keyed on either would keep
 * "working" right up until a metadata row with a null checksum (a pre-M16.1 row) got mislabelled a
 * byte relay. So three states, three renderings, and the ABSENT case is the one that actually pins
 * the rule: it must render nothing, and it is the case a `checksum`- or role-based shortcut can't
 * tell apart from `'bytes'` without also being told the channel.
 */
function transferFixture(overrides: Partial<BundleTransfer> = {}): BundleTransfer {
  return {
    id: "6b6c1a9e-2f3d-4a5b-8c9d-0e1f2a3b4c5d",
    peerDomainId: PEER_ID,
    direction: "export",
    kind: "promotion",
    status: "created",
    sinceSequence: null,
    throughSequence: null,
    checksum: null,
    channel: null,
    createdAt: "2026-08-23T00:00:00.000Z",
    confirmedAt: null,
    ...overrides
  };
}

describe("outposts overview: the byte-relay tag is READ off channel, never inferred", () => {
  it("tags a transfer whose channel is 'bytes' as the byte-relay leg", () => {
    const html = renderToStaticMarkup(
      <RecentTransfersCell transfers={[transferFixture({ channel: "bytes" })]} />
    );
    expect(html).toContain('data-testid="outpost-transfer-byte-relay"');
    expect(html).toContain("byte relay");
  });

  it("a 'metadata' channel renders NO byte-relay tag — the default reading needs no callout", () => {
    const html = renderToStaticMarkup(
      <RecentTransfersCell transfers={[transferFixture({ channel: "metadata" })]} />
    );
    expect(html).not.toContain('data-testid="outpost-transfer-byte-relay"');
    expect(html).not.toContain("byte relay");
  });

  it("THE HONESTY PIN: an ABSENT channel (null) renders NO tag — provenance is read, not guessed", () => {
    // This row has exactly the two properties a shortcut might key on instead of `channel`: no
    // checksum, and (via the row it would sit in) a retrans peer role is equally plausible bait.
    // Neither may stand in for the field itself.
    const html = renderToStaticMarkup(
      <RecentTransfersCell transfers={[transferFixture({ channel: null, checksum: null })]} />
    );
    expect(html).not.toContain('data-testid="outpost-transfer-byte-relay"');
    expect(html).not.toContain("byte relay");
  });

  it("an OMITTED channel key (older SDK/server) also renders no tag, not a throw", () => {
    const withoutChannel = transferFixture();
    delete (withoutChannel as { channel?: unknown }).channel;
    const html = renderToStaticMarkup(<RecentTransfersCell transfers={[withoutChannel]} />);
    expect(html).not.toContain('data-testid="outpost-transfer-byte-relay"');
  });
});
