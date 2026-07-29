import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "../components/ui/button";
import { ForeignOriginNotice, isForeignOriginObject, replicaGuard } from "./replica-origin";

/**
 * M16.3 P2 — the write-control census fix: `registry-detail.tsx` (Assign/Move service, Detach/
 * Repurpose executor bindings, Merge) and `change-detail.tsx` (Accept/Rollback/Cancel) all share
 * these THREE primitives to decide whether a write control renders disabled+explained for a
 * foreign-origin object. This pins the primitives directly — the same "test the pure pieces, not
 * the whole hook-bearing page" idiom `service-board-honesty.test.tsx` uses for `isUnknown`/
 * `UnknownHere` (that file renders `BoardRow`, a purely presentational component with no hooks;
 * `registry-detail.tsx`'s cards DO use `useQuery`/`useMutation`, so — mirroring the idiom, not
 * duplicating the exact shape — this test renders the shared PRIMITIVES those cards wire onto
 * real `Button`/`Select` elements, plus a `Button` reproduction of the actual disabled+title
 * wiring, rather than the full hook-bearing page).
 *
 * No jsdom, no QueryClientProvider — plain vitest + `renderToStaticMarkup`, so this runs in the
 * existing "4. Unit tests" job (transitively required on every PR), same as service-board-
 * honesty.test.tsx.
 */
describe("replica-origin (M16.3 P2): foreign-origin write-control gating", () => {
  const OWN_DOMAIN = "2c1d3e4f-5a6b-4c8d-9e0f-1a2b3c4d5e6f";
  const OTHER_DOMAIN = "5f6b4a2c-1d3e-4f8a-9b0c-2d4e6f8a0b1c";

  describe("isForeignOriginObject", () => {
    it("is FALSE for an object this domain itself originated", () => {
      expect(isForeignOriginObject(OWN_DOMAIN, OWN_DOMAIN)).toBe(false);
    });

    it("is TRUE for an object authoritatively owned by another domain", () => {
      expect(isForeignOriginObject(OTHER_DOMAIN, OWN_DOMAIN)).toBe(true);
    });

    it("is FALSE (not yet decidable) while this instance's own domain id hasn't loaded — never a false positive from missing data", () => {
      expect(isForeignOriginObject(OTHER_DOMAIN, undefined)).toBe(false);
    });

    it("is FALSE for an object with no origin recorded at all (null/undefined originDomainId)", () => {
      expect(isForeignOriginObject(null, OWN_DOMAIN)).toBe(false);
      expect(isForeignOriginObject(undefined, OWN_DOMAIN)).toBe(false);
    });
  });

  describe("replicaGuard", () => {
    it("locally-originated (foreign=false): enabled, no explanatory title", () => {
      expect(replicaGuard(false)).toEqual({ disabled: false });
    });

    it("foreign-origin (foreign=true): disabled, WITH an explanatory title naming single-writer authority", () => {
      const guard = replicaGuard(true);
      expect(guard.disabled).toBe(true);
      expect(guard.title).toBeDefined();
      expect(guard.title).toMatch(/read-only replica|single-writer authority/i);
    });
  });

  describe("a write control wired with replicaGuard (the actual shape every gated Button uses)", () => {
    function renderControl(foreign: boolean): string {
      const guard = replicaGuard(foreign);
      return renderToStaticMarkup(
        <Button data-testid="gated-control" disabled={foreign} title={guard.title}>
          Detach
        </Button>
      );
    }

    it("locally-originated: ENABLED — no disabled attribute, no explanatory title", () => {
      const html = renderControl(false);
      // The button's own Tailwind classes legitimately contain the literal substring "disabled:"
      // (`disabled:pointer-events-none disabled:opacity-50`) — assert on the actual HTML ATTRIBUTE
      // shape, not a bare substring match, so this can't pass vacuously against those class names.
      expect(html).not.toMatch(/\sdisabled(="")?(\s|>)/);
      expect(html).not.toMatch(/\stitle="/);
    });

    it("foreign-origin: DISABLED — the disabled attribute AND an explanatory title are both present", () => {
      const html = renderControl(true);
      expect(html).toMatch(/\sdisabled(="")?(\s|>)/);
      expect(html).toMatch(/\stitle="[^"]*single-writer authority[^"]*"/i);
    });
  });

  describe("ForeignOriginNotice (the honest marker — mirrors service-board.tsx's UnknownHere idiom)", () => {
    it("renders the dashed-amber 'read-only replica' marker, naming the owning domain in its title", () => {
      const html = renderToStaticMarkup(<ForeignOriginNotice originDomainId={OTHER_DOMAIN} />);
      expect(html).toContain("data-testid=\"foreign-origin-notice\"");
      expect(html).toContain("border-dashed");
      expect(html).toContain("read-only replica");
      expect(html).toContain(OTHER_DOMAIN);
      // Deliberately NOT the muted "—"/success-colored idiom `service-board.tsx` reserves for
      // observed-and-clean — this must read as a DIFFERENT thing (an inability to act here), not a
      // clean bill of health, exactly the distinction `service-board.tsx`'s own UnknownHere
      // preserves for unobservable-vs-empty.
      expect(html).not.toContain("text-slate-400");
    });
  });
});
