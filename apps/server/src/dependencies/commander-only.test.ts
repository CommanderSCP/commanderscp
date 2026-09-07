import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type PgBoss from "pg-boss";
import { describe, expect, it } from "vitest";
// A VALUE import, deliberately: `DependencyManagementReasonSchema.options` is the oracle the
// reachability test below derives its expected member list from, and a `import type` would force
// that list to be hand-copied — which is exactly what could not detect a member being added.
import { DependencyManagementReasonSchema, type DependencyManagementReason } from "@scp/schemas";
import { exportedDeclarations, productionSourceFiles, readStripped } from "@scp/source-census";
import {
  commanderOnlyFederationVerdict,
  commanderOnlyJobVerdict,
  dependencyManagementOf,
  type CommanderOnlyConfig,
  type CommanderOnlyVerdict
} from "./commander-only.js";
import { dependencyVersionPollRoleGuard, startDependencyVersionPollLoop } from "./version-poll.js";
import { bumpDispatchRoleGuard, startBumpDispatchLoop } from "./bump-dispatch.js";
import { startBumpGateLoop } from "./bump-gate.js";
import { startBumpFreezeRedriveLoop } from "./bump-freeze-redrive.js";
import {
  internalReleaseDetectionRoleGuard,
  startInternalReleaseLoop
} from "./internal-release-loop.js";
import {
  inventoryIngestionRoleGuard,
  startInventoryIngestionLoop
} from "./inventory-ingestion-loop.js";

/** All dependency automation is commander-only, and agrees. See docs/dependencies.md §130. */

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

type Guard = (config: CommanderOnlyConfig) => CommanderOnlyVerdict;

interface DependencyJob {
  /** Named by capability rather than by file, so a failure names the JOB an operator would
   *  recognise. */
  readonly name: string;
  /** The guard this job's loop is expected to reach the verdict of. */
  readonly guard: Guard;
  /** The loop starter AS IMPORTED — the function object, never a name string, so a wrapper or a
   *  lookalike declared locally is a DIFFERENT object and fails the census below. */
  readonly loop: (...args: never[]) => unknown;
  /** Starts that loop in its own calling convention. See docs/dependencies.md §131. */
  readonly start: (boss: PgBoss, config: CommanderOnlyConfig) => Promise<{ stop(): Promise<void> }>;
}

/** Every background loop in this feature. Kept complete by the census below, not by memory. */
const DEPENDENCY_JOBS: readonly DependencyJob[] = [
  {
    name: "third-party version poll",
    guard: dependencyVersionPollRoleGuard,
    loop: startDependencyVersionPollLoop,
    start: (boss, config) =>
      startDependencyVersionPollLoop(
        boss,
        // The loop reads its config and returns before touching either of these on a refusal, and
        // reaches the probe boss before touching them on an allow — so a stub is honest here and a
        // real Db/PluginHost would only hide which one it dereferenced.
        undefined as unknown as Parameters<typeof startDependencyVersionPollLoop>[1],
        undefined as unknown as Parameters<typeof startDependencyVersionPollLoop>[2],
        config
      )
  },
  {
    name: "internal release detection",
    guard: internalReleaseDetectionRoleGuard,
    loop: startInternalReleaseLoop,
    start: (boss, config) =>
      startInternalReleaseLoop(boss, { config } as unknown as Parameters<
        typeof startInternalReleaseLoop
      >[1])
  },
  {
    name: "dependency-inventory ingestion",
    guard: inventoryIngestionRoleGuard,
    loop: startInventoryIngestionLoop,
    start: (boss, config) =>
      startInventoryIngestionLoop(boss, { config } as unknown as Parameters<
        typeof startInventoryIngestionLoop
      >[1])
  },
  {
    name: "bump dispatch",
    guard: bumpDispatchRoleGuard,
    loop: startBumpDispatchLoop,
    start: (boss, config) =>
      startBumpDispatchLoop(boss, { config } as unknown as Parameters<
        typeof startBumpDispatchLoop
      >[1])
  },
  {
    // THE FIFTH LOOP, and the one that made "five loops, four guards" look like a discrepancy: it
    // declares no guard of its own and imports the dispatcher's instead (`bump-gate.ts`), because
    // merging is a repository write and a more consequential one than opening the pull request.
    name: "auto-merge gate",
    guard: bumpDispatchRoleGuard,
    loop: startBumpGateLoop,
    start: (boss, config) =>
      startBumpGateLoop(boss, { config } as unknown as Parameters<typeof startBumpGateLoop>[1])
  },
  {
    // THE SIXTH LOOP. See docs/dependencies.md §132.
    name: "bump freeze redrive",
    guard: bumpDispatchRoleGuard,
    loop: startBumpFreezeRedriveLoop,
    start: (boss, config) =>
      startBumpFreezeRedriveLoop(
        boss,
        // Read-before-touch, exactly as the poll's entry above: the loop decides on config alone and
        // returns before dereferencing the Db on a refusal.
        undefined as unknown as Parameters<typeof startBumpFreezeRedriveLoop>[1],
        config
      )
  }
];

/** The distinct guards, derived by function identity. See docs/dependencies.md §133. */
const JOB_GUARDS: readonly { name: string; guard: Guard }[] = [
  ...DEPENDENCY_JOBS.reduce((byGuard, job) => {
    byGuard.set(job.guard, [...(byGuard.get(job.guard) ?? []), job.name]);
    return byGuard;
  }, new Map<Guard, string[]>())
].map(([guard, names]) => ({ name: names.join(" + "), guard }));

// THE CENSUS — what background loops EXIST, and is every one of them accounted for?

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** A loop starter, by RETURN TYPE. See docs/dependencies.md §134. */
const RETURNS_LOOP_HANDLE = /^\s*:\s*Promise<\s*\w*LoopHandle\s*>\s*\{/;
const LOOP_STARTER_NAME = /^start[A-Z][\w$]*Loop$/;

interface DiscoveredLoop {
  name: string;
  /** `dependencies/bump-gate.ts` — src-relative, so a failure message is a path a reader can open. */
  file: string;
}

/** `readStripped`, NOT a bare `readFileSync`. See docs/dependencies.md §135. */
const discoveredLoops: DiscoveredLoop[] = productionSourceFiles(SRC_DIR).flatMap((file) =>
  exportedDeclarations(readStripped(file))
    .filter(
      (declaration) =>
        RETURNS_LOOP_HANDLE.test(declaration.tail) || LOOP_STARTER_NAME.test(declaration.name)
    )
    .map((declaration) => ({ name: declaration.name, file: relative(SRC_DIR, file) }))
);

/** Each discovered starter, IMPORTED — so the table below is compared against the actual function
 *  object the module exports rather than against a name that a local shadow would also satisfy. */
const discoveredLoopExports = await Promise.all(
  discoveredLoops.map(async (loop) => {
    const mod: Record<string, unknown> = await import(pathToFileURL(join(SRC_DIR, loop.file)).href);
    return { ...loop, exported: mod[loop.name] };
  })
);

/** The loops that are not dependency automation. See docs/dependencies.md §136. */
const NOT_DEPENDENCY_AUTOMATION: readonly { at: string; why: string }[] = [
  {
    at: "coordination/reconcile.ts:startReconcileLoop",
    why: "an outpost coordinates its own domain"
  },
  { at: "coordination/observe.ts:startObserveLoop", why: "an outpost observes its own executors" },
  { at: "coordination/watchdog.ts:startWatchdogLoop", why: "an outpost times out its own targets" },
  { at: "federation/inbox-loop.ts:startInboxLoop", why: "an outpost is the side that RECEIVES" },
  {
    at: "federation/federation-sync.ts:startFederationSyncLoop",
    why: "federation is the outpost's job"
  },
  {
    at: "federation/auto-relay.ts:startAutoRelayLoop",
    why: "a retrans node relays across the CDS boundary"
  },
  {
    // NOT a loop at all. See docs/dependencies.md §137.
    at: "background-work.ts:startBackgroundLoops",
    why: "the loop runner, not a job — every job it starts brings its own guard"
  }
];

describe("the dependency-job table is COMPLETE — a job cannot exist without being guarded", () => {
  it("accounts for every background loop in the tree: dependency automation, or explicitly not", () => {
    // The property CLAUDE.md names, made checkable: "every dependency job is commander-only" is a
    // claim about a SET, and until this test the set was whatever someone had remembered to type.
    const inTable = new Set(DEPENDENCY_JOBS.map((job) => job.loop as unknown));
    const outOfScope = new Set(NOT_DEPENDENCY_AUTOMATION.map((entry) => entry.at));

    const unclassified = discoveredLoopExports
      .filter((loop) => !inTable.has(loop.exported) && !outOfScope.has(`${loop.file}:${loop.name}`))
      .map(
        (loop) =>
          `${loop.file}:${loop.name} — add it to DEPENDENCY_JOBS with its guard, or to ` +
          `NOT_DEPENDENCY_AUTOMATION with the reason it runs off the commander`
      );
    // Anti-vacuity in both directions, the same mutual guard the router census uses: break
    // discovery and every table entry lands in `tabledButNotFound`; empty the table and every
    // discovered loop lands in `unclassified`. Neither half can pass by finding nothing.
    const tabledButNotFound = DEPENDENCY_JOBS.filter(
      (job) => !discoveredLoopExports.some((loop) => loop.exported === job.loop)
    ).map(
      (job) =>
        `${job.name} — the table's function is not the one the tree exports (a shadow, a wrapper, ` +
        `or discovery has stopped finding it)`
    );
    const staleExemptions = [...outOfScope].filter(
      (at) => !discoveredLoops.some((loop) => `${loop.file}:${loop.name}` === at)
    );

    expect({ unclassified, tabledButNotFound, staleExemptions }).toEqual({
      unclassified: [],
      tabledButNotFound: [],
      staleExemptions: []
    });
  });

  it("finds more loops than the dependency feature owns — discovery is not looking at one directory", () => {
    // If this ever equalled `DEPENDENCY_JOBS.length` the walk would have narrowed to
    // `dependencies/` without anyone noticing, and the exemption list above would be decoration.
    expect(discoveredLoops.length).toBeGreaterThan(DEPENDENCY_JOBS.length);
    expect(discoveredLoops.map((loop) => `${loop.file}:${loop.name}`)).toContain(
      "coordination/reconcile.ts:startReconcileLoop"
    );
  });
});

/** THE GUARD IS NOT MERELY COMPUTED. See docs/dependencies.md §138. */
class ProbeBossTouched extends Error {}

function probeBoss(): { boss: PgBoss; touched: string[] } {
  const touched: string[] = [];
  const explode =
    (method: string) =>
    async (...args: unknown[]): Promise<never> => {
      touched.push(`${method}(${typeof args[0] === "string" ? args[0] : ""})`);
      throw new ProbeBossTouched(method);
    };
  return {
    touched,
    boss: {
      createQueue: explode("createQueue"),
      work: explode("work"),
      send: explode("send"),
      schedule: explode("schedule")
    } as unknown as PgBoss
  };
}

async function loopStarts(job: DependencyJob, config: CommanderOnlyConfig): Promise<boolean> {
  const { boss, touched } = probeBoss();
  try {
    const handle = await job.start(boss, config);
    await handle.stop();
  } catch (err) {
    if (err instanceof ProbeBossTouched) return true;
    throw err;
  }
  // A loop that swallowed the probe's throw still reveals itself: it touched the boss.
  return touched.length > 0;
}

describe("every dependency loop OBEYS its guard — the verdict decides whether it starts", () => {
  it("starts exactly where its guard allows and NEVER CREATES A QUEUE where it refuses", async () => {
    const wrong: string[] = [];
    for (const job of DEPENDENCY_JOBS) {
      for (const config of CONFIG_MATRIX) {
        const started = await loopStarts(job, config);
        const allowed = job.guard(config).allowed;
        if (started !== allowed) {
          wrong.push(
            `${job.name} @ ${describeConfig(config)}: guard says ${allowed}, loop ${
              started ? "STARTED" : "did not start"
            }`
          );
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it("NEGATIVE CONTROL — every loop really does start somewhere, so the refusals above mean something", async () => {
    const commander: CommanderOnlyConfig = {
      role: "worker",
      federationRole: "commander",
      federationRoleDeclared: true
    };
    const inert: string[] = [];
    for (const job of DEPENDENCY_JOBS) {
      if (!(await loopStarts(job, commander))) inert.push(job.name);
    }
    expect(inert).toEqual([]);
  });
});

describe("every guard tests the axes in the SAME ORDER — one misconfiguration, one remedy", () => {
  /** The order is pinned WITHOUT pinning any wording. See docs/dependencies.md §139. */
  const onlyProcessWrong: CommanderOnlyConfig = {
    role: "api",
    federationRole: "commander",
    federationRoleDeclared: true
  };
  const onlyUndeclared: CommanderOnlyConfig = {
    role: "worker",
    federationRole: "commander",
    federationRoleDeclared: false
  };
  const onlyNotCommander: CommanderOnlyConfig = {
    role: "worker",
    federationRole: "outpost",
    federationRoleDeclared: true
  };

  it("blames the PROCESS axis first — an api process is never sent to change a federation setting", () => {
    // Wrong on all three. Before this round the poll answered "federationRole is 'outpost'" here
    // and the dispatcher answered "SCP_ROLE is 'api'", for one and the same deployment.
    const everythingWrong: CommanderOnlyConfig = {
      role: "api",
      federationRole: "outpost",
      federationRoleDeclared: false
    };
    for (const job of JOB_GUARDS) {
      expect(job.guard(everythingWrong).allowed, job.name).toBe(false);
      expect(job.guard(everythingWrong).reason, job.name).toBe(job.guard(onlyProcessWrong).reason);
    }
  });

  it("blames the UNDECLARED axis before the declared-role axis", () => {
    // `federationRole` is a DEFAULT and not a fact on an undeclared deployment, so this also pins
    // that no guard quotes the value in its undeclared sentence: 'outpost' here and 'commander' in
    // `onlyUndeclared` must produce the same line, because neither is something to act on.
    const undeclaredOutpost: CommanderOnlyConfig = {
      role: "worker",
      federationRole: "outpost",
      federationRoleDeclared: false
    };
    for (const job of JOB_GUARDS) {
      expect(job.guard(undeclaredOutpost).allowed, job.name).toBe(false);
      expect(job.guard(undeclaredOutpost).reason, job.name).toBe(job.guard(onlyUndeclared).reason);
    }
  });

  it("NEGATIVE CONTROL — the three refusals are three DISTINCT sentences per guard", () => {
    // Without this, a guard that returned one generic string for everything would satisfy both
    // assertions above perfectly, and the operator-facing half of the fix would be gone.
    for (const job of JOB_GUARDS) {
      const reasons = [onlyProcessWrong, onlyUndeclared, onlyNotCommander].map(
        (config) => job.guard(config).reason
      );
      expect(new Set(reasons).size, `${job.name}: ${reasons.join(" | ")}`).toBe(3);
    }
  });
});

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
    // THE BUG THIS EXISTS TO PREVENT. See docs/dependencies.md §140.
    const roles = [...new Set(CONFIG_MATRIX.map((config) => config.role))];
    // The fixture's own guard: the whole point is the role the JOB guard refuses, so a role list
    // that has lost it is a list this test cannot fail on.
    expect(roles).toContain("api");

    const verdicts = roles.map((role) => {
      // Typed as the FULL job config — the extra axis is present in the value handed to a function
      // whose parameter type omits it, which is exactly the production call shape (`deps.config`).
      const config: CommanderOnlyConfig = {
        role,
        federationRole: "commander",
        federationRoleDeclared: true
      };
      return { role, verdict: commanderOnlyFederationVerdict(config, "the route") };
    });

    for (const { role, verdict } of verdicts) {
      expect(verdict.allowed, role).toBe(true);
      // Identical, not merely all-allowed: a guard that started reading the process axis to shade
      // its REASON would still allow, and would still be a route telling an operator about a
      // setting the route does not depend on.
      expect(verdict, role).toEqual(verdicts[0]!.verdict);
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

/** The same verdict, shaped as an answer not a refusal. See docs/dependencies.md §141. */
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
    // A value nobody can produce is a lie in the contract. See docs/dependencies.md §142.
    const declared: readonly DependencyManagementReason[] =
      DependencyManagementReasonSchema.options;
    // Anti-vacuity: an oracle that resolved to `[]` would make the assertion below a claim about
    // nothing, and every `produced` value would have to vanish for it to fail.
    expect(declared.length).toBeGreaterThan(1);
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
