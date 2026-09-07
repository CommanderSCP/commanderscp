import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** THE PLAYWRIGHT SUITE'S IMPORT GRAPH MUST NOT REACH `vitest`. See docs/web.md §21. */
const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: dirname(new URL(import.meta.url).pathname),
  encoding: "utf8"
}).trim();

/** `@scp/<name>` → the workspace directory that holds its `src`, read from the real package.json. */
function workspacePackages(): Map<string, string> {
  const dirs = execFileSync("git", ["ls-files", "-z", "*/package.json", "*/*/package.json"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  })
    .split("\0")
    .filter(Boolean);
  const map = new Map<string, string>();
  for (const file of dirs) {
    const pkg = JSON.parse(readFileSync(join(repoRoot, file), "utf8")) as { name?: string };
    if (pkg.name?.startsWith("@scp/")) map.set(pkg.name, dirname(join(repoRoot, file)));
  }
  return map;
}

const packages = workspacePackages();

/** Every `import`/`export ... from "x"` and `await import("x")` specifier in a source file. */
function specifiersOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const m of text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

/** Resolves a specifier to a first-party source file, or not. See docs/web.md §22. */
function resolveFirstParty(spec: string, fromFile: string): string | undefined {
  const tryExts = (base: string): string | undefined => {
    for (const cand of [
      base.replace(/\.js$/, ".ts"),
      base.replace(/\.js$/, ".tsx"),
      `${base}.ts`,
      `${base}.tsx`,
      join(base, "index.ts"),
      join(base, "index.tsx")
    ]) {
      if (existsSync(cand)) return cand;
    }
    return undefined;
  };
  if (spec.startsWith(".")) return tryExts(resolve(dirname(fromFile), spec));
  if (!spec.startsWith("@scp/")) return undefined;
  const [, name, ...rest] = spec.split("/");
  const dir = packages.get(`@scp/${name}`);
  if (!dir) return undefined;
  const sub = rest.join("/").replace(/^dist\//, "");
  return tryExts(join(dir, "src", sub || "index"));
}

const VITEST = (spec: string): boolean => spec === "vitest" || spec.startsWith("vitest/");

/** Walks the graph from `entry`, returning the first chain that reaches `vitest`, or `undefined`. */
function chainToVitest(entry: string): string[] | undefined {
  const seen = new Set<string>();
  const queue: { file: string; chain: string[] }[] = [{ file: entry, chain: [entry] }];
  while (queue.length > 0) {
    const { file, chain } = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of specifiersOf(file)) {
      if (VITEST(spec)) return [...chain, spec];
      const next = resolveFirstParty(spec, file);
      if (next && !seen.has(next)) queue.push({ file: next, chain: [...chain, next] });
    }
  }
  return undefined;
}

/** The Playwright entry points. See docs/web.md §23. */
const entries = execFileSync("git", ["ls-files", "-z", "apps/web/e2e"], {
  cwd: repoRoot,
  encoding: "utf8"
})
  .split("\0")
  .filter((p) => p.endsWith(".spec.ts") || p.endsWith("global-setup.ts"))
  .map((p) => join(repoRoot, p));

describe("apps/web Playwright suite is vitest-free", () => {
  it("found the real entry points (non-vacuity: an empty list would pass every assertion below)", () => {
    expect(entries.length).toBeGreaterThanOrEqual(5);
    expect(entries.some((e) => e.endsWith("global-setup.ts"))).toBe(true);
  });

  it("resolves @scp workspace packages, including across the dist→src hop the setup uses", () => {
    // Non-vacuity for `resolveFirstParty`: if this returned `undefined` for everything, the walk
    // below would visit one file and find nothing, and this gate would be permanently green.
    const globalSetup = entries.find((e) => e.endsWith("global-setup.ts"))!;
    const harness = resolveFirstParty("@scp/server/dist/test-support/harness.js", globalSetup);
    expect(harness).toBe(join(repoRoot, "apps/server/src/test-support/harness.ts"));
    expect(chainToVitest(join(repoRoot, "apps/server/src/test-support/smoke.integration.test.ts")))
      // A known-positive control for the walk itself: this file imports vitest on line 1.
      .toBeDefined();
  });

  it.each(entries.map((e) => [e.slice(repoRoot.length + 1), e] as const))(
    "%s reaches no module that imports vitest",
    (_label, entry) => {
      const chain = chainToVitest(entry);
      expect(
        chain && chain.map((c) => c.replace(`${repoRoot}/`, "")).join("\n  -> ")
      ).toBeUndefined();
    }
  );
});
