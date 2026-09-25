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
  fetchGiteaChartOverHelm,
  GITEA_IMAGE_COORDINATE,
  IMAGES_LIST_PATH,
  isBackendName,
  isValidCommitSha,
  isValidUpstreamTag,
  VALUES_YAML_PATH,
  type BackendName,
  type DiffClassification,
  type FullSandboxInput,
  type TrackedImage,
  type VendorFile,
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

export const DEFAULT_REVENDOR_FETCH_DEPS: RevendorFetchDeps = {
  resolveImageDigest: createSkopeoDigestResolver(),
  verifyKeylessSignature: createKeylessImageVerifier(),
  // `@scp/vendor-refresh`'s `fetchGiteaChartOverHelm`, NOT a local `execFileSync` call — see that
  // function's own doc comment: this package may not import `node:child_process` at all
  // (`packages/runner-launcher/src/no-docker-on-kubernetes.test.ts`'s M23.6 clause-1 census).
  fetchGiteaChart: fetchGiteaChartOverHelm
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
      identityRegexp:
        "^https://github\\.com/argoproj/argo-cd/\\.github/workflows/image-reuse\\.yaml@refs/tags/",
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
    throw new Error(
      `vendor-refresh orchestrator: '${tag}' is not a well-formed upstream release tag`
    );
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

/** The vendor directory prefix for `backend` — used only to STRIP before checking the closed
 *  filename grammar below, never on its own as a containment check (a prefix `startsWith` cannot
 *  refuse a `..`-shaped path, which is exactly what PROBE (path-probe.mjs, 2026-09-25 re-review,
 *  finding 5) found: `deploy/helm-bundled/vendor/argocd/../../templates/argocd.yaml` STARTS WITH the
 *  argocd vendor prefix as a plain string, and Node's own path resolution walks it OUT of that
 *  directory entirely regardless of what the string comparison believed it saw). */
function vendorPathPrefix(backend: BackendName): string {
  const vendorDir = backend === "gitea" ? "gitea" : ARGOPROJ_BACKENDS[backend].vendorDir;
  return `deploy/helm-bundled/vendor/${vendorDir}/`;
}

const SHARED_DOWNSTREAM_PATHS: ReadonlySet<string> = new Set([
  VALUES_YAML_PATH,
  BUNDLE_IMAGES_TS_PATH,
  IMAGES_LIST_PATH
]);

/** The CLOSED filename grammar under a backend's own vendor directory (finding 5: "enforce an exact
 *  enumerated set, not a directory prefix"). `install.yaml` for every non-split backend; gitea's
 *  five own, named files; Argo Workflows' `install.yaml` OR the two-digit `install-part-NN.yaml`
 *  shape — a REGEX rather than a literal list for that one case ALONE, because the split PART COUNT
 *  is upstream's to change (finding 7, `.Files.Glob`) and a literal list would have to be
 *  regenerated by hand every time it does; the two-digit bound is the SAME declared limit
 *  `split.ts`'s own `partFileName` already refuses to exceed, so this is not a wider grammar than
 *  the writer's, only the same one re-checked on the read side. */
function isAllowedVendorFilename(backend: BackendName, filename: string): boolean {
  if (backend === "gitea") {
    return [
      "install-no-secrets.yaml",
      "config/config_environment.sh",
      "init/configure_gpg_environment.sh",
      "init/init_directory_structure.sh",
      "init/configure_gitea.sh"
    ].includes(filename);
  }
  if (backend === "argo-workflows") {
    return filename === "install.yaml" || /^install-part-\d{2}\.yaml$/.test(filename);
  }
  return filename === "install.yaml";
}

export function assertFixedVendorPaths(
  backend: BackendName,
  declaredManifestPaths: readonly string[]
): void {
  const prefix = vendorPathPrefix(backend);
  for (const path of declaredManifestPaths) {
    if (SHARED_DOWNSTREAM_PATHS.has(path)) continue;
    // REJECT ANY `..` PATH SEGMENT BEFORE ANYTHING ELSE — literal, not normalized: a path that
    // NAMES `..` at all is refused outright, so there is nothing downstream that a later normalize-
    // then-compare step could still get wrong.
    if (path.split("/").includes("..")) {
      throw new Error(
        `vendor-refresh orchestrator: REFUSED (fixed_vendor_paths) — declaredManifestPaths names ` +
          `'${path}', which contains a '..' path segment`
      );
    }
    if (path.startsWith(prefix) && isAllowedVendorFilename(backend, path.slice(prefix.length))) {
      continue;
    }
    throw new Error(
      `vendor-refresh orchestrator: REFUSED (fixed_vendor_paths) — declaredManifestPaths names ` +
        `'${path}', which is not one of the fixed vendored paths for '${backend}' (the three shared ` +
        `downstream files, or one of this backend's own well-known vendor filenames under '${prefix}'). ` +
        "declaredManifestPaths must be the FIXED vendored set for this backend, never an arbitrary " +
        "caller-supplied path."
    );
  }
}

/** The one tracked coordinate this refuses a downgrade against, per backend — the four argoproj
 *  backends only; gitea's downgrade guard is on a DIFFERENT axis (its own function, below —
 *  finding 4). */
function primaryCoordinate(backend: Exclude<BackendName, "gitea">): string {
  return ARGOPROJ_BACKENDS[backend].trackedImages[0]!.coordinate;
}

/** Read the version `values.yaml` CURRENTLY declares for this backend's primary tracked coordinate,
 *  directly off the target repository — never the caller-supplied `fromTag` alone, which a stale or
 *  tampered descriptor could misstate (finding 1). Argoproj backends only — `toTag` for them IS the
 *  tracked image's own tag, so this is the correct axis to compare on (see gitea's own function,
 *  below, for why it is NOT this one for gitea). */
async function readCurrentTagFromRepo(
  session: RepoSession,
  backend: Exclude<BackendName, "gitea">,
  baseBranch: string
): Promise<string> {
  const file = await session.readFile(VALUES_YAML_PATH, baseBranch);
  if (file === undefined) {
    throw new Error(
      `vendor-refresh orchestrator: '${VALUES_YAML_PATH}' is not present at '${baseBranch}'`
    );
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

/** The path `gitea-plan.ts`'s own header comment is written to — the one place the CHART version
 *  (as opposed to the app/image version) of the currently-vendored gitea is recorded anywhere in
 *  the repo. */
const GITEA_VENDORED_MANIFEST_PATH = "deploy/helm-bundled/vendor/gitea/install-no-secrets.yaml";

/**
 * GITEA HAS TWO INDEPENDENT VERSION AXES (finding 4, 2026-09-25 re-review): the Helm CHART version
 * (`toTag` here — what `helm pull --version` takes, e.g. `12.6.0`) and the gitea APP/IMAGE version
 * (`1.26.1-rootless` — a chart's own choice, not derivable from the chart version by any contract).
 * The bug this replaces conflated them: it compared `toTag` (a chart version) against `values.yaml`'s
 * stored IMAGE tag, which let a chart DOWNGRADE (`12.6.0` -> `12.5.0`) through undetected as long as
 * the image tag string sorted "higher" by accident, and it fed `toTag` straight into
 * `resolveImageDigest` as if it WERE the image tag (`docker.gitea.com/gitea:12.6.0` — a reference
 * that has never existed), which is why every real gitea re-vendor failed closed. Fixed by keeping
 * the two axes separate: this function compares `toTag` against the CHART version
 * `gitea-plan.ts`'s own header comment records in the currently-vendored manifest (never the image
 * tag `values.yaml` stores); {@link resolveGiteaImageDigest} is the separate function that resolves
 * the IMAGE axis, from the chart's OWN `Chart.yaml` after it is pulled, never from `toTag` directly.
 */
async function readCurrentGiteaChartVersion(
  session: RepoSession,
  baseBranch: string
): Promise<string> {
  const file = await session.readFile(GITEA_VENDORED_MANIFEST_PATH, baseBranch);
  if (file === undefined) {
    throw new Error(
      `vendor-refresh orchestrator: '${GITEA_VENDORED_MANIFEST_PATH}' is not present at '${baseBranch}'`
    );
  }
  // The exact shape `giteaHeader()` (gitea-plan.ts) writes: `helm template <release> gitea-charts/
  // gitea --version <chartVersion> --namespace <release> \`.
  const match = /--version\s+(\S+)\s+--namespace/.exec(file.content);
  if (!match) {
    throw new Error(
      `vendor-refresh orchestrator: '${GITEA_VENDORED_MANIFEST_PATH}' does not name a chart version ` +
        "in its own header comment — cannot read the current CHART version to guard against a downgrade"
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
  const currentTag =
    backend === "gitea"
      ? await readCurrentGiteaChartVersion(session, baseBranch)
      : await readCurrentTagFromRepo(session, backend, baseBranch);
  if (compareUpstreamTags(toTag, currentTag) <= 0) {
    throw new Error(
      `vendor-refresh orchestrator: REFUSED (downgrade) — toTag '${toTag}' is not newer than the ` +
        `currently vendored '${currentTag}'${backend === "gitea" ? " (chart version, read from " + GITEA_VENDORED_MANIFEST_PATH + ")" : " (read from " + VALUES_YAML_PATH + ")"} at '${baseBranch}'. ` +
        "A re-vendor only ever moves forward."
    );
  }
}

/**
 * The IMAGE axis for gitea (finding 4's other half): reads the chart's OWN `Chart.yaml`
 * `appVersion` field — a small, structured piece of metadata already sitting on disk after
 * `fetchGiteaChart` pulled the chart, never a render — and resolves a digest for the conventional
 * `<appVersion>-rootless` tag shape the vendored chart has always used
 * (`docker.gitea.com/gitea:1.26.1-rootless` — see the real vendored manifest's own header), falling
 * back to the bare `appVersion` if that reference does not exist. Never guessed silently: if
 * NEITHER resolves, the run fails loudly rather than pinning a digest for a reference that might be
 * wrong. The sandbox's own `resolveImageDigest` (a lookup, not a guess — see `sandbox-io.ts`) is
 * what catches a wrong guess here even if both happened to resolve: it only has a digest for the
 * EXACT tag this function decided on, so a chart whose rendered image tag disagrees fails the plan
 * rather than silently shipping the wrong pin.
 */
async function readGiteaChartAppVersion(chartDir: string): Promise<string> {
  const raw = await readFile(join(chartDir, "Chart.yaml"), "utf8");
  const match = /^appVersion:\s*["']?([^"'\s]+)["']?\s*$/m.exec(raw);
  if (!match) {
    throw new Error(
      `vendor-refresh orchestrator: '${chartDir}/Chart.yaml' declares no 'appVersion' — cannot resolve the gitea image tag`
    );
  }
  return match[1]!;
}

async function resolveGiteaImageTag(
  coordinate: string,
  appVersion: string,
  deps: RevendorFetchDeps
): Promise<string> {
  const candidates = [`${appVersion}-rootless`, appVersion];
  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      await deps.resolveImageDigest(`${coordinate}:${candidate}`);
      return candidate;
    } catch (err) {
      failures.push(`'${candidate}': ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(
    `vendor-refresh orchestrator: could not resolve a digest for '${coordinate}' at app version ` +
      `'${appVersion}' — tried ${candidates.map((c) => `'${c}'`).join(" and ")} (${failures.join("; ")}). ` +
      "The chart's image-tag convention may have changed; this is refused rather than guessed."
  );
}

// ================================================================================================
// THE ORCHESTRATOR DOES NOT TRUST THE SANDBOX'S VERDICT (2026-09-25 re-review, finding 2).
// ================================================================================================
// The sandbox is where UNTRUSTED bytes get parsed — that is the entire reason it holds no
// credential. Its own `classification` is therefore not what decides auto-merge: `output.json` is
// validated against a STRICT shape (unknown keys refused — a sandbox that could smuggle an extra
// field is a sandbox that could smuggle instructions THIS process reads back later), and the
// orchestrator re-derives, itself, with NO YAML parsing at all, whether the returned bytes are safe:
// the vendored manifest file(s), rejoined, must equal the fetched (authenticity-checked) bytes this
// orchestrator already holds EXACTLY; the three shared downstream files' diffs must be confined,
// LINE BY LINE, to lines that already mention a tracked image coordinate. Either check failing, or
// being impossible to run at all (gitea: rendered from a chart, not a fetched manifest — there is no
// byte-identical baseline to compare against), forces `requires-review`.

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const keys = Object.keys(obj);
  const extra = keys.filter((k) => !allowed.includes(k));
  if (extra.length > 0) {
    throw new Error(
      `vendor-refresh orchestrator: REFUSED (untrusted_output_shape) — ${label} carries unknown key(s): ${extra.join(", ")}`
    );
  }
  const missing = allowed.filter((k) => !keys.includes(k));
  if (missing.length > 0) {
    throw new Error(
      `vendor-refresh orchestrator: REFUSED (untrusted_output_shape) — ${label} is missing '${missing.join(", ")}'`
    );
  }
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(
      `vendor-refresh orchestrator: REFUSED (untrusted_output_shape) — ${label} is not a string`
    );
  }
  return value;
}

/** Parse and STRICTLY validate `output.json`'s shape — an unknown key ANYWHERE in it is refused,
 *  never silently ignored. This is a shape check only (types, exact key sets); it says nothing
 *  about whether the CONTENT is trustworthy — that is what the checks below this function are for. */
export function parseSandboxOutputStrict(raw: string): {
  plan: VendorRefreshPlan;
  classification: DiffClassification;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `vendor-refresh orchestrator: REFUSED (untrusted_output_shape) — output.json is not valid JSON (${err instanceof Error ? err.message : String(err)})`
    );
  }
  if (!isPlainObject(parsed)) {
    throw new Error(
      "vendor-refresh orchestrator: REFUSED (untrusted_output_shape) — output.json is not an object"
    );
  }
  assertExactKeys(parsed, ["plan", "classification"], "output.json");

  const planRaw = parsed["plan"];
  if (!isPlainObject(planRaw)) {
    throw new Error(
      "vendor-refresh orchestrator: REFUSED (untrusted_output_shape) — output.json.plan is not an object"
    );
  }
  assertExactKeys(
    planRaw,
    ["backend", "tag", "files", "trackedImages", "summary"],
    "output.json.plan"
  );
  const backend = assertString(planRaw["backend"], "output.json.plan.backend");
  const tag = assertString(planRaw["tag"], "output.json.plan.tag");
  const summary = assertString(planRaw["summary"], "output.json.plan.summary");

  const filesRaw = planRaw["files"];
  if (!Array.isArray(filesRaw)) {
    throw new Error(
      "vendor-refresh orchestrator: REFUSED (untrusted_output_shape) — output.json.plan.files is not an array"
    );
  }
  const files: VendorFile[] = filesRaw.map((f, i) => {
    if (!isPlainObject(f)) {
      throw new Error(
        `vendor-refresh orchestrator: REFUSED (untrusted_output_shape) — output.json.plan.files[${i}] is not an object`
      );
    }
    assertExactKeys(f, ["path", "content"], `output.json.plan.files[${i}]`);
    return {
      path: assertString(f["path"], `output.json.plan.files[${i}].path`),
      content: assertString(f["content"], `output.json.plan.files[${i}].content`)
    };
  });

  const trackedImagesRaw = planRaw["trackedImages"];
  if (!Array.isArray(trackedImagesRaw)) {
    throw new Error(
      "vendor-refresh orchestrator: REFUSED (untrusted_output_shape) — output.json.plan.trackedImages is not an array"
    );
  }
  const trackedImages: TrackedImage[] = trackedImagesRaw.map((t, i) => {
    if (!isPlainObject(t)) {
      throw new Error(
        `vendor-refresh orchestrator: REFUSED (untrusted_output_shape) — output.json.plan.trackedImages[${i}] is not an object`
      );
    }
    assertExactKeys(
      t,
      ["bundleImageName", "resolvedRef", "tagRef"],
      `output.json.plan.trackedImages[${i}]`
    );
    return {
      bundleImageName: assertString(
        t["bundleImageName"],
        `output.json.plan.trackedImages[${i}].bundleImageName`
      ),
      resolvedRef: assertString(
        t["resolvedRef"],
        `output.json.plan.trackedImages[${i}].resolvedRef`
      ),
      tagRef: assertString(t["tagRef"], `output.json.plan.trackedImages[${i}].tagRef`)
    };
  });

  const classificationRaw = parsed["classification"];
  if (!isPlainObject(classificationRaw)) {
    throw new Error(
      "vendor-refresh orchestrator: REFUSED (untrusted_output_shape) — output.json.classification is not an object"
    );
  }
  assertExactKeys(classificationRaw, ["class", "reasons"], "output.json.classification");
  const cls = classificationRaw["class"];
  if (cls !== "image-only" && cls !== "requires-review") {
    throw new Error(
      `vendor-refresh orchestrator: REFUSED (untrusted_output_shape) — output.json.classification.class is not 'image-only' or 'requires-review' (got ${JSON.stringify(cls)})`
    );
  }
  const reasonsRaw = classificationRaw["reasons"];
  if (!Array.isArray(reasonsRaw)) {
    throw new Error(
      "vendor-refresh orchestrator: REFUSED (untrusted_output_shape) — output.json.classification.reasons is not an array"
    );
  }
  const reasons = reasonsRaw.map((r, i) =>
    assertString(r, `output.json.classification.reasons[${i}]`)
  );

  return {
    plan: { backend: backend as BackendName, tag, files, trackedImages, summary },
    classification: { class: cls, reasons }
  };
}

/** finding 2, first orchestrator-side check: the vendored manifest file(s) the sandbox returned,
 *  REJOINED (never re-parsed), must equal the fetched, authenticity-checked bytes this orchestrator
 *  already holds — BYTE FOR BYTE. No YAML parsing at all: `splitIntoNamedParts`'s own contract
 *  (`tools/vendor-refresh/src/split.ts`) is that `parts.join("\n---\n")` reproduces the original
 *  exactly, so re-joining in path-sorted order and comparing strings is the whole check. Gitea has
 *  no equivalent — its "fetched bytes" are a chart tarball, not the rendered manifest — so this
 *  function is never called for it; the caller treats "gitea" as an automatic authenticity gap
 *  instead (see `authenticityGapsFor`). */
export function verifyVendoredManifestUnchanged(
  backend: Exclude<BackendName, "gitea">,
  fetchedManifestText: string,
  files: readonly VendorFile[]
): string | undefined {
  const prefix = vendorPathPrefix(backend);
  const vendorFiles = files
    .filter(
      (f) =>
        f.path.startsWith(prefix) && isAllowedVendorFilename(backend, f.path.slice(prefix.length))
    )
    .slice()
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (vendorFiles.length === 0) {
    return "the sandbox returned no vendored manifest file at all";
  }
  const reconstructed = vendorFiles.map((f) => f.content).join("\n---\n");
  if (reconstructed !== fetchedManifestText) {
    return (
      `the returned vendored manifest file(s) (${vendorFiles.map((f) => f.path).join(", ")}), ` +
      "rejoined, do not reproduce the fetched bytes byte-for-byte"
    );
  }
  return undefined;
}

/** finding 2, second orchestrator-side check: every line that DIFFERS between the old and new
 *  content of a shared downstream file must mention a tracked image coordinate on BOTH sides — a
 *  pure line-level diff, no YAML/TS parsing. A CHANGED LINE COUNT is refused outright: an added or
 *  removed line is something this check cannot vouch for the safety of at all. */
export function verifyOnlyTrackedImageLinesChanged(
  label: string,
  oldContent: string,
  newContent: string,
  trackedCoordinates: readonly string[]
): string | undefined {
  if (oldContent === newContent) return undefined;
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  if (oldLines.length !== newLines.length) {
    return `${label}: line count changed (${oldLines.length} -> ${newLines.length}) — cannot verify a line-level diff is confined to a tracked image`;
  }
  for (let i = 0; i < oldLines.length; i++) {
    const oldLine = oldLines[i]!;
    const newLine = newLines[i]!;
    if (oldLine === newLine) continue;
    const mentionsTracked = trackedCoordinates.some(
      (c) => oldLine.includes(c) && newLine.includes(c)
    );
    if (!mentionsTracked) {
      return `${label}: line ${i + 1} changed and does not mention a tracked image coordinate on both sides`;
    }
  }
  return undefined;
}

/**
 * finding 3: "Auto-merge eligibility = `image-only` AND authenticity VERIFIED." Authenticity means
 * BOTH a confirmed, passing signature check (never merely attempted — {@link BACKEND_VERIFICATION}'s
 * `method: "keyless"`, which `resolveAndVerifyTrackedDigests` already throws hard on a REAL negative
 * for) AND a fetch by commit SHA (never by tag — a release-asset backend has no sha-addressed form
 * at all). Named here, once, so `orchestrateRevendor` and its tests share exactly one definition of
 * "authenticity verified" rather than two that could drift apart.
 */
export function authenticityGapsFor(backend: BackendName): readonly string[] {
  const gaps: string[] = [];
  const verification = BACKEND_VERIFICATION[backend];
  if (verification.method !== "keyless") {
    gaps.push(
      `${backend}: no confirmed image-signature check (${verification.unverifiedReason ?? "unconfirmed mechanism"}) — never eligible for auto-merge`
    );
  }
  const fetchedBySha = backend !== "gitea" && ARGOPROJ_BACKENDS[backend].urlKind === "raw-tree";
  if (!fetchedBySha) {
    gaps.push(
      `${backend}: fetched by tag, not by commit sha (${backend === "gitea" ? "chart pull, not a sha-addressed fetch" : "no sha-addressed form for a release-asset backend"}) — never eligible for auto-merge`
    );
  }
  return gaps;
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
    copyOut: {
      containerPath: "/work/out",
      hostDir: outDir,
      when: "on-success",
      onFailure: "propagate"
    },
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
    // The IMAGE tag to resolve/verify a digest for. For the four argoproj backends this IS `toTag`
    // (their tracked image's own tag equals the release tag, by the split's whole design). For
    // gitea it is NEVER `toTag` (a chart version) — see `resolveGiteaImageTag`'s doc, finding 4.
    let imageTagForDigest = toTag;

    if (backend === "gitea") {
      chartHostDir = await deps.fetchGiteaChart(toTag, join(inDir, "chart-src"));
      fetchNote = `gitea chart pulled at version ${toTag} via helm pull (network, orchestrator-side; template itself runs sandboxed)`;
      coordinates = [GITEA_IMAGE_COORDINATE];
      const appVersion = await readGiteaChartAppVersion(chartHostDir);
      imageTagForDigest = await resolveGiteaImageTag(GITEA_IMAGE_COORDINATE, appVersion, deps);
    } else {
      const fetched = await fetchArgoprojManifest(ctx, backend, toTag);
      manifestText = fetched.manifestText;
      fetchNote = fetched.fetchNote;
      coordinates = ARGOPROJ_BACKENDS[backend].trackedImages.map((t) => t.coordinate);
    }

    const resolvedDigests = await resolveAndVerifyTrackedDigests(
      ctx,
      backend,
      imageTagForDigest,
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
        throw new Error(
          `vendor-refresh orchestrator: '${label}' is not present at '${baseBranch}'`
        );
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
    // finding 2: STRICT shape validation — unknown keys refused before anything about the content
    // is trusted at all.
    const output = parseSandboxOutputStrict(outputRaw);

    // THE ORCHESTRATOR'S OWN VERDICT (findings 2 and 3) — never merely the sandbox's, and never
    // capable of moving the classification AWAY from requires-review, only toward it: every gap
    // found here is APPENDED to whatever the sandbox itself reported.
    const orchestratorGaps: string[] = [...authenticityGapsFor(backend)];
    if (backend === "gitea") {
      // No byte-identical baseline exists for a rendered chart — "cannot be done" is itself a gap
      // (finding 2: "If any check fails, or cannot be done: requires-review"), not an exemption.
      orchestratorGaps.push(
        "gitea: no byte-equivalence check is possible (rendered from a chart, not a fetched manifest)"
      );
    } else {
      const manifestGap = verifyVendoredManifestUnchanged(
        backend,
        manifestText!,
        output.plan.files
      );
      if (manifestGap) orchestratorGaps.push(manifestGap);
    }
    for (const [path, oldContent] of [
      [VALUES_YAML_PATH, valuesYaml!.content],
      [BUNDLE_IMAGES_TS_PATH, bundleImagesTs!.content],
      [IMAGES_LIST_PATH, imagesList!.content]
    ] as const) {
      const returned = output.plan.files.find((f) => f.path === path);
      const newContent = returned ? returned.content : oldContent;
      const gap = verifyOnlyTrackedImageLinesChanged(path, oldContent, newContent, coordinates);
      if (gap) orchestratorGaps.push(gap);
    }

    const combinedReasons = [...output.classification.reasons, ...orchestratorGaps];
    const combinedClassification: DiffClassification =
      combinedReasons.length === 0
        ? { class: "image-only", reasons: [] }
        : { class: "requires-review", reasons: combinedReasons };

    return { plan: output.plan, classification: combinedClassification, fetchNote };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}
