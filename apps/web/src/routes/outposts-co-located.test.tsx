import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { OutpostConfig } from "@scp/schemas";

/**
 * pipeline-substrate-registry-scan.md §10.5 — THE CO-LOCATED OUTPOST on the M16 Outposts surfaces.
 *
 * A self-bound `outpost` record (`peerDomainId` = THIS instance's own domain) has NO
 * `federation_peers` row, so it can never be a `peers[]` entry and no peer-keyed cell can render it.
 * The census of every join from an outpost record to its peer row on the web side is:
 *   * the Outposts overview's table (peer rows) — self is NOT a row; its record is read off
 *     `FederationStatusResponse.selfOutpost` into the self-domain panel (`SelfOutpostLine`);
 *   * the per-outpost detail page (`findPeerStatus`) — for self's own id it renders the co-located
 *     card + the configuration section keyed on `selfDomain`, not "No peer … is paired";
 *   * the configuration section's DeclareConfigCard (peer role check) — the `coLocated` variant.
 *
 * WHAT IS PINNED, and how each would fail
 *   * `SelfOutpostLine` states three things three ways: a record (name, tier, the marker
 *     `co-located · this instance`), `null` = "no outpost registered" + a declare link, `undefined`
 *     = "not reported" (an older server) — dropping the undefined arm reads an old server as "none".
 *   * The tier of a self record follows the same three-state honesty as a peer row: null → unknown
 *     marker, in `unknownFields` → `· unverified`, else the tier.
 *   * `SelfDomainPanel` still forbids every peer-row column for self.
 *   * `DeclareConfigCard coLocated` renders the declare control with the co-located copy and does
 *     NOT run the peer-role refusal (there is no peer) — but ONLY for `selfRole: "commander"`, the
 *     one role the server's self-shape door accepts (`outpost-binding.ts`; measured in
 *     `outpost-config-sync.integration.test.ts`): every other role renders the refusal and no
 *     control. Without `coLocated` a `commander`-role peer is still refused (the existing case in
 *     outpost-configuration.test.tsx). `SelfOutpostLine`'s `null` arm offers the declare link on
 *     the same condition and otherwise reads `declared at the commander`.
 *
 * MUTATION LOG (each applied ALONE, then reverted)
 * | Mutation | Result |
 * |---|---|
 * | `SelfOutpostLine`: treat `undefined` like `null` | the "not reported" case FAILS |
 * | `SelfOutpostTier`: ignore `unknownFields` | the unverified case FAILS (`data-tier-provenance="declared"`) |
 * | `DeclareConfigCard`: drop the `!coLocated &&` guard and pass `peer={{role:"commander"}}` | the co-located case FAILS (`config-role-not-outpost`) |
 * | `DeclareConfigCard`: drop the `selfRole !== "commander"` refusal | the "any OTHER role" case FAILS (`config-declare-save` rendered) |
 * | `SelfOutpostLine`: offer the declare link on every role | the "NON-commander role" case FAILS (`self-outpost-declare-link` present) |
 * | `SelfDomainPanel`: stop threading `selfOutpost` | the registered case FAILS (`data-self-outpost="unreported"`) |
 */
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>
}));

const { SelfDomainPanel, SelfOutpostLine, SelfOutpostTier } = await import("./outposts");
const { DeclareConfigCard } = await import("./outpost-configuration");
const { SelfOutpostCard } = await import("./outpost-detail");

const SELF = {
  domainId: "11111111-2222-4333-8444-555555555555",
  name: "hq-commander",
  role: "commander" as const,
  publicKey: "ed25519-pub"
};

function selfConfig(overrides: Partial<OutpostConfig> = {}): OutpostConfig {
  return {
    objectId: "019f0000-0000-7000-8000-0000000000aa",
    urn: `urn:scp:org:outpost:${SELF.domainId}`,
    name: "hq-outpost",
    peerDomainId: SELF.domainId,
    trustTier: "commercial",
    originDomainId: SELF.domainId,
    originIsSelf: true,
    peerIsSelf: true,
    provenance: null,
    revision: 1,
    version: 1,
    unknownFields: [],
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
    ...overrides
  };
}

function visibleText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

describe("SelfOutpostLine (§10.5): the co-located record, read off selfOutpost, three states", () => {
  it("a record: its name, its tier, and the marker `co-located · this instance` — never a peer column", () => {
    const html = renderToStaticMarkup(<SelfOutpostLine self={SELF} selfOutpost={selfConfig()} />);
    expect(html).toContain('data-self-outpost="registered"');
    // The router `Link` is mocked to a bare `<a>` (attributes do not survive) — the assertion is
    // that the record's NAME is inside an anchor: the page the pipeline's outpost link also opens.
    expect(html).toMatch(/<a>hq-outpost<\/a>/);
    const text = visibleText(html);
    expect(text).toContain("hq-outpost");
    expect(text).toContain("commercial");
    expect(text).toContain("co-located · this instance");
    expect(html).toContain('data-tier-provenance="declared"');
    for (const forbidden of ["Last sync", "Exported", "Transport", "Health"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("`null`: a STATED absence — `no outpost registered` with the way to declare one; not a blank", () => {
    const html = renderToStaticMarkup(<SelfOutpostLine self={SELF} selfOutpost={null} />);
    expect(html).toContain('data-self-outpost="none"');
    expect(visibleText(html)).toContain("no outpost registered");
    expect(html, "the way to declare one is a link").toMatch(/<a>declare one<\/a>/);
    expect(html).not.toMatch(/<a>hq-outpost<\/a>/);
  });

  it("`null` on a NON-commander role: the absence is stated, but NO declare link — the record is the commander's (the server 400s the self shape from an outpost)", () => {
    for (const role of ["outpost", "retrans", "unset"] as const) {
      const html = renderToStaticMarkup(
        <SelfOutpostLine self={{ ...SELF, role }} selfOutpost={null} />
      );
      expect(html, role).toContain('data-self-outpost="none"');
      expect(html, role).toContain('data-self-outpost-authority="commander"');
      expect(visibleText(html), role).toContain("no outpost registered");
      expect(visibleText(html), role).toContain("declared at the commander");
      expect(html, `${role}: no declare link`).not.toContain("self-outpost-declare-link");
      expect(html, `${role}: no anchor at all`).not.toMatch(/<a>/);
    }
  });

  it("`undefined` (an older server): `not reported` — NOT read as none", () => {
    const html = renderToStaticMarkup(<SelfOutpostLine self={SELF} selfOutpost={undefined} />);
    expect(html).toContain('data-self-outpost="unreported"');
    expect(visibleText(html)).toContain("not reported");
    expect(visibleText(html)).not.toContain("no outpost registered");
  });
});

describe("SelfOutpostTier (§10.5): the same three-state tier honesty as a peer row", () => {
  it("no tier → the unknown marker, never blank, never `commercial`", () => {
    const html = renderToStaticMarkup(
      <SelfOutpostTier config={selfConfig({ trustTier: null, unknownFields: ["trustTier"] })} />
    );
    expect(html).toContain('data-trust-tier="unknown"');
    expect(html).toContain('data-testid="outpost-unknown"');
    expect(visibleText(html)).not.toContain("commercial");
  });

  it("a tier the server ALSO lists in unknownFields (an unverified shadow) reads `· unverified`", () => {
    const html = renderToStaticMarkup(
      <SelfOutpostTier
        config={selfConfig({
          trustTier: "il5",
          provenance: "manual",
          unknownFields: ["trustTier"]
        })}
      />
    );
    expect(html).toContain('data-tier-provenance="unverified"');
    expect(visibleText(html)).toContain("il5 · unverified");
  });

  it("a declared tier reads plainly", () => {
    const html = renderToStaticMarkup(
      <SelfOutpostTier config={selfConfig({ trustTier: "il5" })} />
    );
    expect(html).toContain('data-tier-provenance="declared"');
    expect(visibleText(html)).toBe("il5");
  });
});

describe("SelfDomainPanel (§10.5): carries the co-located record beside the domain identity", () => {
  it("threads selfOutpost through — a registered record renders on the panel", () => {
    const html = renderToStaticMarkup(<SelfDomainPanel self={SELF} selfOutpost={selfConfig()} />);
    expect(html).toContain('data-self-outpost="registered"');
    expect(visibleText(html)).toContain("Co-located outpost");
    expect(visibleText(html)).toContain("hq-outpost");
    // Still says self is not a paired peer — the record does not make it one.
    expect(visibleText(html)).toContain("not a paired peer");
  });

  it("with `null` the panel states the absence and offers the declare link", () => {
    const html = renderToStaticMarkup(<SelfDomainPanel self={SELF} selfOutpost={null} />);
    expect(html).toContain('data-self-outpost="none"');
  });

  it("without the prop (an older server) it reads `not reported`, and every peer-row column is still absent", () => {
    const html = renderToStaticMarkup(<SelfDomainPanel self={SELF} />);
    expect(html).toContain('data-self-outpost="unreported"');
    const text = visibleText(html);
    for (const forbidden of [
      "Last sync",
      "Exported",
      "Applied at outpost",
      "Transport",
      "Health"
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });
});

describe("SelfOutpostCard (§10.5): the detail page's card for this instance's own domain id", () => {
  it("names the domain, its role and the co-located record — and NO peer-row status cell", () => {
    const html = renderToStaticMarkup(<SelfOutpostCard self={SELF} selfOutpost={selfConfig()} />);
    expect(html).toContain('data-testid="self-outpost-card"');
    const text = visibleText(html);
    expect(text).toContain("hq-commander");
    expect(text).toContain("hq-outpost");
    expect(text).toContain("co-located · this instance");
    // The status cells are PEER-ROW readings; self has no peer row, so none may appear.
    for (const forbidden of [
      "Last sync",
      "Exported by this side",
      "Transport",
      "Applied at outpost",
      "Health"
    ]) {
      expect(text).not.toContain(forbidden);
    }
    expect(html).not.toContain('data-testid="outpost-tier"');
    expect(html).not.toContain('data-testid="outpost-transport"');
  });

  it("with no record it states the absence rather than rendering the peer 'not paired' sentence", () => {
    const html = renderToStaticMarkup(<SelfOutpostCard self={SELF} selfOutpost={null} />);
    expect(html).toContain('data-self-outpost="none"');
    expect(visibleText(html)).not.toContain("is paired on this instance");
  });
});

describe("DeclareConfigCard coLocated (§10.5): the declare control for this instance's own domain", () => {
  it("on a COMMANDER-role instance it renders the declare control with the co-located copy and no peer-role refusal", () => {
    const html = renderToStaticMarkup(
      <DeclareConfigCard coLocated selfRole="commander" onCreate={() => {}} />
    );
    expect(html).toContain('data-testid="config-declare-card"');
    expect(html).toContain('data-co-located="true"');
    expect(html).toContain('data-testid="config-declare-co-located"');
    expect(html).toContain('data-testid="config-declare-save"');
    expect(html).not.toContain('data-testid="config-role-not-outpost"');
    expect(html).not.toContain('data-testid="config-self-role-not-commander"');
    expect(visibleText(html)).toContain("co-located outpost");
  });

  it("on any OTHER role (outpost / retrans / unset / not given) it renders the refusal the server measures — no declare control", () => {
    // Mirrors `outpost-binding.ts`: the self shape is a 400 unless `federation_self.role` is
    // `commander` (an outpost's own record is commander-declared and arrives replicated). Offering
    // the button here would guide the outpost operator into authoring a local row that outranks
    // the commander's replica in every read.
    for (const role of ["outpost", "retrans", "unset", undefined] as const) {
      const html = renderToStaticMarkup(
        <DeclareConfigCard
          coLocated
          {...(role !== undefined ? { selfRole: role } : {})}
          onCreate={() => {}}
        />
      );
      expect(html, String(role)).toContain('data-testid="config-self-role-not-commander"');
      expect(html, String(role)).not.toContain('data-testid="config-declare-save"');
      expect(html, String(role)).not.toContain('data-testid="config-declare-card"');
      const text = visibleText(html);
      expect(text, String(role)).toContain("commander-declared");
      expect(text, String(role)).toContain("declare it at the commander");
      if (role === "unset") {
        expect(text).toContain("scp federation init --role commander");
      } else {
        expect(text, String(role)).not.toContain("scp federation init");
      }
    }
  });

  it("without coLocated, a non-outpost peer is still refused (the door 400s it)", () => {
    const html = renderToStaticMarkup(
      <DeclareConfigCard peer={{ role: "commander" }} onCreate={() => {}} />
    );
    expect(html).toContain('data-testid="config-role-not-outpost"');
    expect(html).not.toContain('data-testid="config-declare-save"');
  });
});
