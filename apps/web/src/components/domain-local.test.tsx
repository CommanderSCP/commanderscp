import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// House pattern (outposts-honesty.test.tsx). See docs/web.md §37.
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
  ProvenanceLink,
  PublishConfirmBody
} from "./domain-local";

/** The three properties of this UI a refactor could lose. See docs/web.md §38. */

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

  // M20.7 (§6c): provenance is READ from the server's create-time stamp, never derived. The two
  // states must render distinguishably, and the inherited tooltip must carry the container's urn
  // — that's the entire point of having asked the server for the field.
  it("badge tooltip distinguishes declared (null stamp) from inherited (stamped), by urn", () => {
    const declared = renderToStaticMarkup(<DomainLocalBadge inheritedFrom={null} />);
    expect(declared).toContain("Declared directly at create");
    expect(declared).not.toContain("Inherited at create from");

    const inherited = renderToStaticMarkup(
      <DomainLocalBadge
        inheritedFrom={{
          id: "0c1d2e3f-4a5b-4c6d-8e9f-a0b1c2d3e4f5",
          urn: "urn:scp:default:service:secure-partition"
        }}
      />
    );
    expect(inherited).toContain(
      "Inherited at create from urn:scp:default:service:secure-partition"
    );
    expect(inherited).toContain("historical provenance");
    expect(inherited).not.toContain("Declared directly");
  });

  it("provenance link routes a routable container urn and degrades to plain text otherwise", () => {
    const linked = renderToStaticMarkup(
      <ProvenanceLink
        source={{
          id: "0c1d2e3f-4a5b-4c6d-8e9f-a0b1c2d3e4f5",
          urn: "urn:scp:default:service:secure-partition"
        }}
      />
    );
    expect(linked).toContain('href="/services/0c1d2e3f-4a5b-4c6d-8e9f-a0b1c2d3e4f5"');
    expect(linked).toContain("secure-partition");

    const unrouted = renderToStaticMarkup(
      <ProvenanceLink source={{ id: "x", urn: "urn:scp:default:not-a-registry:thing" }} />
    );
    expect(unrouted).not.toContain("<a ");
    expect(unrouted).toContain("thing");
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
    expect(
      renderWithQueryClient(
        <DomainLocalPublishCard object={SHARED} typeId="component" invalidateKeys={[]} />
      )
    ).toBe("");
    // `domainLocal` absent (older payload) must behave as shared, not throw or render.
    const { domainLocal: omitted, ...withoutBit } = SHARED;
    void omitted; // the destructure exists to OMIT the field; void marks the binding deliberate
    expect(
      renderWithQueryClient(
        <DomainLocalPublishCard object={withoutBit} typeId="component" invalidateKeys={[]} />
      )
    ).toBe("");
  });

  it("publish card offers the verb for a domain-local object, and no inverse anywhere", () => {
    const html = renderWithQueryClient(
      <DomainLocalPublishCard object={LOCAL} typeId="component" invalidateKeys={[]} />
    );
    expect(html).toContain('data-testid="publish-object-button"');
    // "There is no un-publish" appears only in the confirm copy (asserted below), never as a
    // control: the card's own markup must not contain an un-publish affordance.
    expect(html.toLowerCase()).not.toMatch(/un-?publish/);
    // No provenance stamp → no provenance line (an absent fact renders as absence, not filler).
    expect(html).not.toContain('data-testid="publish-provenance"');
  });

  it("publish card's provenance line is stamped-fact-only, and disclaims live ordering", () => {
    const html = renderWithQueryClient(
      <DomainLocalPublishCard
        object={{
          ...LOCAL,
          domainLocalInheritedFrom: {
            id: "0c1d2e3f-4a5b-4c6d-8e9f-a0b1c2d3e4f5",
            urn: "urn:scp:default:service:secure-partition"
          }
        }}
        typeId="component"
        invalidateKeys={[]}
      />
    );
    expect(html).toContain('data-testid="publish-provenance"');
    expect(html).toContain("Locality inherited at create from");
    expect(html).toContain("secure-partition");
    // §6c's normative caveat, pinned: the stamp is history, never a §6b publish-order predictor —
    // the server decides ordering at publish time.
    expect(html).toContain("the server");
    expect(html).toContain("publish");
  });

  // The link decision is derived entirely from the urn. See docs/web.md §39.
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
        edge={{ ...base, otherEndpointUrn: "urn:scp:default:not-a-registry:something" }}
      />
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

  it("confirm copy states M20.6's publish order and, critically, the ABSENCE of cascade", () => {
    const html = renderToStaticMarkup(<PublishConfirmBody />);
    // Container-first ordering: a child inside a still-local container is refused.
    expect(html).toContain("publish its containers first");
    // The M20.6 author's explicit warning: never imply that publishing a container publishes
    // what's under it — each child is its own decision. This claim going missing is exactly the
    // copy drift that would promise something the system refuses to do.
    expect(html).toContain("does not publish its children");
    expect(html).toContain("its own explicit decision");
  });
});
