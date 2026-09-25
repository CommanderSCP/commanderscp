import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  deriveBackendValues,
  fingerprint,
  loadRelease,
  parseManifests,
  resolveHelm,
  RETARGETABLE_IMAGE_PATHS,
  stamp,
  type KubeObject,
  type StackRelease
} from "@scp/stackd";
import { StackBackendSchema, type StackBackend } from "@scp/schemas";

/**
 * THE STACK CONTROLLER'S RIGHTS, CHECKED AGAINST THE RENDERS (M29.4, ADR-0058 E1).
 *
 * The rest of helm-verify refuses every ClusterRole the main chart could render, because nothing
 * scpd does needs one. The stack controller is the one deliberate exception, so it is held to its
 * own, narrower set of assertions instead of being waved through:
 *
 *   SEPARATION  - its ClusterRoles are bound ONLY to its ServiceAccount (one ClusterRoleBinding
 *                 for the cluster half; one RoleBinding per backend namespace for the namespaced
 *                 half, which is bound nowhere cluster-wide), exactly one pod runs as it, no scpd
 *                 pod gains any grant it did not have without it, and its credential is mounted
 *                 only into the controller and the migrations Job.
 *   SUFFICIENCY - every kind every backend renders (through the controller's OWN values
 *                 derivation) is granted, with the verbs server-side apply and prune need, in the
 *                 namespaces the chart creates — so a vendored-manifest bump that adds a kind is a
 *                 red gate here, not a 403 in a customer's cluster.
 *   DETERMINISM - rendering a backend twice from the same inputs is byte-identical (the reconcile
 *                 re-applies only on change), and Gitea's read-back secrets do reach the render.
 */

export interface StackdVerifyContext {
  repoRoot: string;
  chartDir: string;
  bundledChartDir: string;
  renderChart: (release: string, setArgs: string[]) => K8sDoc[];
  fail: (msg: string) => void;
}

interface K8sDoc {
  apiVersion?: string;
  kind?: string;
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string> };
  [k: string]: unknown;
}

interface Rule {
  apiGroups?: string[];
  resources?: string[];
  verbs?: string[];
  resourceNames?: string[];
}

/** Rendered kind -> [API group, resource, cluster-scoped]. An unknown kind fails the gate. */
const RESOURCE_OF: Record<string, [string, string, boolean]> = {
  Namespace: ["", "namespaces", true],
  CustomResourceDefinition: ["apiextensions.k8s.io", "customresourcedefinitions", true],
  ClusterRole: ["rbac.authorization.k8s.io", "clusterroles", true],
  ClusterRoleBinding: ["rbac.authorization.k8s.io", "clusterrolebindings", true],
  PriorityClass: ["scheduling.k8s.io", "priorityclasses", true],
  ConfigMap: ["", "configmaps", false],
  Secret: ["", "secrets", false],
  Service: ["", "services", false],
  ServiceAccount: ["", "serviceaccounts", false],
  PersistentVolumeClaim: ["", "persistentvolumeclaims", false],
  Deployment: ["apps", "deployments", false],
  StatefulSet: ["apps", "statefulsets", false],
  DaemonSet: ["apps", "daemonsets", false],
  NetworkPolicy: ["networking.k8s.io", "networkpolicies", false],
  Role: ["rbac.authorization.k8s.io", "roles", false],
  RoleBinding: ["rbac.authorization.k8s.io", "rolebindings", false],
  WorkflowTemplate: ["argoproj.io", "workflowtemplates", false]
};

const docKey = (d: K8sDoc) => `${d.kind}/${d.metadata?.namespace ?? ""}/${d.metadata?.name ?? ""}`;

function podSpecs(doc: K8sDoc): Record<string, unknown>[] {
  const spec = doc["spec"] as Record<string, unknown> | undefined;
  const template = spec?.["template"] as { spec?: Record<string, unknown> } | undefined;
  return template?.spec ? [template.spec] : [];
}

function grants(
  rules: Rule[],
  group: string,
  resource: string,
  verb: string,
  name?: string
): boolean {
  return rules.some(
    (r) =>
      (r.apiGroups ?? []).includes(group) &&
      (r.resources ?? []).includes(resource) &&
      (r.verbs ?? []).includes(verb) &&
      (r.resourceNames === undefined || (name !== undefined && r.resourceNames.includes(name)))
  );
}

function envNames(doc: K8sDoc): { name: string; secret?: string; key?: string }[] {
  return podSpecs(doc).flatMap((ps) =>
    [
      ...((ps["containers"] as unknown[]) ?? []),
      ...((ps["initContainers"] as unknown[]) ?? [])
    ].flatMap((c) =>
      (
        ((c as { env?: unknown[] }).env ?? []) as {
          name: string;
          valueFrom?: { secretKeyRef?: { name: string; key: string } };
        }[]
      ).map((e) => ({
        name: e.name,
        ...(e.valueFrom?.secretKeyRef
          ? { secret: e.valueFrom.secretKeyRef.name, key: e.valueFrom.secretKeyRef.key }
          : {})
      }))
    )
  );
}

export async function verifyStackController(ctx: StackdVerifyContext): Promise<string[]> {
  const { fail } = ctx;
  const notes: string[] = [];
  const release = "verify";
  const ns = "verify-scp";
  const full = `${release}-commanderscp`;
  const sa = `${full}-stackd`;
  const clusterRole = `${full}-stackd-cluster`;
  const namespacedRole = `${full}-stackd-namespaced`;

  const off = ctx.renderChart(release, ["--namespace", ns, "--set", "networkPolicy.enabled=true"]);
  const on = ctx.renderChart(release, [
    "--namespace",
    ns,
    "--set",
    "networkPolicy.enabled=true",
    "--set",
    "stackd.enabled=true"
  ]);

  // ---- SEPARATION ------------------------------------------------------------------------------
  const offKeys = new Set(off.map(docKey));
  const added = on.filter((d) => !offKeys.has(docKey(d)));
  const chartValues = parseYaml(readFileSync(path.join(ctx.chartDir, "values.yaml"), "utf8")) as {
    stackd: { backendNamespaces: string[] };
  };
  const backendNamespaces = chartValues.stackd.backendNamespaces;
  const expectedAdded = new Set([
    `ServiceAccount/${ns}/${sa}`,
    `ClusterRole//${clusterRole}`,
    `ClusterRole//${namespacedRole}`,
    `ClusterRoleBinding//${clusterRole}`,
    `Secret//${sa}`,
    `ConfigMap//${sa}-images`,
    `Deployment//${sa}`,
    `NetworkPolicy//${sa}`,
    ...backendNamespaces.flatMap((n) => [`Namespace//${n}`, `RoleBinding/${n}/${sa}`])
  ]);
  const addedKeys = added.map(docKey).sort();
  if (JSON.stringify(addedKeys) !== JSON.stringify([...expectedAdded].sort())) {
    fail(
      `[stackd] enabling the stack controller must add exactly its own objects; added ${JSON.stringify(addedKeys)}, expected ${JSON.stringify([...expectedAdded].sort())}`
    );
  }

  const bindings = on.filter((d) => d.kind === "ClusterRoleBinding" || d.kind === "RoleBinding");
  for (const b of bindings) {
    const roleRef = (b["roleRef"] ?? {}) as { kind?: string; name?: string };
    const subjects = (b["subjects"] ?? []) as {
      kind?: string;
      name?: string;
      namespace?: string;
    }[];
    const refersToStackd = roleRef.name === clusterRole || roleRef.name === namespacedRole;
    const bindsStackdSa = subjects.some((s) => s.kind === "ServiceAccount" && s.name === sa);
    if (refersToStackd || bindsStackdSa) {
      const onlyStackd =
        subjects.length === 1 &&
        subjects[0]!.kind === "ServiceAccount" &&
        subjects[0]!.name === sa &&
        subjects[0]!.namespace === ns;
      if (!onlyStackd || !refersToStackd) {
        fail(
          `[stackd] ${b.kind} '${b.metadata?.name}' mixes the stack controller's grant with another identity or role (roleRef ${roleRef.name}, subjects ${JSON.stringify(subjects)}) — its rights must be bound to its ServiceAccount ALONE`
        );
      }
      if (b.kind === "ClusterRoleBinding" && roleRef.name !== clusterRole) {
        fail(
          `[stackd] the namespaced ClusterRole is bound cluster-wide by '${b.metadata?.name}' — it must only be bound per backend namespace`
        );
      }
      if (b.kind === "RoleBinding" && !backendNamespaces.includes(String(b.metadata?.namespace))) {
        fail(
          `[stackd] RoleBinding '${b.metadata?.name}' grants the controller rights in '${b.metadata?.namespace}', which is not a backend namespace`
        );
      }
    }
  }
  const stackdRoleBindings = bindings.filter(
    (b) =>
      b.kind === "RoleBinding" &&
      ((b["roleRef"] ?? {}) as { name?: string }).name === namespacedRole
  );
  if (stackdRoleBindings.length !== backendNamespaces.length) {
    fail(
      `[stackd] expected one RoleBinding per backend namespace (${backendNamespaces.length}), got ${stackdRoleBindings.length}`
    );
  }

  const podsAsStackd = on.filter((d) => podSpecs(d).some((ps) => ps["serviceAccountName"] === sa));
  if (podsAsStackd.map(docKey).join() !== `Deployment//${sa}`) {
    fail(
      `[stackd] exactly the stackd Deployment may run as ${sa}; found ${JSON.stringify(podsAsStackd.map(docKey))}`
    );
  }

  // No scpd identity gains a grant: every Role/RoleBinding/ClusterRole outside the controller's is
  // byte-identical with and without it.
  const isStackdObject = (d: K8sDoc) => expectedAdded.has(docKey(d));
  const rbacKinds = new Set(["Role", "RoleBinding", "ClusterRole", "ClusterRoleBinding"]);
  const rbacOf = (docs: K8sDoc[]) =>
    JSON.stringify(
      docs
        .filter((d) => rbacKinds.has(d.kind ?? "") && !isStackdObject(d))
        .map((d) => ({
          k: docKey(d),
          rules: d["rules"],
          roleRef: d["roleRef"],
          subjects: d["subjects"]
        }))
        .sort((a, b) => a.k.localeCompare(b.k))
    );
  if (rbacOf(on) !== rbacOf(off)) {
    fail(
      "[stackd] enabling the stack controller changed a grant held by something other than the controller — scpd must gain nothing"
    );
  }
  const scpdServiceAccounts = new Set(
    on
      .filter((d) => !isStackdObject(d))
      .flatMap((d) => podSpecs(d).map((ps) => String(ps["serviceAccountName"] ?? "default")))
  );
  if (scpdServiceAccounts.has(sa)) fail(`[stackd] an scpd workload runs as ${sa}`);

  // The credential reaches the controller and the migrations Job, and nothing else.
  for (const d of on) {
    const holds = envNames(d).some((e) => e.secret === sa && e.key === "credential");
    const allowed =
      docKey(d) === `Deployment//${sa}` ||
      (d.kind === "Job" && String(d.metadata?.name).includes("-migrate-"));
    if (holds && !allowed)
      fail(`[stackd] ${docKey(d)} mounts the stack controller's operator credential`);
    if (!holds && allowed)
      fail(`[stackd] ${docKey(d)} does not receive the stack controller's credential it needs`);
  }
  for (const d of on.filter(
    (x) => x.kind === "Deployment" && /-(api|worker)$/.test(String(x.metadata?.name))
  )) {
    const env = envNames(d);
    if (
      !env.some(
        (e) =>
          e.name === "SCP_OPERATOR_DATABASE_PASSWORD" &&
          e.secret === sa &&
          e.key === "operatorDatabasePassword"
      )
    ) {
      fail(
        `[stackd] ${docKey(d)} has no scp_operator connection — the controller's spec/status doors would 503`
      );
    }
  }
  const migrate = on.find(
    (d) => d.kind === "Job" && String(d.metadata?.name).includes("-migrate-")
  );
  if (!migrate || !envNames(migrate).some((e) => e.name === "SCP_PROVISION_OPERATOR_ROLE")) {
    fail("[stackd] the migrations Job does not provision the chart-generated scp_operator login");
  }
  // An operator-supplied connection replaces the generated password everywhere.
  const supplied = ctx.renderChart(release, [
    "--namespace",
    ns,
    "--set",
    "stackd.enabled=true",
    "--set",
    "operatorApi.databaseUrlSecret=my-operator-db"
  ]);
  for (const d of supplied) {
    const env = envNames(d);
    if (
      env.some(
        (e) =>
          e.name === "SCP_OPERATOR_DATABASE_PASSWORD" || e.name === "SCP_PROVISION_OPERATOR_ROLE"
      )
    ) {
      fail(
        `[stackd] ${docKey(d)} still uses the generated scp_operator password although operatorApi.databaseUrlSecret supplies one`
      );
    }
  }

  // The chart's backend namespaces ARE the bundled chart's.
  const bundledValues = parseYaml(
    readFileSync(path.join(ctx.bundledChartDir, "values.yaml"), "utf8")
  ) as {
    bundledExecutor: Record<string, { namespace?: string }>;
  };
  const bundledNamespaces = ["argocd", "argoWorkflows", "argoRollouts", "argoEvents", "gitea"]
    .map((k) => bundledValues.bundledExecutor[k]?.namespace)
    .sort();
  if (JSON.stringify([...backendNamespaces].sort()) !== JSON.stringify(bundledNamespaces)) {
    fail(
      `[stackd] stackd.backendNamespaces ${JSON.stringify(backendNamespaces)} differ from deploy/helm-bundled's ${JSON.stringify(bundledNamespaces)}`
    );
  }

  // ---- SUFFICIENCY -----------------------------------------------------------------------------
  const clusterRules = (on.find((d) => docKey(d) === `ClusterRole//${clusterRole}`)?.["rules"] ??
    []) as Rule[];
  const nsRules = (on.find((d) => docKey(d) === `ClusterRole//${namespacedRole}`)?.["rules"] ??
    []) as Rule[];
  for (const r of [...clusterRules, ...nsRules]) {
    for (const f of ["apiGroups", "resources", "verbs"] as const) {
      if ((r[f] ?? []).includes("*")) fail(`[stackd] a stack controller rule has ${f}: ['*']`);
    }
  }
  const nsRule = clusterRules.find((r) => (r.resources ?? []).includes("namespaces"));
  if (!nsRule?.resourceNames || nsRule.resourceNames.length === 0) {
    fail("[stackd] the controller's namespace rule is not limited by resourceNames");
  }

  const helm = await resolveHelm({
    pinFile: path.join(ctx.repoRoot, "tools/helm/pin.env"),
    binary: "helm"
  });
  const base = await loadRelease({ chartDir: ctx.bundledChartDir, version: "verify" });
  // Every image the controller may be told to use, set — so every template an override unlocks
  // (the RPM build) is rendered and checked too.
  const everyImage: StackRelease = {
    ...base,
    imageOverrides: Object.fromEntries(
      RETARGETABLE_IMAGE_PATHS.map((p) => [
        p,
        `registry.verify/${p.replace(/\./g, "-").toLowerCase()}:1`
      ])
    )
  };
  const gitea = {
    adminPassword: "verify-pw",
    secretKey: "verify-key",
    internalToken: "verify-token"
  };
  const render = async (
    rel: StackRelease,
    backend: StackBackend,
    g = gitea
  ): Promise<KubeObject[]> => {
    const values = deriveBackendValues(
      { backend, enabled: true, sizeTier: "medium" },
      { release: rel, scpNamespace: ns, federationRole: "commander", gitea: g }
    );
    return stamp(parseManifests(await helm.template(rel.chartDir, values)), backend, rel.version);
  };
  let checked = 0;
  for (const rel of [base, everyImage]) {
    for (const backend of StackBackendSchema.options) {
      const objs = await render(rel, backend);
      if (objs.length === 0)
        fail(`[stackd] ${backend} rendered nothing through the controller's values`);
      for (const o of objs) {
        checked += 1;
        const mapped = RESOURCE_OF[o.kind];
        if (!mapped) {
          fail(
            `[stackd] ${backend} renders a ${o.apiVersion} ${o.kind}, which neither this gate nor stackd-rbac.yaml knows — grant it (and add it to RESOURCE_OF) deliberately`
          );
          continue;
        }
        const [group, resource, clusterScoped] = mapped;
        const renderedGroup = o.apiVersion.includes("/") ? o.apiVersion.split("/")[0]! : "";
        if (renderedGroup !== group)
          fail(
            `[stackd] ${o.kind} renders in group '${renderedGroup}', RESOURCE_OF says '${group}'`
          );
        if (o.kind === "Namespace") {
          for (const verb of ["get", "patch"]) {
            if (!grants(clusterRules, "", "namespaces", verb, o.metadata.name)) {
              fail(
                `[stackd] ${backend} applies Namespace '${o.metadata.name}', which the controller may not ${verb}`
              );
            }
          }
          continue;
        }
        const rules = clusterScoped ? clusterRules : nsRules;
        const verbs =
          o.kind === "CustomResourceDefinition"
            ? ["get", "create", "patch"]
            : ["get", "create", "patch", "delete"];
        for (const verb of verbs) {
          if (!grants(rules, group, resource, verb)) {
            fail(
              `[stackd] ${backend} renders ${o.kind} '${o.metadata.name}', and the controller's ${clusterScoped ? "cluster" : "namespaced"} role does not grant '${verb}' on ${group || "core"}/${resource}`
            );
          }
        }
        if (!clusterScoped && !backendNamespaces.includes(o.metadata.namespace ?? "")) {
          fail(
            `[stackd] ${backend} renders ${o.kind} '${o.metadata.name}' into '${o.metadata.namespace}', where the controller holds no rights`
          );
        }
      }
    }
  }
  // The state store and the readiness evidence.
  for (const [resource, verbs] of [
    ["secrets", ["get", "create", "patch", "delete"]],
    ["pods", ["get", "list"]]
  ] as const) {
    for (const verb of verbs) {
      if (!grants(nsRules, "", resource, verb))
        fail(
          `[stackd] the controller cannot ${verb} ${resource} (state store / readiness evidence)`
        );
    }
  }
  // CRDs are never deleted by the controller: removing one removes every custom resource of it.
  if (grants(clusterRules, "apiextensions.k8s.io", "customresourcedefinitions", "delete")) {
    fail("[stackd] the controller may delete CustomResourceDefinitions");
  }

  // ---- ROLLOUTS THAT CAN COMPLETE --------------------------------------------------------------
  // A Deployment on a ReadWriteOnce claim that SURGES cannot finish a rollout when the app locks
  // its data (measured on kind: Gitea's level-db queue lock crash-loops the surged pod), and the
  // controller would roll every upgrade of it back. The property, over every backend's render.
  let rwoDeployments = 0;
  for (const backend of StackBackendSchema.options) {
    const objs = await render(base, backend);
    const rwoClaims = new Set(
      objs
        .filter(
          (o) =>
            o.kind === "PersistentVolumeClaim" &&
            ((o["spec"] as { accessModes?: string[] } | undefined)?.accessModes ?? []).includes(
              "ReadWriteOnce"
            )
        )
        .map((o) => o.metadata.name)
    );
    for (const d of objs.filter((o) => o.kind === "Deployment")) {
      const spec = d["spec"] as {
        strategy?: { type?: string };
        template?: { spec?: { volumes?: { persistentVolumeClaim?: { claimName?: string } }[] } };
      };
      const onRwo = (spec.template?.spec?.volumes ?? []).some(
        (v) =>
          v.persistentVolumeClaim?.claimName && rwoClaims.has(v.persistentVolumeClaim.claimName)
      );
      if (!onRwo) continue;
      rwoDeployments += 1;
      if (spec.strategy?.type !== "Recreate") {
        fail(
          `[stackd] ${backend}'s Deployment '${d.metadata.name}' mounts a ReadWriteOnce claim and rolls out with '${spec.strategy?.type ?? "RollingUpdate"}' — a surged pod cannot take the volume's data lock, so every upgrade would fail and be rolled back. Give it strategy Recreate (renderVendoredBackend "strategies")`
        );
      }
    }
  }
  if (rwoDeployments === 0) {
    fail(
      "[stackd] the RWO-rollout census found no Deployment on a ReadWriteOnce claim — Gitea has one, so the census is not looking"
    );
  }

  // ---- DETERMINISM -----------------------------------------------------------------------------
  for (const backend of StackBackendSchema.options) {
    const a = fingerprint(await render(base, backend));
    const b = fingerprint(await render(base, backend));
    if (a !== b)
      fail(
        `[stackd] ${backend} does not render deterministically — every reconcile would re-apply it`
      );
  }
  const g1 = fingerprint(await render(base, "gitea"));
  const g2 = fingerprint(await render(base, "gitea", { ...gitea, secretKey: "another-key" }));
  if (g1 === g2)
    fail(
      "[stackd] Gitea's read-back SECRET_KEY does not reach the render — every reconcile would rotate it"
    );

  notes.push(
    `  stack controller: ${added.length} objects of its own and nothing else; bound only to ${sa}; ${checked} rendered objects across all five backends (two image sets) all granted, in backend namespaces only; renders deterministic, Gitea secrets carried`
  );
  return notes;
}
