import { describe, expect, it } from "vitest";
import { assertProductionSecretsOrThrow, federationRoleUndeclaredWarning } from "./boot-checks.js";

/** §8.9 — an undeclared federation role is load-bearing, so boot names it. */
describe("federationRoleUndeclaredWarning", () => {
  it("an UNDECLARED role yields exactly one line naming the variable and the consequence", () => {
    const line = federationRoleUndeclaredWarning({ federationRoleDeclared: false });
    expect(line).not.toBeNull();
    expect(line).not.toContain("\n");
    expect(line).toContain("SCP_FEDERATION_ROLE is not set");
    expect(line).toMatch(/promotion export, cosign key minting and dependency automation.*REFUSED/);
  });

  it("a DECLARED role is silent", () => {
    expect(federationRoleUndeclaredWarning({ federationRoleDeclared: true })).toBeNull();
  });
});

/** D6 (§7.3) boot-refusal gate. */
describe("assertProductionSecretsOrThrow (D6)", () => {
  it("REFUSES production boot on an ephemeral generated secrets master key", () => {
    expect(() =>
      assertProductionSecretsOrThrow({
        deploymentMode: "production",
        secretsMasterKeyWasGenerated: true,
        cookieSecretWasGenerated: false
      })
    ).toThrow(/SCP_SECRETS_MASTER_KEY/);
  });

  it("REFUSES production boot on an ephemeral generated cookie secret, naming both when both are ephemeral", () => {
    expect(() =>
      assertProductionSecretsOrThrow({
        deploymentMode: "production",
        secretsMasterKeyWasGenerated: true,
        cookieSecretWasGenerated: true
      })
    ).toThrow(/SCP_SECRETS_MASTER_KEY and SCP_COOKIE_SECRET/);
  });

  it("ALLOWS production boot when both secrets were operator-provided (not generated)", () => {
    expect(() =>
      assertProductionSecretsOrThrow({
        deploymentMode: "production",
        secretsMasterKeyWasGenerated: false,
        cookieSecretWasGenerated: false
      })
    ).not.toThrow();
  });

  it("ALLOWS evaluation mode to boot on ephemeral secrets (dev/eval convenience)", () => {
    expect(() =>
      assertProductionSecretsOrThrow({
        deploymentMode: "evaluation",
        secretsMasterKeyWasGenerated: true,
        cookieSecretWasGenerated: true
      })
    ).not.toThrow();
  });
});
