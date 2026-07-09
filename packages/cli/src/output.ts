export type OutputFormat = "json" | "table";

function printTable(rows: Record<string, string>[]): void {
  if (rows.length === 0) {
    console.log("(no results)");
    return;
  }
  const columns = Object.keys(rows[0] ?? {});
  const widths = columns.map((col) =>
    Math.max(col.length, ...rows.map((row) => (row[col] ?? "").length))
  );

  const line = (values: string[]): string =>
    values.map((v, i) => v.padEnd(widths[i] ?? 0)).join("  ");

  console.log(line(columns.map((c) => c.toUpperCase())));
  for (const row of rows) {
    console.log(line(columns.map((c) => row[c] ?? "")));
  }
}

export function printResult(
  data: unknown,
  format: OutputFormat,
  toRow: (item: unknown) => Record<string, string>
): void {
  if (format === "json") {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  const rows = Array.isArray(data) ? data.map(toRow) : [toRow(data)];
  printTable(rows);
}
