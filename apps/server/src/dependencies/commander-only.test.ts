import { describe, expect, it } from "vitest";
import type { DependencyManagementReason } from "@scp/schemas";
import {
  commanderOnlyFederationVerdict,
  commanderOnlyJobVerdict,
  dependencyManagementOf,
  type CommanderOnlyConfig,
  type CommanderOnlyVerdict
} from "./commander-only.js";
import { dependencyVersionPollRoleGuard } from "./version-poll.js";
import { bumpDispatchRoleGuard } from "./bump-dispatch.js";
import { internalReleaseDetectionRoleGuard } from "./internal-release-loop.js";
import { inventoryIngestionRoleGuard } from "./inventory-ingestion-loop.js";

/**
 * ================================================================================================
 * ADR-0032 §7d — ALL DEPENDENCY AUTOMATION IS COMMANDER-ONLY, AND ALL OF IT AGREES
 * ================================================================================================
 * The owner's decision (2026-08-17) is a statement about the WHOLE feature, not about one job: an
 * outpost never ORIGINATES a dependency bump, it RECEIVES the resulting change down the global
 * pipeline the commander manages. A rule that holds for a feature and is implemented once per job
 * is the property CLAUDE.md's census rule names — it regresses per job, and the branch that
 * regresses first is the fail-closed one, which is false on every developer machine, on every
 * declared commander, and in every test that does not deliberately construct it.
 *
 * So the DECISION is asserted here across every guard at once, over the FULL config matrix rather
 * than a sample. Two of the five keep bespoke bodies on purpose (their refusal TEXT carries
 * capability-specific facts a shared string cannot); this file is what makes that safe, because it
 * does not care how a guard is implemented — only that all five answer the same question the same
 * way. Add a sixth dependency job, forget to guard it, and the entry added here fails.
 */

/** Every deployment shape a guard can see — the full product of the three axes, not a sample. */
const CONFIG_MATRIX: CommanderOnlyConfig[] = (["all", "api", "worker"] as const).flatMap((role) =>
  (["commander", "outpost", "retrans"] as const).flatMap((federationRole) =>
    [true, false].map((federationRoleDeclared) => ({
      role,
      federationRole,
      federationRoleDeclared
    }))
  )
);

const describeConfig = (config: CommanderOnlyConfig): string =>
  `role=${config.role} federationRole=${config.federationRole} declared=${config.federationRoleDeclared}`;

/**
 * Every background job in this feature, by the guard it actually exports. Named by capability
 * rather than by file so a failure names the JOB an operator would recognise.
 */
const JOB_GUARDS: readonly {
  name: string;
  guard: (config: CommanderOnlyConfig) => CommanderOnlyVerdict;
}[] = [
  { name: "third-party version poll", guard: dependencyVersionPollRoleGuard },
  { name: "internal release detection", guard: internalReleaseDetectionRoleGuard },
  { name: "dependency-inventory ingestion", guard: inventoryIngestionRoleGuard },
  // Both the dispatcher and the auto-merge gate consult this one — `bump-gate.ts` imports it rather
  // than declaring its own, so guarding it once covers both loops.
  { name: "bump dispatch + auto-merge gate", guard: bumpDispatchRoleGuard }
];

describe("every dependency-automation job reaches the SAME verdict, on every deployment shape", () => {
  it("allows exactly the two background-work roles on an explicitly declared commander — nothing else, for any job", () => {
    // The oracle is written out rather than derived from any guard, so it cannot agree with a
    // uniformly-broken set of guards: two configs out of eighteen, stated independently.
    const expectedAllowed = [
      { role: "all", federationRole: "commander", federationRoleDeclared: true },
      { role: "worker", federationRole: "commander", federationRoleDeclared: true }
    ];
    for (const job of JOB_GUARDS) {
      const allowed = CONFIG_MATRIX.filter((config) => job.guard(config).allowed);
      expect(allowed, job.name).toEqual(expectedAllowed);
    }
  });

  it("disagrees nowhere — a guard that drifts from the others fails here naming both", () => {
    const disagreements = CONFIG_MATRIX.flatMap((config) => {
      const verdicts = JOB_GUARDS.map((job) => ({ name: job.name, ...job.guard(config) }));
      const first = verdicts[0]!;
      return verdicts
        .filter((verdict) => verdict.allowed !== first.allowed)
        .map(
          (verdict) =>
            `${describeConfig(config)}: '${verdict.name}' says ${verdict.allowed}, '${first.name}' says ${first.allowed}`
        );
    });
    expect(disagreements).toEqual([]);
  });

  it("gives a REASON on every refusal, for every job — a silent guard is the failure this feature keeps shipping", () => {
    const silent = CONFIG_MATRIX.flatMap((config) =>
      JOB_GUARDS.filter((job) => {
        const verdict = job.guard(config);
        return !verdict.allowed && verdict.reason.trim() === "";
      }).map((job) => `${job.name} @ ${describeConfig(config)}`)
    );
    expect(silent).toEqual([]);
  });
});

describe("commanderOnlyJobVerdict — the three refusals, one per axis", () => {
  const base = {
    role: "worker" as const,
    federationRole: "commander" as const,
    federationRoleDeclared: true
  };
  const what = "the test capability";

  it("names the PROCESS axis first, so an api process is not sent to change a federation setting", () => {
    // Order matters for the remedy, not for the verdict: an api process on an undeclared outpost is
    // wrong on both axes, and the operator's first move is to run it on a worker.
    const verdict = commanderOnlyJobVerdict(
      { role: "api", federationRole: "outpost", federationRoleDeclared: false },
      what
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/SCP_ROLE/);
    expect(verdict.reason).not.toMatch(/SCP_FEDERATION_ROLE/);
  });

  it("refuses an UNDECLARED deployment even though `federationRole` reads 'commander'", () => {
    // This is exactly what `loadConfig` produces with SCP_FEDERATION_ROLE unset, and it is the only
    // refusal whose input looks identical to the accepted case.
    const verdict = commanderOnlyJobVerdict({ ...base, federationRoleDeclared: false }, what);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/not declared/);
    // The remedy has to be in the line, or an operator running a real commander cannot turn it on.
    expect(verdict.reason).toMatch(/federationRole/);
  });

  it("refuses a declared non-commander and says where the work belongs", () => {
    for (const federationRole of ["outpost", "retrans"] as const) {
      const verdict = commanderOnlyJobVerdict({ ...base, federationRole }, what);
      expect(verdict.allowed, federationRole).toBe(false);
      expect(verdict.reason, federationRole).toMatch(/COMMANDER/);
      expect(verdict.reason, federationRole).toContain(federationRole);
    }
  });

  it("interpolates the capability, so five callers do not log one indistinguishable sentence", () => {
    // Mutating the FIXTURE, not just the input: a guard that ignored `what` would pass every
    // assertion above and produce five identical, unattributable log lines in production.
    for (const capability of ["capability-alpha", "capability-beta"]) {
      expect(
        commanderOnlyJobVerdict({ ...base, federationRole: "outpost" }, capability).reason
      ).toContain(capability);
      expect(commanderOnlyJobVerdict(base, capability).reason).toContain(capability);
    }
  });

  it("allows both background-work roles on a declared commander, and logs that it did", () => {
    for (const role of ["all", "worker"] as const) {
      const verdict = commanderOnlyJobVerdict({ ...base, role }, what);
      expect(verdict.allowed, role).toBe(true);
      // A posture this consequential must not be the invisible one — the allow carries a reason too.
      expect(verdict.reason, role).not.toBe("");
    }
  });
});

describe("commanderOnlyFederationVerdict — the half a ROUTE asks", () => {
  it("ignores SCP_ROLE entirely, because every HTTP request lands on an api process in a split topology", () => {
    // THE BUG THIS EXISTS TO PREVENT: applying the job guard to a route would 4xx every backfill
    // call on a correctly-deployed commander that runs `SCP_ROLE=api` in front of `SCP_ROLE=worker`.
    for (const role of ["all", "api", "worker"] as const) {
      expect(
        commanderOnlyFederationVerdict(
          { federationRole: "commander", federationRoleDeclared: true },
          "the route"
        ).allowed,
        role
      ).toBe(true);
    }
  });

  it("still refuses an undeclared deployment and a declared non-commander", () => {
    expect(
      commanderOnlyFederationVerdict(
        { federationRole: "commander", federationRoleDeclared: false },
        "the route"
      ).allowed
    ).toBe(false);
    for (const federationRole of ["outpost", "retrans"] as const) {
      expect(
        commanderOnlyFederationVerdict(
          { federationRole, federationRoleDeclared: true },
          "the route"
        ).allowed,
        federationRole
      ).toBe(false);
    }
  });

  it("agrees with the job guard on the federation axis wherever the process axis is satisfied", () => {
    // The two entry points must not be able to disagree about federation — that is the whole reason
    // one calls the other rather than restating it.
    for (const config of CONFIG_MATRIX.filter((c) => c.role !== "api")) {
      expect(commanderOnlyFederationVerdict(config, "x").allowed, describeConfig(config)).toBe(
        commanderOnlyJobVerdict(config, "x").allowed
      );
    }
  });
});

/**
 * ================================================================================================
 * `dependencyManagementOf` — THE SAME VERDICT, SHAPED AS AN ANSWER RATHER THAN A REFUSAL
 * ================================================================================================
 * The guards above produce refusals. The tenant-facing resolve route does not refuse: it answers
 * `enabled` on an outpost, correctly computed from federated policies that NOTHING THERE WILL ACT
 * ON. The envelope is what qualifies that answer, so what has to be true of it is (a) it never
 * disagrees with the guard that actually gates the work, and (b) `role_undeclared` is its own value
 * — the branch that reads as `commander` on the config value alone, and is the exact opposite of it.
 */
describe("dependencyManagementOf — the answer-shaped verdict (ADR-0032 §7d)", () => {
  it("answers `true`/`commander` for an explicitly declared commander", () => {
    expect(
      dependencyManagementOf({ federationRole: "commander", federationRoleDeclared: true })
    ).toEqual({ managedHere: true, reason: "commander" });
  });

  it("answers `role_undeclared` — NOT `commander` — for a deployment that never declared a role", () => {
    // THE POINT OF THE WHOLE VALUE. `loadConfig` DEFAULTS `federationRole` to 'commander' when
    // SCP_FEDERATION_ROLE is unset, so the input here is byte-identical to the accepted case on
    // every field but `federationRoleDeclared`. Folding it into `commander` would hand a caller the
    // opposite of the truth: it looks like the place work happens and is the place nothing runs.
    const envelope = dependencyManagementOf({
      federationRole: "commander",
      federationRoleDeclared: false
    });
    expect(envelope.managedHere).toBe(false);
    expect(envelope.reason).toBe("role_undeclared");
    expect(envelope.reason).not.toBe("commander");
  });

  it("names the DECLARED role on each refusal, so the remedy differs per posture", () => {
    for (const federationRole of ["outpost", "retrans"] as const) {
      expect(dependencyManagementOf({ federationRole, federationRoleDeclared: true })).toEqual({
        managedHere: false,
        reason: federationRole
      });
    }
  });

  it("reaches every reason value the schema declares — none is unreachable", () => {
    // A value nobody can produce is a lie in the contract: a consuming client would branch on it
    // forever and never see it. The oracle is the schema's own member list, written out here so
    // adding a sixth member without a way to produce it fails.
    const declared: DependencyManagementReason[] = [
      "commander",
      "outpost",
      "retrans",
      "role_undeclared"
    ];
    const produced = new Set(CONFIG_MATRIX.map((config) => dependencyManagementOf(config).reason));
    expect([...produced].sort()).toEqual([...declared].sort());
  });

  it("carries `managedHere` iff `reason` is `commander`, on every deployment shape", () => {
    // The invariant that lets a caller read either field alone. Asserted rather than trusted,
    // because `reason` is a LABEL computed beside the verdict rather than from it.
    const inconsistent = CONFIG_MATRIX.filter((config) => {
      const envelope = dependencyManagementOf(config);
      return envelope.managedHere !== (envelope.reason === "commander");
    }).map(describeConfig);
    expect(inconsistent).toEqual([]);
  });

  it("NEVER DISAGREES WITH THE GUARD THAT GATES THE WORK — over the full config matrix", () => {
    // The whole reason this is one predicate. An envelope that said "managed here" where the
    // backfill answers 409, or the reverse, would be a worse explanation than no envelope at all.
    const disagreements = CONFIG_MATRIX.filter(
      (config) =>
        dependencyManagementOf(config).managedHere !==
        commanderOnlyFederationVerdict(config, "x").allowed
    ).map(describeConfig);
    expect(disagreements).toEqual([]);
  });

  it("is a fact about the DEPLOYMENT, not the process — SCP_ROLE never changes the answer", () => {
    // In the split topology every HTTP request lands on an `SCP_ROLE=api` process while the jobs
    // drain on a `worker`. Reading the process axis here would tell every caller of a perfectly
    // correct commander that dependencies are not managed there.
    for (const role of ["all", "api", "worker"] as const) {
      expect(
        dependencyManagementOf({
          ...{ role },
          federationRole: "commander",
          federationRoleDeclared: true
        }),
        role
      ).toEqual({ managedHere: true, reason: "commander" });
    }
  });
});
