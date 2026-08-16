export type OutputFormat = "json" | "table";

/** A row is whatever a mapper hands us — API objects arrive with numbers, booleans, nulls and
 *  nested objects, not just strings — so the TABLE printer owns the string coercion, not 100+
 *  callers. (Before this, `printTable` typed rows as `Record<string, string>` and every caller that
 *  passed an API object straight through lied about it with a cast; the first numeric field —
 *  `scp federation import`'s `appliedEntries` — crashed the printer with `v.padEnd is not a
 *  function` AFTER the import had already applied.) */
export type OutputRow = Record<string, unknown>;

/**
 * Render one table cell as text. Kept deliberately plain:
 *  - string → as is
 *  - number / bigint / boolean → their canonical text (`0` and `false` are VALUES, not absences)
 *  - null / undefined → blank (the printer's long-standing convention for an absent field; row
 *    mappers that want `—` or `?` say so themselves — see cli-absent-formatters.test.ts)
 *  - object / array → compact JSON, so a nested field never prints as `[object Object]`
 */
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
