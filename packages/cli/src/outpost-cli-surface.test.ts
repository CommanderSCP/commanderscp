import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import { outpostClaimantTokens, OutpostTrustTierSchema } from "@scp/schemas";
import type { OutpostConfig, OutpostConfigReconcileResult } from "@scp/schemas";
import { buildProgram, formatReconcilePreviewLines, formatReconcileResultLines } from "./cli.js";

/**
 * M16.2 phase A, REVIEW ROUND 5 — THE CLI HALF OF THE OUTPOST SURFACE (N1, N2).
 *
 * N1 — THE TIER FIX MISSED THE ONLY PLACE AN OPERATOR READS THE LIST. ADR-0022 widened
 * `OutpostTrustTier` from `commercial|fedramp-high|il5` to the glossary's five members, and the
 * schema, the migration header, the proposal and the glossary alignment were all corrected — while
 * `--trust-tier`'s two option descriptions kept printing the OLD THREE. `scp federation outpost
 * declare --help` is the only place an operator learns what to type, so an operator enrolling a
 * GovCloud outpost was told there was no value for it, and pushed to leave the tier unknown or
 * assert `commercial` — the INVENTED POSTURE the whole honest-unknown design exists to prevent.
 * The help text is now DERIVED from the enum; this test is the assertion that keeps documentation
 * and enum from drifting apart again, and it is deliberately written against the ENUM'S OWN
 * MEMBERS rather than a retyped list, so adding a sixth tier cannot leave the help behind.
 *
 * N2 — THE RECOVERY VERB HAD NO CLI. Charter principle 3 is API -> SDK -> CLI -> IaC -> UI, and
 * `reconcileOutpost` shipped in the SDK with no command. It is the verb an operator uses to un-wedge
 * a peer holding duplicate `outpost` objects — and that operator is the one person who cannot reach
 * it through the UI, because the wedged peer is what the UI fails to render.
 */

function findCommand(root: Command, path: string[]): Command | undefined {
  let current: Command | undefined = root;
  for (const name of path) {
    current = current?.commands.find((c) => c.name() === name);
    if (current === undefined) return undefined;
  }
  return current;
}

function trustTierHelp(command: Command): string {
  const option = command.options.find((o) => o.long === "--trust-tier");
  expect(option, `${command.name()} has no --trust-tier option`).toBeDefined();
  return option!.description;
}

describe("scp federation outpost — the operator-facing surface", () => {
  const program = buildProgram();
  const PEER = "00000000-0000-0000-0000-000000000002";

  it("N1: `outpost declare --trust-tier` documents EVERY tier the API accepts", () => {
    const declare = findCommand(program, ["federation", "outpost", "declare"]);
    expect(declare).toBeDefined();
    const help = trustTierHelp(declare!);
    for (const tier of OutpostTrustTierSchema.options) {
      expect(help, `--trust-tier help omits the accepted tier '${tier}'`).toContain(tier);
    }
  });

  it("N1: `outpost set --trust-tier` documents EVERY tier the API accepts", () => {
    const set = findCommand(program, ["federation", "outpost", "set"]);
    expect(set).toBeDefined();
    const help = trustTierHelp(set!);
    for (const tier of OutpostTrustTierSchema.options) {
      expect(help, `--trust-tier help omits the accepted tier '${tier}'`).toContain(tier);
    }
  });

  it("N1: neither help string offers a tier the API would REJECT", () => {
    // The other direction of the same drift: a help text listing a member the enum dropped would
    // send an operator straight into a 400. Both strings are checked against the enum, so any token
    // that looks like a tier must BE one.
    const accepted = new Set<string>(OutpostTrustTierSchema.options);
    for (const path of [
      ["federation", "outpost", "declare"],
      ["federation", "outpost", "set"]
    ]) {
      const help = trustTierHelp(findCommand(program, path)!);
      const offered = (help.split(/\s+/)[0] ?? "").split("|");
      expect(offered.length).toBeGreaterThan(1);
      for (const token of offered) {
        expect(
          accepted.has(token),
          `--trust-tier help offers '${token}', which the API rejects`
        ).toBe(true);
      }
    }
  });

  it("N2: the recovery verb `outpost reconcile` exists and takes the peer it un-wedges", () => {
    const reconcile = findCommand(program, ["federation", "outpost", "reconcile"]);
    expect(reconcile, "`scp federation outpost reconcile` is missing").toBeDefined();
    const peer = reconcile!.options.find((o) => o.long === "--peer");
    expect(peer).toBeDefined();
    expect(peer!.required).toBe(true);
  });

  it("N2: every SDK federation-outpost verb has a command (API -> SDK -> CLI parity)", () => {
    // The census that would have caught N2 at the time: the four write/read verbs plus the recovery
    // verb. Checked as a SET so a future SDK addition with no command fails here rather than in a
    // review round.
    const outpost = findCommand(program, ["federation", "outpost"]);
    expect(outpost).toBeDefined();
    const names = outpost!.commands.map((c) => c.name()).sort();
    expect(names).toEqual(["declare", "list", "reconcile", "set", "show"]);
  });

  /**
   * M1 (review round 6) — THE RECOVERY COMMAND MUST NOT DESCRIBE A JOURNALED, DOWNSTREAM-PROPAGATING
   * DELETE OF THIS DOMAIN'S OWN CONFIG AS "removed N unverified shadow(s)". That wording is true only
   * for `removedShadowObjectIds` (a stray hand-typed copy this domain never authored — nothing rides
   * the journal). For `removedLocalObjectIds` (the `?keep=` verified-duplicate escape, N9) it is false:
   * the row dropped is this domain's OWN declared config, and the tombstone journals down to the
   * outpost. The two cases must read differently — this test fails if they are ever collapsed back
   * into one bucket/one sentence, which is exactly the regression a `removedObjectIds.length` mutant
   * would reintroduce.
   */
  function fakeConfig() {
    return {
      objectId: "00000000-0000-0000-0000-000000000001",
      urn: "urn:scp:test:outpost:x",
      name: "x",
      peerDomainId: "00000000-0000-0000-0000-000000000002",
      trustTier: null,
      originDomainId: "00000000-0000-0000-0000-000000000003",
      revision: 1,
      version: 1,
      unknownFields: [] as string[],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    } as unknown as OutpostConfigReconcileResult["config"];
  }

  it("M1: a removed SHADOW and a removed LOCAL-ORIGIN row produce DIFFERENT output", () => {
    const shadowRemoval: OutpostConfigReconcileResult = {
      config: fakeConfig(),
      adoptedObjectId: null,
      removedShadowObjectIds: ["shadow-id-1"],
      removedLocalObjectIds: []
    };
    const localRemoval: OutpostConfigReconcileResult = {
      config: fakeConfig(),
      adoptedObjectId: null,
      removedShadowObjectIds: [],
      removedLocalObjectIds: ["local-id-1"]
    };

    const shadowLines = formatReconcileResultLines(shadowRemoval).join("\n");
    const localLines = formatReconcileResultLines(localRemoval).join("\n");

    // The two outputs must differ — pins the M1 fix directly, not just via a substring.
    expect(shadowLines).not.toEqual(localLines);

    // The shadow case must NOT claim a journal/propagation, and must call it a shadow.
    expect(shadowLines).toMatch(/unverified shadow/i);
    expect(shadowLines).not.toMatch(/journal/i);
    expect(shadowLines).not.toMatch(/propagat/i);

    // The local-origin case MUST say plainly that this domain's own row was deleted and that it
    // journals/propagates downstream — an operator must be able to tell the two apart.
    expect(localLines).toMatch(/this domain authored|this domain's own/i);
    expect(localLines).toMatch(/journal/i);
    expect(localLines).toMatch(/propagat/i);
    expect(localLines).not.toMatch(/unverified shadow/i);
  });

  /**
   * THE OPTIMISTIC-CONCURRENCY PRECONDITION, ON THE SURFACE WITH THE LARGEST UNGUARDED WINDOW.
   * `reconcile` went straight to the write with no read at all, so the CLI had neither a preview
   * nor a staleness guard on a call that can adopt an operator's entered config, DISCARD it, or
   * delete a row this domain authored and journal that delete downstream.
   */
  function claimant(over: Partial<OutpostConfig> & { objectId: string }): OutpostConfig {
    return {
      urn: `urn:scp:test:outpost:${over.objectId}`,
      name: over.objectId,
      peerDomainId: PEER,
      trustTier: null,
      originDomainId: "00000000-0000-0000-0000-0000000000ff",
      originIsSelf: false,
      provenance: null,
      revision: 1,
      version: 1,
      unknownFields: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...over
    } as OutpostConfig;
  }

  it("the precondition is ON by default and skipping it takes a NAMED flag", () => {
    const reconcile = findCommand(program, ["federation", "outpost", "reconcile"])!;
    const flag = reconcile.options.find((o) => o.long === "--no-precondition");
    expect(
      flag,
      "`--no-precondition` is missing — the token would have no deliberate escape"
    ).toBeDefined();
    // Commander models `--no-x` as a boolean that DEFAULTS TRUE: absent flag => precondition sent.
    // A default of `false` would make the guard opt-in, which is the shipped-broken shape.
    expect(reconcile.opts().precondition).toBe(true);
    // And it must not promise consent: the CLI's window is milliseconds, not a human reading.
    expect(flag!.description).toMatch(/between the listing and the call|silently/i);
  });

  it("the token is derived from the listing, per peer, as objectId:version", () => {
    const mine = claimant({ objectId: "11111111-1111-1111-1111-111111111111", version: 4 });
    const other = claimant({
      objectId: "22222222-2222-2222-2222-222222222222",
      version: 9,
      peerDomainId: "00000000-0000-0000-0000-00000000dead"
    });
    expect(outpostClaimantTokens([mine, other], PEER)).toEqual([
      "11111111-1111-1111-1111-111111111111:4"
    ]);
    // VERSION, NOT REVISION. `revision` is author-assigned on the import path, so it cannot detect a
    // shadow ADOPTED IN PLACE — same id, same revision, different origin.
    expect(
      outpostClaimantTokens([claimant({ objectId: mine.objectId, revision: 77 })], PEER)
    ).toEqual([`${mine.objectId}:1`]);
  });

  it("the preview names the ADOPTION, the silent local cleanup and the PROPAGATING delete differently", () => {
    const shadow = claimant({
      objectId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      provenance: "manual",
      originIsSelf: false
    });
    const local = claimant({
      objectId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      originIsSelf: true
    });
    const verified = claimant({ objectId: "cccccccc-cccc-cccc-cccc-cccccccccccc" });

    // THE DEFECT'S OWN SCENARIO: a locally-authored row alongside the shadow. The default call keeps
    // the LOCAL row — so a preview that promised adoption would be a lie, and the operator's entered
    // value is what gets dropped.
    const bare = formatReconcilePreviewLines([shadow, local]).join("\n");
    expect(bare).toMatch(new RegExp(`KEEP\\s+${local.objectId}`));
    expect(bare).toMatch(new RegExp(`REMOVE\\s+${shadow.objectId}`));
    expect(bare).not.toMatch(new RegExp(`ADOPT\\s+${shadow.objectId}`));

    // Naming the shadow with --keep is the OTHER arm: it adopts, and the concurrent locally-authored
    // row is deleted with a tombstone that PROPAGATES. Both facts must be on screen.
    const kept = formatReconcilePreviewLines([shadow, local], shadow.objectId).join("\n");
    expect(kept).toMatch(new RegExp(`ADOPT\\s+${shadow.objectId}`));
    expect(kept).toMatch(new RegExp(`DELETE\\s+${local.objectId}`));
    expect(kept).toMatch(/PROPAGATE/);
    // The two removals must never read alike (the M1 rule, applied to the PREVIEW as well as the
    // report): a shadow removal is invisible to the outpost, a local one is not.
    expect(bare).toMatch(/invisible to the outpost/i);
    expect(bare).not.toMatch(/PROPAGATE/);

    // A verified replica can only be refused — the preview says so before the 409 arrives.
    expect(formatReconcilePreviewLines([local, verified]).join("\n")).toMatch(
      new RegExp(`REFUSE\\s+${verified.objectId}`)
    );
  });

  it("with TWO rows of equal authority and no --keep, it declines to predict rather than guess", () => {
    // The server breaks a same-class tie by `(created_at, id)`. Reconstructing that here and
    // printing it as a prediction is the guess the panel refuses to make
    // (`reconcile-default-indeterminate`) — and a preview that MIGHT be wrong is worse than none,
    // because these lines exist precisely to say what WILL happen.
    const localA = claimant({
      objectId: "dddddddd-dddd-dddd-dddd-dddddddddddd",
      originIsSelf: true
    });
    const localB = claimant({
      objectId: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
      originIsSelf: true
    });
    const tied = formatReconcilePreviewLines([localA, localB]).join("\n");
    expect(tied).toMatch(/will not guess/i);
    expect(tied).not.toMatch(/\bKEEP\b|\bADOPT\b|\bDELETE\b/);
    // It still states the consequence class of each row — declining to predict is not declining to
    // inform, and dropping either of these PROPAGATES.
    expect(tied).toContain(localA.objectId);
    expect(tied).toContain(localB.objectId);
    expect(tied).toMatch(/PROPAGATE/);
    // Naming a survivor resolves it: the same two rows now preview a definite outcome.
    const named = formatReconcilePreviewLines([localA, localB], localB.objectId).join("\n");
    expect(named).toMatch(new RegExp(`KEEP\\s+${localB.objectId}`));
    expect(named).toMatch(new RegExp(`DELETE\\s+${localA.objectId}`));
  });

  it("a --keep naming no live claimant previews the 400, not the default outcome", () => {
    const local = claimant({
      objectId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      originIsSelf: true
    });
    const lines = formatReconcilePreviewLines([local], "ffffffff-ffff-ffff-ffff-ffffffffffff").join(
      "\n"
    );
    expect(lines).toMatch(/400/);
    expect(lines).not.toMatch(/\bKEEP\b/);
  });

  it("M1: with nothing removed, the message says so without naming either bucket", () => {
    const nothing: OutpostConfigReconcileResult = {
      config: fakeConfig(),
      adoptedObjectId: null,
      removedShadowObjectIds: [],
      removedLocalObjectIds: []
    };
    const lines = formatReconcileResultLines(nothing).join("\n");
    expect(lines).toMatch(/nothing/i);
    expect(lines).not.toMatch(/unverified shadow/i);
    expect(lines).not.toMatch(/journal/i);
  });

  /**
   * ROUND 3 — THE SAME HALF-GUARD, IN THE CLI. `adoptedObjectId` is required-NULLABLE
   * (`federation.ts`), and BEFORE ADR-0023 the generated SDK validated NO response, so a server that omits the key
   * hands this function `undefined`. Keyed on `=== null`, that took the OTHER branch and printed
   *
   *     Adopted: undefined (an unverified hand-filled shadow is now this domain's own object)
   *
   * — an adoption that did not happen, reported as one that did, from the CLI's own recovery verb.
   * The browser half of this bug was fixed in `routes/outpost-configuration.tsx`; the class is
   * broader than the file, so it is pinned in both.
   */
  it("an ABSENT adoptedObjectId reports NO adoption, never `Adopted: undefined`", () => {
    const absent = {
      config: fakeConfig(),
      removedShadowObjectIds: [],
      removedLocalObjectIds: []
    } as unknown as OutpostConfigReconcileResult;
    // `adoptedObjectId` is not merely `undefined` — the KEY IS MISSING, which is what an omitting
    // server actually sends.
    expect("adoptedObjectId" in absent).toBe(false);

    const lines = formatReconcileResultLines(absent).join("\n");
    expect(lines).toContain("Adopted: nothing");
    expect(lines).not.toMatch(/undefined/);
    expect(lines).not.toMatch(/is now this domain's own object/);

    // PREMISE, so this cannot pass by the adoption branch having been broken outright: a REAL
    // adoption is still reported as one.
    const real: OutpostConfigReconcileResult = {
      config: fakeConfig(),
      adoptedObjectId: "adopted-id-1",
      removedShadowObjectIds: [],
      removedLocalObjectIds: []
    };
    expect(formatReconcileResultLines(real).join("\n")).toContain("Adopted: adopted-id-1");
  });
});
