import { describe, expect, it } from "vitest";
import { LAUNCHER_OWNER_ID, jobManifest } from "./index.js";
import type { RunnerSpec } from "./index.js";

/**
 * ================================================================================================
 * THE KUBERNETES LAUNCH GOLDEN — the whole manifest, pinned, in one `toStrictEqual`
 * ================================================================================================
 *
 * THIS FILE EXISTED AS A CLAIM BEFORE IT EXISTED AS A FILE, and that is why it is here. M23.2's
 * `jobManifest` doc says, verbatim: "`kubernetes-launch.golden.test.ts` asserts the whole object
 * with `toStrictEqual`, so a field ADDED here without a golden update is a red test rather than a
 * silent change to what every managed run does." A filterless grep for that filename across the repo
 * returned exactly ONE hit — the sentence itself. The function was exported for a gate that was
 * never written, which is the precise shape CLAUDE.md names: "treat a well-written comment naming a
 * hazard as a signal to sweep, not as evidence it was handled". M23.4 changes what a launch sends,
 * so the gate is written before the change rather than after it.
 *
 * WHY A GOLDEN AND NOT FIELD-BY-FIELD ASSERTIONS. The Docker adapter's complete statement of intent
 * is one array of strings and `launch-argv.golden.test.ts` pins it whole; the Kubernetes equivalent
 * is this object, and pinning "the fields we remembered to check" degrades into a test that cannot
 * see an ADDED one. `toStrictEqual` on the whole manifest is the only shape where a new field —
 * a `hostNetwork`, a `serviceAccountName`, a mount, an `env` entry carrying a credential — reddens
 * a test instead of shipping.
 *
 * THE SECOND OBJECT A LAUNCH PRODUCES — the per-run Secret — is NOT built by a pure function and so
 * is not pinned here. It is pinned in `kubernetes-adapter.test.ts` ("THE SECRET IS OWNED BY THE JOB"
 * and "the value travels as a Secret + envFrom"), which reaches it through the recording fake.
 */

const SPEC: RunnerSpec = {
  runId: "iac-abc123",
  labels: { "scp.executor": "scp-managed-iac", "scp.run-id": "iac-abc123" },
  image: "ghcr.io/commanderscp/scp-runner-iac:0.1.0",
  operands: ["apply"],
  networkMode: "none",
  env: ["TF_IN_AUTOMATION=1"],
  // A NON-EMPTY `secretEnv`, because it is the ONE thing that changes the container's shape
  // (`envFrom`) and the whole subject of M23.4. Its VALUES never reach this object.
  secretEnv: ["AWS_SECRET_ACCESS_KEY=never-in-a-manifest"],
  copyIn: [{ hostDir: "/host/in", containerPath: "/workspace" }],
  copyOut: {
    containerPath: "/workspace",
    hostDir: "/host/out",
    when: "always",
    onFailure: "swallow"
  },
  timeoutMs: 600_000,
  maxBuffer: 32 * 1024 * 1024
};

const OPTS = {
  namespace: "scp",
  jobName: "scp-runner-iac-abc123",
  secretName: "scp-runner-iac-abc123-env",
  reapDeadline: "2026-08-20T12:00:00.000Z",
  slots: new Map([["/workspace", "m0"]]),
  workspaceVolume: { kind: "persistentVolumeClaim", claimName: "scp-runner-rwx" } as const,
  runAsNonRoot: false,
  ttlSecondsAfterFinished: 3_600
};

describe("THE KUBERNETES LAUNCH GOLDEN", () => {
  it("PINS THE WHOLE JOB MANIFEST — every field a managed run creates on a cluster", () => {
    expect(jobManifest(SPEC, OPTS)).toStrictEqual({
      apiVersion: "batch/v1",
      kind: "Job",
      // `LAUNCHER_OWNER_ID` IS THE ONE FIELD THAT CANNOT BE A LITERAL — it is a per-PROCESS uuid, and
      // that is deliberate rather than incidental: `reap()` distinguishes "my Job" from "a dead
      // peer's Job" by it, so a stable literal would make every launcher in a replica set believe it
      // owned every other's runs. Pinned by identity to the exported constant, which still catches a
      // change to WHICH label carries it.
      metadata: {
        name: "scp-runner-iac-abc123",
        namespace: "scp",
        labels: {
          "scp.executor": "scp-managed-iac",
          "scp.run-id": "iac-abc123",
          "scp.launcher.owner": LAUNCHER_OWNER_ID,
          "scp.launcher.run-id": "iac-abc123",
          "scp.launcher.network": "none"
        },
        annotations: { "scp.launcher.deadline": "2026-08-20T12:00:00.000Z" }
      },
      spec: {
        suspend: true,
        backoffLimit: 0,
        completions: 1,
        parallelism: 1,
        ttlSecondsAfterFinished: 3_600,
        template: {
          metadata: {
            labels: {
              "scp.executor": "scp-managed-iac",
              "scp.run-id": "iac-abc123",
              "scp.launcher.owner": LAUNCHER_OWNER_ID,
              "scp.launcher.run-id": "iac-abc123",
              "scp.launcher.network": "none"
            }
          },
          spec: {
            restartPolicy: "Never",
            automountServiceAccountToken: false,
            securityContext: { seccompProfile: { type: "RuntimeDefault" } },
            containers: [
              {
                name: "runner",
                image: "ghcr.io/commanderscp/scp-runner-iac:0.1.0",
                args: ["apply"],
                env: [{ name: "TF_IN_AUTOMATION", value: "1" }],
                envFrom: [{ secretRef: { name: "scp-runner-iac-abc123-env" } }],
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: false,
                  capabilities: { drop: ["ALL"] }
                },
                volumeMounts: [
                  {
                    name: "workspace",
                    mountPath: "/workspace",
                    subPath: "scp-runner-iac-abc123/m0"
                  }
                ]
              }
            ],
            volumes: [
              {
                name: "workspace",
                persistentVolumeClaim: { claimName: "scp-runner-rwx" }
              }
            ]
          }
        }
      }
    });
  });

  it("NO CREDENTIAL VALUE IS ANYWHERE IN THE MANIFEST — the property the golden above cannot state", () => {
    // THE GOLDEN IS AN EQUALITY, so it already forbids the value — but only for THIS spec's literal.
    // This is the same claim as a PROPERTY, which is what survives someone regenerating the golden
    // from actual output: whatever the manifest becomes, the secret half of `secretEnv` is not in it.
    // (The KEY is expected to be absent too: it arrives through `envFrom`, which names only the
    // Secret, so a key appearing here would mean a fallback to `env[].value` had been reintroduced.)
    const serialised = JSON.stringify(jobManifest(SPEC, OPTS));
    expect(serialised).not.toContain("never-in-a-manifest");
    expect(serialised).not.toContain("AWS_SECRET_ACCESS_KEY");
  });

  it("WITHOUT `secretEnv` THERE IS NO `envFrom` AT ALL — an empty array would still mount nothing, and say something", () => {
    const container = (
      jobManifest({ ...SPEC, secretEnv: [] }, OPTS) as {
        spec: { template: { spec: { containers: Record<string, unknown>[] } } };
      }
    ).spec.template.spec.containers[0]!;
    expect(container).not.toHaveProperty("envFrom");
  });

  it("`runAsNonRoot: true` IS THE ONLY THING THAT ADDS IT — the reference shape's value, opted into", () => {
    const podSpec = (
      jobManifest(SPEC, { ...OPTS, runAsNonRoot: true }) as {
        spec: { template: { spec: { securityContext: Record<string, unknown> } } };
      }
    ).spec.template.spec.securityContext;
    expect(podSpec).toStrictEqual({
      runAsNonRoot: true,
      seccompProfile: { type: "RuntimeDefault" }
    });
  });

  it("A `hostPath` VOLUME IS THE OTHER SHAPE, and it is pinned too", () => {
    const volumes = (
      jobManifest(SPEC, {
        ...OPTS,
        workspaceVolume: { kind: "hostPath", path: "/var/lib/scp/runner-workspace" }
      }) as { spec: { template: { spec: { volumes: unknown[] } } } }
    ).spec.template.spec.volumes;
    expect(volumes).toStrictEqual([
      {
        name: "workspace",
        hostPath: { path: "/var/lib/scp/runner-workspace", type: "DirectoryOrCreate" }
      }
    ]);
  });

  // ==============================================================================================
  // THE DEPLOYMENT'S POD CONVENTIONS (M23.5)
  // ==============================================================================================
  //
  // THE GOLDEN ABOVE IS THE FIRST HALF OF THIS PROOF AND IT IS UNCHANGED, which is the point: a
  // deployment that states no conventions produces the SAME manifest it produced before the channel
  // existed. What follows pins the other half — what arrives when a deployment states them, and that
  // each one is emitted only when stated.
  //
  // WHAT WAS WRONG. `deploy/helm` creates six pods; five are templates that carry
  // `.Values.imagePullSecrets`, `.Values.image.pullPolicy` and a `resources` block, and the sixth is
  // this object, built at run time from settings that described a namespace, a workspace and two
  // booleans. It inherited none of them. Measured on a real cluster, image already on the node and
  // tagged `:latest`: `spawn-failed, code=ErrImagePull — failed to pull and unpack image
  // docker.io/library/scp-probe-runner:latest`, while the identical image ran fine under
  // `docker create`. An unset `imagePullPolicy` is `Always` for `:latest` — charter principle 5
  // broken in production by an omission.
  const CONVENTIONS = {
    imagePullSecrets: ["ghcr-creds", "harbor-creds"],
    imagePullPolicy: "IfNotPresent",
    resources: { requests: { cpu: "250m", memory: "512Mi" }, limits: { memory: "4Gi" } }
  } as const;

  const podSpecOf = (manifest: Record<string, unknown>): Record<string, unknown> =>
    (manifest as { spec: { template: { spec: Record<string, unknown> } } }).spec.template.spec;
  const containerOf = (manifest: Record<string, unknown>): Record<string, unknown> =>
    (podSpecOf(manifest).containers as Record<string, unknown>[])[0]!;

  it("THE DEPLOYMENT'S POD CONVENTIONS REACH THE JOB — pull secrets, pull policy and resources", () => {
    const manifest = jobManifest(SPEC, { ...OPTS, pod: CONVENTIONS });
    expect(podSpecOf(manifest).imagePullSecrets).toStrictEqual([
      { name: "ghcr-creds" },
      { name: "harbor-creds" }
    ]);
    expect(containerOf(manifest).imagePullPolicy).toBe("IfNotPresent");
    expect(containerOf(manifest).resources).toStrictEqual({
      requests: { cpu: "250m", memory: "512Mi" },
      limits: { memory: "4Gi" }
    });
  });

  it("A DEPLOYMENT THAT STATES NONE EMITS NONE — the three keys are ABSENT, never empty", () => {
    // An `imagePullSecrets: []` or a `resources: {}` in the manifest would be a different object
    // from the one every launch before M23.5 produced, and the golden above would be a lie about
    // what a docker-defaults deployment sends. `toHaveProperty` is the assertion that can tell
    // "absent" from "present and falsy"; a `toStrictEqual` on the whole object cannot say which.
    const manifest = jobManifest(SPEC, OPTS);
    expect(podSpecOf(manifest)).not.toHaveProperty("imagePullSecrets");
    expect(containerOf(manifest)).not.toHaveProperty("imagePullPolicy");
    expect(containerOf(manifest)).not.toHaveProperty("resources");
    // And the same for a block that exists but is empty — `managedRunnerPodConventions()` returns
    // `undefined` in that case, but the manifest must not depend on it having done so.
    const empty = jobManifest(SPEC, { ...OPTS, pod: {} });
    expect(podSpecOf(empty)).not.toHaveProperty("imagePullSecrets");
    expect(containerOf(empty)).not.toHaveProperty("imagePullPolicy");
    expect(containerOf(empty)).not.toHaveProperty("resources");
  });

  it("EACH CONVENTION IS INDEPENDENT — stating one does not conjure the other two", () => {
    // The shape that would pass the two tests above and still be wrong: one `if (pod)` guarding all
    // three emissions. An operator who sets only `imagePullPolicy` — the air-gap fix, and the one
    // most likely to be set alone — would then also get an empty `resources: {}` and an
    // `imagePullSecrets: []`, and a ResourceQuota reading `limits` would reject the pod.
    const policyOnly = jobManifest(SPEC, { ...OPTS, pod: { imagePullPolicy: "Never" } });
    expect(containerOf(policyOnly).imagePullPolicy).toBe("Never");
    expect(podSpecOf(policyOnly)).not.toHaveProperty("imagePullSecrets");
    expect(containerOf(policyOnly)).not.toHaveProperty("resources");

    const secretsOnly = jobManifest(SPEC, { ...OPTS, pod: { imagePullSecrets: ["only"] } });
    expect(podSpecOf(secretsOnly).imagePullSecrets).toStrictEqual([{ name: "only" }]);
    expect(containerOf(secretsOnly)).not.toHaveProperty("imagePullPolicy");

    // AN EMPTY LIST IS NOT A STATEMENT. `.Values.imagePullSecrets` is `[]` by default and the chart
    // renders no variable at all for it, but a hand-rolled deployment can hand `[]` down; it must
    // produce an ABSENT key, not `imagePullSecrets: []`.
    const emptyList = jobManifest(SPEC, { ...OPTS, pod: { imagePullSecrets: [] } });
    expect(podSpecOf(emptyList)).not.toHaveProperty("imagePullSecrets");
  });

  it("AN UNEXPRESSIBLE `networkMode` IS CARRIED AS `unexpressible`, never dropped", () => {
    const labels = (
      jobManifest({ ...SPEC, networkMode: "container:some/other-thing" }, OPTS) as {
        metadata: { labels: Record<string, string> };
      }
    ).metadata.labels;
    expect(labels["scp.launcher.network"]).toBe("unexpressible");
  });
});
