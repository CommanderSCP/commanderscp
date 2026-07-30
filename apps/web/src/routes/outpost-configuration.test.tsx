import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OutpostTrustTierSchema } from "@scp/schemas";
import type {
  FederationPeerStatus,
  OutpostConfig,
  OutpostConfigReconcileResult
} from "@scp/schemas";

/**
 * M16.2 phase B (B3) — PER-OUTPOST CONFIGURATION, pinned on every PR.
 *
 * Four separate contracts live in this card and each has its own way of going wrong:
 *
 *  1. TRUST TIER — absent until set. A blank select that reads as `commercial` is the invented
 *     posture this milestone exists to prevent; and phase A has no clear-to-unknown verb, so the
 *     placeholder must never be submittable once a tier exists.
 *  2. AN UNVERIFIED SHADOW — must SAY it is one and offer the reconcile verb, and the edit must be
 *     gated on the MEASURED 409 (`outpost-handfill-wedge.integration.test.ts`: PATCH on a
 *     shadow-only peer answers 409 "read-only replica"), never quietly overwritten.
 *  3. POKE-MODE — labelled THIS SIDE ONLY. One toggle presented as controlling both sides is a claim
 *     about a database this instance cannot write.
 *  4. RECONCILE — the two removal outcomes must be visibly different, and a removal that PROPAGATES
 *     downstream must say so BEFORE it is taken.
 *
 * Also pinned: the "managed elsewhere" notes offer NO edit control at all (owner decision), because
 * an edit box that silently does nothing downstream is worse than no box — freezes are TESTED never
 * to ride the journal (`coordination/service-board-precedence.integration.test.ts`).
 */
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>
}));

const {
  DeclareConfigCard,
  ManagedElsewhereNotes,
  MANAGED_ELSEWHERE,
  PokeModeCard,
  ReconcileOutcome,
  ReconcilePanel,
  TrustTierCard,
  claimantsForPeer,
  declaredTierOf,
  hasAuthorityConflict,
  isConfigForeign,
  isUnilateralSparse,
  removalPreview
} = await import("./outpost-configuration");

const PEER_ID = "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";
const OWN_DOMAIN = "aa11bb22-cc33-4d44-8e55-ff6677889900";
const OTHER_DOMAIN = "bb22cc33-dd44-4e55-9f66-001122334455";

function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, " ");
}

/** The single element tag carrying `attr` — React emits attributes in JSX order, so a regex anchored
 *  on one attribute and reaching for another is a coin flip. Slicing the tag out makes the assertion
 *  about the ELEMENT, which is what is actually being claimed. */
function tagWithAttr(html: string, attr: string): string {
  const at = html.indexOf(attr);
  expect(at, `element carrying ${attr} is rendered`).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<", at), html.indexOf(">", at) + 1);
}

/** The open tag immediately preceding a piece of rendered text (for `<option>`s, whose identity is
 *  their label rather than a testid). */
function openTagBefore(html: string, text: string): string {
  const at = html.indexOf(text);
  expect(at, `text ${text} is rendered`).toBeGreaterThan(-1);
  const start = html.lastIndexOf("<", at);
  return html.slice(start, html.indexOf(">", start) + 1);
}

function configFixture(overrides: Partial<OutpostConfig> = {}): OutpostConfig {
  return {
    objectId: "11111111-1111-4111-8111-111111111111",
    urn: `urn:scp:outpost:${PEER_ID}`,
    name: "amer-prod",
    peerDomainId: PEER_ID,
    trustTier: null,
    originDomainId: OWN_DOMAIN,
    originIsSelf: true,
    provenance: null,
    revision: 1,
    version: 1,
    unknownFields: ["trustTier"],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides
  };
}

/** The hand-filled shadow: foreign origin, `provenance: 'manual'`, tier declared unknown even though
 *  a value rides the wire. */
function shadowFixture(overrides: Partial<OutpostConfig> = {}): OutpostConfig {
  return configFixture({
    objectId: "22222222-2222-4222-8222-222222222222",
    trustTier: "il5",
    originDomainId: OTHER_DOMAIN,
    originIsSelf: false,
    provenance: "manual",
    unknownFields: ["trustTier"],
    ...overrides
  });
}

/** A signature-verified replica of another authoring domain's row — the one reconcile refuses to
 *  delete, with or without `?keep=`. */
function replicaFixture(overrides: Partial<OutpostConfig> = {}): OutpostConfig {
  return configFixture({
    objectId: "33333333-3333-4333-8333-333333333333",
    trustTier: "govcloud",
    originDomainId: OTHER_DOMAIN,
    originIsSelf: false,
    provenance: null,
    unknownFields: [],
    ...overrides
  });
}

function statusFixture(overrides: Partial<FederationPeerStatus> = {}): FederationPeerStatus {
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
    lastPokeReceivedAt: null,
    effectiveCadence: "poll",
    unknownFields: ["healthRollup", "appliedAtPeer"],
    recentTransfers: [],
    ...overrides
  };
}

describe("trust tier: absent until set, and never defaulted", () => {
  it("offers exactly the API's five members, read from the schema itself", () => {
    const html = renderToStaticMarkup(
      <TrustTierCard
        config={configFixture()}
        ownDomainId={OWN_DOMAIN}
        onSave={() => {}}
        onReconcile={() => {}}
      />
    );
    // Not a hardcoded list and not a count: the options ARE the enum, so an enum change moves the UI.
    for (const member of OutpostTrustTierSchema.options) {
      expect(html, `option for ${member}`).toContain(`value="${member}"`);
    }
    expect(OutpostTrustTierSchema.options).toHaveLength(5);
  });

  it("renders an explicit unknown for a tier-less config — never a blank that reads as commercial", () => {
    const html = renderToStaticMarkup(
      <TrustTierCard
        config={configFixture()}
        ownDomainId={OWN_DOMAIN}
        onSave={() => {}}
        onReconcile={() => {}}
      />
    );
    expect(html).toContain('data-testid="config-tier-current"');
    expect(html).toContain('data-trust-tier="unknown"');
    expect(html).toContain("unknown here");
    // The select must not have PRE-SELECTED a member for a config that asserts none — THE most
    // likely way a tier gets invented, since a bare <select> silently selects its first option.
    expect(html).not.toContain('data-trust-tier="commercial"');
    expect(html).toContain('<option value="" disabled=""');
    expect(tagWithAttr(html, 'selected=""'), "the SELECTED option is the placeholder").toContain(
      'value=""'
    );
  });

  it("does not offer the placeholder once a tier IS set — there is no clear-to-unknown verb", () => {
    const html = renderToStaticMarkup(
      <TrustTierCard
        config={configFixture({ trustTier: "il5", unknownFields: [] })}
        ownDomainId={OWN_DOMAIN}
        onSave={() => {}}
        onReconcile={() => {}}
      />
    );
    expect(html).toContain('data-trust-tier="il5"');
    // PREMISE for the assertion above: when a tier IS asserted, THAT member is the selected one.
    expect(tagWithAttr(html, 'selected=""')).toContain('value="il5"');
    // Offering "— not set —" here would advertise an un-assert the API cannot perform.
    expect(html).not.toContain("— not set —");
  });
});

describe("trust tier: an unverified shadow is named, not overwritten", () => {
  it("says it is a hand-filled shadow, offers reconcile, and disables the edit on the MEASURED 409", () => {
    const html = renderToStaticMarkup(
      <TrustTierCard
        config={shadowFixture()}
        ownDomainId={OWN_DOMAIN}
        onSave={() => {}}
        onReconcile={() => {}}
      />
    );

    expect(html).toContain('data-testid="config-unverified-shadow-notice"');
    expect(html).toContain('data-testid="config-adopt-shadow"');
    expect(html).toContain('data-tier-unverified="true"');
    expect(visibleText(html)).toContain("unverified");
    // The server answers 409 for a PATCH against a row this domain did not author, so the control is
    // disabled — mirroring a measured refusal, not guessing at one. Asserted on the SELECT and on the
    // guard's own explanation, because the Save button is ALSO disabled while the draft matches the
    // stored value: keying only on that would have passed with the gate removed entirely.
    expect(tagWithAttr(html, 'data-testid="config-tier-select"')).toContain('disabled=""');
    expect(tagWithAttr(html, 'data-testid="config-tier-save"')).toContain('disabled=""');
    expect(tagWithAttr(html, 'data-testid="config-tier-save"')).toContain("read-only replica");
  });

  it("PREMISE: a config this domain AUTHORED is editable — the gate is not blanket caution", () => {
    const html = renderToStaticMarkup(
      <TrustTierCard
        config={configFixture({ trustTier: "il5", unknownFields: [] })}
        ownDomainId={OWN_DOMAIN}
        onSave={() => {}}
        onReconcile={() => {}}
      />
    );
    // A UI that blocks a write the server accepts is a defect this repo has already fixed once, so
    // the un-gated case is asserted too: the select is enabled and the shadow notice is absent.
    expect(html).not.toContain('data-testid="config-unverified-shadow-notice"');
    expect(tagWithAttr(html, 'data-testid="config-tier-select"')).not.toContain("disabled");
    expect(tagWithAttr(html, 'data-testid="config-tier-save"')).not.toContain("read-only replica");
  });

  it("isConfigForeign prefers the server's own originIsSelf and never fabricates a block", () => {
    expect(isConfigForeign(configFixture(), OWN_DOMAIN)).toBe(false);
    expect(isConfigForeign(shadowFixture(), OWN_DOMAIN)).toBe(true);
    // originIsSelf absent (an older server) -> fall back to the domain compare…
    const legacy = configFixture({ originIsSelf: undefined, originDomainId: OTHER_DOMAIN });
    expect(isConfigForeign(legacy, OWN_DOMAIN)).toBe(true);
    // …and with the OWN domain id still loading, nothing is blocked.
    expect(isConfigForeign(legacy, undefined)).toBe(false);
  });
});

describe("poke-mode: this side only", () => {
  it("labels the flag as this side's half of a two-sided consent", () => {
    const html = renderToStaticMarkup(
      <PokeModeCard status={statusFixture()} onToggle={() => {}} />
    );
    expect(html).toContain('data-testid="poke-mode-both-sides-note"');
    const text = visibleText(html);
    expect(text).toContain("this side");
    expect(text).toContain("does not set the outpost");
    // The control names the side it acts on, so it cannot be read as flipping both.
    expect(text).toContain("Enable poke-mode on this side");
  });

  it("renders the UNILATERAL-SPARSE misconfiguration as such", () => {
    const sparse = statusFixture({
      peer: { ...statusFixture().peer, pokeMode: true },
      lastPokeReceivedAt: null,
      effectiveCadence: "poll"
    });
    expect(isUnilateralSparse(sparse)).toBe(true);

    const html = renderToStaticMarkup(<PokeModeCard status={sparse} onToggle={() => {}} />);
    expect(html).toContain('data-testid="poke-mode-unilateral-sparse"');
    expect(visibleText(html)).toContain("no poke has ever been received");
  });

  it("does NOT warn when a poke has actually been received", () => {
    const healthy = statusFixture({
      peer: { ...statusFixture().peer, pokeMode: true },
      lastPokeReceivedAt: "2026-07-29T09:00:00.000Z",
      effectiveCadence: "poke"
    });
    expect(isUnilateralSparse(healthy)).toBe(false);
    const html = renderToStaticMarkup(<PokeModeCard status={healthy} onToggle={() => {}} />);
    expect(html).not.toContain('data-testid="poke-mode-unilateral-sparse"');
  });
});

describe("managed elsewhere: shown, never editable", () => {
  it("names all three and offers no control", () => {
    const html = renderToStaticMarkup(<ManagedElsewhereNotes />);

    for (const item of MANAGED_ELSEWHERE) {
      expect(html, item.id).toContain(`data-testid="managed-elsewhere-${item.id}"`);
    }
    expect(html).toContain('data-editable="false"');
    // THE OWNER DECISION, enforced: no button, no input, no select anywhere in this block.
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<select");
    // …and it says where each one really is configured, so "no control here" is not a dead end.
    expect(visibleText(html)).toContain("does NOT ride the sync journal");
  });
});

describe("reconcile: the two removal outcomes are never one bucket", () => {
  it("classifies each dropped row from its own provenance", () => {
    const local = configFixture({ trustTier: "il5" });
    const shadow = shadowFixture();
    const replica = replicaFixture();

    // Keep the local row: the shadow's removal is a silent local cleanup…
    expect(removalPreview([local, shadow], local.objectId, OWN_DOMAIN)).toEqual([
      { config: shadow, outcome: "local-cleanup" }
    ]);
    // …keep the shadow, and the LOCAL row's removal propagates downstream.
    expect(removalPreview([local, shadow], shadow.objectId, OWN_DOMAIN)).toEqual([
      { config: local, outcome: "propagates-downstream" }
    ]);
    // …and keeping anything that requires deleting a VERIFIED replica is refused outright.
    expect(removalPreview([local, replica], local.objectId, OWN_DOMAIN)).toEqual([
      { config: replica, outcome: "refused" }
    ]);
  });

  it("states a PROPAGATING removal before it can be taken, and refuses the impossible choice", () => {
    const local = configFixture({ trustTier: "il5" });
    const shadow = shadowFixture();
    const replica = replicaFixture();
    const html = renderToStaticMarkup(
      <ReconcilePanel
        claimants={[local, shadow, replica]}
        ownDomainId={OWN_DOMAIN}
        onReconcile={() => {}}
      />
    );

    expect(html).toContain('data-outcome="propagates-downstream"');
    expect(html).toContain('data-outcome="local-cleanup"');
    expect(html).toContain('data-outcome="refused"');
    expect(visibleText(html)).toContain("PROPAGATES to the outpost");

    // Every "keep" choice here would require deleting the verified replica, so every button is
    // disabled rather than offered-and-409'd…
    expect(html).toContain('data-testid="reconcile-confirm-propagating"');
    // Keeping the LOCAL row would require deleting the verified replica — the server refuses that
    // outright, so the button is disabled and says why rather than being offered and 409'd.
    expect(tagWithAttr(html, `data-keep="${local.objectId}"`)).toContain('disabled=""');
    expect(tagWithAttr(html, `data-keep="${local.objectId}"`)).toContain(
      "signature-verified replica"
    );
  });

  it("gates a propagating removal behind an explicit confirmation", () => {
    const localA = configFixture({ objectId: "44444444-4444-4444-8444-444444444444" });
    const localB = configFixture({ objectId: "55555555-5555-4555-8555-555555555555" });
    const html = renderToStaticMarkup(
      <ReconcilePanel
        claimants={[localA, localB]}
        ownDomainId={OWN_DOMAIN}
        onReconcile={() => {}}
      />
    );
    // Both rows are locally authored, so either choice drops one this domain authored: the button is
    // held until the operator confirms they understand the removal propagates.
    expect(html).toContain('data-testid="reconcile-confirm-propagating"');
    expect(tagWithAttr(html, `data-keep="${localA.objectId}"`)).toContain('disabled=""');
    expect(tagWithAttr(html, `data-keep="${localB.objectId}"`)).toContain('disabled=""');
  });

  it("renders a shadow cleanup and a propagating tombstone in visibly different ways", () => {
    const shadowOnly: OutpostConfigReconcileResult = {
      config: configFixture({ trustTier: "il5" }),
      adoptedObjectId: null,
      removedShadowObjectIds: ["22222222-2222-4222-8222-222222222222"],
      removedLocalObjectIds: []
    };
    const localDropped: OutpostConfigReconcileResult = {
      config: replicaFixture(),
      adoptedObjectId: null,
      removedShadowObjectIds: [],
      removedLocalObjectIds: ["11111111-1111-4111-8111-111111111111"]
    };

    const shadowHtml = renderToStaticMarkup(<ReconcileOutcome result={shadowOnly} />);
    const localHtml = renderToStaticMarkup(<ReconcileOutcome result={localDropped} />);

    expect(shadowHtml).toContain('data-testid="reconcile-removed-shadows"');
    expect(shadowHtml).not.toContain('data-testid="reconcile-removed-local"');
    expect(visibleText(shadowHtml)).toContain("a local cleanup only");
    expect(visibleText(shadowHtml)).not.toContain("PROPAGATES");

    expect(localHtml).toContain('data-testid="reconcile-removed-local"');
    expect(localHtml).not.toContain('data-testid="reconcile-removed-shadows"');
    expect(visibleText(localHtml)).toContain("PROPAGATES");
    // …and only the propagating one is styled as destructive.
    expect(localHtml).toContain("bg-red-50");
    expect(shadowHtml).not.toContain("bg-red-50");
  });

  it("an adoption is reported as an adoption, not as a removal", () => {
    const adopted: OutpostConfigReconcileResult = {
      config: configFixture({ trustTier: "il5" }),
      adoptedObjectId: "22222222-2222-4222-8222-222222222222",
      removedShadowObjectIds: [],
      removedLocalObjectIds: []
    };
    const html = renderToStaticMarkup(<ReconcileOutcome result={adopted} />);
    expect(html).toContain('data-testid="reconcile-adopted"');
    expect(html).not.toContain('data-testid="reconcile-removed-local"');
    expect(html).not.toContain('data-testid="reconcile-removed-shadows"');
  });
});

describe("the conflict is detected from the LIST, not from a resolved single read", () => {
  it("finds two claimants bound to one peer", () => {
    const configs = [
      configFixture(),
      shadowFixture(),
      configFixture({ peerDomainId: OTHER_DOMAIN })
    ];
    expect(claimantsForPeer(configs, PEER_ID)).toHaveLength(2);
    expect(hasAuthorityConflict(configs, PEER_ID)).toBe(true);
    expect(hasAuthorityConflict(configs, OTHER_DOMAIN)).toBe(false);
    expect(hasAuthorityConflict(undefined, PEER_ID)).toBe(false);
  });
});

describe("declaring a config object", () => {
  it("does not offer the create control for a non-outpost peer (a MEASURED 400)", () => {
    const retrans = { ...statusFixture().peer, role: "retrans" as const };
    const html = renderToStaticMarkup(<DeclareConfigCard peer={retrans} onCreate={() => {}} />);
    expect(html).toContain('data-testid="config-role-not-outpost"');
    expect(html).not.toContain('data-testid="config-declare-save"');
  });

  it("lets an operator declare the object WITHOUT inventing a tier", () => {
    const html = renderToStaticMarkup(
      <DeclareConfigCard peer={statusFixture().peer} onCreate={() => {}} />
    );
    expect(html).toContain('data-testid="config-declare-save"');
    // The leave-unset option is SELECTABLE here, unlike the editor — creating without a tier is the
    // whole reason `trustTier` is optional on the create body.
    expect(openTagBefore(html, "— leave unset —")).toContain('value=""');
    // SELECTABLE here, unlike the editor's placeholder — an operator who has not decided the tier
    // must be able to declare the object without one being invented for them.
    expect(openTagBefore(html, "— leave unset —")).not.toContain("disabled");
  });

  it("maps the leave-unset option to an ABSENT trustTier, never an empty string", () => {
    // `CreateOutpostConfigRequestSchema` is a `z.strictObject` and `trustTier` is the five-member
    // enum, so `trustTier: ""` is a 400 — and, worse, a select value silently coerced to a member
    // would be an invented posture. Absent is the only honest encoding of "not decided yet".
    expect(declaredTierOf("")).toBeUndefined();
    expect(declaredTierOf("il5")).toBe("il5");
  });
});
