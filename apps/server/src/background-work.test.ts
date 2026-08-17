import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type PgBoss from "pg-boss";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportedDeclarations, productionSourceFiles, readStripped } from "@scp/source-census";
import type { ServerConfig } from "./config.js";
import type { Db } from "./db/client.js";
import type { CelSandbox } from "./governance/cel-sandbox.js";
import type { PluginHost } from "./plugin-host/contract.js";
import {
  BACKGROUND_LOOPS,
  runsBackgroundWork,
  startBackgroundLoops,
  type BackgroundLoop,
  type BackgroundLoopContext
} from "./background-work.js";

/**
 * ================================================================================================
 * THE COMPOSITION ROOT'S BACKGROUND WORK, PROVEN BY RUNNING IT
 * ================================================================================================
 * This file exists because the thing it checks was, until now, checked by SUBSTRING MATCHES on
 * `main.ts` — and those were measured worthless twice over:
 *
 *   - M21.7: commenting `startBumpDispatchLoop(…)` out of `main.ts` left `bump-dispatch.test.ts`
 *     green at 20/20, including a case literally named "starts the worker, and stops it on
 *     shutdown", and left the whole apps/server unit suite green at 972/972.
 *   - 2026-08-17 (this change): flipping `main.ts`'s background-work condition to `false` — one
 *     token, killing ALL ELEVEN loops — left `bump-dispatch`, `bump-gate`, `inventory-ingestion`
 *     and `domain-event-routers` green at 79/79, and the full 972-test unit suite green.
 *     `domain-event-routers.test.ts` had recorded that exact mutation as a known-uncovered edge.
 *
 * `main.ts` cannot be imported (`main()` runs at module scope), so the fix was not a better regex —
 * it was to MOVE THE THING BEING CHECKED somewhere importable. `background-work.ts` holds the loop
 * registry and the role predicate; everything below EXECUTES them.
 *
 * WHAT IS PROVEN HERE, BEHAVIOURALLY:
 *   1. `runsBackgroundWork` — which process roles own loops, by calling it.
 *   2. The registry is COMPLETE — every `start…Loop` in the tree is registered or explicitly
 *      exempted, compared by function IDENTITY against what each module exports.
 *   3. Every registered loop ACTUALLY STARTS and reaches pg-boss, creating its own queue, when its
 *      config allows. Wrong arguments in a registry entry fail here, because the loop runs.
 *   4. Every registered loop's guard is OBEYED through the registry path — a refused loop creates
 *      no queue.
 *   5. `stop()` stops EVERY loop that was started, in order.
 *
 * WHAT IS *NOT* PROVEN HERE, STATED PLAINLY (see `@scp/source-census`'s package doc for the general
 * list): that `main.ts` calls `startBackgroundLoops` at all. That single link is still a substring
 * match — the one at the bottom of this file — because nothing can import `main.ts`. It is one call
 * rather than eleven plus eleven `.stop()`s, and the registry means a NEW loop cannot widen that
 * gap; but a mutation that deletes the call from `main.ts` entirely is caught only by that
 * substring, and a mutation that makes the enclosing branch dead is caught by NOTHING in this
 * package. Closing it needs a test that boots the real process against a real database and asks
 * the database which queues exist. That is not written, and this comment is not a substitute for
 * it — it is a record that the gap is known and where it lives.
 */

// -------------------------------------------------------------------------------------------
// Fixtures
// -------------------------------------------------------------------------------------------

/** A `boss` that RECORDS instead of refusing — the opposite polarity from
 *  `dependencies/commander-only.test.ts`'s probe (which throws on touch to prove a REFUSAL touched
 *  nothing). Here the question is what a loop that is ALLOWED to run actually does, so every call
 *  is captured and the queue names are the observable. */
function recordingBoss(): { boss: PgBoss; queues: string[]; calls: string[] } {
  const queues: string[] = [];
  const calls: string[] = [];
  const boss = new Proxy(
    {},
    {
      get(_target, property: string | symbol) {
        // A Proxy that answers every property with a function makes the object THENABLE, and
        // `await boss` would then hang forever. Anything not a string method name is absent.
        if (typeof property !== "string" || property === "then") return undefined;
        return async (...args: unknown[]): Promise<unknown> => {
          calls.push(property);
          if (property === "createQueue" && typeof args[0] === "string") queues.push(args[0]);
          if (property === "getSchedules") return [];
          if (property === "send") return "job-id";
          return undefined;
        };
      }
    }
  ) as unknown as PgBoss;
  return { boss, queues, calls };
}

/** The three axes a loop guard can see, plus the master key the coordination loops take. Only the
 *  fields the loops read at START time need to be real; a loop that dereferences `db` or `host`
 *  before deciding whether to run would fail loudly here, which is information rather than noise. */
function contextFor(
  boss: PgBoss,
  overrides: Partial<Pick<ServerConfig, "role" | "federationRole" | "federationRoleDeclared">> = {}
): BackgroundLoopContext {
  const config = {
    role: "worker",
    federationRole: "commander",
    federationRoleDeclared: true,
    secretsMasterKey: Buffer.alloc(32),
    ...overrides
  } as unknown as ServerConfig;
  return {
    boss,
    db: undefined as unknown as Db,
    host: undefined as unknown as PluginHost,
    sandbox: undefined as unknown as CelSandbox,
    config
  };
}

/** The three DEFAULT-OFF loops read the LIVE env at start (never an import-frozen const), so a run
 *  that wants to see them start has to turn them on the same way an operator would. */
const OPT_IN_ENV = {
  SCP_INBOX_LOOP: "1",
  SCP_RETRANS_AUTO_RELAY: "1",
  SCP_FEDERATION_SYNC_LOOP: "1"
} as const;

let savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  savedEnv = {};
  for (const key of Object.keys(OPT_IN_ENV)) savedEnv[key] = process.env[key];
});
afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function enableOptInLoops(): void {
  for (const [key, value] of Object.entries(OPT_IN_ENV)) process.env[key] = value;
}

// -------------------------------------------------------------------------------------------
// 1. The role predicate — the thing whose inline version was unreachable
// -------------------------------------------------------------------------------------------

describe("runsBackgroundWork", () => {
  it("is true for the two roles that own loops and false for a pure api process", () => {
    // Inline in `main.ts` this was the single token whose mutation killed every loop with a green
    // suite. Exported, it costs three assertions to pin.
    expect(runsBackgroundWork({ role: "all" })).toBe(true);
    expect(runsBackgroundWork({ role: "worker" })).toBe(true);
    expect(runsBackgroundWork({ role: "api" })).toBe(false);
  });
});

// -------------------------------------------------------------------------------------------
// 2. The registry is COMPLETE — discovered from the tree, not from memory
// -------------------------------------------------------------------------------------------

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)));

/** Same two-armed rule `dependencies/commander-only.test.ts` uses, and for the same reason: a new
 *  loop that returns `Promise<PollerHandle>` is caught by the NAME, one called `startDependencyReaper`
 *  by the RETURN TYPE. Matching on either is how a census avoids being a census of what it expects. */
const RETURNS_LOOP_HANDLE = /^\s*:\s*Promise<\s*\w*LoopHandle\s*>\s*\{/;
const LOOP_STARTER_NAME = /^start[A-Z][\w$]*Loop$/;

/** `readStripped`, never `readFileSync` — a `start…Loop` quoted inside a module doc would otherwise
 *  be DISCOVERED, imported, found absent, and reported as an unregistered loop that does not exist.
 *  See `@scp/source-census` for the six things stripping still does not buy. */
const discoveredLoops = productionSourceFiles(SRC_DIR).flatMap((file) =>
  exportedDeclarations(readStripped(file))
    .filter(
      (declaration) =>
        RETURNS_LOOP_HANDLE.test(declaration.tail) || LOOP_STARTER_NAME.test(declaration.name)
    )
    .map((declaration) => ({ name: declaration.name, file: relative(SRC_DIR, file) }))
);

const discoveredLoopExports = await Promise.all(
  discoveredLoops.map(async (loop) => {
    const mod: Record<string, unknown> = await import(pathToFileURL(join(SRC_DIR, loop.file)).href);
    return { ...loop, exported: mod[loop.name] };
  })
);

/**
 * Loop starters that are deliberately NOT in `BACKGROUND_LOOPS`, each with the reason — listed
 * rather than filtered by directory, because a path filter is exactly where the next unwired loop
 * hides (CLAUDE.md: census with no grep filters).
 */
const NOT_COMPOSITION_ROOT_LOOPS: readonly { at: string; why: string }[] = [
  {
    at: "background-work.ts:startBackgroundLoops",
    why:
      "the RUNNER, not a loop — it returns a Promise<BackgroundLoopHandle> and so is discovered by " +
      "the return-type arm. Registering it in BACKGROUND_LOOPS would start the registry inside itself."
  }
];

describe("BACKGROUND_LOOPS accounts for every background loop in the tree", () => {
  it("registers each discovered loop exactly once, or exempts it with a reason", () => {
    const registered = new Map<unknown, string[]>();
    for (const entry of BACKGROUND_LOOPS) {
      registered.set(entry.loop, [...(registered.get(entry.loop) ?? []), entry.name]);
    }
    const exempt = new Set(NOT_COMPOSITION_ROOT_LOOPS.map((entry) => entry.at));

    const unregistered = discoveredLoopExports
      .filter((loop) => !registered.has(loop.exported) && !exempt.has(`${loop.file}:${loop.name}`))
      .map(
        (loop) =>
          `${loop.file}:${loop.name} — add it to BACKGROUND_LOOPS, or to ` +
          `NOT_COMPOSITION_ROOT_LOOPS with the reason the composition root does not start it`
      );

    // Registered TWICE is its own defect and the mirror of the router registry's double-registration
    // hazard: two handles on one loop means two workers competing on one queue.
    const registeredTwice = [...registered.values()]
      .filter((names) => names.length > 1)
      .map((names) => names.join(" + "));

    // Anti-vacuity, both directions: break discovery and every registry entry lands in
    // `registeredButNotFound`; empty the registry and every discovered loop lands in `unregistered`.
    const registeredButNotFound = BACKGROUND_LOOPS.filter(
      (entry) => !discoveredLoopExports.some((loop) => loop.exported === entry.loop)
    ).map(
      (entry) =>
        `${entry.name} — the registry's function is not the one the tree exports (a shadow, a ` +
        `wrapper, or discovery has stopped finding it)`
    );

    const staleExemptions = [...exempt].filter(
      (at) => !discoveredLoops.some((loop) => `${loop.file}:${loop.name}` === at)
    );

    expect({
      unregistered,
      registeredTwice,
      registeredButNotFound,
      staleExemptions
    }).toEqual({
      unregistered: [],
      registeredTwice: [],
      registeredButNotFound: [],
      staleExemptions: []
    });
  });

  it("discovers loops across more than one directory — the walk has not narrowed", () => {
    const files = new Set(discoveredLoops.map((loop) => dirname(loop.file)));
    expect(files.size).toBeGreaterThan(1);
    expect(discoveredLoops.map((loop) => `${loop.file}:${loop.name}`)).toContain(
      "coordination/reconcile.ts:startReconcileLoop"
    );
  });
});

// -------------------------------------------------------------------------------------------
// 3+4. Every registered loop RUNS — and obeys its guard — through the real registry path
// -------------------------------------------------------------------------------------------

/** The queue each loop creates when it is allowed to run. Written out rather than imported as a set
 *  of constants ON PURPOSE: this is the ORACLE. Importing `RECONCILE_QUEUE` here would make the
 *  assertion agree with the code by construction, and a queue renamed on both sides at once — which
 *  is a pg-boss-visible, operator-visible change — would pass silently. */
const QUEUE_PER_LOOP: Readonly<Record<string, string>> = {
  reconcile: "coordination-reconcile-tick",
  watchdog: "coordination-watchdog-sweep",
  observe: "coordination-observe-tick",
  "federation inbox": "federation-inbox-tick",
  "retrans auto-relay": "federation-auto-relay-tick",
  "federation sync": "federation-sync-tick",
  "third-party version poll": "dependency-version-poll-tick",
  "internal release detection": "dependency-internal-release",
  "dependency-inventory ingestion": "dependency-inventory-ingestion",
  "bump dispatch": "dependency-bump",
  "auto-merge gate": "dependency-bump-gate"
};

describe("every registered loop actually starts, against the real registry", () => {
  it("creates EXACTLY the queue set the eleven loops own, on a declared commander worker", async () => {
    enableOptInLoops();
    const { boss, queues } = recordingBoss();

    const handle = await startBackgroundLoops(contextFor(boss));
    await handle.stop();

    // Every loop reached pg-boss and created ITS OWN queue. This is what a substring on `main.ts`
    // could never say: the loop RAN, with the arguments the registry entry actually builds.
    expect([...queues].sort()).toEqual([...Object.values(QUEUE_PER_LOOP)].sort());
    // …and the oracle covers the whole registry, so a loop added without a queue row here fails
    // rather than being silently unchecked.
    expect(Object.keys(QUEUE_PER_LOOP).sort()).toEqual(
      BACKGROUND_LOOPS.map((entry) => entry.name).sort()
    );
  });

  it("starts NO dependency loop on a field outpost — the guards are consulted on this path too", async () => {
    // The negative control for the case above, and the ADR-0032 §7d rule observed at the
    // COMPOSITION ROOT rather than on the guards in isolation. `commander-only.test.ts` proves each
    // guard's full matrix; this proves the registry actually routes through them.
    enableOptInLoops();
    const { boss, queues } = recordingBoss();

    const handle = await startBackgroundLoops(
      contextFor(boss, { federationRole: "outpost", federationRoleDeclared: true })
    );
    await handle.stop();

    const dependencyQueues = Object.values(QUEUE_PER_LOOP).filter((queue) =>
      queue.startsWith("dependency-")
    );
    expect(queues.filter((queue) => dependencyQueues.includes(queue))).toEqual([]);
    // The coordination and federation loops are NOT commander-only — an outpost reconciles its own
    // domain — so they must still be here. Without this the case would also pass if nothing ran.
    expect(queues).toContain("coordination-reconcile-tick");
    expect(queues).toContain("federation-inbox-tick");
  });

  it("leaves the three DEFAULT-OFF loops inert when their env opt-in is absent", async () => {
    // No `enableOptInLoops()`. An unconfigured instance does not spin, and "does not spin" means
    // the queue is never created — not merely that a tick does nothing.
    const { boss, queues } = recordingBoss();
    const handle = await startBackgroundLoops(contextFor(boss));
    await handle.stop();

    expect(queues).not.toContain("federation-inbox-tick");
    expect(queues).not.toContain("federation-auto-relay-tick");
    expect(queues).not.toContain("federation-sync-tick");
    expect(queues).toContain("coordination-reconcile-tick");
  });
});

// -------------------------------------------------------------------------------------------
// 5. The runner itself — started in order, and every started loop is stopped
// -------------------------------------------------------------------------------------------

describe("startBackgroundLoops — the runner", () => {
  /** A synthetic table, so the RUNNER's contract is pinned independently of the eleven real loops:
   *  with the real table, "stopped everything" is invisible (a real handle's `stop()` has no
   *  observable here). This is the layer that catches a runner that starts eleven and stops ten. */
  function fakeLoops(count: number): {
    loops: BackgroundLoop[];
    started: string[];
    stopped: string[];
  } {
    const started: string[] = [];
    const stopped: string[] = [];
    const loops = Array.from({ length: count }, (_unused, index) => {
      const name = `loop-${index}`;
      return {
        name,
        loop: () => undefined,
        start: async () => {
          started.push(name);
          return {
            stop: async () => {
              stopped.push(name);
            }
          };
        }
      } satisfies BackgroundLoop;
    });
    return { loops, started, stopped };
  }

  it("starts every loop in registration order", async () => {
    const { loops, started } = fakeLoops(4);
    await startBackgroundLoops(contextFor(recordingBoss().boss), loops);
    expect(started).toEqual(["loop-0", "loop-1", "loop-2", "loop-3"]);
  });

  it("STOPS EVERY LOOP IT STARTED, in the same order", async () => {
    // The regression this closes by construction: `main.ts` used to hand-write eleven `.stop()`
    // calls beside eleven `const`s, so a twelfth loop could be started and never stopped, and
    // nothing anywhere would notice. There is now one loop over what was started.
    const { loops, started, stopped } = fakeLoops(4);
    const handle = await startBackgroundLoops(contextFor(recordingBoss().boss), loops);
    expect(stopped).toEqual([]);
    await handle.stop();
    expect(stopped).toEqual(started);
  });

  it("stops only what it started when a later loop fails to start", async () => {
    // Boot fails loudly (the error propagates) — but the loops already up must still be stoppable,
    // and the handle for a loop that never started cannot be invented.
    const { loops, started, stopped } = fakeLoops(3);
    const exploding: BackgroundLoop = {
      name: "exploding",
      loop: () => undefined,
      start: async () => {
        throw new Error("boom");
      }
    };
    await expect(
      startBackgroundLoops(contextFor(recordingBoss().boss), [loops[0]!, exploding, loops[1]!])
    ).rejects.toThrow("boom");
    expect(started).toEqual(["loop-0"]);
    expect(stopped).toEqual([]);
  });

  it("passes ONE context through — the gate loop gets the reconcile loop's exact sandbox", async () => {
    // "It shares the CEL sandbox with the reconcile loop" used to rest on two `getSharedCelSandbox()`
    // calls happening to memoise. Now it is one field on one object, and this observes that every
    // entry is handed the identical reference.
    const seen: unknown[] = [];
    const probe: BackgroundLoop[] = ["a", "b"].map((name) => ({
      name,
      loop: () => undefined,
      start: async (ctx) => {
        seen.push(ctx.sandbox);
        return { stop: async () => {} };
      }
    }));
    const sandbox = { marker: "the one sandbox" } as unknown as CelSandbox;
    await startBackgroundLoops({ ...contextFor(recordingBoss().boss), sandbox }, probe);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(sandbox);
    expect(seen[1]).toBe(sandbox);
  });
});

// -------------------------------------------------------------------------------------------
// The one remaining link that is TEXT, and what it does and does not prove
// -------------------------------------------------------------------------------------------

describe("the composition root calls the registry (SOURCE CENSUS — main.ts cannot be imported)", () => {
  const mainTs = readStripped(join(SRC_DIR, "main.ts"));

  /**
   * WHAT THIS PROVES: the characters `startBackgroundLoops(` appear in `main.ts`'s code, outside a
   * comment.
   *
   * WHAT IT DOES NOT PROVE, and this list is not decoration — every item has shipped in this repo:
   * that the enclosing branch is reachable (the MEASURED mutation: condition flipped to `false`,
   * 79/79 green, whole suite green); that the call is not in a dead branch; that the context handed
   * over is correct; that the returned handle is stopped. Only booting the real process against a
   * real database and asking it which queues exist can prove those, and that test does not exist.
   *
   * It is kept because it is the cheapest possible detector for the single most likely edit — a
   * merge or a revert that drops the line — and because everything AROUND it is now behavioural, so
   * this is the whole of the residue rather than one of twenty-three such assertions.
   */
  it("hands the loops to `startBackgroundLoops` and stops them on shutdown", () => {
    expect(mainTs).toMatch(/(?<![\w.$])startBackgroundLoops\s*\(/);
    expect(mainTs).toMatch(/backgroundLoops\.stop\(\)/);
  });

  it("imports the registry rather than shadowing it with a local of the same name", () => {
    // A local definition would satisfy the substring above while wiring something else entirely.
    expect(mainTs).toMatch(
      /import\s*\{[^}]*\bstartBackgroundLoops\b[^}]*\}\s*from\s*["']\.\/background-work\.js["']/
    );
    expect(mainTs).not.toMatch(
      /(?:const|let|var|function|class)\s+startBackgroundLoops\b|(?<![\w.$])startBackgroundLoops\s*=(?!=)/
    );
  });

  it("starts no loop of its own beside the registry — the registry is the only path", () => {
    // Discovered names, so this covers a loop that does not exist yet. `main.ts` calling a
    // `start…Loop` directly would bypass every behavioural check in this file. The runner is
    // excluded by the SAME exemption list the completeness census uses, rather than by name here —
    // two hand-maintained copies of "what is not a loop" is the drift this file exists to prevent.
    const exemptNames = new Set(
      NOT_COMPOSITION_ROOT_LOOPS.map((entry) => entry.at.split(":")[1] ?? "")
    );
    const startedDirectly = discoveredLoops
      .map((loop) => loop.name)
      .filter((name) => !exemptNames.has(name))
      .filter((name) => new RegExp(String.raw`(?<![\w.$])${name}\s*\(`).test(mainTs));
    expect(startedDirectly).toEqual([]);
  });
});
