import type { ChangeState } from "@scp/schemas";
import { ChangeStateSchema } from "@scp/schemas";

/** The change lifecycle state machine. See docs/coordination.md §1013. */
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
  { from: "validating", to: "accepted", trigger: "accept" },
  { from: "validating", to: "cancelled", trigger: "cancel" },
  { from: "validating", to: "rolled_back", trigger: "rollback" },
  { from: "accepted", to: "rolled_back", trigger: "rollback" }
];

const LEGAL_EDGE_SET: ReadonlySet<string> = new Set(
  LEGAL_TRANSITIONS.map((edge) => `${edge.from}->${edge.to}`)
);

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
