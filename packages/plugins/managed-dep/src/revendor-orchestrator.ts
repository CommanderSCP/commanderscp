/**
 * THE `re-vendor` ORCHESTRATOR HALF (ADR-0059, owner decision 2026-09-25 in response to the #420
 * review: "split + small amendment"). This module is what holds the repo-write credential's
 * process; it never parses a vendored manifest and never runs `helm template`. Its whole job is:
 *
 *   1. fetch the upstream manifest/chart — by COMMIT SHA where upstream addresses content that way
 *      (`raw-tree` backends), by the one address a `release-asset` backend actually has otherwise —
 *      treating the fetched bytes as OPAQUE (never parsed here);
 *   2. resolve and, where a verification mechanism is confirmed, cosign-verify each tracked image's
 *      digest at `toTag` BEFORE it is pinned;
 *   3. refuse a downgrade, by comparing `toTag` against the version the TARGET REPOSITORY's own
 *      `values.yaml` currently declares — never the caller-supplied `fromTag` alone;
 *   4. launch `apps/runner-dep-vendor` (`--network none`, no credential, no environment) with the
 *      verified bytes, which does ALL parsing/splitting/rewriting/`helm template`/classification and
 *      returns files;
 *   5. hand the returned files back to the caller (`index.ts`'s `triggerRevendor`), which is what
 *      still runs the containment check (every path is one of `declaredManifestPaths`) and commits.
 *
 * See ADR-0059 for the full design and, honestly, for what is NOT yet covered (cosign verification
 * is wired and enforced for `argocd` only — the one backend this session confirmed publishes
 * KEYLESS per-image cosign signatures with a documented identity; the other four are logged as an
 * explicit, named gap rather than silently treated as verified — see {@link BACKEND_VERIFICATION}).
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginContext } from "@scp/plugin-api";
import {
  resolveRunnerLauncher,
  runnerOutcomeDetail,
  toRunnerRunId,
  type KubernetesLauncherSettings,
  type ResolveRunnerLauncher,
  type RunnerResult
} from "@scp/runner-launcher";
import {
  createKeylessImageVerifier,
  type KeylessIdentity,
  type KeylessImageVerifyResult
} from "@scp/cosign";
import {
  ARGOPROJ_BACKENDS,
  argoprojManifestUrl,
  argoprojManifestUrlBySha,
  BUNDLE_IMAGES_TS_PATH,
  createSkopeoDigestResolver,
  GITEA_CHART_REPO_NAME,
  GITEA_CHART_REPO_URL,
  GITEA_IMAGE_COORDINATE,
  IMAGES_LIST_PATH,
  isBackendName,
  isValidCommitSha,
  isValidUpstreamTag,
  runSandbox,
  VALUES_YAML_PATH,
  type BackendName,
  type DiffClassification,
  type FullSandboxInput,
  type VendorRefreshPlan
} from "@scp/vendor-refresh";
import type { RepoSession } from "./repo-write.js";

export const REVENDOR_RUNNER_NETWORK_MODE = "none";
const DEFAULT_TIMEOUT_MS = 10 * 60_000; // the argo-workflows manifest is ~11 MB; give it room
const MAX_FETCH_BYTES = 64 * 1024 * 1024;

export interface RevendorOrchestratorConfig {
  /** SERVER-INJECTED (never tenant): the vetted, pinned `scp-runner-dep-vendor` sandbox image. */
  revendorRunnerImage: string;
  workspaceRoot: string;
  timeoutMs?: number;
  dockerBinary?: string;
  runnerLauncher?: "docker" | "kubernetes";
  kubernetes?: KubernetesLauncherSettings;
}

/** Injectable so every test can fake the network/subprocess reach — the SAME shape
 *  `@scp/vendor-refresh`'s `VendorRefreshIO` and `createSkopeoDigestResolver`/
 *  `createKeylessImageVerifier` already use: the default is the real, network-reaching
 *  implementation, and a fixture stands in for tests. */
export interface RevendorFetchDeps {
  resolveImageDigest: (ref: string) => Promise<string>;
  verifyKeylessSignature: (imageRef: string, identity: KeylessIdentity) => KeylessImageVerifyResult;
  /** Gitea only: `helm repo add`/`update`/`pull --untar` the chart at `chartVersion` into
   *  `destDir/gitea`. Shells to `helm` on PATH (or `SCP_HELM_BIN`) — the orchestrator's OWN scoped
   *  use of helm, fetch-only, never template (that runs in the sandbox — see this module's doc). */
  fetchGiteaChart: (chartVersion: string, destDir: string) => Promise<string>;
}

function resolveHelmBin(): string {
  return process.env.SCP_HELM_BIN && process.env.SCP_HELM_BIN.trim() !== ""
    ? process.env.SCP_HELM_BIN
    : "helm";
}

let giteaRepoAdded = false;

async function realFetchGiteaChart(chartVersion: string, destDir: string): Promise<string> {
  const helm = resolveHelmBin();
  if (!giteaRepoAdded) {
    execFileSync(helm, ["repo", "add", GITEA_CHART_REPO_NAME, GITEA_CHART_REPO_URL, "--force-update"]);
    execFileSync(helm, ["repo", "update", GITEA_CHART_REPO_NAME]);
    giteaRepoAdded = true;
  }
  execFileSync(helm, [
    "pull",
    `${GITEA_CHART_REPO_NAME}/gitea`,
    "--version",
    chartVersion,
    "--untar",
    "--untardir",
    destDir
  ]);
  return join(destDir, "gitea");
}

export const DEFAULT_REVENDOR_FETCH_DEPS: RevendorFetchDeps = {
  resolveImageDigest: createSkopeoDigestResolver(),
  verifyKeylessSignature: createKeylessImageVerifier(),
  fetchGiteaChart: realFetchGiteaChart
};

/** Per-backend image-verification coverage, measured against each project's OWN published release
 *  workflow (2026-09-25 — see ADR-0059 for the full research trail). Named HONESTLY rather than
 *  uniformly: a false "verified" is worse than a documented gap. */
interface BackendVerification {
  method: "keyless" | "none";
  identity?: KeylessIdentity;
  unverifiedReason?: string;
}

export const BACKEND_VERIFICATION: Record<BackendName, BackendVerification> = {
  argocd: {
    method: "keyless",
    identity: {
      // Confirmed against docs/operator-manual/signed-release-assets.md (argoproj/argo-cd, measured
      // 2026-09-25): every Argo CD container image is cosign-signed, keyless, by this workflow.
      identityRegexp: "^https://github\\.com/argoproj/argo-cd/\\.github/workflows/image-reuse\\.yaml@refs/tags/",
      oidcIssuer: "https://token.actions.githubusercontent.com"
    }
  },
  "argo-workflows": {
    method: "none",
    unverifiedReason:
      "argo-workflows signs release images with a STATIC cosign key (`cosign sign --key`, its " +
      "release.yaml, measured 2026-09-25) — not keyless. Key-based verification is not yet wired " +
      "(ADR-0059 follow-up); this image's digest is pinned WITHOUT a signature check."
  },
  "argo-rollouts": {
    method: "none",
    unverifiedReason:
      "no confirmed per-image cosign signature was found in argo-rollouts' release workflow as of " +
      "2026-09-25 (measured: it cosign SIGN-BLOBs its SBOM only). This image's digest is pinned " +
      "WITHOUT a signature check — a follow-up to confirm the real mechanism, if any."
  },
  "argo-events": {
    method: "none",
    unverifiedReason:
      "no cosign usage was found in argo-events' release workflow at all as of 2026-09-25 " +
      "(measured). This image's digest is pinned WITHOUT a signature check."
  },
  gitea: {
    method: "none",
    unverifiedReason:
      "no confirmed cosign signing for Gitea's own release images as of 2026-09-25 (not researched " +
      "to the same depth as the argoproj family — Gitea's release process looks traditional). This " +
      "image's digest is pinned WITHOUT a signature check."
  }
};

/** Resolve a release tag to its commit sha via the one GitHub route that answers for a tag, a
 *  branch OR a sha alike (`/commits/{ref}`) — deliberately not the two-hop
 *  `git/ref/tags`+`git/tags/{sha}` dance an ANNOTATED tag would otherwise need. Routed through
 *  `ctx.http` (finding 6): this is the orchestrator's own egress-guarded channel, server-allowlisted,
 *  never a bare `fetch()`. */
export async function resolveTagCommitSha(
  ctx: PluginContext,
  upstreamRepo: string,
  tag: string
): Promise<string> {
  if (!isValidUpstreamTag(tag)) {
    throw new Error(`vendor-refresh orchestrator: '${tag}' is not a well-formed upstream release tag`);
  }
  const res = await ctx.http.request({
    method: "GET",
    url: `https://api.github.com/repos/${upstreamRepo}/commits/${encodeURIComponent(tag)}`,
    headers: { accept: "application/vnd.github+json" }
  });
  if (res.status !== 200) {
    throw new Error(
      `vendor-refresh orchestrator: resolving '${upstreamRepo}@${tag}' to a commit sha failed (HTTP ${res.status})`
    );
  }
  const sha = (res.body as { sha?: unknown }).sha;
  if (typeof sha !== "string" || !isValidCommitSha(sha)) {
    throw new Error(
      `vendor-refresh orchestrator: '${upstreamRepo}@${tag}' did not resolve to a well-formed commit sha`
    );
  }
  return sha;
}

interface FetchedManifest {
  manifestText: string;
  /** Human-readable provenance line for the PR body/summary. */
  fetchNote: string;
}

async function fetchArgoprojManifest(
  ctx: PluginContext,
  backend: Exclude<BackendName, "gitea">,
  toTag: string
): Promise<FetchedManifest> {
  const spec = ARGOPROJ_BACKENDS[backend];
  let url: string;
  let fetchNote: string;
  if (spec.urlKind === "raw-tree") {
    const sha = await resolveTagCommitSha(ctx, spec.upstreamRepo, toTag);
    url = argoprojManifestUrlBySha(spec, sha);
    fetchNote = `fetched by commit sha ${sha} (resolved from tag ${toTag})`;
  } else {
    // RELEASE-ASSET: a GitHub Release upload has no commit-sha-addressed form (finding 1's own
    // wording: "by commit SHA where upstream addresses content that way"). Fetched by tag — the one
    // address upstream actually publishes it at — which is the acknowledged, documented gap ADR-0059
    // records (neither argo-workflows nor argo-rollouts publish a checksums file covering
    // `install.yaml` either, so there is no independent artifact to verify this fetch against yet).
    url = argoprojManifestUrl(spec, toTag);
    fetchNote = `fetched by tag ${toTag} (release-asset — no commit-sha-addressed form; ADR-0059)`;
  }
  const res = await ctx.http.request({
    method: "GET",
    url,
    headers: { accept: "text/plain" },
    maxResponseBytes: MAX_FETCH_BYTES
  });
  if (res.status !== 200) {
    throw new Error(`vendor-refresh orchestrator: GET ${url} -> HTTP ${res.status}`);
  }
  if (typeof res.body !== "string" || res.body.trim() === "") {
    throw new Error(`vendor-refresh orchestrator: GET ${url} returned no text body`);
  }
  return { manifestText: res.body, fetchNote };
}

/** Every tracked image's `coordinate:toTag` digest, resolved through the pinned skopeo and — where
 *  {@link BACKEND_VERIFICATION} confirms a mechanism — cosign-verified BEFORE being pinned. A real
 *  negative (`unverified`: cosign ran and found no matching signature) is FAIL-CLOSED; an
 *  unconfirmed mechanism is a loud, logged, honest gap, never a silent pass. */
async function resolveAndVerifyTrackedDigests(
  ctx: PluginContext,
  backend: BackendName,
  toTag: string,
  coordinates: readonly string[],
  deps: RevendorFetchDeps
): Promise<Record<string, string>> {
  const verification = BACKEND_VERIFICATION[backend];
  const out: Record<string, string> = {};
  for (const coordinate of coordinates) {
    const ref = `${coordinate}:${toTag}`;
    const digest = await deps.resolveImageDigest(ref);
    if (verification.method === "keyless" && verification.identity) {
      const result = deps.verifyKeylessSignature(`${ref}@${digest}`, verification.identity);
      if (result.status !== "verified") {
        throw new Error(
          `vendor-refresh orchestrator: REFUSED — cosign could not verify '${ref}@${digest}' ` +
            `(${result.status}: ${result.detail}). Refusing to pin a digest whose signature does not check out.`
        );
      }
      ctx.logger.info("managed-dep re-vendor: cosign keyless verification OK", { ref, digest });
    } else {
      ctx.logger.warn(
        "managed-dep re-vendor: pinning a digest WITHOUT a signature check (no confirmed verification mechanism)",
        { ref, digest, reason: verification.unverifiedReason }
      );
    }
    out[ref] = digest;
  }
  return out;
}

// A permissive, `vX.Y.Z`-only comparator — the same grammar `isValidUpstreamTag` already accepts
// (this function is only ever called on tags that already passed it). Pre-release suffixes compare
// as OLDER than their base release (`v3.5.0-rc1` < `v3.5.0`), which is the conservative direction:
// treating a pre-release as newer would let a re-vendor "upgrade" a stable pin to a release
// candidate.
export function compareUpstreamTags(a: string, b: string): number {
  const parse = (t: string): { core: number[]; pre: string } => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(t);
    if (!m) throw new Error(`vendor-refresh orchestrator: '${t}' is not a comparable upstream tag`);
    return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? "" };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa.core[i]! !== pb.core[i]!) return pa.core[i]! - pb.core[i]!;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === "") return 1; // a has no pre-release suffix -> a is newer
  if (pb.pre === "") return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

/** Every path `declaredManifestPaths` may legitimately name for `backend` — the three shared
 *  downstream files, or anything under this backend's OWN vendor directory (a prefix rather than an
 *  enumerated file list, because Argo Workflows' split part COUNT is upstream's to change — see
 *  `argo-workflows.yaml`'s `.Files.Glob`, finding 7). This is the "declaredManifestPaths must be the
 *  fixed vendored set" half of the owner decision: a caller-supplied path outside this shape is
 *  refused here, before a credential is minted, REGARDLESS of what the intent claims. */
function vendorPathPrefix(backend: BackendName): string {
  const vendorDir = backend === "gitea" ? "gitea" : ARGOPROJ_BACKENDS[backend].vendorDir;
  return `deploy/helm-bundled/vendor/${vendorDir}/`;
}

const SHARED_DOWNSTREAM_PATHS: ReadonlySet<string> = new Set([
  VALUES_YAML_PATH,
  BUNDLE_IMAGES_TS_PATH,
  IMAGES_LIST_PATH
]);

export function assertFixedVendorPaths(
  backend: BackendName,
  declaredManifestPaths: readonly string[]
): void {
  const prefix = vendorPathPrefix(backend);
  for (const path of declaredManifestPaths) {
    if (SHARED_DOWNSTREAM_PATHS.has(path)) continue;
    if (path.startsWith(prefix)) continue;
    throw new Error(
      `vendor-refresh orchestrator: REFUSED (fixed_vendor_paths) — declaredManifestPaths names ` +
        `'${path}', which is neither one of the three shared downstream files nor under '${backend}'s ` +
        `own vendor directory ('${prefix}'). declaredManifestPaths must be the FIXED vendored set for ` +
        "this backend, never an arbitrary caller-supplied path."
    );
  }
}

/** The one tracked coordinate this refuses a downgrade against, per backend. */
function primaryCoordinate(backend: BackendName): string {
  return backend === "gitea"
    ? GITEA_IMAGE_COORDINATE
    : ARGOPROJ_BACKENDS[backend as Exclude<BackendName, "gitea">].trackedImages[0]!.coordinate;
}

/** Read the version `values.yaml` CURRENTLY declares for this backend's primary tracked coordinate,
 *  directly off the target repository — never the caller-supplied `fromTag` alone, which a stale or
 *  tampered descriptor could misstate (finding 1). */
async function readCurrentTagFromRepo(
  session: RepoSession,
  backend: BackendName,
  baseBranch: string
): Promise<string> {
  const file = await session.readFile(VALUES_YAML_PATH, baseBranch);
  if (file === undefined) {
    throw new Error(`vendor-refresh orchestrator: '${VALUES_YAML_PATH}' is not present at '${baseBranch}'`);
  }
  const coordinate = primaryCoordinate(backend);
  const escaped = coordinate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?<![A-Za-z0-9._/-])${escaped}:([^\\s"'#]+)`);
  const match = pattern.exec(file.content);
  if (!match) {
    throw new Error(
      `vendor-refresh orchestrator: '${VALUES_YAML_PATH}' declares no reference to '${coordinate}' — cannot read the current version to guard against a downgrade`
    );
  }
  return match[1]!;
}

export async function assertNotDowngrade(
  session: RepoSession,
  backend: BackendName,
  baseBranch: string,
  toTag: string
): Promise<void> {
  const currentTag = await readCurrentTagFromRepo(session, backend, baseBranch);
  if (compareUpstreamTags(toTag, currentTag) <= 0) {
    throw new Error(
      `vendor-refresh orchestrator: REFUSED (downgrade) — toTag '${toTag}' is not newer than the ` +
        `currently vendored '${currentTag}' (read from '${VALUES_YAML_PATH}' at '${baseBranch}'). ` +
        "A re-vendor only ever moves forward."
    );
  }
}

async function runVendorSandbox(
  config: RevendorOrchestratorConfig,
  resolveLauncher: ResolveRunnerLauncher,
  runKey: string,
  inDir: string,
  outDir: string
): Promise<RunnerResult> {
  return resolveLauncher({
    dockerBinary: config.dockerBinary,
    runnerLauncher: config.runnerLauncher,
    kubernetes: config.kubernetes
  }).run({
    runId: toRunnerRunId(runKey),
    labels: { "scp.executor": "scp-managed-dep", "scp.run-id": toRunnerRunId(runKey) },
    image: config.revendorRunnerImage,
    operands: [],
    networkMode: REVENDOR_RUNNER_NETWORK_MODE,
    env: [],
    secretEnv: [],
    copyIn: [{ hostDir: inDir, containerPath: "/work/in" }],
    copyOut: { containerPath: "/work/out", hostDir: outDir, when: "on-success", onFailure: "propagate" },
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: MAX_FETCH_BYTES
  });
}

export interface OrchestrateRevendorResult {
  plan: VendorRefreshPlan;
  classification: DiffClassification;
  fetchNote: string;
}

/** The whole orchestrator half, end to end. `index.ts`'s `triggerRevendor` calls this in place of
 *  the old in-process `planVendorRefresh` call, then does the SAME containment check
 *  (`declaredManifestPaths`) and commit it already did — nothing about the commit/PR path changes. */
export async function orchestrateRevendor(
  ctx: PluginContext,
  config: RevendorOrchestratorConfig,
  backend: BackendName,
  toTag: string,
  baseBranch: string,
  session: RepoSession,
  /** Every path this run may touch (the SAME `declaredManifestPaths` `index.ts` already validated
   *  the descriptor with) — read here for whichever of them look like a vendored Kubernetes manifest,
   *  to give the classifier the CURRENT content to compare the sandbox's proposed new content
   *  against. A path that does not exist yet reads as "" (nothing there before), not a refusal. */
  declaredManifestPaths: readonly string[],
  resolveLauncher: ResolveRunnerLauncher = resolveRunnerLauncher,
  deps: RevendorFetchDeps = DEFAULT_REVENDOR_FETCH_DEPS
): Promise<OrchestrateRevendorResult> {
  if (!isBackendName(backend)) {
    throw new Error(`vendor-refresh orchestrator: unknown backend '${backend}'`);
  }

  assertFixedVendorPaths(backend, declaredManifestPaths);
  await assertNotDowngrade(session, backend, baseBranch, toTag);

  await mkdir(config.workspaceRoot, { recursive: true });
  const scratch = await mkdtemp(join(config.workspaceRoot, "scp-dep-vendor-"));
  try {
    const inDir = join(scratch, "in");
    const outDir = join(scratch, "out");
    await mkdir(inDir, { recursive: true });
    await mkdir(outDir, { recursive: true });

    let manifestText: string | undefined;
    let chartHostDir: string | undefined;
    let fetchNote: string;
    let coordinates: readonly string[];

    if (backend === "gitea") {
      chartHostDir = await deps.fetchGiteaChart(toTag, join(inDir, "chart-src"));
      fetchNote = `gitea chart pulled at version ${toTag} via helm pull (network, orchestrator-side; template itself runs sandboxed)`;
      coordinates = [GITEA_IMAGE_COORDINATE];
    } else {
      const fetched = await fetchArgoprojManifest(ctx, backend, toTag);
      manifestText = fetched.manifestText;
      fetchNote = fetched.fetchNote;
      coordinates = ARGOPROJ_BACKENDS[backend].trackedImages.map((t) => t.coordinate);
    }

    const resolvedDigests = await resolveAndVerifyTrackedDigests(
      ctx,
      backend,
      toTag,
      coordinates,
      deps
    );

    const [valuesYaml, bundleImagesTs, imagesList] = await Promise.all([
      session.readFile(VALUES_YAML_PATH, baseBranch),
      session.readFile(BUNDLE_IMAGES_TS_PATH, baseBranch),
      session.readFile(IMAGES_LIST_PATH, baseBranch)
    ]);
    for (const [label, file] of [
      [VALUES_YAML_PATH, valuesYaml],
      [BUNDLE_IMAGES_TS_PATH, bundleImagesTs],
      [IMAGES_LIST_PATH, imagesList]
    ] as const) {
      if (file === undefined) {
        throw new Error(`vendor-refresh orchestrator: '${label}' is not present at '${baseBranch}'`);
      }
    }

    // The CURRENTLY vendored manifest(s), read for the classifier's old/new comparison. Every path
    // the server told this run it may touch (`declaredManifestPaths`) that LOOKS like a vendored
    // Kubernetes manifest is read; a path that does not exist yet (a genuinely new split part) reads
    // as "" — a legitimate "there was nothing here before" rather than a refusal.
    const currentVendoredFiles: Record<string, string> = {};
    for (const path of declaredManifestPaths) {
      if (!path.startsWith("deploy/helm-bundled/vendor/") || !path.endsWith(".yaml")) continue;
      const file = await session.readFile(path, baseBranch);
      currentVendoredFiles[path] = file?.content ?? "";
    }

    let chartDirInSandbox: string | undefined;
    if (chartHostDir !== undefined) {
      // The orchestrator's fetched chart directory is ALREADY under `inDir` (via
      // `fetchGiteaChart(toTag, join(inDir, "chart-src"))` above) — `docker cp`'d in wholesale
      // alongside input.json, at the container path the sandbox's `chartDir` field names.
      chartDirInSandbox = "/work/in/chart-src/gitea";
    }

    const input: FullSandboxInput = {
      backend,
      toTag,
      ...(manifestText !== undefined ? { manifestText } : {}),
      ...(chartDirInSandbox !== undefined ? { chartDir: chartDirInSandbox } : {}),
      resolvedDigests,
      valuesYaml: valuesYaml!.content,
      bundleImagesTs: bundleImagesTs!.content,
      imagesList: imagesList!.content,
      currentVendoredFiles
    };
    await writeFile(join(inDir, "input.json"), JSON.stringify(input), "utf8");

    const runKey = `revendor-${backend}-${toTag}-${Date.now()}`;
    const run = await runVendorSandbox(config, resolveLauncher, runKey, inDir, outDir);
    if (!run.succeeded) {
      throw new Error(
        `vendor-refresh orchestrator: the sandbox failed to plan the re-vendor — ${runnerOutcomeDetail(run)}`
      );
    }

    const outputRaw = await readFile(join(outDir, "output.json"), "utf8");
    const output = JSON.parse(outputRaw) as {
      plan: VendorRefreshPlan;
      classification: DiffClassification;
    };
    return { plan: output.plan, classification: output.classification, fetchNote };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}
