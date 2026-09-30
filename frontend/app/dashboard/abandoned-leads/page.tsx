"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ShoppingCart } from "lucide-react";
import { useAuthStore } from "@/stores/auth-store";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { getErrorMessage } from "@/lib/api-client/client";
import { abandonmentListQueryOptions } from "@/lib/api-client/queries/abandonment.queries";
import { AbandonmentFilters, type AbandonmentFilterState } from "@/components/abandonment/abandonment-filters";
import { AbandonmentTable, AbandonmentTableSkeleton } from "@/components/abandonment/abandonment-table";
import { OrdersPagination } from "@/components/orders/orders-pagination";
import { LeadSelectionToolbar } from "@/components/leads/lead-selection-toolbar";
import { AssignAbandonmentManagerDialog } from "@/components/abandonment/assign-manager-dialog";
import { AssignAbandonmentSalespersonDialog } from "@/components/abandonment/assign-salesperson-dialog";
import { ManagerAutoAssignToggle, SalespersonAutoAssignToggle } from "@/components/abandonment/auto-assign-toggle";

const PAGE_SIZE = 20;

export default function AbandonedLeadsPage() {
  const user = useAuthStore((s) => s.user);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<AbandonmentFilterState>({});
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [assignManagerOpen, setAssignManagerOpen] = useState(false);
  const [assignSalespersonOpen, setAssignSalespersonOpen] = useState(false);

  const params = useMemo(() => ({ page, pageSize: PAGE_SIZE, ...filters }), [page, filters]);
  const { data, isPending, isFetching, error } = useQuery(abandonmentListQueryOptions(params));

  if (!user) return null;

  const isAdmin = user.role === "ADMIN";
  const isManager = user.role === "MANAGER";

  function clearSelection() {
    setSelectedIds(new Set());
  }

  function toggleAll(checked: boolean) {
    if (!data) return;
    setSelectedIds(checked ? new Set(data.items.map((item) => item.id)) : new Set());
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
                <p className="text-sm font-medium">No abandoned carts right now.</p>
                <p className="text-sm text-muted-foreground">
                  New entries appear here automatically as shoppers leave checkout without paying.
                </p>
              </div>
            ) : (
              <>
                <AbandonmentTable
                  items={data?.items ?? []}
                  isFetching={isFetching}
                  selectedIds={isAdmin || isManager ? selectedIds : undefined}
                  onToggleOne={isAdmin || isManager ? toggleOne : undefined}
                  onToggleAll={isAdmin || isManager ? toggleAll : undefined}
                />
                {data ? <OrdersPagination pagination={data.pagination} onPageChange={setPage} disabled={isFetching} /> : null}
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
    </div>
  );
}
