import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { trackedFiles } from "./tracked.js";

/** THE `--passWithNoTests` GATE. See docs/source-census.md §30. */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");

const FLAG = "--passWithNoTests";

/** Integration scripts that may carry the flag, with reasons. See docs/source-census.md §31. */
const INTEGRATION_FLAG_ALLOWLIST: Record<string, string> = {
  "@scp/server": "CI shards test:integration 4 ways; a shard may draw zero files",
  "@scp/plugin-managed-iac": "single-file suite; the other shard legitimately draws zero files",
  "@scp/plugin-managed-dep": "single-file suite; the other shard legitimately draws zero files",
  "@scp/plugin-managed-scan": "single-file suite; the other shard legitimately draws zero files",
  "@scp/runner-launcher":
    "single-file suite (reaper.integration.test.ts, M23.1 phase 4); the other shard legitimately draws zero files"
};

/** `test:integration` scripts that are allowed to have no integration test file at all today. */
const KNOWN_EMPTY_INTEGRATION_SUITES = new Set<string>([]);

interface Pkg {
  name: string;
  path: string;
  test?: string;
  integration?: string;
  /** Tracked test files under the package, split the way the two configs split them. */
  unitFiles: string[];
  integrationFiles: string[];
}

/** A vitest-run script, as opposed to `turbo run test` (the root) or `tsx src/verify.ts` (helm-verify). */
function isVitest(script: string | undefined): script is string {
  return script !== undefined && /\bvitest\b/.test(script);
}

function census(): Pkg[] {
  const files = trackedFiles(REPO_ROOT);
  const manifests = files.filter((p) => p === "package.json" || p.endsWith("/package.json"));
  const packages: Pkg[] = [];

  for (const manifest of manifests) {
    const dir = manifest === "package.json" ? "" : manifest.slice(0, -"/package.json".length);
    // TOLERANT, for the same reason `scanner-containment.test.ts`'s sweep is: `git ls-files` lists
    // the INDEX, and a manifest `rm`'d but not yet `git rm`'d would otherwise kill this gate with a
    // bare ENOENT that says nothing about test scripts. Skipping is bounded by the census floor
    // asserted below, which is over the manifests ACTUALLY READ.
    let parsed: { name?: string; scripts?: Record<string, string> };
    try {
      parsed = JSON.parse(readFileSync(resolve(REPO_ROOT, manifest), "utf8")) as {
        name?: string;
        scripts?: Record<string, string>;
      };
    } catch {
      continue;
    }
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

describe("the shard lever cannot silently disconnect (SCP_INTEGRATION_SHARD)", () => {
  /** The shard arrives by env var, never a turbo passthrough. See docs/source-census.md §32. */
  const SHARD_TOKEN = "${SCP_INTEGRATION_SHARD:-}";

  it("turbo.json passes SCP_INTEGRATION_SHARD through to test:integration (strict env)", () => {
    const turbo = JSON.parse(readFileSync(resolve(REPO_ROOT, "turbo.json"), "utf8")) as {
      tasks?: Record<string, { passThroughEnv?: string[] }>;
    };
    expect(
      turbo.tasks?.["test:integration"]?.passThroughEnv,
      "without this entry turbo strips the var and every CI shard silently runs the full suite"
    ).toContain("SCP_INTEGRATION_SHARD");
  });

  it("EVERY vitest test:integration script expands the shard selector", () => {
    const unsharded = PACKAGES.filter(
      (p) => isVitest(p.integration) && !p.integration!.includes(SHARD_TOKEN)
    ).map((p) => `${p.name} (${p.path}): "test:integration": "${p.integration}"`);
    expect(
      unsharded,
      `append ${SHARD_TOKEN} to the script — without it this package's whole integration suite runs in all 4 CI shards instead of being partitioned`
    ).toStrictEqual([]);

    // Non-vacuity: the census must actually be seeing sharded scripts today.
    expect(PACKAGES.filter((p) => p.integration?.includes(SHARD_TOKEN)).length).toBeGreaterThan(4);
  });
});
