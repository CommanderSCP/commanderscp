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
