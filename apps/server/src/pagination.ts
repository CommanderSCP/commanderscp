/**
 * Cursor-based pagination codec shared by every list endpoint (DESIGN.md §6: stable ordering by
 * `(created_at, id)`). Originally lived in `services/objects-service.ts` (M0); factored out here
 * once the generic graph endpoints, type registry, relationships, and audit log all needed the
 * identical codec.
 */
export function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id })
  ).toString("base64url");
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "createdAt" in parsed &&
      "id" in parsed &&
      typeof (parsed as Record<string, unknown>).createdAt === "string" &&
      typeof (parsed as Record<string, unknown>).id === "string"
    ) {
      const p = parsed as { createdAt: string; id: string };
      return { createdAt: new Date(p.createdAt), id: p.id };
    }
    return null;
  } catch {
    return null;
  }
}
