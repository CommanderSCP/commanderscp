/**
 * THE VALIDATOR for SCP-authored Applications (M28.4, ADR-0055 D9) — run by the plugin before any
 * write AND by the server on everything it authors (forward and rollback), so both layers apply ONE
 * rule.
 *
 * It checks a document against what the OPERATOR declared on the execution-system
 * (`properties.authoring`) and refuses it unless it is exactly something the server could render: the
 * registered carrier at its pinned revision, the scoped authoring project, an allowlisted namespace on
 * an allowlisted destination, and only the authored kinds in the exact shape the renderer writes.
 * Anything else is a way to reach the cluster through Argo CD (a ClusterRoleBinding in the values, a
 * foreign repo, another cluster, `hostPort`, an unconfined AppArmor annotation, a notifications
 * webhook) or to drive a Rollout (`spec.paused`, an indefinite `pause: {}`, a `status`).
 *
 * A VALUE-LEVEL ALLOWLIST at every level (review round 2): keys AND values. Every refusal message
 * names the refused property and never echoes an identifier from the document, so it is safe to
 * persist on a Decision.
 */

/** The only kinds an authored Application may carry — `@scp/schemas` `AUTHORED_MANIFEST_KINDS`,
 *  duplicated because this package takes no schemas dependency; pinned equal by a server test. */
export const AUTHORED_MANIFEST_KINDS: readonly { group: string; kind: string }[] = [
  { group: "argoproj.io", kind: "Rollout" },
  { group: "", kind: "Service" }
];

/** `@scp/schemas` `FORBIDDEN_AUTHORING_NAMESPACES`, duplicated for the same reason. */
const FORBIDDEN_NAMESPACES = ["default", "kube-system", "kube-public", "kube-node-lease"];

/** Argo CD's in-cluster destination (the server's `IN_CLUSTER_SERVER`). */
export const IN_CLUSTER_SERVER = "https://kubernetes.default.svc";

const APPLICATION_LABELS: Readonly<Record<string, string | null>> = {
  // `null` = any non-empty string (an identity the caller compares separately).
  "app.kubernetes.io/managed-by": "commanderscp",
  "commanderscp.io/authored": "true",
  "commanderscp.io/org": null,
  "commanderscp.io/component": null,
  "commanderscp.io/target": null
};
const APPLICATION_ANNOTATIONS = ["commanderscp.io/change", "commanderscp.io/rollout-source"];
const MANIFEST_ANNOTATIONS = ["commanderscp.io/change"];

export interface AuthoringConfig {
  repoURL: string;
  path?: string;
  chart?: string;
  targetRevision: string;
  project: string;
  namespaces: string[];
  /** Argo CD cluster NAMES an authored Application may target, besides the in-cluster server. */
  clusters: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
const isInt = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER) =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const isStr = (v: unknown) => typeof v === "string" && v.length > 0;

function onlyKeys(
  where: string,
  obj: Record<string, unknown>,
  allowed: readonly string[]
): string[] {
  return Object.keys(obj)
    .filter((k) => !allowed.includes(k))
    .map((k) => `${where}.${k} is not a field SCP authors`);
}

function stringMap(where: string, v: unknown): string[] {
  if (!isRecord(v)) return [`${where} must be a map of strings`];
  return Object.entries(v)
    .filter(([, value]) => typeof value !== "string")
    .map(([k]) => `${where}.${k} must be a string`);
}

/** Parses `config.authoring`; `undefined` when the operator declared none or it is malformed. */
export function readAuthoringConfig(raw: unknown): AuthoringConfig | undefined {
  if (!isRecord(raw)) return undefined;
  const s = (k: string) =>
    typeof raw[k] === "string" && raw[k] !== "" ? (raw[k] as string) : undefined;
  const list = (k: string) =>
    Array.isArray(raw[k])
      ? (raw[k] as unknown[]).filter((n): n is string => typeof n === "string" && n.length > 0)
      : [];
  const repoURL = s("repoURL");
  const targetRevision = s("targetRevision");
  const project = s("project");
  const namespaces = list("namespaces");
  if (!repoURL || !targetRevision || !project || project === "default" || namespaces.length === 0) {
    return undefined;
  }
  if ((s("path") === undefined) === (s("chart") === undefined)) return undefined;
  return {
    repoURL,
    ...(s("path") ? { path: s("path") } : {}),
    ...(s("chart") ? { chart: s("chart") } : {}),
    targetRevision,
    project,
    namespaces,
    clusters: list("clusters")
  };
}

function checkMetadata(
  where: string,
  meta: unknown,
  labels: Readonly<Record<string, string | null>> | "any-string",
  annotations: readonly string[]
): string[] {
  if (!isRecord(meta)) return [`${where}.metadata is missing`];
  const problems = onlyKeys(`${where}.metadata`, meta, [
    "name",
    "namespace",
    "labels",
    "annotations"
  ]);
  if (!isStr(meta.name)) problems.push(`${where}.metadata.name is missing`);
  if (meta.labels !== undefined) {
    if (labels === "any-string")
      problems.push(...stringMap(`${where}.metadata.labels`, meta.labels));
    else if (!isRecord(meta.labels)) problems.push(`${where}.metadata.labels must be a map`);
    else {
      problems.push(...onlyKeys(`${where}.metadata.labels`, meta.labels, Object.keys(labels)));
      for (const [k, want] of Object.entries(labels)) {
        const got = meta.labels[k];
        if (want === null ? !isStr(got) : got !== want) {
          problems.push(`${where}.metadata.labels.${k} is not the value SCP authors`);
        }
      }
    }
  } else if (labels !== "any-string") {
    problems.push(`${where}.metadata.labels is missing`);
  }
  if (meta.annotations !== undefined) {
    if (!isRecord(meta.annotations)) problems.push(`${where}.metadata.annotations must be a map`);
    else {
      problems.push(...onlyKeys(`${where}.metadata.annotations`, meta.annotations, annotations));
      problems.push(...stringMap(`${where}.metadata.annotations`, meta.annotations));
    }
  }
  return problems;
}

/** The labels the renderer stamps on a Rollout and its Services (`renderAuthoredDeployment`). */
function manifestLabels(rolloutName: string): Record<string, string> {
  return {
    "app.kubernetes.io/name": rolloutName,
    "app.kubernetes.io/managed-by": "commanderscp",
    "commanderscp.io/authored": "true"
  };
}

/** EXACT equality of a string map — no extra key, no other value (review round 3: a selector or
 *  label set naming ANOTHER app's pods is how a Service or Rollout reaches workloads it never owned). */
function exactly(where: string, got: unknown, want: Record<string, string>): string[] {
  if (!isRecord(got)) return [`${where} is missing`];
  const same =
    Object.keys(got).length === Object.keys(want).length &&
    Object.entries(want).every(([k, v]) => got[k] === v);
  return same ? [] : [`${where} is not exactly what SCP authors for this Rollout`];
}

function checkRolloutSpec(
  where: string,
  spec: unknown,
  serviceNames: string[],
  rolloutName: string
): string[] {
  if (!isRecord(spec)) return [`${where} is missing`];
  const problems = onlyKeys(where, spec, [
    "replicas",
    "revisionHistoryLimit",
    "selector",
    "template",
    "strategy"
  ]);
  // `paused`, `restartAt`, `workloadRef`, analysis and traffic routing all fall out of the allowlist
  // above; `paused` is named because it is the one that DRIVES a rollout.
  if ("paused" in spec)
    problems.push(`${where}.paused would pause the Rollout — SCP never drives one`);
  if (spec.replicas !== undefined && !isInt(spec.replicas, 1, 1000))
    problems.push(`${where}.replicas is out of range`);
  if (spec.revisionHistoryLimit !== undefined && !isInt(spec.revisionHistoryLimit, 0, 100)) {
    problems.push(`${where}.revisionHistoryLimit is out of range`);
  }
  const selector = spec.selector;
  if (!isRecord(selector)) problems.push(`${where}.selector is missing`);
  else {
    problems.push(...onlyKeys(`${where}.selector`, selector, ["matchLabels"]));
    problems.push(
      ...exactly(`${where}.selector.matchLabels`, selector.matchLabels, {
        "app.kubernetes.io/name": rolloutName
      })
    );
  }
  const template = spec.template;
  if (!isRecord(template)) problems.push(`${where}.template is missing`);
  else {
    problems.push(...onlyKeys(`${where}.template`, template, ["metadata", "spec"]));
    // Labels only: a pod-template annotation is how an AppArmor/seccomp profile is set unconfined.
    if (!isRecord(template.metadata)) problems.push(`${where}.template.metadata is missing`);
    else {
      problems.push(...onlyKeys(`${where}.template.metadata`, template.metadata, ["labels"]));
      problems.push(
        ...exactly(`${where}.template.metadata.labels`, template.metadata.labels, {
          "app.kubernetes.io/name": rolloutName
        })
      );
    }
    const pod = template.spec;
    if (!isRecord(pod)) problems.push(`${where}.template.spec is missing`);
    else {
      problems.push(...onlyKeys(`${where}.template.spec`, pod, ["containers"]));
      const containers = Array.isArray(pod.containers) ? pod.containers : [];
      if (containers.length !== 1)
        problems.push(`${where}.template.spec.containers must hold one container`);
      for (const c of containers) {
        const at = `${where}.template.spec.containers[]`;
        if (!isRecord(c)) {
          problems.push(`${at} is not an object`);
          continue;
        }
        problems.push(...onlyKeys(at, c, ["name", "image", "ports"]));
        if (c.name !== "app") problems.push(`${at}.name must be "app"`);
        // No whitespace of any kind — a newline in an image ref is a second YAML line in the chart.
        if (!(typeof c.image === "string" && /^\S{1,512}$/.test(c.image))) {
          problems.push(`${at}.image is not a single-token image reference`);
        }
        if (c.ports !== undefined) {
          if (!Array.isArray(c.ports)) problems.push(`${at}.ports is not a list`);
          for (const port of Array.isArray(c.ports) ? c.ports : []) {
            // containerPort ONLY: `hostPort`/`hostIP` bind the node's network.
            if (!isRecord(port)) problems.push(`${at}.ports[] is not an object`);
            else {
              problems.push(...onlyKeys(`${at}.ports[]`, port, ["containerPort"]));
              if (!isInt(port.containerPort, 1, 65535))
                problems.push(`${at}.ports[].containerPort is out of range`);
            }
          }
        }
      }
    }
  }
  const strategy = spec.strategy;
  if (!isRecord(strategy)) return [...problems, `${where}.strategy is missing`];
  problems.push(...onlyKeys(`${where}.strategy`, strategy, ["canary", "blueGreen"]));
  const hasCanary = "canary" in strategy;
  const hasBlueGreen = "blueGreen" in strategy;
  if (hasCanary === hasBlueGreen) {
    problems.push(`${where}.strategy must declare exactly one of canary or blueGreen`);
  }
  if (hasCanary) {
    const canary = strategy.canary;
    if (!isRecord(canary)) problems.push(`${where}.strategy.canary is not an object`);
    else {
      problems.push(
        ...onlyKeys(`${where}.strategy.canary`, canary, ["steps", "maxSurge", "maxUnavailable"])
      );
      if (
        canary.maxSurge !== undefined &&
        !(typeof canary.maxSurge === "string" && /^[1-9]\d?%$|^100%$/.test(canary.maxSurge))
      ) {
        problems.push(`${where}.strategy.canary.maxSurge is not a percentage SCP authors`);
      }
      if (canary.maxUnavailable !== undefined && canary.maxUnavailable !== 0) {
        problems.push(`${where}.strategy.canary.maxUnavailable must be 0`);
      }
      if (canary.steps !== undefined) {
        if (!Array.isArray(canary.steps) || canary.steps.length === 0) {
          problems.push(`${where}.strategy.canary.steps must be a non-empty list when present`);
        }
        for (const [i, step] of (Array.isArray(canary.steps) ? canary.steps : []).entries()) {
          const at = `${where}.strategy.canary.steps[${i}]`;
          if (!isRecord(step) || Object.keys(step).length !== 1) {
            problems.push(`${at} must be exactly one of setWeight or pause`);
            continue;
          }
          problems.push(...onlyKeys(at, step, ["setWeight", "pause"]));
          if ("setWeight" in step && !isInt(step.setWeight, 0, 100))
            problems.push(`${at}.setWeight is out of range`);
          if ("pause" in step) {
            const pause = step.pause;
            const timed =
              isRecord(pause) &&
              Object.keys(pause).length === 1 &&
              typeof pause.duration === "string" &&
              /^[1-9]\d*s$/.test(pause.duration);
            if (!timed) {
              problems.push(
                `${at}.pause is not a timed pause — an indefinite pause waits for \`promote\`, which SCP may never call`
              );
            }
          }
        }
      }
    }
  }
  if (hasBlueGreen) {
    const bg = strategy.blueGreen;
    if (!isRecord(bg)) problems.push(`${where}.strategy.blueGreen is not an object`);
    else {
      problems.push(
        ...onlyKeys(`${where}.strategy.blueGreen`, bg, [
          "activeService",
          "previewService",
          "autoPromotionEnabled",
          "autoPromotionSeconds",
          "scaleDownDelaySeconds"
        ])
      );
      if (bg.autoPromotionEnabled !== true || !isInt(bg.autoPromotionSeconds, 1)) {
        problems.push(
          `${where}.strategy.blueGreen must auto-promote (autoPromotionEnabled: true, autoPromotionSeconds > 0) — SCP never promotes`
        );
      }
      if (bg.scaleDownDelaySeconds !== undefined && !isInt(bg.scaleDownDelaySeconds, 0)) {
        problems.push(`${where}.strategy.blueGreen.scaleDownDelaySeconds is out of range`);
      }
      const named = [bg.activeService, bg.previewService];
      if (
        serviceNames.length !== 2 ||
        !named.every((n) => typeof n === "string" && serviceNames.includes(n)) ||
        bg.activeService === bg.previewService
      ) {
        problems.push(
          `${where}.strategy.blueGreen must switch between the two Services it carries`
        );
      }
    }
  } else if (serviceNames.length > 0) {
    problems.push(`${where} carries Services, which only a blue-green Rollout switches between`);
  }
  return problems;
}

function checkService(where: string, spec: unknown, rolloutName: string): string[] {
  if (!isRecord(spec)) return [`${where}.spec is missing`];
  const problems = onlyKeys(`${where}.spec`, spec, ["type", "selector", "ports"]);
  if (spec.type !== "ClusterIP") {
    problems.push(
      `${where}.spec.type must be ClusterIP — the carrier never exposes a Service outside the cluster`
    );
  }
  problems.push(
    ...exactly(`${where}.spec.selector`, spec.selector, { "app.kubernetes.io/name": rolloutName })
  );
  for (const port of Array.isArray(spec.ports) ? spec.ports : [null]) {
    if (!isRecord(port)) {
      problems.push(`${where}.spec.ports must be a list of ports`);
      continue;
    }
    problems.push(...onlyKeys(`${where}.spec.ports[]`, port, ["name", "port", "targetPort"]));
    if (!isInt(port.port, 1, 65535) || !isInt(port.targetPort, 1, 65535)) {
      problems.push(`${where}.spec.ports[] must name port and targetPort in range`);
    }
  }
  return problems;
}

function checkManifests(manifests: unknown[], namespace: string): string[] {
  const problems: string[] = [];
  const rollouts = manifests.filter((m) => isRecord(m) && m.kind === "Rollout");
  const services = manifests.filter((m) => isRecord(m) && m.kind === "Service") as Record<
    string,
    unknown
  >[];
  if (rollouts.length !== 1) problems.push("the carrier must carry exactly one Rollout");
  const rolloutMeta = (rollouts[0] as Record<string, unknown> | undefined)?.metadata;
  const rolloutName =
    isRecord(rolloutMeta) && typeof rolloutMeta.name === "string" ? rolloutMeta.name : "";
  manifests.forEach((m, i) => {
    const where = `manifests[${i}]`;
    if (!isRecord(m)) {
      problems.push(`${where} is not an object`);
      return;
    }
    problems.push(...onlyKeys(where, m, ["apiVersion", "kind", "metadata", "spec"]));
    const expectedVersion =
      m.kind === "Rollout" ? "argoproj.io/v1alpha1" : m.kind === "Service" ? "v1" : undefined;
    if (!expectedVersion) {
      problems.push(
        `${where} is a ${String(m.kind)} — an authored Application carries only ${AUTHORED_MANIFEST_KINDS.map((k) => k.kind).join(" and ")}`
      );
      return;
    }
    if (m.apiVersion !== expectedVersion)
      problems.push(`${where}.apiVersion must be ${expectedVersion}`);
    problems.push(
      ...checkMetadata(where, m.metadata, manifestLabels(rolloutName), MANIFEST_ANNOTATIONS)
    );
    if (isRecord(m.metadata) && m.metadata.namespace !== namespace) {
      problems.push(`${where} does not land in the Application's destination namespace`);
    }
    if (m.kind === "Rollout") {
      const names = services
        .map((s) => (isRecord(s.metadata) ? s.metadata.name : undefined))
        .filter((n): n is string => typeof n === "string");
      problems.push(...checkRolloutSpec(`${where}.spec`, m.spec, names, rolloutName));
    } else {
      const name = isRecord(m.metadata) ? m.metadata.name : undefined;
      if (name !== `${rolloutName}-active` && name !== `${rolloutName}-preview`) {
        problems.push(`${where} is not one of the Rollout's own active/preview Services`);
      }
      problems.push(...checkService(where, m.spec, rolloutName));
    }
  });
  return problems;
}

/** Every reason `doc` is not a carrier render the operator's declaration permits. Empty ⇒ allowed. */
export function authoredApplicationProblems(doc: unknown, authoring: AuthoringConfig): string[] {
  if (!isRecord(doc)) return ["the authored Application is not an object"];
  const problems = onlyKeys("Application", doc, ["apiVersion", "kind", "metadata", "spec"]);
  if (doc.apiVersion !== "argoproj.io/v1alpha1" || doc.kind !== "Application") {
    problems.push("Application must be argoproj.io/v1alpha1 Application");
  }
  // No finalizers, no owner references: a `resources-finalizer` would make deleting the Application
  // cascade into the namespace's resources — a write SCP never asked for. No annotation beyond SCP's
  // own: Argo CD notifications subscribe webhooks by annotation.
  problems.push(
    ...checkMetadata("Application", doc.metadata, APPLICATION_LABELS, APPLICATION_ANNOTATIONS)
  );
  const spec = doc.spec;
  if (!isRecord(spec)) return [...problems, "Application.spec is missing"];
  problems.push(
    ...onlyKeys("Application.spec", spec, ["project", "destination", "source", "syncPolicy"])
  );
  if (spec.project !== authoring.project)
    problems.push("Application.spec.project is not the authoring project");
  if (
    spec.syncPolicy !== undefined &&
    !(isRecord(spec.syncPolicy) && Object.keys(spec.syncPolicy).length === 0)
  ) {
    problems.push(
      "Application.spec.syncPolicy must be empty — SCP triggers every sync and creates no namespace"
    );
  }
  const dest = spec.destination;
  let namespace = "";
  if (!isRecord(dest)) problems.push("Application.spec.destination is missing");
  else {
    namespace = typeof dest.namespace === "string" ? dest.namespace : "";
    const keys = Object.keys(dest).sort().join(",");
    const inCluster = keys === "namespace,server" && dest.server === IN_CLUSTER_SERVER;
    const named =
      keys === "name,namespace" &&
      typeof dest.name === "string" &&
      authoring.clusters.includes(dest.name);
    if (!inCluster && !named) {
      problems.push(
        "Application destination is not the in-cluster server or an allowlisted cluster"
      );
    }
    if (
      !namespace ||
      FORBIDDEN_NAMESPACES.includes(namespace) ||
      namespace.startsWith("kube-") ||
      !authoring.namespaces.includes(namespace)
    ) {
      problems.push("Application destination namespace is not in the authoring allowlist");
    }
  }
  const source = spec.source;
  if (!isRecord(source)) return [...problems, "Application.spec.source is missing"];
  problems.push(
    ...onlyKeys("Application.spec.source", source, [
      "repoURL",
      "path",
      "chart",
      "targetRevision",
      "helm"
    ])
  );
  for (const key of ["repoURL", "path", "chart", "targetRevision"] as const) {
    if (source[key] !== authoring[key])
      problems.push(`Application source ${key} is not the registered carrier's`);
  }
  const helm = source.helm;
  if (!isRecord(helm)) return [...problems, "Application.spec.source.helm is missing"];
  problems.push(...onlyKeys("Application.spec.source.helm", helm, ["valuesObject"]));
  const values = helm.valuesObject;
  if (!isRecord(values)) return [...problems, "the carrier's valuesObject is missing"];
  problems.push(...onlyKeys("valuesObject", values, ["manifests"]));
  const manifests = Array.isArray(values.manifests) ? values.manifests : [];
  if (manifests.length === 0) problems.push("the carrier's manifests are empty");
  problems.push(...checkManifests(manifests, namespace));
  return problems;
}
