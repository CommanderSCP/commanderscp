import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { ScpClient } from "@scp/sdk";
import type { ExecutorEvent, PluginContext, ScopedHttpClient } from "@scp/plugin-api";
import githubExecutorPlugin from "@scp/plugin-github";
import argoCdExecutorPlugin from "@scp/plugin-argocd";
import type { ComponentPipelineObservedRun } from "@scp/schemas";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { changeSourceEvents, changes, objects } from "../db/schema.js";
import { createSourceMapping } from "./source-mappings-repo.js";
import { ingestObservedEvents } from "./observe.js";
import { processChangeSourceEvents } from "./webhook-processor.js";
import { selectEventsByCommit } from "./observed-run-facts.js";

/**
 * A CI RUN IS NOT A RELEASE (docs/proposals/run-events-are-not-releases.md, owner 2026-09-16).
 *
 * Measured on the homelab: 87 GitHub `workflow_run` events became changes and drove 40 real Argo CD
 * syncs. Everything here enters at the layer production uses. The REAL `@scp/plugin-github` and
 * `@scp/plugin-argocd` `observe()` run against a local stand-in for the provider API that serves
 * the provider's own response shapes. Their events go through `ingestObservedEvents` under the
 * source kind production files them under (`github`, `argocd` — `observe.ts#sourceKindForModule`),
 * then through the SAME `processChangeSourceEvents` the reconcile loop calls. Webhook cases go
 * through the real `/webhook` route with the provider's event header. Without that header the
 * delivery silently takes the generic path (journey-view §8.16).
 *
 * The one layer not driven is `runObserveSweep`'s subprocess host dispatch. The host's egress guard
 * blocks loopback for tenant plugins, so it cannot reach a local stand-in. That dispatch never
 * reads the event kind: it hands `observe()`'s array to `ingestObservedEvents` unchanged.
 *
 * No reconcile loop, on purpose. The processor is driven inline, and a live loop is a competing
 * consumer whose SKIP LOCKED turns the inline call into a silent no-op.
 */


interface StandIn {
  commits: { sha: string; date: string; files: string[] }[];
  runs: Record<string, unknown>[];
  apps: Record<string, unknown>[];
}

/** A GitHub "list workflow runs" run object, shaped from a real one captured on the homelab. */
function githubRun(id: number, headSha: string, createdAt: string, repo: string) {
  return {
    id,
    name: "Validate GitOps Config",
    node_id: "WFR_kwLOTEZyGM8AAAAIL_ezyg",
    head_branch: "main",
    head_sha: headSha,
    path: ".github/workflows/validate.yaml",
    run_number: 812,
    event: "push",
    status: "completed",
    conclusion: "success",
    workflow_id: 190112233,
    url: `https://api.github.com/repos/${repo}/actions/runs/${id}`,
    html_url: `https://github.com/${repo}/actions/runs/${id}`,
    created_at: createdAt,
    updated_at: createdAt,
    run_attempt: 1,
    repository: { id: 1279685144, name: repo.split("/")[1], full_name: repo, fork: false }
  };
}

describe("a CI run is not a release (run-events-are-not-releases.md option C)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let standInServer: Server;
  let standInUrl: string;
  const standIn: StandIn = { commits: [], runs: [], apps: [] };
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

  const inOrg = <T>(fn: Parameters<typeof withTenantTx<T>>[2]) =>
    withTenantTx(server.deps.db, org.orgId, fn);

  beforeAll(async () => {
    server = await listenTestServer({});
    org = await createTestOrg(server, "run-events");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    // The provider stand-in: GitHub's REST paths the github adapter's poll calls, and Argo CD's
    // application list. Bodies are the providers' own shapes.
    standInServer = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://stand-in");
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "POST" && /\/app\/installations\/[^/]+\/access_tokens$/.test(url.pathname)) {
        return send(201, {
          token: "stand-in-installation-token",
          expires_at: new Date(Date.now() + 3_600_000).toISOString()
        });
      }
      if (/^\/repos\/[^/]+\/[^/]+\/commits$/.test(url.pathname)) {
        return send(
          200,
          standIn.commits.map((c) => ({ sha: c.sha, commit: { author: { date: c.date } } }))
        );
      }
      const one = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/commits\/([0-9a-f]+)$/);
      if (one) {
        const c = standIn.commits.find((x) => x.sha === one[1]);
        return c
          ? send(200, { sha: c.sha, files: c.files.map((filename) => ({ filename })) })
          : send(404, {});
      }
      if (/^\/repos\/[^/]+\/[^/]+\/actions\/runs$/.test(url.pathname)) {
        return send(200, { total_count: standIn.runs.length, workflow_runs: standIn.runs });
      }
      if (url.pathname === "/api/v1/applications") {
        return send(200, { items: standIn.apps });
      }
      return send(404, { message: "Not Found" });
    });
    await new Promise<void>((resolve) => standInServer.listen(0, "127.0.0.1", resolve));
    standInUrl = `http://127.0.0.1:${(standInServer.address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => standInServer?.close(() => resolve()));
    await server?.close();
  });

  const http: ScopedHttpClient = {
    async request(req) {
      const response = await fetch(req.url, {
        method: req.method,
        headers: {
          ...(req.headers ?? {}),
          ...(req.body !== undefined ? { "content-type": "application/json" } : {})
        },
        body: req.body === undefined ? undefined : JSON.stringify(req.body)
      });
      const text = await response.text();
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: text.length > 0 ? (JSON.parse(text) as unknown) : undefined
      };
    }
  };

  const ctx = (config: unknown): PluginContext => ({
    orgId: org.orgId,
    scopeKey: "run-events",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { get: async () => undefined },
    http,
    config
  });

  const uniqueSha = () => randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40);

  /** The REAL github plugin's `observe()` (pollCommits + pollRuns), ingested exactly as the observe
   *  driver ingests it, then processed by the reconcile loop's own processor. */
  async function pollGithub(repo: string, instanceId: string): Promise<ExecutorEvent[]> {
    const [owner, name] = repo.split("/");
    const events = await githubExecutorPlugin.observe(
      ctx({
        appId: "1",
        installationId: `install-${instanceId}`,
        owner,
        repo: name,
        privateKeyPem,
        apiBaseUrl: standInUrl
      })
    );
    await inOrg((tx) => ingestObservedEvents(tx, org.orgId, "github", instanceId, events));
    await inOrg((tx) => processChangeSourceEvents(tx, org.orgId));
    return events;
  }

  async function componentWithWholeRepoMapping(sourceKind: string, repoPattern: string | undefined) {
    const component = await createTestComponent(admin, { name: `run-events-${randomUUID().slice(0, 8)}` });
    await inOrg((tx) =>
      createSourceMapping(tx, {
        orgId: org.orgId,
        sourceKind,
        ...(repoPattern ? { repoPattern } : {}),
        componentIdOrUrn: component.id
      })
    );
    return component;
  }

  async function changesOf(componentId: string) {
    return inOrg((tx) =>
      tx
        .select({ objectId: changes.objectId, sourceRef: changes.sourceRef })
        .from(changes)
        .innerJoin(objects, eq(objects.id, changes.objectId))
        .where(
          and(
            eq(changes.orgId, org.orgId),
            sql`${objects.properties} @> ${JSON.stringify({ targets: [componentId] })}::jsonb`
          )
        )
    );
  }

  async function eventRows(sourceKind: string, kind: string) {
    return inOrg((tx) =>
      tx
        .select()
        .from(changeSourceEvents)
        .where(
          and(
            eq(changeSourceEvents.orgId, org.orgId),
            eq(changeSourceEvents.sourceKind, sourceKind),
            sql`${changeSourceEvents.payload} ->> 'kind' = ${kind}`
          )
        )
    );
  }

  async function observedRunOf(componentId: string): Promise<ComponentPipelineObservedRun | null> {
    const res = await server.app.inject({
      method: "GET",
      url: `/api/v1/components/${componentId}/pipeline`,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    expect(res.statusCode, res.body).toBe(200);
    const observedRun = res.json().observedRun as ComponentPipelineObservedRun | null | undefined;
    expect(observedRun, "a current server always evaluates observedRun").not.toBeUndefined();
    return observedRun ?? null;
  }

  async function webhook(event: string, payload: Record<string, unknown>) {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/v1/change-sources/github/webhook",
      headers: {
        authorization: `Bearer ${org.adminToken}`,
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": randomUUID()
      },
      payload
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
    const eventId = (res.json() as { eventId: string }).eventId;
    await inOrg((tx) => processChangeSourceEvents(tx, org.orgId));
    const rows = await inOrg((tx) =>
      tx.select().from(changeSourceEvents).where(eq(changeSourceEvents.id, eventId))
    );
    expect(rows[0]?.processedAt, "the processor settled the delivery").not.toBeNull();
    return rows[0]!;
  }

  it("a polled github workflow_run is STORED and proposes NOTHING, while the push for the same commit DOES, and the built-upstream line names that run", async () => {
    const REPO = "acme/gitops-poll";
    const component = await componentWithWholeRepoMapping("github", REPO);
    const sha = uniqueSha();
    const runId = 35046979497;
    standIn.commits = [{ sha, date: "2026-09-16T02:10:33Z", files: ["commanderscp/apps/app.yaml"] }];
    standIn.runs = [githubRun(runId, sha, "2026-09-16T02:10:47Z", REPO)];

    const events = await pollGithub(REPO, "gh-poll-1");
    // The real plugin emitted both, so the case is not vacuous on the input side.
    expect(events.map((e) => e.kind).sort()).toEqual(["push", "workflow_run"]);

    const runRows = (await eventRows("github", "workflow_run")).filter(
      (r) => (r.payload as { commitSha?: string }).commitSha === sha
    );
    expect(runRows, "the run is still ingested — dedupe/watermarks are untouched").toHaveLength(1);
    expect(runRows[0]!.processedAt).not.toBeNull();
    expect(runRows[0]!.resultingChangeObjectId, "a CI run is not a release").toBeNull();

    const released = await changesOf(component.id);
    expect(released, "exactly ONE release: the push").toHaveLength(1);
    expect((released[0]!.sourceRef as { kind?: string }).kind).toBe("push");

    const observedRun = await observedRunOf(component.id);
    expect(observedRun).toEqual({
      sourceKind: "github",
      repo: REPO,
      runId: String(runId),
      workflowName: "Validate GitOps Config",
      workflowPath: ".github/workflows/validate.yaml",
      url: `https://github.com/${REPO}/actions/runs/${runId}`,
      observedAt: expect.any(String),
      changeId: released[0]!.objectId
    });
  });

  it("the run is found by commit even when it was ingested BEFORE its push, and a run for another commit or another repo is never named", async () => {
    const REPO = "acme/gitops-late-push";
    const component = await componentWithWholeRepoMapping("github", REPO);
    const sha = uniqueSha();
    const otherSha = uniqueSha();

    // Poll 1: only runs — this commit's, a run at another commit, and a FORK's run at THIS sha.
    standIn.commits = [];
    standIn.runs = [
      githubRun(9001, sha, "2026-09-16T03:00:10Z", REPO),
      githubRun(9002, otherSha, "2026-09-16T03:00:20Z", REPO)
    ];
    await pollGithub(REPO, "gh-poll-2");
    await inOrg((tx) =>
      ingestObservedEvents(tx, org.orgId, "github", "gh-fork", [
        {
          kind: "workflow_run",
          occurredAt: "2026-09-16T03:00:30Z",
          correlation: { repo: "someone/gitops-fork", commitSha: sha, correlationKey: "run-9003" },
          raw: githubRun(9003, sha, "2026-09-16T03:00:30Z", "someone/gitops-fork")
        }
      ])
    );
    await inOrg((tx) => processChangeSourceEvents(tx, org.orgId));
    expect(await changesOf(component.id), "runs alone release nothing").toHaveLength(0);
    expect(await observedRunOf(component.id)).toBeNull();

    // Poll 2: the push arrives afterwards.
    standIn.commits = [{ sha, date: "2026-09-16T03:00:00Z", files: ["base/kustomization.yaml"] }];
    standIn.runs = [];
    await pollGithub(REPO, "gh-poll-2b");
    const released = await changesOf(component.id);
    expect(released).toHaveLength(1);

    const observedRun = await observedRunOf(component.id);
    expect(observedRun?.runId, "this commit's run, not the other commit's or the fork's").toBe("9001");
    expect(observedRun?.changeId).toBe(released[0]!.objectId);
  });

  it("a github pull_request webhook proposes NOTHING (owner: never), while a push webhook to the same repo does", async () => {
    const component = await componentWithWholeRepoMapping("github", "acme/pr-repo");
    const headSha = uniqueSha();

    const pr = await webhook("pull_request", {
      action: "opened",
      number: 42,
      pull_request: { number: 42, head: { sha: headSha, ref: "feature/x" }, base: { ref: "main" } },
      repository: { full_name: "acme/pr-repo" }
    });
    expect(pr.resultingChangeObjectId).toBeNull();
    expect(await changesOf(component.id)).toHaveLength(0);

    // Positive control: the SAME mapping does match this repo for a push.
    const push = await webhook("push", {
      ref: "refs/heads/main",
      after: headSha,
      head_commit: { id: headSha, added: ["a.yaml"], modified: [], removed: [] },
      commits: [{ id: headSha, added: ["a.yaml"], modified: [], removed: [] }],
      repository: { full_name: "acme/pr-repo" }
    });
    expect(push.resultingChangeObjectId).not.toBeNull();
    expect(await changesOf(component.id)).toHaveLength(1);
  });

  it("a github workflow_run WEBHOOK proposes nothing either, and still names the run for its commit", async () => {
    const component = await componentWithWholeRepoMapping("github", "acme/hook-repo");
    const sha = uniqueSha();
    await webhook("push", {
      ref: "refs/heads/main",
      after: sha,
      head_commit: { id: sha, added: ["b.yaml"], modified: [], removed: [] },
      commits: [{ id: sha, added: ["b.yaml"], modified: [], removed: [] }],
      repository: { full_name: "acme/hook-repo" }
    });
    const run = await webhook("workflow_run", {
      action: "completed",
      workflow_run: githubRun(7007, sha, "2026-09-16T04:00:00Z", "acme/hook-repo"),
      repository: { full_name: "acme/hook-repo" }
    });
    expect(run.resultingChangeObjectId).toBeNull();
    const released = await changesOf(component.id);
    expect(released).toHaveLength(1);
    expect((await observedRunOf(component.id))?.runId).toBe("7007");
  });

  it("one Argo CD sync observed by the REAL argocd plugin proposes NOTHING, even through a mapping that matches it", async () => {
    // A repo-less mapping under the argocd source kind matches every event that kind produces —
    // exactly what would have released on every Argo CD reconcile before the gate.
    const component = await componentWithWholeRepoMapping("argocd", undefined);
    standIn.apps = [
      {
        metadata: { name: `agentkit-auto-${randomUUID().slice(0, 6)}` },
        status: {
          reconciledAt: "2026-09-16T05:00:00Z",
          sync: { status: "Synced", revision: uniqueSha() },
          health: { status: "Healthy" }
        }
      }
    ];
    const events = await argoCdExecutorPlugin.observe(
      ctx({ serverUrl: standInUrl, token: "stand-in" })
    );
    expect(events.map((e) => e.kind)).toEqual(["sync"]);
    await inOrg((tx) => ingestObservedEvents(tx, org.orgId, "argocd", "argocd-1", events));
    await inOrg((tx) => processChangeSourceEvents(tx, org.orgId));

    const syncRows = await eventRows("argocd", "sync");
    expect(syncRows).toHaveLength(1);
    expect(syncRows[0]!.processedAt).not.toBeNull();
    expect(syncRows[0]!.resultingChangeObjectId).toBeNull();
    expect(await changesOf(component.id)).toHaveLength(0);
  });

  it("the commit lookup is served by migration 0113's index, not a scan of the append-only table", async () => {
    const plan = await inOrg(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      const query = selectEventsByCommit(tx, org.orgId, ["github"], [uniqueSha()]).toSQL();
      const rows = await tx.execute(
        sql.raw(
          `EXPLAIN ${query.sql.replace(/\$(\d+)/g, (_m, i: string) => {
            const value = query.params[Number(i) - 1];
            return typeof value === "number" ? String(value) : `'${String(value)}'`;
          })}`
        )
      );
      return (rows as unknown as { rows?: Record<string, string>[] }).rows ?? (rows as unknown as Record<string, string>[]);
    });
    const text = plan.map((r) => Object.values(r).join(" ")).join("\n");
    expect(text).toContain("change_source_events_org_kind_commit");
    // The COMMIT must be an index condition, not a filter applied after an (org, kind) prefix scan.
    // A prefix scan also names the index, so the name alone would pass with a drifted expression.
    const indexCond = text.split("\n").find((line) => line.includes("Index Cond")) ?? "";
    expect(indexCond, text).toMatch(/commit_sha/);
    expect(text, text).not.toMatch(/Filter:.*(commit_sha|coalesce)/i);
  });
});
