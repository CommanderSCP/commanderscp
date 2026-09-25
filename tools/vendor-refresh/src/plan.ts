/** The top-level planner: dispatch to the right per-backend plan, then patch the three files every
 *  backend shares (`deploy/helm-bundled/values.yaml`, `deploy/airgap/src/bundle-images.ts`,
 *  `tools/ci-mirror/images.list`). Pure given its inputs — the CLI (`cli.ts`) is what reads these
 *  three files off disk and writes the plan's files back; tests pass fixture strings instead. */
import { ARGOPROJ_BACKENDS } from "./argoproj-backends.js";
import { planArgoprojBackend } from "./argoproj-plan.js";
import { GITEA_CHART_REF } from "./gitea-backend.js";
import { planGitea } from "./gitea-plan.js";
import { patchImageRefsOrThrow } from "./patch-image-refs.js";
import { patchImagesList } from "./patch-images-list.js";
import {
  isBackendName,
  type VendorFile,
  type VendorRefreshIO,
  type VendorRefreshPlan
} from "./types.js";

export const VALUES_YAML_PATH = "deploy/helm-bundled/values.yaml";
export const BUNDLE_IMAGES_TS_PATH = "deploy/airgap/src/bundle-images.ts";
export const IMAGES_LIST_PATH = "tools/ci-mirror/images.list";

export type ReadRepoFile = (path: string) => Promise<string>;

export interface PlanVendorRefreshOptions {
  /** Gitea only: the chart ref `helm template` fetches. Defaults to the real `gitea-charts/gitea`
   *  repo ref; tests pass a local fixture chart directory instead. */
  giteaChartRef?: string;
}

function assertNoDuplicatePaths(files: readonly VendorFile[]): void {
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) {
      throw new Error(`vendor-refresh: the plan writes '${file.path}' more than once — refusing`);
    }
    seen.add(file.path);
  }
}

export async function planVendorRefresh(
  backend: string,
  tag: string,
  io: VendorRefreshIO,
  readRepoFile: ReadRepoFile,
  options: PlanVendorRefreshOptions = {}
): Promise<VendorRefreshPlan> {
  if (!isBackendName(backend)) {
    throw new Error(
      `vendor-refresh: unknown backend '${backend}' (expected one of ${Object.keys(ARGOPROJ_BACKENDS).concat("gitea").join(", ")})`
    );
  }

  const basePlan: VendorRefreshPlan =
    backend === "gitea"
      ? await planGitea(options.giteaChartRef ?? GITEA_CHART_REF, tag, io)
      : await planArgoprojBackend(backend, tag, io);

  const valuesYaml = await readRepoFile(VALUES_YAML_PATH);
  const patchedValuesYaml = patchImageRefsOrThrow(
    valuesYaml,
    basePlan.trackedImages,
    VALUES_YAML_PATH
  );

  const bundleImagesTs = await readRepoFile(BUNDLE_IMAGES_TS_PATH);
  const patchedBundleImagesTs = patchImageRefsOrThrow(
    bundleImagesTs,
    basePlan.trackedImages,
    BUNDLE_IMAGES_TS_PATH
  );

  const imagesList = await readRepoFile(IMAGES_LIST_PATH);
  const { content: patchedImagesList, updated } = patchImagesList(
    imagesList,
    basePlan.trackedImages
  );

  const extraFiles: VendorFile[] = [
    { path: VALUES_YAML_PATH, content: patchedValuesYaml },
    { path: BUNDLE_IMAGES_TS_PATH, content: patchedBundleImagesTs }
  ];
  if (patchedImagesList !== imagesList) {
    extraFiles.push({ path: IMAGES_LIST_PATH, content: patchedImagesList });
  }

  const files = [...basePlan.files, ...extraFiles];
  assertNoDuplicatePaths(files);

  const summary = [
    basePlan.summary,
    `  ${VALUES_YAML_PATH} updated`,
    `  ${BUNDLE_IMAGES_TS_PATH} updated`,
    updated.length > 0
      ? `  ${IMAGES_LIST_PATH} updated (${updated.join(", ")})`
      : `  ${IMAGES_LIST_PATH} unchanged (no CI test pulls this backend's image today)`
  ].join("\n");

  return { ...basePlan, files, summary };
}

export type { BackendName } from "./types.js";
