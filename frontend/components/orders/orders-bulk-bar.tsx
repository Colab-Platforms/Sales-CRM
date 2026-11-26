"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/api-client/client";
import { ordersApi } from "@/lib/api-client/endpoints/orders.api";
import type { LiveExportInput, LiveOrderCount } from "@/lib/api-client/types/orders.types";
import { MAX_SELECTED_ORDERS, countText, waitForOrdersFile } from "./orders-bulk";

export type DownloadKind = "filtered" | "selected";

interface OrdersBulkBarProps {
  count: { data: LiveOrderCount | null; error: string | null; onRetry: () => void };
  /** True while typed search text has not reached the filters yet. */
  waiting: boolean;
  selectedCount: number;
  onClearSelection: () => void;
  downloading: { kind: DownloadKind; progress: string } | null;
  onDownload: (kind: DownloadKind) => void;
}

/** Above the table (Admin / Manager): how many orders match all filters, and the two downloads. */
export function OrdersBulkBar({ count, waiting, selectedCount, onClearSelection, downloading, onDownload }: OrdersBulkBarProps) {
  const nothingMatches = count.data?.status === "ready" && count.data.total === 0;
  const tooMany = selectedCount > MAX_SELECTED_ORDERS;
  const label = (kind: DownloadKind, idle: string) => (downloading?.kind === kind ? "Preparing…" : idle);
  return (
    <div className="space-y-1" data-testid="orders-bulk-bar">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span role="status" aria-live="polite" className="font-medium tabular-nums" data-testid="orders-count">
            {countText({ data: count.data, failed: Boolean(count.error), waiting })}
          </span>
          {count.error ? (
            <Button type="button" variant="ghost" size="sm" onClick={count.onRetry}>
              Retry
            </Button>
          ) : null}
          {selectedCount > 0 ? (
            <>
              <span className="text-muted-foreground" data-testid="orders-selected-count">
                {selectedCount.toLocaleString("en-IN")} selected
              </span>
              <Button type="button" variant="ghost" size="sm" onClick={onClearSelection}>
                Clear selection
              </Button>
            </>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" disabled={Boolean(downloading) || waiting || nothingMatches} onClick={() => onDownload("filtered")} data-testid="download-filtered">
            <Download data-icon="inline-start" />
            {label("filtered", "Download filtered orders")}
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={Boolean(downloading) || selectedCount === 0 || tooMany} onClick={() => onDownload("selected")} data-testid="download-selected">
            <Download data-icon="inline-start" />
            {label("selected", "Download selected orders")}
          </Button>
        </div>
      </div>
      {count.error ? <p role="alert" className="text-sm text-destructive">{count.error}</p> : null}
      {tooMany ? <p role="alert" className="text-sm text-destructive">Select at most {MAX_SELECTED_ORDERS.toLocaleString("en-IN")} orders, or use Download filtered orders.</p> : null}
      {downloading?.progress ? <p className="text-xs text-muted-foreground" data-testid="download-progress">Preparing the download: {downloading.progress}</p> : null}
    </div>
  );
}

/** Runs one download at a time: waits for the server to have the file, then hands it to the browser. */
export function useOrdersDownload() {
  const [downloading, setDownloading] = useState<{ kind: DownloadKind; progress: string } | null>(null);
  const left = useRef(false);
  const busy = useRef(false);
  useEffect(() => {
    left.current = false;
    return () => {
      left.current = true;
    };
  }, []);

  const download = async (kind: DownloadKind, input: LiveExportInput) => {
    if (busy.current) return;
    busy.current = true;
    setDownloading({ kind, progress: "" });
    try {
      const file = await waitForOrdersFile(() => ordersApi.exportLive(input), { onProgress: (progress) => setDownloading({ kind, progress }), cancelled: () => left.current });
      if (!file) return;
      const url = URL.createObjectURL(file.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.filename;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Downloaded ${file.rows.toLocaleString("en-IN")} ${file.rows === 1 ? "order" : "orders"} (${file.filename})`);
      if (file.missing > 0) toast.warning(`${file.missing.toLocaleString("en-IN")} selected ${file.missing === 1 ? "order was" : "orders were"} not found and ${file.missing === 1 ? "is" : "are"} not in the file.`);
    } catch (error) {
      toast.error(error instanceof Error && !("isAxiosError" in error) ? error.message : getErrorMessage(error, "The download failed."));
    } finally {
      busy.current = false;
      if (!left.current) setDownloading(null);
    }
  };

  return { downloading, download };
}
