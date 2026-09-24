import { createHash } from "node:crypto";
import { hasPermission } from "./resolve.js";
import type { TenantTx } from "../db/tenant-tx.js";
import { forbidden } from "../errors.js";
import { canonicalJson } from "../util/canonical-json.js";

/**
 * THE EXECUTION-SYSTEM ROUTING DOOR (M28.3 final re-verify, probe E; ADR-0056 addendum 3).
 *
 * An `execution-system` object's `properties` decide WHERE a trigger goes and WITH WHAT AUTHORITY:
 * `kind` picks the plugin module, `serverUrl` the endpoint, `tokenSecretKey` which stored credential
 * is sent there, `namespace` where it runs, `allowInternalEgress` whether private egress is asked
 * for, `authoring` (argocd) the bound on what SCP may author, `webUrl`/`serverUrl` on a registry the
 * host a build pushes to — and every key a module's manifest declares is copied into that module's
 * plugin config (`executionSystemPluginConfig`). Probe E: an Operator holding only `object:write`
 * re-pointed a sandbox system's `serverUrl` at the prod Argo, and its permissive allowlist then let
 * an attacker repo plan there with the prod plan credentials.
 *
 * THE PROPERTY, not the instance: ANY change to an execution-system's `properties` needs
 * `secret:write` at the org root — the bar that sets the credential those properties route. Not a
 * list of routing keys: the type's schema is open (`{"type":"object"}`, drizzle/0019), the carried
 * set is whatever each module's manifest declares and grows with it, and `webUrl` — which reads as
 * a display link — turned out to address a registry push. A named list is where the next key hides.
 * `name`, `labels` and containment stay at `object:write`: none of them reaches a plugin.
 *
 * Installed at the repo's local write choke point (`createObject`/`updateObject`, which
 * `upsertObjectByUrn`, the typed and generic object routes, coordination-as-code apply and the
 * `scp connect` flows all funnel through) and at federation hand-fill (which stamps
 * `federationImport` and so bypasses that choke point). A SIGNED import is the origin domain's
 * authority, gated there by this same code; the receiver never executes it
 * (`isLocallyAuthoredExecutionSystem`).
 */

export const EXECUTION_SYSTEM_TYPE_ID = "execution-system";

/** The property keys a write would add, change or remove, sorted. */
export function executionSystemPropertyDelta(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): string[] {
  const changed: string[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (
      Object.hasOwn(before, key) !== Object.hasOwn(after, key) ||
      canonicalJson(before[key]) !== canonicalJson(after[key])
    ) {
      changed.push(key);
    }
  }
  return changed.sort();
}

export async function assertMayWriteExecutionSystemRouting(
  tx: TenantTx,
  args: {
    orgId: string;
    actorObjectId: string;
    typeId: string;
    /** `{}` on a create: every property a new system carries is a routing decision. */
    before: Record<string, unknown>;
    /** The properties about to be STORED — the value, not the request field. */
    after: Record<string, unknown>;
    subject: string;
  }
): Promise<void> {
  if (args.typeId !== EXECUTION_SYSTEM_TYPE_ID) return;
  const changed = executionSystemPropertyDelta(args.before, args.after);
  if (changed.length === 0) return;
  const ok = await hasPermission(tx, {
    orgId: args.orgId,
    subjectObjectId: args.actorObjectId,
    permission: "secret:write",
    // org root object id === orgId (bootstrap invariant), as governance-labels.ts reads it.
    scopeObjectId: args.orgId
  });
  if (ok) return;
  throw forbidden(
    `cannot change the properties of ${args.subject} (${changed.join(", ")}): an execution system's ` +
      `properties decide where its triggers go and which stored credential they carry, so writing ` +
      `them requires 'secret:write' at the organization root — the bar for setting that credential. ` +
      `'object:write' may still rename or relabel it (ADR-0056 addendum 3).`
  );
}

/** The fields a source-allowlist row is bound to: where the system's credentials go, and which. */
export const ROUTING_FINGERPRINT_FIELDS = [
  "kind",
  "serverUrl",
  "namespace",
  "tokenSecretKey"
] as const;

function normalisedUrl(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return new URL(value.trim()).href;
  } catch {
    return value;
  }
}

/** sha256 over the routing fields, so an allowlist set for one endpoint cannot follow a re-point. */
export function executionSystemRoutingFingerprint(properties: unknown): string {
  const props = (properties && typeof properties === "object" ? properties : {}) as Record<
    string,
    unknown
  >;
  const fields: Record<string, unknown> = {};
  for (const key of ROUTING_FINGERPRINT_FIELDS) {
    fields[key] = key === "serverUrl" ? normalisedUrl(props[key]) : (props[key] ?? null);
  }
  return createHash("sha256").update(canonicalJson(fields)).digest("hex");
}

/** A REPLICATED execution system is never executable here. Its routing was written by another
 *  domain's writer, but `tokenSecretKey` names a secret in THIS instance's store — so resolving it
 *  would send a local credential wherever a peer pointed it. Register the system locally instead. */
export function isLocallyAuthoredExecutionSystem(
  sys: { originDomainId: string },
  selfDomainId: string
): boolean {
  return sys.originDomainId === selfDomainId;
}
