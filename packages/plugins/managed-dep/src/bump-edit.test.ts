import { describe, expect, it } from "vitest";
import { applyManifestBump, verifyManifestBump, type ManifestBumpSpec } from "./bump-edit.js";

/**
 * These tests are the charter's `scp-managed-dep` prohibitions, one assertion each. They are written
 * against BYTES rather than against the editor's intentions on purpose: the verifier exists because
 * the thing that produces the edit lives in a separate image that this repository does not build, so
 * every test here supplies a hostile "runner output" directly and asserts the verdict.
 */

const npmSpec: ManifestBumpSpec = {
  ecosystem: "npm",
  coordinate: "@acme/lib",
  manifestPath: "package.json",
  fromVersion: "^1.2.3",
  toVersion: "^1.4.0"
};

const npmBefore = `{
  "name": "widget",
  "dependencies": {
    "@acme/lib": "^1.2.3",
    "left-pad": "^1.0.0"
  }
}`;

const goSpec: ManifestBumpSpec = {
  ecosystem: "go",
  coordinate: "github.com/acme/lib",
  manifestPath: "go.mod",
  fromVersion: "v1.2.3",
  toVersion: "v1.4.0"
};

const goBefore = `module github.com/acme/widget

go 1.22

require (
\tgithub.com/acme/lib v1.2.3
\tgithub.com/other/thing v0.9.0
)`;

const ociSpec: ManifestBumpSpec = {
  ecosystem: "oci",
  coordinate: "alpine",
  manifestPath: "Dockerfile",
  fromVersion: "3.18",
  toVersion: "3.19"
};

const ociBefore = `FROM alpine:3.18
RUN echo hello
`;

describe("applyManifestBump — the reference edit the runner image must agree with", () => {
  it("bumps an npm declared range in place, leaving every other byte alone", () => {
    const after = applyManifestBump(npmBefore, npmSpec);
    expect(after).toBe(npmBefore.replace('"@acme/lib": "^1.2.3"', '"@acme/lib": "^1.4.0"'));
  });

  it("bumps a go.mod require line", () => {
    expect(applyManifestBump(goBefore, goSpec)).toBe(
      goBefore.replace("github.com/acme/lib v1.2.3", "github.com/acme/lib v1.4.0")
    );
  });

  it("bumps a Dockerfile base-image tag", () => {
    expect(applyManifestBump(ociBefore, ociSpec)).toBe("FROM alpine:3.19\nRUN echo hello\n");
  });

  it("refuses (undefined) when the manifest does not declare what the inventory says it does", () => {
    expect(applyManifestBump(npmBefore, { ...npmSpec, fromVersion: "^9.9.9" })).toBeUndefined();
  });

  it("refuses (undefined) when two lines could be the edit target — a choice would be a guess", () => {
    const ambiguous = `${ociBefore}FROM alpine:3.18 AS second\n`;
    expect(applyManifestBump(ambiguous, ociSpec)).toBeUndefined();
  });
});

describe("verifyManifestBump — the refusal that stands between a runner and a repository", () => {
  it("accepts exactly the reference edit", () => {
    const after = applyManifestBump(npmBefore, npmSpec) as string;
    const verdict = verifyManifestBump(npmBefore, after, npmSpec);
    expect(verdict.ok).toBe(true);
  });

  it("refuses a runner that changed nothing", () => {
    const verdict = verifyManifestBump(npmBefore, npmBefore, npmSpec);
    expect(verdict).toMatchObject({ ok: false, reason: "unchanged" });
  });

  it("refuses a file that declares no such dependency at all (charter: never edits such a file)", () => {
    const unrelated = `{"name":"widget","dependencies":{"left-pad":"^1.0.0"}}`;
    const verdict = verifyManifestBump(unrelated, `${unrelated} `, npmSpec);
    expect(verdict).toMatchObject({ ok: false, reason: "coordinate_not_declared" });
  });

  it("refuses an ADDED dependency (line count grew)", () => {
    const after = npmBefore.replace(
      '"left-pad": "^1.0.0"',
      '"left-pad": "^1.0.0",\n    "sneaky": "^0.0.1"'
    );
    const verdict = verifyManifestBump(npmBefore, after, npmSpec);
    expect(verdict).toMatchObject({ ok: false, reason: "line_count_changed" });
  });

  it("refuses a REMOVED dependency (line count shrank)", () => {
    const after = npmBefore.replace('\n    "left-pad": "^1.0.0"', "");
    const verdict = verifyManifestBump(npmBefore, after, npmSpec);
    expect(verdict).toMatchObject({ ok: false, reason: "line_count_changed" });
  });

  it("refuses a second declaration changing alongside the intended one", () => {
    const after = (applyManifestBump(npmBefore, npmSpec) as string).replace(
      '"left-pad": "^1.0.0"',
      '"left-pad": "^2.0.0"'
    );
    const verdict = verifyManifestBump(npmBefore, after, npmSpec);
    expect(verdict).toMatchObject({ ok: false, reason: "multiple_lines_changed" });
  });

  it("refuses when the ONE changed line is a different declaration", () => {
    const after = npmBefore.replace('"left-pad": "^1.0.0"', '"left-pad": "^2.0.0"');
    const verdict = verifyManifestBump(npmBefore, after, npmSpec);
    expect(verdict).toMatchObject({ ok: false, reason: "wrong_declaration_changed" });
  });

  it("refuses when the inventory's declared version is not on the line (stale reading)", () => {
    const stale = { ...npmSpec, fromVersion: "^1.0.0" };
    const after = npmBefore.replace('"@acme/lib": "^1.2.3"', '"@acme/lib": "^1.4.0"');
    const verdict = verifyManifestBump(npmBefore, after, stale);
    expect(verdict).toMatchObject({ ok: false, reason: "from_version_not_on_line" });
  });

  it("refuses a coordinate swapped underneath the version — the includes() trap", () => {
    // `includes(toVersion)` would pass this: the target version IS present, on a line that IS the
    // right one in the before-image. Only RECONSTRUCTING the line catches that the package name was
    // swapped underneath it — which is why `non_version_edit`, not a set of includes() assertions,
    // is what answers here.
    const after = npmBefore.replace('"@acme/lib": "^1.2.3"', '"@evil/lib": "^1.4.0"');
    const verdict = verifyManifestBump(npmBefore, after, npmSpec);
    expect(verdict).toMatchObject({ ok: false, reason: "non_version_edit" });
  });

  it("refuses extra text appended to the changed line", () => {
    const after = npmBefore.replace(
      '"@acme/lib": "^1.2.3",',
      '"@acme/lib": "^1.4.0", "sneaky": "^0.0.1",'
    );
    const verdict = verifyManifestBump(npmBefore, after, npmSpec);
    expect(verdict).toMatchObject({ ok: false, reason: "non_version_edit" });
  });

  // THE TWO TESTS BELOW ARE THE REASON THE STRUCTURAL HALF EXISTS, and they are not hypothetical:
  // `toVersion` is derived from a THIRD-PARTY VERSION INDEX (ADR-0032 §7), so it is the one field in
  // the descriptor that an outside party influences. A version string that carries JSON syntax
  // passes the textual reconstruction BY CONSTRUCTION — the reconstruction's whole rule is "the
  // to-version token replaced the from-version token", and it did.

  it("refuses an injected version token that ADDS a dependency through valid JSON", () => {
    const injected = { ...npmSpec, toVersion: '^1.4.0", "evil": "1.0.0' };
    const after = applyManifestBump(npmBefore, injected) as string;
    expect(JSON.parse(after)).toBeTruthy(); // it really is valid JSON — the textual test cannot see it
    const verdict = verifyManifestBump(npmBefore, after, injected);
    expect(verdict).toMatchObject({ ok: false, reason: "declaration_set_changed" });
  });

  it("refuses an injected version token that leaves the manifest unparseable", () => {
    const injected = { ...npmSpec, toVersion: '^1.4.0"' };
    const after = applyManifestBump(npmBefore, injected) as string;
    const verdict = verifyManifestBump(npmBefore, after, injected);
    expect(verdict).toMatchObject({ ok: false, reason: "manifest_unparseable" });
  });

  it("accepts a go.mod and a Dockerfile edit through the same ecosystem-agnostic rule", () => {
    expect(
      verifyManifestBump(goBefore, applyManifestBump(goBefore, goSpec) as string, goSpec).ok
    ).toBe(true);
    expect(
      verifyManifestBump(ociBefore, applyManifestBump(ociBefore, ociSpec) as string, ociSpec).ok
    ).toBe(true);
  });

  it("STILL refuses a coordinate that is absent from the file, when no anchor was derived", () => {
    // The file-level clause is REPLACED in the anchored branch (a constructed `registry/repository`
    // coordinate is legitimately absent from the text), so this pins that it is still there in the
    // branch that has no anchor. Without it, "replaced in the anchored branch" could quietly become
    // "deleted".
    const unrelated = `{"name":"widget","dependencies":{"left-pad":"^1.0.0"}}`;
    expect(verifyManifestBump(unrelated, `${unrelated} `, npmSpec)).toMatchObject({
      ok: false,
      reason: "coordinate_not_declared"
    });
  });

  it("refuses a version string containing regex replacement syntax being mis-expanded", () => {
    // `$&` in a version would be expanded by String.replace; the verifier uses index/slice, so the
    // reconstruction is literal and this round-trips rather than silently corrupting.
    const spec: ManifestBumpSpec = {
      ecosystem: "python",
      coordinate: "acme-lib",
      manifestPath: "requirements.txt",
      fromVersion: "==1.0.0$&",
      toVersion: "==1.1.0"
    };
    const before = "acme-lib==1.0.0$&\nother==2.0.0\n";
    const after = "acme-lib==1.1.0\nother==2.0.0\n";
    expect(verifyManifestBump(before, after, spec).ok).toBe(true);
  });
});

/**
 * ================================================================================================
 * M21.7 — THE ANCHORED BRANCH: split-shape Helm images, and the veto that keeps it honest
 * ================================================================================================
 * Every fixture here is a values file whose coordinate and version are on DIFFERENT lines, which is
 * the shape both implementations refused outright before this round. The rule under test is:
 *
 *   the target is the anchor line, refused unless (a) the file's line at that index equals the
 *   anchor text byte-for-byte, (b) it carries `fromVersion`, and (c) the set of lines naming BOTH
 *   the coordinate and `fromVersion` is EMPTY or exactly {the anchor line}.
 *
 * The anchors below are written as literals rather than derived, on purpose: this module is the
 * REFUSAL, and it must be provable against a hostile descriptor as well as against a correct one.
 * `write-guard.test.ts` is where the derivation that produces them is tested, and
 * `runner-shim.test.ts` is where the real `run.sh` is required to agree with these same verdicts.
 */

/**
 * THE ADVERSARIAL VALUES FILE (`split-shape-image-bumps.md` §7). `1.2.3` appears FIVE times and only
 * ONE of them is the version of `acme/api`:
 *
 *   line  3  `imageTag`     — not an `image` key, so the parser never reads it
 *   line  7  `api.image.tag`      <- THE TARGET
 *   line 11  `worker.image.tag`   — a different image, pinned at the same version
 *   line 12  `appVersion`   — the chart's own version
 *   line 14  a pod LABEL
 *
 * Under the coordinate rule this file has ZERO candidates (no line names both `acme/api` and
 * `1.2.3`), which is why it was safe-but-useless before. Under the anchored rule the other five
 * occurrences are not disambiguated — they are never examined, because there are no candidates,
 * only an address.
 */
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

/** The `api.image.tag` line, 1-based, and its bytes. Line 7 by the listing above. */
const API_TAG_LINE = 7;
const API_TAG_TEXT = "    tag: 1.2.3";

const valuesSpec: ManifestBumpSpec = {
  ecosystem: "oci",
  coordinate: "acme/api",
  manifestPath: "chart/values.yaml",
  fromVersion: "1.2.3",
  toVersion: "1.2.4",
  anchor: { line: API_TAG_LINE, text: API_TAG_TEXT }
};

/** The same file with ONLY line `n` (1-based) replaced. Used to build hostile "runner output". */
function withLine(content: string, n: number, replacement: string): string {
  const out = content.split("\n");
  out[n - 1] = replacement;
  return out.join("\n");
}

describe("the anchored rule — a split-shape image becomes bumpable", () => {
  it("the fixture really is what the tests claim: six occurrences, and the coordinate rule is SILENT", () => {
    // A guard on the FIXTURE, not on the code. Every assertion below is about a file where the
    // textual rule finds nothing; if an edit to this fixture ever put the coordinate and the version
    // on one line, the split-shape tests would start passing through the old path and prove nothing.
    expect(VALUES.split("\n").filter((l) => l.includes("1.2.3"))).toHaveLength(5);
    expect(
      VALUES.split("\n").filter((l) => l.includes("acme/api") && l.includes("1.2.3"))
    ).toHaveLength(0);
    expect(VALUES.split("\n")[API_TAG_LINE - 1]).toBe(API_TAG_TEXT);
  });

  it("REFUSES the whole shape when no anchor is supplied — this is what changed", () => {
    const { anchor: _anchor, ...unanchored } = valuesSpec;
    expect(applyManifestBump(VALUES, unanchored)).toBeUndefined();
    // ...and the widening is not "the verifier got looser": with no anchor the verdict is still the
    // old one, on the very same bytes the anchored case accepts.
    const after = withLine(VALUES, API_TAG_LINE, "    tag: 1.2.4");
    expect(verifyManifestBump(VALUES, after, unanchored)).toMatchObject({
      ok: false,
      // `acme/api` IS in this file — on the `repository:` line — so the FILE-level clause passes and
      // it is the LINE-level clause 3 that refuses. That is precisely the gap: the coordinate is
      // declared here, just not where the version is.
      reason: "wrong_declaration_changed"
    });
  });

  it("edits the anchored line, leaving the five other `1.2.3` occurrences alone", () => {
    const after = applyManifestBump(VALUES, valuesSpec) as string;
    expect(after).toBe(withLine(VALUES, API_TAG_LINE, "    tag: 1.2.4"));
    // Named, not counted: the OTHER image and the chart's own version must both be untouched.
    expect(after.split("\n")[10]).toBe("    tag: 1.2.3");
    expect(after.split("\n")[11]).toBe("appVersion: 1.2.3");
    expect(verifyManifestBump(VALUES, after, valuesSpec)).toMatchObject({ ok: true });
  });

  it("SHAPE C: a coordinate that appears nowhere contiguously is still bumpable", () => {
    // `{registry, repository, tag}` — the coordinate `ghcr.io/acme/api` is a CONSTRUCTION, so the
    // file-level `before.includes(coordinate)` clause is FALSE for it. That clause has to be
    // replaced in the anchored branch rather than supplemented, and this is what says so: it would
    // otherwise refuse every such bump as `coordinate_not_declared`.
    const content = [
      "image:",
      "  registry: ghcr.io",
      "  repository: acme/api",
      "  tag: 1.2.3",
      ""
    ].join("\n");
    expect(content.includes("ghcr.io/acme/api")).toBe(false);
    const spec: ManifestBumpSpec = {
      ecosystem: "oci",
      coordinate: "ghcr.io/acme/api",
      manifestPath: "chart/values.yaml",
      fromVersion: "1.2.3",
      toVersion: "1.2.4",
      anchor: { line: 4, text: "  tag: 1.2.3" }
    };
    const after = applyManifestBump(content, spec) as string;
    expect(after).toBe(content.replace("tag: 1.2.3", "tag: 1.2.4"));
    expect(verifyManifestBump(content, after, spec)).toMatchObject({ ok: true });
  });
});

describe("the anchored rule — what it refuses (clause by clause)", () => {
  it("(a) refuses when the file's bytes at the anchor line are not the anchor text", () => {
    // A descriptor derived from a DIFFERENT revision of this file. The line number would still
    // address something, which is exactly why a bare line number is not enough.
    const stale: ManifestBumpSpec = {
      ...valuesSpec,
      anchor: { line: API_TAG_LINE, text: "    tag: 1.2.3   # pinned by ops" }
    };
    expect(applyManifestBump(VALUES, stale)).toBeUndefined();
    expect(
      verifyManifestBump(VALUES, withLine(VALUES, API_TAG_LINE, "    tag: 1.2.4"), stale)
    ).toMatchObject({ ok: false, reason: "anchor_text_mismatch" });
  });

  it("(a) refuses an anchor past the end of the file rather than reading undefined", () => {
    const past: ManifestBumpSpec = { ...valuesSpec, anchor: { line: 900, text: API_TAG_TEXT } };
    expect(applyManifestBump(VALUES, past)).toBeUndefined();
    expect(
      verifyManifestBump(VALUES, withLine(VALUES, API_TAG_LINE, "    tag: 1.2.4"), past)
    ).toMatchObject({ ok: false, reason: "anchor_text_mismatch" });
  });

  it("ADVERSARIAL: the runner edited the OTHER image's identical tag — the right path, wrong line", () => {
    // `worker.image.tag` (line 11) is byte-identical to the target line and carries the same
    // version, so a rule keyed on the version token alone cannot tell them apart. Addressing by line
    // can: the changed line is not the anchored one.
    const after = withLine(VALUES, 11, "    tag: 1.2.4");
    expect(verifyManifestBump(VALUES, after, valuesSpec)).toMatchObject({
      ok: false,
      reason: "anchor_line_not_changed"
    });
  });

  it("ADVERSARIAL: a multi-document values file edited at the right key in the WRONG document", () => {
    // Two documents, the same key path in each, the same coordinate and version. The parser
    // distinguishes them (`doc[0].image.tag` vs `doc[1].image.tag`) and so does the line number; a
    // rule that matched on the key path alone would not.
    const multi = [
      "image:",
      "  repository: acme/api",
      "  tag: 1.2.3",
      "---",
      "image:",
      "  repository: acme/api",
      "  tag: 1.2.3",
      ""
    ].join("\n");
    const spec: ManifestBumpSpec = {
      ecosystem: "oci",
      coordinate: "acme/api",
      manifestPath: "chart/values.yaml",
      fromVersion: "1.2.3",
      toVersion: "1.2.4",
      anchor: { line: 3, text: "  tag: 1.2.3" }
    };
    // The anchor names document ONE's tag; the runner edited document TWO's.
    expect(verifyManifestBump(multi, withLine(multi, 7, "  tag: 1.2.4"), spec)).toMatchObject({
      ok: false,
      reason: "anchor_line_not_changed"
    });
    // And the correctly-placed edit is accepted, so the refusal above is not "this file is refused".
    expect(verifyManifestBump(multi, withLine(multi, 3, "  tag: 1.2.4"), spec)).toMatchObject({
      ok: true
    });
  });

  it("(c) VETO: an anchor may not overrule a line that names both the coordinate and the version", () => {
    // A contiguous declaration lives at line 1 and the descriptor anchors somewhere else. Before the
    // anchor existed this file had exactly one answer, and the anchored mode must not be able to
    // produce a different one — the widening applies only where the textual rule is silent.
    const content = ["image: acme/api:1.2.3", "otherTag: 1.2.3", ""].join("\n");
    const spec: ManifestBumpSpec = {
      ecosystem: "oci",
      coordinate: "acme/api",
      manifestPath: "chart/values.yaml",
      fromVersion: "1.2.3",
      toVersion: "1.2.4",
      anchor: { line: 2, text: "otherTag: 1.2.3" }
    };
    expect(applyManifestBump(content, spec)).toBeUndefined();
    expect(
      verifyManifestBump(content, withLine(content, 2, "otherTag: 1.2.4"), spec)
    ).toMatchObject({ ok: false, reason: "coordinate_rule_disagrees" });
  });

  it("(c) VETO: an AMBIGUOUS coordinate rule refuses even when the anchor is one of the candidates", () => {
    // Two lines name both. That is the ambiguity the unanchored rule refuses today, and an anchor
    // must not be able to resolve it — "which declaration did the subscriber mean" is not a question
    // a line number derived from the same parse can answer.
    const content = ["image: acme/api:1.2.3", "sidecar: acme/api:1.2.3", ""].join("\n");
    const spec: ManifestBumpSpec = {
      ecosystem: "oci",
      coordinate: "acme/api",
      manifestPath: "chart/values.yaml",
      fromVersion: "1.2.3",
      toVersion: "1.2.4",
      anchor: { line: 1, text: "image: acme/api:1.2.3" }
    };
    expect(applyManifestBump(content, spec)).toBeUndefined();
    expect(
      verifyManifestBump(content, withLine(content, 1, "image: acme/api:1.2.4"), spec)
    ).toMatchObject({ ok: false, reason: "coordinate_rule_disagrees" });
  });

  it("(c) an anchor that AGREES with a speaking coordinate rule is accepted, and edits the same line", () => {
    // The negative control for the two above: the veto must not refuse everything it is asked
    // about. This is also the case D5 makes deliberate — the anchor is derived for the ecosystems
    // that already worked, so the veto is exercised code rather than a branch nothing reaches.
    const content = ["image: acme/api:1.2.3", "unrelated: true", ""].join("\n");
    const base = {
      ecosystem: "oci" as const,
      coordinate: "acme/api",
      manifestPath: "chart/values.yaml",
      fromVersion: "1.2.3",
      toVersion: "1.2.4"
    };
    const anchored: ManifestBumpSpec = {
      ...base,
      anchor: { line: 1, text: "image: acme/api:1.2.3" }
    };
    expect(applyManifestBump(content, anchored)).toBe(applyManifestBump(content, base));
    expect(
      verifyManifestBump(content, applyManifestBump(content, anchored) as string, anchored)
    ).toMatchObject({ ok: true });
  });
});

describe("the anchored rule — the clauses it did NOT replace still refuse", () => {
  const good = withLine(VALUES, API_TAG_LINE, "    tag: 1.2.4");

  it("clause 1: a line added or removed is still `line_count_changed`", () => {
    expect(verifyManifestBump(VALUES, `${good}extra: true\n`, valuesSpec)).toMatchObject({
      ok: false,
      reason: "line_count_changed"
    });
  });

  it("clause 2: a second line moving alongside the anchored one is still `multiple_lines_changed`", () => {
    const two = withLine(good, 11, "    tag: 1.2.4");
    expect(verifyManifestBump(VALUES, two, valuesSpec)).toMatchObject({
      ok: false,
      reason: "multiple_lines_changed"
    });
  });

  it("a byte-identical return is still `unchanged`", () => {
    expect(verifyManifestBump(VALUES, VALUES, valuesSpec)).toMatchObject({
      ok: false,
      reason: "unchanged"
    });
  });

  it("clause (b): an anchor line that does not carry the declared version is refused", () => {
    // The stale-inventory case, measured on the ANCHOR line because the changed line has already
    // been proven to be it. `repository:` is a real line of a real image block and carries no
    // version at all.
    const spec: ManifestBumpSpec = {
      ...valuesSpec,
      anchor: { line: 6, text: "    repository: acme/api" }
    };
    expect(applyManifestBump(VALUES, spec)).toBeUndefined();
    expect(
      verifyManifestBump(VALUES, withLine(VALUES, 6, "    repository: acme/api2"), spec)
    ).toMatchObject({ ok: false, reason: "from_version_not_on_line" });
  });

  it("ADVERSARIAL clause 4: the right line, the right version, and an extra token appended", () => {
    // `includes(toVersion)` is satisfied by this. Only rebuilding the line from the BEFORE bytes and
    // comparing byte-for-byte catches it, and that clause is untouched by the anchoring.
    const sneaky = withLine(VALUES, API_TAG_LINE, "    tag: 1.2.4 # and pullPolicy: Always");
    expect(sneaky.includes("1.2.4")).toBe(true);
    expect(verifyManifestBump(VALUES, sneaky, valuesSpec)).toMatchObject({
      ok: false,
      reason: "non_version_edit"
    });
  });

  it("ADVERSARIAL clause 4: the right line, the right version, and the KEY renamed underneath it", () => {
    // The anchored branch checks the line's IDENTITY on the BEFORE side; clause 4 is what checks
    // what the AFTER side made of it. Renaming `tag` to `imageTag` would silently unpin the image
    // (the parser stops reading it, so the next ingestion prunes the row) while the version token
    // moved exactly as asked.
    const renamed = withLine(VALUES, API_TAG_LINE, "    imageTag: 1.2.4");
    expect(verifyManifestBump(VALUES, renamed, valuesSpec)).toMatchObject({
      ok: false,
      reason: "non_version_edit"
    });
  });
});
