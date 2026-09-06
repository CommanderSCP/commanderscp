import { describe, expect, it } from "vitest";
import type { DependencyLineKey } from "@scp/schemas";
import {
  mergeDependencySubscription,
  type DependencySubscriptionCandidate,
  type MergeDependencySubscriptionInput
} from "./subscription-resolution.js";
import {
  mergeContributorEffects,
  type MatchedPolicy,
  type PolicyEffect
} from "../governance/policy-model.js";

/**
 * M21.3 — THE ENABLEMENT MERGE, as a pure function (ADR-0032 §6).
 *
 *     effective_enabled(component, line) =
 *         instance_unlocked  AND  component_enabled  AND  NOT line_opted_out
 *
 * Every property below is a property of the ALGEBRA, not of a database, which is exactly why the
 * merge was extracted as a pure function (BUILD_AND_TEST.md §4.1). No Postgres here; the DB-backed
 * half is proven in `subscription-resolution.integration.test.ts`.
 *
 * Seven properties are load-bearing and each is asserted in the direction that can FAIL OPEN:
 *
 *   1. ABSENT NEVER MEANS ENABLED. No contributions ⇒ not enabled.
 *   2. THE INSTANCE LEVEL UNLOCKS AND NEVER ACTIVATES. `unlocked` alone enables nothing (ADR-0006:
 *      managed execution is never a default).
 *   3. A DISABLE ALWAYS WINS over any number of enables at any tier.
 *   4. ORDER-INDEPENDENCE — proven by exhausting every permutation of the contribution list, not by
 *      one hand-picked shuffle.
 *   5. MOST-RESTRICTIVE-WINS for `granularity` and `delivery`; auto-merge is never acquired by
 *      merging two policies that each meant something safer.
 *  5b. SILENCE IS A VOTE, NOT AN ABSTENTION. (5) only ever composes two DECLARED values, and the
 *      composition that can fail open is SILENT + DECLARED — a component that authored
 *      `{enabled: true}` beside an org-wide `auto_merge`. Pinned in both arrangements.
 *   6. A MISTYPED SELECTOR KEY IS REFUSED, NOT STRIPPED INTO A WILDCARD — on an enable AND on an
 *      opt-out, the two directions being loose in different senses.
 *   7. A WILDCARD IS RECORDED EXPLICITLY (`selector: {}`), so an explanation never leaves
 *      "matched everything on purpose" and "matched everything by accident" looking alike.
 *
 * Every assertion of an ABSENCE carries a NEGATIVE CONTROL in the same test — a test proving nothing
 * happened is vacuous unless it also proves the thing that SHOULD happen did. Concretely: each
 * "not enabled" case is re-run with the one blocking element removed, and must come out enabled.
 */

const LINE: DependencyLineKey = { ecosystem: "npm", coordinate: "@acme/lib", major: "1" };

const UNLOCKED = { unlocked: true, source: "instance:dependency_subscription_unlock" };
const LOCKED = { unlocked: false, source: "instance:dependency_subscription_unlock" };

/** An enabling contribution at `tier`, with optional settings and selectors. */
function enable(
  tier: DependencySubscriptionCandidate["tier"],
  effect: Record<string, unknown> = {}
): DependencySubscriptionCandidate {
  return { tier, source: `policy:enable-${tier}@${tier}-id`, effect: { enabled: true, ...effect } };
}

function disable(
  tier: DependencySubscriptionCandidate["tier"],
  effect: Record<string, unknown> = {}
): DependencySubscriptionCandidate {
  return {
    tier,
    source: `policy:disable-${tier}@${tier}-id`,
    effect: { enabled: false, ...effect }
  };
}

function resolve(
  candidates: DependencySubscriptionCandidate[],
  instance = UNLOCKED,
  line: DependencyLineKey = LINE
): ReturnType<typeof mergeDependencySubscription> {
  return mergeDependencySubscription({ line, instance, candidates });
}

/** Every permutation of `items` — the honest form of "order cannot matter". A single shuffle can
 *  pass against an implementation that is sensitive to one specific adjacent swap. */
function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  const out: T[][] = [];
  items.forEach((item, i) => {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) out.push([item, ...p]);
  });
  return out;
}

describe("dependency-subscription enablement merge (ADR-0032 §6)", () => {
  // (1) ABSENT NEVER MEANS ENABLED

  it("(1) absent never means enabled — no contributions at all resolves NOT enabled", () => {
    const result = resolve([]);
    expect(result.enabled).toBe(false);
    expect(result.reason).toBe("not_enabled");

    // NEGATIVE CONTROL: the identical call with one enabling contribution DOES enable, so the
    // assertion above is about the absence of contributions and not about a merge that never
    // enables anything.
    expect(resolve([enable("component")]).enabled).toBe(true);
  });

  it("(1) a contribution whose selectors do not match the line does not enable it", () => {
    // A coordinate the line does not carry. Selectors are ANDed and compared verbatim.
    const other = enable("component", { coordinate: "@acme/other" });
    const result = resolve([other]);
    expect(result.enabled).toBe(false);
    expect(result.reason).toBe("not_enabled");
    // A non-matching contribution is not this line's business — it is left out of the explanation
    // entirely rather than reported as an ignored one.
    expect(result.contributions.map((c) => c.contributed)).toEqual(["unlock"]);

    // NEGATIVE CONTROL: the same shape with the line's OWN coordinate enables.
    expect(resolve([enable("component", { coordinate: "@acme/lib" })]).enabled).toBe(true);
  });

  it("(1) coordinates are compared VERBATIM — an opt-out for `@acme/lib` does not touch `acme-lib`", () => {
    // `graph/urn.ts`'s slugify collapses `@acme/lib`, `acme/lib` and `acme-lib` into ONE slug. If
    // this comparison normalised, one opt-out would silently un-subscribe three different packages.
    const slugCollision: DependencyLineKey = {
      ecosystem: "npm",
      coordinate: "acme-lib",
      major: "1"
    };
    const result = resolve(
      [enable("component"), disable("component", { coordinate: "@acme/lib" })],
      UNLOCKED,
      slugCollision
    );
    expect(result.enabled).toBe(true);

    // NEGATIVE CONTROL: the very same opt-out DOES bite the package it actually names.
    expect(
      resolve([enable("component"), disable("component", { coordinate: "@acme/lib" })], UNLOCKED, {
        ecosystem: "npm",
        coordinate: "@acme/lib",
        major: "1"
      }).enabled
    ).toBe(false);
  });

  it("(1) selectors are ANDed — ecosystem, coordinate and major must ALL match", () => {
    expect(resolve([enable("component", { coordinate: "@acme/lib", major: "2" })]).enabled).toBe(
      false
    );
    expect(
      resolve([enable("component", { ecosystem: "go", coordinate: "@acme/lib", major: "1" })])
        .enabled
    ).toBe(false);

    expect(
      resolve([enable("component", { ecosystem: "npm", coordinate: "@acme/lib", major: "1" })])
        .enabled
    ).toBe(true);
  });

  // (2) THE INSTANCE LEVEL UNLOCKS AND NEVER ACTIVATES (ADR-0006)

  it("(2) the instance level UNLOCKS and NEVER ACTIVATES — unlocked with no enabling contribution is NOT enabled", () => {
    const result = resolve([], UNLOCKED);
    expect(result.enabled).toBe(false);
    expect(result.reason).toBe("not_enabled");
    // The unlock IS carried as a contribution — it participated, it just cannot activate.
    expect(result.contributions).toEqual([
      { tier: "instance", source: "instance:dependency_subscription_unlock", contributed: "unlock" }
    ]);

    // NEGATIVE CONTROL: the unlock is genuinely load-bearing — with an enabling contribution
    // present, flipping ONLY the unlock flips the verdict.
    expect(resolve([enable("component")], UNLOCKED).enabled).toBe(true);
    expect(resolve([enable("component")], LOCKED).enabled).toBe(false);
  });

  it("(2) a locked instance defeats enables at every tier, and says so", () => {
    const everyTier = [
      enable("org"),
      enable("containment_domain"),
      enable("service"),
      enable("component")
    ];
    const locked = resolve(everyTier, LOCKED);
    expect(locked.enabled).toBe(false);
    expect(locked.reason).toBe("instance_locked");
    expect(locked.contributions.find((c) => c.tier === "instance")?.contributed).toBe("lock");

    // NEGATIVE CONTROL: the same four contributions with the deployment unlocked DO enable.
    expect(resolve(everyTier, UNLOCKED).enabled).toBe(true);
  });

  // (3) A DISABLE ALWAYS WINS

  it("(3) one disable defeats FOUR enables, and the disable may sit at ANY tier", () => {
    const enables = [
      enable("org"),
      enable("containment_domain"),
      enable("service"),
      enable("component")
    ];
    // The deepest level may only subtract — but so may every other level. Each tier gets a turn.
    for (const tier of ["org", "containment_domain", "service", "component"] as const) {
      const result = resolve([...enables, disable(tier)]);
      expect(result.enabled, `a disable at ${tier} must win`).toBe(false);
      expect(result.reason).toBe("disabled");
    }

    // NEGATIVE CONTROL: the four enables alone, with no disable, resolve ENABLED — so the four
    // assertions above are about the disable and not about an enable that never worked.
    expect(resolve(enables).enabled).toBe(true);
  });

  it("(3) a narrow opt-out subtracts exactly one line from a broad enable", () => {
    // The authoring shape ADR-0032 §6 exists for: "subscribe my component, but not acme-lib".
    const candidates = [enable("component"), disable("component", { coordinate: "@acme/lib" })];
    expect(resolve(candidates, UNLOCKED, LINE).enabled).toBe(false);

    // NEGATIVE CONTROL: every OTHER line of the same component stays subscribed.
    expect(
      resolve(candidates, UNLOCKED, { ecosystem: "npm", coordinate: "@acme/other", major: "1" })
        .enabled
    ).toBe(true);
  });

  // (4) ORDER-INDEPENDENCE

  it("(4) the whole result — verdict, settings AND explanation — is identical under every permutation", () => {
    const candidates = [
      enable("org", { delivery: "auto_merge" }),
      enable("service", { granularity: "minor_and_patch" }),
      enable("component", { granularity: "patch", delivery: "pull_request" }),
      disable("containment_domain", { coordinate: "@acme/other" }),
      { tier: "org" as const, source: "policy:broken@broken-id", effect: { enabled: "yes" } }
    ];
    const baseline = resolve(candidates);
    const perms = permutations(candidates);
    expect(perms).toHaveLength(120); // 5! — every ordering, not one sampled shuffle
    for (const perm of perms) {
      expect(resolve(perm)).toEqual(baseline);
    }

    // NEGATIVE CONTROL: the fixture is not trivially order-insensitive because it is uniform — it
    // carries competing settings and a mixture of admitted, ignored and non-matching contributions,
    // and it resolves to the tightened combination.
    expect(baseline.enabled).toBe(true);
    expect(baseline.granularity).toBe("patch");
    expect(baseline.delivery).toBe("pull_request");
    expect(baseline.contributions.filter((c) => c.contributed === "ignored")).toHaveLength(1);
  });

  it("(5) granularity: patch beats minor_and_patch — a child may only tighten", () => {
    expect(
      resolve([
        enable("org", { granularity: "minor_and_patch" }),
        enable("component", { granularity: "patch" })
      ]).granularity
    ).toBe("patch");

    // The other direction too: the tightening one may sit ABOVE the loosening one.
    expect(
      resolve([
        enable("org", { granularity: "patch" }),
        enable("component", { granularity: "minor_and_patch" })
      ]).granularity
    ).toBe("patch");

    // NEGATIVE CONTROL: `minor_and_patch` is reachable — when nothing tightens it, it survives.
    expect(
      resolve([
        enable("org", { granularity: "minor_and_patch" }),
        enable("component", { granularity: "minor_and_patch" })
      ]).granularity
    ).toBe("minor_and_patch");
  });

  it("(5) delivery: pull_request beats auto_merge — auto-merge is never ACQUIRED by merging", () => {
    // Two policies that each meant something safer must not combine into the privileged option.
    expect(
      resolve([
        enable("org", { delivery: "auto_merge" }),
        enable("component", { delivery: "pull_request" })
      ]).delivery
    ).toBe("pull_request");

    // NEGATIVE CONTROL: auto_merge IS reachable when every enabling contribution asked for it.
    expect(
      resolve([
        enable("org", { delivery: "auto_merge" }),
        enable("component", { delivery: "auto_merge" })
      ]).delivery
    ).toBe("auto_merge");
  });

  it("(5) absent settings resolve to the MOST RESTRICTIVE option, never the looser one", () => {
    const result = resolve([enable("component")]);
    expect(result.granularity).toBe("patch");
    expect(result.delivery).toBe("pull_request");

    // NEGATIVE CONTROL: the defaults are defaults, not constants — an explicit declaration wins.
    const declared = resolve([
      enable("component", { granularity: "minor_and_patch", delivery: "auto_merge" })
    ]);
    expect(declared.granularity).toBe("minor_and_patch");
    expect(declared.delivery).toBe("auto_merge");
  });

  it("(5) settings on an OPT-OUT are inert — only contributions that ENABLED are read", () => {
    // A `delivery: auto_merge` riding on an `enabled: false` must not be able to loosen anything.
    const result = resolve([
      enable("component", { delivery: "pull_request" }),
      disable("org", { coordinate: "@acme/other", delivery: "auto_merge" })
    ]);
    expect(result.enabled).toBe(true);
    expect(result.delivery).toBe("pull_request");

    // NEGATIVE CONTROL: the same value on an ENABLING contribution is read.
    expect(
      resolve([
        enable("component", { delivery: "auto_merge" }),
        enable("org", { delivery: "auto_merge" })
      ]).delivery
    ).toBe("auto_merge");
  });

  // -----------------------------------------------------------------------------------------
  // (5b) SILENCE IS A VOTE, NOT AN ABSTENTION — the silent+declared composition
  //
  // Every case above compares two DECLARED values, which is the composition that cannot fail open.
  // The one that CAN is silent-plus-declared: a component team authors `{enabled: true}` and says
  // nothing about delivery, and an ORG-WIDE policy declares `auto_merge`. If absence were "no
  // opinion", the MIN would be taken over the declared value alone and the team would be handed the
  // privileged option — SCP merging commits into their repo with no pull request — by a policy they
  // do not own and never read. ADR-0032 §8 puts the choice with the TEAM; 0062's header says
  // auto-merge is "never inherited from silence".
  //
  // So a silent contribution votes for the DEFAULT, and the answer to "may a broader scope grant
  // auto-merge to a narrower one that stayed silent?" is NO, pinned in both directions below.
  // -----------------------------------------------------------------------------------------

  it("(5b) a SILENT enable is not an abstention — a declared auto_merge beside it resolves pull_request", () => {
    // The measured defect, in its exact shape: the component asked for a subscription and nothing
    // more; the org asked for auto-merge.
    expect(resolve([enable("component"), enable("org", { delivery: "auto_merge" })]).delivery).toBe(
      "pull_request"
    );
    // …and the same in the other arrangement — a silent ORG beside a declaring COMPONENT. Silence
    // restricts from either side; there is no precedence in a MIN.
    expect(resolve([enable("org"), enable("component", { delivery: "auto_merge" })]).delivery).toBe(
      "pull_request"
    );

    // NEGATIVE CONTROL: auto_merge is genuinely reachable — remove the silent contribution and the
    // identical declaration wins. So the two assertions above are about the SILENCE, not about a
    // merge that can never produce auto_merge at all.
    expect(resolve([enable("org", { delivery: "auto_merge" })]).delivery).toBe("auto_merge");
    expect(
      resolve([
        enable("org", { delivery: "auto_merge" }),
        enable("component", { delivery: "auto_merge" })
      ]).delivery
    ).toBe("auto_merge");
  });

  it("(5b) a SILENT enable restricts granularity the same way — one rule, not two", () => {
    expect(
      resolve([enable("component"), enable("org", { granularity: "minor_and_patch" })]).granularity
    ).toBe("patch");
    expect(
      resolve([enable("org"), enable("component", { granularity: "minor_and_patch" })]).granularity
    ).toBe("patch");

    // NEGATIVE CONTROL: with no silent contribution in the set, the declaration stands.
    expect(
      resolve([
        enable("org", { granularity: "minor_and_patch" }),
        enable("component", { granularity: "minor_and_patch" })
      ]).granularity
    ).toBe("minor_and_patch");
  });

  it("(5b) a silent contribution that does NOT match the line does not restrict it", () => {
    // Silence only votes where it ENABLED. A silent enable naming a different package is not a
    // contribution to this line at all, so it must not drag this line's delivery back to
    // pull_request — otherwise auto-merge would become unreachable in any org with a second policy.
    expect(
      resolve([
        enable("component", { coordinate: "@acme/lib", delivery: "auto_merge" }),
        enable("org", { coordinate: "@acme/other" })
      ]).delivery
    ).toBe("auto_merge");

    // …nor does a silent OPT-OUT, which never reaches the settings at all.
    expect(
      resolve([
        enable("component", { delivery: "auto_merge" }),
        disable("org", { coordinate: "@acme/other" })
      ]).delivery
    ).toBe("auto_merge");
  });

  // Malformed and conditional contributions — the two "admitted to neither side" paths

  it("a malformed effect enables nothing, throws nothing, and is REPORTED rather than dropped", () => {
    const broken: DependencySubscriptionCandidate = {
      tier: "component",
      source: "policy:broken@broken-id",
      // `enabled` is required — absent never means enabled, so this does not parse.
      effect: { coordinate: "@acme/lib" }
    };
    const result = resolve([broken]);
    expect(result.enabled).toBe(false);
    // A malformed OPT-OUT fails OPEN, so it must be visible in the result (principle 6), not silent.
    expect(result.contributions).toContainEqual({
      tier: "component",
      source: "policy:broken@broken-id",
      contributed: "ignored",
      ignoredReason: "malformed"
    });

    // NEGATIVE CONTROL: the same effect WITH `enabled` parses and enables.
    expect(
      resolve([{ ...broken, effect: { coordinate: "@acme/lib", enabled: true } }]).enabled
    ).toBe(true);
  });

  it("a MISTYPED SELECTOR KEY is refused, never STRIPPED into a wildcard — on an enable AND on an opt-out", () => {
    // THE PROPERTY: a selector that fails to bind must void ITSELF, not the constraint. 0062's
    // header already argues it for a bad ecosystem VALUE ("a voided selector fails OPEN"); a
    // mistyped KEY fails to bind in exactly the same way and far more quietly. A plain `z.object`
    // STRIPS the unknown key, so the effect arrives at the merge with NO selectors — a WILDCARD.

    // (a) THE ENABLE DIRECTION. One transposed character in `coordinate` would subscribe EVERY line
    // of the scope instead of the one npm package named.
    const typoEnable: DependencySubscriptionCandidate = {
      tier: "component",
      source: "policy:typo-enable@typo-id",
      effect: { enabled: true, coordinat: "@acme/lib" }
    };
    const notThisLine = { ecosystem: "go", coordinate: "example.com/other", major: "7" } as const;
    const enableResult = resolve([typoEnable], UNLOCKED, notThisLine);
    expect(enableResult.enabled).toBe(false);
    expect(enableResult.reason).toBe("not_enabled");
    // Refused, and REPORTED — an author who typed it must be able to see why nothing happened.
    expect(enableResult.contributions).toContainEqual({
      tier: "component",
      source: "policy:typo-enable@typo-id",
      contributed: "ignored",
      ignoredReason: "malformed"
    });

    // (b) THE OPT-OUT DIRECTION, which is the one that fails OPEN in the other sense: a stripped
    // selector turns "never bump @acme/lib" into "never bump ANYTHING", silently un-subscribing
    // every line the operator meant to keep.
    const typoOptOut: DependencySubscriptionCandidate = {
      tier: "org",
      source: "policy:typo-optout@typo-id",
      effect: { enabled: false, coordinat: "@acme/lib" }
    };
    const optOutResult = resolve([enable("component"), typoOptOut], UNLOCKED, notThisLine);
    expect(optOutResult.enabled).toBe(true);
    expect(optOutResult.contributions).toContainEqual({
      tier: "org",
      source: "policy:typo-optout@typo-id",
      contributed: "ignored",
      ignoredReason: "malformed"
    });

    // NEGATIVE CONTROLS: the correctly-spelled key is honoured in both directions, so the two
    // refusals above are about the TYPO and not about a parse that rejects every selector.
    expect(
      resolve(
        [{ ...typoEnable, effect: { enabled: true, coordinate: "example.com/other" } }],
        UNLOCKED,
        notThisLine
      ).enabled
    ).toBe(true);
    expect(
      resolve(
        [
          enable("component"),
          { ...typoOptOut, effect: { enabled: false, coordinate: "example.com/other" } }
        ],
        UNLOCKED,
        notThisLine
      ).enabled
    ).toBe(false);

    // …and the typo is refused rather than merely inert: the same document WITHOUT the stray key is
    // a legitimate wildcard, and a wildcard still works.
    expect(
      resolve([{ ...typoEnable, effect: { enabled: true } }], UNLOCKED, notThisLine).enabled
    ).toBe(true);
  });

  it("records a WILDCARD selector explicitly as `{}`, so an explanation cannot be ambiguous", () => {
    // Wildcard-by-intent and wildcard-by-accident were indistinguishable in a Decision while the
    // key was simply omitted. The accident is now unrepresentable (the test above), but the
    // explanation must say so on its own — principle 6 is about what the RESULT can answer.
    const wildcard = resolve([enable("component")]);
    expect(wildcard.contributions).toContainEqual({
      tier: "component",
      source: "policy:enable-component@component-id",
      contributed: "enable",
      selector: {}
    });

    // NEGATIVE CONTROL: a narrowed contribution still echoes the selectors it actually carried, so
    // `{}` means "deliberately unconstrained" rather than "this field is always empty".
    expect(
      resolve([enable("component", { coordinate: "@acme/lib" })]).contributions
    ).toContainEqual(expect.objectContaining({ selector: { coordinate: "@acme/lib" } }));

    // The key is omitted only where there are no selectors to report: the instance row, and a
    // contribution that never parsed.
    expect(wildcard.contributions.find((c) => c.tier === "instance")).not.toHaveProperty(
      "selector"
    );
    const malformed = resolve([{ tier: "org", source: "s", effect: { enabled: "yes" } }]);
    expect(malformed.contributions.find((c) => c.tier === "org")).not.toHaveProperty("selector");
  });

  it("a CEL condition may never ENABLE, and still DISABLES", () => {
    // There is no change context here to evaluate a condition against, so the two directions are
    // treated differently — the only split that cannot fail open.
    const conditionalEnable: DependencySubscriptionCandidate = {
      ...enable("component"),
      conditional: true
    };
    const ignored = resolve([conditionalEnable]);
    expect(ignored.enabled).toBe(false);
    expect(ignored.contributions).toContainEqual(
      expect.objectContaining({ contributed: "ignored", ignoredReason: "condition_unevaluable" })
    );

    // NEGATIVE CONTROL for the enable half: the identical candidate WITHOUT a condition enables.
    expect(resolve([enable("component")]).enabled).toBe(true);

    const conditionalDisable: DependencySubscriptionCandidate = {
      ...disable("org"),
      conditional: true
    };
    const disabled = resolve([enable("component"), conditionalDisable]);
    expect(disabled.enabled).toBe(false);
    expect(disabled.reason).toBe("disabled");
    expect(disabled.contributions).toContainEqual(
      expect.objectContaining({ source: conditionalDisable.source, contributed: "disable" })
    );

    // NEGATIVE CONTROL for the disable half: without it, the same enable stands.
    expect(resolve([enable("component")]).enabled).toBe(true);
  });

  // Explainability — "WHICH level turned this off?" (charter principle 6)

  it("carries every level's contribution, so a caller can name the level that turned it off", () => {
    const result = resolve([
      enable("org"),
      enable("service"),
      disable("component", { coordinate: "@acme/lib" })
    ]);
    expect(result.enabled).toBe(false);
    const off = result.contributions.filter((c) => c.contributed === "disable");
    expect(off).toHaveLength(1);
    expect(off[0]).toEqual({
      tier: "component",
      source: "policy:disable-component@component-id",
      contributed: "disable",
      selector: { coordinate: "@acme/lib" }
    });
    // The enables are carried too — the explanation is the whole chain, not just the veto.
    expect(result.contributions.filter((c) => c.contributed === "enable")).toHaveLength(2);
  });

  // The gate is untouched (ADR-0032 §3a consequence 4)

  it("an unrecognised effect shape leaves gate enforcement untouched — mergeContributorEffects ignores it", () => {
    // `dependencySubscription` is deliberately NOT in `policy-model.ts`'s `PolicyEffect` union: that
    // union drives the gate's require/approve enforcement, and an enablement bit is not an
    // "unsatisfied effect". THE CAST BELOW IS THE PROOF — if the effect were added to the union,
    // this would compile without it.
    const subscriptionEffect = {
      dependencySubscription: { enabled: true, delivery: "auto_merge" }
    } as unknown as PolicyEffect;

    const matched: MatchedPolicy = {
      policyObjectId: "policy-1",
      policyVersion: 3,
      name: "subscribe-and-require",
      enforcement: "required",
      condition: undefined,
      effects: [{ requireControls: ["control-a"] }, subscriptionEffect],
      matchedAt: { objectId: "obj-1", depth: 0, via: "unscoped" },
      emergencyPolicy: false,
      autoRollbackOnFailure: false
    };

    const merged = mergeContributorEffects([matched]);
    // The subscription effect contributes NO required control and NO approval requirement — it
    // cannot make a change fail a gate, which is the whole reason it stays out of the union.
    expect(merged.requireControls).toEqual(["control-a"]);
    expect(merged.requireApprovals).toEqual([]);

    // NEGATIVE CONTROL: the same merge DOES see the shapes that are in the union — so the assertion
    // above is about `dependencySubscription` being ignored, not about a merge that returns nothing.
    const withApproval = mergeContributorEffects([
      {
        ...matched,
        effects: [
          subscriptionEffect,
          { requireApprovals: { count: 2, fromRole: "sre", scope: "change" } }
        ]
      }
    ]);
    expect(withApproval.requireApprovals).toEqual([
      {
        count: 2,
        fromRole: "sre",
        scope: "change",
        originPolicyObjectId: "policy-1",
        originPolicyVersion: 3,
        originEffectIndex: 1
      }
    ]);
  });

  it("is TOTAL — every input shape returns a resolution rather than throwing", () => {
    const hostile: MergeDependencySubscriptionInput["candidates"] = [
      { tier: "org", source: "s1", effect: null },
      { tier: "org", source: "s2", effect: undefined },
      { tier: "org", source: "s3", effect: 42 },
      { tier: "org", source: "s4", effect: "enabled" },
      { tier: "org", source: "s5", effect: [] },
      { tier: "org", source: "s6", effect: { enabled: null } },
      { tier: "org", source: "s7", effect: { enabled: true, ecosystem: "not-an-ecosystem" } }
    ];
    const result = resolve(hostile);
    expect(result.enabled).toBe(false);
    expect(result.reason).toBe("not_enabled");
    // Each one is reported as malformed rather than swallowed — including the last, whose
    // `ecosystem` is outside `DependencyEcosystemSchema` (0062's JSON Schema refuses it at
    // authoring time; this is the second line of defence, and it fails CLOSED).
    expect(result.contributions.filter((c) => c.ignoredReason === "malformed")).toHaveLength(
      hostile.length
    );

    // NEGATIVE CONTROL: a well-formed candidate in the same call is still admitted.
    expect(resolve([...hostile, enable("component")]).enabled).toBe(true);
  });
});
