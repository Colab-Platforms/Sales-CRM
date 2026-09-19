"use client";

import { toast } from "sonner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { useUpdateLeadMutation } from "@/lib/api-client/mutations/lead.mutations";
import type { Lead, LeadListPagination } from "@/lib/api-client/types/lead.types";
import type { LeadWorkingStatus } from "@/lib/api-client/types/dashboard.types";
import type { Role } from "@/lib/api-client/types/auth.types";

const STATUS_OPTIONS: LeadWorkingStatus[] = [
  "NEW",
  "ASSIGNED",
  "WORKING",
  "INTERESTED",
  "EXPIRED",
  "CONVERTED",
  "CLOSED",
];

function LeadStatusSelect({ lead }: { lead: Lead }) {
  const updateLead = useUpdateLeadMutation();

  return (
    <select
      value={lead.workingStatus}
      disabled={updateLead.isPending}
      onChange={(e) =>
        updateLead.mutate(
          { id: lead.id, payload: { workingStatus: e.target.value as LeadWorkingStatus } },
          { onSuccess: () => toast.success("Status updated.") },
        )
      }
      className="border-input h-8 rounded-md border bg-transparent px-2 text-xs"
    >
      {STATUS_OPTIONS.map((status) => (
        <option key={status} value={status}>
          {status}
        </option>
      ))}
    </select>
  );
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
  const columnCount = role !== "SALESPERSON" ? 9 : 8;

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={(e) => onToggleAll(e.target.checked)}
                  aria-label="Select all leads"
                />
              </TableHead>
              <TableHead>Lead</TableHead>
              <TableHead>Contact</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Priority</TableHead>
              {role !== "SALESPERSON" ? <TableHead>Manager</TableHead> : null}
              <TableHead>Salesperson</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {leads.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columnCount} className="py-10 text-center text-muted-foreground">
                  No leads found.
                </TableCell>
              </TableRow>
            ) : (
              leads.map((lead) => (
                <TableRow key={lead.id} data-state={selectedIds.has(lead.id) ? "selected" : undefined}>
                  <TableCell>
                    <input
                      type="checkbox"
                      checked={selectedIds.has(lead.id)}
                      onChange={(e) => onToggleOne(lead.id, e.target.checked)}
                      aria-label={`Select ${lead.firstName}`}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">
                      {lead.firstName} {lead.lastName ?? ""}
                    </div>
                    <div className="text-xs text-muted-foreground">{lead.leadNumber}</div>
                  </TableCell>
                  <TableCell>
                    <div>{lead.mobile ?? "—"}</div>
                    <div className="text-xs text-muted-foreground">{lead.email ?? ""}</div>
                  </TableCell>
                  <TableCell>{lead.source?.name ?? "—"}</TableCell>
                  <TableCell>
                    {role === "SALESPERSON" ? <LeadStatusSelect lead={lead} /> : <StatusBadge status={lead.workingStatus} />}
                  </TableCell>
                  <TableCell>{lead.priority}</TableCell>
                  {role !== "SALESPERSON" ? <TableCell>{lead.assignedManager?.name ?? "—"}</TableCell> : null}
                  <TableCell>{lead.owner?.name ?? "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(lead.createdAt).toLocaleDateString()}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {pagination && pagination.totalPages > 1 ? (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            Page {pagination.page} of {pagination.totalPages} ({pagination.total} leads)
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
