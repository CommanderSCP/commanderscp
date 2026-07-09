import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestOrg,
  listenTestServer,
  type ListeningTestServer
} from "../test-support/harness.js";
import { startCliSession, type CliInvocation } from "../test-support/cli-runner.js";

/**
 * `scp service register` is named explicitly in BUILD_AND_TEST.md's charter verification table
 * and used by later E2E/seed work, so it — and its 7 sibling `register` commands plus the
 * ownership convenience commands — must exist with these exact names against the real built CLI
 * binary (test-support/cli-runner.ts), not just typecheck. Mirrors
 * graph/custom-type.integration.test.ts's CLI black-box style.
 */
describe("CLI: M2 typed registry + ownership commands", () => {
  let server: ListeningTestServer;

  beforeAll(async () => {
    server = await listenTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it("`scp service register` + `scp domain register` + ownership commands round-trip", async () => {
    const org = await createTestOrg(server, "cli-typed-registries");
    const cli: CliInvocation = await startCliSession(server.baseUrl);
    try {
      await cli.run(["login", "--username", org.adminUsername, "--password", org.adminPassword]);

      const service = await cli.runJson<{ id: string; typeId: string; name: string }>([
        "service",
        "register",
        "--name",
        "cli-checkout-service"
      ]);
      expect(service.typeId).toBe("service");
      expect(service.name).toBe("cli-checkout-service");

      const domain = await cli.runJson<{ id: string; typeId: string }>([
        "domain",
        "register",
        "--name",
        "cli-platform-domain"
      ]);
      expect(domain.typeId).toBe("domain");

      const team = await cli.runJson<{ id: string; typeId: string }>([
        "team",
        "register",
        "--name",
        "cli-platform-team"
      ]);
      expect(team.typeId).toBe("team");

      const listed = await cli.runJson<Array<{ id: string; name: string }>>(["service", "list"]);
      expect(listed.some((s) => s.id === service.id)).toBe(true);

      const owned = await cli.runJson<{ id: string; typeId: string; fromId: string; toId: string }>(
        ["service", "add-owner", service.id, "--owner", team.id]
      );
      expect(owned.typeId).toBe("owns");
      expect(owned.fromId).toBe(team.id);
      expect(owned.toId).toBe(service.id);

      const owners = await cli.runJson<Array<{ id: string }>>([
        "service",
        "list-owners",
        service.id
      ]);
      expect(owners.some((o) => o.id === owned.id)).toBe(true);

      const svcB = await cli.runJson<{ id: string }>([
        "service",
        "register",
        "--name",
        "cli-checkout-dependency"
      ]);
      const dependsOn = await cli.runJson<{ typeId: string }>([
        "service",
        "add-depends-on",
        service.id,
        "--target",
        svcB.id
      ]);
      expect(dependsOn.typeId).toBe("depends_on");
    } finally {
      await cli.cleanup();
    }
  });
});
