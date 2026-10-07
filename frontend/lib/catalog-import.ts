import type { CatalogImportStatus } from "@/lib/api-client/types/products.types";

/** 0-100 for the progress bar. Unknown total (still counting) -> 0; finished -> 100. */
export function importPercent(job: Pick<CatalogImportStatus, "status" | "total" | "processed">): number {
  if (job.status === "completed") return 100;
  if (!(job.total > 0)) return 0;
  return Math.min(100, Math.floor((job.processed / job.total) * 100));
}

export const formatCount = (n: number): string => n.toLocaleString("en-IN");

/** "2,500 / 8,400 SKUs" */
export const progressLabel = (job: Pick<CatalogImportStatus, "total" | "processed">): string => `${formatCount(job.processed)} / ${formatCount(job.total)} SKUs`;

export const SUMMARY_ROWS = [
  ["total", "Total rows"],
  ["imported", "Imported"],
  ["updated", "Updated"],
  ["unchanged", "Unchanged"],
  ["skipped", "Skipped"],
  ["unmatched", "Unmatched"],
  ["errors", "Errors"],
] as const;
