import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseKubernetesImages } from "@scp/dependency-manifests";

/**
 * THE VENDORED-IMAGE INVENTORY CENSUS (M29.8a, proposal §9.1 step 1).
 *
 * M29's dependency-subscription machinery (ADR-0032, M21) and the M29.8 "keep the stack current"
 * loop both rest on one claim: `parseKubernetesImages` sees EVERY image the Standard Stack's
 * vendored manifests and `deploy/helm-bundled/values.yaml` declare. Nobody had checked that claim
 * against the real files — it was asserted per-shape, in isolation, in `kubernetes-images.test.ts`,
 * never against the actual multi-megabyte, multi-document, SPLIT-into-parts manifests this repo
 * ships. `deploy/helm-bundled/vendor/argo-workflows/install-part-0N.yaml` is exactly the shape
 * §4.4a's own worked example warns about: a property proved in one place (one small fixture
 * document) and never checked in the place that actually matters (four ~2.5 MB files whose contents
 * were split at a document boundary by hand years after the parser was written).
 *
 * THE EXPECTED SET IS BUILT INDEPENDENTLY of `parseKubernetesImages` — a plain regex scan, never the
 * `yaml` library the parser walks an AST with, and never any code this package shares with it (see
 * {@link independentImageRefs}). It only needs to answer the same narrow question a second way: what
 * image does this repo's own files ACTUALLY declare, one line at a time.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const VENDOR_DIR = resolve(REPO_ROOT, "deploy/helm-bundled/vendor");
const VALUES_YAML = resolve(REPO_ROOT, "deploy/helm-bundled/values.yaml");

/** Every tracked `.yaml`/`.yml` file under `deploy/helm-bundled/vendor/**`, NO extension filter
 *  narrower than that and no directory excluded — a census with a filter is where the next instance
 *  hides (CLAUDE.md). This walks the real filesystem tree rather than `git ls-files` deliberately:
 *  the property under test is "what `parseKubernetesImages` sees when pointed at this file", and a
 *  file the census cannot find is a file the reader cannot find either. */
function listVendorYamlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...listVendorYamlFiles(full));
    else if (/\.ya?ml$/.test(entry.name)) out.push(full);
  }
  return out.sort();
}

interface ImageRef {
  coordinate: string;
  /** Exactly one of `declared`/`digest` is set — a bare, unversioned name names no version SCP
   *  tracks, and none of the real files declare one, so this census does not synthesize that case. */
  declared?: string;
  digest?: string;
}

function refKey(ref: ImageRef): string {
  return `${ref.coordinate}\u0000${ref.declared ?? ""}\u0000${ref.digest ?? ""}`;
}

/**
 * THE INDEPENDENT EXTRACTOR. A single-line `<key>: <ref>` scalar, where `<key>` is `image`,
 * `serverImage` or `controllerImage` (the two spellings `deploy/helm-bundled/values.yaml` uses for
 * Argo Workflows' images, M29.8a) — the ONE shape every real declaration in these files uses today
 * (verified by hand against every `grep -rna "image:"` hit in `deploy/helm-bundled/vendor/` and
 * `values.yaml` before this test was written: zero split `registry`/`repository`/`tag` shapes exist
 * there). This is deliberately NOT a general-purpose Kubernetes-image reader — that is exactly the
 * parser under test — it exists only to answer the same question a second, structurally different
 * way, so the two can be compared.
 */
function independentImageRefs(content: string): ImageRef[] {
  const refs: ImageRef[] = [];
  // `[ \t]*(?:- )?` — a sequence item's FIRST key commonly rides the same line as its `-`
  // (`containers:\n  - image: foo:1.2`), which is exactly the shape `argo-rollouts/install.yaml`
  // uses and the first version of this extractor missed entirely (caught by this test disagreeing
  // with the parser on that real file — see the PR body's mutation log).
  const re =
    /^[ \t]*(?:- )?(?:image|serverImage|controllerImage):[ \t]*["']?([^"'\s#]+)["']?[ \t]*(?:#.*)?$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const raw = m[1]!;
    const at = raw.lastIndexOf("@");
    if (at > 0 && /^sha256:[0-9a-f]{64}$/.test(raw.slice(at + 1))) {
      refs.push({ coordinate: raw.slice(0, at), digest: raw.slice(at + 1) });
      continue;
    }
    const colon = raw.lastIndexOf(":");
    const firstSlash = raw.indexOf("/");
    // A colon before the first `/` is a registry PORT (`localhost:5000/x`), not a tag separator.
    // None of the real files use one; kept for correctness, not because it is exercised today.
    if (colon > 0 && (firstSlash < 0 || colon > firstSlash)) {
      refs.push({ coordinate: raw.slice(0, colon), declared: raw.slice(colon + 1) });
    }
  }
  return refs;
}

/** What `parseKubernetesImages` actually resolved, in the same {@link ImageRef} shape — dropping
 *  `unresolved` entries (a declaration the parser SAW but could not read, e.g. the deliberately-empty
 *  `bundledExecutor.argoWorkflows.catalog.infra.image`) since {@link independentImageRefs} likewise
 *  only ever proposes a ref it can read. */
function parserImageRefs(content: string): ImageRef[] {
  return parseKubernetesImages(content)
    .filter((d) => d.constraint !== "unresolved")
    .map((d) => ({
      coordinate: d.coordinate,
      ...(d.declared !== undefined ? { declared: d.declared } : {}),
      ...(d.digest !== undefined ? { digest: d.digest } : {})
    }));
}

interface Comparison {
  missingFromParser: string[];
  extraInParser: string[];
}

/** The comparison itself, factored out and unit-tested below on a synthetic mismatch — a census
 *  whose comparison never actually disagrees on anything is unfalsifiable, so the mechanism that
 *  DECIDES disagreement is proved separately from the real files it is run against. */
function compare(expected: readonly ImageRef[], actual: readonly ImageRef[]): Comparison {
  const expectedKeys = new Set(expected.map(refKey));
  const actualKeys = new Set(actual.map(refKey));
  return {
    missingFromParser: [...expectedKeys].filter((k) => !actualKeys.has(k)).sort(),
    extraInParser: [...actualKeys].filter((k) => !expectedKeys.has(k)).sort()
  };
}

describe("compare() — the comparison mechanism itself, on a synthetic mismatch", () => {
  it("reports a ref the independent extractor found but the parser did not (non-vacuity)", () => {
    const expected: ImageRef[] = [
      { coordinate: "quay.io/argoproj/argocd", declared: "v3.4.5" },
      { coordinate: "example.com/missing", declared: "v9.9.9" }
    ];
    const actual: ImageRef[] = [{ coordinate: "quay.io/argoproj/argocd", declared: "v3.4.5" }];
    const result = compare(expected, actual);
    expect(result.missingFromParser).toEqual(["example.com/missing\u0000v9.9.9\u0000"]);
    expect(result.extraInParser).toEqual([]);
  });

  it("reports a ref the parser invented that nothing in the file declares", () => {
    const result = compare(
      [{ coordinate: "a", declared: "1" }],
      [
        { coordinate: "a", declared: "1" },
        { coordinate: "b", declared: "2" }
      ]
    );
    expect(result.extraInParser).toEqual(["b\u00002\u0000"]);
    expect(result.missingFromParser).toEqual([]);
  });

  it("agrees (both empty) on identical sets, order-independent and dedup'd", () => {
    const result = compare(
      [
        { coordinate: "a", declared: "1" },
        { coordinate: "a", declared: "1" }
      ],
      [{ coordinate: "a", declared: "1" }]
    );
    expect(result.missingFromParser).toEqual([]);
    expect(result.extraInParser).toEqual([]);
  });
});

describe("independentImageRefs() — the independent extractor, on synthetic fixtures", () => {
  it("reads a plain tag ref", () => {
    expect(independentImageRefs("image: quay.io/argoproj/argocd:v3.4.5\n")).toEqual([
      { coordinate: "quay.io/argoproj/argocd", declared: "v3.4.5" }
    ]);
  });

  it("reads a quoted ref", () => {
    expect(independentImageRefs('image: "docker.gitea.com/gitea:1.26.1-rootless"\n')).toEqual([
      { coordinate: "docker.gitea.com/gitea", declared: "1.26.1-rootless" }
    ]);
  });

  it("reads a digest-pinned ref", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    expect(independentImageRefs(`image: acme/api@${digest}\n`)).toEqual([
      { coordinate: "acme/api", digest }
    ]);
  });

  it("reads serverImage/controllerImage the same way as image", () => {
    expect(
      independentImageRefs(
        "serverImage: quay.io/argoproj/argocli:v4.0.7\ncontrollerImage: quay.io/argoproj/workflow-controller:v4.0.7\n"
      )
    ).toEqual([
      { coordinate: "quay.io/argoproj/argocli", declared: "v4.0.7" },
      { coordinate: "quay.io/argoproj/workflow-controller", declared: "v4.0.7" }
    ]);
  });

  it("ignores a bare `image:` key with a mapping value on the next line (not this shape)", () => {
    expect(independentImageRefs("image:\n  repository: acme/api\n  tag: 1.2.3\n")).toEqual([]);
  });

  it("ignores an unrelated key that merely contains 'image'", () => {
    expect(independentImageRefs("imagePullPolicy: Always\n")).toEqual([]);
  });

  it("reads a sequence item's image key riding the same line as its `-` (the real argo-rollouts shape)", () => {
    // Found by this census disagreeing with the parser on the REAL vendored file: the first version
    // of this extractor required the key to be the first token on its line and missed
    // `- image: quay.io/argoproj/argo-rollouts:v1.10.0` entirely.
    expect(
      independentImageRefs("containers:\n  - image: quay.io/argoproj/argo-rollouts:v1.10.0\n")
    ).toEqual([{ coordinate: "quay.io/argoproj/argo-rollouts", declared: "v1.10.0" }]);
  });
});

describe("the vendored-image inventory census — parseKubernetesImages vs. the independent extractor", () => {
  const vendorFiles = listVendorYamlFiles(VENDOR_DIR);

  it("the census actually found files (non-vacuity) — an empty walk would make every assertion below vacuous", () => {
    expect(vendorFiles.length).toBeGreaterThan(0);
    expect(vendorFiles.some((f) => f.includes("argo-workflows/install-part-"))).toBe(true);
  });

  it.each(vendorFiles.map((f) => [f.replace(`${VENDOR_DIR}/`, ""), f] as const))(
    "%s: the parser finds exactly the images the independent extractor finds",
    (_label, file) => {
      const content = readFileSync(file, "utf8");
      const expected = independentImageRefs(content);
      const actual = parserImageRefs(content);
      const result = compare(expected, actual);
      expect(
        result,
        `parser vs independent extractor disagree on ${file}\n` +
          `  missing from parser: ${result.missingFromParser.join(", ") || "(none)"}\n` +
          `  extra in parser:     ${result.extraInParser.join(", ") || "(none)"}`
      ).toEqual({ missingFromParser: [], extraInParser: [] });
    }
  );

  it("values.yaml: the parser finds exactly the images the independent extractor finds", () => {
    const content = readFileSync(VALUES_YAML, "utf8");
    const expected = independentImageRefs(content);
    const actual = parserImageRefs(content);
    const result = compare(expected, actual);
    expect(
      result,
      `parser vs independent extractor disagree on values.yaml\n` +
        `  missing from parser: ${result.missingFromParser.join(", ") || "(none)"}\n` +
        `  extra in parser:     ${result.extraInParser.join(", ") || "(none)"}`
    ).toEqual({ missingFromParser: [], extraInParser: [] });
  });

  // MUTATION-PROVED (2026-09-25, see the PR body's log): a first version of this check combined
  // vendor/** and values.yaml into one set before comparing, and excluding an entire backend
  // directory from the walk (simulating "this image's file went unreachable") still passed — every
  // one of these six coordinates is ALSO declared in values.yaml, so the aggregate never noticed a
  // whole vendor FILE going missing. Split in two: a directory-presence check with no dependency on
  // image content at all, and a vendor-FILES-ONLY coordinate check that cannot be satisfied by
  // values.yaml's copy of the same coordinate.
  it("the walk finds all five backend directories, by name (independent of any image content)", () => {
    const backendDirs = new Set(
      vendorFiles.map((f) => f.slice(VENDOR_DIR.length + 1).split("/")[0])
    );
    expect([...backendDirs].sort()).toEqual(
      ["argo-events", "argo-rollouts", "argo-workflows", "argocd", "gitea"].sort()
    );
  });

  it("the six Standard Stack images SCP tracks are ALL present in vendor/** ALONE, not only in values.yaml", () => {
    const vendorRefs = new Set<string>();
    for (const file of vendorFiles) {
      for (const ref of parserImageRefs(readFileSync(file, "utf8"))) vendorRefs.add(refKey(ref));
    }
    const expectedCoordinates = [
      "quay.io/argoproj/argocd",
      "quay.io/argoproj/argocli",
      "quay.io/argoproj/workflow-controller",
      "quay.io/argoproj/argo-rollouts",
      "quay.io/argoproj/argo-events",
      "docker.gitea.com/gitea"
    ];
    const foundCoordinates = new Set([...vendorRefs].map((k) => k.split("\u0000")[0]));
    const missing = expectedCoordinates.filter((c) => !foundCoordinates.has(c));
    expect(
      missing,
      `these tracked backend images were not found in any vendor/** file: ${missing.join(", ")}`
    ).toEqual([]);

    // And the two upstream images this repo does NOT retarget (a real, named gap — see
    // tools/vendor-refresh's README) are still SEEN by the reader, because they really are in the
    // file: the reader's job is completeness of what is declared, not agreement with what SCP tracks.
    expect(foundCoordinates.has("ghcr.io/dexidp/dex")).toBe(true);
    expect(foundCoordinates.has("public.ecr.aws/docker/library/redis")).toBe(true);
  });
});
