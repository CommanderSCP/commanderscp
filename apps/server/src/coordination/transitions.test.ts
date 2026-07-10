import { describe, expect, it } from "vitest";
import type { ChangeState } from "@scp/schemas";
import {
  CHANGE_STATES,
  isLegalTransition,
  LEGAL_TRANSITIONS,
  legalNextStates,
  TERMINAL_STATES
} from "./transitions.js";

/**
 * BUILD_AND_TEST.md §8 M3 DoD: "Unit: EXHAUSTIVE legal/illegal transition table (every edge,
 * legal and illegal)". This test enumerates the full 8x8 cross product of `ChangeState` pairs
 * (64 ordered pairs, including same-state "pairs" — no self-transitions are legal) and asserts
 * `isLegalTransition` matches the expected edge set exactly, one assertion per pair — not a
 * sampling, not a summary count.
 *
 * MAJOR #8 fix (PR #7 review — "transition-table test is tautological"): the previous version
 * built its "expected" set FROM `transitions.ts`'s own `LEGAL_TRANSITIONS` constant — the exact
 * thing under test — so the main loop only ever proved `isLegalTransition` is self-consistent
 * with `LEGAL_TRANSITIONS`, never that either one actually matches the state machine DESIGN.md
 * §9.1 specifies. A mutation that added a spurious legal edge to `LEGAL_TRANSITIONS` (e.g.
 * `evaluated -> executing`, skipping the coordination step) would have updated both sides of the
 * old comparison identically and the test would still have passed.
 *
 * `EXPECTED_LEGAL_EDGES` below is transcribed LITERALLY and independently from DESIGN.md §9.1's
 * diagram and prose — it never imports or derives from `LEGAL_TRANSITIONS` — and the main loop
 * checks `isLegalTransition` against this hardcoded source of truth instead. `LEGAL_TRANSITIONS`
 * is still imported for the one test below that legitimately inspects it directly (every entry
 * carries a non-empty trigger verb) — that check is about a structural property of the exported
 * data itself, not a re-derivation of "what's legal," so it stays non-circular.
 *
 * DESIGN.md §9.1 diagram:
 * ```
 *  proposed ──▶ evaluated ──▶ coordinated ──▶ executing ──▶ validating ──▶ promoted
 *      │             │              │              │              │
 *      └─────────────┴──────┬───────┴──────────────┴──────┬───────┘
 *                           ▼                             ▼
 *                       cancelled                    rolled_back
 * ```
 */
const EXPECTED_LEGAL_EDGES: ReadonlySet<string> = new Set([
  // Happy path (top row of the diagram): each step is the engine's own
  // observe/compare/decide/coordinate progression.
  "proposed->evaluated",
  "evaluated->coordinated",
  "coordinated->executing",
  "executing->validating",
  "validating->promoted",

  // cancel: "legal from every pre-promotion state" (transitions.ts's own edge-rationale comment,
  // matching the diagram's left fan-in to `cancelled`) — every state before `promoted`.
  "proposed->cancelled",
  "evaluated->cancelled",
  "coordinated->cancelled",
  "executing->cancelled",
  "validating->cancelled",

  // rollback: "legal once the change has actually done something an external system needs
  // reverting" — executing/validating/promoted (the diagram's right fan-in to `rolled_back`,
  // including `promoted -> rolled_back`, the one edge out of an otherwise-terminal state). Never
  // legal from proposed/evaluated/coordinated, where nothing has executed yet.
  "executing->rolled_back",
  "validating->rolled_back",
  "promoted->rolled_back"
]);

describe("coordination/transitions — exhaustive legal/illegal transition table (hardcoded from DESIGN.md §9.1)", () => {
  it("covers all 8 states x 8 states = 64 ordered pairs", () => {
    expect(CHANGE_STATES.length).toBe(8);
    expect(CHANGE_STATES.length * CHANGE_STATES.length).toBe(64);
  });

  it("the hardcoded expected set has exactly 13 edges (5 happy-path + 5 cancel + 3 rollback, per DESIGN §9.1's prose)", () => {
    expect(EXPECTED_LEGAL_EDGES.size).toBe(13);
  });

  for (const from of CHANGE_STATES) {
    for (const to of CHANGE_STATES) {
      const key = `${from}->${to}`;
      const shouldBeLegal = EXPECTED_LEGAL_EDGES.has(key);
      it(`${from} -> ${to} is ${shouldBeLegal ? "LEGAL" : "illegal"}`, () => {
        expect(isLegalTransition(from, to)).toBe(shouldBeLegal);
      });
    }
  }

  it("has no self-transitions (no state legally transitions to itself)", () => {
    for (const state of CHANGE_STATES) {
      expect(isLegalTransition(state, state)).toBe(false);
      expect(EXPECTED_LEGAL_EDGES.has(`${state}->${state}`)).toBe(false);
    }
  });

  it("every legal edge has a non-empty trigger verb", () => {
    for (const edge of LEGAL_TRANSITIONS) {
      expect(edge.trigger.length).toBeGreaterThan(0);
    }
  });

  it("terminal states (cancelled, rolled_back) have no outgoing edges except promoted->rolled_back's source", () => {
    expect(TERMINAL_STATES.has("cancelled")).toBe(true);
    expect(TERMINAL_STATES.has("rolled_back")).toBe(true);
    expect(legalNextStates("cancelled")).toEqual([]);
    expect(legalNextStates("rolled_back")).toEqual([]);
  });

  it("promoted is not fully terminal — rollback remains legal", () => {
    expect(TERMINAL_STATES.has("promoted" as ChangeState)).toBe(false);
    expect(legalNextStates("promoted")).toEqual(["rolled_back"]);
  });

  it("cancel is legal from every pre-promotion state", () => {
    for (const state of ["proposed", "evaluated", "coordinated", "executing", "validating"] as const) {
      expect(isLegalTransition(state, "cancelled")).toBe(true);
    }
  });

  it("rollback is legal only from executing/validating/promoted", () => {
    for (const state of ["proposed", "evaluated", "coordinated"] as const) {
      expect(isLegalTransition(state, "rolled_back")).toBe(false);
    }
    for (const state of ["executing", "validating", "promoted"] as const) {
      expect(isLegalTransition(state, "rolled_back")).toBe(true);
    }
  });

  it("the happy path is exactly proposed->evaluated->coordinated->executing->validating->promoted", () => {
    const chain: ChangeState[] = [
      "proposed",
      "evaluated",
      "coordinated",
      "executing",
      "validating",
      "promoted"
    ];
    for (let i = 0; i < chain.length - 1; i++) {
      expect(isLegalTransition(chain[i]!, chain[i + 1]!)).toBe(true);
    }
  });
});
