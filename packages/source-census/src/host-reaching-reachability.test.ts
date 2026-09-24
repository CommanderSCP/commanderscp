import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { trackedFiles } from "./tracked.js";

/**
 * THE INSTALLATION GATE for host-reaching execution (M27.9).
 *
 * M27 shipped eight increments and every one of them was green. A census for PRODUCTION callers
 * then found `compileInventory`, `egressAllowlistFor`, `enrolDomain`, `recordIssuance` and
 * `reconcileSerials` at ZERO: the plugin refused a trigger whose material was incomplete, that
 * refusal was mutation-proved, the inventory compiler was proved, the allowlist was proved — and
 * nothing anywhere produced the material, so no host-reaching run could execute at all while every
 * gate stayed green.
 *
 * This is §4.4a's rule applied to that class. The bug was one missing call; the PROPERTY is "a
 * capability whose every test calls it directly, so no test notices when nothing else does." So the
 * gate is written over the property: each function below is load-bearing for a host-reaching run,
 * and each must be reachable from something that is not a test.
 *
 * WHY A SOURCE CENSUS RATHER THAN A BEHAVIOURAL TEST. A behavioural test for this path needs a
 * bound `managed-ops` executor, which needs a runner image, a catalog verification key and a real
 * `sshd` — all of which exist, and all of which a future refactor can quietly stop exercising. The
 * source census cannot be satisfied by accident: deleting the call in `reconcile.ts` turns it red
 * with the name of the function that became unreachable.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");

/** Every function that must be reachable from production code, and WHY it is load-bearing.
 *  The reason is carried here because a bare list decays into something people delete from. */
const MUST_HAVE_A_PRODUCTION_CALLER: Record<string, string> = {
  deriveOpsRunMaterial:
    "produces the material `managed-ops` refuses to run without; with no caller, every " +
    "host-reaching trigger is refused by its own plugin",
  opsLaneTriggerParameters: "the reconcile-side call that puts the material on the trigger",
  compileInventory: "turns observed membership into the inventory — which machines get touched",
  egressAllowlistFor: "the per-run bound on what the run can reach at all (M27.6b)",
  enrolDomain:
    "the only door to a CA, and the only place the break-glass precondition is enforced " +
    "(ADR-0051); unreachable means no domain can ever be enrolled",
  recordIssuance:
    "ADR-0051 D5's detective control — the ONLY thing that bounds CA compromise, since short " +
    "TTLs provably do not",
  reconcileSerials: "surfaces a serial a host accepted that SCP never issued — the forgery signal",
  // M28.2 — host ops through an org's Argo Workflows (ADR-0054).
  deriveOpsBound:
    "the ONE derivation both executors share; if Mode C stopped calling it, the two paths could " +
    "diverge on which hosts a run touches",
  isOpsLane:
    "decides which triggers are host-reaching at all; unreachable means the Argo path derives " +
    "nothing and the pod has no token",
  createOpsRunRedemption:
    "stores the Argo run's bound and seals its one-time token; with no caller no scp-ops-v1 pod " +
    "can ever reach its material",
  redeemOpsRun:
    "the redeem door's logic — single-use, windowed, audited; with no caller the Argo path " +
    "cannot obtain a certificate",
  registerOpsRunRedemptionRoutes: "puts the redeem door on the public API"
};

const isTest = (p: string): boolean =>
  p.includes(".test.") || p.includes("/test-support/") || p.includes("/testkit/");

/** Tracked, non-test TypeScript sources. Read with `readFileSync`, NOT via a grep tool: some
 *  tracked sources in this repo carry literal NUL bytes and every search tool silently drops them
 *  from a recursive search with exit 1 — indistinguishable from "no such code exists" (§4.4b). */
const PRODUCTION_SOURCES = trackedFiles(REPO_ROOT).filter(
  (p) =>
    (p.startsWith("apps/") || p.startsWith("packages/")) &&
    p.endsWith(".ts") &&
    !p.endsWith(".d.ts") &&
    !isTest(p)
);

/** Where each name is DEFINED — excluded when looking for callers, since a definition is not a use. */
function definitionFiles(name: string): Set<string> {
  const defined = new Set<string>();
  const declaration = new RegExp(`export (?:async )?function ${name}\\b`);
  for (const path of PRODUCTION_SOURCES) {
    if (declaration.test(readFileSync(resolve(REPO_ROOT, path), "utf8"))) defined.add(path);
  }
  return defined;
}

function callersOf(name: string): string[] {
  const defined = definitionFiles(name);
  // `name(` or `name (`, anywhere but its own definition. Deliberately loose: a false POSITIVE here
  // costs nothing (the gate stays green on a real caller), while a false negative would fail a
  // build for a function that is genuinely wired.
  const used = new RegExp(`\\b${name}\\s*\\(`);
  return PRODUCTION_SOURCES.filter((p) => !defined.has(p)).filter((p) =>
    used.test(readFileSync(resolve(REPO_ROOT, p), "utf8"))
  );
}

describe("host-reaching execution is INSTALLED, not merely built", () => {
  it.each(Object.entries(MUST_HAVE_A_PRODUCTION_CALLER))(
    "%s has at least one non-test caller",
    (name, why) => {
      const callers = callersOf(name);
      expect(
        callers,
        `${name}() has NO production caller. It is ${why}. A test calling it directly does not ` +
          `make it reachable — that is exactly how M27 shipped eight green increments with no ` +
          `working host-reaching path. Wire it, or delete it and say so.`
      ).not.toEqual([]);
    }
  );

  it("every name in the census is actually DEFINED somewhere", () => {
    // Otherwise a rename silently empties the gate: `callersOf` on a name nothing defines returns
    // every file that never mentions it, the assertion above passes vacuously, and the census
    // reports green while protecting nothing. This is the "checks that pass without running" shape.
    for (const name of Object.keys(MUST_HAVE_A_PRODUCTION_CALLER)) {
      expect(
        [...definitionFiles(name)],
        `${name} is in the reachability census but nothing exports it — it was renamed or ` +
          `removed, and the census entry now protects nothing.`
      ).not.toEqual([]);
    }
  });
});
