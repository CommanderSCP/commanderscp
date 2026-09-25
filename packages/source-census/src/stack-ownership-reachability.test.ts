import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { trackedFiles } from "./tracked.js";
import { stripComments } from "./ts.js";

/**
 * THE INSTALLATION GATE for coordination-as-code stack ownership: its two writers (stamp, release)
 * are each wired, and nothing else writes the column. The behaviour is proved by
 * `apps/server/src/coordination-as-code/stack-release.integration.test.ts`; this is the cheap half
 * that notices a caller deleted or a second writer added. Sources are read with comments stripped
 * and with `readFileSync`, never a grep tool (BUILD_AND_TEST.md §4.4b). See docs/coordination-as-code.md §328.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");

const MUST_HAVE_A_PRODUCTION_CALLER: Record<string, string> = {
  stampObjectStackOwnership: "claims every object an apply declares",
  stampRelationshipStackOwnership: "claims every edge an apply declares",
  releaseObjectStackOwnership: "is the only way a retired stack's objects become adoptable",
  releaseRelationshipStackOwnership: "is the same for its edges",
  releaseStackOwnership: "validates, releases and audits — the verb, not a fraction of it",
  stackReleaseAuthorityChecks:
    "is the release's authority bar; with no caller a Viewer could hand any stack's rows to another"
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

const stripped = new Map<string, string>();
const read = (p: string): string => {
  let text = stripped.get(p);
  if (text === undefined) {
    text = stripComments(readFileSync(resolve(REPO_ROOT, p), "utf8"));
    stripped.set(p, text);
  }
  return text;
};

function definitionFiles(name: string): Set<string> {
  const declaration = new RegExp(`export (?:async )?function ${name}\\b`);
  return new Set(PRODUCTION_SOURCES.filter((p) => declaration.test(read(p))));
}

function callersOf(name: string): string[] {
  const defined = definitionFiles(name);
  const used = new RegExp(`\\b${name}\\s*\\(`);
  return PRODUCTION_SOURCES.filter((p) => !defined.has(p)).filter((p) => used.test(read(p)));
}

describe("stack ownership's two writers are INSTALLED, and are the only writers", () => {
  it.each(Object.entries(MUST_HAVE_A_PRODUCTION_CALLER))(
    "%s has at least one non-test caller",
    (name, why) => {
      expect(
        callersOf(name),
        `${name}() has NO production caller. It ${why}. A test calling it directly does not make it reachable.`
      ).not.toEqual([]);
    }
  );

  it("every name in the census is actually DEFINED somewhere", () => {
    for (const name of Object.keys(MUST_HAVE_A_PRODUCTION_CALLER)) {
      expect(
        [...definitionFiles(name)],
        `${name} is in the census but nothing exports it`
      ).not.toEqual([]);
    }
  });

  it("the release route checks the stack's authority BEFORE it releases anything", () => {
    const route = read("apps/server/src/routes/plans.ts");
    const checks = route.indexOf("await stackReleaseAuthorityChecks(tx, auth.orgId, stackName)");
    const release = route.indexOf("return releaseStackOwnership(tx, {");
    expect(checks, "the route no longer computes the stack's authority checks").toBeGreaterThan(-1);
    expect(release, "the route no longer calls releaseStackOwnership").toBeGreaterThan(-1);
    expect(checks).toBeLessThan(release);
  });

  it("ONE MODULE writes `managed_by_stack` on objects and relationships", () => {
    // Every UPDATE spelling of the column: drizzle's `.set({ managedByStack … })` and raw SQL.
    // (Inserts are not updates: rbac-apply stamps its OWN tables' column at row creation.)
    const writes = /\.set\(\{\s*managedByStack\b|SET\s+managed_by_stack\b/i;
    expect(PRODUCTION_SOURCES.filter((p) => writes.test(read(p))).sort()).toEqual([
      "apps/server/src/coordination-as-code/stack-ownership.ts"
    ]);
  });

  it("CONTROL — the writer pattern matches both spellings, and a commented-out write is not a writer", () => {
    const writes = /\.set\(\{\s*managedByStack\b|SET\s+managed_by_stack\b/i;
    expect(writes.test(".set({ managedByStack: null })")).toBe(true);
    expect(writes.test("UPDATE relationships AS r SET managed_by_stack = $1")).toBe(true);
    expect(writes.test(stripComments("// tx.update(objects).set({ managedByStack: x })"))).toBe(
      false
    );
  });
});
