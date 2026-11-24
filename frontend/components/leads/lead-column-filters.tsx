"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { TableCell, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { sourcesQueryOptions } from "@/lib/api-client/queries/source.queries";
import { managersQueryOptions, adminSalespersonsQueryOptions } from "@/lib/api-client/queries/admin.queries";
import { mySalespersonsQueryOptions } from "@/lib/api-client/queries/manager.queries";
import { STATUS_LABELS, STATUS_ORDER } from "@/lib/status";
import { hasActiveFilters } from "@/lib/lead-filter";
import type { LeadListParams } from "@/lib/api-client/types/lead.types";
import type { LeadWorkingStatus } from "@/lib/api-client/types/dashboard.types";
import type { Role } from "@/lib/api-client/types/auth.types";

export type ColumnFilterState = Omit<LeadListParams, "page" | "limit">;

const CELL = "h-8 w-full min-w-0 rounded-md border bg-background px-2 text-xs";
const PRIORITIES = ["LOW", "MEDIUM", "HIGH"] as const;
const NONE = "NONE";

/** A text box that waits for a pause in typing before it filters, so every keystroke is not a request. */
function DebouncedText({ value, onCommit, placeholder, label }: { value: string; onCommit: (v: string) => void; placeholder: string; label: string }) {
  const [text, setText] = useState(value);
  const [timer, setTimer] = useState<ReturnType<typeof setTimeout> | null>(null);
  return (
    <input
      type="search"
      className={CELL}
      aria-label={label}
      placeholder={placeholder}
      value={text}
      onChange={(e) => {
        const v = e.target.value;
        setText(v);
        if (timer) clearTimeout(timer);
        setTimer(setTimeout(() => onCommit(v.trim()), 350));
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          if (timer) clearTimeout(timer);
          onCommit(text.trim());
        }
      }}
    />
  );
}

/**
 * The filter row of the Leads table: one control under each column header (Actions has none). Every control is a server-side filter, all of them combine, and the page returns to page 1 whenever one changes
 * (that is done by the page's onChange). The "Created" column is a start and an end date (inclusive, India time).
 */
export function LeadColumnFilters({ value, onChange, role, resetKey, onClearAll }: { value: ColumnFilterState; onChange: (next: ColumnFilterState) => void; role: Role; resetKey: number; onClearAll: () => void }) {
  const isAdmin = role === "ADMIN";
  const isSalesperson = role === "SALESPERSON";
  const sources = useQuery(sourcesQueryOptions());
  const managers = useQuery({ ...managersQueryOptions(), enabled: isAdmin });
  const adminSales = useQuery({ ...adminSalespersonsQueryOptions(), enabled: isAdmin });
  const mySales = useQuery({ ...mySalespersonsQueryOptions(), enabled: role === "MANAGER" });
  const set = (patch: Partial<ColumnFilterState>) => onChange({ ...value, ...patch });
  const empty = (v: string) => (v === "" ? undefined : v);

  const salespeople: { id: string; name: string }[] = isAdmin ? (adminSales.data ?? []).filter((s) => s.status === "ACTIVE").map((s) => ({ id: s.id, name: s.name })) : (mySales.data ?? []).map((s) => ({ id: s.id, name: s.name }));

  return (
    <TableRow className="bg-muted/30 hover:bg-muted/30" data-testid="lead-column-filters" key={resetKey}>
      <TableCell className="pl-4" />
      <TableCell className="min-w-40">
        <DebouncedText key={`n${resetKey}`} label="Filter by lead name" placeholder="Name" value={value.name ?? ""} onCommit={(v) => set({ name: empty(v) })} />
      </TableCell>
      <TableCell className="min-w-40">
        <DebouncedText key={`c${resetKey}`} label="Filter by phone or email" placeholder="Phone / email" value={value.contact ?? ""} onCommit={(v) => set({ contact: empty(v) })} />
      </TableCell>
      <TableCell className="min-w-32">
        <select className={CELL} aria-label="Filter by source" value={value.sourceId ?? ""} onChange={(e) => set({ sourceId: empty(e.target.value) })}>
          <option value="">All sources</option>
          {(sources.data ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </TableCell>
      <TableCell className="min-w-32">
        <select className={CELL} aria-label="Filter by status" value={value.workingStatus ?? ""} onChange={(e) => set({ workingStatus: (empty(e.target.value) as LeadWorkingStatus | undefined) })}>
          <option value="">All statuses</option>
          {STATUS_ORDER.filter((s) => !isSalesperson || s !== "ASSIGNED").map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </TableCell>
      <TableCell className="min-w-28">
        <select className={CELL} aria-label="Filter by priority" value={value.priority ?? ""} onChange={(e) => set({ priority: empty(e.target.value) as ColumnFilterState["priority"] })}>
          <option value="">All</option>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p.charAt(0) + p.slice(1).toLowerCase()}
            </option>
          ))}
        </select>
      </TableCell>
      {role !== "SALESPERSON" ? (
        <TableCell className="min-w-36">
          {isAdmin ? (
            <select className={CELL} aria-label="Filter by manager" value={value.managerId ?? ""} onChange={(e) => set({ managerId: empty(e.target.value) })}>
              <option value="">All managers</option>
              <option value={NONE}>Unassigned</option>
              {(managers.data ?? []).filter((m) => m.status === "ACTIVE").map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          ) : null}
        </TableCell>
      ) : null}
      <TableCell className="min-w-36">
        {isSalesperson ? null : (
          <select className={CELL} aria-label="Filter by salesperson" value={value.salespersonId ?? ""} onChange={(e) => set({ salespersonId: empty(e.target.value) })}>
            <option value="">All salespeople</option>
            <option value={NONE}>Unassigned</option>
            {salespeople.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
      </TableCell>
      <TableCell className="min-w-44">
        <div className="flex items-center gap-1">
          <input type="date" className={CELL} aria-label="Created from" title="Created from" value={value.createdFrom ?? ""} max={value.createdTo || undefined} onChange={(e) => set({ createdFrom: empty(e.target.value) })} />
          <span className="text-xs text-muted-foreground">–</span>
          <input type="date" className={CELL} aria-label="Created to" title="Created to" value={value.createdTo ?? ""} min={value.createdFrom || undefined} onChange={(e) => set({ createdTo: empty(e.target.value) })} />
        </div>
      </TableCell>
      <TableCell className="pr-4 text-right">
        {hasActiveFilters(value) ? (
          <Button type="button" size="sm" variant="ghost" onClick={onClearAll} data-testid="clear-column-filters">
            <X />
            Clear Filters
          </Button>
        ) : null}
      </TableCell>
    </TableRow>
  );
}
