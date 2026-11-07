"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileSpreadsheet, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { assignableTelecallersQueryOptions } from "@/lib/api-client/queries/abandonment.queries";
import { mySalespersonsQueryOptions } from "@/lib/api-client/queries/manager.queries";
import { STATUS_LABELS, STATUS_ORDER } from "@/lib/status";
import { useAuthStore } from "@/stores/auth-store";
import { ExportHistory, RangeControls, isActive, istDay, useExportActions, useExports, type ExportFilters } from "./export-shared";

/**
 * The filters sent with a date-range Excel export: the list's own search / column filters (when the box is ticked), then the panel's own choices, which win:
 * one salesperson and/or one lead status (New, Ringing, Interested, ...). Empty values are dropped.
 */
export function excelRequestFilters(listFilters: ExportFilters, applyList: boolean, salespersonId: string, workingStatus: string): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (applyList) for (const [k, v] of Object.entries(listFilters)) if (v !== undefined && v !== "") out[k] = v;
  if (salespersonId) out.salespersonId = salespersonId;
  if (workingStatus) out.workingStatus = workingStatus;
  return out;
}

/**
 * Admin / manager only. Downloads the abandoned-LEAD records (not the audio) as an Excel file for one day or a custom From - To range, optionally for one salesperson and/or one lead
 * status, built in the background. Independent of the recording ZIP below it: its own range, its own history and limits. Excel files started from the "Download Leads" button of the
 * selection toolbar appear in this history too.
 */
export function LeadExcelPanel({ filters = {} }: { filters?: ExportFilters }) {
  const role = useAuthStore((s) => s.user?.role);
  const direct = role === "ADMIN" || role === "HR";
  const [from, setFromRaw] = useState(istDay());
  const [to, setToRaw] = useState(istDay());
  const [applyFilters, setApplyFilters] = useState(true);
  const [salespersonId, setSalespersonId] = useState("");
  const [workingStatus, setWorkingStatus] = useState("");
  // Admin picks from every active telecaller, a manager from their own team.
  const managerTeam = useQuery({ ...mySalespersonsQueryOptions(), enabled: !direct && role === "MANAGER" });
  const allTelecallers = useQuery({ ...assignableTelecallersQueryOptions(), enabled: direct });
  const team = (direct ? allTelecallers.data : managerTeam.data) ?? [];
  const { exports } = useExports("EXCEL");
  const actions = useExportActions("EXCEL");
  const listFilterCount = Object.values(filters).filter((v) => v !== undefined && v !== "").length;
  const requestFilters = excelRequestFilters(filters, applyFilters, salespersonId, workingStatus);
  const rangeInvalid = !from || !to || from > to;
  // A running export of the very same range is shown instead of starting a second one.
  const running = exports.find((e) => e.selection === null && e.from === from && e.to === to && isActive(e));

  return (
    <div className="sketch-outline flex flex-wrap items-end gap-4 bg-card/60 p-4" data-testid="lead-excel-panel">
      <div className="space-y-1">
        <p className="text-sm font-medium">Download abandoned leads (Excel)</p>
        <p className="text-xs text-muted-foreground">Every lead detected in the date range, with customer, contact, items, value, status, call attempts and who it is assigned to. Narrow it to one salesperson or one lead status below. To export only some leads, tick them in the list and use Download Leads.</p>
      </div>
      <RangeControls from={from} to={to} idPrefix="lead-excel" onChange={(f, t) => { setFromRaw(f); setToRaw(t); actions.setError(null); }} />
      <div className="space-y-1">
        <Label htmlFor="lead-excel-salesperson" className="text-xs text-muted-foreground">Salesperson</Label>
        <NativeSelect id="lead-excel-salesperson" value={salespersonId} onChange={(e) => setSalespersonId(e.target.value)} className="w-52">
          <option value="">All salespeople</option>
          {team.map((sp) => (
            <option key={sp.id} value={sp.id}>{sp.name}</option>
          ))}
        </NativeSelect>
      </div>
      <div className="space-y-1">
        <Label htmlFor="lead-excel-status" className="text-xs text-muted-foreground">Lead status</Label>
        <NativeSelect id="lead-excel-status" value={workingStatus} onChange={(e) => setWorkingStatus(e.target.value)} className="w-44">
          <option value="">All statuses</option>
          {STATUS_ORDER.filter((status) => role !== "SALESPERSON" || status !== "ASSIGNED").map((status) => (
            <option key={status} value={status}>{STATUS_LABELS[status]}</option>
          ))}
        </NativeSelect>
      </div>
      <Button type="button" onClick={() => actions.start.mutate({ from, to, ...(Object.keys(requestFilters).length > 0 ? { filters: requestFilters } : {}) })} disabled={actions.start.isPending || rangeInvalid || Boolean(running)} data-testid="download-excel">
        {actions.start.isPending ? <Loader2 className="animate-spin" /> : <FileSpreadsheet />}
        {running ? "Excel in progress…" : "Download Excel"}
      </Button>
      {listFilterCount > 0 ? (
        <label className="flex w-full items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={applyFilters} onChange={(e) => setApplyFilters(e.target.checked)} />
          Apply the {listFilterCount} active list filter{listFilterCount === 1 ? "" : "s"} to this Excel file
        </label>
      ) : null}
      {rangeInvalid ? <p className="w-full text-sm text-destructive" role="alert">Choose a From date that is not after the To date.</p> : null}
      <div className="w-full">
        <ExportHistory kind="EXCEL" title="Recent lead exports" />
      </div>
    </div>
  );
}
