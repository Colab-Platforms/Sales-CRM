"use client";

import { useState } from "react";
import { toast } from "sonner";
import { usePreviewImportMutation, useConfirmImportMutation } from "@/lib/api-client/mutations/lead.mutations";
import { getErrorMessage } from "@/lib/api-client/client";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import type { ImportPreviewResult } from "@/lib/api-client/types/lead.types";

const CRM_FIELDS = [
  { value: "", label: "Ignore" },
  { value: "firstName", label: "First Name" },
  { value: "lastName", label: "Last Name" },
  { value: "mobile", label: "Mobile" },
  { value: "email", label: "Email" },
  { value: "requirement", label: "Requirement" },
  { value: "location", label: "Location" },
  { value: "sourceName", label: "Source" },
];

function parseHeaderRow(text: string): string[] {
  const firstLine = text.split(/\r?\n/)[0] ?? "";
  return firstLine.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
}

export function ImportLeadsDialog({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const previewImport = usePreviewImportMutation();
  const confirmImport = useConfirmImportMutation();
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<ImportPreviewResult | null>(null);

  function reset() {
    setFile(null);
    setHeaders([]);
    setMapping({});
    setPreview(null);
  }

  async function handleFileChange(selected: File | null) {
    setFile(selected);
    setPreview(null);
    if (!selected) {
      setHeaders([]);
      return;
    }
    const text = await selected.text();
    setHeaders(parseHeaderRow(text));
    setMapping({});
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
        toast.success(`${result.createdCount} lead(s) imported.`);
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
            <DialogTitle>Import Leads from CSV</DialogTitle>
            <DialogDescription>Upload a CSV file, map its columns, then review before importing.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>CSV file</Label>
              <Input type="file" accept=".csv,text/csv" onChange={(e) => handleFileChange(e.target.files?.[0] ?? null)} />
            </div>

            {headers.length > 0 && !preview ? (
              <div className="space-y-2">
                <Label>Column mapping</Label>
                <div className="max-h-56 space-y-2 overflow-y-auto rounded-md border p-3">
                  {headers.map((header) => (
                    <div key={header} className="flex items-center justify-between gap-3">
                      <span className="text-sm">{header}</span>
                      <select
                        value={mapping[header] ?? ""}
                        onChange={(e) => setMapping((prev) => ({ ...prev, [header]: e.target.value }))}
                        className="border-input h-8 rounded-md border bg-transparent px-2 text-sm shadow-xs"
                      >
                        {CRM_FIELDS.map((f) => (
                          <option key={f.value} value={f.value}>
                            {f.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {preview ? (
              <div className="grid grid-cols-3 gap-3 rounded-lg border p-3 text-sm">
                <div>
                  <div className="text-muted-foreground">Total rows</div>
                  <div className="font-medium">{preview.totalRows}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">Valid</div>
                  <div className="font-medium text-emerald-600">{preview.validRows}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">Duplicate / Invalid</div>
                  <div className="font-medium text-amber-600">
                    {preview.duplicateRows} / {preview.invalidRows}
                  </div>
                </div>
              </div>
            ) : null}

            {previewImport.error ? (
              <p className="text-sm text-destructive">{getErrorMessage(previewImport.error, "Failed to preview import.")}</p>
            ) : null}
            {confirmImport.error ? (
              <p className="text-sm text-destructive">{getErrorMessage(confirmImport.error, "Failed to import leads.")}</p>
            ) : null}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            {preview ? (
              <Button onClick={handleConfirm} disabled={confirmImport.isPending || preview.validRows === 0}>
                {confirmImport.isPending ? "Importing..." : `Import ${preview.validRows} Leads`}
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
