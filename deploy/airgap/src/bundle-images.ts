/**
 * THE canonical list of images the air-gap bundle carries — the single source of truth every
 * other bundle-contents enumeration is derived from.
 *
 * WHY THIS FILE EXISTS. Until M21.7 the list lived as a literal array inside `build-bundle.ts`,
 * and four other places restated it in prose or shell: the CLI's own `--*-ref` flags,
 * `offline-install-doc.ts`'s "What's in the bundle" tree, `README.md`, and install.sh's
 * per-backend `--set` blocks. Restated lists drift, and the drift is invisible until an operator
 * is standing on the far side of an air gap: `scp-runner-scan` (M13.3b) and `scp-runner-dep`
 * (M21.5) were both built, both published by `publish-images.yml`, both referenced by
 * `deploy/helm/values.yaml` — and neither was ever in the bundle. The managed-scan and managed-dep
 * executors therefore had NO IMAGE TO RUN on a disconnected install, and no test said so, because
 * no test could: nothing enumerated the class "runner images the product ships".
 *
 * So the list is data now, in one place, and `bundle-images.test.ts` holds it against the
 * filesystem: every `apps/runner-*` the repo builds must appear here.
 *
 * ---------------------------------------------------------------------------------------------
 * UNCONDITIONAL, NOT OPT-IN — the shape decision, and the evidence for it
 * ---------------------------------------------------------------------------------------------
 * Every image below rides EVERY bundle. None of them is gated on a build-time flag, including the
 * ones whose feature is off by default. That is not an oversight carried forward; it is the
 * existing, deliberate design, and the two new runners follow it:
 *
 *   - `scp-runner-iac` has always been bundled unconditionally even though `managedIac.enabled`
 *     defaults to `false`. Same for `argocd`/`valkey`/`gitea`/`argo-*`, all of whose
 *     `bundledExecutor.*.enabled` default to `false`. The conditionality in this system is at
 *     DEPLOY time (which images the cluster pulls), never at BUNDLE time — build-bundle.ts's own
 *     comment on the Argo CD entry says exactly this: "pulled only by domains that enable
 *     bundledExecutor.argocd".
 *   - The failure modes are not symmetric. An oversized bundle is a logistics cost the operator
 *     can see and plan around BEFORE the media crosses the boundary. A missing image is discovered
 *     AFTER it crossed, in the one environment where "go fetch the other image" is precisely the
 *     thing that cannot be done. Charter principle 5 makes air-gap first-class; a bundle that
 *     silently cannot run a feature the operator enabled is not first-class.
 *   - Charter principle 7 puts Simplicity first. One unconditional list needs no new flag, no new
 *     conditional path in install.sh, and no way to build a bundle that is wrong.
 *
 * THE RESIDUAL, STATED RATHER THAN PAPERED OVER: `scp-runner-scan` is the largest image here (a
 * Fedora base carrying `oscap` + the SSG datastreams + `trivy` + a baked vulnerability DB), and it
 * is only ever launched by the COMMANDER (ADR-0020 — scanning is commander-resident; outposts and
 * retrans own no scanner). A per-role bundle would let outpost media drop it. There is no per-role
 * bundle today — one release artifact installs every role — and inventing one to save space on a
 * medium that is already carrying Argo CD and Gitea is the wrong trade at this size. If per-role
 * bundles ever arrive, THIS list is where the role facet belongs.
 */

/** Where `skopeo copy` reads an image from. `docker-daemon` = the local daemon; `docker` = a
 *  registry pull (an operator-chosen, documented fetch — see build-bundle.ts's header). */
export type ImageSourceType = "docker-daemon" | "docker";

/** One image the bundle carries, described independently of any CLI parsing. */
export interface BundleImageSpec {
  /** Bundle-wide logical name: the `images/<name>` directory, the `<name>.digest` file, the entry
   *  in `BUNDLE_IMAGE_NAMES`, and (upper-snake-cased) the `manifest.sh` variable stem. */
  name: string;
  /** Stem of this image's CLI flags: `--<optionStem>-ref` / `--<optionStem>-source`. Deliberately
   *  separate from `name` — the eval postgres image is `postgres-eval` in the bundle but has
   *  always been `--postgres-ref` on the command line, and renaming a shipped flag is a break. */
  optionStem: string;
  defaultRef: string;
  defaultSource: ImageSourceType;
  flagDescription: string;
  doc: string;
}

/**
 * The three ephemeral single-shot runner images the Managed Execution Exception is implemented in
 * (charter principle 1 + its `scp-managed-scan` / `scp-managed-dep` amendments). Named as a CLASS
 * rather than one-by-one so `bundle-images.test.ts` can hold the class against `apps/runner-*` —
 * the property that made the M13.3b/M21.5 gap possible was that nobody could enumerate it.
 */
export const RUNNER_IMAGE_NAMES = ["scp-runner-iac", "scp-runner-scan", "scp-runner-dep"] as const;

/** Derive the `apps/` directory that builds a given runner image (`scp-runner-scan` -> `runner-scan`). */
export function runnerAppDirName(imageName: string): string {
  return imageName.replace(/^scp-/, "");
}

export const BUNDLE_IMAGE_SPECS: readonly BundleImageSpec[] = [
  {
    name: "scpd",
    optionStem: "scpd",
    defaultRef: "scp:dev",
    defaultSource: "docker-daemon",
    flagDescription: "scpd image reference to bundle",
    doc: "api + worker + Web UI (the ghcr.io/commanderscp/scpd image)"
  },
  // ---- The three managed-execution runners. Ephemeral, single-shot, launched per run by their
  // orchestrator plugin; each is OFF until the operator supplies its image, and each is bundled
  // unconditionally so that supplying it is possible at all on a disconnected install.
  {
    name: "scp-runner-iac",
    optionStem: "runner-iac",
    defaultRef: "scp-runner-iac:dev",
    defaultSource: "docker-daemon",
    flagDescription: "scp-runner-iac image reference to bundle",
    doc: "the isolated managed-IaC executor image (env: SCP_MANAGED_IAC_RUNNER_IMAGE)"
  },
  {
    name: "scp-runner-scan",
    optionStem: "runner-scan",
    defaultRef: "scp-runner-scan:dev",
    defaultSource: "docker-daemon",
    flagDescription: "scp-runner-scan image reference to bundle",
    doc: "the isolated managed-scan toolchain image, trivy + oscap (env: SCP_MANAGED_SCAN_RUNNER_IMAGE)"
  },
  {
    name: "scp-runner-dep",
    optionStem: "runner-dep",
    defaultRef: "scp-runner-dep:dev",
    defaultSource: "docker-daemon",
    flagDescription: "scp-runner-dep image reference to bundle",
    doc: "the isolated managed-dep manifest editor image (env: SCP_MANAGED_DEP_RUNNER_IMAGE)"
  },
  {
    name: "postgres-eval",
    optionStem: "postgres",
    defaultRef: "postgres:16",
    defaultSource: "docker-daemon",
    flagDescription: "eval postgres image reference to bundle",
    doc: "the unmodified postgres:16 image (evaluation/compose use only)"
  },
  // ---- Bundled executor backends (Mode B) — Argo CD + its Valkey cache. Ride the signed bundle
  // like the runners above; pulled only by domains that enable bundledExecutor.argocd. install.sh
  // retargets them onto bundledExecutor.argocd.image/.valkeyImage.
  {
    name: "argocd",
    optionStem: "argocd",
    defaultRef: "quay.io/argoproj/argocd:v3.4.5",
    defaultSource: "docker",
    flagDescription: "bundled Argo CD image (Mode B) to bundle",
    doc: "bundled Argo CD (Mode B — only pulled where bundledExecutor.argocd is enabled)"
  },
  {
    name: "valkey",
    optionStem: "valkey",
    defaultRef: "valkey/valkey:8-alpine",
    defaultSource: "docker",
    flagDescription: "bundled Argo CD's Valkey cache image to bundle",
    doc: "bundled Argo CD's Valkey cache"
  },
  {
    name: "argo-workflows-cli",
    optionStem: "argo-workflows-cli",
    defaultRef: "quay.io/argoproj/argocli:v4.0.7",
    defaultSource: "docker",
    flagDescription: "bundled Argo Workflows argocli image",
    doc: "bundled Argo Workflows argocli"
  },
  {
    name: "argo-workflows-controller",
    optionStem: "argo-workflows-controller",
    defaultRef: "quay.io/argoproj/workflow-controller:v4.0.7",
    defaultSource: "docker",
    flagDescription: "bundled Argo Workflows controller image",
    doc: "bundled Argo Workflows controller"
  },
  {
    name: "argo-events",
    optionStem: "argo-events",
    defaultRef: "quay.io/argoproj/argo-events:v1.9.10",
    defaultSource: "docker",
    flagDescription: "bundled Argo Events image",
    doc: "bundled Argo Events"
  },
  // Bundled Gitea (Mode B — the DEFAULT unified registry, ADR-0012). Single image: Gitea runs
  // self-contained on SQLite (chart v12.6.0 minimal profile — the only upstream busybox ref was the
  // helm-test Pod, which is stripped from the vendored manifest). install.sh retargets it onto
  // bundledExecutor.gitea.image. Harbor is REMOVED from the bundled stack; an existing Harbor is
  // served via the import path (coordinated as an execution system), not bundled.
  {
    name: "gitea",
    optionStem: "gitea",
    defaultRef: "docker.gitea.com/gitea:1.26.1-rootless",
    defaultSource: "docker",
    flagDescription: "bundled Gitea image (Mode B — the default unified registry)",
    doc: "bundled Gitea (Mode B — the default unified registry, ADR-0012)"
  }
];

/** `--runner-iac-ref` -> `runnerIacRef`: the key commander puts a `--<stem>-<suffix>` flag under. */
export function optionKey(optionStem: string, suffix: "ref" | "source"): string {
  return (optionStem + "-" + suffix).replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}
