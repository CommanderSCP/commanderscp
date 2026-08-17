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
