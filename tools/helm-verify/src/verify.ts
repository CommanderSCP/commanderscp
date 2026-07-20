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
 * top-level `pnpm test` (Turborepo picks up this package's `test` script), which also runs on
 * CI's general Node-only runner (`homelab-commanderscp-linux-general` — no Helm pre-provisioned).
 * A hard ENOENT there would fail every PR's unit-test stage for a tool-availability gap, not a
 * real regression. The assertions below are still a REAL gate: `.github/workflows/ci.yml`'s
 * dedicated `helm-verify` job installs Helm first (`azure/setup-helm@v4`) before running this
 * exact script, so a loosened `values.yaml` genuinely fails CI there — see that job's own
 * comment. Locally, any dev with Helm on PATH gets the real check for free via `pnpm test`.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseAllDocuments } from "yaml";

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

/** Pure detector: given a role and a rendered bundled chart, return the list of guardrail
 *  violations (a bundled backend that rendered but is not allowed for that role). Empty ⇒ clean.
 *  This is the single decision function shared by the standing gate (feeds `fail()` → non-zero exit)
 *  and the explicit negative-case test below (asserts it fires). */
function federationRoleViolations(role: string, docs: K8sDoc[]): string[] {
  const allowed = ALLOWED_BUNDLED_BACKENDS_BY_ROLE[role];
  if (!allowed) {
    return [`unknown federationRole '${role}' — expected one of ${Object.keys(ALLOWED_BUNDLED_BACKENDS_BY_ROLE).join("|")}`];
  }
  const allowedList = [...allowed].join(", ") || "none";
  const violations: string[] = [];
  for (const [backend, ns] of Object.entries(BACKEND_NAMESPACES)) {
    const enabled = docs.some((d) => d.metadata?.namespace === ns || (d.kind === "Namespace" && d.metadata?.name === ns));
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

function assert(condition: unknown, msg: string): void {
  if (!condition) fail(msg);
}

function renderDir(dir: string, releaseName: string, setArgs: string[]): K8sDoc[] {
  const args = ["template", releaseName, dir, ...setArgs];
  const output = execFileSync("helm", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
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

interface Container {
  name: string;
  image?: string;
  env?: { name: string; value?: string; valueFrom?: unknown }[];
  securityContext?: {
    allowPrivilegeEscalation?: boolean;
    readOnlyRootFilesystem?: boolean;
    capabilities?: { drop?: string[] };
    seccompProfile?: { type?: string };
  };
  readinessProbe?: { httpGet?: { path?: string; port?: string; scheme?: string } };
  livenessProbe?: { httpGet?: { path?: string; port?: string; scheme?: string } };
}

interface PodSpec {
  securityContext?: { runAsNonRoot?: boolean; seccompProfile?: { type?: string } };
  containers?: Container[];
  initContainers?: Container[];
}

function podSpecOf(doc: K8sDoc): PodSpec | undefined {
  if (doc.kind === "Deployment" || doc.kind === "Job") {
    const spec = doc.spec as { template?: { spec?: PodSpec } } | undefined;
    return spec?.template?.spec;
  }
  return undefined;
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
  const migrationsJob = docs.find((d) => d.kind === "Job" && String(d.metadata?.name).includes("-migrate-"));
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

  const apiDeploy = docs.find((d) => d.kind === "Deployment" && String(d.metadata?.name).endsWith("-api"));
  const workerDeploy = docs.find((d) => d.kind === "Deployment" && String(d.metadata?.name).endsWith("-worker"));
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
    assert(apiImage && apiImage === workerImage, `[${label}] api and worker must use the SAME image (got api=${apiImage}, worker=${workerImage})`);
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
      .join(", ")}) — bundled backends must live ONLY in deploy/helm-bundled, never the release-stored main chart`
  );
  if (label === "kitchen-sink") {
    // What the main chart DOES keep for bundled backends: enabling argocd / gitea turns on the SCP-
    // side integration — the post-install auto-wire hook Job (mints the scoped backend token) and
    // the allow-<backend> NetworkPolicy egress. Assert both render for each.
    for (const be of ["argocd", "gitea"]) {
      const autowireJob = docs.find(
        (d) => d.kind === "Job" && String(d.metadata?.name).includes(`${be}-autowire`)
      );
      assert(autowireJob, `[${label}] bundledExecutor.${be}.enabled but no ${be}-autowire hook Job in the main chart`);
      const hookAnn = autowireJob?.metadata?.annotations?.["helm.sh/hook"] ?? "";
      assert(
        hookAnn.includes("post-install"),
        `[${label}] ${be}-autowire Job must be a post-install hook (got "${hookAnn}")`
      );
      assert(
        docs.some((d) => d.kind === "NetworkPolicy" && String(d.metadata?.name).includes(`allow-${be}`)),
        `[${label}] bundledExecutor.${be}.enabled but no allow-${be} NetworkPolicy egress in the main chart`
      );
    }
  }

  // NetworkPolicy — default-deny AND at least one explicit allow, both present.
  const networkPolicies = docs.filter((d) => d.kind === "NetworkPolicy");
  assert(networkPolicies.length >= 2, `[${label}] expected multiple NetworkPolicies (default-deny + explicit allows), got ${networkPolicies.length}`);
  const defaultDeny = networkPolicies.find((np) => {
    const spec = np.spec as { policyTypes?: string[]; ingress?: unknown; egress?: unknown } | undefined;
    return (
      spec?.policyTypes?.includes("Ingress") &&
      spec?.policyTypes?.includes("Egress") &&
      spec.ingress === undefined &&
      spec.egress === undefined
    );
  });
  assert(defaultDeny, `[${label}] expected a default-deny NetworkPolicy (policyTypes [Ingress,Egress], no ingress/egress rules)`);
  const explicitAllowEgress = networkPolicies.some((np) => {
    const spec = np.spec as { egress?: unknown[] } | undefined;
    return Array.isArray(spec?.egress) && spec!.egress!.length > 0;
  });
  assert(explicitAllowEgress, `[${label}] expected at least one NetworkPolicy with an explicit egress allow (e.g. DNS)`);

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
        | { egress?: { to?: ExecEgressTo[]; ports?: { port?: number }[] }[] }
        | undefined;
      const rule = spec?.egress?.[0];
      assert(
        Array.isArray(rule?.to) &&
          rule!.to!.some((t) => t.namespaceSelector?.matchLabels?.["kubernetes.io/metadata.name"] === "argocd"),
        `[${label}] allow-executor-argocd must carry a namespaceSelector 'to' entry for namespace argocd`
      );
      assert(
        Array.isArray(rule?.to) && rule!.to!.some((t) => t.ipBlock?.cidr === "203.0.113.0/24"),
        `[${label}] allow-executor-argocd must carry an ipBlock 'to' entry for the configured CIDR`
      );
      assert(
        Array.isArray(rule?.ports) && rule!.ports!.some((p) => p.port === 8080) && rule!.ports!.some((p) => p.port === 80),
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
      const touchesDbPort = (rule.ports ?? []).some((p) => typeof p.port === "number" && dbPorts.has(p.port));
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
      "--set", "postgres.evalInCluster.enabled=true",
      "--set", "managedIac.enabled=true",
      "--set", "managedIac.runnerImage=ghcr.io/commanderscp/scp-runner-iac:0.1.0",
      "--set", "federation.mtls.enabled=true",
      "--set", "federation.mtls.existingSecret=my-fed-cert",
      "--set", "federation.serverMtls.enabled=true",
      "--set", "federation.serverMtls.existingSecret=my-fed-server-mtls",
      "--set", "federation.serverMtls.crl.enabled=true",
      "--set", "federation.serverMtls.crl.existingSecret=my-fed-server-mtls-crl",
      "--set", "ingress.enabled=true",
      "--set", "ingress.host=scp.example.com",
      "--set", "ingress.mtls.enabled=true",
      "--set", "ingress.mtls.caSecretName=fed-ca",
      "--set", "serviceMonitor.enabled=true",
      "--set", "objectStorage.provider=s3",
      "--set", "eventBus.backend=nats",
      "--set", "eventBus.natsUrl=nats://nats:4222",
      "--set", "worker.hpa.enabled=true",
      "--set", "oidc.enabled=true",
      "--set", "oidc.issuer=https://idp.example.com",
      "--set", "oidc.clientId=scp",
      "--set", "oidc.redirectUri=https://scp.example.com/callback",
      // Main-chart bundled integration: only the SLIM enabled flags exist here now (they turn on the
      // auto-wire hook + allow-argocd NetworkPolicy). The vendored render lives in the
      // separate bundled chart, verified below.
      "--set", "bundledExecutor.argocd.enabled=true",
      "--set", "bundledExecutor.gitea.enabled=true",
      // Executor egress allowlist (Mode A / BYO-coordinate) — one entry exercising BOTH `to` shapes
      // at once (an in-cluster namespaceSelector AND an external ipBlock) plus multiple ports.
      "--set-json", 'networkPolicy.executorEgress=[{"name":"argocd","namespaces":["argocd"],"cidrs":["203.0.113.0/24"],"ports":[{"protocol":"TCP","port":8080},{"protocol":"TCP","port":80}]}]',
      // Operator half of the two-layer internal-egress model (ADR-0003) — the application-layer SSRF
      // guard's hard boundary. Pairs with networkPolicy.executorEgress above: the same "what may this
      // pod reach" decision, enforced once at the k8s layer and once inside the plugin host.
      "--set-json", 'internalEgressHosts=["argocd-server.argocd.svc.cluster.local"]'
    ])
  );

  // Size-regression guard: the MAIN chart's Helm release Secret must stay under Kubernetes' 1 MB
  // limit. Helm stores base64(gzip(whole chart)) in the release — a vendored backend manifest
  // creeping into deploy/helm would blow past 1 MB and break `helm install` outright (the M11
  // regression that motivated the deploy/helm-bundled split). Package + measure.
  console.log("helm-verify: checking the main chart's packaged size stays under Helm's 1 MB release limit...");
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
      "--set", "bundledExecutor.argocd.enabled=true",
      "--set", "bundledExecutor.argocd.image=registry.example.com/scp/argocd:v3.4.5",
      "--set", "bundledExecutor.argocd.valkeyImage=registry.example.com/scp/valkey:8.2.3",
      "--set", "bundledExecutor.argoWorkflows.enabled=true",
      "--set", "bundledExecutor.argoWorkflows.serverImage=registry.example.com/scp/argocli:v4.0.7",
      "--set", "bundledExecutor.argoWorkflows.controllerImage=registry.example.com/scp/workflow-controller:v4.0.7",
      "--set", "bundledExecutor.argoEvents.enabled=true",
      "--set", "bundledExecutor.argoEvents.image=registry.example.com/scp/argo-events:v1.9.10",
      "--set", "bundledExecutor.gitea.enabled=true",
      "--set", "bundledExecutor.gitea.image=registry.example.com/scp/gitea:1.26.1-rootless"
    ])
  );

  // M15.4 federation-role guardrail (CHART-RENDER-TIME LINT, NOT runtime authority) — explicit
  // positive AND negative cases. The operator sets both federationRole and the enabled flags; this
  // lint catches the misconfiguration of a role enabling a backend it should not run.
  console.log("helm-verify: checking the M15.4 federation-role bundled-backend guardrail (render-time lint)...");
  {
    const guardLabel = "federation-role-guardrail";

    // POSITIVE: an `outpost` may run gitea + argocd (self-contained deploy target, ADR-0012). The
    // role label must be stamped on the render, and the guardrail must find ZERO violations.
    const okDocs = renderBundledChart([
      "--set", "federationRole=outpost",
      "--set", "bundledExecutor.gitea.enabled=true",
      "--set", "bundledExecutor.gitea.image=registry.example.com/scp/gitea:1.26.1-rootless",
      "--set", "bundledExecutor.argocd.enabled=true",
      "--set", "bundledExecutor.argocd.image=registry.example.com/scp/argocd:v3.4.5",
      "--set", "bundledExecutor.argocd.valkeyImage=registry.example.com/scp/valkey:8.2.3"
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
      "--set", "federationRole=retrans",
      "--set", "bundledExecutor.gitea.enabled=true",
      "--set", "bundledExecutor.gitea.image=registry.example.com/scp/gitea:1.26.1-rootless"
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
    for (const v of federationRoleViolations(renderedFederationRole(badDocs), badDocs)) wouldFail.push(v);
    assert(
      wouldFail.length > 0,
      `[${guardLabel}] a disallowed (role, enabled-backends) render must produce a helm-verify failure (non-zero exit); it produced none`
    );
    console.log(
      `  positive (outpost + gitea/argocd) clean; negative (retrans + gitea) correctly flagged: "${badViolations[0]}"`
    );
  }

  if (failures.length > 0) {
    console.error(`\nhelm-verify: ${failures.length} assertion(s) FAILED:\n`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log("\nhelm-verify: all hardened-defaults assertions passed.");
}

main();
