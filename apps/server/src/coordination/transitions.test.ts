import { describe, expect, it } from "vitest";
import type { ChangeState } from "@scp/schemas";
import {
  CHANGE_STATES,
  isLegalTransition,
  LEGAL_TRANSITIONS,
  legalNextStates,
  TERMINAL_STATES
} from "./transitions.js";

/** BUILD_AND_TEST.md §8 M3 DoD. See docs/coordination.md §1012. */
const EXPECTED_LEGAL_EDGES: ReadonlySet<string> = new Set([
  // Happy path (top row of the diagram): each step is the engine's own
  // observe/compare/decide/coordinate progression.
  "proposed->evaluated",
  "evaluated->coordinated",
  "coordinated->executing",
  "executing->validating",
  "validating->accepted",

  // M12 P4B: the optional `waiting` detour on the coordinated->executing step (a change with
  // unsatisfied cross-change `requires` parks in `waiting`, then releases to `executing`).
  "coordinated->waiting",
  "waiting->executing",

  // cancel: "legal from every pre-acceptance state" (transitions.ts's own edge-rationale comment,
  // matching the diagram's left fan-in to `cancelled`) — every state before `accepted`, now
  // including `waiting`.
  "proposed->cancelled",
  "evaluated->cancelled",
  "coordinated->cancelled",
  "waiting->cancelled",
  "executing->cancelled",
  "validating->cancelled",

  // rollback: "legal once the change has actually done something an external system needs
  // reverting" — executing/validating/accepted (the diagram's right fan-in to `rolled_back`,
  // including `accepted -> rolled_back`, the one edge out of an otherwise-terminal state). Never
  // legal from proposed/evaluated/coordinated, where nothing has executed yet.
  "executing->rolled_back",
  "validating->rolled_back",
  "accepted->rolled_back"
]);

describe("coordination/transitions — exhaustive legal/illegal transition table (hardcoded from DESIGN.md §9.1)", () => {
  it("covers all 9 states x 9 states = 81 ordered pairs", () => {
    expect(CHANGE_STATES.length).toBe(9);
    expect(CHANGE_STATES.length * CHANGE_STATES.length).toBe(81);
  });

  it("the hardcoded expected set has exactly 16 edges (5 happy-path + 2 P4B waiting + 6 cancel + 3 rollback)", () => {
    expect(EXPECTED_LEGAL_EDGES.size).toBe(16);
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

  it("terminal states (cancelled, rolled_back) have no outgoing edges except accepted->rolled_back's source", () => {
    expect(TERMINAL_STATES.has("cancelled")).toBe(true);
    expect(TERMINAL_STATES.has("rolled_back")).toBe(true);
    expect(legalNextStates("cancelled")).toEqual([]);
    expect(legalNextStates("rolled_back")).toEqual([]);
  });

  it("accepted is not fully terminal — rollback remains legal", () => {
    expect(TERMINAL_STATES.has("accepted" as ChangeState)).toBe(false);
    expect(legalNextStates("accepted")).toEqual(["rolled_back"]);
  });

  it("cancel is legal from every pre-acceptance state (including P4B's waiting)", () => {
    for (const state of [
      "proposed",
      "evaluated",
      "coordinated",
      "waiting",
      "executing",
      "validating"
    ] as const) {
      expect(isLegalTransition(state, "cancelled")).toBe(true);
    }
  });

  it("rollback is legal only from executing/validating/accepted (never from waiting — nothing executed yet)", () => {
    for (const state of ["proposed", "evaluated", "coordinated", "waiting"] as const) {
      expect(isLegalTransition(state, "rolled_back")).toBe(false);
    }
    for (const state of ["executing", "validating", "accepted"] as const) {
      expect(isLegalTransition(state, "rolled_back")).toBe(true);
    }
  });

  it("the happy path is exactly proposed->evaluated->coordinated->executing->validating->accepted", () => {
    const chain: ChangeState[] = [
      "proposed",
      "evaluated",
      "coordinated",
      "executing",
      "validating",
      "accepted"
    ];
    for (let i = 0; i < chain.length - 1; i++) {
      expect(isLegalTransition(chain[i]!, chain[i + 1]!)).toBe(true);
    }
  });
});
