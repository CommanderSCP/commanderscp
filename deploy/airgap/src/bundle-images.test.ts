import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { readStripped } from "@scp/source-census";
import {
  BUNDLE_IMAGE_SPECS,
  RUNNER_IMAGE_NAMES,
  optionKey,
  runnerAppDirName
} from "./bundle-images.js";
import { buildManifest, renderManifestSh } from "./manifest.js";
import { renderOfflineInstallDoc } from "./offline-install-doc.js";
import { run } from "@scp/cosign";
import type { BundleImage } from "./types.js";

/** The gate behind M21.7 item 1. See docs/airgap.md §2. */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(HERE, "../../..");
const APPS_DIR = path.join(REPO_ROOT, "apps");
const CLI_SOURCE = path.join(PACKAGE_ROOT, "src", "build-bundle.ts");
const TSX_BIN = path.join(PACKAGE_ROOT, "node_modules", ".bin", "tsx");

const bundledNames = BUNDLE_IMAGE_SPECS.map((s) => s.name);

describe("every runner image the repo builds is carried by the bundle", () => {
  /** The census is taken from the filesystem, not a list here. See docs/airgap.md §3. */
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
  /** THE WIRING PROOF. See docs/airgap.md §4. */
  const runCli = (args: string[]): { name: string; source: string }[] => {
    if (!existsSync(TSX_BIN)) {
      throw new Error(
        `${TSX_BIN} not found — run \`pnpm install\` (tsx is a devDependency of @scp/airgap, and ` +
          `this suite runs the CLI's SOURCE so it cannot pass against a stale dist/)`
      );
    }
    const { stdout } = run(TSX_BIN, [CLI_SOURCE, ...args], { log: false });
    return stdout
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((line) => {
        const [name, source] = line.split("\t");
        return { name: name!, source: source! };
      });
  };

  const listed = runCli(["--list-images"]);

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

  /** Every stem in one run, proving the mapping is a bijection. See docs/airgap.md §5. */
  const probed = runCli([
    "--list-images",
    ...BUNDLE_IMAGE_SPECS.flatMap((s) => [
      `--${s.optionStem}-ref`,
      `example.test/probe-${s.optionStem}:1`,
      `--${s.optionStem}-source`,
      "docker"
    ])
  ]);

  it.each(BUNDLE_IMAGE_SPECS.map((s) => [s.name, s.optionStem] as const))(
    "%s is pointable at a different source via --%s-ref (the flags come from the same list)",
    (name, optionStem) => {
      expect(probed.find((l) => l.name === name)).toEqual({
        name,
        source: `docker:example.test/probe-${optionStem}:1`
      });
      // ...and the flag key commander derives is the one resolveImageSources() reads back.
      expect(optionKey(optionStem, "ref")).toMatch(/^[a-zA-Z0-9]+$/);
    }
  );
});

describe("install.sh can address every bundled image by the shell stem manifest.sh emits", () => {
  /** install.sh does not know any image's name. See docs/airgap.md §6. */
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

  /** The M21.7 class, INVERTED. Above. See docs/airgap.md §7. */
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
      expect(
        sh,
        `install.sh reads ${stem}_* but no bundled image derives the stem ${stem}`
      ).toMatch(new RegExp(`^${stem}_DIGEST=`, "m"));
    }
  });
});

/** KNOB EXTRACTION, SHARED BY EVERY SURFACE THAT PRESCRIBES ONE. See docs/airgap.md §8. */

/** `SCP_MANAGED_SCAN_RUNNER_IMAGE=…` — an env var presented as something to set. */
const envKnobs = (text: string): string[] => [
  ...new Set([...text.matchAll(/\b(SCP_[A-Z0-9_]+)=/g)].map((m) => m[1]!))
];
const chartKnobs = (text: string): string[] => [
  ...new Set(
    [...text.matchAll(/\b([a-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+)=/g)].map((m) => m[1]!)
  )
];

/** Every dotted path defined in a shipped chart's values.yaml, e.g. `managedDep.runnerImage`. */
const chartValuePaths = (chartDir: string): string[] => {
  const doc: unknown = parseYaml(
    readFileSync(path.join(REPO_ROOT, chartDir, "values.yaml"), "utf8")
  );
  const out: string[] = [];
  const walk = (node: unknown, prefix: string): void => {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return;
    for (const [key, value] of Object.entries(node)) {
      const dotted = prefix === "" ? key : `${prefix}.${key}`;
      out.push(dotted);
      walk(value, dotted);
    }
  };
  walk(doc, "");
  return out;
};
// install.sh drives BOTH shipped charts: the SCP release (deploy/helm) and, via scp-bundled.sh,
// the out-of-release bundled-backends chart (deploy/helm-bundled) whose `bundledExecutor.*`
// values it computes in the same branch. A knob is real if either chart defines it.
const definedChartValues = new Set([
  ...chartValuePaths("deploy/helm"),
  ...chartValuePaths("deploy/helm-bundled")
]);

/** The env vars the server actually reads. See docs/airgap.md §9. */
const executorBindingsSource = (): string =>
  readStripped(path.join(REPO_ROOT, "apps/server/src/coordination/executor-bindings-repo.ts"));

describe("every knob install.sh prescribes is a lever in the mode it prints it in", () => {
  /** The scan-runner activation block was printed under one flag. See docs/airgap.md §10. */
  const installSh = readFileSync(path.join(PACKAGE_ROOT, "assets", "install.sh"), "utf8");

  /** install.sh's step 4 is one top-level. See docs/airgap.md §11. */
  const HELM_IF = '\nif [[ "$MODE" == "helm" ]]; then\n';
  const openIdx = installSh.indexOf(HELM_IF);
  const elseIdx = installSh.indexOf("\nelse\n", openIdx);
  const fiIdx = installSh.indexOf("\nfi\n", elseIdx);
  if (openIdx < 0 || elseIdx < 0 || fiIdx < 0) {
    throw new Error(
      "install.sh: could not find the top-level step-4 `if $MODE == helm ... else ... fi` — the " +
        "mode split this suite reasons about no longer exists in the shape it assumes"
    );
  }
  const regions = {
    helm: installSh.slice(openIdx, elseIdx),
    compose: installSh.slice(elseIdx, fiIdx)
  };

  /** Only what the operator SEES. A comment cannot mislead someone standing at a terminal. */
  const echoed = (region: string): string =>
    region
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("echo "))
      .join("\n");

  it("the chart values install.sh sets or prints under helm all exist in a shipped chart", () => {
    const knobs = [
      ...chartKnobs(regions.helm),
      ...[...regions.helm.matchAll(/--set "([^"=]+)=/g)].map((m) => m[1]!)
    ];
    // Guard the extraction: a regex that matched nothing would pass every assertion below.
    expect(knobs).toContain("image.repository");
    expect(knobs).toContain("managedIac.runnerImage");

    for (const knob of knobs) {
      expect(
        definedChartValues.has(knob),
        `install.sh's helm branch names the chart value '${knob}', which neither ` +
          `deploy/helm/values.yaml nor deploy/helm-bundled/values.yaml defines — under helm a ` +
          `chart value is the operator's only lever, so a knob no chart has is a no-op`
      ).toBe(true);
    }
  });

  it("the helm branch prints no env-var knob — the chart is the only lever there", () => {
    // THE ORIGINAL DEFECT. `SCP_MANAGED_SCAN_RUNNER_IMAGE=<ref>` was printed here as an
    // instruction; nothing in deploy/helm turns an operator-supplied env var into a pod env var,
    // so following it changed nothing. Guarded below by proving the same extraction DOES find
    // env knobs in the compose branch, where they are real.
    const helmEnvKnobs = envKnobs(echoed(regions.helm));
    expect(
      helmEnvKnobs,
      `install.sh's helm branch tells the operator to set ${helmEnvKnobs.join(", ")}; helm has no ` +
        `mechanism to carry an env var into the pods, so that instruction silently does nothing. ` +
        `Either add a chart value that renders it, or say plainly that this mode cannot enable it`
    ).toEqual([]);
    expect(envKnobs(echoed(regions.compose)).length).toBeGreaterThan(0);
  });

  it("the compose branch prints no chart-value knob — helm values are not a lever there", () => {
    const composeChartKnobs = chartKnobs(echoed(regions.compose));
    expect(
      composeChartKnobs,
      `install.sh's compose branch names the Helm value(s) ${composeChartKnobs.join(", ")}; a ` +
        `compose install runs no chart, so there is nothing for that setting to reach`
    ).toEqual([]);
    expect(chartKnobs(echoed(regions.helm)).length).toBeGreaterThan(0);
  });

  /** VERIFY THE LEVER, NOT JUST THE SIGNAL. See docs/airgap.md §12. */
  it("finds compose-mode env knobs at all (guards the per-knob cases below from being empty)", () => {
    // `it.each([])` runs nothing and reports nothing — a deleted compose block would silently
    // delete its own coverage. Named here so that becomes a failure instead.
    expect(envKnobs(echoed(regions.compose))).toEqual(
      expect.arrayContaining([
        "SCP_MANAGED_IAC_RUNNER_IMAGE",
        "SCP_MANAGED_SCAN_RUNNER_IMAGE",
        "SCP_MANAGED_DEP_RUNNER_IMAGE"
      ])
    );
  });

  it.each(envKnobs(echoed(regions.compose)))(
    "%s, printed as a compose-mode instruction, is an env var the server actually reads",
    (knob) => {
      const settings = executorBindingsSource();
      expect(
        settings.includes(`process.env.${knob}`),
        `install.sh tells a compose operator to set ${knob}, but ` +
          `apps/server/src/coordination/executor-bindings-repo.ts never reads it`
      ).toBe(true);
    }
  );

  it.each(RUNNER_IMAGE_NAMES)(
    "compose mode — the mode a runner can actually launch in — tells the operator how to enable %s",
    (name) => {
      const line = echoed(regions.compose)
        .split("\n")
        .find((l) => l.includes(name));
      expect(
        line,
        `install.sh's compose branch never mentions ${name}; compose/VM is the one shipped mode ` +
          `whose launch mechanism (the docker CLI, DESIGN §12) can start a runner at all, so an ` +
          `operator gets the activation guidance HERE or nowhere`
      ).toBeDefined();
      expect(envKnobs(line!).length).toBeGreaterThan(0);
    }
  );

  it.each(RUNNER_IMAGE_NAMES)(
    "helm mode still tells the operator %s is present, without prescribing a knob for it",
    (name) => {
      // Not silence: the image IS in their registry, digest-pinned, and they should know. What
      // helm mode must not do is dress that inventory up as an activation instruction.
      expect(echoed(regions.helm)).toContain(name);
    }
  );
});

describe("the prose docs point at the canonical list instead of restating it", () => {
  /** Both docs kept restating the list they promised to point at. See docs/airgap.md §13. */
  const designDoc = readFileSync(path.join(REPO_ROOT, "docs/DESIGN.md"), "utf8");
  const sec16Start = designDoc.indexOf("\n## 16. Deployment & Packaging\n");
  const sec16End = designDoc.indexOf("\n## 17.", sec16Start);
  const docs = [
    {
      label: "deploy/airgap/README.md",
      text: readFileSync(path.join(PACKAGE_ROOT, "README.md"), "utf8")
    },
    { label: "docs/DESIGN.md §16", text: designDoc.slice(sec16Start, sec16End) }
  ];

  it("finds both docs, and DESIGN §16's real body (guards the slicing above)", () => {
    expect(sec16Start).toBeGreaterThan(-1);
    expect(sec16End).toBeGreaterThan(sec16Start);
    // An empty or wrongly-sliced §16 would pass every "does not name them all" case vacuously.
    expect(docs[1]!.text).toContain("scp-bundle-<version>.tar.gz");
    expect(docs[0]!.text).toContain("scp-bundle-<version>/");
  });

  it.each(docs.map((d) => d.label))("%s points the reader at bundle-images.ts", (label) => {
    const doc = docs.find((d) => d.label === label)!;
    expect(
      doc.text,
      `${label} neither carries the list nor says where it lives — a reader has nowhere to go`
    ).toContain("bundle-images.ts");
  });

  it.each(docs.map((d) => d.label))("%s does not re-enumerate every bundled image", (label) => {
    const doc = docs.find((d) => d.label === label)!;
    const named = BUNDLE_IMAGE_SPECS.map((s) => s.name).filter((n) => doc.text.includes(n));
    const missing = BUNDLE_IMAGE_SPECS.map((s) => s.name).filter((n) => !doc.text.includes(n));
    expect(
      missing.length,
      `${label} names all ${named.length} bundled images (${named.join(", ")}) — that is a second ` +
        `copy of the canonical list, and the copy is what goes stale. Point at ` +
        `deploy/airgap/src/bundle-images.ts (or \`--list-images\`) instead`
    ).toBeGreaterThan(0);
  });
});

describe("the operator-facing offline install doc lists what actually crossed the air gap", () => {
  const doc = renderOfflineInstallDoc("1.0.0-rc");

  it.each(BUNDLE_IMAGE_SPECS.map((s) => s.name))("names %s in the contents tree", (name) => {
    expect(doc).toContain(`    ${name}/`);
  });

  /** The case above is a doc<->spec CONSISTENCY check. See docs/airgap.md §14. */
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

  /** Naming the runner is not checking what to set. See docs/airgap.md §15. */
  const runnerSection = (): string => {
    const start = doc.indexOf("## The managed-execution runner images");
    if (start < 0) throw new Error("offline install doc: runner section heading is gone");
    const end = doc.indexOf("\n## ", start + 1);
    return end < 0 ? doc.slice(start) : doc.slice(start, end);
  };

  it("names no chart value that neither shipped chart defines", () => {
    const knobs = chartKnobs(runnerSection());
    // Guard the extraction: a regex that matched nothing would pass the loop below vacuously.
    // The doc legitimately names this one — to say it renders env vars WITHOUT launching anything.
    expect(
      knobs,
      "the runner section names no chart value at all, so this case proves nothing — either the " +
        "extraction broke or the honest `managedIac.enabled` sentence was dropped"
    ).toContain("managedIac.enabled");

    for (const knob of knobs) {
      expect(
        definedChartValues.has(knob),
        `the bundled OFFLINE_INSTALL.md names the chart value '${knob}', which neither ` +
          `deploy/helm/values.yaml nor deploy/helm-bundled/values.yaml defines. On the far side ` +
          `of an air gap a helm value that no chart has applies cleanly and changes nothing — ` +
          `"it didn't take" is expensive to discover there`
      ).toBe(true);
    }
  });

  it.each(RUNNER_IMAGE_NAMES)(
    "the activation cell for %s prescribes an env var the server reads, and no chart value",
    (name) => {
      const row = runnerSection()
        .split("\n")
        .find((l) => l.startsWith("|") && l.includes(name));
      expect(
        row,
        `the enable table has no row for ${name}, so the doc's activation guidance cannot be ` +
          `checked — the operator gets it here or nowhere`
      ).toBeDefined();

      // Compose/VM is the one shipped mode whose launch mechanism (the docker CLI, DESIGN §12) can
      // start a runner, and there the lever is an env var on the `scp` service. A chart value in
      // this column would be the original defect, re-rendered into the doc that crosses the gap.
      expect(
        chartKnobs(row!),
        `${name}'s "How to enable (compose/VM)" cell names a Helm value; a compose install runs ` +
          `no chart, so there is nothing for that setting to reach`
      ).toEqual([]);

      const knobs = envKnobs(row!);
      expect(
        knobs.length,
        `${name}'s activation cell prescribes no SCP_* env var, so the doc names the runner ` +
          `without ever saying what switches it on`
      ).toBeGreaterThan(0);

      // VERIFY THE LEVER, NOT JUST THE SIGNAL: the env var is only an instruction if it is read.
      const settings = executorBindingsSource();
      for (const knob of knobs) {
        expect(
          settings.includes(`process.env.${knob}`),
          `the bundled OFFLINE_INSTALL.md tells a compose operator to set ${knob} to enable ` +
            `${name}, but apps/server/src/coordination/executor-bindings-repo.ts never reads it`
        ).toBe(true);
      }
    }
  );
});
