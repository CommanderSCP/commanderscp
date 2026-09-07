import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  exportedDeclarations,
  matchingParen,
  productionSourceFiles,
  readStripped
} from "@scp/source-census";
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

/** The router registration census, and its two failure modes. See docs/events.md §6. */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAIN_TS = join(SRC_DIR, "main.ts");

// Discovery: what routers EXIST? The scanner itself. See docs/events.md §7.

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

/** This read was missed when the sibling census was converted. See docs/events.md §8. */
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

// The composition root, as text — the one link that cannot be imported

/** Balanced-paren scan, because the argument list nests calls. See docs/events.md §9. */
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
    // No conditional here: a substring cannot see a dead branch. See docs/events.md §10.
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
