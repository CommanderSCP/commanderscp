import { and, eq, isNull, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { GraphObject } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { objects } from "../db/schema.js";
import { createObject, toGraphObject } from "./objects-repo.js";
import { isUniqueViolation } from "../db/pg-errors.js";

/**
 * `artifact` — THE IMMUTABLE BUILT THING IDENTIFIED BY DIGEST, as a first-class object (ADR-0045).
 *
 * MINTED ONLY AT THE PROMOTION BOUNDARY (ADR-0045 D2) — `exportPromotionBundle` (commander, after
 * the manifest is cosign-signed) and `importPromotionBundle` (receiver, after signature + checksum
 * verification pass). Neither a build report nor an `observe()` poll mints. That is what keeps the
 * population bounded to promoted digests — attested-only, no GC problem — and this module has no
 * opinion on either caller; it is the one place identity is resolved and rows are written, called
 * from `federation/promotion-repo.ts`.
 */

export interface ArtifactMintInput {
  /** `'oci' | 'blob'` today (`ArtifactRefSchema`), but read as a plain string here — the registered
   *  `artifact` type's `artifactType` property is deliberately OPEN (0094's header; ADR-0045 D1),
   *  and this module must not narrow what its own caller already widened. */
  artifactType: string;
  digest: string;
}

export interface MintArtifactObjectsOptions {
  actorObjectId: string;
  requestId: string;
  /** ADR-0045 D2 — which side of the boundary minted this row. Optional, open provenance: never an
   *  enforcement input, purely for an operator asking "where did this artifact object come from". */
  mintedBy: "export" | "import";
  /** The promotion change that first caused this identity to be minted, when known. Optional: a
   *  row found already minted (by this call or an earlier one) is returned unchanged — this field
   *  is stamped only on the row this call itself creates, never overwritten on convergence (see
   *  the "first" in the name). */
  firstPromotedChangeId?: string;
}

/** One `artifact` row, keyed by its identity — read straight off the partial unique index 0094
 *  installs, so this is the exact query that index makes an index probe rather than a scan.
 *  EXPORTED for `federation/import-repo.ts`'s ordinary `object_upsert` pre-check — see that
 *  module's "AN ARTIFACT IDENTITY COLLISION COSTS ONE ENTRY" section for why a second reader of
 *  this exact query exists outside the mint path. */
export async function findArtifactByIdentity(
  tx: TenantTx,
  orgId: string,
  artifactType: string,
  digest: string
): Promise<GraphObject | undefined> {
  const rows = await tx
    .select()
    .from(objects)
    .where(
      and(
        eq(objects.orgId, orgId),
        eq(objects.typeId, "artifact"),
        isNull(objects.deletedAt),
        sql`${objects.properties} ->> 'digest' = ${digest}`,
        sql`${objects.properties} ->> 'artifactType' = ${artifactType}`
      )
    )
    .limit(1);
  return rows[0] ? toGraphObject(rows[0]) : undefined;
}

/**
 * UPSERT-BY-IDENTITY, one artifact at a time: find by `(orgId, digest, artifactType)`; if absent,
 * create. Called for every entry in `artifacts[]` by {@link mintArtifactObjects}.
 *
 * IDEMPOTENT ACROSS CALLS — a re-export of an already-exported change, or a second call racing the
 * first (two concurrent promotion attempts naming the same digest), converges on ONE row: the
 * find-then-create is not atomic, so a lost race surfaces as `objects_artifact_one_per_digest_type`
 * failing on the INSERT, caught here and resolved by re-reading the row the winner created — never
 * a 409 surfaced to the caller, because neither `exportPromotionBundle` nor `importPromotionBundle`
 * has anything to do with a caller-facing conflict over an artifact object's existence.
 *
 * THE SAME CLASS OF RISK 0051/0043 ALREADY CARRY, NOT A NEW ONE: an `artifact` object is an
 * ordinary (non-domain-local) object once minted (ADR-0045 D3), so it journals and may ALSO arrive
 * at a peer through ordinary full-scope sync, independently of a promotion bundle — carrying the
 * MINTING domain's own urn embedded verbatim (every replicated object does; urns are not
 * re-derived on import). That replica and a row this function creates locally can never collide on
 * `objects_org_id_urn_key` (their urns differ), which is exactly the exposure 0051's own header
 * accepted for `placement` and 0043 accepted for `outpost` — general to every identity-bearing
 * registered type in this schema, not specific to `artifact`, and not solved here for the same
 * reason it was not solved there.
 */
async function upsertArtifactByIdentity(
  tx: TenantTx,
  orgId: string,
  artifact: ArtifactMintInput,
  options: MintArtifactObjectsOptions
): Promise<GraphObject> {
  const existing = await findArtifactByIdentity(tx, orgId, artifact.artifactType, artifact.digest);
  if (existing) return existing;

  try {
    return await createObject(tx, {
      orgId,
      typeId: "artifact",
      actorObjectId: options.actorObjectId,
      requestId: options.requestId,
      id: uuidv7(),
      // The digest IS the identity — a readable name beats an invented label, and `deriveUrn`
      // slugifies it into a valid urn segment.
      name: `${artifact.artifactType}:${artifact.digest}`,
      properties: {
        digest: artifact.digest,
        artifactType: artifact.artifactType,
        mintedBy: options.mintedBy,
        ...(options.firstPromotedChangeId
          ? { firstPromotedChangeId: options.firstPromotedChangeId }
          : {})
      }
    });
  } catch (err) {
    if (isUniqueViolation(err, "objects_artifact_one_per_digest_type")) {
      // Lost the race — the row this call would have created now exists under a different id.
      // Converge on it rather than surfacing a conflict neither caller can act on.
      const winner = await findArtifactByIdentity(
        tx,
        orgId,
        artifact.artifactType,
        artifact.digest
      );
      if (winner) return winner;
    }
    throw err;
  }
}

/**
 * Mint (or find) one `artifact` object per entry in `artifacts` — the ONLY two call sites are
 * `exportPromotionBundle` and `importPromotionBundle` (ADR-0045 D2). Order-preserving; duplicate
 * `(digest, artifactType)` pairs within one call converge on the same returned object, same as
 * across calls.
 */
export async function mintArtifactObjects(
  tx: TenantTx,
  orgId: string,
  artifacts: ArtifactMintInput[],
  options: MintArtifactObjectsOptions
): Promise<GraphObject[]> {
  const minted: GraphObject[] = [];
  // Sequential, not `Promise.all`: two entries in the SAME call sharing an identity (a malformed or
  // duplicated artifact set) must also converge on one row, and interleaved concurrent finds would
  // both see "absent" and both attempt to create — the exact race `upsertArtifactByIdentity`'s catch
  // exists to resolve, but resolving it N-ways per call is needless when strict ordering avoids it
  // for free. Promotion artifact sets are small (single digits), so this costs nothing worth
  // parallelizing away.
  for (const artifact of artifacts) {
    minted.push(await upsertArtifactByIdentity(tx, orgId, artifact, options));
  }
  return minted;
}
