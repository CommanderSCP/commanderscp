import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import type { ChangeStageDependencyStatus, ChangeWaitStatus, GraphObject } from "@scp/schemas";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { startCliSession, type CliInvocation } from "../test-support/cli-runner.js";
import type { PluginHost } from "../plugin-host/contract.js";
import { reconcileOrgTick } from "./reconcile.js";
import { createInMemoryFakeHost } from "./test-support/fake-plugin-host.js";

/**
 * ADR-0028 increment 4, surface 2 — THE HOLD AT THE TERMINAL, against the real `scp` binary.
 *
 * WHY THE REAL BINARY AND NOT `formatStageDependencyLines` ALONE. The renderer is unit-pinned in
 * `packages/cli/src/stage-dependency-surface.test.ts`, and that is the right level for what it says.
 * It cannot pin what this file pins: that the COMMANDS actually call it. Both call sites are inside
 * Commander `.action()` closures, which `cli-absent-formatters.test.ts` documents as the position
 * where ten correct-but-unheld guards hid through an entire mutation sweep — a renderer can be
 * perfect and simply never reached, and the unit test would not notice.
 *
 * THE `--output json` CASE IS THE ONE THAT WAS BROKEN, so it leads. That branch printed
 * `result.waitStatus` alone, and the fixture below is deliberately the shape that exposed it: a
 * change held by a stage dependency that declares NO `requires`. The two couplings are independent,
 * so this is the ordinary ADR-0028 shape rather than a corner — and before this increment it printed
 * the literal `null`, i.e. the scripted path reported "nothing is holding this change" about a change
 * whose trigger was being withheld, while the human path said HELD.
 *
 * Fixture conventions are `stage-dependency-hold.integration.test.ts`'s: `reconcileOrgTick` driven
 * directly so "N ticks" means exactly N, and a fresh org per case.
 */

/** Mutable — the in-memory host closes over it and the plugin re-reads it on every call. */
const executorConfig: {
  autoSucceedAfterMs: number;
  forcePhase: Record<string, string>;
} = {
  autoSucceedAfterMs: 10 * 60_000,
  forcePhase: {}
};

describe("stage dependencies: `scp change wait-status` / `explain` (ADR-0028 increment 4)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let gamma: GraphObject;
  let topologyId: string;
  let host: PluginHost;

  beforeAll(async () => {
    server = await listenTestServer();
    host = createInMemoryFakeHost(executorConfig);
  });

  beforeEach(async () => {
    org = await createTestOrg(server, "stagedepcli");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    gamma = await admin.deploymentTargets.create({ name: `gamma-${randomUUID().slice(0, 8)}` });
    const topology = await admin.object("release-topology").create({
      name: `gamma-only-${randomUUID().slice(0, 8)}`,
      properties: { waves: [{ name: "gamma", mode: "parallel", targets: [gamma.id] }] }
    });
    topologyId = topology.id;
    executorConfig.forcePhase = {};
  });

  afterAll(async () => {
    await server?.close();
  });

  async function componentAtGamma(label: string) {
    const component = await createTestComponent(admin, {
      name: `${label}-${randomUUID().slice(0, 8)}`
    });
    await admin.placements.create({ component: component.id, deploymentTarget: gamma.id });
    return component;
  }

  /** A change whose single target is held at gamma behind a component that has never deployed there,
   *  and which declares NO `requires` — the shape whose `--output json` printed a bare `null`. */
  async function heldChange() {
    const dependency = await componentAtGamma("cli-dep");
    const dependant = await componentAtGamma("cli-app");
    const change = await admin.changes.propose({
      name: `cli-held-${randomUUID().slice(0, 8)}`,
      targets: [dependant.id],
      topology: topologyId,
      stageDependencies: [{ dependsOn: dependency.id }]
    });
    for (let i = 0; i < 3; i++) {
      await reconcileOrgTick(
        server.deps.db,
        org.orgId,
        host,
        server.deps.celSandbox!,
        server.deps.config.secretsMasterKey
      );
    }
    // The precondition, asserted rather than assumed: without it every assertion below could pass on
    // a change that was never held at all, which is the fixture-never-applied failure this repo keeps
    // meeting. `waitStatus` null is half the point — it is what made the old JSON branch print `null`.
    const explained = await admin.changes.explain(change.id);
    expect(explained.waitStatus).toBeNull();
    expect(explained.stageDependencyStatus?.held).toBe(true);
    return { change, dependency, dependant };
  }

  it("`wait-status --output json` emits BOTH couplings — the stage-dependency hold is not dropped with `requires`", async () => {
    const { change, dependency } = await heldChange();
    const cli: CliInvocation = await startCliSession(server.baseUrl);
    try {
      await cli.run(["login", "--username", org.adminUsername, "--password", org.adminPassword]);
      const payload = await cli.runJson<{
        waitStatus: ChangeWaitStatus | null;
        stageDependencyStatus: ChangeStageDependencyStatus | null;
      }>(["change", "wait-status", change.id]);

      // BEFORE INCREMENT 4 THIS WAS THE LITERAL `null`: the command printed `result.waitStatus`, and
      // this change declares no `requires`. A script asking "is anything holding this?" got "no".
      expect(payload).not.toBeNull();
      expect(payload.waitStatus).toBeNull();

      const status = payload.stageDependencyStatus;
      expect(status?.held).toBe(true);
      // Structured, not prose — the whole reason the JSON branch exists. The dependency and its
      // branch survive the round trip through the real binary's stdout.
      const verdict = status!.targets[0]!.dependencies[0]!;
      expect(verdict.dependsOn).toBe(dependency.id);
      expect(verdict.branch).toBe("never_deployed");
      expect(verdict.satisfied).toBe(false);
    } finally {
      await cli.cleanup();
    }
  }, 180_000);

  it("`wait-status` and `explain` both PRINT the dependency, the place and the branch", async () => {
    const { change, dependency, dependant } = await heldChange();
    const cli: CliInvocation = await startCliSession(server.baseUrl);
    try {
      await cli.run(["login", "--username", org.adminUsername, "--password", org.adminPassword]);

      // Asserted on BOTH commands because they are two independent call sites of the same renderer,
      // and `explain` is the one an operator reaches for first — it was also the one where the hold
      // was previously reduced to a single undifferentiated `decisions[]` row.
      for (const argv of [
        ["change", "wait-status", change.id],
        ["change", "explain", change.id]
      ]) {
        const { stdout } = await cli.run(argv);
        const where = argv[1]!;
        // WHO is waited on, WHERE, and WHY. Names and a branch token, never a whole sentence — a
        // pinned sentence would go green on a reword that stopped reading the field entirely.
        expect(stdout, where).toContain(dependency.name);
        expect(stdout, where).toContain(dependant.name);
        expect(stdout, where).toContain(gamma.name);
        expect(stdout, where).toContain("never_deployed");
        expect(stdout, where).toContain("HELD");
      }

      // `explain` still prints everything it printed before — the section is an addition, and the
      // plan whose target sits at `pending` is the thing the section explains.
      const { stdout } = await cli.run(["change", "explain", change.id]);
      expect(stdout).toContain("Decisions (");
      expect(stdout).toContain("pending");
    } finally {
      await cli.cleanup();
    }
  }, 180_000);

  it("an UNCOUPLED change grows no stage-dependency section in `explain`, and says so standalone", async () => {
    // The boundary that keeps the section from becoming noise on every change in the estate — and
    // the case where a "coupled nothing" line printed for a server that simply said nothing would be
    // a fabricated observation. `wait-status` is the focused view, so it earns the explicit line;
    // `explain` has a whole plan below it and stays silent.
    const plain = await componentAtGamma("cli-plain");
    const change = await admin.changes.propose({
      name: `cli-uncoupled-${randomUUID().slice(0, 8)}`,
      targets: [plain.id],
      topology: topologyId
    });
    const explained = await admin.changes.explain(change.id);
    expect(explained.stageDependencyStatus ?? null).toBeNull();

    const cli: CliInvocation = await startCliSession(server.baseUrl);
    try {
      await cli.run(["login", "--username", org.adminUsername, "--password", org.adminPassword]);
      const waitStatus = await cli.run(["change", "wait-status", change.id]);
      expect(waitStatus.stdout).toContain("coupled nothing");
      const explain = await cli.run(["change", "explain", change.id]);
      expect(explain.stdout).not.toContain("Stage dependencies");
      expect(explain.stdout).not.toContain("coupled nothing");
    } finally {
      await cli.cleanup();
    }
  }, 180_000);
});
