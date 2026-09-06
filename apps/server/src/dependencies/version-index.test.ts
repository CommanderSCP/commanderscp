import { afterEach, describe, expect, it, vi } from "vitest";
import type { DependencyIndexResult, DependencyIndexVersion } from "@scp/plugin-api";
import { DependencyEcosystemSchema } from "@scp/schemas";
import type { PluginHost } from "../plugin-host/contract.js";
import { asThirdPartyLine, eligibleSuffixFor, isOnLine, type ThirdPartyLine } from "./line-head.js";
import {
  INDEX_MODULE_BY_ECOSYSTEM,
  INDEX_URL_ENV_BY_ECOSYSTEM,
  queryLineHead,
  resolveIndexInstanceConfig,
  selectLineHead
} from "./version-index.js";
import type { FeedRead } from "./version-index-feed.js";

/**
 * M21.4 — the NEVER-GUESS properties (ADR-0032 §7), pinned as pure-function tests.
 *
 * Every assertion below is about the same rule from a different angle: a version that cannot be
 * DETERMINED must produce NOTHING, with a legible reason. The failure these guard against is not a
 * crash — it is a plausible-looking wrong answer that makes a component look up to date.
 */

const line = (
  over: Partial<{ ecosystem: string; major: string; tagPattern: string | null }> = {}
) =>
  ({
    ecosystem: "npm",
    major: "4",
    tagPattern: null,
    ...over
  }) as {
    ecosystem: "npm" | "go" | "maven" | "python" | "oci";
    major: string;
    tagPattern: string | null;
  };

const v = (...versions: string[]): DependencyIndexVersion[] =>
  versions.map((version) => ({ version }));

/**
 * `queryLineHead` accepts ONLY a `ThirdPartyLine`, so even a test has to come through
 * `asThirdPartyLine` — which is the ingress split working (ADR-0032 §7): an INTERNAL line cannot be
 * handed to an index by anyone, including a test that means to.
 */
const pollable = (
  over: Partial<{ ecosystem: string; coordinate: string; major: string; tagPattern: string | null }>
): ThirdPartyLine => {
  const built = asThirdPartyLine(
    {
      id: "00000000-0000-0000-0000-0000000000ff",
      ecosystem: "npm",
      coordinate: "@acme/lib",
      major: "4",
      tagPattern: null,
      ...over
    } as Parameters<typeof asThirdPartyLine>[0],
    // No producer is declared for this coordinate — the fact is an ARGUMENT since drizzle/0068,
    // and a fixture that wants a pollable line has to state it rather than inherit it from a NULL
    // column nobody wrote.
    { hasDeclaredProducer: false }
  );
  if (built === null) throw new Error("fixture is not a third-party line");
  return built;
};

describe("the ecosystem vocabulary is the same list on all THREE sides", () => {
  it("plugin-api's DependencyIndexEcosystem matches the Zod enum at RUNTIME", () => {
    // M21.4 added a THIRD copy of one vocabulary (`@scp/schemas`' Zod enum, `@scp/dependency-
    // manifests`' parser type, and now `@scp/plugin-api`'s plugin-contract type). The first two
    // drifted already — `image` vs `oci` — with both sides fully green, because no test crossed the
    // boundary; `packages/dependency-manifests/src/ecosystem-vocabulary.test.ts` exists for exactly
    // that. This is the same check for the third copy.
    //
    // `INDEX_MODULE_BY_ECOSYSTEM` is what makes it a RUNTIME check rather than an erased type
    // assertion: it is declared `Record<DependencyIndexEcosystem, PluginModule>`, so a missing key
    // and an extra key are both compile errors, and its KEYS are therefore that type's members
    // observable at runtime.
    expect(Object.keys(INDEX_MODULE_BY_ECOSYSTEM).sort()).toEqual(
      [...DependencyEcosystemSchema.options].sort()
    );
  });

  it("every ecosystem has an index module and an env var slot — no ecosystem is silently unpollable", () => {
    // NEGATIVE CONTROL for the check above: two lists can agree while one of them maps an ecosystem
    // to nothing. `oci` is the one deliberate `null` — its reach is the existing registry allowlist,
    // not a URL — and it is asserted by name so a future `null` cannot be added unnoticed.
    for (const ecosystem of DependencyEcosystemSchema.options) {
      expect(INDEX_MODULE_BY_ECOSYSTEM[ecosystem]).toBeTruthy();
    }
    const withoutUrlEnv = DependencyEcosystemSchema.options.filter(
      (ecosystem) => INDEX_URL_ENV_BY_ECOSYSTEM[ecosystem] === null
    );
    expect(withoutUrlEnv).toEqual(["oci"]);
  });
});

describe("selectLineHead — ordering is numeric, never lexicographic", () => {
  it("picks 4.10.0 over 4.9.0, which string order gets backwards", () => {
    // The concrete failure `@scp/dependency-manifests/version.ts` names: `"9" > "10"`. A resolver
    // that sorted strings would "bump" a subscriber from 4.10.0 down to 4.9.0.
    const selected = selectLineHead(line(), v("4.9.0", "4.10.0", "4.2.0"));
    expect(selected.head?.version).toBe("4.10.0");
  });

  it("skips an unparseable version and COUNTS it, rather than coercing it", () => {
    const selected = selectLineHead(line(), v("4.1.0", "latest", "nightly", "4.2.0"));
    expect(selected.head?.version).toBe("4.2.0");
    expect(selected.skipped).toBe(2);
    expect(selected.considered).toBe(4);
  });

  it("records NOTHING when everything offered is unparseable", () => {
    const selected = selectLineHead(line(), v("latest", "stable", "edge"));
    expect(selected.head).toBeUndefined();
    expect(selected.reason).toBe("no_parseable_version");
  });

  it("records NOTHING when the LINE's own major cannot be read", () => {
    // `dependency_lines.major` is free text with no CHECK (0061). A line whose identity cannot be
    // parsed cannot have membership tested, so no candidate may be admitted "just in case".
    const selected = selectLineHead(line({ major: "stable" }), v("4.1.0", "5.0.0"));
    expect(selected.head).toBeUndefined();
    expect(selected.reason).toBe("line_major_unparseable");
  });
});

describe("selectLineHead — line membership is structural, not textual", () => {
  it("a Go line spelled v2 matches 2.x.y", () => {
    const selected = selectLineHead(
      line({ ecosystem: "go", major: "v2" }),
      v("v1.9.0", "v2.3.1", "v3.0.0")
    );
    expect(selected.head?.version).toBe("v2.3.1");
    expect(selected.offLine).toBe(2);
  });

  it("a two-component line (1.2) admits only 1.2.z — not 1.3.0", () => {
    const selected = selectLineHead(line({ major: "1.2" }), v("1.2.3", "1.2.9", "1.3.0"));
    expect(selected.head?.version).toBe("1.2.9");
    expect(selected.offLine).toBe(1);
  });

  it("a one-component line (3) does NOT admit 30.x by prefix", () => {
    // A textual `startsWith` comparison would accept 30.1.0 onto the `3` line.
    const selected = selectLineHead(line({ major: "3" }), v("3.1.0", "30.1.0"));
    expect(selected.head?.version).toBe("3.1.0");
    expect(selected.offLine).toBe(1);
  });

  it("isOnLine agrees with those cases directly", () => {
    const three = { major: 3, minor: 0, patch: 0, precision: 1 as const, raw: "3" };
    expect(isOnLine({ major: 3, minor: 9, patch: 9, precision: 3, raw: "3.9.9" }, three)).toBe(
      true
    );
    expect(isOnLine({ major: 30, minor: 1, patch: 0, precision: 3, raw: "30.1.0" }, three)).toBe(
      false
    );
    const oneTwo = { major: 1, minor: 2, patch: 0, precision: 2 as const, raw: "1.2" };
    expect(isOnLine({ major: 1, minor: 2, patch: 9, precision: 3, raw: "1.2.9" }, oneTwo)).toBe(
      true
    );
    expect(isOnLine({ major: 1, minor: 3, patch: 0, precision: 3, raw: "1.3.0" }, oneTwo)).toBe(
      false
    );
  });
});

describe("selectLineHead — a head is chosen WITHIN one suffix class", () => {
  it("a prerelease never becomes a language line's head", () => {
    const selected = selectLineHead(line(), v("4.1.0", "4.2.0-rc.1", "4.2.0-beta"));
    expect(selected.head?.version).toBe("4.1.0");
    expect(selected.offLine).toBe(2);
  });

  it("an image line with no tagPattern takes the plain tags, not the -alpine variant", () => {
    // `compareVersions` REFUSES to order `3.19.1-alpine` against `3.19.1`: they are two flavours of
    // one release, not an upgrade path. Mixing them would move a subscriber between variants.
    const selected = selectLineHead(
      line({ ecosystem: "oci", major: "3.19" }),
      v("3.19.0", "3.19.1", "3.19.2-alpine")
    );
    expect(selected.head?.version).toBe("3.19.1");
    expect(selected.offLine).toBe(1);
  });

  it("an image line WITH tagPattern '-alpine' takes only that variant", () => {
    const selected = selectLineHead(
      line({ ecosystem: "oci", major: "3.19", tagPattern: "-alpine" }),
      v("3.19.0", "3.19.1", "3.19.2-alpine", "3.19.3-slim")
    );
    expect(selected.head?.version).toBe("3.19.2-alpine");
    expect(eligibleSuffixFor({ ecosystem: "oci", tagPattern: "-alpine" })).toBe("-alpine");
    // NEGATIVE CONTROL: the pattern is only consulted for images. A language line can never be
    // steered by a stray tag_pattern (0061 normalises it to NULL on write, and this is the reader's
    // half of that same rule).
    expect(eligibleSuffixFor({ ecosystem: "npm", tagPattern: "-alpine" })).toBe("");
  });
});

describe("selectLineHead — image tags are not semver", () => {
  it("a date stamp never becomes the head of a numeric line", () => {
    // `20240115` and `7` are indistinguishable as strings; `parseImageTagVersion` refuses a
    // single-component tag for exactly that reason, and this is the consequence at the line level.
    const selected = selectLineHead(
      line({ ecosystem: "oci", major: "3" }),
      v("3.1", "3.2", "20240115", "latest", "3")
    );
    expect(selected.head?.version).toBe("3.2");
    // `20240115`, `latest` and the bare `3` are all SKIPPED as unparseable-for-an-image-tag.
    expect(selected.skipped).toBe(3);
  });

  it("an EMPTY version list is its own reason — the package exists and has published nothing", () => {
    // `no_versions_on_line` and `no_published_versions` are two different facts about the world and
    // two different operator actions: "this package has no releases at all" (chase the publisher, or
    // the coordinate is wrong) versus "its releases are all on other majors" (the LINE's `major` is
    // wrong). Reporting the first as the second sends the operator to edit a line that is fine.
    const empty = selectLineHead(line({ major: "4" }), v());
    expect(empty.head).toBeUndefined();
    expect(empty.reason).toBe("no_published_versions");
    expect(empty.considered).toBe(0);

    // NEGATIVE CONTROL: a NON-empty answer that carries nothing on this line is still
    // `no_versions_on_line`, so the new reason is about emptiness and not about "nothing matched".
    const offLine = selectLineHead(line({ major: "4" }), v("5.0.0", "6.1.0"));
    expect(offLine.reason).toBe("no_versions_on_line");
    expect(offLine.offLine).toBe(2);
  });

  it("with only single-component and non-numeric tags, an image line records NOTHING", () => {
    const selected = selectLineHead(
      line({ ecosystem: "oci", major: "3" }),
      v("latest", "3", "edge")
    );
    expect(selected.head).toBeUndefined();
    expect(selected.reason).toBe("no_parseable_version");
  });
});

describe("resolveIndexInstanceConfig — indexes are operator config, and unset means UNAVAILABLE", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("an unset ecosystem URL yields no instance (the air-gap default)", () => {
    for (const ecosystem of ["go", "npm", "python", "maven"] as const) {
      expect(resolveIndexInstanceConfig(ecosystem, "org-1", {})).toBeNull();
    }
  });

  it("a configured URL derives allowedHosts FROM THAT URL, and never opts into internal egress", () => {
    const instance = resolveIndexInstanceConfig("go", "org-1", {
      SCP_DEPENDENCY_INDEX_GO_URL: "https://goproxy.internal:8443/proxy"
    });
    expect(instance).toMatchObject({
      module: INDEX_MODULE_BY_ECOSYSTEM.go,
      orgId: "org-1",
      config: { baseUrl: "https://goproxy.internal:8443/proxy" },
      allowedHosts: ["goproxy.internal:8443"]
    });
    // `allowInternalEgress` is the two-layer operator grant (ADR-0003). A registry poll must not
    // shortcut it — an index pointed at 127.0.0.1/10.x is the SSRF shape MAJOR #6 closed.
    expect(instance?.allowInternalEgress).toBeUndefined();
  });

  it("a malformed operator URL yields no instance rather than an unguarded request", () => {
    expect(
      resolveIndexInstanceConfig("npm", "org-1", { SCP_DEPENDENCY_INDEX_NPM_URL: "not a url" })
    ).toBeNull();
  });

  it("oci is configured from the EXISTING registry allowlist and the pinned skopeo — no new env", () => {
    vi.stubEnv("SCP_SKOPEO_BIN", "/opt/scp/bin/skopeo");
    expect(
      resolveIndexInstanceConfig("oci", "org-1", { SCP_ARTIFACT_OCI_REGISTRY_HOSTS: "" })
    ).toBeNull();
    const instance = resolveIndexInstanceConfig("oci", "org-1", {
      SCP_ARTIFACT_OCI_REGISTRY_HOSTS: "registry.internal, ghcr.io",
      SCP_ARTIFACT_INSECURE_HOSTS: "registry.internal"
    });
    expect(instance).toMatchObject({
      module: "dependency-index-oci",
      config: {
        skopeoBinary: "/opt/scp/bin/skopeo",
        allowedRegistryHosts: ["registry.internal", "ghcr.io"],
        insecureRegistryHosts: ["registry.internal"]
      }
    });
    // The image index has NO allowedHosts: it does not use ctx.http at all.
    expect(instance?.allowedHosts).toBeUndefined();
  });
});

function fakeHost(
  listVersions: () => Promise<DependencyIndexResult>,
  resolveDigest?: () => Promise<
    | { status: "available"; digest: string }
    | { status: "unavailable"; reason: "no_digest"; detail: string }
  >
): PluginHost {
  const notWired = (): never => {
    throw new Error("this fixture only wires dependencyIndex()");
  };
  return {
    async start() {},
    async stop() {},
    async stopInstances() {},
    executor: notWired,
    control: notWired,
    discovery: notWired,
    notification: notWired,
    federationTransport: notWired,
    gitFileRead: notWired,
    dependencyIndex() {
      return {
        listVersions,
        resolveDigest:
          resolveDigest ??
          (async () => ({
            status: "unavailable" as const,
            reason: "no_digest" as const,
            detail: "n/a"
          })),
        describeIndex: async () => ({ ecosystem: "npm" as const, reportsDigest: false })
      };
    }
  };
}

const NPM_ENV = { SCP_DEPENDENCY_INDEX_NPM_URL: "https://npm.internal" };

describe("queryLineHead", () => {
  it("carries an index's UNAVAILABLE straight through with its reason and detail", async () => {
    const outcome = await queryLineHead(
      pollable({ ecosystem: "npm", coordinate: "@acme/lib", major: "4" }),
      {
        host: fakeHost(async () => ({
          status: "unavailable",
          reason: "redirected",
          detail: "point me at the final url"
        })),
        orgId: "org-1",
        env: NPM_ENV
      }
    );
    expect(outcome).toMatchObject({
      status: "unavailable",
      reason: "redirected",
      source: "index:dependency-index-npm"
    });
  });

  it("a THROWING index plugin becomes an unavailable verdict, never a rejected sweep", async () => {
    // One bad index must not abort the tick for every other line in the estate.
    const outcome = await queryLineHead(
      pollable({ ecosystem: "npm", coordinate: "@acme/lib", major: "4" }),
      {
        host: fakeHost(async () => {
          throw new Error("plugin host: call timed out");
        }),
        orgId: "org-1",
        env: NPM_ENV
      }
    );
    expect(outcome).toMatchObject({ status: "unavailable", reason: "unreachable" });
    if (outcome.status !== "unavailable") throw new Error("unreachable");
    expect(outcome.detail).toMatch(/call timed out/);
  });

  it("an index that answers but carries nothing on the line is UNDETERMINED, not unavailable", async () => {
    // Distinct verdicts on purpose: this one means "the line's major or tag_pattern is wrong",
    // which is an entirely different operator action from "the network is down".
    const outcome = await queryLineHead(
      pollable({ ecosystem: "npm", coordinate: "@acme/lib", major: "9" }),
      {
        host: fakeHost(async () => ({ status: "available", versions: v("4.1.0") })),
        orgId: "org-1",
        env: NPM_ENV
      }
    );
    expect(outcome).toMatchObject({ status: "undetermined", reason: "no_versions_on_line" });
  });

  it("resolves a digest for an image head, and survives a digest lookup that fails", async () => {
    vi.stubEnv("SCP_SKOPEO_BIN", "/opt/scp/bin/skopeo");
    const ociEnv = { SCP_ARTIFACT_OCI_REGISTRY_HOSTS: "registry.internal" };
    const withDigest = await queryLineHead(
      pollable({ ecosystem: "oci", coordinate: "registry.internal/acme/base", major: "3.19" }),
      {
        host: fakeHost(
          async () => ({ status: "available", versions: v("3.19.0", "3.19.1", "latest") }),
          async () => ({ status: "available", digest: `sha256:${"a".repeat(64)}` })
        ),
        orgId: "org-1",
        env: ociEnv
      }
    );
    expect(withDigest).toMatchObject({
      status: "observed",
      head: { version: "3.19.1", digest: `sha256:${"a".repeat(64)}` }
    });

    // A digest that cannot be resolved does NOT void the observation — the tag is still the head,
    // and the air-gap feed carries no digests at all, so requiring one would make an air-gapped
    // estate unable to record an image head ever. It travels as an EXPLICIT null, never as an
    // absent field: an absent one let the PREVIOUS version's digest stay beside the new tag, and the
    // row then asserted a (tag, digest) pair that never existed in any registry (ADR-0032 §7).
    const withoutDigest = await queryLineHead(
      pollable({ ecosystem: "oci", coordinate: "registry.internal/acme/base", major: "3.19" }),
      {
        host: fakeHost(
          async () => ({ status: "available", versions: v("3.19.0", "3.19.1") }),
          async () => {
            throw new Error("skopeo inspect failed");
          }
        ),
        orgId: "org-1",
        env: ociEnv
      }
    );
    expect(withoutDigest).toMatchObject({ status: "observed", head: { version: "3.19.1" } });
    if (withoutDigest.status !== "observed") throw new Error("unreachable");
    expect(withoutDigest.head.digest, "explicitly null, never absent").toBeNull();
    vi.unstubAllEnvs();
  });
});

describe("queryLineHead — the air-gap resort", () => {
  const unusedHost = fakeHost(async () => {
    throw new Error("no index is configured, so no plugin may be started");
  });

  it("with no index and no feed, the answer is NOT_CONFIGURED — never 'no new version'", async () => {
    const outcome = await queryLineHead(
      pollable({ ecosystem: "go", coordinate: "example.com/x", major: "v1" }),
      { host: unusedHost, orgId: "org-1", env: {}, feed: { status: "absent" } }
    );
    expect(outcome).toMatchObject({ status: "unavailable", reason: "not_configured" });
    if (outcome.status !== "unavailable") throw new Error("unreachable");
    expect(outcome.detail).toMatch(/SCP_DEPENDENCY_INDEX_GO_URL/);
    expect(outcome.detail).toMatch(/nothing was asked, so nothing is known/);
  });

  it("an operator-loaded feed answers when no index is configured", async () => {
    const feed: FeedRead = {
      status: "present",
      document: {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        entries: [
          { ecosystem: "go", coordinate: "example.com/x", versions: ["v1.2.0", "v1.3.0", "v2.0.0"] }
        ]
      },
      ageHours: 1,
      staleness: "fresh",
      softMaxAgeHours: 168,
      hardMaxAgeHours: 720
    };
    const outcome = await queryLineHead(
      pollable({ ecosystem: "go", coordinate: "example.com/x", major: "v1" }),
      { host: unusedHost, orgId: "org-1", env: {}, feed }
    );
    expect(outcome).toMatchObject({
      status: "observed",
      source: "operator-feed",
      head: { version: "v1.3.0" }
    });
  });

  it("a HARD-STALE feed is refused, fail-closed — it is not used with a warning", async () => {
    const feed: FeedRead = {
      status: "present",
      document: { schemaVersion: 1, generatedAt: new Date(0).toISOString(), entries: [] },
      ageHours: 5000,
      staleness: "hard",
      softMaxAgeHours: 168,
      hardMaxAgeHours: 720
    };
    const outcome = await queryLineHead(
      pollable({ ecosystem: "go", coordinate: "example.com/x", major: "v1" }),
      { host: unusedHost, orgId: "org-1", env: {}, feed }
    );
    expect(outcome).toMatchObject({ status: "unavailable", reason: "feed_stale" });
  });

  it("a coordinate the feed does not carry is 'unlisted', which is not 'up to date'", async () => {
    const feed: FeedRead = {
      status: "present",
      document: {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        entries: [{ ecosystem: "go", coordinate: "example.com/other", versions: ["v1.0.0"] }]
      },
      ageHours: 1,
      staleness: "fresh",
      softMaxAgeHours: 168,
      hardMaxAgeHours: 720
    };
    const outcome = await queryLineHead(
      pollable({ ecosystem: "go", coordinate: "example.com/x", major: "v1" }),
      { host: unusedHost, orgId: "org-1", env: {}, feed }
    );
    expect(outcome).toMatchObject({ status: "unavailable", reason: "feed_missing_coordinate" });
  });
});
