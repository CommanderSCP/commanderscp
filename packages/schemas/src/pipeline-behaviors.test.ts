import { describe, expect, it } from "vitest";
import {
  AlarmStateEvidenceSchema,
  CapturedWorkflowRefSchema,
  HookFreshnessContextSchema,
  ManifestContinuousHookSchema,
  ManifestPipelineHookSchema,
  PipelineEvidenceSubjectSchema,
  SubmitPipelineEvidenceRequestSchema,
  WorkflowRefSchema
} from "./pipeline-behaviors.js";
// `Sha256DigestSchema` is D23's form and is EXERCISED here, but it is DEFINED in `supply-chain.ts`
// — see that file's note: `executors.ts` needs it too, and defining it beside its specification
// would make `pipeline-behaviors -> executors -> pipeline-behaviors` a module cycle.
import { Sha256DigestSchema } from "./supply-chain.js";
import { DesiredStateManifestSchema } from "./iac.js";

/**
 * `packages/schemas/src/pipeline-behaviors.ts` — the pipeline BEHAVIOUR contract (D11/D12/D13/D21/
 * D23/D25). Every `it()` below proves a PROPERTY the file's own doc comments state, not a mechanic —
 * see the header of that file for the reasoning each test is pinning.
 */

const COMPONENT_URN = "urn:scp:org1:component:api";
const TARGET_URN = "urn:scp:org1:deployment-target:prod-cluster";
const DIGEST = `sha256:${"a".repeat(64)}`;
const COMMIT_SHA = "a".repeat(40);

const workflowRef = () => ({
  repo: "acme/api",
  branch: "main",
  path: "workflows/tests.yaml"
});

describe("PipelineEvidenceSubjectSchema — evidence must be bound to bytes or a commit", () => {
  it("REJECTS evidence with NEITHER artifactDigest NOR commitSha — unbound evidence is not evidence", () => {
    const result = PipelineEvidenceSubjectSchema.safeParse({
      componentUrn: COMPONENT_URN,
      targetUrn: TARGET_URN
    });
    expect(result.success).toBe(false);
  });

  it("ACCEPTS artifactDigest alone", () => {
    const result = PipelineEvidenceSubjectSchema.safeParse({
      componentUrn: COMPONENT_URN,
      targetUrn: TARGET_URN,
      artifactDigest: DIGEST
    });
    expect(result.success).toBe(true);
  });

  it("ACCEPTS commitSha alone", () => {
    const result = PipelineEvidenceSubjectSchema.safeParse({
      componentUrn: COMPONENT_URN,
      targetUrn: TARGET_URN,
      commitSha: COMMIT_SHA
    });
    expect(result.success).toBe(true);
  });
});

describe("SubmitPipelineEvidenceRequestSchema — provenance is stamped server-side, never accepted from the caller", () => {
  it("REFUSES an extra top-level key — specifically `producer`, the forgeable self-attestation this shape deliberately excludes", () => {
    const result = SubmitPipelineEvidenceRequestSchema.safeParse({
      subject: {
        componentUrn: COMPONENT_URN,
        targetUrn: TARGET_URN,
        artifactDigest: DIGEST
      },
      evidence: {
        kind: "alarmState",
        hookId: "bake-1",
        windowStart: "2026-08-26T00:00:00.000Z",
        windowEnd: "2026-08-26T01:00:00.000Z",
        alarms: []
      },
      // The forgeable field: a caller claiming who reported this. A silent strip here would be the
      // bug — the request must be REFUSED outright, not accepted-with-the-field-dropped.
      producer: "ci-bot"
    });
    expect(result.success).toBe(false);
  });
});

describe("ManifestContinuousHookSchema — maxAgeSeconds is required, because stale-green must read as absent", () => {
  it("REJECTS a hook with no maxAgeSeconds", () => {
    const result = ManifestContinuousHookSchema.safeParse({
      kind: "continuous",
      componentUrn: COMPONENT_URN,
      hookId: "canary-probe",
      workflow: workflowRef(),
      everySeconds: 60
      // maxAgeSeconds omitted
    });
    expect(result.success).toBe(false);
  });

  it("ACCEPTS a hook that carries maxAgeSeconds", () => {
    const result = ManifestContinuousHookSchema.safeParse({
      kind: "continuous",
      componentUrn: COMPONENT_URN,
      hookId: "canary-probe",
      workflow: workflowRef(),
      everySeconds: 60,
      maxAgeSeconds: 300
    });
    expect(result.success).toBe(true);
  });
});

describe("AlarmStateEvidenceSchema — a quiet claim must name the window it covers", () => {
  it("ACCEPTS an empty alarms array together with a window — an empty array is a POSITIVE assertion of quiet", () => {
    const result = AlarmStateEvidenceSchema.safeParse({
      kind: "alarmState",
      hookId: "bake-1",
      windowStart: "2026-08-26T00:00:00.000Z",
      windowEnd: "2026-08-26T01:00:00.000Z",
      alarms: []
    });
    expect(result.success).toBe(true);
  });

  it("REJECTS a payload missing windowStart/windowEnd — a quiet claim with no window covers nothing", () => {
    const missingBoth = AlarmStateEvidenceSchema.safeParse({
      kind: "alarmState",
      hookId: "bake-1",
      alarms: []
    });
    expect(missingBoth.success).toBe(false);

    const missingWindowStart = AlarmStateEvidenceSchema.safeParse({
      kind: "alarmState",
      hookId: "bake-1",
      windowEnd: "2026-08-26T01:00:00.000Z",
      alarms: []
    });
    expect(missingWindowStart.success).toBe(false);

    const missingWindowEnd = AlarmStateEvidenceSchema.safeParse({
      kind: "alarmState",
      hookId: "bake-1",
      windowStart: "2026-08-26T00:00:00.000Z",
      alarms: []
    });
    expect(missingWindowEnd.success).toBe(false);
  });
});

describe("Sha256DigestSchema — the ONE canonical form", () => {
  it("accepts sha256:<64 lowercase hex>", () => {
    expect(Sha256DigestSchema.safeParse(DIGEST).success).toBe(true);
  });

  it("rejects bare hex with no prefix", () => {
    expect(Sha256DigestSchema.safeParse("a".repeat(64)).success).toBe(false);
  });

  it("rejects uppercase hex", () => {
    expect(Sha256DigestSchema.safeParse(`sha256:${"A".repeat(64)}`).success).toBe(false);
  });

  it("rejects a repo@sha256:... compound ref", () => {
    expect(Sha256DigestSchema.safeParse(`ghcr.io/acme/api@sha256:${"a".repeat(64)}`).success).toBe(
      false
    );
  });

  it("rejects a wrong-length hex", () => {
    expect(Sha256DigestSchema.safeParse(`sha256:${"a".repeat(63)}`).success).toBe(false);
    expect(Sha256DigestSchema.safeParse(`sha256:${"a".repeat(65)}`).success).toBe(false);
  });
});

describe("CapturedWorkflowRefSchema — never a bare template name", () => {
  it("requires commitSha and bundle — a bare WorkflowRef does NOT satisfy it", () => {
    const bareRef = workflowRef();
    // The bare form parses fine on its own schema...
    expect(WorkflowRefSchema.safeParse(bareRef).success).toBe(true);
    // ...but is NOT a CapturedWorkflowRef: the run must be pinned to a built commit and a bundle.
    expect(CapturedWorkflowRefSchema.safeParse(bareRef).success).toBe(false);
  });

  it("accepts a captured ref carrying commitSha and bundle", () => {
    const result = CapturedWorkflowRefSchema.safeParse({
      ...workflowRef(),
      commitSha: COMMIT_SHA,
      bundle: { repository: "tests/api", digest: DIGEST }
    });
    expect(result.success).toBe(true);
  });
});

describe("ManifestPipelineHookSchema — discriminates on kind", () => {
  it("a postDeploy with a stage parses", () => {
    const result = ManifestPipelineHookSchema.safeParse({
      kind: "postDeploy",
      componentUrn: COMPONENT_URN,
      hookId: "integration-suite",
      workflow: workflowRef(),
      stage: "staging"
    });
    expect(result.success).toBe(true);
  });

  it("an unknown kind is refused", () => {
    const result = ManifestPipelineHookSchema.safeParse({
      kind: "preFlight",
      componentUrn: COMPONENT_URN,
      hookId: "unknown-hook",
      workflow: workflowRef()
    });
    expect(result.success).toBe(false);
  });
});

describe("HookFreshnessContextSchema — the never-reported case is a first-class value, not an omission", () => {
  it("accepts latestEvidence: null together with staleAfter: null", () => {
    const result = HookFreshnessContextSchema.safeParse({
      hook: "continuous",
      hookId: "canary-probe",
      maxAgeSeconds: 300,
      latestEvidence: null,
      staleAfter: null
    });
    expect(result.success).toBe(true);
  });

  it("accepts a populated pair", () => {
    const result = HookFreshnessContextSchema.safeParse({
      hook: "continuous",
      hookId: "canary-probe",
      maxAgeSeconds: 300,
      latestEvidence: {
        evidenceId: "0198f2a0-0000-7000-8000-000000000001",
        outcome: "passed",
        completedAt: "2026-08-26T00:00:00.000Z",
        artifactDigest: DIGEST,
        commitSha: null
      },
      staleAfter: "2026-08-26T00:05:00.000Z"
    });
    expect(result.success).toBe(true);
  });
});

describe("DesiredStateManifestSchema — the three new collections are additive", () => {
  it("still parses a manifest with NONE of pipelineHooks/rollouts/convergence present", () => {
    const result = DesiredStateManifestSchema.safeParse({
      stackName: "team-api",
      objects: [],
      relationships: []
    });
    expect(result.success).toBe(true);
  });

  it("parses a manifest carrying all three collections", () => {
    const result = DesiredStateManifestSchema.safeParse({
      stackName: "team-api",
      objects: [],
      relationships: [],
      pipelineHooks: [
        {
          kind: "postMerge",
          componentUrn: COMPONENT_URN,
          hookId: "unit-suite",
          workflow: workflowRef()
        }
      ],
      rollouts: [
        {
          componentUrn: COMPONENT_URN,
          targetClass: "cluster",
          rollout: {
            strategy: "canary",
            steps: [{ weightPercent: 25 }, { weightPercent: 100 }]
          }
        }
      ],
      convergence: [
        {
          componentUrn: COMPONENT_URN,
          targetUrn: TARGET_URN,
          converge: true,
          scope: "changedSubset"
        }
      ]
    });
    expect(result.success).toBe(true);
  });
});
