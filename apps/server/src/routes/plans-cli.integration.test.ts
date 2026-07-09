import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { App, Service, Stack, synthToFile } from "@scp/iac";
import {
  createTestOrg,
  listenTestServer,
  type ListeningTestServer
} from "../test-support/harness.js";
import { startCliSession, type CliInvocation } from "../test-support/cli-runner.js";

interface ApplyJsonOutput {
  planId: string;
  stackName: string;
  status: string;
  creates: number;
  updates: number;
  deletes: number;
  noops: number;
}

interface PlanJsonOutput {
  id: string;
  stackName: string;
  status: string;
  diff: { summary: { creates: number; updates: number; deletes: number; noops: number } };
}

/**
 * BUILD_AND_TEST.md §8 M2 DoD (b), literal wording: "an `@scp/iac` stack applied twice is a
 * no-op the second time (plan shows zero actions) ... integration + a CLI-driven test." Uses
 * `startCliSession` (test-support/cli-runner.ts) to spawn the REAL BUILT `scp` binary, same
 * pattern as `graph/custom-type.integration.test.ts`'s CLI half — a genuine black-box exercise of
 * `scp plan`/`scp apply`, not an in-process shortcut.
 */
describe("plans: CLI-driven no-op-on-second-apply (DoD (b))", () => {
  let server: ListeningTestServer;

  beforeAll(async () => {
    server = await listenTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it("`scp plan` then `scp apply` twice — the second apply's printed summary is all-zero (all noop)", async () => {
    const org = await createTestOrg(server, "plans-cli");
    const cli: CliInvocation = await startCliSession(server.baseUrl);
    const dir = await mkdtemp(path.join(os.tmpdir(), "scp-iac-cli-test-"));
    try {
      await cli.run(["login", "--username", org.adminUsername, "--password", org.adminPassword]);

      // The manifest file is exactly what `@scp/iac`'s `synthToFile` writes — the CLI never
      // imports/executes the IaC TypeScript program itself, only the synthesized JSON (module
      // doc, packages/cli/src/cli.ts's plan/apply section).
      const stackName = `cli-stack-${randomUUID().slice(0, 8)}`;
      const app = new App();
      const stack = new Stack(app, stackName);
      new Service(stack, "svc", { name: "Svc", properties: { tier: "high" } });
      const manifestPath = path.join(dir, "manifest.json");
      await synthToFile(stack, manifestPath);

      const planResult = await cli.runJson<PlanJsonOutput>(["plan", "--manifest", manifestPath]);
      expect(planResult.stackName).toBe(stackName);
      expect(planResult.diff.summary).toEqual({ creates: 1, updates: 0, deletes: 0, noops: 0 });

      const firstApply = await cli.runJson<ApplyJsonOutput>(["apply", "--manifest", manifestPath]);
      expect(firstApply).toMatchObject({
        stackName,
        status: "applied",
        creates: 1,
        updates: 0,
        deletes: 0,
        noops: 0
      });

      // The literal DoD assertion: `scp apply` run AGAIN with the same manifest file shows zero
      // creates/updates/deletes — a machine-parseable count via `--output json`, not just prose.
      const secondApply = await cli.runJson<ApplyJsonOutput>(["apply", "--manifest", manifestPath]);
      expect(secondApply).toMatchObject({
        stackName,
        status: "applied",
        creates: 0,
        updates: 0,
        deletes: 0,
        noops: 1
      });

      // `scp plan-status` round-trips the second apply's plan id.
      const status = await cli.runJson<PlanJsonOutput>(["plan-status", secondApply.planId]);
      expect(status.status).toBe("applied");
    } finally {
      await cli.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
