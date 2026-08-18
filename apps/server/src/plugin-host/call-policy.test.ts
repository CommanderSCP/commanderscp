import { afterEach, describe, expect, it } from "vitest";
import {
  MANAGED_EXECUTOR_MODULES,
  MANAGED_TRIGGER_GRACE_MS,
  assertManagedTimeoutSchemas,
  resolveCallPolicy
} from "./call-policy.js";
import { RUNNER_REAP_GRACE_MS, RUNNER_REMOVE_TIMEOUT_MS } from "@scp/runner-launcher";
import { MANIFEST_BY_MODULE } from "./plugin-manifests.js";

/**
 * M23.1c — the per-method RPC budget, and the manifest ceiling it is derived from.
 *
 * The end-to-end proof that the budget reaches a real managed run lives in
 * `managed-trigger-budget.test.ts` (a real `managed-iac` through a DEFAULT-constructed host). This
 * file covers the parts that test cannot reach in reasonable wall-clock time: the arithmetic, the
 * clamp on rows stored before the ceiling existed, and the boot assertion whose absence is what
 * would let a deleted `maximum` degrade SILENTLY back to the 10s SIGKILL.
 */

const HANG_DETECTOR_MS = 10_000;

/** An independent ceiling-on-the-ceiling. Reading `maximum` off the manifest is right for the
 *  product (one number, two readers) but self-referential in a test, so this hardcodes the bound
 *  the value must respect — `maximum: Number.MAX_SAFE_INTEGER` would satisfy "is bounded" and
 *  nothing else. */
const SANE_CEILING_MS = 60 * 60_000;

function timeoutMaximumFor(module: string): number {
  const schema = MANIFEST_BY_MODULE[module]?.configSchema as {
    properties?: { timeoutMs?: { maximum?: unknown } };
  };
  const max = schema?.properties?.timeoutMs?.maximum;
  expect(typeof max, `${module} publishes no timeoutMs maximum`).toBe("number");
  return max as number;
}

describe("managed executor timeoutMs is bounded at BOTH ends, on every managed module", () => {
  /**
   * A LOOP OVER THE ENUMERATED LIST, not three assertions about `managed-iac`. The defect record
   * named one plugin; the property was in all three, each declaring its own copy of
   * `{ type: "integer", minimum: 1000 }` with no ceiling. A census that fixes the instance instead
   * of the class is this repository's recurring bug source (CLAUDE.md, "census by property"), and a
   * fourth managed class fails here until it carries the same bounds.
   */
  it.each(MANAGED_EXECUTOR_MODULES)("%s publishes a bounded, sane timeoutMs", (module) => {
    const schema = MANIFEST_BY_MODULE[module]?.configSchema as {
      properties?: { timeoutMs?: { type?: unknown; minimum?: unknown; default?: unknown } };
    };
    const prop = schema?.properties?.timeoutMs;
    const maximum = timeoutMaximumFor(module);
    expect(prop?.type).toBe("integer");
    expect(prop?.minimum).toBe(1_000);
    expect(maximum).toBeGreaterThan(prop?.minimum as number);
    expect(maximum).toBeLessThanOrEqual(SANE_CEILING_MS);
    // The default a tenant inherits must itself be admissible — a default outside the bounds is a
    // schema that refuses its own documented behaviour.
    expect(prop?.default).toBeGreaterThanOrEqual(prop?.minimum as number);
    expect(prop?.default).toBeLessThanOrEqual(maximum);
  });
});

describe("resolveCallPolicy", () => {
  it("leaves every non-trigger method on the 10s hang detector, with its transparent retry intact", () => {
    for (const method of ["observe", "status", "abort", "describeCapabilities", "readFileAtRef"]) {
      const policy = resolveCallPolicy({
        module: "managed-iac",
        config: { timeoutMs: 600_000 },
        method,
        hangDetectorMs: HANG_DETECTOR_MS
      });
      expect(policy, `method '${method}' should keep the hang detector`).toEqual({
        budgetMs: HANG_DETECTOR_MS,
        retryOnCrash: true
      });
    }
  });

  it("leaves a NON-managed module's trigger on the hang detector too", () => {
    expect(
      resolveCallPolicy({
        module: "fake-executor",
        config: { autoSucceedAfterMs: 0 },
        method: "trigger",
        hangDetectorMs: HANG_DETECTOR_MS
      })
    ).toEqual({ budgetMs: HANG_DETECTOR_MS, retryOnCrash: true });
  });

  it("gives a managed trigger the instance's own timeoutMs plus the grace, and no crash retry", () => {
    expect(
      resolveCallPolicy({
        module: "managed-iac",
        config: { timeoutMs: 600_000 },
        method: "trigger",
        hangDetectorMs: HANG_DETECTOR_MS
      })
    ).toEqual({ budgetMs: 600_000 + MANAGED_TRIGGER_GRACE_MS, retryOnCrash: false });
  });

  it("falls back to the manifest default when the instance config sets no timeoutMs", () => {
    const budgets = MANAGED_EXECUTOR_MODULES.map(
      (module) =>
        resolveCallPolicy({
          module,
          config: {},
          method: "trigger",
          hangDetectorMs: HANG_DETECTOR_MS
        }).budgetMs
    );
    // Every managed default is minutes, so every derived budget must exceed the detector it replaces
    // — the failure this whole change exists to stop.
    for (const budget of budgets) expect(budget).toBeGreaterThan(HANG_DETECTOR_MS);
    expect(budgets).toEqual([
      10 * 60_000 + MANAGED_TRIGGER_GRACE_MS, // managed-iac
      10 * 60_000 + MANAGED_TRIGGER_GRACE_MS, // managed-scan
      5 * 60_000 + MANAGED_TRIGGER_GRACE_MS // managed-dep
    ]);
  });

  /**
   * THE CLAMP IS FOR ROWS THAT ALREADY EXIST. `maximum` refuses a bad value at the write door, and a
   * write door only ever sees new writes: a binding stored while the schema was
   * `{ minimum: 1000 }` with no ceiling — including the 2^31 that motivated the cap — is still in
   * the database and is never re-validated on read. Without this the ceiling would be true only of
   * deployments that had never been configured.
   */
  it("clamps a stored timeoutMs that predates the ceiling, instead of trusting it", () => {
    const maximum = timeoutMaximumFor("managed-iac");
    expect(
      resolveCallPolicy({
        module: "managed-iac",
        config: { timeoutMs: 2 ** 31 },
        method: "trigger",
        hangDetectorMs: HANG_DETECTOR_MS
      })
    ).toEqual({ budgetMs: maximum + MANAGED_TRIGGER_GRACE_MS, retryOnCrash: false });
  });

  it("clamps up a below-floor value and ignores a non-numeric one", () => {
    const floored = resolveCallPolicy({
      module: "managed-dep",
      config: { timeoutMs: -1 },
      method: "trigger",
      hangDetectorMs: HANG_DETECTOR_MS
    });
    expect(floored.budgetMs).toBe(1_000 + MANAGED_TRIGGER_GRACE_MS);

    const garbage = resolveCallPolicy({
      module: "managed-dep",
      config: { timeoutMs: "forever" },
      method: "trigger",
      hangDetectorMs: HANG_DETECTOR_MS
    });
    expect(garbage.budgetMs).toBe(5 * 60_000 + MANAGED_TRIGGER_GRACE_MS);
  });
});

/**
 * THE BOOT GATE, and why it is not redundant with the schema test above.
 *
 * If a `maximum` is ever deleted, nothing FAILS — `resolveCallPolicy` stops recognising that module
 * as managed and quietly hands its `trigger` the 10s hang detector back. That is the M23.1c defect,
 * restored on exactly one plugin, with a green suite. So the degradation has to be made loud at the
 * one moment it can be: module load, beside the allowlist, in
 * `coordination/executor-bindings-repo.ts`. These two tests assert BOTH halves — that the gate
 * fires, and that the thing it is guarding against really is silent.
 */
describe("assertManagedTimeoutSchemas (the boot gate)", () => {
  const saved = new Map<string, { configSchema: unknown }>();

  afterEach(() => {
    for (const [module, manifest] of saved) MANIFEST_BY_MODULE[module] = manifest;
    saved.clear();
  });

  function unbound(module: string): void {
    saved.set(module, MANIFEST_BY_MODULE[module]!);
    MANIFEST_BY_MODULE[module] = {
      configSchema: {
        type: "object",
        additionalProperties: false,
        properties: { timeoutMs: { type: "integer", minimum: 1000, default: 600_000 } }
      }
    };
  }

  it("passes against the manifests as shipped", () => {
    expect(() => assertManagedTimeoutSchemas()).not.toThrow();
  });

  it("throws, naming the module, when any managed manifest loses its timeoutMs ceiling", () => {
    unbound("managed-scan");
    expect(() => assertManagedTimeoutSchemas()).toThrow(/managed-scan/);
  });

  it("without that gate the loss is SILENT — the module's trigger reverts to the hang detector", () => {
    unbound("managed-scan");
    expect(
      resolveCallPolicy({
        module: "managed-scan",
        config: { timeoutMs: 600_000 },
        method: "trigger",
        hangDetectorMs: HANG_DETECTOR_MS
      })
    ).toEqual({ budgetMs: HANG_DETECTOR_MS, retryOnCrash: true });
  });
});

/**
 * ================================================================================================
 * M23.3 — THE CROSS-PACKAGE RELATIONSHIPS THAT USED TO BE COMMENTS THAT DRIFTED
 * ================================================================================================
 * Two numbers in `@scp/runner-launcher` and one here have to stand in a fixed order, and every
 * previous phase expressed that order in prose. `RUNNER_REAP_GRACE_MS`'s own doc said it plainly:
 * "nothing enforces the relationship automatically, precisely because nothing CAN import across
 * that boundary." That is true from the LAUNCHER's side and false from this one — `apps/server`
 * depends on `@scp/runner-launcher`, never the reverse — so the gate belongs here.
 *
 * IT IS NOT PEDANTRY. Every one of M23.3's HIGH defects was a number sized against a quantity that
 * had since changed, with a well-written comment still asserting the old arithmetic. A comment
 * naming a hazard is a signal to sweep, not evidence it was handled (CLAUDE.md).
 */
describe("M23.3: the grace constants stand in the order the cleanup path needs", () => {
  it("MANAGED_TRIGGER_GRACE_MS EXCEEDS the teardown it exists to protect", () => {
    // The only work that happens after a run's whole-run deadline is the adapter's
    // `finally { docker rm -f }`, capped at RUNNER_REMOVE_TIMEOUT_MS. A grace merely EQUAL to it
    // (which is what 30_000 was) is spent entirely by one worst-case teardown, leaving zero for the
    // `withRecordedOutcome` write and `saveState` that the grace exists to make room for — so the
    // host SIGKILLs the subprocess at precisely the moment the ledger entry would have landed.
    expect(MANAGED_TRIGGER_GRACE_MS).toBeGreaterThan(RUNNER_REMOVE_TIMEOUT_MS);
  });

  it("RUNNER_REAP_GRACE_MS EXCEEDS MANAGED_TRIGGER_GRACE_MS — never reapable while its owner may live", () => {
    // A container's `scp.launcher.deadline` is `runDeadline + RUNNER_REAP_GRACE_MS`; the host gives
    // up on the subprocess at `runDeadline + MANAGED_TRIGGER_GRACE_MS`. If the stamp expired FIRST,
    // there would be a window in which a peer launcher sees a container as `foreign AND past
    // deadline` — the exact predicate `reap()` destroys on — while the process that owns it is
    // still alive and still running `tofu apply`. That is HIGH-2 arriving through the other door.
    expect(RUNNER_REAP_GRACE_MS).toBeGreaterThan(MANAGED_TRIGGER_GRACE_MS);
  });

  it("the reap grace also covers the teardown, so a run that finishes normally is never reapable", () => {
    expect(RUNNER_REAP_GRACE_MS).toBeGreaterThan(RUNNER_REMOVE_TIMEOUT_MS);
  });
});
