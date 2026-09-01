import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { atLineStart } from "@scp/source-census";
import {
  PINNED_SKOPEO_IMAGE,
  PINNED_SKOPEO_VERSION,
  SKOPEO_BIN_ENV,
  VENDORED_SKOPEO_PATH,
  assertPinnedSkopeoVersion,
  resolveSkopeo,
  skopeoReportedVersion
} from "@scp/cosign";
import { REPO_ROOT } from "./repo-paths.js";

/**
 * Parse a `tools/<pin>/pin.env` (each a single source of truth) as KEY=VALUE pairs. One PARSER for
 * every pin file — the file format is one format, and a parsing fix applied to a per-pin copy and
 * not its twin is the comment-proof bug class this function exists to prevent — while every
 * ASSERTION stays per-pin at the call sites, so separate pins keep separate verdicts (the budget
 * census's rule).
 *
 * Comment-proof, like cosign-bin.test.ts's twin: the key pattern is anchored to the start of the
 * trimmed line and admits only `[A-Z_0-9]`, so a `#`-prefixed line cannot become a pin.
 */
function readPinEnv(relative: string): Record<string, string> {
  const text = readFileSync(path.join(REPO_ROOT, relative), "utf8");
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^([A-Z_0-9]+)=(.*)$/.exec(line.trim());
    if (match?.[1] && match[2] !== undefined) out[match[1]] = match[2];
  }
  return out;
}

/** Raw bytes. Safe for every use below because each is either ANCHORED at the point of assertion
 *  (`atLineStart`, which a `#` prefix cannot satisfy) or an ABSENCE assertion, where a comment
 *  marker only makes the check harder to pass and stripping would weaken it. */
function readRepoFile(relative: string): string {
  return readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

/**
 * The skopeo pin is a TRIPLE-string coupling — `tools/skopeo/pin.env`, the Dockerfile's build
 * ARG + COPY block, and `packages/cosign/src/skopeo-bin.ts`'s constants. Nothing at build or run
 * time forces those to agree, so a stale copy would silently mean "the image ships binary A
 * while the code asserts version B". These tests are that forcing function — the same shape as
 * cosign-bin.test.ts, which guards the cosign pin's quadruple coupling.
 *
 * IT SHARED THAT FILE'S DEFECT TOO. MEASURED 2026-08-17: commenting out `ARG SKOPEO_IMAGE=` in the
 * root Dockerfile and `d=/opt/scp/libexec/skopeo` in the wrapper left this file green at 10 passed
 * / 1 skipped, because `.toContain(…)` over raw text cannot tell a live line from a described one.
 * Every presence assertion below is therefore anchored with `@scp/source-census`'s `atLineStart` —
 * each of these lines genuinely begins its line, so the anchor costs nothing and a `#` prefix can
 * no longer satisfy it.
 *
 * THE LIMIT: anchoring fixes the comment case and no more (see the package doc). It cannot see a
 * `COPY` in a stage the final image never draws from, and it cannot tell that the vendored library
 * closure is complete. The assertion that cannot be talked out of is the fail-closed `skopeo
 * --version` check at the bottom of this file, which runs the resolved binary.
 */
describe("skopeo pin: every copy of the pin agrees with tools/skopeo/pin.env", () => {
  const pin = readPinEnv("tools/skopeo/pin.env");

  it("pin.env is well-formed (version + amd64 platform digest + paths)", () => {
    // Upstream reports the version WITHOUT a leading `v` (unlike cosign).
    expect(pin.SKOPEO_PINNED_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pin.SKOPEO_PINNED_IMAGE).toMatch(/^quay\.io\/skopeo\/stable@sha256:[0-9a-f]{64}$/);
    expect(pin.SKOPEO_UPSTREAM_PATH).toBe("/usr/bin/skopeo");
    expect(pin.SKOPEO_VENDORED_PATH).toBe(VENDORED_SKOPEO_PATH);
    expect(pin.SKOPEO_LIBEXEC_DIR).toBe("/opt/scp/libexec/skopeo");
  });

  it("skopeo-bin.ts constants match pin.env", () => {
    expect(PINNED_SKOPEO_VERSION).toBe(pin.SKOPEO_PINNED_VERSION);
    expect(PINNED_SKOPEO_IMAGE).toBe(pin.SKOPEO_PINNED_IMAGE);
  });

  it("the Dockerfile vendors exactly the pinned image into exactly the pinned paths", () => {
    const dockerfile = readRepoFile("Dockerfile");
    expect(dockerfile).toMatch(atLineStart(`ARG SKOPEO_IMAGE=${pin.SKOPEO_PINNED_IMAGE}`));
    // The real ELF binary goes to libexec; the wrapper (which runs it against the vendored
    // loader + libs — the binary is dynamically linked) is what lands on the vendored path.
    expect(dockerfile).toMatch(
      atLineStart(`COPY --from=skopeo ${pin.SKOPEO_UPSTREAM_PATH} ${pin.SKOPEO_LIBEXEC_DIR}/skopeo`)
    );
    expect(dockerfile).toMatch(
      atLineStart(`COPY tools/skopeo/skopeo-wrapper.sh ${pin.SKOPEO_VENDORED_PATH}`)
    );
    expect(dockerfile).toMatch(
      atLineStart("COPY tools/skopeo/policy.json /etc/containers/policy.json")
    );
  });

  it("the image BUILD can be served by the mirror — the fourth consumer form, which had no guard", () => {
    // ADDED 2026-08-18, after the pinned skopeo digest was DELETED from quay.io (404) and took every
    // E2E job red at image build, five steps before a test ran. The second quay.io outage to do so.
    //
    // `tools/ci-mirror/images.list` mirrors every third-party image to GHCR so CI never pulls live,
    // and enumerated three consumer forms. A DIGEST-PINNED `FROM` is a fourth, and neither mechanism
    // reaches it: a `FROM …@sha256:…` resolves AT THE REGISTRY, so a local re-tag is invisible to it,
    // and the `SCP_*_IMAGE_REF` vars are read by the installer scripts rather than by BuildKit. The
    // census that produced forms 1-3 was a census of TEST consumers, and an image build is not a test.
    //
    // THIS ASSERTS THE THREE HALVES TOGETHER, because any one of them alone is silently inert: the
    // Dockerfile must take the image from an ARG, compose must pass that ARG through, and the mirror
    // must export it under that exact name.
    const dockerfile = readRepoFile("Dockerfile");
    expect(dockerfile).toMatch(atLineStart("FROM ${SKOPEO_IMAGE} AS skopeo"));

    // The Node BASE image is the same consumer form (2026-08-31) — it was the last third-party
    // image the build still resolved against Docker Hub live, un-pinned, after skopeo and cosign
    // were mirrored. Both stages that use it, plus the digest-pinned ARG default from
    // tools/node/pin.env, plus the absence of a bare floating-tag FROM that would bypass the ARG.
    const nodePin = readPinEnv("tools/node/pin.env");
    expect(nodePin.NODE_PINNED_IMAGE).toMatch(/^docker\.io\/library\/node@sha256:[0-9a-f]{64}$/);
    expect(dockerfile).toMatch(atLineStart(`ARG NODE_IMAGE=${nodePin.NODE_PINNED_IMAGE}`));
    expect(dockerfile).toMatch(atLineStart("FROM ${NODE_IMAGE} AS base"));
    expect(dockerfile).toMatch(atLineStart("FROM ${NODE_IMAGE} AS runtime"));
    expect(
      dockerfile,
      "a bare `FROM node:<tag>` bypasses the pinned, mirror-servable ARG"
    ).not.toMatch(/^FROM node:/m);

    // And no `# syntax=` parser directive: it names a BuildKit frontend image that BuildKit pulls
    // from Docker Hub LIVE on a cold build — an unmirrored dependency on every fresh E2E runner.
    // A parser directive is only live on the FIRST line, so that is the line asserted.
    expect(
      dockerfile.split("\n")[0],
      "the root Dockerfile reintroduced a syntax directive — a live Docker Hub frontend pull"
    ).not.toMatch(/^#\s*syntax=/);
    expect(
      readRepoFile("tools/ci-image/Dockerfile").split("\n")[0],
      "tools/ci-image/Dockerfile reintroduced a syntax directive — a live Docker Hub frontend pull"
    ).not.toMatch(/^#\s*syntax=/);

    // A CENSUS, NOT A CASE — and this is the correction that matters. The first version of this
    // guard read `deploy/compose/docker-compose.yml` BY NAME, and a second compose file
    // (`docker-compose.federation.yml`, which e2e-m6 builds the very same Dockerfile with) had no
    // `build.args` at all. One file fixed, one file still pulling quay.io live, and a green guard
    // over the top. The property is "every compose file that BUILDS the root Dockerfile", so the
    // population is discovered from disk rather than typed here.
    const composeDir = path.join(REPO_ROOT, "deploy/compose");
    const builders = readdirSync(composeDir)
      .filter((name: string) => name.endsWith(".yml") || name.endsWith(".yaml"))
      .map((name: string) => ({
        rel: `deploy/compose/${name}`,
        text: readFileSync(path.join(composeDir, name), "utf8")
      }))
      .filter((f: { rel: string; text: string }) => /dockerfile:\s*Dockerfile\s*$/m.test(f.text));

    // Anti-vacuity: a glob that matched nothing would satisfy every assertion below.
    expect(builders.length).toBeGreaterThanOrEqual(2);

    for (const { rel, text } of builders) {
      // PASS-THROUGH FORM, and the shape is the assertion. `- SKOPEO_IMAGE` with no value means
      // "take it from the environment, and omit the arg entirely when unset", so a developer running
      // `docker compose up` with no mirror still gets the Dockerfile's pinned default. Writing
      // `SKOPEO_IMAGE=${SCP_SKOPEO_IMAGE_REF}` would pass an EMPTY string when unset and break `FROM`
      // for everyone outside CI — which is why this pins the form and not merely the presence.
      expect(text, `${rel} builds the root Dockerfile but does not pass SKOPEO_IMAGE`).toMatch(
        /^\s+- SKOPEO_IMAGE\s*$/m
      );
      expect(text, `${rel} builds the root Dockerfile but does not pass COSIGN_IMAGE`).toMatch(
        /^\s+- COSIGN_IMAGE\s*$/m
      );
      expect(text, `${rel} builds the root Dockerfile but does not pass NODE_IMAGE`).toMatch(
        /^\s+- NODE_IMAGE\s*$/m
      );
      // COMMENTS STRIPPED FIRST, and that is not fussiness — the un-stripped version of this
      // assertion FAILED on its own explanatory comment, which spells out the broken form in order to
      // warn against it. That is the repo's documented hazard in miniature: prose describing a hazard
      // satisfied a check meant to detect it. The guard must read the YAML, not the essay.
      const yamlOnly = text
        .split("\n")
        .filter((line: string) => !line.trimStart().startsWith("#"))
        .join("\n");
      expect(yamlOnly, `${rel} uses the empty-when-unset interpolation form`).not.toMatch(
        /SKOPEO_IMAGE=\$\{/
      );
      expect(yamlOnly, `${rel} uses the empty-when-unset interpolation form`).not.toMatch(
        /COSIGN_IMAGE=\$\{/
      );
      expect(yamlOnly, `${rel} uses the empty-when-unset interpolation form`).not.toMatch(
        /NODE_IMAGE=\$\{/
      );
    }

    // ...and the mirror exports it under the Dockerfile's own ARG name. Exporting only the
    // `SCP_`-prefixed ref — which is what shipped — leaves the build pulling upstream while every
    // other consumer is served from the mirror, which is exactly how this survived one outage.
    const mirror = readRepoFile("scripts/ci-mirror.sh");
    expect(mirror).toContain('echo "SKOPEO_IMAGE=${skopeo_ref}"');
    expect(mirror).toContain('echo "COSIGN_IMAGE=${cosign_ref}"');
    expect(mirror).toContain('echo "NODE_IMAGE=${node_ref}"');
    // …and the manifest itself carries the node pin BY VARIABLE, the same no-drift contract the
    // two CLI pins have (ci-offline-mirror.test.ts asserts theirs; this is the node twin).
    expect(readRepoFile("tools/ci-mirror/images.list")).toMatch(
      atLineStart("${NODE_PINNED_IMAGE}")
    );
  });

  it("the wrapper runs the vendored binary against the vendored loader, from the libexec dir", () => {
    // The wrapper's header comment describes both of these lines in prose, so raw `.toContain`
    // here was satisfied by the documentation of the wrapper rather than the wrapper.
    const wrapper = readRepoFile("tools/skopeo/skopeo-wrapper.sh");
    expect(wrapper).toMatch(atLineStart(`d=${pin.SKOPEO_LIBEXEC_DIR}`));
    expect(wrapper).toMatch(
      atLineStart('exec "$d/lib/ld-linux-x86-64.so.2" --library-path "$d/lib" "$d/skopeo" "$@"')
    );
  });

  it("the release path is untouched: install.sh still uses the operator's PATH skopeo", () => {
    // The vendored skopeo is for the runtime image (the c2 relay), NOT for the air-gap
    // release/bundle path — install.sh runs on an operator's install target where
    // /opt/scp/bin does not exist, and its skopeo remains the operator-supplied one.
    const installSh = readRepoFile("deploy/airgap/assets/install.sh");
    expect(installSh).not.toContain("/opt/scp/bin/skopeo");
    expect(installSh).not.toContain(SKOPEO_BIN_ENV);
  });
});

describe("skopeo pin: resolution point", () => {
  const originalOverride = process.env[SKOPEO_BIN_ENV];

  afterEach(() => {
    if (originalOverride === undefined) delete process.env[SKOPEO_BIN_ENV];
    else process.env[SKOPEO_BIN_ENV] = originalOverride;
  });

  it(`${SKOPEO_BIN_ENV} designates a pinned binary`, () => {
    process.env[SKOPEO_BIN_ENV] = "/somewhere/else/skopeo";
    expect(resolveSkopeo()).toEqual({
      bin: "/somewhere/else/skopeo",
      pinned: true,
      source: "override"
    });
  });

  it("without an override, resolution is never 'pinned' unless it found the vendored path", () => {
    delete process.env[SKOPEO_BIN_ENV];
    const resolved = resolveSkopeo();
    // On a dev machine / CI runner this is normally the PATH skopeo (the same one the
    // release-path suites use); inside the runtime image it is the vendored wrapper. Either way
    // `pinned` must be true ONLY for the vendored path — that is what keeps an operator's
    // /usr/local/bin/skopeo from being mislabelled as vetted.
    expect(resolved.pinned).toBe(resolved.bin === VENDORED_SKOPEO_PATH);
  });

  it("an unpinned resolution is never version-asserted (operators bring their own skopeo)", () => {
    expect(() =>
      assertPinnedSkopeoVersion({ bin: "skopeo", pinned: false, source: "path" })
    ).not.toThrow();
  });
});

describe("skopeo pin: the version assertion FAILS CLOSED", () => {
  it("throws when a pinned binary cannot be executed at all", () => {
    expect(() =>
      assertPinnedSkopeoVersion({
        bin: "/nonexistent/definitely-not-skopeo",
        pinned: true,
        source: "override"
      })
    ).toThrow(/could not be executed|did not report a version/i);
  });

  it("throws when a pinned binary reports the WRONG version", () => {
    // `true` exits 0 and prints nothing, so it stands in for "some binary that is not our
    // skopeo" without needing a second real skopeo build on the box.
    expect(() =>
      assertPinnedSkopeoVersion({ bin: "/usr/bin/true", pinned: true, source: "override" })
    ).toThrow(/refusing|mismatch|did not report a version/i);
  });
});

/**
 * The real thing: when a pinned skopeo is actually present (inside the runtime image, or wherever
 * SCP_SKOPEO_BIN points at an extracted pin), its reported version MUST equal the pin. Skips —
 * never falsely fails — where no pinned binary exists (dev machines and today's CI, whose PATH
 * skopeo serves the release-path suites and is deliberately unpinned).
 */
const pinnedPresent = (() => {
  const resolved = resolveSkopeo();
  return resolved.pinned && skopeoReportedVersion(resolved.bin) !== null;
})();

describe.skipIf(!pinnedPresent)(
  "skopeo pin: the resolved pinned binary IS the pinned release",
  () => {
    it("reports exactly the pinned version", () => {
      const resolved = resolveSkopeo();
      expect(skopeoReportedVersion(resolved.bin)).toBe(PINNED_SKOPEO_VERSION);
      expect(() => assertPinnedSkopeoVersion(resolved)).not.toThrow();
    });
  }
);
