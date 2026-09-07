import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type PgBoss from "pg-boss";
import { describe, expect, it } from "vitest";
import type { DomainEventJob } from "../events/pgboss.js";
import { readStripped } from "@scp/source-census";
import { BACKGROUND_LOOPS, type BackgroundLoopContext } from "../background-work.js";
import type { CelSandbox } from "../governance/cel-sandbox.js";
import { BUMP_OBSERVED_EVENT } from "../coordination/correlation.js";
import {
  DOMAIN_EVENT_ROUTERS,
  domainEventRouters,
  type RouterGuardConfig
} from "../events/domain-event-registry.js";
import { bumpDispatchRoleGuard } from "./bump-dispatch.js";
import {
  DEPENDENCY_BUMP_GATE_QUEUE,
  isBumpObservedEvent,
  observedBumpRouter,
  startBumpGateLoop
} from "./bump-gate.js";
import { buildBumpMergeIntentParameters } from "./bump-actuator.js";

/** M21.5's AUTO-MERGE LINK. See docs/dependencies.md §102. */

const srcDir = dirname(fileURLToPath(import.meta.url));

/** The census, because the integration registers the router. See docs/dependencies.md §103. */
/** A context whose `boss` records the queues it is asked to create. Everything else is absent on
 *  purpose: a loop that dereferenced `db` or `host` before deciding whether to run would fail here,
 *  which is information rather than noise. */
function gateContext(createdInto: string[]): BackgroundLoopContext {
  return {
    boss: {
      createQueue: async (queue: string) => void createdInto.push(queue),
      work: async () => "worker-id",
      send: async () => "job-id",
      schedule: async () => undefined
    } as unknown as PgBoss,
    db: undefined as never,
    host: undefined as never,
    sandbox: undefined as never,
    config: {
      role: "worker",
      federationRole: "commander",
      federationRoleDeclared: true,
      secretsMasterKey: Buffer.alloc(32)
    } as never
  };
}

describe("the composition root actually wires the gate", () => {
  it("registers the observed-bump router in the production registry, under the DISPATCHER's guard", () => {
    // By identity: "same guard as the dispatcher's, by import rather than by copy" is the claim the
    // module doc makes, and merging is the more consequential repository write of the two — so a
    // registry entry pairing this router with a laxer guard is the defect this rules out.
    const entries = DOMAIN_EVENT_ROUTERS.filter((entry) => entry.factory === observedBumpRouter);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.guard).toBe(bumpDispatchRoleGuard);
  });

  it("registers it on a declared commander worker, and on nothing else", () => {
    const queuesFor = (config: RouterGuardConfig): string[] =>
      domainEventRouters(config).map((router) => router.queue);
    expect(
      queuesFor({ role: "worker", federationRole: "commander", federationRoleDeclared: true })
    ).toContain(DEPENDENCY_BUMP_GATE_QUEUE);
    expect(
      queuesFor({ role: "worker", federationRole: "outpost", federationRoleDeclared: true })
    ).not.toContain(DEPENDENCY_BUMP_GATE_QUEUE);
    expect(
      queuesFor({ role: "worker", federationRole: "commander", federationRoleDeclared: false })
    ).not.toContain(DEPENDENCY_BUMP_GATE_QUEUE);
  });

  it("is in the production loop registry, and creates ITS OWN queue when the registry runs it", async () => {
    // Identity, then behaviour. `background-work.test.ts` starts the whole registry and pins the
    // full queue set; this asserts the gate's own link, in the file a reader of the gate opens.
    const entries = BACKGROUND_LOOPS.filter((entry) => entry.loop === startBumpGateLoop);
    expect(entries).toHaveLength(1);

    const created: string[] = [];
    const handle = await entries[0]!.start(gateContext(created));
    await handle.stop();
    expect(created).toContain(DEPENDENCY_BUMP_GATE_QUEUE);
  });

  it("hands it the SHARED CEL sandbox — 'the existing gate machinery' means literally the same one", async () => {
    // This was a regex over text, and what replaced it. See docs/dependencies.md §104.
    let sandboxReads = 0;
    const marker = { marker: "the one shared sandbox" } as unknown as CelSandbox;
    const recording: BackgroundLoopContext = {
      ...gateContext([]),
      get sandbox() {
        sandboxReads++;
        return marker;
      }
    };

    const gate = BACKGROUND_LOOPS.find((entry) => entry.loop === startBumpGateLoop)!;
    await (await gate.start(recording)).stop();
    expect(sandboxReads, "the gate entry did not read ctx.sandbox").toBeGreaterThan(0);

    // …and the reconcile loop reads the SAME field of the SAME context, which is what makes
    // "literally the same one" true rather than a coincidence of two memoised calls.
    const afterGate = sandboxReads;
    const reconcile = BACKGROUND_LOOPS.find((entry) => entry.name === "reconcile")!;
    await (await reconcile.start(recording)).stop();
    expect(sandboxReads, "the reconcile entry did not read ctx.sandbox").toBeGreaterThan(afterGate);
  });

  it("never takes a competing consumer on the shared domain-event stream", () => {
    // `boss.work` on `domain-events` does not deduplicate. See docs/dependencies.md §105.
    for (const file of ["main.ts", "background-work.ts"]) {
      const raw = readFileSync(join(srcDir, "..", file), "utf8");
      expect(raw, `${file} registers a competing consumer on domain-events`).not.toMatch(
        /work<[^>]*>\(\s*DOMAIN_EVENTS_QUEUE/
      );
    }
  });
});

/** The producer: the one place the trigger is emitted. See docs/dependencies.md §106. */
describe("the trigger is emitted at the ingress choke point (source census)", () => {
  const processorTs = readStripped(join(srcDir, "..", "coordination", "webhook-processor.ts"));

  it("writes the observed-bump outbox event in the branch that attached the event to a bump", () => {
    const attached = /if \(authoredChangeId\) \{[\s\S]*?continue;/.exec(processorTs)?.[0] ?? "";
    expect(attached).toContain("BUMP_OBSERVED_EVENT");
    expect(attached).toContain("writeOutboxEvent");
    // The SUBJECT is the change — the router reads exactly that and re-derives everything else.
    expect(attached).toMatch(/subject: authoredChangeId/);
  });

  it("passes the event's commit to the correlation, so a ref-less CI event can attach at all", () => {
    // GitHub's `workflow_run` (the event that says a component's checks CONCLUDED) carries
    // `head_sha` and NO ref. Without this argument it would fall through to ordinary source-mapping
    // correlation and mint a SECOND, unrelated change for a release that already has one.
    const call = /matchAuthoredBumpChange\(tx, orgId, \{[\s\S]*?\}\)/.exec(processorTs)?.[0] ?? "";
    expect(call).toContain("commitSha: hint.commitSha");
  });
});

describe("the router predicate", () => {
  const event = (type: string): DomainEventJob => ({
    id: "e1",
    orgId: "o1",
    type,
    subject: "change-1"
  });

  it("matches the observed-bump event and nothing else", () => {
    expect(isBumpObservedEvent(event(BUMP_OBSERVED_EVENT))).toBe(true);
    expect(isBumpObservedEvent(event("scp.change.transitioned"))).toBe(false);
    expect(isBumpObservedEvent(event("scp.dependency.line_head_advanced"))).toBe(false);
  });

  it("enqueues onto its OWN queue, and does no work in the router", async () => {
    const sent: { queue: string; job: unknown; options: unknown }[] = [];
    const boss = {
      send: async (queue: string, job: unknown, options?: unknown) => {
        sent.push({ queue, job, options });
        return "job-id";
      }
    };
    const router = observedBumpRouter();
    expect(router.queue).toBe(DEPENDENCY_BUMP_GATE_QUEUE);
    // It must NOT share the dispatcher's queue: `boss.work()` is a competing consumer, so a second
    // worker there would steal roughly half of the bump dispatches.
    expect(router.queue).not.toBe("dependency-bump");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the fixture is one method wide
    await router.route(boss as any, event(BUMP_OBSERVED_EVENT));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- as above
    await router.route(boss as any, event("scp.change.transitioned"));
    expect(sent).toEqual([
      {
        queue: DEPENDENCY_BUMP_GATE_QUEUE,
        job: { orgId: "o1", changeObjectId: "change-1" },
        // Asserted EMPTY for the reason the dispatcher's router documents at length: pg-boss scopes
        // every `singleton_key` index to a non-default queue policy, so a dedup option here would be
        // recorded and silently ignored.
        options: undefined
      }
    ]);
  });

  it("ignores an event carrying no change subject rather than enqueuing a job for nothing", async () => {
    const sent: unknown[] = [];
    const boss = {
      send: async (_q: string, job: unknown) => {
        sent.push(job);
        return "id";
      }
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the fixture is one method wide
    await observedBumpRouter().route(boss as any, {
      id: "e",
      orgId: "o",
      type: BUMP_OBSERVED_EVENT,
      subject: null
    });
    expect(sent).toEqual([]);
  });
});

/** The merge descriptor the server builds is one accepted. See docs/dependencies.md §107. */
describe("the merge descriptor crosses the plugin-host seam intact", () => {
  const EVIDENCED = "a1b2c3d4".repeat(5);
  const changeObjectId = "0198f3c1-1111-7000-8000-000000000001";

  it("is accepted by the plugin's own parser, and derives the branch from the change id", async () => {
    const plugin = await import("@scp/plugin-managed-dep");
    const parameters = buildBumpMergeIntentParameters({
      changeObjectId,
      repo: "acme/widget",
      baseBranch: "main",
      expectedHeadCommit: EVIDENCED,
      pullRequestNumber: 7
    });
    expect(plugin.parseIntentAction({ kind: "custom", parameters })).toBe("merge");
    const descriptor = plugin.parseBumpMergeDescriptor({ kind: "custom", parameters });
    expect(descriptor.headBranch).toBe(plugin.bumpBranchFor(changeObjectId));
    expect(descriptor.expectedHeadCommit).toBe(EVIDENCED);
    // THE ADDRESS OF THE MERGE, across the same seam. The plugin REQUIRES it and has no fallback to
    // searching for a pull request on the head branch, so a server that stopped sending it would
    // fail here rather than silently going back to "merge whatever the listing returns first".
    expect(descriptor.pullRequestNumber).toBe(7);
  });

  it("carries NO branch and NO content-bearing key — the merge target is derived, never supplied", async () => {
    const plugin = await import("@scp/plugin-managed-dep");
    const parameters = buildBumpMergeIntentParameters({
      changeObjectId,
      repo: "acme/widget",
      baseBranch: "main",
      expectedHeadCommit: EVIDENCED,
      pullRequestNumber: 7
    });
    for (const key of [...plugin.CONTENT_BEARING_KEYS, "headBranch", "branch", "ref"]) {
      expect(Object.keys(parameters)).not.toContain(key);
    }
  });
});
