import { describe, expect, it } from "vitest";
import { extractHint } from "./webhook-processor.js";

/**
 * ADR-0028 increment 1 — the INGRESS half of the declaration channel.
 *
 * The one line worth a test here is the ADAPTER-BRANCH RE-FORWARD. `extractHint` reconstructs the
 * hint FIELD BY FIELD when a source kind resolves a webhook adapter, rather than spreading the
 * generic shape, so a field that is not named there is dropped SILENTLY — no error, no marker, the
 * release simply runs uncoupled. `provides`/`requires` had to be explicitly re-forwarded for exactly
 * this reason (`webhook-processor.ts`'s own comment says so), and `stageDependencies` is the third.
 *
 * It is a REACHABLE case, not a theoretical one: a first-party `scp change-source report` for
 * sourceKind `github` sends a flat typed body AND resolves the github adapter.
 *
 * Also pinned: malformed input is carried, not dropped. `stageDependencies` sits with `requires`,
 * not with `provides`, because dropping it fails OPEN — the release would deploy with no hold at
 * all, ahead of every component its author named.
 */
describe("extractHint: stageDependencies survives ingress (ADR-0028)", () => {
  const DEP = { dependsOn: "urn:scp:acme:component:b", minWeight: 10, atTargets: ["dt-gamma"] };

  it("reads a well-formed declaration off the flat first-party body", () => {
    // `terraform` resolves no adapter — the plain generic path.
    const hint = extractHint("terraform", {}, { repo: "acme/a", stageDependencies: [DEP] });
    expect(hint.stageDependencies).toEqual([DEP]);
    expect(hint.stageDependenciesInvalid).toBeUndefined();
  });

  it("an absent or empty declaration leaves the hint byte-identical to a pre-ADR-0028 one", () => {
    expect(extractHint("terraform", {}, { repo: "acme/a" })).not.toHaveProperty(
      "stageDependencies"
    );
    expect(
      extractHint("terraform", {}, { repo: "acme/a", stageDependencies: [] })
    ).not.toHaveProperty("stageDependencies");
    expect(
      extractHint("terraform", {}, { repo: "acme/a", stageDependencies: null })
    ).not.toHaveProperty("stageDependenciesInvalid");
  });

  it("THE RE-FORWARD: a body that ALSO resolves a provider adapter keeps its declaration", () => {
    // A github push body the adapter can map, carrying the flat first-party coupling fields beside
    // it. If the adapter branch stopped naming `stageDependencies`, this is the assertion that
    // fails — and without it the loss is invisible.
    const payload = {
      ref: "refs/heads/main",
      repository: { full_name: "acme/a" },
      after: "0".repeat(40),
      stageDependencies: [DEP]
    };
    const hint = extractHint("github", { "x-github-event": "push" }, payload);
    expect(hint.repo).toBe("acme/a"); // the adapter really did fire — otherwise this proves nothing
    expect(hint.stageDependencies).toEqual([DEP]);
  });

  it("THE RE-FORWARD, invalid half: a malformed declaration reaches the processor's refusal too", () => {
    const payload = {
      ref: "refs/heads/main",
      repository: { full_name: "acme/a" },
      after: "0".repeat(40),
      stageDependencies: [{ minWeight: 10 }]
    };
    const hint = extractHint("github", { "x-github-event": "push" }, payload);
    expect(hint.repo).toBe("acme/a");
    expect(hint.stageDependencies).toBeUndefined();
    expect(hint.stageDependenciesInvalid).toEqual([{ minWeight: 10 }]);
  });

  it("a malformed declaration is CARRIED as invalid, never dropped (fail-closed, as `requires` is)", () => {
    for (const bad of [
      "comp-b",
      [{ minWeight: 10 }],
      [{ dependsOn: "" }],
      [{ dependsOn: "b", minWeight: 0 }],
      [{ dependsOn: "b", minWeight: 101 }],
      [{ dependsOn: "b", atTargets: "dt-1" }],
      [{ dependsOn: "b", unknownKey: true }] // strictObject: an undeclared key is refused, not stripped
    ]) {
      const hint = extractHint("terraform", {}, { repo: "acme/a", stageDependencies: bad });
      expect(hint.stageDependencies, JSON.stringify(bad)).toBeUndefined();
      expect(hint.stageDependenciesInvalid, JSON.stringify(bad)).toEqual(bad);
    }
  });
});
