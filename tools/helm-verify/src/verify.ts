#!/usr/bin/env node
/**
 * @scp/helm-verify — the "helm template assertions" gate BUILD_AND_TEST.md §8 M8's DoD calls for:
 * "Helm hardened defaults must actually apply (non-root/read-only-rootfs/dropped-caps/
 * NetworkPolicy present in rendered manifests — test via `helm template` assertions)."
 *
 * Renders `deploy/helm` with several representative value sets (bare defaults, and a "kitchen
 * sink" with every optional feature toggled on — managed-iac, federation mTLS, ingress,
 * serviceMonitor, NATS event bus, OIDC, worker HPA) and asserts STRUCTURALLY on the parsed YAML —
 * not string-grepping the raw template output, which can't tell "the field is present on the
 * container that matters" from "the string appears somewhere in the file". A loosened default in
 * `values.yaml` fails THIS script, not just a human reviewer's eyeball pass.
 *
 * Run: `pnpm --filter @scp/helm-verify verify` (from repo root) or `tsx src/verify.ts` from this
 * directory. Requires `helm` on PATH (BUILD_AND_TEST.md §1: Helm 3.16+) — no live cluster needed,
 * this is pure `helm template` (offline rendering).
 *
 * SKIPS (does not fail) when `helm` isn't on PATH at all — this script is wired into the
 * top-level `pnpm test` (Turborepo picks up this package's `test` script), which runs in a CI job
 * that deliberately installs no tools of its own, and on developer machines that may have no Helm.
 * A hard ENOENT there would fail the unit-test stage for a tool-availability gap, not a real
 * regression. (Historical note: that skip branch was ALWAYS taken in CI when the unit-test stage
 * ran on `homelab-commanderscp-linux-general`, which shipped Node only. CI now runs on GitHub-hosted
 * `ubuntu-latest`, which pre-installs helm, so the assertions below genuinely execute in the
 * unit-test stage too — a bonus, not the guarantee.) The assertions below are a REAL gate
 * regardless of any of that: `.github/workflows/ci.yml`'s
 * dedicated `helm-verify` job installs Helm ITSELF (`azure/setup-helm@v4`) before running this
 * exact script — not trusting the runner image — so a loosened `values.yaml` genuinely fails CI
 * there on any runner. See that job's own comment. Locally, any dev with Helm on PATH gets the
 * real check for free via `pnpm test`.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseAllDocuments } from "yaml";
import { jobManifest, kubernetesRbacKey, kubernetesRunnerRbac } from "@scp/runner-launcher";
import type { KubernetesRbacRule, RunnerSpec } from "@scp/runner-launcher";

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

// =============================================================================================
// M15.4 — federation-role bundled-backend guardrail (a CHART-RENDER-TIME SELF-CONSISTENCY LINT).
//
// HONEST SCOPE: this is a `helm template`-time misconfiguration guardrail, NOT SCP runtime
// governance/authority. The OPERATOR sets BOTH `federationRole` AND the `bundledExecutor.*.enabled`
// flags at install time; this lint pairs those two install-time values and fails the render-check
// when a role enables a bundled backend it should not run. It is deliberately NOT wired to runtime
// enforcement: the runtime `self_domain.role` (apps/server/src/federation/self-repo.ts) is ADVISORY
// metadata set post-install via the federation API, with no bearing on a Helm install-time value and
// no graph representation of bundled-backend enablement — so runtime enforcement here would fork the
// engine. This tooling-only lint is the owner-chosen alternative (M15.4; ADR-0012 §M15.4 note).
//
// Each bundled backend ⇒ its own namespace; presence of resources in that namespace in the render is
// how we detect "this backend is actually enabled" (robust: asserts on what WOULD deploy, not on the
// --set flags we happened to pass).
const BACKEND_NAMESPACES: Record<string, string> = {
  argocd: "scp-argocd",
  argoWorkflows: "scp-argo-workflows",
  argoEvents: "scp-argo-events",
  gitea: "scp-gitea"
};

// Allowed bundled backends per federation role. DOC SOURCE: ADR-0012 (outposts run Gitea as the
// self-contained registry/git + the deploy engine; commander runs the full Standard Stack) + the
// poke/retrans federation model (a `retrans` node is a validate-and-relay CDS-boundary relay — NOT
// an execution site, so it bundles NOTHING) + the M15.4 milestone note in BUILD_AND_TEST.md §8.
// Conservative where the docs are silent (outpost restricted to gitea + argocd; the build/event
// backends — argoWorkflows/argoEvents — are commander-only) — the assumption is documented in the
// M15.4 milestone note. If a future decision widens a role, widen this table (the single source of
// truth) and the milestone note together.
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

/**
 * ==================================================================================================
 * M23.6 CLAUSE 5 — THE RUNNER ROLE, DIFFED AGAINST WHAT THE ADAPTER ACTUALLY ISSUES, BOTH WAYS
 * ==================================================================================================
 *
 * The clause is "the chart grants exactly what the adapter calls, and no more". The gate that stood
 * here before could only ever catch the FIRST half: `batch/jobs` was checked with
 * `JSON.stringify(rules).includes('"patch"')`, `pods`/`pods/log` were checked NOWHERE AT ALL, and
 * only `events` and `secrets` had a set-equality. Measured against that gate: four unused verbs
 * added to `runner-iac.yaml` (`jobs: +deletecollection,+update`; `pods,pods/log: +delete,+create`)
 * left this script green, `pnpm -w test` green and the kind suite green. A privilege that can only
 * drift wider is the direction that matters.
 *
 * THE EXPECTED SET IS NOT WRITTEN HERE. It is `kubernetesRunnerRbac()` in `@scp/runner-launcher`,
 * which `kubernetes-rbac-contract.test.ts` holds to the adapter by DRIVING every route over a
 * recording io and deriving the verbs from the wire. A second hand-maintained copy in this file
 * would be free to agree with the chart and disagree with the code, which is the failure mode this
 * whole clause is about.
 *
 * ONE RULE PER (apiGroup, resource) IS PART OF THE CONTRACT, not a convenience for the comparison. A
 * rule listing two resources gives each of them every verb in the list — that is how `pods` came to
 * hold `get` and `pods/log` to hold `list`, neither of which the adapter ever issues — so a render
 * that splits or merges rules differently must fail here rather than be normalised away.
 */
function rbacDiff(rendered: unknown, expected: readonly KubernetesRbacRule[]): string[] {
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
        `${key} is NOT granted at all; the adapter issues ${JSON.stringify(verbs)} against it`
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
        `${key} grants ${JSON.stringify(extra)}, which the adapter never issues — a standing privilege for a caller that never calls`
      );
    }
  }
  for (const key of seen.keys()) {
    if (!want.has(key)) {
      problems.push(
        `${key} is granted and the adapter touches it NOT AT ALL (verbs ${JSON.stringify(seen.get(key))})`
      );
    }
  }
  return problems;
}

// ==================================================================================================
// M23.6 CLAUSE 5, WIDENED FROM ONE RULE TO THE WHOLE CHART — WHAT `helm install` ACTUALLY GRANTS
// ==================================================================================================
/**
 * `rbacDiff` above is real and fires in both directions, but it is true of ONE Role. The clause is
 * "the chart grants exactly what the adapter calls, and no more", and that is a statement about the
 * CHART. The gap is not theoretical: the M23.6 verification pass pointed a real authorizer at the
 * harness identity and got `delete nodes: yes` — a question no assertion in this repository had ever
 * asked, because every RBAC assertion it had was aimed at `-runner-iac`'s `rules` array. A diff can
 * only speak for the object it is handed; everything the chart renders BESIDE that object was
 * ungated.
 *
 * SO THIS FUNCTION TAKES A WHOLE RENDER AND ANSWERS: WHICH IDENTITY ENDS UP HOLDING WHICH RULES.
 * It resolves every RoleBinding's `roleRef` against every rendered Role, accumulates the union per
 * ServiceAccount subject, and compares each identity's TOTAL grant — not one rule of it — against a
 * pinned expectation. Three identities exist in this chart and all three are named here, so a FOURTH
 * is a failure by construction rather than something a reader has to notice:
 *
 *   - THE WORKLOAD ServiceAccount (the one the api/worker pods run as, and therefore the one the
 *     Kubernetes adapter's every call authenticates as): exactly `kubernetesRunnerRbac()`, which is
 *     the set `kubernetes-rbac-contract.test.ts` derives from the wire by driving the adapter. Or
 *     NOTHING AT ALL, on every render where no managed run can launch.
 *   - THE TWO AUTOWIRE ServiceAccounts (`-argocd-autowire`, `-gitea-autowire`): `get` on `secrets`,
 *     in the bundled backend's own namespace. These are install-time hooks that read one generated
 *     admin secret and mint a scoped API token; their Roles live in a DIFFERENT namespace from
 *     everything else the chart grants, which is precisely why "the runner Role is correct" never
 *     said anything about them.
 *
 * AND FOUR STRUCTURAL REFUSALS THAT DO NOT DEPEND ON KNOWING THE EXPECTED SET:
 *   1. NO ClusterRole AND NO ClusterRoleBinding, EVER. Every grant this chart makes is namespaced.
 *      `delete nodes` is a cluster-scoped question and this is the assertion that makes the answer
 *      structurally "no" — including for the value combinations no matrix enumerates, since the
 *      source census at the end of `verifySocketInvariantMatrix` covers the templates as text.
 *   2. NO WILDCARD in `apiGroups`, `resources` or `verbs`. A `*` passes any set-equality that is
 *      written as a `.includes`, and grants everything the day a new resource appears.
 *   3. NO `escalate`, `bind` OR `impersonate`. Those three are how a bounded grant becomes an
 *      unbounded one without the grant itself changing.
 *   4. EVERY Role IS BOUND AND EVERY BINDING RESOLVES. A Role nothing references authorises nobody
 *      (ADR-0035 §6a's exact starting failure, generalised from the one case that was checked), and
 *      a RoleBinding whose `roleRef` names a Role this render does not contain is a grant that
 *      silently does nothing — or, worse, picks up a same-named Role that is already in the cluster.
 */
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

/**
 * The identity the api/worker pods run as — the one the Kubernetes adapter's every call
 * authenticates as, and therefore the subject of "the chart grants exactly what the adapter calls".
 *
 * READ FROM THE DEPLOYMENTS' POD SPECS, for two reasons. `serviceAccount.create=false` renders no
 * ServiceAccount object at all while the pods still authenticate as something, so the object is the
 * wrong place to look. And the chart's install-time HOOKS (the two bundled-backend autowire Jobs)
 * deliberately run as their own identities; folding those in here would make this return three names
 * and say nothing about any of them.
 */
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

  // (1) NOTHING CLUSTER-SCOPED, AT ALL.
  for (const doc of docs) {
    if (doc.kind === "ClusterRole" || doc.kind === "ClusterRoleBinding") {
      say(
        `the chart rendered a ${doc.kind} ('${String(doc.metadata?.name)}'). Every grant this chart makes is namespaced; a cluster-scoped one is how a runner identity comes to hold verbs on nodes, namespaces or other releases' objects`
      );
    }
  }

  // (2)(3) WILDCARDS AND ESCALATION VERBS, over every rule of every role-ish object.
  const roles = new Map<string, RenderedRule[]>();
  for (const doc of docs) {
    if (doc.kind !== "Role" && doc.kind !== "ClusterRole") continue;
    const name = String(doc.metadata?.name ?? "");
    const namespace = String(doc.metadata?.namespace ?? "");
    const rules = (doc["rules"] ?? []) as RenderedRule[];
    roles.set(`${namespace}/${name}`, rules);
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
    const rules = roles.get(key);
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
  for (const key of roles.keys()) {
    if (!boundRoles.has(key)) {
      say(
        `Role '${key}' is rendered with no RoleBinding, so it authorises nobody — the shape ADR-0035 §6a records as the starting failure, here as a property of every Role rather than of the one that was checked`
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
  // THE INSTALL-TIME HOOKS. Pinned by SHAPE here rather than described: each reads exactly one
  // generated admin Secret in the bundled backend's namespace to mint a scoped API token.
  const AUTOWIRE_GRANT: KubernetesRbacRule[] = [
    { apiGroup: "", resource: "secrets", verbs: ["get"] }
  ];
  for (const identity of [...effective.keys(), ...allPodServiceAccountNames(docs)]) {
    if (identity.endsWith("-argocd-autowire") || identity.endsWith("-gitea-autowire")) {
      expected.set(identity, AUTOWIRE_GRANT);
    }
  }
  for (const identity of effective.keys()) {
    if (!expected.has(identity)) {
      say(
        `'${identity}' is granted rules by this chart and is not one of the three identities it is supposed to have (the workload ServiceAccount and the two bundled-backend autowire hooks)`
      );
    }
  }
  // AND THE OTHER DIRECTION: a pod running as an identity nothing above pins. A new hook Job with its
  // own ServiceAccount would otherwise be invisible here until the day someone gave it a Role.
  for (const identity of allPodServiceAccountNames(docs)) {
    if (identity !== workloadName && !expected.has(identity)) {
      say(
        `a pod in this render runs as '${identity}', which is neither the workload ServiceAccount nor one of the two pinned autowire hooks — a new identity inside the release that no grant assertion covers`
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
    for (const problem of rbacDiff(got, want)) {
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

// ==================================================================================================
// M23.6 CLAUSE 6 — THE SOCKET INVARIANT, ENFORCED BY RENDERING EVERY COMBINATION
// ==================================================================================================
/**
 * THE INVARIANT M23 MUST NOT BREAK, in BUILD_AND_TEST.md's own words: "**no Docker socket is mounted
 * into any pod, ever** — not behind a value, not behind a `managedIac.enabled` opt-in, not 'for
 * dev'." The escape risk `runner-iac.yaml`'s module header refuses to paper over is the reason M23
 * exists at all; a socket mount would satisfy the goal while destroying the reason.
 *
 * WHAT STOOD FOR THIS BEFORE, AND WHY IT WAS NOT A GATE. Nothing rendered the chart and looked. A
 * filterless `grep -rna 'docker.sock\\|/var/run/docker'` over the repo found ZERO assertions over
 * rendered chart output — every `docker.sock` assertion in the tree was on Docker ARGV, which is a
 * statement about the compose path and says nothing about a pod. Measured, before this section
 * existed: a `hostPath: /var/run/docker.sock` volume plus its mount added to
 * `deployment-worker.yaml` produced FOUR `docker.sock` occurrences in `helm template` AT THE DEFAULT
 * VALUES while `pnpm -w test` stayed green (72/72) and helm-verify stayed green.
 *
 * A HANDFUL OF HAND-PICKED COMBINATIONS IS NOT A MATRIX. The 31 `renderChart` calls elsewhere in
 * this file are each aimed at one question; none of them is a sweep, and the combination that
 * carries a socket is by definition the one nobody thought to name. The product below is
 * EXHAUSTIVE over the dimensions the clause names — every `managed*` enablement combination and
 * every documented `managedRunners` override — and the count is printed so "exhaustive" is a number
 * rather than a claim.
 *
 * AND THE HALF `helm template` STRUCTURALLY CANNOT SEE. The runner pod is not in the chart: it is
 * built by `jobManifest()` in `packages/runner-launcher` at RUN time, from the settings the chart
 * delivers as environment variables. So for every Kubernetes render this section ALSO reads the
 * worker's own env out of the render, derives the launcher settings exactly as
 * `managedRunnerKubernetesSettings()` does, builds the Job manifest those values produce, and holds
 * it to the same invariant. The chart cannot render a socket, and it cannot ASK for one either.
 */

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
  // CronJob: spec.jobTemplate.spec.template.spec
  const jobTemplate = spec["jobTemplate"] as
    { spec?: { template?: { spec?: Record<string, unknown> } } } | undefined;
  if (jobTemplate?.spec?.template?.spec) out.push(jobTemplate.spec.template.spec);
  return out;
}

/**
 * Every reason a rendered manifest violates the invariant. Two independent instruments, because
 * each catches what the other cannot: a STRUCTURAL walk that knows which field is a volume (so it
 * can name `hostPath` even when the path is innocuous), and a RAW scan of the bytes (so a socket
 * hidden in a ConfigMap, an annotation or an unmodelled field cannot slip past the walk).
 */
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

/**
 * The runner Job THIS RENDER WOULD PRODUCE. Mirrors `managedRunnerKubernetesSettings()` in
 * `apps/server/src/coordination/executor-bindings-repo.ts` — claim first, host path second, nothing
 * third — so a chart that started plumbing `SCP_MANAGED_RUNNER_K8S_WORKSPACE_HOST_PATH` (today it
 * does not, and that absence is itself asserted) would be caught here rather than at run time.
 */
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
  /**
   * M23.6 CLAUSE 5, WIDENED. Whether a managed run can actually launch at this point — i.e. whether
   * the workload ServiceAccount is supposed to hold the runner grant AT ALL — and, if so, whether
   * the per-run Secret capability is on. DERIVED FROM THE POINT'S OWN VALUES, never read back out of
   * the render: an expectation computed from the thing being checked agrees with it by construction.
   */
  expectRunnerGrant: boolean;
  perRunSecrets: boolean;
}

/**
 * The exhaustive product. Dimensions, and why each one is in it:
 *  - the three managed classes, independently on/off (8) — the clause names them by wildcard, and
 *    each one gates a different block of `runner-iac.yaml` and of the worker's env.
 *  - the launcher (2) — `docker` and `kubernetes` render different pods and different volumes.
 *  - `managedRunners.kubernetes.namespace` empty vs a runner namespace (2) — moves the Role, the
 *    RoleBinding and the Jobs, and is the M23.5 render-time guard's own input.
 *  - `perRunSecrets` (2) — renders or omits a rule and flips a server-side flag.
 *  - `acceptSharedNamespaceSecretDelete` (2) — the documented override for the guard above; the
 *    combination it exists to unblock is asserted to REFUSE without it.
 *  - `runAsNonRoot` (2) — the only value that changes the runner pod's securityContext.
 * Run twice: once with the rest of the chart at defaults, once with every other optional feature on
 * (the existing kitchen sink plus `api.role=all`, which is the single-pod install where the worker's
 * volumes land on the api pod too). Plus one small sweep over `api.role`, whose three values decide
 * which pods exist at all.
 */
function socketMatrix(): MatrixPoint[] {
  const points: MatrixPoint[] = [];
  const IAC_IMAGE = "ghcr.io/commanderscp/scp-runner-iac:0.1.0";
  const bool = [false, true];

  /**
   * THE TWO ENVIRONMENTS ARE NOT SYMMETRIC, AND THE ASYMMETRY IS THE FACTORING RATHER THAN A CORNER
   * CUT. `defaults` carries the FULL `managedRunners` product, because those are the values the
   * clause names and the ones that gate the runner templates. `everything-on` exists to answer a
   * different question — "does any OTHER chart feature introduce a socket" — and no other feature
   * reads a `managedRunners.kubernetes.*` value, so crossing it with the full product would multiply
   * renders without multiplying coverage. It is crossed with every class combination and both
   * launchers, which is what decides which pods exist.
   *
   * THE COST IS REAL AND IS WHY THIS IS WRITTEN DOWN. Each point is one `helm` process. At 276
   * points this task starved the rest of `turbo run test`: `@scp/plugin-managed-scan`'s
   * `scanner-containment` test, 390ms in isolation, timed out at 49,061ms once in three runs. The
   * `fullProduct` flag is the lever that keeps the sweep exhaustive where exhaustiveness is the
   * claim and bounded where it is not.
   */
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

  /**
   * THE BUNDLED BACKENDS' OWN IDENTITIES (M23.6 clause 5, widened). `bundledExecutor.*.enabled` is
   * not a dimension of the socket product — no bundled backend can introduce a runtime socket into
   * an SCP pod — but each one renders a ServiceAccount, a Role and a RoleBinding IN THE BACKEND'S
   * NAMESPACE, which is a grant this chart makes to an identity outside everything the runner Role
   * gate ever looked at. They are swept here so `chartGrantProblems` sees them: both alone and
   * together, and crossed with the Kubernetes launcher so the runner grant and the hook grants are
   * checked in one render rather than in two that never meet.
   */
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

  for (const point of points) {
    let raw: string;
    try {
      raw = renderRaw(CHART_DIR, "verify-socket", point.args);
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

    /**
     * M23.6 CLAUSE 5, WIDENED — THE WHOLE CHART'S GRANT, ON THE RENDERS THIS LOOP ALREADY HAS.
     *
     * Sharing this loop is a deliberate cost decision, not a tidiness one. Each point is one `helm`
     * process and this sweep already starved `turbo run test` once at 276 points (see
     * `socketMatrix`'s own note); a second exhaustive sweep for RBAC would have doubled that for
     * renders byte-identical to these. So the two invariants are asked of one render each, and the
     * function above is pure so it can also be pointed at any other render.
     */
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

  /**
   * AND THE CENSUS THAT COVERS THE COMBINATIONS NO MATRIX CAN ENUMERATE. A sweep proves the points
   * it visits; a string that appears in NO template of the chart cannot appear in ANY render of it,
   * for every value assignment including the ones nobody has thought of yet. So the two instruments
   * are complementary rather than redundant: this one is total over literal paths, the matrix is
   * what catches a path a VALUE supplies.
   *
   * `hostPath` IS ASSERTED ABSENT FROM THE TEMPLATES AS WELL AS FROM THE RENDERS. This chart
   * declares no hostPath volume anywhere and has no value that could produce one — the runner
   * workspace is an RWX PersistentVolumeClaim and nothing else. `packages/runner-launcher` DOES
   * support `{ kind: "hostPath" }` (the kind harness uses it, and `kubernetes-launch.golden.test.ts`
   * pins that shape), reached only through `SCP_MANAGED_RUNNER_K8S_WORKSPACE_HOST_PATH` — an
   * environment variable this chart does not set, which is asserted below by name rather than left
   * as an observation.
   *
   * SCOPE, STATED RATHER THAN IMPLIED: `deploy/helm` — the chart `helm install` applies. The
   * bundled-backends chart is checked for runtime sockets in its RENDER (below) and not for
   * `hostPath` in its SOURCE, because `deploy/helm-bundled/vendor/argo-workflows` carries upstream
   * CRD definitions whose openAPI schemas DOCUMENT the `hostPath` field in prose; that text is not a
   * pod spec and stripping it would mean editing a vendored upstream manifest.
   */
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
    /**
     * M23.6 CLAUSE 5, WIDENED — THE CLUSTER-SCOPED HALF, AS A CENSUS. `chartGrantProblems` refuses a
     * ClusterRole in every render the matrix visits; this refuses one in every render that COULD
     * exist, including the value assignments nobody has enumerated. It is the same pairing the socket
     * invariant uses one assertion above, and for the same reason: a sweep is total over the points
     * it visits, a census is total over the literal text.
     */
    for (const clusterKind of ["ClusterRole", "ClusterRoleBinding"]) {
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
      "bundledExecutor.argoEvents.enabled=true",
      "--set",
      "bundledExecutor.gitea.enabled=true"
    ]
  ]) {
    const bundledRaw = renderRaw(BUNDLED_CHART_DIR, "verify-socket-bundled", setArgs);
    for (const pattern of RUNTIME_SOCKET_PATTERNS) {
      assert(
        !bundledRaw.includes(pattern),
        `[${label}] the bundled-backends render contains '${pattern}' — a vendored backend mounting a container runtime socket is the same escape, one chart along`
      );
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

  /**
   * AND THE GRANT DETECTOR'S OWN NON-VACUITY. Same discipline as the socket control above: every
   * verdict `chartGrantProblems` returned was "no problems", which is also what a function that had
   * stopped looking returns. Four plants, each aimed at one arm that has no other control — a
   * ClusterRole, a wildcard verb, a Role nothing binds, and an identity the chart is not supposed to
   * have — asserted by COUNT so a detector that fired once and stopped is visible.
   */
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
    "is not one of the three identities"
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
    `  and the WHOLE chart's RBAC grant checked on all ${grantsChecked} of them: no ClusterRole or ClusterRoleBinding, no wildcard, no escalate/bind/impersonate, every Role bound, and each of the three identities holding exactly its pinned set`
  );
}

function assert(condition: unknown, msg: string): void {
  if (!condition) fail(msg);
}

/** The RAW `helm template` output. Separate from {@link renderDir} because a NEGATIVE invariant
 *  ("this string appears nowhere in what would be applied") is strictly stronger over the raw bytes
 *  than over the parsed docs: a socket path smuggled into a ConfigMap body, an annotation or a
 *  pod-spec field this file's `K8sDoc` shape does not model is invisible to a structural walk and
 *  obvious here. This is the exact inverse of the module doc's warning about string-grepping, which
 *  is about POSITIVE assertions ("the field is present on the container that matters"). */
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
  execFileSync("helm", ["package", dir, "--destination", out], { stdio: "ignore" });
  const tgz = readdirSync(out).find((f) => f.endsWith(".tgz"));
  if (!tgz) throw new Error(`helm package produced no .tgz in ${out}`);
  return readFileSync(path.join(out, tgz)).toString("base64").length;
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

interface NpEgressRule {
  to?: {
    ipBlock?: { cidr?: string; except?: string[] };
    namespaceSelector?: unknown;
    podSelector?: unknown;
  }[];
  ports?: { protocol?: string; port?: number; endPort?: number }[];
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

/**
 * THE REACHABILITY CONSTRAINT this guard encodes — and why "an ipBlock rule mentioning 443 or 6443"
 * is NOT it.
 *
 * A NetworkPolicy egress rule lets the hook pod reach the apiserver only if BOTH halves hold on the
 * destination the CNI actually evaluates, which is the POST-DNAT one: kube-proxy has already
 * rewritten `kubernetes.default` (10.96.0.1:443) to the real endpoint, `<node-ip>:6443`, before
 * policy is applied.
 *
 *   PORT — 6443 must be allowed. Measured on the drill's own environment (kind): the post-DNAT
 *          destination is 172.18.0.2:6443. A rule listing only 443 renders, reads plausibly, passes
 *          any "is 443 allowed" check — and the hook is dropped exactly as before the fix. 443 alone
 *          is therefore NOT sufficient evidence of reachability and must not satisfy this guard.
 *   CIDR — the allowed ipBlocks must actually cover a node IP, AND must not cover anything else.
 *          `cidrs: [10.0.0.0/8]` looks careful and misses kind's 172.18.0.0/16 entirely — narrowing
 *          breaks reachability. `cidrs: [0.0.0.0/0]` goes the other way: it covers all three
 *          required ranges trivially, so a coverage-only check waves it through, but it ALSO grants
 *          the hook pod unrestricted public-internet egress on TCP/6443 (and 443) — inside a chart
 *          whose whole posture is default-deny, and that the air-gap drill exists to certify as
 *          zero-egress. So the guard requires the union of the rule's ipBlocks (minus any `except`)
 *          to cover ALL THREE RFC1918 ranges the chart ships as its default — the set the chart
 *          claims covers "kind, k3s, and private-endpoint managed clusters" — AND to extend no
 *          further than that union. Same class of bug as the ports check above: "at least" is not
 *          "exactly"; both the lower and the upper bound have to be asserted, or the guard only
 *          catches half of the ways this can regress.
 *
 * An operator with a genuinely public control-plane endpoint sets `networkPolicy.kubeApi.cidrs` to
 * that endpoint and this guard would flag it — deliberately: this asserts on the CHART'S SHIPPED
 * DEFAULT render, which is what the drill and every out-of-the-box install use.
 */
const KUBE_API_ENDPOINT_PORT = 6443;
const KUBE_API_REQUIRED_CIDRS = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"];

/** A NetworkPolicy rule list carries NO ALLOW RULES — i.e. the policy DENIES that direction — when
 *  the field is absent OR an empty array. Kubernetes treats `egress:` (absent) and `egress: []` as
 *  identical; anything that recognises only one of the two can be evaded by writing the other.
 *  Shared by every default-deny detection in this file so the two can never drift apart again. */
function hasNoAllowRules(v: unknown): boolean {
  return v === undefined || v === null || (Array.isArray(v) && v.length === 0);
}

type IpRange = [start: number, end: number];

/** IPv4 CIDR -> inclusive [start,end] as unsigned 32-bit numbers. `undefined` for anything this can
 *  not reason about (IPv6, malformed) — which then never counts as coverage, so an unparseable CIDR
 *  can only make the guard STRICTER, never accidentally satisfy it. */
function cidrToRange(cidr: string): IpRange | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr.trim());
  if (!m) return undefined;
  const octets = [m[1], m[2], m[3], m[4]].map(Number);
  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return undefined;
  const bits = Number(m[5]);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return undefined;
  const addr = octets.reduce((acc, o) => acc * 256 + o, 0);
  const size = 2 ** (32 - bits);
  const start = Math.floor(addr / size) * size; // normalise to the network address
  return [start, start + size - 1];
}

function mergeRanges(ranges: IpRange[]): IpRange[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: IpRange[] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** base minus sub — used so an ipBlock's `except` holes cannot be counted as coverage. */
function subtractRanges(base: IpRange[], sub: IpRange[]): IpRange[] {
  let acc = mergeRanges(base);
  for (const [ss, se] of mergeRanges(sub)) {
    const next: IpRange[] = [];
    for (const [s, e] of acc) {
      if (se < s || ss > e) next.push([s, e]);
      else {
        if (s < ss) next.push([s, ss - 1]);
        if (e > se) next.push([se + 1, e]);
      }
    }
    acc = next;
  }
  return acc;
}

function rangesCover(covered: IpRange[], required: IpRange): boolean {
  let cursor = required[0];
  for (const [s, e] of mergeRanges(covered)) {
    if (s > cursor) return false;
    if (e >= cursor) cursor = e + 1;
    if (cursor > required[1]) return true;
  }
  return cursor > required[1];
}

function ipToStr(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

/** The exact union of the three required RFC1918 ranges, as merged [start,end] pairs. Anything a
 *  granting rule covers OUTSIDE this union — 0.0.0.0/0, another private block, the public
 *  internet — is exactly as dangerous as failing to cover it: this chart's whole posture is
 *  default-deny, and the kube-API allow exists to punch ONE narrow, known hole in that, not to
 *  become a second "allow-all" rule wearing a kube-API label. */
const KUBE_API_REQUIRED_RANGES: IpRange[] = mergeRanges(
  KUBE_API_REQUIRED_CIDRS.map((c) => cidrToRange(c)).filter((r): r is IpRange => r !== undefined)
);

/**
 * THE AIR-GAP REGRESSION GUARD (nightly deploy-drills.yml has no `pull_request` trigger; THIS job
 * runs on every PR).
 *
 * Every bundled-executor auto-wire hook Job (`*-autowire-*`) begins by reading the backend's admin
 * Secret from `https://kubernetes.default.svc`. Its pod carries the chart's selector labels, so the
 * chart's own `-default-deny` NetworkPolicy selects it — and for 12 consecutive nightly air-gap runs
 * NOTHING in the chart allowed egress to the API server, so Calico dropped that read, the bin's
 * `waitFor` timed out, and `helm upgrade --wait` failed with the uninformative "post-upgrade hooks
 * failed ... Job in progress".
 *
 * Pure detector (returns violations; empty ⇒ clean) so the standing gate and the explicit NEGATIVE
 * case below share ONE decision function.
 *
 * The check is deliberately structural, and deliberately demands an **ipBlock**: a `namespaceSelector`
 * can NEVER reach the API server (kube-apiserver is a host-networked static pod, not a workload
 * endpoint, and CNIs such as Calico evaluate egress policy against the POST-DNAT destination — the
 * node IP:6443, not the ClusterIP). Without that requirement the pre-existing `allow-argocd` rule
 * (namespaceSelector, ports 80+443) would satisfy a naive "port 443 is allowed" check and this guard
 * would have passed on the very render that was broken in production.
 *
 * ipBlock-ness is necessary but NOT sufficient — see KUBE_API_ENDPOINT_PORT / KUBE_API_REQUIRED_CIDRS
 * / KUBE_API_REQUIRED_RANGES above for the actual reachability constraint (6443 must be allowed, the
 * ipBlocks must cover the private ranges the chart ships, and must not grant more than that) and for
 * the mutations that used to slip past (narrowing the ports, narrowing the CIDRs, and — the
 * complementary failure — widening the CIDRs to something like `0.0.0.0/0` that covers the required
 * ranges while also granting public-internet egress).
 */
function autowireHookKubeApiViolations(label: string, docs: K8sDoc[]): string[] {
  const violations: string[] = [];
  const policies = docs.filter((d) => d.kind === "NetworkPolicy");
  /** Does this single egress rule plausibly reach a kube-apiserver endpoint? Returns the reason it
   *  does NOT, so the violation message can say which half failed. */
  const kubeApiRuleGap = (rule: NpEgressRule): string | undefined => {
    const blocks = (rule.to ?? [])
      .map((t) => t.ipBlock)
      .filter((b): b is NonNullable<typeof b> => Boolean(b));
    if (blocks.length === 0) return "no ipBlock 'to' entry";
    const ports = rule.ports ?? [];
    // An absent/empty `ports` means "every port" in Kubernetes — genuinely reachable.
    const portOk =
      ports.length === 0 ||
      ports.some(
        (p) =>
          (p.protocol ?? "TCP") === "TCP" &&
          typeof p.port === "number" &&
          (p.port === KUBE_API_ENDPOINT_PORT ||
            (typeof p.endPort === "number" &&
              p.port <= KUBE_API_ENDPOINT_PORT &&
              KUBE_API_ENDPOINT_PORT <= p.endPort))
      );
    if (!portOk) {
      return `TCP/${KUBE_API_ENDPOINT_PORT} is not among its ports (${ports
        .map((p) => `${p.protocol ?? "TCP"}/${p.port}${p.endPort ? `-${p.endPort}` : ""}`)
        .join(",")})`;
    }
    const allowed = blocks
      .map((b) => cidrToRange(String(b.cidr ?? "")))
      .filter((r): r is IpRange => r !== undefined);
    const excepted = blocks
      .flatMap((b) => b.except ?? [])
      .map((c) => cidrToRange(String(c)))
      .filter((r): r is IpRange => r !== undefined);
    const covered = subtractRanges(allowed, excepted);
    const missing = KUBE_API_REQUIRED_CIDRS.filter((c) => {
      const req = cidrToRange(c);
      return req === undefined || !rangesCover(covered, req);
    });
    if (missing.length > 0) {
      return `its ipBlocks (${blocks
        .map((b) => b.cidr)
        .join(",")}) do not cover ${missing.join(",")}`;
    }
    // COVERING the three required ranges is necessary but NOT sufficient — a bare `0.0.0.0/0`
    // covers all of them trivially while ALSO granting the hook pod unrestricted egress to the
    // public internet on TCP/6443 (and 443), inside a chart whose entire posture is default-deny
    // and that the air-gap drill exists to certify as zero-egress. So the grant must be bounded
    // from BOTH sides: it must not extend beyond the union of the required private ranges either
    // — computed on `covered` (post-`except`), so an `except` carve-out cannot be used to dodge
    // this any more than it can be used to dodge the coverage check above.
    const excess = subtractRanges(covered, KUBE_API_REQUIRED_RANGES);
    if (excess.length > 0) {
      return (
        `its ipBlocks (${blocks.map((b) => b.cidr).join(",")}) grant egress BEYOND the ` +
        `required private ranges (${KUBE_API_REQUIRED_CIDRS.join(", ")}) — e.g. ${excess
          .map(([s, e]) => (s === e ? ipToStr(s) : `${ipToStr(s)}-${ipToStr(e)}`))
          .join(
            ", "
          )} — which includes public-internet address space; the kube-API allow must be ` +
        `scoped to exactly the required private ranges, never 0.0.0.0/0 or any range that reaches ` +
        `beyond them`
      );
    }
    return undefined;
  };
  // Identify hooks by their COMPONENT LABEL, never by name substring: the rendered Job name embeds
  // the Helm release name, so a release called e.g. `verify-autowire-argocd` would drag the
  // unrelated migrations Job into this check.
  const hookJobs = docs.filter(
    (d) =>
      d.kind === "Job" &&
      /-autowire$/.test(String(d.metadata?.labels?.["app.kubernetes.io/component"] ?? ""))
  );
  if (hookJobs.length === 0) {
    return [`[${label}] expected at least one *-autowire hook Job in this render, found none`];
  }
  // WHAT COUNTS AS "DENY-ALL EGRESS": policyTypes contains Egress and the policy carries NO egress
  // ALLOW RULE. `egress` absent and `egress: []` are the SAME policy to Kubernetes — both deny
  // everything — so both must be recognised here. Matching only `=== undefined` (as this did) made
  // an equally valid `egress: []` default-deny invisible, every hook took the `!denied` branch, and
  // this entire regression guard passed green while the hooks were still being dropped.
  // The old `spec.ingress === undefined` clause is gone too: whether a policy also carries INGRESS
  // rules has no bearing on whether it denies EGRESS, so requiring it was a second way to hide a
  // real deny-all. And it is `filter`+`some`, not `find`: with several policies, the first match is
  // not necessarily the one that selects the hook pod.
  const denyPolicies = policies.filter((np) => {
    const spec = np.spec as { policyTypes?: string[]; egress?: unknown } | undefined;
    return Boolean(spec?.policyTypes?.includes("Egress")) && hasNoAllowRules(spec?.egress);
  });

  for (const job of hookJobs) {
    const jobName = String(job.metadata?.name ?? "<unnamed>");
    const podLabels = podTemplateLabelsOf(job);
    const denied = denyPolicies.some((np) =>
      selectorSelects((np.spec as { podSelector?: LabelSelector }).podSelector, podLabels)
    );
    if (!denied) {
      // networkPolicy.enabled=false ⇒ nothing is enforced anywhere and there is genuinely nothing to
      // check. But if the render DOES contain NetworkPolicies and yet no deny-all selects this hook,
      // the guard would pass VACUOUSLY — the exact silent-pass shape this check exists to prevent —
      // so say so instead of skipping.
      if (policies.length === 0) continue;
      violations.push(
        `[${label}] hook Job '${jobName}' pod (${JSON.stringify(podLabels)}) is NOT selected by any ` +
          `deny-all-egress NetworkPolicy in a render that HAS ${policies.length} NetworkPolicy(s). ` +
          `This chart always renders '-default-deny' over its own selector labels when ` +
          `networkPolicy.enabled, so either that policy was weakened or the hook's labels drifted — ` +
          `and either way the kube-API reachability assertion below would be skipped and this guard ` +
          `would pass without checking anything.`
      );
      continue;
    }

    const gaps: string[] = [];
    const granting = policies.filter((np) => {
      const spec = np.spec as { podSelector?: LabelSelector; egress?: NpEgressRule[] } | undefined;
      if (!selectorSelects(spec?.podSelector, podLabels)) return false;
      let ok = false;
      for (const rule of spec?.egress ?? []) {
        const gap = kubeApiRuleGap(rule);
        if (gap === undefined) ok = true;
        else if (gap !== "no ipBlock 'to' entry")
          gaps.push(`NetworkPolicy/${np.metadata?.name}: ${gap}`);
      }
      return ok;
    });
    if (granting.length === 0) {
      violations.push(
        `[${label}] hook Job '${jobName}' is selected by a deny-all-egress NetworkPolicy but NO ` +
          `NetworkPolicy grants its pod (${JSON.stringify(podLabels)}) a plausible path to the ` +
          `Kubernetes API server. Required, because the CNI evaluates the POST-DNAT destination ` +
          `(<node-ip>:${KUBE_API_ENDPOINT_PORT}, measured 172.18.0.2:6443 on the drill's kind cluster — ` +
          `NOT the 10.96.0.1:443 ClusterIP): an egress rule with ipBlock 'to' entries whose CIDRs cover ` +
          `${KUBE_API_REQUIRED_CIDRS.join(", ")} AND whose ports include TCP/${KUBE_API_ENDPOINT_PORT}. ` +
          `443 alone is NOT enough (it is the pre-DNAT port; the packet the CNI sees is on ` +
          `${KUBE_API_ENDPOINT_PORT}), and a single private range is not enough (kind's node IPs are ` +
          `172.18.0.0/16, k3s' are elsewhere). Its first action is a cross-namespace Secret read ` +
          `against https://kubernetes.default.svc — under an enforced default-deny (the air-gap drill) ` +
          `that read is DROPPED and 'helm upgrade --wait' dies on the hook. Fix ` +
          `networkPolicy.kubeApi (deploy/helm/templates/networkpolicy.yaml, -allow-kube-api-autowire)` +
          (gaps.length > 0 ? `. Closest candidate rule(s) — ${gaps.join("; ")}` : "") +
          `.`
      );
      continue;
    }
    // Blast radius: the granting policy must NOT also cover the ordinary workloads. api/worker keep
    // the unmodified default-deny posture — the kube-API allow is for the short-lived hook pods only.
    for (const np of granting) {
      const sel = (np.spec as { podSelector?: LabelSelector }).podSelector;
      for (const kind of ["api", "worker"]) {
        const deploy = docs.find(
          (d) =>
            d.kind === "Deployment" && d.metadata?.labels?.["app.kubernetes.io/component"] === kind
        );
        if (deploy && selectorSelects(sel, podTemplateLabelsOf(deploy))) {
          violations.push(
            `[${label}] NetworkPolicy/${np.metadata?.name} grants kube-API egress but ALSO selects the ` +
              `'${kind}' Deployment's pods — the API-server allow must be scoped to the auto-wire hook ` +
              `pods only, never the long-running workloads`
          );
        }
      }
    }
  }
  return violations;
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
  // Bundled executor backends (Mode B — e.g. Argo CD) render UNMODIFIED upstream into their OWN
  // namespace; SCP asserts isolation + air-gap on them (see verifyBundledArgocd below), NOT its
  // strict pod-hardening: upstream Argo CD hardens per-container (allowPrivilegeEscalation/
  // readOnlyRootFilesystem/runAsNonRoot on the container) but not pod-level runAsNonRoot, and
  // re-hardening it would fork the engine (the guardian's "unmodified upstream" prohibition). SCP's
  // OWN resources render namespace-agnostic (they take the release namespace), so an explicit
  // metadata.namespace is the marker of a bundled backend to exclude here.
  const workloads = docs.filter(
    (d) =>
      workloadKinds.has(d.kind ?? "") &&
      d.metadata?.name &&
      !String(d.metadata.name).includes("postgres-eval") &&
      !d.metadata?.namespace
  );

  assert(workloads.length > 0, `[${label}] expected at least one Deployment/Job in the render`);

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

  // M9.3 (ADR-0001, in-app federation mTLS) — the kitchen-sink render opts into
  // federation.serverMtls.enabled. Since Node has no per-route TLS (the WHOLE listener becomes
  // HTTPS), the readiness/liveness probes MUST follow or they fail their own TLS handshake
  // against a plain-HTTP-expecting client — a structural check so a future values.yaml/template
  // change that forgets this doesn't silently ship broken probes.
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

  // Bundled backends (Mode B) now live in the SEPARATE `deploy/helm-bundled` chart, delivered via
  // `helm template | kubectl apply` — they exceed Helm's 1 MB release-Secret limit, so they must
  // NEVER ride the main chart's stored release (the M11 regression that motivated the split; see
  // verifyBundledChart + the packaged-size guard in main). Regression guard: the MAIN chart must
  // render ZERO resources into any bundled-backend namespace, on EVERY value set — if a vendored
  // file or render template crept back into deploy/helm, this fails.
  const bundledNamespaces = ["scp-argocd", "scp-argo-workflows", "scp-argo-events", "scp-gitea"];
  // The ONLY main-chart resources allowed in a bundled namespace are the auto-wire hooks' tiny
  // cross-namespace RBAC (a Role + RoleBinding in scp-argocd / scp-gitea, to read the backend's
  // admin secret) — identified by the *-autowire component labels. Anything else means a VENDORED
  // backend (Deployment/CRD/ConfigMap/…) crept back into the release-stored main chart.
  const autowireComponents = new Set(["argocd-autowire", "gitea-autowire"]);
  const strayBundled = docs.filter(
    (d) =>
      bundledNamespaces.includes(d.metadata?.namespace ?? "") &&
      !autowireComponents.has(d.metadata?.labels?.["app.kubernetes.io/component"] ?? "")
  );
  assert(
    strayBundled.length === 0,
    `[${label}] the main chart rendered ${strayBundled.length} non-autowire resource(s) into a bundled-backend namespace (${strayBundled
      .map((d) => `${d.kind}/${d.metadata?.name}`)
      .join(
        ", "
      )}) — bundled backends must live ONLY in deploy/helm-bundled, never the release-stored main chart`
  );
  if (label === "kitchen-sink") {
    // What the main chart DOES keep for bundled backends: enabling argocd / gitea turns on the SCP-
    // side integration — the post-install auto-wire hook Job (mints the scoped backend token) and
    // the allow-<backend> NetworkPolicy egress. Assert both render for each.
    for (const be of ["argocd", "gitea"]) {
      const autowireJob = docs.find(
        (d) => d.kind === "Job" && String(d.metadata?.name).includes(`${be}-autowire`)
      );
      assert(
        autowireJob,
        `[${label}] bundledExecutor.${be}.enabled but no ${be}-autowire hook Job in the main chart`
      );
      const hookAnn = autowireJob?.metadata?.annotations?.["helm.sh/hook"] ?? "";
      assert(
        hookAnn.includes("post-install"),
        `[${label}] ${be}-autowire Job must be a post-install hook (got "${hookAnn}")`
      );
      assert(
        docs.some(
          (d) => d.kind === "NetworkPolicy" && String(d.metadata?.name).includes(`allow-${be}`)
        ),
        `[${label}] bundledExecutor.${be}.enabled but no allow-${be} NetworkPolicy egress in the main chart`
      );
    }
    // ...and the third thing the main chart must keep for them: a path from the hook pods to the
    // Kubernetes API server under the chart's own default-deny. See autowireHookKubeApiViolations.
    for (const v of autowireHookKubeApiViolations(label, docs)) fail(v);
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

  // Executor egress allowlist (networkPolicy.executorEgress, Mode A / BYO-coordinate — SCP's
  // outbound observe/trigger/status/abort calls to a coordinated Argo CD/GitHub/etc). Opt-in and
  // additive: empty (the "defaults" render) must produce ZERO allow-executor-* NetworkPolicies —
  // the default-deny baseline stays byte-for-byte unchanged — while a configured entry (the
  // "kitchen-sink" render below) must produce exactly the configured policy, with BOTH a
  // namespaceSelector `to` entry (in-cluster executor) and an ipBlock `to` entry (external
  // executor) and the configured ports actually present.
  // Internal-egress allowlist (internalEgressHosts -> SCP_INTERNAL_EGRESS_HOSTS, ADR-0003). The
  // application-layer twin of networkPolicy.executorEgress below: it is the HARD boundary for the
  // plugin SSRF egress guard, so the default MUST render nothing at all — an accidental default here
  // would silently let every tenant-configurable plugin reach loopback/RFC1918, which is exactly the
  // hole (MAJOR #6) the guard exists to close. When set, both the api and worker Deployments must
  // carry it (the worker is where the plugin host actually lives).
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

  // Adversarial review MAJOR #2: on the DEFAULT (unconfigured networkPolicy.postgresCidr/natsCidr)
  // values, the Postgres/NATS egress rules must NEVER allow "any destination" — a NetworkPolicy
  // egress rule entry with `ports` but no `to` at all means every destination on that port,
  // including the public internet. Every egress rule entry on every port-scoped
  // allow-postgres/allow-nats NetworkPolicy must carry a `to` with at least one selector/ipBlock.
  // This is a structural check (parsed YAML, not a string grep) so a future regression back to an
  // absent `to:` fails THIS assertion, not just a human reviewer's eyeball pass.
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

/** Assertions for the SEPARATE bundled-backends chart (deploy/helm-bundled), rendered with every
 *  backend enabled + images retargeted. This is where the bundled-backend isolation / air-gap
 *  checks live now that the backends no longer ride the main chart. (Harbor is REMOVED from the
 *  bundled stack — Gitea is the default registry, ADR-0012; an existing Harbor is coordinated via
 *  the import path, not bundled.) */
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

function main(): void {
  if (!helmAvailable()) {
    console.log(
      "helm-verify: SKIP — 'helm' not found on PATH (BUILD_AND_TEST.md §1 requires Helm 3.16+ to " +
        "run this check). This is expected on CI's general Node-only unit-test runner; the " +
        "dedicated 'helm-verify' CI job installs Helm and runs this exact script for real. To run " +
        "it yourself, install Helm and re-run `pnpm --filter @scp/helm-verify test`."
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
      // Main-chart bundled integration: only the SLIM enabled flags exist here now (they turn on the
      // auto-wire hook + allow-argocd NetworkPolicy). The vendored render lives in the
      // separate bundled chart, verified below.
      "--set",
      "bundledExecutor.argocd.enabled=true",
      "--set",
      "bundledExecutor.gitea.enabled=true",
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

  // AIR-GAP REGRESSION GUARD — the bundled-executor auto-wire hooks' path to the Kubernetes API
  // server under the chart's own enforced default-deny. This is what broke the nightly air-gap drill
  // on every scheduled run from 2026-07-13, and `deploy-drills.yml` has NO `pull_request` trigger —
  // so this PR-time job is the only thing that can catch a regression before a nightly does.
  //
  // Checked PER BACKEND, each enabled ALONE, not just together in the kitchen sink: the gitea hook
  // makes the identical `https://kubernetes.default.svc` call and had the identical latent failure,
  // reached only because argocd is enabled first and died first. A fix that happened to work only
  // when both flags are on would be exactly the "fixed the instance, not the class" bug.
  console.log(
    "helm-verify: checking the bundled auto-wire hooks' kube-API egress under default-deny..."
  );
  for (const be of ["argocd", "gitea"]) {
    const docs = renderChart(`verify-autowire-${be}`, [
      "--set",
      `bundledExecutor.${be}.enabled=true`
    ]);
    const violations = autowireHookKubeApiViolations(`autowire-${be}-only`, docs);
    for (const v of violations) fail(v);
    if (violations.length === 0) {
      console.log(
        `  ${be}-only render: hook pods have an ipBlock egress path covering ` +
          `${KUBE_API_REQUIRED_CIDRS.join("/")} on TCP/${KUBE_API_ENDPOINT_PORT} (the POST-DNAT ` +
          `apiserver destination, not the 443 ClusterIP port) — OK`
      );
    }
  }

  // UPGRADE-FROM-A-SHIPPED-RELEASE GUARD — `networkPolicy.kubeApi` is a values map that did NOT
  // exist in previously released charts, and `scripts/scp-bundled.sh` wires a bundled backend with
  // `helm upgrade --reuse-values`. Helm implements that flag by REPLACING the new chart's
  // values.yaml defaults with the OLD release's coalesced values (`chart.Values = oldVals`), so on
  // every existing installation this key is simply ABSENT at render time. `--set
  // networkPolicy.kubeApi=null` reproduces that value tree exactly (both yield nil at that path,
  // and both made the pre-fix template die with
  //   Error: ... at <.Values.networkPolicy.kubeApi.enabled>: nil pointer evaluating interface {}.enabled
  // — i.e. the very command this fix exists to unbreak would have failed EARLIER, at render, for
  // every existing install, while a fresh install looked fine).
  //
  // TWO things must hold, and the second is the one a bare "does it render?" check misses: the
  // policy must still be RENDERED. A nil-safe read that let the absent key mean "disabled" would
  // render happily and then hang the auto-wire hook all over again.
  {
    const label =
      "reuse-values-upgrade (networkPolicy.kubeApi absent, as on any pre-existing release)";
    const upgraded = renderChart("verify-reuse-values", [
      "--set",
      "bundledExecutor.argocd.enabled=true",
      "--set",
      "bundledExecutor.gitea.enabled=true",
      "--set",
      "networkPolicy.kubeApi=null"
    ]);
    assert(
      upgraded.some(
        (d) =>
          d.kind === "NetworkPolicy" && String(d.metadata?.name).includes("allow-kube-api-autowire")
      ),
      `[${label}] rendered without error but produced NO -allow-kube-api-autowire NetworkPolicy — an ` +
        `absent kubeApi key must default to ENABLED with the chart's documented CIDRs/ports, otherwise ` +
        `every 'helm upgrade --reuse-values' from an existing release silently drops the fix and the ` +
        `auto-wire hook hangs exactly as it did before`
    );
    for (const v of autowireHookKubeApiViolations(label, upgraded)) fail(v);
    console.log(
      "  reuse-values upgrade render (kubeApi key absent): policy still rendered and reachable — OK"
    );
  }

  // NEGATIVE case — PROVE the guard above actually fires. Rendering with networkPolicy.kubeApi
  // disabled reproduces the exact pre-fix manifest set (default-deny selects the hook pod; the only
  // other policies covering it are DNS, the RFC1918 DB-port allow, and the backend's
  // namespaceSelector allow — none of which can reach a host-networked apiserver). The detector MUST
  // report a violation for each hook; if a future change made it permissive, THIS assert goes red.
  {
    const guardLabel = "autowire-kube-api-guard";
    const preFix = renderChart("verify-autowire-prefix", [
      "--set",
      "bundledExecutor.argocd.enabled=true",
      "--set",
      "bundledExecutor.gitea.enabled=true",
      "--set",
      "networkPolicy.kubeApi.enabled=false"
    ]);
    const preFixViolations = autowireHookKubeApiViolations(guardLabel, preFix);
    assert(
      preFixViolations.length >= 2,
      `[${guardLabel}] with networkPolicy.kubeApi disabled BOTH auto-wire hooks must be flagged as having no kube-API egress path (that is the shipped-broken state); got ${preFixViolations.length} violation(s)`
    );
    for (const be of ["argocd", "gitea"]) {
      assert(
        preFixViolations.some((v) => v.includes(`${be}-autowire`)),
        `[${guardLabel}] the negative case must name the ${be}-autowire hook Job; got: ${preFixViolations.join("; ")}`
      );
    }
    console.log(`  negative case (networkPolicy.kubeApi disabled) correctly flagged both hooks`);
  }

  // NEGATIVE cases 2+3 — the two MUTATIONS that used to slip past this guard while leaving the hook
  // just as dead on a real cluster. Both render a perfectly valid, ipBlock-backed, 443-bearing
  // -allow-kube-api-autowire policy; both are unreachable post-DNAT. If someone loosens
  // kubeApiRuleGap back to "any ipBlock rule mentioning 443 or 6443", THESE go red.
  for (const [what, setArgs, why] of [
    [
      "ports narrowed to [443]",
      ["--set-json", "networkPolicy.kubeApi.ports=[443]"],
      "443 is the pre-DNAT ClusterIP port; the packet the CNI actually evaluates is <node-ip>:6443 (measured 172.18.0.2:6443 on kind)"
    ],
    [
      "cidrs narrowed to [10.0.0.0/8]",
      ["--set-json", 'networkPolicy.kubeApi.cidrs=["10.0.0.0/8"]'],
      "kind's node IPs are 172.18.0.0/16 — outside 10/8 — so the drill's own cluster is not covered"
    ]
  ] as [string, string[], string][]) {
    const guardLabel = `autowire-kube-api-guard (${what})`;
    const mutated = renderChart("verify-autowire-mutation", [
      "--set",
      "bundledExecutor.argocd.enabled=true",
      "--set",
      "bundledExecutor.gitea.enabled=true",
      ...setArgs
    ]);
    const mutatedViolations = autowireHookKubeApiViolations(guardLabel, mutated);
    assert(
      mutatedViolations.length >= 2,
      `[${guardLabel}] this render must be flagged for BOTH hooks — ${why}. The guard must encode real ` +
        `reachability, not "an ipBlock rule exists on some kube-ish port"; got ${mutatedViolations.length} violation(s)`
    );
    console.log(`  negative case (${what}) correctly flagged both hooks`);
  }

  // NEGATIVE case — WIDENING. This is the complementary failure to the two narrowing mutations
  // above: `cidrs: ["0.0.0.0/0"]` trivially COVERS all three required RFC1918 ranges (so a
  // coverage-only check waves it through — verified: this render passed 'all hardened-defaults
  // assertions passed' before this case existed), while ALSO granting the hook pods unrestricted
  // public-internet egress on TCP/6443 (and 443) — inside a chart whose whole posture is
  // default-deny and that the air-gap drill exists to certify as zero-egress. The guard must bound
  // the grant from BOTH sides — "at least" is not "exactly" — or a widened CIDR list sails through
  // exactly as a narrowed one used to.
  {
    const guardLabel = "autowire-kube-api-guard (cidrs widened to [0.0.0.0/0])";
    const widened = renderChart("verify-autowire-widen", [
      "--set",
      "bundledExecutor.argocd.enabled=true",
      "--set",
      "bundledExecutor.gitea.enabled=true",
      "--set-json",
      'networkPolicy.kubeApi.cidrs=["0.0.0.0/0"]'
    ]);
    const widenedViolations = autowireHookKubeApiViolations(guardLabel, widened);
    assert(
      widenedViolations.length >= 2,
      `[${guardLabel}] this render must be flagged for BOTH hooks — 0.0.0.0/0 covers the required ` +
        `private ranges but ALSO grants the hook pods egress to the entire public internet, which a ` +
        `chart whose whole posture is default-deny must never accept. The guard must encode BOTH a ` +
        `lower bound (covers the required ranges) and an upper bound (extends no further than them), ` +
        `not coverage alone; got ${widenedViolations.length} violation(s)`
    );
    assert(
      widenedViolations.every((v) => v.includes("BEYOND the required private ranges")),
      `[${guardLabel}] the violations for this render must name the specific defect — grant extends ` +
        `beyond the required private ranges — not some unrelated gap; got: ${JSON.stringify(widenedViolations)}`
    );
    console.log("  negative case (cidrs widened to 0.0.0.0/0) correctly flagged both hooks");
  }

  // NEGATIVE case 4 — default-deny written as `egress: []` instead of omitting the field. Kubernetes
  // treats the two identically; a detector that recognises only the omitted form sees NO default-deny,
  // skips every hook, and reports success on a render whose hooks are still dropped. Synthetic docs
  // rather than a render, because the chart cannot be coaxed into emitting the empty-list form —
  // which is exactly why the hole survived review.
  {
    const guardLabel = "autowire-kube-api-guard (default-deny as `egress: []`)";
    const hookLabels = {
      "app.kubernetes.io/name": "commanderscp",
      "commanderscp.io/autowire-hook": "true"
    };
    const synthetic: K8sDoc[] = [
      {
        kind: "NetworkPolicy",
        metadata: { name: "synthetic-default-deny" },
        // The evasion: an ALLOW-RULE-FREE egress list spelled as [] rather than omitted.
        spec: {
          podSelector: { matchLabels: { "app.kubernetes.io/name": "commanderscp" } },
          policyTypes: ["Egress"],
          egress: []
        }
      },
      {
        kind: "Job",
        metadata: {
          name: "synthetic-argocd-autowire",
          labels: { "app.kubernetes.io/component": "argocd-autowire" }
        },
        spec: { template: { metadata: { labels: hookLabels } } }
      }
    ];
    const syntheticViolations = autowireHookKubeApiViolations(guardLabel, synthetic);
    // NOT a bare count. With only one NetworkPolicy and one hook Job in this synthetic set, BOTH
    // branches of the detector produce exactly one violation — the buggy `hasNoAllowRules` (i.e.
    // `=== undefined` only) sees `egress: []` as NOT deny-all, so the hook is reported as "not
    // selected by any deny-all-egress policy" (a DIFFERENT, WRONG diagnosis, and one that would
    // also fire on a render with no NetworkPolicy at all). Asserting only `.length >= 1` cannot
    // tell these apart and would stay green through that exact regression. So pin down the
    // SPECIFIC violation the fixed detector must produce: the hook IS recognised as denied by the
    // `egress: []` policy, and THEN found to lack a kube-API path.
    const correctlyDenied = syntheticViolations.some(
      (v) =>
        v.includes("synthetic-argocd-autowire") &&
        v.includes("is selected by a deny-all-egress NetworkPolicy but NO") &&
        v.includes("plausible path to the Kubernetes API server")
    );
    const wronglyUnselected = syntheticViolations.some((v) => v.includes("is NOT selected by any"));
    assert(
      correctlyDenied && !wronglyUnselected,
      `[${guardLabel}] a deny-all-egress policy written as 'egress: []' must still be recognised as ` +
        `default-deny, and the hook must then be reported as DENIED-with-no-kube-API-path — not as ` +
        `"not selected by any deny-all-egress policy" (the wrong diagnosis a detector matching only ` +
        `'egress === undefined' produces, since it never counts the [] policy as denying anything, ` +
        `and which is just as green a violation count while checking nothing this case exists to ` +
        `check); got: ${JSON.stringify(syntheticViolations)}`
    );
    console.log(
      `  negative case (default-deny as \`egress: []\`) correctly recognised as deny-all`
    );
  }

  // M16.3 P3 — the MAIN chart's `federationRole` value must reach the api/worker containers as
  // `SCP_FEDERATION_ROLE` (templates/_helpers.tpl's `commanderscp.commonEnv`), the runtime knob
  // `config.ts`'s `loadFederationRole` reads to gate SPA registration (`app.ts`) off for a
  // `retrans` relay. Unlike the M15.4 bundled-backend guardrail above (a render-time LINT only —
  // that one is explicitly NOT runtime authority, per that block's own comment), THIS is asserting
  // the actual wiring a live pod boots with: render the main chart with `federationRole=retrans`
  // and check the env var landed, by name, on both Deployments' `scpd` containers. A regression
  // that dropped this env var from `commonEnv` (or reverted app.ts's gate) would leave a retrans
  // instance silently serving the SPA again — exactly the defect this milestone fixes — so this
  // assertion is what keeps it caught at render time, permanently, in CI.
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

  // ------------------------------------------------------------------------------------------
  // OPERATOR CONFIG SURFACE — the chart must be able to configure the profiles the server ships.
  //
  // WHY THIS EXISTS. M13 and M14 both shipped operator env vars with no chart deliverable in
  // their DoDs, and the gap was invisible because nothing asserted on it: `commanderscp.commonEnv`
  // renders a FIXED list, there is no generic `extraEnv` escape hatch, and a var that is simply
  // absent produces a perfectly healthy pod running with the feature off. The result was a chart
  // that provisioned a scan-DB PVC for a scanner it could not start and mounted federation client
  // certs for a sync loop it could not enable. This block is the standing guard against the next
  // one: every knob below is asserted BOTH ways — absent by default, present and correct when
  // asked for — so "the server grew a knob and the chart did not" fails at render time in CI.
  //
  // DEFAULT-ABSENT IS THE LOAD-BEARING HALF. Every loop here is opt-in on the server side
  // (`=== "1"`), so a chart that rendered `SCP_INBOX_LOOP=0` would still be wrong-ish but harmless,
  // while one that rendered it unconditionally as "1" would start unattended byte movement at a
  // CDS boundary on a default `helm install`. Assert the vars are ABSENT, not merely falsy.
  // ------------------------------------------------------------------------------------------
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
      "SCP_ARTIFACT_OCI_REGISTRY_HOSTS",
      "SCP_ARTIFACT_BLOB_BASE_URLS",
      "SCP_ARTIFACT_INSECURE_HOSTS",
      "SCP_INTERNAL_BASE_URL"
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
    // Comma-joined, in values order — the parse the server does (`parseRegistryHostList`).
    bothHave(onDocs, "SCP_ARTIFACT_OCI_REGISTRY_HOSTS", "reg.example.com:5000,mirror.example.com");
    bothHave(onDocs, "SCP_ARTIFACT_BLOB_BASE_URLS", "https://blobs.example.com");
    bothHave(onDocs, "SCP_ARTIFACT_INSECURE_HOSTS", "reg.example.com:5000");
    assert(
      envOf(onDocs, "-api", "SCP_ROLE")?.value === "all",
      `[${envLabel}] api.role=all must render SCP_ROLE=all on the api Deployment (the knob that unblocks POST /discovery/run on a two-Deployment install)`
    );
    console.log(`  enabled render: every knob present + correct on BOTH Deployments`);

    // The operator token is a secretKeyRef, never a literal — a token rendered as a plain env
    // VALUE would sit in the Deployment spec for anyone with `get deploy`.
    const opDocs = renderChart(releaseName, [
      "--set",
      "operatorApi.enabled=true",
      "--set",
      "appSecrets.existingSecret=scp-operator"
    ]);
    for (const suffix of ["-api", "-worker"]) {
      const found = envOf(opDocs, suffix, "SCP_OPERATOR_TOKEN");
      assert(
        found?.value === undefined && found?.valueFrom?.secretKeyRef?.name === "scp-operator",
        `[${envLabel}] SCP_OPERATOR_TOKEN must be a secretKeyRef (never a literal value) on the ${suffix.slice(1)} Deployment`
      );
    }

    // FAIL-FAST GUARDS — both must REFUSE to render. A typo'd role or an operator token with no
    // Secret behind it would otherwise surface as a healthy-looking install that misbehaves at
    // runtime (a 400 from /discovery/run; a pod crash-looping on a missing secret key).
    for (const [args, what] of [
      [["--set", "api.role=worker"], "api.role=worker"],
      [
        ["--set", "operatorApi.enabled=true"],
        "operatorApi.enabled with no appSecrets.existingSecret"
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
    console.log(`  operator token is a secretKeyRef; both fail-fast guards refuse to render`);
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

    // NEGATIVE: a `retrans` CDS-boundary relay is a validate-and-forward node, NOT an execution site
    // — it may bundle NOTHING. Enabling gitea on it is exactly the misconfiguration the lint exists
    // to catch. We PROVE the lint fires: render retrans + gitea, and assert the guardrail returns a
    // violation naming the role + the offending backend. This is a REAL suite assertion — if a
    // future change made the guardrail permissive, THIS assert fails and helm-verify goes red.
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

  // ================================================================================================
  // M23.2 — THE KUBERNETES RUNNER LAUNCHER'S CHART CONTRACT
  // ================================================================================================
  // Four properties, and every one of them is something a `helm install` gets wrong SILENTLY. The
  // adapter itself is gated by `kubernetes-adapter.kind.test.ts` against a real cluster (CI job 4e);
  // what THAT cannot see is whether the chart hands it a token, an egress path, a volume and the
  // settings to use them. A managed run then fails minutes into a promotion, on a cluster, with a
  // timeout — which is the worst place to discover any of it.
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

    // (2b) M23.5 MEDIUM-10 — THE RUNNER POD'S OWN DENY-ALL, PROVEN TO SELECT THE POD.
    //
    //      ADR-0035 §6a's "an operator on Calico/Cilium loses nothing" is a claim about a
    //      NetworkPolicy that must actually SELECT the runner pod, not merely exist in the chart. A
    //      podSelector rendered by Helm and a pod template built by `jobManifest()` are two
    //      independent sources of truth for the SAME label; this reads both and checks the subset
    //      relationship the API server itself applies, rather than asserting they were WRITTEN to
    //      agree.
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

    // (3) THE PER-RUN SECRET GRANT — DECLARED HERE, NOT TOLERATED HERE.
    //
    //     THIS BLOCK INVERTED IN M23.4 AND THE INVERSION IS THE POINT OF WRITING IT DOWN. Until then
    //     it asserted the grant was ABSENT: `perRunSecrets` was a declared-and-disabled capability
    //     and this gate's job was to keep it disabled. The owner granted the RBAC on 2026-08-20
    //     ("grant the secrets RBAC, keep going"), so the default render now carries a privilege it
    //     did not carry before. A hardened-defaults gate that simply stopped failing on that would
    //     be worse than no gate — it would have quietly accepted a privilege grant. So the gate does
    //     not stop asserting; it asserts the OPPOSITE, plus the exact SHAPE of what was granted, so
    //     that any FURTHER widening (a `get`, a `list`, a `*`, a second resource) is a red build.
    //
    //     WHAT IS ACCEPTED, EXHAUSTIVELY: `create` and `delete` on `""/secrets`, namespaced, on the
    //     worker ServiceAccount, rendered only where a managed run can actually launch. The
    //     reasoning, the alternatives and the combination the owner accepted along with it are in
    //     ADR-0035; this is the machine-checked half of that record.
    const runnerRole = (docs: K8sDoc[]) =>
      docs.find((d) => d.kind === "Role" && String(d.metadata?.name ?? "").endsWith("-runner-iac"));
    const roleOn = runnerRole(k8s);
    assert(roleOn, `[${label}] no runner Role rendered with the Kubernetes launcher selected`);
    // THE WHOLE ROLE, AS A SET, AGAINST WHAT THE ADAPTER ISSUES — the M23.6 clause 5 gate. This
    // subsumes the two assertions that used to stand here: the `patch` the harness found missing
    // (the adapter creates the Job SUSPENDED and PATCHes it live, so without it `start` is a 403 for
    // every run) and the `events: list` M23.5 added (when a Job cannot create a pod at all, the
    // controller's `FailedCreate` Event is the only record of why, and teardown deletes the Job).
    // Both are now MISSING-verb findings of the same diff, which also reports the opposite.
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

    // (3a-guard) M23.5 MEDIUM-7 — THE DEFAULT POSTURE IS A RENDER-TIME REFUSAL, NOT A README LINE.
    //
    //     `perRunSecrets` defaults `true` and grants `delete` on EVERY Secret in whatever namespace
    //     this Role renders into (see the assertion above pinning the verb set). Proved with the
    //     worker's own token against a live cluster: `DELETE .../secrets/scp-commanderscp-db ->
    //     Success`. Before this guard, an operator who took every OTHER default got that blast
    //     radius over their own release's Secrets with no signal at install time. Three cases: the
    //     unsafe combination refuses; each of the three documented escapes renders clean.
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

    // (3b) THE RBAC EXISTS FOR ALL THREE MANAGED CLASSES, NOT ONLY THE ONE IT WAS NAMED AFTER.
    //
    //      A MEASURED DEFECT, NOT A TIDINESS RULE. Before M23.4 this Role was gated on
    //      `managedIac.enabled` while the service-account token, the kube-API egress allow, the
    //      workspace mount and every launcher setting were gated on "any managed class". Case (a)
    //      above proves the TOKEN arrives for a dep-only render; nothing proved the AUTHORISATION
    //      did, and it did not — `helm template` with managedDep alone rendered no Role and no
    //      RoleBinding at all, so the worker authenticated and every `jobs: create` was a 403.
    //      managed-dep, the one class that writes to a user's repository, was dead on Kubernetes.
    //      That is the incomplete-call-site-census property, and this loop is the census.
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

    // (3c) THE ROLE FOLLOWS THE RUNNER NAMESPACE. `managedRunners.kubernetes.namespace` has been
    //      operator-settable since M23.2 and the adapter creates its Jobs there; the Role was
    //      rendered unconditionally into `.Release.Namespace`, so taking the chart's own advice and
    //      separating the runners produced a silent 403 on every launch. Both now come from one
    //      helper, and this is what keeps them from drifting apart again.
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
    // (5) EVERY WORKER-ROLE WRITE PATH, ON EVERY POD THAT RUNS THE WORKER ROLE (M23.5).
    //
    //     THIS BLOCK EXISTS BECAUSE EVERYTHING ABOVE IT LOOKS AT `-worker` AND NOTHING LOOKS AT
    //     `-api`. `helm template --set api.role=all --set worker.replicaCount=0` — the single-pod
    //     topology `values.yaml` documents by name — put the token and every launcher setting on the
    //     api pod (M23.2 fixed the token for exactly that reason) and mounted NOTHING at
    //     `SCP_MANAGED_RUNNER_K8S_WORKSPACE_ROOT`. Copy-in wrote to the api container's ephemeral
    //     filesystem, the runner Job mounted the real claim and found an empty directory, and
    //     managed-iac's copy-out is `when:"always" / onFailure:"swallow"`, so the run reported
    //     nothing wrong. `assertRunnerPrerequisites` refuses a render whose claim is MISSING and
    //     rendered happily for the topology where it is named and never mounted.
    //
    //     AND THE ASSERTION THAT WAS ALREADY HALF-WRITTEN. The operator-config-surface block above
    //     says, in its own comment, "a knob wired into only one of them is a silent half-fix (the
    //     loops run on the worker, but an `api.role=all` pod runs them too)" — and applies that rule
    //     to env vars and to nothing else. So the api pod's TOKEN, its launcher settings and its
    //     volumes were all unasserted: reverting `deployment-api.yaml`'s conditional
    //     `automountServiceAccountToken` to the hard `false` it shipped with before M23.2 reddened
    //     nothing in this file. One predicate, both pods, all of it.
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

    // (6) THE POD CONVENTIONS THE RUNNER JOB INHERITS (M23.5).
    //
    //     THE COUNT IS THE FINDING. This chart creates SIX pods; five are templates in this repo and
    //     every one of them carries `.Values.imagePullSecrets`, `.Values.image.pullPolicy` and a
    //     `resources` block. The sixth is built by `jobManifest()` at run time from
    //     `managedRunnerSettings()`, which described a namespace, a workspace and two booleans — so
    //     it inherited none of them, and not just the two that were reported. Measured on a real
    //     cluster with the image already on the node and tagged `:latest`: `spawn-failed,
    //     code=ErrImagePull`, while the identical image ran fine under `docker create`. An unset
    //     `imagePullPolicy` is `Always` for `:latest` — charter principle 5, broken in production.
    //
    //     ASSERTED ON THE CHART SIDE BECAUSE THAT IS THE HALF NO UNIT TEST CAN SEE. The golden pins
    //     what `jobManifest` does with these values; `managed-runner-selection.test.ts` pins how the
    //     server parses them. Neither can answer whether a `helm install` ever emits one.
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

      // (6c) `resources` — ABSENT unless set, and verbatim JSON when it is. The chart ships no
      //      default deliberately (a guessed memory limit OOMKills a real `tofu apply`, which looks
      //      like a runner bug); what it must not do is silently drop the value an operator DID set,
      //      because a namespace with a compute ResourceQuota and no defaulting LimitRange rejects a
      //      pod that declares none and no pod is then ever created.
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

  if (failures.length > 0) {
    console.error(`\nhelm-verify: ${failures.length} assertion(s) FAILED:\n`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log("\nhelm-verify: all hardened-defaults assertions passed.");
}

main();
