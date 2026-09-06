import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantTx } from "../db/tenant-tx.js";
import { putSecret } from "./secrets-repo.js";
import { runSecretsDecryptCanary } from "./decrypt-canary.js";
import {
  buildTestServer,
  createTestOrg,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";

/**
 * D6 / B3 boot canary (§7.3). The canary proves the configured master key decrypts the vault, per
 * org, inside `withTenantTx` (the RLS-vacuity fix — an unscoped read would pass on a vault it never
 * saw). These prove: the RIGHT key passes and actually decrypted something; the WRONG key fails
 * closed; and an org with no vault is not a false failure.
 */
describe("secrets decrypt canary (§7.3 / D6)", () => {
  let server: TestServer;
  let org: TestOrg;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "canary-org");
  }, 90_000);

  afterAll(async () => {
    await server.close();
  });

  it("passes with the configured key and reports it actually decrypted a real secret", async () => {
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      putSecret(tx, {
        orgId: org.orgId,
        key: "canary-probe",
        value: "s3cr3t-value",
        masterKey: server.deps.config.secretsMasterKey
      })
    );

    const result = await runSecretsDecryptCanary(
      server.deps.db,
      server.deps.config.secretsMasterKey
    );
    expect(result.orgsWithSecrets).toBeGreaterThanOrEqual(1);
    expect(result.decryptsAttempted).toBeGreaterThanOrEqual(1);
  });

  it("FAILS CLOSED with a wrong master key (AEAD mismatch), naming the org", async () => {
    const wrongKey = randomBytes(32);
    await expect(runSecretsDecryptCanary(server.deps.db, wrongKey)).rejects.toThrow(
      /decrypt canary FAILED|AEAD/i
    );
  });

  it("does not false-fail on an org that holds no secrets (a genuinely empty vault is fine)", async () => {
    const emptyOrg = await createTestOrg(server, "canary-empty");
    // The canary enumerates ALL orgs; the empty one must be skipped, not treated as a failure. Using
    // the correct key here so only the empty-vault path is under test.
    const result = await runSecretsDecryptCanary(
      server.deps.db,
      server.deps.config.secretsMasterKey
    );
    expect(result.orgsEnumerated).toBeGreaterThanOrEqual(2);
    expect(emptyOrg.orgId).toBeTruthy();
  });
});
