import { z } from "zod";
import { PromotionManifestSchema } from "@scp/schemas";

/** The per-change join between a change and its transfers. See docs/federation.md §49. */

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

// §9.4 (pipeline-substrate-registry-scan.md) — WHAT THE COMMANDER SIGNED, persisted at export.

/** The key holding one record per export of this change. See docs/federation.md §50. */
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

/** The export records on a change, read defensively. See docs/federation.md §51. */
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

// THE SERVER-OWNED `sourceRef` KEYS — what a caller may NOT plant.

/** Both keys above have exactly one server-side writer. See docs/federation.md §52. */
export const SERVER_OWNED_SOURCE_REF_KEYS: readonly string[] = [
  BOUNDARY_BUNDLE_CHECKSUMS_KEY,
  PROMOTION_EXPORTS_KEY
];

/** The server-owned keys PRESENT on a caller-supplied `sourceRef` (`[]` for a non-object). */
export function serverOwnedSourceRefKeysIn(sourceRef: unknown): string[] {
  if (!sourceRef || typeof sourceRef !== "object" || Array.isArray(sourceRef)) return [];
  return SERVER_OWNED_SOURCE_REF_KEYS.filter(
    (key) => key in (sourceRef as Record<string, unknown>)
  );
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
