"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { reportAutomationApi } from "@/lib/api-client/endpoints/report-automation.api";
import { pickerErrorMessage, pickerKey, pickerRowState } from "./report-automation-form";

/** Admin dialog: pick one of the templates Meta reports as APPROVED and register it in the CRM. Selecting it for the report stays a separate step in the settings. */
export function ReportTemplatePicker({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const approved = useQuery({ queryKey: ["report-automation", "approved-templates"], queryFn: reportAutomationApi.approvedTemplates, retry: false, gcTime: 0, refetchOnWindowFocus: false });
  const add = useMutation({
    mutationFn: (t: { name: string; language: string }) => reportAutomationApi.addTemplate(t.name, t.language),
    retry: false,
    onMutate: () => setMessage(null),
    onSuccess: (r) => {
      setMessage({ ok: true, text: r.alreadyAdded ? `${r.name} (${r.language}) was already added.` : `${r.name} (${r.language}) added. Select it in the template dropdown and press Save.` });
      void queryClient.invalidateQueries({ queryKey: ["report-automation", "status"] });
      void approved.refetch();
    },
    onError: (e) => setMessage({ ok: false, text: pickerErrorMessage(e, "Could not add the template.") }),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="Add Template" data-testid="template-picker">
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col gap-3 rounded-lg border bg-background p-4 shadow-lg">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold">Add template - approved in Meta</h2>
          <Button type="button" size="sm" variant="outline" onClick={onClose} data-testid="picker-close">Close</Button>
        </div>
        {message ? <p role={message.ok ? "status" : "alert"} className={`text-sm ${message.ok ? "text-emerald-600" : "text-destructive"}`} data-testid="picker-message">{message.text}</p> : null}
        {approved.isFetching && !approved.data ? <p className="text-sm text-muted-foreground" data-testid="picker-loading">Loading approved templates from Meta…</p> : null}
        {approved.error ? (
          <div className="space-y-2" data-testid="picker-error">
            <p role="alert" className="text-sm text-destructive">{pickerErrorMessage(approved.error)}</p>
            <Button type="button" size="sm" onClick={() => void approved.refetch()} disabled={approved.isFetching} data-testid="picker-retry">{approved.isFetching ? "Retrying…" : "Retry"}</Button>
          </div>
        ) : null}
        {approved.data && approved.data.length === 0 ? <p className="text-sm text-muted-foreground">Meta reports no approved templates.</p> : null}
        {approved.data && approved.data.length > 0 ? (
          <div className="overflow-auto">
            <Table>
              <TableHeader><TableRow><TableHead>Template</TableHead><TableHead>Language</TableHead><TableHead>Category</TableHead><TableHead className="text-right"> </TableHead></TableRow></TableHeader>
              <TableBody>
                {approved.data.map((t) => {
                  const s = pickerRowState(t);
                  return (
                    <TableRow key={pickerKey(t)} data-testid={`picker-row-${t.name}-${t.language}`}>
                      <TableCell className="font-medium">{t.name}{s.note ? <p className="text-xs font-normal text-amber-600">{s.note}</p> : null}</TableCell>
                      <TableCell>{t.language}</TableCell>
                      <TableCell>{t.category ?? "-"}</TableCell>
                      <TableCell className="text-right">
                        {s.kind === "added" ? <span className="text-sm text-emerald-600" data-testid="already-added">Already added</span> : <Button type="button" size="sm" disabled={s.kind === "blocked" || add.isPending} onClick={() => add.mutate({ name: t.name, language: t.language })} data-testid={`add-${t.name}-${t.language}`}>{add.isPending && add.variables?.name === t.name && add.variables.language === t.language ? "Adding…" : "Add"}</Button>}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        ) : null}
      </div>
    </div>
  );
}
