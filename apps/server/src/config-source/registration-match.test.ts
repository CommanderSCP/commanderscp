import { describe, expect, it } from "vitest";
import {
  normalizeConfigSourceRepoIdentity,
  resolveConfigSourceForSync,
  type ConfigSourceRegistration
} from "./registration-match.js";

const reg = (
  over: Partial<ConfigSourceRegistration> & { id: string }
): ConfigSourceRegistration => ({
  team: "team-default",
  ...over
});

describe("resolveConfigSourceForSync", () => {
  it("matches an exact single-repo registration, case-folded (manifest-reader.ts's identity rule)", () => {
    const registrations = [reg({ id: "r1", repo: "Payments/Payments-API", team: "team-payments" })];
    const result = resolveConfigSourceForSync(registrations, "payments/payments-api", "stack-a");
    expect(result).toEqual({
      outcome: "matched",
      registration: registrations[0],
      team: "team-payments"
    });
  });

  it("does not match an exact registration by prefix", () => {
    const registrations = [reg({ id: "r1", repo: "acme/widgets", team: "team-a" })];
    const result = resolveConfigSourceForSync(registrations, "acme/widgets-fork", "stack-a");
    expect(result).toEqual({ outcome: "no_match" });
  });

  it("matches a namespace/pattern registration covering a team's whole fleet", () => {
    const registrations = [reg({ id: "r1", repoPattern: "payments/*", team: "team-payments" })];
    const result = resolveConfigSourceForSync(registrations, "payments/payments-api", "stack-a");
    expect(result).toEqual({
      outcome: "matched",
      registration: registrations[0],
      team: "team-payments"
    });
  });

  it("resolves 'no_match' as an ordinary outcome for an unregistered repo", () => {
    const registrations = [reg({ id: "r1", repo: "acme/widgets", team: "team-a" })];
    const result = resolveConfigSourceForSync(registrations, "acme/gadgets", "stack-a");
    expect(result).toEqual({ outcome: "no_match" });
  });

  it("refuses loudly, naming both, when a repo is matched by two registrations", () => {
    const r1 = reg({ id: "r2", repoPattern: "payments/*", team: "team-payments" });
    const r2 = reg({ id: "r1", repo: "payments/payments-api", team: "team-platform" });
    const result = resolveConfigSourceForSync([r1, r2], "payments/payments-api", "stack-a");
    expect(result.outcome).toBe("ambiguous_repo");
    if (result.outcome !== "ambiguous_repo") throw new Error("unreachable");
    // Sorted by id, never last-writer-wins / array order.
    expect(result.matches).toEqual([r2, r1]);
  });

  it("refuses loudly, naming the owner, when a stack name is already owned by a different registration", () => {
    const owner = reg({
      id: "r1",
      repo: "acme/billing",
      team: "team-billing",
      stackTeams: { "shared-stack": "team-billing" }
    });
    const matched = reg({ id: "r2", repo: "acme/payments", team: "team-payments" });
    const result = resolveConfigSourceForSync([owner, matched], "acme/payments", "shared-stack");
    expect(result).toEqual({
      outcome: "stack_owned_elsewhere",
      stackName: "shared-stack",
      matchedRegistration: matched,
      owner
    });
  });

  it("does not refuse when the matched registration itself owns the stack name", () => {
    const registrations = [
      reg({
        id: "r1",
        repo: "acme/payments",
        team: "team-payments",
        stackTeams: { "payments-api": "team-payments-core" }
      })
    ];
    const result = resolveConfigSourceForSync(registrations, "acme/payments", "payments-api");
    expect(result).toEqual({
      outcome: "matched",
      registration: registrations[0],
      team: "team-payments-core"
    });
  });

  it("checks ambiguous_repo before stack ownership: an ambiguous repo never reaches the stack check", () => {
    const r1 = reg({
      id: "r1",
      repo: "acme/payments",
      team: "team-a",
      stackTeams: { x: "team-a" }
    });
    const r2 = reg({ id: "r2", repoPattern: "acme/*", team: "team-b" });
    const result = resolveConfigSourceForSync([r1, r2], "acme/payments", "x");
    expect(result.outcome).toBe("ambiguous_repo");
  });

  it("the four outcomes are pairwise distinguishable by `outcome` alone", () => {
    const owner = reg({ id: "r1", repo: "a/one", team: "team-a", stackTeams: { s: "team-a" } });
    const matched = reg({ id: "r2", repo: "a/two", team: "team-b" });
    const dup1 = reg({ id: "r3", repo: "a/three", team: "team-c" });
    const dup2 = reg({ id: "r4", repo: "a/three", team: "team-d" });
    const all = [owner, matched, dup1, dup2];

    const outcomes = new Set([
      resolveConfigSourceForSync(all, "a/none", "s").outcome,
      resolveConfigSourceForSync(all, "a/two", "s").outcome,
      resolveConfigSourceForSync(all, "a/three", "s").outcome,
      resolveConfigSourceForSync(all, "a/one", "s").outcome
    ]);
    expect(outcomes).toEqual(
      new Set(["no_match", "stack_owned_elsewhere", "ambiguous_repo", "matched"])
    );
  });

  it("treats a registration naming neither repo nor repoPattern as matching nothing", () => {
    const registrations = [reg({ id: "r1", team: "team-a" })];
    const result = resolveConfigSourceForSync(registrations, "acme/anything", "stack-a");
    expect(result).toEqual({ outcome: "no_match" });
  });
});

describe("normalizeConfigSourceRepoIdentity", () => {
  it("trims, strips surrounding slashes, and lowercases", () => {
    expect(normalizeConfigSourceRepoIdentity("  /Acme/Widgets/  ")).toBe("acme/widgets");
  });
});
