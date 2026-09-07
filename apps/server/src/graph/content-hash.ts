import { createHash } from "node:crypto";

/** `content_hash = sha256(canonical row content)` (DESIGN.md §4.1). See docs/graph.md §44. */
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

/** A declared pipeline hook's canonical hash. See docs/graph.md §45. */
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

/** A piece of pipeline evidence, canonically. Excludes `source` and `producerSubjectId`: those are
 *  provenance the RECEIVER stamps, so including them would make the same result hash differently
 *  either side of a federation hop. */
export function computePipelineEvidenceContentHash(input: {
  orgId: string;
  componentObjectId: string;
  targetObjectId: string;
  hookId: string;
  artifactDigest: string | null;
  commitSha: string | null;
  payload: unknown;
}): string {
  const canonical = JSON.stringify({
    orgId: input.orgId,
    componentObjectId: input.componentObjectId,
    targetObjectId: input.targetObjectId,
    hookId: input.hookId,
    artifactDigest: input.artifactDigest,
    commitSha: input.commitSha,
    payload: input.payload
  });
  return createHash("sha256").update(canonical).digest("hex");
}
