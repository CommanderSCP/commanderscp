import { afterEach, describe, expect, it } from "vitest";
import {
  MANAGED_EXECUTOR_MODULES,
  MANAGED_OUTCOME_TAIL_MS,
  MANAGED_TRIGGER_GRACE_MS,
  assertManagedTimeoutSchemas,
  managedTriggerGraceMs,
  resolveCallPolicy,
  runnerLauncherKindOf
} from "./call-policy.js";
import {
  MANAGED_RUN_TIMEOUT_MAX_MS,
  RUNNER_POST_DEADLINE_CALLS,
  RUNNER_REAP_GRACE_MS,
  RUNNER_REMOVE_TIMEOUT_MS,
  clampRunTimeoutMs,
  runnerPostDeadlineCallsMs,
  runnerPostDeadlineMs,
  runnerReapGraceMs
} from "@scp/runner-launcher";
import type { RunnerLauncherKind } from "@scp/runner-launcher";
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
      10 * 60_000 + MANAGED_TRIGGER_GRACE_MS,
      10 * 60_000 + MANAGED_TRIGGER_GRACE_MS,
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
 * M23.1e — THE CROSS-PACKAGE RELATIONSHIPS THAT USED TO BE COMMENTS THAT DRIFTED
 * ================================================================================================
 * Two numbers in `@scp/runner-launcher` and one here have to stand in a fixed order, and every
 * previous phase expressed that order in prose. `RUNNER_REAP_GRACE_MS`'s own doc said it plainly:
 * "nothing enforces the relationship automatically, precisely because nothing CAN import across
 * that boundary." That is true from the LAUNCHER's side and false from this one — `apps/server`
 * depends on `@scp/runner-launcher`, never the reverse — so the gate belongs here.
 *
 * IT IS NOT PEDANTRY. Every one of M23.1e's HIGH defects was a number sized against a quantity that
 * had since changed, with a well-written comment still asserting the old arithmetic. A comment
 * naming a hazard is a signal to sweep, not evidence it was handled (CLAUDE.md).
 */
describe("M23.1e: the grace constants stand in the order the cleanup path needs", () => {
  it("MANAGED_TRIGGER_GRACE_MS EXCEEDS the teardown it exists to protect", () => {
    // The Docker adapter's `finally { docker rm -f }` is capped at RUNNER_REMOVE_TIMEOUT_MS. A grace
    // merely EQUAL to it (which is what 30_000 was) is spent entirely by one worst-case teardown,
    // leaving zero for the `withRecordedOutcome` write and `saveState` that the grace exists to make
    // room for — so the host SIGKILLs the subprocess at precisely the moment the ledger entry would
    // have landed.
    //
    // THIS ARM IS ABOUT ONE TEARDOWN AND THAT IS NOW ITS LIMIT, said plainly because it read as the
    // whole gate and was not: it is true of an adapter whose teardown is one call, and M23.5 found
    // the Kubernetes teardown had become three with this still green. The per-kind arms below are
    // the gate; this one is kept because the Docker default is what most deployments run.
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

/**
 * ================================================================================================
 * M23.5 HIGH-2 — THE ORDERING HOLDS FOR EVERY ADAPTER, NOT FOR THE ONE THAT EXISTED WHEN IT WAS
 * WRITTEN
 * ================================================================================================
 *
 * `MANAGED_TRIGGER_GRACE_MS` was 60s, chosen in prose as "two worst-case teardowns" of
 * `RUNNER_REMOVE_TIMEOUT_MS`, and gated by `grace > RUNNER_REMOVE_TIMEOUT_MS` — ONE teardown. The
 * Kubernetes `finally` is three bounded calls, so sixty seconds of bounded work consumed the whole
 * grace and left nothing for the outcome write it exists to protect. The number was gated; the
 * MODEL was not, and nothing knew the teardown had grown.
 *
 * THE GATE IS NOW `it.each` OVER THE KINDS, so an adapter cannot be added without its ordering
 * being checked, and `teardown-model.test.ts` in the launcher counts what each adapter's `finally`
 * ACTUALLY issues against the declared count these numbers are derived from. Between them: adding a
 * fourth teardown step reddens the census by name, and correcting the count moves every number
 * here.
 */
const LAUNCHER_KINDS = Object.keys(RUNNER_POST_DEADLINE_CALLS) as RunnerLauncherKind[];

describe("M23.5: the grace is derived from what teardown costs ON THE ADAPTER IN USE", () => {
  it("EVERY KIND THE LAUNCHER DECLARES IS GATED HERE — a new adapter cannot arrive ungated", () => {
    // Not decoration: the arms below are `it.each` over this list, so if it ever stopped tracking
    // the launcher's own model an adapter could join with no ordering check at all.
    expect(LAUNCHER_KINDS.length).toBeGreaterThanOrEqual(2);
    expect(LAUNCHER_KINDS).toStrictEqual(Object.keys(RUNNER_POST_DEADLINE_CALLS));
  });

  it.each(LAUNCHER_KINDS)(
    "%s: the grace covers that adapter's WHOLE post-deadline work and still leaves the outcome write",
    (kind) => {
      // THE ARM 60s FAILED ON KUBERNETES. `runnerPostDeadlineMs("kubernetes")` is 94s; a 60s grace
      // is spent before the teardown even finishes, so the host SIGKILLs the subprocess mid-cleanup
      // and `withRecordedOutcome` never runs — the M23.1c chain, restored.
      expect(managedTriggerGraceMs(kind)).toBeGreaterThan(runnerPostDeadlineMs(kind));
      // And what is LEFT after the cleanup is the whole reason the grace exists.
      expect(managedTriggerGraceMs(kind) - runnerPostDeadlineMs(kind)).toBe(
        MANAGED_OUTCOME_TAIL_MS
      );
      // The teardown alone must not be able to eat it, which is the sentence the old gate made
      // about one call and this one makes about however many that adapter issues.
      expect(managedTriggerGraceMs(kind)).toBeGreaterThan(runnerPostDeadlineCallsMs(kind));
    }
  );

  it.each(LAUNCHER_KINDS)(
    "%s: the reap stamp outlives the host's SIGKILL — never reapable while its owner may live",
    (kind) => {
      // HIGH-2's other door, per adapter. A container/Job whose stamp expires before the process
      // that owns it is dead is `foreign AND past deadline` to every peer launcher, which is
      // precisely and only what `reap()` destroys — onto a live `tofu apply`.
      expect(runnerReapGraceMs(kind)).toBeGreaterThan(managedTriggerGraceMs(kind));
    }
  );

  it("A KUBERNETES INSTANCE GETS THE KUBERNETES GRACE — the injected field, not a constant", () => {
    // `runnerLauncher` is server-injected into the same config object the launcher resolver reads,
    // so host and plugin answer "which adapter?" from ONE value. Before this, the host budgeted a
    // Docker teardown for a run performing a Kubernetes one.
    const docker = resolveCallPolicy({
      module: "managed-iac",
      config: { timeoutMs: 120_000, runnerLauncher: "docker" },
      method: "trigger",
      hangDetectorMs: HANG_DETECTOR_MS
    });
    const k8s = resolveCallPolicy({
      module: "managed-iac",
      config: { timeoutMs: 120_000, runnerLauncher: "kubernetes" },
      method: "trigger",
      hangDetectorMs: HANG_DETECTOR_MS
    });
    expect(docker.budgetMs).toBe(120_000 + managedTriggerGraceMs("docker"));
    expect(k8s.budgetMs).toBe(120_000 + managedTriggerGraceMs("kubernetes"));
    expect(k8s.budgetMs).toBeGreaterThan(docker.budgetMs);
  });

  it("AN UNSET OR UNRECOGNISED `runnerLauncher` IS DOCKER — the same fall-through the resolver makes", () => {
    // `resolveRunnerLauncher` is `config.runnerLauncher !== "kubernetes"` -> Docker. Reading the
    // field any other way here would let the two disagree, which is the whole thing this closes.
    expect(runnerLauncherKindOf(undefined)).toBe("docker");
    expect(runnerLauncherKindOf({})).toBe("docker");
    expect(runnerLauncherKindOf({ runnerLauncher: "podman" })).toBe("docker");
    expect(runnerLauncherKindOf({ runnerLauncher: "kubernetes" })).toBe("kubernetes");
    expect(
      resolveCallPolicy({
        module: "managed-iac",
        config: { timeoutMs: 120_000 },
        method: "trigger",
        hangDetectorMs: HANG_DETECTOR_MS
      }).budgetMs
    ).toBe(120_000 + MANAGED_TRIGGER_GRACE_MS);
  });
});

/**
 * ================================================================================================
 * MEDIUM (verification pass 5) — THE CEILING IS ONE NUMBER AND BOTH SIDES OF THE RPC APPLY IT
 * ================================================================================================
 *
 * `resolveCallPolicy` clamped the HOST's budget and nothing else. The plugin on the other side of
 * the same RPC read the same stored row and handed `config.timeoutMs ?? DEFAULT_TIMEOUT_MS` to
 * `RunnerSpec.timeoutMs` untouched, so above the ceiling the two numbers were not two views of one
 * budget — they were hours apart, in the direction that defeats `reap()`.
 *
 * THIS FILE IS WHERE THAT RELATIONSHIP CAN BE CHECKED AT ALL. `@scp/runner-launcher` may not import
 * from the server (the dependency only goes one way), which is the same reason the grace-ordering
 * arms below live here rather than beside the constants they relate.
 */
describe("MEDIUM (pass 5): the host's budget and the launcher's run are clamped to the SAME ceiling", () => {
  /** A row the pre-ceiling `{ minimum: 1000 }` schema admitted, still in the database, never
   *  re-validated on read. 4 hours — the value the defect was measured at. */
  const STORED_4H = 4 * 60 * 60_000;

  const budgetFor = (module: string, timeoutMs: number): number =>
    resolveCallPolicy({
      module,
      config: { timeoutMs },
      method: "trigger",
      hangDetectorMs: HANG_DETECTOR_MS
    }).budgetMs;

  it.each(MANAGED_EXECUTOR_MODULES)(
    "%s: the run the launcher performs is exactly the run the host budgeted for",
    (module) => {
      // THE EQUALITY IS THE PROPERTY. `budgetMs` is `clampedRunBudget + MANAGED_TRIGGER_GRACE_MS`,
      // so stripping the grace must leave precisely what `run()` will hold the run to. Before the
      // launcher clamp these were 3_600_000 and 14_400_000.
      expect(budgetFor(module, STORED_4H) - MANAGED_TRIGGER_GRACE_MS).toBe(
        clampRunTimeoutMs(STORED_4H)
      );
      // …and for an in-range value the tenant's own number survives on both sides.
      expect(budgetFor(module, 120_000) - MANAGED_TRIGGER_GRACE_MS).toBe(
        clampRunTimeoutMs(120_000)
      );
    }
  );

  it("THE ORPHAN A HOST SIGKILL LEAVES IS REAPABLE WITHIN ONE GRACE, not within days", () => {
    // The measured defect, as arithmetic across the boundary. The host's expiry is the event that
    // CREATES the orphan (it SIGKILLs the subprocess, so no `finally` and no teardown run), and the
    // orphan's stamp is what decides when any peer may collect it.
    const runBudget = clampRunTimeoutMs(2 ** 31);
    const hostSigkillsAt = runBudget + MANAGED_TRIGGER_GRACE_MS;
    const orphanStampedAt = runBudget + RUNNER_REAP_GRACE_MS;

    expect(
      orphanStampedAt - hostSigkillsAt,
      "an orphaned container outlives the SIGKILL that created it by more than one reap grace"
    ).toBeLessThanOrEqual(RUNNER_REAP_GRACE_MS - MANAGED_TRIGGER_GRACE_MS);
    // Unclamped, this window was 2**31 - 3_600_000 ms — 24.5 days of an unsupervised `tofu apply`.
    expect(orphanStampedAt - hostSigkillsAt).toBeLessThanOrEqual(60_000);
    // Still POSITIVE: the container must not become reapable before its owner is dead (HIGH-2).
    expect(orphanStampedAt).toBeGreaterThan(hostSigkillsAt);
  });

  it.each(MANAGED_EXECUTOR_MODULES)(
    "%s's manifest ceiling IS the launcher's, so the two clamps cannot drift",
    (module) => {
      // The boot gate asserts this too; here it is with the actual manifest, named, so that a
      // manifest edit fails on the module rather than on a generic boot message.
      expect(timeoutMaximumFor(module)).toBe(MANAGED_RUN_TIMEOUT_MAX_MS);
    }
  );

  it("the boot gate REFUSES a manifest whose ceiling is not the launcher's", () => {
    const target = MANAGED_EXECUTOR_MODULES[0];
    const schema = MANIFEST_BY_MODULE[target]!.configSchema as {
      properties: { timeoutMs: { maximum: number } };
    };
    const original = schema.properties.timeoutMs.maximum;
    try {
      // A ceiling BELOW the launcher's: the host stops waiting while the run is still legitimately
      // inside its own budget — the M23.1c SIGKILL, back on one plugin, with a green suite.
      schema.properties.timeoutMs.maximum = MANAGED_RUN_TIMEOUT_MAX_MS / 2;
      expect(() => assertManagedTimeoutSchemas()).toThrow(target);
      // And ABOVE it: the write door admits a value the launcher will silently cut short.
      schema.properties.timeoutMs.maximum = MANAGED_RUN_TIMEOUT_MAX_MS * 2;
      expect(() => assertManagedTimeoutSchemas()).toThrow(target);
    } finally {
      schema.properties.timeoutMs.maximum = original;
    }
  });
});
