import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// House pattern (outposts-honesty.test.tsx): `Link` throws outside a RouterProvider, so it is
// stubbed — but UNLIKE the bare-anchor stub there, this one interpolates `params` into `to`, because
// the EndpointName tests below assert the href. What that pins is that the component CHOSE the link
// branch and fed it the right registry basePath + object id; TanStack's own interpolation is
// covered by the E2E spec against the real router.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({
    to,
    params,
    title,
    children
  }: {
    to?: string;
    params?: Record<string, string>;
    title?: string;
    children?: React.ReactNode;
  }) => {
    const href = Object.entries(params ?? {}).reduce(
      (path, [key, value]) => path.replace(`$${key}`, value),
      to ?? ""
    );
    return (
      <a href={href} title={title}>
        {children}
      </a>
    );
  }
}));
import {
  DomainLocalBadge,
  DomainLocalCreateField,
  DomainLocalPublishCard,
  EndpointName,
  PublishConfirmBody
} from "./domain-local";

/**
 * M20 (ADR-0031) — pins the three properties of the domain-local UI that a refactor could silently
 * lose without a compile error:
 *
 * 1. The publish card is gated on the OBJECT's `domainLocal` bit and nothing else — no federation
 *    role ever enters the decision. The commander-side guarantee is structural (the object never
 *    arrives), so the only correct client-side condition is the bit itself; a role check would be
 *    the conditional-view failure mode M16.3's census found.
 * 2. The confirm copy states irreversibility in the exact terms ADR-0031 §6 uses ("one-way",
 *    "no un-publish") — this is the safety copy for an action that cannot be undone, so its
 *    presence is behaviour, not wording. (Phrasing may move between elements; the CLAIMS may not
 *    disappear.)
 * 3. Nothing in this module offers an inverse. There is deliberately NO un-publish control to
 *    assert on; instead we assert the module renders no button/verb containing "un-publish".
 *
 * Plain `renderToStaticMarkup`, no jsdom — same harness as replica-origin.test.tsx. Radix's
 * dialog portals render nothing statically, which is why the confirm body is exported and
 * asserted directly.
 */

function renderWithQueryClient(node: React.JSX.Element): string {
  const queryClient = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>
  );
}

const SHARED = { id: "0b7f6c1e-1111-4222-8333-444455556666", name: "vpc-core", domainLocal: false };
const LOCAL = { ...SHARED, domainLocal: true };

describe("domain-local UI (M20 / ADR-0031)", () => {
  it("badge names the declaration and its consequences in the tooltip", () => {
    const html = renderToStaticMarkup(<DomainLocalBadge />);
    expect(html).toContain("domain-local");
    expect(html).toContain('data-testid="domain-local-badge"');
    // The tooltip is the one place the badge explains itself; it must state the guarantee
    // (never journaled to peers) and the exit (one-way publish), not just repeat the label.
    expect(html).toContain("journaled to federation peers");
    expect(html).toContain("never leaves this security domain");
    expect(html).toContain("one-way Publish");
  });

  it("create field names the permission and the immutability before the operator commits", () => {
    const html = renderToStaticMarkup(
      <DomainLocalCreateField checked={false} onChange={() => {}} />
    );
    expect(html).toContain("federation:write");
    expect(html).toContain("Immutable once set");
    // ADR-0031 §6's asymmetry, stated at declaration time — the reverse direction is refused.
    expect(html).toContain("refused permanently");
    // M20.5 §6a: container declarations propagate to children created later — and ONLY later
    // (no retrofit). Both halves are claims the operator acts on, so both are pinned.
    expect(html).toContain("inherits it at create");
    expect(html).toContain("never retrofitted");
    expect(html).toContain('data-testid="new-domain-local-checkbox"');
  });

  it("publish card renders NOTHING for a shared object — gating is the object's own bit", () => {
    expect(renderWithQueryClient(<DomainLocalPublishCard object={SHARED} typeId="component" invalidateKeys={[]} />)).toBe("");
    // `domainLocal` absent (older payload) must behave as shared, not throw or render.
    const { domainLocal: _omitted, ...withoutBit } = SHARED;
    expect(renderWithQueryClient(<DomainLocalPublishCard object={withoutBit} typeId="component" invalidateKeys={[]} />)).toBe("");
  });

  it("publish card offers the verb for a domain-local object, and no inverse anywhere", () => {
    const html = renderWithQueryClient(
      <DomainLocalPublishCard object={LOCAL} typeId="component" invalidateKeys={[]} />
    );
    expect(html).toContain('data-testid="publish-object-button"');
    // "There is no un-publish" appears only in the confirm copy (asserted below), never as a
    // control: the card's own markup must not contain an un-publish affordance.
    expect(html.toLowerCase()).not.toMatch(/un-?publish/);
  });

  // The sweep report's link decision is derived ENTIRELY from `otherEndpointUrn`'s type segment,
  // and the no-link branch depends on a server-side FALLBACK (a vanished endpoint degrades the
  // urn to the raw id), not on a contract. These pin both branches so a change to that fallback —
  // or to the urn shape — breaks a test here instead of shipping a dead link (M20 author's
  // caveat, 2026-08-13).
  it("sweep endpoint with a routable urn renders a LINK into its registry page", () => {
    const html = renderToStaticMarkup(
      <EndpointName
        edge={{
          id: "6f0a1b2c-3d4e-4f50-8161-728394a5b6c7",
          typeId: "depends_on",
          otherEndpointId: "0c1d2e3f-4a5b-4c6d-8e9f-a0b1c2d3e4f5",
          otherEndpointUrn: "urn:scp:default:component:pub-drill-delta",
          otherEndpointName: "pub-drill-delta"
        }}
      />
    );
    expect(html).toContain("<a ");
    expect(html).toContain('href="/components/0c1d2e3f-4a5b-4c6d-8e9f-a0b1c2d3e4f5"');
    expect(html).toContain("pub-drill-delta");
  });

  it("sweep endpoint with a NON-routable urn renders plain text, never a dead link", () => {
    const base = {
      id: "6f0a1b2c-3d4e-4f50-8161-728394a5b6c7",
      typeId: "depends_on",
      otherEndpointId: "0c1d2e3f-4a5b-4c6d-8e9f-a0b1c2d3e4f5",
      otherEndpointName: "0c1d2e3f-4a5b-4c6d-8e9f-a0b1c2d3e4f5"
    };
    // Today's degraded shape: the raw id substituted for the urn (no type segment at all).
    const degradedToday = renderToStaticMarkup(
      <EndpointName edge={{ ...base, otherEndpointUrn: base.otherEndpointId }} />
    );
    // A plausible future degraded shape: a sentinel string. Must ALSO stay linkless.
    const degradedSentinel = renderToStaticMarkup(
      <EndpointName edge={{ ...base, otherEndpointUrn: "unknown" }} />
    );
    // A well-formed urn whose type is simply not a routed registry.
    const unroutedType = renderToStaticMarkup(
      <EndpointName
        edge={{ ...base, otherEndpointUrn: "urn:scp:default:not-a-registry:something" }} />
    );
    for (const html of [degradedToday, degradedSentinel, unroutedType]) {
      expect(html).not.toContain("<a ");
      expect(html).not.toContain("href=");
      // The name is still shown — the row never drops out of the report.
      expect(html).toContain(base.otherEndpointName);
    }
  });

  it("confirm copy states the one-way property and the withheld-edge semantics", () => {
    const html = renderToStaticMarkup(<PublishConfirmBody />);
    expect(html).toContain("one-way");
    expect(html).toContain("there is no un-publish");
    expect(html).toContain("cannot be recalled");
    // The withheld bucket's meaning — edges to still-local endpoints stay home.
    expect(html).toContain("withheld");
    expect(html).toContain("until that endpoint is published");
  });
});
