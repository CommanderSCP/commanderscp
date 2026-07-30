import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "../components/ui/button";
import {
  ForeignOriginNotice,
  isForeignOriginObject,
  isMergeLoserBlocked,
  isMoveBlocked,
  replicaGuard
} from "./replica-origin";

/**
 * M16.3 P2 (REMEASURED) — the primitives behind the TWO write-control gates that survive, both of
 * which mirror a refusal MEASURED in `apps/server/src/federation/foreign-origin-writes.integration.
 * test.ts`: MOVE across a foreign-origin `contains` edge (`deleteRelationship` 409s) and MERGE with
 * a foreign-origin LOSER (`deleteObject` 409s). Everything else the first cut gated —
 * Detach/Repurpose/Bind, ASSIGN, MOVE across a local edge, merge into a foreign SURVIVOR, and
 * Accept/Rollback/Cancel — the server measurably ACCEPTS, so those gates are gone.
 *
 * `replicaGuard`'s mandatory `refusal: string` parameter is a WEAKER guarantee than an earlier
 * commit on this PR claimed ("gated on the wrong row is now a type error" — it is not): TypeScript
 * requires a second argument at every call site, but does not check that its CONTENT names a real,
 * measured refusal — `replicaGuard(true, "")` compiles cleanly, and `isMoveBlocked`/
 * `isMergeLoserBlocked`'s `{ originDomainId: string }` parameter types accept any object with that
 * shape, including a full `GraphObject` for the WRONG row (a component instead of its `contains`
 * edge) — structural typing plus no excess-property check on a passed variable means `tsc
 * --noEmit` is clean either way. What actually keeps each gate honest is this file: every
 * `disabled`/`title` assertion below is pinned to the SPECIFIC measured case it names, so a gate
 * rekeyed onto the wrong row breaks a test here, not a compile. `refusal` is good, enforced-by-
 * convention documentation, not a compile-time guarantee.
 *
 * No jsdom, no QueryClientProvider — plain vitest + `renderToStaticMarkup`, so this runs in the
 * existing "4. Unit tests" job (transitively required on every PR), same as service-board-
 * honesty.test.tsx.
 */
describe("replica-origin (M16.3 P2): measured foreign-origin write-control gating", () => {
  const OWN_DOMAIN = "2c1d3e4f-5a6b-4c8d-9e0f-1a2b3c4d5e6f";
  const OTHER_DOMAIN = "5f6b4a2c-1d3e-4f8a-9b0c-2d4e6f8a0b1c";
  const REFUSAL = "Merging this component in would soft-delete it, which `deleteObject` refuses here:";

  describe("isForeignOriginObject", () => {
    it("is FALSE for a row this domain itself originated", () => {
      expect(isForeignOriginObject(OWN_DOMAIN, OWN_DOMAIN)).toBe(false);
    });

    it("is TRUE for a row authoritatively owned by another domain", () => {
      expect(isForeignOriginObject(OTHER_DOMAIN, OWN_DOMAIN)).toBe(true);
    });

    it("is FALSE (not yet decidable) while this instance's own domain id hasn't loaded — missing data never fabricates a block", () => {
      expect(isForeignOriginObject(OTHER_DOMAIN, undefined)).toBe(false);
    });

    it("is FALSE for a row with no origin recorded at all (null/undefined originDomainId)", () => {
      expect(isForeignOriginObject(null, OWN_DOMAIN)).toBe(false);
      expect(isForeignOriginObject(undefined, OWN_DOMAIN)).toBe(false);
    });
  });

  // The defect class this milestone shipped was not "no gate" — it was "gated on the WRONG ROW".
  // These two pin WHICH row each surviving gate reads, against the measured server behaviour in
  // apps/server/src/federation/foreign-origin-writes.integration.test.ts.
  describe("isMoveBlocked — keyed on the `contains` EDGE, never on the component", () => {
    it("no current edge (an ASSIGN) is NEVER blocked — measured: 'ASSIGN ... SUCCEEDS even when the COMPONENT is foreign-origin'", () => {
      expect(isMoveBlocked(undefined, OWN_DOMAIN)).toBe(false);
    });

    it("a LOCALLY-originated edge is not blocked — measured: 'MOVE across a LOCALLY-originated contains edge SUCCEEDS even when the COMPONENT is foreign-origin'", () => {
      expect(isMoveBlocked({ originDomainId: OWN_DOMAIN }, OWN_DOMAIN)).toBe(false);
    });

    it("a FOREIGN-ORIGIN edge IS blocked — measured: 'MOVE across a FOREIGN-ORIGIN contains edge 409s'", () => {
      expect(isMoveBlocked({ originDomainId: OTHER_DOMAIN }, OWN_DOMAIN)).toBe(true);
    });
  });

  describe("isMergeLoserBlocked — keyed on the LOSER, never on the survivor", () => {
    it("a locally-originated loser is not blocked", () => {
      expect(isMergeLoserBlocked({ originDomainId: OWN_DOMAIN }, OWN_DOMAIN)).toBe(false);
    });

    it("a FOREIGN-ORIGIN loser IS blocked — measured: 'merge 409s when the LOSER is foreign-origin'", () => {
      expect(isMergeLoserBlocked({ originDomainId: OTHER_DOMAIN }, OWN_DOMAIN)).toBe(true);
    });
  });

  describe("replicaGuard", () => {
    it("locally-originated (foreign=false): enabled, no explanatory title — and the refusal text is NOT leaked onto an enabled control", () => {
      expect(replicaGuard(false, REFUSAL)).toEqual({ disabled: false });
    });

    it("foreign-origin (foreign=true): disabled, and the title carries the CALLER'S measured refusal, not a blanket claim", () => {
      const guard = replicaGuard(true, REFUSAL);
      expect(guard.disabled).toBe(true);
      // The specific refusal this gate mirrors must survive into what the operator reads — that is
      // what makes an unmeasured gate impossible to write without lying in the UI.
      expect(guard.title).toContain(REFUSAL);
      expect(guard.title).toMatch(/single-writer authority/i);
    });

    it("a DIFFERENT gate produces a DIFFERENT explanation — one blanket message for every control is exactly the defect being corrected", () => {
      const move = replicaGuard(
        true,
        "Moving this component would delete its current service edge, which `deleteRelationship` refuses here:"
      );
      expect(move.title).not.toBe(replicaGuard(true, REFUSAL).title);
    });
  });

  describe("a write control wired with replicaGuard (the actual shape both surviving gates use)", () => {
    function renderControl(foreign: boolean): string {
      const guard = replicaGuard(foreign, REFUSAL);
      return renderToStaticMarkup(
        <Button data-testid="gated-control" disabled={guard.disabled} title={guard.title}>
          Merge in
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

  describe("ForeignOriginNotice (the honest provenance marker — mirrors service-board.tsx's UnknownHere idiom)", () => {
    it("renders the dashed-amber 'read-only replica' marker, naming the owning domain in its title", () => {
      const html = renderToStaticMarkup(<ForeignOriginNotice originDomainId={OTHER_DOMAIN} />);
      expect(html).toContain("data-testid=\"foreign-origin-notice\"");
      expect(html).toContain("border-dashed");
      expect(html).toContain("read-only replica");
      expect(html).toContain(OTHER_DOMAIN);
      // Deliberately NOT the muted "—"/success-colored idiom `service-board.tsx` reserves for
      // observed-and-clean — this must read as a DIFFERENT thing, exactly the distinction
      // `service-board.tsx`'s own UnknownHere preserves for unobservable-vs-empty.
      expect(html).not.toContain("text-slate-400");
    });

    it("scopes its claim to what was MEASURED (the object's own fields) instead of overclaiming that nothing works here", () => {
      const html = renderToStaticMarkup(<ForeignOriginNotice originDomainId={OTHER_DOMAIN} />);
      // `foreign-origin-writes.integration.test.ts` measures executor bindings SUCCEEDING against a
      // foreign-origin target — the badge must not tell an operator otherwise.
      expect(html).toMatch(/executor bindings is unaffected/i);
    });
  });
});
