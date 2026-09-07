import { describe, expect, it } from "vitest";
import type { ControlOutcomeStatus, DependencyIndexEcosystem, ExecutionPhase } from "./index.js";

/** `@scp/plugin-api` IS TYPES ONLY. See docs/plugin-api.md §1. */

/** Compiles only when `Union` and `Listed` have exactly the same members, in either direction. */
type Exactly<Union, Listed extends Union> = [Union] extends [Listed] ? true : never;

const EXECUTION_PHASES = ["pending", "running", "succeeded", "failed", "aborted"] as const;
const CONTROL_OUTCOME_STATUSES = [
  "pass",
  "fail",
  "warning",
  "skipped",
  "timed_out",
  "expired"
] as const;
const DEPENDENCY_INDEX_ECOSYSTEMS = ["npm", "go", "maven", "python", "oci"] as const;

const PHASES_ARE_EXACT: Exactly<ExecutionPhase, (typeof EXECUTION_PHASES)[number]> = true;
const CONTROL_STATUSES_ARE_EXACT: Exactly<
  ControlOutcomeStatus,
  (typeof CONTROL_OUTCOME_STATUSES)[number]
> = true;
const ECOSYSTEMS_ARE_EXACT: Exactly<
  DependencyIndexEcosystem,
  (typeof DEPENDENCY_INDEX_ECOSYSTEMS)[number]
> = true;

describe("@scp/plugin-api: the closed unions other packages switch on", () => {
  it("ExecutionPhase, ControlOutcomeStatus and DependencyIndexEcosystem are exactly these members", () => {
    // If one of these three assignments is a type error, a union was widened or narrowed without a
    // matching change at every exhaustive consumer. `pnpm typecheck` is where that surfaces; this
    // assertion is here so the run is not empty and so the expected members are printed.
    expect([PHASES_ARE_EXACT, CONTROL_STATUSES_ARE_EXACT, ECOSYSTEMS_ARE_EXACT]).toStrictEqual([
      true,
      true,
      true
    ]);
    expect([...EXECUTION_PHASES]).toStrictEqual([
      "pending",
      "running",
      "succeeded",
      "failed",
      "aborted"
    ]);
    expect([...CONTROL_OUTCOME_STATUSES]).toStrictEqual([
      "pass",
      "fail",
      "warning",
      "skipped",
      "timed_out",
      "expired"
    ]);
    expect([...DEPENDENCY_INDEX_ECOSYSTEMS]).toStrictEqual(["npm", "go", "maven", "python", "oci"]);
  });
});
