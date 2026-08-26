import { and, eq, isNull, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { GraphObject, TrustDomainId } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { objects } from "../db/schema.js";
import { createObject, toGraphObject } from "./objects-repo.js";
import { computeObjectContentHash } from "./content-hash.js";
import { ProblemError, notFound } from "../errors.js";
import { appendAuditEvent } from "../audit/audit-repo.js";

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
 * find-then-create is not atomic, so a lost race surfaces as an INSERT failing on
 * `objects_artifact_one_per_digest_type` (this identity) or `objects_org_id_urn_key` (the urn
 * `deriveUrn` derives from the same identity is deterministic, so the two indexes fire on the same
 * race) — never a 409 surfaced to the caller, because neither `exportPromotionBundle` nor
 * `importPromotionBundle` has anything to do with a caller-facing conflict over an artifact
 * object's existence.
 *
 * DETECTED AS A `ProblemError` 409, NOT A RAW PG 23505 — `createObject` (objects-repo.ts) already
 * catches both unique violations itself and rethrows a `conflict()` `ProblemError` before this
 * function's own `catch` ever sees the original driver error, so `isUniqueViolation` can never
 * match here (a `ProblemError` carries no `.code`). The only conflict `createObject` can throw from
 * this call is one of those two races, so catching `ProblemError` + `status === 409` here and
 * re-reading by identity is precise, not a broad swallow.
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
    // A SAVEPOINT (nested `tx.transaction`), not a bare `try`/`catch` — `placements-repo.ts` and
    // `webhook-processor.ts` state the same rule this call needs: a unique violation aborts the
    // WHOLE enclosing Postgres transaction, so a `catch` that re-reads on the SAME `tx` afterward
    // hits every statement it issues with `25P02` ("current transaction is aborted") rather than
    // the answer it is trying to converge on. `tx.transaction(...)` here is a real `SAVEPOINT` /
    // `ROLLBACK TO SAVEPOINT` around exactly the risky INSERT, so a lost race rolls back only that
    // nested scope and leaves the caller's transaction usable for the re-read below.
    return await tx.transaction((inner) =>
      createObject(inner, {
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
      })
    );
  } catch (err) {
    if (err instanceof ProblemError && err.status === 409) {
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

export interface AdoptArtifactIdentityInput {
  /** THIS domain's own row — found by identity (digest+artifactType), never by the incoming urn:
   *  see the caller (`federation/import-repo.ts`'s `object_upsert` branch). Stays the id AND the
   *  urn after adoption; only authority and content move. */
  existingId: string;
  /** The cryptographically-verified signer of the incoming entry (never `payload.originDomainId`
   *  — same authority rule every other import branch enforces). */
  originDomainId: TrustDomainId;
  revision: number;
  /** The incoming signed entry's own `properties` — merged over the existing row's (see the
   *  `firstPromotedChangeId` carve-out below). */
  incomingProperties: Record<string, unknown>;
  actorObjectId: string;
  requestId: string;
}

/**
 * ADR-0045 D2a — CONVERGE BY ADOPTION, the D2/D3 fix for the artifact identity collision that
 * `mintArtifactObjects`'s import-mint (D2) and ordinary full-scope sync (D3) otherwise produce
 * FOREVER, once per promotion per peer: `importPromotionBundle` mints this domain's own local
 * anchor for a digest the moment it is promoted in (D2 — the receiver needs SOMETHING to point its
 * newly-proposed change's `sourceRef` at immediately, before any ordinary sync could possibly have
 * carried the exporter's copy). That row is an ORDINARY object once minted (D3), so it journals —
 * and the exporter's OWN minted row for the identical `(digest, artifactType)` is ALSO ordinary and
 * WILL eventually arrive here via full-scope sync, independently of any promotion. Two different
 * ids, one identity: `objects_artifact_one_per_digest_type` (0094) refuses the second row outright.
 *
 * The prior behavior (`import-repo.ts`'s pre-check) SKIPPED the incoming entry and recorded an
 * `federation.import.entry_dropped` audit event — correct for an accidental one-off collision
 * (0051/0043's precedent), wrong here: this collision is not accidental, it is GUARANTEED for every
 * promoted digest that also reaches this peer under `full` scope, so skip-and-record produces one
 * dropped entry per promotion per peer forever and the receiver's anchor never learns the shared
 * base is now present.
 *
 * INSTEAD: adopt. The existing (import-minted) row's AUTHORITY moves to the incoming entry's
 * verified signer — id and urn stay exactly as they were (every local reference the receiver's own
 * promoted change already holds — `sourceRef.artifactDigests`, `derived_from` edges, anything keyed
 * on this artifact's id — keeps resolving, which is the whole reason the id must NOT become the
 * incoming one, unlike `upsertObjectByUrn`'s unrelated hand-fill-reconciliation branch). `revision`
 * and `properties` move to the incoming entry's, EXCEPT `firstPromotedChangeId`: that field is
 * this receiver's own local history ("the promotion that first caused this identity to be minted
 * HERE" — `MintArtifactObjectsOptions`'s doc above) and stays true after adoption exactly as before
 * it, the same "never overwritten on convergence" rule a plain re-mint already honors.
 *
 * NOT RE-JOURNALED. This is treated as what it now is — an ordinary imported replica of the peer's
 * own artifact object, same as any other `federationImport` write (`objects-repo.ts`'s `!input.
 * federationImport` journal gate) — so this call does not itself emit a fresh `object_upsert`; the
 * LOCAL audit row is written unconditionally either way (charter principle 6), and any further
 * relay of the now-adopted row to a THIRD domain goes through the ordinary replica-relay path, not
 * this write.
 *
 * WHY NOT MAKE THE IMPORT-MINTED ANCHOR `domainLocal: true` INSTEAD (the alternative ADR-0045 D2a
 * considered and rejected): a domain-local anchor never journals at all, which looks like it
 * sidesteps the collision — but it also means the exporter's later-arriving SHARED copy could never
 * land under the SAME id (a domain-local object's identity is invisible to every peer by design,
 * ADR-0031 §2), so the receiver would be permanently split between its own local-only anchor and
 * the real shared artifact the rest of the federation actually references. M20's whole semantics —
 * "this object IS the org's one graph object for this identity, replicated with authority" — would
 * wedge for every promoted artifact, forever, which is a worse and more permanent version of the
 * exact problem this fix exists to close.
 */
export async function adoptArtifactIdentity(
  tx: TenantTx,
  orgId: string,
  input: AdoptArtifactIdentityInput
): Promise<GraphObject> {
  const rows = await tx
    .select()
    .from(objects)
    .where(
      and(
        eq(objects.orgId, orgId),
        eq(objects.id, input.existingId),
        eq(objects.typeId, "artifact"),
        isNull(objects.deletedAt)
      )
    )
    .for("update");
  const existing = rows[0];
  if (!existing) throw notFound(`artifact '${input.existingId}' not found`);

  // IDEMPOTENT REPLAY (DESIGN §13 DoD: "double-import is a no-op") — this call's own caller keys
  // adoption on IDENTITY (digest+artifactType), never on `payload.id`, so `existingId !== payload.
  // id` is true for EVERY subsequent ordinary resync of the same exporter entry after the first
  // adoption, not only the first time. Without this guard, a from-genesis resync or an ordinary
  // channel replay would re-adopt on every delivery — bumping `version`, rewriting `content_hash`
  // and appending a fresh audit event forever, the exact unbounded-growth shape this codebase has
  // already been burned by once (persist-on-change exists for Decisions for the same reason).
  // Already adopted from this same (or a newer) origin/revision: return unchanged.
  if (existing.originDomainId === input.originDomainId && existing.revision >= input.revision) {
    return toGraphObject(existing);
  }

  const existingProperties = existing.properties as Record<string, unknown>;
  const nextProperties: Record<string, unknown> = {
    ...input.incomingProperties,
    ...(typeof existingProperties.firstPromotedChangeId === "string"
      ? { firstPromotedChangeId: existingProperties.firstPromotedChangeId }
      : {})
  };
  const nextVersion = existing.version + 1;
  const afterHash = computeObjectContentHash({
    id: existing.id,
    orgId,
    domainId: existing.domainId,
    typeId: "artifact",
    name: existing.name,
    urn: existing.urn,
    properties: nextProperties,
    labels: existing.labels,
    version: nextVersion
  });

  const [row] = await tx
    .update(objects)
    .set({
      originDomainId: input.originDomainId,
      revision: input.revision,
      // Same as any signature-verified import: not an unverified hand-fill.
      provenance: null,
      properties: nextProperties,
      version: nextVersion,
      contentHash: afterHash,
      updatedAt: new Date()
    })
    .where(eq(objects.id, existing.id))
    .returning();
  if (!row) throw new Error("failed to adopt artifact identity");

  await appendAuditEvent(tx, {
    orgId,
    domainId: existing.domainId,
    actorId: input.actorObjectId,
    action: "artifact.update",
    subjectId: existing.id,
    beforeHash: existing.contentHash,
    afterHash,
    reason:
      `converged by adoption (ADR-0045 D2a): this domain's own import-minted artifact anchor now ` +
      `adopts origin domain '${input.originDomainId}' as the shared base's authority — id/urn unchanged`,
    requestId: input.requestId,
    // ADR-0045 D3 — an artifact is never domain-local.
    subjectDomainLocal: false
  });

  return toGraphObject(row);
}
