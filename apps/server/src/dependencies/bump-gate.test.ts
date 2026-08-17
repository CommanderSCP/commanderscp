import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { DomainEventJob } from "../events/pgboss.js";
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
  observedBumpRouter
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
 */
describe("the composition root actually wires the gate", () => {
  const mainTs = readFileSync(join(srcDir, "..", "main.ts"), "utf8");

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

  it("starts the gate worker, and stops it on shutdown (source census — main.ts cannot be imported)", () => {
    // …and never takes a second `boss.work()` on the shared stream, which would steal M21.4's and
    // the dispatcher's events and receive roughly half of its own.
    expect(mainTs).not.toMatch(/work<[^>]*>\(\s*DOMAIN_EVENTS_QUEUE/);
    expect(mainTs).toMatch(/startBumpGateLoop\(/);
    expect(mainTs).toMatch(/bumpGateLoop\.stop\(\)/);
  });

  it("hands it the SHARED CEL sandbox — 'the existing gate machinery' means literally the same one", () => {
    const call = /startBumpGateLoop\([\s\S]*?\}\);/.exec(mainTs)?.[0] ?? "";
    expect(call).toContain("getSharedCelSandbox()");
    expect(call).toContain("host: pluginHost");
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
 */
describe("the trigger is emitted at the ingress choke point (source census)", () => {
  const processorTs = readFileSync(
    join(srcDir, "..", "coordination", "webhook-processor.ts"),
    "utf8"
  );

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
