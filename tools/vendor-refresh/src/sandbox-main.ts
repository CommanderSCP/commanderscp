/** The `apps/runner-dep-vendor` sandbox's entrypoint logic (ADR-0059) — reads
 *  `/work/in/input.json`, runs the SAME `planVendorRefresh` every human `vendor-refresh refresh` run
 *  and every existing test already exercises (nothing about the planner itself changes for the
 *  split), classifies the diff, and writes `/work/out/output.json`. `main()` is the only piece that
 *  touches the filesystem; {@link runSandbox} is pure given its input and is what
 *  `sandbox-main.test.ts` calls directly. */
import { readFile, writeFile } from "node:fs/promises";
import { classifyRevendorDiff, type DiffClassification } from "./classify.js";
import { buildSandboxIO, type SandboxInput } from "./sandbox-io.js";
import {
  BUNDLE_IMAGES_TS_PATH,
  IMAGES_LIST_PATH,
  planVendorRefresh,
  VALUES_YAML_PATH
} from "./plan.js";
import type { VendorFile, VendorRefreshPlan } from "./types.js";

/** {@link SandboxInput} plus the three repo files `planVendorRefresh` patches, and the CURRENTLY
 *  vendored manifest text (keyed by repo-relative path — whatever paths this backend's vendor dir
 *  holds today, before this run), for the classifier's old/new comparison. */
export interface FullSandboxInput extends SandboxInput {
  valuesYaml: string;
  bundleImagesTs: string;
  imagesList: string;
  currentVendoredFiles: Record<string, string>;
}

export interface SandboxOutput {
  plan: VendorRefreshPlan;
  classification: DiffClassification;
}

/** A vendored Kubernetes manifest the classifier should look at — everything else `planVendorRefresh`
 *  writes (`values.yaml`, `bundle-images.ts`, `images.list`, gitea's extracted shell scripts) is
 *  config/script text the classifier was never built to parse as Kubernetes objects; scoping to this
 *  shape is what keeps a false "changed outside a tracked image" verdict from firing on, say, a shell
 *  script extraction whose bytes happen to differ for a reason that has nothing to do with authority.
 */
function isVendoredManifestYaml(path: string): boolean {
  return path.startsWith("deploy/helm-bundled/vendor/") && path.endsWith(".yaml");
}

export async function runSandbox(
  input: FullSandboxInput,
  /** Injectable ONLY for tests — `main()` always takes the default, which shells out to the pinned
   *  `helm` this image vendors. See `buildSandboxIO`'s own `execFn` parameter. */
  execFn?: (bin: string, args: string[]) => string
): Promise<SandboxOutput> {
  const io = execFn === undefined ? buildSandboxIO(input) : buildSandboxIO(input, execFn);
  const repoFiles: Record<string, string> = {
    [VALUES_YAML_PATH]: input.valuesYaml,
    [BUNDLE_IMAGES_TS_PATH]: input.bundleImagesTs,
    [IMAGES_LIST_PATH]: input.imagesList
  };
  const readRepoFile = async (path: string): Promise<string> => {
    const content = repoFiles[path];
    if (content === undefined) {
      throw new Error(
        `vendor-refresh sandbox: readRepoFile('${path}') — no such file was supplied in the sandbox input`
      );
    }
    return content;
  };

  const plan = await planVendorRefresh(input.backend, input.toTag, io, readRepoFile, {
    giteaChartRef: input.chartDir
  });

  // CLASSIFY OLD vs NEW, concatenated ACROSS every vendored-manifest file on each side (not
  // matched path-by-path) — an object that MOVED between split parts between releases (argo-workflows
  // may reshuffle its 4-way split at any tag; `argo-workflows.yaml`'s `.Files.Glob` already treats
  // the part count as upstream's to change, not this tool's) is still the SAME object by
  // kind/namespace/name on both sides of a single concatenated document, so a pure reshuffle is not
  // itself mistaken for an add+remove. A genuinely REMOVED object (present in the old concatenation,
  // absent from every new file) still classifies as removed, and a genuinely NEW one still classifies
  // as new — see classify.ts's own object-key matching.
  const oldConcatenated = Object.values(input.currentVendoredFiles).join("\n---\n");
  const newConcatenated = plan.files
    .filter((f: VendorFile) => isVendoredManifestYaml(f.path))
    .map((f: VendorFile) => f.content)
    .join("\n---\n");
  const trackedCoordinates = plan.trackedImages.map((t) =>
    t.tagRef.slice(0, t.tagRef.lastIndexOf(":"))
  );
  const classification = classifyRevendorDiff(oldConcatenated, newConcatenated, trackedCoordinates);

  return { plan, classification };
}

const IN_PATH = "in/input.json";
const OUT_PATH = "out/output.json";

export async function main(): Promise<void> {
  const raw = await readFile(IN_PATH, "utf8");
  const input = JSON.parse(raw) as FullSandboxInput;
  const output = await runSandbox(input);
  await writeFile(OUT_PATH, JSON.stringify(output), "utf8");
}

// Only when run as the container's entrypoint — every test imports `runSandbox` directly instead.
if (process.argv[1] && process.argv[1].endsWith("sandbox-main.js")) {
  main().catch((err) => {
    process.stderr.write(
      `vendor-refresh sandbox: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exitCode = 1;
  });
}
