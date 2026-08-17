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
const PACKAGE_ROOT = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(HERE, "../../..");
const APPS_DIR = path.join(REPO_ROOT, "apps");
const CLI_SOURCE = path.join(PACKAGE_ROOT, "src", "build-bundle.ts");
const TSX_BIN = path.join(PACKAGE_ROOT, "node_modules", ".bin", "tsx");

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
   * THE WIRING PROOF. Everything above tests the LIST; this RUNS the entrypoint and reads the list
   * it actually resolved. A `bundle-images.ts` that names all three runners while
   * `build-bundle.ts` keeps a hardcoded array of its own is precisely the "component built, never
   * installed" defect this repo keeps shipping, and only running the entrypoint can rule it out.
   *
   * IT RUNS `src/build-bundle.ts` UNDER tsx — NOT `dist/build-bundle.js`, which is what it used to
   * do and which made the proof only as fresh as the last `tsc`. Under the exact command this
   * package's README documents (`pnpm --filter @scp/airgap test` — vitest directly, NOT through
   * turbo, so `dependsOn: ["build"]` never runs), a stale `dist/` passed while the source was
   * broken: reverting `resolveImageSources` to a hardcoded three-image array and NOT rebuilding
   * left this suite green. A wiring proof that can pass against a build nobody just made is not a
   * proof of anything. Nothing is given up by driving the source: `dist/build-bundle.js` is `tsc`
   * output of this exact file and of nothing else, and the `build`/`typecheck` tasks cover that
   * compile step.
   */
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

  /**
   * Every stem probed in ONE run, each with a ref unique to that stem: this proves the
   * flag->image mapping is a bijection, which eleven separate single-flag runs would not — two
   * stems that both wrote the same option key would each pass alone and only disagree here.
   */
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
      expect(
        sh,
        `install.sh reads ${stem}_* but no bundled image derives the stem ${stem}`
      ).toMatch(new RegExp(`^${stem}_DIGEST=`, "m"));
    }
  });
});

/**
 * KNOB EXTRACTION, SHARED BY EVERY SURFACE THAT PRESCRIBES ONE.
 *
 * Hoisted out of the install.sh describe below because install.sh is not the only place that tells
 * an operator what to set: the SAME activation guidance is rendered into the bundled
 * `docs/OFFLINE_INSTALL.md` (`offline-install-doc.ts`), which `deploy/airgap/README.md` calls "the
 * one to actually read" and which ships INSIDE the bundle, on the far side of the gap. When only
 * install.sh was gated, the identical no-op instruction could be reintroduced in the doc and the
 * whole suite stayed green — measured. One definition, both surfaces.
 */

/** `SCP_MANAGED_SCAN_RUNNER_IMAGE=…` — an env var presented as something to set. */
const envKnobs = (text: string): string[] => [
  ...new Set([...text.matchAll(/\b(SCP_[A-Z0-9_]+)=/g)].map((m) => m[1]!))
];
/** `managedDep.runnerImage=…` / `postgres.evalInCluster.enabled=…` — a Helm values path. */
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

/**
 * The env vars the server actually reads — the one module all three managed classes read from.
 *
 * READ WITH COMMENTS STRIPPED, and that is the whole point of the check. MEASURED 2026-08-17: with
 * `runnerImage: process.env.SCP_MANAGED_DEP_RUNNER_IMAGE` commented out of that module, this file
 * stayed green at 87/87 — because the module also DOCUMENTS the variable in a doc comment eight
 * lines above the read ("SCP_MANAGED_DEP_RUNNER_IMAGE — the vetted, pinned `scp-runner-dep`
 * image…"). So "verify the lever, not just the signal" was verifying a third thing: the PROSE about
 * the lever. `@scp/source-census` exists so this package and `apps/server` share one reader rather
 * than each carrying a copy of the stripper.
 *
 * THE LIMIT, stated where the assertion is: stripping proves the module still MENTIONS the variable
 * in code. It cannot prove the value is used, reaches a runner, or is read on the path an operator's
 * compose install takes — `process.env.X` assigned to a field nobody consumes would satisfy every
 * assertion below. What proves the rest is `runner-image.integration.test.ts`, which launches the
 * runner for real.
 */
const executorBindingsSource = (): string =>
  readStripped(path.join(REPO_ROOT, "apps/server/src/coordination/executor-bindings-repo.ts"));

describe("every knob install.sh prescribes is a lever in the mode it prints it in", () => {
  /**
   * M21.7 item 1's follow-up defect, and the reason this whole describe exists: the block that
   * tells an air-gapped operator how to switch on `scp-runner-scan` was printed ONLY under
   * `--mode helm`, and named `SCP_MANAGED_SCAN_RUNNER_IMAGE`. Under helm the only lever an
   * operator has is a chart value, and the chart has none for that env var (helm/README.md,
   * "Still NOT settable"), so the instruction did nothing — silently, with no error, on the far
   * side of an air gap where "it didn't take" is expensive to discover. An instruction that
   * silently no-ops is worse than no instruction at all: it reads as coverage.
   *
   * The PROPERTY, not the instance: a knob is only real in the mode whose deployment mechanism can
   * carry it. Chart values are levers under helm and mean nothing under compose; env vars on the
   * `scp` service are levers under compose (and VM — `scp.platform`'s Ansible role runs install.sh
   * with `--mode compose`) and mean nothing under helm. So both directions are asserted for both
   * modes, over the text install.sh ACTUALLY PRINTS, extracted from the real script.
   */
  const installSh = readFileSync(path.join(PACKAGE_ROOT, "assets", "install.sh"), "utf8");

  /**
   * install.sh's step 4 is one top-level `if [[ "$MODE" == "helm" ]] ... else ... fi`; every
   * nested `else`/`fi` inside it is indented, so slicing on the column-0 keywords yields exactly
   * the text an operator in each mode sees.
   */
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

  /**
   * VERIFY THE LEVER, NOT JUST THE SIGNAL. The compose-mode instruction is only real if the
   * product reads that env var. All three managed classes read theirs in one module — deliberately
   * the only place this looks, and deliberately named in `turbo.json`'s inputs for this package, so
   * the two stay in step: move the read and this fails loudly rather than going quietly stale.
   */
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
  /**
   * The M21.7 commit said README.md and DESIGN §16 "stop restating the list and point at it", and
   * then both went on restating it — README's contents tree enumerated all eleven images, DESIGN
   * §16 enumerated them one sentence before the paragraph explaining that enumerating them
   * anywhere else is how `scp-runner-scan` and `scp-runner-dep` were missed for two releases. A
   * doc contradicting its own next paragraph is this repo's recurring shape, and nothing failed
   * when it happened, because nothing looked.
   *
   * WHY "MUST NOT NAME THEM ALL" RATHER THAN "MUST NAME THEM ALL": a doc that carries the whole
   * inventory has to be maintained in lockstep with `bundle-images.ts` forever, and the failure
   * mode when it isn't — a list that LOOKS complete and is one image short — is precisely the bug.
   * A doc that carries a POINTER cannot go stale. So the gate is on the restatement itself: the
   * moment a doc names every image again, it fails here.
   *
   * The bundled, operator-facing `docs/OFFLINE_INSTALL.md` is the deliberate exception, and it is
   * exempt because it is not prose: `offline-install-doc.ts` GENERATES its contents tree from the
   * same array, and the describe below holds it to naming every image.
   */
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

  /**
   * THE CASE ABOVE ONLY CHECKS THE RUNNER'S NAME IS PRESENT, NEVER WHAT THE DOC TELLS THE OPERATOR
   * TO SET. That gap was measured: rewriting the scan runner's activation cell to
   * `helm: --set managedScan.runnerImage=<printed ref>` — a chart value NEITHER shipped chart
   * defines, so the exact silent no-op M21.7 item 1 was written to remove — left the whole
   * @scp/airgap suite green (10 files, 139 passed, 0 failed).
   *
   * This doc is the higher-consequence surface of the two: install.sh's guidance scrolls past once,
   * while `docs/OFFLINE_INSTALL.md` ships inside the bundle and is the thing an air-gapped operator
   * actually reads. So it gets the SAME two-directional check install.sh's describe runs, over the
   * same extraction — a knob is real only in the mode whose deployment mechanism can carry it.
   */
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
