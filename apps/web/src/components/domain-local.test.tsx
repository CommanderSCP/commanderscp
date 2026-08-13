import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  DomainLocalBadge,
  DomainLocalCreateField,
  DomainLocalPublishCard,
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
