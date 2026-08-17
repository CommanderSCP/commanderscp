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
import { DEPENDENCY_DELEGATION_DECISION_KIND } from "./delegation-detection.js";
import { BUMP_SOURCE_KIND } from "./bump-actuator.js";
import { readBumpAuthorship } from "./bump-authorship-repo.js";

/**
 * M21.5 — THE BUMP IS ACTUALLY DISPATCHED, THROUGH THE REAL PATH (ADR-0032 §8/§9).
 *
 * ================================================================================================
 * WHY THIS FILE EXISTS, AND WHY THE REST OF M21.5's SUITE COULD NOT CATCH WHAT IT CATCHES
 * ================================================================================================
 * `recordBumpChange`, `resolveEffectiveDelivery` and `buildBumpIntentParameters` were built, tested
 * and correct, and NOTHING constructed a `managed-dep` `TriggerIntent`: no job, no route, no loop.
 * A suite that drives a function proves the function and says nothing about whether anything calls
 * it — which is how the same failure landed four times in M21. So every test below enters through
 * the PRODUCTION SEAM and never through the function under test:
 *
 *   recordDependencyLineHead (the ONE head write door)
 *     -> an `scp.dependency.line_head_advanced` OUTBOX row, in the head write's own transaction
 *     -> the domain-event job shape the outbox relay actually sends
 *     -> advancedLineHeadRouter (registered WITH pg-boss, because `boss.work()` is a competing
 *        consumer and a second worker on `domain-events` would steal M21.4's events)
 *     -> the `dependency-bump` queue
 *     -> startBumpDispatchLoop's worker
 *     -> a bump change, and a `trigger()` on the `managed-dep` plugin instance.
 *
 * DELETE ANY LINK OF THAT CHAIN AND THESE TESTS FAIL. Removing the outbox emit fails the first
 * block; removing the router registration or the loop fails the second; removing the dispatch fails
 * the trigger assertions.
 *
 * ================================================================================================
 * AND THE SAME DISCIPLINE FOR THE AUTO-MERGE LINK (block 2b, ADR-0032 §8c)
 * ================================================================================================
 * `resolveEffectiveDelivery` was the FIFTH instance of the same failure: correct, tested, and
 * unreachable — no control ever ran on a bump change (they sit at `proposed`, and governance prewarm
 * only sweeps `validating`), nothing re-evaluated a bump after its pull request opened, and there
 * was no merge anywhere in the tree. So block 2b enters through the webhook ingress too:
 *
 *   a raw github `push` / `workflow_run` row in `change_source_events`
 *     -> the REAL `processChangeSourceEvents` -> `matchAuthoredBumpChange` (branch route, then the
 *        HEAD-COMMIT route a ref-less CI event needs)
 *     -> an `scp.dependency.bump_observed` OUTBOX row, in the ingress transaction
 *     -> observedBumpRouter -> the `dependency-bump-gate` queue -> startBumpGateLoop's worker
 *     -> `prewarmGovernanceForChange` (the EXISTING gate) -> a real `control_runs` row
 *     -> `resolveEffectiveDelivery` -> a `managed-dep` MERGE intent.
 *
 * Nothing in that block calls `runBumpGateJob`, `prewarmGovernanceForChange` or
 * `resolveEffectiveDelivery` directly.
 *
 * ================================================================================================
 * AND THE DELEGATION REFUSAL IS PROVEN WITH A REAL PROBE, NOT A PLANTED VERDICT
 * ================================================================================================
 * `bump-provenance.integration.test.ts` plants the `dependency_delegation` Decision with
 * `insertDecision` — correct for testing the READERS, and it would pass unchanged with no writer
 * anywhere in the tree, which is exactly the state M21.5 was in. Here the verdict is written by the
 * dispatch job READING A `renovate.json` OUT OF THE REPOSITORY through the plugin host's
 * `readFileAtRef` client, and the enablement refusal is then driven through the AUTHORING CHOKE
 * POINT — the typed `/policies` route AND a free-form-`typeId` door — because
 * `subscription-authoring-guard.ts`'s header measured that the route was never the boundary.
 */
describe("M21.5 the bump dispatcher: a head advances and a bump is authored (Testcontainers)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let boss: Awaited<ReturnType<typeof startPgBoss>> | undefined;
  let loop: BumpDispatchLoopHandle | undefined;
  let gateLoop: BumpGateLoopHandle | undefined;

  /** Every `trigger()` that reached the plugin host, with the instance it was addressed to. */
  const triggers: { instanceId: string; intent: TriggerIntent }[] = [];
  /** Every `evaluate()` the governance gate performed, with the CHANGE it was about and the commit
   *  it was asked about — which is the field the whole auto-merge grant turns on.
   *
   *  THE CHANGE ID IS RECORDED, and that is not cosmetic. Every test in the auto-merge block uses
   *  the same `BUMP_COMMIT` constant, and these accumulators were module-level and never reset — so
   *  `expect(controlEvaluations.map(e => e.commitSha)).toContain(BUMP_COMMIT)`, written to prove a
   *  control ran for THIS change, was satisfied forever by the first test that ran one. It could not
   *  fail. The `beforeEach` below resets them and the assertions now name the change. */
  const controlEvaluations: { instanceId: string; changeId: unknown; commitSha: unknown }[] = [];
  /** The pull request the fake provider reports the authoring run opened, per change — the number
   *  AND the URL `status().stateRef` carries back and the server records. `undefined` for a change
   *  the fixture wants to leave with no recorded pull request. */
  const openedPullRequests = new Map<string, { number: number; url: string }>();
  let nextPullRequestNumber = 100;
  /**
   * The web URL the fixture PROVIDER hands back for a pull request it opened.
   *
   * DELIBERATELY NOT A GITHUB URL, and that is the whole point of the column it feeds
   * (migration 0066): this is an outpost-local Gitea (M15), so it is a different HOST and it spells
   * the path `/pulls/` where github.com spells `/pull/`. A consumer composing a link from `repo` +
   * `pull_request_number` would emit `https://github.com/<repo>/pull/<n>`, which 404s here — so an
   * assertion that this exact string reached the database cannot be satisfied by a synthesiser.
   */
  const providerPullRequestUrl = (repo: string, number: number): string =>
    `https://gitea.dc1.internal/${repo}/pulls/${number}`;
  /** What the fixture `github-check` control answers. Mutable so a test can say what "the
   *  component's own checks" reported, and FOR WHICH COMMIT. */
  let controlOutcome: ControlOutcome = { status: "expired", evidence: {} };
  /** What `status()` reports for a merge run — the honest outcome the gate job records rather than
   *  assuming a dispatch means a merge. */
  let mergeRunPhase: "succeeded" | "failed" = "succeeded";
  /** Every `readFileAtRef` the delegation probe performed. */
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

  /**
   * ACCUMULATORS ARE RESET PER TEST, and this is a correctness fix rather than tidiness.
   *
   * They were module-level and never cleared, so any assertion of the form `toContain(<a constant
   * every test in the file uses>)` was satisfied by whatever an earlier test had already pushed.
   * `expect(controlEvaluations.map(e => e.commitSha)).toContain(BUMP_COMMIT)` — written into the
   * "checks passed for a DIFFERENT commit" test to prove a control HAD run for this bump — CANNOT
   * FAIL under those conditions: the first test in the block runs a control for `BUMP_COMMIT` and
   * every later one inherits its evidence. That is this repo's own recurring "green for the wrong
   * reason" shape.
   *
   * `openedPullRequests` and `relayed` are deliberately NOT reset: they are per-change state the
   * fixture keeps for the lifetime of the changes themselves, not per-test observations.
   */
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
            // AN AUTHORING RUN OPENS A PULL REQUEST, and this run's outcome is the only place its
            // number and its URL exist. The server reads both back off `status().stateRef` and
            // records them: the merge is ADDRESSED to the number rather than found by listing (so a
            // fixture reporting no number would make every merge below unreachable), and the URL is
            // unrecoverable afterwards because nothing on the row says which provider this was.
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
    server = await listenTestServer();
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

  /**
   * A subscribed component that declares `@acme/lib@^1.2.3` from `package.json` in its own
   * repository, with the git binding that names that repository — the binding is what chooses the
   * credential, so without it there is no repository to author into.
   *
   * `lineId` and `manifestPaths` are options rather than constants BECAUSE THE ABSENCE OF THEM IS
   * WHAT LET A BLOCKER SHIP. Every fixture in the first cut of this file minted its own line with a
   * coordinate unique to itself and declared it from exactly one manifest, so the suite could not
   * see that `findOpenBumpChange` keyed on (coordinate, toVersion) alone: a second component on the
   * same line, and a second manifest in the same component, both collapsed onto one bump change.
   */
  async function subscribedComponent(options?: {
    /** Files the fixture repository contains, e.g. a `renovate.json`. */
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
        config: { appId: "1", installationId: "2", owner: "acme", repo: `dep-${slug}` }
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
      recordDependencyLineHead(tx, org.orgId, {
        lineId,
        latestVersion: version,
        latestDigest: null
      })
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
      recordDependencyLineHead(tx, org.orgId, {
        lineId: fixture.lineId,
        latestVersion: "1.4.0",
        latestDigest: null
      })
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

  /**
   * ==============================================================================================
   * THE LINK IS CAPTURED HERE OR NOWHERE (migration 0066, M21.7 item C)
   * ==============================================================================================
   * 0064 recorded `repo` and `pull_request_number` and no URL, on the reasoning that the two
   * compose one. They compose one for github.com. They compose a 404 for an outpost-local Gitea
   * (M15) — a different host, and `/pulls/` rather than `/pull/` — and for GitHub Enterprise, and
   * nothing on the authorship row records which provider authored the bump. So the URL the provider
   * itself returned has to be persisted at the one moment it exists: the authoring run's outcome.
   *
   * This test enters through the SAME production seam as the rest of the file — head write door ->
   * outbox -> router -> queue -> loop -> dispatch -> phase 5 -> `recordBumpPullRequest` — and never
   * calls the repo function. Delete the URL from phase 5's read of `status().stateRef`, or delete
   * the phase-5 write entirely, and this goes red.
   */
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
        config: { appId: "1", installationId: "2", owner: "acme", repo: `quiet-${slug}` }
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

  // ---------------------------------------------------------------------------------------------
  // 2b. ONE BUMP CHANGE PER (COMPONENT, MANIFEST) — the fixture whose absence hid a blocker
  // ---------------------------------------------------------------------------------------------

  /**
   * A dependency LINE EXISTS TO BE DECLARED BY MANY COMPONENTS — that is the entire point of the
   * M21.3 reverse index — so "two subscribed components on one line" is the ordinary case, not an
   * edge one. It had no fixture, and `findOpenBumpChange` accepted a `componentObjectId` it never
   * compared: the second component to reach the lookup reused the FIRST one's change, so it got no
   * change, no branch, no dispatch and no bump, silently and forever. Worse, ADR-0032 §9's
   * provenance loop then inverted — the returning push correlated to a change that was not about
   * this component, and every component after the first minted the second, unrelated change §9
   * exists to prevent.
   */
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

  /**
   * The other half of the same key, and it is not a defensive extra: `component_dependencies` is
   * unique on `(org, component, line, manifest_path)`, so ONE component legitimately declares one
   * line from two manifests — a workspace root and a service's own `package.json`. A bump change
   * declares exactly ONE `manifestPath`, so two manifests must be two changes; keyed without it, one
   * file was edited and the other silently was not.
   */
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

  /**
   * ==============================================================================================
   * THE FIRST DISPATCH OF AN `auto_merge` SUBSCRIPTION IS ALWAYS A PULL REQUEST (ADR-0032 §8c)
   * ==============================================================================================
   * This test was originally written as a record that auto-merge did nothing at all, with a note
   * saying it was EXPECTED TO FAIL once something re-enqueued the bump after the component's checks
   * concluded. That link is now built (`bump-gate.ts`), so the note is gone — but the behaviour it
   * pins is not, and it is the more important half of the charter clause:
   *
   *   at the FIRST dispatch the branch does not exist, no push has returned, no commit is recorded
   *   and no control has run — so `auto_merge` is refused and delivery is a pull request, whatever
   *   the subscription asked for.
   *
   * "The bump merges on its second look, never on its first" is the property, and this is where it
   * is pinned. The block below ("the auto-merge link") is where the SECOND look is proven.
   *
   * The downgrade is also RECORDED with its reason, which is the difference between an operator who
   * can see why the privileged option was declined and one who wonders whether they mis-authored the
   * policy.
   */
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

  // ---------------------------------------------------------------------------------------------
  // 2b. THE AUTO-MERGE LINK — the SECOND look, driven through the real ingress and the real gate
  // ---------------------------------------------------------------------------------------------

  /**
   * ==============================================================================================
   * EVERY LINK OF THE CHAIN, AND DELETING ANY ONE OF THEM FAILS THIS BLOCK
   * ==============================================================================================
   *   a provider webhook row (github `push`, then github `workflow_run`)
   *     -> the REAL `processChangeSourceEvents`
   *     -> `matchAuthoredBumpChange` (branch route for the push, HEAD-COMMIT route for the CI event)
   *     -> the `scp.dependency.bump_observed` OUTBOX row, in the ingress transaction
   *     -> the domain-event job shape the outbox relay actually sends
   *     -> `observedBumpRouter` (registered WITH pg-boss)
   *     -> the `dependency-bump-gate` queue
   *     -> `startBumpGateLoop`'s worker
   *     -> `prewarmGovernanceForChange` — the EXISTING gate — which runs the component's own
   *        required control against the bump's OWN commit and deposits a real `control_runs` row
   *     -> `resolveEffectiveDelivery` grants
   *     -> a `managed-dep` MERGE intent.
   *
   * Nothing below calls `runBumpGateJob`, `prewarmGovernanceForChange` or `resolveEffectiveDelivery`
   * directly. That is the point: M21's standing failure is components that are correct and have no
   * caller, and a suite that drives the component proves the component.
   */
  describe("the auto-merge link (ADR-0032 §8c)", () => {
    /** A `control` bound to `github-check` PLUS a required policy naming it — which together are
     *  what makes the governance gate run anything at all for this component. The module matters:
     *  `bump-actuator.ts` grants only on modules that answer "did THIS CHANGE'S OWN commit pass the
     *  component's OWN CI?", so a `scan-result-control` binding here would (correctly) grant
     *  nothing. */
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
      // It is then CONSUMED WITHOUT BEING RELAYED. In production that evaluation runs and refuses
      // (`github-check` answers `expired` — CI has not concluded on the commit the push just
      // announced), which is the FIRST-dispatch behaviour already pinned above. Relaying it here
      // would re-prove that and make every assertion below race a second, identical gate job for the
      // same change, so each test drives exactly one evaluation: the one triggered by CI.
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
      // The component's checks went green FOR THE BUMP'S OWN COMMIT.
      // EVIDENCE NAMES THE COMPONENT'S OWN REPOSITORY as well as the bump's own commit — the URL
      // `@scp/plugin-github-check` records is the only field that says which repository a verdict is
      // about, and a commit id travels between repositories freely (a fork, a mirror, a vendored
      // copy), so the module name alone bound the evidence to nothing.
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

      // (1) A REAL CONTROL RAN, and it was asked about the bump's own commit — not the base branch,
      //     which is what `github-check` would have fallen back to before the push was recorded.
      // BOUND TO THIS CHANGE, not merely to the shared commit constant: every test in this block
      // uses the same `BUMP_COMMIT`, so an assertion over the commit alone was satisfied by any
      // earlier test's evaluation.
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

      // (3) THE VERDICT IS EXPLAINABLE (charter principle 6).
      const verdicts = await decisionsOfKind(DEPENDENCY_BUMP_MERGE_DECISION_KIND, changeObjectId);
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

    /**
     * ============================================================================================
     * "THE COMPONENT'S OWN CHECKS" MUST BE BOUND TO THE COMPONENT'S OWN REPOSITORY
     * ============================================================================================
     * The grant used to be enforced as a MODULE-NAME STRING plus a commit id, and neither binds the
     * evidence to this component: a `github-check` control an operator configured against a DIFFERENT
     * repository that happens to contain the same commit object — a fork, a mirror, a vendored copy;
     * commit ids are content hashes and travel freely — reported green for exactly the commit the
     * bump is at, and the merge was granted. The code comment asserted the opposite while nothing
     * enforced it.
     */
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
      // STRICTER HERE THAN AT THE AUTHORING SEAM, and deliberately. `assertComponentNotDelegated`
      // refuses only when a verdict SAYS delegated, because the authoring path is what PRODUCES the
      // verdict. An INCONCLUSIVE probe (a bad credential, a provider 5xx, an egress refusal) records
      // no verdict at all — so "no verdict" is byte-identical to "we could not read the repository",
      // and merging is a bigger thing to do on that than opening a pull request is.
      const { fixture, changeObjectId } = await authoredAndPushed();
      await requireOwnChecks(fixture.componentObjectId);
      controlOutcome = {
        status: "pass",
        evidence: { url: ownChecksUrl(fixture.repo), ref: BUMP_COMMIT }
      };
      // Erase the `allow` verdict the dispatch job's own probe recorded — which is exactly the state
      // an inconclusive probe leaves behind, since `recordDelegationProbe` refuses to write one.
      //
      // Over the ADMIN connection, because `decisions` is append-only to the tenant role (no DELETE
      // grant) — a property worth noticing rather than working around: the state under test is one
      // production reaches by a probe never CONCLUDING, never by a verdict being removed.
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

    /**
     * ============================================================================================
     * A FABRICATED "BUMP" NAMING SOMEBODY ELSE'S REPOSITORY MERGES NOTHING (ADR-0032 §8f)
     * ============================================================================================
     * THE CONFUSED DEPUTY THIS CLOSES. Every input that decided whose credential merged what was
     * read from `changes.source_ref.scp_authored` — a field `POST /api/v1/changes` writes VERBATIM
     * for any authenticated principal — and the event that starts the gate is producible through
     * `POST /change-sources/{kind}/report`. So an ordinary tenant could declare a bump against a
     * repository they do not own and have SCP merge into it with SCP's installation credential.
     *
     * This test is the forgery itself, through the PUBLIC API, with a `source_ref` that names every
     * field the old merge path read and names them correctly. What stops it is not a validation of
     * that field — validating an attacker-writable field yields a well-formed attacker-supplied
     * answer — but that the merge path reads `dependency_bump_authorships`, which no route can
     * write, and a change with no row there is not a bump change.
     *
     * IT ENTERS THROUGH THE GATE JOB ITSELF rather than through the webhook, so the assertion is
     * about the decision and not about whether an event happened to correlate.
     */
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

    /**
     * ============================================================================================
     * THE AUDIT TRAIL MUST NOT LIE ABOUT THE ONE IRREVERSIBLE ACTION (principle 6)
     * ============================================================================================
     * A merge produces its OWN provider events — the merge commit's push, whatever CI runs after —
     * which correlate straight back to this bump and re-run the gate. That second run found no OPEN
     * pull request, dispatched a doomed merge and recorded `withheld / merge_refused`, so the LATEST
     * Decision for a bump that DID merge said it did not.
     *
     * Driven the way production reaches it: the same CI conclusion delivered TWICE.
     */
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

    /**
     * ============================================================================================
     * TWO CONCURRENT JOBS, TWO PLUGIN-INSTANCE NAMESPACES (ADR-0032 §7c clause 4)
     * ============================================================================================
     * `bump-dispatch.ts` (authoring) and `bump-gate.ts` (merging) both act on the SAME component
     * binding, both start a `managed-dep` instance for it, and both tear it down in a `finally`.
     * The id used to be `managed-dep:<bindingId>` for both — one shared subprocess — so whichever
     * job finished first killed the other's in flight, including a `status()` call issued AFTER the
     * provider had already merged. A head advance and a CI conclusion are unrelated events; nothing
     * orders them.
     */
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

    /**
     * ============================================================================================
     * THE OPERATOR'S CONTAINER RUNTIME REACHES THE RUNNER THIS PATH STARTS (2026-08-16)
     * ============================================================================================
     * `@scp/plugin-managed-dep` runs `execFile(config.dockerBinary ?? "docker", …)`, and
     * `SCP_MANAGED_RUNNER_DOCKER_BINARY` is how an operator points that at podman — the sanctioned
     * runtime on the RHEL/air-gapped estates this class ships into (docs/container-runtimes.md).
     *
     * ASSERTED HERE, SEPARATELY FROM THE BINDING PATH, because this class has two ways of being
     * constructed and this is the one that runs. `routes/executors.integration.test.ts` covers
     * `resolveExecutorPluginInstance`, the path taken only for a `managed-dep` binding an operator
     * makes BY HAND; ordinary dispatch never touches it — `managed-dep-instance.ts` builds the
     * instance itself from `managedDepServerSettings()`. When the runtime knob was first wired,
     * both of this class's paths were missed while its two sibling classes were wired correctly, so
     * an operator on podman got a silent hardcoded `docker` for every ordinary bump. A test on the
     * binding path alone would have stayed green through exactly that.
     *
     * The value is deliberately NOT `"docker"`: asserting the fallback would pass whether or not
     * anything was injected at all.
     */
    it("hands the operator's container runtime to the runner it starts", async () => {
      const saved = process.env.SCP_MANAGED_RUNNER_DOCKER_BINARY;
      process.env.SCP_MANAGED_RUNNER_DOCKER_BINARY = "/usr/bin/operator-chosen-runtime";
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
        }
      } finally {
        if (saved === undefined) delete process.env.SCP_MANAGED_RUNNER_DOCKER_BINARY;
        else process.env.SCP_MANAGED_RUNNER_DOCKER_BINARY = saved;
      }
    }, 180_000);

    /**
     * ============================================================================================
     * A REFUSAL RAISED IN PHASE 4 CARRIES A `decision_id` LIKE EVERY OTHER ONE (principle 6)
     * ============================================================================================
     * "Every blocked response carries a `decision_id`." A throw out of the dispatch itself — the
     * runner image not configured on this deployment, an unresolvable binding, an unreachable plugin
     * host — was the one class of merge refusal that left NO Decision at all: the job logged and
     * moved on, and an operator had nowhere to see that a merge had been authorised and had not
     * happened.
     */
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

  /**
   * ==============================================================================================
   * AN UNREADABLE REPOSITORY IS NOT A REPOSITORY WITH NOTHING IN IT
   * ==============================================================================================
   * `probeDependencyUpdateDelegation` used to swallow every read failure into `unreadable` and
   * return `delegated: false`, which is byte-identical to a clean repository — so a bad credential
   * produced an `allow` Decision and an authored commit, and the `delegation_probe_failed` branch
   * this asserts was UNREACHABLE. It is the one refusal standing between SCP and two actuators
   * editing one file, so "we could not check" must never resolve to "go ahead and write to it".
   *
   * Driven through `runBumpDispatchJob` — the exact function the worker runs — because the outcome
   * this needs to assert (the NAMED skip) is that function's return value, and the loop swallows it
   * into a log line.
   */
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

  // ---------------------------------------------------------------------------------------------
  // 4. THE REFUSALS THAT KEEP THE CLASS OFF, AND OFF THE PROVIDERS IT MAY NOT USE
  //
  // Each of the three below survived DELETION with both the unit suite and this integration suite
  // green — including the one that keeps the whole class off by default. They are the seam between
  // "an operator enabled managed execution" and "a container ran with a repository-write credential",
  // so each gets an assertion of its own rather than a comment claiming it is there.
  // ---------------------------------------------------------------------------------------------

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
    // The refusal lands BEFORE anything is started, which is the whole shape of ADR-0006: no
    // container could have been launched and no credential minted.
    //
    // ASSERTED AS AN EMPTY SET, not as "does not contain `managed-dep:<pluginInstanceId>`". That
    // form CANNOT FAIL: the id this code builds is `managed-dep:<bindingRowId>:<runToken>`, so the
    // string it asserted the absence of is one nothing has ever produced — with the accumulator
    // module-level and never reset, it was a negative assertion about a value from no code path.
    expect(startedInstances.filter((id) => id.startsWith("managed-dep:"))).toEqual([]);
    expect(
      triggers.filter(
        (t) => (t.intent.parameters as { repo?: string } | undefined)?.repo === fixture.repo
      )
    ).toHaveLength(0);
  }, 120_000);

  it("REFUSES a component served by a non-GitHub binding — only an App can mint a per-run, single-repo credential", async () => {
    // The charter clause this enforces is a CREDENTIAL clause, not a provider preference: Gitea and
    // GitLab tokens are standing credentials scoped to a user or a group, and the amendment
    // authorising this class requires "issued per run, scoped to the single repository under change".
    // `repo-write.ts`'s `resolveRepoWriter` refuses them too; refusing HERE is what makes the message
    // name the binding and the component rather than surfacing as a plugin error with neither in it.
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

  it("REFUSES to resolve a hand-created managed-dep BINDING while the class is off — the other door to the same class", async () => {
    // `startManagedDepInstance` is not the only way a `managed-dep` plugin instance can come into
    // being: an operator can create an `executor_bindings` row for it by hand, and that path goes
    // through `resolveExecutorPluginInstance` instead. Two doors, one class, so the off-by-default
    // refusal has to be on both — and the SIBLING classes' identical refusals in that same function
    // (`managed-iac`, `managed-scan`) are asserted beside it, because a refusal with no test is what
    // this block exists to stop being normal.
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
          config: {}
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
