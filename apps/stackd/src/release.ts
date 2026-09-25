import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { StackReleaseSchema, type StackBackend } from "@scp/schemas";

/**
 * WHAT ONE SCP RELEASE'S STACK IS (M29.4, ADR-0058 E4). The controller image carries the vendored
 * `deploy/helm-bundled` chart; the release's backend versions are whatever that chart pins. The only
 * deploy-time input is an IMAGE RETARGET map — what the air-gap `install.sh` already does for the
 * bundled images — so a disconnected install pulls the same bytes from its own registry. It is
 * written by whoever installs the main chart (never through SCP's API), and it may only name the
 * image fields below: nothing else a render depends on can be changed from outside the image.
 */

/** Values key in deploy/helm-bundled for each API backend name. */
export const VALUES_KEY: Record<StackBackend, string> = {
  argocd: "argocd",
  "argo-workflows": "argoWorkflows",
  "argo-rollouts": "argoRollouts",
  "argo-events": "argoEvents",
  gitea: "gitea"
};

/** The ONLY values a deploy-time override may set, as dotted paths under `bundledExecutor`. */
export const RETARGETABLE_IMAGE_PATHS: readonly string[] = [
  "argocd.image",
  "argocd.valkeyImage",
  "argocd.dexImage",
  "argoWorkflows.serverImage",
  "argoWorkflows.controllerImage",
  "argoWorkflows.executorImage",
  "argoWorkflows.catalog.buildImage.builderImage",
  "argoWorkflows.catalog.buildImage.gitImage",
  "argoWorkflows.catalog.buildRpm.builderImage",
  "argoWorkflows.catalog.infra.image",
  "argoRollouts.image",
  "argoEvents.image",
  "gitea.image"
];

/** An OCI reference: no whitespace, quotes or YAML-significant characters, bounded. */
const IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._\-/:@+]{0,510}$/;

export type ChartValues = Record<string, unknown>;

export interface StackRelease {
  /** The SCP release this controller carries — the version every backend it applies reports. */
  version: string;
  chartDir: string;
  /** deploy/helm-bundled/values.yaml, parsed — the source of every default the controller scales. */
  chartValues: ChartValues;
  /** Dotted path under `bundledExecutor` -> image reference. */
  imageOverrides: Readonly<Record<string, string>>;
}

export function parseImageOverrides(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("image overrides must be a JSON object of <values path>: <image ref>");
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!RETARGETABLE_IMAGE_PATHS.includes(key)) {
      throw new Error(
        `image override '${key}' is not a retargetable image field; allowed: ${RETARGETABLE_IMAGE_PATHS.join(", ")}`
      );
    }
    if (typeof value !== "string" || !IMAGE_REF.test(value)) {
      throw new Error(
        `image override '${key}' is not an image reference: ${JSON.stringify(value)}`
      );
    }
    out[key] = value;
  }
  return out;
}

export async function loadRelease(opts: {
  chartDir: string;
  version: string;
  imageOverridesFile?: string;
}): Promise<StackRelease> {
  const version = StackReleaseSchema.parse(opts.version);
  const chartValues = parseYaml(
    await readFile(path.join(opts.chartDir, "values.yaml"), "utf8")
  ) as ChartValues;
  let imageOverrides: Record<string, string> = {};
  if (opts.imageOverridesFile) {
    let text: string | undefined;
    try {
      text = await readFile(opts.imageOverridesFile, "utf8");
    } catch (err) {
      // An absent file is "no retargets" (a connected install); anything else is a real error.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (text !== undefined && text.trim() !== "")
      imageOverrides = parseImageOverrides(JSON.parse(text));
  }
  return { version, chartDir: opts.chartDir, chartValues, imageOverrides };
}

/** `a.b.c` into a nested object. */
export function getPath(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const part of dotted.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function setPath(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split(".");
  let cur: Record<string, unknown> = obj;
  for (const part of parts.slice(0, -1)) {
    const next = cur[part];
    if (next === null || typeof next !== "object" || Array.isArray(next)) cur[part] = {};
    cur = cur[part] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

/** The chart's defaults for one backend (`bundledExecutor.<key>`). */
export function chartBackendDefaults(
  release: StackRelease,
  backend: StackBackend
): Record<string, unknown> {
  const v = getPath(release.chartValues, `bundledExecutor.${VALUES_KEY[backend]}`);
  if (v === null || typeof v !== "object") {
    throw new Error(
      `deploy/helm-bundled/values.yaml has no bundledExecutor.${VALUES_KEY[backend]}`
    );
  }
  return v as Record<string, unknown>;
}

/** The namespace a backend is installed into — fixed by the chart, never by the spec. */
export function backendNamespace(release: StackRelease, backend: StackBackend): string {
  const ns = chartBackendDefaults(release, backend)["namespace"];
  if (typeof ns !== "string" || ns === "") {
    throw new Error(`deploy/helm-bundled/values.yaml gives ${backend} no namespace`);
  }
  return ns;
}
