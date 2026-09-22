"use client";

import Link from "next/link";
import { toast } from "sonner";
import { Eye, Inbox } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { useUpdateLeadMutation } from "@/lib/api-client/mutations/lead.mutations";
import { STATUS_LABELS, STATUS_ORDER } from "@/lib/status";
import type { Lead, LeadListPagination } from "@/lib/api-client/types/lead.types";
import type { LeadWorkingStatus } from "@/lib/api-client/types/dashboard.types";
import type { Role } from "@/lib/api-client/types/auth.types";

// Exported so the Lead Details page can reuse the exact same status-change
// control (and its mutation) instead of a second implementation.
export function LeadStatusSelect({ lead }: { lead: Lead }) {
  const updateLead = useUpdateLeadMutation();

  return (
    <NativeSelect
      size="sm"
      aria-label={`Status for ${lead.firstName}`}
      value={lead.workingStatus}
      disabled={updateLead.isPending}
      wrapperClassName="w-40"
      onChange={(e) =>
        updateLead.mutate(
          { id: lead.id, payload: { workingStatus: e.target.value as LeadWorkingStatus } },
          { onSuccess: () => toast.success("Status updated.") },
        )
      }
    >
      {STATUS_ORDER.map((status) => (
        <option key={status} value={status}>
          {STATUS_LABELS[status]}
        </option>
      ))}
    </NativeSelect>
  );
}

export function leadDetailHref(id: string) {
  return `/dashboard/leads/${id}`;
}

interface LeadTableProps {
  leads: Lead[];
  isLoading: boolean;
  role: Role;
  selectedIds: Set<string>;
  onToggleOne: (id: string, checked: boolean) => void;
  onToggleAll: (checked: boolean) => void;
  pagination?: LeadListPagination;
  onPageChange: (page: number) => void;
}

export function LeadTable({
  leads,
  isLoading,
  role,
  selectedIds,
  onToggleOne,
  onToggleAll,
  pagination,
  onPageChange,
}: LeadTableProps) {
  const allSelected = leads.length > 0 && leads.every((lead) => selectedIds.has(lead.id));
  // checkbox, Lead, Mobile, Source, Product/Requirement, Status, Priority, [Manager], Salesperson, Created, Action
  const columnCount = role !== "SALESPERSON" ? 11 : 10;

  if (isLoading) {
    return (
      <div className="sketch-panel space-y-3 bg-card p-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="sketch-panel overflow-x-auto bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12 pl-4">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={(e) => onToggleAll(e.target.checked)}
                  aria-label="Select all leads"
                />
              </TableHead>
              <TableHead>Lead</TableHead>
              <TableHead>Mobile</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Product / Requirement</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Priority</TableHead>
              {role !== "SALESPERSON" ? <TableHead>Manager</TableHead> : null}
              <TableHead>Salesperson</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="text-right pr-4">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {leads.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={columnCount} className="py-14 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <Inbox className="size-8 text-muted-foreground/40" />
                    <p className="font-semibold">No leads found</p>
                    <p className="font-hand text-base text-muted-foreground">
                      Try clearing your filters, or add a lead.
                    </p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              leads.map((lead) => (
                <TableRow key={lead.id} data-state={selectedIds.has(lead.id) ? "selected" : undefined}>
                  <TableCell className="pl-4">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(lead.id)}
                      onChange={(e) => onToggleOne(lead.id, e.target.checked)}
                      aria-label={`Select ${lead.firstName}`}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="font-semibold">
                      {lead.firstName} {lead.lastName ?? ""}
                    </div>
                    <div className="font-mono text-xs text-muted-foreground">{lead.leadNumber}</div>
                  </TableCell>
                  <TableCell>
                    <div>{lead.mobile ?? "—"}</div>
                    {lead.email ? (
                      <div className="text-xs text-muted-foreground">{lead.email}</div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <div>{lead.source?.name ?? "—"}</div>
                    {lead.importBatch ? (
                      <div className="text-xs text-muted-foreground">
                        via {lead.importBatch.uploadedBy.name} ({lead.importBatch.uploadedBy.role})
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="max-w-48">
                    <span className="block truncate" title={lead.requirement ?? undefined}>
                      {lead.requirement ?? "—"}
                    </span>
                  </TableCell>
                  <TableCell>
                    {role === "SALESPERSON" ? (
                      <LeadStatusSelect lead={lead} />
                    ) : (
                      <StatusBadge status={lead.workingStatus} />
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{lead.priority}</TableCell>
                  {role !== "SALESPERSON" ? (
                    <TableCell>{lead.assignedManager?.name ?? "—"}</TableCell>
                  ) : null}
                  <TableCell>{lead.owner?.name ?? "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(lead.createdAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="pr-4 text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      render={<Link href={leadDetailHref(lead.id)} aria-label={`View ${lead.firstName}`} />}
                    >
                      <Eye />
                      View
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {pagination && pagination.totalPages > 1 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <span className="text-muted-foreground">
            Page <span className="font-semibold text-foreground">{pagination.page}</span> of{" "}
            {pagination.totalPages} · {pagination.total} leads
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={pagination.page <= 1}
              onClick={() => onPageChange(pagination.page - 1)}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={pagination.page >= pagination.totalPages}
              onClick={() => onPageChange(pagination.page + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
