import { randomBytes } from "node:crypto";
import {
  StackBackendSchema,
  type PutStackStatusRequest,
  type StackBackend,
  type StackBackendSpec,
  type StackBackendStatusReport,
  type StackNeed,
  type StackSettings,
  type StackSpecDocument
} from "@scp/schemas";
import type { HelmRenderer } from "./helm.js";
import { KubeError, type KubeClient } from "./kube.js";
import {
  fingerprint,
  isCrd,
  isOurs,
  parseManifests,
  refKey,
  refOf,
  removedRefs,
  stamp,
  unionRefs,
  type KubeObject,
  type ObjectRef
} from "./manifests.js";
import { checkReadiness, crdEstablished, type Readiness } from "./readiness.js";
import { backendNamespace, type StackRelease } from "./release.js";
import { EMPTY_STATE, type BackendState, type StateStore } from "./state.js";
import { mintSelfSignedCertificate } from "./tls.js";
import {
  backendNeeds,
  deriveBackendValues,
  type GiteaSecrets,
  type ValuesContext
} from "./values.js";

/**
 * THE STACK CONTROLLER'S RECONCILE (M29.4, ADR-0058).
 *
 * One tick reads the desired state from scpd — the only input from outside the image — and walks
 * the backends ONE AT A TIME. Each enabled backend is rendered from the vendored chart, and if its
 * rendered set differs from the last one that was healthy, applied (CRDs first, as their own step,
 * then everything else), health-checked, and only then recorded as the new last good set and the
 * objects it no longer contains pruned. A set that does not become healthy is replaced by the last
 * good one, and the attempt is remembered so it is not retried until an operator asks
 * (`POST /instance/stack/upgrade`) or the desired set changes. A disabled backend's objects are
 * deleted. Status is written back after every backend, so the Stack page follows a long upgrade.
 *
 * Seam for M29.2 (auto-wire): `ControllerDeps.afterReady` runs once a backend's set is healthy.
 */

export interface StackApi {
  spec(): Promise<StackSpecDocument>;
  putStatus(req: PutStackStatusRequest): Promise<void>;
}

export interface ControllerDeps {
  api: StackApi;
  kube: KubeClient;
  helm: HelmRenderer;
  release: StackRelease;
  store: StateStore;
  scpNamespace: string;
  federationRole: "commander" | "outpost" | "retrans";
  readyTimeoutMs: number;
  crdTimeoutMs: number;
  removeTimeoutMs: number;
  pollMs: number;
  /** How often an unchanged, healthy set is re-applied to undo drift. */
  resyncMs: number;
  log: (line: string) => void;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** M29.2's seam: wiring that needs a healthy backend (registration, tokens, egress). */
  afterReady?: (backend: StackBackend, objects: KubeObject[]) => Promise<StackNeed[]>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface DesiredSet {
  objects: KubeObject[];
  fingerprint: string;
  needs: StackNeed[];
}

// ---- rendering ----------------------------------------------------------------------------------

const alnum = (n: number): string => {
  let out = "";
  while (out.length < n)
    out += randomBytes(n)
      .toString("base64")
      .replace(/[^A-Za-z0-9]/g, "");
  return out.slice(0, n);
};

const secretData = (live: KubeObject | null, key: string): string | undefined => {
  const raw = (live?.["data"] as Record<string, string> | undefined)?.[key];
  return raw === undefined ? undefined : Buffer.from(raw, "base64").toString("utf8");
};

/** Gitea's generate-once values, read back from the running install (what `lookup` would do). */
export async function resolveGiteaSecrets(
  kube: KubeClient,
  namespace: string
): Promise<GiteaSecrets> {
  const admin = await kube.get({
    apiVersion: "v1",
    kind: "Secret",
    name: "gitea-admin-secret",
    namespace
  });
  const inline = await kube.get({
    apiVersion: "v1",
    kind: "Secret",
    name: "scp-gitea-inline-config",
    namespace
  });
  const security = secretData(inline, "security") ?? "";
  const found = (k: string) => new RegExp(`^${k}=(.+)$`, "m").exec(security)?.[1]?.trim();
  return {
    adminPassword: secretData(admin, "password") || alnum(24),
    secretKey: found("SECRET_KEY") || alnum(64),
    internalToken: found("INTERNAL_TOKEN") || alnum(105)
  };
}

export async function renderBackend(
  deps: ControllerDeps,
  spec: StackBackendSpec
): Promise<DesiredSet> {
  const ctx: ValuesContext = {
    release: deps.release,
    scpNamespace: deps.scpNamespace,
    federationRole: deps.federationRole
  };
  if (spec.backend === "gitea") {
    ctx.gitea = await resolveGiteaSecrets(deps.kube, backendNamespace(deps.release, "gitea"));
  }
  const values = deriveBackendValues(spec, ctx);
  const text = await deps.helm.template(deps.release.chartDir, values);
  const objects = stamp(parseManifests(text), spec.backend, deps.release.version);
  if (objects.length === 0) throw new Error(`the chart rendered nothing for ${spec.backend}`);
  return { objects, fingerprint: fingerprint(objects), needs: backendNeeds(spec, values, ctx) };
}

/** argo-server's persistent certificate: minted once, never rotated while the Secret exists. */
export async function ensureArgoServerTls(deps: ControllerDeps): Promise<void> {
  const namespace = backendNamespace(deps.release, "argo-workflows");
  const defaults = deps.release.chartValues as {
    bundledExecutor?: { argoWorkflows?: { tlsSecretName?: string } };
  };
  const name = defaults.bundledExecutor?.argoWorkflows?.tlsSecretName || "argo-server-tls";
  if (await deps.kube.get({ apiVersion: "v1", kind: "Secret", name, namespace })) return;
  const host = `argo-server.${namespace}`;
  const minted = mintSelfSignedCertificate({
    commonName: `${host}.svc`,
    dnsNames: ["argo-server", host, `${host}.svc`, `${host}.svc.cluster.local`],
    validDays: 3650
  });
  await deps.kube.apply({
    apiVersion: "v1",
    kind: "Secret",
    type: "kubernetes.io/tls",
    metadata: {
      name,
      namespace,
      labels: {
        "stack.commanderscp.io/managed-by": "scp-stackd",
        "stack.commanderscp.io/backend": "argo-workflows"
      }
    },
    stringData: { "tls.crt": minted.certPem, "tls.key": minted.keyPem }
  });
  deps.log(`minted argo-server's persistent certificate into ${namespace}/${name}`);
}

// ---- applying -----------------------------------------------------------------------------------

async function until(
  deps: ControllerDeps,
  timeoutMs: number,
  probe: () => Promise<boolean>
): Promise<boolean> {
  const sleep = deps.sleep ?? defaultSleep;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(deps.pollMs);
  }
}

/** CRDs first, as their own step, Established before anything else is sent; then the rest,
 *  Namespaces leading. */
export async function applyManifestSet(deps: ControllerDeps, objects: KubeObject[]): Promise<void> {
  const crds = objects.filter(isCrd);
  for (const crd of crds) await deps.kube.apply(crd);
  if (crds.length > 0) {
    const established = await until(deps, deps.crdTimeoutMs, async () => {
      for (const crd of crds) {
        const live = await deps.kube.get(refOf(crd));
        if (!live || !crdEstablished(live)) return false;
      }
      return true;
    });
    if (!established) {
      throw new Error(
        `CustomResourceDefinitions not Established within ${deps.crdTimeoutMs / 1000}s`
      );
    }
    // The kinds those CRDs define are only discoverable now.
    for (const crd of crds) {
      const spec = crd["spec"] as { group?: string; versions?: { name: string }[] } | undefined;
      for (const v of spec?.versions ?? []) deps.kube.invalidate(`${spec?.group}/${v.name}`);
    }
  }
  const rest = objects.filter((o) => !isCrd(o));
  const ordered = [
    ...rest.filter((o) => o.kind === "Namespace"),
    ...rest.filter((o) => o.kind !== "Namespace")
  ];
  for (const o of ordered) await deps.kube.apply(o);
}

async function waitReady(
  deps: ControllerDeps,
  objects: (KubeObject | ObjectRef)[]
): Promise<Readiness> {
  let last: Readiness = { ready: false, detail: [] };
  await until(deps, deps.readyTimeoutMs, async () => {
    last = await checkReadiness(deps.kube, objects);
    return last.ready;
  });
  return last;
}

/** Deletes what the set no longer renders — only objects carrying THIS backend's labels, and never
 *  a CRD (deleting one deletes every custom resource of its kind, cluster-wide) or a Namespace
 *  (the main chart owns them, and the controller's rights live in them). */
export async function pruneRemoved(
  deps: ControllerDeps,
  backend: StackBackend,
  refs: ObjectRef[]
): Promise<ObjectRef[]> {
  const deleted: ObjectRef[] = [];
  for (const ref of refs) {
    if (isCrd(ref) || ref.kind === "Namespace") continue;
    const live = await deps.kube.get(ref);
    if (!live) continue;
    if (!isOurs(live, backend)) {
      deps.log(`not pruning ${refKey(ref)}: it does not carry ${backend}'s stack labels`);
      continue;
    }
    await deps.kube.delete(ref);
    deleted.push(ref);
  }
  return deleted;
}

// ---- one backend --------------------------------------------------------------------------------

interface Outcome {
  report: StackBackendStatusReport;
  state: BackendState;
}

function report(
  backend: StackBackend,
  release: string,
  fields: Partial<Omit<StackBackendStatusReport, "backend">> &
    Pick<StackBackendStatusReport, "phase">
): StackBackendStatusReport {
  return {
    backend,
    runningVersion: null,
    targetVersion: release,
    needs: [],
    ...fields,
    lastError: fields.lastError ? fields.lastError.slice(0, 2000) : null,
    detail: (fields.detail ?? []).map((d) => d.slice(0, 500)).slice(0, 50)
  };
}

/** When each backend's set was last applied, per controller, for the drift resync. In memory on
 *  purpose: a restarted controller re-applies once, which is exactly when drift is likeliest. */
const appliedAtByController = new WeakMap<ControllerDeps, Map<StackBackend, number>>();
function appliedAt(deps: ControllerDeps): Map<StackBackend, number> {
  let m = appliedAtByController.get(deps);
  if (!m) appliedAtByController.set(deps, (m = new Map()));
  return m;
}

export async function reconcileBackend(
  deps: ControllerDeps,
  spec: StackBackendSpec,
  settings: StackSettings,
  progress: (r: StackBackendStatusReport) => Promise<void>
): Promise<Outcome> {
  const { backend } = spec;
  const release = deps.release.version;
  const state = await deps.store.load(backend);

  if (!spec.enabled) {
    if (state.inventory.length === 0 && !state.lastGood) {
      return { report: report(backend, release, { phase: "disabled" }), state };
    }
    await progress(
      report(backend, release, {
        phase: "removing",
        runningVersion: state.lastGood?.release ?? null
      })
    );
    await pruneRemoved(deps, backend, state.inventory);
    const gone = await until(deps, deps.removeTimeoutMs, async () => {
      for (const ref of state.inventory) {
        if (isCrd(ref) || ref.kind === "Namespace") continue;
        const live = await deps.kube.get(ref);
        if (live && isOurs(live, backend)) return false;
      }
      return true;
    });
    if (!gone) {
      return {
        report: report(backend, release, {
          phase: "removing",
          lastError: `not every object was gone within ${deps.removeTimeoutMs / 1000}s; retrying`
        }),
        state
      };
    }
    await deps.store.clear(backend, state.lastGood?.chunks ?? 0);
    appliedAt(deps).delete(backend);
    deps.log(`${backend}: removed`);
    return { report: report(backend, release, { phase: "disabled" }), state: { ...EMPTY_STATE } };
  }

  if (backend === "argo-workflows") await ensureArgoServerTls(deps);
  const desired = await renderBackend(deps, spec);
  const lastGood = state.lastGood;
  const now = (deps.now ?? (() => new Date()))();

  // STEADY: the healthy set is what is desired. Re-apply on the resync cadence to undo drift.
  if (lastGood && lastGood.fingerprint === desired.fingerprint) {
    const appliedAtMs = appliedAt(deps).get(backend);
    if (appliedAtMs === undefined || now.getTime() - appliedAtMs >= deps.resyncMs) {
      await applyManifestSet(deps, desired.objects);
      appliedAt(deps).set(backend, now.getTime());
    }
    const health = await checkReadiness(deps.kube, desired.objects);
    const wired =
      health.ready && deps.afterReady ? await deps.afterReady(backend, desired.objects) : [];
    return {
      report: report(backend, release, {
        phase: health.ready ? "ready" : "degraded",
        runningVersion: lastGood.release,
        needs: [...desired.needs, ...wired],
        detail: health.detail,
        ...(health.ready ? {} : { lastError: "a workload that was healthy is not available" })
      }),
      state
    };
  }

  // HELD: a new release under the manual update policy waits for `POST /instance/stack/upgrade`.
  const releaseChange = lastGood !== null && lastGood.release !== release;
  if (
    releaseChange &&
    lastGood &&
    settings.updatePolicy === "manual" &&
    settings.upgradeGeneration <= lastGood.upgradeGeneration
  ) {
    const health = await checkReadiness(deps.kube, state.inventory);
    return {
      report: report(backend, release, {
        phase: health.ready ? "ready" : "degraded",
        runningVersion: lastGood.release,
        needs: [
          {
            code: "upgrade-approval",
            message: `Release ${release} is available (running ${lastGood.release}); updates are manual, so it waits for an upgrade request.`
          }
        ],
        detail: health.detail
      }),
      state
    };
  }

  // REMEMBERED FAILURE: not retried until the desired set changes or an operator asks again.
  const failed = state.failed;
  if (
    failed &&
    failed.fingerprint === desired.fingerprint &&
    settings.upgradeGeneration <= failed.upgradeGeneration
  ) {
    if (lastGood) {
      const health = await checkReadiness(deps.kube, state.inventory);
      return {
        report: report(backend, release, {
          phase: health.ready ? "degraded" : "failed",
          runningVersion: lastGood.release,
          lastError: failed.error,
          needs: [
            {
              code: "upgrade-rolled-back",
              message: `The change to release ${failed.release} did not become healthy and was rolled back to ${lastGood.release}. Retry with an upgrade request.`
            }
          ],
          detail: health.detail
        }),
        state
      };
    }
    // A failed first install has nothing to fall back to and stays applied: if its workloads come
    // up after all (a slow image pull), it becomes the last good set.
    const health = await checkReadiness(deps.kube, desired.objects);
    if (!health.ready) {
      return {
        report: report(backend, release, {
          phase: "failed",
          lastError: failed.error,
          detail: health.detail
        }),
        state
      };
    }
    return promote(deps, spec, settings, state, desired, health);
  }

  // ATTEMPT.
  await progress(
    report(backend, release, {
      phase: lastGood ? "upgrading" : "installing",
      runningVersion: lastGood?.release ?? null,
      needs: desired.needs
    })
  );
  const withInventory: BackendState = {
    ...state,
    inventory: unionRefs(state.inventory, desired.objects.map(refOf))
  };
  await deps.store.save(backend, withInventory); // a crash from here on still knows what exists
  let health: Readiness;
  let applyError: string | null = null;
  try {
    await applyManifestSet(deps, desired.objects);
    appliedAt(deps).set(backend, now.getTime());
    health = await waitReady(deps, desired.objects);
  } catch (err) {
    applyError = err instanceof Error ? err.message : String(err);
    health = { ready: false, detail: [applyError] };
  }
  if (health.ready) return promote(deps, spec, settings, withInventory, desired, health);

  const error =
    applyError ??
    `release ${release} did not become healthy within ${deps.readyTimeoutMs / 1000}s: ${health.detail
      .filter((d) => !/: (\d+)\/\1 (available|ready), \d+ updated$/.test(d))
      .slice(0, 3)
      .join("; ")}`;
  const attempt = {
    fingerprint: desired.fingerprint,
    release,
    upgradeGeneration: settings.upgradeGeneration,
    error,
    at: now.toISOString()
  };
  if (!lastGood) {
    const next: BackendState = { ...withInventory, failed: attempt };
    await deps.store.save(backend, next);
    deps.log(`${backend}: install failed: ${error}`);
    return {
      report: report(backend, release, {
        phase: "failed",
        lastError: error,
        detail: health.detail
      }),
      state: next
    };
  }

  // FALL BACK to the last good set, and delete what only the failed set added.
  deps.log(`${backend}: ${error} — restoring the last good set (${lastGood.release})`);
  const good = await deps.store.loadLastGood(backend, lastGood.chunks);
  await applyManifestSet(deps, good);
  const goodRefs = good.map(refOf);
  await pruneRemoved(deps, backend, removedRefs(withInventory.inventory, goodRefs));
  appliedAt(deps).set(backend, now.getTime());
  const restored = await waitReady(deps, good);
  const next: BackendState = { ...state, inventory: goodRefs, failed: attempt };
  await deps.store.save(backend, next);
  return {
    report: report(backend, release, {
      phase: restored.ready ? "degraded" : "failed",
      runningVersion: lastGood.release,
      lastError: `${error}; rolled back to ${lastGood.release}${restored.ready ? "" : ", which is not healthy either"}`,
      needs: [
        {
          code: "upgrade-rolled-back",
          message: `The change to release ${release} did not become healthy and was rolled back to ${lastGood.release}. Retry with an upgrade request.`
        }
      ],
      detail: [...restored.detail, ...health.detail.map((d) => `(failed attempt) ${d}`)]
    }),
    state: next
  };
}

/** A healthy set becomes the last good one; what it no longer renders is pruned. */
async function promote(
  deps: ControllerDeps,
  spec: StackBackendSpec,
  settings: StackSettings,
  state: BackendState,
  desired: DesiredSet,
  health: Readiness
): Promise<Outcome> {
  const { backend } = spec;
  const release = deps.release.version;
  const chunks = await deps.store.saveLastGood(
    backend,
    desired.objects,
    state.lastGood?.chunks ?? 0
  );
  const refs = desired.objects.map(refOf);
  const next: BackendState = {
    inventory: refs,
    lastGood: {
      release,
      fingerprint: desired.fingerprint,
      upgradeGeneration: settings.upgradeGeneration,
      appliedAt: (deps.now ?? (() => new Date()))().toISOString(),
      chunks
    },
    failed: null
  };
  // Saved BEFORE pruning: a crash mid-prune leaves the old objects listed nowhere, and the label
  // check is what keeps a later prune from ever touching anything that is not this backend's.
  await deps.store.save(backend, next);
  const pruned = await pruneRemoved(deps, backend, removedRefs(state.inventory, refs));
  if (pruned.length > 0)
    deps.log(`${backend}: pruned ${pruned.length} objects the set no longer renders`);
  const wired = deps.afterReady ? await deps.afterReady(backend, desired.objects) : [];
  deps.log(`${backend}: ready at ${release}`);
  return {
    report: report(backend, release, {
      phase: "ready",
      runningVersion: release,
      needs: [...desired.needs, ...wired],
      detail: health.detail
    }),
    state: next
  };
}

// ---- the whole stack ----------------------------------------------------------------------------

/** One reconcile tick. Returns the report it last published. */
export async function reconcileStack(deps: ControllerDeps): Promise<PutStackStatusRequest> {
  const spec = await deps.api.spec();
  const specs = new Map(spec.backends.map((b) => [b.backend, b]));
  const reports = new Map<StackBackend, StackBackendStatusReport>();
  const publish = async (): Promise<PutStackStatusRequest> => {
    const body: PutStackStatusRequest = {
      release: deps.release.version,
      observedUpgradeGeneration: spec.settings.upgradeGeneration,
      backends: [...reports.values()]
    };
    try {
      await deps.api.putStatus(body);
    } catch (err) {
      deps.log(
        `status report failed (will retry next tick): ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return body;
  };
  let last: PutStackStatusRequest | undefined;
  for (const backend of StackBackendSchema.options) {
    const backendSpec = specs.get(backend) ?? {
      backend,
      enabled: false,
      sizeTier: "small" as const
    };
    try {
      const outcome = await reconcileBackend(deps, backendSpec, spec.settings, async (r) => {
        reports.set(backend, r);
        await publish();
      });
      reports.set(backend, outcome.report);
    } catch (err) {
      const message =
        err instanceof KubeError && err.status === 403
          ? `the controller's Kubernetes rights do not cover this: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      deps.log(`${backend}: reconcile failed: ${message}`);
      reports.set(
        backend,
        report(backend, deps.release.version, { phase: "failed", lastError: message })
      );
    }
    last = await publish();
  }
  return last!;
}

export interface StackControllerHandle {
  stop(): Promise<void>;
  /** Resolves after the first complete tick (for health probes and tests). */
  readonly firstTick: Promise<void>;
  lastTickAt(): Date | null;
}

/** The controller's loop: one tick, then the interval, until stopped. */
export function startStackController(
  deps: ControllerDeps,
  opts: { intervalMs: number }
): StackControllerHandle {
  let stopped = false;
  let wake: (() => void) | undefined;
  let lastTick: Date | null = null;
  let resolveFirst!: () => void;
  const firstTick = new Promise<void>((r) => (resolveFirst = r));
  const loop = (async () => {
    while (!stopped) {
      try {
        await reconcileStack(deps);
      } catch (err) {
        deps.log(`tick failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      lastTick = new Date();
      resolveFirst();
      if (stopped) break;
      await new Promise<void>((r) => {
        wake = r;
        setTimeout(r, opts.intervalMs);
      });
    }
  })();
  return {
    firstTick,
    lastTickAt: () => lastTick,
    async stop() {
      stopped = true;
      wake?.();
      await loop;
    }
  };
}
