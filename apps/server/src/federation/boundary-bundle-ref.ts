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
 * key is read-only decoration for the boundary segment (and is deliberately NOT journalled — a
 * replica of a change sees no stamp, which is correct: this instance's ledger rows are its own).
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
