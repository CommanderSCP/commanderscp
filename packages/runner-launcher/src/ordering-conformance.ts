import { afterEach, describe, expect, it } from "vitest";
import type { RunnerCopyIn, RunnerCopyOut, RunnerLauncher, RunnerSpec } from "./index.js";

/**
 * ================================================================================================
 * THE AWAIT-ORDERING CONFORMANCE SUITE — ADAPTER-NEUTRAL, AND REUSED BY EVERY ADAPTER
 * ================================================================================================
 *
 * WHY THIS EXISTS AS ITS OWN FILE. `docker-adapter.test.ts` proves WHAT the adapter puts on the
 * command line. It cannot prove WHEN, and for a while nobody noticed: its recording seam invoked
 * every `execFile` callback SYNCHRONOUSLY, so each step resolved before the next line of the
 * adapter ran and the recorded array was ISSUE order — which is identical whether a step was
 * awaited or fired and forgotten. Twenty tests, twenty mutations "caught", and these two both
 * SURVIVED:
 *
 *     await pending.catch(() => undefined);              ->   void pending.catch(() => undefined);
 *     await execFileAsync(docker, ["rm", "-f", id], …)   ->   void execFileAsync(…)
 *
 * managed-iac's copy-out arm is `when: "always", onFailure: "swallow"`. Drop the first await and
 * the `finally { docker rm -f }` fires while `docker cp <id>:/workspace/. <workspaceDir>` is still
 * streaming: the container dies mid-copy, `plan.json` lands truncated or absent, `run()` still
 * returns `{ succeeded: true }`, and the plugin caches a succeeded apply with no evidence — with the
 * whole build green.
 *
 * WHY IT IS PARAMETERISED RATHER THAN TWO MORE DOCKER TESTS. M23.2 adds a Kubernetes-Job adapter and
 * will be written against `docker-adapter.test.ts` as its conformance contract. Ordering is not a
 * Docker property — a Job adapter that deletes the Job while the evidence copy is still streaming
 * loses exactly the same plan.json — so these checks are expressed over the PORT's five lifecycle
 * steps, and an adapter supplies a {@link LaunchOrderingSubstrate} that can hold one step open. The
 * Kubernetes adapter inherits every case below by writing a substrate, not by re-deriving the race.
 *
 * WHAT A SUBSTRATE MUST DO, AND THE ONE THING THAT MAKES IT HONEST: a held step must be ISSUED and
 * must NOT SETTLE. A substrate that delayed the ISSUE instead of the settle would make every held
 * case below pass vacuously — which is why the first case is the UNHELD CONTROL: with nothing held
 * the full sequence must appear, in order, and `run()` must resolve with the runner's own output.
 *
 * THE SECOND DESCRIBE IS ABOUT IDENTITY, NOT ORDER, and it is here for the same inheritance reason.
 * Every case above — and every case in `docker-adapter.test.ts` — has exactly ONE `run()` in flight,
 * so one run's steps are the only steps there are and nothing can catch a per-run value kept
 * somewhere shared. Hoisting `const containerId` (index.ts:200) to module scope typechecks clean and
 * passed all thirty tests of the M23.1 suite; with two runs in flight it makes one run's `rm -f`
 * destroy the OTHER run's container, orphaning the first with its resolved credentials still in its
 * environment and tearing the second down twice. That is not a Docker property either: a Job adapter
 * that kept the Job name in a module binding loses exactly the same way, so the case is expressed
 * over identities and inherited by writing a substrate.
 */

/** The port's lifecycle steps, named independently of how any adapter performs them. */
export type RunnerStepKind = "create" | "copy-in" | "start" | "copy-out" | "teardown";

/**
 * One adapter's testable substrate: it reports which steps have been ISSUED, and it can hold the
 * next occurrence of a step open (issued, not settled) until released.
 */
export interface LaunchOrderingSubstrate {
  /** The adapter under test, wired to this substrate. */
  readonly launcher: RunnerLauncher;
  /**
   * A spec this adapter accepts. The suite overrides `copyIn`/`copyOut` and nothing else, so the
   * image, operands, network, timeouts and buffers stay the adapter's own business.
   */
  baseSpec(): RunnerSpec;
  /** The steps ISSUED so far, in issue order. */
  issued(): RunnerStepKind[];
  /**
   * THE PER-RUN IDENTITY each issued step ADDRESSED, aligned one-for-one with {@link issued} — the
   * Docker container id, a Kubernetes Job name, whatever this adapter's runs are named by. For a
   * `create`, the identity that call PRODUCES (Docker reads it out of the call's stdout; an adapter
   * that generates the name up front already has it on the argv).
   *
   * REQUIRED, not optional, and the concurrency case THROWS rather than skips when a substrate
   * reports `undefined`: an adapter author who could opt out would opt out, and the case would then
   * pass vacuously for exactly the adapter that had not thought about two runs at once.
   */
  issuedIdentities(): (string | undefined)[];
  /** Hold the next `count` occurrences of `kind`: issued, but not settled until released. */
  hold(kind: RunnerStepKind, count?: number): void;
  /**
   * Settle the OLDEST still-held occurrence of `kind` — successfully, or with `failure`.
   *
   * CORRECTED CLAIM (this used to take a third `nth` argument selecting AMONG held occurrences, on
   * the theory that releasing out of order was what the concurrency case below needed — measured
   * false. Every identity this suite checks is allocated at ISSUE time, not at settle time: the
   * Docker substrate's `stepIdentity` reads the id off `createdIds`, populated the instant `create`
   * is issued (see docker-adapter.test.ts, "ALLOCATED AT ISSUE TIME, not at delivery"), so no order
   * of *releasing* two held creates can move which identity either run ends up with. Measured
   * directly: forcing every release to the oldest-held occurrence (removing `nth` entirely) still
   * catches the containerId-hoist mutation the concurrency case exists for, at the same one case.
   * The mechanism was never load-bearing; removed rather than kept as an unexercised obligation a
   * future adapter's `release` would have had to implement with nothing checking it did.
   */
  release(kind: RunnerStepKind, failure?: Error): void;
  /**
   * Optional: flush whatever this substrate's deliveries ride on, ONE round. The default drains
   * three macrotask turns; the suite calls it repeatedly until no further step is issued, so an
   * adapter whose steps each cost several turns needs no override. An adapter that delivers on a
   * real timer does.
   */
  settleRound?(): Promise<void>;
}

/** One drain round: three macrotask turns, which also drains the microtask queue between them. */
async function defaultSettleRound(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** A promise whose settlement can be OBSERVED without awaiting it — the whole point of the teardown case. */
interface Tracked<T> {
  settled(): boolean;
  promise: Promise<T>;
}

function track<T>(promise: Promise<T>): Tracked<T> {
  let settled = false;
  const observed = promise.then(
    (value) => {
      settled = true;
      return value;
    },
    (err: unknown) => {
      settled = true;
      throw err;
    }
  );
  // The rejection arms assert on `observed`; this keeps Node from calling it unhandled in the
  // window between the rejection and the assertion.
  observed.catch(() => undefined);
  return { settled: () => settled, promise: observed };
}

const COPY_IN_A: RunnerCopyIn = { hostDir: "/host/in-a", containerPath: "/work/in-a" };
const COPY_IN_B: RunnerCopyIn = { hostDir: "/host/in-b", containerPath: "/work/in-b" };
const OUT_SWALLOW: RunnerCopyOut = {
  containerPath: "/work/out",
  hostDir: "/host/out",
  when: "always",
  onFailure: "swallow"
};
const OUT_PROPAGATE: RunnerCopyOut = {
  containerPath: "/work/out",
  hostDir: "/host/out",
  when: "on-success",
  onFailure: "propagate"
};

const FULL_SEQUENCE: RunnerStepKind[] = [
  "create",
  "copy-in",
  "copy-in",
  "start",
  "copy-out",
  "teardown"
];

/**
 * ONE CASE'S BOOKKEEPING. It exists for a reason found the hard way: the first draft let a FAILED
 * case leave a run in flight with a step still held, and when the next case reset the recorder that
 * abandoned run resumed and interleaved its steps into the next case's recording — turning one real
 * failure into four bogus ones with unreadable diffs. {@link Case.cleanup} releases whatever is
 * still held and awaits the run, so a failing case fails alone.
 */
interface Case {
  hold(kind: RunnerStepKind, count?: number): void;
  release(kind: RunnerStepKind, failure?: Error): void;
  run(copyOut: RunnerCopyOut | undefined, copyIn?: RunnerCopyIn[]): Tracked<{ succeeded: boolean }>;
  issued(): RunnerStepKind[];
  /** The identity each issued step addressed, aligned with {@link Case.issued}. */
  identities(): (string | undefined)[];
  /** Drain until the adapter cannot issue anything further — it is blocked on a held step. */
  quiesce(): Promise<void>;
  cleanup(): Promise<void>;
}

function newCase(substrate: LaunchOrderingSubstrate): Case {
  /** How many holds of each kind are still outstanding, so cleanup can free a failed case's run. */
  const outstanding = new Map<RunnerStepKind, number>();
  const runs: Promise<unknown>[] = [];

  async function quiesce(): Promise<void> {
    // ADAPTIVE, not a fixed number of turns: each step costs the substrate at least one turn, so a
    // constant drain silently under-waits as soon as a case has more steps before its held one —
    // which is exactly the bug that produced the interleaving described above. Loop until a whole
    // round passes with nothing new issued; a held step guarantees that converges.
    let previous = -1;
    for (let round = 0; round < 50 && substrate.issued().length !== previous; round++) {
      previous = substrate.issued().length;
      await (substrate.settleRound ? substrate.settleRound() : defaultSettleRound());
    }
  }

  return {
    hold(kind, count = 1) {
      outstanding.set(kind, (outstanding.get(kind) ?? 0) + count);
      substrate.hold(kind, count);
    },
    release(kind, failure) {
      outstanding.set(kind, Math.max(0, (outstanding.get(kind) ?? 0) - 1));
      substrate.release(kind, failure);
    },
    run(copyOut, copyIn = [COPY_IN_A, COPY_IN_B]) {
      const tracked = track(substrate.launcher.run({ ...substrate.baseSpec(), copyIn, copyOut }));
      runs.push(tracked.promise);
      return tracked;
    },
    issued: () => substrate.issued(),
    identities: () => substrate.issuedIdentities(),
    quiesce,
    async cleanup() {
      for (const [kind, count] of outstanding) {
        for (let i = 0; i < count; i++) {
          try {
            substrate.release(kind);
          } catch {
            // Never issued (the case failed before reaching it) — nothing to free.
          }
        }
      }
      outstanding.clear();
      await quiesce();
      await Promise.allSettled(runs);
    }
  };
}

/**
 * Case bookkeeping for one `describe`: hands back an `open()` and registers the cleanup that keeps a
 * failed case from leaking its half-finished run into the next one. Called inside a `describe` body.
 */
function useCases(createSubstrate: () => LaunchOrderingSubstrate): () => Case {
  let current: Case | undefined;

  afterEach(async () => {
    const c = current;
    current = undefined;
    if (c) await c.cleanup();
  });

  return () => {
    current = newCase(createSubstrate());
    return current;
  };
}

/**
 * Runs the await-ordering cases against one adapter.
 *
 * `createSubstrate` is called ONCE PER CASE and must return a substrate carrying no state from the
 * previous one.
 */
export function runLaunchOrderingConformanceSuite(
  label: string,
  createSubstrate: () => LaunchOrderingSubstrate
): void {
  describe(`${label}: every step is AWAITED before the next one is issued`, () => {
    const open = useCases(createSubstrate);

    it("THE UNHELD CONTROL — with nothing held, every step is issued in order and run() resolves", async () => {
      // Non-vacuity for every case below: it proves the substrate ISSUES what the adapter asks for,
      // so that a missing later step in a held case can only be the hold. A substrate that delayed
      // the ISSUE rather than the SETTLE would pass all the held cases and fail this one.
      const c = open();
      const result = await c.run(OUT_SWALLOW).promise;
      expect(c.issued()).toStrictEqual(FULL_SEQUENCE);
      expect(result.succeeded).toBe(true);
    });

    it("`create` IS AWAITED — while it is open, NOTHING else is issued and run() has not resolved", async () => {
      const c = open();
      c.hold("create");
      const run = c.run(OUT_SWALLOW);

      await c.quiesce();
      expect(c.issued(), "a step was issued before the container existed").toStrictEqual([
        "create"
      ]);
      expect(run.settled()).toBe(false);

      c.release("create");
      await run.promise;
      expect(c.issued()).toStrictEqual(FULL_SEQUENCE);
    });

    it("THE COPY-INS ARE SEQUENTIAL — the second is not issued until the first has settled", async () => {
      // The `for … of` loop's `await`. Fired-and-forgotten copies would race each other into the
      // same container and, worse, race `start`.
      const c = open();
      c.hold("copy-in", 2);
      const run = c.run(OUT_SWALLOW);

      await c.quiesce();
      expect(c.issued(), "the copy-ins were issued in parallel").toStrictEqual([
        "create",
        "copy-in"
      ]);

      c.release("copy-in");
      await c.quiesce();
      // The second copy-in is now open, and `start` must still be waiting on it.
      expect(c.issued(), "`start` was issued while a copy-in was still streaming").toStrictEqual([
        "create",
        "copy-in",
        "copy-in"
      ]);
      expect(run.settled()).toBe(false);

      c.release("copy-in");
      await run.promise;
      expect(c.issued()).toStrictEqual(FULL_SEQUENCE);
    });

    it("`start` IS AWAITED — the copy-OUT is not issued while the runner is still running", async () => {
      const c = open();
      c.hold("start");
      const run = c.run(OUT_SWALLOW);

      await c.quiesce();
      expect(
        c.issued(),
        "evidence was copied out of a container that was still running"
      ).toStrictEqual(["create", "copy-in", "copy-in", "start"]);
      expect(run.settled()).toBe(false);

      c.release("start");
      await run.promise;
      expect(c.issued()).toStrictEqual(FULL_SEQUENCE);
    });

    it("THE SWALLOWED COPY-OUT IS AWAITED — teardown does NOT begin while evidence is still streaming", async () => {
      // THE RACE THIS FILE EXISTS FOR (managed-iac: `when: "always"`, `onFailure: "swallow"`).
      // `void pending.catch(() => undefined)` lets the `finally` destroy the container mid-copy:
      // plan.json lands truncated or absent, `run()` still reports succeeded, and the plugin caches
      // a succeeded apply with no evidence.
      const c = open();
      c.hold("copy-out");
      const run = c.run(OUT_SWALLOW);

      await c.quiesce();
      expect(
        c.issued(),
        "teardown was issued while the evidence copy-out was still streaming — the container is destroyed mid-copy and the evidence is silently truncated"
      ).toStrictEqual(["create", "copy-in", "copy-in", "start", "copy-out"]);
      expect(run.settled()).toBe(false);

      c.release("copy-out");
      const result = await run.promise;
      expect(c.issued()).toStrictEqual(FULL_SEQUENCE);
      expect(result.succeeded).toBe(true);
    });

    it("A FAILING SWALLOWED COPY-OUT IS STILL AWAITED — the failure is absorbed only AFTER it happens", async () => {
      // `.catch(() => undefined)` on a promise nobody awaits swallows nothing in time: the teardown
      // would already have run. Releasing the held step as a FAILURE separates "the failure is
      // swallowed" from "the failure is not waited for".
      const c = open();
      c.hold("copy-out");
      const run = c.run(OUT_SWALLOW);

      await c.quiesce();
      expect(c.issued()).toStrictEqual(["create", "copy-in", "copy-in", "start", "copy-out"]);

      c.release("copy-out", new Error("copy-out: no such file or directory"));
      const result = await run.promise;
      expect(result.succeeded).toBe(true);
      expect(c.issued()).toStrictEqual(FULL_SEQUENCE);
    });

    it("THE PROPAGATING COPY-OUT IS AWAITED — teardown waits for it, and its failure escapes run()", async () => {
      // managed-scan's and managed-dep's arm. Same race, different landing: un-awaited, the
      // rejection would surface as an unhandled rejection instead of out of `run()`.
      const c = open();
      c.hold("copy-out");
      const run = c.run(OUT_PROPAGATE);

      await c.quiesce();
      expect(c.issued()).toStrictEqual(["create", "copy-in", "copy-in", "start", "copy-out"]);
      expect(run.settled()).toBe(false);

      c.release("copy-out", new Error("copy-out: no such file or directory"));
      await expect(run.promise).rejects.toThrow(/no such file or directory/);
      expect(c.issued()).toStrictEqual(FULL_SEQUENCE);
    });

    it("TEARDOWN IS AWAITED — run() does not resolve until the container is gone", async () => {
      // `void execFileAsync(docker, ["rm","-f",id], …)` in the `finally`. The caller would be told
      // the run is over while a container carrying its resolved credentials is still alive, and the
      // plugin's own cleanup of the workspace would race the daemon.
      const c = open();
      c.hold("teardown");
      const run = c.run(OUT_SWALLOW);

      await c.quiesce();
      expect(c.issued()).toStrictEqual(FULL_SEQUENCE);
      expect(
        run.settled(),
        "run() resolved before the container was destroyed — the credential-carrying container outlives the call"
      ).toBe(false);

      c.release("teardown");
      const result = await run.promise;
      expect(result.succeeded).toBe(true);
    });

    it("A FAILING TEARDOWN IS AWAITED AND SWALLOWED — run() still resolves, but only afterwards", async () => {
      const c = open();
      c.hold("teardown");
      const run = c.run(OUT_SWALLOW);

      await c.quiesce();
      expect(run.settled()).toBe(false);

      c.release("teardown", new Error("teardown: no such container"));
      const result = await run.promise;
      expect(result.succeeded).toBe(true);
    });

    it("WITH NO COPY-OUT, TEARDOWN STILL WAITS ON `start` — the empty-spec path is awaited too", async () => {
      // The minimal shape (every spec with `copyOut: undefined`). Without it, an adapter could await
      // only inside the copy-out branch and still pass everything above.
      const c = open();
      c.hold("start");
      const run = c.run(undefined, []);

      await c.quiesce();
      expect(c.issued()).toStrictEqual(["create", "start"]);
      expect(run.settled()).toBe(false);

      c.release("start");
      await run.promise;
      expect(c.issued()).toStrictEqual(["create", "start", "teardown"]);
    });
  });

  describe(`${label}: two runs in flight never address each other's container`, () => {
    const open = useCases(createSubstrate);

    it("TWO RUNS AT ONCE — every step of each run addresses ITS OWN identity", async () => {
      // WHAT THIS CATCHES, EXACTLY. Hoisting `containerId` out of the `run()` body to module scope
      // typechecks clean and passes every other test in this package, because no other test has two
      // `run()` calls in flight — one run's steps are always the only ones there are. Under that
      // mutation the second run's later steps address the FIRST run's container and both teardowns
      // `rm -f` the same id: one container is orphaned still holding whatever the run gave it, and
      // the other is destroyed twice, the second time out from under a live run.
      //
      // PER-RUN IDENTITY IS NOW TWO THINGS, NOT ONE, and both are covered by the same partition: the
      // container id `create` returns, and the `--name` the CALLER chose (`RunnerSpec.runId`), which
      // is what teardown addresses. A substrate reports them under one identity — see the Docker
      // substrate's `stepIdentity` — so a teardown aimed at the OTHER run's name fails here exactly
      // as a copy aimed at the other run's id does. That is why the substrate must hand out a
      // distinct `runId` per run: two runs sharing one name is the same bug wearing new clothes,
      // and with managed-iac deriving `runId` from `intent.idempotencyKey` it is reachable in
      // production by two concurrent triggers of one key.
      //
      // It is not a live bug today — `index.ts` holds no module-level mutable state — and that is
      // the reason to pin it rather than to skip it: the three managed plugins are three pg-boss
      // `work()` handlers in ONE Node process, so two `run()` calls across plugins overlap as a
      // matter of course, and this suite's own framing (a substrate that holds a step OPEN) is an
      // invitation to park per-run state where it is convenient.
      const c = open();
      c.hold("create", 2);
      // The first copy-in of EACH run. Held so both runs are genuinely interleaved through the
      // copy-in step too, not just at `create`.
      c.hold("copy-in", 2);

      const first = c.run(OUT_SWALLOW);
      const second = c.run(OUT_SWALLOW);

      await c.quiesce();
      // THE NON-VACUITY CHECK for everything below: both runs really are in flight at once. If the
      // harness serialised them, only one `create` would be here and the rest would prove nothing.
      expect(
        c.issued(),
        "the two runs did not overlap — the case cannot see a shared identity if only one run exists at a time"
      ).toStrictEqual(["create", "create"]);

      // `release` always takes the oldest held occurrence of `kind` — see `LaunchOrderingSubstrate`'s
      // own doc for why an out-of-order release would add nothing here: every identity this suite
      // checks is fixed at ISSUE time, not at settle time, so no release order can move it.
      c.release("create");
      await c.quiesce();
      c.release("create");
      await c.quiesce();
      expect(c.issued()).toStrictEqual(["create", "create", "copy-in", "copy-in"]);

      c.release("copy-in");
      await c.quiesce();
      c.release("copy-in");

      await Promise.all([first.promise, second.promise]);

      // THE ASSERTION IS SYMMETRIC — it never asks which run is which, only that the steps partition
      // into two complete lifecycles. That holds for any adapter and needs no run attribution.
      const partitions = partitionByIdentity(c.issued(), c.identities());
      expect(
        [...partitions.keys()],
        "the two runs shared one identity: one run's container is orphaned with its credentials, and the other is torn down twice"
      ).toHaveLength(2);
      for (const [identity, steps] of partitions) {
        expect(
          steps,
          `the run on '${identity}' did not see its own complete lifecycle — a step of one run addressed the other run's container`
        ).toStrictEqual(FULL_SEQUENCE);
      }
    });
  });
}

/**
 * Groups the issued steps by the identity they addressed, preserving issue order within each group.
 * Throws rather than returning something weaker when a substrate reports no identity: an all-
 * `undefined` substrate would collapse both runs into one group and the case would pass for the
 * wrong reason, which is the exact failure mode it exists to catch.
 */
function partitionByIdentity(
  steps: RunnerStepKind[],
  identities: (string | undefined)[]
): Map<string, RunnerStepKind[]> {
  if (identities.length !== steps.length) {
    throw new Error(
      `substrate: issuedIdentities() returned ${identities.length} entries for ${steps.length} issued steps; they must align one-for-one`
    );
  }
  const partitions = new Map<string, RunnerStepKind[]>();
  steps.forEach((step, index) => {
    const identity = identities[index];
    if (identity === undefined) {
      throw new Error(
        `substrate: issuedIdentities() reported no identity for the '${step}' step at index ${index}. Every step must report the run it addressed, and a 'create' must report the identity it PRODUCES — without that this case cannot tell two runs apart and would pass vacuously.`
      );
    }
    const group = partitions.get(identity) ?? [];
    group.push(step);
    partitions.set(identity, group);
  });
  return partitions;
}
