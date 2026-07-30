// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { OutpostConfig } from "@scp/schemas";
import { fire, render } from "../test-support/render-dom";

/**
 * M16.2 phase B (B3) — WHAT THE CLICK ACTUALLY SENDS.
 *
 * THE ONE THING THIS FILE OWNS, and the reason it is not in `outpost-configuration.test.tsx`: every
 * other web test renders to a STRING (`renderToStaticMarkup`), which cannot fire a handler. So the
 * reconcile panel's central guarantee — that the default button sends the SURVIVOR IT NAMED, never a
 * bare re-derive-it-yourself call — was pinned only as the `data-keep` ATTRIBUTE rendered beside the
 * handler. MEASURED: replacing `onClick={() => onReconcile(defaultKeep.objectId)}` with
 * `onClick={() => onReconcile(undefined)}` left all 102 web tests green.
 *
 * WHY THE DIFFERENCE MATTERS AT RUNTIME, not just on principle. A bare `POST …/reconcile` with no
 * `?keep=` re-derives the survivor SERVER-SIDE (`outposts-repo.ts` `byAuthority`) at request time —
 * AFTER the operator has read a prediction computed from a possibly-stale `listOutposts()` cache. A
 * claimant row that appeared since that fetch is then soft-deleted having NEVER been previewed, and
 * if it is locally authored that is a journaled tombstone which PROPAGATES to the outpost. A stale
 * `?keep=` id cannot do that: it fails safe with the server's 400.
 *
 * This file runs in a happy-dom environment (docblock above) so the handlers can be invoked for
 * real; see `src/test-support/render-dom.tsx` for why that dependency was taken.
 */
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>
}));

const { ReconcilePanel, TrustTierCard } = await import("./outpost-configuration");

const PEER_ID = "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";
const OWN_DOMAIN = "aa11bb22-cc33-4d44-8e55-ff6677889900";
const OTHER_DOMAIN = "bb22cc33-dd44-4e55-9f66-001122334455";

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

describe("reconcile: the default button SENDS the survivor it named", () => {
  it("clicking the default calls onReconcile with the named object id, never bare", () => {
    const local = configFixture();
    const shadow = shadowFixture();
    const onReconcile = vi.fn();
    const view = render(
      <ReconcilePanel
        claimants={[local, shadow]}
        ownDomainId={OWN_DOMAIN}
        onReconcile={onReconcile}
      />
    );

    // PREMISE: this really is the offered-default case, and the attribute names the local row.
    expect(view.byTestId("reconcile-default").getAttribute("data-keep")).toBe(local.objectId);

    view.click("reconcile-default");

    // THE GUARANTEE. `toHaveBeenCalledWith(local.objectId)` is what a bare `onReconcile(undefined)`
    // fails — and the `undefined` assertion below names the exact mutant so a future reader knows
    // what this line is defending, rather than reading it as a redundant restatement.
    expect(onReconcile).toHaveBeenCalledTimes(1);
    expect(onReconcile).toHaveBeenCalledWith(local.objectId);
    expect(onReconcile).not.toHaveBeenCalledWith(undefined);
    view.unmount();
  });

  it("the attribute and the payload cannot diverge — same id, from one render", () => {
    // The two copies of the claim, checked against EACH OTHER rather than each against a fixture:
    // whatever survivor the panel picks, the id it PAINTS and the id it SENDS are the same value.
    const localA = configFixture({ objectId: "44444444-4444-4444-8444-444444444444" });
    const shadow = shadowFixture();
    const onReconcile = vi.fn();
    const view = render(
      <ReconcilePanel
        claimants={[shadow, localA]}
        ownDomainId={OWN_DOMAIN}
        onReconcile={onReconcile}
      />
    );

    const painted = view.byTestId("reconcile-default").getAttribute("data-keep");
    expect(painted).toBe(localA.objectId);
    view.click("reconcile-default");
    expect(onReconcile).toHaveBeenCalledWith(painted);
    view.unmount();
  });

  it("each per-row Keep button sends ITS OWN row, and a disabled one sends nothing", () => {
    // Keeping the shadow drops the local row (propagating) → held behind the confirmation, so it is
    // disabled and a click must do NOTHING. Keeping the local row drops only the shadow → clickable,
    // and must send that row's id.
    const local = configFixture();
    const shadow = shadowFixture();
    const onReconcile = vi.fn();
    const view = render(
      <ReconcilePanel
        claimants={[local, shadow]}
        ownDomainId={OWN_DOMAIN}
        onReconcile={onReconcile}
      />
    );

    const buttons = Array.from(
      view.container.querySelectorAll<HTMLButtonElement>('[data-testid="reconcile-keep"]')
    );
    expect(buttons).toHaveLength(2);
    const keepLocal = buttons.find((b) => b.getAttribute("data-keep") === local.objectId);
    const keepShadow = buttons.find((b) => b.getAttribute("data-keep") === shadow.objectId);
    expect(keepLocal, "a Keep button for the local row").toBeDefined();
    expect(keepShadow, "a Keep button for the shadow row").toBeDefined();

    // PREMISE: the propagating choice really is held.
    expect(keepShadow!.disabled).toBe(true);
    fire(keepShadow!, new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onReconcile, "a disabled destructive button must not fire").not.toHaveBeenCalled();

    fire(keepLocal!, new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onReconcile).toHaveBeenCalledTimes(1);
    expect(onReconcile).toHaveBeenCalledWith(local.objectId);
    view.unmount();
  });

  it("a default that would delete a VERIFIED replica is disabled and sends nothing", () => {
    const local = configFixture();
    const replica = replicaFixture();
    const onReconcile = vi.fn();
    const view = render(
      <ReconcilePanel
        claimants={[local, replica]}
        ownDomainId={OWN_DOMAIN}
        onReconcile={onReconcile}
      />
    );
    expect((view.byTestId("reconcile-default") as HTMLButtonElement).disabled).toBe(true);
    view.click("reconcile-default");
    expect(onReconcile).not.toHaveBeenCalled();
    view.unmount();
  });
});

describe("trust tier: the save button SENDS the tier that was chosen", () => {
  it("sends the selected member, not the stored one and not a blank", () => {
    // The other half of the same class: `onSave(tier as OutpostTrustTier)` reads component state a
    // static render cannot change, so what the button sends was never asserted at all.
    const onSave = vi.fn();
    const view = render(
      <TrustTierCard
        config={configFixture()}
        ownDomainId={OWN_DOMAIN}
        onSave={onSave}
        onReconcile={() => {}}
      />
    );

    const select = view.byTestId("config-tier-select") as HTMLSelectElement;
    // PREMISE: nothing is asserted yet, so the placeholder is what is selected and Save is held.
    expect(select.value).toBe("");
    expect((view.byTestId("config-tier-save") as HTMLButtonElement).disabled).toBe(true);

    select.value = "il5";
    fire(select, new Event("change", { bubbles: true }));

    view.click("config-tier-save");
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("il5");
    expect(onSave).not.toHaveBeenCalledWith("");
    view.unmount();
  });

  it("the adopt-shadow control reaches the reconcile verb", () => {
    const onReconcile = vi.fn();
    const view = render(
      <TrustTierCard
        config={shadowFixture()}
        ownDomainId={OWN_DOMAIN}
        onSave={() => {}}
        onReconcile={onReconcile}
      />
    );
    view.click("config-adopt-shadow");
    expect(onReconcile).toHaveBeenCalledTimes(1);
    view.unmount();
  });
});
