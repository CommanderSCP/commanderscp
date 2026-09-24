/**
 * THE PLUGIN'S SECOND LAYER for SCP-authored Applications (M28.4 fix round, ADR-0055 D2/D6/D9).
 *
 * The server derives the authored Application and refuses a recipe that tries to supply one; this
 * file assumes both of those failed and checks the document against what the OPERATOR declared on
 * the execution-system (`config.authoring`). The document is refused unless it is exactly a carrier
 * render: its source is the registered carrier at its pinned revision, its project is the scoped
 * authoring project, its destination is an allowlisted namespace, and it carries only the authored
 * kinds, in that namespace, in the narrow shape the server writes. Everything outside that shape is
 * a way to reach the cluster through Argo CD (a ClusterRoleBinding in the values, a foreign repo,
 * `kube-system`) or to drive a Rollout (`spec.paused`, an indefinite `pause: {}`, a `status`).
 *
 * It is an ALLOWLIST of keys at every level, never a denylist: the next dangerous field is one
 * nobody thought to list, so an unlisted key is a refusal.
 */

/** The only kinds an authored Application may carry — `@scp/schemas` `AUTHORED_MANIFEST_KINDS`,
 *  duplicated because this package takes no schemas dependency; pinned equal by a server test. */
export const AUTHORED_MANIFEST_KINDS: readonly { group: string; kind: string }[] = [
  { group: "argoproj.io", kind: "Rollout" },
  { group: "", kind: "Service" }
];

/** `@scp/schemas` `FORBIDDEN_AUTHORING_NAMESPACES`, duplicated for the same reason. */
const FORBIDDEN_NAMESPACES = ["default", "kube-system", "kube-public", "kube-node-lease"];

export interface AuthoringConfig {
  repoURL: string;
  path?: string;
  chart?: string;
  targetRevision: string;
  project: string;
  namespaces: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function onlyKeys(
  where: string,
  obj: Record<string, unknown>,
  allowed: readonly string[]
): string[] {
  return Object.keys(obj)
    .filter((k) => !allowed.includes(k))
    .map((k) => `${where}.${k} is not a field SCP authors`);
}

/** Parses `config.authoring`; `undefined` when the operator declared none or it is malformed. */
export function readAuthoringConfig(raw: unknown): AuthoringConfig | undefined {
  if (!isRecord(raw)) return undefined;
  const s = (k: string) =>
    typeof raw[k] === "string" && raw[k] !== "" ? (raw[k] as string) : undefined;
  const repoURL = s("repoURL");
  const targetRevision = s("targetRevision");
  const project = s("project");
  const namespaces = Array.isArray(raw.namespaces)
    ? raw.namespaces.filter((n): n is string => typeof n === "string" && n.length > 0)
    : [];
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
    namespaces
  };
}

function checkPause(where: string, pause: unknown): string[] {
  if (!isRecord(pause)) return [`${where}.pause must be an object`];
  const problems = onlyKeys(`${where}.pause`, pause, ["duration"]);
  const d = pause.duration;
  const timed =
    (typeof d === "string" && /^[1-9]\d*[smh]$/.test(d)) || (typeof d === "number" && d > 0);
  if (!timed) {
    problems.push(
      `${where}.pause has no duration — an indefinite pause waits for \`promote\`, which SCP may never call`
    );
  }
  return problems;
}

function checkRolloutSpec(where: string, spec: unknown): string[] {
  if (!isRecord(spec)) return [`${where} is missing`];
  const problems = onlyKeys(where, spec, [
    "replicas",
    "revisionHistoryLimit",
    "selector",
    "template",
    "strategy"
  ]);
  // `paused`, `restartAt`, `workloadRef`, analysis and traffic routing all fall out of the allowlist
  // above; `paused` is named here because it is the one that DRIVES a rollout.
  if ("paused" in spec)
    problems.push(`${where}.paused would pause the Rollout — SCP never drives one`);
  const template = spec.template;
  if (!isRecord(template)) problems.push(`${where}.template is missing`);
  else {
    problems.push(...onlyKeys(`${where}.template`, template, ["metadata", "spec"]));
    const pod = template.spec;
    if (!isRecord(pod)) problems.push(`${where}.template.spec is missing`);
    else {
      problems.push(...onlyKeys(`${where}.template.spec`, pod, ["containers"]));
      const containers = Array.isArray(pod.containers) ? pod.containers : [];
      if (containers.length !== 1)
        problems.push(`${where}.template.spec.containers must hold one container`);
      for (const c of containers) {
        if (!isRecord(c)) problems.push(`${where} container is not an object`);
        else
          problems.push(
            ...onlyKeys(`${where}.template.spec.containers[]`, c, ["name", "image", "ports"])
          );
      }
    }
  }
  const strategy = spec.strategy;
  if (!isRecord(strategy)) return [...problems, `${where}.strategy is missing`];
  problems.push(...onlyKeys(`${where}.strategy`, strategy, ["canary", "blueGreen"]));
  if (isRecord(strategy.canary)) {
    const canary = strategy.canary;
    problems.push(
      ...onlyKeys(`${where}.strategy.canary`, canary, ["steps", "maxSurge", "maxUnavailable"])
    );
    const steps = canary.steps;
    if (steps !== undefined && !Array.isArray(steps))
      problems.push(`${where}.strategy.canary.steps is not a list`);
    for (const [i, step] of (Array.isArray(steps) ? steps : []).entries()) {
      const at = `${where}.strategy.canary.steps[${i}]`;
      if (!isRecord(step)) {
        problems.push(`${at} is not an object`);
        continue;
      }
      problems.push(...onlyKeys(at, step, ["setWeight", "pause"]));
      if ("pause" in step) problems.push(...checkPause(at, step.pause));
    }
  }
  if (isRecord(strategy.blueGreen)) {
    const bg = strategy.blueGreen;
    problems.push(
      ...onlyKeys(`${where}.strategy.blueGreen`, bg, [
        "activeService",
        "previewService",
        "autoPromotionEnabled",
        "autoPromotionSeconds",
        "scaleDownDelaySeconds"
      ])
    );
    if (
      bg.autoPromotionEnabled !== true ||
      !(typeof bg.autoPromotionSeconds === "number" && bg.autoPromotionSeconds > 0)
    ) {
      problems.push(
        `${where}.strategy.blueGreen must auto-promote (autoPromotionEnabled: true, autoPromotionSeconds > 0) — SCP never promotes`
      );
    }
  }
  if (!isRecord(strategy.canary) && !isRecord(strategy.blueGreen)) {
    problems.push(`${where}.strategy declares neither canary nor blueGreen`);
  }
  return problems;
}

function checkManifest(i: number, m: unknown, namespace: string): string[] {
  const where = `manifests[${i}]`;
  if (!isRecord(m)) return [`${where} is not an object`];
  const problems = onlyKeys(where, m, ["apiVersion", "kind", "metadata", "spec"]);
  const apiVersion = typeof m.apiVersion === "string" ? m.apiVersion : "";
  const group = apiVersion.includes("/") ? apiVersion.split("/")[0]! : "";
  const allowed = AUTHORED_MANIFEST_KINDS.some((k) => k.kind === m.kind && k.group === group);
  if (!allowed) {
    return [
      ...problems,
      `${where} is ${String(m.kind)} (${apiVersion || "core"}) — an authored Application carries only ${AUTHORED_MANIFEST_KINDS.map((k) => k.kind).join(" and ")}`
    ];
  }
  const meta = m.metadata;
  if (!isRecord(meta)) return [...problems, `${where}.metadata is missing`];
  problems.push(
    ...onlyKeys(`${where}.metadata`, meta, ["name", "namespace", "labels", "annotations"])
  );
  if (meta.namespace !== namespace) {
    problems.push(
      `${where} lands in namespace '${String(meta.namespace)}', not the Application's '${namespace}'`
    );
  }
  if (isRecord(meta.annotations)) {
    problems.push(
      ...onlyKeys(`${where}.metadata.annotations`, meta.annotations, ["commanderscp.io/change"])
    );
  }
  if (m.kind === "Rollout") problems.push(...checkRolloutSpec(`${where}.spec`, m.spec));
  if (m.kind === "Service") {
    const spec = m.spec;
    if (!isRecord(spec)) problems.push(`${where}.spec is missing`);
    else {
      problems.push(...onlyKeys(`${where}.spec`, spec, ["type", "selector", "ports"]));
      if (spec.type !== "ClusterIP")
        problems.push(
          `${where}.spec.type must be ClusterIP — the carrier never exposes a Service outside the cluster`
        );
    }
  }
  return problems;
}

/** Every reason `doc` is not a carrier render the operator's declaration permits. Empty ⇒ allowed. */
export function authoredApplicationProblems(doc: unknown, authoring: AuthoringConfig): string[] {
  if (!isRecord(doc)) return ["the authored Application is not an object"];
  const problems = onlyKeys("Application", doc, ["apiVersion", "kind", "metadata", "spec"]);
  // No finalizers, no owner references: a `resources-finalizer` would make deleting the Application
  // cascade into the namespace's resources, which is a write SCP never asked for.
  if (isRecord(doc.metadata)) {
    problems.push(
      ...onlyKeys("Application.metadata", doc.metadata, ["name", "labels", "annotations"])
    );
  }
  const spec = doc.spec;
  if (!isRecord(spec)) return [...problems, "Application.spec is missing"];
  problems.push(
    ...onlyKeys("Application.spec", spec, ["project", "destination", "source", "syncPolicy"])
  );
  if (spec.project !== authoring.project) {
    problems.push(
      `Application.spec.project is '${String(spec.project)}', not the authoring project '${authoring.project}'`
    );
  }
  if (isRecord(spec.syncPolicy) && Object.keys(spec.syncPolicy).length > 0) {
    problems.push(
      "Application.spec.syncPolicy must be empty — SCP triggers every sync and creates no namespace"
    );
  }
  const dest = spec.destination;
  const namespace = isRecord(dest) && typeof dest.namespace === "string" ? dest.namespace : "";
  if (
    !namespace ||
    FORBIDDEN_NAMESPACES.includes(namespace) ||
    namespace.startsWith("kube-") ||
    !authoring.namespaces.includes(namespace)
  ) {
    problems.push(
      `Application destination namespace '${namespace}' is not in the authoring allowlist (${authoring.namespaces.join(", ")})`
    );
  }
  if (isRecord(dest))
    problems.push(
      ...onlyKeys("Application.spec.destination", dest, ["server", "name", "namespace"])
    );
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
    if (source[key] !== authoring[key]) {
      problems.push(
        `Application source ${key} '${String(source[key])}' is not the registered carrier's '${String(authoring[key])}'`
      );
    }
  }
  const helm = source.helm;
  if (!isRecord(helm)) return [...problems, "Application.spec.source.helm is missing"];
  problems.push(...onlyKeys("Application.spec.source.helm", helm, ["valuesObject"]));
  const values = helm.valuesObject;
  if (!isRecord(values)) return [...problems, "the carrier's valuesObject is missing"];
  problems.push(...onlyKeys("valuesObject", values, ["manifests"]));
  const manifests = Array.isArray(values.manifests) ? values.manifests : [];
  if (manifests.length === 0) problems.push("the carrier's manifests are empty");
  manifests.forEach((m, i) => problems.push(...checkManifest(i, m, namespace)));
  return problems;
}
