import { describe, expect, it } from "vitest";
import { ManifestParseError } from "./types.js";
import { readDeclaredProjectVersion } from "./own-version.js";

/**
 * The PRODUCER-side reader (M21.4, ADR-0032 §7a).
 *
 * The property under test throughout is the THREE-WAY OUTCOME. `declared`, `absent` and
 * `unresolved` are three different facts about a repository, and every collapse between them is a
 * lie a caller cannot detect:
 *
 *   - `unresolved` collapsed into `absent`  ⇒ "this project has no version", of a project that has
 *     one, sending whoever reads the Decision to look in the wrong place;
 *   - `absent` collapsed into a THROW       ⇒ "we could not read the manifest", of a manifest we
 *     read perfectly well;
 *   - a THROW collapsed into `absent`       ⇒ a 404 HTML body reported as "declares no version".
 *
 * So each case below asserts the DISCRIMINANT, not merely that something non-fatal came back.
 *
 * MUTATION LOG — applied, watched fail, reverted, watched pass:
 * | Mutation | Result |
 * |---|---|
 * | maven: take the first `<version>` in document order (drop the `<project>`-depth check) | "never mistakes a DEPENDENCY's or the PARENT's version" FAILS with `1.0.0-parent`, and the inherited case FAILS too |
 * | report an inherited/`dynamic` version as `absent` instead of `unresolved` | both "unresolved, not absent" cases FAIL — the collapse this file exists to prevent |
 */
describe("readDeclaredProjectVersion — npm", () => {
  it("reads `version`, and reports its absence as absent rather than as a failure", () => {
    expect(readDeclaredProjectVersion("npm", '{"name":"@acme/api","version":"2.5.1"}')).toEqual({
      outcome: "declared",
      version: "2.5.1",
      declaredIn: "version"
    });
    // A workspace root: readable, private, and genuinely without a version of its own.
    expect(readDeclaredProjectVersion("npm", '{"name":"root","private":true}')).toMatchObject({
      outcome: "absent"
    });
    // Readable, but the field is unusable. Still `absent` — throwing would report a read failure
    // that did not happen.
    expect(readDeclaredProjectVersion("npm", '{"version":42}')).toMatchObject({
      outcome: "absent"
    });
  });

  it("THROWS on content that is not a package.json at all", () => {
    // The bodies a manifest fetch actually returns when it goes wrong — each arrives as a string.
    expect(() => readDeclaredProjectVersion("npm", "<!doctype html><title>404</title>")).toThrow(
      ManifestParseError
    );
    expect(() => readDeclaredProjectVersion("npm", "")).toThrow(ManifestParseError);
    expect(() => readDeclaredProjectVersion("npm", "[1,2,3]")).toThrow(ManifestParseError);
    expect(() =>
      readDeclaredProjectVersion(
        "npm",
        "version https://git-lfs.github.com/spec/v1\noid sha256:ab\nsize 12\n"
      )
    ).toThrow(ManifestParseError);
  });
});

describe("readDeclaredProjectVersion — python", () => {
  it("reads PEP 621 `[project] version`, then Poetry's", () => {
    expect(
      readDeclaredProjectVersion("python", '[project]\nname = "acme"\nversion = "3.1.0"\n')
    ).toMatchObject({ outcome: "declared", version: "3.1.0", declaredIn: "project.version" });
    expect(
      readDeclaredProjectVersion("python", '[tool.poetry]\nname = "acme"\nversion = "0.9.2"\n')
    ).toMatchObject({ outcome: "declared", version: "0.9.2", declaredIn: "tool.poetry.version" });
  });

  it("reports a PEP 621 DYNAMIC version as unresolved, never as absent", () => {
    // setuptools-scm / hatch-vcs: the project HAS a version and the build backend computes it.
    // Determining it means running the backend — ADR-0032 §8, ADR-0002 gate 5.
    const outcome = readDeclaredProjectVersion(
      "python",
      '[project]\nname = "acme"\ndynamic = ["version"]\n'
    );
    expect(outcome.outcome).toBe("unresolved");
    expect(outcome.outcome === "unresolved" && outcome.detail).toMatch(/build backend/);

    // NEGATIVE CONTROL: a `dynamic` list that does NOT contain "version" is not this case, and a
    // project that simply declares nothing is `absent`.
    expect(
      readDeclaredProjectVersion("python", '[project]\ndynamic = ["readme"]\nversion = "1.0"\n')
    ).toMatchObject({ outcome: "declared", version: "1.0" });
    expect(readDeclaredProjectVersion("python", '[project]\nname = "acme"\n')).toMatchObject({
      outcome: "absent"
    });
  });

  it("THROWS on content with no TOML in it at all", () => {
    expect(() => readDeclaredProjectVersion("python", "")).toThrow(ManifestParseError);
    expect(() => readDeclaredProjectVersion("python", "# just a comment\n")).toThrow(
      ManifestParseError
    );
  });
});

describe("readDeclaredProjectVersion — maven", () => {
  it("reads the DIRECT <version> child of <project>", () => {
    expect(
      readDeclaredProjectVersion(
        "maven",
        `<?xml version="1.0"?>
         <project xmlns="http://maven.apache.org/POM/4.0.0">
           <groupId>com.acme</groupId>
           <artifactId>api</artifactId>
           <version>4.0.2</version>
         </project>`
      )
    ).toMatchObject({ outcome: "declared", version: "4.0.2" });
  });

  it("never mistakes a DEPENDENCY's or the PARENT's version for the project's", () => {
    // Both of these are `<version>` elements and neither is the project's. Reading the first
    // `<version>` in document order would return `1.0.0-parent` here and `9.9.9` below.
    expect(
      readDeclaredProjectVersion(
        "maven",
        `<project>
           <parent><groupId>com.acme</groupId><version>1.0.0-parent</version></parent>
           <version>4.0.2</version>
           <dependencies><dependency><artifactId>lib</artifactId><version>9.9.9</version></dependency></dependencies>
         </project>`
      )
    ).toMatchObject({ outcome: "declared", version: "4.0.2" });
  });

  it("reports an INHERITED version as unresolved, not absent", () => {
    const outcome = readDeclaredProjectVersion(
      "maven",
      "<project><parent><version>1.0.0</version></parent><artifactId>api</artifactId></project>"
    );
    expect(outcome.outcome).toBe("unresolved");
    expect(outcome.outcome === "unresolved" && outcome.detail).toMatch(/inherited/);

    // NEGATIVE CONTROL: no parent and no version is genuinely `absent` — the two must not collapse,
    // because "go read the parent POM" and "there is nothing to read" are different instructions.
    expect(
      readDeclaredProjectVersion("maven", "<project><artifactId>api</artifactId></project>")
    ).toMatchObject({ outcome: "absent" });
  });

  it("reports a ${property} version as unresolved", () => {
    expect(
      readDeclaredProjectVersion("maven", "<project><version>${revision}</version></project>")
    ).toMatchObject({ outcome: "unresolved" });
  });

  it("handles namespace prefixes, comments and CDATA the way pom-xml.ts does", () => {
    expect(
      readDeclaredProjectVersion(
        "maven",
        `<mvn:project><!-- <version>0.0.0</version> --><mvn:version><![CDATA[5.1.0]]></mvn:version></mvn:project>`
      )
    ).toMatchObject({ outcome: "declared", version: "5.1.0" });
  });

  it("THROWS on a truncated or mis-nested document — a read failure is not an absent version", () => {
    // The one that matters most: a response cut off mid-document would otherwise report "this
    // project declares no version", and a caller would record that as a fact about the repo.
    expect(() => readDeclaredProjectVersion("maven", "<project><version>4.0.2</version>")).toThrow(
      ManifestParseError
    );
    expect(() =>
      readDeclaredProjectVersion("maven", "<project><version>4.0.2</wrong></project>")
    ).toThrow(ManifestParseError);
    expect(() => readDeclaredProjectVersion("maven", "<!doctype html><title>404</title>")).toThrow(
      ManifestParseError
    );
  });
});
