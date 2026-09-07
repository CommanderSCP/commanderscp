import { describe, expect, it } from "vitest";
import { LAUNCHER_OWNER_ID, jobManifest, runnerRunBoundMs } from "./index.js";
import type { RunnerSpec } from "./index.js";

/** THE KUBERNETES LAUNCH GOLDEN. See docs/runner-launcher.md §310. */

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
      // The owner id cannot be a literal: it is per process. See docs/runner-launcher.md §311.
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
        // M23.5 MEDIUM-9 — derived from `runnerRunBoundMs`, not a literal, so this golden does not
        // silently drift from the function it has to match if either changes independently.
        activeDeadlineSeconds: Math.ceil(runnerRunBoundMs("kubernetes", SPEC.timeoutMs) / 1000),
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
    // The golden is an equality, so it already forbids it. See docs/runner-launcher.md §312.
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

  // THE DEPLOYMENT'S POD CONVENTIONS. See docs/runner-launcher.md §313.
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

  // Arguments and values are escaped for variable expansion. See docs/runner-launcher.md §314.

  it("A LITERAL `$` IN AN OPERAND SURVIVES THE ROUND TRIP — not a `$(VAR)` reference", () => {
    const manifest = jobManifest(
      { ...SPEC, operands: ["A[$$]B[$(NOT_DEFINED)]C[$PLAIN]"] },
      OPTS
    ) as { spec: { template: { spec: { containers: Record<string, unknown>[] } } } };
    // What the API server does to THIS escaped string: `$$$$` -> `$$`, `$$(` -> `$(` (not expanded,
    // since `$(` only opens a reference when it is not preceded by an escaped `$`), `$$P` -> `$P`.
    // The net effect is the ORIGINAL, UNESCAPED text the caller supplied.
    expect(manifest.spec.template.spec.containers[0]!["args"]).toStrictEqual([
      "A[$$$$]B[$$(NOT_DEFINED)]C[$$PLAIN]"
    ]);
  });

  it("AN OPERAND SHAPED LIKE A SECRET REFERENCE DOES NOT BECOME ONE", () => {
    // Before the fix this operand, combined with a `secretEnv` key of the same name, put the
    // credential's VALUE in `args` on a real cluster (see the module comment on
    // `escapeKubernetesVarExpansion`). The golden proves only the SHAPE — that the string reaching
    // Kubernetes is not a bare `$(...)` — since the manifest never carries the secret's value at all.
    const manifest = jobManifest(
      { ...SPEC, operands: ["$(MY_CREDENTIAL)"], secretEnv: ["MY_CREDENTIAL=never-in-a-manifest"] },
      OPTS
    ) as { spec: { template: { spec: { containers: Record<string, unknown>[] } } } };
    expect(manifest.spec.template.spec.containers[0]!["args"]).toStrictEqual(["$$(MY_CREDENTIAL)"]);
  });

  it("`env[].value` IS ESCAPED THE SAME WAY — `env[].name` IS NOT", () => {
    const manifest = jobManifest({ ...SPEC, env: ["PLAIN=a$(VAR)b"] }, OPTS) as {
      spec: { template: { spec: { containers: Record<string, unknown>[] } } };
    };
    expect(manifest.spec.template.spec.containers[0]!["env"]).toStrictEqual([
      { name: "PLAIN", value: "a$$(VAR)b" }
    ]);
  });

  // MEDIUM-9 — `activeDeadlineSeconds`. See docs/runner-launcher.md §315.

  it("IS DERIVED FROM `spec.timeoutMs` VIA `runnerRunBoundMs`, NOT A FLAT CONSTANT", () => {
    const short = jobManifest({ ...SPEC, timeoutMs: 30_000 }, OPTS) as {
      spec: { activeDeadlineSeconds: number };
    };
    const long = jobManifest({ ...SPEC, timeoutMs: 3_600_000 }, OPTS) as {
      spec: { activeDeadlineSeconds: number };
    };
    // A managed-iac run against a large estate must not be truncated by a deadline sized for a
    // 30-second managed-scan step — proving this tracks the SPEC rather than a shared literal.
    expect(long.spec.activeDeadlineSeconds).toBeGreaterThan(short.spec.activeDeadlineSeconds);
    expect(short.spec.activeDeadlineSeconds).toBe(
      Math.ceil(runnerRunBoundMs("kubernetes", 30_000) / 1000)
    );
    expect(long.spec.activeDeadlineSeconds).toBe(
      Math.ceil(runnerRunBoundMs("kubernetes", 3_600_000) / 1000)
    );
  });

  it("IS STRICTLY GREATER THAN THE LAUNCHER'S OWN WHOLE-RUN BUDGET IN SECONDS — a backstop, not a race", () => {
    // If the Job's own deadline could expire BEFORE the launcher's graceful teardown finishes, the
    // controller's SIGTERM would race `run()`'s own abandon-and-teardown path on every ordinary run
    // — turning a backstop for a dead process into a second, earlier kill for a live one.
    const manifest = jobManifest(SPEC, OPTS) as { spec: { activeDeadlineSeconds: number } };
    expect(manifest.spec.activeDeadlineSeconds).toBeGreaterThan(Math.floor(SPEC.timeoutMs / 1000));
  });
});
