import { describe, expect, it } from "vitest";
import type { ControlOutcomeStatus, DependencyIndexEcosystem, ExecutionPhase } from "./index.js";

/**
 * `@scp/plugin-api` IS TYPES ONLY — every export above `STUB`-level is an `interface` or a `type`,
 * and `dist/index.js` is empty. That is why this package had no tests and why its `test` script
 * carried `--passWithNoTests`: there was no runtime surface to call.
 *
 * WHAT THIS FILE HONESTLY IS, AND IS NOT. It is NOT a behaviour test — there is no behaviour here.
 * It is a TYPE-LEVEL PIN of the three closed unions the rest of the product switches on, and its
 * teeth are in `pnpm typecheck`, not in `vitest`: `Exactly<…>` fails to compile if a member is added
 * to or removed from the union without updating the list beside it. The runtime `expect` below is
 * the weaker half — it makes the package non-empty so `vitest run` (now without
 * `--passWithNoTests`) has something to run, and it prints the intended list when the type check
 * fires.
 *
 * WHY THESE THREE UNIONS. Each is consumed by an exhaustive `switch`/mapping somewhere that does
 * NOT live in this package — `ExecutionPhase` by the reconciler and the UI's status badges,
 * `ControlOutcomeStatus` by the gate evaluation, `DependencyIndexEcosystem` by the manifest
 * parsers. Widening one of them is a source-compatible edit HERE that silently leaves a hole THERE.
 */

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
