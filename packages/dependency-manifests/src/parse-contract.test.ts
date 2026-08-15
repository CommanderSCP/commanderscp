/**
 * THE THROW/NO-THROW CONTRACT OF THE PACKAGE'S PUBLIC ENTRY POINT.
 *
 * M21.2 changed `parseGoMod` and `parseDockerfile` from returning `[]` to throwing
 * {@link ManifestParseError} on unreadable content, and the empty string went with them. Nothing
 * consumes this package yet, so nothing broke — which is exactly why it needed pinning now: M21.3's
 * ingestion caller is the first consumer, it is being written by a different agent from a different
 * context, and the only thing standing between it and an unhandled rejection on a 404 body is that
 * this contract is (a) documented where a caller reading `index.ts` cannot miss it and (b) asserted
 * somewhere that goes red if it drifts.
 *
 * Two properties are asserted here that the per-parser suites structurally cannot:
 *
 * 1. **Imported from `./index.js`, not from the modules.** The per-parser tests import
 *    `./go-mod.js` directly, so they would stay green if an export were dropped from the entry
 *    point. The contract belongs to what a consumer can actually reach.
 * 2. **Same input across all six.** Each parser's own suite proves its own throw with its own
 *    fixture; none of them proves the six agree on a SHARED input. `""` is that input, and it is
 *    the one an ingestion caller hits first (an empty file, an empty 200 body, a deleted path).
 *
 * NEGATIVE CONTROL is `parseRequirementsTxt`, which must NOT throw. Without it every assertion here
 * is satisfied by a package that throws on everything — the vacuous-test shape where an assertion of
 * a behaviour is met for the wrong reason.
 */
import { describe, expect, it } from "vitest";

import {
  ManifestParseError,
  parseDockerfile,
  parseGoMod,
  parsePackageJson,
  parsePomXml,
  parsePyprojectToml,
  parseRequirementsTxt
} from "./index.js";

/** The five that refuse unreadable content, with an input that is not their format. */
const THROWING: ReadonlyArray<readonly [string, (content: string) => unknown, string]> = [
  ["parsePackageJson", parsePackageJson, "<!doctype html><title>404</title>"],
  ["parseGoMod", parseGoMod, "<!doctype html><title>404</title>"],
  [
    "parseDockerfile",
    parseDockerfile,
    "version https://git-lfs.github.com/spec/v1\noid sha256:ab\n"
  ],
  ["parsePyprojectToml", parsePyprojectToml, "<!doctype html><title>404</title>"],
  ["parsePomXml", parsePomXml, "<!doctype html><title>404</title>"]
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
