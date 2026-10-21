"use client";

import { useCallback, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ShoppingCart, Upload } from "lucide-react";
import { useAuthStore } from "@/stores/auth-store";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { getErrorMessage } from "@/lib/api-client/client";
import { abandonmentItemOptionsQueryOptions, abandonmentListQueryOptions } from "@/lib/api-client/queries/abandonment.queries";
import { abandonmentApi } from "@/lib/api-client/endpoints/abandonment.api";
import { Button } from "@/components/ui/button";
import { AbandonmentFilters, type AbandonmentFilterState } from "@/components/abandonment/abandonment-filters";
import { AbandonmentTable, AbandonmentTableSkeleton } from "@/components/abandonment/abandonment-table";
import { OrdersPagination } from "@/components/orders/orders-pagination";
import { LeadSelectionToolbar } from "@/components/leads/lead-selection-toolbar";
import { AssignAbandonmentManagerDialog } from "@/components/abandonment/assign-manager-dialog";
import { AssignAbandonmentSalespersonDialog } from "@/components/abandonment/assign-salesperson-dialog";
import { AbandonmentBulkUpdateStatusDialog } from "@/components/abandonment/bulk-update-status-dialog";
import { ManagerAutoAssignToggle, SalespersonAutoAssignToggle } from "@/components/abandonment/auto-assign-toggle";
import { AbandonmentDateRangeFilter, DATE_RANGE_LABEL, DEFAULT_DATE_RANGE, parseDateRange } from "@/components/abandonment/abandonment-date-range";
import type { AbandonmentDateRange, ListAbandonmentsParams } from "@/lib/api-client/types/abandonment.types";
import { parseAbandonedLeadsUrl } from "@/lib/abandoned-leads-href";
import { assignableTelecallersQueryOptions } from "@/lib/api-client/queries/abandonment.queries";
import { X } from "lucide-react";
import { IngestionHealthPanel } from "@/components/abandonment/ingestion-health";
import { ImportAbandonedLeadsDialog } from "@/components/abandonment/import-abandoned-leads-dialog";

const PAGE_SIZE = 20;

// `page` lives in the URL (same pattern as CustomersListView/OrdersListView) so a refresh, or Back
// from a lead's detail page, returns to the same page instead of silently resetting to page 1.
function parsePage(params: URLSearchParams): number {
  const page = Number(params.get("page"));
  return Number.isInteger(page) && page >= 1 ? page : 1;
}

export function AbandonedLeadsView() {
  const user = useAuthStore((s) => s.user);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const page = parsePage(searchParams);
  // Today is the default working view. It lives in the URL so a refresh, Back from a lead, and everything that happens after an assignment keep it.
  const range = parseDateRange(searchParams.get("range"));
  // Drill-down filters from the dashboards (?salespersonId=, ?assignment=UNASSIGNED_TELECALLER). Validated here; a telecaller never sends them (the server also refuses them).
  const urlFilters = parseAbandonedLeadsUrl(searchParams);
  const isTelecaller = user?.role === "SALESPERSON";
  const salespersonId = isTelecaller ? undefined : urlFilters.salespersonId;
  const assignment = isTelecaller ? undefined : urlFilters.assignment;
  const [filters, setFilters] = useState<AbandonmentFilterState>({});
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Shown when changing a filter had to clear a selection, so a selection is never dropped silently.
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);
  const [assignManagerOpen, setAssignManagerOpen] = useState(false);
  const [assignSalespersonOpen, setAssignSalespersonOpen] = useState(false);
  const [updateStatusOpen, setUpdateStatusOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const goToPage = useCallback(
    (nextPage: number) => {
      const next = new URLSearchParams(window.location.search);
      if (nextPage > 1) next.set("page", String(nextPage));
      else next.delete("page");
      const query = next.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [router, pathname],
  );
  const resetPage = useCallback(() => goToPage(1), [goToPage]);
  const changeRange = useCallback(
    (next: AbandonmentDateRange) => {
      const query = new URLSearchParams(window.location.search);
      if (next === DEFAULT_DATE_RANGE) query.delete("range");
      else query.set("range", next);
      query.delete("page"); // a new range always starts on page 1
      const text = query.toString();
      router.replace(text ? `${pathname}?${text}` : pathname, { scroll: false });
    },
    [router, pathname],
  );
  // Removes a drill-down filter chip (telecaller / unassigned) from the URL; back to page 1.
  const removeUrlFilter = useCallback(
    (name: "salespersonId" | "assignment") => {
      const query = new URLSearchParams(window.location.search);
      query.delete(name);
      query.delete("page");
      const text = query.toString();
      router.replace(text ? `${pathname}?${text}` : pathname, { scroll: false });
    },
    [router, pathname],
  );

  const params = useMemo<ListAbandonmentsParams>(() => ({ page, pageSize: PAGE_SIZE, ...filters, dateRange: range, ...(salespersonId ? { salespersonId } : {}), ...(assignment ? { assignment } : {}) }), [page, filters, range, salespersonId, assignment]);
  // Rows of another day are never kept on screen while a new range loads (they would be selectable under the wrong heading); page/filter changes within a day still are.
  const { data, isPending, isFetching, error } = useQuery({
    ...abandonmentListQueryOptions(params),
    placeholderData: (previous, previousQuery) => ((previousQuery?.queryKey[2] as ListAbandonmentsParams | undefined)?.dateRange === range ? previous : undefined),
  });
  const itemOptions = useQuery(abandonmentItemOptionsQueryOptions());
  const [selectingAll, setSelectingAll] = useState(false);
  const [selectAllError, setSelectAllError] = useState<string | null>(null);

  if (!user) return null;

  const hasActiveFilters = Boolean(filters.search || filters.workingStatus || (filters.items && filters.items.length > 0) || salespersonId || assignment);
  const isAdmin = user.role === "ADMIN";
  const isManager = user.role === "MANAGER";
  const isHr = user.role === "HR";
  // Who works the queue as a team lead: pick leads, assign them to telecallers. (HR distributes but does not work leads.)
  const isStaff = isAdmin || isManager || isHr;
  const hasUrlFilters = Boolean(salespersonId || assignment);

  function clearSelection() {
    setSelectedIds(new Set());
    setSelectAllError(null);
  }

  // A filter change shows a different set of leads, so the selection is cleared - and SAID, never silently.
  function clearSelectionForFilterChange() {
    if (selectedIds.size > 0) setSelectionNotice(`${selectedIds.size} selected ${selectedIds.size === 1 ? "lead was" : "leads were"} deselected because the filter changed.`);
    clearSelection();
  }

  function selectRange(next: AbandonmentDateRange) {
    clearSelectionForFilterChange();
    changeRange(next);
  }

  function toggleAll(checked: boolean) {
    if (!data) return;
    setSelectionNotice(null);
    setSelectedIds(checked ? new Set(data.items.map((item) => item.id)) : new Set());
  }

  // "Select all N": every abandonment the CURRENT filters match, not just this page - so a TL can pick all of one product's carts
  // and hand them to one telecaller in a single bulk-assign.
  async function selectAllMatching() {
    setSelectingAll(true);
    setSelectAllError(null);
    try {
      const result = await abandonmentApi.listMatchingIds({ ...filters, dateRange: range, ...(salespersonId ? { salespersonId } : {}), ...(assignment ? { assignment } : {}) });
      setSelectedIds(new Set(result.ids));
      if (result.capped) setSelectAllError(`Only the first ${result.ids.length} of ${result.total} matches were selected. Narrow the filters to assign the rest.`);
    } catch (e) {
      setSelectAllError(getErrorMessage(e, "Could not select all matching leads."));
    } finally {
      setSelectingAll(false);
    }
  }

  function toggleOne(id: string, checked: boolean) {
    setSelectionNotice(null);
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
        title="Abandoned Leads"
        description={
          isAdmin
            ? "Shoppers who entered checkout on the website but left before paying. Assign them to a manager or a telecaller to work."
            : isManager
              ? "Abandoned carts assigned to you. Hand them off to your telecallers to follow up."
              : isHr
                ? "Abandoned carts waiting to be distributed. Assign them to telecallers."
                : "Abandoned carts assigned to you. Reach out while the intent is still fresh."
        }
        actions={
          isAdmin || isManager ? (
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              <Upload />
              Import CSV
            </Button>
          ) : undefined
        }
      />

      {isAdmin ? <ManagerAutoAssignToggle /> : null}
      {isManager ? <SalespersonAutoAssignToggle /> : null}

      {isStaff ? <IngestionHealthPanel canReconcile={isAdmin} /> : null}

      <AbandonmentDateRangeFilter value={range} onChange={selectRange} total={error ? undefined : data?.pagination.totalItems} />

      {hasUrlFilters ? <DrillDownChips salespersonId={salespersonId} assignment={assignment} onRemove={(name) => { clearSelectionForFilterChange(); removeUrlFilter(name); }} /> : null}

      <AbandonmentFilters
        value={filters}
        onChange={(next) => {
          setFilters(next);
          resetPage();
          clearSelectionForFilterChange();
        }}
        role={user.role}
      />

      {(isStaff) && data && data.pagination.totalItems > data.items.length && selectedIds.size < data.pagination.totalItems ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>{data.pagination.totalItems} abandoned leads match.</span>
          <Button type="button" size="sm" variant="outline" onClick={selectAllMatching} disabled={selectingAll}>
            {selectingAll ? "Selecting…" : `Select all ${data.pagination.totalItems}`}
          </Button>
        </div>
      ) : null}
      {selectAllError ? <p role="alert" className="text-sm text-destructive">{selectAllError}</p> : null}
      {selectionNotice ? (
        <p role="status" data-testid="selection-notice" className="flex items-center gap-2 text-sm text-muted-foreground">
          {selectionNotice}
          <button type="button" className="underline" onClick={() => setSelectionNotice(null)}>Dismiss</button>
        </p>
      ) : null}

      {selectedIds.size > 0 ? (
        <LeadSelectionToolbar
          count={selectedIds.size}
          onClear={clearSelection}
          onAssignManager={isAdmin ? () => setAssignManagerOpen(true) : undefined}
          onAssignSalesperson={isStaff ? () => setAssignSalespersonOpen(true) : undefined}
          onUpdateStatus={isAdmin ? () => setUpdateStatusOpen(true) : undefined}
        />
      ) : null}

      {error ? (
        <div className="sketch-outline border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {getErrorMessage(error, "Failed to load abandoned leads.")}
        </div>
      ) : (
        <Card>
          <CardContent>
            {isPending ? (
              <AbandonmentTableSkeleton withSelection={isStaff} />
            ) : data && data.items.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-12 text-center">
                <div className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <ShoppingCart className="size-5" />
                </div>
                <p className="text-sm font-medium" data-testid="abandonment-empty">
                  {hasActiveFilters
                    ? `No abandoned carts match these filters${range === "all" ? "" : ` for ${DATE_RANGE_LABEL[range].toLowerCase()}`}.`
                    : isTelecaller
                      ? range === "all"
                        ? "No abandoned leads are assigned to you yet."
                        : `No abandoned leads assigned to you ${range === "today" ? "today" : "yesterday"}.`
                      : range === "today"
                        ? "No abandoned leads today yet."
                        : range === "yesterday"
                          ? "No abandoned leads yesterday."
                          : "No abandoned carts right now."}
                </p>
                <p className="text-sm text-muted-foreground">
                  {hasActiveFilters ? "Try removing a product or another filter." : "New entries appear here automatically as shoppers leave checkout without paying."}
                </p>
                {!hasActiveFilters && range !== "all" ? (
                  <div className="flex flex-wrap justify-center gap-2">
                    {range === "today" ? (
                      <Button type="button" size="sm" variant="outline" onClick={() => selectRange("yesterday")}>View yesterday</Button>
                    ) : null}
                    <Button type="button" size="sm" variant="outline" onClick={() => selectRange("all")}>View all leads</Button>
                  </div>
                ) : null}
                {hasActiveFilters ? (
                  <Button type="button" size="sm" variant="outline" onClick={() => { setFilters({}); resetPage(); clearSelectionForFilterChange(); if (salespersonId) removeUrlFilter("salespersonId"); if (assignment) removeUrlFilter("assignment"); }}>
                    Clear filters
                  </Button>
                ) : null}
              </div>
            ) : (
              <>
                <AbandonmentTable
                  items={data?.items ?? []}
                  itemsFilter={{
                    options: itemOptions.data?.items ?? [],
                    loading: itemOptions.isPending,
                    failed: Boolean(itemOptions.error),
                    selected: filters.items ?? [],
                    onChange: (next) => {
                      setFilters({ ...filters, items: next.length > 0 ? next : undefined });
                      resetPage();
                      clearSelectionForFilterChange();
                    },
                  }}
                  isFetching={isFetching}
                  selectedIds={isStaff ? selectedIds : undefined}
                  onToggleOne={isStaff ? toggleOne : undefined}
                  onToggleAll={isStaff ? toggleAll : undefined}
                  role={user.role}
                />
                {data ? <OrdersPagination pagination={data.pagination} onPageChange={goToPage} disabled={isFetching} /> : null}
              </>
            )}
          </CardContent>
        </Card>
      )}

      <ImportAbandonedLeadsDialog open={importOpen} onOpenChange={setImportOpen} onDone={() => setImportOpen(false)} isManager={isManager} />
      <AssignAbandonmentManagerDialog
        open={assignManagerOpen}
        onOpenChange={setAssignManagerOpen}
        abandonmentIds={[...selectedIds]}
        onDone={() => {
          setAssignManagerOpen(false);
          clearSelection();
        }}
      />
      <AssignAbandonmentSalespersonDialog
        open={assignSalespersonOpen}
        onOpenChange={setAssignSalespersonOpen}
        abandonmentIds={[...selectedIds]}
        onDone={() => {
          setAssignSalespersonOpen(false);
          clearSelection();
        }}
      />
      <AbandonmentBulkUpdateStatusDialog
        open={updateStatusOpen}
        onOpenChange={setUpdateStatusOpen}
        abandonmentIds={[...selectedIds]}
        onDone={() => {
          setUpdateStatusOpen(false);
          clearSelection();
        }}
      />
    </div>
  );
}

/** Shows (and lets the viewer remove) the filters a dashboard drill-down applied. */
function DrillDownChips({ salespersonId, assignment, onRemove }: { salespersonId?: string; assignment?: string; onRemove: (name: "salespersonId" | "assignment") => void }) {
  const telecallers = useQuery(assignableTelecallersQueryOptions());
  const name = salespersonId ? (telecallers.data?.find((t) => t.id === salespersonId)?.name ?? "selected telecaller") : null;
  const chip = (label: string, testId: string, remove: () => void) => (
    <button type="button" onClick={remove} data-testid={testId} className="inline-flex items-center gap-1 rounded-full border bg-background px-3 py-1 text-xs font-medium hover:bg-muted" aria-label={`Remove filter: ${label}`}>
      {label}
      <X className="size-3" aria-hidden />
    </button>
  );
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="drilldown-chips" aria-label="Active drill-down filters">
      <span className="text-xs text-muted-foreground">Showing:</span>
      {salespersonId ? chip(`Telecaller: ${name}`, "chip-telecaller", () => onRemove("salespersonId")) : null}
      {assignment ? chip("Unassigned — waiting for a telecaller", "chip-unassigned", () => onRemove("assignment")) : null}
    </div>
  );
}

