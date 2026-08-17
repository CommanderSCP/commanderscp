import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ManifestParseError } from "@scp/dependency-manifests";
import { DOMAIN_EVENT_ROUTERS, domainEventRouters } from "../events/domain-event-registry.js";
import {
  INVENTORY_INGESTION_QUEUE,
  inventoryIngestionRoleGuard,
  inventoryIngestionRouter
} from "./inventory-ingestion-loop.js";
import {
  candidateManifestPaths,
  isGitLfsPointer,
  literalRepoFor,
  manifestBasename,
  manifestStampOutcome,
  MANIFEST_PARSERS,
  MAX_MANIFEST_READS,
  projectIngestionStamp,
  repoManifestScope,
  scopeClaims,
  type IngestedManifest,
  type ManifestSkipReason,
  type SkippedManifest
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

  // -----------------------------------------------------------------------------------------
  // M21.7 — the stamp projection: which of THREE meanings an empty inventory has
  // -----------------------------------------------------------------------------------------
  describe("projectIngestionStamp — an empty inventory has three meanings and this picks one", () => {
    const read = (path: string, declared: number): IngestedManifest => ({
      path,
      declared,
      pruned: 0,
      removed: false
    });
    const skip = (path: string, reason: ManifestSkipReason): SkippedManifest => ({
      path,
      reason,
      detail: `${path} was skipped because ${reason}`
    });

    it("READ AND EMPTY is `ok` with rowsWritten 0 — the state that was impossible to express", () => {
      // The whole reason the table exists. Every probe came back "not there", nothing was known
      // before, so this pass has positive evidence and the honest answer is "declares nothing".
      // If this ever became `unreadable`, a component with genuinely no dependencies would be
      // reported to an operator as broken.
      expect(projectIngestionStamp({ manifests: [], skipped: [] })).toEqual({
        outcome: "ok",
        rowsWritten: 0,
        manifests: []
      });
    });

    it("counts rowsWritten as the DECLARATIONS WRITTEN, summed across manifests", () => {
      const stamp = projectIngestionStamp({
        manifests: [read("go.mod", 2), read("Dockerfile", 1)],
        skipped: []
      });
      expect(stamp.outcome).toBe("ok");
      expect(stamp.rowsWritten).toBe(3);
    });

    it("a manifest that WENT AWAY is still positive evidence: `ok`, and the entry says so", () => {
      // `removed` means the provider said the path is not there and its rows were pruned. It is an
      // answer, not a failure — so it must not drag the component into `unreadable`.
      const stamp = projectIngestionStamp({
        manifests: [{ path: "go.mod", declared: 0, pruned: 4, removed: true }],
        skipped: []
      });
      expect(stamp.outcome).toBe("ok");
      expect(stamp.rowsWritten).toBe(0);
      expect(stamp.manifests[0]?.path).toBe("go.mod");
      expect(stamp.manifests[0]?.outcome).toBe("ok");
      expect(stamp.manifests[0]?.detail).toBeDefined();
    });

    it("MIXED is `partial`, and names WHICH path failed — a count could not", () => {
      const stamp = projectIngestionStamp({
        manifests: [read("package.json", 3)],
        skipped: [skip("Dockerfile", "manifest_unparseable")]
      });
      expect(stamp.outcome).toBe("partial");
      // The declarations that DID land are still counted: a partial pass wrote real rows.
      expect(stamp.rowsWritten).toBe(3);
      expect(stamp.manifests.map((m) => [m.path, m.outcome])).toEqual([
        ["Dockerfile", "unreadable"],
        ["package.json", "ok"]
      ]);
      // The ingestion's own sentence rides along — WHICH file and WHY is the actionable half.
      expect(stamp.manifests.find((m) => m.path === "Dockerfile")?.detail).toContain(
        "manifest_unparseable"
      );
    });

    it("NOTHING READ is `unreadable` — never `ok`, which would claim the component declares nothing", () => {
      const stamp = projectIngestionStamp({
        manifests: [],
        skipped: [skip("package.json", "read_failed"), skip("go.mod", "ref_not_found")]
      });
      expect(stamp.outcome).toBe("unreadable");
      expect(stamp.rowsWritten).toBe(0);
      expect(stamp.manifests.map((m) => m.path)).toEqual(["go.mod", "package.json"]);
    });
  });

  describe("manifestStampOutcome — `unsupported` and `unreadable` carry different operator actions", () => {
    it("splits `manifest_unparseable` STRUCTURALLY, not by reading the skip's prose", () => {
      // The one reason pushed by two different branches: a malformed body (fix the file, and the
      // next pass may succeed) and "no parser is registered for this filename in this build"
      // (nothing to fix). They are told apart by asking MANIFEST_PARSERS the same question the
      // skipping branch asked — the alternative, matching on the detail sentence, is a label named
      // after a string that any reword breaks.
      expect(manifestStampOutcome("services/api/go.mod", "manifest_unparseable")).toBe(
        "unreadable"
      );
      expect(manifestStampOutcome("Cargo.toml", "manifest_unparseable")).toBe("unsupported");
    });

    it("a file SCP structurally cannot decode is `unsupported` — re-running changes nothing", () => {
      expect(manifestStampOutcome("package.json", "lfs_pointer")).toBe("unsupported");
      expect(manifestStampOutcome("package.json", "too_large")).toBe("unsupported");
      expect(manifestStampOutcome("package.json", "not_a_file")).toBe("unsupported");
      expect(manifestStampOutcome("package.json", "not_text")).toBe("unsupported");
      expect(manifestStampOutcome("package.json", "unsupported_encoding")).toBe("unsupported");
    });

    it("a read that failed THIS TIME is `unreadable` — the next pass may succeed", () => {
      expect(manifestStampOutcome("package.json", "read_failed")).toBe("unreadable");
      expect(manifestStampOutcome("package.json", "ref_not_found")).toBe("unreadable");
      expect(manifestStampOutcome("package.json", "read_indeterminate")).toBe("unreadable");
      expect(manifestStampOutcome("package.json", "incomplete_body")).toBe("unreadable");
      expect(manifestStampOutcome("package.json", "read_budget_exhausted")).toBe("unreadable");
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
     * that can regress the wiring is an edit to the composition root, which no unit or integration
     * test of this module would otherwise touch.
     *
     * WHAT A SUBSTRING MATCH DOES NOT PROVE, said plainly: the two `main.ts` assertions below are
     * text, and text cannot tell a live call from a dead one — deleting
     * `startInventoryIngestionLoop`'s OWN `boss.createQueue` and `boss.work` left this green, and
     * left the entire suite green, because nothing executed the loop. The ROUTER half no longer
     * has that weakness: M21.7 moved the router list out of `main.ts` into the importable
     * `events/domain-event-registry.ts`, so this capability's registration is asserted below by
     * running it.
     *
     * The behavioural half is `inventory-ingestion.integration.test.ts`'s "the production path"
     * block: a real pg-boss, this capability's real router, `startInventoryIngestionLoop` itself,
     * and the assertion that a domain event lands ROWS IN THE TABLE. That is what fails when the
     * wiring is deleted.
     */
    const mainTs = readFileSync(join(import.meta.dirname, "..", "main.ts"), "utf8");

    it("the production registry registers THIS router, under THIS capability's guard", () => {
      // By function identity, not by name: the mis-binding this rules out is the registry pairing
      // this router with some other capability's guard, which would register it on processes whose
      // ingestion worker is refused — an enqueue onto a queue nothing drains.
      const entries = DOMAIN_EVENT_ROUTERS.filter(
        (entry) => entry.factory === inventoryIngestionRouter
      );
      expect(entries).toHaveLength(1);
      expect(entries[0]!.guard).toBe(inventoryIngestionRoleGuard);
    });

    it("a declared-commander background process gets it, and NO other deployment shape does", () => {
      const queuesFor = (config: {
        role: "all" | "api" | "worker";
        federationRole: "commander" | "outpost" | "retrans";
        federationRoleDeclared: boolean;
      }): string[] => domainEventRouters(config).map((router) => router.queue);

      expect(
        queuesFor({ role: "worker", federationRole: "commander", federationRoleDeclared: true })
      ).toContain(INVENTORY_INGESTION_QUEUE);

      // AN OUTPOST NO LONGER GETS IT (ADR-0032 §7d, owner decision 2026-08-17). This assertion was
      // the exact inverse until then — "every federation role, deliberately (§3: each domain
      // derives its OWN inventory)" — and it was green, because that is precisely what the guard
      // did. The decision reversed the QUESTION, not the mechanics: an outpost never ORIGINATES a
      // dependency bump, it RECEIVES the resulting change down the global pipeline the commander
      // manages, so the inventory it used to derive fed nothing that could ever act on it.
      expect(
        queuesFor({ role: "worker", federationRole: "outpost", federationRoleDeclared: true })
      ).not.toContain(INVENTORY_INGESTION_QUEUE);
      expect(
        queuesFor({ role: "worker", federationRole: "retrans", federationRoleDeclared: true })
      ).not.toContain(INVENTORY_INGESTION_QUEUE);

      // THE FAIL-CLOSED CASE, which is the branch that regresses silently: `federationRole`
      // DEFAULTS to `commander`, so an outpost predating the setting — or a chart that omits it —
      // presents here as a commander unless the DECLARATION is required as well.
      expect(
        queuesFor({ role: "worker", federationRole: "commander", federationRoleDeclared: false })
      ).not.toContain(INVENTORY_INGESTION_QUEUE);

      expect(
        queuesFor({ role: "api", federationRole: "commander", federationRoleDeclared: true })
      ).not.toContain(INVENTORY_INGESTION_QUEUE);
    });

    it("main.ts starts the WORKER — without it the queue fills and nothing drains it", () => {
      expect(mainTs).toContain("startInventoryIngestionLoop(boss, {");
    });

    it("main.ts stops the loop on close, so a shutdown does not tear the pool out from under it", () => {
      expect(mainTs).toContain("inventoryIngestionLoop.stop()");
    });
  });
});
