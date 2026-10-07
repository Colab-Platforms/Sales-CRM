"use client";

import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { getErrorMessage } from "@/lib/api-client/client";
import { productsApi } from "@/lib/api-client/endpoints/products.api";
import { productsKeys } from "@/lib/api-client/queries/products.queries";
import type { CatalogImportStatus } from "@/lib/api-client/types/products.types";
import { SUMMARY_ROWS, formatCount, importPercent, progressLabel } from "@/lib/catalog-import";

/** The progress + summary of one import job. Pure presentation, so it can be rendered from a given job. */
export function CatalogImportProgress({ job, onDownloadFailed }: { job: CatalogImportStatus; onDownloadFailed?: () => void }) {
  const percent = importPercent(job);
  return (
    <div className="grid gap-3" data-testid="catalog-import-progress">
      <p className="text-sm">
        File: <span className="font-medium">{job.fileName}</span>
        {job.total > 0 ? ` — ${formatCount(job.total)} SKUs` : ""}
      </p>
      {job.status === "running" ? (
        <div className="grid gap-1.5">
          <p className="text-sm font-medium">Importing Shiprocket Catalog...</p>
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${percent}%` }} />
          </div>
          <p className="text-xs text-muted-foreground">
            {percent}% · {progressLabel(job)}
          </p>
        </div>
      ) : null}
      {job.status === "failed" ? (
        <p role="alert" className="text-sm text-destructive">
          Import failed: {job.error ?? "unknown error"}. It is safe to upload the file again.
        </p>
      ) : null}
      {job.status === "completed" ? <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">Import complete</p> : null}
      {job.status !== "running" ? (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4" data-testid="catalog-import-summary">
          {SUMMARY_ROWS.map(([key, label]) => (
            <div key={key} className="flex justify-between gap-2 border-b py-1">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="font-medium tabular-nums">{formatCount(job.summary[key])}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {job.status !== "running" && job.failedRowCount > 0 ? (
        <div className="grid gap-2" data-testid="catalog-import-failed">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium">
              {job.failedRowsTruncated ? `The first ${formatCount(job.failedRowCount)} rows that were not imported` : `${formatCount(job.failedRowCount)} rows were not imported`}
            </p>
            {onDownloadFailed ? (
              <Button type="button" size="sm" variant="outline" onClick={onDownloadFailed}>
                Download failed rows
              </Button>
            ) : null}
          </div>
          <ul className="max-h-48 overflow-y-auto rounded-md border text-xs">
            {job.failedRowsPreview.map((r) => (
              <li key={`${r.row}-${r.sku}`} className="flex gap-2 border-b px-2 py-1 last:border-b-0">
                <span className="w-12 shrink-0 text-muted-foreground">Row {r.row}</span>
                <span className="w-32 shrink-0 truncate font-mono">{r.sku ?? "—"}</span>
                <span className="w-20 shrink-0 capitalize">{r.status}</span>
                <span className="min-w-0 break-words text-muted-foreground">{r.reason}</span>
              </li>
            ))}
          </ul>
          {job.failedRowCount > job.failedRowsPreview.length ? (
            <p className="text-xs text-muted-foreground">Showing the first {job.failedRowsPreview.length}; download the report for all of them.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ADMIN / MANAGER: upload the Shiprocket catalog export. The server streams it in batches and reports progress; weights and dimensions are
// added to the products the CRM already has (matched by SKU) - nothing is created, renamed or re-identified, and re-uploading is safe.
export function CatalogImportPanel() {
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const status = useQuery({
    queryKey: ["catalog-import", jobId],
    queryFn: async () => {
      const next = await productsApi.catalogImportStatus(jobId!);
      // Weights/dimensions changed: refresh the product list once the import has finished.
      if (next.status !== "running") void queryClient.invalidateQueries({ queryKey: productsKeys.all });
      return next;
    },
    enabled: jobId !== null,
    refetchInterval: (q) => (q.state.data && q.state.data.status !== "running" ? false : 700),
    retry: false,
  });
  const job = status.data;
  const running = uploading || job?.status === "running";

  async function upload(file: File) {
    setUploading(true);
    setJobId(null);
    try {
      const started = await productsApi.startCatalogImport(file);
      setJobId(started.jobId);
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not start the import."));
    } finally {
      setUploading(false);
      if (input.current) input.current.value = "";
    }
  }

  async function downloadFailed() {
    if (!jobId) return;
    try {
      const blob = await productsApi.catalogImportFailedRows(jobId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "catalog-import-failed-rows.csv";
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not download the failed rows."));
    }
  }

  return (
    <Card>
      <CardContent className="grid gap-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Import Shiprocket Catalog</p>
            <p className="text-xs text-muted-foreground">
              Upload the Shiprocket product export (CSV). Weight and dimensions are added to the products you already have, matched by SKU. Any size of catalog is fine; importing the same file again changes nothing.
            </p>
          </div>
          <div>
            <input ref={input} type="file" accept=".csv,text/csv" className="hidden" aria-label="Shiprocket catalog CSV" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
            <Button type="button" disabled={running} onClick={() => input.current?.click()}>
              {running ? "Importing…" : "Import Shiprocket Catalog"}
            </Button>
          </div>
        </div>
        {status.error ? (
          <p role="alert" className="text-sm text-destructive">
            {getErrorMessage(status.error, "Could not read the import progress.")}
          </p>
        ) : null}
        {job ? <CatalogImportProgress job={job} onDownloadFailed={() => void downloadFailed()} /> : null}
      </CardContent>
    </Card>
  );
}
