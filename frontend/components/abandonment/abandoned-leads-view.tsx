"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { AbandonmentFilters } from "@/components/abandonment/abandonment-filters";
import { hasAnyFilter, toApiFilters, type AbandonmentFilterState } from "@/components/abandonment/abandonment-column-filters";
import { AbandonmentTable, AbandonmentTableSkeleton } from "@/components/abandonment/abandonment-table";
import { OrdersPagination } from "@/components/orders/orders-pagination";
import { LeadSelectionToolbar } from "@/components/leads/lead-selection-toolbar";
import { AssignAbandonmentManagerDialog } from "@/components/abandonment/assign-manager-dialog";
import { AssignAbandonmentSalespersonDialog } from "@/components/abandonment/assign-salesperson-dialog";
import { AbandonmentBulkUpdateStatusDialog } from "@/components/abandonment/bulk-update-status-dialog";
import { ManagerAutoAssignToggle, RedistributeAbsentCard, SalespersonAutoAssignToggle } from "@/components/abandonment/auto-assign-toggle";
import { AbandonmentDateRangeFilter, DATE_RANGE_LABEL, DEFAULT_DATE_RANGE, parseDateRange } from "@/components/abandonment/abandonment-date-range";
import type { AbandonmentDateRange, ListAbandonmentsParams } from "@/lib/api-client/types/abandonment.types";
import { parseAbandonedLeadsUrl } from "@/lib/abandoned-leads-href";
import { assignableTelecallersQueryOptions } from "@/lib/api-client/queries/abandonment.queries";
import { X } from "lucide-react";
import { IngestionHealthPanel } from "@/components/abandonment/ingestion-health";
import { BucketSummary } from "@/components/leads/bucket-summary";
import { ImportAbandonedLeadsDialog } from "@/components/abandonment/import-abandoned-leads-dialog";
import { LeadExcelPanel } from "@/components/abandonment/lead-excel-panel";
import { RecordingZipPanel } from "@/components/abandonment/recording-zip-panel";
import { EXPORTS_KEY, istDay, type ExportFilters } from "@/components/abandonment/export-shared";
import { abandonmentRecordingsApi, describeRequestError } from "@/lib/api-client/endpoints/abandonment.recordings.api";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { encodeItemKeys } from "@/lib/abandonment-items";

const PAGE_SIZES = [20, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 20;

function parsePageSize(params: URLSearchParams): number {
  const size = Number(params.get("size"));
  return (PAGE_SIZES as readonly number[]).includes(size) ? size : DEFAULT_PAGE_SIZE;
}

// The search / column filters live in the URL too (`f`), next to `page`: a refresh or Back from a lead can never leave "page 2" pointing at an unfiltered list.
const NUMBER_FILTERS = ["valueMin", "valueMax"] as const;
const STRING_FILTERS = ["search", "workingStatus", "lead", "contact", "assignee", "lastAction", "detectedFrom", "detectedTo"] as const;
function parseFilters(raw: string | null): AbandonmentFilterState {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of STRING_FILTERS) if (typeof parsed[key] === "string" && parsed[key]) out[key] = String(parsed[key]).slice(0, 100);
    for (const key of NUMBER_FILTERS) if (typeof parsed[key] === "number" && Number.isFinite(parsed[key])) out[key] = parsed[key];
    if (Array.isArray(parsed.items)) {
      const items = parsed.items.filter((k): k is string => typeof k === "string").slice(0, 50);
      if (items.length > 0) out.items = items;
    }
    return out as AbandonmentFilterState;
  } catch {
    return {};
  }
}
function serializeFilters(f: AbandonmentFilterState): string | undefined {
  const clean = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0)));
  return Object.keys(clean).length > 0 ? JSON.stringify(clean) : undefined;
}

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
  const pageSize = parsePageSize(searchParams);
  // Today is the default working view. It lives in the URL so a refresh, Back from a lead, and everything that happens after an assignment keep it.
  const range = parseDateRange(searchParams.get("range"));
  // Drill-down filters from the dashboards (?salespersonId=, ?assignment=UNASSIGNED_TELECALLER). Validated here; a telecaller never sends them (the server also refuses them).
  const urlFilters = parseAbandonedLeadsUrl(searchParams);
  const isTelecaller = user?.role === "SALESPERSON";
  const salespersonId = isTelecaller ? undefined : urlFilters.salespersonId;
  const assignment = isTelecaller ? undefined : urlFilters.assignment;
  const [filters, setFiltersState] = useState<AbandonmentFilterState>(() => parseFilters(searchParams.get("f")));
  // Daily bucket / RINGING pool views are about when a lead was ASSIGNED, not when the cart was abandoned, so they ignore the Today / Yesterday tabs.
  const [bucketOnly, setBucketOnly] = useState(false);
  const [allDays, setAllDays] = useState(false);
  const apiRange: AbandonmentDateRange = bucketOnly || allDays ? "all" : range;
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Shown when changing a filter had to clear a selection, so a selection is never dropped silently.
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);
  const [assignManagerOpen, setAssignManagerOpen] = useState(false);
  const [assignSalespersonOpen, setAssignSalespersonOpen] = useState(false);
  const [updateStatusOpen, setUpdateStatusOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  // Every URL change goes through one place that builds on the LAST URL written (not window.location, which lags a pending router.replace),
  // so a filter change and "back to page 1" made together can never overwrite each other.
  const urlRef = useRef(searchParams.toString());
  const currentQuery = searchParams.toString();
  useEffect(() => {
    urlRef.current = currentQuery;
  }, [currentQuery]);
  const updateUrl = useCallback(
    (change: (query: URLSearchParams) => void) => {
      const next = new URLSearchParams(urlRef.current);
      change(next);
      const query = next.toString();
      urlRef.current = query;
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [router, pathname],
  );
  const goToPage = useCallback(
    (nextPage: number) =>
      updateUrl((next) => {
        if (nextPage > 1) next.set("page", String(nextPage));
        else next.delete("page");
      }),
    [updateUrl],
  );
  const resetPage = useCallback(() => goToPage(1), [goToPage]);
  // Search / filter change: kept in the URL and always back to page 1, in one write.
  const setFilters = useCallback(
    (next: AbandonmentFilterState) => {
      setFiltersState(next);
      updateUrl((query) => {
        const serialized = serializeFilters(next);
        if (serialized) query.set("f", serialized);
        else query.delete("f");
        query.delete("page");
      });
    },
    [updateUrl],
  );
  const changePageSize = useCallback(
    (size: number) =>
      updateUrl((query) => {
        if (size === DEFAULT_PAGE_SIZE) query.delete("size");
        else query.set("size", String(size));
        query.delete("page");
      }),
    [updateUrl],
  );
  const changeRange = useCallback(
    (next: AbandonmentDateRange) =>
      updateUrl((query) => {
        if (next === DEFAULT_DATE_RANGE) query.delete("range");
        else query.set("range", next);
        query.delete("page"); // a new range always starts on page 1
      }),
    [updateUrl],
  );
  // Removes a drill-down filter chip (telecaller / unassigned) from the URL; back to page 1.
  const removeUrlFilter = useCallback(
    (name: "salespersonId" | "assignment") =>
      updateUrl((query) => {
        query.delete(name);
        query.delete("page");
      }),
    [updateUrl],
  );

  // A custom Detected range from the column filter replaces the Today / Yesterday / All tabs (see toApiFilters).
  const customDates = Boolean(filters.detectedFrom || filters.detectedTo);
  const effectiveRange: AbandonmentDateRange = customDates ? "all" : apiRange;
  const params = useMemo<ListAbandonmentsParams>(() => ({ page, pageSize, ...toApiFilters(filters, apiRange), ...(bucketOnly ? { bucket: "TODAY" as const } : {}), ...(salespersonId ? { salespersonId } : {}), ...(assignment ? { assignment } : {}) }), [page, pageSize, filters, apiRange, bucketOnly, salespersonId, assignment]);
  // The list's own search / column filters, offered to the Excel export (the date range comes from the export panel itself).
  const exportFilters = useMemo<ExportFilters>(
    () => ({ search: filters.search, workingStatus: filters.workingStatus, lead: filters.lead, contact: filters.contact, assignee: filters.assignee, lastAction: filters.lastAction, valueMin: filters.valueMin, valueMax: filters.valueMax, items: filters.items && filters.items.length > 0 ? encodeItemKeys(filters.items) : undefined }),
    [filters],
  );
  // Rows of another day are never kept on screen while a new range loads (they would be selectable under the wrong heading); page/filter changes within a day still are.
  const { data, isPending, isFetching, error } = useQuery({
    ...abandonmentListQueryOptions(params),
    // Only the page number (or page size) may change while old rows stay on screen; a different filter, search or day never shows the previous result set.
    placeholderData: (previous, previousQuery) => {
      const before = previousQuery?.queryKey[2] as ListAbandonmentsParams | undefined;
      if (!before) return undefined;
      const { page: _p, pageSize: _s, ...beforeFilters } = before;
      const { page: _p2, pageSize: _s2, ...nowFilters } = params;
      return JSON.stringify(beforeFilters) === JSON.stringify(nowFilters) ? previous : undefined;
    },
  });
  const itemOptions = useQuery(abandonmentItemOptionsQueryOptions());
  const queryClient = useQueryClient();
  // Lead names for the Manual assignment list: remembered from every page that was shown and from "Select all", so leads picked across pages are named.
  const leadLabels = useRef(new Map<string, { name: string; leadNumber: string }>());
  useEffect(() => {
    for (const item of data?.items ?? []) leadLabels.current.set(item.id, { name: item.lead.name, leadNumber: item.lead.leadNumber });
  }, [data]);
  const [downloadingLeads, setDownloadingLeads] = useState(false);
  const [selectingAll, setSelectingAll] = useState(false);
  const [selectAllError, setSelectAllError] = useState<string | null>(null);

  if (!user) return null;

  const hasActiveFilters = Boolean(hasAnyFilter(filters) || salespersonId || assignment || bucketOnly);
  const isAdmin = user.role === "ADMIN";
  const isManager = user.role === "MANAGER";
  const isHr = user.role === "HR";
  // Who works the queue as a team lead: pick leads, assign them to telecallers. (HR distributes but does not work leads.)
  const isStaff = isAdmin || isManager || isHr;
  const canHearRecordings = isAdmin || isManager;
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
      const result = await abandonmentApi.listMatchingIds({ ...toApiFilters(filters, apiRange), ...(bucketOnly ? { bucket: "TODAY" as const } : {}), ...(salespersonId ? { salespersonId } : {}), ...(assignment ? { assignment } : {}) });
      for (const l of result.labels) leadLabels.current.set(l.id, { name: l.name, leadNumber: l.leadNumber });
      setSelectedIds(new Set(result.ids));
      if (result.capped) setSelectAllError(`Only the first ${result.ids.length} of ${result.total} matches were selected. Narrow the filters to assign the rest.`);
    } catch (e) {
      setSelectAllError(getErrorMessage(e, "Could not select all matching leads."));
    } finally {
      setSelectingAll(false);
    }
  }

  // "Download Leads": an Excel of exactly the ticked leads (what was filtered, searched and ticked - nothing else), built in the background; it appears in the lead-exports history below.
  async function downloadSelectedLeads() {
    setDownloadingLeads(true);
    try {
      await abandonmentRecordingsApi.startExport({ kind: "EXCEL", from: istDay(), to: istDay(), filters: { ids: [...selectedIds] } });
      void queryClient.invalidateQueries({ queryKey: EXPORTS_KEY });
      toast.success(`Excel of ${selectedIds.size} selected lead${selectedIds.size === 1 ? "" : "s"} is being prepared. Follow it under "Download abandoned leads" - you can leave this page.`);
    } catch (e) {
      toast.error(describeRequestError(e, "Could not start the lead export."));
    } finally {
      setDownloadingLeads(false);
    }
  }

  // "Download all N matching": every lead the current search, filters and day range match - across all pages, not only the 1,000 that "Select all" can tick.
  async function downloadAllMatching() {
    setDownloadingLeads(true);
    try {
      const { page: _page, pageSize: _size, items, ...rest } = params;
      const filtersOut: Record<string, unknown> = { matching: true, ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined && v !== "")), ...(items && items.length > 0 ? { items: encodeItemKeys(items) } : {}) };
      await abandonmentRecordingsApi.startExport({ kind: "EXCEL", from: istDay(), to: istDay(), filters: filtersOut });
      void queryClient.invalidateQueries({ queryKey: EXPORTS_KEY });
      toast.success("Excel of all matching leads is being prepared. Follow it under \"Download abandoned leads\" - you can leave this page.");
    } catch (e) {
      toast.error(describeRequestError(e, "Could not start the lead export."));
    } finally {
      setDownloadingLeads(false);
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
      {isManager ? <RedistributeAbsentCard /> : null}

      {isStaff ? <IngestionHealthPanel canReconcile={isAdmin} /> : null}

      {isManager ? (
        <BucketSummary
          kind="ABANDONED"
          onShowRinging={() => {
            clearSelectionForFilterChange();
            setBucketOnly(false);
            setAllDays(true);
            setFilters({ workingStatus: "RINGING" });
          }}
        />
      ) : null}

      {isTelecaller ? (
        <div>
          <Button
            type="button"
            variant={bucketOnly ? "default" : "outline"}
            onClick={() => {
              clearSelectionForFilterChange();
              setBucketOnly(!bucketOnly);
              setAllDays(false);
              resetPage();
            }}
          >
            Today&apos;s bucket
          </Button>
        </div>
      ) : null}

      <AbandonmentDateRangeFilter value={range} onChange={(next) => { setAllDays(false); setBucketOnly(false); selectRange(next); }} total={error ? undefined : data?.pagination.totalItems} />

      {hasUrlFilters ? <DrillDownChips salespersonId={salespersonId} assignment={assignment} onRemove={(name) => { clearSelectionForFilterChange(); removeUrlFilter(name); }} /> : null}

      <AbandonmentFilters
        value={filters}
        onChange={(next) => {
          setFilters(next);
          clearSelectionForFilterChange();
        }}
        role={user.role}
      />

      {canHearRecordings ? <LeadExcelPanel filters={exportFilters} /> : null}
      {canHearRecordings ? <RecordingZipPanel /> : null}

      {(isStaff) && data && data.pagination.totalItems > data.items.length && selectedIds.size < data.pagination.totalItems ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>{data.pagination.totalItems} abandoned leads match.</span>
          <Button type="button" size="sm" variant="outline" onClick={selectAllMatching} disabled={selectingAll}>
            {selectingAll ? "Selecting…" : `Select all ${data.pagination.totalItems}`}
          </Button>
          {canHearRecordings ? (
            <Button type="button" size="sm" variant="outline" onClick={downloadAllMatching} disabled={downloadingLeads} data-testid="download-all-matching">
              {downloadingLeads ? "Starting…" : `Download all ${data.pagination.totalItems} matching (Excel)`}
            </Button>
          ) : null}
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
          onDownload={canHearRecordings ? downloadSelectedLeads : undefined}
          downloading={downloadingLeads}
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
              <AbandonmentTableSkeleton withSelection={isStaff} withRecording={canHearRecordings} />
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
                  <Button type="button" size="sm" variant="outline" onClick={() => { setFilters({}); setBucketOnly(false); setAllDays(false); clearSelectionForFilterChange(); if (salespersonId) removeUrlFilter("salespersonId"); if (assignment) removeUrlFilter("assignment"); }}>
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
                      clearSelectionForFilterChange();
                    },
                  }}
                  columnFilters={{
                    value: filters,
                    onChange: (next) => {
                      setFilters(next);
                      clearSelectionForFilterChange();
                    },
                  }}
                  isFetching={isFetching}
                  selectedIds={isStaff ? selectedIds : undefined}
                  onToggleOne={isStaff ? toggleOne : undefined}
                  onToggleAll={isStaff ? toggleAll : undefined}
                  role={user.role}
                />
                {data ? (
                  <>
                    <div className="flex items-center justify-end gap-2 pt-4 text-sm text-muted-foreground">
                      <label htmlFor="abandonment-page-size">Rows per page</label>
                      <select
                        id="abandonment-page-size"
                        value={pageSize}
                        onChange={(e) => {
                          clearSelectionForFilterChange();
                          changePageSize(Number(e.target.value));
                        }}
                        disabled={isFetching}
                        className="h-8 rounded-md border bg-background px-2 text-sm text-foreground"
                      >
                        {PAGE_SIZES.map((size) => (
                          <option key={size} value={size}>
                            {size}
                          </option>
                        ))}
                      </select>
                    </div>
                    <OrdersPagination pagination={data.pagination} onPageChange={goToPage} disabled={isFetching} />
                  </>
                ) : null}
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
        labelOf={(id) => leadLabels.current.get(id)}
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

