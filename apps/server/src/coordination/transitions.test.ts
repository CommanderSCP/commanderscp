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
 * `isLegalTransition` matches `LEGAL_TRANSITIONS` exactly, one assertion per pair — not a
 * sampling, not a summary count.
 */
describe("coordination/transitions — exhaustive legal/illegal transition table", () => {
  const expectedLegal = new Set(LEGAL_TRANSITIONS.map((e) => `${e.from}->${e.to}`));

  for (const from of CHANGE_STATES) {
    for (const to of CHANGE_STATES) {
      const key = `${from}->${to}`;
      const shouldBeLegal = expectedLegal.has(key);
      it(`${from} -> ${to} is ${shouldBeLegal ? "LEGAL" : "illegal"}`, () => {
        expect(isLegalTransition(from, to)).toBe(shouldBeLegal);
      });
    }
  }

  it("covers all 8 states x 8 states = 64 ordered pairs", () => {
    expect(CHANGE_STATES.length).toBe(8);
    expect(CHANGE_STATES.length * CHANGE_STATES.length).toBe(64);
  });

  it("has no self-transitions (no state legally transitions to itself)", () => {
    for (const state of CHANGE_STATES) {
      expect(isLegalTransition(state, state)).toBe(false);
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
