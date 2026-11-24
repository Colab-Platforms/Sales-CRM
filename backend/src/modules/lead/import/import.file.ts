import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { listXlsxSheets, readXlsxRows } from "./import.xlsx.js";
import { detectColumns } from "./import.columns.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";

// READS A CUSTOMER FILE (.xlsx or .csv) one row at a time. An .xlsx is streamed from disk (never loaded whole), so a file of many tens of thousands of rows costs little memory. A legacy binary .xls is not supported by
// the spreadsheet library the CRM uses: the caller gets a clear message to save the file as .xlsx or .csv.

export const MAX_COLUMNS = 200;

export type RawRow = { rowNumber: number; values: string[] };

export function fileKind(originalName: string): "csv" | "xlsx" {
  const name = originalName.toLowerCase();
  if (name.endsWith(".csv")) return "csv";
  if (name.endsWith(".xlsx") || name.endsWith(".xlsm")) return "xlsx";
  if (name.endsWith(".xls")) throw new ApiError("Old Excel files (.xls) are not supported. Open the file in Excel and save it as .xlsx or .csv, then upload it again.", STATUS_CODES.BAD_REQUEST);
  throw new ApiError("Upload an Excel (.xlsx) or CSV (.csv) file.", STATUS_CODES.BAD_REQUEST);
}

/** One spreadsheet cell as text. Dates become ISO strings, numbers keep every digit (a phone number must not turn into 9.8765E9), formulas give their result. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  if (typeof value === "number") return Number.isInteger(value) ? value.toFixed(0) : String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "object") {
    const v = value as { text?: unknown; richText?: { text?: string }[]; result?: unknown; hyperlink?: string; error?: string };
    if (v.error) return "";
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text ?? "").join("").trim();
    if (v.result !== undefined) return cellText(v.result);
    if (v.text !== undefined) return cellText(v.text);
    if (v.hyperlink) return String(v.hyperlink);
    return "";
  }
  return String(value).trim();
}

export async function* readRows(filePath: string, originalName: string): AsyncGenerator<RawRow> {
  const kind = fileKind(originalName);
  if (kind === "csv") {
    let records: string[][];
    try {
      records = parse(readFileSync(filePath), { bom: true, skip_empty_lines: true, relax_column_count: true, delimiter: [",", ";", "\t"], trim: true });
    } catch {
      throw new ApiError("The CSV file could not be read. Check that it is a valid CSV file.", STATUS_CODES.BAD_REQUEST);
    }
    let n = 0;
    for (const values of records) {
      n += 1;
      if (values.every((v) => v === "")) continue;
      yield { rowNumber: n, values };
    }
    return;
  }

  try {
    // the worksheet that holds the customer table: the first whose header row has a phone or email column (a workbook often starts with a summary / cover sheet), else the first sheet
    const sheets = await listXlsxSheets(filePath);
    const usable = sheets.find((s) => Object.values(detectColumns(uniqueHeaders(s.header)).mapping).some((f) => f === "mobile" || f === "email"));
    for await (const row of readXlsxRows(filePath, (usable ?? sheets[0])?.index ?? 0)) {
      if (row.values.every((v) => v === "")) continue;
      yield row;
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("The Excel file could not be read. Check that it is a valid .xlsx file.", STATUS_CODES.BAD_REQUEST);
  }
}

/** Unique, non-empty header names: blank headers become "Column N", repeats become "Name (2)". */
export function uniqueHeaders(values: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return values.slice(0, MAX_COLUMNS).map((raw, i) => {
    const base = raw.trim() || `Column ${i + 1}`;
    const count = (seen.get(base.toLowerCase()) ?? 0) + 1;
    seen.set(base.toLowerCase(), count);
    return count === 1 ? base : `${base} (${count})`;
  });
}
