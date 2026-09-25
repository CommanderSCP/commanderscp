/** Builds a {@link VendorRefreshIO} that reaches NOTHING outside the process — the IO the
 *  `apps/runner-dep-vendor` sandbox (network-`none`, credential-free, ADR-0059) runs
 *  `planVendorRefresh`/`planArgoprojBackend`/`planGitea` against. Every field the real
 *  `io.ts`/`digest.ts` implementation would fetch over the network or resolve through a subprocess
 *  is instead a LOOKUP into bytes the orchestrator already fetched and verified — see
 *  `sandbox-main.ts` for what assembles {@link SandboxInput} on the orchestrator side and hands it
 *  across the `docker cp` boundary as JSON.
 *
 *  A lookup miss is not a bug to paper over: it is exactly the property this split exists to
 *  enforce. `resolveImageDigest` is keyed on the EXACT `coordinate:tag` string
 *  `planArgoprojBackend`/`planGitea` build from what the FETCHED MANIFEST ITSELF declares — the
 *  orchestrator pre-resolved and cosign-verified a digest only for `coordinate:toTag` (the tag it was
 *  told to re-vendor TO). So if the manifest's own declared tag does not equal `toTag`, the lookup
 *  here misses and the plan fails closed — with no additional code, because a stale/wrong descriptor
 *  and a manifest that disagrees with `toTag` are the same failure the moment nothing was
 *  pre-resolved for what the manifest actually says. */
import { execFileSync } from "node:child_process";
import type { BackendName, VendorRefreshIO } from "./types.js";

export interface SandboxInput {
  backend: BackendName;
  toTag: string;
  /** The ONE fetched manifest text, for the four argoproj-family backends. Absent for gitea, which
   *  never calls `fetchText` (its content comes from `runHelmTemplate` instead). */
  manifestText?: string;
  /** The already-fetched, already-`helm pull`ed chart directory, gitea only — an ABSOLUTE path
   *  inside the sandbox container (`/work/in/chart`), never a repo-qualified ref: this container has
   *  no network and cannot `helm repo add` anything. */
  chartDir?: string;
  /** `coordinate:tag` -> digest (`sha256:...`, no `coordinate:tag@` prefix — matches
   *  `ResolveImageDigest`'s own return contract), pre-resolved AND cosign-verified by the
   *  orchestrator for every tracked image at `toTag`. */
  resolvedDigests: Record<string, string>;
}

/** A local filesystem path detector — deliberately narrow (leading `/`) rather than "not a
 *  `<repo>/<chart>` shape": `helm template` treats ANY arg containing no `/` or starting with `.`/`/`
 *  as a path, and the sandbox only ever constructs paths under `/work/in`, so anchoring on the one
 *  shape this module itself produces is precise where guessing at the general grammar would not be. */
function isLocalChartPath(chartRef: string): boolean {
  return chartRef.startsWith("/");
}

/** `giteaHelmTemplateArgs(chartRef, chartVersion)` always appends `--version <chartVersion>` —
 *  correct when `chartRef` names a repo-qualified chart (`gitea-charts/gitea`, what every human run
 *  and every test uses) and MEANINGLESS for a local chart directory, which already IS one exact,
 *  already-pulled version and accepts no `--version` selector for itself. Stripping the flag here
 *  — rather than teaching `gitea-backend.ts`/`gitea-plan.ts` a second arg-building shape — keeps
 *  `planGitea`'s call to `giteaHelmTemplateArgs` IDENTICAL for every caller (human CLI, every
 *  existing test, and this sandbox); only the one place that actually shells out to `helm` needs to
 *  know the args it was handed do not apply to a local path. */
function stripVersionFlagForLocalChart(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--version") {
      i++; // also drop the value that follows
      continue;
    }
    out.push(args[i]!);
  }
  return out;
}

/** Build the sandbox's `VendorRefreshIO`. `execFn` is injectable ONLY for tests — the sandbox's own
 *  `main()` always takes the default, which shells out to the pinned `helm` this image vendors
 *  (tools/helm/pin.env). */
export function buildSandboxIO(
  input: SandboxInput,
  execFn: (bin: string, args: string[]) => string = (bin, args) =>
    execFileSync(bin, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
): VendorRefreshIO {
  return {
    async fetchText(url: string): Promise<string> {
      if (input.manifestText === undefined) {
        throw new Error(
          `vendor-refresh sandbox: fetchText(${url}) was called but no manifestText was supplied in ` +
            "the sandbox input — the orchestrator did not fetch a manifest for this backend, or this " +
            "is gitea (which never calls fetchText)"
        );
      }
      // The URL argument is IGNORED, deliberately: `planArgoprojBackend` calls `fetchText` exactly
      // once per plan, for exactly the one URL the orchestrator already fetched (by commit SHA or by
      // release-asset tag — see `revendor-orchestrator.ts`), so there is nothing to key a lookup by
      // that a single pre-fetched string does not already answer.
      return input.manifestText;
    },

    async resolveImageDigest(ref: string): Promise<string> {
      const digest = input.resolvedDigests[ref];
      if (digest === undefined) {
        throw new Error(
          `vendor-refresh sandbox: no pre-resolved digest for '${ref}' — the orchestrator only ` +
            `resolved and cosign-verified digests for this backend's tracked image(s) at toTag ` +
            `'${input.toTag}'. Either the fetched manifest declares a DIFFERENT tag than toTag for ` +
            "this coordinate (refused: a re-vendor's own manifest must declare the tag it claims to " +
            "be re-vendoring to), or this coordinate is not one of the backend's tracked images at all."
        );
      }
      return digest;
    },

    async runHelmTemplate(args: readonly string[]): Promise<string> {
      // args[2] is the chart ref position in `giteaHelmTemplateArgs`'s own output
      // (["template", RELEASE_NAME, chartRef, "--version", ...]) — see that function for the shape.
      const chartRef = args[2];
      const localArgs =
        typeof chartRef === "string" && isLocalChartPath(chartRef)
          ? stripVersionFlagForLocalChart(args)
          : [...args];
      return execFn("helm", localArgs);
    }
  };
}
