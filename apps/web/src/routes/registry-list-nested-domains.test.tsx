import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { buildCreatePayload, orderDomainOwnedFirst, ParentDomainField } from "./registry-list";

/**
 * G2 (outpost-ui.md §5(b), owner decision 2026-08-13): the domains registry's create form gains an
 * optional "Parent domain" picker, and wires `domainId` into the create payload only when the
 * operator actually chose one.
 *
 * Plain `renderToStaticMarkup`, no router — `RegistryListPage` itself needs a router
 * (`useBasePathParam`), so this file pins the two pieces that DON'T: the picker's own conditional
 * rendering (pulled out as `ParentDomainField`, house pattern per domain-local.test.tsx's
 * publish-card empty-string check) and the payload-shaping rule (`buildCreatePayload`, a pure
 * function so the wiring claim is testable without a live mutation).
 */
describe("registry-list.tsx: nested-domains parent picker (G2)", () => {
  it("ParentDomainField renders the picker, with its testid and top-level placeholder, when shown", () => {
    const html = renderToStaticMarkup(
      <ParentDomainField
        show={true}
        value=""
        onChange={() => {}}
        options={[{ id: "d1", name: "americas" }]}
      />
    );
    expect(html).toContain('data-testid="new-parent-domain-select"');
    expect(html).toContain("Parent domain");
    // Radix's `SelectContent` portals its items (domain-local.test.tsx's precedent: "Radix's dialog
    // portals render nothing statically"), so the option list is not asserted here — only that the
    // trigger renders and states the empty-selection meaning up front.
    expect(html).toContain("Top-level (no parent)");
  });

  it("ParentDomainField renders NOTHING when `show` is false — i.e. every non-domains registry", () => {
    const html = renderToStaticMarkup(
      <ParentDomainField show={false} value="" onChange={() => {}} options={[]} />
    );
    expect(html).toBe("");
  });

  it("buildCreatePayload: domainId rides through only when a parent domain was actually chosen", () => {
    const withParent = buildCreatePayload({
      name: "americas-east",
      serviceMember: false,
      serviceId: "",
      domainLocal: false,
      isDomainsRegistry: true,
      parentDomainId: "parent-domain-id"
    });
    expect(withParent.domainId).toBe("parent-domain-id");

    // Empty selection = top-level (the existing default): `domainId` must be OMITTED, not sent as
    // `""` — an included empty string would 400 at the server (`z.string().uuid()`), the "false
    // silently interpreted as something" failure mode this repo's `domainLocal` omit-rule guards
    // against next to it.
    const noParent = buildCreatePayload({
      name: "top-level-domain",
      serviceMember: false,
      serviceId: "",
      domainLocal: false,
      isDomainsRegistry: true,
      parentDomainId: ""
    });
    expect(noParent).not.toHaveProperty("domainId");
  });

  it("buildCreatePayload: domainId is dropped on every OTHER registry, even if a caller passed one", () => {
    // The picker only renders for the domains registry (`isDomainsRegistry`), so `parentDomainId`
    // should never be non-empty here in practice — but the payload builder is the last line of
    // defence, and this pins that it does not trust the caller.
    const payload = buildCreatePayload({
      name: "some-component",
      serviceMember: true,
      serviceId: "svc-1",
      domainLocal: false,
      isDomainsRegistry: false,
      parentDomainId: "should-be-ignored"
    });
    expect(payload).not.toHaveProperty("domainId");
    expect(payload.service).toBe("svc-1");
  });

  it("buildCreatePayload preserves the existing domainLocal omit-when-unset rule alongside domainId", () => {
    const declared = buildCreatePayload({
      name: "secure-partition",
      serviceMember: false,
      serviceId: "",
      domainLocal: true,
      isDomainsRegistry: true,
      parentDomainId: "parent-domain-id"
    });
    expect(declared.domainLocal).toBe(true);
    expect(declared.domainId).toBe("parent-domain-id");

    const undeclared = buildCreatePayload({
      name: "ordinary",
      serviceMember: false,
      serviceId: "",
      domainLocal: false,
      isDomainsRegistry: true,
      parentDomainId: ""
    });
    expect(undeclared).not.toHaveProperty("domainLocal");
    expect(undeclared).not.toHaveProperty("domainId");
  });
});

/**
 * OWNERSHIP-SHAPED ORDERING (outpost-ui.md §9, owner 2026-08-14) — the outpost's catalog lists put
 * the containers THIS domain owns first, so an operator finds where to hang shared domain IaC/CaC
 * without scanning past commander replicas. Pinned as a pure function: the rule keys ONLY on
 * `originDomainId` vs the instance's own domain — never on labels or names.
 */
describe("registry-list.tsx: domain-owned rows first (outpost catalog)", () => {
  const SELF = "11111111-1111-4111-8111-111111111111";
  const OTHER = "22222222-2222-4222-8222-222222222222";
  const items = [
    { id: "a", originDomainId: OTHER, name: "cmdr-a" },
    { id: "b", originDomainId: SELF, name: "mine-b" },
    { id: "c", originDomainId: OTHER, name: "cmdr-c" },
    { id: "d", originDomainId: SELF, name: "mine-d" }
  ];

  it("puts self-owned rows first, preserving each half's original order", () => {
    expect(orderDomainOwnedFirst(items, SELF).map((i) => i.id)).toEqual(["b", "d", "a", "c"]);
  });

  it("is the identity when the instance's own domain is unknown — never guesses ownership", () => {
    // Federation not initialised → nothing can be attributed; the API's order stands untouched
    // rather than some row being promoted on a hunch.
    expect(orderDomainOwnedFirst(items, undefined).map((i) => i.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("is a no-op when everything is self-owned (the commander's usual case)", () => {
    const allMine = items.map((i) => ({ ...i, originDomainId: SELF }));
    expect(orderDomainOwnedFirst(allMine, SELF)).toEqual(allMine);
  });

  it("does not drop or duplicate rows", () => {
    const out = orderDomainOwnedFirst(items, SELF);
    expect(out).toHaveLength(items.length);
    expect(new Set(out.map((i) => i.id)).size).toBe(items.length);
  });
});
