export type OutputFormat = "json" | "table";

/** A row is whatever a mapper hands us. See docs/cli.md §133. */
export type OutputRow = Record<string, unknown>;

/** Render one table cell as text. Kept deliberately plain. See docs/cli.md §134. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "bigint":
    case "boolean":
      return String(value);
    case "object":
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    default:
      return String(value);
  }
}

/** Exported for the unit test; `printResult` is the public door. Returns the lines it printed. */
export function tableLines(rows: OutputRow[]): string[] {
  if (rows.length === 0) return ["(no results)"];
  const columns = Object.keys(rows[0] ?? {});
  const cells = rows.map((row) => columns.map((col) => cellText(row[col])));
  const widths = columns.map((col, i) =>
    Math.max(col.length, ...cells.map((row) => (row[i] ?? "").length))
  );
  const line = (values: string[]): string =>
    values.map((v, i) => v.padEnd(widths[i] ?? 0)).join("  ");
  return [line(columns.map((c) => c.toUpperCase())), ...cells.map((row) => line(row))];
}

function printTable(rows: OutputRow[]): void {
  for (const l of tableLines(rows)) console.log(l);
}

export function printResult(
  data: unknown,
  format: OutputFormat,
  toRow: (item: unknown) => OutputRow
): void {
  if (format === "json") {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  const rows = Array.isArray(data) ? data.map(toRow) : [toRow(data)];
  printTable(rows);
}
