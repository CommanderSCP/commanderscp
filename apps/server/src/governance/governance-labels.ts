import { hasPermission } from "../authz/resolve.js";
import type { TenantTx } from "../db/tenant-tx.js";
import { badRequest, forbidden } from "../errors.js";
import { canonicalJson } from "../util/canonical-json.js";

/** THE RESERVED GOVERNANCE LABEL NAMESPACE. See docs/governance.md §146. */
export const GOVERNANCE_LABEL_PREFIX = "scp.governance/";

/** Is this label key reserved to governance? See docs/governance.md §147. */
export function isGovernanceLabelKey(key: string): boolean {
  return key.startsWith(GOVERNANCE_LABEL_PREFIX);
}

/** The governance keys this write would add, change or remove. See docs/governance.md §148. */
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

/** Refuses a governance-label write unless the actor may. See docs/governance.md §149. */
export async function assertMayWriteGovernanceLabels(
  tx: TenantTx,
  args: {
    orgId: string;
    actorObjectId: string;
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

/** A policy selector may key only on governance labels. See docs/governance.md §150. */
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

/** The same rule for a peer's `custom` sync scope. See docs/governance.md §151. */
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
