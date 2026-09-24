import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { trackedFiles } from "./tracked.js";

/**
 * THE INSTALLATION GATE for the build lane's destination derivation (M28.1, ADR-0053).
 *
 * The sibling of `host-reaching-reachability.test.ts`, for the same property: a capability whose
 * every test calls it directly, so no test notices when nothing else does. M28.1's DoD is that an
 * `rpm` component PROMOTES to a package repo, and the behavioural proof of that is
 * `rpm-build-lane.integration.test.ts` — which needs Docker for its last leg and a reconcile loop for
 * all of it. This census is the cheap half that cannot be satisfied by accident: each producer
 * below must be reached from production code, and the reconcile call must route a refusal to the
 * terminal Decision path rather than to the catch-and-retry one.
 *
 * Read with `readFileSync`, never a grep tool: some tracked sources carry literal NUL bytes and
 * every search tool silently drops them from a recursive search (§4.4b).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");

const MUST_HAVE_A_PRODUCTION_CALLER: Record<string, string> = {
  buildLaneTriggerParameters:
    "derives what a build trigger carries — source identity AND, by the Type's destination " +
    "class, the destination; with no caller, a build lane reaches its executor with nothing",
  registryForComponent:
    "the ONE resolution of where a component publishes; the build lane and the pipeline view " +
    "must share it, or the tile and the trigger disagree about the destination"
};

const isTest = (p: string): boolean =>
  p.includes(".test.") || p.includes("/test-support/") || p.includes("/testkit/");

const PRODUCTION_SOURCES = trackedFiles(REPO_ROOT).filter(
  (p) =>
    (p.startsWith("apps/") || p.startsWith("packages/")) &&
    p.endsWith(".ts") &&
    !p.endsWith(".d.ts") &&
    !isTest(p)
);

const read = (p: string): string => readFileSync(resolve(REPO_ROOT, p), "utf8");

function definitionFiles(name: string): Set<string> {
  const declaration = new RegExp(`export (?:async )?function ${name}\\b`);
  return new Set(PRODUCTION_SOURCES.filter((p) => declaration.test(read(p))));
}

function callersOf(name: string): string[] {
  const defined = definitionFiles(name);
  const used = new RegExp(`\\b${name}\\s*\\(`);
  return PRODUCTION_SOURCES.filter((p) => !defined.has(p)).filter((p) => used.test(read(p)));
}

describe("the build lane's destination derivation is INSTALLED, not merely built", () => {
  it.each(Object.entries(MUST_HAVE_A_PRODUCTION_CALLER))(
    "%s has at least one non-test caller",
    (name, why) => {
      expect(
        callersOf(name),
        `${name}() has NO production caller. It is what ${why}. A test calling it directly does ` +
          `not make it reachable.`
      ).not.toEqual([]);
    }
  );

  it("every name in the census is actually DEFINED somewhere", () => {
    // A rename would otherwise empty the gate: `callersOf` a name nothing defines passes vacuously.
    for (const name of Object.keys(MUST_HAVE_A_PRODUCTION_CALLER)) {
      expect(
        [...definitionFiles(name)],
        `${name} is in the census but nothing exports it`
      ).not.toEqual([]);
    }
  });

  it("reconcile routes the build lane's REFUSAL to the terminal path, not the retry loop", () => {
    // `buildLaneTriggerParameters` throws `BuildDestinationRefused` for a registry that cannot hold
    // what the Type builds. Uncaught, that throw lands in the per-target catch, which logs and
    // retries every tick with no Decision — a refusal nobody can see. `asRefusal` is the one thing
    // that turns it into a value `refuseTrigger` terminalises.
    const reconcile = read("apps/server/src/coordination/reconcile.ts");
    expect(reconcile).toMatch(
      /await buildLaneTriggerParameters\(tx, \{[^}]*\}\)\.catch\(asRefusal\)/
    );
    expect(reconcile).toMatch(
      /if \(sourceParameters instanceof TriggerParameterRefusal\) \{\s*await refuseTrigger\(tx, sourceParameters\);/
    );
  });

  it("the derivation routes on the Type's destination CLASS, never on the Category alone", () => {
    // The M28.1 defect was a destination derived for the whole `build` Category. The table is
    // what replaced it; a derivation that stops reading it has reintroduced the defect.
    const derivation = read("apps/server/src/coordination/build-trigger-parameters.ts");
    expect(derivation).toContain("DESTINATION_FORMAT_OF_TYPE[type]");
    expect(derivation).toContain("assertRegistryServes(registry, type, format)");
  });
});
