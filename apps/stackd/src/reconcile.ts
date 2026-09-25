import { randomBytes } from "node:crypto";
import {
  StackBackendSchema,
  type PutStackStatusRequest,
  type PutStackWiringRequest,
  type StackBackend,
  type StackBackendIntegrity,
  type StackBackendSpec,
  type StackBackendWiringSpec,
  type StackBackendStatusReport,
  type StackNeed,
  type StackSettings,
  type StackSpecDocument,
  type PutStackAuthoringRequest
} from "@scp/schemas";
import type { HelmRenderer } from "./helm.js";
import { KubeError, type KubeClient } from "./kube.js";
import {
  assertStackSet,
  fingerprint,
  isCrd,
  isOurs,
  parseManifests,
  refKey,
  refOf,
  refViolation,
  removedRefs,
  stamp,
  STACK_KINDS,
  unionRefs,
  type KubeObject,
  type ObjectRef,
  type StackKind
} from "./manifests.js";
import { checkReadiness, crdEstablished, type Readiness } from "./readiness.js";
import { backendNamespace, type StackRelease } from "./release.js";
import {
  EMPTY_STATE,
  inventoryDigest,
  stateDigests,
  type BackendState,
  type StateDigests,
  type StateStore
} from "./state.js";
import type { BackendHttp } from "./backend-http.js";
import { ensureArgoServerTls, type WiringContext } from "./wiring.js";
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
 * (`POST /instance/stack/upgrade`) or the desired set changes. A disabled backend's workloads are
 * deleted and its DATA KEPT (volumes, generate-once secrets) until an operator purges it
 * (`POST /instance/stack/backends/:b/purge`, review S3). Status is written back after every
 * backend, so the Stack page follows a long upgrade.
 *
 * What the controller reads back from the cluster — its inventory and the last good set — is
 * checked twice before it is acted on (review S1): against the sha256 scpd recorded from the
 * controller's own last report (a mismatch is refused, and said so), and object by object against
 * `STACK_KINDS` and the backend's namespace, then re-stamped, before a fall back applies it.
 *
 * M29.2 (ADR-0061): once a backend's set is healthy, `ControllerDeps.afterReady` wires it into SCP
 * (`wiring.ts` — token, CA, both egress layers, registration), and before a disabled backend is
 * removed `ControllerDeps.unwire` takes that back.
 */

export interface StackApi {
  spec(): Promise<StackSpecDocument>;
  putStatus(req: PutStackStatusRequest): Promise<void>;
  /** M29.2: the hand-off after a backend is healthy, and its withdrawal on disable. */
  putWiring(backend: StackBackend, req: PutStackWiringRequest): Promise<void>;
  deleteWiring(backend: StackBackend): Promise<void>;
  /** M29.3: the canary-authoring hand-off, and its withdrawal. */
  putAuthoring(req: PutStackAuthoringRequest): Promise<void>;
  deleteAuthoring(): Promise<void>;
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
  /** The kinds a backend may contain; `STACK_KINDS` unless a test's fake chart needs its own. */
  kinds?: readonly StackKind[];
  /** M29.2: wiring that needs a healthy backend (token, CA, egress, registration) — `wireBackend`. */
  afterReady?: (
    backend: StackBackend,
    objects: KubeObject[],
    ctx: WiringContext
  ) => Promise<StackNeed[]>;
  /** M29.3: the stack-level step after every backend (`reconcileAuthoring`): canary authoring.
   *  Its needs join the argo-rollouts report. */
  afterStack?: (input: {
    spec: StackSpecDocument;
    reports: Map<StackBackend, StackBackendStatusReport>;
    renders: Map<StackBackend, KubeObject[]>;
  }) => Promise<StackNeed[]>;
  /** M29.2: runs before a disabled backend is removed — `unwireBackend`. */
  unwire?: (backend: StackBackend, ctx: { wasWired: boolean }) => Promise<void>;
  /** M29.2: what the wiring step needs: a client for the backends' own APIs, and the labels that
   *  select scpd's pods (the egress NetworkPolicy's subject). */
  wiring?: { http: BackendHttp; scpPodLabels: Record<string, string> };
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** What one backend's render may depend on beyond its own spec — typed booleans derived from the
 *  WHOLE spec, never a string (M29.3: whether canary authoring is wanted, which puts the SCP
 *  account's create/update grant on the authoring project into Argo CD's render). */
export interface StackWide {
  authoring: boolean;
}

/** Canary authoring is wanted exactly while Argo CD, Gitea and Argo Rollouts are all enabled. */
export function stackWideOf(backends: StackBackendSpec[]): StackWide {
  const on = new Set(backends.filter((b) => b.enabled).map((b) => b.backend));
  return { authoring: on.has("argocd") && on.has("gitea") && on.has("argo-rollouts") };
}

export interface DesiredSet {
  objects: KubeObject[];
  fingerprint: string;
  needs: StackNeed[];
}

// ---- data ---------------------------------------------------------------------------------------

/** Secrets whose values are generated once and read back on every later render (Gitea's admin
 *  password, its SECRET_KEY and INTERNAL_TOKEN): losing one locks the data out, so it is data. */
export const GENERATE_ONCE_SECRETS: readonly string[] = [
  "gitea-admin-secret",
  "scp-gitea-inline-config"
];

/** A backend's DATA: kept when it is disabled or a release stops rendering it; deleted only by a
 *  purge (review S3). */
export const isRetainedData = (ref: ObjectRef): boolean =>
  (ref.kind === "PersistentVolumeClaim" && ref.apiVersion === "v1") ||
  (ref.kind === "Secret" && ref.apiVersion === "v1" && GENERATE_ONCE_SECRETS.includes(ref.name));

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
  const [adminName, inlineName] = GENERATE_ONCE_SECRETS as [string, string];
  const admin = await kube.get({ apiVersion: "v1", kind: "Secret", name: adminName, namespace });
  const inline = await kube.get({ apiVersion: "v1", kind: "Secret", name: inlineName, namespace });
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
  spec: StackBackendSpec,
  stackWide: StackWide = { authoring: false }
): Promise<DesiredSet> {
  const ctx: ValuesContext = {
    release: deps.release,
    scpNamespace: deps.scpNamespace,
    federationRole: deps.federationRole,
    authoring: stackWide.authoring
  };
  const namespace = backendNamespace(deps.release, spec.backend);
  if (spec.backend === "gitea") ctx.gitea = await resolveGiteaSecrets(deps.kube, namespace);
  const values = deriveBackendValues(spec, ctx);
  const text = await deps.helm.template(deps.release.chartDir, values);
  const objects = stamp(parseManifests(text), spec.backend, deps.release.version);
  if (objects.length === 0) throw new Error(`the chart rendered nothing for ${spec.backend}`);
  assertStackSet(objects, namespace, `the render of ${spec.backend}`, deps.kinds ?? STACK_KINDS);
  return { objects, fingerprint: fingerprint(objects), needs: backendNeeds(spec, values, ctx) };
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

/** What a prune may never delete: a CRD (deleting one deletes every custom resource of its kind,
 *  cluster-wide), a Namespace (the main chart owns them, and the controller's rights live in them),
 *  anything outside this backend's kinds and namespace, and — unless this is a purge — its data. */
function prunable(
  deps: ControllerDeps,
  backend: StackBackend,
  ref: ObjectRef,
  opts: { purge: boolean }
): boolean {
  if (isCrd(ref) || ref.kind === "Namespace") return false;
  if (!opts.purge && isRetainedData(ref)) return false;
  const bad = refViolation(ref, backendNamespace(deps.release, backend), deps.kinds ?? STACK_KINDS);
  if (bad) {
    deps.log(`not pruning ${refKey(ref)}: ${bad}`);
    return false;
  }
  return true;
}

/** Deletes what the set no longer renders — only objects carrying THIS backend's labels, and only
 *  what `prunable` allows. */
export async function pruneRemoved(
  deps: ControllerDeps,
  backend: StackBackend,
  refs: ObjectRef[],
  opts: { purge: boolean } = { purge: false }
): Promise<ObjectRef[]> {
  const deleted: ObjectRef[] = [];
  for (const ref of refs) {
    if (!prunable(deps, backend, ref, opts)) continue;
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

/** Waits until every prunable ref is gone (or no longer ours). */
async function awaitGone(
  deps: ControllerDeps,
  backend: StackBackend,
  refs: ObjectRef[],
  opts: { purge: boolean }
): Promise<boolean> {
  return until(deps, deps.removeTimeoutMs, async () => {
    for (const ref of refs) {
      if (!prunable(deps, backend, ref, opts)) continue;
      const live = await deps.kube.get(ref);
      if (live && isOurs(live, backend)) return false;
    }
    return true;
  });
}

// ---- one backend --------------------------------------------------------------------------------

interface Outcome {
  report: StackBackendStatusReport;
  state: BackendState;
  /** The set a READY backend was reconciled with this tick (M29.3: what the stack-level
   *  authoring step derives the carrier, endpoints and Rollouts installs from). */
  objects?: KubeObject[];
}

type ReportFields = Partial<
  Omit<StackBackendStatusReport, "backend" | "lastGoodSha256" | "inventorySha256">
> &
  Pick<StackBackendStatusReport, "phase">;

function report(
  backend: StackBackend,
  release: string,
  digests: StateDigests | null,
  fields: ReportFields
): StackBackendStatusReport {
  return {
    backend,
    runningVersion: null,
    targetVersion: release,
    ...fields,
    lastError: fields.lastError ? fields.lastError.slice(0, 2000) : null,
    needs: (fields.needs ?? []).slice(0, 20),
    detail: (fields.detail ?? []).map((d) => d.slice(0, 500)).slice(0, 50),
    lastGoodSha256: digests?.lastGoodSha256 ?? null,
    inventorySha256: digests?.inventorySha256 ?? null
  };
}

/** Per controller, in memory: when each backend's set was last applied (for the drift resync —
 *  a restarted controller re-applies once, which is exactly when drift is likeliest), and the
 *  digests of the state it last wrote or verified (what a report hands scpd). */
interface Memory {
  appliedAt: Map<StackBackend, number>;
  digests: Map<StackBackend, StateDigests>;
}
const memoryByController = new WeakMap<ControllerDeps, Memory>();
function memory(deps: ControllerDeps): Memory {
  let m = memoryByController.get(deps);
  if (!m) memoryByController.set(deps, (m = { appliedAt: new Map(), digests: new Map() }));
  return m;
}

/** Does the loaded state match what scpd recorded from this controller's own last report?
 *  Nothing recorded (a backend never reported with digests) is trusted on first use. */
function verifyState(
  state: BackendState,
  expected: StackBackendIntegrity | undefined
): { inventory: boolean; lastGood: boolean; detail: string[] } {
  if (!expected || (expected.inventorySha256 === null && expected.lastGoodSha256 === null)) {
    return { inventory: true, lastGood: true, detail: [] };
  }
  const detail: string[] = [];
  const inv = inventoryDigest(state);
  const inventory = expected.inventorySha256 === null || expected.inventorySha256 === inv;
  if (!inventory) {
    detail.push(
      `stored inventory sha256 ${inv.slice(0, 12)}… does not match scpd's record ${expected.inventorySha256!.slice(0, 12)}…; it was not used — pruning follows the current render only`
    );
  }
  const claimed = state.lastGood?.sha256 ?? null;
  const lastGood = claimed === expected.lastGoodSha256;
  if (!lastGood) {
    detail.push(
      `stored last good set sha256 ${claimed?.slice(0, 12) ?? "none"}… does not match scpd's record ${expected.lastGoodSha256?.slice(0, 12) ?? "none"}…; it will not be applied`
    );
  }
  return { inventory, lastGood, detail };
}

export async function reconcileBackend(
  deps: ControllerDeps,
  spec: StackBackendSpec,
  settings: StackSettings,
  expected: StackBackendIntegrity | undefined,
  progress: (r: StackBackendStatusReport) => Promise<void>,
  recordedWiring?: StackBackendWiringSpec,
  stackWide: StackWide = { authoring: false }
): Promise<Outcome> {
  const { backend } = spec;
  const release = deps.release.version;
  const namespace = backendNamespace(deps.release, backend);
  const mem = memory(deps);
  const loaded = await deps.store.load(backend);
  const trust = verifyState(loaded, expected);

  // What a report hands scpd: the digests of state this controller wrote or verified — never of
  // state that failed verification, so a rewritten Secret cannot become scpd's new record.
  let digests: StateDigests | null =
    trust.inventory && trust.lastGood
      ? stateDigests(loaded)
      : (mem.digests.get(backend) ??
        (expected?.inventorySha256
          ? { lastGoodSha256: expected.lastGoodSha256, inventorySha256: expected.inventorySha256 }
          : null));
  if (digests) mem.digests.set(backend, digests);
  const save = async (s: BackendState): Promise<void> => {
    await deps.store.save(backend, s);
    digests = stateDigests(s);
    mem.digests.set(backend, digests);
  };
  const integrityNeed: StackNeed[] =
    trust.detail.length > 0
      ? [
          {
            code: "state-integrity",
            message:
              `The controller's stored state for ${backend} does not match scpd's record of it, so it was not used: ${trust.detail.join("; ")}`.slice(
                0,
                500
              )
          }
        ]
      : [];
  const rep = (fields: ReportFields) =>
    report(backend, release, digests, {
      ...fields,
      needs: [...integrityNeed, ...(fields.needs ?? [])]
    });

  // The refs the controller may act on. A tampered inventory is replaced by what the current
  // render contains (the render is built from the image; nothing outside it decides it).
  let renderRefs: ObjectRef[] | undefined;
  const trustedInventory = async (): Promise<ObjectRef[]> => {
    if (trust.inventory) return loaded.inventory;
    renderRefs ??= (await renderBackend(deps, { ...spec, enabled: true }, stackWide)).objects.map(
      refOf
    );
    return renderRefs;
  };
  const trustedRetained = async (): Promise<ObjectRef[]> =>
    trust.inventory ? loaded.retained : (await trustedInventory()).filter(isRetainedData);
  // A last good record scpd does not recognise is dropped, never applied: the backend proceeds as
  // if it had nothing to fall back to, and the next healthy set becomes the last good one.
  const state: BackendState = {
    ...loaded,
    inventory: await trustedInventory(),
    retained: await trustedRetained(),
    lastGood: trust.lastGood ? loaded.lastGood : null
  };

  if (!spec.enabled) {
    const removing = () =>
      progress(rep({ phase: "removing", runningVersion: state.lastGood?.release ?? null }));
    return disable(deps, spec, state, { save, rep, removing }, mem, recordedWiring);
  }

  // A purge requested while disabled and overtaken by an enable is spent, not deferred: it must
  // not fire on some later disable.
  if (spec.purgeGeneration > state.purgedGeneration) {
    state.purgedGeneration = spec.purgeGeneration;
    await save(state);
  }

  if (backend === "argo-workflows") await ensureArgoServerTls(deps);
  const desired = await renderBackend(deps, spec, stackWide);
  const lastGood = state.lastGood;
  const now = (deps.now ?? (() => new Date()))();

  // STEADY: the healthy set is what is desired. Re-apply on the resync cadence to undo drift.
  if (lastGood && lastGood.fingerprint === desired.fingerprint) {
    const appliedAtMs = mem.appliedAt.get(backend);
    if (appliedAtMs === undefined || now.getTime() - appliedAtMs >= deps.resyncMs) {
      await applyManifestSet(deps, desired.objects);
      mem.appliedAt.set(backend, now.getTime());
    }
    const health = await checkReadiness(deps.kube, desired.objects);
    const wired =
      health.ready && deps.afterReady
        ? await deps.afterReady(backend, desired.objects, { spec, recorded: recordedWiring })
        : [];
    return {
      report: rep({
        phase: health.ready ? "ready" : "degraded",
        runningVersion: lastGood.release,
        needs: [...desired.needs, ...wired],
        detail: health.detail,
        ...(health.ready ? {} : { lastError: "a workload that was healthy is not available" })
      }),
      state,
      ...(health.ready ? { objects: desired.objects } : {})
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
      report: rep({
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
        report: rep({
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
        report: rep({ phase: "failed", lastError: failed.error, detail: health.detail }),
        state
      };
    }
    return promote(deps, spec, settings, state, desired, health, save, rep, recordedWiring);
  }

  // ATTEMPT.
  await progress(
    rep({
      phase: lastGood ? "upgrading" : "installing",
      runningVersion: lastGood?.release ?? null,
      needs: desired.needs
    })
  );
  const withInventory: BackendState = {
    ...state,
    inventory: unionRefs(state.inventory, desired.objects.map(refOf))
  };
  await save(withInventory); // a crash from here on still knows what exists
  let health: Readiness;
  let applyError: string | null = null;
  try {
    await applyManifestSet(deps, desired.objects);
    mem.appliedAt.set(backend, now.getTime());
    health = await waitReady(deps, desired.objects);
  } catch (err) {
    applyError = err instanceof Error ? err.message : String(err);
    health = { ready: false, detail: [applyError] };
  }
  if (health.ready) {
    return promote(deps, spec, settings, withInventory, desired, health, save, rep, recordedWiring);
  }

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
    await save(next);
    deps.log(`${backend}: install failed: ${error}`);
    return {
      report: rep({ phase: "failed", lastError: error, detail: health.detail }),
      state: next
    };
  }

  // FALL BACK to the last good set — only once it has proved to be the set this controller stored
  // (review S1): the bytes read back hash to what the state and scpd both recorded, and every
  // object is one this backend may contain. It is re-stamped, so what is applied carries this
  // backend's labels whatever the stored copy says.
  let good: KubeObject[];
  try {
    const stored = await deps.store.loadLastGood(backend, lastGood.chunks);
    if (stored.sha256 !== lastGood.sha256) {
      throw new Error(
        `the stored last good set's bytes hash to ${stored.sha256.slice(0, 12)}…, not the ${lastGood.sha256?.slice(0, 12) ?? "(unrecorded)"}… that was stored`
      );
    }
    assertStackSet(
      stored.objects,
      namespace,
      "the stored last good set",
      deps.kinds ?? STACK_KINDS
    );
    good = stamp(stored.objects, backend, lastGood.release);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    const next: BackendState = { ...withInventory, failed: attempt };
    await save(next);
    deps.log(`${backend}: ${error} — NOT falling back: ${why}`);
    return {
      report: rep({
        phase: "failed",
        runningVersion: null,
        lastError: `${error}; the last good set was not restored because it failed its integrity check: ${why}`,
        detail: health.detail
      }),
      state: next
    };
  }
  deps.log(`${backend}: ${error} — restoring the last good set (${lastGood.release})`);
  await applyManifestSet(deps, good);
  const goodRefs = good.map(refOf);
  const onlyFailed = removedRefs(withInventory.inventory, goodRefs);
  await pruneRemoved(deps, backend, onlyFailed);
  mem.appliedAt.set(backend, now.getTime());
  const restored = await waitReady(deps, good);
  const next: BackendState = {
    ...state,
    inventory: goodRefs,
    retained: unionRefs(state.retained, onlyFailed.filter(isRetainedData)),
    failed: attempt
  };
  await save(next);
  return {
    report: rep({
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

/** A disabled backend: its workloads removed, its data kept; a purge request deletes the data. */
async function disable(
  deps: ControllerDeps,
  spec: StackBackendSpec,
  state: BackendState,
  io: {
    save: (s: BackendState) => Promise<void>;
    rep: (fields: ReportFields) => StackBackendStatusReport;
    removing: () => Promise<void>;
  },
  mem: Memory,
  recordedWiring?: StackBackendWiringSpec
): Promise<Outcome> {
  const { backend } = spec;
  const { save, rep } = io;
  let current = state;
  const removing = current.inventory.length > 0 || current.lastGood !== null;
  const wasWired = Boolean(recordedWiring?.factsSha256);
  // M29.2: UNWIRE FIRST — scpd stops routing to it (and forgets its token), the egress closes —
  // then the workloads go. A failure is logged and retried next tick (scpd still reports the
  // wiring), never a reason to leave a disabled backend running.
  if ((removing || wasWired) && deps.unwire) {
    try {
      await deps.unwire(backend, { wasWired });
    } catch (err) {
      deps.log(
        `${backend}: unwiring failed (retried next tick): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  if (removing) {
    await io.removing();
    // Not a purge, so `prunable` keeps the data: only the workloads and config go.
    await pruneRemoved(deps, backend, current.inventory);
    if (!(await awaitGone(deps, backend, current.inventory, { purge: false }))) {
      return {
        report: rep({
          phase: "removing",
          lastError: `not every object was gone within ${deps.removeTimeoutMs / 1000}s; retrying`
        }),
        state: current
      };
    }
    // (An untrusted last good record was dropped at load; its chunks are left for the next promote
    // to overwrite, since it says nothing reliable about how many there are.)
    if (current.lastGood) {
      await deps.store.dropLastGood(backend, current.lastGood.chunks);
    }
    current = {
      ...structuredClone(EMPTY_STATE),
      retained: unionRefs(current.retained, current.inventory.filter(isRetainedData)),
      purgedGeneration: current.purgedGeneration
    };
    await save(current);
    mem.appliedAt.delete(backend);
    deps.log(`${backend}: removed; ${current.retained.length} data object(s) kept until a purge`);
  }

  if (spec.purgeGeneration > current.purgedGeneration) {
    if (current.retained.length > 0) {
      await io.removing();
      await pruneRemoved(deps, backend, current.retained, { purge: true });
      if (!(await awaitGone(deps, backend, current.retained, { purge: true }))) {
        return {
          report: rep({
            phase: "removing",
            lastError: `the purged data was not gone within ${deps.removeTimeoutMs / 1000}s; retrying`
          }),
          state: current
        };
      }
      deps.log(`${backend}: purged ${current.retained.length} data object(s)`);
    }
    current = { ...structuredClone(EMPTY_STATE), purgedGeneration: spec.purgeGeneration };
    await save(current);
  }

  return {
    report: rep({
      phase: "disabled",
      needs:
        current.retained.length > 0
          ? [
              {
                code: "data-retained",
                message: `Disabled. Its data (${current.retained
                  .map((r) => `${r.kind} ${r.name}`)
                  .join(", ")
                  .slice(
                    0,
                    300
                  )}) is kept, so enabling it again resumes where it was; purge it to delete the data for good.`
              }
            ]
          : []
    }),
    state: current
  };
}

/** A healthy set becomes the last good one; what it no longer renders is pruned — except data,
 *  which is kept as retained until a purge. */
async function promote(
  deps: ControllerDeps,
  spec: StackBackendSpec,
  settings: StackSettings,
  state: BackendState,
  desired: DesiredSet,
  health: Readiness,
  save: (s: BackendState) => Promise<void>,
  rep: (fields: ReportFields) => StackBackendStatusReport,
  recordedWiring?: StackBackendWiringSpec
): Promise<Outcome> {
  const { backend } = spec;
  const release = deps.release.version;
  const stored = await deps.store.saveLastGood(
    backend,
    desired.objects,
    state.lastGood?.chunks ?? 0
  );
  const refs = desired.objects.map(refOf);
  const removed = removedRefs(state.inventory, refs);
  const next: BackendState = {
    inventory: refs,
    // Data the set renders again is inventory again; data it no longer renders stays retained.
    retained: removedRefs(unionRefs(state.retained, removed.filter(isRetainedData)), refs),
    lastGood: {
      release,
      fingerprint: desired.fingerprint,
      upgradeGeneration: settings.upgradeGeneration,
      appliedAt: (deps.now ?? (() => new Date()))().toISOString(),
      chunks: stored.chunks,
      sha256: stored.sha256
    },
    failed: null,
    purgedGeneration: Math.max(state.purgedGeneration, spec.purgeGeneration)
  };
  // Saved BEFORE pruning: a crash mid-prune leaves the old objects listed nowhere, and the label
  // check is what keeps a later prune from ever touching anything that is not this backend's.
  await save(next);
  const pruned = await pruneRemoved(deps, backend, removed);
  if (pruned.length > 0)
    deps.log(`${backend}: pruned ${pruned.length} objects the set no longer renders`);
  const wired = deps.afterReady
    ? await deps.afterReady(backend, desired.objects, { spec, recorded: recordedWiring })
    : [];
  deps.log(`${backend}: ready at ${release}`);
  return {
    report: rep({
      phase: "ready",
      runningVersion: release,
      needs: [...desired.needs, ...wired],
      detail: health.detail
    }),
    state: next,
    objects: desired.objects
  };
}

// ---- the whole stack ----------------------------------------------------------------------------

/** One reconcile tick. Returns the report it last published. */
export async function reconcileStack(deps: ControllerDeps): Promise<PutStackStatusRequest> {
  const spec = await deps.api.spec();
  const specs = new Map(spec.backends.map((b) => [b.backend, b]));
  const integrity = new Map(spec.integrity.map((i) => [i.backend, i]));
  const wiring = new Map((spec.wiring ?? []).map((w) => [w.backend, w]));
  const reports = new Map<StackBackend, StackBackendStatusReport>();
  const renders = new Map<StackBackend, KubeObject[]>();
  const stackWide = stackWideOf(spec.backends);
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
      sizeTier: "small" as const,
      purgeGeneration: 0,
      rotateGeneration: 0
    };
    try {
      const outcome = await reconcileBackend(
        deps,
        backendSpec,
        spec.settings,
        integrity.get(backend),
        async (r) => {
          reports.set(backend, r);
          await publish();
        },
        wiring.get(backend),
        stackWide
      );
      reports.set(backend, outcome.report);
      if (outcome.objects) renders.set(backend, outcome.objects);
    } catch (err) {
      const message =
        err instanceof KubeError && err.status === 403
          ? `the controller's Kubernetes rights do not cover this: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      deps.log(`${backend}: reconcile failed: ${message}`);
      // The digests this controller last wrote or verified, else scpd's own record handed back:
      // a failed tick must neither erase scpd's record nor replace it with an unverified one.
      const expected = integrity.get(backend);
      const digests =
        memory(deps).digests.get(backend) ??
        (expected?.inventorySha256
          ? { lastGoodSha256: expected.lastGoodSha256, inventorySha256: expected.inventorySha256 }
          : null);
      reports.set(
        backend,
        report(backend, deps.release.version, digests, { phase: "failed", lastError: message })
      );
    }
    last = await publish();
  }
  if (deps.afterStack) {
    const needs = await deps.afterStack({ spec, reports, renders });
    const r = reports.get("argo-rollouts");
    if (r && needs.length > 0) {
      reports.set("argo-rollouts", { ...r, needs: [...r.needs, ...needs].slice(0, 20) });
      last = await publish();
    }
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
