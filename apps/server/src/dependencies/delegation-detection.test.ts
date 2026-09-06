import { describe, expect, it } from "vitest";
import type { ReadFileAtRefRequest, ReadFileAtRefResult } from "@scp/git-provider-core";
import type { TenantTx } from "../db/tenant-tx.js";
import { BUMP_BRANCH_PREFIX, buildBumpIntentParameters, bumpRefFor } from "./bump-actuator.js";
import {
  DELEGATION_CONFIG_PATHS,
  delegationCoversManifest,
  delegationProbeIsInconclusive,
  delegationRefusalMessage,
  parseDelegationConfig,
  parseDependabotConfig,
  probeDependencyUpdateDelegation,
  recordDelegationProbe,
  type DelegationProbeSubject
} from "./delegation-detection.js";

/**
 * The conflict detection, at the layer that always runs.
 *
 * The rule these assertions encode is stated once in the module doc and is the reason every
 * ambiguous case below resolves the way it does: WHEN IN DOUBT, IT COVERS. A wrong "covers" costs a
 * legible refusal naming a file; a wrong "does not cover" puts two actuators on one manifest, which
 * is the failure the whole feature is gated on preventing.
 */

describe("renovate configs", () => {
  it("covers everything by default — that is what Renovate actually does", () => {
    const c = parseDelegationConfig("renovate.json", '{"extends":["config:recommended"]}');
    expect(c).toMatchObject({ tool: "renovate", active: true, coversEverything: true });
    expect(delegationCoversManifest(c!, "services/api/package.json", "npm")).toBe(true);
  });

  it("covers nothing when explicitly disabled for the repository", () => {
    const c = parseDelegationConfig(".github/renovate.json", '{"enabled":false}');
    expect(c).toMatchObject({ active: false });
    expect(delegationCoversManifest(c!, "package.json", "npm")).toBe(false);
  });

  it("honours includePaths as a restriction, and only as a restriction", () => {
    const c = parseDelegationConfig("renovate.json", '{"includePaths":["services/api/**"]}');
    expect(delegationCoversManifest(c!, "services/api/package.json", "npm")).toBe(true);
    expect(delegationCoversManifest(c!, "services/web/package.json", "npm")).toBe(false);
    // Prefix matching is on SEGMENTS: `services/api` must not claim `services/api-v2`.
    expect(delegationCoversManifest(c!, "services/api-v2/package.json", "npm")).toBe(false);
  });

  it("covers everything when it does not parse — a config we cannot read is one we cannot narrow", () => {
    const c = parseDelegationConfig("renovate.json", "{ this is json5, // not json }");
    expect(c).toMatchObject({ coversEverything: true });
    expect(c?.note).toMatch(/did not parse/);
  });

  it("covers everything when it is not even an object", () => {
    expect(parseDelegationConfig("renovate.json", "[]")).toMatchObject({ coversEverything: true });
  });
});

describe("dependabot configs", () => {
  const yaml = `version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/services/api"
    schedule:
      interval: weekly
  - package-ecosystem: "docker"
    directory: "/"
`;

  it("reads the ecosystem/directory pairs without a YAML dependency", () => {
    const c = parseDependabotConfig(".github/dependabot.yml", yaml);
    expect(c.ecosystems).toEqual(["npm", "oci"]);
    expect(c.directories).toEqual(["/", "/services/api"]);
  });

  it("claims only the manifests its declared pairs cover", () => {
    const c = parseDependabotConfig(".github/dependabot.yml", yaml);
    expect(delegationCoversManifest(c, "services/api/package.json", "npm")).toBe(true);
    expect(delegationCoversManifest(c, "Dockerfile", "oci")).toBe(true);
    // An ecosystem it does not manage at all cannot collide with a bump SCP would author.
    expect(delegationCoversManifest(c, "go.mod", "go")).toBe(false);
  });

  it("is INERT when it declares no updates — an empty file delegates nothing", () => {
    expect(parseDependabotConfig(".github/dependabot.yml", "version: 2\n")).toMatchObject({
      active: false
    });
  });

  it("does NOT collide when every ecosystem it manages is one SCP never authors", () => {
    const c = parseDependabotConfig(
      ".github/dependabot.yml",
      'version: 2\nupdates:\n  - package-ecosystem: "bundler"\n    directory: "/"\n'
    );
    expect(c.coversEverything).toBe(false);
    expect(delegationCoversManifest(c, "package.json", "npm")).toBe(false);
  });

  it("WIDENS to everything when it names an ecosystem this reader does not recognise alongside one it does", () => {
    // The dangerous direction is guessing "does not collide" about a config shape this code has not
    // learned. A newly-added `package-ecosystem` must widen, never narrow.
    const c = parseDependabotConfig(
      ".github/dependabot.yml",
      'version: 2\nupdates:\n  - package-ecosystem: "npm"\n    directory: "/"\n  - package-ecosystem: "brand-new-thing"\n    directory: "/"\n'
    );
    expect(c.coversEverything).toBe(true);
    expect(delegationCoversManifest(c, "go.mod", "go")).toBe(true);
  });

  it("WIDENS to everything for the multi-directory `directories:` form it does not enumerate", () => {
    const c = parseDependabotConfig(
      ".github/dependabot.yml",
      'version: 2\nupdates:\n  - package-ecosystem: "npm"\n    directories:\n      - "/a"\n      - "/b"\n'
    );
    expect(c.coversEverything).toBe(true);
  });

  it("ignores commented-out entries", () => {
    const c = parseDependabotConfig(
      ".github/dependabot.yml",
      'version: 2\nupdates:\n  # - package-ecosystem: "npm"\n  #   directory: "/"\n'
    );
    expect(c.active).toBe(false);
  });
});

describe("the candidate path list", () => {
  it("covers both tools' documented locations, including the extensionless `.renovaterc`", () => {
    expect(DELEGATION_CONFIG_PATHS).toContain("renovate.json");
    expect(DELEGATION_CONFIG_PATHS).toContain(".github/renovate.json");
    expect(DELEGATION_CONFIG_PATHS).toContain(".renovaterc");
    expect(DELEGATION_CONFIG_PATHS).toContain(".github/dependabot.yml");
    expect(DELEGATION_CONFIG_PATHS).toContain(".github/dependabot.yaml");
  });

  it("routes every dependabot path to the dependabot parser and everything else to renovate's", () => {
    for (const path of DELEGATION_CONFIG_PATHS) {
      const expected = path.includes("dependabot") ? "dependabot" : "renovate";
      // A body valid for neither parser, so only the ROUTING is under test.
      expect(parseDelegationConfig(path, "version: 2\n")?.tool).toBe(expected);
    }
  });
});

/**
 * ================================================================================================
 * "WE COULD NOT CHECK" IS NOT "NOTHING TO FIND" — EACH FAILURE MODE, SEPARATELY
 * ================================================================================================
 * The probe used to swallow every read failure into `unreadable` and return `delegated: false`, so a
 * bad credential, a provider 5xx, an egress refusal and a refused blob all produced a result
 * BYTE-IDENTICAL to a clean repository: `configs: []`, `collisions: []`, `delegated: false`. The
 * dispatcher then wrote an `allow` Decision and authored the bump, and the `delegation_probe_failed`
 * branch it has for exactly this was unreachable.
 *
 * Each mode is asserted on its own rather than as one "the reader failed" case, because they arrive
 * through DIFFERENT limbs — three of them as a THROW from the reader (the git adapter's own auth/HTTP
 * failure, and the plugin host's egress guard) and one as a `refused` OUTCOME the reader returns
 * normally. A single test would have proven only whichever limb it happened to take.
 */
describe("a probe that could not READ never resolves to 'no delegation here'", () => {
  const subject: DelegationProbeSubject = {
    componentObjectId: "component-1",
    repo: "acme/widgets",
    ref: "refs/heads/main",
    manifests: [{ manifestPath: "package.json", ecosystem: "npm" }]
  };

  /** A reader that answers every candidate path the same way. */
  const readerThatAlways = (
    answer: (request: ReadFileAtRefRequest) => ReadFileAtRefResult
  ): ((request: ReadFileAtRefRequest) => Promise<ReadFileAtRefResult>) => {
    return async (request) => answer(request);
  };
  const notFound = (request: ReadFileAtRefRequest): ReadFileAtRefResult => ({
    outcome: "not_found",
    missing: "path",
    path: request.path,
    requestedRef: request.ref,
    detail: "fixture: absent"
  });

  it.each([
    [
      "a bad credential (the adapter throws a 401)",
      async () => {
        throw new Error("github readFileAtRef: HTTP 401 (bad credentials)");
      }
    ],
    [
      "a provider 5xx (the adapter throws)",
      async () => {
        throw new Error("github readFileAtRef: HTTP 502 from api.github.com");
      }
    ],
    [
      "an egress refusal (the plugin host's guard throws before the request leaves)",
      async () => {
        throw new Error(
          "plugin egress refused: host 'api.github.com' resolves to a private address and no allowlist permits it"
        );
      }
    ]
  ] as const)("is INCONCLUSIVE on %s, and records NOTHING", async (_label, reader) => {
    const probe = await probeDependencyUpdateDelegation(
      reader as unknown as (r: ReadFileAtRefRequest) => Promise<ReadFileAtRefResult>,
      subject
    );
    // The shape that used to be indistinguishable from a clean repository...
    expect(probe.delegated).toBe(false);
    expect(probe.configs).toEqual([]);
    expect(probe.collisions).toEqual([]);
    expect(probe.conclusive).toBe(false);
    expect(probe.unreadable).toHaveLength(DELEGATION_CONFIG_PATHS.length);
    expect(delegationProbeIsInconclusive(probe)).toBe(true);

    // AND THE WRITER REFUSES IT. This is where the rule lives rather than in the one caller, so a
    // second producer of this verdict inherits the refusal instead of re-deriving it. It throws
    // before touching `tx`, which is why a stub is enough here.
    await expect(
      recordDelegationProbe(null as unknown as TenantTx, "org-1", subject, probe)
    ).rejects.toThrow(/never resolves to "go ahead and write to them"/);
  });

  it("is INCONCLUSIVE on a REFUSED read outcome too — the limb that is not a throw", async () => {
    const probe = await probeDependencyUpdateDelegation(
      readerThatAlways((request) =>
        request.path === "renovate.json"
          ? {
              outcome: "refused",
              reason: "too_large",
              detail: "declared 40000000 bytes, over the 1048576-byte ceiling",
              path: request.path,
              requestedRef: request.ref
            }
          : notFound(request)
      ),
      subject
    );
    expect(probe.delegated).toBe(false);
    expect(probe.conclusive).toBe(false);
    // ONE unreadable path out of ten is enough: the file that could not be read is exactly the one
    // that might have delegated these manifests.
    expect(probe.unreadable.map((u) => u.configPath)).toEqual(["renovate.json"]);
    await expect(
      recordDelegationProbe(null as unknown as TenantTx, "org-1", subject, probe)
    ).rejects.toThrow(/could not read 1 of the/);
  });

  it("stays CONCLUSIVE when every candidate path answered — the clean repository still gets its allow", async () => {
    const probe = await probeDependencyUpdateDelegation(readerThatAlways(notFound), subject);
    expect(probe.delegated).toBe(false);
    expect(probe.conclusive).toBe(true);
    expect(probe.unreadable).toEqual([]);
    expect(delegationProbeIsInconclusive(probe)).toBe(false);
  });

  it("a COLLISION found is conclusive enough to refuse, whatever else failed to read", async () => {
    // The asymmetry is deliberate and is why the test is `!delegated && !conclusive`: more unread
    // config could only ADD collisions, never remove the one already found. Blocking on partial
    // evidence of delegation is the safe direction; allowing on partial evidence is not.
    const probe = await probeDependencyUpdateDelegation(
      readerThatAlways((request) => {
        if (request.path === "renovate.json") {
          return {
            outcome: "found",
            path: request.path,
            requestedRef: request.ref,
            commitSha: "deadbeef",
            content: '{"extends":["config:recommended"]}',
            sizeBytes: 34
          };
        }
        if (request.path === ".github/dependabot.yml") {
          return {
            outcome: "refused",
            reason: "not_a_file",
            detail: "fixture: a directory",
            path: request.path,
            requestedRef: request.ref
          };
        }
        return notFound(request);
      }),
      subject
    );
    expect(probe.delegated).toBe(true);
    expect(probe.conclusive).toBe(false);
    expect(delegationProbeIsInconclusive(probe)).toBe(false);
  });
});

describe("the refusal message", () => {
  it("names the file found, which is what an operator has to act on", () => {
    const message = delegationRefusalMessage([
      { configPath: ".github/dependabot.yml", tool: "dependabot", manifestPaths: ["package.json"] }
    ]);
    expect(message).toContain(".github/dependabot.yml");
    expect(message).toContain("package.json");
    expect(message).toContain("dependabot");
  });
});

describe("the authored-branch contract, pinned across the two modules that restate it", () => {
  it("the server's prefix matches the plugin's, byte for byte", async () => {
    // `@scp/plugin-managed-dep` restates this constant rather than importing the server's, and the
    // server restates it again in `coordination/correlation.ts` — three copies, because neither a
    // plugin nor the correlation path may depend on the dependencies subsystem. THIS is where they
    // are proven equal; a drift here is a bump whose returning webhook mints a duplicate change.
    const plugin = await import("@scp/plugin-managed-dep");
    const { BUMP_AUTHORED_REF_PREFIX } = await import("../coordination/correlation.js");
    expect(BUMP_BRANCH_PREFIX).toBe(plugin.BUMP_BRANCH_PREFIX);
    expect(bumpRefFor("abc")).toBe(`refs/heads/${plugin.bumpBranchFor("abc")}`);
    expect(BUMP_AUTHORED_REF_PREFIX).toBe(`refs/heads/${BUMP_BRANCH_PREFIX}`);
  });

  /**
   * THE OTHER HALF OF THE SAME SEAM, and the one easy to leave untested because both sides compile
   * fine without it: the server BUILDS the descriptor and the plugin PARSES it, across a plugin-host
   * RPC boundary where the type on the wire is `Record<string, unknown>`. Nothing but a test can say
   * the two agree.
   *
   * It is not hypothetical. The plugin REQUIRES `declaredManifestPaths` — it refuses to default that
   * set to the target manifest, because a default would make its "must be a manifest the component
   * already contains" gate compare a value with itself — so a server that did not send it would fail
   * every bump at dispatch with both packages green.
   */
  it("the descriptor the server builds is one the plugin accepts, field for field", async () => {
    const plugin = await import("@scp/plugin-managed-dep");
    const changeObjectId = "0198f3c1-1111-7000-8000-000000000001";
    const parameters = buildBumpIntentParameters({
      orgId: "org",
      requestId: "req",
      componentObjectId: "component",
      lineId: "0198f3c1-2222-7000-8000-000000000002",
      repo: "acme/widget",
      baseBranch: "main",
      ecosystem: "npm",
      coordinate: "@acme/lib",
      manifestPath: "package.json",
      declaredManifestPaths: ["package.json", "svc/package.json"],
      fromVersion: "^1.2.3",
      toVersion: "^1.4.0",
      delivery: { delivery: "pull_request", reason: "test" },
      changeObjectId
    });

    const descriptor = plugin.parseBumpDescriptor({ kind: "custom", parameters });
    expect(descriptor.repo).toBe("acme/widget");
    expect(descriptor.spec.coordinate).toBe("@acme/lib");
    expect(descriptor.declaredManifestPaths).toEqual(["package.json", "svc/package.json"]);
    // The branch the plugin derives is the ref the server recorded on the change — the provenance
    // loop's join, checked end to end rather than as two constants that happen to look alike.
    expect(`refs/heads/${descriptor.headBranch}`).toBe(bumpRefFor(changeObjectId));

    // ...and the descriptor carries none of the keys the plugin refuses as possible file content.
    for (const key of plugin.CONTENT_BEARING_KEYS) {
      expect(key in parameters, `${key} must never appear in a bump descriptor`).toBe(false);
    }
  });
});
