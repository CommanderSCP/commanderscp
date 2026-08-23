import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { managedDepServerSettings, managedRunnerSettings } from "./executor-bindings-repo.js";
import { pluginCtx } from "../federation/promotion-scan-step.js";

/**
 * M23.2 — LAYER 3 OF THE THREE, AND THE HALF NO PLUGIN PACKAGE CAN SEE.
 *
 * Each plugin's own `runner-launcher-selection.test.ts` proves that a plugin CONSTRUCTED THE WAY
 * PRODUCTION CONSTRUCTS IT honours `config.runnerLauncher`. That leaves the other half open: does
 * anything in production ever PUT `runnerLauncher` in that config? A selection every plugin obeys
 * and nothing ever sets is a feature installed nowhere — the class CLAUDE.md names as this
 * repository's dominant one.
 *
 * THE PRECEDENT IS EXACT AND IT IS THIS FUNCTION. `dockerBinary` shipped injected on the binding
 * path and ABSENT on the binding-free `managed-dep` dispatch, so an operator's podman applied to two
 * managed classes out of three — and the comment describing the hole was corrected to match the
 * broken behaviour instead of the behaviour being fixed. A launcher SELECTION with the same shape
 * has a larger blast radius: the commander's own promotion scan, or the ordinary bump dispatch,
 * would stay on Docker on a Kubernetes deployment, i.e. exactly as dead as M23 exists to fix.
 */

const SAVED = new Map<string, string | undefined>();
function setEnv(key: string, value: string | undefined): void {
  if (!SAVED.has(key)) SAVED.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
afterEach(() => {
  for (const [key, value] of SAVED) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  SAVED.clear();
});

function selectKubernetes(over: Record<string, string | undefined> = {}): void {
  setEnv("SCP_MANAGED_RUNNER_LAUNCHER", "kubernetes");
  setEnv("SCP_MANAGED_RUNNER_K8S_NAMESPACE", "scp");
  setEnv("SCP_MANAGED_RUNNER_K8S_WORKSPACE_ROOT", "/scp-workspace");
  setEnv("SCP_MANAGED_RUNNER_K8S_WORKSPACE_CLAIM", "scp-runner-workspace");
  setEnv("SCP_MANAGED_RUNNER_K8S_PER_RUN_SECRETS", undefined);
  setEnv("SCP_MANAGED_RUNNER_K8S_WORKSPACE_HOST_PATH", undefined);
  setEnv("SCP_MANAGED_RUNNER_K8S_RUN_AS_NON_ROOT", undefined);
  // M23.5 — cleared here for the same reason as every line above it: the `toStrictEqual` below is
  // an EXHAUSTIVE statement of what a launch is configured with, and it can only stay one if the
  // ambient environment cannot contribute a key to it.
  setEnv("SCP_MANAGED_RUNNER_K8S_IMAGE_PULL_SECRETS", undefined);
  setEnv("SCP_MANAGED_RUNNER_K8S_IMAGE_PULL_POLICY", undefined);
  setEnv("SCP_MANAGED_RUNNER_K8S_RESOURCES", undefined);
  for (const [k, v] of Object.entries(over)) setEnv(k, v);
}

describe("M23.2: `managedRunnerSettings()` is the one place the launcher is chosen", () => {
  it("UNSET IS DOCKER, and carries no Kubernetes block at all", () => {
    setEnv("SCP_MANAGED_RUNNER_LAUNCHER", undefined);
    const settings = managedRunnerSettings();
    expect(settings.runnerLauncher).toBe("docker");
    // NOT `kubernetes: undefined` — the key is absent, so nothing about Kubernetes reaches a plugin
    // on a compose deployment even as an empty shape a future `??` could latch onto.
    expect("kubernetes" in settings).toBe(false);
  });

  it("A TYPO IS DOCKER, deliberately, and the direction of that choice is the point", () => {
    // "the deployment keeps doing what it did before" is diagnosable in one step on Kubernetes —
    // nothing works, and `scpd` ships no docker binary. The opposite default, nudging a compose
    // deployment onto Jobs it has no API server for, is not.
    setEnv("SCP_MANAGED_RUNNER_LAUNCHER", "Kubernetes");
    expect(managedRunnerSettings().runnerLauncher).toBe("docker");
    setEnv("SCP_MANAGED_RUNNER_LAUNCHER", "k8s");
    expect(managedRunnerSettings().runnerLauncher).toBe("docker");
  });

  it("SELECTED, WITH A PVC — the production shape owner decision 5 requires", () => {
    selectKubernetes();
    expect(managedRunnerSettings()).toStrictEqual({
      dockerBinary: "docker",
      runnerLauncher: "kubernetes",
      kubernetes: {
        namespace: "scp",
        workspaceRoot: "/scp-workspace",
        workspaceVolume: { kind: "persistentVolumeClaim", claimName: "scp-runner-workspace" },
        perRunSecrets: false,
        runAsNonRoot: false
      }
    });
  });

  it("THE PER-RUN SECRET CAPABILITY IS OFF UNLESS THE OPERATOR SAYS THE EXACT WORD", () => {
    selectKubernetes({ SCP_MANAGED_RUNNER_K8S_PER_RUN_SECRETS: "yes" });
    expect(managedRunnerSettings().kubernetes?.perRunSecrets).toBe(false);
    selectKubernetes({ SCP_MANAGED_RUNNER_K8S_PER_RUN_SECRETS: "true" });
    expect(managedRunnerSettings().kubernetes?.perRunSecrets).toBe(true);
  });

  it("`runAsNonRoot` IS OFF BY DEFAULT — none of the three runner images has a USER line", () => {
    selectKubernetes();
    expect(managedRunnerSettings().kubernetes?.runAsNonRoot).toBe(false);
    selectKubernetes({ SCP_MANAGED_RUNNER_K8S_RUN_AS_NON_ROOT: "true" });
    expect(managedRunnerSettings().kubernetes?.runAsNonRoot).toBe(true);
  });

  it("INCOMPLETE SETTINGS YIELD NO BLOCK, so the resolver's NAMED refusal is what an operator sees", () => {
    // A half-built Job manifest and a `TypeError` deep inside it is the alternative. Fail closed and
    // name the missing piece — the same direction every refusal in this class leans.
    selectKubernetes({ SCP_MANAGED_RUNNER_K8S_WORKSPACE_ROOT: undefined });
    expect(managedRunnerSettings().kubernetes).toBeUndefined();
    selectKubernetes({ SCP_MANAGED_RUNNER_K8S_NAMESPACE: undefined });
    expect(managedRunnerSettings().kubernetes).toBeUndefined();
    selectKubernetes({ SCP_MANAGED_RUNNER_K8S_WORKSPACE_CLAIM: undefined });
    expect(managedRunnerSettings().kubernetes).toBeUndefined();
  });

  it("THE HOST-PATH VOLUME IS THE HARNESS's, and the PVC WINS when both are set", () => {
    selectKubernetes({
      SCP_MANAGED_RUNNER_K8S_WORKSPACE_CLAIM: undefined,
      SCP_MANAGED_RUNNER_K8S_WORKSPACE_HOST_PATH: "/tmp/scp-kind-workspace"
    });
    expect(managedRunnerSettings().kubernetes?.workspaceVolume).toStrictEqual({
      kind: "hostPath",
      path: "/tmp/scp-kind-workspace"
    });
    // A deployment that has BOTH is a deployment with a real PVC and a leftover harness variable.
    // Preferring the PVC means the leftover cannot silently downgrade a production runner onto the
    // node's filesystem.
    selectKubernetes({ SCP_MANAGED_RUNNER_K8S_WORKSPACE_HOST_PATH: "/tmp/scp-kind-workspace" });
    expect(managedRunnerSettings().kubernetes?.workspaceVolume).toStrictEqual({
      kind: "persistentVolumeClaim",
      claimName: "scp-runner-workspace"
    });
  });
});

/**
 * M23.5 — THE POD CONVENTIONS EVERY OTHER POD IN THIS CHART INHERITS, AND THIS ONE DID NOT.
 *
 * `deploy/helm` creates six pods. Five are Helm templates and every one of them sets
 * `.Values.imagePullSecrets`, `.Values.image.pullPolicy` and a `resources` block. The sixth — the
 * runner Job — is built by `jobManifest()` at run time from what THIS function returns, and what it
 * returned described a namespace, a workspace and two booleans. Nothing about the pod, so nothing
 * about the pod was inherited: not just the two fields that were reported, but every convention.
 *
 * MEASURED, on a real cluster, image already loaded on the node and tagged `:latest`:
 * `spawn-failed, code=ErrImagePull — failed to pull and unpack image docker.io/library/
 * scp-probe-runner:latest`. Unset `imagePullPolicy` is `Always` for `:latest`; the identical image
 * runs fine under `docker create`. That is charter principle 5 broken in production by an omission.
 */
describe("M23.5: the deployment's pod conventions reach the runner Job", () => {
  it("ABSENT BY DEFAULT — a deployment that states none carries no `pod` key at all", () => {
    selectKubernetes();
    const k8s = managedRunnerSettings().kubernetes!;
    // NOT `pod: {}`. An empty block would reach `jobManifest` and has to be equivalent to absence
    // there too (the golden pins that), but the honest statement here is that nothing was stated.
    expect("pod" in k8s).toBe(false);
  });

  it("EACH CONVENTION ARRIVES INDEPENDENTLY, parsed into a closed shape", () => {
    selectKubernetes({
      SCP_MANAGED_RUNNER_K8S_IMAGE_PULL_SECRETS: " ghcr-creds , harbor-creds ",
      SCP_MANAGED_RUNNER_K8S_IMAGE_PULL_POLICY: "IfNotPresent",
      SCP_MANAGED_RUNNER_K8S_RESOURCES:
        '{"requests":{"cpu":"250m","memory":"512Mi"},"limits":{"memory":"4Gi"}}'
    });
    expect(managedRunnerSettings().kubernetes?.pod).toStrictEqual({
      imagePullSecrets: ["ghcr-creds", "harbor-creds"],
      imagePullPolicy: "IfNotPresent",
      resources: { requests: { cpu: "250m", memory: "512Mi" }, limits: { memory: "4Gi" } }
    });

    // ONE ALONE IS ONE ALONE. `imagePullPolicy` is the air-gap fix and the one most likely to be set
    // by itself; it must not conjure an empty `resources`, which a ResourceQuota reading `limits`
    // would then reject.
    selectKubernetes({ SCP_MANAGED_RUNNER_K8S_IMAGE_PULL_POLICY: "Never" });
    expect(managedRunnerSettings().kubernetes?.pod).toStrictEqual({ imagePullPolicy: "Never" });
  });

  it("A YAML `cpu: 1` ARRIVES AS A JSON NUMBER and is accepted — `values.yaml` quotes it, an operator will not", () => {
    // `{{ .Values....resources | toJson }}` emits `{"limits":{"cpu":1}}` for an unquoted `cpu: 1`,
    // and `values.yaml`'s own api/worker blocks write `cpu: "1"` precisely because YAML does this.
    // Refusing the unquoted form would turn a formatting slip into a dead deployment.
    selectKubernetes({ SCP_MANAGED_RUNNER_K8S_RESOURCES: '{"limits":{"cpu":2,"memory":"4Gi"}}' });
    expect(managedRunnerSettings().kubernetes?.pod?.resources).toStrictEqual({
      limits: { cpu: "2", memory: "4Gi" }
    });
  });

  it("`{}` IS NOT A STATEMENT — the chart's own default for `resources` renders nothing", () => {
    selectKubernetes({ SCP_MANAGED_RUNNER_K8S_RESOURCES: "{}" });
    expect("pod" in managedRunnerSettings().kubernetes!).toBe(false);
  });

  it("A MALFORMED VALUE IS REFUSED BY NAME, never dropped", () => {
    // THE DIRECTION IS THE POINT. A silently-dropped pull secret is an `ErrImagePull` minutes into a
    // promotion with nothing naming the cause — which is the exact failure this channel exists to
    // end, reintroduced by the channel itself. Every arm below names its variable and its value.
    for (const [env, bad] of [
      ["SCP_MANAGED_RUNNER_K8S_IMAGE_PULL_SECRETS", "Not_A_Secret_Name"],
      ["SCP_MANAGED_RUNNER_K8S_IMAGE_PULL_POLICY", "always"],
      ["SCP_MANAGED_RUNNER_K8S_RESOURCES", "not json"],
      ["SCP_MANAGED_RUNNER_K8S_RESOURCES", '["requests"]'],
      // The one that matters most: a key that is neither `requests` nor `limits` would otherwise
      // land verbatim inside the container spec.
      ["SCP_MANAGED_RUNNER_K8S_RESOURCES", '{"claims":[{"name":"gpu"}]}'],
      ["SCP_MANAGED_RUNNER_K8S_RESOURCES", '{"limits":{"mem ory":"4Gi"}}'],
      ["SCP_MANAGED_RUNNER_K8S_RESOURCES", '{"limits":{"memory":"4 gigs"}}']
    ] as [string, string][]) {
      selectKubernetes({ [env]: bad });
      expect(() => managedRunnerSettings(), `${env}=${bad} was accepted`).toThrow(env);
    }
  });

  it("A LEGITIMATE EXTENDED RESOURCE IS ACCEPTED — the validator is closed, not a two-name allowlist", () => {
    selectKubernetes({
      SCP_MANAGED_RUNNER_K8S_RESOURCES:
        '{"limits":{"nvidia.com/gpu":"1","ephemeral-storage":"20Gi"}}'
    });
    expect(managedRunnerSettings().kubernetes?.pod?.resources).toStrictEqual({
      limits: { "nvidia.com/gpu": "1", "ephemeral-storage": "20Gi" }
    });
  });
});

describe("M23.2: every production construction path carries the selection", () => {
  it("THE COMMANDER'S OWN PROMOTION SCAN — the in-process path that bypasses the plugin host", () => {
    // `federation/promotion-scan-step.ts` constructs a `managed-scan` context directly rather than
    // through a binding (BUILD_AND_TEST.md M23.1d records that bypass as STILL OPEN). It is the path
    // most likely to be forgotten, and forgetting it would leave the commander scanning on Docker
    // forever on a cluster where nothing else does.
    selectKubernetes();
    const config = pluginCtx("scp-runner-scan:vetted", "none").config as Record<string, unknown>;
    expect(config.runnerLauncher).toBe("kubernetes");
    expect(config.kubernetes).toMatchObject({ namespace: "scp", workspaceRoot: "/scp-workspace" });
  });

  it("THE ORDINARY BUMP DISPATCH — `managedDepServerSettings`, the binding-FREE path", () => {
    // This is the path `dockerBinary` was missing from for a release. Same function, same shape.
    selectKubernetes();
    const settings = managedDepServerSettings();
    expect(settings.runnerLauncher).toBe("kubernetes");
    expect(settings.kubernetes?.namespace).toBe("scp");
  });

  it("THE THREE BINDING INJECTION SITES SPREAD THE WHOLE SLICE, not one field of it", () => {
    // A SOURCE ASSERTION, and it is the honest instrument for this one: the binding paths need a
    // tenant transaction and a real object row, so driving them here would test the fixture. What
    // has to be true is structural — each managed module's server-injected block takes EVERYTHING
    // `managedRunnerSettings()` returns, so a field added to that function reaches every binding
    // without a fourth edit. The failure this prevents is the one that already happened once:
    // `serverInjected.dockerBinary = …` named ONE field, so the next field silently reached none of
    // the three.
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, "executor-bindings-repo.ts"), "utf8");
    const spreads = source.match(/Object\.assign\(serverInjected, managedRunnerSettings\(\)\);/g);
    expect(spreads, "a managed binding stopped taking the whole launcher slice").toHaveLength(3);
    // And nothing may go back to naming one field of it.
    expect(source).not.toMatch(/serverInjected\.dockerBinary\s*=/);
  });

  it("THE PLUGIN HOST SUBPROCESS CONSTRUCTS ALL THREE WITH NO RESOLVER ARGUMENT", () => {
    // This is what makes each plugin's DEFAULT PARAMETER the production wiring, and therefore what
    // makes those packages' `runner-launcher-selection.test.ts` files meaningful. Pass an explicit
    // `resolveDockerRunnerLauncher` here and every one of them would go on passing while every
    // managed run on Kubernetes shelled out to a binary the image does not ship.
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, "../plugin-host/subprocess-entry.ts"), "utf8");
    for (const factory of [
      "createManagedIacExecutorPlugin",
      "createManagedScanExecutorPlugin",
      "createManagedDepExecutorPlugin"
    ]) {
      expect(
        source,
        `${factory} is no longer constructed with the zero-argument default`
      ).toContain(`mod.${factory}()`);
    }
  });
});
