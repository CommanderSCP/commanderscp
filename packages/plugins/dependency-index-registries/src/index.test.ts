/**
 * Every HTTP call here is fixtured with `nock` against RECORDED, REAL response shapes — a Go module
 * proxy `@v/list` text body, an abbreviated npm packument, PyPI's JSON API with a yanked release,
 * and a real `maven-metadata.xml`. `nock.disableNetConnect()` is active for the whole file, so any
 * call a fixture does not cover fails loudly instead of reaching the internet (CLAUDE.md: "Tests
 * never touch the internet").
 *
 * The shapes are not invented. Each fixture below carries a comment naming the field it exercises
 * and why that field matters — a fixture built from a guess would prove the parser reads the
 * fixture, which is the vacuous-test shape this repo has already been bitten by.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import nock from "nock";
import {
  createGoIndexPlugin,
  createMavenIndexPlugin,
  createNpmIndexPlugin,
  createPypiIndexPlugin,
  escapeGoModulePath,
  encodeNpmName,
  mavenMetadataPath,
  parseMavenMetadataVersions
} from "./index.js";
import { classifyTransportError, isRedirectError } from "./common.js";
import { createTestContext } from "./test-support.js";

const GO_BASE = "https://goproxy.internal";
const NPM_BASE = "https://npm.internal";
const PYPI_BASE = "https://pypi.internal";
const MAVEN_BASE = "https://maven.internal";

beforeAll(() => {
  nock.disableNetConnect();
});
afterEach(() => {
  nock.cleanAll();
});
afterAll(() => {
  nock.enableNetConnect();
});

describe("the air-gap default: an unconfigured index reports UNAVAILABLE, never an empty list", () => {
  // ADR-0032 §7. This is the property that keeps a disconnected estate distinguishable from an
  // up-to-date one; `versions: []` here would silently stop every dependency subscription.
  it.each([
    ["go", createGoIndexPlugin()],
    ["npm", createNpmIndexPlugin()],
    ["python", createPypiIndexPlugin()],
    ["maven", createMavenIndexPlugin()]
  ])("%s", async (_name, plugin) => {
    const result = await plugin.listVersions(createTestContext({}), {
      ecosystem: "go",
      coordinate: "example.com/x",
      majorLine: "v1"
    });
    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") throw new Error("unreachable");
    expect(result.reason).toBe("not_configured");
    // The remedy has to be READABLE, not inferrable.
    expect(result.detail).toMatch(/SCP_DEPENDENCY_INDEX_/);
  });

  it("and no language index ever claims a content digest", async () => {
    for (const plugin of [
      createGoIndexPlugin(),
      createNpmIndexPlugin(),
      createPypiIndexPlugin(),
      createMavenIndexPlugin()
    ]) {
      expect(plugin.describeIndex().reportsDigest).toBe(false);
      const digest = await plugin.resolveDigest(createTestContext({ baseUrl: GO_BASE }), {
        ecosystem: "go",
        coordinate: "example.com/x",
        version: "v1.0.0"
      });
      expect(digest).toMatchObject({ status: "unavailable", reason: "no_digest" });
    }
  });
});

describe("Go module proxy", () => {
  it("reads the real text/plain @v/list body, and escapes the module path the protocol's way", async () => {
    // REAL SHAPE: the goproxy `/@v/list` endpoint returns text/plain, one version per line,
    // UNORDERED. The path is case-encoded (`Masterminds` -> `!masterminds`), which the real
    // proxy.golang.org REQUIRES — without it a capitalised module 404s.
    const scope = nock(GO_BASE)
      .get("/github.com/!masterminds/semver/v3/@v/list")
      .reply(200, "v3.2.1\nv3.1.1\nv3.2.0\n", { "content-type": "text/plain" });

    const result = await createGoIndexPlugin().listVersions(
      createTestContext({ baseUrl: GO_BASE }),
      { ecosystem: "go", coordinate: "github.com/Masterminds/semver/v3", majorLine: "v3" }
    );

    expect(scope.isDone()).toBe(true);
    expect(result).toEqual({
      status: "available",
      // VERBATIM and in the index's own order — this plugin does not rank (ADR-0032 §7).
      versions: [{ version: "v3.2.1" }, { version: "v3.1.1" }, { version: "v3.2.0" }]
    });
  });

  it("an EMPTY list body is 'available with zero versions', not malformed", async () => {
    // A module with no tagged release really does return an empty body. That is a true fact about
    // the line, and it must not be reported as a broken index.
    nock(GO_BASE)
      .get("/example.com/untagged/@v/list")
      .reply(200, "", { "content-type": "text/plain" });
    const result = await createGoIndexPlugin().listVersions(
      createTestContext({ baseUrl: GO_BASE }),
      { ecosystem: "go", coordinate: "example.com/untagged", majorLine: "v1" }
    );
    expect(result).toEqual({ status: "available", versions: [] });
  });

  it("a 404 is unknown_coordinate, not unreachable", async () => {
    nock(GO_BASE).get("/example.com/nope/@v/list").reply(404, "not found");
    const result = await createGoIndexPlugin().listVersions(
      createTestContext({ baseUrl: GO_BASE }),
      { ecosystem: "go", coordinate: "example.com/nope", majorLine: "v1" }
    );
    expect(result).toMatchObject({ status: "unavailable", reason: "unknown_coordinate" });
  });

  it("escapeGoModulePath is the protocol's rule, not a lowercase()", () => {
    expect(escapeGoModulePath("github.com/Masterminds/semver/v3")).toBe(
      "github.com/!masterminds/semver/v3"
    );
    expect(escapeGoModulePath("github.com/BurntSushi/toml")).toBe("github.com/!burnt!sushi/toml");
    // NEGATIVE CONTROL: an all-lowercase path is untouched, so the test above is not satisfied by
    // any transformation that merely lowercases.
    expect(escapeGoModulePath("github.com/stretchr/testify")).toBe("github.com/stretchr/testify");
  });
});

describe("npm registry", () => {
  it("reads the abbreviated packument's `versions` keys and IGNORES dist-tags.latest", async () => {
    // REAL SHAPE of `application/vnd.npm.install-v1+json`. `dist-tags.latest` here is 5.0.0 — a
    // DIFFERENT major line from the one being asked about, which is exactly why reading it would
    // put an off-line version forward as this line's head.
    const scope = nock(NPM_BASE)
      .get("/@acme%2flib")
      .matchHeader("accept", "application/vnd.npm.install-v1+json")
      .reply(200, {
        name: "@acme/lib",
        "dist-tags": { latest: "5.0.0", next: "6.0.0-rc.1" },
        versions: {
          "4.17.20": {
            name: "@acme/lib",
            version: "4.17.20",
            dist: { tarball: "https://x/a.tgz" }
          },
          "4.17.21": {
            name: "@acme/lib",
            version: "4.17.21",
            dist: { tarball: "https://x/b.tgz" }
          },
          "5.0.0": { name: "@acme/lib", version: "5.0.0", dist: { tarball: "https://x/c.tgz" } }
        }
      });

    const result = await createNpmIndexPlugin().listVersions(
      createTestContext({ baseUrl: NPM_BASE }),
      { ecosystem: "npm", coordinate: "@acme/lib", majorLine: "4" }
    );

    expect(scope.isDone()).toBe(true);
    expect(result).toEqual({
      status: "available",
      // All three, unfiltered — the SERVER decides which are on the v4 line, not this plugin.
      versions: [{ version: "4.17.20" }, { version: "4.17.21" }, { version: "5.0.0" }]
    });
  });

  it("a document with no `versions` object is malformed_response, never an empty answer", async () => {
    nock(NPM_BASE).get("/lodash").reply(200, { error: "Not found" });
    const result = await createNpmIndexPlugin().listVersions(
      createTestContext({ baseUrl: NPM_BASE }),
      { ecosystem: "npm", coordinate: "lodash", majorLine: "4" }
    );
    expect(result).toMatchObject({ status: "unavailable", reason: "malformed_response" });
  });

  it("encodeNpmName encodes the scope slash and nothing else", () => {
    expect(encodeNpmName("@acme/lib")).toBe("@acme%2flib");
    // NEGATIVE CONTROL: an unscoped name must survive untouched (encodeURIComponent would not).
    expect(encodeNpmName("lodash")).toBe("lodash");
  });
});

describe("PyPI JSON API", () => {
  it("excludes fully-yanked releases and file-less releases, on the index's OWN say-so", async () => {
    // REAL SHAPE: `releases` maps a version to its file list; each file carries PEP 592's `yanked`.
    // `0.0.1` with `[]` is a registered-but-unpublished version PyPI really does return.
    const scope = nock(PYPI_BASE)
      .get("/pypi/requests/json")
      .reply(200, {
        info: { name: "requests", version: "2.31.0" },
        releases: {
          "2.30.0": [{ filename: "requests-2.30.0-py3-none-any.whl", yanked: false }],
          "2.31.0": [{ filename: "requests-2.31.0-py3-none-any.whl", yanked: false }],
          "2.29.0": [{ filename: "requests-2.29.0-py3-none-any.whl", yanked: true }],
          "0.0.1": []
        }
      });

    const result = await createPypiIndexPlugin().listVersions(
      createTestContext({ baseUrl: PYPI_BASE }),
      { ecosystem: "python", coordinate: "requests", majorLine: "2" }
    );

    expect(scope.isDone()).toBe(true);
    expect(result).toEqual({
      status: "available",
      versions: [{ version: "2.30.0" }, { version: "2.31.0" }]
    });
  });

  it("a release whose files are only PARTLY yanked is still offered", async () => {
    // NEGATIVE CONTROL for the exclusion above: the rule is "every file yanked", not "any file
    // yanked" — a wheel yanked while the sdist stands is still an installable release.
    nock(PYPI_BASE)
      .get("/pypi/partly/json")
      .reply(200, {
        releases: {
          "1.0.0": [
            { filename: "partly-1.0.0.whl", yanked: true },
            { filename: "partly-1.0.0.tar.gz", yanked: false }
          ]
        }
      });
    const result = await createPypiIndexPlugin().listVersions(
      createTestContext({ baseUrl: PYPI_BASE }),
      { ecosystem: "python", coordinate: "partly", majorLine: "1" }
    );
    expect(result).toEqual({ status: "available", versions: [{ version: "1.0.0" }] });
  });
});

describe("Maven repository", () => {
  const METADATA = `<?xml version="1.0" encoding="UTF-8"?>
<metadata>
  <groupId>org.springframework</groupId>
  <artifactId>spring-core</artifactId>
  <versioning>
    <latest>6.1.4</latest>
    <release>6.1.4</release>
    <versions>
      <version>5.3.31</version>
      <version>6.1.3</version>
      <version>6.1.4</version>
    </versions>
    <lastUpdated>20240215120000</lastUpdated>
  </versioning>
</metadata>`;

  it("reads the <versions> block of a real maven-metadata.xml", async () => {
    const scope = nock(MAVEN_BASE)
      .get("/org/springframework/spring-core/maven-metadata.xml")
      .reply(200, METADATA, { "content-type": "text/xml" });

    const result = await createMavenIndexPlugin().listVersions(
      createTestContext({ baseUrl: MAVEN_BASE }),
      { ecosystem: "maven", coordinate: "org.springframework:spring-core", majorLine: "6" }
    );

    expect(scope.isDone()).toBe(true);
    expect(result).toEqual({
      status: "available",
      versions: [{ version: "5.3.31" }, { version: "6.1.3" }, { version: "6.1.4" }]
    });
  });

  it("<latest>/<release> are NOT folded into the candidate set", () => {
    // The document above names 6.1.4 three times: once in <versions> and twice as a sibling
    // pointer. A document-wide scan would return four entries; the block-scoped one returns three.
    expect(parseMavenMetadataVersions(METADATA)).toEqual(["5.3.31", "6.1.3", "6.1.4"]);
  });

  it("a document with no <versions> block is malformed, NOT 'no versions'", () => {
    expect(parseMavenMetadataVersions("<metadata><groupId>a</groupId></metadata>")).toBeNull();
    // NEGATIVE CONTROL: an EMPTY <versions> block is a real artifact with no releases — [] not null.
    expect(parseMavenMetadataVersions("<metadata><versions></versions></metadata>")).toEqual([]);
  });

  it("a coordinate that is not groupId:artifactId is refused, never turned into a plausible path", async () => {
    expect(mavenMetadataPath("org.springframework:spring-core")).toBe(
      "org/springframework/spring-core/maven-metadata.xml"
    );
    expect(mavenMetadataPath("spring-core")).toBeNull();
    expect(mavenMetadataPath("g:a:1.0")).toBeNull();
    const result = await createMavenIndexPlugin().listVersions(
      createTestContext({ baseUrl: MAVEN_BASE }),
      { ecosystem: "maven", coordinate: "spring-core", majorLine: "6" }
    );
    expect(result).toMatchObject({ status: "unavailable", reason: "unknown_coordinate" });
  });
});

describe("HAZARD: redirects are hard-disabled on the plugin HTTP client", () => {
  it("a 3xx status is its OWN reason, with the remedy in the detail", async () => {
    // Public registries redirect routinely, and `subprocess-entry.ts` passes `redirect: "error"` on
    // BOTH fetch branches. Reporting this as `unreachable` sends an operator to the firewall for a
    // problem whose fix is "point me at the final url".
    nock(NPM_BASE).get("/lodash").reply(301, "", { location: "https://registry.npmjs.org/lodash" });
    const result = await createNpmIndexPlugin().listVersions(
      createTestContext({ baseUrl: NPM_BASE }),
      { ecosystem: "npm", coordinate: "lodash", majorLine: "4" }
    );
    expect(result).toMatchObject({ status: "unavailable", reason: "redirected" });
    if (result.status !== "unavailable") throw new Error("unreachable");
    expect(result.detail).toMatch(/final url/i);
  });

  it("the THROWN redirect is found through the cause chain, not only in the top message", () => {
    // Node's fetch with `redirect: "error"` rejects with a bland `TypeError: fetch failed` and puts
    // `unexpected redirect` in `.cause`. A classifier that read only `err.message` would call every
    // redirect `unreachable` — the exact silent misdirection this reason exists to prevent.
    const nested = new TypeError("fetch failed", { cause: new Error("unexpected redirect") });
    expect(isRedirectError(nested)).toBe(true);
    expect(classifyTransportError(nested, "https://x/y").reason).toBe("redirected");

    // NEGATIVE CONTROL: an ordinary connect failure must NOT be classified as a redirect.
    const refused = new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
    expect(isRedirectError(refused)).toBe(false);
    expect(classifyTransportError(refused, "https://x/y").reason).toBe("unreachable");
  });
});

describe("HAZARD: the chart's egress is default-deny, so this reads as a plugin error", () => {
  it("an unreachable index names the NetworkPolicy where the operator has to go", () => {
    const refused = new TypeError("fetch failed", {
      cause: new Error("connect ECONNREFUSED 10.0.0.1:443")
    });
    const result = classifyTransportError(refused, "https://npm.internal/lodash");
    expect(result.reason).toBe("unreachable");
    expect(result.detail).toMatch(/NetworkPolicy/);
    expect(result.detail).toMatch(/executorEgress/);
    expect(result.detail).toMatch(/DEFAULT-DENY/);
  });

  it("an egress-guard refusal names the ALLOWLIST rather than the network", () => {
    const blocked = new Error("egress to 'npm.internal' is not allowed for this plugin instance");
    const result = classifyTransportError(blocked, "https://npm.internal/lodash");
    expect(result.reason).toBe("unreachable");
    expect(result.detail).toMatch(/allowedHosts/);
  });
});
