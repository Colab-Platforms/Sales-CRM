"use client";

import { Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Plus, Upload } from "lucide-react";
import { useAuthStore } from "@/stores/auth-store";
import { leadListQueryOptions, leadKeys } from "@/lib/api-client/queries/lead.queries";
import { leadApi } from "@/lib/api-client/endpoints/lead.api";
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
import { BulkDeleteLeadsDialog, type BulkDeleteMode } from "@/components/leads/bulk-delete-leads-dialog";
import { NativeSelect } from "@/components/ui/native-select";
import { idFilterOf } from "@/lib/lead-filter";
import { LeadColumnFilters } from "@/components/leads/lead-column-filters";

export const PAGE_SIZES = [20, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 20;

function LeadsPageContent() {
  const user = useAuthStore((s) => s.user);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [deleteMode, setDeleteMode] = useState<BulkDeleteMode | null>(null);
  // bumped by "Clear Filters" so the filter inputs (which keep their own typing state) start empty again
  const [resetKey, setResetKey] = useState(0);
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

  // The real total from the database (not the filtered list): what "Delete All Leads" would act on. Admin only.
  const allCount = useQuery({ queryKey: [...leadKeys.all, "delete-all-count"], queryFn: () => leadApi.previewBulkDelete({ all: true }), enabled: user?.role === "ADMIN" });
  const params = useMemo(() => ({ page, limit: pageSize, ...filters }), [page, pageSize, filters]);
  const { data, isPending, error } = useQuery(leadListQueryOptions(params));

  if (!user) return null;

  const isAdmin = user.role === "ADMIN";
  const isManager = user.role === "MANAGER";

  function clearSelection() {
    setSelectedIds(new Set());
    setAllMatching(false);
  }

  // ONE handler for every filter change (top bar and column row): back to page 1, selection dropped (it belonged to the old list), and an emptied filter set also resets the inputs
  function changeFilters(next: typeof filters) {
    setFilters(next);
    setPage(1);
    clearSelection();
    if (Object.keys(next).length === 0) setResetKey((k) => k + 1);
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
        key={resetKey}
        value={filters}
        onChange={changeFilters}
        role={user.role}
      />

      {selectedIds.size > 0 && !idFilter && pageCount > 0 && selectedIds.size === pageCount && total > pageCount ? (
        <p className="sketch-outline bg-muted/50 px-4 py-2.5 text-sm text-muted-foreground" data-testid="unfiltered-note">
          Selecting every lead across all pages is only available after you apply a filter or search ({total.toLocaleString("en-IN")} leads match right now). To delete every lead, use the separate <strong>Delete All Leads</strong> button (Admin only, typed confirmation).
        </p>
      ) : null}

      {selectedIds.size > 0 && idFilter && pageCount > 0 && selectedIds.size === pageCount ? (
        <SelectAllMatching pageCount={pageCount} total={total} allSelected={useFilter} onSelectAll={() => setAllMatching(true)} onClear={clearSelection} />
      ) : null}

      {selectedIds.size > 0 ? (
        <LeadSelectionToolbar
          count={selectedCount}
          onClear={clearSelection}
          onAssignManager={isAdmin ? () => setAssignManagerOpen(true) : undefined}
          onAssignSalesperson={isManager || isAdmin ? () => setAssignSalespersonOpen(true) : undefined}
          // changing the status of a filter-wide selection is not offered: it only exists for explicit ids
          onUpdateStatus={isAdmin && !useFilter ? () => setUpdateStatusOpen(true) : undefined}
          // Two different deletions (Admin only): what is selected on this page, or every lead matching the filters across all pages.
          onDeletePage={isAdmin ? () => setDeleteMode("PAGE") : undefined}
          onDeleteMatching={isAdmin && useFilter ? () => setDeleteMode("MATCHING") : undefined}
        />
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        {isAdmin ? (
          <Button type="button" variant="destructive" size="sm" onClick={() => setDeleteMode("ALL")} disabled={!allCount.data || allCount.data.matched === 0} data-testid="delete-all-leads">
            Delete All Leads ({allCount.data ? allCount.data.matched.toLocaleString("en-IN") : "…"})
          </Button>
        ) : (
          <span />
        )}
      <div className="flex items-center justify-end gap-2 text-sm" data-testid="page-size">
        <label htmlFor="lead-page-size" className="text-xs text-muted-foreground">
          Records per page
        </label>
        <NativeSelect
          id="lead-page-size"
          wrapperClassName="w-24"
          value={String(pageSize)}
          onChange={(e) => {
            // filters and search stay as they are; only the page size and position change
            setPageSize(Number(e.target.value));
            setPage(1);
            clearSelection();
          }}
        >
          {PAGE_SIZES.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </NativeSelect>
      </div>
      </div>

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
          filterRow={<LeadColumnFilters value={filters} onChange={changeFilters} role={user.role} resetKey={resetKey} onClearAll={() => changeFilters({})} />}
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
        isAdmin={isAdmin}
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
      <BulkDeleteLeadsDialog
        open={deleteMode !== null}
        onOpenChange={(next) => !next && setDeleteMode(null)}
        mode={deleteMode ?? "PAGE"}
        // current-page deletion is limited to the leads on screen, even when "all matching" is selected
        leadIds={deleteMode === "PAGE" ? (useFilter ? (data?.data.map((l) => l.id) ?? []) : [...selectedIds]) : []}
        filter={idFilter}
        onDone={() => {
          setDeleteMode(null);
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
