import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ManifestParseError } from "@scp/dependency-manifests";
import {
  candidateManifestPaths,
  isGitLfsPointer,
  literalRepoFor,
  manifestBasename,
  MANIFEST_PARSERS,
  MAX_MANIFEST_READS,
  repoManifestScope,
  scopeClaims
} from "./inventory-ingestion.js";

/**
 * M21.2 — the PURE half of dependency-inventory ingestion (BUILD_AND_TEST.md §4.1: anything testable
 * as a pure function must be written as one). The database-backed behaviour — the enablement gate
 * refusing to fetch, the per-manifest failure handling, the prune, idempotency, and the fact that
 * anything CALLS the ingestion at all — is in `inventory-ingestion.integration.test.ts`.
 */
describe("M21.2 dependency-inventory ingestion — pure parts (ADR-0032 §4)", () => {
  describe("the parser table", () => {
    it("covers exactly the six dependency-manifest filenames the five ecosystems declare in", () => {
      expect([...MANIFEST_PARSERS.keys()].sort()).toEqual([
        "Dockerfile",
        "go.mod",
        "package.json",
        "pom.xml",
        "pyproject.toml",
        "requirements.txt"
      ]);
    });

    it("dispatches on the BASENAME, so a manifest nested at any depth is still parsed", () => {
      expect(manifestBasename("services/api/go.mod")).toBe("go.mod");
      expect(manifestBasename("go.mod")).toBe("go.mod");
      // A `\` is a legal character in a git path and is NOT a separator — `node:path.basename`
      // would split on it on Windows, which is why this does not use it.
      expect(manifestBasename("weird\\dir/package.json")).toBe("package.json");
      expect(MANIFEST_PARSERS.get(manifestBasename("a/b/c/Dockerfile"))).toBeDefined();
    });

    it("every registered parser throws ManifestParseError on a 404 HTML body — the caller contract", () => {
      const html = "<!DOCTYPE html>\n<html><body>404 Not Found</body></html>\n";
      const survivors: string[] = [];
      for (const [filename, parse] of MANIFEST_PARSERS) {
        try {
          parse(html);
          survivors.push(filename);
        } catch (err) {
          expect(err).toBeInstanceOf(ManifestParseError);
        }
      }
      // `requirements.txt` is the documented exception: its format has no required construct to
      // miss, so it CANNOT throw and the ingestion cannot rely on a throw to notice a bad body.
      // That is precisely why `isGitLfsPointer` exists as a separate structural check — this
      // assertion is what keeps that reasoning honest if a future parser joins the exception.
      expect(survivors).toEqual(["requirements.txt"]);
    });
  });

  describe("isGitLfsPointer", () => {
    it("recognises a pointer, which is valid text and would otherwise parse as a manifest", () => {
      const pointer =
        "version https://git-lfs.github.com/spec/v1\noid sha256:4d7a2145\nsize 12345\n";
      expect(isGitLfsPointer(pointer)).toBe(true);
      expect(isGitLfsPointer(pointer.replace(/\n/g, "\r\n"))).toBe(true);
    });

    it("is the ONLY thing standing between a pointer and requirements.txt's declarations", () => {
      const pointer = "version https://git-lfs.github.com/spec/v1\noid sha256:4d7a2145\nsize 12\n";
      const parse = MANIFEST_PARSERS.get("requirements.txt");
      // Proving the hazard rather than asserting the guard exists: handed a pointer, the one parser
      // that never throws returns DECLARATIONS. Ingesting those would replace the component's real
      // python inventory with the pointer's own lines and prune the truth away.
      expect(parse?.(pointer).length).toBeGreaterThan(0);
      expect(isGitLfsPointer(pointer)).toBe(true);
    });

    it("does not fire on a real manifest that merely mentions git-lfs", () => {
      expect(isGitLfsPointer('{"dependencies":{"git-lfs":"^1.0.0"}}')).toBe(false);
      // The version line must be FIRST — the pointer spec requires it, and a `.gitattributes`-style
      // preamble is not a pointer.
      expect(isGitLfsPointer("# notes\nversion https://git-lfs.github.com/spec/v1\n")).toBe(false);
    });
  });

  describe("repoManifestScope — the probe set, derived from the mappings for THIS repository", () => {
    const map = (repoPattern: string | null, pathPattern: string | null) => ({
      repoPattern,
      pathPattern
    });

    it("uses ONLY the mappings that name this repository", () => {
      // THE BLOCKER, at its source. A component fed by two repos used to derive its probe set from
      // BOTH, so a release from `acme/chart` probed `svc/api/**`'s paths in the chart repo, got
      // `not_found`, and pruned the code repo's inventory away.
      const mappings = [map("acme/code", "svc/api/**"), map("acme/chart", "deploy/**")];
      expect(repoManifestScope(mappings, "acme/code").prefixes).toEqual(["svc/api"]);
      expect(repoManifestScope(mappings, "acme/chart").prefixes).toEqual(["deploy"]);
    });

    it("reports `mapped: false` for a repository no mapping names — nothing to probe, nothing to prune", () => {
      const scope = repoManifestScope([map("acme/code", null)], "acme/other");
      expect(scope.mapped).toBe(false);
      expect(scope.prefixes).toEqual([]);
    });

    it("a mapping with no repo pattern constrains no repository, exactly as correlation reads it", () => {
      expect(repoManifestScope([map(null, null)], "anything/at-all").mapped).toBe(true);
      expect(repoManifestScope([map("acme/*", null)], "acme/widgets").mapped).toBe(true);
    });

    it("the repo ROOT is a prefix ONLY when a mapping constrains no path", () => {
      // THE MAJOR. The root used to be seeded unconditionally, so every enabled component in a
      // monorepo ingested the root `package.json` as its OWN declarations — including two
      // components scoped by `path_pattern` to different subdirectories, which then both claimed it.
      expect(repoManifestScope([map(null, "svc/api/**")], "acme/mono").prefixes).toEqual([
        "svc/api"
      ]);
      expect(repoManifestScope([map(null, null)], "acme/mono").prefixes).toEqual([""]);
    });

    it("takes the LITERAL head of a directory glob — the shape discovery actually writes", () => {
      expect(repoManifestScope([map(null, "services/api/**")], "r").prefixes).toEqual([
        "services/api"
      ]);
    });

    it("stops at the first wildcard segment rather than guessing past it", () => {
      expect(repoManifestScope([map(null, "services/*/api/**")], "r").prefixes).toEqual([
        "services"
      ]);
      expect(repoManifestScope([map(null, "**")], "r").prefixes).toEqual([""]);
    });

    it("reads a wildcard-free pattern BOTH ways unless its last segment is a manifest filename", () => {
      // `services/api/go.mod` names a FILE — its directory is the prefix, and probing
      // `services/api/go.mod/go.mod` would be nonsense.
      expect(repoManifestScope([map(null, "services/api/go.mod")], "r").prefixes).toEqual([
        "services/api"
      ]);
      // `services/api` is ambiguous, and treating it as a file (stripping `api`) meant the
      // component's OWN directory was never probed at all — only its parent's.
      expect(repoManifestScope([map(null, "services/api")], "r").prefixes).toEqual([
        "services",
        "services/api"
      ]);
    });

    it("dedupes and sorts, so the read order is stable across runs", () => {
      const mappings = [map(null, "a/**"), map(null, "a/b/**"), map(null, "a/**")];
      expect(repoManifestScope(mappings, "r").prefixes).toEqual(["a", "a/b"]);
    });
  });

  describe("scopeClaims — the mapping's own predicate decides what the generator produced", () => {
    const scopeOf = (pathPattern: string | null) =>
      repoManifestScope([{ repoPattern: null, pathPattern }], "r");

    it("a path-unconstrained mapping claims the whole repository", () => {
      expect(scopeClaims(scopeOf(null), "anywhere/deep/go.mod")).toBe(true);
    });

    it("a subtree glob does NOT claim the repo root", () => {
      const scope = scopeOf("svc/api/**");
      expect(scopeClaims(scope, "svc/api/package.json")).toBe(true);
      expect(scopeClaims(scope, "package.json")).toBe(false);
    });

    it("an exact file pattern claims that file and nothing beside it", () => {
      const scope = scopeOf("services/api/go.mod");
      expect(scopeClaims(scope, "services/api/go.mod")).toBe(true);
      expect(scopeClaims(scope, "services/api/package.json")).toBe(false);
    });

    it("a wildcard-free directory pattern claims what is UNDER it, not what is beside it", () => {
      const scope = scopeOf("services/api");
      expect(scopeClaims(scope, "services/api/go.mod")).toBe(true);
      expect(scopeClaims(scope, "services/go.mod")).toBe(false);
      // Not a prefix-string test: a sibling directory whose name merely starts the same way is not
      // inside it.
      expect(scopeClaims(scope, "services/api-v2/go.mod")).toBe(false);
    });

    it("claims nothing when the head cannot reach past a wildcard — honestly reading zero paths", () => {
      const scope = scopeOf("services/*/api/**");
      expect(scope.prefixes).toEqual(["services"]);
      expect(scopeClaims(scope, "services/go.mod")).toBe(false);
    });
  });

  describe("candidateManifestPaths", () => {
    const wholeRepo = repoManifestScope([{ repoPattern: null, pathPattern: null }], "r");

    it("asks for KNOWN paths first, so the read budget can never freeze the real inventory", () => {
      const { paths } = candidateManifestPaths({
        knownPaths: ["deep/nested/custom/pom.xml"],
        scope: wholeRepo
      });
      expect(paths[0]).toBe("deep/nested/custom/pom.xml");
    });

    it("crosses every prefix with every manifest filename, and dedupes against the known set", () => {
      const scope = repoManifestScope(
        [
          { repoPattern: null, pathPattern: null },
          { repoPattern: null, pathPattern: "svc/**" }
        ],
        "r"
      );
      const { paths } = candidateManifestPaths({ knownPaths: ["go.mod"], scope });
      expect(paths).toContain("go.mod");
      expect(paths.filter((p) => p === "go.mod")).toHaveLength(1);
      expect(paths).toContain("svc/package.json");
      expect(paths).toHaveLength(MANIFEST_PARSERS.size * 2);
    });

    it("DROPS a known path this repository's mappings do not cover — unprobed, and so unprunable", () => {
      // The other half of the blocker: a known path is a path SOME pass wrote, not necessarily one
      // this repo's mappings cover. Probing it here is how a pass acquired the `not_found` it then
      // pruned another repository's rows with.
      const scope = repoManifestScope([{ repoPattern: null, pathPattern: "svc/api/**" }], "r");
      const { paths } = candidateManifestPaths({
        knownPaths: ["svc/api/go.mod", "other/repo/go.mod"],
        scope
      });
      expect(paths).toContain("svc/api/go.mod");
      expect(paths).not.toContain("other/repo/go.mod");
    });

    it("bounds the reads and NAMES the paths it did not read", () => {
      const scope = repoManifestScope(
        Array.from({ length: 20 }, (_, i) => ({ repoPattern: null, pathPattern: `p${i}/**` })),
        "r"
      );
      const { paths, unread } = candidateManifestPaths({ knownPaths: [], scope });
      expect(paths).toHaveLength(MAX_MANIFEST_READS);
      expect(unread).toHaveLength(20 * MANIFEST_PARSERS.size - MAX_MANIFEST_READS);
      // BY NAME, not by count: a component over the budget has permanently stale rows at these
      // exact paths, and an operator cannot act on "42 candidates were not read".
      expect(unread.every((p) => p.includes("/"))).toBe(true);
      expect(new Set([...paths, ...unread]).size).toBe(paths.length + unread.length);
    });
  });

  describe("literalRepoFor — the backfill's address, declared or refused", () => {
    it("takes a single literal repo pattern", () => {
      expect(literalRepoFor(["acme/widgets"])).toBe("acme/widgets");
      expect(literalRepoFor(["acme/widgets", "acme/widgets", null])).toBe("acme/widgets");
    });

    it("refuses a glob — a matching rule is not an address", () => {
      expect(literalRepoFor(["acme/*"])).toBeNull();
      expect(literalRepoFor([null])).toBeNull();
      expect(literalRepoFor([])).toBeNull();
    });

    it("refuses TWO different repos rather than picking one", () => {
      expect(literalRepoFor(["acme/widgets", "acme/other"])).toBeNull();
    });
  });

  describe("the wiring census — this feature's whole failure mode is being built and not installed", () => {
    /**
     * M21 has shipped FOUR components with no production caller (a guard reaching one of four
     * doors, a detection with no caller, an actuator with no dispatcher, a config schema never
     * registered), and this ingestion was the fifth. Every one of them had passing tests, because
     * tests called the component directly.
     *
     * So the acceptance criterion is not "the function works", it is WIRED — and the only thing
     * that can regress the wiring is an edit to `main.ts`, which no unit or integration test of
     * this module would otherwise touch. This census reads that file and fails if the two halves
     * are not both there.
     *
     * WHAT THIS DOES NOT PROVE, said plainly: A SUBSTRING MATCH IS NOT A TEST OF BEHAVIOUR. It
     * proves the call sites exist in `main.ts` and nothing else — deleting
     * `startInventoryIngestionLoop`'s OWN `boss.createQueue` and `boss.work` left this green, and
     * left the entire suite green, because nothing executed the loop.
     *
     * The behavioural half is `inventory-ingestion.integration.test.ts`'s "the production path"
     * block: a real pg-boss, this capability's real router, `startInventoryIngestionLoop` itself,
     * and the assertion that a domain event lands ROWS IN THE TABLE. That is what fails when the
     * wiring is deleted. This census remains only for the one edge it covers that the other cannot
     * — `main.ts`'s own call sites, which no test of this module would otherwise touch.
     */
    const mainTs = readFileSync(join(import.meta.dirname, "..", "main.ts"), "utf8");

    it("main.ts registers the ROUTER with startPgBoss — without it no event ever reaches the queue", () => {
      expect(mainTs).toContain("inventoryIngestionRouter()");
      expect(mainTs).toContain("inventoryIngestionRoleGuard(config)");
    });

    it("main.ts starts the WORKER — without it the queue fills and nothing drains it", () => {
      expect(mainTs).toContain("startInventoryIngestionLoop(boss, {");
    });

    it("main.ts stops the loop on close, so a shutdown does not tear the pool out from under it", () => {
      expect(mainTs).toContain("inventoryIngestionLoop.stop()");
    });
  });
});
