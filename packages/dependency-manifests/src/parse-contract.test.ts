/** The throw or no-throw contract of the entry point. See docs/dependency-manifests.md §61. */
import { describe, expect, it } from "vitest";

import {
  ManifestParseError,
  parseDockerfile,
  parseGoMod,
  parseKubernetesImages,
  parsePackageJson,
  parsePomXml,
  parsePyprojectToml,
  parseRequirementsTxt
} from "./index.js";

/** The six that refuse unreadable content, with an input that is not their format. */
const THROWING: ReadonlyArray<readonly [string, (content: string) => unknown, string]> = [
  ["parsePackageJson", parsePackageJson, "<!doctype html><title>404</title>"],
  ["parseGoMod", parseGoMod, "<!doctype html><title>404</title>"],
  [
    "parseDockerfile",
    parseDockerfile,
    "version https://git-lfs.github.com/spec/v1\noid sha256:ab\n"
  ],
  ["parsePyprojectToml", parsePyprojectToml, "<!doctype html><title>404</title>"],
  ["parsePomXml", parsePomXml, "<!doctype html><title>404</title>"],
  // The interesting member: a 404 body is valid YAML. See docs/dependency-manifests.md §62.
  ["parseKubernetesImages", parseKubernetesImages, "<!doctype html><title>404</title>"]
];

describe("manifest parser throw contract (as reached through the entry point)", () => {
  it.each(THROWING)(
    "%s throws ManifestParseError on content that is not its format",
    (_n, fn, bad) => {
      expect(() => fn(bad)).toThrow(ManifestParseError);
    }
  );

  it.each(THROWING)(
    "%s throws on the EMPTY STRING rather than reporting zero dependencies",
    (_n, fn) => {
      // The case most likely to reach an ingestion caller and the one most likely to be assumed
      // benign. `[]` here would mean "this component declares nothing", which is what would be
      // written over its real inventory.
      expect(() => fn("")).toThrow(ManifestParseError);
    }
  );

  it("NEGATIVE CONTROL: a values file that is only comments does NOT throw", () => {
    // The second exception to the throw rule, and it is a SHAPE rather than a parser: YAML's honest
    // empty is a file with no documents at all. Without this, "requires a mapping root" would
    // report every chart whose values are commented out as `unreadable` — forever, since re-reading
    // changes nothing, which is the wrong operator action.
    expect(parseKubernetesImages("# every value is commented out\n")).toEqual([]);
  });

  it("NEGATIVE CONTROL: parseRequirementsTxt does not throw, on empty or on junk", () => {
    // A requirements.txt has no required construct, so there is nothing whose absence proves the
    // file is not one — it is the documented exception in `index.ts`, not an oversight. If this
    // ever starts throwing, the table in `index.ts` is wrong and M21.3 will not be catching it.
    expect(parseRequirementsTxt("")).toEqual([]);
    expect(parseRequirementsTxt("<!doctype html><title>404</title>")).toEqual([]);
  });

  it("NEGATIVE CONTROL: a well-formed manifest of each kind still returns rows", () => {
    // Otherwise every assertion above is satisfied by six functions that throw unconditionally.
    expect(parsePackageJson('{"dependencies":{"left-pad":"1.3.0"}}')).toHaveLength(1);
    expect(parseGoMod("module m\n\nrequire example.com/x v1.2.3\n")).toHaveLength(1);
    expect(parseDockerfile("FROM alpine:3.20\n")).toHaveLength(1);
    expect(parseKubernetesImages("image: acme/api:1.2.3\n")).toHaveLength(1);
    expect(parsePyprojectToml('[project]\ndependencies = ["requests>=2.31"]\n')).toHaveLength(1);
    expect(
      parsePomXml(
        "<project><dependencies><dependency><groupId>g</groupId>" +
          "<artifactId>a</artifactId><version>1.0</version></dependency></dependencies></project>"
      )
    ).toHaveLength(1);
    expect(parseRequirementsTxt("requests==2.32.3\n")).toHaveLength(1);
  });
});
