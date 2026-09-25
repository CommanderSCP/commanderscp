#!/usr/bin/env node
/** The helm template assertions gate. See docs/helm-verify.md §1. */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseAllDocuments } from "yaml";
import { jobManifest, kubernetesRbacKey, kubernetesRunnerRbac } from "@scp/runner-launcher";
import { opsTemplateShapeProblems } from "@scp/plugin-argo-workflows";
import type { KubernetesRbacRule, RunnerSpec } from "@scp/runner-launcher";
import {
  verifyBlocking2Guards,
  verifyExistingSecretOverrides,
  verifyStackController
} from "./stackd.js";
import { backendEndpoint, egressPolicy, loadRelease, type KubeObject } from "@scp/stackd";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHART_DIR = path.resolve(__dirname, "../../../deploy/helm");
const BUNDLED_CHART_DIR = path.resolve(__dirname, "../../../deploy/helm-bundled");

function helmAvailable(): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", ["helm"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

interface K8sDoc {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    annotations?: Record<string, string>;
    labels?: Record<string, string>;
  };
  spec?: Record<string, unknown>;
  data?: Record<string, string>;
  [key: string]: unknown;
}

const failures: string[] = [];

function fail(msg: string): void {
  failures.push(msg);
}

// M15.4 — federation-role bundled-backend guardrail. See docs/helm-verify.md §2.
const BACKEND_NAMESPACES: Record<string, string> = {
  argocd: "scp-argocd",
  argoWorkflows: "scp-argo-workflows",
  argoEvents: "scp-argo-events",
  gitea: "scp-gitea"
};

// Allowed bundled backends per federation role. DOC SOURCE. See docs/helm-verify.md §3.
const ALLOWED_BUNDLED_BACKENDS_BY_ROLE: Record<string, ReadonlySet<string>> = {
  commander: new Set(["argocd", "argoWorkflows", "argoEvents", "gitea"]),
  outpost: new Set(["argocd", "gitea"]),
  retrans: new Set<string>() // a CDS-boundary relay is not an execution site — bundle nothing
};

/** The federation role stamped onto every bundled-backend Namespace by
 *  `commanderscp.federationRole` (templates/_helpers.tpl). Read straight from the render so the lint
 *  checks the OPERATOR's declared role, not an assumption. Defaults to `commander` (the chart
 *  default) if no labelled Namespace is present. */
function renderedFederationRole(docs: K8sDoc[]): string {
  const ns = docs.find(
    (d) => d.kind === "Namespace" && d.metadata?.labels?.["commanderscp.io/federation-role"]
  );
  return ns?.metadata?.labels?.["commanderscp.io/federation-role"] ?? "commander";
}

/** The runner role, diffed against what the adapter issues. See docs/helm-verify.md §4. */
function rbacDiff(
  rendered: unknown,
  expected: readonly KubernetesRbacRule[],
  /** Who the grant is FOR. Defaults to the adapter, which is the caller for the runner Role; the
   *  chart-wide gate passes the identity's own description so a message about an install-time hook
   *  does not claim the Kubernetes adapter issues its calls. */
  caller = "the adapter"
): string[] {
  type Rule = { apiGroups?: string[]; resources?: string[]; verbs?: string[] };
  const rules = (rendered ?? []) as Rule[];
  const problems: string[] = [];

  const seen = new Map<string, string[]>();
  for (const rule of rules) {
    const groups = rule.apiGroups ?? [];
    const resources = rule.resources ?? [];
    if (groups.length !== 1) {
      problems.push(
        `a rule names ${groups.length} apiGroups (${JSON.stringify(groups)}); one rule, one group`
      );
      continue;
    }
    if (resources.length !== 1) {
      problems.push(
        `a rule names ${resources.length} resources (${JSON.stringify(resources)}) and therefore grants EACH of them ${JSON.stringify(rule.verbs)} — split it, one rule per resource`
      );
      continue;
    }
    const key = kubernetesRbacKey({ apiGroup: groups[0]!, resource: resources[0]! });
    if (seen.has(key)) {
      problems.push(
        `${key} appears in more than one rule, so its effective grant is the union — merge them`
      );
      continue;
    }
    seen.set(key, [...(rule.verbs ?? [])].sort());
  }

  const want = new Map(expected.map((r) => [kubernetesRbacKey(r), [...r.verbs].sort()]));
  for (const [key, verbs] of want) {
    const got = seen.get(key);
    if (got === undefined) {
      problems.push(
        `${key} is NOT granted at all; ${caller} issues ${JSON.stringify(verbs)} against it`
      );
      continue;
    }
    const missing = verbs.filter((v) => !got.includes(v));
    const extra = got.filter((v) => !verbs.includes(v));
    if (missing.length > 0) {
      problems.push(
        `${key} is missing ${JSON.stringify(missing)} — every call using it is a 403 inside a run`
      );
    }
    if (extra.length > 0) {
      problems.push(
        `${key} grants ${JSON.stringify(extra)}, which ${caller} never issues — a standing privilege for a caller that never calls`
      );
    }
  }
  for (const key of seen.keys()) {
    if (!want.has(key)) {
      problems.push(
        `${key} is granted and ${caller} touches it NOT AT ALL (verbs ${JSON.stringify(seen.get(key))})`
      );
    }
  }
  return problems;
}

// M23.6 CLAUSE 5, WIDENED FROM ONE RULE TO THE WHOLE CHART — WHAT `helm install` ACTUALLY GRANTS
/** That diff is real and fires both ways, but covers one. See docs/helm-verify.md §5. */
const RBAC_WILDCARD = "*";
const RBAC_ESCALATION_VERBS = ["escalate", "bind", "impersonate"];
/** Cluster-scoped resources a namespaced Role cannot meaningfully grant — named so that a rule
 *  mentioning one is reported as the mistake it is rather than as a silently inert line. */
const CLUSTER_SCOPED_RESOURCES = [
  "nodes",
  "namespaces",
  "persistentvolumes",
  "clusterroles",
  "clusterrolebindings",
  "customresourcedefinitions",
  "storageclasses",
  "priorityclasses",
  "apiservices",
  "validatingwebhookconfigurations",
  "mutatingwebhookconfigurations"
];

interface RenderedRule {
  apiGroups?: string[];
  resources?: string[];
  verbs?: string[];
}

/** The identity the api and worker pods run as. See docs/helm-verify.md §6. */
function workloadServiceAccountNames(docs: K8sDoc[]): string[] {
  const names = new Set<string>();
  for (const doc of docs) {
    if (doc.kind !== "Deployment") continue;
    for (const podSpec of podSpecsOf(doc)) {
      const name = podSpec["serviceAccountName"];
      if (typeof name === "string" && name.length > 0) names.add(name);
    }
  }
  return [...names].sort();
}

/** Every identity ANY pod in this render runs as, hooks included — so a new workload running as a
 *  name nothing pinned is a failure rather than an identity this gate simply never looked at. */
function allPodServiceAccountNames(docs: K8sDoc[]): string[] {
  const names = new Set<string>();
  for (const doc of docs) {
    for (const podSpec of podSpecsOf(doc)) {
      const name = podSpec["serviceAccountName"];
      if (typeof name === "string" && name.length > 0) names.add(name);
    }
  }
  return [...names].sort();
}

function chartGrantProblems(args: {
  label: string;
  docs: K8sDoc[];
  /** True when a managed run can actually launch here, i.e. the runner Role must render. */
  expectRunnerGrant: boolean;
  perRunSecrets: boolean;
}): string[] {
  const { label, docs, expectRunnerGrant, perRunSecrets } = args;
  const problems: string[] = [];
  const say = (msg: string) => problems.push(`[${label}] ${msg}`);

  for (const doc of docs) {
    if (doc.kind === "ClusterRole" || doc.kind === "ClusterRoleBinding") {
      say(
        `the chart rendered a ${doc.kind} ('${String(doc.metadata?.name)}'). Every grant this chart makes is namespaced; a cluster-scoped one is how a runner identity comes to hold verbs on nodes, namespaces or other releases' objects`
      );
    }
  }

  // (2)(3) WILDCARDS AND ESCALATION VERBS, over every rule of every role-ish object.
  const roles = new Map<string, { kind: string; rules: RenderedRule[] }>();
  for (const doc of docs) {
    if (doc.kind !== "Role" && doc.kind !== "ClusterRole") continue;
    const name = String(doc.metadata?.name ?? "");
    const namespace = String(doc.metadata?.namespace ?? "");
    const rules = (doc["rules"] ?? []) as RenderedRule[];
    roles.set(`${namespace}/${name}`, { kind: doc.kind, rules });
    for (const rule of rules) {
      for (const field of ["apiGroups", "resources", "verbs"] as const) {
        if ((rule[field] ?? []).includes(RBAC_WILDCARD)) {
          say(
            `${doc.kind} '${name}' has a rule with ${field}: ['*'] — a wildcard grants every resource that exists now AND every one added later, and satisfies any assertion written as a membership test`
          );
        }
      }
      for (const verb of rule.verbs ?? []) {
        if (RBAC_ESCALATION_VERBS.includes(verb)) {
          say(
            `${doc.kind} '${name}' grants '${verb}', which lets the holder widen its OWN grant without this chart changing`
          );
        }
      }
      for (const resource of rule.resources ?? []) {
        if (CLUSTER_SCOPED_RESOURCES.includes(resource)) {
          say(
            `${doc.kind} '${name}' names the cluster-scoped resource '${resource}'; nothing this chart grants is cluster-scoped`
          );
        }
      }
    }
  }

  // (4) EVERY BINDING RESOLVES, EVERY ROLE IS BOUND, AND THE UNION PER IDENTITY.
  const effective = new Map<string, RenderedRule[]>();
  const subjectNamespaces = new Set<string>();
  const boundRoles = new Set<string>();
  for (const doc of docs) {
    if (doc.kind !== "RoleBinding") continue;
    const bindingName = String(doc.metadata?.name ?? "");
    const namespace = String(doc.metadata?.namespace ?? "");
    const roleRef = (doc["roleRef"] ?? {}) as { kind?: string; name?: string };
    const key = `${namespace}/${String(roleRef.name)}`;
    const rules = roles.get(key)?.rules;
    if (roleRef.kind !== "Role" || rules === undefined) {
      say(
        `RoleBinding '${bindingName}' in namespace '${namespace}' references ${String(roleRef.kind)} '${String(roleRef.name)}', which this render does not contain — the grant either does nothing or silently picks up a same-named object already in the cluster`
      );
      continue;
    }
    boundRoles.add(key);
    for (const subject of (doc["subjects"] ?? []) as {
      kind?: string;
      name?: string;
      namespace?: string;
    }[]) {
      if (subject.kind !== "ServiceAccount") {
        say(
          `RoleBinding '${bindingName}' names a ${String(subject.kind)} subject ('${String(subject.name)}'); this chart grants to ServiceAccounts and nothing else`
        );
        continue;
      }
      subjectNamespaces.add(String(subject.namespace ?? ""));
      const identity = String(subject.name);
      effective.set(identity, [...(effective.get(identity) ?? []), ...rules]);
    }
  }
  for (const [key, role] of roles) {
    if (!boundRoles.has(key)) {
      say(
        `${role.kind} '${key}' is rendered with no RoleBinding, so it authorises nobody — the shape ADR-0035 §6a records as the starting failure, here as a property of every Role rather than of the one that was checked`
      );
    }
  }
  // EVERY IDENTITY LIVES WHERE THE WORKLOAD LIVES. A subject in a second namespace would mean this
  // release grants to an identity outside itself, which no assertion below would otherwise notice.
  if (subjectNamespaces.size > 1) {
    say(
      `RoleBinding subjects span ${subjectNamespaces.size} namespaces (${[...subjectNamespaces].join(", ")}); every identity this chart grants to is a ServiceAccount in the RELEASE namespace`
    );
  }

  // (5) EACH IDENTITY'S TOTAL GRANT, AGAINST WHAT IT IS SUPPOSED TO HOLD.
  const workload = workloadServiceAccountNames(docs);
  if (workload.length !== 1) {
    say(
      `the pods in this render name ${workload.length} distinct serviceAccountNames (${JSON.stringify(workload)}); the adapter's calls authenticate as ONE identity and this gate cannot say which`
    );
    return problems;
  }
  const workloadName = workload[0]!;
  const expected = new Map<string, KubernetesRbacRule[]>();
  expected.set(workloadName, expectRunnerGrant ? [...kubernetesRunnerRbac({ perRunSecrets })] : []);
  // M29.2: the two install-time auto-wire hook identities are GONE (the stack controller wires the
  // bundled backends, and its own grants are gated by ./stackd.ts), so the workload ServiceAccount
  // is the ONE identity this render may grant to.
  for (const identity of effective.keys()) {
    if (!expected.has(identity)) {
      say(
        `'${identity}' is granted rules by this chart and is not the one identity it is supposed to have (the workload ServiceAccount)`
      );
    }
  }
  // AND THE OTHER DIRECTION: a pod running as an identity nothing above pins. A new hook Job with its
  // own ServiceAccount would otherwise be invisible here until the day someone gave it a Role.
  for (const identity of allPodServiceAccountNames(docs)) {
    if (identity !== workloadName && !expected.has(identity)) {
      say(
        `a pod in this render runs as '${identity}', which is not the workload ServiceAccount — a new identity inside the release that no grant assertion covers`
      );
    }
  }
  for (const [identity, want] of expected) {
    const got = effective.get(identity) ?? [];
    if (want.length === 0) {
      if (got.length > 0) {
        say(
          `'${identity}' holds ${JSON.stringify(got)} on a render where no managed run can launch — a standing privilege for a caller that never calls`
        );
      }
      continue;
    }
    const caller =
      identity === workloadName ? "the Kubernetes adapter" : `the '${identity}' install-time hook`;
    for (const problem of rbacDiff(got, want, caller)) {
      say(`the TOTAL grant held by '${identity}' is not what it is supposed to be: ${problem}`);
    }
  }
  return problems;
}

/** Pure detector: given a role and a rendered bundled chart, return the list of guardrail
 *  violations (a bundled backend that rendered but is not allowed for that role). Empty ⇒ clean.
 *  This is the single decision function shared by the standing gate (feeds `fail()` → non-zero exit)
 *  and the explicit negative-case test below (asserts it fires). */
function federationRoleViolations(role: string, docs: K8sDoc[]): string[] {
  const allowed = ALLOWED_BUNDLED_BACKENDS_BY_ROLE[role];
  if (!allowed) {
    return [
      `unknown federationRole '${role}' — expected one of ${Object.keys(ALLOWED_BUNDLED_BACKENDS_BY_ROLE).join("|")}`
    ];
  }
  const allowedList = [...allowed].join(", ") || "none";
  const violations: string[] = [];
  for (const [backend, ns] of Object.entries(BACKEND_NAMESPACES)) {
    const enabled = docs.some(
      (d) => d.metadata?.namespace === ns || (d.kind === "Namespace" && d.metadata?.name === ns)
    );
    if (enabled && !allowed.has(backend)) {
      violations.push(
        `federationRole '${role}' may NOT enable bundled backend '${backend}' (renders into namespace ${ns}); ` +
          `backends allowed for role '${role}': [${allowedList}]. ` +
          `Disable bundledExecutor.${backend}.enabled or correct federationRole.`
      );
    }
  }
  return violations;
}

// M23.6 CLAUSE 6 — THE SOCKET INVARIANT, ENFORCED BY RENDERING EVERY COMBINATION
/** The invariant this milestone must not break, in its words. See docs/helm-verify.md §7. */

/** Every spelling of a container runtime's control socket that would grant escape if mounted. */
const RUNTIME_SOCKET_PATTERNS = [
  "docker.sock",
  "/var/run/docker",
  "containerd.sock",
  "crio.sock",
  "podman.sock",
  "buildkitd.sock"
];

/** A pod spec, wherever it sits in a workload doc. */
function podSpecsOf(doc: K8sDoc): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const spec = doc.spec as Record<string, unknown> | undefined;
  if (!spec) return out;
  if (doc.kind === "Pod") out.push(spec);
  const template = spec["template"] as { spec?: Record<string, unknown> } | undefined;
  if (template?.spec) out.push(template.spec);
  const jobTemplate = spec["jobTemplate"] as
    { spec?: { template?: { spec?: Record<string, unknown> } } } | undefined;
  if (jobTemplate?.spec?.template?.spec) out.push(jobTemplate.spec.template.spec);
  return out;
}

/** Every reason a rendered manifest violates the invariant. See docs/helm-verify.md §8. */
function socketInvariantProblems(label: string, raw: string, docs: K8sDoc[]): string[] {
  const problems: string[] = [];

  for (const pattern of RUNTIME_SOCKET_PATTERNS) {
    if (raw.includes(pattern)) {
      problems.push(
        `[${label}] the render contains '${pattern}' — a container runtime socket in a manifest this chart would apply`
      );
    }
  }

  for (const doc of docs) {
    for (const podSpec of podSpecsOf(doc)) {
      const name = `${doc.kind}/${String(doc.metadata?.name ?? "?")}`;
      for (const volume of (podSpec["volumes"] as Record<string, unknown>[] | undefined) ?? []) {
        if (volume["hostPath"] !== undefined) {
          problems.push(
            `[${label}] ${name} mounts a hostPath volume ${JSON.stringify(volume["hostPath"])} — this chart declares none, and a hostPath is one path edit away from being a socket`
          );
        }
      }
      const containers = [
        ...((podSpec["containers"] as Record<string, unknown>[] | undefined) ?? []),
        ...((podSpec["initContainers"] as Record<string, unknown>[] | undefined) ?? [])
      ];
      for (const container of containers) {
        for (const mount of (container["volumeMounts"] as { mountPath?: string }[] | undefined) ??
          []) {
          const at = mount.mountPath ?? "";
          if (RUNTIME_SOCKET_PATTERNS.some((p) => at.includes(p))) {
            problems.push(`[${label}] ${name} mounts a runtime socket at ${at}`);
          }
        }
      }
    }
  }
  return problems;
}

/** The worker Deployment's env, flattened — how the chart tells the server what to launch on. */
function workerEnvMap(docs: K8sDoc[]): Record<string, string> {
  const worker = docs.find(
    (d) => d.kind === "Deployment" && String(d.metadata?.name ?? "").endsWith("-worker")
  );
  const containers = ((
    worker?.spec as { template?: { spec?: { containers?: { env?: EnvVar[] }[] } } } | undefined
  )?.template?.spec?.containers ?? []) as { env?: EnvVar[] }[];
  const out: Record<string, string> = {};
  for (const c of containers) {
    for (const e of c.env ?? []) {
      if (typeof e.value === "string") out[e.name] = e.value;
    }
  }
  return out;
}

/** The runner Job THIS RENDER WOULD PRODUCE. See docs/helm-verify.md §9. */
function runnerJobFromRender(docs: K8sDoc[]): K8sDoc | null {
  const env = workerEnvMap(docs);
  if (env["SCP_MANAGED_RUNNER_LAUNCHER"] !== "kubernetes") return null;
  const namespace = env["SCP_MANAGED_RUNNER_K8S_NAMESPACE"]?.trim();
  const workspaceRoot = env["SCP_MANAGED_RUNNER_K8S_WORKSPACE_ROOT"]?.trim();
  const claimName = env["SCP_MANAGED_RUNNER_K8S_WORKSPACE_CLAIM"]?.trim();
  const hostPath = env["SCP_MANAGED_RUNNER_K8S_WORKSPACE_HOST_PATH"]?.trim();
  if (!namespace || !workspaceRoot) return null;
  const workspaceVolume = claimName
    ? ({ kind: "persistentVolumeClaim", claimName } as const)
    : hostPath
      ? ({ kind: "hostPath", path: hostPath } as const)
      : undefined;
  if (!workspaceVolume) return null;
  const spec: RunnerSpec = {
    runId: "socket-matrix",
    labels: {},
    image: "ghcr.io/commanderscp/scp-runner-iac:0.1.0",
    operands: ["apply"],
    networkMode: "none",
    env: [],
    secretEnv: [],
    copyIn: [],
    copyOut: undefined,
    timeoutMs: 600_000,
    maxBuffer: 32 * 1024 * 1024
  };
  return jobManifest(spec, {
    namespace,
    jobName: "scp-runner-iac-socket-matrix",
    secretName: "scp-runner-iac-socket-matrix-env",
    reapDeadline: new Date(0).toISOString(),
    slots: new Map([[`${workspaceRoot}/in`, "in"]]),
    workspaceVolume,
    runAsNonRoot: env["SCP_MANAGED_RUNNER_K8S_RUN_AS_NON_ROOT"] === "true",
    ttlSecondsAfterFinished: 3_600
  }) as K8sDoc;
}

interface MatrixPoint {
  label: string;
  args: string[];
  /** True when the chart's own render-time guards are expected to REFUSE this combination. */
  refuses: boolean;
  /** M23.6 CLAUSE 5, WIDENED. See docs/helm-verify.md §10. */
  expectRunnerGrant: boolean;
  perRunSecrets: boolean;
}

/** The exhaustive product. See docs/helm-verify.md §11. */
function socketMatrix(): MatrixPoint[] {
  const points: MatrixPoint[] = [];
  const IAC_IMAGE = "ghcr.io/commanderscp/scp-runner-iac:0.1.0";
  const bool = [false, true];

  /** The two environments are not symmetric, and that shapes it. See docs/helm-verify.md §12. */
  const environments: { name: string; extra: string[]; fullProduct: boolean }[] = [
    { name: "defaults", extra: [], fullProduct: true },
    {
      fullProduct: false,
      name: "everything-on",
      extra: [
        "--set",
        "api.role=all",
        "--set",
        "ingress.enabled=true",
        "--set",
        "ingress.host=scp.example.com",
        "--set",
        "eventBus.driver=nats",
        "--set",
        "nats.enabled=true",
        "--set",
        "serviceMonitor.enabled=true",
        "--set",
        "worker.autoscaling.enabled=true",
        "--set",
        "imagePullSecrets[0].name=ghcr-creds",
        "--set",
        "image.pullPolicy=Always",
        "--set",
        "managedRunners.kubernetes.resources.limits.memory=512Mi",
        "--set",
        "managedRunners.kubernetes.imagePullSecrets[0].name=runner-creds",
        "--set",
        "managedRunners.kubernetes.imagePullPolicy=IfNotPresent"
      ]
    }
  ];

  for (const env of environments) {
    for (const iac of bool) {
      for (const dep of bool) {
        for (const scan of bool) {
          const classArgs = [
            "--set",
            `managedIac.enabled=${iac}`,
            ...(iac ? ["--set", `managedIac.runnerImage=${IAC_IMAGE}`] : []),
            ...(dep
              ? ["--set", "managedDep.runnerImage=ghcr.io/commanderscp/scp-runner-dep:0.1.0"]
              : []),
            ...(scan
              ? ["--set", "managedScan.runnerImage=ghcr.io/commanderscp/scp-runner-scan:0.1.0"]
              : [])
          ];
          const classes = `iac=${iac},dep=${dep},scan=${scan}`;

          // THE DOCKER LAUNCHER. Every Kubernetes value below renders nothing here, so the product
          // collapses to one point per class combination — asserted, not assumed, by the fact that
          // this file's (3d) case already proves a docker deployment renders no runner surface.
          points.push({
            label: `${env.name} docker ${classes}`,
            args: [...env.extra, ...classArgs],
            refuses: false,
            // NO RUNNER GRANT ON A DOCKER DEPLOYMENT, EVER — the narrowing `runner-iac.yaml`'s point 3
            // declares. The pods mount no token here, so a Role would be a standing grant for a
            // caller that cannot call.
            expectRunnerGrant: false,
            perRunSecrets: false
          });

          // THE KUBERNETES LAUNCHER. Refuses outright when no class is enabled ("nothing will ever
          // launch"), so that arm is a refusal point rather than a render.
          const namespaces = env.fullProduct ? ["", "scp-runners"] : ["scp-runners"];
          const secretsAxis = env.fullProduct ? bool : [true];
          const acceptAxis = env.fullProduct ? bool : [false];
          const nonRootAxis = env.fullProduct ? bool : [false];
          for (const namespace of namespaces) {
            for (const perRunSecrets of secretsAxis) {
              for (const accept of acceptAxis) {
                for (const runAsNonRoot of nonRootAxis) {
                  const k8sArgs = [
                    "--set",
                    "managedRunners.launcher=kubernetes",
                    "--set",
                    "managedRunners.kubernetes.workspace.claimName=scp-runner-rwx",
                    "--set",
                    `managedRunners.kubernetes.namespace=${namespace}`,
                    "--set",
                    `managedRunners.kubernetes.perRunSecrets=${perRunSecrets}`,
                    "--set",
                    `managedRunners.kubernetes.acceptSharedNamespaceSecretDelete=${accept}`,
                    "--set",
                    `managedRunners.kubernetes.runAsNonRoot=${runAsNonRoot}`
                  ];
                  const noClass = !iac && !dep && !scan;
                  const sharedSecretRefusal = namespace === "" && perRunSecrets && !accept;
                  points.push({
                    label: `${env.name} kubernetes ${classes} ns='${namespace}' secrets=${perRunSecrets} accept=${accept} nonroot=${runAsNonRoot}`,
                    args: [...env.extra, ...classArgs, ...k8sArgs],
                    refuses: noClass || sharedSecretRefusal,
                    expectRunnerGrant: !noClass,
                    perRunSecrets
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  // `api.role` decides which pods exist at all, so it gets its own sweep on both launchers rather
  // than riding only in `everything-on`. Its legal values are `api|all` and the chart refuses
  // anything else at render time (`deployment-api.yaml`), which is why `worker` is not swept here:
  // there is no such deployment shape to check.
  for (const role of ["api", "all"]) {
    points.push({
      label: `api.role=${role} docker iac=true`,
      args: [
        "--set",
        `api.role=${role}`,
        "--set",
        "managedIac.enabled=true",
        "--set",
        `managedIac.runnerImage=${IAC_IMAGE}`
      ],
      refuses: false,
      expectRunnerGrant: false,
      perRunSecrets: false
    });
    points.push({
      label: `api.role=${role} kubernetes iac=true`,
      args: [
        "--set",
        `api.role=${role}`,
        "--set",
        "managedIac.enabled=true",
        "--set",
        `managedIac.runnerImage=${IAC_IMAGE}`,
        "--set",
        "managedRunners.launcher=kubernetes",
        "--set",
        "managedRunners.kubernetes.workspace.claimName=scp-runner-rwx",
        "--set",
        "managedRunners.kubernetes.namespace=scp-runners"
      ],
      refuses: false,
      expectRunnerGrant: true,
      // `perRunSecrets` is left at the chart's own default here, which is `true` (values.yaml,
      // the owner's 2026-08-20 grant). Stated as a literal rather than read back from the render.
      perRunSecrets: true
    });
  }

  /** THE BUNDLED BACKENDS' OWN IDENTITIES. See docs/helm-verify.md §13. */
  for (const backends of [["argocd"], ["gitea"], ["argocd", "gitea"]]) {
    const enable = backends.flatMap((be) => ["--set", `bundledExecutor.${be}.enabled=true`]);
    points.push({
      label: `bundled ${backends.join("+")} docker`,
      args: enable,
      refuses: false,
      expectRunnerGrant: false,
      perRunSecrets: false
    });
    points.push({
      label: `bundled ${backends.join("+")} kubernetes iac=true`,
      args: [
        ...enable,
        "--set",
        "managedIac.enabled=true",
        "--set",
        `managedIac.runnerImage=${IAC_IMAGE}`,
        "--set",
        "managedRunners.launcher=kubernetes",
        "--set",
        "managedRunners.kubernetes.workspace.claimName=scp-runner-rwx",
        "--set",
        "managedRunners.kubernetes.namespace=scp-runners"
      ],
      refuses: false,
      expectRunnerGrant: true,
      perRunSecrets: true
    });
  }
  return points;
}

const RPM_BUILDER_VERIFY_IMAGE = "ghcr.io/commanderscp/scp-builder-rpm:verify";
/** The digest and SCP API URL the all-backends render pins scp-ops-v1 to — what the plugin's
 *  read-back check is then asked to accept (M28.2, ADR-0054 D9(d)). */
const OPS_VERIFY_DIGEST = `sha256:${"d".repeat(64)}`;
const OPS_VERIFY_API_URL = "https://commanderscp-api.verify-scp-ns.svc:8443";

/** THE SHIPPED RPM BUILD (M28.1, ADR-0053) — rendered and held to what was MEASURED.
 *
 *  `scp-build-image-v1`'s build container is the one deliberately-weakened workload in this chart,
 *  and the generic WorkflowTemplate guard above is written around that: it forbids privileged, uid
 *  0 and any capability beyond SETUID/SETGID. That guard is TOO LOOSE for the RPM build, which was
 *  measured to need NO relaxation at all — so the image template's four would pass it unnoticed.
 *  This asserts the RPM build container is fully hardened, that its positional arguments are the
 *  script's contract, that its source checkout is byte-identical to the image template's (the
 *  fetch-by-commit property must not drift between two copies), and that it is absent until its
 *  image is named rather than rendered with an empty image. */
function verifyRpmCatalogTemplate(): void {
  const label = "M28.1 scp-build-rpm-v1";
  console.log(`\nhelm-verify: ${label} — rendering the RPM catalog template and its hardening...`);
  const base = [
    "--set",
    "bundledExecutor.argoWorkflows.enabled=true",
    "--set",
    "bundledExecutor.scpNamespace=verify-scp-ns"
  ];
  const templatesOf = (docs: K8sDoc[]) =>
    new Map(
      docs
        .filter((d) => d.kind === "WorkflowTemplate")
        .map((d) => [String(d.metadata?.name), d] as const)
    );

  const off = templatesOf(renderBundledChart(base));
  assert(
    off.has("scp-build-image-v1") && !off.has("scp-build-rpm-v1"),
    `[${label}] with no builderImage the chart must render scp-build-image-v1 and NOT scp-build-rpm-v1 (rendered: ${[...off.keys()].join(", ")}). An RPM template with an empty image would fail only at its last step`
  );

  const on = templatesOf(
    renderBundledChart([
      ...base,
      "--set",
      `bundledExecutor.argoWorkflows.catalog.buildRpm.builderImage=${RPM_BUILDER_VERIFY_IMAGE}`
    ])
  );
  const rpm = on.get("scp-build-rpm-v1");
  const image = on.get("scp-build-image-v1");
  assert(rpm, `[${label}] builderImage is set but scp-build-rpm-v1 did not render`);
  if (!rpm || !image) return;

  type WfTemplate = {
    name?: string;
    container?: Container & { command?: string[]; args?: string[] };
    initContainers?: (Container & { args?: string[] })[];
  };
  const spec = rpm.spec as {
    serviceAccountName?: string;
    arguments?: { parameters?: { name: string; value?: string }[] };
    templates?: WfTemplate[];
  };
  const imageSpec = image.spec as { serviceAccountName?: string; templates?: WfTemplate[] };
  const tpl = spec.templates?.[0];
  const build = tpl?.container;
  assert(
    build?.image === RPM_BUILDER_VERIFY_IMAGE,
    `[${label}] build container image is '${build?.image}', not the configured builderImage`
  );
  assert(
    spec.serviceAccountName === imageSpec.serviceAccountName,
    `[${label}] runs as '${spec.serviceAccountName}', not the catalog build identity '${imageSpec.serviceAccountName}' whose Role is the workflowtaskresults floor`
  );

  // FULLY HARDENED — every field, because each was measured to be unnecessary to relax.
  const sc = (build?.securityContext ?? {}) as {
    runAsUser?: number;
    runAsNonRoot?: boolean;
    readOnlyRootFilesystem?: boolean;
    allowPrivilegeEscalation?: boolean;
    privileged?: boolean;
    seccompProfile?: { type?: string };
    appArmorProfile?: { type?: string };
    capabilities?: { drop?: string[]; add?: string[] };
  };
  const hardening: [boolean, string][] = [
    [sc.runAsNonRoot === true && sc.runAsUser === 1000, "runAsNonRoot as uid 1000"],
    [sc.readOnlyRootFilesystem === true, "readOnlyRootFilesystem: true"],
    [sc.allowPrivilegeEscalation === false, "allowPrivilegeEscalation: false"],
    [sc.privileged !== true, "not privileged"],
    [sc.seccompProfile?.type === "RuntimeDefault", "seccompProfile RuntimeDefault"],
    [sc.appArmorProfile?.type !== "Unconfined", "no Unconfined AppArmor profile"],
    [(sc.capabilities?.drop ?? []).includes("ALL"), "capabilities drop ALL"],
    [(sc.capabilities?.add ?? []).length === 0, "no added capabilities"]
  ];
  for (const [ok, what] of hardening) {
    assert(
      ok,
      `[${label}] build container is not '${what}'. rpmbuild was measured to need NO relaxation (template header), so this is a regression, not a tuning`
    );
  }

  // THE SCRIPT'S POSITIONAL CONTRACT (apps/builder-rpm/build-rpm.sh: <spec> <upload-url> <commit>).
  // A reorder here would publish to a spec path, or build from a URL — and pass every other check.
  const expectedArgs = [
    "{{inputs.parameters.rpmSpec}}",
    "{{inputs.parameters.rpmUploadUrl}}",
    "{{inputs.parameters.sourceCommit}}"
  ];
  assert(
    JSON.stringify(build?.args) === JSON.stringify(expectedArgs) &&
      JSON.stringify(build?.command) === JSON.stringify(["/usr/local/bin/scp-build-rpm"]),
    `[${label}] build container runs ${JSON.stringify(build?.command)} ${JSON.stringify(build?.args)}, not scp-build-rpm ${JSON.stringify(expectedArgs)}`
  );

  // The four REQUIRED parameters carry no default — Argo refuses to submit without them.
  const params = new Map((spec.arguments?.parameters ?? []).map((p) => [p.name, p] as const));
  for (const required of ["sourceRepo", "sourceCommit", "rpmSpec", "rpmUploadUrl"]) {
    assert(
      params.has(required) && params.get(required)?.value === undefined,
      `[${label}] '${required}' must be declared with NO default, so a trigger missing it is refused at submit rather than built or published somewhere guessed`
    );
  }

  // The checkout is the image template's, byte for byte.
  const fetchOf = (t?: WfTemplate) => t?.initContainers?.find((c) => c.name === "fetch-source");
  const rpmFetch = fetchOf(tpl);
  const imageFetch = fetchOf(imageSpec.templates?.[0]);
  assert(
    rpmFetch !== undefined && JSON.stringify(rpmFetch) === JSON.stringify(imageFetch),
    `[${label}] fetch-source differs from scp-build-image-v1's. The checkout-by-commit is the property that ties a published artifact to a revision; the two copies must stay identical`
  );

  // M29.5 (ADR-0062): THE PUSH CREDENTIAL IS BOUND TO ONE HOST in both build templates — the
  // destination is SCP-assembled from an org's registry object, so an unbound token goes wherever
  // that object points. Each container mounts `registryHost`, and the image script refuses a
  // mismatched host BEFORE the credential is written into its docker config.
  type EnvRef = { name: string; valueFrom?: { secretKeyRef?: { name?: string; key?: string } } };
  const imageBuild = imageSpec.templates?.[0]?.container as
    { env?: EnvRef[]; args?: string[] } | undefined;
  for (const [which, c] of [
    ["scp-build-image-v1", imageBuild],
    [label, build as { env?: EnvRef[] } | undefined]
  ] as const) {
    const ref = c?.env?.find((e) => e.name === "REGISTRY_HOST")?.valueFrom?.secretKeyRef;
    assert(
      ref?.name === "scp-build-registry" && ref.key === "registryHost",
      `[${which}] does not mount REGISTRY_HOST from scp-build-registry/registryHost — its push credential is not bound to a host`
    );
  }
  const script = imageBuild?.args?.[0] ?? "";
  const refusal = script.indexOf('[ "$host" != "$REGISTRY_HOST" ]');
  const written = script.indexOf("config.json");
  assert(
    refusal > 0 && written > refusal,
    "[scp-build-image-v1] the REGISTRY_HOST refusal must come before the push credential is written to $DOCKER_CONFIG"
  );
  console.log(
    "  both build templates bind the push credential to registryHost; the image script refuses a mismatched host before writing the credential"
  );
  console.log(
    "  absent until builderImage is set; fully hardened (no relaxation); positional args match build-rpm.sh; required params carry no default; fetch-source identical to scp-build-image-v1"
  );
}

const INFRA_VERIFY_IMAGE = "ghcr.io/commanderscp/scp-runner-iac:verify";
/** The values that render the infra templates — the operator's backend switch plus the image. */
const INFRA_VERIFY_SETS = [
  "--set",
  `bundledExecutor.argoWorkflows.catalog.infra.image=${INFRA_VERIFY_IMAGE}`,
  "--set",
  "bundledExecutor.argoWorkflows.catalog.infra.stateBackend.type=s3",
  "--set",
  "bundledExecutor.argoWorkflows.catalog.infra.stateBackend.config.bucket=verify-state",
  "--set",
  "bundledExecutor.argoWorkflows.catalog.infra.stateBackend.config.encrypt=true"
];

/** INFRASTRUCTURE BUILDOUT (M28.3, ADR-0056) — scp-infra-plan-v1 / scp-infra-apply-v1, rendered and
 *  held to their contract.
 *
 *  What `infra-lane.integration.test.ts` cannot see, because it runs the SCRIPT, not the rendered
 *  template: that the template runs that script (the ConfigMap is byte-identical to the file the
 *  test runs), with the positional arguments in the order the test passes them, as the identity the
 *  chart gives the executor floor and nothing else, fully hardened, exporting exactly the global
 *  outputs the argo-workflows plugin reads — and that the whole thing is ABSENT until the operator
 *  names a state backend, and a render that names one without an image fails rather than shipping
 *  a template with an empty image. */
function verifyInfraCatalogTemplates(): void {
  const label = "M28.3 scp-infra-plan-v1/apply-v1";
  console.log(`\nhelm-verify: ${label} — rendering the infra catalog templates...`);
  const base = [
    "--set",
    "bundledExecutor.argoWorkflows.enabled=true",
    "--set",
    "bundledExecutor.scpNamespace=verify-scp-ns"
  ];
  const templatesOf = (docs: K8sDoc[]) =>
    new Map(
      docs
        .filter((d) => d.kind === "WorkflowTemplate")
        .map((d) => [String(d.metadata?.name), d] as const)
    );

  // ABSENT until the backend is named — even with the image set (install.sh always sets it).
  const off = templatesOf(
    renderBundledChart([
      ...base,
      "--set",
      `bundledExecutor.argoWorkflows.catalog.infra.image=${INFRA_VERIFY_IMAGE}`
    ])
  );
  assert(
    !off.has("scp-infra-plan-v1") && !off.has("scp-infra-apply-v1"),
    `[${label}] with no stateBackend.type the infra templates must NOT render (rendered: ${[...off.keys()].join(", ")}) — a template with nowhere to keep state would lose it with the pod`
  );

  // FAIL-CLOSED: a backend with no image.
  let failedClosed = false;
  try {
    renderRaw(BUNDLED_CHART_DIR, "verify-infra-noimage", [
      ...base,
      "--set",
      "bundledExecutor.argoWorkflows.catalog.infra.stateBackend.type=s3"
    ]);
  } catch (err) {
    // THE RIGHT failure, not any failure: a render that died for some other reason (a typo in the
    // template, a missing value elsewhere) would otherwise read as this guard holding.
    const e = err as { message?: string; stderr?: unknown };
    failedClosed = `${e.message ?? ""}${String(e.stderr ?? "")}`.includes(
      "infra.stateBackend.type is set but infra.image is empty"
    );
  }
  assert(
    failedClosed,
    `[${label}] stateBackend.type set with an empty infra.image did not fail the render WITH ITS OWN MESSAGE — it must refuse, not ship a template with no image`
  );

  const docs = renderBundledChart([...base, ...INFRA_VERIFY_SETS]);
  const on = templatesOf(docs);
  const configMap = docs.find((d) => d.kind === "ConfigMap" && d.metadata?.name === "scp-infra-v1");
  const shipped = readFileSync(path.join(BUNDLED_CHART_DIR, "files/scp-infra.sh"), "utf8");
  assert(
    configMap?.data?.["scp-infra.sh"] === shipped,
    `[${label}] the scp-infra-v1 ConfigMap's scp-infra.sh is not byte-identical to deploy/helm-bundled/files/scp-infra.sh — the script the integration test runs must be the script that ships`
  );
  assert(
    configMap?.data?.["backend.tfbackend"] === 'bucket = "verify-state"\nencrypt = true\n',
    `[${label}] backend.tfbackend rendered ${JSON.stringify(configMap?.data?.["backend.tfbackend"])}, not the operator's stateBackend.config as HCL`
  );

  type WfTemplate = {
    name?: string;
    outputs?: {
      parameters?: { name: string; globalName?: string; valueFrom?: { path?: string } }[];
    };
    container?: Container & {
      command?: string[];
      args?: string[];
      envFrom?: { secretRef?: { name?: string; optional?: boolean } }[];
      securityContext?: Record<string, unknown>;
    };
    initContainers?: unknown[];
  };
  const buildSa = (on.get("scp-build-image-v1")?.spec as { serviceAccountName?: string })
    ?.serviceAccountName;

  for (const phase of ["plan", "apply"] as const) {
    const name = `scp-infra-${phase}-v1`;
    const wf = on.get(name);
    assert(wf, `[${label}] ${name} did not render with a state backend and an image set`);
    if (!wf) continue;
    const spec = wf.spec as {
      serviceAccountName?: string;
      arguments?: { parameters?: { name: string; value?: string }[] };
      templates?: WfTemplate[];
      synchronization?: { mutexes?: { name?: string }[] };
    };
    // ONE RUN PER STATE WORKSPACE, the same mutex name in both templates, so a plan and an apply
    // of one workspace queue rather than race.
    assert(
      JSON.stringify(spec.synchronization?.mutexes) ===
        JSON.stringify([{ name: "scp-infra-{{workflow.parameters.stateWorkspace}}" }]),
      `[${label}] ${name} synchronization is ${JSON.stringify(spec.synchronization)} — it must hold the per-workspace mutex scp-infra-{{workflow.parameters.stateWorkspace}}`
    );
    const tpl = spec.templates?.[0];
    const c = tpl?.container;
    assert(
      c?.image === INFRA_VERIFY_IMAGE,
      `[${label}] ${name} runs '${c?.image}', not infra.image`
    );
    assert(
      spec.serviceAccountName === `scp-infra-${phase}` && spec.serviceAccountName !== buildSa,
      `[${label}] ${name} runs as '${spec.serviceAccountName}' — it must be the ${phase} identity scp-infra-${phase}: never the other phase's (a plan's identity must be read-only), never the build identity a tenant's Dockerfile runs as`
    );
    assert(
      (tpl?.initContainers ?? []).length === 0,
      `[${label}] ${name} grew an init container; the checkout is the script's, by commit`
    );

    // THE POSITIONAL CONTRACT (files/scp-infra.sh's usage line, and the order the test runs it).
    const expectedArgs = [
      phase,
      "{{inputs.parameters.environment}}",
      "{{inputs.parameters.stateWorkspace}}",
      "{{inputs.parameters.sourceRepo}}",
      "{{inputs.parameters.sourceCommit}}",
      "{{inputs.parameters.infraPath}}",
      ...(phase === "apply" ? ["{{inputs.parameters.planDigest}}"] : [])
    ];
    assert(
      JSON.stringify(c?.command) === JSON.stringify(["bash", "/scp/scp-infra.sh"]) &&
        JSON.stringify(c?.args) === JSON.stringify(expectedArgs),
      `[${label}] ${name} runs ${JSON.stringify(c?.command)} ${JSON.stringify(c?.args)}, not bash /scp/scp-infra.sh ${JSON.stringify(expectedArgs)}`
    );

    // REQUIRED parameters carry no default — Argo refuses to submit without them.
    const params = new Map((spec.arguments?.parameters ?? []).map((p) => [p.name, p] as const));
    const required = ["environment", "stateWorkspace", "sourceRepo", "sourceCommit"];
    if (phase === "apply") required.push("planDigest");
    for (const r of required) {
      assert(
        params.has(r) && params.get(r)?.value === undefined,
        `[${label}] ${name}: '${r}' must be declared with NO default, so a trigger missing it is refused at submit`
      );
    }
    assert(
      phase === "apply" || !params.has("planDigest"),
      `[${label}] scp-infra-plan-v1 declares planDigest — a plan has nothing to be bound to`
    );

    // THE EVIDENCE CHANNEL — exactly the global outputs `@scp/plugin-argo-workflows` reads.
    const outputs = (tpl?.outputs?.parameters ?? []).map(
      (o) => `${o.globalName}<-${o.valueFrom?.path}`
    );
    const expectedOutputs = [
      "scpPlanDigest<-/work/out/planDigest",
      "scpPlanAdd<-/work/out/planAdd",
      "scpPlanChange<-/work/out/planChange",
      "scpPlanDestroy<-/work/out/planDestroy",
      "scpPlanApplied<-/work/out/applied"
    ];
    assert(
      JSON.stringify(outputs) === JSON.stringify(expectedOutputs),
      `[${label}] ${name} exports ${JSON.stringify(outputs)}, not the plan-evidence contract ${JSON.stringify(expectedOutputs)} (PLAN_OUTPUT_PARAMETERS in the argo-workflows plugin)`
    );

    // FULLY HARDENED — tofu, git and jq need no relaxation.
    const sc = (c?.securityContext ?? {}) as {
      runAsNonRoot?: boolean;
      runAsUser?: number;
      readOnlyRootFilesystem?: boolean;
      allowPrivilegeEscalation?: boolean;
      privileged?: boolean;
      seccompProfile?: { type?: string };
      capabilities?: { drop?: string[]; add?: string[] };
    };
    const hardening: [boolean, string][] = [
      [sc.runAsNonRoot === true && (sc.runAsUser ?? 0) > 0, "runAsNonRoot as a non-zero uid"],
      [sc.readOnlyRootFilesystem === true, "readOnlyRootFilesystem: true"],
      [sc.allowPrivilegeEscalation === false, "allowPrivilegeEscalation: false"],
      [sc.privileged !== true, "not privileged"],
      [sc.seccompProfile?.type === "RuntimeDefault", "seccompProfile RuntimeDefault"],
      [(sc.capabilities?.drop ?? []).includes("ALL"), "capabilities drop ALL"],
      [(sc.capabilities?.add ?? []).length === 0, "no added capabilities"]
    ];
    for (const [ok, what] of hardening) {
      assert(ok, `[${label}] ${name} container is not '${what}'`);
    }

    // CREDENTIALS: the operator's infra Secret (optional) and the catalog's gitToken — nothing else.
    const secretRefs = (c?.env ?? [])
      .map(
        (e) =>
          (e as { valueFrom?: { secretKeyRef?: { name?: string; key?: string } } }).valueFrom
            ?.secretKeyRef
      )
      .filter((r): r is { name?: string; key?: string } => r !== undefined)
      .map((r) => `${r.name}/${r.key}`);
    assert(
      JSON.stringify(secretRefs) === JSON.stringify(["scp-build-registry/gitToken"]),
      `[${label}] ${name} reads secret keys ${JSON.stringify(secretRefs)} — only the catalog's gitToken may be read by key (registry push credentials must never reach an infra pod)`
    );
    assert(
      JSON.stringify(c?.envFrom) ===
        JSON.stringify([{ secretRef: { name: `scp-infra-${phase}-credentials`, optional: true } }]),
      `[${label}] ${name} envFrom is ${JSON.stringify(c?.envFrom)}, not the operator's optional ${phase} credentials Secret scp-infra-${phase}-credentials (the plan's must be read-only, so the two are never one Secret)`
    );
    const backendEnv = (c?.env ?? []).find((e) => e.name === "SCP_STATE_BACKEND_TYPE");
    assert(
      (backendEnv as { value?: string } | undefined)?.value === "s3",
      `[${label}] ${name} does not carry the operator's backend type in SCP_STATE_BACKEND_TYPE`
    );
  }

  // Each infra identity's Role is the executor floor and nothing more.
  for (const phase of ["plan", "apply"] as const) {
    const role = docs.find(
      (d) => d.kind === "Role" && d.metadata?.name === `scp-infra-${phase}`
    ) as { rules?: { apiGroups?: string[]; resources?: string[]; verbs?: string[] }[] } | undefined;
    assert(
      JSON.stringify(role?.rules) ===
        JSON.stringify([
          {
            apiGroups: ["argoproj.io"],
            resources: ["workflowtaskresults"],
            verbs: ["create", "patch"]
          }
        ]),
      `[${label}] the scp-infra-${phase} Role grants ${JSON.stringify(role?.rules)} — the chart grants each infra identity the executor floor only; anything more is the operator's to add`
    );
  }
  console.log(
    "  absent until stateBackend.type is set; fails closed with its own message when the image is missing; ships files/scp-infra.sh byte-identical; positional args + required params + evidence outputs match; per-workspace mutex; fully hardened; plan and apply identities + Secrets separate, each at the executor floor"
  );
}

function verifySocketInvariantMatrix(): void {
  const label = "M23.6 socket invariant";
  console.log(
    "\nhelm-verify: rendering the FULL values matrix and asserting no pod mounts a container runtime socket..."
  );
  const points = socketMatrix();
  let rendered = 0;
  let refused = 0;
  let runnerJobs = 0;
  let grantsChecked = 0;
  let grantProblems = 0;

  // M29.1 (ADR-0058 "the default flip"): stackd now renders BY DEFAULT, and it renders its own
  // ClusterRole/ClusterRoleBinding/second ServiceAccount+namespace-spanning RoleBindings — real,
  // reviewed and asserted on their OWN terms in verifyStackdMatrix() below. This matrix is about
  // the MANAGED RUNNER's identity in isolation (one pod identity, no cluster-scoped grant, no
  // socket mount); every point here turns stackd back off so it keeps testing exactly that,
  // the same way it did before stackd existed as a default-on render.
  const STACKD_OFF = ["--set", "stackd.enabled=false"];
  for (const point of points) {
    let raw: string;
    try {
      raw = renderRaw(CHART_DIR, "verify-socket", [...point.args, ...STACKD_OFF]);
    } catch (err) {
      // A REFUSAL IS AN ANSWER, AND THE ONLY ACCEPTABLE ONE FOR A COMBINATION THE CHART GUARDS.
      // Counting it silently would let a guard that started refusing EVERYTHING shrink the matrix
      // to nothing, so the expectation is stated per point and checked in both directions.
      if (!point.refuses) {
        fail(
          `[${label}] ${point.label} failed to render, and this combination is expected to be valid: ${String((err as { stderr?: string }).stderr ?? err).slice(0, 400)}`
        );
      }
      refused += 1;
      continue;
    }
    if (point.refuses) {
      fail(
        `[${label}] ${point.label} RENDERED, but the chart's own guards are supposed to refuse it — a render-time guard that stopped guarding`
      );
    }
    rendered += 1;
    const docs = parseAllDocuments(raw)
      .map((d) => d.toJS() as K8sDoc | null)
      .filter((d): d is K8sDoc => d != null && typeof d === "object" && "kind" in d);
    for (const problem of socketInvariantProblems(point.label, raw, docs)) fail(problem);

    /** M23.6 CLAUSE 5, WIDENED. See docs/helm-verify.md §14. */
    for (const problem of chartGrantProblems({
      label: point.label,
      docs,
      expectRunnerGrant: point.expectRunnerGrant,
      perRunSecrets: point.perRunSecrets
    })) {
      fail(problem);
      grantProblems += 1;
    }
    grantsChecked += 1;

    // AND THE POD THE CHART CANNOT RENDER.
    const job = runnerJobFromRender(docs);
    if (job) {
      runnerJobs += 1;
      for (const problem of socketInvariantProblems(
        `${point.label} runner Job`,
        JSON.stringify(job),
        [job]
      )) {
        fail(problem);
      }
    }
  }

  /** The census covering combinations no matrix can enumerate. See docs/helm-verify.md §15. */
  const templateDir = path.join(CHART_DIR, "templates");
  const chartSources = readdirSync(templateDir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".tpl"))
    .map((f) => ({
      file: `templates/${f}`,
      text: readFileSync(path.join(templateDir, f), "utf8")
    }));
  chartSources.push({
    file: "values.yaml",
    text: readFileSync(path.join(CHART_DIR, "values.yaml"), "utf8")
  });
  assert(
    chartSources.length > 10,
    `[${label}] the template census read ${chartSources.length} files, which is too few to be the chart — every assertion below would pass on an empty list`
  );
  for (const { file, text } of chartSources) {
    for (const pattern of RUNTIME_SOCKET_PATTERNS) {
      // The values.yaml PROSE explains why no socket is mounted, so a comment naming one is not a
      // violation — the check is on what the file would emit, with comment lines removed.
      const emitted = text
        .split("\n")
        .filter((line) => !/^\s*#/.test(line))
        .join("\n");
      assert(
        !emitted.includes(pattern),
        `[${label}] deploy/helm/${file} contains '${pattern}' outside a comment — no value combination can make that safe`
      );
    }
    assert(
      !/^\s*hostPath\s*:/m.test(
        text
          .split("\n")
          .filter((line) => !/^\s*#/.test(line))
          .join("\n")
      ),
      `[${label}] deploy/helm/${file} declares a hostPath volume. This chart declares none; the runner workspace is an RWX PersistentVolumeClaim`
    );
    assert(
      !text.includes("SCP_MANAGED_RUNNER_K8S_WORKSPACE_HOST_PATH"),
      `[${label}] deploy/helm/${file} plumbs SCP_MANAGED_RUNNER_K8S_WORKSPACE_HOST_PATH — that variable makes the runner Job mount a host directory, and it is deliberately reachable only from the kind harness`
    );
    /** M23.6 CLAUSE 5, WIDENED. See docs/helm-verify.md §16. ONE file is exempt, by name: the
     *  stack controller's RBAC (M29.4, ADR-0058 E1), which is cluster-scoped by necessity, renders
     *  only under `stackd.enabled`, and is held to its own assertions in ./stackd.ts instead. */
    const stackdException =
      file === "templates/stackd-rbac.yaml" &&
      text.trimStart().startsWith("{{- if .Values.stackd.enabled }}");
    for (const clusterKind of stackdException ? [] : ["ClusterRole", "ClusterRoleBinding"]) {
      const emitted = text
        .split("\n")
        .filter((line) => !/^\s*#/.test(line))
        .join("\n");
      assert(
        !new RegExp(`kind:\\s*${clusterKind}\\b`).test(emitted),
        `[${label}] deploy/helm/${file} can render a ${clusterKind}. Every grant this chart makes is namespaced — a cluster-scoped one authorises the holder against nodes, namespaces and every other release in the cluster, and no value combination can narrow it back`
      );
    }
  }
  for (const setArgs of [
    [] as string[],
    [
      "--set",
      "bundledExecutor.argocd.enabled=true",
      "--set",
      "bundledExecutor.argoWorkflows.enabled=true",
      "--set",
      // Required once the argo-server ingress policy is namespace-scoped; the chart fails closed
      // without it rather than falling back to "SCP's pod label in ANY namespace".
      "bundledExecutor.scpNamespace=verify-scp-ns",
      "--set",
      "bundledExecutor.argoEvents.enabled=true",
      "--set",
      // Argo Rollouts belongs in the all-backends render even though SCP never coordinates it
      // (ADR-0008 §3 — observed via the Argo CD Application, never driven). It is 3 MB of vendored
      // upstream that this chart applies to a cluster; leaving it out would mean the socket scan,
      // the RoleBinding-subject re-homing check and the container guards below never look at it.
      // "What this chart can render" is the question, not "what SCP talks to".
      "bundledExecutor.argoRollouts.enabled=true",
      "--set",
      "bundledExecutor.gitea.enabled=true",
      // M28.2 — the host-ops catalog template is OFF by default, so the all-backends render turns
      // it on: the guards below must see the one workload in this chart that will hold a root
      // certificate for a domain's hosts.
      "--set",
      "bundledExecutor.argoWorkflows.catalog.ops.enabled=true",
      "--set",
      `bundledExecutor.argoWorkflows.catalog.ops.runnerImage=registry.example.com/scp/scp-runner-ops:verify@${OPS_VERIFY_DIGEST}`,
      "--set",
      `bundledExecutor.argoWorkflows.catalog.ops.apiUrl=${OPS_VERIFY_API_URL}`,
      "--set",
      "bundledExecutor.argoWorkflows.catalog.ops.targetCidrs={10.20.0.0/16}",
      "--set",
      "bundledExecutor.argoWorkflows.catalog.ops.kubeApiCidrs={10.43.0.1/32}",
      "--set",
      // scp-build-rpm-v1 renders only once its first-party builder image is named (M28.1), so
      // without this the socket scan and the WorkflowTemplate container guards below would never
      // see it — "what this chart can render" includes it.
      `bundledExecutor.argoWorkflows.catalog.buildRpm.builderImage=${RPM_BUILDER_VERIFY_IMAGE}`,
      // The infra templates (M28.3) render only once a state backend is named — same reason.
      ...INFRA_VERIFY_SETS
    ]
  ]) {
    const bundledRaw = renderRaw(BUNDLED_CHART_DIR, "verify-socket-bundled", setArgs);
    const opsEnabled = setArgs.includes("bundledExecutor.argoWorkflows.catalog.ops.enabled=true");
    assertOpsCatalog(label, bundledRaw, opsEnabled);
    if (opsEnabled) {
      // THE DETECTOR'S OWN NON-VACUITY, as for the socket and grant detectors above: each planted
      // defect in an otherwise-good render must be reported, or every clean ops verdict means nothing.
      const PLANTS: [string, string, string][] = [
        [
          "an extra Workflow parameter",
          "      - name: opsRunId\n",
          "      - name: opsRunId\n      - name: opsInventory\n"
        ],
        ["catalog verification off", "value: required", 'value: "off"'],
        [
          "a deadline past the certificate",
          "activeDeadlineSeconds: 600",
          "activeDeadlineSeconds: 3600"
        ],
        [
          "DNS to anywhere",
          "              kubernetes.io/metadata.name: kube-system\n",
          "              kubernetes.io/metadata.name: anywhere\n"
        ]
      ];
      for (const [what, from, to] of PLANTS) {
        const planted = bundledRaw.replace(from, to);
        const problems: string[] = [];
        if (planted === bundledRaw) {
          fail(
            `[${label}] assertOpsCatalog self-test could not plant '${what}' — the render changed shape`
          );
          continue;
        }
        assertOpsCatalog(label, planted, true, (condition, msg) => {
          if (!condition) problems.push(msg);
        });
        assert(
          problems.length > 0,
          `[${label}] assertOpsCatalog did not detect ${what} in a planted render, so its clean verdict means nothing`
        );
      }
    }
    for (const pattern of RUNTIME_SOCKET_PATTERNS) {
      assert(
        !bundledRaw.includes(pattern),
        `[${label}] the bundled-backends render contains '${pattern}' — a vendored backend mounting a container runtime socket is the same escape, one chart along`
      );
    }
    // EVERY ROLE-BINDING SUBJECT IS RE-HOMED. `_bundled-executor.tpl` re-homes each vendored
    // backend into its own namespace; until 2026-09-20 it walked the subjects of a
    // ClusterRoleBinding but not of a RoleBinding, which took the metadata-only branch. Upstream
    // Argo Workflows ships `argo-binding` naming `ServiceAccount argo` in namespace `argo`, so the
    // binding moved to `scp-argo-workflows` while still pointing at a namespace that does not
    // exist — and it carries `coordination.k8s.io/leases`, the workflow-controller's LEADER
    // ELECTION. The bundle deployed a controller that could never take leadership, and nothing
    // failed loudly: the Deployment is Ready either way.
    //
    // Checked on SUBJECTS ONLY, never on a blanket scan for the upstream name: a config VALUE may
    // legitimately mention it, which is the exact distinction the helper is careful about.
    for (const doc of parseAllDocuments(bundledRaw)
      .map((d) => d.toJS() as K8sDoc | null)
      .filter((d): d is K8sDoc => Boolean(d))) {
      if (doc.kind !== "RoleBinding" && doc.kind !== "ClusterRoleBinding") continue;
      const subjects = (doc.subjects ?? []) as {
        kind?: string;
        name?: string;
        namespace?: string;
      }[];
      for (const subject of subjects) {
        if (!subject.namespace) continue;
        assert(
          subject.namespace.startsWith("scp-"),
          `[${label}] bundled ${doc.kind} '${doc.metadata?.name}' names subject '${subject.name}' in namespace '${subject.namespace}', which is not a re-homed 'scp-*' namespace — the vendored manifest's upstream namespace survived the re-home, so this grant lands on a ServiceAccount that does not exist`
        );
      }
    }
    // THE BUILD IDENTITY GRANTS THE EXECUTOR FLOOR AND NOTHING ELSE. A catalog build pod runs the
    // TENANT'S OWN Dockerfile, and Argo refuses to run it tokenless ("executor.serviceAccountName
    // must not be empty if automountServiceAccountToken is false"), so a token is readable from
    // inside that build by construction. What it can DO is the only lever left — and the floor is
    // `workflowtaskresults: create, patch`, which is how the emissary executor reports step status.
    // Any other resource here is authority a malicious build could reach.
    for (const doc of parseAllDocuments(bundledRaw)
      .map((d) => d.toJS() as K8sDoc | null)
      .filter((d): d is K8sDoc => Boolean(d))) {
      if (doc.kind !== "Role" || doc.metadata?.name !== "scp-build") continue;
      const rules = ((doc as { rules?: unknown[] }).rules ?? []) as { resources?: string[] }[];
      const granted = rules.flatMap((r) => r.resources ?? []).sort();
      assert(
        granted.length === 1 && granted[0] === "workflowtaskresults",
        `[${label}] the catalog build Role grants ${JSON.stringify(granted)} — it may grant workflowtaskresults and nothing else. That pod runs the tenant's own Dockerfile and can read its own token, so every extra resource here is authority a malicious build inherits`
      );
    }

    // THE BUILD CONTAINER'S RELAXATIONS ARE EXACTLY THE FOUR THAT WERE MEASURED, AND NO MORE.
    // scp-build-image-v1 cannot be a hardened container: rootless BuildKit has to create a user
    // namespace, and seccomp RuntimeDefault, the default AppArmor profile, no_new_privs and
    // `drop: [ALL]` each independently prevent that (see the template header for the failure each
    // one produces). That makes this the one workload in the chart whose securityContext is
    // deliberately weaker — which is precisely why it needs a guard rather than trust. A later
    // edit reaching for `privileged: true` or dropping runAsNonRoot would look, in a diff, exactly
    // like the four relaxations already here.
    //
    // WorkflowTemplate containers are invisible to assertHardenedContainer (it walks Deployments
    // and Jobs), so without this check nothing constrains them at all.
    for (const doc of parseAllDocuments(bundledRaw)
      .map((d) => d.toJS() as K8sDoc | null)
      .filter((d): d is K8sDoc => Boolean(d))) {
      if (doc.kind !== "WorkflowTemplate") continue;
      const templates = ((doc as { spec?: { templates?: unknown[] } }).spec?.templates ?? []) as {
        name?: string;
        container?: Container;
        initContainers?: Container[];
      }[];
      for (const tpl of templates) {
        for (const container of [tpl.container, ...(tpl.initContainers ?? [])].filter(
          (c): c is Container => Boolean(c)
        )) {
          const where = `${doc.metadata?.name}/${tpl.name}/${container.name}`;
          const sc = (container.securityContext ?? {}) as {
            privileged?: boolean;
            runAsUser?: number;
            runAsNonRoot?: boolean;
            readOnlyRootFilesystem?: boolean;
            capabilities?: { drop?: string[]; add?: string[] };
          };
          assert(
            sc.privileged !== true,
            `[${label}] catalog container '${where}' is privileged. Nothing in this chart may be: a build pod runs the tenant's own Dockerfile, and privileged hands it the node's kernel`
          );
          assert(
            sc.runAsUser !== 0,
            `[${label}] catalog container '${where}' runs as uid 0. The builder is rootless by construction; running it as root does not work and would not be acceptable if it did`
          );
          // The builder needs SETUID/SETGID for newuidmap; nothing may need more than that.
          const added = (sc.capabilities?.add ?? []).slice().sort();
          const ALLOWED_ADDED = ["SETGID", "SETUID"];
          assert(
            added.every((cap) => ALLOWED_ADDED.includes(cap)),
            `[${label}] catalog container '${where}' adds capabilities ${JSON.stringify(added)} — only ${JSON.stringify(ALLOWED_ADDED)} are justified (newuidmap/newgidmap). Anything else is new authority inside a pod running an untrusted Dockerfile`
          );
        }
      }
    }

    // THE ACCOUNT SCP COORDINATES AS STAYS NARROW. argo-server runs `--auth-mode=client`, so it
    // performs every Kubernetes action AS THE CALLER — which means this Role is not "SCP's
    // permissions in a namespace", it is what SCP can make argo-server do on its behalf. Granting
    // `secrets` here would hand SCP the ability to read every Secret in the backend's namespace
    // through the very API it coordinates with, and `pods/exec` would hand it a shell. The plugin
    // needs neither: its calls are workflows, workflowtemplates and cronworkflows, nothing else.
    const FORBIDDEN_COORDINATOR_RESOURCES = ["secrets", "pods", "pods/exec", "pods/log", "*"];
    for (const doc of parseAllDocuments(bundledRaw)
      .map((d) => d.toJS() as K8sDoc | null)
      .filter((d): d is K8sDoc => Boolean(d))) {
      if (doc.kind !== "Role" || !String(doc.metadata?.name ?? "").includes("coordinator"))
        continue;
      const rules = ((doc as { rules?: unknown[] }).rules ?? []) as {
        resources?: string[];
        verbs?: string[];
      }[];
      for (const rule of rules) {
        for (const resource of rule.resources ?? []) {
          assert(
            !FORBIDDEN_COORDINATOR_RESOURCES.includes(resource),
            `[${label}] the bundled coordinator Role '${doc.metadata?.name}' grants '${resource}' — argo-server acts AS the caller, so this would let SCP read every Secret (or exec into pods) in that namespace through the API it coordinates with. The plugin calls workflows/workflowtemplates/cronworkflows only`
          );
          assert(
            !(rule.verbs ?? []).includes("*"),
            `[${label}] the bundled coordinator Role '${doc.metadata?.name}' grants verb '*' on '${resource}' — enumerate the verbs the plugin actually calls`
          );
        }
      }
    }

    // ARGO-SERVER IS HANDED A PERSISTENT CERTIFICATE. Without `--tls-certificate-secret-name` it
    // mints a fresh self-signed cert on every start — measured across three restarts, three
    // distinct fingerprints — which makes its CA unpinnable and breaks SCP's executorTls trust at
    // the first restart of that pod, with an error that reads like SCP's own misconfiguration.
    for (const doc of parseAllDocuments(bundledRaw)
      .map((d) => d.toJS() as K8sDoc | null)
      .filter((d): d is K8sDoc => Boolean(d))) {
      if (doc.kind !== "Deployment" || doc.metadata?.name !== "argo-server") continue;
      const containers = ((doc.spec as { template?: { spec?: { containers?: unknown[] } } })
        ?.template?.spec?.containers ?? []) as { name?: string; args?: string[] }[];
      const server = containers.find((c) => c.name === "argo-server");
      assert(
        (server?.args ?? []).some((a) => a.startsWith("--tls-certificate-secret-name=")),
        `[${label}] bundled argo-server has no --tls-certificate-secret-name — it will mint a NEW self-signed certificate on every start, so nothing can pin its CA`
      );
    }

    // EVERY BUNDLED WORKLOAD IS BOUNDED. Upstream ships all four backends with no requests and no
    // limits on any container, which makes every one BestEffort: unbounded, and the FIRST thing
    // evicted under node pressure. On a single-node install that is SCP's own Postgres.
    //
    // `bundledExecutor.argocd.resources` existed in values.yaml before this was wired and was read
    // by NOTHING — sized, commented, per-component, and dead. That is why this assertion reads the
    // RENDER rather than the values: a knob is only real if it reaches a container.
    for (const doc of parseAllDocuments(bundledRaw)
      .map((d) => d.toJS() as K8sDoc | null)
      .filter((d): d is K8sDoc => Boolean(d))) {
      if (doc.kind === "NetworkPolicy") {
        // NO INGRESS RULE MAY ADMIT A POD LABEL FROM ANY NAMESPACE. `namespaceSelector: {}` ANDed
        // with a podSelector reads as "SCP's pods", but a pod label is writable by anyone who can
        // create a pod in any namespace — so the control is one its own subject can satisfy.
        // Measured before this was scoped: adding `app.kubernetes.io/name=commanderscp` to a
        // busybox pod in `default` took it from BLOCKED to REACHED, same pod, nothing else changed.
        const ingress = ((doc.spec as { ingress?: unknown[] })?.ingress ?? []) as {
          from?: { namespaceSelector?: Record<string, unknown>; podSelector?: unknown }[];
        }[];
        for (const rule of ingress) {
          for (const peer of rule.from ?? []) {
            if (!peer.podSelector || peer.namespaceSelector === undefined) continue;
            assert(
              Object.keys(peer.namespaceSelector).length > 0,
              `[${label}] bundled NetworkPolicy '${doc.metadata?.name}' admits a pod label from an EMPTY namespaceSelector — that is any namespace, and a pod label is writable by anyone who can create a pod. Scope it with bundledExecutor.scpNamespace`
            );
          }
        }
        continue;
      }
      if (!["Deployment", "StatefulSet", "DaemonSet"].includes(doc.kind ?? "")) continue;
      const podSpec = ((doc.spec as { template?: { spec?: Record<string, unknown> } })?.template
        ?.spec ?? {}) as Record<string, unknown>;
      for (const field of ["containers", "initContainers"]) {
        const list = (podSpec[field] ?? []) as {
          name?: string;
          resources?: Record<string, unknown>;
        }[];
        for (const container of list) {
          const r = container.resources ?? {};
          assert(
            Boolean(r.requests) && Boolean(r.limits),
            `[${label}] bundled ${doc.kind} '${doc.metadata?.name}' ${field} '${container.name}' declares no ${!r.requests ? "requests" : "limits"} — an unbounded vendored container is BestEffort and is evicted before anything that declares a request, which on a single-node install means SCP's own Postgres. Add it to that backend's 'resources' map in deploy/helm-bundled/values.yaml, keyed by CONTAINER name`
          );
        }
      }
    }
  }

  // NON-VACUITY, IN THREE PARTS. Every assertion above is "nothing was found", which is exactly what
  // an empty matrix, a render that produced nothing, and a guard that refused everything all
  // produce. The counts are asserted so the sweep cannot pass by having swept nothing.
  assert(
    points.length === 162,
    `[${label}] the matrix is ${points.length} points, not the 162 it is documented as — update the count deliberately, with the dimension that changed`
  );
  assert(
    rendered === 131 && refused === 31,
    `[${label}] the matrix rendered ${rendered} and saw ${refused} refusals; expected 131 and 31`
  );
  assert(
    runnerJobs === 110,
    `[${label}] ${runnerJobs} of the renders produced a derivable runner Job manifest; expected 110. Zero would mean the env-derived half of this gate checked nothing at all`
  );
  // …and the detector itself finds what it is looking for when it IS there.
  const planted: K8sDoc = {
    kind: "Deployment",
    metadata: { name: "planted" },
    spec: {
      template: {
        spec: {
          volumes: [{ name: "sock", hostPath: { path: "/var/run/docker.sock" } }],
          containers: [{ name: "c", volumeMounts: [{ mountPath: "/var/run/docker.sock" }] }]
        }
      }
    }
  };
  // FOUR, and the number is the two instruments meeting: the raw scan matches `docker.sock` and
  // `/var/run/docker` in the bytes, and the structural walk names the hostPath VOLUME and the
  // container's MOUNT separately. A control that only counted one of them would leave the other
  // instrument unproven.
  assert(
    socketInvariantProblems("control", "hostPath: /var/run/docker.sock", [planted]).length === 4,
    `[${label}] the socket detector does not fire on a manifest that plainly violates the invariant, so every clean verdict above means nothing`
  );

  /** AND THE GRANT DETECTOR'S OWN NON-VACUITY. See docs/helm-verify.md §17. */
  const plantedGrant: K8sDoc[] = [
    {
      kind: "Deployment",
      metadata: { name: "planted" },
      spec: { template: { spec: { serviceAccountName: "scp", containers: [] } } }
    },
    {
      kind: "ClusterRole",
      metadata: { name: "planted-cluster" },
      rules: [{ apiGroups: [""], resources: ["nodes"], verbs: ["delete"] }]
    },
    {
      kind: "Role",
      metadata: { name: "planted-wild", namespace: "default" },
      rules: [{ apiGroups: ["batch"], resources: ["jobs"], verbs: ["*"] }]
    },
    {
      kind: "Role",
      metadata: { name: "planted-unbound", namespace: "default" },
      rules: [{ apiGroups: [""], resources: ["secrets"], verbs: ["get"] }]
    },
    {
      kind: "RoleBinding",
      metadata: { name: "planted-binding", namespace: "default" },
      roleRef: { kind: "Role", name: "planted-wild" },
      subjects: [{ kind: "ServiceAccount", name: "a-stranger", namespace: "default" }]
    }
  ];
  const plantedProblems = chartGrantProblems({
    label: "control",
    docs: plantedGrant,
    expectRunnerGrant: false,
    perRunSecrets: false
  });
  const plantedNames = [
    "rendered a ClusterRole",
    "verbs: ['*']",
    "names the cluster-scoped resource 'nodes'",
    "authorises nobody",
    "is not the one identity"
  ];
  for (const fragment of plantedNames) {
    assert(
      plantedProblems.some((problem) => problem.includes(fragment)),
      `[${label}] the grant detector did not report '${fragment}' on a render that plainly contains it, so every clean grant verdict above means nothing`
    );
  }
  assert(
    grantsChecked === rendered && grantProblems === 0,
    `[${label}] the grant gate checked ${grantsChecked} of ${rendered} renders and reported ${grantProblems} problems`
  );

  console.log(
    `  ${points.length} value combinations: ${rendered} rendered clean, ${refused} refused by the chart's own guards as expected, ${runnerJobs} runner Job manifests derived from the rendered env and checked too — no hostPath and no runtime socket anywhere`
  );
  console.log(
    `  and the WHOLE chart's RBAC grant checked on all ${grantsChecked} of them: no ClusterRole or ClusterRoleBinding, no wildcard, no escalate/bind/impersonate, every Role bound, and the one workload identity holding exactly its pinned set`
  );
}

function assert(condition: unknown, msg: string): void {
  if (!condition) fail(msg);
}

/**
 * THE HOST-OPS CATALOG TEMPLATE (M28.2, ADR-0054). The one workload in the bundled chart whose pod
 * will hold a root certificate for a domain's hosts — so each property its design rests on is
 * checked against the RENDER, not the template text:
 *   - OFF unless asked for (default render has no `scp-ops-v1` at all);
 *   - the Workflow's parameters are exactly the sealed token and a run id — nothing a reader of
 *     Workflows could use, and nothing a host list could hide in;
 *   - the container is fully hardened (it runs no tenant code, so it needs no relaxation);
 *   - its identity grants the executor floor and nothing more;
 *   - its egress policy actually SELECTS the pod the template produces (subset match on the
 *     podMetadata labels) and admits SSH only to the operator's ranges.
 */
function assertOpsCatalog(
  label: string,
  bundledRaw: string,
  opsEnabled: boolean,
  check: (condition: unknown, msg: string) => void = assert
): void {
  const docs = parseAllDocuments(bundledRaw)
    .map((d) => d.toJS() as K8sDoc | null)
    .filter((d): d is K8sDoc => Boolean(d));
  const tpl = docs.find((d) => d.kind === "WorkflowTemplate" && d.metadata?.name === "scp-ops-v1");
  if (!opsEnabled) {
    check(
      !tpl,
      `[${label}] scp-ops-v1 rendered with catalog.ops disabled — the host-ops template must be off unless an operator enables it`
    );
    return;
  }
  check(tpl, `[${label}] catalog.ops.enabled=true rendered no scp-ops-v1 WorkflowTemplate`);
  if (!tpl) return;
  // THE CHART AND THE RUNTIME CHECK ARE ONE THING. The argo-workflows plugin refuses, at submit time,
  // any scp-ops-v1 whose shape is not exactly the chart's (#414 re-verification: a denylist let four
  // bypasses through). Asking that same function about the ACTUAL render means a chart edit it would
  // refuse fails here, at build time, instead of refusing every production run.
  const shapeProblems = opsTemplateShapeProblems(JSON.parse(JSON.stringify(tpl)), {
    runnerImageDigest: OPS_VERIFY_DIGEST,
    redeemUrl: OPS_VERIFY_API_URL
  });
  check(
    shapeProblems.length === 0,
    `[${label}] the rendered scp-ops-v1 is not the shape @scp/plugin-argo-workflows accepts: ${shapeProblems.join("; ")}`
  );
  const spec = tpl.spec as {
    arguments?: { parameters?: { name?: string }[] };
    podMetadata?: { labels?: Record<string, string> };
    serviceAccountName?: string;
    templates?: {
      container?: Container & {
        securityContext?: Container["securityContext"] & {
          privileged?: boolean;
          runAsNonRoot?: boolean;
          capabilities?: { drop?: string[]; add?: string[] };
        };
      };
    }[];
  };
  const params = (spec.arguments?.parameters ?? []).map((p) => p.name).sort();
  check(
    JSON.stringify(params) === JSON.stringify(["opsRunId", "opsRunTokenSealed"]),
    `[${label}] scp-ops-v1 declares parameters ${JSON.stringify(params)} — it may declare exactly opsRunId and opsRunTokenSealed. A Workflow's arguments are persisted in etcd, the Argo UI and the archive; hosts, roles and credentials reach the pod by redemption, never as parameters`
  );
  for (const t of spec.templates ?? []) {
    const c = t.container;
    if (!c) continue;
    const sc = c.securityContext ?? {};
    check(
      sc.readOnlyRootFilesystem === true &&
        sc.allowPrivilegeEscalation === false &&
        sc.privileged !== true &&
        sc.runAsNonRoot === true &&
        (sc.capabilities?.drop ?? []).includes("ALL") &&
        (sc.capabilities?.add ?? []).length === 0 &&
        sc.seccompProfile?.type === "RuntimeDefault",
      `[${label}] scp-ops-v1 container '${c.name ?? "main"}' is not fully hardened — it runs only the closed catalog and needs no relaxation, so any here is new authority beside a root certificate`
    );
    const envNames = (c.env ?? []).map((e) => e.name);
    for (const required of [
      "SCP_OPS_API_URL",
      "SCP_OPS_RUN_TOKEN_SEALED",
      "SCP_OPS_SEALING_KEY_FILE"
    ]) {
      check(
        envNames.includes(required),
        `[${label}] scp-ops-v1 container sets no ${required} — the runner cannot redeem without it`
      );
    }
    const verify = (c.env ?? []).find((e) => e.name === "SCP_OPS_CATALOG_VERIFY");
    check(
      verify?.value === "required",
      `[${label}] scp-ops-v1 does not require catalog verification — the signed catalog is what bounds a host-reaching run`
    );
  }
  const role = docs.find((d) => d.kind === "Role" && d.metadata?.name === spec.serviceAccountName);
  const granted = ((role as { rules?: { resources?: string[] }[] } | undefined)?.rules ?? [])
    .flatMap((r) => r.resources ?? [])
    .sort();
  check(
    granted.length === 1 && granted[0] === "workflowtaskresults",
    `[${label}] the ops Role '${spec.serviceAccountName}' grants ${JSON.stringify(granted)} — workflowtaskresults and nothing else; this pod holds a root certificate`
  );
  const policy = docs.find(
    (d) => d.kind === "NetworkPolicy" && d.metadata?.name === "scp-ops-egress"
  );
  check(policy, `[${label}] catalog.ops.enabled rendered no scp-ops-egress NetworkPolicy`);
  const selector = ((
    policy?.spec as { podSelector?: { matchLabels?: Record<string, string> } } | undefined
  )?.podSelector?.matchLabels ?? {}) as Record<string, string>;
  const podLabels = spec.podMetadata?.labels ?? {};
  check(
    Object.keys(selector).length > 0 &&
      Object.entries(selector).every(([k, v]) => podLabels[k] === v),
    `[${label}] scp-ops-egress selects ${JSON.stringify(selector)}, which the scp-ops-v1 pod labels ${JSON.stringify(podLabels)} do not satisfy — the policy would select nothing`
  );
  const sshRules = (
    (
      policy?.spec as {
        egress?: { ports?: { port?: number }[]; to?: { ipBlock?: { cidr?: string } }[] }[];
      }
    )?.egress ?? []
  ).filter((r) => (r.ports ?? []).some((p) => p.port === 22));
  check(
    sshRules.length === 1 &&
      (sshRules[0]!.to ?? []).every((t) => t.ipBlock?.cidr && t.ipBlock.cidr !== "0.0.0.0/0"),
    `[${label}] scp-ops-egress must admit SSH to the operator's targetCidrs only (one rule, ipBlocks, never 0.0.0.0/0)`
  );

  // EVERY egress rule names a destination — "port 53 to anywhere" was the defect this replaced —
  // and the Kubernetes API rule is the operator's, never an RFC1918 /8.
  const egress = ((policy?.spec as { egress?: { to?: unknown[]; ports?: { port?: number }[] }[] })
    ?.egress ?? []) as {
    to?: { ipBlock?: { cidr?: string }; namespaceSelector?: unknown }[];
    ports?: { port?: number }[];
  }[];
  check(
    egress.every((r) => (r.to ?? []).length > 0),
    `[${label}] scp-ops-egress has a rule with no 'to' — that admits its ports to every destination`
  );
  const dns = egress.filter((r) => (r.ports ?? []).some((p) => p.port === 53));
  check(
    dns.length === 1 &&
      (dns[0]!.to ?? []).every(
        (t) =>
          JSON.stringify(t.namespaceSelector ?? {}).includes("kube-system") &&
          t.ipBlock === undefined
      ),
    `[${label}] scp-ops-egress DNS must go to kube-system only`
  );
  check(
    egress.every((r) =>
      (r.to ?? []).every(
        (t) =>
          !["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "0.0.0.0/0"].includes(
            t.ipBlock?.cidr ?? ""
          )
      )
    ),
    `[${label}] scp-ops-egress admits a whole private range — every CIDR here is operator-set and specific`
  );
  const deadline = (tpl.spec as { activeDeadlineSeconds?: number }).activeDeadlineSeconds;
  check(
    typeof deadline === "number" && deadline > 0 && deadline <= 600,
    `[${label}] scp-ops-v1 activeDeadlineSeconds is ${String(deadline)} — it must be <= 600, the run certificate's TTL`
  );
}

/** The RAW `helm template` output. See docs/helm-verify.md §18. */
function renderRaw(dir: string, releaseName: string, setArgs: string[]): string {
  return execFileSync("helm", ["template", releaseName, dir, ...setArgs], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
}

function renderDir(dir: string, releaseName: string, setArgs: string[]): K8sDoc[] {
  const output = renderRaw(dir, releaseName, setArgs);
  return parseAllDocuments(output)
    .map((doc) => doc.toJS() as K8sDoc | null)
    .filter((doc): doc is K8sDoc => doc != null && typeof doc === "object" && "kind" in doc);
}

function renderChart(releaseName: string, setArgs: string[]): K8sDoc[] {
  return renderDir(CHART_DIR, releaseName, setArgs);
}

function renderBundledChart(setArgs: string[]): K8sDoc[] {
  return renderDir(BUNDLED_CHART_DIR, "scp-bundled", setArgs);
}

/** Size of `helm package <dir>` base64-encoded — a close proxy for the Helm release Secret, which
 *  stores base64(gzip(whole chart)) and is capped at Kubernetes' 1 MB Secret limit. */
function packagedChartBase64Size(dir: string): number {
  const out = mkdtempSync(path.join(os.tmpdir(), "helm-verify-pkg-"));
  // The same leaked-tempdir property as the *.test.ts census this dir's sibling fixtures were
  // swept for (see @scp/test-tmpdir) — this is production tool code, not a vitest test, so that
  // package's afterEach-based tracking does not apply here; a plain try/finally is the fix.
  try {
    execFileSync("helm", ["package", dir, "--destination", out], { stdio: "ignore" });
    const tgz = readdirSync(out).find((f) => f.endsWith(".tgz"));
    if (!tgz) throw new Error(`helm package produced no .tgz in ${out}`);
    return readFileSync(path.join(out, tgz)).toString("base64").length;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** One container env entry. `valueFrom` was `unknown` until the operator-config-surface block
 *  below needed to assert that a SECRET-backed var is genuinely a `secretKeyRef` and not a literal
 *  — an assertion that cannot be written against `unknown`, and one worth being able to write:
 *  a token rendered as a plain `value` sits in the Deployment spec for anyone with `get deploy`. */
interface EnvVar {
  name: string;
  value?: string;
  valueFrom?: { secretKeyRef?: { name?: string; key?: string } };
}

interface Container {
  name: string;
  image?: string;
  env?: EnvVar[];
  securityContext?: {
    allowPrivilegeEscalation?: boolean;
    readOnlyRootFilesystem?: boolean;
    capabilities?: { drop?: string[] };
    seccompProfile?: { type?: string };
  };
  readinessProbe?: { httpGet?: { path?: string; port?: string; scheme?: string } };
  livenessProbe?: { httpGet?: { path?: string; port?: string; scheme?: string } };
  /** M23.5 — a write path this chart puts in an env var must have a volume behind it in EVERY pod
   *  that runs the role that writes there. See the `both roles` block. */
  volumeMounts?: { name?: string; mountPath?: string }[];
  /** 2026-09-17 eviction incident — see values.yaml's `postgres.evalInCluster.resources` doc
   *  comment. `undefined` (the key absent from the rendered YAML entirely) is the defect: it makes
   *  the pod BestEffort QoS, the kubelet's first eviction candidate under node memory pressure. An
   *  empty object ({}) is the same defect and is deliberately NOT treated as "present" below. */
  resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
}

interface PodSpec {
  securityContext?: { runAsNonRoot?: boolean; seccompProfile?: { type?: string } };
  containers?: Container[];
  initContainers?: Container[];
  /** M23.2 — the field owner decision 6 makes conditional. `false` is the hardened default and must
   *  stay it for every deployment that launches no managed runner through the API server. */
  automountServiceAccountToken?: boolean;
  /** M23.2 — the shared RWX runner workspace is one of these. */
  volumes?: { name?: string }[];
}

function podSpecOf(doc: K8sDoc): PodSpec | undefined {
  if (doc.kind === "Deployment" || doc.kind === "Job") {
    const spec = doc.spec as { template?: { spec?: PodSpec } } | undefined;
    return spec?.template?.spec;
  }
  return undefined;
}

function podTemplateLabelsOf(doc: K8sDoc): Record<string, string> {
  const spec = doc.spec as
    { template?: { metadata?: { labels?: Record<string, string> } } } | undefined;
  return spec?.template?.metadata?.labels ?? {};
}

interface LabelSelector {
  matchLabels?: Record<string, string>;
  matchExpressions?: { key: string; operator: string; values?: string[] }[];
}

/** Full Kubernetes LabelSelector semantics (matchLabels AND matchExpressions) against a concrete
 *  label set. Used to answer the question a name-based grep cannot: "does THIS policy actually
 *  select THAT pod?" — the exact question the air-gap regression turned on. */
function selectorSelects(sel: LabelSelector | undefined, labels: Record<string, string>): boolean {
  if (!sel) return false;
  for (const [k, v] of Object.entries(sel.matchLabels ?? {})) {
    if (String(labels[k]) !== String(v)) return false;
  }
  for (const expr of sel.matchExpressions ?? []) {
    const val = labels[expr.key];
    const present = val !== undefined;
    const values = (expr.values ?? []).map(String);
    switch (expr.operator) {
      case "In":
        if (!present || !values.includes(String(val))) return false;
        break;
      case "NotIn":
        if (present && values.includes(String(val))) return false;
        break;
      case "Exists":
        if (!present) return false;
        break;
      case "DoesNotExist":
        if (present) return false;
        break;
      default:
        return false; // unknown operator — refuse to claim a match
    }
  }
  return true;
}

/** A NetworkPolicy rule list carries NO ALLOW RULES — i.e. the policy DENIES that direction — when
 *  the field is absent OR an empty array. Kubernetes treats `egress:` (absent) and `egress: []` as
 *  identical; anything that recognises only one of the two can be evaded by writing the other.
 *  Shared by every default-deny detection in this file so the two can never drift apart again. */
function hasNoAllowRules(v: unknown): boolean {
  return v === undefined || v === null || (Array.isArray(v) && v.length === 0);
}

function assertHardenedContainer(scope: string, container: Container): void {
  const sc = container.securityContext;
  assert(sc, `${scope} container '${container.name}' has no securityContext at all`);
  if (!sc) return;
  assert(
    sc.allowPrivilegeEscalation === false,
    `${scope} container '${container.name}': allowPrivilegeEscalation must be false (got ${sc.allowPrivilegeEscalation})`
  );
  assert(
    sc.readOnlyRootFilesystem === true,
    `${scope} container '${container.name}': readOnlyRootFilesystem must be true (got ${sc.readOnlyRootFilesystem})`
  );
  assert(
    Array.isArray(sc.capabilities?.drop) && sc.capabilities!.drop!.includes("ALL"),
    `${scope} container '${container.name}': capabilities.drop must include "ALL" (got ${JSON.stringify(sc.capabilities)})`
  );
  assert(
    sc.seccompProfile?.type === "RuntimeDefault",
    `${scope} container '${container.name}': seccompProfile.type must be RuntimeDefault (got ${JSON.stringify(sc.seccompProfile)})`
  );
}

function verifyRender(label: string, docs: K8sDoc[]): void {
  const workloadKinds = new Set(["Deployment", "Job"]);
  // Bundled executor backends. See docs/helm-verify.md §24.
  const workloads = docs.filter(
    (d) =>
      workloadKinds.has(d.kind ?? "") &&
      d.metadata?.name &&
      !String(d.metadata.name).includes("postgres-eval") &&
      !d.metadata?.namespace
  );

  assert(workloads.length > 0, `[${label}] expected at least one Deployment/Job in the render`);

  // CENSUS, NOT SYMPTOM (2026-09-17 incident — see values.yaml's `postgres.evalInCluster.resources`
  // doc comment and CLAUDE.md's "census by property" rule). The kubelet evicted the live eval
  // Postgres because ONE container in ONE template declared no `resources` at all, which is
  // BestEffort QoS. The fix for THAT container is below; this loop is the sweep for every OTHER
  // container this chart renders now or ever adds later — over the UNFILTERED `docs`, not
  // `workloads` (which deliberately excludes postgres-eval and any namespaced hook), and over both
  // `containers` and `initContainers`. An empty `resources: {}` is the SAME defect as an absent key
  // (Kubernetes' QoS computation looks at requests/limits, not at whether the key is spelled), so
  // both are rejected here, not just the absent case.
  for (const doc of docs) {
    if (doc.kind !== "Deployment" && doc.kind !== "Job") continue;
    const podSpec = podSpecOf(doc);
    if (!podSpec) continue;
    for (const container of [...(podSpec.containers ?? []), ...(podSpec.initContainers ?? [])]) {
      const requests = container.resources?.requests;
      assert(
        requests !== undefined && Object.keys(requests).length > 0,
        `[${label}] ${doc.kind}/${doc.metadata?.name} container '${container.name}' declares no resource REQUESTS (got ${JSON.stringify(container.resources)}) — this is BestEffort QoS, the kubelet's first eviction candidate under node memory pressure, and is exactly the property that got the live eval Postgres pod evicted on 2026-09-17`
      );
    }
  }

  for (const doc of workloads) {
    const scope = `[${label}] ${doc.kind}/${doc.metadata?.name}`;
    const podSpec = podSpecOf(doc);
    assert(podSpec, `${scope}: could not locate pod spec`);
    if (!podSpec) continue;

    assert(
      podSpec.securityContext?.runAsNonRoot === true,
      `${scope}: pod securityContext.runAsNonRoot must be true (got ${podSpec.securityContext?.runAsNonRoot})`
    );

    for (const container of [...(podSpec.containers ?? []), ...(podSpec.initContainers ?? [])]) {
      assertHardenedContainer(scope, container);
    }
  }

  // Migrations Job must run as a pre-install/pre-upgrade hook.
  const migrationsJob = docs.find(
    (d) => d.kind === "Job" && String(d.metadata?.name).includes("-migrate-")
  );
  assert(migrationsJob, `[${label}] expected a migrations Job in the render`);
  if (migrationsJob) {
    const hookAnnotation = migrationsJob.metadata?.annotations?.["helm.sh/hook"] ?? "";
    assert(
      hookAnnotation.includes("pre-install") && hookAnnotation.includes("pre-upgrade"),
      `[${label}] migrations Job must be a pre-install,pre-upgrade hook (got "${hookAnnotation}")`
    );

    // Least privilege: the migrations Job is the ONLY workload that may hold the admin
    // DATABASE_URL. api/worker must NEVER see it.
    const migrateEnv = (podSpecOf(migrationsJob)?.containers ?? []).flatMap((c) => c.env ?? []);
    assert(
      migrateEnv.some((e) => e.name === "DATABASE_URL"),
      `[${label}] migrations Job must receive the admin DATABASE_URL`
    );
  }

  const apiDeploy = docs.find(
    (d) => d.kind === "Deployment" && String(d.metadata?.name).endsWith("-api")
  );
  const workerDeploy = docs.find(
    (d) => d.kind === "Deployment" && String(d.metadata?.name).endsWith("-worker")
  );
  assert(apiDeploy, `[${label}] expected the api Deployment`);
  assert(workerDeploy, `[${label}] expected the worker Deployment`);

  for (const [name, doc] of [
    ["api", apiDeploy],
    ["worker", workerDeploy]
  ] as const) {
    if (!doc) continue;
    const env = (podSpecOf(doc)?.containers ?? []).flatMap((c) => c.env ?? []);
    assert(
      !env.some((e) => e.name === "DATABASE_URL"),
      `[${label}] ${name} Deployment must NEVER receive the admin DATABASE_URL (least privilege — SCP_SKIP_MIGRATIONS)`
    );
    assert(
      env.some((e) => e.name === "SCP_SKIP_MIGRATIONS" && e.value === "true"),
      `[${label}] ${name} Deployment must set SCP_SKIP_MIGRATIONS=true`
    );
    assert(
      env.some((e) => e.name === "SCP_RUNTIME_DATABASE_URL"),
      `[${label}] ${name} Deployment must receive SCP_RUNTIME_DATABASE_URL`
    );
  }

  // Single image version for api+worker — no skew (DESIGN §16, §17 Upgradeability).
  if (apiDeploy && workerDeploy) {
    const apiImage = (podSpecOf(apiDeploy)?.containers ?? [])[0]?.image;
    const workerImage = (podSpecOf(workerDeploy)?.containers ?? [])[0]?.image;
    assert(
      apiImage && apiImage === workerImage,
      `[${label}] api and worker must use the SAME image (got api=${apiImage}, worker=${workerImage})`
    );
  }

  // THE EVAL POSTGRES'S OWN DEFAULT (2026-09-17 incident). Only "kitchen-sink" enables
  // postgres.evalInCluster — "defaults" renders no postgres-eval Deployment at all, so this block is
  // a no-op there and load-bearing on kitchen-sink, which sets NO override for
  // postgres.evalInCluster.resources, so what lands here is the CHART'S OWN default.
  const postgresEvalDeploy = docs.find(
    (d) => d.kind === "Deployment" && String(d.metadata?.name).endsWith("-postgres-eval")
  );
  if (postgresEvalDeploy) {
    const postgresContainer = (podSpecOf(postgresEvalDeploy)?.containers ?? []).find(
      (c) => c.name === "postgres"
    );
    assert(
      postgresContainer,
      `[${label}] expected a 'postgres' container in the postgres-eval Deployment`
    );
    if (postgresContainer) {
      assert(
        postgresContainer.resources?.requests?.["cpu"] === "50m" &&
          postgresContainer.resources?.requests?.["memory"] === "256Mi",
        `[${label}] postgres-eval's default resources.requests must be {cpu: 50m, memory: 256Mi} (got ${JSON.stringify(postgresContainer.resources?.requests)}) — see values.yaml's postgres.evalInCluster.resources doc comment for why`
      );
      assert(
        postgresContainer.resources?.limits === undefined,
        `[${label}] postgres-eval must ship NO default memory/cpu LIMIT — a guessed limit risks OOMKilling the eval database instead of merely deprioritizing it (got ${JSON.stringify(postgresContainer.resources?.limits)})`
      );
    }
  }

  // Ingress mTLS (adversarial review MAJOR #3) — the kitchen-sink render opts into
  // ingress.mtls.enabled; the rendered Ingress must actually carry the nginx client-cert-
  // verification annotations (not just accept the value silently).
  if (label === "kitchen-sink") {
    const ingressDoc = docs.find((d) => d.kind === "Ingress");
    assert(ingressDoc, `[${label}] expected an Ingress in the render`);
    if (ingressDoc) {
      const annotations = (ingressDoc.metadata?.annotations ?? {}) as Record<string, string>;
      assert(
        annotations["nginx.ingress.kubernetes.io/auth-tls-verify-client"] === "on",
        `[${label}] Ingress with mtls enabled must set nginx.ingress.kubernetes.io/auth-tls-verify-client: "on" (got ${JSON.stringify(annotations["nginx.ingress.kubernetes.io/auth-tls-verify-client"])})`
      );
      assert(
        typeof annotations["nginx.ingress.kubernetes.io/auth-tls-secret"] === "string" &&
          annotations["nginx.ingress.kubernetes.io/auth-tls-secret"].length > 0,
        `[${label}] Ingress with mtls enabled must set a non-empty nginx.ingress.kubernetes.io/auth-tls-secret`
      );
    }
  }

  // M9.3 (ADR-0001, in-app federation mTLS). See docs/helm-verify.md §25.
  if (label === "kitchen-sink") {
    for (const [name, doc] of [
      ["api", apiDeploy],
      ["worker", workerDeploy]
    ] as const) {
      if (!doc) continue;
      const containers = podSpecOf(doc)?.containers ?? [];
      for (const container of containers) {
        assert(
          container.readinessProbe?.httpGet?.scheme === "HTTPS",
          `[${label}] ${name} Deployment container '${container.name}': readinessProbe must use scheme: HTTPS when federation.serverMtls.enabled (got ${JSON.stringify(container.readinessProbe?.httpGet?.scheme)})`
        );
        assert(
          container.livenessProbe?.httpGet?.scheme === "HTTPS",
          `[${label}] ${name} Deployment container '${container.name}': livenessProbe must use scheme: HTTPS when federation.serverMtls.enabled (got ${JSON.stringify(container.livenessProbe?.httpGet?.scheme)})`
        );
      }
      const env = containers.flatMap((c) => c.env ?? []);
      assert(
        env.some((e) => e.name === "SCP_FEDERATION_SERVER_MTLS_CA_FILE"),
        `[${label}] ${name} Deployment must receive SCP_FEDERATION_SERVER_MTLS_CA_FILE when federation.serverMtls.enabled`
      );
      assert(
        env.some((e) => e.name === "SCP_FEDERATION_SERVER_MTLS_CRL_FILE"),
        `[${label}] ${name} Deployment must receive SCP_FEDERATION_SERVER_MTLS_CRL_FILE when federation.serverMtls.crl.enabled`
      );
    }
  }

  // Bundled backends now live in a separate chart. See docs/helm-verify.md §26.
  // scp-argo-rollouts was missing from this list until M29.4 added the fifth backend namespace to
  // the main chart's own renders; the list is every namespace deploy/helm-bundled installs into.
  const bundledNamespaces = [
    "scp-argocd",
    "scp-argo-workflows",
    "scp-argo-rollouts",
    "scp-argo-events",
    "scp-gitea"
  ];
  // The ONLY main-chart resource allowed in a bundled namespace is the stack controller's
  // per-namespace RoleBinding (M29.4: its namespaced rights exist only there; ./stackd.ts pins it).
  // Anything else means a VENDORED backend (Deployment/CRD/ConfigMap/…) — or, since M29.2, a
  // revived install-time auto-wire hook — crept back into the release-stored main chart.
  const strayBundled = docs.filter(
    (d) =>
      bundledNamespaces.includes(d.metadata?.namespace ?? "") &&
      !(
        d.kind === "RoleBinding" && d.metadata?.labels?.["app.kubernetes.io/component"] === "stackd"
      )
  );
  assert(
    strayBundled.length === 0,
    `[${label}] the main chart rendered ${strayBundled.length} resource(s) into a bundled-backend namespace (${strayBundled
      .map((d) => `${d.kind}/${d.metadata?.name}`)
      .join(
        ", "
      )}) — bundled backends must live ONLY in deploy/helm-bundled, never the release-stored main chart`
  );
  // M29.2 (ADR-0061): THE MAIN CHART WIRES NO BUNDLED BACKEND. Their egress, token, trust and
  // registration are the stack controller's, from its own render — a hook Job or an
  // `allow-<backend>` policy here would be a second, hand-kept declaration of the same fact, which
  // is exactly the three-places drift M29.2 removed. In EVERY render, not only the kitchen sink.
  {
    const legacy = docs.filter(
      (d) =>
        (d.kind === "Job" && /-(argocd|gitea)-autowire/.test(String(d.metadata?.name))) ||
        (d.kind === "NetworkPolicy" &&
          /-allow-(argocd|gitea|argo-workflows|kube-api-autowire)$/.test(String(d.metadata?.name)))
    );
    assert(
      legacy.length === 0,
      `[${label}] the main chart rendered bundled-backend wiring of its own (${legacy
        .map((d) => `${d.kind}/${d.metadata?.name}`)
        .join(", ")}) — the stack controller wires bundled backends (ADR-0061)`
    );
  }

  // NetworkPolicy — default-deny AND at least one explicit allow, both present.
  const networkPolicies = docs.filter((d) => d.kind === "NetworkPolicy");
  assert(
    networkPolicies.length >= 2,
    `[${label}] expected multiple NetworkPolicies (default-deny + explicit allows), got ${networkPolicies.length}`
  );
  // `hasNoAllowRules` rather than `=== undefined`: `ingress: []` / `egress: []` is the same
  // deny-everything policy to Kubernetes as omitting the field (same predicate the auto-wire
  // kube-API guard uses — see hasNoAllowRules).
  const defaultDeny = networkPolicies.find((np) => {
    const spec = np.spec as
      { policyTypes?: string[]; ingress?: unknown; egress?: unknown } | undefined;
    return (
      spec?.policyTypes?.includes("Ingress") &&
      spec?.policyTypes?.includes("Egress") &&
      hasNoAllowRules(spec.ingress) &&
      hasNoAllowRules(spec.egress)
    );
  });
  assert(
    defaultDeny,
    `[${label}] expected a default-deny NetworkPolicy (policyTypes [Ingress,Egress], no ingress/egress rules)`
  );
  const explicitAllowEgress = networkPolicies.some((np) => {
    const spec = np.spec as { egress?: unknown[] } | undefined;
    return Array.isArray(spec?.egress) && spec!.egress!.length > 0;
  });
  assert(
    explicitAllowEgress,
    `[${label}] expected at least one NetworkPolicy with an explicit egress allow (e.g. DNS)`
  );

  // Executor egress allowlist. See docs/helm-verify.md §28.
  {
    const envOf = (doc: unknown) =>
      (podSpecOf(doc as never)?.containers ?? []).flatMap((c) => c.env ?? []);
    const apiEgressEnv = envOf(apiDeploy).find((e) => e.name === "SCP_INTERNAL_EGRESS_HOSTS");
    const workerEgressEnv = envOf(workerDeploy).find((e) => e.name === "SCP_INTERNAL_EGRESS_HOSTS");
    if (label === "defaults") {
      assert(
        !apiEgressEnv && !workerEgressEnv,
        `[${label}] internalEgressHosts is empty by default — SCP_INTERNAL_EGRESS_HOSTS must NOT be rendered (the SSRF guard's deny posture must stay untouched)`
      );
    }
    if (label === "kitchen-sink") {
      assert(
        workerEgressEnv?.value === "argocd-server.argocd.svc.cluster.local",
        `[${label}] internalEgressHosts set but the worker Deployment's SCP_INTERNAL_EGRESS_HOSTS is ${JSON.stringify(workerEgressEnv?.value)}`
      );
      assert(
        apiEgressEnv?.value === "argocd-server.argocd.svc.cluster.local",
        `[${label}] internalEgressHosts set but the api Deployment's SCP_INTERNAL_EGRESS_HOSTS is ${JSON.stringify(apiEgressEnv?.value)}`
      );
    }
  }

  const executorPolicies = networkPolicies.filter((np) =>
    String(np.metadata?.name ?? "").includes("-allow-executor-")
  );
  if (label === "defaults") {
    assert(
      executorPolicies.length === 0,
      `[${label}] networkPolicy.executorEgress is empty by default — expected NO allow-executor-* NetworkPolicy, got ${executorPolicies.length}`
    );
  }
  if (label === "kitchen-sink") {
    const argocdExecPolicy = executorPolicies.find((np) =>
      String(np.metadata?.name ?? "").endsWith("-allow-executor-argocd")
    );
    assert(
      argocdExecPolicy,
      `[${label}] networkPolicy.executorEgress set but no allow-executor-argocd NetworkPolicy rendered`
    );
    if (argocdExecPolicy) {
      interface ExecEgressTo {
        namespaceSelector?: { matchLabels?: Record<string, string> };
        ipBlock?: { cidr?: string };
      }
      const spec = argocdExecPolicy.spec as
        { egress?: { to?: ExecEgressTo[]; ports?: { port?: number }[] }[] } | undefined;
      const rule = spec?.egress?.[0];
      assert(
        Array.isArray(rule?.to) &&
          rule!.to!.some(
            (t) => t.namespaceSelector?.matchLabels?.["kubernetes.io/metadata.name"] === "argocd"
          ),
        `[${label}] allow-executor-argocd must carry a namespaceSelector 'to' entry for namespace argocd`
      );
      assert(
        Array.isArray(rule?.to) && rule!.to!.some((t) => t.ipBlock?.cidr === "203.0.113.0/24"),
        `[${label}] allow-executor-argocd must carry an ipBlock 'to' entry for the configured CIDR`
      );
      assert(
        Array.isArray(rule?.ports) &&
          rule!.ports!.some((p) => p.port === 8080) &&
          rule!.ports!.some((p) => p.port === 80),
        `[${label}] allow-executor-argocd must carry the configured ports (8080, 80)`
      );
    }
  }

  // Adversarial review MAJOR #2. See docs/helm-verify.md §29.
  interface EgressRule {
    to?: unknown[];
    ports?: { port?: number }[];
  }
  const dbPorts = new Set([5432, 4222]);
  for (const np of networkPolicies) {
    const name = String(np.metadata?.name ?? "");
    if (!/allow-(postgres|nats)/.test(name)) continue;
    const spec = np.spec as { egress?: EgressRule[] } | undefined;
    for (const rule of spec?.egress ?? []) {
      const touchesDbPort = (rule.ports ?? []).some(
        (p) => typeof p.port === "number" && dbPorts.has(p.port)
      );
      if (!touchesDbPort) continue;
      assert(
        Array.isArray(rule.to) && rule.to.length > 0,
        `[${label}] NetworkPolicy/${name}: a DB-port egress rule has no 'to' at all — this allows egress to ANY destination (including the public internet), not just the intended private-range/CIDR default`
      );
    }
  }
}

/**
 * M28.4 (ADR-0055) — WHAT THE SCP ACCOUNT MAY DO IN THE BUNDLED ARGO CD, parsed the way Argo CD
 * parses it. The first version of this check kept only lines beginning with the literal
 * `"p, scp-coordinator,"`, so `g, scp-coordinator, role:admin`, an unspaced
 * `p,scp-coordinator,applications,action/*,*\/*,allow`, a permissive `policy.default` and a
 * `policy.<overlay>.csv` key all passed it. Now: every `policy*.csv` key is read, every line is
 * split on commas and trimmed (Casbin's own tokenisation), comments are dropped, and the account's
 * `p` grants, its `g` bindings and `policy.default` are all returned for the caller to pin EXACTLY.
 */
function scpArgoCdPolicy(
  data: Record<string, string> | undefined,
  account = "scp-coordinator"
): { grants: string[]; bindings: string[]; policyDefault: string } {
  const grants: string[] = [];
  const bindings: string[] = [];
  for (const [key, value] of Object.entries(data ?? {})) {
    if (!/^policy(\..+)?\.csv$/.test(key)) continue;
    for (const raw of value.split("\n")) {
      const line = raw.replace(/#.*$/, "").trim();
      if (!line) continue;
      const fields = line.split(",").map((f) => f.trim());
      if (fields[0] === "p" && fields[1] === account) grants.push(fields.join(", "));
      if (fields[0] === "g" && fields.slice(1).includes(account)) bindings.push(fields.join(", "));
    }
  }
  return {
    grants: grants.sort(),
    bindings,
    policyDefault: (data?.["policy.default"] ?? "").trim()
  };
}

/** Known-positive controls for `scpArgoCdPolicy`, run on every helm-verify: a parser that cannot
 *  see these would pass a chart that grants them (the "claim about a tool" rule, CLAUDE.md). */
function selfTestScpArgoCdPolicy(): void {
  const cases: [
    string,
    Record<string, string>,
    (p: ReturnType<typeof scpArgoCdPolicy>) => boolean
  ][] = [
    [
      "g binding",
      { "policy.csv": "g, scp-coordinator, role:admin" },
      (p) => p.bindings.length === 1
    ],
    [
      "unspaced grant",
      { "policy.csv": "p,scp-coordinator,applications,action/*,*/*,allow" },
      (p) => p.grants.includes("p, scp-coordinator, applications, action/*, */*, allow")
    ],
    [
      "overlay key",
      { "policy.extra.csv": "p, scp-coordinator, applications, delete, */*, allow" },
      (p) => p.grants.length === 1
    ],
    [
      "permissive default",
      { "policy.default": "role:admin" },
      (p) => p.policyDefault === "role:admin"
    ]
  ];
  for (const [what, data, seen] of cases) {
    assert(
      seen(scpArgoCdPolicy(data)),
      `[argocd-rbac self-test] the policy parser cannot see a ${what}`
    );
  }
}

/** Pins the SCP account's Argo CD authority EXACTLY. `authoringProject` null ⇒ read/sync only. */
function verifyScpArgoCdGrants(
  docs: K8sDoc[],
  label: string,
  authoringProject: string | null
): void {
  const rbacCm = docs.find(
    (d) => d.kind === "ConfigMap" && d.metadata?.name === "argocd-rbac-cm"
  ) as (K8sDoc & { data?: Record<string, string> }) | undefined;
  assert(rbacCm, `[${label}] bundled Argo CD rendered no argocd-rbac-cm`);
  const policy = scpArgoCdPolicy(rbacCm?.data);
  const expectedGrants = [
    ...(authoringProject
      ? [
          `p, scp-coordinator, applications, create, ${authoringProject}/*, allow`,
          `p, scp-coordinator, applications, update, ${authoringProject}/*, allow`
        ]
      : []),
    "p, scp-coordinator, applications, get, */*, allow",
    "p, scp-coordinator, applications, sync, */*, allow"
  ].sort();
  assert(
    JSON.stringify(policy.grants) === JSON.stringify(expectedGrants),
    `[${label}] bundled Argo CD grants the SCP account ${JSON.stringify(policy.grants)}; expected exactly ${JSON.stringify(expectedGrants)} — anything beyond get/sync everywhere and create/update in the authoring project lets SCP drive a Rollout (ADR-0008 §3) or reach the cluster (ADR-0055)`
  );
  assert(
    policy.bindings.length === 0,
    `[${label}] the SCP account is bound to a role (${policy.bindings.join("; ")}) — its authority must be exactly its own p-lines`
  );
  assert(
    policy.policyDefault === "",
    `[${label}] argocd-rbac-cm sets policy.default '${policy.policyDefault}', which every account (SCP's included) inherits`
  );
}

/** The dedicated authoring AppProject, pinned EXACTLY (ADR-0055 D2). */
function verifyAuthoringProject(
  docs: K8sDoc[],
  label: string,
  expected: { project: string; carrierRepoURL: string; namespaces: string[] }
): void {
  const projects = docs.filter((d) => d.kind === "AppProject");
  assert(
    projects.length === 1,
    `[${label}] expected exactly one AppProject, got ${projects.length}`
  );
  const spec = (projects[0]?.spec ?? {}) as Record<string, unknown>;
  assert(
    projects[0]?.metadata?.name === expected.project,
    `[${label}] AppProject is not named '${expected.project}'`
  );
  const want = {
    sourceRepos: [expected.carrierRepoURL],
    destinations: expected.namespaces.map((namespace) => ({
      server: "https://kubernetes.default.svc",
      namespace
    })),
    clusterResourceWhitelist: [],
    namespaceResourceWhitelist: [
      { group: "argoproj.io", kind: "Rollout" },
      { group: "", kind: "Service" }
    ]
  };
  const got = {
    sourceRepos: spec.sourceRepos,
    destinations: spec.destinations,
    clusterResourceWhitelist: spec.clusterResourceWhitelist,
    namespaceResourceWhitelist: spec.namespaceResourceWhitelist
  };
  assert(
    JSON.stringify(got) === JSON.stringify(want),
    `[${label}] the authoring AppProject is ${JSON.stringify(got)}; expected exactly ${JSON.stringify(want)} — any wider and SCP's token is cluster-admin by proxy through Argo CD's controller`
  );
  const extraKeys = Object.keys(spec).filter(
    (k) => !["description", ...Object.keys(want)].includes(k)
  );
  assert(
    extraKeys.length === 0,
    `[${label}] the authoring AppProject carries unexpected spec keys ${extraKeys.join(", ")}`
  );
}

/** Assertions for the SEPARATE bundled-backends chart. See docs/helm-verify.md §30. */
function verifyBundledChart(docs: K8sDoc[]): void {
  const label = "bundled";
  const bundledNamespaces = ["scp-argocd", "scp-argo-workflows", "scp-argo-events", "scp-gitea"];
  const bundled = docs.filter((d) => bundledNamespaces.includes(d.metadata?.namespace ?? ""));

  // Every enabled backend renders at least one resource in its own namespace, and Argo CD's server.
  assert(
    bundled.some((d) => d.kind === "Deployment" && d.metadata?.name === "argocd-server"),
    `[${label}] bundled Argo CD enabled but no argocd-server Deployment in scp-argocd`
  );
  // Bundled Gitea (the default unified registry, ADR-0012): its Deployment must render into
  // scp-gitea, and its SCP-generated admin secret (gitea-admin-secret) must be present (the vendored
  // manifest strips every upstream Secret — gitea-secrets.yaml regenerates them per install).
  assert(
    bundled.some((d) => d.kind === "Deployment" && d.metadata?.name === "scp-gitea"),
    `[${label}] bundled Gitea enabled but no scp-gitea Deployment in scp-gitea`
  );
  assert(
    bundled.some((d) => d.kind === "Secret" && d.metadata?.name === "gitea-admin-secret"),
    `[${label}] bundled Gitea enabled but no SCP-generated gitea-admin-secret in scp-gitea`
  );
  for (const ns of bundledNamespaces) {
    assert(
      bundled.some((d) => d.metadata?.namespace === ns),
      `[${label}] bundled backend namespace '${ns}' rendered no resources`
    );
  }

  // M28.4 (ADR-0055) — ADR-0008 §3 AT THE CREDENTIAL. SCP's Argo CD account may read and sync
  // everything and create/update Applications in the authoring project; it may never run a resource
  // action (Argo Rollouts' promote/abort/retry/restart/pause/resume), patch or delete a managed
  // resource (`update/*`, `delete`), or override. An allowlist of exact grants, not a denylist: a
  // grant nobody listed here is a failure.
  // Authoring is OFF by default: the account reads and syncs, and creates nothing.
  verifyScpArgoCdGrants(bundled, label, null);

  // Every image must be RETARGETED — an un-rewritten upstream ref 404s in an air-gapped registry.
  const bundledImages = bundled
    .flatMap((d) => {
      const ps = (d.spec as { template?: { spec?: PodSpec } } | undefined)?.template?.spec;
      return [...(ps?.containers ?? []), ...(ps?.initContainers ?? [])];
    })
    .map((c) => c.image)
    .filter((i): i is string => Boolean(i));
  assert(bundledImages.length > 0, `[${label}] bundled backends rendered no container images`);
  for (const img of bundledImages) {
    assert(
      !img.includes("quay.io/argoproj") &&
        !img.includes("public.ecr.aws") &&
        !img.includes("docker.gitea.com") &&
        !/(^|\/)busybox:/.test(img),
      `[${label}] bundled backend image '${img}' is NOT retargeted — the air-gap install.sh must rewrite every image to the customer registry (an upstream ref breaks air-gapped installs)`
    );
  }

  // M15.4 standing gate: run the federation-role guardrail on THIS render (default role=commander,
  // every backend enabled ⇒ all allowed ⇒ clean). Reads the role stamped on the Namespaces. Feeds
  // `fail()` — so if a future matrix change or template regression let a disallowed backend through
  // here, helm-verify exits non-zero. (The explicit disallowed-combo proof is in main(), below.)
  const role = renderedFederationRole(docs);
  for (const v of federationRoleViolations(role, docs)) {
    fail(`[${label}] federation-role guardrail (render-time lint): ${v}`);
  }
}

async function main(): Promise<void> {
  // SCP_HELM_VERIFY selects what a missing helm MEANS (2026-08-31). See docs/helm-verify.md §31.
  const mode = process.env["SCP_HELM_VERIFY"] ?? "";
  if (mode !== "" && mode !== "skip" && mode !== "require") {
    console.error(
      `helm-verify: FATAL — unknown SCP_HELM_VERIFY value '${mode}' (use skip|require, or unset for probe)`
    );
    process.exit(1);
  }
  if (mode === "skip") {
    console.log(
      "helm-verify: SKIP (SCP_HELM_VERIFY=skip) — this invocation deliberately does not run the " +
        "assertions; CI job 4b runs this exact script against a pinned helm with " +
        "SCP_HELM_VERIFY=require and is the gate."
    );
    return;
  }
  if (!helmAvailable()) {
    if (mode === "require") {
      console.error(
        "helm-verify: FATAL — SCP_HELM_VERIFY=require but 'helm' is not on PATH. This invocation " +
          "is the gate (CI job 4b installs a pinned helm first); a missing binary here means the " +
          "install step broke, and skipping would be a green job that asserted nothing."
      );
      process.exit(1);
    }
    console.log(
      "helm-verify: SKIP — 'helm' not found on PATH (BUILD_AND_TEST.md §1 requires Helm 3.16+ to " +
        "run this check). The dedicated 'helm-verify' CI job installs a pinned Helm and runs this " +
        "exact script with SCP_HELM_VERIFY=require. To run it yourself, install Helm and re-run " +
        "`pnpm --filter @scp/helm-verify test`."
    );
    return;
  }

  console.log(`helm-verify: rendering ${CHART_DIR} with default values...`);
  verifyRender("defaults", renderChart("verify-defaults", []));

  console.log("helm-verify: rendering with every optional feature toggled on (kitchen sink)...");
  verifyRender(
    "kitchen-sink",
    renderChart("verify-kitchen-sink", [
      "--set",
      "postgres.evalInCluster.enabled=true",
      "--set",
      "managedIac.enabled=true",
      "--set",
      "managedIac.runnerImage=ghcr.io/commanderscp/scp-runner-iac:0.1.0",
      "--set",
      "federation.mtls.enabled=true",
      "--set",
      "federation.mtls.existingSecret=my-fed-cert",
      "--set",
      "federation.serverMtls.enabled=true",
      "--set",
      "federation.serverMtls.existingSecret=my-fed-server-mtls",
      "--set",
      "federation.serverMtls.crl.enabled=true",
      "--set",
      "federation.serverMtls.crl.existingSecret=my-fed-server-mtls-crl",
      "--set",
      "ingress.enabled=true",
      "--set",
      "ingress.host=scp.example.com",
      "--set",
      "ingress.mtls.enabled=true",
      "--set",
      "ingress.mtls.caSecretName=fed-ca",
      "--set",
      "serviceMonitor.enabled=true",
      "--set",
      "objectStorage.provider=s3",
      "--set",
      "eventBus.backend=nats",
      "--set",
      "eventBus.natsUrl=nats://nats:4222",
      "--set",
      "worker.hpa.enabled=true",
      "--set",
      "oidc.enabled=true",
      "--set",
      "oidc.issuer=https://idp.example.com",
      "--set",
      "oidc.clientId=scp",
      "--set",
      "oidc.redirectUri=https://scp.example.com/callback",
      // M29.1 (ADR-0058 "the default flip", ADR-0060): stackd.enabled REFUSES to render together
      // with federation.serverMtls.enabled (above) — a real, deliberate guard (stackd dials scpd
      // in-cluster over plain HTTP; serverMtls turns scpd's whole listener into HTTPS). That
      // combination is not what THIS render is testing — every stackd-specific combination is
      // exercised in its own dedicated renders in stackd.ts — so it is turned off here, the same
      // way any other render that wants a DIFFERENT combo than the default carries its own --set.
      // The bundledExecutor.{argocd,gitea,argoWorkflows} block this render used to also turn on is
      // gone (M29.2, ADR-0061): those values no longer exist in this chart at all — the stack
      // controller installs and wires bundled backends now, verified in stackd.ts instead.
      "--set",
      "stackd.enabled=false",
      // Executor egress allowlist (Mode A / BYO-coordinate) — one entry exercising BOTH `to` shapes
      // at once (an in-cluster namespaceSelector AND an external ipBlock) plus multiple ports.
      "--set-json",
      'networkPolicy.executorEgress=[{"name":"argocd","namespaces":["argocd"],"cidrs":["203.0.113.0/24"],"ports":[{"protocol":"TCP","port":8080},{"protocol":"TCP","port":80}]}]',
      // Operator half of the two-layer internal-egress model (ADR-0003) — the application-layer SSRF
      // guard's hard boundary. Pairs with networkPolicy.executorEgress above: the same "what may this
      // pod reach" decision, enforced once at the k8s layer and once inside the plugin host.
      "--set-json",
      'internalEgressHosts=["argocd-server.argocd.svc.cluster.local"]'
    ])
  );

  // postgres.evalInCluster.resources OVERRIDE PROOF (2026-09-17 incident). "kitchen-sink" above
  // already proves the chart's OWN default lands on the container; this proves an operator override
  // reaches the SAME place, verbatim — the same "both ways" shape every other value in this file
  // gets (absent/default on one render, present and correct when set on another).
  console.log("helm-verify: checking postgres.evalInCluster.resources overrides the container...");
  {
    const label = "postgres-eval-resources-override";
    const docs = renderChart("verify-postgres-eval-resources", [
      "--set",
      "postgres.evalInCluster.enabled=true",
      "--set",
      "postgres.evalInCluster.resources.requests.cpu=100m",
      "--set",
      "postgres.evalInCluster.resources.requests.memory=512Mi",
      "--set",
      "postgres.evalInCluster.resources.limits.memory=1Gi"
    ]);
    const deploy = docs.find(
      (d) => d.kind === "Deployment" && String(d.metadata?.name).endsWith("-postgres-eval")
    );
    assert(deploy, `[${label}] expected a postgres-eval Deployment in this render`);
    const container =
      deploy && (podSpecOf(deploy)?.containers ?? []).find((c) => c.name === "postgres");
    assert(container, `[${label}] expected a 'postgres' container in the postgres-eval Deployment`);
    if (container) {
      assert(
        container.resources?.requests?.["cpu"] === "100m" &&
          container.resources?.requests?.["memory"] === "512Mi" &&
          container.resources?.limits?.["memory"] === "1Gi",
        `[${label}] postgres.evalInCluster.resources does not reach the postgres-eval container verbatim (got ${JSON.stringify(container.resources)})`
      );
    }
  }

  // M29.2 (ADR-0061): THE EGRESS POLICY THE STACK CONTROLLER WRITES, against the REAL render.
  // The controller derives each wired backend's scpd egress NetworkPolicy from that backend's own
  // rendered Service (`backendEndpoint` + `egressPolicy`, apps/stackd/src/wiring.ts). Held here to
  // the property the old allow-<backend> rules had to be hand-kept to: the policy opens the
  // CONTAINER port (the post-DNAT destination — argocd-server's 8080, not the Service's 80, which is
  // what cost the air-gap drill every run) and selects the pods that actually serve it.
  console.log(
    "helm-verify: checking the stack controller's per-backend egress policy against the real renders..."
  );
  {
    const stackRelease = await loadRelease({ chartDir: BUNDLED_CHART_DIR, version: "verify" });
    for (const [be, key] of [
      ["argocd", "argocd"],
      ["gitea", "gitea"],
      ["argo-workflows", "argoWorkflows"]
    ] as const) {
      const backendDocs = renderBundledChart([
        `--set`,
        `bundledExecutor.${key}.enabled=true`,
        `--set`,
        `bundledExecutor.scpNamespace=verify-scp-ns`
      ]);
      // EVERY RENDERED DOC MUST CARRY AN apiVersion. See docs/helm-verify.md §34.
      for (const doc of backendDocs) {
        assert(
          typeof doc.apiVersion === "string" && doc.apiVersion.length > 0,
          `[bundled ${be} render] a document has NO apiVersion (kind=${String(doc.kind)}, ` +
            `name=${String(doc.metadata?.name)}). kubectl apply rejects the entire stream on this, so ` +
            `the whole backend fails to install. The usual cause is Go-template whitespace chomping ` +
            `gluing a document's first line onto a preceding comment — check '{{- end -}}' vs ` +
            `'{{- end }}' where the emitting helper starts its output.`
        );
      }
      let ep;
      try {
        ep = backendEndpoint(stackRelease, be, backendDocs as unknown as KubeObject[]);
      } catch (err) {
        fail(`[${be} egress] ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (!ep) {
        fail(`[${be} egress] the controller derives no endpoint for ${be}`);
        continue;
      }
      const policy = egressPolicy(
        "verify-scp-ns",
        { "app.kubernetes.io/name": "commanderscp" },
        be,
        ep
      );
      const rule = (
        policy["spec"] as {
          egress: { to: { podSelector: LabelSelector }[]; ports: { port: number }[] }[];
        }
      ).egress[0]!;
      const servers = backendDocs.filter(
        (d) =>
          (d.kind === "Deployment" || d.kind === "StatefulSet") &&
          selectorSelects(rule.to[0]!.podSelector, podTemplateLabelsOf(d))
      );
      assert(
        servers.length >= 1,
        `[${be} egress] the controller's egress policy selects no Deployment in the ${be} render — it would open a door to nothing`
      );
      const containerPorts = servers.flatMap((d) =>
        (podSpecOf(d)?.containers ?? []).flatMap((c) =>
          ((c as { ports?: { containerPort?: number }[] }).ports ?? []).map((p) => p.containerPort)
        )
      );
      const opened = rule.ports.map((p) => p.port);
      assert(
        opened.length === 1 && containerPorts.includes(opened[0]!),
        `[${be} egress] the controller's egress policy opens ${JSON.stringify(opened)}, but the pods it selects listen on ${JSON.stringify(containerPorts)} — a NetworkPolicy is matched AFTER the Service's DNAT, so it must open the container port`
      );
      console.log(
        `  ${be}: egress policy -> ${ep.serverUrl} opens container port ${opened[0]} on ${servers.map((d) => d.metadata?.name).join(", ")} — OK`
      );
    }
  }

  // The chart's role value must reach the api and worker pods. See docs/helm-verify.md §40.
  console.log(
    "helm-verify: checking the main chart wires SCP_FEDERATION_ROLE through to api/worker..."
  );
  {
    const roleLabel = "federation-role-runtime-env";
    function scpFederationRoleEnvOf(docs: K8sDoc[], deploymentName: string): string | undefined {
      const doc = docs.find((d) => d.kind === "Deployment" && d.metadata?.name === deploymentName);
      const containers = podSpecOf(doc ?? ({} as K8sDoc))?.containers ?? [];
      for (const c of containers) {
        const found = c.env?.find((e) => e.name === "SCP_FEDERATION_ROLE");
        if (found) return found.value;
      }
      return undefined;
    }

    // Same release name for both renders below (helm template doesn't require uniqueness across
    // separate invocations) — `commanderscp.fullname` is a function of `.Release.Name`, so a
    // differing release name would differ the Deployment name too and break the by-name lookup.
    const releaseName = "verify-fedrole";

    const defaultDocs = renderChart(releaseName, []);
    const apiName = defaultDocs.find(
      (d) => d.kind === "Deployment" && d.metadata?.name?.endsWith("-api")
    )?.metadata?.name;
    const workerName = defaultDocs.find(
      (d) => d.kind === "Deployment" && d.metadata?.name?.endsWith("-worker")
    )?.metadata?.name;
    assert(
      !!apiName && scpFederationRoleEnvOf(defaultDocs, apiName) === "commander",
      `[${roleLabel}] default render (federationRole unset) must carry SCP_FEDERATION_ROLE=commander on the api Deployment`
    );
    assert(
      !!workerName && scpFederationRoleEnvOf(defaultDocs, workerName) === "commander",
      `[${roleLabel}] default render (federationRole unset) must carry SCP_FEDERATION_ROLE=commander on the worker Deployment`
    );

    const retransDocs = renderChart(releaseName, ["--set", "federationRole=retrans"]);
    assert(
      scpFederationRoleEnvOf(retransDocs, apiName ?? "") === "retrans",
      `[${roleLabel}] federationRole=retrans render must carry SCP_FEDERATION_ROLE=retrans on the api Deployment (the value app.ts gates SPA registration on)`
    );
    assert(
      scpFederationRoleEnvOf(retransDocs, workerName ?? "") === "retrans",
      `[${roleLabel}] federationRole=retrans render must carry SCP_FEDERATION_ROLE=retrans on the worker Deployment`
    );
    console.log(
      `  SCP_FEDERATION_ROLE present + correct on both Deployments for default and retrans renders`
    );
  }

  // OPERATOR CONFIG SURFACE. See docs/helm-verify.md §41.
  console.log(
    "helm-verify: checking the operator config surface (loops, allowlists, operator token)..."
  );
  {
    const envLabel = "operator-config-surface";
    const releaseName = "verify-opsurface";

    function envOf(docs: K8sDoc[], suffix: string, name: string): EnvVar | undefined {
      const doc = docs.find((d) => d.kind === "Deployment" && d.metadata?.name?.endsWith(suffix));
      for (const c of podSpecOf(doc ?? ({} as K8sDoc))?.containers ?? []) {
        const found = c.env?.find((e) => e.name === name);
        if (found) return found;
      }
      return undefined;
    }
    /** Assert on BOTH Deployments — a knob wired into only one of them is a silent half-fix (the
     *  loops run on the worker, but an `api.role=all` pod runs them too). */
    function bothHave(docs: K8sDoc[], name: string, expected: string): void {
      for (const suffix of ["-api", "-worker"]) {
        const found = envOf(docs, suffix, name);
        assert(
          found?.value === expected,
          `[${envLabel}] ${name} must be ${expected} on the ${suffix.slice(1)} Deployment, got ${found?.value ?? "<absent>"}`
        );
      }
    }
    function neitherHas(docs: K8sDoc[], name: string): void {
      for (const suffix of ["-api", "-worker"]) {
        assert(
          envOf(docs, suffix, name) === undefined,
          `[${envLabel}] ${name} must be ABSENT from the ${suffix.slice(1)} Deployment on a default render — an unconfigured instance must not opt itself into it`
        );
      }
    }

    const OPT_IN_VARS = [
      "SCP_INBOX_LOOP",
      "SCP_INBOX_TICK_INTERVAL_SECONDS",
      "SCP_RETRANS_AUTO_RELAY",
      "SCP_RETRANS_AUTO_RELAY_INTERVAL_SECONDS",
      "SCP_RETRANS_AUTO_RELAY_MAX_ATTEMPTS",
      "SCP_RETRANS_AUTO_RELAY_LEASE_SECONDS",
      "SCP_FEDERATION_SYNC_LOOP",
      "SCP_FEDERATION_SYNC_INTERVAL_SECONDS",
      "SCP_FEDERATION_SYNC_SPARSE_INTERVAL_SECONDS",
      "SCP_OPERATOR_TOKEN",
      "SCP_OPERATOR_DATABASE_URL",
      "SCP_ARTIFACT_OCI_REGISTRY_HOSTS",
      "SCP_ARTIFACT_BLOB_BASE_URLS",
      "SCP_ARTIFACT_INSECURE_HOSTS",
      "SCP_INTERNAL_BASE_URL",
      "SCP_PUBLIC_BASE_URL"
    ];

    const defaultDocs = renderChart(releaseName, []);
    for (const v of OPT_IN_VARS) neitherHas(defaultDocs, v);
    // The api role default, and that it is a VALUE now rather than the old hardcoded literal.
    for (const suffix of ["-api", "-worker"]) {
      const expected = suffix === "-api" ? "api" : "worker";
      assert(
        envOf(defaultDocs, suffix, "SCP_ROLE")?.value === expected,
        `[${envLabel}] default render must carry SCP_ROLE=${expected} on the ${suffix.slice(1)} Deployment`
      );
    }
    console.log(
      `  default render: all ${OPT_IN_VARS.length} opt-in vars absent, SCP_ROLE api/worker`
    );

    const onDocs = renderChart(releaseName, [
      "--set",
      "federationRole=retrans",
      "--set",
      "api.role=all",
      "--set",
      "internalBaseUrl=https://scp.example.com/api/v1",
      "--set",
      "publicBaseUrl=https://scp.example.com",
      "--set",
      "federation.sync.enabled=true",
      "--set",
      "federation.sync.intervalSeconds=30",
      "--set",
      "federation.sync.sparseIntervalSeconds=1800",
      "--set",
      "federation.relay.inbox.enabled=true",
      "--set",
      "federation.relay.inbox.tickIntervalSeconds=45",
      "--set",
      "federation.relay.autoRelay.enabled=true",
      "--set",
      "federation.relay.autoRelay.intervalSeconds=90",
      "--set",
      "federation.relay.autoRelay.maxAttempts=3",
      "--set",
      "federation.relay.autoRelay.leaseSeconds=7200",
      "--set",
      "artifactChannel.ociRegistryHosts={reg.example.com:5000,mirror.example.com}",
      "--set",
      "artifactChannel.blobBaseUrls={https://blobs.example.com}",
      "--set",
      "artifactChannel.insecureHosts={reg.example.com:5000}"
    ]);
    bothHave(onDocs, "SCP_FEDERATION_SYNC_LOOP", "1");
    bothHave(onDocs, "SCP_FEDERATION_SYNC_INTERVAL_SECONDS", "30");
    bothHave(onDocs, "SCP_FEDERATION_SYNC_SPARSE_INTERVAL_SECONDS", "1800");
    bothHave(onDocs, "SCP_INBOX_LOOP", "1");
    bothHave(onDocs, "SCP_INBOX_TICK_INTERVAL_SECONDS", "45");
    bothHave(onDocs, "SCP_RETRANS_AUTO_RELAY", "1");
    bothHave(onDocs, "SCP_RETRANS_AUTO_RELAY_INTERVAL_SECONDS", "90");
    bothHave(onDocs, "SCP_RETRANS_AUTO_RELAY_MAX_ATTEMPTS", "3");
    bothHave(onDocs, "SCP_RETRANS_AUTO_RELAY_LEASE_SECONDS", "7200");
    bothHave(onDocs, "SCP_INTERNAL_BASE_URL", "https://scp.example.com/api/v1");
    bothHave(onDocs, "SCP_PUBLIC_BASE_URL", "https://scp.example.com");
    // Comma-joined, in values order — the parse the server does (`parseRegistryHostList`).
    bothHave(onDocs, "SCP_ARTIFACT_OCI_REGISTRY_HOSTS", "reg.example.com:5000,mirror.example.com");
    bothHave(onDocs, "SCP_ARTIFACT_BLOB_BASE_URLS", "https://blobs.example.com");
    bothHave(onDocs, "SCP_ARTIFACT_INSECURE_HOSTS", "reg.example.com:5000");
    assert(
      envOf(onDocs, "-api", "SCP_ROLE")?.value === "all",
      `[${envLabel}] api.role=all must render SCP_ROLE=all on the api Deployment (the knob that unblocks POST /discovery/run on a two-Deployment install)`
    );
    console.log(`  enabled render: every knob present + correct on BOTH Deployments`);

    // The operator write surface needs two things, not one. See docs/helm-verify.md §42.
    function assertOperatorCredentialPairing(docs: K8sDoc[], what: string): void {
      for (const suffix of ["-api", "-worker"]) {
        const token = envOf(docs, suffix, "SCP_OPERATOR_TOKEN");
        const dbUrl = envOf(docs, suffix, "SCP_OPERATOR_DATABASE_URL");
        assert(
          (token === undefined) === (dbUrl === undefined),
          `[${envLabel}] ${what}: the ${suffix.slice(1)} Deployment carries SCP_OPERATOR_${token ? "TOKEN" : "DATABASE_URL"} but not SCP_OPERATOR_${token ? "DATABASE_URL" : "TOKEN"} — the operator write door needs BOTH (the token authorizes the caller; the connection is what lets the server execute the write). A pod with only the token 503s on every operator write`
        );
      }
    }
    assertOperatorCredentialPairing(defaultDocs, "default render");
    assertOperatorCredentialPairing(onDocs, "every-knob-on render");

    // Both are secretKeyRefs, never literals — either one rendered as a plain env VALUE would sit
    // in the Deployment spec for anyone with `get deploy` (a shared secret, and a DB password).
    const opDocs = renderChart(releaseName, [
      "--set",
      "operatorApi.enabled=true",
      "--set",
      "appSecrets.existingSecret=scp-operator",
      "--set",
      "operatorApi.databaseUrlSecret=scp-operator-db"
    ]);
    assertOperatorCredentialPairing(opDocs, "operatorApi.enabled render");
    for (const suffix of ["-api", "-worker"]) {
      const found = envOf(opDocs, suffix, "SCP_OPERATOR_TOKEN");
      assert(
        found?.value === undefined && found?.valueFrom?.secretKeyRef?.name === "scp-operator",
        `[${envLabel}] SCP_OPERATOR_TOKEN must be a secretKeyRef (never a literal value) on the ${suffix.slice(1)} Deployment`
      );
      const dbUrl = envOf(opDocs, suffix, "SCP_OPERATOR_DATABASE_URL");
      assert(
        dbUrl?.value === undefined &&
          dbUrl?.valueFrom?.secretKeyRef?.name === "scp-operator-db" &&
          dbUrl?.valueFrom?.secretKeyRef?.key === "SCP_OPERATOR_DATABASE_URL",
        `[${envLabel}] SCP_OPERATOR_DATABASE_URL must be a secretKeyRef into operatorApi.databaseUrlSecret on the ${suffix.slice(1)} Deployment, got ${JSON.stringify(dbUrl)}`
      );
    }

    // FAIL-FAST GUARDS — all three must REFUSE to render. A typo'd role, an operator token with no
    // Secret behind it, or an enabled write surface with no database connection would otherwise
    // surface as a healthy-looking install that misbehaves at runtime (a 400 from /discovery/run;
    // a pod crash-looping on a missing secret key; a 503 on every operator write).
    for (const [args, what] of [
      [["--set", "api.role=worker"], "api.role=worker"],
      [
        ["--set", "operatorApi.enabled=true"],
        "operatorApi.enabled with no appSecrets.existingSecret"
      ],
      [
        ["--set", "operatorApi.enabled=true", "--set", "appSecrets.existingSecret=scp-operator"],
        "operatorApi.enabled with no operatorApi.databaseUrlSecret"
      ]
    ] as [string[], string][]) {
      let rendered = false;
      try {
        renderChart(releaseName, args);
        rendered = true;
      } catch {
        /* expected */
      }
      assert(!rendered, `[${envLabel}] ${what} must FAIL the render, not be silently ignored`);
    }
    console.log(
      `  operator token + database URL are paired secretKeyRefs; all three fail-fast guards refuse to render`
    );
  }

  // Size-regression guard: the MAIN chart's Helm release Secret must stay under Kubernetes' 1 MB
  // limit. Helm stores base64(gzip(whole chart)) in the release — a vendored backend manifest
  // creeping into deploy/helm would blow past 1 MB and break `helm install` outright (the M11
  // regression that motivated the deploy/helm-bundled split). Package + measure.
  console.log(
    "helm-verify: checking the main chart's packaged size stays under Helm's 1 MB release limit..."
  );
  const mainPkg = packagedChartBase64Size(CHART_DIR);
  assert(
    mainPkg < 1_048_576,
    `main chart packaged base64 size ${mainPkg} exceeds Kubernetes' 1 MB Secret limit — 'helm install' would fail; keep vendored backends in deploy/helm-bundled`
  );
  console.log(`  main chart ~${Math.round(mainPkg / 1024)} KB base64 (limit 1024 KB) — OK`);

  // Bundled-backends chart (deploy/helm-bundled): render with every backend enabled + images
  // retargeted, and assert isolation and image retargeting. (Harbor is REMOVED from the bundled
  // stack — Gitea is the default registry, ADR-0012; an existing Harbor is coordinated via import.)
  console.log("helm-verify: rendering the bundled-backends chart (deploy/helm-bundled)...");
  verifyBundledChart(
    renderBundledChart([
      "--set",
      "bundledExecutor.argocd.enabled=true",
      "--set",
      "bundledExecutor.argocd.image=registry.example.com/scp/argocd:v3.4.5",
      "--set",
      "bundledExecutor.argocd.valkeyImage=registry.example.com/scp/valkey:8.2.3",
      "--set",
      "bundledExecutor.argoWorkflows.enabled=true",
      "--set",
      // Required once the argo-server ingress policy is namespace-scoped; the chart fails closed
      // without it rather than falling back to "SCP's pod label in ANY namespace".
      "bundledExecutor.scpNamespace=verify-scp-ns",
      "--set",
      "bundledExecutor.argoWorkflows.serverImage=registry.example.com/scp/argocli:v4.0.7",
      "--set",
      "bundledExecutor.argoWorkflows.controllerImage=registry.example.com/scp/workflow-controller:v4.0.7",
      "--set",
      "bundledExecutor.argoEvents.enabled=true",
      "--set",
      "bundledExecutor.argoEvents.image=registry.example.com/scp/argo-events:v1.9.10",
      "--set",
      "bundledExecutor.gitea.enabled=true",
      "--set",
      "bundledExecutor.gitea.image=registry.example.com/scp/gitea:1.26.1-rootless"
    ])
  );

  // M28.4 (ADR-0055) — SCP-authored Applications: the dedicated AppProject and the exact grant set
  // when authoring is ON, and the chart's own refusals of every unscoped configuration.
  console.log("helm-verify: checking the bundled Argo CD authoring project (ADR-0055)...");
  {
    selfTestScpArgoCdPolicy();
    const base = [
      "--set",
      "bundledExecutor.argocd.enabled=true",
      "--set",
      "bundledExecutor.argocd.image=registry.example.com/scp/argocd:v3.4.5",
      "--set",
      "bundledExecutor.argocd.valkeyImage=registry.example.com/scp/valkey:8.2.3"
    ];
    const authoring = {
      project: "scp-authored",
      carrierRepoURL: "https://gitea.example/platform/gitops.git",
      namespaces: ["shop", "shop-gamma"]
    };
    const on = [
      ...base,
      "--set",
      `bundledExecutor.argocd.authoring.project=${authoring.project}`,
      "--set",
      `bundledExecutor.argocd.authoring.carrierRepoURL=${authoring.carrierRepoURL}`,
      "--set",
      `bundledExecutor.argocd.authoring.namespaces={${authoring.namespaces.join(",")}}`
    ];
    const docs = renderBundledChart(on);
    verifyScpArgoCdGrants(docs, "authoring", authoring.project);
    verifyAuthoringProject(docs, "authoring", authoring);
    // Authoring OFF renders no project at all.
    assert(
      renderBundledChart(base).every((d) => d.kind !== "AppProject"),
      "[authoring] authoring disabled must render no AppProject"
    );
    // Every unscoped configuration is REFUSED at render, not rendered and trusted.
    const refusals: [string, string[]][] = [
      [
        "the unscoped default project",
        ["--set", "bundledExecutor.argocd.authoring.project=default"]
      ],
      ["kube-system", ["--set", "bundledExecutor.argocd.authoring.namespaces={kube-system}"]],
      [
        "Argo CD's own namespace",
        ["--set", "bundledExecutor.argocd.authoring.namespaces={scp-argocd}"]
      ],
      [
        "a bundled backend's namespace",
        ["--set", "bundledExecutor.argocd.authoring.namespaces={scp-gitea}"]
      ],
      ["the default namespace", ["--set", "bundledExecutor.argocd.authoring.namespaces={default}"]],
      ["no carrier", ["--set", "bundledExecutor.argocd.authoring.carrierRepoURL="]],
      ["no namespaces", ["--set", "bundledExecutor.argocd.authoring.namespaces=null"]]
    ];
    for (const [what, override] of refusals) {
      let refused = false;
      try {
        renderRaw(BUNDLED_CHART_DIR, "scp-bundled", [...on, ...override]);
      } catch (err) {
        refused = /ADR-0055/.test(String((err as { stderr?: unknown }).stderr ?? err));
      }
      assert(
        refused,
        `[authoring] the chart must REFUSE ${what} with an ADR-0055 error, and rendered it`
      );
    }
    console.log(
      `  authoring project pinned exactly; ${refusals.length} unscoped configurations refused at render`
    );
  }

  // M15.4 federation-role guardrail (CHART-RENDER-TIME LINT, NOT runtime authority) — explicit
  // positive AND negative cases. The operator sets both federationRole and the enabled flags; this
  // lint catches the misconfiguration of a role enabling a backend it should not run.
  console.log(
    "helm-verify: checking the M15.4 federation-role bundled-backend guardrail (render-time lint)..."
  );
  {
    const guardLabel = "federation-role-guardrail";

    // POSITIVE: an `outpost` may run gitea + argocd (self-contained deploy target, ADR-0012). The
    // role label must be stamped on the render, and the guardrail must find ZERO violations.
    const okDocs = renderBundledChart([
      "--set",
      "federationRole=outpost",
      "--set",
      "bundledExecutor.gitea.enabled=true",
      "--set",
      "bundledExecutor.gitea.image=registry.example.com/scp/gitea:1.26.1-rootless",
      "--set",
      "bundledExecutor.argocd.enabled=true",
      "--set",
      "bundledExecutor.argocd.image=registry.example.com/scp/argocd:v3.4.5",
      "--set",
      "bundledExecutor.argocd.valkeyImage=registry.example.com/scp/valkey:8.2.3"
    ]);
    assert(
      renderedFederationRole(okDocs) === "outpost",
      `[${guardLabel}] federationRole=outpost must be stamped on the bundled-backend Namespaces (got '${renderedFederationRole(okDocs)}')`
    );
    const okViolations = federationRoleViolations("outpost", okDocs);
    assert(
      okViolations.length === 0,
      `[${guardLabel}] POSITIVE case (outpost + gitea/argocd) must render clean, but the guardrail flagged: ${okViolations.join("; ")}`
    );

    // A relay is a validate-and-forward node, and not the other. See docs/helm-verify.md §43.
    const badDocs = renderBundledChart([
      "--set",
      "federationRole=retrans",
      "--set",
      "bundledExecutor.gitea.enabled=true",
      "--set",
      "bundledExecutor.gitea.image=registry.example.com/scp/gitea:1.26.1-rootless"
    ]);
    const badViolations = federationRoleViolations("retrans", badDocs);
    assert(
      badViolations.length > 0,
      `[${guardLabel}] NEGATIVE case (retrans + gitea) MUST be flagged by the guardrail, but it returned no violations — the render-time lint is not firing`
    );
    assert(
      badViolations.some((v) => v.includes("retrans") && v.includes("gitea")),
      `[${guardLabel}] NEGATIVE case violation must name both the role (retrans) and the offending backend (gitea); got: ${badViolations.join("; ")}`
    );
    // And prove it reaches the process exit path: the same detector, fed to fail(), would set a
    // non-zero exit. We simulate the standing-gate wiring against this disallowed render and confirm
    // it would contribute at least one failure (without polluting the real suite tally).
    const wouldFail: string[] = [];
    for (const v of federationRoleViolations(renderedFederationRole(badDocs), badDocs))
      wouldFail.push(v);
    assert(
      wouldFail.length > 0,
      `[${guardLabel}] a disallowed (role, enabled-backends) render must produce a helm-verify failure (non-zero exit); it produced none`
    );
    console.log(
      `  positive (outpost + gitea/argocd) clean; negative (retrans + gitea) correctly flagged: "${badViolations[0]}"`
    );
  }

  // The Kubernetes runner launcher's chart contract. See docs/helm-verify.md §44.
  {
    const label = "M23.2 runner launcher";
    console.log("helm-verify: checking the M23.2 Kubernetes runner-launcher chart contract...");

    // (1) THE DEFAULT IS UNCHANGED. Every deployment that does not opt in must render exactly what
    //     it rendered before: no launcher vars, no API allow, and the hardened token default.
    const defaults = renderChart("verify-m23-default", []);
    const defaultWorker = defaults.find(
      (d) => d.kind === "Deployment" && String(d.metadata?.name ?? "").endsWith("-worker")
    );
    assert(defaultWorker, `[${label}] no worker Deployment in the default render`);
    const defaultSpec = defaultWorker ? podSpecOf(defaultWorker) : undefined;
    assert(
      defaultSpec?.automountServiceAccountToken === false,
      `[${label}] the worker mounts a service-account token by DEFAULT — the hardened default must be unchanged for a deployment that launches no managed runner`
    );
    assert(
      !JSON.stringify(defaults).includes("SCP_MANAGED_RUNNER_LAUNCHER"),
      `[${label}] the default render carries Kubernetes launcher settings; a docker deployment must carry no Kubernetes surface at all`
    );
    assert(
      !defaults.some((d) => String(d.metadata?.name ?? "").includes("allow-kube-api-runner")),
      `[${label}] the default render emits an API-server egress allow for the SCP pods; that must appear only where a runner can launch`
    );

    // (2) SELECTED: the token, the egress allow, the volume and the settings all arrive TOGETHER.
    //     They are derived from one condition on purpose — three that can drift is how a deployment
    //     ends up with a launcher setting and no token, which fails at the first API call.
    const k8s = renderChart("verify-m23-k8s", [
      "--set",
      "managedRunners.launcher=kubernetes",
      "--set",
      "managedRunners.kubernetes.workspace.claimName=scp-runner-rwx",
      // M23.5 MEDIUM-7 — `perRunSecrets` defaults `true`, and since that render-time guard was
      // added an empty `namespace` alongside it is a refusal, not a render. This render is testing
      // the token/egress/volume contract, not that guard (which has its own case below), so it
      // states a runner namespace the same way `values.yaml` recommends operators do.
      "--set",
      "managedRunners.kubernetes.namespace=scp-runners",
      "--set",
      "managedIac.enabled=true",
      "--set",
      "managedIac.runnerImage=ghcr.io/commanderscp/scp-runner-iac:0.1.0"
    ]);
    const worker = k8s.find(
      (d) => d.kind === "Deployment" && String(d.metadata?.name ?? "").endsWith("-worker")
    );
    const workerSpec = worker ? podSpecOf(worker) : undefined;
    assert(
      workerSpec?.automountServiceAccountToken === true,
      `[${label}] the worker has NO service-account token with the Kubernetes launcher selected — every API call it makes would be anonymous`
    );
    const workerEnv = JSON.stringify(workerSpec?.containers ?? []);
    for (const key of [
      "SCP_MANAGED_RUNNER_LAUNCHER",
      "SCP_MANAGED_RUNNER_K8S_NAMESPACE",
      "SCP_MANAGED_RUNNER_K8S_WORKSPACE_ROOT",
      "SCP_MANAGED_RUNNER_K8S_WORKSPACE_CLAIM",
      "SCP_MANAGED_RUNNER_K8S_PER_RUN_SECRETS",
      // Node's global fetch cannot take a custom CA without an undici Agent, so without this the
      // adapter's every request fails TLS verification against the in-cluster API server.
      "NODE_EXTRA_CA_CERTS"
    ]) {
      assert(workerEnv.includes(key), `[${label}] the worker is missing ${key}`);
    }
    assert(
      workerEnv.includes("scp-runner-rwx") ||
        JSON.stringify(workerSpec?.volumes ?? []).includes("scp-runner-rwx"),
      `[${label}] the worker does not mount the shared runner workspace claim — the runner's inputs have nowhere to go`
    );
    // THE TWO CASES THE OLD EXPRESSION GOT WRONG, and they are here because the assertion above
    // SURVIVED the mutation that restores it. `automountServiceAccountToken: {{ .Values.managedIac
    // .enabled }}` is `true` in the render above too, so "the worker has a token" was passing for
    // the wrong reason. Each of these fails under that expression and passes under the real one.
    {
      // (a) managed-DEP only. The old expression keyed on managedIac ALONE, so enabling the bump
      //     actuator and nothing else gave the worker no token at all — M21's actuator dead on
      //     Kubernetes for the second time, by a different mechanism.
      const depOnly = renderChart("verify-m23-dep-only", [
        "--set",
        "managedRunners.launcher=kubernetes",
        "--set",
        "managedRunners.kubernetes.workspace.claimName=scp-runner-rwx",
        // See the comment on the `k8s` render above — M23.5 MEDIUM-7's guard fires here too since
        // `perRunSecrets` defaults true regardless of which managed class is enabled.
        "--set",
        "managedRunners.kubernetes.namespace=scp-runners",
        "--set",
        "managedDep.runnerImage=ghcr.io/commanderscp/scp-runner-dep:0.1.0"
      ]);
      const depWorker = depOnly.find(
        (d) => d.kind === "Deployment" && String(d.metadata?.name ?? "").endsWith("-worker")
      );
      assert(
        podSpecOf(depWorker!)?.automountServiceAccountToken === true,
        `[${label}] with only managed-dep enabled the worker has NO service-account token — the launcher condition is keyed on managed-IaC alone, which is the shape that left two of the three managed classes unable to authenticate`
      );
      // (b) THE DOCKER LAUNCHER WITH managed-IaC ON must NOT mount a token. It is surface for
      //     nothing there — no Kubernetes call is ever made — and the old expression granted it.
      const dockerIac = renderChart("verify-m23-docker-iac", [
        "--set",
        "managedIac.enabled=true",
        "--set",
        "managedIac.runnerImage=ghcr.io/commanderscp/scp-runner-iac:0.1.0"
      ]);
      const dockerWorker = dockerIac.find(
        (d) => d.kind === "Deployment" && String(d.metadata?.name ?? "").endsWith("-worker")
      );
      assert(
        podSpecOf(dockerWorker!)?.automountServiceAccountToken === false,
        `[${label}] the worker mounts a service-account token on a DOCKER-launcher deployment — an API credential for a pod that makes no API call`
      );
    }
    assert(
      k8s.some((d) => String(d.metadata?.name ?? "").includes("allow-kube-api-runner")),
      `[${label}] no API-server egress allow for the SCP pods. The chart's own -default-deny selects the worker (its comment records "api / worker / migrations / postgres-eval are NOT selected" as the BLAST RADIUS of the hook allow), so on any CNI that enforces policy every managed run would hang`
    );

    // The runner pod's own deny-all, proven to select the pod. See docs/helm-verify.md §45.
    {
      type NetworkPolicyDoc = K8sDoc & {
        spec?: {
          podSelector?: { matchLabels?: Record<string, string> };
          policyTypes?: string[];
          ingress?: unknown[];
          egress?: unknown[];
        };
      };
      const denyPolicy = k8s.find(
        (d) =>
          d.kind === "NetworkPolicy" &&
          String(d.metadata?.name ?? "").endsWith("-runner-network-none-deny")
      ) as NetworkPolicyDoc | undefined;
      assert(
        denyPolicy,
        `[${label}] no runner-network-none-deny NetworkPolicy rendered with the Kubernetes launcher selected — every managed run has unrestricted egress with a mounted credential on any CNI, the ADR-0035 §6a gap MEDIUM-10 fixed`
      );
      assert(
        denyPolicy?.metadata?.namespace === "scp-runners",
        `[${label}] the runner deny policy rendered into '${String(denyPolicy?.metadata?.namespace)}', not the runner namespace — a NetworkPolicy only applies within its own namespace, so this would select nothing`
      );
      assert(
        JSON.stringify([...(denyPolicy?.spec?.policyTypes ?? [])].sort()) ===
          '["Egress","Ingress"]' &&
          !denyPolicy?.spec?.ingress &&
          !denyPolicy?.spec?.egress,
        `[${label}] the runner deny policy is not deny-all in both directions (got policyTypes=${JSON.stringify(denyPolicy?.spec?.policyTypes)}, ingress=${JSON.stringify(denyPolicy?.spec?.ingress)}, egress=${JSON.stringify(denyPolicy?.spec?.egress)})`
      );

      // THE PROOF: build the SAME pod `jobManifest()` produces for a real run in this namespace,
      // and check the policy's `matchLabels` against its ACTUAL labels — the same subset test the
      // API server runs. A name-based assertion ("a policy called *-deny exists") cannot catch a
      // typo'd label value; this can.
      const runnerSpec: RunnerSpec = {
        runId: "verify-medium10",
        labels: {},
        image: "ghcr.io/commanderscp/scp-runner-iac:0.1.0",
        operands: ["apply"],
        networkMode: "none",
        env: [],
        secretEnv: [],
        copyIn: [],
        copyOut: undefined,
        timeoutMs: 600_000,
        maxBuffer: 32 * 1024 * 1024
      };
      const manifest = jobManifest(runnerSpec, {
        namespace: "scp-runners",
        jobName: "scp-runner-iac-verify-medium10",
        secretName: "scp-runner-iac-verify-medium10-env",
        reapDeadline: new Date().toISOString(),
        slots: new Map(),
        workspaceVolume: { kind: "hostPath", path: "/var/lib/scp/runner-workspace" },
        runAsNonRoot: false,
        ttlSecondsAfterFinished: 3_600
      }) as { spec: { template: { metadata: { labels: Record<string, string> } } } };
      const podLabels = manifest.spec.template.metadata.labels;
      const matchLabels = denyPolicy?.spec?.podSelector?.matchLabels ?? {};
      const selects = Object.entries(matchLabels).every(([k, v]) => podLabels[k] === v);
      assert(
        selects,
        `[${label}] the runner deny policy's podSelector ${JSON.stringify(matchLabels)} does NOT select a network-mode-none runner pod's actual labels ${JSON.stringify(podLabels)} — rendered but selecting nothing, ADR-0035 §6a's exact starting failure`
      );
    }

    // (3) THE PER-RUN SECRET GRANT. See docs/helm-verify.md §46.
    const runnerRole = (docs: K8sDoc[]) =>
      docs.find((d) => d.kind === "Role" && String(d.metadata?.name ?? "").endsWith("-runner-iac"));
    const roleOn = runnerRole(k8s);
    assert(roleOn, `[${label}] no runner Role rendered with the Kubernetes launcher selected`);
    // THE WHOLE ROLE, AS A SET, AGAINST WHAT THE ADAPTER ISSUES. See docs/helm-verify.md §47.
    {
      const problems = rbacDiff(roleOn?.rules, kubernetesRunnerRbac({ perRunSecrets: true }));
      assert(
        problems.length === 0,
        `[${label}] the runner Role is not what the adapter calls:\n    - ${problems.join("\n    - ")}\n  The expected set is kubernetesRunnerRbac() in @scp/runner-launcher, derived from the wire by kubernetes-rbac-contract.test.ts. Change the adapter and the declaration together, never the chart alone.`
      );
    }

    type Rule = { apiGroups?: string[]; resources?: string[]; verbs?: string[] };
    const secretRulesForShape = ((roleOn?.rules ?? []) as Rule[]).filter((r) =>
      (r.resources ?? []).includes("secrets")
    );
    const secretRules = secretRulesForShape;
    assert(
      secretRules.length === 1,
      `[${label}] expected exactly ONE 'secrets' rule on the runner Role by default (the owner's grant, ADR-0035); found ${secretRules.length}. managed-iac cannot run on Kubernetes without it, and more than one rule means the grant is being widened somewhere this gate cannot see`
    );
    // THE EXACT SHAPE, AS A SET EQUALITY AND NOT A `.includes`. A `.includes("create")` passes for
    // `["*"]`, for `["create","list"]`, and for a rule that also grants `configmaps` — i.e. for
    // every widening this assertion exists to catch.
    assert(
      JSON.stringify((secretRules[0]?.verbs ?? []).slice().sort()) === '["create","delete"]',
      `[${label}] the 'secrets' grant is not exactly ["create","delete"] (got ${JSON.stringify(secretRules[0]?.verbs)}). 'get' is unused by the adapter (one POST, two DELETEs, no GET) and 'list' returns every Secret BODY in the namespace including this release's database password — neither is part of what the owner granted`
    );
    assert(
      JSON.stringify(secretRules[0]?.resources ?? []) === '["secrets"]' &&
        JSON.stringify(secretRules[0]?.apiGroups ?? []) === '[""]',
      `[${label}] the 'secrets' rule names resources/apiGroups other than exactly ["secrets"] in the core group — a rule that carries a second resource inherits this grant's verbs for it`
    );
    assert(
      JSON.stringify(k8s).includes('"SCP_MANAGED_RUNNER_K8S_PER_RUN_SECRETS"'),
      `[${label}] the per-run-secret setting does not reach the server, so the RBAC and the code's belief about the RBAC can diverge`
    );

    //     AND THE OPT-OUT STILL WORKS. One value renders the rule AND sets the flag, in both
    //     directions — an operator who turns it off must get NO rule, or the two halves of the
    //     capability drift apart in the direction that 403s inside a promotion.
    const withoutSecrets = renderChart("verify-m23-nosecrets", [
      "--set",
      "managedRunners.launcher=kubernetes",
      "--set",
      "managedRunners.kubernetes.workspace.claimName=scp-runner-rwx",
      "--set",
      "managedRunners.kubernetes.perRunSecrets=false",
      "--set",
      "managedIac.enabled=true",
      "--set",
      "managedIac.runnerImage=ghcr.io/commanderscp/scp-runner-iac:0.1.0"
    ]);
    assert(
      !JSON.stringify(runnerRole(withoutSecrets)?.rules ?? []).includes("secrets"),
      `[${label}] perRunSecrets=false still renders a 'secrets' rule — the opt-out grants the privilege it says it declines`
    );
    assert(
      JSON.stringify(withoutSecrets).includes('"false"'),
      `[${label}] perRunSecrets=false does not reach the server`
    );

    // (3a-guard) M23.5 MEDIUM-7. See docs/helm-verify.md §48.
    {
      let unsafeRefused = false;
      try {
        renderChart("verify-m23-secret-ns-unsafe", [
          "--set",
          "managedRunners.launcher=kubernetes",
          "--set",
          "managedRunners.kubernetes.workspace.claimName=scp-runner-rwx",
          "--set",
          "managedIac.enabled=true",
          "--set",
          "managedIac.runnerImage=ghcr.io/commanderscp/scp-runner-iac:0.1.0"
          // Deliberately no `namespace`, no `perRunSecrets=false`, no `acceptSharedNamespaceSecretDelete`.
        ]);
      } catch {
        unsafeRefused = true;
      }
      assert(
        unsafeRefused,
        `[${label}] perRunSecrets=true with no managedRunners.kubernetes.namespace and no acceptSharedNamespaceSecretDelete must FAIL the render — this is the default combination and it grants delete on the release's own Secrets`
      );

      const escapes: [string, string[]][] = [
        [
          "a dedicated runner namespace",
          [
            "--set",
            "managedRunners.launcher=kubernetes",
            "--set",
            "managedRunners.kubernetes.workspace.claimName=scp-runner-rwx",
            "--set",
            "managedRunners.kubernetes.namespace=scp-runners",
            "--set",
            "managedIac.enabled=true",
            "--set",
            "managedIac.runnerImage=ghcr.io/commanderscp/scp-runner-iac:0.1.0"
          ]
        ],
        [
          "perRunSecrets=false",
          [
            "--set",
            "managedRunners.launcher=kubernetes",
            "--set",
            "managedRunners.kubernetes.workspace.claimName=scp-runner-rwx",
            "--set",
            "managedRunners.kubernetes.perRunSecrets=false",
            "--set",
            "managedIac.enabled=true",
            "--set",
            "managedIac.runnerImage=ghcr.io/commanderscp/scp-runner-iac:0.1.0"
          ]
        ],
        [
          "acceptSharedNamespaceSecretDelete=true",
          [
            "--set",
            "managedRunners.launcher=kubernetes",
            "--set",
            "managedRunners.kubernetes.workspace.claimName=scp-runner-rwx",
            "--set",
            "managedRunners.kubernetes.acceptSharedNamespaceSecretDelete=true",
            "--set",
            "managedIac.enabled=true",
            "--set",
            "managedIac.runnerImage=ghcr.io/commanderscp/scp-runner-iac:0.1.0"
          ]
        ]
      ];
      for (const [why, args] of escapes) {
        let rendered = false;
        try {
          renderChart("verify-m23-secret-ns-escape", args);
          rendered = true;
        } catch (cause) {
          throw new Error(
            `[${label}] stating ${why} must still render cleanly (M23.5 MEDIUM-7's guard is over-firing): ${String(cause)}`
          );
        }
        assert(rendered, `[${label}] stating ${why} must still render cleanly`);
      }
    }

    // The permissions exist for all three managed classes. See docs/helm-verify.md §49.
    for (const [why, extra] of [
      ["managed-iac only", ["managedIac.enabled=true", "managedIac.runnerImage=ghcr.io/x/iac:1"]],
      ["managed-dep only", ["managedDep.runnerImage=ghcr.io/x/dep:1"]],
      ["managed-scan only", ["managedScan.runnerImage=ghcr.io/x/scan:1"]]
    ] as [string, string[]][]) {
      const docs = renderChart("verify-m23-class", [
        "--set",
        "managedRunners.launcher=kubernetes",
        "--set",
        "managedRunners.kubernetes.workspace.claimName=scp-runner-rwx",
        // See the comment on the `k8s` render above — M23.5 MEDIUM-7's guard fires for every one
        // of these three, `perRunSecrets` defaulting true regardless of which class is enabled.
        "--set",
        "managedRunners.kubernetes.namespace=scp-runners",
        ...extra.flatMap((e) => ["--set", e])
      ]);
      const role = runnerRole(docs);
      assert(
        role,
        `[${label}] with ${why} enabled on the Kubernetes launcher the chart renders NO runner Role. The worker gets a service-account token and every 'jobs: create' it makes is a 403 — a class enabled by the operator that cannot launch anything`
      );
      assert(
        docs.some(
          (d) => d.kind === "RoleBinding" && String(d.metadata?.name ?? "").endsWith("-runner-iac")
        ),
        `[${label}] with ${why} enabled the runner Role is rendered with no RoleBinding, which authorises nobody`
      );
      assert(
        JSON.stringify(role?.rules ?? []).includes("secrets"),
        `[${label}] with ${why} enabled the per-run Secret grant is missing. All three classes are launched by the SAME ServiceAccount through the SAME Role, so a grant that depends on WHICH class is enabled is a grant that is absent whenever the class it was named after is off`
      );
    }

    // (3c) THE ROLE FOLLOWS THE RUNNER NAMESPACE. See docs/helm-verify.md §50.
    {
      const separated = renderChart("verify-m23-ns", [
        "--set",
        "managedRunners.launcher=kubernetes",
        "--set",
        "managedRunners.kubernetes.workspace.claimName=scp-runner-rwx",
        "--set",
        "managedRunners.kubernetes.namespace=scp-runners",
        "--set",
        "managedIac.enabled=true",
        "--set",
        "managedIac.runnerImage=ghcr.io/commanderscp/scp-runner-iac:0.1.0"
      ]);
      assert(
        runnerRole(separated)?.metadata?.namespace === "scp-runners",
        `[${label}] with managedRunners.kubernetes.namespace set, the runner Role renders into '${String(runnerRole(separated)?.metadata?.namespace)}' while the adapter creates its Jobs in 'scp-runners' — every launch is a 403 that names no cause`
      );
      const binding = separated.find(
        (d) => d.kind === "RoleBinding" && String(d.metadata?.name ?? "").endsWith("-runner-iac")
      );
      assert(
        binding?.metadata?.namespace === "scp-runners",
        `[${label}] the runner RoleBinding does not follow the runner namespace, so the Role above authorises nobody there`
      );
      // AND THE SUBJECT STAYS WITH THE WORKLOAD. A RoleBinding in the runner namespace naming a
      // ServiceAccount in the runner namespace would name one that does not exist.
      const subjectNs = (binding as unknown as { subjects?: { namespace?: string }[] })
        ?.subjects?.[0]?.namespace;
      assert(
        subjectNs === "verify-m23-ns" || subjectNs === "default",
        `[${label}] the runner RoleBinding's subject namespace is '${String(subjectNs)}' — the ServiceAccount lives with the workload, in the RELEASE namespace, not in the runner namespace`
      );
    }

    // (3d) A `docker` DEPLOYMENT GETS NO RUNNER RBAC AT ALL. A DECLARED NARROWING (M23.4): the Role
    //      used to render for `managedIac.enabled` regardless of launcher, granting Job creation —
    //      and now Secret creation — to a ServiceAccount whose pods mount no token (case (b) above
    //      asserts exactly that) and which makes no API call. Surface for nobody.
    {
      const dockerIacDocs = renderChart("verify-m23-docker-rbac", [
        "--set",
        "managedIac.enabled=true",
        "--set",
        "managedIac.runnerImage=ghcr.io/commanderscp/scp-runner-iac:0.1.0"
      ]);
      assert(
        !runnerRole(dockerIacDocs),
        `[${label}] a DOCKER-launcher deployment renders the runner Role. Its ServiceAccount mounts no token and makes no API call, so this is a standing Job- and Secret-creation grant for a caller that never calls`
      );
    }
    assert(
      !runnerRole(defaults),
      `[${label}] the DEFAULT render carries a runner Role — the hardened default must grant nothing at all`
    );

    // (4) THE PREREQUISITES ARE REFUSED AT RENDER, not discovered as a hang (owner decision 5).
    //     A NEGATIVE CONTROL FOR EACH, because "the render succeeded" is what a guard that does not
    //     fire also produces.
    for (const [why, args] of [
      [
        "no RWX claim",
        [
          "--set",
          "managedRunners.launcher=kubernetes",
          "--set",
          "managedIac.enabled=true",
          "--set",
          "managedIac.runnerImage=x"
        ]
      ],
      [
        "no managed class enabled",
        [
          "--set",
          "managedRunners.launcher=kubernetes",
          "--set",
          "managedRunners.kubernetes.workspace.claimName=rwx"
        ]
      ]
    ] as [string, string[]][]) {
      let refused = false;
      try {
        renderChart("verify-m23-bad", args);
      } catch {
        refused = true;
      }
      assert(
        refused,
        `[${label}] the chart RENDERED with the Kubernetes launcher and ${why}. Owner decision 5 requires "a render-time check and a clear failure message rather than a mysterious hang"`
      );
    }
    // Every worker write path, on every pod running that role. See docs/helm-verify.md §51.
    {
      const writePaths = (docs: K8sDoc[], suffix: string): string[] => {
        const doc = docs.find(
          (d) => d.kind === "Deployment" && String(d.metadata?.name ?? "").endsWith(suffix)
        );
        return (podSpecOf(doc ?? ({} as K8sDoc))?.containers ?? []).flatMap((c) =>
          (c.volumeMounts ?? []).map((m) => String(m.mountPath))
        );
      };
      const tokenOf = (docs: K8sDoc[], suffix: string): boolean | undefined =>
        podSpecOf(
          docs.find(
            (d) => d.kind === "Deployment" && String(d.metadata?.name ?? "").endsWith(suffix)
          ) ?? ({} as K8sDoc)
        )?.automountServiceAccountToken;

      // The three roots `commanderscp.commonEnv` renders and a worker-role process writes to. Read
      // off `values.yaml`'s defaults, so a changed default that no mount followed is a red build.
      const IAC_ROOT = "/var/lib/scp/managed-iac";
      const DEP_ROOT = "/var/lib/scp/managed-dep";
      const RUNNER_ROOT = "/var/lib/scp/runner-workspace";

      const everything = [
        "--set",
        "managedRunners.launcher=kubernetes",
        "--set",
        "managedRunners.kubernetes.workspace.claimName=scp-runner-rwx",
        // See the comment on the `k8s` render in the M23.2 block above — M23.5 MEDIUM-7's guard
        // fires here too since `perRunSecrets` defaults true.
        "--set",
        "managedRunners.kubernetes.namespace=scp-runners",
        "--set",
        "managedIac.enabled=true",
        "--set",
        "managedIac.runnerImage=ghcr.io/commanderscp/scp-runner-iac:0.1.0",
        "--set",
        "managedDep.runnerImage=ghcr.io/commanderscp/scp-runner-dep:0.1.0"
      ];

      // (5a) THE SINGLE-POD TOPOLOGY, BY NAME. `api.role=all` + `worker.replicaCount: 0` is what
      //      `values.yaml` tells a small install to set; the api pod IS the worker there.
      const singlePod = renderChart("verify-m23-single-pod", [
        ...everything,
        "--set",
        "api.role=all",
        "--set",
        "worker.replicaCount=0"
      ]);
      assert(
        tokenOf(singlePod, "-api") === true,
        `[${label}] on the documented single-pod topology (api.role=all, worker.replicaCount=0) the api pod has NO service-account token — it is the pod that runs the managed executors, so every API call it makes would be anonymous`
      );
      for (const [root, why] of [
        [
          RUNNER_ROOT,
          "the shared runner workspace — copy-in would write to the container's own ephemeral filesystem and the runner Job would mount the real claim and find an empty directory, SILENTLY"
        ],
        [
          IAC_ROOT,
          "the managed-IaC scratch root — `containerSecurityContext.readOnlyRootFilesystem` is true, so this is EROFS on the first mkdir"
        ],
        [
          DEP_ROOT,
          "the managed-dep scratch root — same EROFS, and nothing has ever mounted it on EITHER pod"
        ]
      ] as [string, string][]) {
        assert(
          writePaths(singlePod, "-api").includes(root),
          `[${label}] api.role=all mounts nothing at ${root}: ${why}`
        );
      }

      // (5b) THE SPLIT TOPOLOGY'S WORKER, same three paths. `managedDep` is the one that was missing
      //      here too — the census, not the reported symptom.
      const split = renderChart("verify-m23-split", everything);
      for (const root of [RUNNER_ROOT, IAC_ROOT, DEP_ROOT]) {
        assert(
          writePaths(split, "-worker").includes(root),
          `[${label}] the worker mounts nothing at ${root} — a path this chart renders into an env var and the process writes to`
        );
      }

      // (5c) AND THE NEGATIVE CONTROL, which is what makes (5a) mean anything. At the DEFAULT
      //      `api.role=api` the api pod never runs a managed executor, so it must carry neither the
      //      token nor any of the three roots. "Mount it on both, unconditionally" would pass (5a)
      //      and (5b) and hand a token and an RWX claim to a pure request server.
      assert(
        tokenOf(split, "-api") === false,
        `[${label}] a split-topology api pod (api.role=api) mounts a service-account token — it executes no managed trigger, so that is an API credential for a pod that makes no API call`
      );
      for (const root of [RUNNER_ROOT, IAC_ROOT, DEP_ROOT]) {
        assert(
          !writePaths(split, "-api").includes(root),
          `[${label}] a split-topology api pod (api.role=api) mounts ${root}. It runs no worker-role work; mounting a shared RWX claim there widens the blast radius of the request server for nothing`
        );
      }
    }

    // (6) THE POD CONVENTIONS THE RUNNER JOB INHERITS. See docs/helm-verify.md §52.
    {
      const runnerEnv = (docs: K8sDoc[], name: string): string | undefined => {
        const worker = docs.find(
          (d) => d.kind === "Deployment" && String(d.metadata?.name ?? "").endsWith("-worker")
        );
        for (const c of podSpecOf(worker ?? ({} as K8sDoc))?.containers ?? []) {
          const found = c.env?.find((e) => e.name === name);
          if (found) return found.value ?? "";
        }
        return undefined;
      };
      const base = [
        "--set",
        "managedRunners.launcher=kubernetes",
        "--set",
        "managedRunners.kubernetes.workspace.claimName=scp-runner-rwx",
        // See the comment on the `k8s` render in the M23.2 block above — M23.5 MEDIUM-7's guard
        // fires here too since `perRunSecrets` defaults true.
        "--set",
        "managedRunners.kubernetes.namespace=scp-runners",
        "--set",
        "managedIac.enabled=true",
        "--set",
        "managedIac.runnerImage=ghcr.io/commanderscp/scp-runner-iac:0.1.0"
      ];

      // (6a) THE PULL POLICY IS ALWAYS STATED, and it is the chart's own `IfNotPresent`. An ABSENT
      //      variable is the defect: Kubernetes then defaults it to `Always` for a `:latest` tag and
      //      an air-gapped node reaches for a registry it cannot see.
      assert(
        runnerEnv(k8s, "SCP_MANAGED_RUNNER_K8S_IMAGE_PULL_POLICY") === "IfNotPresent",
        `[${label}] the runner Job's imagePullPolicy is not rendered from the chart's own image.pullPolicy. Unset means Kubernetes defaults it to Always for a :latest tag, which is charter principle 5 broken in an air-gapped install`
      );
      const explicitPolicy = renderChart("verify-m23-pullpolicy", [
        ...base,
        "--set",
        "managedRunners.kubernetes.imagePullPolicy=Never"
      ]);
      assert(
        runnerEnv(explicitPolicy, "SCP_MANAGED_RUNNER_K8S_IMAGE_PULL_POLICY") === "Never",
        `[${label}] managedRunners.kubernetes.imagePullPolicy does not override the inherited value`
      );

      // (6b) PULL SECRETS ARE INHERITED FROM THE DEPLOYMENT-WIDE VALUE, with no second setting. A
      //      runner image in a private registry is the norm for self-hosted and mandatory behind the
      //      per-outpost Harbor SCP itself designs; the worker pulling `scpd` from that same
      //      registry already worked, and the runner Job could not be pulled at all.
      assert(
        runnerEnv(k8s, "SCP_MANAGED_RUNNER_K8S_IMAGE_PULL_SECRETS") === undefined,
        `[${label}] a render with NO imagePullSecrets still emits SCP_MANAGED_RUNNER_K8S_IMAGE_PULL_SECRETS — an empty statement is not the same as no statement`
      );
      const inherited = renderChart("verify-m23-pullsecrets", [
        ...base,
        "--set",
        "imagePullSecrets[0].name=ghcr-creds",
        "--set",
        "imagePullSecrets[1].name=harbor-creds"
      ]);
      assert(
        runnerEnv(inherited, "SCP_MANAGED_RUNNER_K8S_IMAGE_PULL_SECRETS") ===
          "ghcr-creds,harbor-creds",
        `[${label}] the runner Job does not inherit .Values.imagePullSecrets, so a runner image in a private registry cannot be pulled while the worker pulling scpd from the SAME registry can`
      );
      const overridden = renderChart("verify-m23-pullsecrets-override", [
        ...base,
        "--set",
        "imagePullSecrets[0].name=ghcr-creds",
        "--set",
        "managedRunners.kubernetes.imagePullSecrets[0].name=runner-only-creds"
      ]);
      assert(
        runnerEnv(overridden, "SCP_MANAGED_RUNNER_K8S_IMAGE_PULL_SECRETS") === "runner-only-creds",
        `[${label}] managedRunners.kubernetes.imagePullSecrets does not override the inherited list — the runner images may live somewhere the scpd image does not`
      );

      // Absent unless set, and verbatim when it is. See docs/helm-verify.md §53.
      assert(
        runnerEnv(k8s, "SCP_MANAGED_RUNNER_K8S_RESOURCES") === undefined,
        `[${label}] the default render emits SCP_MANAGED_RUNNER_K8S_RESOURCES for an empty resources block`
      );
      const withResources = renderChart("verify-m23-resources", [
        ...base,
        "--set",
        "managedRunners.kubernetes.resources.limits.memory=4Gi",
        "--set",
        "managedRunners.kubernetes.resources.requests.cpu=250m"
      ]);
      const rendered = runnerEnv(withResources, "SCP_MANAGED_RUNNER_K8S_RESOURCES");
      assert(
        rendered !== undefined &&
          (JSON.parse(rendered) as { limits?: { memory?: string } }).limits?.memory === "4Gi",
        `[${label}] managedRunners.kubernetes.resources does not reach the runner Job (got ${rendered ?? "<absent>"}). A namespace with a compute ResourceQuota rejects a pod that declares no limits, and no pod is then ever created`
      );

      // (6d) AND NONE OF IT ON A DOCKER DEPLOYMENT. These three describe a pod spec; a compose or VM
      //      install builds an argv. Same rule as every other Kubernetes variable here.
      const dockerDocs = renderChart("verify-m23-docker-pod", [
        "--set",
        "managedIac.enabled=true",
        "--set",
        "managedIac.runnerImage=ghcr.io/commanderscp/scp-runner-iac:0.1.0",
        "--set",
        "imagePullSecrets[0].name=ghcr-creds"
      ]);
      for (const key of [
        "SCP_MANAGED_RUNNER_K8S_IMAGE_PULL_POLICY",
        "SCP_MANAGED_RUNNER_K8S_IMAGE_PULL_SECRETS",
        "SCP_MANAGED_RUNNER_K8S_RESOURCES"
      ]) {
        assert(
          runnerEnv(dockerDocs, key) === undefined,
          `[${label}] a DOCKER-launcher deployment carries ${key} — a docker deployment must carry no Kubernetes surface at all`
        );
      }
    }

    console.log(
      "  default render unchanged; selected render carries token + egress + volume + settings; the per-run Secret grant is exactly create+delete on secrets, present for all three classes, absent on docker and at the default, and following the runner namespace; both prerequisites refuse at render; every worker-role write path is mounted on BOTH the worker and an api.role=all pod, and on neither at api.role=api; the runner Job inherits the deployment pull secrets, pull policy and resources, and none of the three on docker"
    );
  }

  verifySocketInvariantMatrix();
  verifyRpmCatalogTemplate();
  verifyInfraCatalogTemplates();

  // M29.4 — the stack controller: hardened like every workload, and its one exception to the
  // no-ClusterRole rule held to its own assertions (./stackd.ts).
  console.log("helm-verify: M29.4 stack controller — rendering stackd.enabled=true...");
  verifyRender(
    "stackd",
    renderChart("verify-stackd", [
      "--set",
      "stackd.enabled=true",
      "--set",
      "networkPolicy.enabled=true"
    ])
  );
  for (const note of await verifyStackController({
    repoRoot: path.resolve(__dirname, "../../.."),
    chartDir: CHART_DIR,
    bundledChartDir: BUNDLED_CHART_DIR,
    renderChart,
    fail
  })) {
    console.log(note);
  }

  // #422 adversarial review (LIVE RISK) — GitOps/Argo CD stability of the existingSecret overrides.
  for (const note of verifyExistingSecretOverrides({
    repoRoot: path.resolve(__dirname, "../../.."),
    chartDir: CHART_DIR,
    bundledChartDir: BUNDLED_CHART_DIR,
    renderChart,
    fail
  })) {
    console.log(note);
  }

  // #422 re-verify BLOCKING 2 — the homelab-shaped baseline stays unchanged, and two incomplete
  // GitOps configurations fail the render loudly instead of silently mis-provisioning.
  for (const note of verifyBlocking2Guards({
    repoRoot: path.resolve(__dirname, "../../.."),
    chartDir: CHART_DIR,
    bundledChartDir: BUNDLED_CHART_DIR,
    renderChart,
    fail
  })) {
    console.log(note);
  }

  if (failures.length > 0) {
    console.error(`\nhelm-verify: ${failures.length} assertion(s) FAILED:\n`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log("\nhelm-verify: all hardened-defaults assertions passed.");
}

main().catch((err: unknown) => {
  console.error("helm-verify: FATAL", err);
  process.exit(1);
});
