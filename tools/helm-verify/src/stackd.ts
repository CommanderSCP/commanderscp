import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  assertStackSet,
  deriveBackendValues,
  fingerprint,
  loadRelease,
  parseManifests,
  resolveHelm,
  RETARGETABLE_IMAGE_PATHS,
  egressPolicyName,
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
 *                 only into the controller (the migrations Job gets its id and sha256).
 *   ITS OWN NAMESPACE (review B1) - across a VALUE MATRIX (launcher, runner namespace, per-run
 *                 secrets, every managed class, the bundled backends), no identity but the
 *                 controller holds, through any Role, ClusterRole or binding the chart renders, a
 *                 right that could run a pod as the controller or read its credential in the
 *                 controller's namespace; and the chart REFUSES to render the controller into the
 *                 release, runner or a backend namespace.
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
  const chartDefaults = parseYaml(readFileSync(path.join(ctx.chartDir, "values.yaml"), "utf8")) as {
    stackd: { namespace: string };
  };
  const sns = chartDefaults.stackd.namespace;
  const clusterRole = `${full}-stackd-cluster`;
  const namespacedRole = `${full}-stackd-namespaced`;

  // M29.1 (ADR-0058 "the default flip"): stackd.enabled is now the chart's OWN default (true), so
  // the "off" baseline this diff needs must say so explicitly — the bare render below it replaced
  // is no longer off at all, and the diff would silently become "added: []" instead of failing
  // loudly, which is exactly the shape CLAUDE.md's grep-blind-spot warning is about: a test that
  // stops testing anything and stays green.
  const off = ctx.renderChart(release, [
    "--namespace",
    ns,
    "--set",
    "networkPolicy.enabled=true",
    "--set",
    "stackd.enabled=false"
  ]);
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
  const stateRole = `${sa}-state`;
  /** M29.2 (ADR-0061): the one right the controller holds in SCP's own namespace. */
  const egressRole = `${sa}-egress`;
  const expectedAdded = new Set([
    `Namespace//${sns}`,
    `ServiceAccount/${sns}/${sa}`,
    `ClusterRole//${clusterRole}`,
    `ClusterRole//${namespacedRole}`,
    `ClusterRoleBinding//${clusterRole}`,
    `Role/${sns}/${stateRole}`,
    `RoleBinding/${sns}/${stateRole}`,
    `Secret/${sns}/${sa}`,
    `Secret//${sa}-install`,
    `ConfigMap/${sns}/${sa}-images`,
    `Deployment/${sns}/${sa}`,
    `NetworkPolicy/${sns}/${sa}`,
    `Role/${ns}/${egressRole}`,
    `RoleBinding/${ns}/${egressRole}`,
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
    const refersToStackd =
      roleRef.name === clusterRole ||
      roleRef.name === namespacedRole ||
      roleRef.name === stateRole ||
      roleRef.name === egressRole;
    const bindsStackdSa = subjects.some((s) => s.kind === "ServiceAccount" && s.name === sa);
    if (refersToStackd || bindsStackdSa) {
      const onlyStackd =
        subjects.length === 1 &&
        subjects[0]!.kind === "ServiceAccount" &&
        subjects[0]!.name === sa &&
        subjects[0]!.namespace === sns;
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
      const bindingNs = String(b.metadata?.namespace);
      const allowedHere =
        roleRef.name === stateRole
          ? bindingNs === sns
          : roleRef.name === egressRole
            ? bindingNs === ns
            : backendNamespaces.includes(bindingNs);
      if (b.kind === "RoleBinding" && !allowedHere) {
        fail(
          `[stackd] RoleBinding '${b.metadata?.name}' grants the controller '${roleRef.name}' in '${bindingNs}' — the namespaced role belongs only in the backend namespaces, the state role only in ${sns}`
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
  if (podsAsStackd.map(docKey).join() !== `Deployment/${sns}/${sa}`) {
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

  // The credential's PLAINTEXT is in one Secret in the controller's namespace and reaches the
  // controller alone; the migrations Job records its id and sha256 from the release-namespace
  // Secret, and nothing else receives either.
  const credSecret = on.find((d) => docKey(d) === `Secret/${sns}/${sa}`);
  const credKeys = Object.keys((credSecret?.["stringData"] ?? {}) as Record<string, string>);
  if (credKeys.join() !== "credential") {
    fail(
      `[stackd] the controller's credential Secret holds ${JSON.stringify(credKeys)}, not exactly 'credential'`
    );
  }
  const installSecret = on.find((d) => docKey(d) === `Secret//${sa}-install`);
  const installData = (installSecret?.["stringData"] ?? {}) as Record<string, string>;
  if (
    "credential" in installData ||
    Object.values(installData).some((v) => v.startsWith("scp_op_"))
  ) {
    fail(
      "[stackd] the release-namespace install Secret carries the controller's plaintext credential"
    );
  }
  if (!/^[0-9a-f]{64}$/.test(installData["credentialSha256"] ?? "")) {
    fail("[stackd] the install Secret has no sha256 of the controller's credential");
  }
  const tokenId = installData["credentialTokenId"] ?? "";
  const plaintext =
    ((credSecret?.["stringData"] ?? {}) as Record<string, string>)["credential"] ?? "";
  if (!tokenId || !plaintext.startsWith(`scp_op_${tokenId}.`)) {
    fail("[stackd] the install Secret's credential id is not the controller credential's id");
  }
  for (const d of on) {
    const env = envNames(d);
    const holdsPlain = env.some((e) => e.secret === sa && e.key === "credential");
    const holdsHash = env.some(
      (e) =>
        e.secret === `${sa}-install` &&
        (e.key === "credentialSha256" || e.key === "credentialTokenId")
    );
    const isController = docKey(d) === `Deployment/${sns}/${sa}`;
    const isMigrate = d.kind === "Job" && String(d.metadata?.name).includes("-migrate-");
    if (holdsPlain !== isController) {
      fail(
        `[stackd] ${docKey(d)} ${holdsPlain ? "mounts" : "does not receive"} the stack controller's plaintext credential`
      );
    }
    if (holdsHash !== isMigrate) {
      fail(
        `[stackd] ${docKey(d)} ${holdsHash ? "receives" : "does not receive"} the controller credential's id/sha256`
      );
    }
  }
  // Review S2: a replaced credential rolls the controller.
  const stackdDeployment = on.find((d) => docKey(d) === `Deployment/${sns}/${sa}`);
  const tplAnnotations =
    (
      stackdDeployment?.["spec"] as {
        template?: { metadata?: { annotations?: Record<string, string> } };
      }
    )?.template?.metadata?.annotations ?? {};
  if (!/^[0-9a-f]{64}$/.test(tplAnnotations["checksum/credential"] ?? "")) {
    fail(
      "[stackd] the controller's pod template carries no checksum of its credential — a rotation would not roll it"
    );
  }
  // M29.2 (ADR-0061): IN SCP'S OWN NAMESPACE THE CONTROLLER MAY WRITE NETWORKPOLICIES AND NOTHING
  // ELSE — the per-backend egress policies it opens for scpd when it wires a backend. No Secret (the
  // release namespace holds scpd's database credentials), no workload, no pod: get/patch/delete are
  // held to the three policy names; `create` cannot be limited by name in RBAC, which ADR-0061 states.
  {
    const egressRules = (on.find((d) => docKey(d) === `Role/${ns}/${egressRole}`)?.["rules"] ??
      []) as Rule[];
    const policyNames = (["argocd", "argo-workflows", "gitea"] as const)
      .map((b) => egressPolicyName(b))
      .sort();
    const outside = egressRules.filter(
      (r) =>
        JSON.stringify(r.apiGroups ?? []) !== JSON.stringify(["networking.k8s.io"]) ||
        JSON.stringify(r.resources ?? []) !== JSON.stringify(["networkpolicies"])
    );
    if (outside.length > 0) {
      fail(
        `[stackd] the controller's Role in ${ns} grants something other than NetworkPolicies: ${JSON.stringify(outside)}`
      );
    }
    for (const verb of ["get", "patch", "delete"]) {
      const rule = egressRules.find((r) => (r.verbs ?? []).includes(verb));
      if (
        !rule ||
        JSON.stringify([...(rule.resourceNames ?? [])].sort()) !== JSON.stringify(policyNames)
      ) {
        fail(
          `[stackd] the controller's '${verb}' on NetworkPolicies in ${ns} is not held to exactly ${JSON.stringify(policyNames)}`
        );
      }
    }
    if (!egressRules.some((r) => (r.verbs ?? []).includes("create"))) {
      fail(`[stackd] the controller cannot create its egress NetworkPolicies in ${ns}`);
    }
    for (const r of egressRules) {
      const extra = (r.verbs ?? []).filter(
        (v) => !["get", "patch", "delete", "create"].includes(v)
      );
      if (extra.length > 0)
        fail(`[stackd] the controller's Role in ${ns} grants ${JSON.stringify(extra)}`);
    }
  }
  // Review N3: DNS, the API server, scpd's api pods in the RELEASE namespace, and (M29.2) the two
  // backend APIs it mints tokens on, in the backend namespaces only — nothing else.
  const np = on.find((d) => docKey(d) === `NetworkPolicy/${sns}/${sa}`);
  const egress =
    (np?.["spec"] as { egress?: { to?: Record<string, unknown>[]; ports?: { port?: number }[] }[] })
      ?.egress ?? [];
  const kinds = egress.map((r) => {
    const to = r.to ?? [];
    const sel =
      to.length === 1
        ? (to[0]!["namespaceSelector"] as
            | { matchExpressions?: { key: string; operator: string; values?: string[] }[] }
            | undefined)
        : undefined;
    if (
      to.length === 1 &&
      !("podSelector" in to[0]!) &&
      sel?.matchExpressions?.length === 1 &&
      sel.matchExpressions[0]!.key === "kubernetes.io/metadata.name" &&
      sel.matchExpressions[0]!.operator === "In" &&
      JSON.stringify([...(sel.matchExpressions[0]!.values ?? [])].sort()) ===
        JSON.stringify([...backendNamespaces].sort()) &&
      JSON.stringify((r.ports ?? []).map((p) => p.port).sort()) === JSON.stringify([3000, 8080])
    ) {
      return "backend-apis";
    }
    if (to.length === 1 && "namespaceSelector" in to[0]! && !("podSelector" in to[0]!)) {
      return (r.ports ?? []).every((p) => p.port === 53) ? "dns" : "any-namespace";
    }
    if (to.length > 0 && to.every((t) => "ipBlock" in t)) return "kube-api";
    if (
      to.length === 1 &&
      JSON.stringify(to[0]!["namespaceSelector"]) ===
        JSON.stringify({ matchLabels: { "kubernetes.io/metadata.name": ns } }) &&
      "podSelector" in to[0]!
    ) {
      return "scpd-api";
    }

    return `other:${JSON.stringify(to)}`;
  });
  if (JSON.stringify(kinds) !== JSON.stringify(["dns", "kube-api", "scpd-api", "backend-apis"])) {
    fail(
      `[stackd] the controller's egress is ${JSON.stringify(kinds)}, not exactly DNS, the API server, scpd's api pods in ${ns} and the Argo CD/Gitea APIs (8080/3000) in the backend namespaces`
    );
  }
  for (const d of on.filter(
    (x) => x.kind === "Deployment" && /-(api|worker)$/.test(String(x.metadata?.name))
  )) {
    if (
      !envNames(d).some(
        (e) =>
          e.name === "SCP_OPERATOR_DATABASE_PASSWORD" &&
          e.secret === `${sa}-install` &&
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

  // ---- ITS OWN NAMESPACE, ACROSS THE VALUE MATRIX (review B1) ---------------------------------
  notes.push(...verifyStackdNamespaceIsolation(ctx, { release, ns, sa, sns, backendNamespaces }));

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
      { backend, enabled: true, sizeTier: "medium", purgeGeneration: 0, rotateGeneration: 0 },
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
      // The controller refuses to apply what STACK_KINDS does not allow (review S1): a vendored
      // bump that adds a kind must fail here, not at the first reconcile.
      try {
        const nsOf = objs.find((o) => o.kind === "Namespace")?.metadata.name ?? "";
        assertStackSet(objs, nsOf, `${backend}'s render`);
      } catch (err) {
        fail(`[stackd] ${err instanceof Error ? err.message : String(err)}`);
      }
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
  // The state store lives in the controller's own namespace (review S1).
  const stateRules = (on.find((d) => docKey(d) === `Role/${sns}/${stateRole}`)?.["rules"] ??
    []) as Rule[];
  for (const verb of ["get", "create", "patch", "delete"]) {
    if (!grants(stateRules, "", "secrets", verb))
      fail(`[stackd] the controller cannot ${verb} its state Secrets in ${sns}`);
  }
  // Backend Secrets (Gitea's) and the readiness evidence.
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

  // ---- THE BACKENDS' OWN IDENTITIES, IN THE CONTROLLER'S NAMESPACE (#421 re-verify) -----------
  // The matrix above covers what the MAIN chart renders. Once the controller has applied the
  // backends, their upstream ServiceAccounts hold cluster-wide roles too — so the same property is
  // evaluated over every backend's render, and each subject that still reaches in is an EXPLICIT,
  // justified exception (BACKEND_TAKEOVER_EXCEPTIONS) rather than something nobody looked at.
  {
    const all: K8sDoc[] = [...on];
    for (const backend of StackBackendSchema.options) {
      all.push(...((await render(base, backend)) as unknown as K8sDoc[]));
    }
    const isController = (x: Subject) =>
      x.kind === "ServiceAccount" && x.name === sa && x.namespace === sns;
    const found = new Map<string, string[]>();
    for (const line of takeoverGrants(all, sns, isController)) {
      const subject = line.slice(0, line.indexOf(" may "));
      found.set(subject, [...(found.get(subject) ?? []), line]);
    }
    for (const [subject, lines] of found) {
      if (!(subject in BACKEND_TAKEOVER_EXCEPTIONS)) {
        fail(
          `[stackd] a backend identity reaches into ${sns} with no recorded justification: ${lines.slice(0, 3).join("; ")} — narrow it (bindInNamespace + --namespaced), or record it in BACKEND_TAKEOVER_EXCEPTIONS and ADR-0058 §6`
        );
      }
    }
    for (const subject of Object.keys(BACKEND_TAKEOVER_EXCEPTIONS)) {
      if (!found.has(subject)) {
        fail(
          `[stackd] BACKEND_TAKEOVER_EXCEPTIONS lists ${subject}, which no longer reaches into ${sns} — delete the stale exception`
        );
      }
    }
    notes.push(
      `  backend identities in ${sns}: ${found.size} recorded exception(s) (${[...found.keys()].join(", ")}), no unrecorded one`
    );
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

// ---- review B1: nothing else can become the controller ------------------------------------------

/**
 * THE BACKEND IDENTITIES THAT STILL HOLD A TAKEOVER RIGHT IN THE CONTROLLER'S NAMESPACE, each with
 * why (ADR-0058 §6). Kubernetes RBAC has no deny: a subject bound cluster-wide to create pods holds
 * that right in every namespace, and these upstream roles are cluster-wide because the component's
 * PURPOSE is cluster-wide. Argo Workflows and Argo Events are NOT here — they are narrowed to their
 * own namespaces (deploy/helm-bundled `bindInNamespace` + `--namespaced`). A subject missing from
 * this table fails the gate; an entry that no longer matches fails it too.
 */
const BACKEND_TAKEOVER_EXCEPTIONS: Record<string, string> = {
  "ServiceAccount scp-argocd/argocd-application-controller":
    "Argo CD's application controller applies whatever an Application's manifests hold into the workload namespaces it targets — `*/*` in every namespace is its purpose upstream. Namespace-install would limit Argo CD to its own namespace, i.e. remove the capability SCP bundles it for. Who can make it act: whoever can write an Application/AppProject — SCP's scoped account, and Argo CD's own admin",
  "ServiceAccount scp-argocd/argocd-server":
    "argo-server's API serves resource actions (restart, delete, patch) on any managed resource, cluster-wide upstream; it acts only for an authenticated Argo CD user with an RBAC grant to that application. Same namespace-install trade-off as the application controller",
  "ServiceAccount scp-argocd/argocd-applicationset-controller":
    "reads Secrets cluster-wide for upstream's ApplicationSets-in-any-namespace (SCM/cluster generator tokens beside each ApplicationSet). SCP creates no ApplicationSet, so this is a NARROWING CANDIDATE (bind it in scp-argocd only), not yet taken: Argo CD is rendered by its own template, and whether v3.4's controller still starts with namespace-only Secret reads is unmeasured — a follow-up, recorded rather than guessed",
  "ServiceAccount scp-argo-rollouts/argo-rollouts":
    "Argo Rollouts manages Rollout objects in the WORKLOAD namespaces (it creates their ReplicaSets and reads their Secrets for analysis); a namespaced install would manage only its own, empty namespace (argo-rollouts.yaml). It acts on Rollout objects, which a subject must be able to create in the target namespace first"
};

/** Rights in the controller's namespace that let their holder run a pod AS the controller (and so
 *  hold its rights), mint its token, or read its credential. `[group, resource, verbs]`. */
const TAKEOVER_RIGHTS: [string, string, string[]][] = [
  ["", "pods", ["create", "update", "patch"]],
  ["", "pods/exec", ["create", "get"]],
  ["", "pods/attach", ["create", "get"]],
  ["", "pods/ephemeralcontainers", ["update", "patch"]],
  ["", "replicationcontrollers", ["create", "update", "patch"]],
  ["apps", "deployments", ["create", "update", "patch"]],
  ["apps", "statefulsets", ["create", "update", "patch"]],
  ["apps", "daemonsets", ["create", "update", "patch"]],
  ["apps", "replicasets", ["create", "update", "patch"]],
  ["batch", "jobs", ["create", "update", "patch"]],
  ["batch", "cronjobs", ["create", "update", "patch"]],
  ["", "secrets", ["get", "list", "watch"]],
  ["", "serviceaccounts/token", ["create"]],
  ["", "serviceaccounts", ["impersonate"]],
  ["rbac.authorization.k8s.io", "roles", ["create", "update", "patch", "bind", "escalate"]],
  ["rbac.authorization.k8s.io", "rolebindings", ["create", "update", "patch"]]
];

const matches = (list: string[] | undefined, want: string) =>
  (list ?? []).includes(want) || (list ?? []).includes("*");

/**
 * Every (subject, right) in `docs` that reaches namespace `target` and is a takeover right —
 * through a RoleBinding IN `target`, or any ClusterRoleBinding. A roleRef the render does not
 * contain (a built-in like `admin`) is treated as granting everything: it cannot be read, so it
 * cannot be cleared.
 */
export function takeoverGrants(
  docs: K8sDoc[],
  target: string,
  exempt: (s: Subject) => boolean
): string[] {
  const out: string[] = [];
  const rolesByKey = new Map(
    docs
      .filter((d) => d.kind === "Role" || d.kind === "ClusterRole")
      .map((d) => [
        `${d.kind}/${d.kind === "Role" ? (d.metadata?.namespace ?? "") : ""}/${d.metadata?.name}`,
        d
      ])
  );
  for (const b of docs) {
    if (b.kind !== "RoleBinding" && b.kind !== "ClusterRoleBinding") continue;
    if (b.kind === "RoleBinding" && b.metadata?.namespace !== target) continue;
    const roleRef = (b["roleRef"] ?? {}) as { kind?: string; name?: string };
    const role = rolesByKey.get(
      `${roleRef.kind}/${roleRef.kind === "Role" ? (b.metadata?.namespace ?? "") : ""}/${roleRef.name}`
    );
    const rules: Rule[] = role
      ? ((role["rules"] ?? []) as Rule[])
      : [{ apiGroups: ["*"], resources: ["*"], verbs: ["*"] }];
    for (const subject of (b["subjects"] ?? []) as Subject[]) {
      if (exempt(subject)) continue;
      for (const [group, resource, verbs] of TAKEOVER_RIGHTS) {
        for (const verb of verbs) {
          if (
            rules.some(
              (r) =>
                matches(r.apiGroups, group) &&
                matches(r.resources, resource) &&
                matches(r.verbs, verb)
            )
          ) {
            out.push(
              `${subject.kind} ${subject.namespace ? `${subject.namespace}/` : ""}${subject.name} may ${verb} ${group || "core"}/${resource} in ${target} (via ${b.kind} ${b.metadata?.name} -> ${roleRef.kind} ${roleRef.name})`
            );
          }
        }
      }
    }
  }
  return out;
}

interface Subject {
  kind?: string;
  name?: string;
  namespace?: string;
}

function verifyStackdNamespaceIsolation(
  ctx: StackdVerifyContext,
  p: { release: string; ns: string; sa: string; sns: string; backendNamespaces: string[] }
): string[] {
  const { fail } = ctx;
  const isController = (s: Subject) =>
    s.kind === "ServiceAccount" && s.name === p.sa && s.namespace === p.sns;

  // Known-positive control: the detector sees the exact grant the review found.
  const planted: K8sDoc[] = [
    {
      kind: "Role",
      metadata: { name: "runner", namespace: p.sns },
      rules: [{ apiGroups: ["batch"], resources: ["jobs"], verbs: ["create"] }]
    },
    {
      kind: "RoleBinding",
      metadata: { name: "runner", namespace: p.sns },
      roleRef: { kind: "Role", name: "runner" },
      subjects: [{ kind: "ServiceAccount", name: "worker", namespace: p.ns }]
    },
    {
      kind: "ClusterRoleBinding",
      metadata: { name: "builtin" },
      roleRef: { kind: "ClusterRole", name: "edit" },
      subjects: [{ kind: "ServiceAccount", name: "worker", namespace: p.ns }]
    }
  ];
  const control = takeoverGrants(planted, p.sns, isController);
  if (
    !control.some((c) => c.includes("batch/jobs")) ||
    !control.some((c) => c.includes("ClusterRole edit"))
  ) {
    fail(
      `[stackd] the takeover detector does not see a planted jobs-create grant or an unreadable built-in ClusterRole (${JSON.stringify(control)}) — the matrix below would pass by not looking`
    );
  }

  const common = [
    "--namespace",
    p.ns,
    "--set",
    "stackd.enabled=true",
    "--set",
    "networkPolicy.enabled=true",
    "--set",
    "managedIac.enabled=true",
    "--set",
    "managedIac.runnerImage=ghcr.io/commanderscp/scp-runner-iac:0.1.0",
    "--set",
    "managedDep.runnerImage=ghcr.io/commanderscp/scp-runner-dep:0.1.0",
    "--set",
    "managedScan.runnerImage=ghcr.io/commanderscp/scp-runner-scan:0.1.0",
    "--set",
    "managedOps.runnerImage=ghcr.io/commanderscp/scp-runner-ops:0.1.0"
  ];
  let points = 0;
  let grantsSeen = 0;
  const cells: { label: string; args: string[] }[] = [
    { label: "docker", args: ["--set", "managedRunners.launcher=docker"] }
  ];
  for (const runnerNs of ["", "scp-runners"]) {
    for (const perRunSecrets of [true, false]) {
      cells.push({
        label: `kubernetes ns='${runnerNs}' perRunSecrets=${perRunSecrets}`,
        args: [
          "--set",
          "managedRunners.launcher=kubernetes",
          "--set",
          "managedRunners.kubernetes.workspace.claimName=scp-runner-rwx",
          "--set",
          `managedRunners.kubernetes.namespace=${runnerNs}`,
          "--set",
          `managedRunners.kubernetes.perRunSecrets=${perRunSecrets}`,
          "--set",
          `managedRunners.kubernetes.acceptSharedNamespaceSecretDelete=${runnerNs === ""}`
        ]
      });
    }
  }
  for (const cell of cells) {
    let docs: K8sDoc[];
    try {
      docs = ctx.renderChart(p.release, [...common, ...cell.args]);
    } catch (err) {
      fail(
        `[stackd] matrix cell '${cell.label}' did not render: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`
      );
      continue;
    }
    points += 1;
    // The matrix is only evidence if the cell has grants to find: the runner Role on Kubernetes.
    grantsSeen += docs.filter(
      (d) => d.kind === "RoleBinding" || d.kind === "ClusterRoleBinding"
    ).length;
    // Where the controller ACTUALLY runs in this render — read from its Deployment, not from the
    // value that should have put it there (a namespace-less object lands in the release's).
    const deployment = docs.find((d) => d.kind === "Deployment" && d.metadata?.name === p.sa);
    const where = deployment?.metadata?.namespace ?? p.ns;
    const controllerHere = (s: Subject) =>
      s.kind === "ServiceAccount" && s.name === p.sa && s.namespace === where;
    const bad = takeoverGrants(
      docs.map((d) =>
        // A namespaced binding without a namespace is created in the release namespace.
        d.kind === "RoleBinding" && !d.metadata?.namespace
          ? { ...d, metadata: { ...d.metadata, namespace: p.ns } }
          : d
      ),
      where,
      controllerHere
    );
    for (const b of bad) fail(`[stackd] ${cell.label}: ${b}`);
    // And the controller's own objects are where they belong, whatever the cell.
    for (const d of docs) {
      const name = String(d.metadata?.name ?? "");
      if (
        name === p.sa &&
        d.kind !== "ClusterRoleBinding" &&
        d.kind !== "RoleBinding" &&
        d.metadata?.namespace !== p.sns
      ) {
        fail(`[stackd] ${cell.label}: ${d.kind} ${name} is rendered outside ${p.sns}`);
      }
    }
  }
  if (points !== cells.length || grantsSeen === 0) {
    fail(
      `[stackd] the namespace-isolation matrix rendered ${points}/${cells.length} cells with ${grantsSeen} bindings — it is not looking`
    );
  }

  // The chart refuses to put the controller where something else has rights.
  const refusals: { label: string; args: string[] }[] = [
    { label: "the release namespace", args: ["--set", `stackd.namespace=${p.ns}`] },
    {
      label: "the runner namespace",
      args: [
        "--set",
        "managedRunners.launcher=kubernetes",
        "--set",
        "managedRunners.kubernetes.workspace.claimName=scp-runner-rwx",
        "--set",
        `managedRunners.kubernetes.namespace=${p.sns}`
      ]
    },
    { label: "a backend namespace", args: ["--set", `stackd.namespace=${p.backendNamespaces[0]}`] }
  ];
  for (const r of refusals) {
    let rendered = false;
    try {
      ctx.renderChart(p.release, [...common, ...r.args]);
      rendered = true;
    } catch (err) {
      if (!String(err instanceof Error ? err.message : err).includes("stackd.namespace")) {
        fail(
          `[stackd] putting the controller in ${r.label} failed to render for another reason: ${String(err).slice(0, 300)}`
        );
      }
    }
    if (rendered) fail(`[stackd] the chart renders the stack controller into ${r.label}`);
  }
  return [
    `  stack controller namespace: ${points} value-matrix cells (${grantsSeen} bindings) grant nothing in ${p.sns} to anyone but the controller; ${refusals.length} placements refused`
  ];
}

/**
 * #422 adversarial review (LIVE RISK) — the `existingSecret`-style overrides for the two Secrets
 * this file's own header touches (`stackd.existingCredentialSecret`,
 * `bootstrap.existingAdminPasswordSecret`) must be genuinely STABLE under a `lookup`-blind render
 * (Argo CD): rendering twice from the SAME inputs must be byte-identical for the objects that
 * reference them, and the chart must render NEITHER of the two Secrets it would otherwise
 * generate. A render that still varied between runs (still calling `randAlphaNum`/`randBytes`
 * somewhere in the referencing path) would silently reintroduce the GitOps regeneration risk this
 * override exists to remove.
 */
export function verifyExistingSecretOverrides(ctx: StackdVerifyContext): string[] {
  const { fail, renderChart } = ctx;
  const release = "verify-existing";
  const ns = "verify-scp";
  const full = `${release}-commanderscp`;

  const args = [
    "--namespace",
    ns,
    "--set",
    "stackd.enabled=true",
    "--set",
    "stackd.existingCredentialSecret=my-stackd-credential",
    "--set",
    "stackd.existingCredentialSecretKey=cred",
    // #422 re-verify BLOCKING 2a — required together with existingCredentialSecret above (the
    // migrations Job, in the RELEASE namespace, cannot read a Secret in stackd.namespace under
    // GitOps); the chart FAILS the render without them, which verifyRequiresCredentialHash below
    // exercises directly.
    "--set",
    "stackd.existingCredentialTokenId=abcdefghijklmnopqrstuv",
    "--set",
    "stackd.existingCredentialSha256=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd",
    "--set",
    "bootstrap.existingAdminPasswordSecret=my-bootstrap-admin",
    "--set",
    "bootstrap.existingAdminPasswordSecretKey=pw"
  ];
  const first = renderChart(release, args);
  const second = renderChart(release, args);

  const stackdCredentialSecretName = `${full}-stackd`;
  const bootstrapSecretName = `${full}-bootstrap-admin`;

  for (const rendered of [first, second]) {
    if (
      rendered.some((d) => d.kind === "Secret" && d.metadata?.name === stackdCredentialSecretName)
    ) {
      fail(
        `[stackd] stackd.existingCredentialSecret is set, but the chart still rendered its own ` +
          `generated credential Secret '${stackdCredentialSecretName}' — the override did not take`
      );
    }
    if (rendered.some((d) => d.kind === "Secret" && d.metadata?.name === bootstrapSecretName)) {
      fail(
        `[bootstrap] bootstrap.existingAdminPasswordSecret is set, but the chart still rendered ` +
          `its own generated Secret '${bootstrapSecretName}' — the override did not take`
      );
    }
  }

  interface SecretRef {
    name?: string;
    value?: string;
    valueFrom?: { secretKeyRef?: { name?: string; key?: string } };
  }
  const envVar = (
    docs: K8sDoc[],
    kind: string,
    name: string,
    envName: string
  ): SecretRef | undefined => {
    const doc = docs.find((d) => {
      if (d.kind !== kind) return false;
      return kind === "Job"
        ? String(d.metadata?.name).includes("-migrate-")
        : d.metadata?.name === name;
    });
    const podTemplate = (doc?.["spec"] as Record<string, unknown> | undefined)?.["template"] as
      { spec?: { containers?: { env?: SecretRef[] }[] } } | undefined;
    const env = podTemplate?.spec?.containers?.[0]?.env ?? [];
    return env.find((e) => e.name === envName);
  };

  // THE MEANINGFUL ASSERTION (mutation-caught while writing this: a byte-identical-across-renders
  // check on a secretKeyRef is NOT sensitive to it silently pointing at the WRONG secret — a
  // secretKeyRef {name, key} is a deterministic reference regardless of what the referenced Secret
  // holds, so a render that pointed it back at the chart's own generated Secret name would still
  // "look stable." What actually proves the override took is the reference's NAME/KEY equalling
  // the configured value, checked directly, not inferred from repeat-render stability).
  function assertSecretKeyRef(
    label: string,
    ref: SecretRef | undefined,
    expectedName: string,
    expectedKey: string
  ): void {
    const skr = ref?.valueFrom?.secretKeyRef;
    if (!skr) {
      fail(`[existing-secret] ${label}: no env var found to check`);
      return;
    }
    if (skr.name !== expectedName || skr.key !== expectedKey) {
      fail(
        `[existing-secret] ${label}: expected secretKeyRef {name: ${expectedName}, key: ${expectedKey}}, ` +
          `got {name: ${skr.name}, key: ${skr.key}} — the existingSecret override is not reaching this env var`
      );
    }
  }

  for (const rendered of [first, second]) {
    assertSecretKeyRef(
      "stackd controller's SCP_STACKD_OPERATOR_CREDENTIAL",
      envVar(rendered, "Deployment", stackdCredentialSecretName, "SCP_STACKD_OPERATOR_CREDENTIAL"),
      "my-stackd-credential",
      "cred"
    );
    // #422 re-verify BLOCKING 2a — the migrations Job (release namespace) never gets the RAW
    // credential (that would need a second copy of it OUTSIDE stackd.namespace); it gets the
    // id/sha256 pair as plain literal values, the same shape the chart's own self-generated path
    // already uses.
    const tokenIdVar = envVar(rendered, "Job", "", "SCP_STACKD_CREDENTIAL_TOKEN_ID");
    const shaVar = envVar(rendered, "Job", "", "SCP_STACKD_CREDENTIAL_SHA256");
    if (tokenIdVar?.value !== "abcdefghijklmnopqrstuv") {
      fail(
        `[existing-secret] migrations Job's SCP_STACKD_CREDENTIAL_TOKEN_ID: expected literal ` +
          `value 'abcdefghijklmnopqrstuv', got ${JSON.stringify(tokenIdVar?.value)}`
      );
    }
    if (shaVar?.value !== "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd") {
      fail(
        `[existing-secret] migrations Job's SCP_STACKD_CREDENTIAL_SHA256: expected the configured ` +
          `literal value, got ${JSON.stringify(shaVar?.value)}`
      );
    }
    assertSecretKeyRef(
      "api pod's SCP_BOOTSTRAP_ADMIN_PASSWORD",
      envVar(rendered, "Deployment", `${full}-api`, "SCP_BOOTSTRAP_ADMIN_PASSWORD"),
      "my-bootstrap-admin",
      "pw"
    );
  }

  // Byte-identical across two renders is still worth checking (it is the property a
  // `lookup`-blind GitOps render actually needs), now ALONGSIDE the direct reference check above
  // rather than instead of it.
  for (const [label, get] of [
    [
      "stackd controller's SCP_STACKD_OPERATOR_CREDENTIAL",
      (d: K8sDoc[]) =>
        envVar(d, "Deployment", stackdCredentialSecretName, "SCP_STACKD_OPERATOR_CREDENTIAL")
    ],
    [
      "migrations Job's SCP_STACKD_CREDENTIAL_TOKEN_ID/SHA256",
      (d: K8sDoc[]) => [
        envVar(d, "Job", "", "SCP_STACKD_CREDENTIAL_TOKEN_ID"),
        envVar(d, "Job", "", "SCP_STACKD_CREDENTIAL_SHA256")
      ]
    ],
    [
      "api pod's SCP_BOOTSTRAP_ADMIN_PASSWORD",
      (d: K8sDoc[]) => envVar(d, "Deployment", `${full}-api`, "SCP_BOOTSTRAP_ADMIN_PASSWORD")
    ]
  ] as const) {
    const a = JSON.stringify(get(first));
    const b = JSON.stringify(get(second));
    if (a !== b) {
      fail(
        `[existing-secret] ${label} differs across two renders of the SAME inputs (run1=${a}, run2=${b})`
      );
    }
  }

  return [
    "  existingSecret overrides (stackd.existingCredentialSecret, " +
      "bootstrap.existingAdminPasswordSecret): neither generated Secret rendered, every " +
      "referencing secretKeyRef names the CONFIGURED secret (not the chart's own generated one), " +
      "and every reference is byte-identical across two renders (GitOps/Argo CD stability)"
  ];
}

/**
 * #422 re-verify, BLOCKING 2 — three guards found live against the owner's homelab-shaped chart
 * values (which track `main`, set NONE of the M29.1 bootstrap/stackd keys, and pin `image.tag`
 * with a `@sha256:` digest):
 *
 * 1. A render with NONE of those keys set must be BYTE-FOR-BYTE what it was before M29.1 —
 *    specifically, no `-bootstrap-admin` Secret (which would otherwise re-randomize on every
 *    `lookup`-blind GitOps render) and no api Deployment env-var change referencing it.
 * 2. `stackd.existingCredentialSecret` without BOTH `existingCredentialTokenId` and
 *    `existingCredentialSha256` must FAIL the render loudly (BLOCKING 2a) — a silent fall-through
 *    to a self-generated credential the controller was never given would be worse than an error.
 * 3. `stackd.enabled=true` with a digest-pinned `image.tag` and no `stackd.image.tag` must FAIL
 *    the render loudly (BLOCKING 2c) — the controller would otherwise try to pull scpd's digest
 *    under the scp-stackd repository, which does not exist there.
 */
export function verifyBlocking2Guards(ctx: StackdVerifyContext): string[] {
  const { fail, renderChart } = ctx;
  const full = "verify-homelab-commanderscp";

  // 1. Homelab-shaped baseline: no opinion on any M29.1 key at all.
  const baseline = renderChart("verify-homelab", []);
  if (baseline.some((d) => d.kind === "Secret" && d.metadata?.name === `${full}-bootstrap-admin`)) {
    fail(
      "[blocking-2] a render with NO bootstrap/stackd keys set still rendered a " +
        `'${full}-bootstrap-admin' Secret — bootstrap.generate must default to false and this ` +
        "must stay unrendered until an operator (or scp install) explicitly asks for it"
    );
  }
  const apiDeploy = baseline.find(
    (d) => d.kind === "Deployment" && d.metadata?.name === `${full}-api`
  );
  const apiEnv =
    (
      (apiDeploy?.["spec"] as Record<string, unknown> | undefined)?.["template"] as
        { spec?: { containers?: { env?: { name?: string }[] }[] } } | undefined
    )?.spec?.containers?.[0]?.env ?? [];
  if (apiEnv.some((e) => e.name === "SCP_BOOTSTRAP_ADMIN_PASSWORD")) {
    fail(
      "[blocking-2] a render with NO bootstrap/stackd keys set still added SCP_BOOTSTRAP_ADMIN_PASSWORD " +
        "to the api Deployment — this must stay absent until bootstrap.generate or " +
        "bootstrap.existingAdminPasswordSecret is set"
    );
  }
  if (baseline.some((d) => String(d.metadata?.name ?? "").includes("-stackd"))) {
    fail(
      "[blocking-2] a render with NO bootstrap/stackd keys set rendered a stackd object — " +
        "stackd.enabled must default to false (ADR-0060 §3)"
    );
  }

  // 2. existingCredentialSecret without the id/sha256 pair must fail loudly (BLOCKING 2a).
  try {
    renderChart("verify-homelab-2a", [
      "--set",
      "stackd.enabled=true",
      "--set",
      "stackd.existingCredentialSecret=my-stackd-credential"
      // Deliberately NOT setting existingCredentialTokenId/existingCredentialSha256.
    ]);
    fail(
      "[blocking-2a] stackd.existingCredentialSecret set WITHOUT existingCredentialTokenId/" +
        "existingCredentialSha256 rendered successfully — it must fail the render instead"
    );
  } catch (err) {
    const msg = String(err);
    if (!msg.includes("existingCredentialTokenId") && !msg.includes("existingCredentialSha256")) {
      fail(
        `[blocking-2a] the render DID fail as expected, but not with the expected reason: ${msg.slice(0, 300)}`
      );
    }
  }

  // 3. stackd.enabled with a digest-pinned image.tag and no stackd.image.tag must fail (BLOCKING 2c).
  try {
    renderChart("verify-homelab-2c", [
      "--set",
      "stackd.enabled=true",
      "--set",
      "image.tag=v1.2.3@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      // Deliberately NOT setting stackd.image.tag.
    ]);
    fail(
      "[blocking-2c] stackd.enabled with a digest-pinned image.tag and no stackd.image.tag " +
        "rendered successfully — it must fail the render instead (the controller would otherwise " +
        "try to pull scpd's digest under the scp-stackd repository)"
    );
  } catch (err) {
    const msg = String(err);
    if (!msg.includes("stackd.image.tag")) {
      fail(
        `[blocking-2c] the render DID fail as expected, but not with the expected reason: ${msg.slice(0, 300)}`
      );
    }
  }

  return [
    "  #422 BLOCKING 2 guards: a homelab-shaped render (no bootstrap/stackd keys) is byte-for-byte " +
      "unchanged (no bootstrap-admin Secret, no api env change, no stackd object); an incomplete " +
      "existingCredentialSecret configuration fails the render; a digest-pinned image.tag with " +
      "stackd.enabled and no stackd.image.tag fails the render"
  ];
}
