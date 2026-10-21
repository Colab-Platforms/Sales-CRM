// LeadImportBatch is shared by the normal lead CSV import and the abandoned-lead CSV import. The batch has no
// "kind" column, so abandoned batches carry this marker inside columnMapping (a JSON column) and each flow
// refuses the other's batches.
export const ABANDONED_IMPORT_MARKER = "__kind";
export const ABANDONED_IMPORT_KIND = "ABANDONED";

export function isAbandonedImportBatch(columnMapping: unknown): boolean {
  return Boolean(columnMapping && typeof columnMapping === "object" && (columnMapping as Record<string, unknown>)[ABANDONED_IMPORT_MARKER] === ABANDONED_IMPORT_KIND);
}
