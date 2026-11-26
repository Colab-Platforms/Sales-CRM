"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Download, FileSpreadsheet } from "lucide-react";
import { useAnalyzeImportFileMutation, useStartImportFileMutation, useUpdateImportMappingMutation } from "@/lib/api-client/mutations/lead.mutations";
import { useCreateSegmentMutation } from "@/lib/api-client/mutations/segment.mutations";
import { importProgressQueryOptions, leadKeys } from "@/lib/api-client/queries/lead.queries";
import { segmentsQueryOptions, segmentKeys } from "@/lib/api-client/queries/segment.queries";
import { leadApi } from "@/lib/api-client/endpoints/lead.api";
import { getErrorMessage } from "@/lib/api-client/client";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { SegmentTagPill } from "@/components/leads/lead-tags";
import type { FileImportAnalysis, FileImportPreview, FileImportProgress, ImportField, ImportTaggingSummary } from "@/lib/api-client/types/lead.types";
import { STATUS_LABELS } from "@/lib/status";
import type { Segment } from "@/lib/api-client/types/segment.types";

// Upload an Excel / CSV file -> columns are detected automatically -> choose or create the campaign segment -> preview -> import in the background with live progress -> results and a downloadable list of failed rows.

export const FIELD_LABELS: Record<ImportField, string> = {
  fullName: "Customer name",
  firstName: "First name",
  lastName: "Last name",
  mobile: "Phone number",
  email: "Email",
  orderCount: "Total orders",
  totalOrdersValue: "Total orders value",
  city: "City",
  state: "State",
  address: "Address",
  pincode: "Pincode",
  product: "Product",
  lastOrderDate: "Last order date",
  paymentInfo: "Payment info",
  requirement: "Requirement / notes",
  location: "Location",
  sourceName: "Source",
  extra: "Keep as extra data",
};
const FIELD_ORDER = Object.keys(FIELD_LABELS) as ImportField[];

const n = (v: number) => v.toLocaleString("en-IN");

const statusLabel = (status: string) => (STATUS_LABELS as Record<string, string>)[status] ?? status;

/** What the Tagging column does: the statuses it assigns, and how many values were recognised, blank or not recognised. */
export function TaggingBreakdown({ tagging, done = false }: { tagging: ImportTaggingSummary; done?: boolean }) {
  const counts: [string, number][] = [
    ["Recognised", tagging.recognized],
    ["Blank", tagging.blank],
    ["Not recognised", tagging.unrecognized],
  ];
  return (
    <div className="space-y-2 text-sm" data-testid="import-tagging">
      <p>
        Lead status from the <span className="font-semibold">{tagging.column}</span> column
      </p>
      <dl className="grid grid-cols-3 gap-x-4">
        {counts.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-2 border-b border-border/50 py-1">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-semibold tabular-nums">{n(value)}</dd>
          </div>
        ))}
      </dl>
      {tagging.statuses.length > 0 ? (
        <ul className="flex flex-wrap gap-2 text-xs" aria-label={done ? "Statuses assigned" : "Statuses that will be assigned"}>
          {tagging.statuses.map((s) => (
            <li key={s.status} className="rounded border border-border px-2 py-0.5">
              {statusLabel(s.status)}: <span className="font-semibold tabular-nums">{n(s.count)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {tagging.blank + tagging.unrecognized > 0 ? (
        <p className="text-xs text-muted-foreground">
          Blank and unrecognised rows {done ? "got" : "get"} the default status ({statusLabel("NEW")}).
        </p>
      ) : null}
      {tagging.unrecognizedValues.length > 0 ? (
        <p className="text-xs text-amber-700 dark:text-amber-400">Not recognised: {tagging.unrecognizedValues.map((v) => `"${v.value}" (${n(v.count)})`).join(", ")}</p>
      ) : null}
    </div>
  );
}

/** The preview numbers a user checks before confirming. */
export function PreviewSummary({ preview, segment }: { preview: FileImportPreview; segment: Segment | null }) {
  const rows: [string, number, string?][] = [
    ["Total records in file", preview.totalRows],
    ["Eligible for import", preview.eligibleRows],
    ["New leads that will be created (one per eligible row)", preview.newLeads],
    ["Invalid (cannot be imported)", preview.invalidRows],
    ["Missing phone number", preview.missingPhone],
    ["Missing order count", preview.missingOrderCount],
    ["Order count not a valid number", preview.invalidOrderCount],
  ];
  return (
    <div className="space-y-3" data-testid="import-preview">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Campaign segment:</span>
        {segment ? <SegmentTagPill segment={segment} /> : <span className="font-medium">None selected</span>}
      </div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-3 border-b border-border/50 py-1">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-semibold tabular-nums">{n(value)}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted-foreground">
        Customer type from order count: {n(preview.classification.repeat)} Repeat, {n(preview.classification.loyal)} Loyal, {n(preview.classification.vip)} VIP, {n(preview.classification.unclassified)} not classified.
      </p>
      {preview.tagging ? <TaggingBreakdown tagging={preview.tagging} /> : null}
      {preview.problems.length > 0 ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">First {preview.problems.length} invalid rows</summary>
          <ul className="mt-1 list-disc pl-5">
            {preview.problems.map((p) => (
              <li key={p.row}>
                Row {p.row}: {p.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/** Choose an existing active segment, or (Admin) create one right here. The chosen segment goes on every successfully imported customer of the file. */
export function SegmentPicker({ value, onChange, canCreate }: { value: string; onChange: (id: string) => void; canCreate: boolean }) {
  const { data: segments } = useQuery(segmentsQueryOptions());
  const create = useCreateSegmentMutation();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState("#6366f1");

  function submit() {
    create.mutate(
      { name, color },
      {
        onSuccess: (segment) => {
          toast.success(`Segment "${segment.name}" created.`);
          onChange(segment.id);
          setCreating(false);
          setName("");
        },
      },
    );
  }

  return (
    <div className="space-y-2" data-testid="select-segment">
      <Label htmlFor="import-segment">Select segment</Label>
      <NativeSelect id="import-segment" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">No segment</option>
        {(segments ?? []).map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </NativeSelect>
      {canCreate ? (
        creating ? (
          <div className="sketch-outline space-y-2 p-3">
            <Label htmlFor="new-segment-name" className="text-xs text-muted-foreground">
              New segment name
            </Label>
            <div className="flex gap-2">
              <Input id="new-segment-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Diwali Mega Sale" maxLength={100} />
              <input type="color" aria-label="Segment colour" value={color} onChange={(e) => setColor(e.target.value)} className="h-9 w-10 cursor-pointer rounded border bg-transparent p-0.5" />
            </div>
            {create.error ? <p className="text-sm text-destructive">{getErrorMessage(create.error, "Could not create the segment.")}</p> : null}
            <div className="flex gap-2">
              <Button type="button" size="sm" onClick={submit} disabled={!name.trim() || create.isPending}>
                {create.isPending ? "Creating..." : "Create segment"}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setCreating(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button type="button" size="sm" variant="outline" onClick={() => setCreating(true)}>
            + Create new segment
          </Button>
        )
      ) : null}
    </div>
  );
}

function ResultView({ progress, onDone }: { progress: FileImportProgress; onDone: () => void }) {
  const [downloading, setDownloading] = useState<string | null>(null);
  async function download(kind: "failed" | "duplicates") {
    setDownloading(kind);
    try {
      const blob = await leadApi.downloadImportReport(progress.batchId, kind);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `import-${kind}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not download the report."));
    } finally {
      setDownloading(null);
    }
  }
  const running = progress.status === "PROCESSING" || progress.status === "DRAFT";
  return (
    <div className="space-y-4" data-testid="import-result">
      <div>
        <div className="mb-1 flex justify-between text-sm">
          <span className="font-medium">{running ? "Importing…" : progress.status === "COMMITTED" ? "Import finished" : "Import stopped"}</span>
          <span className="tabular-nums">
            {n(progress.processedRows)} / {n(progress.totalRows)} ({progress.percent}%)
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={progress.percent} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full bg-primary transition-all" style={{ width: `${progress.percent}%` }} />
        </div>
        {running ? <p className="mt-1 text-xs text-muted-foreground">You can close this window; the import keeps running.</p> : null}
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
        {(
          [
            ["New leads created", progress.created],
            ["Segment tags added", progress.segmentMembershipsAdded],
            ["Failed records", progress.failed],
          ] as [string, number][]
        ).map(([label, value]) => (
          <div key={label} className="flex justify-between gap-3 border-b border-border/50 py-1">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-semibold tabular-nums">{n(value)}</dd>
          </div>
        ))}
      </dl>
      {progress.tagging ? <TaggingBreakdown tagging={progress.tagging} done /> : null}
      {progress.error ? <p className="text-sm text-destructive">{progress.error}</p> : null}
      <div className="flex flex-wrap gap-2">
        {progress.failed > 0 ? (
          <Button type="button" variant="outline" size="sm" onClick={() => download("failed")} disabled={downloading !== null}>
            <Download />
            Download failed records ({n(progress.failed)})
          </Button>
        ) : null}
        {progress.duplicates > 0 ? (
          <Button type="button" variant="outline" size="sm" onClick={() => download("duplicates")} disabled={downloading !== null}>
            <Download />
            Duplicate report
          </Button>
        ) : null}
      </div>
      <DialogFooter>
        <Button onClick={onDone}>{running ? "Close" : "Done"}</Button>
      </DialogFooter>
    </div>
  );
}

export function ImportLeadsDialog({
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
  const queryClient = useQueryClient();
  const analyze = useAnalyzeImportFileMutation();
  const updateMapping = useUpdateImportMappingMutation();
  const start = useStartImportFileMutation();
  const { data: segments } = useQuery({ ...segmentsQueryOptions(), enabled: open });
  const [analysis, setAnalysis] = useState<FileImportAnalysis | null>(null);
  const [mapping, setMapping] = useState<Record<string, ImportField>>({});
  const [preview, setPreview] = useState<FileImportPreview | null>(null);
  const [segmentId, setSegmentId] = useState("");
  const [batchId, setBatchId] = useState<string | null>(null);
  const { data: progress } = useQuery(importProgressQueryOptions(batchId ?? "", batchId !== null));

  function reset() {
    setAnalysis(null);
    setMapping({});
    setPreview(null);
    setSegmentId("");
    setBatchId(null);
  }

  function onFile(file: File | null) {
    if (!file) return;
    analyze.mutate(
      { file, segmentId: segmentId || undefined },
      {
        onSuccess: (result) => {
          setAnalysis(result);
          setMapping(result.mapping);
          setPreview(result.preview);
        },
      },
    );
  }

  function changeColumn(header: string, field: ImportField) {
    if (!analysis) return;
    setMapping((m) => ({ ...m, [header]: field }));
    updateMapping.mutate({ batchId: analysis.batchId, mapping: { [header]: field } }, { onSuccess: (r) => { setMapping(r.mapping); setPreview(r.preview); } });
  }

  function begin() {
    if (!analysis) return;
    start.mutate(
      { batchId: analysis.batchId, segmentId: segmentId || null },
      {
        onSuccess: () => {
          setBatchId(analysis.batchId);
          queryClient.invalidateQueries({ queryKey: segmentKeys.all });
        },
      },
    );
  }

  const chosen = (segments ?? []).find((s) => s.id === segmentId) ?? null;
  const review = new Set((analysis?.needsReview ?? []).map((c) => c.header));
  const unknown = new Set(analysis?.unrecognized ?? []);
  const hasContactColumn = Object.values(mapping).some((f) => f === "mobile" || f === "email");
  const finished = progress && (progress.status === "COMMITTED" || progress.status === "FAILED");

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // closing never cancels a running import; it only hides this window
        if (!next) {
          if (finished) queryClient.invalidateQueries({ queryKey: leadKeys.all });
          reset();
        }
        onOpenChange(next);
      }}
    >
      {open ? (
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Import customers from Excel or CSV</DialogTitle>
            <DialogDescription>
              {batchId ? "Your import runs in the background." : analysis ? `${analysis.fileName}: ${n(analysis.totalRows)} records` : "Upload a .xlsx or .csv file. Columns are detected automatically."}
              {isManager ? " Imported leads are assigned to you." : ""}
            </DialogDescription>
          </DialogHeader>

          {batchId ? (
            progress ? (
              <ResultView
                progress={progress}
                onDone={() => {
                  queryClient.invalidateQueries({ queryKey: leadKeys.all });
                  reset();
                  onDone();
                }}
              />
            ) : (
              <p className="text-sm text-muted-foreground">Starting…</p>
            )
          ) : !analysis ? (
            <div className="space-y-4">
              <SegmentPicker value={segmentId} onChange={setSegmentId} canCreate={!isManager} />
              <div className="space-y-1.5">
                <Label htmlFor="import-file">File</Label>
                <div className="sketch-outline flex items-center gap-3 p-4">
                  <FileSpreadsheet className="size-8 text-muted-foreground" />
                  <Input id="import-file" type="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={analyze.isPending} onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
                </div>
                <p className="text-xs text-muted-foreground">Old .xls files are not supported: save them as .xlsx or .csv first. Large files can take a minute to read.</p>
              </div>
              {analyze.isPending ? <p className="text-sm text-muted-foreground">Reading the file…</p> : null}
              {analyze.error ? <p className="text-sm text-destructive">{getErrorMessage(analyze.error, "Could not read the file.")}</p> : null}
            </div>
          ) : (
            <div className="space-y-5">
              <section className="space-y-2">
                <h3 className="text-sm font-bold">1. Detected columns {analysis.rememberedMapping ? <span className="font-normal text-muted-foreground">(mapping remembered from your last upload)</span> : null}</h3>
                <div className="sketch-outline max-h-56 overflow-y-auto">
                  <table className="w-full text-sm">
                    <tbody>
                      {analysis.columns.map((c) => {
                        const needs = review.has(c.header) || unknown.has(c.header);
                        return (
                          <tr key={c.header} className="border-b border-border/40 last:border-0">
                            <td className="px-3 py-1.5 font-medium">{c.header}</td>
                            <td className="px-3 py-1.5 text-xs text-muted-foreground">{c.samples.slice(0, 2).join(", ")}</td>
                            <td className="px-3 py-1.5">
                              {needs ? (
                                <NativeSelect aria-label={`Field for ${c.header}`} value={mapping[c.header] ?? "extra"} onChange={(e) => changeColumn(c.header, e.target.value as ImportField)}>
                                  {FIELD_ORDER.map((f) => (
                                    <option key={f} value={f}>
                                      {FIELD_LABELS[f]}
                                    </option>
                                  ))}
                                </NativeSelect>
                              ) : (
                                <span>{FIELD_LABELS[mapping[c.header] ?? "extra"]}</span>
                              )}
                              {preview?.tagging?.column === c.header ? <span className="ml-2 text-xs font-medium text-primary">sets the lead status</span> : null}
                              {review.has(c.header) ? <span className="ml-2 text-xs text-amber-700 dark:text-amber-400">another column is already the {FIELD_LABELS[(mapping[c.conflictWith ?? ""] ?? "extra") as ImportField].toLowerCase()}: choose</span> : null}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="text-xs text-muted-foreground">Only columns the CRM could not place need a choice. Nothing is dropped: unmatched columns are kept on the lead as extra data.</p>
                {!hasContactColumn ? <p className="text-sm text-destructive">Choose a phone number or email column to continue.</p> : null}
              </section>

              <section className="space-y-2">
                <h3 className="text-sm font-bold">2. Campaign segment</h3>
                <SegmentPicker value={segmentId} onChange={setSegmentId} canCreate={!isManager} />
              </section>

              <section className="space-y-2">
                <h3 className="text-sm font-bold">3. Preview</h3>
                {preview ? <PreviewSummary preview={preview} segment={chosen} /> : null}
              </section>

              {start.error ? <p className="text-sm text-destructive">{getErrorMessage(start.error, "Could not start the import.")}</p> : null}
              <DialogFooter>
                <Button variant="outline" onClick={() => reset()} disabled={start.isPending}>
                  Choose another file
                </Button>
                <Button onClick={begin} disabled={start.isPending || updateMapping.isPending || !hasContactColumn || !preview || preview.eligibleRows === 0}>
                  {start.isPending ? "Starting…" : `Import ${preview ? n(preview.eligibleRows) : ""} records`}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
