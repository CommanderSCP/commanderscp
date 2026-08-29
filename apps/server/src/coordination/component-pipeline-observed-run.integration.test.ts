import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { ScpClient } from "@scp/sdk";
import type { ComponentPipelineObservedRun, GraphObject } from "@scp/schemas";
import {
  createOrphanComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * component-journey-view.md §3 Segment 2 — the `observedRun` field of a component's pipeline,
 * through the real HTTP route. `POST /changes` stores `sourceRef` verbatim (only the two
 * server-owned keys are rejected — `routes/changes.ts`), so planting a realistic observe/webhook
 * -shaped `sourceRef` this way exercises exactly what `observed-run-facts.ts` reads off
 * `changes.source_ref` — the same seam a real webhook/poll delivery writes through
 * (`coordination/webhook-processor.ts#canonicalizeSourceRef`, `coordination/observe.ts#
 * ingestObservedEvents`).
 */
describe("component pipeline: observedRun (§3 Segment 2 — the upstream build marker)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  const uniq = (p: string) => `${p}-${uuidv7()}`;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "pipeline-observed-run");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  async function observedRunOf(
    componentId: string
  ): Promise<ComponentPipelineObservedRun | null | undefined> {
    const res = await server.app.inject({
      method: "GET",
      url: `/api/v1/components/${componentId}/pipeline`,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    expect(res.statusCode, "the pipeline route must answer").toBe(200);
    return res.json().observedRun;
  }

  async function componentWithChange(
    name: string,
    sourceKind: string,
    sourceRef: Record<string, unknown> | undefined
  ): Promise<GraphObject> {
    const component = await createOrphanComponent(server, org, uniq(name));
    await admin.changes.propose({
      name: uniq("chg"),
      targets: [component.id],
      type: "configuration",
      sourceKind,
      ...(sourceRef ? { sourceRef } : {})
    });
    return component;
  }

  it("a realistic OBSERVE-shaped sourceRef (github pollRuns) -> the response carries observedRun verbatim", async () => {
    const component = await componentWithChange("observed-github", "github", {
      repo: "acme/api",
      correlationKey: "run-30858160395",
      kind: "workflow_run",
      observedAt: "2026-08-20T12:00:00.000Z",
      _observed: true,
      raw: {
        id: 30858160395,
        status: "completed",
        conclusion: "success",
        html_url: "https://github.com/acme/api/actions/runs/30858160395",
        head_sha: "a".repeat(40),
        workflow_id: 987,
        name: "CI",
        path: ".github/workflows/ci.yml",
        repository: { full_name: "acme/api" }
      }
    });

    const observedRun = await observedRunOf(component.id);
    expect(observedRun).not.toBeNull();
    expect(observedRun).not.toBeUndefined();
    expect(observedRun!.sourceKind).toBe("github");
    expect(observedRun!.repo).toBe("acme/api");
    expect(observedRun!.runId).toBe("30858160395");
    expect(observedRun!.workflowName).toBe("CI");
    expect(observedRun!.workflowPath).toBe(".github/workflows/ci.yml");
    expect(observedRun!.url).toBe("https://github.com/acme/api/actions/runs/30858160395");
    // observedAt is the CHANGE's own created_at, not the run payload's timestamp — a live server
    // clock value, so only presence + parseability is pinned.
    expect(Number.isNaN(Date.parse(observedRun!.observedAt))).toBe(false);
  });

  it("a realistic WEBHOOK-shaped sourceRef (github workflow_run delivery) -> the response carries observedRun verbatim", async () => {
    const component = await componentWithChange("webhook-github", "github", {
      action: "completed",
      repo: "acme/checkout",
      ref: "refs/heads/main",
      commit: "b".repeat(40),
      workflow_run: {
        id: 30858160500,
        status: "completed",
        conclusion: "success",
        html_url: "https://github.com/acme/checkout/actions/runs/30858160500",
        head_sha: "b".repeat(40),
        name: "deploy",
        path: ".github/workflows/deploy.yml"
      },
      repository: { full_name: "acme/checkout" }
    });

    const observedRun = await observedRunOf(component.id);
    expect(observedRun).toEqual(
      expect.objectContaining({
        sourceKind: "github",
        repo: "acme/checkout",
        runId: "30858160500",
        workflowName: "deploy",
        workflowPath: ".github/workflows/deploy.yml",
        url: "https://github.com/acme/checkout/actions/runs/30858160500"
      })
    );
  });

  it("a change without run identity -> observedRun is null, not omitted (absent-vs-fabricated)", async () => {
    const noChange = await createOrphanComponent(server, org, uniq("no-change"));
    expect(await observedRunOf(noChange.id)).toBeNull();

    const nonRunChange = await componentWithChange("push-only", "github", {
      repo: "acme/api",
      ref: "refs/heads/main",
      commit: "c".repeat(40)
    });
    expect(
      await observedRunOf(nonRunChange.id),
      "a push-shaped sourceRef carries no run identity"
    ).toBeNull();

    const noSourceRef = await componentWithChange("bare-change", "manual", undefined);
    expect(await observedRunOf(noSourceRef.id)).toBeNull();
  });

  it("picks the MOST RECENT run-carrying change when several exist", async () => {
    const component = await createOrphanComponent(server, org, uniq("newest-wins"));
    await admin.changes.propose({
      name: uniq("chg-older"),
      targets: [component.id],
      type: "configuration",
      sourceKind: "github",
      sourceRef: {
        repo: "acme/api",
        kind: "workflow_run",
        _observed: true,
        raw: { id: 1, html_url: "https://github.com/acme/api/actions/runs/1" }
      }
    });
    await admin.changes.propose({
      name: uniq("chg-newer"),
      targets: [component.id],
      type: "configuration",
      sourceKind: "github",
      sourceRef: {
        repo: "acme/api",
        kind: "workflow_run",
        _observed: true,
        raw: { id: 2, html_url: "https://github.com/acme/api/actions/runs/2" }
      }
    });

    const observedRun = await observedRunOf(component.id);
    expect(observedRun?.runId).toBe("2");
  });

  it("an unknown sourceKind never yields observedRun, even with a github-shaped payload", async () => {
    const component = await componentWithChange("unknown-source-kind", "harbor", {
      repo: "acme/api",
      kind: "workflow_run",
      _observed: true,
      raw: { id: 1, html_url: "https://example.com/run/1" }
    });
    expect(await observedRunOf(component.id)).toBeNull();
  });
});
