import { ScpClient } from "@scp/sdk";
import { StackBackendSchema } from "@scp/schemas";
import { resolveHelm, type HelmRenderer } from "./helm.js";
import { KubeClient, type KubeTransport } from "./kube.js";
import { parseManifests } from "./manifests.js";
import { backendNamespace, loadRelease, type StackRelease } from "./release.js";
import type { ControllerDeps, StackApi } from "./reconcile.js";
import { StateStore } from "./state.js";
import { deriveBackendValues } from "./values.js";

/**
 * Assembling a controller from its configuration. The ONLY API client it builds is below, and it
 * uses exactly two operations — the spec read and the status write — with the install-time
 * operator credential and no session: `stack-controller-inputs.test.ts` holds the controller's
 * sources to that.
 */

export function stackApiFor(baseUrl: string, operatorCredential: string): StackApi {
  const client = new ScpClient({ baseUrl });
  return {
    spec: () => client.stack.spec(operatorCredential),
    putStatus: (req) => client.stack.putStatus(req, operatorCredential)
  };
}

export interface ControllerConfig {
  apiUrl: string;
  operatorCredential: string;
  scpNamespace: string;
  release: string;
  chartDir: string;
  helmPinFile: string;
  helmBinary?: string;
  imageOverridesFile?: string;
  federationRole: "commander" | "outpost" | "retrans";
  intervalMs: number;
  readyTimeoutMs: number;
  resyncMs: number;
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
    release: need("SCP_STACKD_RELEASE"),
    chartDir: env.SCP_STACKD_CHART_DIR || "/opt/scp/stack/helm-bundled",
    helmPinFile: env.SCP_STACKD_HELM_PIN || "/opt/scp/stack/helm.pin.env",
    ...(env.SCP_STACKD_HELM_BIN ? { helmBinary: env.SCP_STACKD_HELM_BIN } : {}),
    imageOverridesFile: env.SCP_STACKD_IMAGE_OVERRIDES_FILE || "/etc/scp-stackd/images.json",
    federationRole: role,
    intervalMs: num(env, "SCP_STACKD_INTERVAL_SECONDS", 30) * 1000,
    readyTimeoutMs: num(env, "SCP_STACKD_READY_TIMEOUT_SECONDS", 600) * 1000,
    resyncMs: num(env, "SCP_STACKD_RESYNC_SECONDS", 600) * 1000
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
  return {
    api: stackApiFor(config.apiUrl, config.operatorCredential),
    kube,
    helm,
    release,
    store: new StateStore(kube, (b) => backendNamespace(release, b)),
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
      { backend, enabled: true, sizeTier: "small" },
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
    const crds = objects.filter((o) => o.kind === "CustomResourceDefinition").length;
    lines.push(
      `${backend}: ${objects.length} objects (${crds} CRDs) into ${backendNamespace(release, backend)}`
    );
  }
  return lines;
}
