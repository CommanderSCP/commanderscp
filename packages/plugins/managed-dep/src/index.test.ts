import { beforeEach, describe, expect, it } from "vitest";
import {
  BUMP_BRANCH_PREFIX,
  CONTENT_BEARING_KEYS,
  bumpBranchFor,
  parseBumpDescriptor
} from "./index.js";
import { resolveRepoWriter } from "./repo-write.js";

/**
 * The orchestrator's REFUSALS, unit-tested. Everything here is reachable without Docker and without
 * a network, which is deliberate: these are the checks that decide whether a container is launched
 * or a repository is touched at all, so they must be provable in the layer that always runs.
 *
 * (The trigger()-through-a-container path needs the `scp-runner-dep` image, which this repository
 * does not build yet — see `index.ts`'s "WHAT THIS INCREMENT DOES NOT SHIP". The verifier that
 * stands between that container and the repository is fully covered in `bump-edit.test.ts`.)
 */

const goodParams = {
  ecosystem: "npm",
  coordinate: "@acme/lib",
  manifestPath: "package.json",
  // The manifest paths the component's own inventory declares. REQUIRED, never defaulted to the
  // target — see `parseBumpDescriptor`: a default would make the manifest-only verifier's
  // "must be a manifest the component already contains" gate agree with itself.
  declaredManifestPaths: ["package.json"],
  fromVersion: "^1.2.3",
  toVersion: "^1.4.0",
  repo: "acme/widget",
  baseBranch: "main",
  changeObjectId: "0198f3c1-1111-7000-8000-000000000001",
  delivery: "pull_request"
};

describe("parseBumpDescriptor — what may be asked for", () => {
  it("accepts a well-formed descriptor and derives the branch from the change id", () => {
    const d = parseBumpDescriptor({ kind: "custom", parameters: goodParams });
    expect(d.headBranch).toBe(`${BUMP_BRANCH_PREFIX}${goodParams.changeObjectId}`);
    expect(d.spec.coordinate).toBe("@acme/lib");
    expect(d.delivery).toBe("pull_request");
  });

  it("REFUSES every content-bearing key — the channel ADR-0032 §9 forbids stays closed", () => {
    // Asserted over the exported list rather than a hand-picked example, so a key added to the list
    // without a refusal (or a refusal that stops covering a listed key) fails here.
    for (const key of CONTENT_BEARING_KEYS) {
      expect(() =>
        parseBumpDescriptor({
          kind: "custom",
          parameters: { ...goodParams, [key]: "anything at all" }
        })
      ).toThrow(new RegExp(`carries '${key}'`));
    }
  });

  it("names `sourceFiles` specifically — the field §9 calls out as NOT a precedent", () => {
    expect(CONTENT_BEARING_KEYS).toContain("sourceFiles");
  });

  /**
   * These three used to pin the prose of this file's OWN `isSafeManifestPath`/`isSafeRepo`/
   * `isSafeBranch` predicates. Those are gone: the descriptor is now validated with the SHARED
   * asserts (`write-guard.ts` → `@scp/git-provider-core`), the same ones the write itself re-applies
   * at the splice site. So the assertion moved to the structured REASON, which is both stronger than
   * a message match and no longer this file's wording to own. The inputs are unchanged, so a
   * refusal that stopped covering one of them still fails here.
   */
  it("refuses a manifest path that escapes the repository", () => {
    for (const bad of ["../../etc/passwd", "/etc/passwd", "a/../../b", "a\\b"]) {
      expect(
        () =>
          parseBumpDescriptor({ kind: "custom", parameters: { ...goodParams, manifestPath: bad } }),
        bad
      ).toThrow(expect.objectContaining({ reason: "unsafe_path" }));
    }
  });

  it("refuses a repo that is not a plain owner/repo identity", () => {
    for (const bad of ["acme", "acme/widget/extra", "acme/wid get", "../acme/widget"]) {
      expect(
        () => parseBumpDescriptor({ kind: "custom", parameters: { ...goodParams, repo: bad } }),
        bad
      ).toThrow(expect.objectContaining({ reason: "unsafe_repo" }));
    }
  });

  it("refuses a base branch that could smuggle a ref-spec or an option", () => {
    // `--force` is the case that proves `assertWriteBaseBranch` exists rather than plain
    // `assertWriteBaseRef`: a leading dash is legal in a REF and refused in a BRANCH.
    for (const bad of ["--force", "a..b", "a//b", "a b", "refs/heads/main", "HEAD"]) {
      expect(
        () =>
          parseBumpDescriptor({ kind: "custom", parameters: { ...goodParams, baseBranch: bad } }),
        bad
      ).toThrow(expect.objectContaining({ reason: "unsafe_base_ref" }));
    }
  });

  it("refuses a version token carrying a newline or a control character", () => {
    expect(() =>
      parseBumpDescriptor({
        kind: "custom",
        parameters: { ...goodParams, toVersion: "^1.4.0\nrm -rf /" }
      })
    ).toThrow(/one token on one line/);
  });

  it("refuses a no-op bump", () => {
    expect(() =>
      parseBumpDescriptor({ kind: "custom", parameters: { ...goodParams, toVersion: "^1.2.3" } })
    ).toThrow(/there is no bump to author/);
  });

  it("refuses an unknown ecosystem rather than passing it to the runner", () => {
    expect(() =>
      parseBumpDescriptor({ kind: "custom", parameters: { ...goodParams, ecosystem: "cargo" } })
    ).toThrow(/unknown ecosystem 'cargo'/);
  });

  it("refuses a delivery outside the closed pair — an unrecognised value never means auto_merge", () => {
    for (const bad of [undefined, "", "AUTO_MERGE", "merge", true]) {
      expect(() =>
        parseBumpDescriptor({ kind: "custom", parameters: { ...goodParams, delivery: bad } })
      ).toThrow(/delivery must be/);
    }
  });

  it("refuses a change id that is not an object id — it becomes a branch name", () => {
    expect(() =>
      parseBumpDescriptor({
        kind: "custom",
        parameters: { ...goodParams, changeObjectId: "../../evil" }
      })
    ).toThrow(/it becomes the branch name/);
  });
});

describe("bumpBranchFor — the provenance contract's other half", () => {
  it("is deterministic, so a retry converges on one branch and one pull request", () => {
    expect(bumpBranchFor("abc")).toBe(bumpBranchFor("abc"));
    expect(bumpBranchFor("abc")).toBe("scp/dep-bump/abc");
  });
});

describe("resolveRepoWriter — the credential clause, as a refusal", () => {
  beforeEach(() => undefined);

  it("refuses a provider with no per-run, single-repository, short-lived credential", () => {
    for (const provider of ["gitea", "gitlab"]) {
      expect(() => resolveRepoWriter({ provider, appId: "1", installationId: "2" })).toThrow(
        /standing credential/
      );
    }
  });

  it("refuses a GitHub arm with no App identity — a bump needs a token it can mint per run", () => {
    expect(() => resolveRepoWriter({ provider: "github" })).toThrow(
      /appId and config.installationId/
    );
  });

  it("accepts a complete GitHub App identity", () => {
    expect(resolveRepoWriter({ appId: "1", installationId: "2" })).toBeDefined();
  });
});
