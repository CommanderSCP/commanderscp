import { hasPermission } from "../authz/resolve.js";
import type { TenantTx } from "../db/tenant-tx.js";
import { badRequest, forbidden } from "../errors.js";
import { canonicalJson } from "../util/canonical-json.js";

/**
 * ================================================================================================
 * THE RESERVED GOVERNANCE LABEL NAMESPACE — "a description is not an assertion"
 * ================================================================================================
 *
 * ## The property this closes
 *
 * A governance decision whose MATCH KEY is writable by its own SUBJECT, at a strictly weaker
 * permission than the one that authored the constraint.
 *
 * The live instance: `governance/policy-resolve.ts`'s `scope.selector.labels` branch matches a
 * policy against `labels` on any object in the target's containment chain. Authoring that policy
 * requires `policy:write` AT THE ORG ROOT — `policy-scope-authz.ts` deliberately demands the widest
 * bar there is, "precisely because a selector has org-wide blast radius". Writing the labels it
 * matches on required nothing at all: `object:write` at the object, i.e. the subject's own owner,
 * validated by no schema (`drizzle/0002_rls_rbac_seed.sql:161` registers `policy` with
 * `{"type":"object"}` and `labels` has no schema on ANY type), and with no reserved namespace.
 *
 * So the subject of a selector-scoped policy could walk out of its reach by deleting one map entry.
 * SecOps writes `scope: {selector: {labels: {tier: "pci"}}}` with `requireApprovals` and a strict
 * `scanThreshold`; the component owner drops `tier` from their component's labels; every gate stops
 * matching. No error, no audit event, no Decision — a constraint that fails to match is a constraint
 * that does not apply, and this one fails to match silently.
 *
 * ## Why a reserved namespace and not the alternatives
 *
 * Three shapes were considered; the reasoning is in `docs/proposals/governance-label-namespace.md`
 * and only the conclusion is restated here, because the rejected options are the kind that get
 * re-proposed.
 *
 *  - **An audit event when a label change alters which policies match** is detection, not
 *    prevention: the gate still stops firing, and the operator learns about it from a promotion that
 *    sailed through. It also costs a full policy scan plus a containment walk on the hottest write
 *    path in the system. Cheaper to build, strictly weaker, and it leaves the fail-open in place.
 *
 *  - **Freezing whatever label keys the org's policies happen to name** needs no new namespace and
 *    no re-keying — but it means the day SecOps authors `selector: {env: "prod"}`, every team in the
 *    org loses the ability to set `env` on anything. Governance reach would silently become a
 *    function of unrelated documents, and describing your estate would start returning 403s. The
 *    tension is irreducible: `env` is exactly the label a selector wants AND exactly the label a
 *    team must be able to set.
 *
 *  - **A reserved namespace** dissolves that tension by separating the two acts that were sharing
 *    one bag. `labels.tier` is a DESCRIPTION the owner makes about their own object.
 *    `labels["scp.governance/tier"]` is an ASSERTION an authority makes about it. The first stays
 *    exactly as free as it is today; only the second is out of the subject's reach, and only the
 *    second is what a constraint may key on.
 *
 * This is ADR-0003's shape, one layer over: there, a graph property "is a per-system DECLARATION of
 * intent, not a grant" and buys nothing unless an operator-set value outside tenant write reach
 * independently agrees (`coordination/executor-bindings-repo.ts`'s `resolveInternalEgress`). Here
 * the tenant's `tier: pci` likewise grants and relieves nothing; the operator-set
 * `scp.governance/tier: pci` is the only thing a constraint sees.
 *
 * ## The bar is org-root `policy:write`, and it is the same bar as the policy itself
 *
 * `assertPolicyScopeWithinAuthority` requires `policy:write` at the ORG ROOT to author a
 * selector-scoped policy. A governance label is the other end of that same constraint, so it takes
 * the same bar and not a weaker one. `policy:write` scoped at a component would otherwise let a
 * component-level administrator clear the key an org-level SecOps policy matches on — the original
 * evasion with one more permission and no more authority.
 *
 * ERGONOMICS, since org-root authority sounds heavier than it is: `labelsMatch` runs over the whole
 * CONTAINMENT CHAIN (`policy-resolve.ts`), so an operator labels a DOMAIN or a SERVICE once and
 * every component beneath it is governed. There is no per-component labelling burden, and there is
 * no new place to look — a governance label is an ordinary entry in an ordinary `labels` map,
 * readable by anyone who can read the object.
 *
 * ## Where it is installed
 *
 * At `graph/objects-repo.ts`'s `createObject`/`updateObject` and `graph/relationships-repo.ts`'s
 * `createRelationship`/`updateRelationship` — the choke points every LOCAL write door funnels
 * through — never per route. `routes/*.ts` alone admits `labels` on eighteen handlers, and
 * `subscription-guard-write-doors.integration.test.ts` already records three doors (IaC apply,
 * `POST /federation/hand-fill`, `POST /federation/overlays`) that reach `createObject` without
 * passing through `typed-registries.ts` at all. The `federationImport` exemption and its closing at
 * `federation/handfill-repo.ts` follow that file's precedent exactly; see the call sites.
 */
export const GOVERNANCE_LABEL_PREFIX = "scp.governance/";

/**
 * Is this label key reserved to governance?
 *
 * A bare prefix test, deliberately — no normalisation, no case folding, no trimming. A key is
 * either literally in the namespace or it is not, because both readers of this predicate compare
 * label keys with `===` (`policy-resolve.ts`'s `labelsMatch`, `federation/scope-filter.ts`'s custom
 * mode). Any fuzziness here would create a key that is reserved for the WRITE check and a different
 * key for the MATCH — which is the evasion, rebuilt inside the guard.
 */
export function isGovernanceLabelKey(key: string): boolean {
  return key.startsWith(GOVERNANCE_LABEL_PREFIX);
}

/**
 * The governance-namespace keys this write would ADD, CHANGE **or REMOVE**, sorted.
 *
 * REMOVAL IS THE ATTACK, so it is the case this must not miss: `updateObject` replaces `labels`
 * wholesale, so "the request did not mention the key" and "the request deletes the key" are the
 * same bytes on the wire. A delta computed over `after`'s keys alone would be blind to exactly the
 * move this module exists to stop.
 *
 * Values are compared canonically rather than by reference or `===`: labels are `jsonb`, so a value
 * that round-trips through the database as a structurally-identical object is not the same
 * reference, and a spurious "changed" would turn an ordinary PATCH into a 403.
 */
export function governanceLabelDelta(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): string[] {
  const keys = new Set(
    [...Object.keys(before), ...Object.keys(after)].filter((key) => isGovernanceLabelKey(key))
  );
  const changed: string[] = [];
  for (const key of keys) {
    const inBefore = Object.hasOwn(before, key);
    const inAfter = Object.hasOwn(after, key);
    if (inBefore !== inAfter || canonicalJson(before[key]) !== canonicalJson(after[key])) {
      changed.push(key);
    }
  }
  return changed.sort();
}

/**
 * Refuses a write that would add, change or remove a governance label unless the actor holds
 * `policy:write` at the org root. A write that leaves every governance key byte-identical performs
 * NO permission lookup at all, which is what keeps this off the cost of the ordinary write path.
 *
 * A FULL-REPLACEMENT WRITE THAT SIMPLY OMITS THE KEY IS REFUSED, not silently repaired. Merging the
 * operator's keys back in would produce zero false positives and one very bad true negative: an
 * operator WITH `policy:write` doing a deliberate `PUT` to REMOVE a governance label would be
 * answered 200 and the label would still be there. Two behaviours where one will do, and the silent
 * one is wrong for the actor who matters most. So the refusal is loud and names the exact keys —
 * `graph/objects-repo.ts`'s own ADR-0031 §6a block makes the same call for the same reason ("both of
 * the silent options are worse").
 */
export async function assertMayWriteGovernanceLabels(
  tx: TenantTx,
  args: {
    orgId: string;
    actorObjectId: string;
    /** The stored labels. `{}` on a create. */
    before: Record<string, unknown>;
    /** The labels about to be stored — the value, not the request field. */
    after: Record<string, unknown>;
    /** Named in the error so an operator can find the row without correlating a request id. */
    subject: string;
  }
): Promise<void> {
  const changed = governanceLabelDelta(args.before, args.after);
  if (changed.length === 0) return;

  const ok = await hasPermission(tx, {
    orgId: args.orgId,
    subjectObjectId: args.actorObjectId,
    permission: "policy:write",
    // org root object id === orgId (bootstrap invariant), exactly as `policy-scope-authz.ts` reads it.
    scopeObjectId: args.orgId
  });
  if (ok) return;

  throw forbidden(
    `cannot write reserved governance labels on ${args.subject}: ` +
      `${changed.join(", ")}. Label keys under '${GOVERNANCE_LABEL_PREFIX}' are assertions an ` +
      `authority makes about an object — a policy 'scope.selector' and a federation 'custom' sync ` +
      `scope may key on nothing else — so writing, changing or REMOVING one requires ` +
      `'policy:write' at the organization root, the same bar that authoring a selector-scoped ` +
      `policy requires. Note that a full-replacement write which omits a key REMOVES it: re-send ` +
      `the governance labels the object already carries, or describe your object with an ` +
      `unreserved label key instead.`
  );
}

/**
 * A `policy` document's `scope.selector.labels` may key ONLY on governance labels.
 *
 * WITHOUT THIS HALF THE NAMESPACE IS A FEATURE, NOT A GUARD. An author who reaches for
 * `{tier: "pci"}` — the ordinary, obvious thing, and what `docs/DESIGN.md` §10.1's own example
 * shows — gets a policy their subjects can still walk out of, with no indication that they can.
 * Fail-closed means the unusable state is unrepresentable rather than merely discouraged, which is
 * the move `subscription-authoring-guard.ts` and `drizzle/0061`'s declared-producer CHECK both make.
 *
 * PURE, and refusing on the DOCUMENT alone. It takes `typeId` as an argument rather than letting
 * each caller decide, so every installation site — including the free-form-`typeId` doors — is
 * correct by construction instead of by remembering (`subscription-authoring-guard.ts`'s reasoning,
 * verbatim, for the same reason).
 *
 * ONLY `policy`. `listPolicyCandidates` (`policy-resolve.ts`) selects `type_id = 'policy'` and
 * nothing else, so a `scope.selector` on any other type is never resolved and carries no hazard.
 *
 * `labels: {}` IS a live selector and is left alone: `labelsMatch` is an `every()` over zero
 * entries, so it is `true` for every ancestor — an org-wide match that keys on nothing and therefore
 * cannot be evaded by editing anything. Refusing it would be refusing the one selector shape that
 * was never exposed.
 */
export function assertSelectorKeysAreGovernanceLabels(args: {
  typeId: string;
  properties: Record<string, unknown> | undefined;
}): void {
  if (args.typeId !== "policy") return;
  const scope = args.properties?.scope as { selector?: { labels?: unknown } } | undefined;
  const labels = scope?.selector?.labels;
  // Mirrors the matcher's own test (`if (scope.selector?.labels)`) so this can never refuse a
  // document the matcher would ignore, nor ignore one the matcher would honour.
  if (labels === null || typeof labels !== "object" || Array.isArray(labels)) return;

  const offenders = Object.keys(labels as Record<string, unknown>)
    .filter((key) => !isGovernanceLabelKey(key))
    .sort();
  if (offenders.length === 0) return;

  throw badRequest(
    `policy scope.selector.labels may only key on reserved governance labels, but names: ` +
      `${offenders.join(", ")}. An ordinary label is writable by the object's own owner under ` +
      `'object:write', so a selector keyed on one is a constraint its own subject can remove — ` +
      `silently, and with a weaker permission than the org-root 'policy:write' this policy ` +
      `required. Re-key the selector under '${GOVERNANCE_LABEL_PREFIX}' (e.g. ` +
      `'${GOVERNANCE_LABEL_PREFIX}${offenders[0]}') and apply that label to the domain, service or ` +
      `component you mean to govern — the selector matches down the containment chain, so labelling ` +
      `a container governs everything beneath it. To scope to one known object instead, use ` +
      `scope.objectRef.`
  );
}

/**
 * The same rule for a peer's `custom` sync scope — the OTHER decision in the tree that a tenant can
 * re-aim by editing a label, and the more serious of the two.
 *
 * `federation/scope-filter.ts`'s `custom` mode decides which journal entries LEAVE this security
 * domain, and its own header calls that out: a scoped peer is scoped "precisely FOR
 * confidentiality". The selector is authored under `federation:write`; the labels it matches are the
 * object's own, writable under `object:write`. So a component owner who sets `tier: gold` on their
 * component ships it across a domain boundary to a peer that was configured never to receive it —
 * the same property as the policy case, running in the widening direction rather than the narrowing
 * one, and against confidentiality rather than a gate.
 *
 * ENFORCED AT PEER-CONFIG AUTHORING ONLY. `entryMatchesScope` stays a pure, synchronous predicate
 * that the importer — which cannot query the sender's database — applies to exactly the same input
 * and reaches exactly the same answer; that symmetry is the whole basis of the defense-in-depth
 * re-filter at import, so nothing here touches it. An already-stored `custom` scope keying on an
 * unreserved label keeps filtering exactly as it does today until someone edits it, which is the
 * same grandfathering ADR-0032 §6a's guard accepted.
 */
export function assertSyncScopeSelectorKeysAreGovernanceLabels(
  syncScope: { mode?: unknown; labelSelector?: unknown } | undefined
): void {
  if (!syncScope || syncScope.mode !== "custom") return;
  const selector = syncScope.labelSelector;
  if (selector === null || typeof selector !== "object" || Array.isArray(selector)) return;

  const offenders = Object.keys(selector as Record<string, unknown>)
    .filter((key) => !isGovernanceLabelKey(key))
    .sort();
  if (offenders.length === 0) return;

  throw badRequest(
    `a 'custom' sync scope may only key on reserved governance labels, but names: ` +
      `${offenders.join(", ")}. This selector decides which journal entries cross a security ` +
      `domain boundary, and an ordinary label is writable by the object's own owner under ` +
      `'object:write' — so an unreserved key lets the subject of the filter decide whether it is ` +
      `exported. Re-key under '${GOVERNANCE_LABEL_PREFIX}' (e.g. ` +
      `'${GOVERNANCE_LABEL_PREFIX}${offenders[0]}').`
  );
}
