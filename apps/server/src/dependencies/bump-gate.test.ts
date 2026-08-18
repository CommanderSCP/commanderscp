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

/**
 * M21.5's AUTO-MERGE LINK — the parts of it that are decidable without a database.
 *
 * The behaviour is proven end to end in `bump-dispatch.integration.test.ts` ("the auto-merge link"),
 * through the real ingress, the real router, the real queue, the real worker and the real governance
 * gate. This file covers the two things that suite structurally cannot: that the COMPOSITION ROOT
 * wires the router and the loop at all, and that the merge intent's parameter shape is the one the
 * plugin will accept.
 */

const srcDir = dirname(fileURLToPath(import.meta.url));

/**
 * ================================================================================================
 * THE CENSUS — because the integration suite registers the router ITSELF
 * ================================================================================================
 * This is the identical hazard `bump-dispatch.test.ts` records, one link further down the chain: an
 * integration test that starts its own pg-boss and its own loop passes whether or not `main.ts` ever
 * builds them, and a production process with no router on `domain-events` and no worker on
 * `dependency-bump-gate` would resolve `auto_merge`, downgrade it forever, and be green everywhere.
 * That is the fifth instance of "built and never installed" this milestone exists to not become a
 * sixth of, so it is asserted rather than reviewed.
 *
 * THIS BLOCK NO LONGER READS `main.ts` AT ALL, and the history of why is the point.
 *
 * It used to be three substring assertions. Measured on this very block (M21.7): commenting out
 * `const bumpGateLoop = await startBumpGateLoop(boss, {…})` and its `.stop()` left all 11 cases
 * green — and not only the two `toMatch`es. The "hands it the SHARED CEL sandbox" arm sliced the
 * call out with a regex and asserted on its TEXT, so it happily read `getSharedCelSandbox()` and
 * `host: pluginHost` out of the COMMENTED-OUT call.
 *
 * Stripping comments (`readStripped`) fixed that one case and not the class: a call in a DEAD
 * BRANCH survives stripping untouched, and on 2026-08-17 flipping `main.ts`'s background-work
 * condition to `false` left this file green again with the gate loop never starting.
 *
 * So the loop startups moved into `background-work.ts`'s importable `BACKGROUND_LOOPS`, and every
 * assertion below RUNS the registry entry instead of reading about it. The one census left in this
 * file is an ABSENCE assertion (no competing consumer), which is deliberately raw — see its comment.
 */
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
    // WAS a regex that sliced `startBumpGateLoop(…)` out of `main.ts` and asserted on its TEXT. That
    // check was satisfied by a COMMENTED-OUT call (measured, M21.7), and once comments were stripped
    // it would still have been satisfied by a dead branch. It is now a question about what the
    // registry entry DOES: does it take the sandbox from the one shared context, or fetch its own?
    //
    // The observable is the READ. If this entry were changed back to `sandbox: getSharedCelSandbox()`
    // — the pre-extraction shape, which relied on that function memoising — `ctx.sandbox` would
    // never be touched and this goes red.
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
    // `boss.work` on `domain-events` does not deduplicate — a second worker there steals M21.4's and
    // the dispatcher's events and receives roughly half of its own. An ABSENCE assertion, so it
    // reads RAW on purpose: a comment marker only makes a violation harder to hide, and anchoring
    // would narrow what counts as one (`@scp/source-census`'s hash.ts doc states that rule).
    //
    // BOTH composition files, because the loop startups moved out of `main.ts` on 2026-08-17 — a
    // census still aimed only at the old location is the "fixed some call sites" failure CLAUDE.md
    // names as recurring here.
    for (const file of ["main.ts", "background-work.ts"]) {
      const raw = readFileSync(join(srcDir, "..", file), "utf8");
      expect(raw, `${file} registers a competing consumer on domain-events`).not.toMatch(
        /work<[^>]*>\(\s*DOMAIN_EVENTS_QUEUE/
      );
    }
  });
});

/**
 * ================================================================================================
 * THE PRODUCER — the one place the trigger is emitted
 * ================================================================================================
 * The gate job is worthless without something enqueuing it, and the enqueue is worthless without an
 * outbox row. `bump-dispatch.integration.test.ts` proves the whole chain against a real database;
 * this pins the SITE, because the emit lives in `coordination/webhook-processor.ts` — a file the
 * dependencies suite has no other reason to look at, and a place a later edit could quietly drop it
 * from while every dependency test stayed green.
 *
 * Stripped for the same reason as the block above, and here the raw read was arguably worse: this
 * census slices a BRANCH out with `/if \(authoredChangeId\) \{[\s\S]*?continue;/` and asks what is
 * inside it. Comments are the bulk of that branch's text, so a `writeOutboxEvent` named only in a
 * comment explaining the emit satisfied the assertion just as well as the emit did.
 */
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

/**
 * ================================================================================================
 * THE MERGE DESCRIPTOR THE SERVER BUILDS IS ONE THE PLUGIN ACCEPTS
 * ================================================================================================
 * Same reasoning as `delegation-detection.test.ts`'s equivalent block for the authoring descriptor:
 * the server BUILDS this object and the plugin PARSES it, across a plugin-host RPC boundary where
 * the wire type is `Record<string, unknown>`. Typechecking proves nothing about that seam; only a
 * test that runs both halves does.
 */
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
