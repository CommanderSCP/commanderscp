import { createHash } from "node:crypto";
import {
  ARGOCD_AUTHORING_PROPERTY,
  AUTHORED_DEPLOYMENT_PROPERTY,
  ArgoCdAuthoringSourceSchema,
  AuthoredDeploymentSchema,
  Dns1123LabelSchema,
  SCP_AUTHORED_LABEL_KEY,
  SCP_AUTHORED_LABEL_VALUE,
  type ArgoCdAuthoringSource,
  type AuthoredDeployment,
  type RolloutStrategy
} from "@scp/schemas";
import { and, eq, isNull } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { changePlans, changeWaves, objects } from "../db/schema.js";
import { ociDigestsOfSourceRef } from "./artifact-facts.js";
import { parseTopologyWaves } from "./topology-waves.js";

/**
 * M28.4 — WHAT A DEPLOY-LANE TRIGGER TELLS ARGO CD WHEN SCP AUTHORS THE DEPLOYMENT (ADR-0055).
 *
 * The third sibling of `buildLaneTriggerParameters` and `opsLaneTriggerParameters`, and the same
 * rule: the SERVER derives the material from what the graph already holds, and the plugin carries
 * it to the executor. Here the material is an Argo CD `Application` whose one source is the
 * operator-installed carrier chart, with the SCP-authored Argo `Rollout` in its values. Argo CD's
 * own controller writes the Rollout into the cluster; SCP never holds a credential that could.
 *
 * WHEN IT APPLIES. Only to an `argocd` binding, and only when the component declares
 * `properties.deployment`. Everything else returns `undefined` and the trigger is byte-identical
 * to the import-and-coordinate path (Mode A): an Application SCP did not author is synced, never
 * written.
 *
 * THE ROLLOUT'S STEPS ARE THE WAVE PLAN'S. The release topology's wave that names this target's
 * place carries `rollout` (`RolloutStrategySchema`); that is what the steps are written from, so
 * every component released through one wave rolls in one step vocabulary. Absent ⇒ a canary with
 * no steps, which Argo Rollouts runs as an ordinary rolling update.
 *
 * WHAT IT NEVER WRITES: a step only `promote` can release. A pause is always timed — `pause: {}`
 * waits for a `kubectl argo rollouts promote`, and ADR-0008 §3 forbids SCP that verb, so an
 * authored indefinite pause is a Rollout nobody is allowed to finish.
 */

export class DeploymentAuthoringRefused extends Error {}

/** The trigger parameter the argocd plugin reads the authored Application from — the plugin's
 *  `AUTHORED_APPLICATION_PARAMETER`, pinned equal by `deploy-lane-trigger-parameters.test.ts`. */
export const AUTHORED_APPLICATION_PARAMETER = "scpAuthoredApplication";

export const WAVE_TARGET_DEPLOYMENT_REFUSED_AUDIT_ACTION =
  "change.wave_target.deployment_authoring_refused";

/** Argo CD's in-cluster destination — the default when the place names no registered cluster. */
export const IN_CLUSTER_SERVER = "https://kubernetes.default.svc";

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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(bag: unknown, key: string): string | undefined {
  if (!isRecord(bag)) return undefined;
  const v = bag[key];
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
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

/** Argo Rollouts canary steps for one declared strategy. Every pause carries a duration. */
export function rolloutStepsFor(strategy: RolloutStrategy | undefined): {
  canary: Record<string, unknown>;
} {
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
  rollout: Record<string, unknown>;
}

export interface RenderAuthoredDeploymentInput {
  applicationName: string;
  rolloutName: string;
  namespace: string;
  image: string;
  deployment: AuthoredDeployment;
  strategy: RolloutStrategy | undefined;
  source: ArgoCdAuthoringSource;
  destination: { server: string } | { name: string };
  componentObjectId: string;
  targetObjectId: string;
  changeObjectId: string;
}

/** PURE: the two manifests SCP authors. The Rollout rides in the Application's values; the carrier
 *  chart renders `manifests` verbatim, so what is asserted here is what Argo CD applies. */
export function renderAuthoredDeployment(
  input: RenderAuthoredDeploymentInput
): RenderedAuthoredDeployment {
  const selector = { "app.kubernetes.io/name": input.rolloutName };
  const labels = {
    ...selector,
    "app.kubernetes.io/managed-by": "commanderscp",
    [SCP_AUTHORED_LABEL_KEY]: SCP_AUTHORED_LABEL_VALUE
  };
  const container: Record<string, unknown> = { name: input.rolloutName, image: input.image };
  if (input.deployment.containerPort !== undefined) {
    container.ports = [{ containerPort: input.deployment.containerPort }];
  }
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
      strategy: rolloutStepsFor(input.strategy)
    }
  };
  const { project, ...source } = input.source;
  const application = {
    apiVersion: "argoproj.io/v1alpha1",
    kind: "Application",
    metadata: {
      name: input.applicationName,
      labels: {
        "app.kubernetes.io/managed-by": "commanderscp",
        [SCP_AUTHORED_LABEL_KEY]: SCP_AUTHORED_LABEL_VALUE,
        "commanderscp.io/component": input.componentObjectId,
        "commanderscp.io/target": input.targetObjectId
      },
      annotations: { "commanderscp.io/change": input.changeObjectId }
    },
    spec: {
      project: project ?? "default",
      destination: { ...input.destination, namespace: input.namespace },
      source: { ...source, helm: { valuesObject: { manifests: [rollout] } } },
      // No `automated` policy: SCP triggers every sync, which is what makes each one a coordinated
      // release rather than something Argo CD does on its own schedule.
      syncPolicy: { syncOptions: ["CreateNamespace=true"] }
    }
  };
  return { application, rollout };
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
): Promise<{ strategy: RolloutStrategy | undefined; waveName: string | null }> {
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
  const waves = parseTopologyWaves(plan?.topologyDocument ?? null) ?? [];
  // A sequential wave splits into several compiled waves, so the compiled index is not the
  // document's. Membership is: the topology wave naming this target's place (or the target).
  const members = new Set(memberIds);
  const declared = waves.filter((w) => w.targets.some((t) => members.has(t)));
  const distinct = new Set(declared.map((w) => JSON.stringify(w.rollout ?? null)));
  if (distinct.size > 1) {
    throw new DeploymentAuthoringRefused(
      `the release topology names this target's place in ${declared.length} waves declaring ` +
        `different rollouts, so which steps to author is ambiguous — declare the place once, or ` +
        `give every wave that names it the same rollout.`
    );
  }
  return { strategy: declared[0]?.rollout, waveName: wave.name };
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

  if (readString(component.properties, "argocdApplication") !== undefined) {
    throw new DeploymentAuthoringRefused(
      `component '${component.name}' was imported from an existing Argo CD Application ` +
        `(properties.argocdApplication) AND declares \`properties.${AUTHORED_DEPLOYMENT_PROPERTY}\` ` +
        `for SCP to author. SCP never overwrites an Application it did not author: remove one of the two.`
    );
  }
  const parsed = AuthoredDeploymentSchema.safeParse(declared);
  if (!parsed.success) {
    throw new DeploymentAuthoringRefused(
      `component '${component.name}' declares an unreadable \`properties.${AUTHORED_DEPLOYMENT_PROPERTY}\`: ` +
        parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")
    );
  }
  const deployment = parsed.data;

  // WHERE Argo CD reads the authored manifests from. The execution-system's declaration wins, the
  // same precedence its serverUrl and token already have over an inline binding's config.
  let authoringDoc: unknown;
  if (input.binding?.executionSystemId) {
    const system = await loadObject(tx, input.orgId, input.binding.executionSystemId);
    authoringDoc = isRecord(system?.properties)
      ? system.properties[ARGOCD_AUTHORING_PROPERTY]
      : undefined;
  } else if (isRecord(input.binding?.config)) {
    authoringDoc = input.binding.config[ARGOCD_AUTHORING_PROPERTY];
  }
  if (authoringDoc === undefined) {
    throw new DeploymentAuthoringRefused(
      `component '${component.name}' declares a deployment for SCP to author, but the Argo CD it ` +
        `is bound to declares no \`${ARGOCD_AUTHORING_PROPERTY}\` source — the carrier chart Argo CD ` +
        `renders SCP-authored manifests from. Install deploy/helm-bundled/authoring/scp-authored-manifests ` +
        `where that Argo CD can read it and set \`properties.${ARGOCD_AUTHORING_PROPERTY}\` on the execution-system.`
    );
  }
  const source = ArgoCdAuthoringSourceSchema.safeParse(authoringDoc);
  if (!source.success) {
    throw new DeploymentAuthoringRefused(
      `the Argo CD execution-system's \`${ARGOCD_AUTHORING_PROPERTY}\` is unreadable: ` +
        source.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")
    );
  }

  const placeNamespace = readString(place?.properties, "namespace");
  if (placeNamespace !== undefined && !Dns1123LabelSchema.safeParse(placeNamespace).success) {
    throw new DeploymentAuthoringRefused(
      `deployment-target '${place?.name}' declares namespace '${placeNamespace}', which is not an RFC 1123 label.`
    );
  }
  const namespace = deployment.namespace ?? placeNamespace ?? foldDns1123Label(component.name);

  // The artifact this release IS, when the change says which one. Two is a question SCP will not
  // answer by picking.
  const digests = ociDigestsOfSourceRef(input.sourceRef);
  if (digests.length > 1) {
    throw new DeploymentAuthoringRefused(
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
    externalRef ?? foldDns1123Label(place ? `${component.name}-${place.name}` : component.name);
  if (!Dns1123LabelSchema.safeParse(applicationName).success) {
    throw new DeploymentAuthoringRefused(
      `the binding names Application '${applicationName}', which is not an RFC 1123 label — Argo CD ` +
        `would refuse to create it.`
    );
  }

  const cluster = readString(place?.properties, "cluster");
  const { strategy } = await waveRolloutFor(tx, input.orgId, input.waveId, [
    input.targetObjectId,
    component.id,
    ...(place ? [place.id] : [])
  ]);

  const rendered = renderAuthoredDeployment({
    applicationName,
    rolloutName: foldDns1123Label(component.name),
    namespace,
    image,
    deployment,
    strategy,
    source: source.data,
    destination: cluster ? { name: cluster } : { server: IN_CLUSTER_SERVER },
    componentObjectId: component.id,
    targetObjectId: input.targetObjectId,
    changeObjectId: input.changeObjectId
  });
  return {
    targetRef: applicationName,
    parameters: { [AUTHORED_APPLICATION_PARAMETER]: rendered.application }
  };
}
