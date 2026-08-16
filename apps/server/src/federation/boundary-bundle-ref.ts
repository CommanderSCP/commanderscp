import { z } from "zod";
import { PromotionManifestSchema } from "@scp/schemas";

/**
 * M16.1 (I1) — THE PER-CHANGE JOIN between a change and the bundle transfers that carried it.
 *
 * ## Why this exists
 *
 * `bundle_transfers` (`schema.ts`, drizzle/0034) is a PER-HOP observational ledger: one row per
 * `.scpbundle` this instance produced or consumed, keyed on `(org, peer, direction, kind)` with a
 * `checksum` — and deliberately NO change/component column. The boundary segment needs the opposite
 * cut: "which transfers carried THIS change?".
 *
 * A **promotion** bundle is 1:1 with a change (`exportPromotionBundle` gathers exactly one change),
 * and the ledger row already records that bundle's `checksum`. Correlating by checksum is the same
 * join the inbox loop already relies on (`inbox-loop.integration.test.ts` matches a processed file
 * to its ledger row by checksum). So the join is made by STAMPING the bundle checksum onto the
 * change's existing JSONB `sourceRef` — no new column, no migration.
 *
 * ## Where the stamp is written
 *
 * - EXPORT (the promoting instance, `promotion-repo.ts::exportPromotionBundle` phase 4) — appends
 *   the checksum of the bundle it just produced. Several peers ⇒ several checksums, hence a list.
 * - IMPORT (the receiving instance, `promotion-repo.ts::applyPromotionImport`) — sets the list to
 *   exactly the checksum of the bundle the change arrived in (1:1 by construction).
 *
 * ## Why the exported payload is STRIPPED
 *
 * The bundle's `change.sourceRef` is snapshot BEFORE the export's own stamp is written, but a
 * RE-export of an already-exported change would otherwise carry the earlier hop's checksums into
 * the canonical bundle string and change the Ed25519 checksum of an otherwise identical bundle.
 * {@link withoutBoundaryBundleChecksums} removes the key from the exported payload so a bundle stays
 * byte-identical to what it would have been before this key existed, forever. The exporter's own
 * checksums are local observational bookkeeping and mean nothing on the far side anyway — the
 * receiver stamps the checksum IT observed.
 *
 * ## What this is NOT
 *
 * It is not authority. The journal's own sequence/hash chain is what makes replication safe; this
 * key is read-only decoration for the boundary segment: one instance's ledger rows are its own, so
 * no peer should ever build a segment out of another's stamp. Exactly how far that holds is stated
 * precisely on `changes-repo.ts::stampBoundaryBundleChecksum` — the export-side stamp is genuinely
 * un-journalled, the IMPORT-side one does ride the `change_status` payload, and the reason that
 * leak is harmless is a property of the `change_status` import path, not of this key.
 */

/** The `sourceRef` key holding the checksums of the promotion bundles that carried this change. */
export const BOUNDARY_BUNDLE_CHECKSUMS_KEY = "boundaryBundleChecksums";

/** The checksums stamped on a change's `sourceRef`, defensively read (the column is opaque JSONB —
 *  a malformed value yields `[]`, never a throw and never a fabricated entry). */
export function boundaryBundleChecksumsOf(sourceRef: unknown): string[] {
  if (!sourceRef || typeof sourceRef !== "object" || Array.isArray(sourceRef)) return [];
  const raw = (sourceRef as Record<string, unknown>)[BOUNDARY_BUNDLE_CHECKSUMS_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is string => typeof c === "string" && c.length > 0);
}

/** `sourceRef` with `checksum` APPENDED (deduped, order-preserving) — the export side. */
export function withBoundaryBundleChecksum(
  sourceRef: unknown,
  checksum: string
): Record<string, unknown> {
  const base =
    sourceRef && typeof sourceRef === "object" && !Array.isArray(sourceRef)
      ? { ...(sourceRef as Record<string, unknown>) }
      : {};
  const existing = boundaryBundleChecksumsOf(base);
  base[BOUNDARY_BUNDLE_CHECKSUMS_KEY] = existing.includes(checksum)
    ? existing
    : [...existing, checksum];
  return base;
}

/** `sourceRef` with the key REMOVED — used for the exported bundle payload only (see the header). */
export function withoutBoundaryBundleChecksums(
  sourceRef: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (!sourceRef) return sourceRef ?? null;
  if (!(BOUNDARY_BUNDLE_CHECKSUMS_KEY in sourceRef)) return sourceRef;
  const { [BOUNDARY_BUNDLE_CHECKSUMS_KEY]: _dropped, ...rest } = sourceRef;
  return rest;
}

// ---------------------------------------------------------------------------------------------
// §9.4 (pipeline-substrate-registry-scan.md) — WHAT THE COMMANDER SIGNED, persisted at export.
// ---------------------------------------------------------------------------------------------

/**
 * The `sourceRef` key holding one record PER EXPORT of this change: the peer it was addressed to,
 * when, the bundle checksum (the same value `boundaryBundleChecksums[]` carries — the join key
 * between the two lists), the SELF-BINDING promotion manifest the commander built, its detached
 * cosign signature, and the fingerprint of the instance key that signed it.
 *
 * WHY IT EXISTS. Before this key the exporter persisted NOTHING of what it signed: the manifest and
 * `manifestSignature` were created in `exportPromotionBundle` phase 3, placed in the returned bundle,
 * and forgotten; only the IMPORTER stored them (on the imported change). So the commander could say
 * "exported (checksum …)" and could not say "signed WHAT, for WHOM, with WHICH key" — the Build/Scan &
 * sign tiles' PM/sign facts had no source. Same lock, same UPDATE, same non-journalled bare write as
 * the checksum stamp (`changes-repo.ts::stampBoundaryBundleChecksum`).
 *
 * WHY THE EXPORTED PAYLOAD IS STRIPPED. Exactly the reason `withoutBoundaryBundleChecksums` exists:
 * a re-export must stay byte-identical, and one peer's signed manifest is local bookkeeping that
 * means nothing to another peer (which verifies the manifest it RECEIVES, as a sibling of the bundle).
 */
export const PROMOTION_EXPORTS_KEY = "promotionExports";

/** One stamped export record — the shape written by `withPromotionExport` and read back leniently
 *  by `promotionExportsOf`. `keyFingerprint` is nullable so a stamp written by an instance that did
 *  not record one still parses. */
export const PromotionExportStampSchema = z.object({
  peerDomainId: z.string(),
  exportedAt: z.string(),
  checksum: z.string(),
  manifest: PromotionManifestSchema,
  manifestSignature: z.string(),
  keyFingerprint: z.string().nullable()
});
export type PromotionExportStamp = z.infer<typeof PromotionExportStampSchema>;

/** The export records stamped on a change's `sourceRef`, defensively read: entries that do not
 *  parse are COUNTED (`unparseable`) rather than dropped silently or fabricated — the projection
 *  states the count in `unknownFields`. A MISSING key (`undefined`/`null`) is `[]` with
 *  `unparseable: 0`; a key that is PRESENT but not a list is one unreadable value (`unparseable: 1`)
 *  — the same honesty rule `artifact-facts.ts` applies to a malformed `sbom`: something is stored
 *  under the key, so its absence must not be claimed. */
export function promotionExportsOf(sourceRef: unknown): {
  entries: PromotionExportStamp[];
  unparseable: number;
} {
  if (!sourceRef || typeof sourceRef !== "object" || Array.isArray(sourceRef)) {
    return { entries: [], unparseable: 0 };
  }
  const raw = (sourceRef as Record<string, unknown>)[PROMOTION_EXPORTS_KEY];
  if (raw === undefined || raw === null) return { entries: [], unparseable: 0 };
  if (!Array.isArray(raw)) return { entries: [], unparseable: 1 };
  const entries: PromotionExportStamp[] = [];
  let unparseable = 0;
  for (const item of raw) {
    const parsed = PromotionExportStampSchema.safeParse(item);
    if (parsed.success) entries.push(parsed.data);
    else unparseable += 1;
  }
  return { entries, unparseable };
}

/** `sourceRef` with `record` APPENDED to `promotionExports[]` — the export side. Deduped on
 *  `checksum` (a re-run stamping the same bundle twice records one export, exactly as
 *  `withBoundaryBundleChecksum` dedupes the checksum itself), order-preserving. Pre-existing entries
 *  are carried VERBATIM, parseable or not — this function never rewrites what an earlier stamp wrote. */
export function withPromotionExport(
  sourceRef: unknown,
  record: PromotionExportStamp
): Record<string, unknown> {
  const base =
    sourceRef && typeof sourceRef === "object" && !Array.isArray(sourceRef)
      ? { ...(sourceRef as Record<string, unknown>) }
      : {};
  const raw = base[PROMOTION_EXPORTS_KEY];
  const existing: unknown[] = Array.isArray(raw) ? [...raw] : [];
  const alreadyStamped = existing.some(
    (e) =>
      !!e &&
      typeof e === "object" &&
      !Array.isArray(e) &&
      (e as Record<string, unknown>).checksum === record.checksum
  );
  base[PROMOTION_EXPORTS_KEY] = alreadyStamped ? existing : [...existing, record];
  return base;
}

// ---------------------------------------------------------------------------------------------
// THE SERVER-OWNED `sourceRef` KEYS — what a caller may NOT plant.
// ---------------------------------------------------------------------------------------------

/**
 * Both keys above are written by exactly one server-side writer (`changes-repo.ts::
 * stampBoundaryBundleChecksum`, and the promotion importer for its own received checksum), and the
 * component pipeline RENDERS them as facts — "exported (checksum …)", "manifest signed for <peer>
 * (key <fp>)". `proposeChange` stores a caller's `sourceRef` VERBATIM (DESIGN §8: the delivery
 * payload is kept as-is), so without this list an org proposer could plant a stamp through
 * `POST /changes` and the Scan & sign tile would claim a signing that never happened. The two
 * UNTRUSTED doors refuse/strip these keys; the engine's own callers (federation import — which
 * legitimately writes the import-side checksum — rollback, campaign fan-out) call `proposeChange`
 * directly and are not filtered.
 */
export const SERVER_OWNED_SOURCE_REF_KEYS: readonly string[] = [
  BOUNDARY_BUNDLE_CHECKSUMS_KEY,
  PROMOTION_EXPORTS_KEY
];

/** The server-owned keys PRESENT on a caller-supplied `sourceRef` (`[]` for a non-object). */
export function serverOwnedSourceRefKeysIn(sourceRef: unknown): string[] {
  if (!sourceRef || typeof sourceRef !== "object" || Array.isArray(sourceRef)) return [];
  return SERVER_OWNED_SOURCE_REF_KEYS.filter((key) => key in (sourceRef as Record<string, unknown>));
}

/** `sourceRef` with every server-owned key REMOVED (a new object; the input is not mutated). */
export function withoutServerOwnedSourceRefKeys(
  sourceRef: Record<string, unknown>
): Record<string, unknown> {
  if (serverOwnedSourceRefKeysIn(sourceRef).length === 0) return sourceRef;
  const rest = { ...sourceRef };
  for (const key of SERVER_OWNED_SOURCE_REF_KEYS) delete rest[key];
  return rest;
}

/** `sourceRef` with the key REMOVED — the exported bundle payload only (see the header above). */
export function withoutPromotionExports(
  sourceRef: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (!sourceRef) return sourceRef ?? null;
  if (!(PROMOTION_EXPORTS_KEY in sourceRef)) return sourceRef;
  const { [PROMOTION_EXPORTS_KEY]: _dropped, ...rest } = sourceRef;
  return rest;
}
