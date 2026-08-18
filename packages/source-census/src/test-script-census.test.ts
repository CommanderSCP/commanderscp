import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ================================================================================================
 * THE `--passWithNoTests` GATE — A PACKAGE MAY NOT REPORT SUCCESS FOR HAVING RUN NOTHING
 * ================================================================================================
 *
 * WHAT WENT WRONG. `@scp/runner-launcher` — the only code in the product that spawns a process —
 * had no tests and ran `vitest run --passWithNoTests`, so `turbo run test` printed "No test files
 * found" and reported SUCCESS. M23.1 wrote the suite and dropped the flag from THAT ONE package and
 * stopped there. The argument for dropping it applied verbatim to the other thirty-three: six
 * packages held their entire unit coverage in a SINGLE FILE, so `git rm` of one file would have
 * yielded a green empty package, and the three plugins holding the launch-argv goldens this branch
 * had just declared irreplaceable were among them. Fixing the instance and not the class is the
 * incomplete-call-site-census property CLAUDE.md names; this file is the census made standing.
 *
 * THE RULE, IN TWO PARTS.
 *  1. NO `test` SCRIPT MAY CARRY THE FLAG. The allowlist is EMPTY and is meant to stay empty —
 *     a package with nothing to run gets a test that says what it is (see `@scp/plugin-oidc`'s
 *     `stub.test.ts`), not a flag that hides it.
 *  2. EVERY VITEST `test` SCRIPT MUST HAVE A FILE TO RUN. Part 1 alone is not enough: without this,
 *     deleting a package's last test file turns `pnpm test` red for a package but the reviewer sees
 *     an error about "no test files", not about the coverage that vanished. Asserted as a census so
 *     the failure NAMES the package.
 *
 * `test:integration` IS DIFFERENT, AND IT IS NOT AN OVERSIGHT. CI job 5 runs
 * `pnpm test:integration -- --shard=${matrix.shard}/2`, and vitest shards at FILE granularity: a
 * single-file suite (managed-iac, managed-dep) runs in whichever shard vitest assigns it and
 * legitimately finds ZERO files in the other. Removing the flag there would red half of every CI
 * run for a suite that is working correctly. Those scripts are therefore allowlisted BY NAME with
 * that reason, and the allowlist is checked for staleness in both directions.
 *
 * WHY THIS FILE LIVES IN `@scp/source-census`. This package is the repo's "census over its own
 * tracked source" utility (`readStripped` is what the repo-wide containment gates read with); a
 * census over the repo's own package manifests belongs beside it. It reads `git ls-files`, not a
 * directory walk, for the reason `scanner-containment.test.ts` states: a walk sweeps in
 * `node_modules` and build output and ends up either permanently red or "fixed" with exclusions.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");

const FLAG = "--passWithNoTests";

/**
 * `test:integration` scripts that may carry the flag, each with the reason. ONE REASON ONLY IS
 * LEGITIMATE — vitest's file-granularity `--shard`, which hands a shard zero files for a
 * single-file (or, for managed-scan, an as-yet-unwritten) suite.
 *
 * `@scp/plugin-managed-scan` IS A DEBT, NOT A SHARD ARTIFACT, and is named here rather than hidden:
 * it has a `test:integration` script and a `vitest.integration.config.ts` and ZERO
 * `*.integration.test.ts` files — the M13.3 DoD's real-Docker scan suite was scaffolded and never
 * written. It finds no files in EITHER shard. Delete this entry when that suite lands.
 */
const INTEGRATION_FLAG_ALLOWLIST: Record<string, string> = {
  "@scp/server": "CI shards test:integration 2 ways; a shard may draw zero files",
  "@scp/plugin-managed-iac": "single-file suite; the other shard legitimately draws zero files",
  "@scp/plugin-managed-dep": "single-file suite; the other shard legitimately draws zero files",
  "@scp/plugin-managed-scan":
    "DEBT: the M13.3 real-Docker scan suite was scaffolded and never written — zero files in EITHER shard"
};

/** `test:integration` scripts that are allowed to have no integration test file at all today. */
const KNOWN_EMPTY_INTEGRATION_SUITES = new Set(["@scp/plugin-managed-scan"]);

interface Pkg {
  name: string;
  path: string;
  test?: string;
  integration?: string;
  /** Tracked test files under the package, split the way the two configs split them. */
  unitFiles: string[];
  integrationFiles: string[];
}

function trackedFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  return out.split("\0").filter((p) => p.length > 0);
}

/** A vitest-run script, as opposed to `turbo run test` (the root) or `tsx src/verify.ts` (helm-verify). */
function isVitest(script: string | undefined): script is string {
  return script !== undefined && /\bvitest\b/.test(script);
}

function census(): Pkg[] {
  const files = trackedFiles();
  const manifests = files.filter((p) => p === "package.json" || p.endsWith("/package.json"));
  const packages: Pkg[] = [];

  for (const manifest of manifests) {
    const dir = manifest === "package.json" ? "" : manifest.slice(0, -"/package.json".length);
    const parsed = JSON.parse(readFileSync(resolve(REPO_ROOT, manifest), "utf8")) as {
      name?: string;
      scripts?: Record<string, string>;
    };
    const scripts = parsed.scripts ?? {};
    if (scripts["test"] === undefined && scripts["test:integration"] === undefined) continue;

    // The ROOT manifest's `turbo run test` fans out to every package below; counting the whole repo's
    // test files against it would be meaningless, so it is censused for its script text only.
    const prefix = dir === "" ? null : `${dir}/`;
    const own =
      prefix === null
        ? []
        : files.filter(
            (p) =>
              p.startsWith(prefix) &&
              // Nested workspaces belong to themselves, not to their parent.
              !files.some(
                (m) =>
                  m.endsWith("/package.json") &&
                  m !== manifest &&
                  m.startsWith(prefix) &&
                  p.startsWith(m.slice(0, -"package.json".length))
              )
          );
    const tests = own.filter((p) => /\.test\.tsx?$/.test(p));
    packages.push({
      name: parsed.name ?? manifest,
      path: manifest,
      test: scripts["test"],
      integration: scripts["test:integration"],
      unitFiles: tests.filter((p) => !p.includes(".integration.test.")),
      integrationFiles: tests.filter((p) => p.includes(".integration.test."))
    });
  }
  return packages;
}

const PACKAGES = census();

describe("no package may report test success for having run nothing", () => {
  it("the census actually read the repo's manifests (it is not an empty list)", () => {
    // Non-vacuity. Every assertion below is "this set is empty"; without this one they would all
    // pass trivially the day `git ls-files` returned nothing or the parse silently skipped everyone.
    expect(PACKAGES.length).toBeGreaterThan(30);
    expect(PACKAGES.map((p) => p.name)).toContain("@scp/runner-launcher");
    expect(PACKAGES.map((p) => p.name)).toContain("@scp/plugin-managed-iac");
    // …and the detector itself matches the string it is looking for.
    expect(isVitest("vitest run --passWithNoTests")).toBe(true);
    expect("vitest run --passWithNoTests".includes(FLAG)).toBe(true);
    expect(isVitest("turbo run test")).toBe(false);
  });

  it(`NO \`test\` script carries ${FLAG} — the allowlist for unit scripts is empty`, () => {
    const offenders = PACKAGES.filter((p) => p.test?.includes(FLAG)).map(
      (p) => `${p.name} (${p.path}): "test": "${p.test}"`
    );
    expect(
      offenders,
      `${FLAG} lets a package with no test files report SUCCESS. Give the package a test that says what it is, do not hide it behind the flag.`
    ).toStrictEqual([]);
  });

  it("EVERY vitest `test` script has at least one test file to run", () => {
    // The other half: dropping the flag only bites if there is something to run. A package whose
    // last test file is deleted must fail HERE, naming the package, rather than as vitest's own
    // "No test files found" further down the log.
    const empty = PACKAGES.filter((p) => isVitest(p.test) && p.unitFiles.length === 0).map(
      (p) => `${p.name} (${p.path})`
    );
    expect(
      empty,
      "a package whose `test` script is vitest but which has no *.test.ts file: add the test, or remove the script"
    ).toStrictEqual([]);
  });

  it(`a \`test:integration\` script may carry ${FLAG} ONLY if it is allowlisted BY NAME`, () => {
    const offenders = PACKAGES.filter(
      (p) => p.integration?.includes(FLAG) && INTEGRATION_FLAG_ALLOWLIST[p.name] === undefined
    ).map((p) => `${p.name} (${p.path})`);
    expect(
      offenders,
      "the only legitimate reason is vitest's file-granularity --shard in CI job 5; add the package and the reason to INTEGRATION_FLAG_ALLOWLIST"
    ).toStrictEqual([]);
  });

  it("the integration allowlist has no stale entries — every entry still exists and still carries the flag", () => {
    // An allowlist nobody prunes is how a rule becomes decoration. Both directions: an entry for a
    // package that no longer carries the flag (or no longer exists) must be deleted.
    const stale = Object.keys(INTEGRATION_FLAG_ALLOWLIST).filter((name) => {
      const pkg = PACKAGES.find((p) => p.name === name);
      return pkg === undefined || !pkg.integration?.includes(FLAG);
    });
    expect(stale, "remove these from INTEGRATION_FLAG_ALLOWLIST").toStrictEqual([]);

    const staleEmpty = [...KNOWN_EMPTY_INTEGRATION_SUITES].filter((name) => {
      const pkg = PACKAGES.find((p) => p.name === name);
      return pkg === undefined || pkg.integrationFiles.length > 0;
    });
    expect(
      staleEmpty,
      "these packages now HAVE integration tests — remove them from KNOWN_EMPTY_INTEGRATION_SUITES (and from INTEGRATION_FLAG_ALLOWLIST if they are no longer single-file)"
    ).toStrictEqual([]);
  });

  it("EVERY vitest `test:integration` script has an integration file, unless it is a NAMED debt", () => {
    const empty = PACKAGES.filter(
      (p) =>
        isVitest(p.integration) &&
        p.integrationFiles.length === 0 &&
        !KNOWN_EMPTY_INTEGRATION_SUITES.has(p.name)
    ).map((p) => `${p.name} (${p.path})`);
    expect(
      empty,
      "a `test:integration` script with no *.integration.test.ts file runs nothing in every shard; write the suite or name it in KNOWN_EMPTY_INTEGRATION_SUITES"
    ).toStrictEqual([]);
  });
});
