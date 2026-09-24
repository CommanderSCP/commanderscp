import { describe, expect, it } from "vitest";
import type { TriggerIntent } from "@scp/plugin-api";
import {
  assertInfraTemplateSchedule,
  assertInfraTemplateTrigger,
  authorizeInfraLaneIntent,
  InfraTemplateOutsideLane
} from "./infra-template-guard.js";

/** M28.3 (ADR-0056 §5) — the plugin host's one door for the shipped infra templates. */
describe("infra-template-guard", () => {
  const intent = (targetRef: string): TriggerIntent => ({ kind: "workflow_dispatch", targetRef });

  it("refuses either shipped infra template when the lane did not build the intent", () => {
    for (const ref of ["scp-infra-plan-v1", "scp-infra-apply-v1", "scp-infra-apply-v12"]) {
      expect(() => assertInfraTemplateTrigger(intent(ref))).toThrow(InfraTemplateOutsideLane);
    }
  });

  it("lets the lane's OWN intent object through — and only that object", () => {
    const own = authorizeInfraLaneIntent(intent("scp-infra-apply-v1"));
    expect(() => assertInfraTemplateTrigger(own)).not.toThrow();
    // A structurally identical copy carries no authority: nothing in data can forge it.
    expect(() => assertInfraTemplateTrigger({ ...own })).toThrow(InfraTemplateOutsideLane);
  });

  it("leaves every other template alone (an org's own templates, the build catalog)", () => {
    for (const ref of [
      "scp-build-image-v1",
      "acme-net-plan",
      "scp-infra-plan",
      "my-scp-infra-apply-v1"
    ]) {
      expect(() => assertInfraTemplateTrigger(intent(ref))).not.toThrow();
    }
    expect(() => assertInfraTemplateTrigger({ kind: "sync" })).not.toThrow();
  });

  it("refuses a managed-iac APPLY (a parameter, not a template name) unless the lane built the intent", () => {
    const apply = (): TriggerIntent => ({
      kind: "sync",
      targetRef: "any-workspace",
      parameters: { iacAction: "apply", planDigest: "a".repeat(64) }
    });
    expect(() => assertInfraTemplateTrigger(apply())).toThrow(InfraTemplateOutsideLane);
    expect(() => assertInfraTemplateTrigger(authorizeInfraLaneIntent(apply()))).not.toThrow();
    // A plan is not gated here — the lane still derives it, but a plan applies nothing.
    expect(() =>
      assertInfraTemplateTrigger({ kind: "sync", parameters: { iacAction: "plan" } })
    ).not.toThrow();
  });

  it("refuses ANY schedule naming an infra template — a plan or apply on a cron is never the lane's", () => {
    expect(() =>
      assertInfraTemplateSchedule({
        scheduleId: "s",
        targetRef: "scp-infra-plan-v1",
        cadenceSeconds: 60
      })
    ).toThrow(InfraTemplateOutsideLane);
    expect(() =>
      assertInfraTemplateSchedule({ scheduleId: "s", targetRef: "smoke-tests", cadenceSeconds: 60 })
    ).not.toThrow();
  });
});
