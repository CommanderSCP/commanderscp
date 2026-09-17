import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { ScpClient } from "@scp/sdk";
import type { ExecutorEvent } from "@scp/plugin-api";
import type { ComponentPipelineObservedRun, GraphObject } from "@scp/schemas";
import {
  createOrphanComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { ingestObservedEvents } from "./observe.js";
import { processChangeSourceEvents } from "./webhook-processor.js";

/**
 * component-journey-view.md §3 Segment 2. See docs/coordination.md §291.
 *
 * A CI run is not a release (run-events-are-not-releases.md, owner 2026-09-16), so the run a release
 * went through is a STORED EVENT at that release's commit, never a change of its own. Every case
 * therefore sets up the two things production has: a release (a change whose `sourceRef` names a
 * repo and commit, as ingress writes one) and the run event, stored through the real writer for its
 * shape. Observed runs go through `ingestObservedEvents`. A webhook run goes through the `/webhook`
 * route with the provider's event header. Both are then settled by the real processor.
 *
 * The owner-approved honesty rules (2026-08-10) are pinned unchanged: fields verbatim, null rather
 * than omitted, never fabricated, most-recent release first, and an unreadable source kind yields
 * nothing.
 */
describe("component pipeline: observedRun (§3 Segment 2 — the upstream build marker)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  const uniq = (p: string) => `${p}-${uuidv7()}`;
  const sha = () => randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40);

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

  /** A release of `component` at `commit` — the canonical `repo`/`commit` keys ingress lifts. */
  async function release(
    component: GraphObject,
    sourceKind: string,
    sourceRef: Record<string, unknown> | undefined
  ): Promise<string> {
    const change = await admin.changes.propose({
      name: uniq("chg"),
      targets: [component.id],
      type: "configuration",
      sourceKind,
      ...(sourceRef ? { sourceRef } : {})
    });
    return change.id;
  }

  async function observeRun(sourceKind: string, event: ExecutorEvent): Promise<void> {
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      ingestObservedEvents(tx, org.orgId, sourceKind, `instance-${randomUUID()}`, [event])
    );
    await withTenantTx(server.deps.db, org.orgId, (tx) => processChangeSourceEvents(tx, org.orgId));
  }

  /** The event `@scp/plugin-github#pollRuns` emits, around a real "list workflow runs" run object. */
  function githubPolledRun(repo: string, commit: string, id: number, name = "CI"): ExecutorEvent {
    return {
      kind: "workflow_run",
      occurredAt: "2026-08-20T12:00:00.000Z",
      correlation: { repo, commitSha: commit, correlationKey: `run-${id}` },
      raw: {
        id,
        status: "completed",
        conclusion: "success",
        html_url: `https://github.com/${repo}/actions/runs/${id}`,
        head_sha: commit,
        workflow_id: 987,
        name,
        path: ".github/workflows/ci.yml",
        repository: { full_name: repo }
      }
    };
  }

  it("a polled github run at the release's commit -> observedRun carries it verbatim, naming that release", async () => {
    const component = await createOrphanComponent(server, org, uniq("observed-github"));
    const commit = sha();
    const changeId = await release(component, "github", { repo: "acme/api", commit });
    await observeRun("github", githubPolledRun("acme/api", commit, 30858160395));

    const observedRun = await observedRunOf(component.id);
    expect(observedRun).not.toBeNull();
    expect(observedRun).not.toBeUndefined();
    expect(observedRun!.sourceKind).toBe("github");
    expect(observedRun!.repo).toBe("acme/api");
    expect(observedRun!.runId).toBe("30858160395");
    expect(observedRun!.workflowName).toBe("CI");
    expect(observedRun!.workflowPath).toBe(".github/workflows/ci.yml");
    expect(observedRun!.url).toBe("https://github.com/acme/api/actions/runs/30858160395");
    expect(observedRun!.changeId).toBe(changeId);
    // observedAt is when SCP recorded the run EVENT, not a run payload timestamp — a live server
    // clock value, so only presence + parseability is pinned.
    expect(Number.isNaN(Date.parse(observedRun!.observedAt))).toBe(false);
  });

  it("a github workflow_run WEBHOOK delivery at the release's commit -> observedRun carries it verbatim", async () => {
    const component = await createOrphanComponent(server, org, uniq("webhook-github"));
    const commit = sha();
    await release(component, "github", { repo: "acme/checkout", ref: "refs/heads/main", commit });
    const res = await server.app.inject({
      method: "POST",
      url: "/api/v1/change-sources/github/webhook",
      headers: {
        authorization: `Bearer ${org.adminToken}`,
        "content-type": "application/json",
        "x-github-event": "workflow_run",
        "x-github-delivery": randomUUID()
      },
      payload: {
        action: "completed",
        workflow_run: {
          id: 30858160500,
          status: "completed",
          conclusion: "success",
          html_url: "https://github.com/acme/checkout/actions/runs/30858160500",
          head_sha: commit,
          name: "deploy",
          path: ".github/workflows/deploy.yml"
        },
        repository: { full_name: "acme/checkout" }
      }
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
    await withTenantTx(server.deps.db, org.orgId, (tx) => processChangeSourceEvents(tx, org.orgId));

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

  it("a polled gitea run cites no workflow name/path -> those are null, never guessed", async () => {
    const component = await createOrphanComponent(server, org, uniq("observed-gitea"));
    const commit = sha();
    await release(component, "gitea", { repo: "acme/svc", commit });
    await observeRun("gitea", {
      kind: "workflow_run",
      occurredAt: "2026-08-20T12:00:00.000Z",
      correlation: { repo: "acme/svc", commitSha: commit, correlationKey: "run-77" },
      raw: {
        id: 77,
        status: "success",
        head_sha: commit,
        html_url: "https://gitea.example/acme/svc/actions/runs/77"
      }
    });
    expect(await observedRunOf(component.id)).toEqual(
      expect.objectContaining({
        sourceKind: "gitea",
        runId: "77",
        workflowName: null,
        workflowPath: null
      })
    );
  });

  it("no run for the release's commit -> observedRun is null, not omitted (absent-vs-fabricated)", async () => {
    const noChange = await createOrphanComponent(server, org, uniq("no-change"));
    expect(await observedRunOf(noChange.id)).toBeNull();

    const pushOnly = await createOrphanComponent(server, org, uniq("push-only"));
    await release(pushOnly, "github", { repo: "acme/api", ref: "refs/heads/main", commit: sha() });
    expect(await observedRunOf(pushOnly.id), "a release with no observed run").toBeNull();

    const otherCommit = await createOrphanComponent(server, org, uniq("other-commit"));
    await release(otherCommit, "github", { repo: "acme/other", commit: sha() });
    await observeRun("github", githubPolledRun("acme/other", sha(), 4242));
    expect(
      await observedRunOf(otherCommit.id),
      "a run at a DIFFERENT commit is not this release's"
    ).toBeNull();

    const noSourceRef = await createOrphanComponent(server, org, uniq("bare-change"));
    await release(noSourceRef, "manual", undefined);
    expect(await observedRunOf(noSourceRef.id)).toBeNull();
  });

  it("a run-shaped sourceRef planted ON A CHANGE is no longer read — the run lives in the event, not the change", async () => {
    const component = await createOrphanComponent(server, org, uniq("legacy-run-change"));
    await release(component, "github", {
      repo: "acme/api",
      kind: "workflow_run",
      _observed: true,
      raw: { id: 1, html_url: "https://github.com/acme/api/actions/runs/1" }
    });
    expect(await observedRunOf(component.id)).toBeNull();
  });

  it("picks the MOST RECENT release that has an observed run", async () => {
    const component = await createOrphanComponent(server, org, uniq("newest-wins"));
    const older = sha();
    const newer = sha();
    const newest = sha();
    await release(component, "github", { repo: "acme/api", commit: older });
    const newerId = await release(component, "github", { repo: "acme/api", commit: newer });
    await observeRun("github", githubPolledRun("acme/api", older, 1));
    await observeRun("github", githubPolledRun("acme/api", newer, 2));
    expect((await observedRunOf(component.id))?.runId).toBe("2");

    // A still-newer release with no run yet does not blank the line: the newest release that HAS one.
    await release(component, "github", { repo: "acme/api", commit: newest });
    const observedRun = await observedRunOf(component.id);
    expect(observedRun?.runId).toBe("2");
    expect(observedRun?.changeId).toBe(newerId);
  });

  it("an unknown sourceKind never yields observedRun, even with a github-shaped run at its commit", async () => {
    const component = await createOrphanComponent(server, org, uniq("unknown-source-kind"));
    const commit = sha();
    await release(component, "harbor", { repo: "acme/api", commit });
    await observeRun("harbor", githubPolledRun("acme/api", commit, 1));
    expect(await observedRunOf(component.id)).toBeNull();
  });
});
