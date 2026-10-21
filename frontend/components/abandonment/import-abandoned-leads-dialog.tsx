"use client";

import { useState } from "react";
import { toast } from "sonner";
import { usePreviewAbandonmentImportMutation, useConfirmAbandonmentImportMutation } from "@/lib/api-client/mutations/abandonment.mutations";
import { getErrorMessage } from "@/lib/api-client/client";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import type { ImportPreviewResult } from "@/lib/api-client/types/lead.types";

const CRM_FIELDS = [
  { value: "", label: "Ignore" },
  { value: "firstName", label: "First Name" },
  { value: "lastName", label: "Last Name" },
  { value: "mobile", label: "Mobile" },
  { value: "email", label: "Email" },
  { value: "location", label: "Location" },
  { value: "cartValue", label: "Cart Value" },
  { value: "items", label: "Items (separate with |)" },
  { value: "checkoutUrl", label: "Checkout Link" },
  { value: "abandonedAt", label: "Abandoned At" },
];

// Header text that obviously names a field, so a file exported with ordinary column names arrives pre-mapped.
const HEADER_GUESSES: Record<string, string> = {
  firstname: "firstName",
  first_name: "firstName",
  name: "firstName",
  lastname: "lastName",
  last_name: "lastName",
  mobile: "mobile",
  phone: "mobile",
  phone_number: "mobile",
  email: "email",
  location: "location",
  city: "location",
  cartvalue: "cartValue",
  cart_value: "cartValue",
  total_price: "cartValue",
  items: "items",
  products: "items",
  checkouturl: "checkoutUrl",
  checkout_url: "checkoutUrl",
  abandonedat: "abandonedAt",
  abandoned_at: "abandonedAt",
  created_at: "abandonedAt",
};

function parseHeaderRow(text: string): string[] {
  const firstLine = text.split(/\r?\n/)[0] ?? "";
  return firstLine.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
}

function guessMapping(headers: string[]): Record<string, string> {
  const used = new Set<string>();
  const mapping: Record<string, string> = {};
  for (const header of headers) {
    const field = HEADER_GUESSES[header.toLowerCase().replace(/[\s-]+/g, "_")];
    if (field && !used.has(field)) {
      mapping[header] = field;
      used.add(field);
    }
  }
  return mapping;
}

export function ImportAbandonedLeadsDialog({
  open,
  onOpenChange,
  onDone,
  isManager,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
  isManager?: boolean;
}) {
  const previewImport = usePreviewAbandonmentImportMutation();
  const confirmImport = useConfirmAbandonmentImportMutation();
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<ImportPreviewResult | null>(null);

  function reset() {
    setFile(null);
    setHeaders([]);
    setMapping({});
    setPreview(null);
    previewImport.reset();
    confirmImport.reset();
  }

  async function handleFileChange(selected: File | null) {
    setFile(selected);
    setPreview(null);
    if (!selected) {
      setHeaders([]);
      setMapping({});
      return;
    }
    const parsedHeaders = parseHeaderRow(await selected.text());
    setHeaders(parsedHeaders);
    setMapping(guessMapping(parsedHeaders));
  }

  function handlePreview() {
    if (!file) return;
    const columnMapping = Object.fromEntries(Object.entries(mapping).filter(([, value]) => value));
    previewImport.mutate({ file, columnMapping }, { onSuccess: setPreview });
  }

  function handleConfirm() {
    if (!preview) return;
    confirmImport.mutate(preview.batchId, {
      onSuccess: (result) => {
        if (result.failedCount > 0) {
          toast.warning(`${result.createdCount} abandoned lead(s) imported, ${result.failedCount} row(s) failed.`);
        } else {
          toast.success(`${result.createdCount} abandoned lead(s) imported.`);
        }
        reset();
        onDone();
      },
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      {open ? (
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>Import Abandoned Leads from CSV</DialogTitle>
            <DialogDescription>Upload a CSV file, map its columns, then review before importing. Up to 500 rows per file.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <p className="sketch-outline p-3 text-xs text-muted-foreground">
              Each row needs a first name and a mobile or email. People who already exist as leads are matched, not duplicated;
              people who already have an open abandoned checkout are skipped. New ones follow your auto-assign settings.
              {isManager ? " Uploaded leads are assigned to you." : ""}
            </p>
            <div className="space-y-1.5">
              <Label>CSV file</Label>
              <Input type="file" accept=".csv,text/csv" onChange={(e) => handleFileChange(e.target.files?.[0] ?? null)} />
            </div>

            {headers.length > 0 && !preview ? (
              <div className="space-y-2">
                <Label>Column mapping</Label>
                <div className="sketch-outline max-h-56 space-y-2 overflow-y-auto p-3">
                  {headers.map((header) => (
                    <div key={header} className="flex items-center justify-between gap-3">
                      <span className="min-w-0 truncate font-mono text-sm">{header}</span>
                      <NativeSelect
                        size="sm"
                        wrapperClassName="w-52 shrink-0"
                        aria-label={`Map column ${header}`}
                        value={mapping[header] ?? ""}
                        onChange={(e) => setMapping((prev) => ({ ...prev, [header]: e.target.value }))}
                      >
                        {CRM_FIELDS.map((f) => (
                          <option key={f.value} value={f.value}>
                            {f.label}
                          </option>
                        ))}
                      </NativeSelect>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {preview ? (
              <>
                <div className="sketch-outline grid grid-cols-3 gap-3 p-4 text-sm">
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-muted-foreground">Total rows</div>
                    <div className="text-xl font-extrabold tabular-nums">{preview.totalRows}</div>
                  </div>
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-muted-foreground">Valid</div>
                    <div className="text-xl font-extrabold tabular-nums text-emerald-700 dark:text-emerald-300">{preview.validRows}</div>
                  </div>
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-muted-foreground">Duplicate / Invalid</div>
                    <div className="text-xl font-extrabold tabular-nums text-amber-700 dark:text-amber-300">
                      {preview.duplicateRows} / {preview.invalidRows}
                    </div>
                  </div>
                </div>
                {preview.sampleErrors.length > 0 ? (
                  <ul className="sketch-outline max-h-32 space-y-1 overflow-y-auto p-3 text-xs text-muted-foreground">
                    {preview.sampleErrors.map((e) => (
                      <li key={`${e.row}-${e.reason}`}>
                        Row {e.row}: {e.reason}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            ) : null}

            {previewImport.error ? (
              <p className="text-sm text-destructive">{getErrorMessage(previewImport.error, "Failed to preview import.")}</p>
            ) : null}
            {confirmImport.error ? (
              <p className="text-sm text-destructive">{getErrorMessage(confirmImport.error, "Failed to import abandoned leads.")}</p>
            ) : null}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            {preview ? (
              <Button onClick={handleConfirm} disabled={confirmImport.isPending || preview.validRows === 0}>
                {confirmImport.isPending ? "Importing..." : `Import ${preview.validRows} Abandoned Leads`}
              </Button>
            ) : (
              <Button onClick={handlePreview} disabled={!file || previewImport.isPending}>
                {previewImport.isPending ? "Previewing..." : "Preview"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
