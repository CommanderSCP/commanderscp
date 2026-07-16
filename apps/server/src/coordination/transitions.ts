import type { ChangeState } from "@scp/schemas";
import { ChangeStateSchema } from "@scp/schemas";

/**
 * The change lifecycle state machine (DESIGN.md §9.1) as DATA — a pure, exhaustively unit-tested
 * module with zero I/O, per BUILD_AND_TEST.md §4.1: "anything testable as a pure function must
 * be written as a pure function (the design's single guarded transition function... exist partly
 * for this)". `coordination/transition.ts`'s guarded transition function uses `isLegalTransition`
 * below as its legality gate — the SOLE runtime authority. (`drizzle/0007_change_coordination.sql`
 * also seeds a `state_transitions` table, but nothing reads it. An earlier version of this comment
 * claimed a `transitions.integration.test.ts` cross-checks the two; that file has never existed.
 * `transitions.test.ts` cross-checks THIS constant against a hardcoded edge set instead.)
 *
 * Edge rationale (DESIGN §9.1's diagram + prose):
 *  - The "happy path" states form a chain: proposed -> evaluated -> coordinated -> executing ->
 *    validating -> promoted. Each step corresponds to the engine's own observe/compare/decide/
 *    coordinate progression (coordination/reconcile.ts).
 *  - `waiting` (M12 P4B) is an OPTIONAL detour on the coordinated->executing step: a change with
 *    unsatisfied `properties.requires` goes coordinated -> waiting and is held there until every
 *    cross-change prerequisite is satisfied, then waiting -> executing. A change with no `requires`
 *    takes coordinated -> executing directly, exactly as before — both edges are legal. `cancel` is
 *    legal from `waiting` too (it is pre-promotion); `rollback` is not (nothing has executed yet).
 *  - `cancel` is legal from every pre-promotion state (proposed/evaluated/coordinated/executing/
 *    validating) — an operator can always abort a change that hasn't been promoted yet.
 *  - `rollback` is legal once the change has actually done something an external system needs
 *    reverting (executing/validating/promoted) — never from proposed/evaluated/coordinated, where
 *    nothing has executed yet and `cancel` is the correct verb.
 *  - `cancelled` and `rolled_back` are terminal EXCEPT `promoted -> rolled_back` (a promoted
 *    change can still be rolled back later) — every other state has no outgoing edges once
 *    reached.
 */
export const CHANGE_STATES = ChangeStateSchema.options;

export interface StateTransitionEdge {
  from: ChangeState;
  to: ChangeState;
  trigger: string;
}

export const LEGAL_TRANSITIONS: readonly StateTransitionEdge[] = [
  { from: "proposed", to: "evaluated", trigger: "evaluate" },
  { from: "proposed", to: "cancelled", trigger: "cancel" },
  { from: "evaluated", to: "coordinated", trigger: "coordinate" },
  { from: "evaluated", to: "cancelled", trigger: "cancel" },
  { from: "coordinated", to: "executing", trigger: "execute" },
  { from: "coordinated", to: "waiting", trigger: "await-prerequisites" },
  { from: "coordinated", to: "cancelled", trigger: "cancel" },
  { from: "waiting", to: "executing", trigger: "prerequisites-satisfied" },
  { from: "waiting", to: "cancelled", trigger: "cancel" },
  { from: "executing", to: "validating", trigger: "validate" },
  { from: "executing", to: "cancelled", trigger: "cancel" },
  { from: "executing", to: "rolled_back", trigger: "rollback" },
  { from: "validating", to: "promoted", trigger: "promote" },
  { from: "validating", to: "cancelled", trigger: "cancel" },
  { from: "validating", to: "rolled_back", trigger: "rollback" },
  { from: "promoted", to: "rolled_back", trigger: "rollback" }
];

const LEGAL_EDGE_SET: ReadonlySet<string> = new Set(
  LEGAL_TRANSITIONS.map((edge) => `${edge.from}->${edge.to}`)
);

/** Terminal states have no outgoing edges at all. */
export const TERMINAL_STATES: ReadonlySet<ChangeState> = new Set(
  CHANGE_STATES.filter((s) => !LEGAL_TRANSITIONS.some((edge) => edge.from === s))
);

export function isLegalTransition(from: ChangeState, to: ChangeState): boolean {
  return LEGAL_EDGE_SET.has(`${from}->${to}`);
}

export function findEdge(from: ChangeState, to: ChangeState): StateTransitionEdge | undefined {
  return LEGAL_TRANSITIONS.find((edge) => edge.from === from && edge.to === to);
}

export function legalNextStates(from: ChangeState): ChangeState[] {
  return LEGAL_TRANSITIONS.filter((edge) => edge.from === from).map((edge) => edge.to);
}
