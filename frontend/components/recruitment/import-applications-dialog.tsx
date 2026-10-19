"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  useConfirmApplicationImportMutation,
  usePreviewApplicationImportMutation,
} from "@/lib/api-client/mutations/recruitment.mutations";
import { getErrorMessage } from "@/lib/api-client/client";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import type { ApplicationImportPreview, ImportField } from "@/lib/api-client/types/recruitment.types";

const FIELDS: { value: "" | ImportField; label: string }[] = [
  { value: "", label: "Keep as extra info" },
  { value: "name", label: "Name" },
  { value: "mobile", label: "Mobile" },
  { value: "email", label: "Email" },
  { value: "resumeUrl", label: "Resume link" },
];

// Pre-selects the obvious columns so a typical portal export needs no manual mapping.
function guessField(header: string): "" | ImportField {
  const h = header.toLowerCase().replace(/[^a-z]/g, "");
  if (/(fullname|candidatename|applicantname|^name$)/.test(h)) return "name";
  if (/(mobile|phone|contact|whatsapp)/.test(h)) return "mobile";
  if (/email/.test(h)) return "email";
  if (/(resume|cv)/.test(h)) return "resumeUrl";
  return "";
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// Excel files are converted to CSV in the browser (first sheet only), so the server keeps one import path.
async function excelToCsvFile(file: File): Promise<File> {
  const { readSheet } = await import("read-excel-file/browser");
  const rows = await readSheet(file);
  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\n");
  return new File([csv], file.name.replace(/\.xlsx$/i, ".csv"), { type: "text/csv" });
}

function parseHeaderRow(text: string): string[] {
  const firstLine = text.replace(/^﻿/, "").split(/\r?\n/)[0] ?? "";
  return firstLine.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
}

export function ImportApplicationsDialog({
  jobId,
  jobTitle,
  open,
  onOpenChange,
}: {
  jobId: string;
  jobTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const previewImport = usePreviewApplicationImportMutation(jobId);
  const confirmImport = useConfirmApplicationImportMutation();
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, "" | ImportField>>({});
  const [preview, setPreview] = useState<ApplicationImportPreview | null>(null);

  function reset() {
    setFile(null);
    setHeaders([]);
    setMapping({});
    setPreview(null);
    previewImport.reset();
    confirmImport.reset();
  }

  async function handleFileChange(selected: File | null) {
    setPreview(null);
    previewImport.reset();
    if (!selected) {
      setFile(null);
      setHeaders([]);
      return;
    }
    let csvFile = selected;
    if (/\.xlsx$/i.test(selected.name)) {
      try {
        csvFile = await excelToCsvFile(selected);
      } catch {
        toast.error("Could not read this Excel file. Check it is a valid .xlsx.");
        setFile(null);
        setHeaders([]);
        return;
      }
    }
    setFile(csvFile);
    const parsed = parseHeaderRow(await csvFile.text());
    setHeaders(parsed);
    setMapping(Object.fromEntries(parsed.map((h) => [h, guessField(h)])));
  }

  const mapped = Object.values(mapping);
  const missingRequired = !mapped.includes("name") || !mapped.includes("mobile");

  function handlePreview() {
    if (!file) return;
    const columnMapping = Object.fromEntries(Object.entries(mapping).filter(([, v]) => v)) as Record<string, ImportField>;
    previewImport.mutate({ file, columnMapping }, { onSuccess: setPreview });
  }

  function handleConfirm() {
    if (!preview) return;
    confirmImport.mutate(preview.batchId, {
      onSuccess: (result) => {
        toast.success(`${result.importedCount} application(s) imported.`);
        reset();
        onOpenChange(false);
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
            <DialogTitle>Import applications</DialogTitle>
            <DialogDescription>
              Upload the CSV or Excel (.xlsx) file of applicants for <span className="font-medium text-foreground">{jobTitle}</span>. Applicants already
              imported for this job (same mobile number) are skipped.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="application-csv">CSV or Excel file</Label>
              <Input
                id="application-csv"
                type="file"
                accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={(e) => handleFileChange(e.target.files?.[0] ?? null)}
              />
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
                        wrapperClassName="w-44 shrink-0"
                        aria-label={`Map column ${header}`}
                        value={mapping[header] ?? ""}
                        onChange={(e) => setMapping((prev) => ({ ...prev, [header]: e.target.value as "" | ImportField }))}
                      >
                        {FIELDS.map((f) => (
                          <option key={f.value} value={f.value}>
                            {f.label}
                          </option>
                        ))}
                      </NativeSelect>
                    </div>
                  ))}
                </div>
                {missingRequired ? <p className="text-xs text-muted-foreground">Map one column to Name and one to Mobile.</p> : null}
              </div>
            ) : null}

            {preview ? (
              <div className="space-y-3">
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
                  <ul className="max-h-28 space-y-0.5 overflow-y-auto text-xs text-muted-foreground">
                    {preview.sampleErrors.map((e) => (
                      <li key={`${e.row}-${e.reason}`}>
                        Row {e.row}: {e.reason}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            {previewImport.error ? (
              <p className="text-sm text-destructive">{getErrorMessage(previewImport.error, "Failed to preview import.")}</p>
            ) : null}
            {confirmImport.error ? (
              <p className="text-sm text-destructive">{getErrorMessage(confirmImport.error, "Failed to import applications.")}</p>
            ) : null}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            {preview ? (
              <Button onClick={handleConfirm} disabled={confirmImport.isPending || preview.validRows === 0}>
                {confirmImport.isPending ? "Importing..." : `Import ${preview.validRows} applications`}
              </Button>
            ) : (
              <Button onClick={handlePreview} disabled={!file || missingRequired || previewImport.isPending}>
                {previewImport.isPending ? "Previewing..." : "Preview"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
