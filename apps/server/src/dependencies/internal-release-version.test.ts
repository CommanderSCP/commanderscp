import { describe, expect, it } from "vitest";
import type { ReadFileAtRefRequest, ReadFileAtRefResult } from "@scp/git-provider-core";
import {
  parseImageRef,
  resolveReleasedVersion,
  type ManifestReader,
  type ResolveReleasedVersionInput
} from "./internal-release-version.js";

/**
 * M21.4 — THE VERSION STRATEGY, without a database (BUILD_AND_TEST.md §4.1).
 *
 * `resolveReleasedVersion` is where the whole feature's honesty lives: it either points at a signal
 * or says why it cannot, and the failure mode that matters is the QUIET one — a plausible-looking
 * version derived from something that is not a version. So the assertions below are almost all of
 * the shape "records NOTHING, and here is the reason", each paired with the positive control that
 * makes the refusal about the input rather than about a function that always refuses.
 *
 * MUTATION LOG — applied, watched fail, reverted, watched pass:
 * | Mutation | Result |
 * |---|---|
 * | fall back to the digest when the observed ref carries no tag | "records NOTHING for a digest-only ref" FAILS |
 * | read the manifest at `source_ref.ref` instead of `.commit` | "reads package.json AT THE RELEASED COMMIT" and "records NOTHING when the change carries no released commit" both FAIL |
 * THE LINE GUARD MOVED OUT OF THIS FILE. `lineAcceptsVersion` now lives in `line-head.ts` — it was
 * a SECOND implementation of a question the third-party poll also answers, and the two disagreed
 * about what `tag_pattern` means. Its tests moved with it, to `line-head.test.ts`.
 * (The per-ecosystem refusals are additionally mutation-proven end to end in
 * `internal-release-detection.integration.test.ts` — see its own log.)
 */

const found = (content: string, commitSha = "c0ffee"): ReadFileAtRefResult => ({
  outcome: "found",
  path: "package.json",
  requestedRef: commitSha,
  commitSha,
  content,
  sizeBytes: Buffer.byteLength(content)
});

/** Records what it was asked, so a test can assert the REF a manifest was read at — reading the
 *  released commit rather than a branch head is a correctness property, not an implementation
 *  detail. */
function reader(respond: (request: ReadFileAtRefRequest) => ReadFileAtRefResult): {
  read: ManifestReader;
  calls: ReadFileAtRefRequest[];
} {
  const calls: ReadFileAtRefRequest[] = [];
  return {
    read: async (request) => {
      calls.push(request);
      return respond(request);
    },
    calls
  };
}

function input(overrides: Partial<ResolveReleasedVersionInput> = {}): ResolveReleasedVersionInput {
  return {
    line: { ecosystem: "oci", coordinate: "ghcr.io/acme/api" },
    sourceRef: {},
    observedImages: [],
    manifestPaths: [],
    ...overrides
  };
}

describe("parseImageRef", () => {
  it("splits repository / tag / digest, in all four shapes an executor reports", () => {
    expect(parseImageRef("ghcr.io/acme/api:1.2.3")).toEqual({
      repository: "ghcr.io/acme/api",
      tag: "1.2.3"
    });
    expect(parseImageRef("ghcr.io/acme/api@sha256:ab12")).toEqual({
      repository: "ghcr.io/acme/api",
      digest: "sha256:ab12"
    });
    expect(parseImageRef("ghcr.io/acme/api:1.2.3@sha256:ab12")).toEqual({
      repository: "ghcr.io/acme/api",
      tag: "1.2.3",
      digest: "sha256:ab12"
    });
    expect(parseImageRef("ghcr.io/acme/api")).toEqual({ repository: "ghcr.io/acme/api" });
  });

  it("does not read a REGISTRY PORT as a tag", () => {
    // The naive "split on the last colon" reads `5000/acme/api` as the tag of a ref that has no
    // tag at all — a silently wrong parse, which would then be recorded as this line's version.
    expect(parseImageRef("registry.internal:5000/acme/api")).toEqual({
      repository: "registry.internal:5000/acme/api"
    });
    expect(parseImageRef("registry.internal:5000/acme/api:1.2.3")).toEqual({
      repository: "registry.internal:5000/acme/api",
      tag: "1.2.3"
    });
  });

  it("returns null for junk rather than a repository-shaped guess", () => {
    expect(parseImageRef("")).toBeNull();
    expect(parseImageRef("   ")).toBeNull();
    expect(parseImageRef(":1.2.3")).toBeNull();
  });
});

describe("resolveReleasedVersion — an ecosystem with no strategy says SO", () => {
  it("reports `no_strategy_for_ecosystem`, not a missing manifest reader", async () => {
    // `dependency_lines.ecosystem` is plain `text` with no CHECK (0061), so a row can outlive the
    // enum and a sixth ecosystem lands here first. The REFUSAL was always right; the LABEL was not.
    // It reported `manifest_reader_unavailable`, whose stated remedy is "wire a readFileAtRef
    // reader" — which would fix nothing here. That is the provenance-label failure this repo has
    // shipped once already: a reason named after the branch that matched, false as soon as the
    // branch covers a second case (charter principle 6, ADR-0030 §2).
    const wired = reader(() => found(JSON.stringify({ version: "1.0.0" })));
    const result = await resolveReleasedVersion(
      input({
        line: { ecosystem: "cargo" as never, coordinate: "acme-lib" },
        sourceRef: { repo: "acme/api", commit: "abc123" },
        manifestPaths: ["Cargo.toml"],
        readManifest: wired.read
      })
    );
    expect(result).toMatchObject({ determined: false, reason: "no_strategy_for_ecosystem" });
    // THE PROOF THE OLD LABEL WAS FALSE: a reader IS wired and the answer is unchanged, and nothing
    // was read, so a missing reader could never have been the cause.
    expect(wired.calls).toEqual([]);

    // NEGATIVE CONTROL: a language line with NO reader still reports the reader's own reason, so
    // the split is between two live reasons rather than one renamed one.
    expect(
      await resolveReleasedVersion(
        input({
          line: { ecosystem: "npm", coordinate: "@acme/api" },
          sourceRef: { repo: "acme/api", commit: "abc123" },
          manifestPaths: ["package.json"]
        })
      )
    ).toMatchObject({ determined: false, reason: "manifest_reader_unavailable" });
  });
});

describe("resolveReleasedVersion — oci reads the observed image ref", () => {
  it("records the TAG as the version and the DIGEST alongside it", async () => {
    const result = await resolveReleasedVersion(
      input({
        observedImages: ["ghcr.io/acme/api:1.2.3@sha256:ab12", "ghcr.io/acme/sidecar:9.9.9"]
      })
    );
    expect(result).toMatchObject({
      determined: true,
      signal: "oci_observed_image",
      version: "1.2.3",
      digest: "sha256:ab12"
    });
  });

  it("carries digest `null`, never `undefined`, when the ref had none", async () => {
    // An OMITTED digest leaves whatever `dependency_lines` already stored, which would park a
    // PREVIOUS release's digest beside a NEW version. Explicit null is what clears it.
    const result = await resolveReleasedVersion(
      input({ observedImages: ["ghcr.io/acme/api:1.2.3"] })
    );
    expect(result).toMatchObject({ determined: true, version: "1.2.3", digest: null });
  });

  it("records NOTHING for a digest-only ref — a digest is not a version", async () => {
    expect(
      await resolveReleasedVersion(input({ observedImages: ["ghcr.io/acme/api@sha256:ab12"] }))
    ).toMatchObject({ determined: false, reason: "image_ref_has_no_tag" });
  });

  it("records NOTHING when nothing was observed, or when nothing names this coordinate", async () => {
    expect(await resolveReleasedVersion(input())).toMatchObject({
      determined: false,
      reason: "no_observed_images"
    });
    expect(
      await resolveReleasedVersion(input({ observedImages: ["ghcr.io/acme/other:1.2.3"] }))
    ).toMatchObject({ determined: false, reason: "no_matching_image_ref" });
  });

  it("matches the coordinate VERBATIM — no slug folding", async () => {
    // `graph/urn.ts` collapses these to one slug. If matching normalised, a release of
    // `ghcr.io/acme/API` would move `ghcr.io/acme-api`'s head.
    expect(
      await resolveReleasedVersion(
        input({
          line: { ecosystem: "oci", coordinate: "ghcr.io/acme/api" },
          observedImages: ["ghcr.io/acme/API:1.2.3"]
        })
      )
    ).toMatchObject({ determined: false, reason: "no_matching_image_ref" });
  });

  it("records NOTHING when two observed refs disagree — picking one would be a guess", async () => {
    expect(
      await resolveReleasedVersion(
        input({ observedImages: ["ghcr.io/acme/api:1.2.3", "ghcr.io/acme/api:1.2.4"] })
      )
    ).toMatchObject({ determined: false, reason: "ambiguous_image_refs" });
    // Same tag, two digests: the tag was repointed mid-rollout and neither reading is the head.
    expect(
      await resolveReleasedVersion(
        input({
          observedImages: ["ghcr.io/acme/api:1.2.3@sha256:aa", "ghcr.io/acme/api:1.2.3@sha256:bb"]
        })
      )
    ).toMatchObject({ determined: false, reason: "ambiguous_image_refs" });
  });
});

describe("resolveReleasedVersion — go reads the git tag and nothing else", () => {
  const goLine = { ecosystem: "go", coordinate: "github.com/acme/lib" } as const;

  it("uses source_ref.ref when it IS a tag", async () => {
    expect(
      await resolveReleasedVersion(
        input({ line: goLine, sourceRef: { ref: "refs/tags/v1.4.0", commit: "c0ffee" } })
      )
    ).toMatchObject({
      determined: true,
      signal: "source_ref_tag",
      version: "v1.4.0",
      digest: null
    });
  });

  it("records NOTHING for a branch, an empty tag, or an absent ref", async () => {
    for (const ref of ["refs/heads/main", "refs/tags/", "", undefined]) {
      expect(
        await resolveReleasedVersion(
          input({ line: goLine, sourceRef: { ...(ref !== undefined ? { ref } : {}) } })
        )
      ).toMatchObject({ determined: false, reason: "go_ref_is_not_a_tag" });
    }
  });

  it("does NOT fall back to the commit — a sha parses as a version and would be confident nonsense", async () => {
    // `1a2b3c4d` parses as major 1 (see version.ts). A fallback here produces a wrong answer with
    // no error, which is the exact class this module exists to refuse.
    expect(
      await resolveReleasedVersion(
        input({ line: goLine, sourceRef: { ref: "refs/heads/main", commit: "1a2b3c4d" } })
      )
    ).toMatchObject({ determined: false, reason: "go_ref_is_not_a_tag" });
  });
});

describe("resolveReleasedVersion — a language version comes from the producer's own manifest", () => {
  const npmLine = { ecosystem: "npm", coordinate: "@acme/api" } as const;
  const npmInput = (overrides: Partial<ResolveReleasedVersionInput> = {}) =>
    input({
      line: npmLine,
      sourceRef: { repo: "acme/api", ref: "refs/heads/main", commit: "c0ffee" },
      manifestPaths: ["services/api/package.json"],
      ...overrides
    });

  it("reads package.json AT THE RELEASED COMMIT and records its `version`", async () => {
    const r = reader(() => found(JSON.stringify({ name: "@acme/api", version: "2.5.1" })));
    const result = await resolveReleasedVersion(npmInput({ readManifest: r.read }));

    expect(result).toMatchObject({
      determined: true,
      signal: "producer_manifest",
      version: "2.5.1",
      digest: null
    });
    // The COMMIT, not `refs/heads/main`: a branch name is not an identity and reading at one would
    // report whatever HEAD says now rather than what was released.
    expect(r.calls).toEqual([
      { repo: "acme/api", path: "services/api/package.json", ref: "c0ffee" }
    ]);
  });

  it("reads pyproject.toml and pom.xml through the same strategy", async () => {
    const py = reader(() => found('[project]\nname = "acme-api"\nversion = "3.1.0"\n'));
    expect(
      await resolveReleasedVersion(
        npmInput({
          line: { ecosystem: "python", coordinate: "acme-api" },
          manifestPaths: ["pyproject.toml"],
          readManifest: py.read
        })
      )
    ).toMatchObject({ determined: true, version: "3.1.0" });

    const mvn = reader(() =>
      found("<project><groupId>com.acme</groupId><version>4.0.2</version></project>")
    );
    expect(
      await resolveReleasedVersion(
        npmInput({
          line: { ecosystem: "maven", coordinate: "com.acme:api" },
          manifestPaths: ["pom.xml"],
          readManifest: mvn.read
        })
      )
    ).toMatchObject({ determined: true, version: "4.0.2" });
  });

  it("picks the manifest PATH out of the component's own inventory, and refuses when it has none", async () => {
    const r = reader(() => found(JSON.stringify({ version: "2.5.1" })));
    // A `Dockerfile` and a `requirements.txt` are in the inventory; neither states an npm version.
    expect(
      await resolveReleasedVersion(
        npmInput({ manifestPaths: ["Dockerfile", "requirements.txt"], readManifest: r.read })
      )
    ).toMatchObject({ determined: false, reason: "no_manifest_path_known" });
    // NEGATIVE CONTROL: nothing was fetched — the refusal is about the inventory, not a failed read.
    expect(r.calls).toEqual([]);
  });

  it("records NOTHING when no reader is wired — the honest shape of an unbuilt plugin-host route", async () => {
    expect(await resolveReleasedVersion(npmInput())).toMatchObject({
      determined: false,
      reason: "manifest_reader_unavailable"
    });
  });

  it("records NOTHING when the change carries no released commit", async () => {
    const r = reader(() => found(JSON.stringify({ version: "2.5.1" })));
    expect(
      await resolveReleasedVersion(
        npmInput({ sourceRef: { repo: "acme/api", ref: "refs/heads/main" }, readManifest: r.read })
      )
    ).toMatchObject({ determined: false, reason: "no_released_commit" });
    expect(r.calls).toEqual([]);
  });

  it("CATCHES a ManifestParseError instead of rejecting — a 404 body is a string too", async () => {
    // The caller contract in `@scp/dependency-manifests`' index.ts: unhandled, one bad fetch turns
    // the whole detection run into a rejected job; treated as empty, it reports a false absence.
    const r = reader(() => found("<!doctype html><title>404 Not Found</title>"));
    await expect(resolveReleasedVersion(npmInput({ readManifest: r.read }))).resolves.toMatchObject(
      { determined: false, reason: "manifest_unreadable" }
    );
  });

  it("CATCHES a THROWN reader (auth / 5xx / egress denial) instead of rejecting", async () => {
    const throwing: ManifestReader = async () => {
      throw new Error("github readFileAtRef: request failed at the transport");
    };
    await expect(
      resolveReleasedVersion(npmInput({ readManifest: throwing }))
    ).resolves.toMatchObject({ determined: false, reason: "manifest_unreadable" });
  });

  it("distinguishes not_found, refused, absent and unresolved — four different facts", async () => {
    const cases: [ReadFileAtRefResult, string][] = [
      [
        { outcome: "not_found", missing: "path", path: "p", requestedRef: "c0ffee" },
        "manifest_not_found"
      ],
      [
        {
          outcome: "refused",
          reason: "too_large",
          detail: "40 MB",
          path: "p",
          requestedRef: "c0ffee"
        },
        "manifest_unreadable"
      ],
      [found(JSON.stringify({ name: "@acme/api" })), "manifest_declares_no_version"]
    ];
    for (const [response, reason] of cases) {
      expect(
        await resolveReleasedVersion(npmInput({ readManifest: async () => response }))
      ).toMatchObject({ determined: false, reason });
    }

    // `unresolved` is the one that must NOT collapse into `absent`: the project HAS a version and
    // knowing it means running the build or reading a second document.
    expect(
      await resolveReleasedVersion(
        npmInput({
          line: { ecosystem: "maven", coordinate: "com.acme:api" },
          manifestPaths: ["pom.xml"],
          readManifest: async () =>
            found("<project><parent><version>1.0.0</version></parent></project>")
        })
      )
    ).toMatchObject({ determined: false, reason: "manifest_version_unresolved" });

    expect(
      await resolveReleasedVersion(
        npmInput({
          line: { ecosystem: "maven", coordinate: "com.acme:api" },
          manifestPaths: ["pom.xml"],
          readManifest: async () => found("<project><version>${revision}</version></project>")
        })
      )
    ).toMatchObject({ determined: false, reason: "manifest_version_unresolved" });
  });

  it("records NOTHING when two candidate manifests disagree", async () => {
    const versions: Record<string, string> = {
      "package.json": "1.0.0",
      "services/api/package.json": "2.5.1"
    };
    const result = await resolveReleasedVersion(
      npmInput({
        manifestPaths: ["package.json", "services/api/package.json"],
        readManifest: async (req) => found(JSON.stringify({ version: versions[req.path] }))
      })
    );
    expect(result).toMatchObject({ determined: false, reason: "ambiguous_manifest_versions" });

    // NEGATIVE CONTROL: two candidates that AGREE do determine a version, so the refusal above is
    // about the disagreement and not about there being two paths.
    expect(
      await resolveReleasedVersion(
        npmInput({
          manifestPaths: ["package.json", "services/api/package.json"],
          readManifest: async () => found(JSON.stringify({ version: "2.5.1" }))
        })
      )
    ).toMatchObject({ determined: true, version: "2.5.1" });
  });
});
