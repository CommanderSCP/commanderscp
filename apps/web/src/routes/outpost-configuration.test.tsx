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
 * an edit box that silently does nothing downstream is worse than no box.
 *
 * M25.7 RETIRED HALF OF THAT REASON. This header used to add "— freezes are TESTED never to ride the
 * journal (`coordination/service-board-precedence.integration.test.ts`)", which was true and pinned
 * until owner decision D6 gave an org-tier freeze a graph object so it CAN cross. The no-edit-control
 * ruling survives on the reason that did NOT change: a freeze is scoped at an object in the org's
 * containment graph and there is no "the outpost this freeze belongs to", so a per-outpost freeze
 * form would be structurally wrong rather than merely absent. The case below pins the REWRITTEN copy,
 * which is what makes this a rewrite rather than a silent deletion.
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
  defaultSurvivor,
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

  it("treats an ABSENT tier key exactly like a null one — no empty badge, no orphan select", () => {
    // `OutpostConfigSchema.trustTier` is required-nullable, and BEFORE ADR-0023 the generated SDK
    // validated no response, so a server that omitted the key handed this component `undefined`
    // (since ADR-0023 that body rejects at the SDK boundary; this drives the component directly,
    // which is where the guard itself lives). Keyed on `=== null`, that fell through to the
    // VALUE branch and rendered an empty `<Badge>` with no `data-trust-tier` attribute — a blank
    // standing in for an unknown — while the select, initialised with `?? ""`, showed a value no
    // option carried.
    const noKey = configFixture();
    delete (noKey as { trustTier?: unknown }).trustTier;

    const html = renderToStaticMarkup(
      <TrustTierCard
        config={noKey as OutpostConfig}
        ownDomainId={OWN_DOMAIN}
        onSave={() => {}}
        onReconcile={() => {}}
      />
    );

    expect(html).toContain('data-trust-tier="unknown"');
    expect(html).toContain("unknown here");
    // The placeholder is offered (nothing is asserted) and IS the selected option, so the control
    // cannot silently settle on the first enum member.
    expect(html).toContain("— not set —");
    expect(tagWithAttr(html, 'selected=""')).toContain('value=""');
    expect(html).not.toContain("data-tier-unverified=");
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

  it("a shadow is still a shadow while ownDomainId is LOADING — no authority, no enabled edit", () => {
    // THE WINDOW: `originIsSelf` absent (an older server) and `ownDomainId` not yet resolved.
    // `isConfigForeign` answers FALSE there BY DESIGN — never fabricate a block on a write the server
    // would accept — so gating the unverified marker on `foreign && provenance === "manual"` made a
    // hand-typed shadow render `data-tier-unverified="false"` with an ENABLED edit control: a manual
    // claim presented as this domain's own authority, for as long as the query took.
    const loading = shadowFixture({ originIsSelf: undefined });
    expect(isConfigForeign(loading, undefined), "the premise: origin is undecidable here").toBe(
      false
    );

    const html = renderToStaticMarkup(
      <TrustTierCard
        config={loading}
        ownDomainId={undefined}
        onSave={() => {}}
        onReconcile={() => {}}
      />
    );

    // `provenance: "manual"` IS the statement — the schema defines it as a hand-filled shadow — and it
    // does not depend on a value still in flight.
    expect(html).toContain('data-tier-unverified="true"');
    expect(html).not.toContain('data-tier-unverified="false"');
    expect(visibleText(html)).toContain("unverified");
    expect(html).toContain('data-testid="config-unverified-shadow-notice"');
    // The edit control mirrors the MEASURED 409 for a hand-filled shadow, rather than being offered
    // and refused.
    expect(tagWithAttr(html, 'data-testid="config-tier-select"')).toContain('disabled=""');
    expect(tagWithAttr(html, 'data-testid="config-tier-save"')).toContain("read-only replica");
  });

  /**
   * ROUND 3 — W3 WAS APPLIED ONE FILE OVER AND NOT HERE.
   *
   * `outposts.tsx`'s `TrustTierCell` was fixed to OR the two signals the server emits for this one
   * case; `TrustTierCard` still decided declared-vs-unverified from `provenance` ALONE. But
   * `toOutpostConfig` (`outposts-repo.ts`) pushes `"trustTier"` into `unknownFields` in exactly two
   * cases — no tier at all, or `provenance === "manual"` — so a config that HAS a tier and declares
   * it unknown IS the shadow case, and `OutpostConfigSchema.provenance` is
   * `.nullable().optional()`, so a well-formed response may simply omit the key.
   *
   * MEASURED before the fix: this config rendered BYTE-IDENTICAL to a signature-verified replica of
   * the same tier — `data-tier-unverified="false"`, no shadow notice, edit control offered.
   */
  it("a tier the server DECLARES unknown is unverified even with the provenance key omitted", () => {
    const noProvenance = shadowFixture({ trustTier: "commercial" });
    delete (noProvenance as { provenance?: unknown }).provenance;
    // PREMISE: the ONLY signal left is the declaration.
    expect(noProvenance.provenance).toBeUndefined();
    expect(noProvenance.unknownFields).toContain("trustTier");

    const html = renderToStaticMarkup(
      <TrustTierCard
        config={noProvenance}
        ownDomainId={OWN_DOMAIN}
        onSave={() => {}}
        onReconcile={() => {}}
      />
    );
    // The comparison that actually bites: a signature-verified replica of the SAME tier, which is a
    // value this domain may legitimately show as an assertion.
    const verified = renderToStaticMarkup(
      <TrustTierCard
        config={replicaFixture({ trustTier: "commercial", unknownFields: [] })}
        ownDomainId={OWN_DOMAIN}
        onSave={() => {}}
        onReconcile={() => {}}
      />
    );

    expect(html).not.toBe(verified);
    expect(html).toContain('data-tier-unverified="true"');
    expect(html).not.toContain('data-tier-unverified="false"');
    expect(visibleText(html)).toContain("unverified");
    expect(html).toContain('data-testid="config-unverified-shadow-notice"');
    // PREMISE, so this cannot pass by the verified case having regressed into an unverified one:
    // a replica whose tier the server does NOT declare unknown is still shown as an assertion.
    expect(verified).toContain('data-tier-unverified="false"');
    expect(verified).not.toContain('data-testid="config-unverified-shadow-notice"');
  });

  it("the OTHER direction: a manual shadow whose declaration is missing still READS as unverified", () => {
    // The mirror of the test above, and it is not symmetric bookkeeping: the visible "unverified"
    // word was rendered behind `tierUnknown && unverifiedShadow`, so an older server that sends
    // `provenance: "manual"` but declares nothing left an operator with only an ATTRIBUTE and a
    // badge VARIANT to tell a hand-typed claim from this domain's own assertion — neither of which
    // anybody reads. Whenever the value is shown as unverified, it must SAY so.
    const undeclared = shadowFixture({ trustTier: "commercial", unknownFields: [] });
    expect(undeclared.provenance).toBe("manual");
    expect(undeclared.unknownFields).toHaveLength(0);

    const html = renderToStaticMarkup(
      <TrustTierCard
        config={undeclared}
        ownDomainId={OWN_DOMAIN}
        onSave={() => {}}
        onReconcile={() => {}}
      />
    );
    expect(html).toContain('data-tier-unverified="true"');
    // THE HALF THAT WAS MISSING: the rendered text, not the attribute beside it.
    expect(visibleText(html)).toContain("unverified");
    expect(html).toContain('data-testid="outpost-unknown"');
  });

  it("NO OVER-BLOCKING: an ordinary local config with no tier yet stays fully editable", () => {
    // The guard rail on the fix above. A locally-authored config with NO tier ALSO declares
    // `trustTier` unknown (`if (trustTier === null) unknownFields.push("trustTier")`), and it is the
    // ordinary declare-then-set flow — so keying the unverified/edit-gate on the declaration ALONE
    // would disable the very control this milestone exists to offer. `!isAbsent(config.trustTier)`
    // is what keeps the two apart, and this is what fails if it is dropped.
    const fresh = configFixture();
    expect(fresh.trustTier).toBeNull();
    expect(fresh.unknownFields).toContain("trustTier");

    const html = renderToStaticMarkup(
      <TrustTierCard
        config={fresh}
        ownDomainId={OWN_DOMAIN}
        onSave={() => {}}
        onReconcile={() => {}}
      />
    );
    expect(html).toContain('data-trust-tier="unknown"');
    expect(html).not.toContain('data-testid="config-unverified-shadow-notice"');
    expect(tagWithAttr(html, 'data-testid="config-tier-select"')).not.toContain("disabled");
    expect(tagWithAttr(html, 'data-testid="config-tier-save"')).not.toContain("read-only replica");
  });

  it("survives a response that omits unknownFields — an unknown, never a blank panel", () => {
    // `unknownFields` is required-not-optional and BEFORE ADR-0023 the SDK validated no response, so
    // `config.unknownFields.includes(...)` threw a TypeError and BLANKED THE WHOLE CARD — under the
    // very response shape the guards here exist for. Fail loud beats fail dishonest; a white screen
    // is neither. (Since ADR-0023 that body rejects at the SDK boundary; this case drives the
    // component directly, where the guard itself lives.)
    const noDeclaration = configFixture({ trustTier: "il5" });
    delete (noDeclaration as { unknownFields?: unknown }).unknownFields;

    const html = renderToStaticMarkup(
      <TrustTierCard
        config={noDeclaration as OutpostConfig}
        ownDomainId={OWN_DOMAIN}
        onSave={() => {}}
        onReconcile={() => {}}
      />
    );
    expect(html).toContain('data-trust-tier="il5"');
    expect(html).toContain('data-testid="config-tier-select"');
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
    //
    // DELIBERATE INVERSION (M25.7, owner decision D6). This line asserted `"does NOT ride the sync
    // journal"` — the operator-facing correction of M16.2's "syncs down" aspiration, true and
    // load-bearing until D6 gave an org-tier freeze a graph object. Asserting the old sentence now
    // would pin a lie in place; asserting nothing would let the note go silent. So it pins the two
    // claims the rewritten copy actually makes: freezes are declared PER OBJECT and never per
    // outpost (the structural reason there is no form here, which D6 did not touch), and reaching
    // this outpost is CONDITIONAL on the declaring domain federating it (the part D6 changed).
    const text = visibleText(html);
    expect(text).toContain("never per outpost");
    expect(text).toContain("only if it was declared federating");
    expect(text).not.toContain("does NOT ride the sync journal");
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

  it("the DEFAULT button does not route around the gate the per-row buttons enforce", () => {
    // THE MEASURED BYPASS. With two locally-authored claimants both `reconcile-keep` buttons carried
    // `disabled=""` — either choice drops a row this domain authored, whose tombstone PROPAGATES
    // downstream to the outpost — while the bare `reconcile-default` button called the SAME
    // destructive verb with no preview, no per-outcome block, no confirmation, and a label naming no
    // consequence, and was fully clickable.
    const localA = configFixture({ objectId: "44444444-4444-4444-8444-444444444444" });
    const localB = configFixture({ objectId: "55555555-5555-4555-8555-555555555555" });
    const tied = renderToStaticMarkup(
      <ReconcilePanel
        claimants={[localA, localB]}
        ownDomainId={OWN_DOMAIN}
        onReconcile={() => {}}
      />
    );
    // Two rows of EQUAL authority: the server breaks that tie by creation order, so this side cannot
    // preview a survivor. It declines to offer the default rather than guess at one.
    expect(defaultSurvivor([localA, localB], OWN_DOMAIN)).toBeNull();
    expect(tied).toContain('data-testid="reconcile-default-indeterminate"');
    expect(tied).not.toContain('data-testid="reconcile-default"');

    // A DETERMINATE default — one local row outranks one shadow — IS offered, and carries the whole
    // gate: a per-outcome preview block and the same confirmation the per-row buttons use.
    const shadow = shadowFixture();
    const determinate = renderToStaticMarkup(
      <ReconcilePanel
        claimants={[localA, shadow]}
        ownDomainId={OWN_DOMAIN}
        onReconcile={() => {}}
      />
    );
    expect(defaultSurvivor([localA, shadow], OWN_DOMAIN)).toBe(localA);
    expect(determinate).toContain('data-testid="reconcile-default-block"');
    // It NAMES the survivor it previews — on the block AND on the button that sends it — so the
    // request cannot diverge from what was shown. (`renderToStaticMarkup` cannot fire the handler,
    // so the attribute is what makes the named survivor machine-checkable at all.)
    expect(tagWithAttr(determinate, 'data-testid="reconcile-default-block"')).toContain(
      `data-keep="${localA.objectId}"`
    );
    expect(tagWithAttr(determinate, 'data-testid="reconcile-default"')).toContain(
      `data-keep="${localA.objectId}"`
    );

    // PREMISE, so "gated" is not just "always disabled": the determinate default here drops only a
    // shadow — a silent local cleanup — and IS clickable. The gate is not blanket caution.
    // (`disabled=""`, not `disabled`: the button's own class list carries `disabled:opacity-50`.)
    expect(tagWithAttr(determinate, 'data-testid="reconcile-default"')).not.toContain(
      'disabled=""'
    );
    expect(determinate).toContain('data-outcome="local-cleanup"');
  });

  it("no offered default can ever perform a downstream-propagating removal", () => {
    // THE STRUCTURAL RULE, asserted over every arrangement of the three claimant kinds rather than
    // over the two the review happened to render. `propagates-downstream` means dropping a row THIS
    // domain authored — a journaled tombstone the outpost applies — and that choice must always be
    // made explicitly, per row, behind the confirmation. So: whenever a default IS offered, its own
    // preview contains no such outcome.
    const kinds = {
      local: configFixture({ objectId: "44444444-4444-4444-8444-444444444444" }),
      local2: configFixture({ objectId: "55555555-5555-4555-8555-555555555555" }),
      shadow: shadowFixture(),
      shadow2: shadowFixture({ objectId: "66666666-6666-4666-8666-666666666666" }),
      replica: replicaFixture(),
      replica2: replicaFixture({ objectId: "77777777-7777-4777-8777-777777777777" })
    };
    const all = Object.values(kinds);
    const combos: OutpostConfig[][] = [];
    for (let i = 0; i < all.length; i += 1) {
      for (let j = i + 1; j < all.length; j += 1) {
        combos.push([all[i]!, all[j]!]);
        for (let k = j + 1; k < all.length; k += 1) combos.push([all[i]!, all[j]!, all[k]!]);
      }
    }
    expect(combos.length).toBeGreaterThan(20);

    let offered = 0;
    for (const claimants of combos) {
      const html = renderToStaticMarkup(
        <ReconcilePanel claimants={claimants} ownDomainId={OWN_DOMAIN} onReconcile={() => {}} />
      );
      const ids = claimants.map((c) => c.objectId).join(",");
      if (!html.includes('data-testid="reconcile-default-block"')) {
        expect(html, ids).toContain('data-testid="reconcile-default-indeterminate"');
        continue;
      }
      offered += 1;
      const block = tagWithAttr(html, 'data-testid="reconcile-default-block"');
      const keep = /data-keep="([^"]+)"/.exec(block)?.[1];
      expect(keep, `the offered default names its survivor (${ids})`).toBeDefined();
      // The default's OWN preview, computed from the survivor it names — not the whole panel's, which
      // legitimately contains propagating outcomes for the per-row choices.
      const preview = removalPreview(claimants, keep!, OWN_DOMAIN);
      expect(
        preview.map((entry) => entry.outcome),
        `offered default for ${ids} must not propagate`
      ).not.toContain("propagates-downstream");
    }
    // …and the rule is not satisfied by never offering a default at all.
    expect(offered).toBeGreaterThan(0);
  });

  it("a default that would need to delete a VERIFIED replica is disabled and says why", () => {
    // Local row (rank 0) outranks the verified replica (rank 1), so the default keeps the local row —
    // which requires deleting the replica, and reconcile refuses that outright (409). Disabled with
    // the reason, rather than offered and refused.
    const local = configFixture();
    const replica = replicaFixture();
    const html = renderToStaticMarkup(
      <ReconcilePanel
        claimants={[local, replica]}
        ownDomainId={OWN_DOMAIN}
        onReconcile={() => {}}
      />
    );
    expect(html).toContain('data-testid="reconcile-default-block"');
    expect(tagWithAttr(html, 'data-testid="reconcile-default"')).toContain('disabled=""');
    expect(tagWithAttr(html, 'data-testid="reconcile-default"')).toContain(
      "signature-verified replica"
    );
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

  /**
   * ROUND 3 — THE SAME `=== null` HALF-GUARD, IN THE FILE WHOSE COMMIT IS TITLED "guard both,
   * everywhere". `adoptedObjectId` is required-nullable, and BEFORE ADR-0023 the SDK validated no
   * response. (Since ADR-0023 an omitted required key rejects at the SDK boundary; this case drives
   * the component directly, where the guard itself lives.)
   *
   * MEASURED with `adoptedObjectId: undefined`, BOTH mirrors misfired at once:
   *   * `!== null` was TRUE, so the panel emitted `<p data-testid="reconcile-adopted">Adopted
   *     <code></code> as this domain's own configuration — it journals down to the outpost from now
   *     on.</p>` — an EMPTY element inside a confident claim about a journaling side-effect; and
   *   * `=== null` was FALSE, so the honest `reconcile-removed-none` branch was suppressed.
   * The operator was told an adoption happened AND denied the statement that nothing did.
   */
  it("an ABSENT adoptedObjectId claims no adoption — and does not suppress 'nothing removed'", () => {
    const absent = {
      config: configFixture({ trustTier: "il5" }),
      removedShadowObjectIds: [],
      removedLocalObjectIds: []
    } as unknown as OutpostConfigReconcileResult;
    // The KEY IS MISSING, which is what an omitting server actually sends.
    expect("adoptedObjectId" in absent).toBe(false);

    const html = renderToStaticMarkup(<ReconcileOutcome result={absent} />);
    expect(html).not.toContain('data-testid="reconcile-adopted"');
    expect(visibleText(html)).not.toMatch(/Adopted\s+as this domain/);
    expect(visibleText(html)).not.toMatch(/journals down to the outpost/);
    expect(html).toContain('data-testid="reconcile-removed-none"');
    expect(visibleText(html)).toContain("Nothing needed removing");
  });

  it("survives a response that omits the removed-id arrays — an outcome, never a blank panel", () => {
    // Both arrays are required-not-optional and are dereferenced four times for `.length`, so an
    // omitting server threw a TypeError over the WHOLE outcome panel — i.e. the operator saw nothing
    // at all about a destructive verb that had just run.
    const bare = {
      config: configFixture({ trustTier: "il5" }),
      adoptedObjectId: null
    } as unknown as OutpostConfigReconcileResult;

    const html = renderToStaticMarkup(<ReconcileOutcome result={bare} />);
    expect(html).toContain('data-testid="reconcile-result"');
    expect(html).toContain('data-testid="reconcile-removed-none"');
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
