"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, Upload } from "lucide-react";
import { useAuthStore } from "@/stores/auth-store";
import { leadListQueryOptions } from "@/lib/api-client/queries/lead.queries";
import { getErrorMessage } from "@/lib/api-client/client";
import { Button } from "@/components/ui/button";
import { LeadTable } from "@/components/leads/lead-table";
import { LeadFilters, type LeadFilterState } from "@/components/leads/lead-filters";
import { LeadSelectionToolbar } from "@/components/leads/lead-selection-toolbar";
import { AssignManagerDialog } from "@/components/leads/assign-manager-dialog";
import { AssignSalespersonDialog } from "@/components/leads/assign-salesperson-dialog";
import { ImportLeadsDialog } from "@/components/leads/import-leads-dialog";
import { CreateLeadDialog } from "@/components/leads/create-lead-dialog";

const PAGE_SIZE = 20;

export default function LeadsPage() {
  const user = useAuthStore((s) => s.user);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<LeadFilterState>({});
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [assignManagerOpen, setAssignManagerOpen] = useState(false);
  const [assignSalespersonOpen, setAssignSalespersonOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const params = useMemo(() => ({ page, limit: PAGE_SIZE, ...filters }), [page, filters]);
  const { data, isPending, error } = useQuery(leadListQueryOptions(params));

  if (!user) return null;

  const isAdmin = user.role === "ADMIN";
  const isManager = user.role === "MANAGER";

  function clearSelection() {
    setSelectedIds(new Set());
  }

  function toggleAll(checked: boolean) {
    if (!data) return;
    setSelectedIds(checked ? new Set(data.data.map((lead) => lead.id)) : new Set());
  }

  function toggleOne(id: string, checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{isAdmin ? "All Leads" : "My Leads"}</h1>
          <p className="text-sm text-muted-foreground">
            {isAdmin
              ? "View leads from every source and assign them to managers."
              : isManager
                ? "View leads assigned to you and hand them off to your salespeople."
                : "View the leads assigned to you and update their status."}
          </p>
        </div>
        <div className="flex gap-2">
          {isAdmin || isManager ? (
            <Button variant="outline" onClick={() => setImportOpen(true)} className="gap-2">
              <Upload className="size-4" />
              Import CSV
            </Button>
          ) : null}
          <Button onClick={() => setCreateOpen(true)} className="gap-2">
            <Plus className="size-4" />
            New Lead
          </Button>
        </div>
      </div>

      <LeadFilters
        value={filters}
        onChange={(next) => {
          setFilters(next);
          setPage(1);
          clearSelection();
        }}
        role={user.role}
      />

      {selectedIds.size > 0 ? (
        <LeadSelectionToolbar
          count={selectedIds.size}
          onClear={clearSelection}
          onAssignManager={isAdmin ? () => setAssignManagerOpen(true) : undefined}
          onAssignSalesperson={isManager ? () => setAssignSalespersonOpen(true) : undefined}
        />
      ) : null}

      {error ? (
        <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive">
          {getErrorMessage(error, "Failed to load leads.")}
        </div>
      ) : (
        <LeadTable
          leads={data?.data ?? []}
          isLoading={isPending}
          role={user.role}
          selectedIds={selectedIds}
          onToggleOne={toggleOne}
          onToggleAll={toggleAll}
          pagination={data?.pagination}
          onPageChange={setPage}
        />
      )}

      <AssignManagerDialog
        open={assignManagerOpen}
        onOpenChange={setAssignManagerOpen}
        leadIds={[...selectedIds]}
        onDone={() => {
          setAssignManagerOpen(false);
          clearSelection();
        }}
      />
      <AssignSalespersonDialog
        open={assignSalespersonOpen}
        onOpenChange={setAssignSalespersonOpen}
        leadIds={[...selectedIds]}
        onDone={() => {
          setAssignSalespersonOpen(false);
          clearSelection();
        }}
      />
      <ImportLeadsDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onDone={() => setImportOpen(false)}
        isManager={isManager}
      />
      <CreateLeadDialog open={createOpen} onOpenChange={setCreateOpen} onDone={() => setCreateOpen(false)} />
    </div>
  );
}
