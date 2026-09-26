import { ScpClient } from "@scp/sdk";
import { StackBackendSchema } from "@scp/schemas";
import { nodeBackendHttp } from "./backend-http.js";
import { resolveHelm, type HelmRenderer } from "./helm.js";
import { KubeClient, type KubeTransport } from "./kube.js";
import { assertStackSet, parseManifests } from "./manifests.js";
import { backendNamespace, loadRelease, type StackRelease } from "./release.js";
import type { ControllerDeps, StackApi } from "./reconcile.js";
import { StateStore } from "./state.js";
import { deriveBackendValues } from "./values.js";
import { unwireBackend, wireBackend } from "./wiring.js";
import { credentialNeeds, deliverCredentials } from "./credentials.js";

/**
 * Assembling a controller from its configuration. The ONLY API client it builds is below, and it
 * uses exactly seven operations — the spec read, the status write, (M29.2) the wiring hand-off
 * and its withdrawal, and (M29.5) the sealing key, the sealed credential deliveries and their
 * confirmation — with the install-time credential and no session:
 * `controller-inputs.test.ts` holds the controller's sources to that.
 */

export function stackApiFor(baseUrl: string, operatorCredential: string): StackApi {
  const client = new ScpClient({ baseUrl });
  return {
    spec: () => client.stack.spec(operatorCredential),
    putStatus: (req) => client.stack.putStatus(req, operatorCredential),
    putWiring: (backend, req) => client.stack.putWiring(backend, req, operatorCredential),
    deleteWiring: (backend) => client.stack.deleteWiring(backend, operatorCredential),
    putSealingKey: (req) => client.stack.putSealingKey(req, operatorCredential),
    credentialDeliveries: () => client.stack.credentialDeliveries(operatorCredential),
    ackCredentialDelivery: (id, req) =>
      client.stack.ackCredentialDelivery(id, req, operatorCredential)
  };
}

export interface ControllerConfig {
  apiUrl: string;
  operatorCredential: string;
  scpNamespace: string;
  /** The controller's OWN namespace, where its state lives (review B1/S1). */
  stackdNamespace: string;
  release: string;
  chartDir: string;
  helmPinFile: string;
  helmBinary?: string;
  imageOverridesFile?: string;
  federationRole: "commander" | "outpost" | "retrans";
  intervalMs: number;
  readyTimeoutMs: number;
  resyncMs: number;
  /** M29.2: the labels that select scpd's api and worker pods — the chart's own selector labels,
   *  the subject of the egress NetworkPolicy the controller opens for each wired backend. */
  scpPodLabels: Record<string, string>;
}

/** `SCP_STACKD_SCP_POD_LABELS`: a JSON object of label → value, each a valid label. */
export function parsePodLabels(raw: string | undefined): Record<string, string> {
  if (raw === undefined || raw.trim() === "") return {};
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("SCP_STACKD_SCP_POD_LABELS must be a JSON object of label: value");
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (
      !/^([a-z0-9.-]{1,253}\/)?[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/.test(k) ||
      typeof v !== "string" ||
      !/^([A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?)?$/.test(v)
    ) {
      throw new Error(`SCP_STACKD_SCP_POD_LABELS: '${k}' is not a label selector entry`);
    }
    out[k] = v;
  }
  return out;
}

function num(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0)
    throw new Error(`${key} must be a positive number (got '${raw}')`);
  return n;
}

export function loadControllerConfig(env: NodeJS.ProcessEnv = process.env): ControllerConfig {
  const need = (key: string): string => {
    const v = (env[key] ?? "").trim();
    if (!v) throw new Error(`${key} is required`);
    return v;
  };
  const role = (env.SCP_FEDERATION_ROLE ?? "commander").trim() || "commander";
  if (role !== "commander" && role !== "outpost" && role !== "retrans") {
    throw new Error(`SCP_FEDERATION_ROLE must be commander|outpost|retrans (got '${role}')`);
  }
  return {
    apiUrl: need("SCP_STACKD_API_URL"),
    operatorCredential: need("SCP_STACKD_OPERATOR_CREDENTIAL"),
    scpNamespace: need("SCP_STACKD_SCP_NAMESPACE"),
    stackdNamespace: need("SCP_STACKD_NAMESPACE"),
    release: need("SCP_STACKD_RELEASE"),
    chartDir: env.SCP_STACKD_CHART_DIR || "/opt/scp/stack/helm-bundled",
    helmPinFile: env.SCP_STACKD_HELM_PIN || "/opt/scp/stack/helm.pin.env",
    ...(env.SCP_STACKD_HELM_BIN ? { helmBinary: env.SCP_STACKD_HELM_BIN } : {}),
    imageOverridesFile: env.SCP_STACKD_IMAGE_OVERRIDES_FILE || "/etc/scp-stackd/images.json",
    federationRole: role,
    intervalMs: num(env, "SCP_STACKD_INTERVAL_SECONDS", 30) * 1000,
    readyTimeoutMs: num(env, "SCP_STACKD_READY_TIMEOUT_SECONDS", 600) * 1000,
    resyncMs: num(env, "SCP_STACKD_RESYNC_SECONDS", 600) * 1000,
    scpPodLabels: parsePodLabels(env.SCP_STACKD_SCP_POD_LABELS)
  };
}

export async function buildControllerDeps(
  config: ControllerConfig,
  transport: KubeTransport,
  overrides: Partial<ControllerDeps> = {}
): Promise<ControllerDeps> {
  const helm = await resolveHelm({
    pinFile: config.helmPinFile,
    ...(config.helmBinary ? { binary: config.helmBinary } : {})
  });
  const release = await loadRelease({
    chartDir: config.chartDir,
    version: config.release,
    ...(config.imageOverridesFile ? { imageOverridesFile: config.imageOverridesFile } : {})
  });
  const kube = new KubeClient(transport);
  const deps: ControllerDeps = {
    api: stackApiFor(config.apiUrl, config.operatorCredential),
    kube,
    helm,
    release,
    store: new StateStore(kube, config.stackdNamespace),
    scpNamespace: config.scpNamespace,
    federationRole: config.federationRole,
    readyTimeoutMs: config.readyTimeoutMs,
    crdTimeoutMs: 120_000,
    removeTimeoutMs: 300_000,
    pollMs: 3_000,
    resyncMs: config.resyncMs,
    log: (line) => console.log(`[scp-stackd] ${line}`),
    ...overrides
  };
  installWiringHooks(deps, { http: nodeBackendHttp(), scpPodLabels: config.scpPodLabels });
  return installCredentialHooks(deps, config.stackdNamespace);
}

/**
 * M29.5 (ADR-0063): credentials through SCP. Every tick delivers the sealed envelopes scpd holds
 * into the backends' own Secrets, and a ready backend reports what it still needs entered. A hook
 * an override already set is kept. (`credentials.test.ts` drives the installed hook and watches the
 * Secret get written — a reference to `deliverCredentials` that is never called would pass a
 * census, not that test.)
 */
export function installCredentialHooks(
  deps: ControllerDeps,
  stackdNamespace: string
): ControllerDeps {
  deps.credentials ??= {
    deliver: (recordedKeySha256) =>
      deliverCredentials(
        {
          api: deps.api,
          kube: deps.kube,
          release: deps.release,
          stackdNamespace,
          log: deps.log,
          ...(deps.now ? { now: deps.now } : {})
        },
        recordedKeySha256
      ),
    needs: (backend) => credentialNeeds(deps, backend)
  };
  return deps;
}

/**
 * M29.2 (ADR-0061): the auto-wire. Every ready backend is wired into SCP in the same reconcile;
 * every disabled one is unwired before it is removed. A hook an override already set is kept.
 * (wiring.test.ts calls the installed hooks and watches the hand-off happen — a reference to
 * `wireBackend` that is never called would pass a census, not that test.)
 */
export function installWiringHooks(
  deps: ControllerDeps,
  wiring: NonNullable<ControllerDeps["wiring"]>
): ControllerDeps {
  deps.wiring ??= wiring;
  deps.afterReady ??= (backend, objects, ctx) => wireBackend(deps, backend, objects, ctx);
  deps.unwire ??= (backend, ctx) => unwireBackend(deps, backend, ctx);
  return deps;
}

/**
 * `--self-test`: render every backend with the pinned helm from the vendored chart, offline, and
 * print what each would apply. The image's CI smoke runs this, so a controller image missing its
 * chart, its helm or a working bundle cannot publish.
 */
export async function selfTest(opts: {
  chartDir: string;
  helmPinFile: string;
  helmBinary?: string;
  release: string;
}): Promise<string[]> {
  const helm: HelmRenderer = await resolveHelm({
    pinFile: opts.helmPinFile,
    ...(opts.helmBinary ? { binary: opts.helmBinary } : {})
  });
  const release: StackRelease = await loadRelease({
    chartDir: opts.chartDir,
    version: opts.release
  });
  const lines = [`helm ${helm.version} at ${helm.binary}; release ${release.version}`];
  for (const backend of StackBackendSchema.options) {
    const values = deriveBackendValues(
      { backend, enabled: true, sizeTier: "small", purgeGeneration: 0, rotateGeneration: 0 },
      {
        release,
        scpNamespace: "scp",
        federationRole: "commander",
        ...(backend === "gitea"
          ? {
              gitea: {
                adminPassword: "self-test",
                secretKey: "self-test",
                internalToken: "self-test"
              }
            }
          : {})
      }
    );
    const objects = parseManifests(await helm.template(release.chartDir, values));
    // The same check the controller runs on every render and every read-back (manifests.ts): an
    // image whose chart renders a kind the controller would refuse cannot publish.
    assertStackSet(objects, backendNamespace(release, backend), `the render of ${backend}`);
    const crds = objects.filter((o) => o.kind === "CustomResourceDefinition").length;
    lines.push(
      `${backend}: ${objects.length} objects (${crds} CRDs) into ${backendNamespace(release, backend)}`
    );
  }
  return lines;
}
