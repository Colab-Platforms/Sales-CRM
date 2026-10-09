"use client";

import { useCallback, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ShoppingCart } from "lucide-react";
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
  const [filters, setFilters] = useState<AbandonmentFilterState>({});
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [assignManagerOpen, setAssignManagerOpen] = useState(false);
  const [assignSalespersonOpen, setAssignSalespersonOpen] = useState(false);
  const [updateStatusOpen, setUpdateStatusOpen] = useState(false);

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

  const params = useMemo(() => ({ page, pageSize: PAGE_SIZE, ...filters }), [page, filters]);
  const { data, isPending, isFetching, error } = useQuery(abandonmentListQueryOptions(params));
  const itemOptions = useQuery(abandonmentItemOptionsQueryOptions());
  const [selectingAll, setSelectingAll] = useState(false);
  const [selectAllError, setSelectAllError] = useState<string | null>(null);

  if (!user) return null;

  const hasActiveFilters = Boolean(filters.search || filters.workingStatus || (filters.items && filters.items.length > 0));
  const isAdmin = user.role === "ADMIN";
  const isManager = user.role === "MANAGER";

  function clearSelection() {
    setSelectedIds(new Set());
    setSelectAllError(null);
  }

  function toggleAll(checked: boolean) {
    if (!data) return;
    setSelectedIds(checked ? new Set(data.items.map((item) => item.id)) : new Set());
  }

  // "Select all N": every abandonment the CURRENT filters match, not just this page - so a TL can pick all of one product's carts
  // and hand them to one telecaller in a single bulk-assign.
  async function selectAllMatching() {
    setSelectingAll(true);
    setSelectAllError(null);
    try {
      const result = await abandonmentApi.listMatchingIds(filters);
      setSelectedIds(new Set(result.ids));
      if (result.capped) setSelectAllError(`Only the first ${result.ids.length} of ${result.total} matches were selected. Narrow the filters to assign the rest.`);
    } catch (e) {
      setSelectAllError(getErrorMessage(e, "Could not select all matching leads."));
    } finally {
      setSelectingAll(false);
    }
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
        title="Abandoned Leads"
        description={
          isAdmin
            ? "Shoppers who entered checkout on the website but left before paying. Assign them to a manager to work."
            : isManager
              ? "Abandoned carts assigned to you. Hand them off to your salespeople to follow up."
              : "Abandoned carts assigned to you. Reach out while the intent is still fresh."
        }
      />

      {isAdmin ? <ManagerAutoAssignToggle /> : null}
      {isManager ? <SalespersonAutoAssignToggle /> : null}

      <AbandonmentFilters
        value={filters}
        onChange={(next) => {
          setFilters(next);
          resetPage();
          clearSelection();
        }}
        role={user.role}
      />

      {(isAdmin || isManager) && data && data.pagination.totalItems > data.items.length && selectedIds.size < data.pagination.totalItems ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>{data.pagination.totalItems} abandoned leads match.</span>
          <Button type="button" size="sm" variant="outline" onClick={selectAllMatching} disabled={selectingAll}>
            {selectingAll ? "Selecting…" : `Select all ${data.pagination.totalItems}`}
          </Button>
        </div>
      ) : null}
      {selectAllError ? <p role="alert" className="text-sm text-destructive">{selectAllError}</p> : null}

      {selectedIds.size > 0 ? (
        <LeadSelectionToolbar
          count={selectedIds.size}
          onClear={clearSelection}
          onAssignManager={isAdmin ? () => setAssignManagerOpen(true) : undefined}
          onAssignSalesperson={isManager ? () => setAssignSalespersonOpen(true) : undefined}
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
              <AbandonmentTableSkeleton withSelection={isAdmin || isManager} />
            ) : data && data.items.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-12 text-center">
                <div className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <ShoppingCart className="size-5" />
                </div>
                <p className="text-sm font-medium">{hasActiveFilters ? "No abandoned carts match these filters." : "No abandoned carts right now."}</p>
                <p className="text-sm text-muted-foreground">
                  {hasActiveFilters ? "Try removing a product or another filter." : "New entries appear here automatically as shoppers leave checkout without paying."}
                </p>
                {hasActiveFilters ? (
                  <Button type="button" size="sm" variant="outline" onClick={() => { setFilters({}); resetPage(); clearSelection(); }}>
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
                      clearSelection();
                    },
                  }}
                  isFetching={isFetching}
                  selectedIds={isAdmin || isManager ? selectedIds : undefined}
                  onToggleOne={isAdmin || isManager ? toggleOne : undefined}
                  onToggleAll={isAdmin || isManager ? toggleAll : undefined}
                />
                {data ? <OrdersPagination pagination={data.pagination} onPageChange={goToPage} disabled={isFetching} /> : null}
              </>
            )}
          </CardContent>
        </Card>
      )}

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
