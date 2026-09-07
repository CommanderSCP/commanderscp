import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import pg from "pg";
import { v7 as uuidv7 } from "uuid";
import { ScpApiError, ScpClient } from "@scp/sdk";
import type { DesiredStateManifest } from "@scp/schemas";
import type { ControlOutcome, ExecutorEvent, TriggerIntent } from "@scp/plugin-api";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  testDatabaseUrl,
  waitUntil,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { withTenantTx, type TenantTx } from "../db/tenant-tx.js";
import { changes, decisions, outbox } from "../db/schema.js";
import { startPgBoss, DOMAIN_EVENTS_QUEUE } from "../events/pgboss.js";
import type { ReadFileAtRefResult } from "@scp/git-provider-core";
import type {
  ControlPluginClient,
  ExecutorPluginClient,
  GitFileReadPluginClient,
  PluginHost
} from "../plugin-host/contract.js";
import {
  resolveExecutorPluginInstance,
  upsertExecutorBinding
} from "../coordination/executor-bindings-repo.js";
import { listControlRunsForChange, upsertControlBinding } from "../governance/controls-repo.js";
import { createFreeze, liftFreeze } from "../governance/freezes-repo.js";
import { getOrgRootObjectId } from "../graph/objects-repo.js";
import { SYSTEM_ACTOR_ID } from "../coordination/system-actor.js";
import { processChangeSourceEvents } from "../coordination/webhook-processor.js";
import { BUMP_OBSERVED_EVENT } from "../coordination/correlation.js";
import { changeSourceEvents } from "../db/schema.js";
import {
  observedBumpRouter,
  runBumpGateJob,
  startBumpGateLoop,
  DEPENDENCY_BUMP_MERGE_DECISION_KIND,
  type BumpGateLoopHandle
} from "./bump-gate.js";
import {
  DEPENDENCY_LINE_HEAD_ADVANCED_EVENT,
  recordDependencyLineHead,
  upsertComponentDependency,
  upsertDependencyLine
} from "./dependency-inventory-repo.js";
import {
  advancedLineHeadRouter,
  runBumpDispatchJob,
  startBumpDispatchLoop,
  DEPENDENCY_BUMP_DECISION_KIND,
  type BumpDispatchLoopHandle
} from "./bump-dispatch.js";
import { runBumpFreezeRedriveSweep } from "./bump-freeze-redrive.js";
import { DEPENDENCY_DELEGATION_DECISION_KIND } from "./delegation-detection.js";
import { BUMP_SOURCE_KIND } from "./bump-actuator.js";
import { readBumpAuthorship } from "./bump-authorship-repo.js";

/** The bump is actually dispatched, through the real path. See docs/dependencies.md §29. */
/** M25.8 — the operator credential the PLATFORM-tier freeze fixture authenticates with. The org
 *  Administrator token every other fixture in this file uses cannot write that surface at all,
 *  which is the tier boundary M25.3 built and this file now depends on. */
const OPERATOR_TOKEN = "m25-8-bump-freeze-operator-token";

describe("M21.5 the bump dispatcher: a head advances and a bump is authored (Testcontainers)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let boss: Awaited<ReturnType<typeof startPgBoss>> | undefined;
  let loop: BumpDispatchLoopHandle | undefined;
  let gateLoop: BumpGateLoopHandle | undefined;

  /** Every `trigger()` that reached the plugin host, with the instance it was addressed to. */
  const triggers: { instanceId: string; intent: TriggerIntent }[] = [];
  /** Every gate evaluation, with the change it was about. See docs/dependencies.md §30. */
  const controlEvaluations: { instanceId: string; changeId: unknown; commitSha: unknown }[] = [];
  /** The pull request the fake provider reports the authoring run opened, per change — the number
   *  AND the URL `status().stateRef` carries back and the server records. `undefined` for a change
   *  the fixture wants to leave with no recorded pull request. */
  const openedPullRequests = new Map<string, { number: number; url: string }>();
  let nextPullRequestNumber = 100;
  /** The URL the fixture provider hands back, deliberately. See docs/dependencies.md §31. */
  const providerPullRequestUrl = (repo: string, number: number): string =>
    `https://gitea.dc1.internal/${repo}/pulls/${number}`;
  /** What the fixture `github-check` control answers. Mutable so a test can say what "the
   *  component's own checks" reported, and FOR WHICH COMMIT. */
  let controlOutcome: ControlOutcome = { status: "expired", evidence: {} };
  /** What `status()` reports for a merge run — the honest outcome the gate job records rather than
   *  assuming a dispatch means a merge. */
  let mergeRunPhase: "succeeded" | "failed" = "succeeded";
  const fileReads: { instanceId: string; repo?: string; path: string }[] = [];
  /** repo -> (path -> content). A path absent from the map answers `not_found`, which is what makes
   *  "this repository delegates" a property of the fixture repository rather than of a flag. */
  const repoFiles = new Map<string, Map<string, string>>();
  /** repo -> the error `readFileAtRef` throws for it. What a bad credential, a provider 5xx and an
   *  egress refusal all look like from the server's side of the plugin-host RPC. */
  const repoReadFailures = new Map<string, string>();
  const startedInstances: string[] = [];
  /** The CONFIG each instance was started with, not just its id — `startedInstances` alone cannot
   *  see what the server actually handed the plugin, which is where the runtime binary lives. */
  const startedConfigs: { id: string; config: Record<string, unknown> }[] = [];
  const stoppedInstances: string[] = [];

  const inOrg = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> =>
    withTenantTx(server.deps.db, org.orgId, fn);

  /** Accumulators are reset per test, a correctness fix. See docs/dependencies.md §32. */
  beforeEach(() => {
    triggers.length = 0;
    controlEvaluations.length = 0;
    fileReads.length = 0;
    startedInstances.length = 0;
    startedConfigs.length = 0;
    stoppedInstances.length = 0;
  });

  function recordingHost(): PluginHost {
    const notWired = (): never => {
      throw new Error("this fixture wires only gitFileRead(), executor() and control()");
    };
    return {
      async start(instances) {
        for (const i of instances) {
          startedInstances.push(i.id);
          startedConfigs.push({ id: i.id, config: (i.config ?? {}) as Record<string, unknown> });
        }
      },
      async stop() {},
      async stopInstances(ids) {
        for (const id of ids) stoppedInstances.push(id);
      },
      executor(instanceId: string): ExecutorPluginClient {
        return {
          observe: async (): Promise<ExecutorEvent[]> => [],
          trigger: async (intent) => {
            triggers.push({ instanceId, intent });
            const params = (intent.parameters ?? {}) as {
              action?: string;
              changeObjectId?: string;
              repo?: string;
            };
            // An authoring run opens a pull request. See docs/dependencies.md §33.
            if (params.action !== "merge" && params.changeObjectId) {
              if (!openedPullRequests.has(params.changeObjectId)) {
                const number = nextPullRequestNumber++;
                openedPullRequests.set(params.changeObjectId, {
                  number,
                  url: providerPullRequestUrl(params.repo ?? "", number)
                });
              }
            }
            return { externalId: `managed-dep::${intent.idempotencyKey}` };
          },
          status: async (ref) => {
            // A MERGE run's phase is what the gate job records, so the fixture must be able to say
            // "the provider refused" — otherwise the refusal branch would be unreachable and green.
            if (ref.externalId.includes(":merge:")) {
              return { phase: mergeRunPhase, detail: "fixture" };
            }
            const changeObjectId = ref.externalId.replace("managed-dep::", "");
            const opened = openedPullRequests.get(changeObjectId);
            return {
              phase: "succeeded" as const,
              detail: "fixture",
              ...(opened === undefined
                ? {}
                : {
                    stateRef: {
                      commitSha: "fixture",
                      pullRequestNumber: opened.number,
                      pullRequestUrl: opened.url,
                      merged: false
                    }
                  })
            };
          },
          abort: async () => ({ aborted: false, detail: "fixture" }),
          describeCapabilities: async () => ({
            supportsObserve: true,
            supportsTrigger: true,
            supportsAbort: true,
            triggerKinds: ["custom" as const]
          })
        };
      },
      /** The `github-check` stand-in the governance gate actually calls (M21.5 auto-merge link).
       *  It records the commit it was asked about, because "which commit" is the narrowing the whole
       *  grant turns on — a fixture that ignored `context.commitSha` would pass with the binding
       *  deleted. */
      control(instanceId: string): ControlPluginClient {
        return {
          evaluate: async (req) => {
            controlEvaluations.push({
              instanceId,
              changeId: req.changeId,
              commitSha: (req.context as { commitSha?: unknown }).commitSha
            });
            return controlOutcome;
          }
        };
      },
      discovery: notWired,
      notification: notWired,
      federationTransport: notWired,
      dependencyIndex: notWired,
      gitFileRead(instanceId: string): GitFileReadPluginClient {
        return {
          readFileAtRef: async (request) => {
            fileReads.push({ instanceId, repo: request.repo, path: request.path });
            const failure = repoReadFailures.get((request.repo ?? "").toLowerCase());
            if (failure !== undefined) throw new Error(failure);
            const content = repoFiles.get((request.repo ?? "").toLowerCase())?.get(request.path);
            const result: ReadFileAtRefResult =
              content === undefined
                ? {
                    outcome: "not_found",
                    missing: "path",
                    path: request.path,
                    requestedRef: request.ref,
                    detail: "fixture: this repository does not contain that file"
                  }
                : {
                    outcome: "found",
                    path: request.path,
                    requestedRef: request.ref,
                    commitSha: request.ref,
                    content,
                    sizeBytes: Buffer.byteLength(content)
                  };
            return result;
          }
        };
      }
    };
  }

  beforeAll(async () => {
    // Dependency-bump authoring is OFF unless an operator names the vetted runner image (ADR-0006:
    // managed execution is never a default). Without this the dispatcher refuses before a container
    // could be launched or a credential minted — which is a behaviour this file also asserts.
    process.env.SCP_MANAGED_DEP_RUNNER_IMAGE = "scp-runner-dep:test";
    server = await listenTestServer({ operatorToken: OPERATOR_TOKEN });
    org = await createTestOrg(server);
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    await setInstanceUnlock(true);

    boss = await startPgBoss(server.deps.config.pgBossDatabaseUrl, [
      advancedLineHeadRouter(),
      observedBumpRouter()
    ]);
    const jobConfig = {
      ...server.deps.config,
      // The guard requires BOTH: a background-work process AND an EXPLICITLY DECLARED commander.
      // Set here rather than assumed, so the fixture states the posture the job requires.
      role: "all" as const,
      federationRole: "commander" as const,
      federationRoleDeclared: true
    };
    loop = await startBumpDispatchLoop(boss, {
      db: server.deps.db,
      host: recordingHost(),
      config: jobConfig
    });
    gateLoop = await startBumpGateLoop(boss, {
      db: server.deps.db,
      host: recordingHost(),
      sandbox: server.deps.celSandbox!,
      config: jobConfig
    });
  }, 180_000);

  afterAll(async () => {
    await gateLoop?.stop();
    await loop?.stop();
    await boss?.stop({ graceful: false, timeout: 1000 }).catch(() => undefined);
    await setInstanceUnlock(null).catch(() => undefined);
    delete process.env.SCP_MANAGED_DEP_RUNNER_IMAGE;
    await server?.close();
  });

  /** The unlock is operator-written over the ADMIN connection — `scp_app` holds no write grant and
   *  no write RLS policy exists (0062's two barriers), so a tenant-pool write here would be proving
   *  those barriers absent. */
  async function setInstanceUnlock(unlocked: boolean | null): Promise<void> {
    const pool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 1 });
    try {
      if (unlocked === null) {
        await pool.query(`DELETE FROM dependency_subscription_unlock WHERE id = 'default'`);
        return;
      }
      await pool.query(
        `INSERT INTO dependency_subscription_unlock (id, unlocked, note, updated_at)
           VALUES ('default', $1, 'M21.5 integration fixture', now())
         ON CONFLICT (id) DO UPDATE SET unlocked = EXCLUDED.unlocked, updated_at = now()`,
        [unlocked]
      );
    } finally {
      await pool.end();
    }
  }

  interface Fixture {
    componentObjectId: string;
    lineId: string;
    repo: string;
    instanceId: string;
  }

  /** A subscribed component declaring that range. See docs/dependencies.md §34. */
  async function subscribedComponent(options?: {
    files?: Record<string, string>;
    /** What `readFileAtRef` THROWS for this repository — an unreadable repository, not an empty one. */
    readFailure?: string;
    /** Join an EXISTING line instead of minting one, so two components share a dependency. */
    lineId?: string;
    /** Every manifest this component declares the line from. Default: just `package.json`. */
    manifestPaths?: string[];
    /** `github` unless a test is about the refusal of the others. */
    pluginModule?: "github" | "gitea" | "gitlab";
    declaredVersion?: string;
    resolvedVersion?: string | null;
    observedRef?: string | null;
    /** `pull_request` unless a test is about what auto_merge resolves to. */
    delivery?: "pull_request" | "auto_merge";
  }): Promise<Fixture> {
    const slug = randomUUID().slice(0, 8);
    const repo = `acme/dep-${slug}`;
    repoFiles.set(repo.toLowerCase(), new Map(Object.entries(options?.files ?? {})));
    if (options?.readFailure !== undefined) {
      repoReadFailures.set(repo.toLowerCase(), options.readFailure);
    }

    const component = await createTestComponent(admin, { name: `dep-bump-${slug}` });
    const instanceId = `gh-${slug}`;
    await inOrg((tx) =>
      upsertExecutorBinding(tx, {
        orgId: org.orgId,
        targetObjectId: component.id,
        pluginModule: options?.pluginModule ?? "github",
        pluginInstanceId: instanceId,
        config: { appId: "1", installationId: "2", owner: "acme", repo: `dep-${slug}` },
        actorObjectId: org.orgId,
        requestId: "test-setup"
      })
    );

    const line = options?.lineId
      ? { id: options.lineId }
      : await inOrg((tx) =>
          upsertDependencyLine(tx, org.orgId, {
            ecosystem: "npm",
            coordinate: `@acme/lib-${slug}`,
            major: "1"
          })
        );
    for (const manifestPath of options?.manifestPaths ?? ["package.json"]) {
      await inOrg((tx) =>
        upsertComponentDependency(tx, org.orgId, {
          componentObjectId: component.id,
          lineId: line.id,
          manifestPath,
          declaredVersion: options?.declaredVersion ?? "^1.2.3",
          resolvedVersion:
            options?.resolvedVersion === undefined ? "1.2.3" : options.resolvedVersion,
          observedRef: options?.observedRef === undefined ? "refs/heads/main" : options.observedRef
        })
      );
    }
    await admin.policies.create({
      name: `sub-${slug}`,
      urn: `urn:scp:${org.orgId}:policy:sub-${slug}`,
      properties: {
        scope: { objectRef: component.id },
        enforcement: "advisory",
        effects: [
          {
            dependencySubscription: {
              enabled: true,
              granularity: "minor_and_patch",
              ...(options?.delivery ? { delivery: options.delivery } : {})
            } as const
          }
        ]
      }
    });
    return { componentObjectId: component.id, lineId: line.id, repo, instanceId };
  }

  /** The deps the worker builds for itself, so a test can drive `runBumpDispatchJob` — the exact
   *  function the worker runs — without racing the loop for a queued job. */
  function jobDeps() {
    return {
      db: server.deps.db,
      host: recordingHost(),
      config: {
        ...server.deps.config,
        role: "all" as const,
        federationRole: "commander" as const,
        federationRoleDeclared: true
      }
    };
  }

  /** The deps the GATE worker builds for itself — same shape as {@link jobDeps}, plus the CEL
   *  sandbox the governance prewarm needs. Lets a test drive `runBumpGateJob` (the exact function
   *  the worker runs) without racing the loop for a queued job. */
  function gateDeps() {
    return { ...jobDeps(), sandbox: server.deps.celSandbox! };
  }

  /** Move the line's head through the ONE write door, exactly as both M21.4 ingresses do. */
  async function advanceHead(lineId: string, version: string): Promise<void> {
    const outcome = await inOrg((tx) =>
      recordDependencyLineHead(
        tx,
        org.orgId,
        { lineId, latestVersion: version, latestDigest: null },
        // No producer is declared for these fixtures' coordinates, so the third-party ingress is
        // the one that owns them — the same argument `version-poll.ts` passes.
        { kind: "third_party" }
      )
    );
    expect(outcome.recorded, `the head should have moved to ${version}`).toBe(true);
  }

  /** The exact payload `events/outbox-relay.ts` puts on the domain-event queue for an outbox row. */
  async function relayHeadAdvance(lineId: string): Promise<void> {
    await boss!.send(DOMAIN_EVENTS_QUEUE, {
      id: uuidv7(),
      orgId: org.orgId,
      type: DEPENDENCY_LINE_HEAD_ADVANCED_EVENT,
      source: "/dependencies/lines",
      subject: lineId,
      data: { lineId }
    });
  }

  async function bumpChangesFor(repo: string) {
    const rows = await inOrg((tx) =>
      tx
        .select()
        .from(changes)
        .where(and(eq(changes.orgId, org.orgId), eq(changes.sourceKind, BUMP_SOURCE_KIND)))
    );
    // Matched on the change's OWN `scp_authored` declaration — the same key `correlation.ts` reads
    // — rather than on a targets join, so the fixture asks the same question production does.
    return rows.filter(
      (r) =>
        (r.sourceRef as { scp_authored?: { repo?: unknown } } | null)?.scp_authored?.repo === repo
    );
  }

  // ---------------------------------------------------------------------------------------------
  // 1. THE PRODUCER — the head write door emits the event, in its own transaction
  // ---------------------------------------------------------------------------------------------

  it("an ADVANCED head writes the domain event; a RESTATED one writes nothing", async () => {
    const fixture = await subscribedComponent();
    const before = await outboxRowsFor(fixture.lineId);
    await advanceHead(fixture.lineId, "1.4.0");
    const afterAdvance = await outboxRowsFor(fixture.lineId);
    expect(afterAdvance.length, "the head write door must emit exactly one advance event").toBe(
      before.length + 1
    );

    // A RESTATEMENT is the same point on the line re-observed — the daily poll does this for every
    // third-party line every day, and a job per restatement is a job per dependency per day for
    // work already done.
    await inOrg((tx) =>
      recordDependencyLineHead(
        tx,
        org.orgId,
        { lineId: fixture.lineId, latestVersion: "1.4.0", latestDigest: null },
        { kind: "third_party" }
      )
    );
    expect((await outboxRowsFor(fixture.lineId)).length).toBe(afterAdvance.length);
  }, 60_000);

  async function outboxRowsFor(lineId: string) {
    return inOrg((tx) =>
      tx
        .select()
        .from(outbox)
        .where(
          and(
            eq(outbox.orgId, org.orgId),
            eq(outbox.type, DEPENDENCY_LINE_HEAD_ADVANCED_EVENT),
            eq(outbox.subject, lineId)
          )
        )
    );
  }

  // ---------------------------------------------------------------------------------------------
  // 2. THE WHOLE CHAIN — router, queue, worker, change, dispatch
  // ---------------------------------------------------------------------------------------------

  it("a head advance delivered on the domain-event queue proposes a bump change AND dispatches managed-dep", async () => {
    const fixture = await subscribedComponent();
    await advanceHead(fixture.lineId, "1.4.0");
    await relayHeadAdvance(fixture.lineId);

    const fired = await waitUntil(
      async () => {
        const found = triggers.find(
          (t) => (t.intent.parameters as { repo?: string } | undefined)?.repo === fixture.repo
        );
        return found ?? undefined;
      },
      {
        describe: "the bump dispatcher to trigger managed-dep for this component",
        timeoutMs: 60_000,
        intervalMs: 200
      }
    );

    // THE INTENT IS A DESCRIPTOR, and every field of it names something that already exists.
    expect(fired.intent.parameters).toMatchObject({
      ecosystem: "npm",
      manifestPath: "package.json",
      declaredManifestPaths: ["package.json"],
      fromVersion: "^1.2.3",
      // COMPOSED BY SUBSTITUTION — the range operator survives, which re-rendering from a parsed
      // triple would have dropped in a file this system then commits.
      toVersion: "^1.4.0",
      repo: fixture.repo,
      baseBranch: "main",
      delivery: "pull_request"
    });
    // ADR-0032 §9: authored content is never threaded through the intent.
    for (const forbidden of ["sourceFiles", "content", "patch", "diff", "files", "body"]) {
      expect(Object.keys(fired.intent.parameters ?? {})).not.toContain(forbidden);
    }
    // The instance is assembled from the component's OWN git binding, never a shared one.
    expect(fired.instanceId).toContain("managed-dep:");

    // THE CHANGE — recorded first, so the branch can carry its id and the returning push correlates.
    const [change] = await bumpChangesFor(fixture.repo);
    expect(change, "a bump change must exist").toBeDefined();
    const authored = (change!.sourceRef as { scp_authored: Record<string, unknown> }).scp_authored;
    expect(authored.repo).toBe(fixture.repo);
    expect(authored.ref).toBe(`refs/heads/scp/dep-bump/${change!.objectId}`);
    expect(fired.intent.parameters?.changeObjectId).toBe(change!.objectId);
    expect(fired.intent.idempotencyKey).toBe(change!.objectId);

    // AND THE VERDICT IS EXPLAINABLE (charter principle 6).
    const verdicts = await decisionsOfKind(DEPENDENCY_BUMP_DECISION_KIND, change!.objectId);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.verdict).toBe("dispatched");
  }, 120_000);

  /** THE LINK IS CAPTURED HERE OR NOWHERE. See docs/dependencies.md §35. */
  it("records the pull request URL THE PROVIDER RETURNED, on the real authoring path", async () => {
    const fixture = await subscribedComponent();
    await advanceHead(fixture.lineId, "1.4.0");
    await relayHeadAdvance(fixture.lineId);

    const change = await waitUntil(async () => (await bumpChangesFor(fixture.repo))[0], {
      describe: "the dispatcher to record its bump change",
      timeoutMs: 60_000,
      intervalMs: 200
    });
    const authorship = await waitUntil(
      async () => {
        const row = await inOrg((tx) => readBumpAuthorship(tx, org.orgId, change.objectId));
        // Waiting on the URL specifically, not on the row: the row exists from phase 3, so waiting
        // on it would return before phase 5 had run and the assertions below would race.
        return row?.pullRequestUrl === undefined ? undefined : row;
      },
      {
        describe: "phase 5 to record the pull request the authoring run opened",
        timeoutMs: 60_000,
        intervalMs: 200
      }
    );

    const opened = openedPullRequests.get(change.objectId);
    expect(
      opened,
      "the fixture provider must have opened a pull request for this change"
    ).toBeDefined();
    expect(authorship.pullRequestNumber).toBe(opened!.number);

    // ANCHORED ON A LITERAL, NOT ON `opened.url`. Reading the expectation out of the same fixture
    // that produced the value makes the assertion move with the fixture, which is this repo's
    // "green for the wrong reason" shape — change the fixture's host and nothing fails. Spelled out
    // here, changing it DOES fail.
    expect(authorship.pullRequestUrl).toBe(
      `https://gitea.dc1.internal/${fixture.repo}/pulls/${opened!.number}`
    );
    // AND THE SYNTHESIS IS NOT THE ANSWER — the exact link a consumer would have composed from the
    // two columns 0064 already had, stated so that composing one can never pass this test.
    expect(authorship.pullRequestUrl).not.toBe(
      `https://github.com/${fixture.repo}/pull/${opened!.number}`
    );
  }, 120_000);

  it("REDELIVERY dispatches against the SAME change — one branch, one pull request", async () => {
    const fixture = await subscribedComponent();
    await advanceHead(fixture.lineId, "1.4.0");
    await relayHeadAdvance(fixture.lineId);
    await waitUntil(async () => (await bumpChangesFor(fixture.repo)).length === 1, {
      describe: "the first dispatch to record its change",
      timeoutMs: 60_000,
      intervalMs: 200
    });
    const [first] = await bumpChangesFor(fixture.repo);

    // The SAME advance, delivered again — at-least-once is the contract of both hops.
    await relayHeadAdvance(fixture.lineId);
    await waitUntil(
      async () =>
        triggers.filter(
          (t) => (t.intent.parameters as { repo?: string } | undefined)?.repo === fixture.repo
        ).length >= 2,
      {
        describe: "the redelivered advance to reach the dispatcher",
        timeoutMs: 60_000,
        intervalMs: 200
      }
    );

    // THE ASSERTION THAT MATTERS: no second change, so no second branch and no second pull request.
    const after = await bumpChangesFor(fixture.repo);
    expect(after).toHaveLength(1);
    expect(after[0]?.objectId).toBe(first?.objectId);
    const repeated = triggers.filter(
      (t) => (t.intent.parameters as { repo?: string } | undefined)?.repo === fixture.repo
    );
    expect(new Set(repeated.map((t) => t.intent.idempotencyKey))).toEqual(
      new Set([first!.objectId])
    );
  }, 120_000);

  it("a component that is NOT subscribed is never bumped — the work-list is M21.3's resolution", async () => {
    const slug = randomUUID().slice(0, 8);
    const repo = `acme/quiet-${slug}`;
    repoFiles.set(repo.toLowerCase(), new Map());
    const component = await createTestComponent(admin, { name: `dep-quiet-${slug}` });
    await inOrg((tx) =>
      upsertExecutorBinding(tx, {
        orgId: org.orgId,
        targetObjectId: component.id,
        pluginModule: "github",
        pluginInstanceId: `gh-quiet-${slug}`,
        config: { appId: "1", installationId: "2", owner: "acme", repo: `quiet-${slug}` },
        actorObjectId: org.orgId,
        requestId: "test-setup"
      })
    );
    const line = await inOrg((tx) =>
      upsertDependencyLine(tx, org.orgId, {
        ecosystem: "npm",
        coordinate: `@acme/quiet-${slug}`,
        major: "1"
      })
    );
    await inOrg((tx) =>
      upsertComponentDependency(tx, org.orgId, {
        componentObjectId: component.id,
        lineId: line.id,
        manifestPath: "package.json",
        declaredVersion: "^1.0.0",
        resolvedVersion: "1.0.0",
        observedRef: "refs/heads/main"
      })
    );
    // NO subscription policy — so the monotone AND resolves FALSE and this pair is never in the
    // work-list. Note what is deliberately absent from the dispatcher: any second predicate that
    // could disagree with the resolver.
    await advanceHead(line.id, "1.9.0");
    await relayHeadAdvance(line.id);

    // A negative assertion needs a positive event to race against, or it passes by being early: a
    // SUBSCRIBED component's advance is delivered afterwards and awaited, and only then is the
    // unsubscribed one asserted quiet.
    const canary = await subscribedComponent();
    await advanceHead(canary.lineId, "1.4.0");
    await relayHeadAdvance(canary.lineId);
    await waitUntil(
      async () =>
        triggers.some(
          (t) => (t.intent.parameters as { repo?: string } | undefined)?.repo === canary.repo
        ),
      { describe: "the canary bump to be dispatched", timeoutMs: 60_000, intervalMs: 200 }
    );

    expect(
      triggers.filter((t) => (t.intent.parameters as { repo?: string } | undefined)?.repo === repo)
    ).toHaveLength(0);
    expect(await bumpChangesFor(repo)).toHaveLength(0);
  }, 120_000);

  // 2b. ONE BUMP CHANGE PER (COMPONENT, MANIFEST) — the fixture whose absence hid a blocker

  /** A dependency line exists to be declared by many. See docs/dependencies.md §36. */
  it("two components subscribed to the SAME line each get their OWN change and their OWN dispatch", async () => {
    const first = await subscribedComponent();
    const second = await subscribedComponent({ lineId: first.lineId });
    expect(second.lineId).toBe(first.lineId);

    await advanceHead(first.lineId, "1.4.0");
    await relayHeadAdvance(first.lineId);

    for (const fixture of [first, second]) {
      await waitUntil(
        async () =>
          triggers.some(
            (t) => (t.intent.parameters as { repo?: string } | undefined)?.repo === fixture.repo
          ),
        {
          describe: `a bump dispatched for ${fixture.repo}`,
          timeoutMs: 60_000,
          intervalMs: 200
        }
      );
    }

    const firstChanges = await bumpChangesFor(first.repo);
    const secondChanges = await bumpChangesFor(second.repo);
    expect(firstChanges).toHaveLength(1);
    expect(secondChanges).toHaveLength(1);
    // TWO CHANGES, therefore two branches, two pull requests and two correlatable pushes. Sharing
    // one change here is what the bug did, and it is the assertion that fails when it comes back.
    expect(firstChanges[0]!.objectId).not.toBe(secondChanges[0]!.objectId);

    // Each change declares WHOSE bump it is — the field the lookup now compares, and the only place
    // the subject of a bump exists in a form that lookup can read.
    const claimOf = (row: (typeof firstChanges)[number]) =>
      (row.sourceRef as { scp_authored: Record<string, unknown> }).scp_authored;
    expect(claimOf(firstChanges[0]!).componentObjectId).toBe(first.componentObjectId);
    expect(claimOf(secondChanges[0]!).componentObjectId).toBe(second.componentObjectId);

    // ...and each dispatch names its own change, so neither component's runner authors onto the
    // other's branch.
    const intentFor = (repo: string) =>
      triggers.filter((t) => (t.intent.parameters as { repo?: string } | undefined)?.repo === repo);
    expect(intentFor(first.repo)[0]!.intent.parameters?.changeObjectId).toBe(
      firstChanges[0]!.objectId
    );
    expect(intentFor(second.repo)[0]!.intent.parameters?.changeObjectId).toBe(
      secondChanges[0]!.objectId
    );
  }, 120_000);

  /** The other half of the same key, not a defensive extra. See docs/dependencies.md §37. */
  it("one component declaring the SAME line from two manifests gets a change per manifest", async () => {
    const fixture = await subscribedComponent({
      manifestPaths: ["package.json", "services/api/package.json"]
    });
    await advanceHead(fixture.lineId, "1.4.0");
    await relayHeadAdvance(fixture.lineId);

    await waitUntil(async () => (await bumpChangesFor(fixture.repo)).length === 2, {
      describe: "a bump change per declared manifest",
      timeoutMs: 60_000,
      intervalMs: 200
    });
    const rows = await bumpChangesFor(fixture.repo);
    const claims = rows.map(
      (r) => (r.sourceRef as { scp_authored: Record<string, unknown> }).scp_authored
    );
    expect(claims.map((c) => c.manifestPath as string).sort()).toEqual([
      "package.json",
      "services/api/package.json"
    ]);
    expect(new Set(rows.map((r) => r.objectId)).size).toBe(2);

    // And both were actually dispatched — a change nobody triggers is the failure mode one layer up.
    const dispatched = triggers.filter(
      (t) => (t.intent.parameters as { repo?: string } | undefined)?.repo === fixture.repo
    );
    expect(
      new Set(
        dispatched.map((t) => (t.intent.parameters as { manifestPath?: string }).manifestPath)
      )
    ).toEqual(new Set(["package.json", "services/api/package.json"]));
  }, 120_000);

  /** An auto-merge's first dispatch is still a pull request. See docs/dependencies.md §38. */
  it("a subscription asking for auto_merge is DOWNGRADED to a pull request on its FIRST dispatch", async () => {
    const fixture = await subscribedComponent({ delivery: "auto_merge" });
    await advanceHead(fixture.lineId, "1.4.0");
    await relayHeadAdvance(fixture.lineId);

    const fired = await waitUntil(
      async () =>
        triggers.find(
          (t) => (t.intent.parameters as { repo?: string } | undefined)?.repo === fixture.repo
        ),
      { describe: "the auto_merge subscription's bump", timeoutMs: 60_000, intervalMs: 200 }
    );

    expect(fired.intent.parameters?.delivery).toBe("pull_request");
    const [change] = await bumpChangesFor(fixture.repo);
    const authored = (change!.sourceRef as { scp_authored: Record<string, unknown> }).scp_authored;
    expect(authored.delivery).toBe("pull_request");
    // NOT SILENTLY IGNORED: the change carries why the privileged option was declined, which is the
    // difference between a downgrade an operator can act on and one they cannot see.
    expect(String(authored.deliveryReason)).toMatch(/auto_merge was asked for/);
  }, 120_000);

  // 2b. THE AUTO-MERGE LINK — the SECOND look, driven through the real ingress and the real gate

  /** Every link of the chain; deleting any one fails this. See docs/dependencies.md §39. */
  describe("the auto-merge link (ADR-0032 §8c)", () => {
    /** A bound control plus a policy naming it, together. See docs/dependencies.md §40. */
    async function requireOwnChecks(
      componentObjectId: string,
      module = "github-check"
    ): Promise<string> {
      const controlObjectId = randomUUID();
      await inOrg((tx) =>
        upsertControlBinding(tx, {
          orgId: org.orgId,
          controlObjectId,
          pluginModule: module,
          pluginInstanceId: `ctl-${controlObjectId}`
        })
      );
      const slug = controlObjectId.slice(0, 8);
      await admin.policies.create({
        name: `ci-${slug}`,
        urn: `urn:scp:${org.orgId}:policy:ci-${slug}`,
        properties: {
          scope: { objectRef: componentObjectId },
          enforcement: "required",
          effects: [{ requireControls: [controlObjectId] }]
        }
      });
      return controlObjectId;
    }

    /** Persist a raw provider delivery exactly as `routes/change-sources.ts`'s webhook route does —
     *  that route is a plain INSERT (persist-then-PROCESS, DESIGN §8). */
    async function deliverGithubEvent(
      eventName: string,
      payload: Record<string, unknown>
    ): Promise<void> {
      const id = uuidv7();
      await inOrg((tx) =>
        tx.insert(changeSourceEvents).values({
          id,
          orgId: org.orgId,
          sourceKind: "github",
          signatureVerified: true,
          dedupeKey: `delivery-${id}`,
          headers: { "x-github-event": eventName },
          payload
        })
      );
      // The REAL processor, in the same transaction shape `coordination/reconcile.ts` uses.
      await inOrg((tx) => processChangeSourceEvents(tx, org.orgId));
    }

    const relayed = new Set<string>();

    /** Every not-yet-relayed `scp.dependency.bump_observed` outbox row for one bump change. */
    async function pendingObservedBumps(changeObjectId: string) {
      const rows = await inOrg((tx) =>
        tx
          .select()
          .from(outbox)
          .where(
            and(
              eq(outbox.orgId, org.orgId),
              eq(outbox.type, BUMP_OBSERVED_EVENT),
              eq(outbox.subject, changeObjectId)
            )
          )
      );
      return rows.filter((r) => !relayed.has(r.id));
    }

    /** Relay them, in exactly the job shape `events/outbox-relay.ts` puts on the domain-event
     *  queue — which is what makes the router, the queue and the worker real here. */
    async function relayObservedBumps(changeObjectId: string): Promise<number> {
      const rows = await pendingObservedBumps(changeObjectId);
      for (const row of rows) {
        relayed.add(row.id);
        await boss!.send(DOMAIN_EVENTS_QUEUE, {
          id: row.id,
          orgId: row.orgId,
          type: row.type,
          source: row.source,
          subject: row.subject,
          data: row.data
        });
      }
      return rows.length;
    }

    const BUMP_COMMIT = "abcdef12".repeat(5);

    /** The URL `@scp/plugin-github-check` records as its evidence — the ONLY field in a control run's
     *  evidence that says WHICH REPOSITORY the verdict is about, and therefore the one thing that
     *  binds "the component's own checks" to the component rather than to any repository containing
     *  the same commit object. */
    const ownChecksUrl = (repo: string) =>
      `https://api.github.com/repos/${repo}/commits/${BUMP_COMMIT}/check-runs`;

    /** Remove a component's standing delegation verdict over the ADMIN connection — see the caller
     *  for why this cannot (and must not be able to) go through the tenant pool. */
    async function eraseDelegationVerdict(componentObjectId: string): Promise<void> {
      const pool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 1 });
      try {
        await pool.query(
          `DELETE FROM decisions WHERE org_id = $1 AND kind = $2 AND subject_id = $3`,
          [org.orgId, DEPENDENCY_DELEGATION_DECISION_KIND, componentObjectId]
        );
      } finally {
        await pool.end();
      }
    }

    /** Author a bump the normal way, then bring its push back through the webhook — which is what
     *  records `scp_authored.headCommit` and makes evidence bindable at all. */
    async function authoredAndPushed(options?: { delivery?: "pull_request" | "auto_merge" }) {
      const fixture = await subscribedComponent({ delivery: options?.delivery ?? "auto_merge" });
      await advanceHead(fixture.lineId, "1.4.0");
      await relayHeadAdvance(fixture.lineId);
      const change = await waitUntil(async () => (await bumpChangesFor(fixture.repo))[0], {
        describe: "the bump change",
        timeoutMs: 60_000,
        intervalMs: 200
      });
      const authoredRef = `refs/heads/scp/dep-bump/${change.objectId}`;
      await deliverGithubEvent("push", {
        ref: authoredRef,
        after: BUMP_COMMIT,
        repository: { full_name: fixture.repo },
        head_commit: { id: BUMP_COMMIT, modified: ["package.json"] },
        commits: [{ id: BUMP_COMMIT, modified: ["package.json"] }]
      });

      // THE PUSH EMITS THE TRIGGER TOO, and that is asserted here rather than assumed: the emit is
      // at the ingress choke point, not per event kind, so the authored push produces an evaluation
      // exactly as the CI conclusion does.
      const fromPush = await pendingObservedBumps(change.objectId);
      expect(fromPush.length, "the authored push must emit an observed-bump event").toBeGreaterThan(
        0
      );
      // It is then CONSUMED WITHOUT BEING RELAYED. See docs/dependencies.md §41.
      for (const row of fromPush) relayed.add(row.id);

      return { fixture, changeObjectId: change.objectId, authoredRef };
    }

    /** The CI conclusion. GitHub's `workflow_run` carries `head_sha` and NO ref, which is exactly why
     *  `matchAuthoredBumpChange` needed a head-commit route — see its second half. */
    async function deliverCiConclusion(repo: string, commit = BUMP_COMMIT): Promise<void> {
      await deliverGithubEvent("workflow_run", {
        repository: { full_name: repo },
        workflow_run: { id: 4242, head_sha: commit, status: "completed", conclusion: "success" }
      });
    }

    function mergeIntentsFor(changeObjectId: string) {
      return triggers.filter(
        (t) =>
          (t.intent.parameters as { action?: string } | undefined)?.action === "merge" &&
          (t.intent.parameters as { changeObjectId?: string }).changeObjectId === changeObjectId
      );
    }

    it("runs the EXISTING governance gate for the bump change, against the bump's OWN commit, and merges", async () => {
      const { fixture, changeObjectId } = await authoredAndPushed();
      await requireOwnChecks(fixture.componentObjectId);
      // The checks went green for the bump's own commit. See docs/dependencies.md §42.
      controlOutcome = {
        status: "pass",
        evidence: { url: ownChecksUrl(fixture.repo), ref: BUMP_COMMIT, checkRuns: [] }
      };
      mergeRunPhase = "succeeded";

      await deliverCiConclusion(fixture.repo);
      expect(
        await relayObservedBumps(changeObjectId),
        "the CI conclusion must have emitted the trigger"
      ).toBe(1);

      const merge = await waitUntil(async () => mergeIntentsFor(changeObjectId)[0], {
        describe: "the merge intent for this bump",
        timeoutMs: 60_000,
        intervalMs: 200
      });

      // A real control ran, asked about the bump's own commit. See docs/dependencies.md §43.
      expect(
        controlEvaluations.filter((e) => e.changeId === changeObjectId).map((e) => e.commitSha)
      ).toContain(BUMP_COMMIT);
      // …and it left an ordinary `control_runs` row behind, which is what the grant reads.
      const runs = await inOrg((tx) => listControlRunsForChange(tx, org.orgId, changeObjectId));
      expect(runs.map((r) => r.status)).toContain("pass");

      // (2) THE MERGE INTENT NAMES THE EVIDENCED COMMIT, and carries no branch of its own — the
      //     plugin derives that from the change id, which is what stops this authority from becoming
      //     "merge whatever you are told to".
      expect(merge.intent.parameters).toMatchObject({
        action: "merge",
        repo: fixture.repo,
        baseBranch: "main",
        changeObjectId,
        expectedHeadCommit: BUMP_COMMIT,
        delivery: "auto_merge"
      });
      expect(Object.keys(merge.intent.parameters ?? {})).not.toContain("headBranch");
      expect(merge.intent.idempotencyKey).toBe(`${changeObjectId}:merge:${BUMP_COMMIT}`);

      // (3) THE VERDICT IS EXPLAINABLE. See docs/dependencies.md §44.
      const verdicts = await waitUntil(
        async () => {
          const found = await decisionsOfKind(DEPENDENCY_BUMP_MERGE_DECISION_KIND, changeObjectId);
          return found.length > 0 ? found : undefined;
        },
        { describe: "the dependency_bump_merge Decision for this change" }
      );
      expect(verdicts).toHaveLength(1);
      expect(verdicts[0]!.verdict).toBe("merged");
    }, 180_000);

    it("does NOT advance the bump change down the lifecycle — a bump is not a deployment", async () => {
      // Driving the change through `executing`/`validating` to make gates fire would coordinate a
      // release nobody asked for. The gate runs FOR the change; it never moves it.
      const { fixture, changeObjectId } = await authoredAndPushed();
      await requireOwnChecks(fixture.componentObjectId);
      controlOutcome = {
        status: "pass",
        evidence: { url: ownChecksUrl(fixture.repo), ref: BUMP_COMMIT }
      };
      mergeRunPhase = "succeeded";
      await deliverCiConclusion(fixture.repo);
      await relayObservedBumps(changeObjectId);
      await waitUntil(async () => mergeIntentsFor(changeObjectId)[0], {
        describe: "the merge intent",
        timeoutMs: 60_000,
        intervalMs: 200
      });
      const [row] = await inOrg((tx) =>
        tx.select().from(changes).where(eq(changes.objectId, changeObjectId))
      );
      expect(row?.state).toBe("proposed");
    }, 180_000);

    it("REFUSES to merge when the component's checks passed for a DIFFERENT commit", async () => {
      // Green somewhere else is not green here. Without the ref-equality check, `github-check`'s
      // operator-pinned `expectedRef` fallback means a control could report CI green FOR THE BASE
      // BRANCH and the bump would merge into it on exactly that evidence.
      const { fixture, changeObjectId } = await authoredAndPushed();
      await requireOwnChecks(fixture.componentObjectId);
      // The component's OWN repository, so the refusal below is about the COMMIT and nothing else
      // — a fixture that also got the repository wrong would refuse for two reasons and prove one.
      controlOutcome = {
        status: "pass",
        evidence: { url: ownChecksUrl(fixture.repo), ref: "deadbeef".repeat(5) }
      };
      await deliverCiConclusion(fixture.repo);
      await relayObservedBumps(changeObjectId);

      const verdicts = await waitUntil(
        async () => {
          const found = await decisionsOfKind(DEPENDENCY_BUMP_MERGE_DECISION_KIND, changeObjectId);
          return found.length > 0 ? found : undefined;
        },
        { describe: "the withheld verdict", timeoutMs: 60_000, intervalMs: 200 }
      );
      expect(verdicts[0]!.verdict).toBe("withheld");
      expect((verdicts[0]!.inputContext as { refusal?: string }).refusal).toBe("not_evidenced");
      // THE REASON, not just the refusal code — otherwise this test would stay green with the
      // governance gate deleted entirely, since "no control ran at all" refuses under the same code.
      // What is being pinned is that a control DID run and its evidence named another commit.
      expect(String((verdicts[0]!.reasonTree as { summary?: string }).summary)).toMatch(
        /other than the bump's own head/
      );
      // BOUND TO THIS CHANGE, not merely to the shared commit constant: every test in this block
      // uses the same `BUMP_COMMIT`, so an assertion over the commit alone was satisfied by any
      // earlier test's evaluation.
      expect(
        controlEvaluations.filter((e) => e.changeId === changeObjectId).map((e) => e.commitSha)
      ).toContain(BUMP_COMMIT);
      expect(mergeIntentsFor(changeObjectId)).toHaveLength(0);
    }, 180_000);

    /** The checks must bind to the component's repository. See docs/dependencies.md §45. */
    it("REFUSES to merge when the passing own-check evidence names a DIFFERENT repository", async () => {
      const { fixture, changeObjectId } = await authoredAndPushed();
      await requireOwnChecks(fixture.componentObjectId);
      // Right module, right status, RIGHT COMMIT — and a repository that is not this component's.
      controlOutcome = {
        status: "pass",
        evidence: {
          url: `https://api.github.com/repos/someone-else/fork/commits/${BUMP_COMMIT}/check-runs`,
          ref: BUMP_COMMIT
        }
      };
      await deliverCiConclusion(fixture.repo);
      await relayObservedBumps(changeObjectId);

      const verdicts = await waitUntil(
        async () => {
          const found = await decisionsOfKind(DEPENDENCY_BUMP_MERGE_DECISION_KIND, changeObjectId);
          return found.length > 0 ? found : undefined;
        },
        { describe: "the withheld verdict", timeoutMs: 60_000, intervalMs: 200 }
      );
      expect(verdicts[0]!.verdict).toBe("withheld");
      expect((verdicts[0]!.inputContext as { refusal?: string }).refusal).toBe("not_evidenced");
      // THE REASON, not just the code: "no control ran at all" refuses under the same code, so
      // without this the test would stay green with the whole repository binding deleted.
      expect(String((verdicts[0]!.reasonTree as { summary?: string }).summary)).toMatch(
        /cannot be attributed to '.*'/
      );
      expect(mergeIntentsFor(changeObjectId)).toHaveLength(0);
    }, 180_000);

    it("REFUSES to merge when the org's policies name no required control at all", async () => {
      // ABSENCE IS NEVER PERMISSION. No control is declared, so the gate deposits nothing, so
      // nothing has evidenced the component's own checks — and the bump stays a pull request.
      const { fixture, changeObjectId } = await authoredAndPushed();
      controlOutcome = {
        status: "pass",
        evidence: { url: ownChecksUrl(fixture.repo), ref: BUMP_COMMIT }
      };
      await deliverCiConclusion(fixture.repo);
      await relayObservedBumps(changeObjectId);

      const verdicts = await waitUntil(
        async () => {
          const found = await decisionsOfKind(DEPENDENCY_BUMP_MERGE_DECISION_KIND, changeObjectId);
          return found.length > 0 ? found : undefined;
        },
        { describe: "the withheld verdict", timeoutMs: 60_000, intervalMs: 200 }
      );
      expect(verdicts[0]!.verdict).toBe("withheld");
      expect(String((verdicts[0]!.reasonTree as { summary?: string }).summary)).toMatch(
        /absent never means passed/
      );
      expect(mergeIntentsFor(changeObjectId)).toHaveLength(0);
    }, 180_000);

    it("REFUSES to merge a bump whose subscription resolves to pull_request, however green CI is", async () => {
      const { fixture, changeObjectId } = await authoredAndPushed({ delivery: "pull_request" });
      await requireOwnChecks(fixture.componentObjectId);
      controlOutcome = {
        status: "pass",
        evidence: { url: ownChecksUrl(fixture.repo), ref: BUMP_COMMIT }
      };
      await deliverCiConclusion(fixture.repo);
      await relayObservedBumps(changeObjectId);

      const verdicts = await waitUntil(
        async () => {
          const found = await decisionsOfKind(DEPENDENCY_BUMP_MERGE_DECISION_KIND, changeObjectId);
          return found.length > 0 ? found : undefined;
        },
        { describe: "the withheld verdict", timeoutMs: 60_000, intervalMs: 200 }
      );
      expect((verdicts[0]!.inputContext as { refusal?: string }).refusal).toBe(
        "subscription_is_pull_request"
      );
      // …and the gate was not even run for it: a bump that cannot merge does not pay for a control
      // plugin call against a real provider.
      expect(mergeIntentsFor(changeObjectId)).toHaveLength(0);
    }, 180_000);

    it("reports a provider merge REFUSAL honestly rather than recording a merge that did not happen", async () => {
      const { fixture, changeObjectId } = await authoredAndPushed();
      await requireOwnChecks(fixture.componentObjectId);
      controlOutcome = {
        status: "pass",
        evidence: { url: ownChecksUrl(fixture.repo), ref: BUMP_COMMIT }
      };
      // Branch protection, a required review, a check that went red between the gate and now.
      mergeRunPhase = "failed";
      await deliverCiConclusion(fixture.repo);
      await relayObservedBumps(changeObjectId);

      const verdicts = await waitUntil(
        async () => {
          const found = await decisionsOfKind(DEPENDENCY_BUMP_MERGE_DECISION_KIND, changeObjectId);
          return found.length > 0 ? found : undefined;
        },
        { describe: "the merge verdict", timeoutMs: 60_000, intervalMs: 200 }
      );
      // The intent WAS dispatched — this is not a refusal to try — but the recorded verdict is what
      // actually happened, taken from `status()` rather than from the fact that a dispatch was made.
      expect(mergeIntentsFor(changeObjectId)).toHaveLength(1);
      expect(verdicts[0]!.verdict).toBe("withheld");
      expect((verdicts[0]!.inputContext as { refusal?: string }).refusal).toBe("merge_refused");
      mergeRunPhase = "succeeded";
    }, 180_000);

    it("REFUSES to merge when NO conclusive delegation probe is on record — absence is not evidence", async () => {
      // Stricter here than at the authoring seam, deliberately. See docs/dependencies.md §46.
      const { fixture, changeObjectId } = await authoredAndPushed();
      await requireOwnChecks(fixture.componentObjectId);
      controlOutcome = {
        status: "pass",
        evidence: { url: ownChecksUrl(fixture.repo), ref: BUMP_COMMIT }
      };
      // Erase the allow verdict the probe itself recorded. See docs/dependencies.md §47.
      await eraseDelegationVerdict(fixture.componentObjectId);

      await deliverCiConclusion(fixture.repo);
      await relayObservedBumps(changeObjectId);
      const verdicts = await waitUntil(
        async () => {
          const found = await decisionsOfKind(DEPENDENCY_BUMP_MERGE_DECISION_KIND, changeObjectId);
          return found.length > 0 ? found : undefined;
        },
        { describe: "the withheld verdict", timeoutMs: 60_000, intervalMs: 200 }
      );
      expect((verdicts[0]!.inputContext as { refusal?: string }).refusal).toBe(
        "no_delegation_verdict"
      );
      expect(mergeIntentsFor(changeObjectId)).toHaveLength(0);
    }, 180_000);

    /** A bump naming another repository merges nothing. See docs/dependencies.md §48. */
    it("a FORGED bump change written through POST /changes merges nothing, whatever its source_ref claims", async () => {
      const victim = await subscribedComponent({ delivery: "auto_merge" });
      // THE FORGER CHOOSES THE ID, because `POST /api/v1/changes` accepts one — which is what lets
      // the fabricated `scp_authored.ref` name the very change it is on, exactly as SCP's own
      // derivation would.
      const forgedId = randomUUID();
      const claimed = {
        componentObjectId: victim.componentObjectId,
        lineId: victim.lineId,
        repo: victim.repo,
        ref: `refs/heads/scp/dep-bump/${forgedId}`,
        baseBranch: "main",
        ecosystem: "npm",
        coordinate: "@acme/lib",
        manifestPath: "package.json",
        fromVersion: "^1.2.3",
        toVersion: "^1.4.0",
        headCommit: BUMP_COMMIT,
        delivery: "auto_merge"
      };
      await admin.changes.propose({
        id: forgedId,
        name: `forged-bump-${forgedId.slice(0, 8)}`,
        sourceKind: BUMP_SOURCE_KIND,
        targets: [victim.componentObjectId],
        sourceRef: { repo: victim.repo, commit_sha: BUMP_COMMIT, scp_authored: claimed }
      });

      // THE READABLE CLAIM IS PRESENT AND WELL-FORMED, so this test is not passing because the
      // forgery was malformed: every field the merge path used to read is exactly where it read it,
      // spelled the way SCP spells it.
      const [row] = await inOrg((tx) =>
        tx.select().from(changes).where(eq(changes.objectId, forgedId))
      );
      const stored = (row!.sourceRef as { scp_authored: Record<string, unknown> }).scp_authored;
      expect(stored.repo).toBe(victim.repo);
      expect(stored.ref).toBe(`refs/heads/scp/dep-bump/${forgedId}`);
      expect(stored.headCommit).toBe(BUMP_COMMIT);

      const outcome = await runBumpGateJob(gateDeps(), {
        orgId: org.orgId,
        changeObjectId: forgedId
      });

      expect(outcome.merged).toBe(false);
      expect(outcome.refusal).toBe("no_authored_claim");
      // NOT MERELY UNMERGED: no merge intent was dispatched at all, so no credential was minted and
      // no provider was reached for a repository nobody proved was SCP's to touch.
      expect(mergeIntentsFor(forgedId)).toHaveLength(0);
      expect(triggers).toHaveLength(0);
    }, 180_000);

    /** The audit trail must not lie about the one merge. See docs/dependencies.md §49. */
    it("a SECOND observed event after a successful merge does not overwrite the merged verdict", async () => {
      const { fixture, changeObjectId } = await authoredAndPushed();
      await requireOwnChecks(fixture.componentObjectId);
      controlOutcome = {
        status: "pass",
        evidence: { url: ownChecksUrl(fixture.repo), ref: BUMP_COMMIT }
      };
      mergeRunPhase = "succeeded";

      await deliverCiConclusion(fixture.repo);
      await relayObservedBumps(changeObjectId);
      await waitUntil(
        async () => {
          const found = await decisionsOfKind(DEPENDENCY_BUMP_MERGE_DECISION_KIND, changeObjectId);
          return found.some((d) => d.verdict === "merged") ? found : undefined;
        },
        { describe: "the merged verdict", timeoutMs: 60_000, intervalMs: 200 }
      );
      const mergesDispatched = mergeIntentsFor(changeObjectId).length;

      // THE MERGE'S OWN AFTERMATH: another event about the same bump, exactly as the merge commit's
      // push or the base branch's CI would deliver.
      const second = await runBumpGateJob(gateDeps(), {
        orgId: org.orgId,
        changeObjectId
      });
      expect(second.merged).toBe(true);
      expect(second.refusal).toBeUndefined();
      expect(second.detail).toMatch(/already merged/);

      // NOTHING WAS RE-DISPATCHED, so no doomed merge and no refusal to record.
      expect(mergeIntentsFor(changeObjectId)).toHaveLength(mergesDispatched);
      // AND THE LATEST WORD ON THIS BUMP IS STILL THAT IT MERGED.
      const verdicts = await decisionsOfKind(DEPENDENCY_BUMP_MERGE_DECISION_KIND, changeObjectId);
      const latest = [...verdicts]
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .at(-1);
      expect(latest?.verdict).toBe("merged");
    }, 180_000);

    /** TWO CONCURRENT JOBS, TWO PLUGIN-INSTANCE NAMESPACES. See docs/dependencies.md §50. */
    it("the authoring job and the merge job do NOT share a plugin-instance id", async () => {
      const { fixture, changeObjectId } = await authoredAndPushed();
      await requireOwnChecks(fixture.componentObjectId);
      controlOutcome = {
        status: "pass",
        evidence: { url: ownChecksUrl(fixture.repo), ref: BUMP_COMMIT }
      };
      mergeRunPhase = "succeeded";
      await deliverCiConclusion(fixture.repo);
      await relayObservedBumps(changeObjectId);
      await waitUntil(async () => mergeIntentsFor(changeObjectId)[0], {
        describe: "the merge intent",
        timeoutMs: 60_000,
        intervalMs: 200
      });

      const dep = startedInstances.filter((id) => id.startsWith("managed-dep:"));
      // Both jobs ran against this component in this test, so both ids are here...
      expect(new Set(dep).size).toBeGreaterThan(1);
      // ...and every one of them is unique, so no `finally` can reach another run's subprocess.
      expect(new Set(dep).size).toBe(dep.length);
      // They still name the SAME binding — the namespace is per RUN, not per component, so the
      // credential and config resolution are unchanged.
      const bindingOf = (id: string) => id.split(":")[1];
      expect(new Set(dep.map(bindingOf)).size).toBe(1);
    }, 180_000);

    /** The operator's container runtime reaches this runner. See docs/dependencies.md §51. */
    /** Widened from one field to the whole launcher slice. See docs/dependencies.md §52. */
    it("hands the operator's container runtime AND launcher selection to the runner it starts", async () => {
      const saved = {
        binary: process.env.SCP_MANAGED_RUNNER_DOCKER_BINARY,
        launcher: process.env.SCP_MANAGED_RUNNER_LAUNCHER,
        ns: process.env.SCP_MANAGED_RUNNER_K8S_NAMESPACE,
        root: process.env.SCP_MANAGED_RUNNER_K8S_WORKSPACE_ROOT,
        claim: process.env.SCP_MANAGED_RUNNER_K8S_WORKSPACE_CLAIM
      };
      process.env.SCP_MANAGED_RUNNER_DOCKER_BINARY = "/usr/bin/operator-chosen-runtime";
      process.env.SCP_MANAGED_RUNNER_LAUNCHER = "kubernetes";
      process.env.SCP_MANAGED_RUNNER_K8S_NAMESPACE = "operator-chosen-namespace";
      process.env.SCP_MANAGED_RUNNER_K8S_WORKSPACE_ROOT = "/operator-chosen-workspace";
      process.env.SCP_MANAGED_RUNNER_K8S_WORKSPACE_CLAIM = "operator-chosen-claim";
      try {
        await authoredAndPushed();

        const dep = startedConfigs.filter((i) => i.id.startsWith("managed-dep:"));
        // Non-vacuity: an empty list would make the loop below assert nothing at all.
        expect(dep.length).toBeGreaterThan(0);
        for (const started of dep) {
          expect(
            started.config.dockerBinary,
            `${started.id} was started with a runtime the operator did not choose`
          ).toBe("/usr/bin/operator-chosen-runtime");
          expect(
            started.config.runnerLauncher,
            `${started.id} was started on a launcher the operator did not choose`
          ).toBe("kubernetes");
          expect(
            (started.config.kubernetes as { namespace?: string } | undefined)?.namespace,
            `${started.id} carries no Kubernetes settings, so its runner has nowhere to launch`
          ).toBe("operator-chosen-namespace");
        }
      } finally {
        const restore = (key: string, value: string | undefined): void => {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        };
        restore("SCP_MANAGED_RUNNER_DOCKER_BINARY", saved.binary);
        restore("SCP_MANAGED_RUNNER_LAUNCHER", saved.launcher);
        restore("SCP_MANAGED_RUNNER_K8S_NAMESPACE", saved.ns);
        restore("SCP_MANAGED_RUNNER_K8S_WORKSPACE_ROOT", saved.root);
        restore("SCP_MANAGED_RUNNER_K8S_WORKSPACE_CLAIM", saved.claim);
      }
    }, 180_000);

    /** A refusal raised in phase four carries a decision id. See docs/dependencies.md §53. */
    it("records a Decision when the merge DISPATCH itself fails, not just when the provider refuses", async () => {
      const { fixture, changeObjectId } = await authoredAndPushed();
      await requireOwnChecks(fixture.componentObjectId);
      controlOutcome = {
        status: "pass",
        evidence: { url: ownChecksUrl(fixture.repo), ref: BUMP_COMMIT }
      };

      // The deployment-level "managed execution is never a default" refusal (ADR-0006), reached
      // AFTER the grant — which is exactly the ordering that produced no record.
      const image = process.env.SCP_MANAGED_DEP_RUNNER_IMAGE;
      delete process.env.SCP_MANAGED_DEP_RUNNER_IMAGE;
      let outcome;
      try {
        outcome = await runBumpGateJob(gateDeps(), { orgId: org.orgId, changeObjectId });
      } finally {
        process.env.SCP_MANAGED_DEP_RUNNER_IMAGE = image;
      }

      expect(outcome.merged).toBe(false);
      expect(outcome.refusal).toBe("merge_dispatch_failed");
      const verdicts = await decisionsOfKind(DEPENDENCY_BUMP_MERGE_DECISION_KIND, changeObjectId);
      const latest = [...verdicts]
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .at(-1);
      expect(latest?.verdict).toBe("withheld");
      expect((latest?.inputContext as { refusal?: string }).refusal).toBe("merge_dispatch_failed");
      expect(String((latest?.reasonTree as { summary?: string }).summary)).toMatch(
        /SCP_MANAGED_DEP_RUNNER_IMAGE/
      );
    }, 180_000);

    it("the CI event ATTACHES to the bump instead of minting a second, unrelated change", async () => {
      // ADR-0032 §9, reached through a different event than §9 anticipated: `workflow_run` names no
      // ref, so without the head-commit correlation route it would match the component's ordinary
      // source mapping and propose a second change for a release that already has one.
      const { fixture, changeObjectId } = await authoredAndPushed();
      await admin.changeSources.createMapping("github", {
        repoPattern: fixture.repo,
        component: fixture.componentObjectId
      });
      const before = await inOrg((tx) =>
        tx.select({ id: changes.objectId }).from(changes).where(eq(changes.orgId, org.orgId))
      );
      await deliverCiConclusion(fixture.repo);
      const after = await inOrg((tx) =>
        tx.select({ id: changes.objectId }).from(changes).where(eq(changes.orgId, org.orgId))
      );
      expect(after.length).toBe(before.length);
      // …and the delivery was marked processed AGAINST THE BUMP CHANGE.
      const [event] = await inOrg((tx) =>
        tx
          .select()
          .from(changeSourceEvents)
          .where(
            and(
              eq(changeSourceEvents.orgId, org.orgId),
              eq(changeSourceEvents.resultingChangeObjectId, changeObjectId)
            )
          )
          .orderBy(desc(changeSourceEvents.createdAt))
      );
      expect(event?.processedAt).not.toBeNull();
    }, 180_000);

    // The freeze, and the one act that merges into a repo. See docs/dependencies.md §54.
    describe("M25.8 a change freeze and the dependency actuator (owner decision D8)", () => {
      const runGate = (changeObjectId: string) =>
        runBumpGateJob(gateDeps(), { orgId: org.orgId, changeObjectId });

      /** An org-tier freeze in force right now, authored through the repo the shipped route writes
       *  through. The DOOR is M25.1's subject and is tested there; what is under test here is
       *  whether the bump path reads the row at all. */
      const orgFreeze = (scopeObjectId: string, name: string) =>
        inOrg((tx) =>
          createFreeze(tx, {
            orgId: org.orgId,
            scopeObjectId,
            name,
            startsAt: new Date(Date.now() - 60_000),
            endsAt: new Date(Date.now() + 3_600_000),
            reason: `${name}: M25.8 integration fixture`,
            createdByActorId: SYSTEM_ACTOR_ID
          })
        );

      const lift = (id: string) =>
        inOrg((tx) =>
          liftFreeze(tx, {
            orgId: org.orgId,
            id,
            reason: "M25.8 fixture cleanup",
            actorObjectId: SYSTEM_ACTOR_ID
          })
        );

      /** A bump that is authored, pushed, and EVIDENCED GREEN. See docs/dependencies.md §55. */
      async function greenBump() {
        const { fixture, changeObjectId } = await authoredAndPushed();
        await requireOwnChecks(fixture.componentObjectId);
        controlOutcome = {
          status: "pass",
          evidence: { url: ownChecksUrl(fixture.repo), ref: BUMP_COMMIT, checkRuns: [] }
        };
        mergeRunPhase = "succeeded";
        return { fixture, changeObjectId };
      }

      async function mergeDecisions(changeObjectId: string) {
        return decisionsOfKind(DEPENDENCY_BUMP_MERGE_DECISION_KIND, changeObjectId);
      }

      /** The `freezes` array a refusal Decision carries, as `bump-merge-freeze.ts` projects it. */
      function frozenContext(row: { inputContext: unknown }) {
        const ctx = row.inputContext as {
          refusal?: string;
          freezes?: { id: string; tier: string; scopeObjectId: string | null; endsAt: string }[];
        };
        return ctx;
      }

      it("THE CONTROL: with NO freeze standing, this exact fixture MERGES", async () => {
        // Without this case every refusal below is satisfied by an implementation that refuses
        // unconditionally — including the one a careless mutation would produce. It is the case
        // that makes the others mean "the freeze did it".
        const { changeObjectId } = await greenBump();

        const outcome = await runGate(changeObjectId);

        expect(outcome.merged, outcome.detail).toBe(true);
        expect(outcome.refusal).toBeUndefined();
        expect(mergeIntentsFor(changeObjectId)).toHaveLength(1);
      }, 180_000);

      it("an active ORG freeze blocks the auto-merge — and the pull request is still OPEN", async () => {
        const { fixture, changeObjectId } = await greenBump();
        const opened = openedPullRequests.get(changeObjectId);
        expect(opened, "the authoring run must have opened a pull request").toBeDefined();

        // Declared at the org root, not at the component. See docs/dependencies.md §56.
        const rootId = await inOrg((tx) => getOrgRootObjectId(tx, org.orgId));
        const freeze = await orgFreeze(rootId, "m25-8-org-root");
        try {
          const outcome = await runGate(changeObjectId);

          // (1) THE MERGE IS WITHHELD, under its OWN cause. `not_evidenced` would be the opposite
          //     claim — that the checks have not proven the bump safe. They have; the org has said
          //     nothing lands right now.
          expect(outcome.merged).toBe(false);
          expect(outcome.refusal).toBe("frozen");
          expect(outcome.refusal).not.toBe("not_evidenced");
          // (2) AND NOTHING WAS HANDED TO THE PROVIDER. The refusal is a call not made, not a call
          //     made and reported as refused — `mergeIntentsFor` reads what actually reached the
          //     plugin host, so this cannot be satisfied by a verdict string.
          expect(mergeIntentsFor(changeObjectId)).toHaveLength(0);

          // (3) D8's OTHER HALF: the pull request is open, still carries the number and URL the
          //     provider returned, and is NOT stamped merged. The work stays visible and queued,
          //     which is the value of the subscription the freeze must not destroy.
          const authorship = await inOrg((tx) => readBumpAuthorship(tx, org.orgId, changeObjectId));
          expect(authorship?.pullRequestNumber).toBe(opened!.number);
          expect(authorship?.pullRequestUrl).toBe(
            `https://gitea.dc1.internal/${fixture.repo}/pulls/${opened!.number}`
          );
          expect(authorship?.mergedAt ?? null).toBeNull();
        } finally {
          await lift(freeze.id);
        }
      }, 180_000);

      it("the refusal is a RESOLVABLE Decision carrying the freeze's endsAt and NEVER the clock", async () => {
        const { changeObjectId } = await greenBump();
        const rootId = await inOrg((tx) => getOrgRootObjectId(tx, org.orgId));
        const freeze = await orgFreeze(rootId, "m25-8-decision");
        try {
          const before = new Date();
          await runGate(changeObjectId);

          const rows = await mergeDecisions(changeObjectId);
          expect(rows).toHaveLength(1);
          expect(rows[0]!.verdict).toBe("withheld");
          // RESOLVABLE: the Decision has an id a blocked response can carry (charter principle 6),
          // and it is about THIS change.
          expect(rows[0]!.id).toBeTruthy();
          expect(rows[0]!.subjectId).toBe(changeObjectId);

          const ctx = frozenContext(rows[0]!);
          expect(ctx.refusal).toBe("frozen");
          expect(ctx.freezes).toHaveLength(1);
          const [recorded] = ctx.freezes!;
          expect(recorded!.id).toBe(freeze.id);
          expect(recorded!.tier).toBe("org");
          expect(recorded!.scopeObjectId).toBe(rootId);

          // THE BOUNDARY, NOT THE CLOCK — spelled against the freeze's OWN `ends_at`.
          expect(recorded!.endsAt).toBe(freeze.endsAt.toISOString());
          // Stated the other way too, for the same reason. See docs/dependencies.md §57.
          const window = { from: before.getTime() - 5_000, to: Date.now() + 5_000 };
          for (const value of JSON.stringify(rows[0]!.inputContext).match(
            /"[^"]*\d{4}-\d{2}-\d{2}T[^"]*"/g
          ) ?? []) {
            const instant = Date.parse(JSON.parse(value) as string);
            expect(
              Number.isNaN(instant) || instant < window.from || instant > window.to,
              `the refusal context recorded ${value}, an instant from around evaluation time — the ` +
                `window boundary is the only timestamp that may appear here`
            ).toBe(true);
          }
        } finally {
          await lift(freeze.id);
        }
      }, 180_000);

      it("DEDUP: with the freeze standing, three further attempts write EXACTLY ONE Decision", async () => {
        const { changeObjectId } = await greenBump();
        const rootId = await inOrg((tx) => getOrgRootObjectId(tx, org.orgId));
        const freeze = await orgFreeze(rootId, "m25-8-dedup");
        try {
          // FOUR evaluations of the same standing refusal. In production this path is re-entered on
          // every provider event about the bump's branch for the whole length of the window, which
          // is precisely the repeat-evaluation shape the 1.44 GB/day bill was run up on.
          for (let attempt = 0; attempt < 4; attempt += 1) {
            const outcome = await runGate(changeObjectId);
            expect(outcome.refusal, `attempt ${attempt}`).toBe("frozen");
          }

          const rows = await mergeDecisions(changeObjectId);
          expect(
            rows,
            "a standing freeze must restate itself, not re-record itself, on every attempt"
          ).toHaveLength(1);
        } finally {
          await lift(freeze.id);
        }
      }, 240_000);

      it("a PLATFORM-tier freeze blocks the auto-merge too — the tier no tenant can author or lift", async () => {
        const { changeObjectId } = await greenBump();
        const key = `m25-8-bump-${randomUUID().slice(0, 8)}`;

        // Deployment-wide, and that is forced rather than chosen. See docs/dependencies.md §58.
        await admin.instanceFreezes.put(
          key,
          {
            startsAt: new Date(Date.now() - 60_000).toISOString(),
            endsAt: new Date(Date.now() + 3_600_000).toISOString(),
            reason: `${key}: M25.8 platform-tier integration fixture`,
            match: { allEnvironments: true }
          },
          OPERATOR_TOKEN
        );
        try {
          const outcome = await runGate(changeObjectId);

          expect(outcome.merged).toBe(false);
          expect(outcome.refusal).toBe("frozen");
          expect(mergeIntentsFor(changeObjectId)).toHaveLength(0);

          // THE TIER IS NAMED IN THE REFUSAL, and it has to be: the two tiers are lifted through
          // different doors by different principals, so an operator reading this needs to know
          // which one they hold. `scopeObjectId` is null because no object id in an org's
          // containment chain names anything at the instance tier.
          const rows = await mergeDecisions(changeObjectId);
          expect(rows).toHaveLength(1);
          const ctx = frozenContext(rows[0]!);
          expect(ctx.freezes!.map((f) => f.tier)).toEqual(["platform"]);
          expect(ctx.freezes![0]!.scopeObjectId).toBeNull();
          expect(ctx.freezes![0]!.endsAt).toBeTruthy();
        } finally {
          // LIFTED IN A `finally`, AND THIS IS NOT TIDINESS. `instance_freezes` carries no
          // `org_id`, so a live row here is in force for every other test in this FILE (integration
          // isolation is per file). Leaving it standing would silently freeze the rest of the suite
          // and read as flake.
          await admin.instanceFreezes.lift(key, { reason: "M25.8 cleanup" }, OPERATOR_TOKEN);
        }
      }, 180_000);

      it("when the freeze is LIFTED, the very next attempt MERGES — pull requests accumulate and land when the window closes", async () => {
        const { changeObjectId } = await greenBump();
        const rootId = await inOrg((tx) => getOrgRootObjectId(tx, org.orgId));
        const freeze = await orgFreeze(rootId, "m25-8-lifts");

        const held = await runGate(changeObjectId);
        expect(held.refusal).toBe("frozen");
        expect(mergeIntentsFor(changeObjectId)).toHaveLength(0);

        await lift(freeze.id);

        // NOTHING ELSE CHANGED — same change, same commit, same evidence, same gate call. The only
        // difference is that the freeze is no longer in force, so this is the case that a "refuse
        // always" implementation cannot pass and that pins the refusal as temporary rather than
        // terminal.
        const after = await runGate(changeObjectId);
        expect(after.merged, after.detail).toBe(true);
        expect(after.refusal).toBeUndefined();
        expect(mergeIntentsFor(changeObjectId)).toHaveLength(1);

        // …and the LATEST verdict says it merged, rather than the refusal outliving the merge.
        const rows = await mergeDecisions(changeObjectId);
        expect(rows.map((r) => r.verdict)).toContain("merged");
      }, 240_000);

      it("the AUTHORING dispatch is DOWNGRADED, not refused: the pull request is still authored and the auto-merge TAIL is withheld", async () => {
        // The other act named merge, in a different file. See docs/dependencies.md §59.
        const { fixture, changeObjectId } = await greenBump();
        const bumpIntents = () =>
          triggers.filter(
            (t) =>
              (t.intent.parameters as { action?: string } | undefined)?.action === "bump" &&
              (t.intent.parameters as { repo?: string }).repo === fixture.repo
          );
        expect(bumpIntents(), "the authoring dispatch").toHaveLength(1);

        const rootId = await inOrg((tx) => getOrgRootObjectId(tx, org.orgId));
        const freeze = await orgFreeze(rootId, "m25-8-dispatch");

        // The gate runs and refuses. See docs/dependencies.md §60.
        expect((await runGate(changeObjectId)).refusal).toBe("frozen");
        const runs = await inOrg((tx) => listControlRunsForChange(tx, org.orgId, changeObjectId));
        expect(
          runs.map((r) => r.status),
          "the gate must have deposited passing evidence"
        ).toContain("pass");

        // A REDELIVERED HEAD ADVANCE — the same at-least-once redelivery pinned elsewhere in this
        // file, now landing on a bump that HAS evidence and HAS a recorded head commit.
        await relayHeadAdvance(fixture.lineId);
        await waitUntil(async () => (bumpIntents().length >= 2 ? true : undefined), {
          describe: "the redelivered advance to reach the dispatcher while the freeze stands",
          timeoutMs: 60_000,
          intervalMs: 200
        });

        // WITHHELD: the trigger FIRED (the branch and pull request are still authored — D8), and it
        // carries the delivery that makes `publishBump` return before its auto-merge tail, with no
        // merge precondition to merge against.
        const whileFrozen = bumpIntents()[1]!.intent.parameters as Record<string, unknown>;
        expect(whileFrozen.delivery).toBe("pull_request");
        expect(Object.keys(whileFrozen)).not.toContain("expectedHeadCommit");

        // THE CONTROL, IN THE SAME FLOW AND ON THE SAME CHANGE. Lift the freeze, change nothing
        // else, redeliver again — and the identical dispatch now grants `auto_merge` and carries
        // the precondition. Without this half, the assertion above is satisfied by a build in which
        // this path could never resolve `auto_merge` in the first place.
        await lift(freeze.id);
        await relayHeadAdvance(fixture.lineId);
        await waitUntil(async () => (bumpIntents().length >= 3 ? true : undefined), {
          describe: "the redelivered advance to reach the dispatcher once the freeze is lifted",
          timeoutMs: 60_000,
          intervalMs: 200
        });

        const whenClear = bumpIntents()[2]!.intent.parameters as Record<string, unknown>;
        expect(whenClear.delivery).toBe("auto_merge");
        expect(whenClear.expectedHeadCommit).toBe(BUMP_COMMIT);
      }, 240_000);

      // The producer of the next attempt, driven differently. See docs/dependencies.md §61.

      it("the LIFT alone MERGES it: the SWEEP schedules the attempt no provider event would", async () => {
        const { changeObjectId } = await greenBump();
        const rootId = await inOrg((tx) => getOrgRootObjectId(tx, org.orgId));
        const freeze = await orgFreeze(rootId, "m25-8-redrive");
        let lifted = false;
        try {
          // The refusal production would take when CI concludes inside the window — and ALSO what
          // makes this bump a candidate at all, since the sweep is keyed on the latest Decision.
          expect((await runGate(changeObjectId)).refusal).toBe("frozen");
          expect(mergeIntentsFor(changeObjectId)).toHaveLength(0);

          // THE OPERATOR LIFTS IT, AND THAT IS THE ONLY THING THAT HAPPENS. No push, no
          // `workflow_run`, no relayed outbox row — asserted rather than assumed, because "the next
          // attempt merges it" is only a promise if something other than the provider produces one.
          await lift(freeze.id);
          lifted = true;
          expect(
            await pendingObservedBumps(changeObjectId),
            "lifting a freeze must emit no provider event — if it did, this case would be proving " +
              "the pre-existing webhook path rather than the sweep"
          ).toHaveLength(0);

          const outcome = await runBumpFreezeRedriveSweep(boss!, server.deps.db);
          expect(
            outcome.candidates,
            "the sweep must recognise a bump whose latest verdict is a `frozen` refusal"
          ).toContain(changeObjectId);
          expect(outcome.enqueued).toContain(changeObjectId);

          // AND THE ENQUEUE IS REAL WORK, NOT A RETURN VALUE. See docs/dependencies.md §62.
          const merged = await waitUntil(
            async () => {
              const row = await inOrg((tx) => readBumpAuthorship(tx, org.orgId, changeObjectId));
              return row?.mergedAt ? row : undefined;
            },
            {
              describe:
                "the swept bump to reach the gate worker and be stamped merged — the whole point " +
                "of M25.8b: with no producer, a freeze-withheld bump is stranded for ever",
              timeoutMs: 90_000,
              intervalMs: 250
            }
          );
          expect(merged.mergedAt).toBeTruthy();
          // …and it reached the PROVIDER: one merge intent, addressed to this change.
          expect(mergeIntentsFor(changeObjectId)).toHaveLength(1);
          // …and the latest word on the bump says so, rather than the refusal outliving the merge.
          const rows = await mergeDecisions(changeObjectId);
          expect(rows.map((r) => r.verdict)).toContain("merged");
        } finally {
          if (!lifted) await lift(freeze.id);
        }
      }, 240_000);

      it("THE CONTROL: while the freeze still STANDS, the sweep enqueues nothing for that bump", async () => {
        // Without this case the one above is satisfied by a sweep that enqueues every candidate
        // unconditionally — which would re-enter the gate, and therefore RUN THE COMPONENT'S
        // GOVERNED CONTROLS against a real provider, once a minute for the whole length of every
        // freeze window on the instance.
        const { changeObjectId } = await greenBump();
        const rootId = await inOrg((tx) => getOrgRootObjectId(tx, org.orgId));
        const freeze = await orgFreeze(rootId, "m25-8-redrive-control");
        try {
          expect((await runGate(changeObjectId)).refusal).toBe("frozen");

          const outcome = await runBumpFreezeRedriveSweep(boss!, server.deps.db);

          // It IS on the work-list — the sweep looked at it and ASKED the question…
          expect(outcome.candidates).toContain(changeObjectId);
          // …and got `null` back from nothing, because the freeze is still in force.
          expect(outcome.enqueued).not.toContain(changeObjectId);
          expect(mergeIntentsFor(changeObjectId)).toHaveLength(0);
        } finally {
          await lift(freeze.id);
        }
      }, 240_000);

      it("a bump refused for a NON-freeze reason is never re-driven — the key is `frozen`, not `open`", async () => {
        // With no required checks, the gate names no control. See docs/dependencies.md §63.
        const { changeObjectId } = await authoredAndPushed();
        expect((await runGate(changeObjectId)).refusal).toBe("not_evidenced");

        const outcome = await runBumpFreezeRedriveSweep(boss!, server.deps.db);

        expect(outcome.candidates).not.toContain(changeObjectId);
        expect(outcome.enqueued).not.toContain(changeObjectId);
        expect(mergeIntentsFor(changeObjectId)).toHaveLength(0);
      }, 240_000);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 3. THE DELEGATION REFUSAL — probed for real, then enforced at BOTH readers
  // ---------------------------------------------------------------------------------------------

  it("a repository that already delegates is PROBED, recorded as a block, and never written to", async () => {
    const fixture = await subscribedComponent({
      // Renovate's own documented discovery location, with a config that narrows nothing — so it
      // claims every manifest it detects, including this component's `package.json`.
      files: { "renovate.json": JSON.stringify({ extends: ["config:base"] }) }
    });
    await advanceHead(fixture.lineId, "1.4.0");
    await relayHeadAdvance(fixture.lineId);

    const verdict = await waitUntil(
      async () => {
        const rows = await decisionsOfKind(
          DEPENDENCY_DELEGATION_DECISION_KIND,
          fixture.componentObjectId
        );
        return rows[0] ?? undefined;
      },
      {
        describe: "the dispatcher's delegation probe to record a verdict",
        timeoutMs: 60_000,
        intervalMs: 200
      }
    );

    // WRITTEN BY A REAL READ OF THE REPOSITORY, not planted.
    expect(verdict.verdict).toBe("block");
    expect(fileReads.some((r) => r.repo === fixture.repo && r.path === "renovate.json")).toBe(true);
    const collisions = (verdict.inputContext as { collisions?: { configPath: string }[] })
      .collisions;
    expect(collisions?.[0]?.configPath).toBe("renovate.json");

    // AND NOTHING WAS AUTHORED. Two actuators editing one file is the failure the refusal exists
    // for, so the bump must not merely be delivered differently — it must not happen.
    expect(
      triggers.filter(
        (t) => (t.intent.parameters as { repo?: string } | undefined)?.repo === fixture.repo
      )
    ).toHaveLength(0);
    expect(await bumpChangesFor(fixture.repo)).toHaveLength(0);

    // ...AND THE ENABLEMENT REFUSAL NOW FIRES, at the CHOKE POINT rather than at one route. The
    // typed `/policies` route first:
    await expectApiError(
      admin.policies.create({
        name: `after-probe-${randomUUID().slice(0, 8)}`,
        urn: `urn:scp:${org.orgId}:policy:after-probe-${randomUUID().slice(0, 8)}`,
        properties: {
          scope: { objectRef: fixture.componentObjectId },
          enforcement: "advisory",
          effects: [{ dependencySubscription: { enabled: true } }]
        }
      }),
      409,
      /renovate\.json/
    );

    // ...and a FREE-FORM-`typeId` door, which is where the sibling guard's first cut had a hole:
    // `POST /plans` + apply plants the same document without going near the typed route.
    const stackName = `dep-bump-${randomUUID().slice(0, 8)}`;
    const manifest: DesiredStateManifest = {
      stackName,
      objects: [
        {
          typeId: "policy",
          name: "iac-after-probe",
          urn: `urn:scp:${stackName}:policy:iac-after-probe`,
          properties: {
            scope: { objectRef: fixture.componentObjectId },
            enforcement: "advisory",
            effects: [{ dependencySubscription: { enabled: true } }]
          }
        }
      ],
      relationships: []
    };
    const plan = await admin.plans.create(manifest);
    await expectApiError(admin.plans.apply(plan.id), 409, /renovate\.json/);
  }, 120_000);

  it("a delegation that does NOT cover this component's manifests does not stop the bump", async () => {
    const fixture = await subscribedComponent({
      files: {
        // Dependabot restricted to an ecosystem CommanderSCP does not author bumps for — real
        // delegation, of a class that cannot collide with anything this actuator writes.
        ".github/dependabot.yml":
          "version: 2\nupdates:\n  - package-ecosystem: bundler\n    directory: /\n"
      }
    });
    await advanceHead(fixture.lineId, "1.4.0");
    await relayHeadAdvance(fixture.lineId);

    await waitUntil(
      async () =>
        triggers.some(
          (t) => (t.intent.parameters as { repo?: string } | undefined)?.repo === fixture.repo
        ),
      { describe: "the bump to be dispatched anyway", timeoutMs: 60_000, intervalMs: 200 }
    );
    const verdicts = await decisionsOfKind(
      DEPENDENCY_DELEGATION_DECISION_KIND,
      fixture.componentObjectId
    );
    expect(verdicts[0]?.verdict).toBe("allow");
  }, 120_000);

  /** An unreadable repository is not an empty repository. See docs/dependencies.md §64. */
  it("a repository whose configs cannot be READ is SKIPPED by name, and nothing is authored", async () => {
    const fixture = await subscribedComponent({
      readFailure: "github readFileAtRef: HTTP 401 (bad credentials)"
    });
    await advanceHead(fixture.lineId, "1.4.0");

    const outcome = await runBumpDispatchJob(jobDeps(), {
      orgId: org.orgId,
      lineId: fixture.lineId
    });

    expect(outcome.dispatched).toHaveLength(0);
    const skipped = outcome.skipped.find((s) => s.componentObjectId === fixture.componentObjectId);
    expect(skipped?.reason).toBe("delegation_probe_failed");
    expect(skipped?.detail).toMatch(/HTTP 401/);
    expect(skipped?.detail).toContain(fixture.repo);

    // NOTHING WAS WRITTEN, in either direction: no bump, and no `allow` verdict that a later
    // authoring-time check would read as a standing fact about a repository nobody could read.
    expect(
      triggers.filter(
        (t) => (t.intent.parameters as { repo?: string } | undefined)?.repo === fixture.repo
      )
    ).toHaveLength(0);
    expect(await bumpChangesFor(fixture.repo)).toHaveLength(0);
    expect(
      await decisionsOfKind(DEPENDENCY_DELEGATION_DECISION_KIND, fixture.componentObjectId)
    ).toHaveLength(0);
  }, 120_000);

  // The refusals that keep the class off unusable providers. See docs/dependencies.md §65.

  it("REFUSES to author when the operator has named no runner image — managed execution is never a default", async () => {
    const fixture = await subscribedComponent();
    await advanceHead(fixture.lineId, "1.4.0");

    const image = process.env.SCP_MANAGED_DEP_RUNNER_IMAGE;
    delete process.env.SCP_MANAGED_DEP_RUNNER_IMAGE;
    let outcome;
    try {
      outcome = await runBumpDispatchJob(jobDeps(), { orgId: org.orgId, lineId: fixture.lineId });
    } finally {
      process.env.SCP_MANAGED_DEP_RUNNER_IMAGE = image;
    }

    expect(outcome.dispatched).toHaveLength(0);
    const skipped = outcome.skipped.find((s) => s.componentObjectId === fixture.componentObjectId);
    expect(skipped?.detail).toMatch(/SCP_MANAGED_DEP_RUNNER_IMAGE/);
    // The refusal lands before anything is started. See docs/dependencies.md §66.
    expect(startedInstances.filter((id) => id.startsWith("managed-dep:"))).toEqual([]);
    expect(
      triggers.filter(
        (t) => (t.intent.parameters as { repo?: string } | undefined)?.repo === fixture.repo
      )
    ).toHaveLength(0);
  }, 120_000);

  it("REFUSES a component served by a non-GitHub binding — only an App can mint a per-run, single-repo credential", async () => {
    // The clause is about credentials, not provider preference. See docs/dependencies.md §67.
    const fixture = await subscribedComponent({ pluginModule: "gitea" });
    await advanceHead(fixture.lineId, "1.4.0");

    const outcome = await runBumpDispatchJob(jobDeps(), {
      orgId: org.orgId,
      lineId: fixture.lineId
    });

    expect(outcome.dispatched).toHaveLength(0);
    const skipped = outcome.skipped.find((s) => s.componentObjectId === fixture.componentObjectId);
    expect(skipped?.detail).toMatch(/gitea/);
    expect(skipped?.detail).toMatch(/GitHub App/);
    expect(
      triggers.filter(
        (t) => (t.intent.parameters as { repo?: string } | undefined)?.repo === fixture.repo
      )
    ).toHaveLength(0);
  }, 120_000);

  it("REFUSES a component whose due declarations were observed on DIFFERENT branches", async () => {
    // THE BUG THIS PINS. See docs/dependencies.md §68.
    const fixture = await subscribedComponent({ manifestPaths: ["package.json"] });
    await inOrg((tx) =>
      upsertComponentDependency(tx, org.orgId, {
        componentObjectId: fixture.componentObjectId,
        lineId: fixture.lineId,
        manifestPath: "services/api/package.json",
        declaredVersion: "^1.2.3",
        resolvedVersion: "1.2.3",
        // The whole difference. Same repo, same line, same component — read at another ref.
        observedRef: "refs/heads/dev"
      })
    );
    await advanceHead(fixture.lineId, "1.4.0");

    const outcome = await runBumpDispatchJob(jobDeps(), {
      orgId: org.orgId,
      lineId: fixture.lineId
    });

    expect(outcome.dispatched).toHaveLength(0);
    const refused = outcome.skipped.filter(
      (s) => s.reason === "declarations_disagree_on_source" && s.manifestPath !== undefined
    );
    // BOTH are named, not just the one that would have been edited wrongly — an operator has to see
    // which two things disagree to fix either of them.
    expect(refused.map((s) => s.manifestPath).sort()).toEqual([
      "package.json",
      "services/api/package.json"
    ]);
    expect(refused[0]?.detail).toContain("refs/heads/dev");
    expect(refused[0]?.detail).toContain("refs/heads/main");

    // NOTHING WAS AUTHORED. The `main` declaration was legitimate on its own, so a fix that merely
    // dropped the disagreeing one would still pass an assertion about the `dev` manifest alone.
    expect(
      triggers.filter(
        (t) => (t.intent.parameters as { repo?: string } | undefined)?.repo === fixture.repo
      )
    ).toHaveLength(0);
    expect(await bumpChangesFor(fixture.repo)).toHaveLength(0);
  }, 120_000);

  it("REFUSES to resolve a hand-created managed-dep BINDING while the class is off — the other door to the same class", async () => {
    // That helper is not the only way the instance can arise. See docs/dependencies.md §69.
    const component = await createTestComponent(admin, {
      name: `dep-binding-${randomUUID().slice(0, 8)}`
    });
    // One binding per module, each on its OWN routing Type — `executor_bindings` is unique on
    // (org, target, type), so three bindings sharing a Type would silently be one.
    const cases = [
      ["managed-dep", "npm", "SCP_MANAGED_DEP_RUNNER_IMAGE"],
      ["managed-iac", "infrastructure", "SCP_MANAGED_IAC_RUNNER_IMAGE"],
      ["managed-scan", "image", "SCP_MANAGED_SCAN_RUNNER_IMAGE"]
    ] as const;
    for (const [pluginModule, type] of cases) {
      await inOrg((tx) =>
        upsertExecutorBinding(tx, {
          orgId: org.orgId,
          targetObjectId: component.id,
          pluginModule,
          pluginInstanceId: `${pluginModule}-inst`,
          type,
          config: {},
          actorObjectId: org.orgId,
          requestId: "test-setup"
        })
      );
    }

    const saved = {
      dep: process.env.SCP_MANAGED_DEP_RUNNER_IMAGE,
      iac: process.env.SCP_MANAGED_IAC_RUNNER_IMAGE,
      scan: process.env.SCP_MANAGED_SCAN_RUNNER_IMAGE
    };
    delete process.env.SCP_MANAGED_DEP_RUNNER_IMAGE;
    delete process.env.SCP_MANAGED_IAC_RUNNER_IMAGE;
    delete process.env.SCP_MANAGED_SCAN_RUNNER_IMAGE;
    try {
      for (const [pluginModule, type, envVar] of cases) {
        await expect(
          inOrg((tx) =>
            resolveExecutorPluginInstance(tx, {
              orgId: org.orgId,
              targetObjectId: component.id,
              masterKey: server.deps.config.secretsMasterKey,
              type
            })
          ),
          `${pluginModule} must refuse while ${envVar} is unset`
        ).rejects.toThrow(new RegExp(envVar));
      }
    } finally {
      if (saved.dep !== undefined) process.env.SCP_MANAGED_DEP_RUNNER_IMAGE = saved.dep;
      if (saved.iac !== undefined) process.env.SCP_MANAGED_IAC_RUNNER_IMAGE = saved.iac;
      if (saved.scan !== undefined) process.env.SCP_MANAGED_SCAN_RUNNER_IMAGE = saved.scan;
    }
  }, 120_000);

  async function decisionsOfKind(kind: string, subjectId: string) {
    return inOrg((tx) =>
      tx
        .select()
        .from(decisions)
        .where(
          and(
            eq(decisions.orgId, org.orgId),
            eq(decisions.kind, kind),
            eq(decisions.subjectId, subjectId)
          )
        )
    );
  }

  async function expectApiError(call: Promise<unknown>, status: number, detail: RegExp) {
    await call.then(
      () => {
        throw new Error(`expected the call to fail with HTTP ${status}, but it succeeded`);
      },
      (err: unknown) => {
        expect(err).toBeInstanceOf(ScpApiError);
        const api = err as ScpApiError;
        expect(api.status).toBe(status);
        expect(JSON.stringify(api.problem ?? {})).toMatch(detail);
      }
    );
  }
});
