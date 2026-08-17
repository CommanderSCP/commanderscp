import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BUNDLE_IMAGE_SPECS,
  RUNNER_IMAGE_NAMES,
  optionKey,
  runnerAppDirName
} from "./bundle-images.js";
import { buildManifest, renderManifestSh } from "./manifest.js";
import { renderOfflineInstallDoc } from "./offline-install-doc.js";
import { run } from "./exec.js";
import type { BundleImage } from "./types.js";

/**
 * The gate behind M21.7 item 1: for two releases the air-gap bundle carried ONE of the product's
 * three managed-execution runner images. `scp-runner-scan` (M13.3b) and `scp-runner-dep` (M21.5)
 * were built by `apps/runner-*`, published by `publish-images.yml`, referenced by
 * `deploy/helm/values.yaml` — and absent from every bundle, so on a disconnected install those two
 * executors had no image to run. Charter principle 5 makes air-gap first-class.
 *
 * The PROPERTY that allowed it: nothing enumerated the class "runner images the product ships", so
 * the bundle's list and the repo's runners could disagree indefinitely and no test could notice.
 * These assertions close the class rather than the two instances — a fourth runner added under
 * `apps/` and left out of the bundle fails here on its first CI run.
 *
 * Deliberately NOT asserted anywhere below: a COUNT of images, or their ORDER. Both would go green
 * on the wrong list. Every assertion names the specific image it is about.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const APPS_DIR = path.join(REPO_ROOT, "apps");
const BUILT_CLI = path.resolve(HERE, "../dist/build-bundle.js");

const bundledNames = BUNDLE_IMAGE_SPECS.map((s) => s.name);

describe("every runner image the repo builds is carried by the bundle", () => {
  /**
   * The census is taken from the FILESYSTEM, not from a list in this file: `apps/runner-*` is the
   * set of runner images that exist, and it is not something a change to `bundle-images.ts` can
   * quietly shrink. (A filter here would be where the next missing runner hides — CLAUDE.md
   * "Census by property, not by symptom".)
   */
  const runnerAppDirs = readdirSync(APPS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith("runner-"))
    .map((e) => e.name)
    .sort();

  it("finds the runner apps on disk at all (guards the census itself against a silent empty set)", () => {
    // If `apps/runner-*` ever moves, this suite would otherwise pass vacuously by iterating
    // nothing — the exact "fixture silently never applied" failure the per-runner cases exist to
    // avoid. Named rather than counted: these three must be there.
    expect(runnerAppDirs).toContain("runner-iac");
    expect(runnerAppDirs).toContain("runner-scan");
    expect(runnerAppDirs).toContain("runner-dep");
  });

  it.each(["runner-iac", "runner-scan", "runner-dep"])(
    "apps/%s builds an image the bundle carries",
    (appDir) => {
      expect(bundledNames).toContain(`scp-${appDir}`);
    }
  );

  it("has no runner app on disk that the bundle would leave behind", () => {
    const missing = runnerAppDirs.filter((dir) => !bundledNames.includes(`scp-${dir}`));
    expect(
      missing,
      `apps/${missing.join(", apps/")} build runner images no bundle carries`
    ).toEqual([]);
  });

  it("names the same runners in RUNNER_IMAGE_NAMES, and each maps back to its apps/ directory", () => {
    for (const name of RUNNER_IMAGE_NAMES) {
      expect(bundledNames).toContain(name);
      expect(existsSync(path.join(APPS_DIR, runnerAppDirName(name)))).toBe(true);
    }
    for (const dir of runnerAppDirs) {
      expect(RUNNER_IMAGE_NAMES as readonly string[]).toContain(`scp-${dir}`);
    }
  });
});

describe("build-bundle, run for real, carries what the canonical list says", () => {
  /**
   * THE WIRING PROOF. Everything above tests the LIST; this spawns the SHIPPED ENTRYPOINT
   * (`dist/build-bundle.js`, the file `package.json`'s `scp-airgap-build` bin points at) and reads
   * the list it actually resolved. A `bundle-images.ts` that names all three runners while
   * `build-bundle.ts` keeps a hardcoded array of its own is precisely the "component built, never
   * installed" defect this repo keeps shipping, and only running the entrypoint can rule it out.
   *
   * `dist/` is a build output, not committed. Turborepo's `test` task `dependsOn: ["build"]`, so
   * it is always present under `pnpm test`. When it isn't, this FAILS with instructions rather
   * than skipping — a skipped wiring proof is indistinguishable from a passing one.
   */
  const listed = (() => {
    if (!existsSync(BUILT_CLI)) {
      throw new Error(
        `${BUILT_CLI} not found — run \`pnpm --filter @scp/airgap build\` first ` +
          `(turbo's test task normally does this via dependsOn: ["build"])`
      );
    }
    const { stdout } = run(process.execPath, [BUILT_CLI, "--list-images"], { log: false });
    return stdout
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((line) => {
        const [name, source] = line.split("\t");
        return { name: name!, source: source! };
      });
  })();

  it.each(RUNNER_IMAGE_NAMES)("the real CLI resolves %s as an image to bundle", (name) => {
    const spec = BUNDLE_IMAGE_SPECS.find((s) => s.name === name)!;
    expect(listed.find((l) => l.name === name)).toEqual({
      name,
      source: `${spec.defaultSource}:${spec.defaultRef}`
    });
  });

  it.each(BUNDLE_IMAGE_SPECS.map((s) => s.name))(
    "the real CLI also still resolves the pre-existing image %s",
    (name) => {
      expect(listed.map((l) => l.name)).toContain(name);
    }
  );

  it("resolves nothing the canonical list does not name", () => {
    expect(listed.map((l) => l.name).filter((n) => !bundledNames.includes(n))).toEqual([]);
  });

  it.each(BUNDLE_IMAGE_SPECS.map((s) => [s.name, s.optionStem] as const))(
    "%s is pointable at a different source via --%s-ref (the flags come from the same list)",
    (name, optionStem) => {
      const { stdout } = run(
        process.execPath,
        [
          BUILT_CLI,
          "--list-images",
          `--${optionStem}-ref`,
          "example.test/probe:1",
          `--${optionStem}-source`,
          "docker"
        ],
        { log: false }
      );
      expect(stdout).toContain(`${name}\tdocker:example.test/probe:1`);
      // ...and the flag key commander derives is the one resolveImageSources() reads back.
      expect(optionKey(optionStem, "ref")).toMatch(/^[a-zA-Z0-9]+$/);
    }
  );
});

describe("install.sh can address every bundled image by the shell stem manifest.sh emits", () => {
  /**
   * install.sh does not know any image's name: it loops over `$BUNDLE_IMAGE_NAMES` and derives
   * each variable stem with `printf '%s' "$name" | tr '[:lower:]' '[:upper:]' | tr -c 'A-Z0-9' '_'`.
   * manifest.ts derives the same stem with a JS regex. Two independent implementations of one rule,
   * and the new names are the first to exercise a doubled hyphen path (`scp-runner-scan` ->
   * SCP_RUNNER_SCAN), so they are checked by RUNNING the bash pipeline rather than by restating it.
   */
  const images: BundleImage[] = BUNDLE_IMAGE_SPECS.map((spec, i) => ({
    name: spec.name,
    sourceRef: spec.defaultRef,
    sourceType: spec.defaultSource,
    ociPath: `images/${spec.name}`,
    ociTag: "1.0.0-rc",
    // A distinct digest per image so a stem collision cannot be masked by equal values.
    manifestDigest: "sha256:" + String(i).padStart(2, "0").repeat(32)
  }));
  const sh = renderManifestSh(buildManifest(images, "1.0.0-rc", "2026-08-16T00:00:00.000Z"));

  it.each(BUNDLE_IMAGE_SPECS.map((s) => s.name))(
    "%s: bash's stem pipeline finds a digest manifest.sh actually emitted",
    (name) => {
      const { stdout } = run(
        "sh",
        ["-c", `printf '%s' "$1" | tr '[:lower:]' '[:upper:]' | tr -c 'A-Z0-9' '_'`, "sh", name],
        { log: false }
      );
      const stem = stdout;
      const image = images.find((im) => im.name === name)!;
      expect(sh).toContain(`${stem}_DIGEST='${image.manifestDigest}'`);
      expect(sh).toContain(`${stem}_OCI_PATH='images/${name}'`);
    }
  );

  it("emits each bundled image's name into BUNDLE_IMAGE_NAMES, the list install.sh loops over", () => {
    const line = sh.split("\n").find((l) => l.startsWith("BUNDLE_IMAGE_NAMES="))!;
    for (const spec of BUNDLE_IMAGE_SPECS) {
      expect(line.split(/[\s']/)).toContain(spec.name);
    }
  });

  it("the two runners install.sh prints pinned refs for are addressed by the stems it hardcodes", () => {
    // install.sh reads SCP_RUNNER_SCAN_* / SCP_RUNNER_DEP_* by name (it cannot loop there — each
    // line names a different chart value / env var). Those literal stems must be the ones emitted.
    expect(sh).toMatch(/^SCP_RUNNER_SCAN_DIGEST=/m);
    expect(sh).toMatch(/^SCP_RUNNER_DEP_DIGEST=/m);
  });

  /**
   * The M21.7 class, INVERTED. Above: an image the bundle carries that install.sh cannot address.
   * Here: an image install.sh addresses that the bundle does not carry — the same disagreement
   * from the other side, and the one that fails at 3am on a disconnected cluster with
   * `SCP_RUNNER_X_DIGEST: unbound variable` under `set -u`.
   *
   * install.sh's verify/push loops are generic over `$BUNDLE_IMAGE_NAMES`, but its step-4 helm
   * wiring necessarily names stems literally (each maps to a different chart value or env var).
   * Those literals are read OUT OF THE REAL SCRIPT here rather than restated, so a stem added to
   * install.sh without an image behind it fails on its first run.
   */
  it("every image stem install.sh names literally is a stem manifest.sh emits", () => {
    const installSh = readFileSync(
      fileURLToPath(new URL("../assets/install.sh", import.meta.url)),
      "utf8"
    );
    // `${SCPD_DIGEST}` / `${ARGOCD_RETARGETED_REF:-...}` — uppercase literals only. The generic
    // loops use `"${stem}_DIGEST"` (lowercase `stem`), which deliberately does not match.
    const stems = new Set(
      [...installSh.matchAll(/\$\{([A-Z0-9_]+?)_(?:DIGEST|RETARGETED_REF)\b/g)].map((m) => m[1]!)
    );
    // Guard the extraction itself: a regex that silently matched nothing would pass every
    // assertion below. install.sh demonstrably names scpd's stem.
    expect([...stems]).toContain("SCPD");

    for (const stem of stems) {
      expect(sh, `install.sh reads ${stem}_* but no bundled image derives the stem ${stem}`).toMatch(
        new RegExp(`^${stem}_DIGEST=`, "m")
      );
    }
  });
});

describe("the operator-facing offline install doc lists what actually crossed the air gap", () => {
  const doc = renderOfflineInstallDoc("1.0.0-rc");

  it.each(BUNDLE_IMAGE_SPECS.map((s) => s.name))("names %s in the contents tree", (name) => {
    expect(doc).toContain(`    ${name}/`);
  });

  /**
   * The case above is a doc<->spec CONSISTENCY check: drop an image from the spec and both sides
   * shrink together, so it goes green on the wrong list. This one is anchored to the runner class
   * instead (which `RUNNER_IMAGE_NAMES` holds against `apps/runner-*`), so the inventory an
   * operator reads cannot quietly lose a runner.
   */
  it.each(RUNNER_IMAGE_NAMES)("names the runner %s in the contents tree", (name) => {
    expect(doc).toContain(`    ${name}/`);
  });

  it("carries the section explaining that a bundled runner is not an enabled runner", () => {
    expect(doc).toContain("## The managed-execution runner images");
  });

  it.each(RUNNER_IMAGE_NAMES)("tells the operator how to enable %s", (name) => {
    // Each runner is off until its image is named; the doc has to say which knob does it, because
    // install.sh deliberately does not set two of the three.
    const start = doc.indexOf("## The managed-execution runner images");
    expect(start).toBeGreaterThan(-1);
    expect(doc.slice(start)).toContain(name);
  });
});
