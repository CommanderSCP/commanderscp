import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  STACK_AUTHORING,
  type StackBackend,
  type StackBackendStatusReport,
  type StackNeed,
  type StackSpecDocument
} from "@scp/schemas";
import type { BackendHttp } from "./backend-http.js";
import {
  BACKEND_LABEL,
  MANAGED_BY_LABEL,
  RELEASE_ANNOTATION,
  type KubeObject
} from "./manifests.js";
import { backendNamespace } from "./release.js";
import type { ControllerDeps } from "./reconcile.js";
import { argoCdSession, backendEndpoint, giteaAdmin, type BackendEndpoint } from "./wiring.js";

/**
 * CANARY OUT OF THE BOX (M29.3, ADR-0062) — the stack-level step after every backend has been
 * reconciled. When Argo Rollouts is enabled (with Argo CD and Gitea, both ready and wired), the
 * controller sets up ADR-0055's authoring end to end, with no human step:
 *
 *   1. CARRIER — pushes the carrier chart (`deploy/helm-bundled/authoring/scp-authored-manifests`,
 *      from this image) and the Rollouts install for other clusters into a Gitea repository only it
 *      writes (`scp-stack/scp-authored-manifests`), and pins everything to the resulting COMMIT —
 *      a later push to the repository, by anyone, changes nothing Argo CD renders;
 *   2. PROJECTS — applies the authoring AppProject (ADR-0055 D10's shape: the carrier as its only
 *      source, the one authoring namespace on every target cluster, Rollout and Service only,
 *      nothing cluster-scoped) and the controller's own project for the Rollouts installs;
 *   3. ROLLOUTS REACHES EVERY TARGET — for every cluster registered with Argo CD besides in-cluster
 *      (whose Rollouts controller is this stack's own `argo-rollouts` backend — a second one there
 *      would run two controllers against one cluster), an Application that installs the SAME
 *      vendored, pinned, retargeted render into it, plus the authoring namespace;
 *   4. HAND-OFF — tells scpd the commit and the clusters whose Rollouts install is healthy
 *      (`PUT /instance/stack/authoring`, its credential only). scpd derives the registered Argo CD's
 *      `authoring` from those and release constants; the account's create/update grant on the
 *      project is in the Argo CD render (`values.ts`), keyed on the same three backends.
 *
 * THE M28 CLASS: the target cluster set is ARGO CD'S OWN (its cluster API, read with the admin
 * session — registering a cluster is an Argo CD administrator's act; SCP's account cannot), the
 * repository, projects and namespace are release constants, and nothing here reads a value from the
 * API but hashes. Withdrawn (`DELETE`) the moment any of the three is not wanted.
 */

export const AUTHORING_BACKENDS: readonly StackBackend[] = ["argocd", "gitea", "argo-rollouts"];

/** The label on every Argo CD object this step applies — what the prune lists by. */
export const AUTHORING_LABEL = "stack.commanderscp.io/authoring";
export const IN_CLUSTER_SERVER = "https://kubernetes.default.svc";
const BRANCH = "main";

export interface ArgoCdCluster {
  name: string;
  server: string;
}

/** A registered Argo CD cluster OTHER than in-cluster, as the Argo CD API lists them. */
export function remoteClusters(raw: unknown): ArgoCdCluster[] {
  const items = (raw as { items?: { name?: unknown; server?: unknown }[] } | undefined)?.items;
  const out: ArgoCdCluster[] = [];
  for (const c of items ?? []) {
    if (typeof c.name !== "string" || typeof c.server !== "string") continue;
    if (c.server === IN_CLUSTER_SERVER) continue;
    // The same shape scpd admits (`StackClusterNameSchema`); anything else is not handed over.
    if (!/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(c.name) || c.name.length > 253) continue;
    out.push({ name: c.name, server: c.server });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The Application that installs Rollouts into one cluster: a stable, collision-free name. */
export function rolloutsApplicationName(cluster: ArgoCdCluster): string {
  const hash = createHash("sha256").update(cluster.server).digest("hex").slice(0, 8);
  const base = cluster.name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  return `scp-rollouts-${base || "cluster"}-${hash}`;
}

/** The git blob id of `content` — what Gitea's tree API reports per file. */
export function gitBlobSha(content: Buffer): string {
  return createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${content.length}\0`), content]))
    .digest("hex");
}

async function readTree(dir: string, prefix: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      for (const [k, v] of await readTree(full, rel)) out.set(k, v);
    } else if (entry.isFile()) {
      out.set(rel, await readFile(full));
    }
  }
  return out;
}

/** The controller's stack labels come off: on another cluster they would mean nothing (and on a
 *  cluster that is this one registered twice, they must not look like the in-cluster install's). */
function unstamped(o: KubeObject): KubeObject {
  const labels = Object.fromEntries(
    Object.entries(o.metadata.labels ?? {}).filter(
      ([k]) => k !== MANAGED_BY_LABEL && k !== BACKEND_LABEL
    )
  );
  const annotations = Object.fromEntries(
    Object.entries(o.metadata.annotations ?? {}).filter(([k]) => k !== RELEASE_ANNOTATION)
  );
  return { ...o, metadata: { ...o.metadata, labels, annotations } };
}

const namespaceObject = (name: string): KubeObject => ({
  apiVersion: "v1",
  kind: "Namespace",
  metadata: { name, labels: { "app.kubernetes.io/managed-by": "commanderscp" } }
});

/**
 * Every file the carrier repository holds, by path: the carrier chart, and the Rollouts install
 * for other clusters — the controller's own render of the `argo-rollouts` backend (vendored,
 * pinned, retargeted for air-gap exactly as the in-cluster install is), one JSON document per
 * object, plus the authoring namespace.
 */
export async function carrierFiles(
  chartDir: string,
  rolloutsRender: KubeObject[]
): Promise<Map<string, Buffer>> {
  const files = await readTree(
    path.join(chartDir, "authoring", STACK_AUTHORING.carrierPath),
    STACK_AUTHORING.carrierPath
  );
  const objects = [...rolloutsRender.map(unstamped), namespaceObject(STACK_AUTHORING.namespace)];
  for (const o of objects) {
    const ns = o.metadata.namespace ? `${o.metadata.namespace}.` : "";
    const name = `${o.kind}.${ns}${o.metadata.name}`.toLowerCase().replace(/[^a-z0-9.-]+/g, "-");
    files.set(
      `${STACK_AUTHORING.rolloutsPath}/${name}.json`,
      Buffer.from(`${JSON.stringify(o, null, 2)}\n`)
    );
  }
  return files;
}

// ---- Gitea: the carrier repository ---------------------------------------------------------------

interface GiteaCtx {
  http: BackendHttp;
  base: string;
  auth: string;
}

async function gitea(
  g: GiteaCtx,
  method: "GET" | "POST",
  p: string,
  json?: unknown,
  discardBody = false
): Promise<{ status: number; body: unknown }> {
  return g.http.request({
    method,
    url: `${g.base}/api/v1${p}`,
    headers: { authorization: g.auth },
    ...(json !== undefined ? { json } : {}),
    ...(discardBody ? { discardBody } : {})
  });
}

const repoPath = `/repos/${STACK_AUTHORING.giteaOrg}/${STACK_AUTHORING.giteaRepo}`;

/** Makes the repository hold exactly `files` on `main` and returns that commit. Idempotent: a
 *  branch whose tree already equals `files` blob for blob is returned as it is. */
export async function pushCarrier(g: GiteaCtx, files: Map<string, Buffer>): Promise<string> {
  const org = await gitea(g, "GET", `/orgs/${STACK_AUTHORING.giteaOrg}`);
  if (org.status === 404) {
    const made = await gitea(g, "POST", "/orgs", {
      username: STACK_AUTHORING.giteaOrg,
      visibility: "public",
      description: "CommanderSCP's Standard Stack (written only by the stack controller)"
    });
    if (made.status !== 201 && made.status !== 422) {
      throw new Error(`creating the Gitea organization: HTTP ${made.status}`);
    }
  } else if (org.status !== 200) {
    throw new Error(`reading the Gitea organization: HTTP ${org.status}`);
  }
  const repo = await gitea(g, "GET", repoPath);
  if (repo.status === 404) {
    // PUBLIC: Argo CD's repo-server reads it with no credential. What it holds is the vendored
    // carrier chart and the vendored Rollouts install — nothing that is not already in the image.
    const made = await gitea(g, "POST", `/orgs/${STACK_AUTHORING.giteaOrg}/repos`, {
      name: STACK_AUTHORING.giteaRepo,
      private: false,
      auto_init: false,
      default_branch: BRANCH,
      description: "The CommanderSCP authoring carrier (ADR-0055) and Rollouts installs (ADR-0062)"
    });
    if (made.status !== 201 && made.status !== 409) {
      throw new Error(`creating the carrier repository: HTTP ${made.status}`);
    }
  } else if (repo.status !== 200) {
    throw new Error(`reading the carrier repository: HTTP ${repo.status}`);
  }

  // Read the branch, push what differs, and read it again: the commit handed on is the one whose
  // tree was just SEEN to equal `files` — never an id taken from a response.
  for (let attempt = 0; ; attempt += 1) {
    const { headSha, live } = await readBranch(g);
    const ops = changeOps(files, live);
    if (ops.length === 0 && headSha) return headSha;
    if (attempt > 0) {
      throw new Error(
        `the carrier repository did not settle on its content (${ops.length} files differ)`
      );
    }
    // The response echoes every file written (megabytes, with the Rollouts CRDs): drained, not read.
    const pushed = await gitea(
      g,
      "POST",
      `${repoPath}/contents`,
      {
        branch: BRANCH,
        message: "CommanderSCP stack controller: authoring carrier and Rollouts installs",
        files: ops
      },
      true
    );
    if (pushed.status !== 201) throw new Error(`pushing the carrier: HTTP ${pushed.status}`);
  }
}

async function readBranch(
  g: GiteaCtx
): Promise<{ headSha: string | null; live: Map<string, string> }> {
  const head = await gitea(g, "GET", `${repoPath}/branches/${BRANCH}`);
  const live = new Map<string, string>();
  if (head.status === 404) return { headSha: null, live };
  if (head.status !== 200) throw new Error(`reading the carrier branch: HTTP ${head.status}`);
  const headSha = (head.body as { commit?: { id?: string } }).commit?.id ?? null;
  if (!headSha || !/^[0-9a-f]{40}$/.test(headSha)) {
    throw new Error("the carrier branch names no commit");
  }
  for (let page = 1; page < 50; page += 1) {
    const tree = await gitea(
      g,
      "GET",
      `${repoPath}/git/trees/${headSha}?recursive=true&per_page=1000&page=${page}`
    );
    if (tree.status !== 200) throw new Error(`reading the carrier tree: HTTP ${tree.status}`);
    const body = tree.body as {
      tree?: { path?: string; type?: string; sha?: string }[];
      truncated?: boolean;
    };
    for (const e of body.tree ?? []) {
      if (e.type === "blob" && e.path && e.sha) live.set(e.path, e.sha);
    }
    if (!body.truncated) break;
  }
  return { headSha, live };
}

function changeOps(
  files: Map<string, Buffer>,
  live: Map<string, string>
): Record<string, unknown>[] {
  const ops: Record<string, unknown>[] = [];
  for (const [p, content] of files) {
    const have = live.get(p);
    if (have === gitBlobSha(content)) continue;
    ops.push({
      operation: have === undefined ? "create" : "update",
      path: p,
      content: content.toString("base64"),
      ...(have !== undefined ? { sha: have } : {})
    });
  }
  for (const [p, sha] of live) {
    if (!files.has(p)) ops.push({ operation: "delete", path: p, sha });
  }
  return ops;
}

// ---- Argo CD: projects and Applications -----------------------------------------------------------

const APP_API = "argoproj.io/v1alpha1";

function labels(role: string): Record<string, string> {
  return {
    [MANAGED_BY_LABEL]: "scp-stackd",
    [AUTHORING_LABEL]: role,
    "app.kubernetes.io/managed-by": "commanderscp"
  };
}

/** The authoring project — ADR-0055 D10's shape, with every target cluster as a destination. */
export function authoringProject(
  argocdNs: string,
  repoURL: string,
  clusters: ArgoCdCluster[]
): KubeObject {
  const ns = STACK_AUTHORING.namespace;
  return {
    apiVersion: APP_API,
    kind: "AppProject",
    metadata: { name: STACK_AUTHORING.project, namespace: argocdNs, labels: labels("project") },
    spec: {
      description:
        "CommanderSCP-authored Applications only (ADR-0055, ADR-0062): the carrier as the only source, the authoring namespace on each target cluster, Rollout and Service only, nothing cluster-scoped.",
      sourceRepos: [repoURL],
      destinations: [
        { server: IN_CLUSTER_SERVER, namespace: ns },
        ...clusters.flatMap((c) => [
          { server: c.server, namespace: ns },
          { name: c.name, namespace: ns }
        ])
      ],
      clusterResourceWhitelist: [],
      namespaceResourceWhitelist: [
        { group: "argoproj.io", kind: "Rollout" },
        { group: "", kind: "Service" }
      ]
    }
  };
}

const CLUSTER_SCOPED = new Set([
  "CustomResourceDefinition",
  "ClusterRole",
  "ClusterRoleBinding",
  "Namespace"
]);
const groupOf = (apiVersion: string): string =>
  apiVersion.includes("/") ? apiVersion.split("/")[0]! : "";

/** The controller's own project: the Rollouts installs, into other clusters only, holding exactly
 *  the kinds that render contains. */
export function stackProject(
  argocdNs: string,
  repoURL: string,
  clusters: ArgoCdCluster[],
  rolloutsRender: KubeObject[],
  rolloutsNs: string
): KubeObject {
  const kinds = (scoped: boolean) =>
    [
      ...new Map(
        [...rolloutsRender, namespaceObject(STACK_AUTHORING.namespace)]
          .filter((o) => CLUSTER_SCOPED.has(o.kind) === scoped)
          .map((o) => {
            const k = { group: groupOf(o.apiVersion), kind: o.kind };
            return [`${k.group}/${k.kind}`, k] as const;
          })
      ).values()
    ].sort((a, b) => `${a.group}/${a.kind}`.localeCompare(`${b.group}/${b.kind}`));
  return {
    apiVersion: APP_API,
    kind: "AppProject",
    metadata: {
      name: STACK_AUTHORING.stackProject,
      namespace: argocdNs,
      labels: labels("project")
    },
    spec: {
      description:
        "The CommanderSCP stack controller's own project: the Argo Rollouts install on every registered target cluster (ADR-0062). SCP's Argo CD account is granted nothing here beyond get/sync.",
      sourceRepos: [repoURL],
      // Never in-cluster: this stack's own `argo-rollouts` backend is the Rollouts controller there.
      destinations: clusters.map((c) => ({ server: c.server, namespace: rolloutsNs })),
      clusterResourceWhitelist: kinds(true),
      namespaceResourceWhitelist: kinds(false)
    }
  };
}

export function rolloutsApplication(
  argocdNs: string,
  repoURL: string,
  revision: string,
  cluster: ArgoCdCluster,
  rolloutsNs: string
): KubeObject {
  return {
    apiVersion: APP_API,
    kind: "Application",
    metadata: {
      name: rolloutsApplicationName(cluster),
      namespace: argocdNs,
      labels: labels("rollouts-target"),
      annotations: { "stack.commanderscp.io/cluster": cluster.name }
    },
    spec: {
      project: STACK_AUTHORING.stackProject,
      source: {
        repoURL,
        path: STACK_AUTHORING.rolloutsPath,
        targetRevision: revision,
        directory: { recurse: false }
      },
      destination: { server: cluster.server, namespace: rolloutsNs },
      // Argo CD keeps the install converged; server-side apply because the Rollouts CRDs are larger
      // than client-side apply's last-applied annotation allows. No `resources-finalizer`: deleting
      // this Application never deletes the CRDs (and with them every Rollout) on that cluster —
      // ADR-0058's "CRDs are never deleted".
      syncPolicy: {
        automated: { prune: true, selfHeal: true },
        syncOptions: ["ServerSideApply=true"]
      }
    }
  };
}

/** Synced and Healthy at exactly this revision — only then does a place naming that cluster pass. */
export function rolloutsInstalled(live: KubeObject | null, revision: string): boolean {
  const status = live?.["status"] as
    { sync?: { status?: string; revision?: string }; health?: { status?: string } } | undefined;
  return (
    status?.sync?.status === "Synced" &&
    status.sync.revision === revision &&
    status.health?.status === "Healthy"
  );
}

export function authoringFactsSha256(revision: string, clusters: string[]): string {
  return createHash("sha256")
    .update(JSON.stringify(["authoring", revision, [...clusters].sort()]))
    .digest("hex");
}

// ---- the step ------------------------------------------------------------------------------------

export interface AuthoringInput {
  spec: StackSpecDocument;
  reports: Map<StackBackend, StackBackendStatusReport>;
  /** The render each ready backend was reconciled with this tick. */
  renders: Map<StackBackend, KubeObject[]>;
}

const need = (message: string): StackNeed[] => [
  { code: "wiring", message: `canary authoring: ${message}`.slice(0, 500) }
];

const ready = (r: StackBackendStatusReport | undefined): boolean =>
  r?.phase === "ready" && !r.needs.some((n) => n.code === "wiring");

/** Withdraw: scpd first (nothing more is authored), then the Rollouts-to-target Applications
 *  (never their CRDs). The projects stay: Applications already authored into them keep running. */
async function withdraw(deps: ControllerDeps, input: AuthoringInput): Promise<void> {
  if (input.spec.authoring?.factsSha256) {
    await deps.api.deleteAuthoring();
    deps.log("canary authoring withdrawn from scpd");
  }
  if (input.reports.get("argocd")?.phase !== "ready") return;
  const argocdNs = backendNamespace(deps.release, "argocd");
  for (const app of await deps.kube.list(
    { apiVersion: APP_API, kind: "Application", namespace: argocdNs },
    `${AUTHORING_LABEL}=rollouts-target,${MANAGED_BY_LABEL}=scp-stackd`
  )) {
    await deps.kube.delete({
      apiVersion: APP_API,
      kind: "Application",
      name: app.metadata.name,
      namespace: argocdNs
    });
  }
}

/** THE AUTHORING STEP (`ControllerDeps.afterStack`). Never throws: what did not complete is a need
 *  on the argo-rollouts report. */
export async function reconcileAuthoring(
  deps: ControllerDeps,
  input: AuthoringInput
): Promise<StackNeed[]> {
  if (!deps.wiring) return [];
  const enabled = new Set(input.spec.backends.filter((b) => b.enabled).map((b) => b.backend));
  try {
    if (!AUTHORING_BACKENDS.every((b) => enabled.has(b))) {
      await withdraw(deps, input);
      return enabled.has("argo-rollouts")
        ? need(
            `off — it needs ${AUTHORING_BACKENDS.filter((b) => !enabled.has(b)).join(" and ")} enabled too; until then a component asking for a canary is refused`
          )
        : [];
    }
    const notReady = AUTHORING_BACKENDS.filter((b) => !ready(input.reports.get(b)));
    if (notReady.length > 0) {
      return need(`waiting for ${notReady.join(", ")} to be ready and wired`);
    }
    const renders = (b: StackBackend): KubeObject[] => {
      const r = input.renders.get(b);
      if (!r) throw new Error(`internal: no render of ${b} this tick`);
      return r;
    };
    const giteaEp = backendEndpoint(deps.release, "gitea", renders("gitea"))!;
    const argocdEp: BackendEndpoint = backendEndpoint(deps.release, "argocd", renders("argocd"))!;
    const argocdNs = backendNamespace(deps.release, "argocd");
    const rolloutsNs = backendNamespace(deps.release, "argo-rollouts");
    const rolloutsRender = renders("argo-rollouts");

    // 1. The carrier, pinned by commit.
    const admin = await giteaAdmin(deps, giteaEp);
    const revision = await pushCarrier(
      { http: deps.wiring.http, base: giteaEp.serverUrl, auth: admin.auth },
      await carrierFiles(deps.release.chartDir, rolloutsRender)
    );
    const repoURL = `${giteaEp.serverUrl}/${STACK_AUTHORING.giteaOrg}/${STACK_AUTHORING.giteaRepo}.git`;

    // 2. The target clusters — Argo CD's own registry, read with its admin session.
    const session = await argoCdSession(deps, argocdEp);
    const listed = await deps.wiring.http.request({
      method: "GET",
      url: `${argocdEp.serverUrl}/api/v1/clusters`,
      headers: { authorization: `Bearer ${session}` }
    });
    if (listed.status !== 200) throw new Error(`listing Argo CD's clusters: HTTP ${listed.status}`);
    const clusters = remoteClusters(listed.body);

    // 3. Projects, then Rollouts on every other target cluster; prune the ones whose cluster left.
    await deps.kube.apply(authoringProject(argocdNs, repoURL, clusters));
    await deps.kube.apply(stackProject(argocdNs, repoURL, clusters, rolloutsRender, rolloutsNs));
    const wanted = new Set<string>();
    const installed: string[] = [];
    for (const c of clusters) {
      const app = rolloutsApplication(argocdNs, repoURL, revision, c, rolloutsNs);
      wanted.add(app.metadata.name);
      await deps.kube.apply(app);
      const live = await deps.kube.get({
        apiVersion: APP_API,
        kind: "Application",
        name: app.metadata.name,
        namespace: argocdNs
      });
      if (rolloutsInstalled(live, revision)) installed.push(c.name);
    }
    for (const app of await deps.kube.list(
      { apiVersion: APP_API, kind: "Application", namespace: argocdNs },
      `${AUTHORING_LABEL}=rollouts-target,${MANAGED_BY_LABEL}=scp-stackd`
    )) {
      if (wanted.has(app.metadata.name)) continue;
      await deps.kube.delete({
        apiVersion: APP_API,
        kind: "Application",
        name: app.metadata.name,
        namespace: argocdNs
      });
      deps.log(
        `canary authoring: removed ${app.metadata.name} (its cluster is no longer registered)`
      );
    }

    // 4. The hand-off — only when what scpd holds differs.
    const facts = authoringFactsSha256(revision, installed);
    if (input.spec.authoring?.factsSha256 !== facts) {
      await deps.api.putAuthoring({
        carrierRevision: revision,
        clusters: installed,
        factsSha256: facts
      });
      deps.log(
        `canary authoring: configured at ${revision.slice(0, 12)} for in-cluster${installed.length > 0 ? `, ${installed.join(", ")}` : ""}`
      );
    }
    const pending = clusters.filter((c) => !installed.includes(c.name)).map((c) => c.name);
    return pending.length > 0
      ? need(
          `Argo Rollouts is still installing on ${pending.join(", ")}; a place naming one is refused until it is healthy`
        )
      : [];
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    deps.log(`canary authoring did not complete: ${why}`);
    return need(`did not complete: ${why}`);
  }
}
