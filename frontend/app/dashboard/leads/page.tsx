"use client";

import { Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Plus, Upload } from "lucide-react";
import { useAuthStore } from "@/stores/auth-store";
import { leadListQueryOptions } from "@/lib/api-client/queries/lead.queries";
import { getErrorMessage } from "@/lib/api-client/client";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/page-header";
import { LeadTable } from "@/components/leads/lead-table";
import { LeadFilters, type LeadFilterState } from "@/components/leads/lead-filters";
import { LeadSelectionToolbar } from "@/components/leads/lead-selection-toolbar";
import { AssignManagerDialog } from "@/components/leads/assign-manager-dialog";
import { AssignSalespersonDialog } from "@/components/leads/assign-salesperson-dialog";
import { BulkUpdateStatusDialog } from "@/components/leads/bulk-update-status-dialog";
import { ImportLeadsDialog } from "@/components/leads/import-leads-dialog";
import { BucketSummary } from "@/components/leads/bucket-summary";
import { CreateLeadDialog } from "@/components/leads/create-lead-dialog";
import { SelectAllMatching } from "@/components/leads/select-all-matching";
import { idFilterOf } from "@/lib/lead-filter";

const PAGE_SIZE = 20;

function LeadsPageContent() {
  const user = useAuthStore((s) => s.user);
  const [page, setPage] = useState(1);
  // the Segments page links here with ?segmentId=...
  const initialSegment = useSearchParams().get("segmentId") ?? undefined;
  const [filters, setFilters] = useState<LeadFilterState>(initialSegment ? { segmentId: initialSegment } : {});
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [assignManagerOpen, setAssignManagerOpen] = useState(false);
  const [assignSalespersonOpen, setAssignSalespersonOpen] = useState(false);
  const [updateStatusOpen, setUpdateStatusOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  // "Select all N leads matching this filter" (e.g. a whole campaign segment): the server resolves the ids, the browser never holds them.
  const [allMatching, setAllMatching] = useState(false);

  const params = useMemo(() => ({ page, limit: PAGE_SIZE, ...filters }), [page, filters]);
  const { data, isPending, error } = useQuery(leadListQueryOptions(params));

  if (!user) return null;

  const isAdmin = user.role === "ADMIN";
  const isManager = user.role === "MANAGER";

  function clearSelection() {
    setSelectedIds(new Set());
    setAllMatching(false);
  }

  const idFilter = idFilterOf(filters);
  const total = data?.pagination.total ?? 0;
  const pageCount = data?.data.length ?? 0;
  const useFilter = allMatching && idFilter !== null;
  const selectedCount = useFilter ? total : selectedIds.size;

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
      <PageHeader
        title={isAdmin ? "All Leads" : "My Leads"}
        description={
          isAdmin
            ? "View leads from every source and assign them to managers."
            : isManager
              ? "View leads assigned to you and hand them off to your salespeople."
              : "View the leads assigned to you and update their status."
        }
        actions={
          <>
            {isAdmin || isManager ? (
              <Button variant="outline" onClick={() => setImportOpen(true)}>
                <Upload />
                Import Excel / CSV
              </Button>
            ) : null}
            <Button onClick={() => setCreateOpen(true)}>
              <Plus />
              New Lead
            </Button>
          </>
        }
      />

      {isManager ? (
        <BucketSummary
          onShowRinging={() => {
            setFilters({ workingStatus: "RINGING" });
            setPage(1);
            clearSelection();
          }}
        />
      ) : null}

      <LeadFilters
        value={filters}
        onChange={(next) => {
          setFilters(next);
          setPage(1);
          clearSelection();
        }}
        role={user.role}
      />

      {selectedIds.size > 0 && idFilter && pageCount > 0 && selectedIds.size === pageCount ? (
        <SelectAllMatching pageCount={pageCount} total={total} allSelected={useFilter} onSelectAll={() => setAllMatching(true)} onClear={clearSelection} />
      ) : null}

      {selectedIds.size > 0 ? (
        <LeadSelectionToolbar
          count={selectedCount}
          onClear={clearSelection}
          onAssignManager={isAdmin ? () => setAssignManagerOpen(true) : undefined}
          onAssignSalesperson={isManager ? () => setAssignSalespersonOpen(true) : undefined}
          // changing the status of a filter-wide selection is not offered: it only exists for explicit ids
          onUpdateStatus={isAdmin && !useFilter ? () => setUpdateStatusOpen(true) : undefined}
        />
      ) : null}

      {error ? (
        <div className="sketch-outline border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
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
        filter={useFilter ? idFilter : null}
        count={selectedCount}
        onDone={() => {
          setAssignManagerOpen(false);
          clearSelection();
        }}
      />
      <AssignSalespersonDialog
        open={assignSalespersonOpen}
        onOpenChange={setAssignSalespersonOpen}
        leadIds={[...selectedIds]}
        filter={useFilter ? idFilter : null}
        count={selectedCount}
        onDone={() => {
          setAssignSalespersonOpen(false);
          clearSelection();
        }}
      />
      <BulkUpdateStatusDialog
        open={updateStatusOpen}
        onOpenChange={setUpdateStatusOpen}
        leadIds={[...selectedIds]}
        onDone={() => {
          setUpdateStatusOpen(false);
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

// useSearchParams (the Segments page deep-links here) needs a Suspense boundary.
export default function LeadsPage() {
  return (
    <Suspense fallback={null}>
      <LeadsPageContent />
    </Suspense>
  );
}
