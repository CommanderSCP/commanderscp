import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import type {
  ComponentDependencyBump,
  ComponentDependencyInventoryResponse,
  ComponentDependencyInventoryRow,
  DependencySubscriptionContribution,
  DependencySubscriptionResolutionResponse,
  DependencySubscriptionUnlock
} from "@scp/schemas";
import {
  buildProgram,
  dependencyBumpRow,
  dependencyInventoryBackfillRow,
  dependencyIngestionStampLine,
  dependencyInventoryHeaderLines,
  dependencyInventoryRow,
  dependencyManagementNote,
  dependencyReadNotManagedLine,
  dependencySubscriptionContributionRow,
  dependencySubscriptionResolutionRow,
  dependencySubscriptionUnlockRow
} from "./cli.js";

/**
 * M21.3 — THE CLI HALF OF THE ENABLEMENT SURFACE (ADR-0032 §3a/§6).
 *
 * Charter principle 3 is API → SDK → CLI, so a capability that stops at the SDK is a parity hole.
 * Three things need a witness here:
 *
 *  1. **The three commands exist and carry the right shape** — in particular `set-unlock` takes TWO
 *     mutually exclusive flags rather than one defaulted boolean, because absent never means enabled
 *     (ADR-0032 §6) and a defaulted boolean flag is precisely how an omission becomes a value.
 *
 *  2. **There is NO `subscribe` verb, and the help says where to author one instead.** A dependency
 *     subscription IS a `dependencySubscription` policy effect (ADR-0032 §3a); a bespoke CLI verb
 *     would be a second authoring path for one concept. The ABSENCE is the guarantee, and an absence
 *     is exactly what nobody notices regressing.
 *
 *  3. **The formatters are honest about absent values, and about which level decided the verdict.**
 *     They are exported and called DIRECTLY here for the reason `cli-absent-formatters.test.ts`
 *     records at length: a mapper written inline in a Commander `.action()` closure is unreachable
 *     by any test, so its guards are correct and completely unheld.
 */

function findCommand(root: Command, path: string[]): Command | undefined {
  let current: Command | undefined = root;
  for (const name of path) {
    current = current?.commands.find((c) => c.name() === name);
    if (current === undefined) return undefined;
  }
  return current;
}

/** Delete one key: what an older/newer server actually puts on the wire, which no type rules out at
 *  runtime. `null` is the case that already worked — `undefined` is the one that fabricates. */
function without<T, K extends keyof T>(value: T, key: K): T {
  const copy: T = { ...value };
  delete copy[key];
  return copy;
}

describe("scp dependency-subscriptions — the CLI surface (ADR-0032 §6)", () => {
  const program = buildProgram();
  const root = findCommand(program, ["dependency-subscriptions"]);

  it("exists, with exactly the read/operator-write/resolve trio, M21.2's backfill and M21.6's two READ verbs", () => {
    expect(root).toBeDefined();
    const names = root!.commands.map((c) => c.name()).sort();
    // A CLOSED list on purpose: there is still no `subscribe` verb, and there must not be — a
    // subscription is a `dependencySubscription` effect on an ordinary policy (ADR-0032 §3a), so a
    // bespoke one here would be a second authoring surface for one concept. `backfill-inventory` is
    // not that: it authors nothing, it reads manifests an enabled component already declares.
    // `inventory` and `bumps` (M21.6) are READS of the component-scoped read surface — they author
    // nothing either. This list is also the DELETE-THE-WIRING gate for those two verbs: remove
    // either `.command(...)` registration and this assertion dies.
    expect(names).toEqual([
      "backfill-inventory",
      "bumps",
      "inventory",
      "resolve",
      "set-unlock",
      "unlock"
    ]);
  });

  it("has NO subscribe/enable/disable verb — a subscription is a POLICY effect, and the help says so", () => {
    const names = root!.commands.map((c) => c.name());
    for (const forbidden of [
      "subscribe",
      "unsubscribe",
      "enable",
      "disable",
      "create",
      "opt-out"
    ]) {
      expect(names, `a bespoke '${forbidden}' verb is a second authoring path`).not.toContain(
        forbidden
      );
    }
    // The absence is only defensible if the surface points at the real path. The first thing
    // somebody will look for here is the verb that does not exist.
    expect(root!.description()).toMatch(/scp policy register/i);
    expect(root!.description()).toMatch(/dependencySubscription/);
  });

  it("`set-unlock` takes two MUTUALLY EXCLUSIVE flags, not one defaulted boolean", () => {
    const setUnlock = findCommand(program, ["dependency-subscriptions", "set-unlock"]);
    expect(setUnlock).toBeDefined();
    const longs = setUnlock!.options.map((o) => o.long);
    expect(longs).toContain("--unlocked");
    expect(longs).toContain("--locked");
    // A `--unlocked <bool>` with a default is how "the operator said nothing" silently becomes a
    // value. Both flags must be argument-LESS, so there is no value to default.
    for (const long of ["--unlocked", "--locked"]) {
      const option = setUnlock!.options.find((o) => o.long === long);
      expect(option!.flags, `${long} must take no argument`).not.toMatch(/[<[]/);
      expect(option!.defaultValue, `${long} must have no default`).toBeUndefined();
    }
    // OPERATOR ONLY is the surprising part (no tenant role can grant it), so it belongs in the help
    // rather than in a 403 the operator has to interpret.
    expect(setUnlock!.description()).toMatch(/OPERATOR ONLY/);
    expect(setUnlock!.description()).toMatch(/SCP_OPERATOR_TOKEN/);
  });

  it("`resolve` requires the full line key — a partial key would answer about a different line", () => {
    const resolve = findCommand(program, ["dependency-subscriptions", "resolve"]);
    expect(resolve).toBeDefined();
    // `mandatory` (set by `.requiredOption`), NOT `required` — `required` is true for ANY option
    // that takes an argument, so `--base-url <url>` would satisfy it and the assertion would pass
    // no matter which flags were optional.
    const mandatory = resolve!.options
      .filter((o) => o.mandatory)
      .map((o) => o.long)
      .sort();
    expect(mandatory).toEqual(["--component", "--coordinate", "--ecosystem", "--major"]);
    // The coordinate is compared byte-for-byte; an operator who assumes it is normalised will opt
    // out the wrong package (`@acme/lib` and `acme-lib` share a URN slug but are two lines).
    expect(resolve!.options.find((o) => o.long === "--coordinate")?.description).toMatch(
      /verbatim/i
    );
  });

  it("`backfill-inventory` exists, requires no flags, and repeats --component", () => {
    // M21.2 (ADR-0032 §4). Ingestion is event-driven, so an existing estate acquires an inventory
    // only through this — without a CLI surface the operator's only route would be a raw HTTP call,
    // which is what API→SDK→CLI parity (principle 3) exists to prevent.
    const backfill = findCommand(program, ["dependency-subscriptions", "backfill-inventory"]);
    expect(backfill).toBeDefined();
    // NOTHING is mandatory: the whole-org run is the default, because the ENABLEMENT GATE is what
    // keeps it cheap rather than a narrowing flag the operator has to remember to pass.
    expect(backfill!.options.filter((o) => o.mandatory)).toEqual([]);
    expect(backfill!.options.find((o) => o.long === "--component")).toBeDefined();
    expect(backfill!.options.find((o) => o.long === "--ref")).toBeDefined();
    // The gate is the surprising part — an operator who runs this and sees "0 ingested" needs to
    // know that is enablement and not a broken command.
    expect(backfill!.description()).toMatch(/enablement chain/);
    // The run holds LIVE provider I/O inline, so it is bounded — and the bound must be reachable
    // from the CLI, or a whole-org backfill on a large estate has no way to make progress in
    // several passes.
    expect(backfill!.options.find((o) => o.long === "--fetch-budget")).toBeDefined();
  });

  it("`backfill-inventory` prints the DESTRUCTIVE half of what it did", () => {
    // A backfill DELETES declarations a manifest no longer makes. A receipt that counted only what
    // was added made a run that emptied a component's whole inventory — the wrong `--ref`, a repo
    // mid-migration — print identically to a clean one. The row is the operator's only view of it.
    const row = dependencyInventoryBackfillRow({
      componentObjectId: "00000000-0000-4000-8000-000000000001",
      name: "api",
      verdict: "ingested",
      detail: "1 dependency manifest(s) ingested",
      manifestsIngested: 1,
      declarationsRecorded: 0,
      declarationsPruned: 7,
      manifestsRemoved: 1,
      manifestsSkipped: 0,
      reads: 6
    });
    expect(row.pruned).toBe("7");
    expect(row.removed).toBe("1");
    // NEGATIVE CONTROL: a clean run is distinguishable, which is the whole point of printing it.
    const clean = dependencyInventoryBackfillRow({
      componentObjectId: "00000000-0000-4000-8000-000000000002",
      name: "web",
      verdict: "ingested",
      detail: "1 dependency manifest(s) ingested",
      manifestsIngested: 1,
      declarationsRecorded: 3,
      declarationsPruned: 0,
      manifestsRemoved: 0,
      manifestsSkipped: 0,
      reads: 6
    });
    expect(clean.pruned).toBe("0");
    expect(clean.removed).toBe("0");
  });
});

describe("the M21.3 CLI formatters", () => {
  const unlock: DependencySubscriptionUnlock = {
    unlocked: false,
    note: null,
    updatedAt: null,
    source: "instance:dependency_subscription_unlock"
  };

  it("prints NEVER SET rather than a blank or a fabricated timestamp when the unlock has no row", () => {
    // The shipped state of every deployment: no row at all. "(never set)" and "deliberately
    // re-locked" are different operator situations and must not render identically.
    expect(dependencySubscriptionUnlockRow(unlock).updatedAt).toBe("(never set)");
    // …including when the key is OMITTED entirely, which is what an older/newer server sends.
    expect(dependencySubscriptionUnlockRow(without(unlock, "updatedAt")).updatedAt).toBe(
      "(never set)"
    );

    // NEGATIVE CONTROL: a real timestamp is printed verbatim, so the guard is about ABSENCE and not
    // a column hardcoded to "(never set)".
    expect(
      dependencySubscriptionUnlockRow({ ...unlock, updatedAt: "2026-08-15T00:00:00.000Z" })
        .updatedAt
    ).toBe("2026-08-15T00:00:00.000Z");
  });

  const enabledResponse: DependencySubscriptionResolutionResponse = {
    componentObjectId: "0198f000-0000-7000-8000-000000000001",
    line: { ecosystem: "npm", coordinate: "@acme/lib", major: "1" },
    resolution: {
      enabled: true,
      reason: "enabled",
      granularity: "patch",
      delivery: "pull_request",
      contributions: []
    },
    // The deployment that answered MANAGES dependencies (ADR-0032 §7d) — the ordinary case, so the
    // fixture carries it and the refusals below are the deviation.
    dependencyManagement: { managedHere: true, reason: "commander" }
  };

  it("prints WHETHER ANYTHING HERE WILL ACT ON THE VERDICT — an enabled subscription on an outpost is not a running one", () => {
    // The hole this closes: `enabled: true` is arithmetically correct on an outpost and NOTHING
    // THERE WILL EVER ACT ON IT. The row must carry both halves or the reader is told something
    // true and misleading at once.
    const onOutpost = dependencySubscriptionResolutionRow({
      ...enabledResponse,
      dependencyManagement: { managedHere: false, reason: "outpost" }
    });
    expect(onOutpost.enabled).toBe("true");
    expect(onOutpost.managedHere).toBe("false");
    expect(onOutpost.managedReason).toBe("outpost");

    // `role_undeclared` IS ITS OWN VALUE and must reach the column as itself — it is the branch
    // whose config VALUE reads 'commander', so a formatter that flattened it would print the
    // opposite of the truth.
    expect(
      dependencySubscriptionResolutionRow({
        ...enabledResponse,
        dependencyManagement: { managedHere: false, reason: "role_undeclared" }
      }).managedReason
    ).toBe("role_undeclared");

    // NEGATIVE CONTROL: a declared commander prints `true`, so the column is about the payload and
    // is not hardcoded to a refusal.
    const onCommander = dependencySubscriptionResolutionRow(enabledResponse);
    expect(onCommander.managedHere).toBe("true");
    expect(onCommander.managedReason).toBe("commander");
  });

  /**
   * THE OPERATOR-FACING CAVEAT, HELD IN BOTH DIRECTIONS (ADR-0032 §7d, M21.7 follow-up).
   *
   * This note used to be written INLINE inside the resolve command's Commander `.action()` closure,
   * where nothing could call it: inverting its condition — so the note printed on a healthy
   * commander and went SILENT on the deployment it exists to warn, the exact inversion that matters
   * — left the whole suite green. A conditional caveat is only held when BOTH arms are pinned, so
   * both are below. The wording is deliberately NOT pinned beyond the two facts an operator acts on
   * (the posture, and where to go instead), so a rewrite passes and a wrong condition fails.
   */
  describe("the `resolve` caveat printed beside the table", () => {
    it("APPEARS when nothing here will act on the verdict, and names the posture and the remedy", () => {
      const note = dependencyManagementNote({ managedHere: false, reason: "outpost" });
      expect(note).toBeDefined();
      // The posture, so the operator knows WHICH refusal this is — `outpost` and `role_undeclared`
      // have different remedies (call the commander vs set one env var).
      expect(note).toContain("outpost");
      // …and where the work actually happens, because a caveat an operator cannot act on is silence.
      expect(note).toMatch(/COMMANDER/);

      // `role_undeclared` is the branch whose config VALUE reads `commander`; it must reach the
      // note as itself or the sentence names the opposite of the truth.
      expect(dependencyManagementNote({ managedHere: false, reason: "role_undeclared" })).toContain(
        "role_undeclared"
      );
    });

    it("is SILENT on a declared commander — the direction whose inversion was fully green", () => {
      // THE HALF THAT WAS UNHELD. A caveat on every invocation is one nobody reads, so its absence
      // here is as load-bearing as its presence above.
      expect(dependencyManagementNote({ managedHere: true, reason: "commander" })).toBeUndefined();
    });

    it("is SILENT when the server omitted the envelope — absent is not a refusal", () => {
      // A server that predates the field claims no posture, and asserting one it never claimed is
      // the same fabrication the `-` column exists to avoid. `=== false`, never falsy.
      expect(dependencyManagementNote(undefined)).toBeUndefined();
    });
  });

  it("never FABRICATES `managedHere` when the server omitted the envelope — `-`, never `true`", () => {
    // A server that predates the field sends nothing, and inventing "yes, managed here" is the exact
    // false reassurance the envelope exists to remove. Same guard as `delivery`, sharper consequence.
    const row = dependencySubscriptionResolutionRow(
      without(enabledResponse, "dependencyManagement")
    );
    expect(row.managedHere).toBe("-");
    expect(row.managedReason).toBe("-");
    // …and the verdict is still printed, because the answer is not withheld — only unqualified.
    expect(row.enabled).toBe("true");
  });

  it("never prints `undefined` in the DELIVERY column — where the two values are 'open a PR' and 'merge it automatically'", () => {
    const stripped: DependencySubscriptionResolutionResponse = {
      ...enabledResponse,
      resolution: without(without(enabledResponse.resolution, "delivery"), "granularity")
    };
    const row = dependencySubscriptionResolutionRow(stripped);
    expect(row.delivery).toBe("-");
    expect(row.granularity).toBe("-");

    // NEGATIVE CONTROL: present values are printed as themselves.
    const full = dependencySubscriptionResolutionRow(enabledResponse);
    expect(full.delivery).toBe("pull_request");
    expect(full.granularity).toBe("patch");
  });

  it("echoes the coordinate VERBATIM — the byte that decides which package an opt-out named", () => {
    expect(dependencySubscriptionResolutionRow(enabledResponse).coordinate).toBe("@acme/lib");
    expect(
      dependencySubscriptionResolutionRow({
        ...enabledResponse,
        line: { ...enabledResponse.line, coordinate: "acme-lib" }
      }).coordinate
    ).toBe("acme-lib");
  });

  it("renders an ABSENT selector as the wildcard it is, not as a blank that reads 'matched nothing'", () => {
    const wildcard: DependencySubscriptionContribution = {
      tier: "component",
      source: "policy:subscribe-all@0198f000-0000-7000-8000-000000000002",
      contributed: "enable"
    };
    expect(dependencySubscriptionContributionRow(wildcard).selector).toBe("*");

    // NEGATIVE CONTROL: a present selector renders its own keys, so "*" means WILDCARD and not
    // "this formatter always prints a star".
    const scoped: DependencySubscriptionContribution = {
      ...wildcard,
      contributed: "disable",
      selector: { coordinate: "@acme/lib" }
    };
    const row = dependencySubscriptionContributionRow(scoped);
    expect(row.selector).toBe("coordinate=@acme/lib");
    // `contributed` is the column that answers "which level turned this off".
    expect(row.contributed).toBe("disable");
    expect(row.tier).toBe("component");
  });

  it("shows an IGNORED contribution's reason — a malformed opt-out fails OPEN, so it must be visible", () => {
    const ignored: DependencySubscriptionContribution = {
      tier: "org",
      source: "policy:broken@0198f000-0000-7000-8000-000000000003",
      contributed: "ignored",
      ignoredReason: "malformed"
    };
    const row = dependencySubscriptionContributionRow(ignored);
    expect(row.contributed).toBe("ignored");
    expect(row.ignoredReason).toBe("malformed");

    // NEGATIVE CONTROL: the same formatter leaves the column EMPTY when there is no reason, so it
    // is reporting the reason rather than always printing one.
    expect(
      dependencySubscriptionContributionRow(without(ignored, "ignoredReason")).ignoredReason
    ).toBe("");
  });
});

/**
 * M21.6 — THE TWO READ VERBS (proposal §3.3) and their formatters. Both consume the component-scoped
 * read surface through the SDK (`client.dependencySubscriptions.inventory` / `.bumps`); the
 * formatters are exported and called DIRECTLY here because a mapper inside a Commander `.action()`
 * closure is unreachable by any test (see the file doc above).
 */
describe("scp dependency-subscriptions inventory | bumps — the M21.6 read verbs", () => {
  const program = buildProgram();

  it("`inventory` requires --component and offers an ecosystem DISPLAY filter plus paging", () => {
    const inventory = findCommand(program, ["dependency-subscriptions", "inventory"]);
    expect(inventory).toBeDefined();
    const mandatory = inventory!.options.filter((o) => o.mandatory).map((o) => o.long);
    expect(mandatory).toEqual(["--component"]);
    for (const long of ["--ecosystem", "--limit", "--cursor", "--output"]) {
      expect(
        inventory!.options.find((o) => o.long === long),
        `${long} missing`
      ).toBeDefined();
    }
    // The verb READS; the null-stamp honesty rule is the surprising part, so the help carries it.
    expect(inventory!.description()).toMatch(/NOT RECORDED/);
  });

  it("`bumps` requires --component and says a PR link is never composed", () => {
    const bumps = findCommand(program, ["dependency-subscriptions", "bumps"]);
    expect(bumps).toBeDefined();
    const mandatory = bumps!.options.filter((o) => o.mandatory).map((o) => o.long);
    expect(mandatory).toEqual(["--component"]);
    for (const long of ["--limit", "--cursor", "--output"]) {
      expect(
        bumps!.options.find((o) => o.long === long),
        `${long} missing`
      ).toBeDefined();
    }
    expect(bumps!.description()).toMatch(/never composed/);
  });

  const COMPONENT_ID = "0198f000-0000-7000-8000-000000000010";
  const LINE_ID = "0198f000-0000-7000-8000-000000000011";

  const baseRow: ComponentDependencyInventoryRow = {
    line: { id: LINE_ID, ecosystem: "npm", coordinate: "@acme/lib", major: "1", tagPattern: null },
    manifestPath: "package.json",
    declaredVersion: "^1.2.3",
    resolvedVersion: "1.2.3",
    resolvedDigest: null,
    observedRepo: "acme/app",
    observedRef: "refs/heads/main",
    observedAt: "2026-08-16T00:00:00.000Z",
    head: {
      latestVersion: "1.4.0",
      latestDigest: null,
      latestObservedAt: "2026-08-16T01:00:00.000Z"
    },
    producer: null,
    subscription: {
      enabled: true,
      reason: "enabled",
      granularity: "minor_and_patch",
      delivery: "pull_request",
      contributions: [
        {
          tier: "component",
          source: "policy:checkout-deps@0198f000-0000-7000-8000-000000000012",
          contributed: "enable",
          granularity: "minor_and_patch",
          delivery: "pull_request"
        }
      ]
    }
  };

  const baseResponse: ComponentDependencyInventoryResponse = {
    component: { id: COMPONENT_ID, name: "checkout-api", domainId: null },
    dependencyManagement: { managedHere: true, reason: "commander" },
    ingestion: null,
    lastIngestionDecision: null,
    componentGate: { enabled: true, reason: "enabled", contributions: [] },
    rows: [baseRow],
    nextCursor: null
  };

  it("inventory row: the coordinate is VERBATIM, nulls print `-`, and settings show only when enabled", () => {
    const row = dependencyInventoryRow(baseRow);
    expect(row.coordinate).toBe("@acme/lib");
    expect(row.ecosystem).toBe("npm");
    expect(row.major).toBe("1");
    expect(row.manifest).toBe("package.json");
    expect(row.declared).toBe("^1.2.3");
    expect(row.resolved).toBe("1.2.3");
    expect(row.latest).toBe("1.4.0");
    expect(row.subscription).toBe("enabled (minor_and_patch, pull_request)");
    expect(row.reason).toBe("enabled");

    // A slug-colliding sibling is a DIFFERENT line and must print as itself.
    expect(
      dependencyInventoryRow({ ...baseRow, line: { ...baseRow.line, coordinate: "acme-lib" } })
        .coordinate
    ).toBe("acme-lib");

    // `resolvedVersion: null` = the manifest pins none; `latestVersion: null` = NOT OBSERVED —
    // both are `-`, never a fabricated version and never the literal `null`/`undefined`.
    const unresolved = dependencyInventoryRow({
      ...baseRow,
      resolvedVersion: null,
      head: { latestVersion: null, latestDigest: null, latestObservedAt: null }
    });
    expect(unresolved.resolved).toBe("-");
    expect(unresolved.latest).toBe("-");
    // …including when the key is OMITTED, which is what an older/newer server sends.
    expect(dependencyInventoryRow(without(baseRow, "head")).latest).toBe("-");

    // NOT enabled: the settings are meaningless (schemas: 'meaningful only when enabled'), so
    // they are not shown; the REASON column carries WHY.
    const optedOut = dependencyInventoryRow({
      ...baseRow,
      subscription: {
        enabled: false,
        reason: "disabled",
        granularity: "patch",
        delivery: "pull_request",
        contributions: []
      }
    });
    expect(optedOut.subscription).toBe("not enabled");
    expect(optedOut.reason).toBe("disabled");
  });

  it("inventory row: an IGNORED contribution is surfaced in REASON, never hidden — a malformed opt-out fails OPEN", () => {
    const withIgnored = dependencyInventoryRow({
      ...baseRow,
      subscription: {
        ...baseRow.subscription,
        contributions: [
          ...baseRow.subscription.contributions,
          {
            tier: "org",
            source: "policy:broken@0198f000-0000-7000-8000-000000000013",
            contributed: "ignored",
            ignoredReason: "malformed"
          }
        ]
      }
    });
    expect(withIgnored.reason).toBe("enabled (+1 ignored: malformed)");
    // NEGATIVE CONTROL: no ignored contribution, no note.
    expect(dependencyInventoryRow(baseRow).reason).toBe("enabled");
  });

  it("inventory header: a null stamp prints NOT RECORDED (never 'never ingested', never 'no dependencies'); a stamp prints itself; the gate is labelled apart from row reasons", () => {
    const lines = dependencyInventoryHeaderLines(baseResponse);
    // A null stamp is NEVER ATTEMPTED — the stamp table's one reading of a missing row — and is
    // never "no dependencies".
    expect(lines).toContain("ingestion: never attempted");
    expect(lines).toContain("last ingestion decision: none on record");
    expect(lines.join("\n")).not.toMatch(/no dependencies/i);
    // …and when the key is OMITTED (a server predating the stamp read) — nothing recorded either.
    expect(dependencyInventoryHeaderLines(without(baseResponse, "ingestion"))).toContain(
      "ingestion: never attempted"
    );
    // The gate line uses the GATE's vocabulary under its own label.
    expect(lines.find((l) => l.startsWith("component gate:"))).toBe(
      "component gate: enabled (enabled=true, 0 contribution(s))"
    );
    expect(
      dependencyInventoryHeaderLines({
        ...baseResponse,
        componentGate: { enabled: false, reason: "no_enabling_contribution", contributions: [] }
      }).find((l) => l.startsWith("component gate:"))
    ).toBe("component gate: no_enabling_contribution (enabled=false, 0 contribution(s))");

    // NEGATIVE CONTROL: a present stamp is printed as itself, so "never attempted" reports ABSENCE.
    const stamped = dependencyInventoryHeaderLines({
      ...baseResponse,
      ingestion: {
        lastAttemptAt: "2026-08-16T02:00:00.000Z",
        source: "backfill",
        outcome: "partial",
        rowsWritten: 3,
        detail: null,
        manifests: [
          {
            repo: "acme/app",
            path: "package.json",
            outcome: "ok",
            rows: 3,
            at: "2026-08-16T02:00:00.000Z"
          },
          {
            repo: "acme/app",
            path: "go.mod",
            outcome: "unreadable",
            rows: 0,
            at: "2026-08-16T02:00:00.000Z",
            detail: "read_failed"
          }
        ]
      },
      lastIngestionDecision: {
        decisionId: "0198f000-0000-7000-8000-000000000014",
        firstObservedAt: "2026-08-15T00:00:00.000Z",
        manifestPathsRead: ["package.json"],
        manifestPathsAbsent: ["Dockerfile"],
        skipped: [{ path: "go.mod", reason: "read_failed" }]
      }
    });
    expect(stamped).toContain(
      "ingestion: partial — some manifests could not be read at 2026-08-16T02:00:00.000Z (backfill), 3 row(s) written; manifests: acme/app:package.json=ok, acme/app:go.mod=unreadable (read_failed)"
    );
    expect(stamped).toContain(
      "last ingestion decision: 0198f000-0000-7000-8000-000000000014 first observed 2026-08-15T00:00:00.000Z; read [package.json] absent [Dockerfile] skipped 1 (go.mod: read_failed)"
    );
    expect(stamped.join("\n")).not.toMatch(/never attempted/);
  });

  it("ingestion stamp line: the TRICHOTOMY — never attempted / ok+0 = no dependencies declared / ok+N / partial and unreadable with the file list / not enabled — read off the stamp, never off `rows`", () => {
    const at = "2026-08-16T02:00:00.000Z";
    const okEntry = { repo: "acme/app", path: "package.json", outcome: "ok", rows: 0, at };
    expect(dependencyIngestionStampLine(null)).toBe("ingestion: never attempted");
    expect(dependencyIngestionStampLine(undefined)).toBe("ingestion: never attempted");
    // ok + 0 rows: the one state an empty inventory could not express before the stamp.
    expect(
      dependencyIngestionStampLine({
        lastAttemptAt: at,
        source: "loop",
        outcome: "ok",
        rowsWritten: 0,
        detail: null,
        manifests: [okEntry, { ...okEntry, path: "go.mod" }]
      })
    ).toBe(
      `ingestion: ok — no dependencies declared (read 2 manifest(s)) at ${at} (loop); manifests: acme/app:package.json=ok, acme/app:go.mod=ok`
    );
    // ok + N rows: an ordinary receipt.
    expect(
      dependencyIngestionStampLine({
        lastAttemptAt: at,
        source: "loop",
        outcome: "ok",
        rowsWritten: 4,
        detail: null,
        manifests: [{ ...okEntry, rows: 4 }]
      })
    ).toBe(`ingestion: ok at ${at} (loop), 4 row(s) written; manifests: acme/app:package.json=ok`);
    // unreadable: every file listed with its verdict — the operator's next action is a file.
    expect(
      dependencyIngestionStampLine({
        lastAttemptAt: at,
        source: "backfill",
        outcome: "unreadable",
        rowsWritten: 0,
        detail: null,
        manifests: [
          {
            repo: "acme/app",
            path: "go.mod",
            outcome: "unreadable",
            rows: 0,
            at,
            detail: "parse error"
          },
          { repo: "acme/charts", path: "Dockerfile", outcome: "unsupported", rows: 0, at }
        ]
      })
    ).toBe(
      `ingestion: unreadable — no manifest could be read at ${at} (backfill), 0 row(s) written; manifests: acme/app:go.mod=unreadable (parse error), acme/charts:Dockerfile=unsupported`
    );
    // not enabled: the gate's own sentence, and the word "no dependencies" never appears.
    const gated = dependencyIngestionStampLine({
      lastAttemptAt: at,
      source: "loop",
      outcome: "not_enabled",
      rowsWritten: 0,
      detail: "instance_locked",
      manifests: []
    });
    expect(gated).toBe(
      `ingestion: not enabled — the gate was closed, nothing was fetched at ${at} (loop) — instance_locked`
    );
    expect(gated).not.toMatch(/no dependencies/);
  });

  it("the not-managed line: printed ONLY for `managedHere: false` (with the reason), silent on a commander AND when the server omitted the envelope", () => {
    const line = dependencyReadNotManagedLine({ managedHere: false, reason: "outpost" });
    expect(line).toBeDefined();
    expect(line).toContain("dependencies are not managed on this instance (outpost)");
    expect(
      dependencyReadNotManagedLine({ managedHere: false, reason: "role_undeclared" })
    ).toContain("(role_undeclared)");
    // A declared commander: silent — a caveat on every invocation is one nobody reads.
    expect(
      dependencyReadNotManagedLine({ managedHere: true, reason: "commander" })
    ).toBeUndefined();
    // Absent is not a refusal (`=== false`, never falsy).
    expect(dependencyReadNotManagedLine(undefined)).toBeUndefined();
  });

  const baseBump: ComponentDependencyBump = {
    changeId: "0198f000-0000-7000-8000-000000000020",
    changeName: "bump @acme/lib 1.2.3 -> 1.4.0",
    line: { id: LINE_ID, ecosystem: "npm", coordinate: "@acme/lib", major: "1" },
    manifestPath: "package.json",
    fromVersion: "1.2.3",
    toVersion: "1.4.0",
    repo: "acme/app",
    baseBranch: "main",
    authoredRef: "refs/heads/scp/dep-bump/0198f000-0000-7000-8000-000000000020",
    pullRequestNumber: 42,
    pullRequestUrl: null,
    headCommit: "abc123",
    dispatchedAt: "2026-08-16T03:00:00.000Z",
    mergedAt: null,
    delivery: "pull_request",
    deliveryReason: "first look is always a pull request",
    merge: null
  };

  it("bump row: the PR column is the stored URL when present, else `#n` from the number, else `-`; `-` for an unconfirmed merge and an unrun gate", () => {
    const row = dependencyBumpRow(baseBump);
    expect(row.coordinate).toBe("@acme/lib");
    expect(row["from -> to"]).toBe("1.2.3 -> 1.4.0");
    expect(row.pr).toBe("#42");
    // NEVER composed from repo + number: the provider is not known here.
    expect(row.pr).not.toMatch(/acme\/app|https?:/);
    expect(row.dispatched).toBe("2026-08-16T03:00:00.000Z");
    expect(row.merged).toBe("-");
    expect(row.verdict).toBe("-");
    expect(row.delivery).toBe("pull_request");

    // A stored URL IS printed, and it REPLACES the number (the better address of the same PR) —
    // the guard is about absence, not a column that never links.
    expect(
      dependencyBumpRow({ ...baseBump, pullRequestUrl: "https://git.example/acme/app/pulls/42" }).pr
    ).toBe("https://git.example/acme/app/pulls/42");
    // No number yet: `-`, not `#null`.
    expect(dependencyBumpRow({ ...baseBump, pullRequestNumber: null }).pr).toBe("-");

    // NEGATIVE CONTROL: a merged, gated bump prints its facts.
    const merged = dependencyBumpRow({
      ...baseBump,
      mergedAt: "2026-08-16T04:00:00.000Z",
      merge: {
        verdict: "merged",
        decisionId: "0198f000-0000-7000-8000-000000000021",
        evaluatedAt: "2026-08-16T04:00:00.000Z"
      }
    });
    expect(merged.merged).toBe("2026-08-16T04:00:00.000Z");
    expect(merged.verdict).toBe("merged");
    // An absent dispatch Decision leaves DELIVERY `-`, never a defaulted `pull_request`.
    expect(dependencyBumpRow({ ...baseBump, delivery: null }).delivery).toBe("-");
  });
});
