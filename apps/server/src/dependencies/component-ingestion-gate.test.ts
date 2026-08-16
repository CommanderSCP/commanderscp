import { describe, expect, it } from "vitest";
import {
  mergeComponentIngestionGate,
  mergeDependencySubscription,
  type DependencySubscriptionCandidate
} from "./subscription-resolution.js";

/**
 * M21.2 — THE GATE THAT DECIDES WHETHER A COMPONENT'S MANIFESTS ARE FETCHED AT ALL (ADR-0032 §6).
 *
 * ADR-0032 §6 states the consequence in two deliberately different verbs: "a disabled component is
 * never FETCHED and an opted-out dependency is never POLLED". Ingestion is a fetch, so it is gated
 * by the chain's first two conjuncts — and the whole point of `mergeComponentIngestionGate` is that
 * it decides that by running the REAL merge over witness lines rather than by writing
 * `instanceUnlocked && candidates.some(...)` a second time.
 *
 * These tests are therefore about EXACTNESS, not about the boolean. An approximate gate is
 * defensible in the safe direction and would still be wrong: a component whose org-wide enable
 * survives one narrow opt-out must still be fetched, or its inventory freezes for a reason nobody
 * can see. Each case below is paired with what `mergeDependencySubscription` itself says about a
 * concrete line, so a drift between the two is a failure rather than a matter of opinion.
 */
describe("M21.2 component ingestion gate (ADR-0032 §6)", () => {
  const unlocked = { unlocked: true, source: "instance:test" };
  const locked = { unlocked: false, source: "instance:test" };

  const candidate = (
    effect: unknown,
    extra: Partial<DependencySubscriptionCandidate> = {}
  ): DependencySubscriptionCandidate => ({
    tier: "component",
    source: "policy:test",
    effect,
    ...extra
  });

  it("is CLOSED with no contributions at all — absent never means enabled", () => {
    const gate = mergeComponentIngestionGate({ instance: unlocked, candidates: [] });
    expect(gate.enabled).toBe(false);
    expect(gate.reason).toBe("no_enabling_contribution");
  });

  it("is CLOSED when the deployment is locked, however many enables there are", () => {
    const gate = mergeComponentIngestionGate({
      instance: locked,
      candidates: [candidate({ enabled: true })]
    });
    expect(gate.enabled).toBe(false);
    expect(gate.reason).toBe("instance_locked");
    // The explanation still comes from the merge, so "which level turned this off" is answerable
    // from the gate's own result rather than only from a per-line resolution somewhere else.
    expect(gate.contributions.some((c) => c.tier === "instance" && c.contributed === "lock")).toBe(
      true
    );
  });

  it("is OPEN for a bare enable, and names the witness line the merge was satisfied on", () => {
    const gate = mergeComponentIngestionGate({
      instance: unlocked,
      candidates: [candidate({ enabled: true })]
    });
    expect(gate.enabled).toBe(true);
    expect(gate.reason).toBe("enabled");
    expect(gate.witness).toBeDefined();
    // The witness is a real answer, not a label: the same merge over that same line agrees.
    expect(
      mergeDependencySubscription({
        line: gate.witness!,
        instance: unlocked,
        candidates: [candidate({ enabled: true })]
      }).enabled
    ).toBe(true);
  });

  it("STAYS OPEN when a narrow opt-out removes only some of what a broad enable covers", () => {
    // THE CASE AN APPROXIMATE GATE GETS WRONG IN THE OTHER DIRECTION — and the case a naive
    // "is anything left?" implementation gets wrong here. `@acme/lib` is opted out; every other
    // npm line this component declares is still subscribed, so its manifests must still be read.
    const candidates = [
      candidate({ enabled: true }),
      candidate({ coordinate: "@acme/lib", enabled: false })
    ];
    const gate = mergeComponentIngestionGate({ instance: unlocked, candidates });
    expect(gate.enabled).toBe(true);
    // Cross-checked against the merge on a line the opt-out does NOT name.
    expect(
      mergeDependencySubscription({
        line: { ecosystem: "npm", coordinate: "@other/lib", major: "1" },
        instance: unlocked,
        candidates
      }).enabled
    ).toBe(true);
  });

  it("CLOSES when the opt-out covers everything the enable covers", () => {
    const candidates = [candidate({ enabled: true }), candidate({ enabled: false })];
    const gate = mergeComponentIngestionGate({ instance: unlocked, candidates });
    expect(gate.enabled).toBe(false);
    expect(gate.reason).toBe("no_enabling_contribution");
    // And the merge agrees about an arbitrary concrete line: there is nothing left to subscribe.
    expect(
      mergeDependencySubscription({
        line: { ecosystem: "npm", coordinate: "@other/lib", major: "9" },
        instance: unlocked,
        candidates
      }).enabled
    ).toBe(false);
  });

  it("CLOSES when the only enable is exactly cancelled by an equally narrow opt-out", () => {
    const candidates = [
      candidate({ ecosystem: "npm", coordinate: "@acme/lib", major: "1", enabled: true }),
      candidate({ ecosystem: "npm", coordinate: "@acme/lib", major: "1", enabled: false })
    ];
    expect(mergeComponentIngestionGate({ instance: unlocked, candidates }).enabled).toBe(false);
  });

  it("STAYS OPEN when the opt-out is NARROWER than the enable on a different axis", () => {
    // The enable covers every `npm` line; the opt-out covers major `1` of every ecosystem. Lines on
    // npm major 2 survive both, so there is work to do — a gate that compared the two selectors
    // pairwise rather than asking the merge would get this wrong.
    const candidates = [
      candidate({ ecosystem: "npm", enabled: true }),
      candidate({ major: "1", enabled: false })
    ];
    expect(mergeComponentIngestionGate({ instance: unlocked, candidates }).enabled).toBe(true);
    expect(
      mergeDependencySubscription({
        line: { ecosystem: "npm", coordinate: "@acme/lib", major: "2" },
        instance: unlocked,
        candidates
      }).enabled
    ).toBe(true);
  });

  it("does NOT open on a conditional enable — an unevaluable condition may never enable", () => {
    const gate = mergeComponentIngestionGate({
      instance: unlocked,
      candidates: [candidate({ enabled: true }, { conditional: true })]
    });
    expect(gate.enabled).toBe(false);
    // Reported, not dropped: the contribution appears as `ignored` so the operator can see that a
    // policy WAS found and why it did not count.
    expect(
      gate.contributions.some(
        (c) => c.contributed === "ignored" && c.ignoredReason === "condition_unevaluable"
      )
    ).toBe(true);
  });

  it("does NOT open on a malformed effect, and reports it", () => {
    const gate = mergeComponentIngestionGate({
      instance: unlocked,
      // `strictObject`: a mistyped selector key is refused rather than stripped, which is what stops
      // one transposed character from becoming a wildcard subscription.
      candidates: [candidate({ enabled: true, coordinat: "@acme/lib" })]
    });
    expect(gate.enabled).toBe(false);
    expect(
      gate.contributions.some((c) => c.contributed === "ignored" && c.ignoredReason === "malformed")
    ).toBe(true);
  });

  it("is not fooled by a selector that happens to equal the witness placeholder", () => {
    // The placeholder is derived from the values the candidates actually name, so an adversarial
    // coordinate cannot collide with it and turn a wildcard opt-out into a miss. The literal below
    // is the placeholder's own starting value, which is the only string worth testing here.
    const collide = "(no dependency line has this)";
    const candidates = [
      candidate({ enabled: true }),
      candidate({ coordinate: collide, enabled: false })
    ];
    const gate = mergeComponentIngestionGate({ instance: unlocked, candidates });
    expect(gate.enabled).toBe(true);
    expect(gate.witness?.coordinate).not.toBe(collide);
  });

  it("is order-independent — the gate inherits the merge's commutativity", () => {
    const a = candidate({ ecosystem: "npm", enabled: true });
    const b = candidate({ major: "1", enabled: false });
    const c = candidate({ coordinate: "@acme/lib", enabled: true });
    const forward = mergeComponentIngestionGate({ instance: unlocked, candidates: [a, b, c] });
    const backward = mergeComponentIngestionGate({ instance: unlocked, candidates: [c, b, a] });
    expect(forward.enabled).toBe(backward.enabled);
    expect(forward.reason).toBe(backward.reason);
    // AND THE WITNESS ITSELF, which the verdict above does not cover. It used to be "the first
    // selector that opened the gate", taken from a candidate list that arrives in the order an
    // UNORDERED SELECT returned — so two identical runs could disagree. Any consumer that records
    // it (the ingestion Decision did) then re-opens the persist-on-change guard, which exists
    // because a churning Decision measured 1.44 GB/day (ADR-0024).
    expect(forward.witness).toEqual(backward.witness);
  });

  describe("`ecosystem` is a CLOSED ENUM, so a witness outside it is not a line that can exist", () => {
    /**
     * The fresh-value trick is right for `coordinate` and `major` — open strings, where a value no
     * selector names is a value some real line could have. It is WRONG for `ecosystem`, whose whole
     * domain is the five members of the enum. A witness carrying an invented sixth is matched by no
     * ecosystem-scoped opt-out at all.
     */
    const allEcosystems = ["npm", "go", "maven", "python", "oci"] as const;

    it("CLOSES when per-ecosystem opt-outs between them cover every line that could exist", () => {
      // Five effects that are not one bare disable, and that together subtract everything the
      // org-wide enable covers. The gate used to stay OPEN here — so the component was fetched, and
      // therefore PRUNED, on every accepted change, forever, for a subscription that can never
      // produce a single subscribed line.
      const candidates = [
        candidate({ enabled: true }),
        ...allEcosystems.map((ecosystem) => candidate({ ecosystem, enabled: false }))
      ];
      const gate = mergeComponentIngestionGate({ instance: unlocked, candidates });
      expect(gate.enabled).toBe(false);
      expect(gate.reason).toBe("no_enabling_contribution");
      // The merge agrees about every concrete line, one per ecosystem — the gate is not merely
      // conservative here, it is right.
      for (const ecosystem of allEcosystems) {
        expect(
          mergeDependencySubscription({
            line: { ecosystem, coordinate: "@acme/anything", major: "1" },
            instance: unlocked,
            candidates
          }).enabled
        ).toBe(false);
      }
    });

    it("STAYS OPEN when even ONE ecosystem is left — the fix must not close the gate too eagerly", () => {
      // The negative control. Four of five opted out: every `oci` line this component declares is
      // still subscribed, so its manifests must still be read.
      const candidates = [
        candidate({ enabled: true }),
        ...allEcosystems
          .filter((e) => e !== "oci")
          .map((ecosystem) => candidate({ ecosystem, enabled: false }))
      ];
      const gate = mergeComponentIngestionGate({ instance: unlocked, candidates });
      expect(gate.enabled).toBe(true);
      expect(gate.witness?.ecosystem).toBe("oci");
      expect(
        mergeDependencySubscription({
          line: { ecosystem: "oci", coordinate: "docker.io/library/alpine", major: "3" },
          instance: unlocked,
          candidates
        }).enabled
      ).toBe(true);
    });

    it("never proposes a witness outside the enum", () => {
      const gate = mergeComponentIngestionGate({
        instance: unlocked,
        candidates: [candidate({ enabled: true })]
      });
      expect(allEcosystems).toContain(gate.witness?.ecosystem);
    });
  });
});
