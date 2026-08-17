import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
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
 * `main.ts` hands `startPgBoss` an array of {@link DomainEventRouter}s. That array has TWO failure
 * modes, and until this file the protection against both was a code comment ("Every entry below
 * appears exactly once"), which is a claim rather than a check:
 *
 *   1. REGISTERED TWICE (the rebase hazard). During M21's build a rebase put `acceptedChangeRouter()`
 *      on both sides of a conflict in that array; concatenating the sides — the naive resolution —
 *      registers it twice. The domain-events worker calls every router for every event, so the
 *      capability's queue gets two jobs per event, and `boss.work()` on that queue is a COMPETING
 *      consumer: it does not deduplicate, it runs the work twice. pg-boss reports nothing.
 *
 *   2. NEVER REGISTERED (the "built but never installed" hazard). Every router in this tree has an
 *      integration test that registers the router ITSELF, because that is the only way to drive it
 *      deterministically. Those suites stay green when `main.ts` never wires the router at all —
 *      which is this codebase's most-shipped defect class (six instances in M21 alone).
 *
 * WHY THIS IS A SOURCE CENSUS AND NOT AN IMPORT: `main.ts` calls `main()` at module scope, so
 * importing it starts a server. The registration site is a literal inside that module, and the
 * honest way to read a literal in a module you cannot import is to read the module.
 *
 * WHY IT DOES NOT ROT: nothing here names a router. The set of routers is DISCOVERED from the
 * filesystem (every exported factory whose return type is `DomainEventRouter`) and compared against
 * what the composition root registers. Add a fifth router module and this census demands it be
 * registered exactly once; the assertion has no list to forget to update.
 *
 * The two comparisons are mutual anti-vacuity guards. If the discovery regex ever stopped matching,
 * the declared set would go empty — and the "registered but not declared" half of the second test
 * fails, because the registration site still names four factories. If the argument-list extraction
 * ever broke, the registered set would go empty — and the "declared but not registered" half fails.
 * Neither can silently pass by finding nothing.
 */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAIN_TS = join(SRC_DIR, "main.ts");

// -------------------------------------------------------------------------------------------
// Discovery: what routers EXIST?
// -------------------------------------------------------------------------------------------

/** Production sources only — a `*.test.ts` file may define a fixture router, which nothing should
 *  register in the composition root. */
function productionSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      out.push(...productionSourceFiles(full));
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

/** `export function someRouter(…): DomainEventRouter {` — params allowed, so a future factory that
 *  takes a dependency is still discovered. */
const ROUTER_FACTORY =
  /export\s+function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*:\s*DomainEventRouter\b/g;

interface DiscoveredRouter {
  factory: string;
  file: string;
}

const declaredRouters: DiscoveredRouter[] = productionSourceFiles(SRC_DIR).flatMap((file) => {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(ROUTER_FACTORY)].map((m) => ({
    factory: m[1]!,
    file: relative(SRC_DIR, file)
  }));
});

// -------------------------------------------------------------------------------------------
// The registration site: what does the composition root actually pass to `startPgBoss`?
// -------------------------------------------------------------------------------------------

/**
 * The text between `startPgBoss(` and its matching `)`, by balanced-paren scan rather than a
 * non-greedy regex — the argument list contains nested calls and array literals, and a `[\s\S]*?\)`
 * would stop at the first of them the moment anyone reformats the call.
 *
 * Throws rather than returning empty if the call site cannot be found: "the composition root moved"
 * must be a loud failure, never a census that silently examines nothing.
 */
function startPgBossArgumentList(source: string): string {
  const callSites = [...source.matchAll(/(?<![\w.$])startPgBoss\s*\(/g)].filter((m) => {
    // Skip mentions inside comments — several doc comments in `main.ts` refer to `startPgBoss`.
    const lineStart = source.lastIndexOf("\n", m.index!) + 1;
    const before = source.slice(lineStart, m.index!);
    return !before.includes("//") && !/^\s*\*/.test(before);
  });
  if (callSites.length !== 1) {
    throw new Error(
      `expected exactly one startPgBoss(...) call in main.ts, found ${callSites.length}. ` +
        "The composition root moved — this census must be pointed at the new registration site, " +
        "not deleted."
    );
  }
  const open = callSites[0]!.index! + callSites[0]![0].length - 1;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")") {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error("unbalanced parentheses in main.ts's startPgBoss(...) call");
}

/** Strip `//` line comments so a factory name MENTIONED in a comment inside the argument list is
 *  not mistaken for a registration (and so a commented-out registration does not count). */
const stripLineComments = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");

const mainTs = readFileSync(MAIN_TS, "utf8");
const registrationSite = stripLineComments(startPgBossArgumentList(mainTs));

/** Every identifier CALLED inside the argument list, with repeats — this is the registered list.
 *  `config.pgBossDatabaseUrl` is a property access, not a call, so the first argument contributes
 *  nothing; the guard predicates (`bumpDispatchRoleGuard(config)`) are evaluated OUTSIDE the call. */
const registeredFactories: string[] = [
  ...registrationSite.matchAll(/(?<![\w.$])([A-Za-z_$][\w$]*)\s*\(/g)
].map((m) => m[1]!);

// -------------------------------------------------------------------------------------------

describe("domain-event router registration (composition-root census)", () => {
  it("registers no router TWICE — a second registration is two enqueues per event, silently", () => {
    const seen = new Map<string, number>();
    for (const name of registeredFactories) seen.set(name, (seen.get(name) ?? 0) + 1);
    const registeredMoreThanOnce = [...seen.entries()]
      .filter(([, count]) => count > 1)
      .map(([name, count]) => `${name} x${count}`);

    expect({
      site: "main.ts startPgBoss(...)",
      registeredMoreThanOnce
    }).toEqual({ site: "main.ts startPgBoss(...)", registeredMoreThanOnce: [] });
  });

  it("registers EVERY router that exists in the tree, and nothing that does not", () => {
    const declared = declaredRouters.map((r) => r.factory);
    const declaredButNotRegistered = declaredRouters
      .filter((r) => !registeredFactories.includes(r.factory))
      .map((r) => `${r.factory} (${r.file})`);
    // Also catches the census breaking: if discovery ever found nothing, every registered name
    // would land here rather than the suite going quietly green over an empty comparison.
    const registeredButNotDeclared = [...new Set(registeredFactories)].filter(
      (name) => !declared.includes(name)
    );

    expect({ declaredButNotRegistered, registeredButNotDeclared }).toEqual({
      declaredButNotRegistered: [],
      registeredButNotDeclared: []
    });
  });

  it("imports each registered factory rather than shadowing it with a local of the same name", () => {
    // A registration whose identifier resolves to something defined inside `main()` would satisfy
    // the two tests above while wiring something other than the discovered factory.
    const mainFn = mainTs.indexOf("async function main");
    // Not `slice(0, -1)`-by-accident: a missing marker would leave the whole file as the "import
    // section" and pass this test for free.
    expect(mainFn, "main.ts no longer declares `async function main`").toBeGreaterThan(0);
    const importSection = mainTs.slice(0, mainFn);
    const notImported = [...new Set(registeredFactories)].filter(
      (name) => !new RegExp(String.raw`(?<![\w.$])${name}(?![\w$])`).test(importSection)
    );
    expect(notImported).toEqual([]);
  });
});

describe("the routers themselves are distinguishable", () => {
  it("every router in the tree has its own name and its own destination queue", async () => {
    const routers: DomainEventRouter[] = [];
    for (const declared of declaredRouters) {
      const mod: Record<string, unknown> = await import(
        pathToFileURL(join(SRC_DIR, declared.file)).href
      );
      const factory = mod[declared.factory];
      expect(typeof factory, `${declared.factory} is not exported from ${declared.file}`).toBe(
        "function"
      );
      routers.push((factory as () => DomainEventRouter)());
    }
    // The same predicate production boots through, over the WHOLE universe of routers rather than
    // the subset a given process's role guards admit: two routers that shared a name or a queue
    // would be a latent double-registration the moment both guards allowed.
    expect(() => assertRoutersRegisteredOnce(routers)).not.toThrow();
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
