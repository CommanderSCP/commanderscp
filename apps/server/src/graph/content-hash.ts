import { createHash } from "node:crypto";

/**
 * `content_hash = sha256(canonical row content)` (DESIGN.md §4.1) — used for federation
 * change-detection (a peer can tell a row changed without comparing every column) and recomputed
 * on every write. Field order is fixed so identical logical content always hashes identically.
 */
export function computeObjectContentHash(input: {
  id: string;
  orgId: string;
  domainId: string | null;
  typeId: string;
  name: string;
  urn: string;
  properties: unknown;
  labels: unknown;
  version: number;
}): string {
  const canonical = JSON.stringify({
    id: input.id,
    orgId: input.orgId,
    domainId: input.domainId,
    typeId: input.typeId,
    name: input.name,
    urn: input.urn,
    properties: input.properties,
    labels: input.labels,
    version: input.version
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function computeRelationshipContentHash(input: {
  id: string;
  orgId: string;
  typeId: string;
  fromId: string;
  toId: string;
  properties: unknown;
  labels: unknown;
}): string {
  const canonical = JSON.stringify({
    id: input.id,
    orgId: input.orgId,
    typeId: input.typeId,
    fromId: input.fromId,
    toId: input.toId,
    properties: input.properties,
    labels: input.labels
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * A declared pipeline hook's canonical hash (outpost-run probes). Same fixed-field-order discipline
 * as the two above: the hash is what lets an outpost tell "this hook changed" from "this hook was
 * re-journalled" without diffing every column, and it is the value a tombstone carries so a delete
 * references the exact content it removes.
 *
 * IDENTITY FIELDS ONLY PLUS THE DECLARATION. `id` is deliberately ABSENT — a hook's identity is
 * `(orgId, componentObjectId, kind, hookId)` (migration 0096's unique constraint), and the row's
 * uuid is local to whichever instance minted it. Including it would make the commander's row and
 * the outpost's copy of the same declaration hash differently, which is exactly the comparison this
 * exists to support.
 */
export function computePipelineHookContentHash(input: {
  orgId: string;
  componentObjectId: string;
  kind: string;
  hookId: string;
  workflow: unknown;
  stage: string | null;
  everySeconds: number | null;
  maxAgeSeconds: number | null;
  quietWindowSeconds: number | null;
}): string {
  const canonical = JSON.stringify({
    orgId: input.orgId,
    componentObjectId: input.componentObjectId,
    kind: input.kind,
    hookId: input.hookId,
    workflow: input.workflow,
    stage: input.stage,
    everySeconds: input.everySeconds,
    maxAgeSeconds: input.maxAgeSeconds,
    quietWindowSeconds: input.quietWindowSeconds
  });
  return createHash("sha256").update(canonical).digest("hex");
}
