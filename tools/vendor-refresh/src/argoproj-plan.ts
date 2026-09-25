/** Plan a re-vendor of one of the four argoproj-family backends. See `argoproj-backends.ts` for the
 *  per-backend shape and `deploy/helm-bundled/README.md` for why the fetch is byte-for-byte, never
 *  modified in place. */
import { createHash } from "node:crypto";
import { parseKubernetesImages } from "@scp/dependency-manifests";
import {
  ARGOPROJ_BACKENDS,
  argoprojManifestUrl,
  type ArgoprojBackendSpec
} from "./argoproj-backends.js";
import { splitIntoNamedParts } from "./split.js";
import type {
  BackendName,
  TrackedImage,
  VendorFile,
  VendorRefreshIO,
  VendorRefreshPlan
} from "./types.js";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Every image the fetched manifest declares, keyed by coordinate — the LAST one wins only in the
 *  sense that `parseKubernetesImages` already merges identical declarations; a coordinate declared at
 *  two DIFFERENT versions in one file is reported as such in its own `note`, which is surfaced rather
 *  than silently picked between (this tool never breaks that tie itself). */
async function resolveTrackedImages(
  spec: ArgoprojBackendSpec,
  raw: string,
  io: VendorRefreshIO
): Promise<{ tracked: TrackedImage[]; untracked: string[] }> {
  const declared = parseKubernetesImages(raw);
  const byCoordinate = new Map<string, string>(); // coordinate -> declared tag
  const untrackedCoordinates = new Set<string>();
  for (const dep of declared) {
    if (dep.constraint === "unresolved" || dep.declared === undefined) continue;
    if (byCoordinate.has(dep.coordinate) && byCoordinate.get(dep.coordinate) !== dep.declared) {
      throw new Error(
        `vendor-refresh: '${dep.coordinate}' is declared at more than one version in this manifest ` +
          `(${byCoordinate.get(dep.coordinate)} and ${dep.declared}) — refusing to guess which one to track`
      );
    }
    byCoordinate.set(dep.coordinate, dep.declared);
  }

  const tracked: TrackedImage[] = [];
  const trackedCoordinates = new Set(spec.trackedImages.map((t) => t.coordinate));
  for (const [coordinate, tag] of byCoordinate) {
    if (!trackedCoordinates.has(coordinate)) {
      untrackedCoordinates.add(`${coordinate}:${tag}`);
      continue;
    }
  }
  for (const t of spec.trackedImages) {
    const tag = byCoordinate.get(t.coordinate);
    if (tag === undefined) {
      throw new Error(
        `vendor-refresh: expected to find '${t.coordinate}' in the fetched manifest, but it declares ` +
          "no such image — either the upstream layout changed, or this tool's TrackedImageSpec is stale"
      );
    }
    const tagRef = `${t.coordinate}:${tag}`;
    const digest = await io.resolveImageDigest(tagRef);
    tracked.push({
      bundleImageName: t.bundleImageName,
      tagRef,
      resolvedRef: `${tagRef}@${digest}`
    });
  }
  return { tracked, untracked: [...untrackedCoordinates].sort() };
}

export async function planArgoprojBackend(
  backend: Exclude<BackendName, "gitea">,
  tag: string,
  io: VendorRefreshIO
): Promise<VendorRefreshPlan> {
  const spec = ARGOPROJ_BACKENDS[backend];
  const url = argoprojManifestUrl(spec, tag);
  const raw = await io.fetchText(url);
  if (raw.trim() === "") {
    throw new Error(`vendor-refresh: ${url} returned an empty body`);
  }

  const files: VendorFile[] = spec.split
    ? splitIntoNamedParts(raw).map((p) => ({
        path: `deploy/helm-bundled/vendor/${spec.vendorDir}/${p.name}`,
        content: p.content
      }))
    : [{ path: `deploy/helm-bundled/vendor/${spec.vendorDir}/install.yaml`, content: raw }];

  const { tracked, untracked } = await resolveTrackedImages(spec, raw, io);

  const summaryLines = [
    `${backend}: vendored ${spec.upstreamRepo}@${tag}'s ${spec.manifestPath} unmodified ` +
      `(sha256:${sha256(raw)}, ${raw.length.toLocaleString()} bytes${spec.split ? `, split into ${files.length} parts` : ""}).`,
    ...tracked.map((t) => `  tracked image ${t.bundleImageName}: ${t.resolvedRef}`),
    ...(untracked.length > 0
      ? [
          `  NOT tracked by SCP (present in the vendored manifest, no bundle-images.ts/values.yaml entry): ${untracked.join(", ")}`
        ]
      : [])
  ];

  return { backend, tag, files, trackedImages: tracked, summary: summaryLines.join("\n") };
}
