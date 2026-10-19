import { parse } from "csv-parse/sync";

export function parseCsv(text: string): Record<string, string>[] {
  const records = parse(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
    bom: true,
  }) as Record<string, string>[];
  return records;
}

export function detectHeaders(text: string): string[] {
  const rows = parseCsv(text);
  if (!rows.length) {
    // still try header-only
    const firstLine = text.split(/\r?\n/).find((l) => l.trim());
    return firstLine ? firstLine.split(",").map((h) => h.trim().replace(/^"|"$/g, "")) : [];
  }
  return Object.keys(rows[0]);
}
