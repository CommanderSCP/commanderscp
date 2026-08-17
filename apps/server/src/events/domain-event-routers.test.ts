import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  exportedDeclarations,
  matchingParen,
  productionSourceFiles,
  readStripped
} from "../test-support/source-census.js";
import {
  DOMAIN_EVENT_ROUTERS,
  domainEventRouters,
  type RouterGuardConfig
} from "./domain-event-registry.js";
import {
  DuplicateRouterRegistrationError,
  assertRoutersRegisteredOnce,
  startPgBoss,
  type DomainEventRouter
} from "./pgboss.js";

/**
 * ================================================================================================
 * M21.7 item 4 — THE ROUTER REGISTRATION CENSUS
 * ================================================================================================
 * The composition root hands `startPgBoss` a list of {@link DomainEventRouter}s. That list has TWO
 * failure modes, and until this file the protection against both was a code comment ("Every entry
 * below appears exactly once"), which is a claim rather than a check:
 *
 *   1. REGISTERED TWICE (the rebase hazard). During M21's build a rebase put `acceptedChangeRouter()`
 *      on both sides of a conflict in that list; concatenating the sides — the naive resolution —
 *      registers it twice. The domain-events worker calls every router for every event, so the
 *      capability's queue gets two jobs per event, and `boss.work()` on that queue is a COMPETING
 *      consumer: it does not deduplicate, it runs the work twice. pg-boss reports nothing.
 *
 *   2. NEVER REGISTERED (the "built but never installed" hazard). Every router in this tree has an
 *      integration test that registers the router ITSELF, because that is the only way to drive it
 *      deterministically. Those suites stay green when the composition root never wires the router
 *      at all — which is this codebase's most-shipped defect class (six instances in M21 alone).
 *
 * WHAT THIS FILE ASSERTS AGAINST, AND WHY IT CHANGED. The first version of this census read
 * `main.ts` as TEXT, because `main.ts` calls `main()` at module scope and cannot be imported. Text
 * cannot distinguish a registration that is LIVE from one that is UNREACHABLE: invert the role
 * guard on a registration line (`allowed ? [] : [router()]`) and the factory's name is still right
 * there in the source, so every source census stays green while production registers nothing. So
 * the list itself moved out of `main.ts` into `events/domain-event-registry.ts`, a pure importable
 * value, and the assertions below EXECUTE it — `DOMAIN_EVENT_ROUTERS` compared by function
 * IDENTITY against the routers discovered in the tree, and `domainEventRouters(config)` called for
 * a matrix of deployment configs.
 *
 * THE GAP THAT REMAINS, STATED PLAINLY RATHER THAN PAPERED OVER: the last link — that `main.ts`
 * passes `domainEventRouters(config)` to `startPgBoss` — is still checked as source text, because
 * importing `main.ts` starts a server. "The composition root wires the registry" is therefore the
 * one property here proven by a substring and not by behaviour. It is a much smaller surface than
 * the old census (one call, not four conditional registrations, with nothing config-dependent left
 * in it), and two of the three ways that substring could lie while present are closed below: a
 * LOCAL SHADOW of `domainEventRouters` (checked for), and the call sitting in a DEAD BRANCH of the
 * argument list (no conditional operator is permitted in it). The third is not closed and cannot
 * be by reading text: whether the enclosing `if (runsBackgroundWork)` block executes at all. A
 * mutation that makes that branch unreachable passes this file, and — checked, not assumed — no
 * other test in this package covers it either, because nothing imports `main.ts`. That is a known,
 * uncovered edge, recorded here rather than implied away.
 *
 * WHY IT DOES NOT ROT: nothing here names a router. The set of routers is DISCOVERED from the
 * filesystem (every exported factory whose return type is `DomainEventRouter`) and compared against
 * the registry. Add a fifth router module and this census demands it be registered exactly once.
 *
 * The comparisons are mutual anti-vacuity guards: break discovery and the registry's entries have
 * nothing to match (they land in `registeredButNotDeclared`); empty the registry and every
 * discovered router lands in `declaredButNotRegistered`. Neither half can pass by finding nothing.
 */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAIN_TS = join(SRC_DIR, "main.ts");

// -------------------------------------------------------------------------------------------
// Discovery: what routers EXIST?
// -------------------------------------------------------------------------------------------
//
// The scanner itself — the production-source walk, the declaration-start regex and the
// balanced-paren parameter skip — lives in `test-support/source-census.ts`, shared with the
// dependency-loop census in `dependencies/commander-only.test.ts`. It was written here first and
// moved out the moment there were two consumers: a scanner in two copies is exactly the property
// CLAUDE.md's census rule names, and the next fix to it would have landed in one of them. Read
// that module for the declaration forms it has to survive and why.

/** The return type must be ONE router — `: DomainEventRouter` followed by a function body (`{`) or
 *  an arrow's `=>`. Anchoring on what FOLLOWS the type is what keeps `DomainEventRouter[]` (the
 *  registry's own `domainEventRouters(config)` returns a list of them) and `Promise<…>` out: those
 *  are consumers of routers, not declarations of one. */
const RETURNS_ROUTER = /^\s*:\s*DomainEventRouter\s*(?:\{|=>)/;

interface DiscoveredRouter {
  factory: string;
  file: string;
}

function routerFactoriesIn(source: string): string[] {
  return exportedDeclarations(source)
    .filter((declaration) => RETURNS_ROUTER.test(declaration.tail))
    .map((declaration) => declaration.name);
}

/**
 * `readStripped`, and this read was MISSED when the sibling loop census in
 * `dependencies/commander-only.test.ts` was converted — the same file's OTHER read (`mainCode`,
 * below) was converted at the time and this one, three functions up, was not. Fixing one call site
 * of a concept is this codebase's named recurring bug; a census that only half strips is an
 * instance of it.
 *
 * Measured 2026-08-17, on raw text: an `export function bumpRetryRouter(): DomainEventRouter { … }`
 * written inside a `/* … *\/` block in `dependencies/bump-gate.ts` — a shape reference in a module
 * doc, which is ordinary style in this tree — was DISCOVERED as a real router, imported, found
 * absent from the module, and reported as
 * `declaredButNotRegistered: ["bumpRetryRouter (dependencies/bump-gate.ts)"]`. A false RED, and an
 * unfixable-looking one: it names a router that does not exist and no registry entry can satisfy
 * it. Stripping is what makes this a census of the CODE.
 */
const declaredRouters: DiscoveredRouter[] = productionSourceFiles(SRC_DIR).flatMap((file) =>
  routerFactoriesIn(readStripped(file)).map((factory) => ({
    factory,
    file: relative(SRC_DIR, file)
  }))
);

/** Each discovered factory, IMPORTED — so the census below compares the actual function object the
 *  registry holds against the actual function the module exports. A name string would be satisfied
 *  by a local shadow; a function reference is not. */
const discovered = await Promise.all(
  declaredRouters.map(async (declared) => {
    const mod: Record<string, unknown> = await import(
      pathToFileURL(join(SRC_DIR, declared.file)).href
    );
    return { ...declared, exported: mod[declared.factory] };
  })
);

// -------------------------------------------------------------------------------------------
// The composition root, as text — the one link that cannot be imported
// -------------------------------------------------------------------------------------------

/**
 * The text between `startPgBoss(` and its matching `)`, by balanced-paren scan rather than a
 * non-greedy regex — the argument list contains nested calls, and a `[\s\S]*?\)` would stop at the
 * first of them the moment anyone reformats the call.
 *
 * Throws rather than returning empty if the call site cannot be found: "the composition root moved"
 * must be a loud failure, never a census that silently examines nothing.
 */
function startPgBossArgumentList(code: string): string {
  const callSites = [...code.matchAll(/(?<![\w.$])startPgBoss\s*\(/g)];
  if (callSites.length !== 1) {
    throw new Error(
      `expected exactly one startPgBoss(...) call in main.ts, found ${callSites.length}. ` +
        "The composition root moved — this census must be pointed at the new registration site, " +
        "not deleted."
    );
  }
  const open = callSites[0]!.index + callSites[0]![0].length - 1;
  const close = matchingParen(code, open);
  if (close === -1) throw new Error("unbalanced parentheses in main.ts's startPgBoss(...) call");
  return code.slice(open + 1, close);
}

const mainCode = readStripped(MAIN_TS);

// -------------------------------------------------------------------------------------------

describe("the registry holds every router in the tree, exactly once (runtime identity census)", () => {
  it("registers each discovered router once — not zero times, not twice, and not a lookalike", () => {
    const registeredFactories = DOMAIN_EVENT_ROUTERS.map((entry) => entry.factory);
    const countOf = (fn: unknown): number =>
      registeredFactories.filter((candidate) => candidate === fn).length;

    const declaredButNotRegistered = discovered
      .filter((router) => countOf(router.exported) === 0)
      .map((router) => `${router.factory} (${router.file})`);
    const registeredMoreThanOnce = discovered
      .filter((router) => countOf(router.exported) > 1)
      .map((router) => `${router.factory} x${countOf(router.exported)}`);
    // Anti-vacuity, and the shadow check in one: an entry whose function is not the one the module
    // exports lands here — same name, different object — so a local `function acceptedChangeRouter()`
    // in the registry fails even with the real import still present.
    const registeredButNotDeclared = registeredFactories
      .filter((fn) => !discovered.some((router) => router.exported === fn))
      .map(
        (fn) =>
          `${fn.name || "<anonymous>"} (not the function the tree exports under that name — a ` +
          `shadow, a wrapper, or discovery has stopped finding it)`
      );

    expect({
      declaredButNotRegistered,
      registeredMoreThanOnce,
      registeredButNotDeclared
    }).toEqual({
      declaredButNotRegistered: [],
      registeredMoreThanOnce: [],
      registeredButNotDeclared: []
    });
  });

  it("gives every router its own name and its own destination queue", () => {
    // The same predicate production boots through, over the WHOLE registry rather than the subset a
    // given process's role guards admit: two routers sharing a name or a queue would be a latent
    // double-registration the moment both guards allowed.
    const routers = DOMAIN_EVENT_ROUTERS.map((entry) => entry.factory());
    expect(() => assertRoutersRegisteredOnce(routers)).not.toThrow();
  });
});

describe("what a process actually registers is decided by each router's own guard", () => {
  /** Every deployment shape the guards can see. Not a sample — the full product of the three axes
   *  `RouterGuardConfig` exposes. */
  const CONFIG_MATRIX: RouterGuardConfig[] = (["all", "api", "worker"] as const).flatMap((role) =>
    (["commander", "outpost", "retrans"] as const).flatMap((federationRole) =>
      [true, false].map((federationRoleDeclared) => ({
        role,
        federationRole,
        federationRoleDeclared
      }))
    )
  );

  it("registers exactly the entries whose OWN guard allows, on every config", () => {
    const mismatches = CONFIG_MATRIX.flatMap((config) => {
      const actual = domainEventRouters(config).map((router) => router.name);
      // The oracle is each entry's own guard, evaluated here independently of the registry's
      // filter — so a filter that ignores the guard, inverts it, or applies ONE entry's guard to
      // every entry produces a set this disagrees with.
      const expected = DOMAIN_EVENT_ROUTERS.filter((entry) => entry.guard(config).allowed).map(
        (entry) => entry.factory().name
      );
      return JSON.stringify(actual) === JSON.stringify(expected)
        ? []
        : [
            `${JSON.stringify(config)}: registered ${JSON.stringify(actual)}, guards allow ${JSON.stringify(expected)}`
          ];
    });
    expect(mismatches).toEqual([]);
  });

  it("registers NOTHING on an api-only process, whatever else that process is", () => {
    // Config-INDEPENDENT of the guards themselves, which is the point: it is not derived from the
    // registry, so it survives the filter being deleted, inverted, or stubbed `true`. A router
    // exists to enqueue onto a capability queue that a background worker drains; an api process
    // drains nothing, so a router registered there fills a queue with work nobody will do.
    const registeredOnApi = CONFIG_MATRIX.filter((config) => config.role === "api").flatMap(
      (config) =>
        domainEventRouters(config).map((router) => `${router.name} @ ${config.federationRole}`)
    );
    expect(registeredOnApi).toEqual([]);
  });

  it("leaves no router permanently inert — each one is reachable on some deployment", () => {
    // "Registered but its guard refuses everywhere" is the deepest form of built-and-never-installed:
    // the wiring is present, the census above is green, and the capability never runs anywhere.
    const neverAllowed = DOMAIN_EVENT_ROUTERS.filter(
      (entry) => !CONFIG_MATRIX.some((config) => entry.guard(config).allowed)
    ).map((entry) => entry.factory().name);
    expect(neverAllowed).toEqual([]);
  });
});

describe("the composition root wires the registry (source census — the one link that cannot be imported)", () => {
  it("hands `domainEventRouters(config)` to startPgBoss, UNCONDITIONALLY, and builds no router of its own", () => {
    const argumentList = startPgBossArgumentList(mainCode);
    expect(argumentList).toMatch(/(?<![\w.$])domainEventRouters\s*\(/);
    // No conditional operator anywhere in the argument list, because a substring cannot tell a live
    // call from one parked in a dead branch (`cond ? domainEventRouters(config) : []`). The routers
    // argument is not a decision this file gets to make — the guards decide, inside the registry,
    // where the decision is observable. A legitimate need for a ternary here fails loudly, which is
    // the right way for that conversation to start.
    expect(argumentList).not.toMatch(/\?|&&|\|\|/);
    // …and main.ts does not ALSO register one directly, which would bypass everything above.
    // Discovered names, so this covers a router that does not exist yet.
    const builtInMain = declaredRouters
      .map((router) => router.factory)
      .filter((name) => new RegExp(String.raw`(?<![\w.$])${name}\s*\(`).test(mainCode));
    expect(builtInMain).toEqual([]);
  });

  it("imports `domainEventRouters` rather than shadowing it with a local of the same name", () => {
    // A local definition would satisfy the substring above while wiring something else entirely —
    // and it does not have to REPLACE the import to do that, which is why this looks for the
    // declaration rather than for the import's absence.
    expect(mainCode).toMatch(
      /import\s*\{[^}]*\bdomainEventRouters\b[^}]*\}\s*from\s*["']\.\/events\/domain-event-registry\.js["']/
    );
    expect(mainCode).not.toMatch(
      /(?:const|let|var|function|class)\s+domainEventRouters\b|(?<![\w.$])domainEventRouters\s*=(?!=)/
    );
  });
});

describe("startPgBoss refuses a double registration before it opens a connection", () => {
  const router = (name: string, queue: string): DomainEventRouter => ({
    name,
    queue,
    async route() {}
  });
  // Port 1 is not listenable: if the guard below were ever removed, this call would attempt a real
  // connection and fail with a connection error instead — which is exactly how the mutation proof
  // for this test reads RED.
  const unreachable = "postgres://scp:scp@127.0.0.1:1/postgres";

  it("rejects the SAME router registered twice, naming the duplicate", async () => {
    const twice = [router("dependency-bump", "q-bump"), router("dependency-bump", "q-bump")];
    const err = await startPgBoss(unreachable, twice).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(DuplicateRouterRegistrationError);
    expect((err as DuplicateRouterRegistrationError).duplicateNames).toEqual(["dependency-bump"]);
  });

  it("rejects two DIFFERENT routers claiming one queue, naming the queue and both claimants", async () => {
    const collide = [router("alpha", "shared-queue"), router("beta", "shared-queue")];
    const err = await startPgBoss(unreachable, collide).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(DuplicateRouterRegistrationError);
    expect((err as DuplicateRouterRegistrationError).sharedQueues).toEqual([
      ["shared-queue", ["alpha", "beta"]]
    ]);
  });

  it("lets a well-formed list through the guard (it is the connection that fails, not the check)", async () => {
    const fine = [router("alpha", "q-alpha"), router("beta", "q-beta")];
    const err = await startPgBoss(unreachable, fine).then(
      () => undefined,
      (e: unknown) => e
    );
    // Proves the guard is a duplicate check and not a blanket refusal: this list gets past it and
    // dies on the unreachable database instead.
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(DuplicateRouterRegistrationError);
  });
});
