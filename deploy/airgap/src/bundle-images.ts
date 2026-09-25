/** THE canonical list of images the air-gap bundle carries. See docs/airgap.md §16. */

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

/** The three ephemeral runner images the exception is built in. See docs/airgap.md §17. */
export const RUNNER_IMAGE_NAMES = [
  "scp-runner-iac",
  "scp-runner-scan",
  "scp-runner-dep",
  "scp-runner-ops"
] as const;

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
    name: "scp-runner-ops",
    optionStem: "runner-ops",
    defaultRef: "scp-runner-ops:dev",
    defaultSource: "docker-daemon",
    flagDescription: "scp-runner-ops image reference to bundle",
    doc: "the isolated host-reaching Ansible catalog runner, charter-allowlisted (env: SCP_MANAGED_OPS_RUNNER_IMAGE)"
  },
  // The Standard Stack controller (M29.4, ADR-0058). First-party, built from apps/stackd with the
  // repo root as context. Not a runner: a long-running Deployment of the main chart. install.sh
  // retargets it (stackd.image.*) and hands it the bundled backends' retargets (stackd.imageOverrides).
  {
    name: "scp-stackd",
    optionStem: "stackd",
    defaultRef: "scp-stackd:dev",
    defaultSource: "docker-daemon",
    flagDescription: "scp-stackd (the Standard Stack controller) image reference to bundle",
    doc: "the Standard Stack controller — installs and upgrades the bundled backends (stackd.image)"
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
  // The build catalog's two images (scp-build-image-v1). Pulled only where
  // bundledExecutor.argoWorkflows is enabled AND a build lane actually runs — but bundled
  // unconditionally alongside the controller, because an air-gapped domain that can submit the
  // workflow and then cannot pull its builder has a template that fails at the last moment.
  {
    name: "buildkit-rootless",
    optionStem: "buildkit-rootless",
    defaultRef: "moby/buildkit:v0.33.0-rootless",
    defaultSource: "docker",
    flagDescription: "build catalog's rootless BuildKit image",
    doc: "build catalog's rootless BuildKit builder (scp-build-image-v1)"
  },
  {
    name: "catalog-git",
    optionStem: "catalog-git",
    defaultRef: "alpine/git:2.47.2",
    defaultSource: "docker",
    flagDescription: "build catalog's git image (source checkout)",
    doc: "build catalog's git client, for the pinned source checkout"
  },
  // scp-build-rpm-v1's builder (M28.1, ADR-0053). FIRST-PARTY — no maintained public image ships
  // rpmbuild — so it is built from apps/builder-rpm like the runners are and, unlike the two
  // above, has no upstream default in the chart at all: install.sh setting it is what renders the
  // template.
  {
    name: "scp-builder-rpm",
    optionStem: "builder-rpm",
    defaultRef: "scp-builder-rpm:dev",
    defaultSource: "docker-daemon",
    flagDescription: "scp-build-rpm-v1's builder image (rpmbuild, EL9) to bundle",
    doc: "build catalog's RPM builder (scp-build-rpm-v1) — first-party, apps/builder-rpm"
  },
  {
    name: "argo-events",
    optionStem: "argo-events",
    defaultRef: "quay.io/argoproj/argo-events:v1.9.10",
    defaultSource: "docker",
    flagDescription: "bundled Argo Events image",
    doc: "bundled Argo Events"
  },
  {
    name: "argo-rollouts",
    optionStem: "argo-rollouts",
    defaultRef: "quay.io/argoproj/argo-rollouts:v1.10.0",
    defaultSource: "docker",
    flagDescription: "bundled Argo Rollouts image",
    doc: "bundled Argo Rollouts controller (progressive delivery; observed, never driven)"
  },
  // Bundled Gitea (Mode B — the DEFAULT unified registry, ADR-0012). See docs/airgap.md §18.
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
