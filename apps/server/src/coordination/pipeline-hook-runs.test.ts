import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  capturedWorkflowRefOf,
  hookRunBindingCarrier,
  hookRunIdempotencyKey,
  isTerminalHookRunStatus,
  outcomeFor,
  type HookRunIdentity,
  type PipelineHookRunRow
} from "./pipeline-hook-runs.js";

/**
 * Pure decision-logic tests for the identity/status/outcome vocabulary this module owns without a
 * `TenantTx`. `claimHookRun`, `ensureHookRunTriggered`, `applyHookRunObservation` and
 * `pollNonTerminalHookRuns` are DB and executor seams and stay with
 * `pipeline-hook-runs.integration.test.ts`.
 */

describe("isTerminalHookRunStatus", () => {
  it("is terminal for succeeded, failed and aborted", () => {
    expect(isTerminalHookRunStatus("succeeded")).toBe(true);
    expect(isTerminalHookRunStatus("failed")).toBe(true);
    expect(isTerminalHookRunStatus("aborted")).toBe(true);
  });

  it("is non-terminal for pending and running", () => {
    expect(isTerminalHookRunStatus("pending")).toBe(false);
    expect(isTerminalHookRunStatus("running")).toBe(false);
  });
});

describe("hookRunIdempotencyKey — pure derivation from the identity tuple", () => {
  const identity: HookRunIdentity = {
    orgId: randomUUID(),
    changeObjectId: randomUUID(),
    hookId: "post-deploy-smoke",
    waveIndex: 1
  };

  it("is stable across two calls with an equivalent (but distinct) identity object", () => {
    expect(hookRunIdempotencyKey(identity)).toBe(hookRunIdempotencyKey({ ...identity }));
  });

  it("matches the documented shape: scp-hook- followed by 64 lowercase hex characters", () => {
    expect(hookRunIdempotencyKey(identity)).toMatch(/^scp-hook-[a-f0-9]{64}$/);
  });

  it("changes when any single identity component changes", () => {
    const base = hookRunIdempotencyKey(identity);
    expect(hookRunIdempotencyKey({ ...identity, waveIndex: 2 })).not.toBe(base);
    expect(hookRunIdempotencyKey({ ...identity, hookId: "other-hook" })).not.toBe(base);
    expect(hookRunIdempotencyKey({ ...identity, changeObjectId: randomUUID() })).not.toBe(base);
    expect(hookRunIdempotencyKey({ ...identity, orgId: randomUUID() })).not.toBe(base);
  });

  it("does not collide null waveIndex (postMerge) with waveIndex 0", () => {
    // The delimiter join renders `null` as the empty component and `0` as the string "0" — the
    // module doc's explicit "`null` and `0` MUST NOT collide" guarantee.
    const withNull = hookRunIdempotencyKey({ ...identity, waveIndex: null });
    const withZero = hookRunIdempotencyKey({ ...identity, waveIndex: 0 });
    expect(withNull).not.toBe(withZero);
  });

  it("is order-sensitive across the delimiter: shifting a character between hookId and waveIndex does not collide", () => {
    // NUL is the composite-key delimiter (CLAUDE.md) precisely because it cannot occur in any
    // component; two identities that would concatenate to the same raw string without a delimiter
    // must still key apart.
    const a = hookRunIdempotencyKey({ ...identity, hookId: "hook", waveIndex: 12 });
    const b = hookRunIdempotencyKey({ ...identity, hookId: "hook1", waveIndex: 2 });
    expect(a).not.toBe(b);
  });
});

describe("hookRunBindingCarrier — target when there is one, else the component", () => {
  it("prefers targetObjectId when present", () => {
    expect(
      hookRunBindingCarrier({ targetObjectId: "target-1", componentObjectId: "component-1" })
    ).toBe("target-1");
  });

  it("falls back to componentObjectId for a postMerge run (no target)", () => {
    expect(
      hookRunBindingCarrier({ targetObjectId: null, componentObjectId: "component-1" })
    ).toBe("component-1");
  });
});

describe("outcomeFor — the phase->outcome judgement, aborted collapsed to failed on purpose", () => {
  it("maps succeeded to passed", () => {
    expect(outcomeFor("succeeded")).toBe("passed");
  });

  it("maps failed to failed", () => {
    expect(outcomeFor("failed")).toBe("failed");
  });

  it("maps aborted to failed — a judgement, not an omission (see the module doc)", () => {
    expect(outcomeFor("aborted")).toBe("failed");
  });

  it("has no outcome for the two non-terminal phases", () => {
    expect(outcomeFor("pending")).toBeNull();
    expect(outcomeFor("running")).toBeNull();
  });
});

describe("capturedWorkflowRefOf — parsed, not cast", () => {
  const validRef = {
    repo: "org/repo",
    branch: "main",
    path: "workflows/smoke.yaml",
    commitSha: "a".repeat(40),
    bundle: {
      repository: "registry.example.com/tests/smoke",
      digest: `sha256:${"b".repeat(64)}`
    }
  };

  const run = (capturedWorkflow: unknown): PipelineHookRunRow => ({
    id: randomUUID(),
    orgId: randomUUID(),
    componentObjectId: randomUUID(),
    targetObjectId: randomUUID(),
    changeObjectId: randomUUID(),
    hookId: "post-deploy-smoke",
    kind: "postDeploy",
    waveIndex: 0,
    artifactDigest: null,
    commitSha: null,
    externalRunId: null,
    externalUrl: null,
    status: "succeeded",
    pluginInstanceId: randomUUID(),
    attempt: 1,
    startedAt: new Date(),
    lastObservedAt: null,
    capturedWorkflow,
    createdAt: new Date(),
    updatedAt: new Date()
  });

  it("returns null when capturedWorkflow is null", () => {
    expect(capturedWorkflowRefOf(run(null))).toBeNull();
  });

  it("returns null when capturedWorkflow is undefined", () => {
    expect(capturedWorkflowRefOf(run(undefined))).toBeNull();
  });

  it("returns null for a value that merely has the right keys but fails schema validation", () => {
    // commitSha is not 40-hex — a shape-valid-looking value is not a CapturedWorkflowRef.
    expect(capturedWorkflowRefOf(run({ ...validRef, commitSha: "not-a-sha" }))).toBeNull();
  });

  it("returns null for a value missing the bundle digest's canonical form", () => {
    expect(
      capturedWorkflowRefOf(
        run({ ...validRef, bundle: { ...validRef.bundle, digest: "sha256:not-hex" } })
      )
    ).toBeNull();
  });

  it("parses and returns a genuinely valid CapturedWorkflowRef", () => {
    expect(capturedWorkflowRefOf(run(validRef))).toEqual(validRef);
  });
});
