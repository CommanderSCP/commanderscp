import { createHash } from "node:crypto";
import {
  ARGOCD_AUTHORING_PROPERTY,
  AUTHORED_DEPLOYMENT_PROPERTY,
  ArgoCdAuthoringSchema,
  AuthoredDeploymentSchema,
  Dns1123LabelSchema,
  RolloutStrategySchema,
  SCP_AUTHORED_LABEL_KEY,
  SCP_AUTHORED_LABEL_VALUE,
  isForbiddenAuthoringNamespace,
  type ArgoCdAuthoring,
  type AuthoredDeployment,
  type AuthoredRolloutStrategy,
  type RolloutStrategy
} from "@scp/schemas";
import { and, eq, isNull } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { changePlans, changeWaves, objects } from "../db/schema.js";
import { listRolloutsForComponents } from "../coordination-as-code/rollout-convergence-repo.js";
import { ociDigestsOfSourceRef } from "./artifact-facts.js";
import { parseTopologyWaves } from "./topology-waves.js";
import { authoredApplicationProblems, readAuthoringConfig } from "@scp/plugin-argocd";
import {
  TriggerParameterRefusal,
  WAVE_TARGET_DEPLOYMENT_REFUSED_AUDIT_ACTION,
  WAVE_TARGET_DEPLOYMENT_REFUSED_STATUS
} from "./trigger-parameter-refusal.js";

/**
 * M28.4 — WHAT A DEPLOY-LANE TRIGGER TELLS ARGO CD WHEN SCP AUTHORS THE DEPLOYMENT (ADR-0055).
 *
 * The third sibling of `buildLaneTriggerParameters` and `opsLaneTriggerParameters`, and the same
 * rule: the SERVER derives the material from what the graph already holds, and the plugin carries
 * it to the executor. Here the material is an Argo CD `Application` whose one source is the
 * operator-installed carrier chart, with the SCP-authored Argo `Rollout` (and, for blue-green, its
 * two Services) in its values. Argo CD's own controller writes them into the cluster; SCP never
 * holds a credential that could.
 *
 * WHEN IT APPLIES. Only to an `argocd` binding, and only when the component declares
 * `properties.deployment`. Everything else returns `undefined` and the trigger is byte-identical
 * to the import-and-coordinate path (Mode A): an Application SCP did not author is synced, never
 * written. (A RECIPE cannot supply one instead — `scpAuthoredApplication` is a server-reserved
 * parameter, refused at the one choke point in `reconcile.ts`; `reserved-trigger-parameters.ts`.)
 *
 * WHERE THE STEPS COME FROM (owner decision 2026-09-23). The component's own D12 declaration
 * (`component_rollouts`, target class `cluster` — the `CanaryRollout` / `RollingRollout` /
 * `BlueGreenRollout` constructs) WINS; the release topology's wave that names this target's place
 * applies only where the component declares none; absent both, a canary with no steps (Argo's
 * rolling update). Which one was used is stamped on the Application, so it is never silent.
 *
 * WHAT IT NEVER WRITES: a step only `promote` can release. Every pause is timed, and blue-green
 * always auto-promotes — ADR-0008 §3 forbids SCP the promote verb, so an authored indefinite pause
 * is a Rollout nobody is allowed to finish.
 */

/** The deploy lane's refusal, through M28.1's typed channel (`trigger-parameter-refusal.ts`):
 *  `reconcile.ts` terminalises it with a Decision and an audit event, never a retry. */
export class DeploymentAuthoringRefused extends TriggerParameterRefusal {
  readonly status = WAVE_TARGET_DEPLOYMENT_REFUSED_STATUS;
  readonly action = WAVE_TARGET_DEPLOYMENT_REFUSED_AUDIT_ACTION;
  constructor(message: string, inputContext: Record<string, unknown> = {}) {
    super(message, {
      remediation:
        "correct the declaration named above, then cancel/rollback/re-propose the change",
      inputContext
    });
  }
}

/** The trigger parameter the argocd plugin reads the authored Application from — the plugin's
 *  `AUTHORED_APPLICATION_PARAMETER`, pinned equal by `deploy-lane-trigger-parameters.test.ts`. */
export const AUTHORED_APPLICATION_PARAMETER = "scpAuthoredApplication";

/** The `status().stateRef` key under which the argocd plugin reports an SCP-authored Application's
 *  live manifest (JSON text) — the plugin's `PRIOR_AUTHORED_APPLICATION_KEY`, pinned equal by test. */
export const PRIOR_AUTHORED_APPLICATION_KEY = "scpAuthoredApplicationJson";

/** Argo CD's in-cluster destination — the default when the place names no registered cluster. */
export const IN_CLUSTER_SERVER = "https://kubernetes.default.svc";

/** The labels the plugin compares before it will UPDATE an Application (ADR-0055 D5): an
 *  Application authored for another component, target or org is never overwritten. */
export const AUTHORED_IDENTITY_LABELS = [
  "commanderscp.io/org",
  "commanderscp.io/component",
  "commanderscp.io/target"
] as const;

/** The module this lane serves. A deployment declared on a component bound to anything else is
 *  not this lane's to author. */
const AUTHORING_MODULE = "argocd";

export interface DeployLaneTriggerParameterInput {
  orgId: string;
  /** The wave target's object — a placement (stage mode) or the component itself. */
  targetObjectId: string;
  waveId: string;
  changeObjectId: string;
  /** The change's `sourceRef` — read for the OCI digest this release is, never trusted as a shape. */
  sourceRef: unknown;
  /** The module the binding resolved to (`ensureExecutorInstanceStarted`). */
  pluginModule: string | null;
  binding: {
    externalRef: string | null;
    executionSystemId: string | null;
    config: unknown;
  } | null;
}

export interface AuthoredDeploymentTrigger {
  /** The Application name — sent as `trigger().targetRef`, so status/abort address what was made. */
  targetRef: string;
  parameters: Record<typeof AUTHORED_APPLICATION_PARAMETER, Record<string, unknown>>;
  /** The execution-system's CURRENT authoring the document was derived under — what a rollback's
   *  prior manifest is re-validated against. Never sent to the executor. */
  authoring: ArgoCdAuthoring;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(bag: unknown, key: string): string | undefined {
  if (!isRecord(bag)) return undefined;
  const v = bag[key];
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

function issues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

/** Fold any name into an RFC 1123 label. Deterministic, so re-triggers address the same objects;
 *  a name too long to fold keeps a hash of the whole, so two long names never collide. */
export function foldDns1123Label(raw: string): string {
  const folded = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = folded.length > 0 ? folded : "scp";
  if (base.length <= 63) return base;
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 8);
  return `${base.slice(0, 54).replace(/-+$/, "")}-${hash}`;
}

/** A readable name that is COLLISION-FREE by construction: the folded display name, truncated,
 *  plus 8 hex of a hash over the object ids it stands for. Folding alone collides — `ca-eu` at
 *  `west` and `ca` at `eu-west` both fold to `ca-eu-west` — and ids never do. Always starts with a
 *  letter, so it is also a valid RFC 1035 Service name. */
export function nameWithIdentity(raw: string, identity: string, maxLength = 63): string {
  const hash = createHash("sha256").update(identity).digest("hex").slice(0, 8);
  let base = foldDns1123Label(raw);
  if (!/^[a-z]/.test(base)) base = `scp-${base}`;
  base = base.slice(0, maxLength - hash.length - 1).replace(/-+$/, "");
  return `${base}-${hash}`;
}

/** Argo Rollouts `spec.strategy` for one declared strategy. Every pause carries a duration and
 *  blue-green always auto-promotes. */
export function rolloutStrategyFor(
  strategy: AuthoredRolloutStrategy | undefined,
  services?: { active: string; preview: string }
): Record<string, unknown> {
  if (strategy === undefined) return { canary: {} };
  if (strategy.strategy === "canary") {
    const steps: Record<string, unknown>[] = [];
    for (const step of strategy.steps) {
      steps.push({ setWeight: step.weightPercent });
      if (step.pauseSeconds !== undefined && step.pauseSeconds > 0) {
        steps.push({ pause: { duration: `${step.pauseSeconds}s` } });
      }
    }
    return { canary: { steps } };
  }
  if (strategy.strategy === "blueGreen") {
    if (!services) throw new Error("blue-green needs its two Services named");
    // The deploy lane refuses a blue-green without it before rendering; this is the renderer's own
    // floor, so a future caller cannot author a Rollout that waits for `promote`.
    if (strategy.autoPromotionSeconds === undefined) {
      throw new Error("blue-green is only authored with autoPromotionSeconds (ADR-0055 D4)");
    }
    return {
      blueGreen: {
        activeService: services.active,
        previewService: services.preview,
        autoPromotionEnabled: true,
        autoPromotionSeconds: strategy.autoPromotionSeconds,
        ...(strategy.scaleDownDelaySeconds !== undefined
          ? { scaleDownDelaySeconds: strategy.scaleDownDelaySeconds }
          : {})
      }
    };
  }
  // ROLLING. With no pause it is exactly Argo's step-less canary with a surge bound. With a pause
  // it is a canary whose weights climb by `batchPercent`, pausing between batches — the only way
  // Argo Rollouts expresses "wait between batches", and still a timed pause.
  const surge = { maxSurge: `${strategy.batchPercent}%`, maxUnavailable: 0 };
  const pause = strategy.pauseBetweenSeconds;
  if (pause === undefined || pause === 0) return { canary: surge };
  const steps: Record<string, unknown>[] = [];
  for (let w = strategy.batchPercent; w < 100; w += strategy.batchPercent) {
    steps.push({ setWeight: w });
    steps.push({ pause: { duration: `${pause}s` } });
  }
  return { canary: { ...surge, steps } };
}

/** Strip a tag (never a registry port) from an image ref, for digest pinning. */
function imageRepositoryOf(image: string): string {
  const withoutDigest = image.split("@")[0]!;
  const lastSlash = withoutDigest.lastIndexOf("/");
  const lastColon = withoutDigest.lastIndexOf(":");
  return lastColon > lastSlash ? withoutDigest.slice(0, lastColon) : withoutDigest;
}

export interface RenderedAuthoredDeployment {
  application: Record<string, unknown>;
  /** Exactly what rides in `spec.source.helm.valuesObject.manifests`, in order. */
  manifests: Record<string, unknown>[];
}

export interface RenderAuthoredDeploymentInput {
  orgId: string;
  applicationName: string;
  rolloutName: string;
  namespace: string;
  image: string;
  deployment: AuthoredDeployment;
  strategy: AuthoredRolloutStrategy | undefined;
  /** Where the steps came from — stamped on the Application so the choice is never silent. */
  rolloutSource: string;
  authoring: ArgoCdAuthoring;
  destination: { server: string } | { name: string };
  componentObjectId: string;
  targetObjectId: string;
  changeObjectId: string;
}

/** PURE: the manifests SCP authors. They ride in the Application's values; the carrier chart
 *  renders `manifests` verbatim, so what is asserted here is what Argo CD applies. */
export function renderAuthoredDeployment(
  input: RenderAuthoredDeploymentInput
): RenderedAuthoredDeployment {
  const selector = { "app.kubernetes.io/name": input.rolloutName };
  const labels = {
    ...selector,
    "app.kubernetes.io/managed-by": "commanderscp",
    [SCP_AUTHORED_LABEL_KEY]: SCP_AUTHORED_LABEL_VALUE
  };
  const container: Record<string, unknown> = { name: "app", image: input.image };
  if (input.deployment.containerPort !== undefined) {
    container.ports = [{ containerPort: input.deployment.containerPort }];
  }
  const blueGreen = input.strategy?.strategy === "blueGreen";
  const services = blueGreen
    ? { active: `${input.rolloutName}-active`, preview: `${input.rolloutName}-preview` }
    : undefined;
  const rollout = {
    apiVersion: "argoproj.io/v1alpha1",
    kind: "Rollout",
    metadata: {
      name: input.rolloutName,
      namespace: input.namespace,
      labels,
      annotations: { "commanderscp.io/change": input.changeObjectId }
    },
    spec: {
      ...(input.deployment.replicas !== undefined ? { replicas: input.deployment.replicas } : {}),
      revisionHistoryLimit: 3,
      selector: { matchLabels: selector },
      template: { metadata: { labels: selector }, spec: { containers: [container] } },
      strategy: rolloutStrategyFor(input.strategy, services)
    }
  };
  const manifests: Record<string, unknown>[] = [rollout];
  if (services) {
    // A blue-green Rollout switches traffic by rewriting these two Services' selectors, so they
    // must exist; the controller adds the pod-template-hash itself. ClusterIP only — the carrier
    // never exposes anything outside the cluster.
    for (const name of [services.active, services.preview]) {
      manifests.push({
        apiVersion: "v1",
        kind: "Service",
        metadata: { name, namespace: input.namespace, labels },
        spec: {
          type: "ClusterIP",
          selector,
          ports: [
            {
              name: "http",
              port: input.deployment.containerPort,
              targetPort: input.deployment.containerPort
            }
          ]
        }
      });
    }
  }
  const { repoURL, path, chart, targetRevision, project } = input.authoring;
  const application = {
    apiVersion: "argoproj.io/v1alpha1",
    kind: "Application",
    metadata: {
      name: input.applicationName,
      labels: {
        "app.kubernetes.io/managed-by": "commanderscp",
        [SCP_AUTHORED_LABEL_KEY]: SCP_AUTHORED_LABEL_VALUE,
        "commanderscp.io/org": input.orgId,
        "commanderscp.io/component": input.componentObjectId,
        "commanderscp.io/target": input.targetObjectId
      },
      annotations: {
        "commanderscp.io/change": input.changeObjectId,
        "commanderscp.io/rollout-source": input.rolloutSource
      }
    },
    spec: {
      project,
      destination: { ...input.destination, namespace: input.namespace },
      source: {
        repoURL,
        ...(path !== undefined ? { path } : {}),
        ...(chart !== undefined ? { chart } : {}),
        targetRevision,
        helm: { valuesObject: { manifests } }
      },
      // No `automated` policy: SCP triggers every sync, which is what makes each one a coordinated
      // release rather than something Argo CD does on its own schedule. No `CreateNamespace=true`:
      // a destination namespace is one the operator allowlisted and created; creating one would
      // need a cluster-scoped grant the authoring project deliberately does not have.
      syncPolicy: {}
    }
  };
  return { application, manifests };
}

async function loadObject(tx: TenantTx, orgId: string, id: string) {
  const [row] = await tx
    .select({
      id: objects.id,
      typeId: objects.typeId,
      name: objects.name,
      properties: objects.properties
    })
    .from(objects)
    .where(and(eq(objects.orgId, orgId), eq(objects.id, id), isNull(objects.deletedAt)))
    .limit(1);
  return row;
}

/** The wave plan's `rollout` for this target's place, read off the plan's SNAPSHOTTED topology —
 *  the document the change compiled against, never the topology object's current revision. */
async function waveRolloutFor(
  tx: TenantTx,
  orgId: string,
  waveId: string,
  memberIds: string[]
): Promise<{ strategy: AuthoredRolloutStrategy | undefined; waveName: string | null }> {
  const [wave] = await tx
    .select({ planId: changeWaves.planId, name: changeWaves.name })
    .from(changeWaves)
    .where(and(eq(changeWaves.orgId, orgId), eq(changeWaves.id, waveId)))
    .limit(1);
  if (!wave) return { strategy: undefined, waveName: null };
  const [plan] = await tx
    .select({ topologyDocument: changePlans.topologyDocument })
    .from(changePlans)
    .where(and(eq(changePlans.orgId, orgId), eq(changePlans.id, wave.planId)))
    .limit(1);
  let waves;
  try {
    waves = parseTopologyWaves(plan?.topologyDocument ?? null) ?? [];
  } catch (err) {
    // A snapshot that no longer parses (written by an older peer, or by fixture surgery) is a
    // VERDICT here, not a retry: it will not parse on the next tick either.
    throw new DeploymentAuthoringRefused(
      `the change's snapshotted wave plan cannot be read: ${(err as { detail?: string }).detail ?? String(err)}`,
      { gate: "deployment_authoring", cause: "wave_plan_unreadable" }
    );
  }
  // A sequential wave splits into several compiled waves, so the compiled index is not the
  // document's. Membership is: the topology wave naming this target's place (or the target).
  const members = new Set(memberIds);
  const declared = waves.filter((w) => w.targets.some((t) => members.has(t)));
  const distinct = new Set(declared.map((w) => JSON.stringify(w.rollout ?? null)));
  if (distinct.size > 1) {
    throw new DeploymentAuthoringRefused(
      `the release topology names this target's place in ${declared.length} waves declaring ` +
        `different rollouts, so which steps to author is ambiguous — declare the place once, or ` +
        `give every wave that names it the same rollout.`,
      { gate: "deployment_authoring", cause: "ambiguous_wave_rollout" }
    );
  }
  const found = declared.find((w) => w.rollout !== undefined);
  return { strategy: found?.rollout, waveName: found?.name ?? wave.name };
}

/** The component's own D12 declaration for clusters, when it made one. It WINS (owner, 2026-09-23). */
async function componentRolloutFor(
  tx: TenantTx,
  orgId: string,
  componentId: string
): Promise<RolloutStrategy | undefined> {
  const rows = await listRolloutsForComponents(tx, orgId, [componentId]);
  const row = rows.find((r) => r.targetClass === "cluster");
  if (!row) return undefined;
  const parsed = RolloutStrategySchema.safeParse(row.rollout);
  if (!parsed.success) {
    throw new DeploymentAuthoringRefused(
      `the component's own cluster rollout declaration cannot be read: ${issues(parsed.error)}`,
      { gate: "deployment_authoring", cause: "component_rollout_unreadable" }
    );
  }
  return parsed.data;
}

export async function deployLaneTriggerParameters(
  tx: TenantTx,
  input: DeployLaneTriggerParameterInput
): Promise<AuthoredDeploymentTrigger | undefined> {
  if (input.pluginModule !== AUTHORING_MODULE) return undefined;

  const target = await loadObject(tx, input.orgId, input.targetObjectId);
  if (!target) return undefined;
  let component = target;
  let place: Awaited<ReturnType<typeof loadObject>> | undefined;
  if (target.typeId === "placement") {
    const componentId = readString(target.properties, "componentId");
    const placeId = readString(target.properties, "deploymentTargetId");
    const c = componentId ? await loadObject(tx, input.orgId, componentId) : undefined;
    if (!c) return undefined;
    component = c;
    place = placeId ? await loadObject(tx, input.orgId, placeId) : undefined;
  } else if (target.typeId !== "component") {
    return undefined;
  }

  const declared = isRecord(component.properties)
    ? component.properties[AUTHORED_DEPLOYMENT_PROPERTY]
    : undefined;
  // THE ONE OPT-IN. No declaration ⇒ the import-and-coordinate path, unchanged.
  if (declared === undefined) return undefined;

  const refuse = (cause: string, message: string): never => {
    throw new DeploymentAuthoringRefused(message, {
      gate: "deployment_authoring",
      cause,
      componentObjectId: component.id
    });
  };

  if (readString(component.properties, "argocdApplication") !== undefined) {
    refuse(
      "imported_and_declared",
      `component '${component.name}' was imported from an existing Argo CD Application ` +
        `(properties.argocdApplication) AND declares \`properties.${AUTHORED_DEPLOYMENT_PROPERTY}\` ` +
        `for SCP to author. SCP never overwrites an Application it did not author: remove one of the two.`
    );
  }
  const parsed = AuthoredDeploymentSchema.safeParse(declared);
  if (!parsed.success) {
    refuse(
      "deployment_unreadable",
      `component '${component.name}' declares an unreadable \`properties.${AUTHORED_DEPLOYMENT_PROPERTY}\`: ` +
        issues(parsed.error)
    );
  }
  const deployment = parsed.data!;

  // WHERE Argo CD reads the authored manifests from, which project, which namespaces — from the
  // EXECUTION-SYSTEM ONLY (review round 2). An inline binding's config is tenant-writable
  // (`object:write`), so a bound read from it is a bound the tenant chooses; the write door refuses
  // `authoring` there and the resolver strips it (`SYSTEM_ONLY_CONFIG_KEYS`), and this lane never
  // looks. The same rule ADR-0003 applies to `allowInternalEgress`.
  let authoringDoc: unknown;
  if (input.binding?.executionSystemId) {
    const system = await loadObject(tx, input.orgId, input.binding.executionSystemId);
    authoringDoc = isRecord(system?.properties)
      ? system.properties[ARGOCD_AUTHORING_PROPERTY]
      : undefined;
  }
  if (authoringDoc === undefined) {
    refuse(
      "no_authoring",
      `component '${component.name}' declares a deployment for SCP to author, but the Argo CD it ` +
        `is bound to declares no \`${ARGOCD_AUTHORING_PROPERTY}\` source — the carrier chart, the ` +
        `scoped project and the namespace allowlist. Install deploy/helm-bundled/authoring/scp-authored-manifests ` +
        `where that Argo CD can read it and set \`properties.${ARGOCD_AUTHORING_PROPERTY}\` on the ` +
        `execution-system — an inline binding can never declare it.`
    );
  }
  const authoring = ArgoCdAuthoringSchema.safeParse(authoringDoc);
  if (!authoring.success) {
    refuse(
      "authoring_unreadable",
      `the Argo CD execution-system's \`${ARGOCD_AUTHORING_PROPERTY}\` is unreadable: ${issues(authoring.error)}`
    );
  }
  const auth = authoring.data!;

  const placeNamespace = readString(place?.properties, "namespace");
  if (placeNamespace !== undefined && !Dns1123LabelSchema.safeParse(placeNamespace).success) {
    refuse(
      "namespace_invalid",
      `deployment-target '${place?.name}' declares namespace '${placeNamespace}', which is not an RFC 1123 label.`
    );
  }
  const namespace = deployment.namespace ?? placeNamespace ?? foldDns1123Label(component.name);
  // THE NAMESPACE ALLOWLIST, server-side (the bundled AppProject enforces it again in Argo CD).
  if (isForbiddenAuthoringNamespace(namespace) || !auth.namespaces.includes(namespace)) {
    refuse(
      "namespace_not_allowed",
      `the authored deployment would land in namespace '${namespace}', which the Argo CD ` +
        `execution-system's authoring allowlist does not name (${auth.namespaces.join(", ")}). ` +
        `SCP authors only into namespaces the operator allowlisted — never a control namespace.`
    );
  }

  // The artifact this release IS, when the change says which one. Two is a question SCP will not
  // answer by picking.
  const digests = ociDigestsOfSourceRef(input.sourceRef);
  if (digests.length > 1) {
    refuse(
      "multiple_digests",
      `the change carries ${digests.length} OCI digests (${digests.join(", ")}); an authored ` +
        `Rollout runs one image, and choosing between them would be a guess.`
    );
  }
  const image =
    digests.length === 1
      ? `${imageRepositoryOf(deployment.image)}@${digests[0]}`
      : deployment.image;

  const externalRef = input.binding?.externalRef ?? null;
  const applicationName =
    externalRef ??
    nameWithIdentity(
      place ? `${component.name}-${place.name}` : component.name,
      `${component.id}:${input.targetObjectId}`
    );
  if (!Dns1123LabelSchema.safeParse(applicationName).success) {
    refuse(
      "application_name_invalid",
      `the binding names Application '${applicationName}', which is not an RFC 1123 label — Argo CD ` +
        `would refuse to create it.`
    );
  }

  // D-a: the component's own declaration wins; the wave plan fills in where it declares none.
  const own = await componentRolloutFor(tx, input.orgId, component.id);
  const wave = own
    ? undefined
    : await waveRolloutFor(tx, input.orgId, input.waveId, [
        input.targetObjectId,
        component.id,
        ...(place ? [place.id] : [])
      ]);
  const strategy = own ?? wave?.strategy;
  const rolloutSource = own
    ? "component"
    : wave?.strategy
      ? `wave:${wave.waveName ?? "(unnamed)"}`
      : "none";
  // Owner decision D-b (2026-09-23): blue-green only with the controller promoting itself.
  if (strategy?.strategy === "blueGreen" && strategy.autoPromotionSeconds === undefined) {
    refuse(
      "blue_green_without_auto_promotion",
      `the wave plan declares a blue-green rollout with no autoPromotionSeconds. Without it the ` +
        `Rollout waits for \`promote\` — the one verb SCP may never call (ADR-0008 §3) — so it ` +
        `would never finish. Declare how long the preview runs before the controller promotes it.`
    );
  }
  if (strategy?.strategy === "blueGreen" && deployment.containerPort === undefined) {
    refuse(
      "blue_green_needs_port",
      `a blue-green Rollout switches traffic between two Services, and \`properties.${AUTHORED_DEPLOYMENT_PROPERTY}\` ` +
        `declares no containerPort for them to target.`
    );
  }

  const cluster = readString(place?.properties, "cluster");
  // THE DESTINATION ALLOWLIST: a place naming an Argo CD cluster may target it only when the
  // operator listed it; otherwise the in-cluster server, which the project allows.
  if (cluster !== undefined && !(auth.clusters ?? []).includes(cluster)) {
    refuse(
      "cluster_not_allowed",
      `deployment-target '${place?.name}' names Argo CD cluster '${cluster}', which the ` +
        `execution-system's authoring does not list in \`clusters\`.`
    );
  }
  // Leaves room for blue-green's `-preview` suffix inside a 63-character Service name.
  const rolloutName = nameWithIdentity(component.name, component.id, 55);
  const rendered = renderAuthoredDeployment({
    orgId: input.orgId,
    applicationName,
    rolloutName,
    namespace,
    image,
    deployment,
    strategy,
    rolloutSource,
    authoring: auth,
    destination: cluster ? { name: cluster } : { server: IN_CLUSTER_SERVER },
    componentObjectId: component.id,
    targetObjectId: input.targetObjectId,
    changeObjectId: input.changeObjectId
  });
  // THE SAME VALIDATOR THE PLUGIN RUNS, on what the server itself authored. It cannot fail for a
  // correct renderer; it is here so a renderer change that widens the document is refused with a
  // Decision instead of reaching Argo CD and failing there.
  assertWithinAuthoring(rendered.application, auth, "rendered_outside_authoring");
  return {
    targetRef: applicationName,
    parameters: { [AUTHORED_APPLICATION_PARAMETER]: rendered.application },
    authoring: auth
  };
}

/** Run the plugin's own validator (`@scp/plugin-argocd`'s `authoredApplicationProblems`) against the
 *  CURRENT authoring, refusing with a Decision. Messages name properties, never identifiers. */
function assertWithinAuthoring(doc: unknown, auth: ArgoCdAuthoring, cause: string): void {
  const config = readAuthoringConfig(auth);
  const problems = config
    ? authoredApplicationProblems(doc, config)
    : ["the execution-system's authoring declaration is not usable"];
  if (problems.length > 0) {
    throw new DeploymentAuthoringRefused(
      `the Application is outside what the Argo CD execution-system's authoring permits: ${problems.join("; ")}`,
      { gate: "deployment_authoring", cause, problems: problems.length }
    );
  }
}

/**
 * D-c (owner decision 2026-09-23): a ROLLBACK RE-AUTHORS THE PRIOR MANIFEST. The prior is what the
 * argocd plugin's `status()` reported as the Application's state (`stateRef.scpAuthoredApplicationJson`)
 * when the original change was triggered — recorded as that wave target's `priorStateRef`.
 *
 * WHAT "THE PRIOR MANIFEST" MEANS (review round 2): the prior release's CONTENT — the Rollout (image,
 * steps) and its Services as they were deployed — re-authored under the CURRENT derivation: today's
 * carrier, today's project, today's destination. Not the prior Application verbatim. The carrier is
 * a pass-through vehicle, not part of the release; pinning a rollback to the carrier revision it
 * happened to ride would make rollback fail precisely after an operator upgraded the carrier, and
 * the prior Application's project/source were only ever the operator's bound at the time — the bound
 * that holds NOW is the one a write must satisfy. So the content is kept, the envelope is current,
 * and the result is re-validated by the same validator the forward path and the plugin run, against
 * the execution-system's current `authoring`.
 *
 * Refused (with a Decision):
 * - no prior (the original change was this target's first authored deployment);
 * - a prior authored for another org or target;
 * - a prior whose destination differs from today's (the target was moved: restoring content into
 *   the OLD namespace would leave the current deployment in place and re-deploy where the operator
 *   may since have revoked — the B1 probe's shape);
 * - a prior whose content no longer satisfies today's authoring (e.g. a namespace or kind the
 *   operator has since withdrawn).
 */
export function authoredRollbackTrigger(
  priorStateRef: unknown,
  forward: AuthoredDeploymentTrigger,
  expected: { orgId: string; targetObjectId: string }
): AuthoredDeploymentTrigger {
  // Carried as a JSON STRING, deliberately: `priorStateRef` is bounded to depth 8 before it is
  // stored (`boundPersistedJson`), and an Application is deeper than that — an object would come
  // back with its Rollout replaced by truncation markers. A string is depth 1; one too long for the
  // byte bound comes back cut, fails to parse, and is refused below rather than re-authored.
  const priorJson = isRecord(priorStateRef)
    ? priorStateRef[PRIOR_AUTHORED_APPLICATION_KEY]
    : undefined;
  let prior: unknown;
  try {
    prior = typeof priorJson === "string" ? JSON.parse(priorJson) : undefined;
  } catch {
    prior = undefined;
  }
  if (!isRecord(prior)) {
    throw new DeploymentAuthoringRefused(
      "a rollback of an SCP-authored Application needs the manifest that was deployed BEFORE the " +
        "change being undone, and none is recorded — the change was this target's first authored " +
        "deployment. Re-propose the version you want as a forward change.",
      { gate: "deployment_authoring", cause: "rollback_without_prior" }
    );
  }
  const labels =
    isRecord(prior.metadata) && isRecord(prior.metadata.labels) ? prior.metadata.labels : {};
  if (
    labels["commanderscp.io/org"] !== expected.orgId ||
    labels["commanderscp.io/target"] !== expected.targetObjectId ||
    labels[SCP_AUTHORED_LABEL_KEY] !== SCP_AUTHORED_LABEL_VALUE
  ) {
    throw new DeploymentAuthoringRefused(
      "the recorded prior Application was not authored by CommanderSCP for this target, so it is " +
        "not something this rollback may restore.",
      { gate: "deployment_authoring", cause: "rollback_prior_foreign" }
    );
  }
  const forwardApp = forward.parameters[AUTHORED_APPLICATION_PARAMETER] as {
    spec: { destination: unknown };
  };
  const priorSpec = isRecord(prior.spec) ? prior.spec : {};
  if (JSON.stringify(priorSpec.destination) !== JSON.stringify(forwardApp.spec.destination)) {
    throw new DeploymentAuthoringRefused(
      "the prior release was deployed to a different destination than this target has now, so " +
        "re-authoring it would restore it somewhere else and leave the current release in place. " +
        "Re-propose the version you want as a forward change.",
      { gate: "deployment_authoring", cause: "rollback_destination_changed" }
    );
  }
  const priorSource = isRecord(priorSpec.source) ? priorSpec.source : {};
  const priorHelm = isRecord(priorSource.helm) ? priorSource.helm : {};
  const priorValues = isRecord(priorHelm.valuesObject) ? priorHelm.valuesObject : {};
  const application = structuredClone(forward.parameters[AUTHORED_APPLICATION_PARAMETER]) as {
    metadata: { annotations: Record<string, string> };
    spec: { source: { helm: { valuesObject: { manifests: unknown } } } };
  };
  application.metadata.annotations["commanderscp.io/rollout-source"] = "rollback";
  application.spec.source.helm.valuesObject.manifests = priorValues.manifests;
  assertWithinAuthoring(application, forward.authoring, "rollback_prior_outside_authoring");
  return {
    targetRef: forward.targetRef,
    parameters: { [AUTHORED_APPLICATION_PARAMETER]: application as Record<string, unknown> },
    authoring: forward.authoring
  };
}
