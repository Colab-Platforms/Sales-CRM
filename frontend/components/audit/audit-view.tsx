"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ClipboardList } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { OrdersPagination } from "@/components/orders/orders-pagination";
import { useAudit } from "@/hooks/useAudit";
import { ACTIVITY_SOURCE_ORDER, AUDIT_FILTERABLE_TYPES } from "@/lib/audit-status";
import type { ActivitySource, ActivityType, AuditEntry, AuditListParams } from "@/lib/api-client/types/audit.types";
import { AuditDetailDialog } from "./audit-detail-dialog";
import { AuditFiltersBar, type AuditFilters } from "./audit-filters";
import { AuditTable, AuditTableSkeleton } from "./audit-table";

const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 350;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

interface ParsedState extends AuditFilters {
  page: number;
  search: string;
}

// Filters live in the URL so a refresh, or a link from Order Detail / Customer 360 (?orderId=/?leadId=),
// lands on the right pre-filtered view.
function parseState(params: URLSearchParams): ParsedState {
  const oneOf = <T extends string>(key: string, allowed: readonly string[]): T | undefined => {
    const value = params.get(key);
    return value && allowed.includes(value) ? (value as T) : undefined;
  };
  const date = (key: string) => {
    const value = params.get(key);
    return value && DATE_PATTERN.test(value) ? value : undefined;
  };
  const page = Number(params.get("page"));

  return {
    page: Number.isInteger(page) && page >= 1 ? page : 1,
    search: (params.get("search") ?? "").slice(0, 100),
    type: oneOf<ActivityType>("type", AUDIT_FILTERABLE_TYPES),
    source: oneOf<ActivitySource>("source", ACTIVITY_SOURCE_ORDER),
    dateFrom: date("dateFrom"),
    dateTo: date("dateTo"),
  };
}

function dayBoundary(day: string | undefined, time: string): string | undefined {
  if (!day) return undefined;
  const date = new Date(`${day}T${time}`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function AuditView() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const state = parseState(new URLSearchParams(searchParams.toString()));
  const [searchText, setSearchText] = useState(state.search);
  const [selected, setSelected] = useState<AuditEntry | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(searchTimer.current), []);

  const updateUrl = useCallback(
    (patch: Record<string, string | undefined>, resetPage = true) => {
      const next = new URLSearchParams(window.location.search);
      for (const [key, value] of Object.entries(patch)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      if (resetPage) next.delete("page");
      const query = next.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [router, pathname],
  );

  const handleSearchChange = (text: string) => {
    setSearchText(text);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => updateUrl({ search: text.trim() || undefined }), SEARCH_DEBOUNCE_MS);
  };

  const handleClear = () => {
    clearTimeout(searchTimer.current);
    setSearchText("");
    router.replace(pathname, { scroll: false });
  };

  const dateRangeInvalid = Boolean(state.dateFrom && state.dateTo && state.dateFrom > state.dateTo);
  const hasActiveFilters = Boolean(state.search || searchText.trim() || state.type || state.source || state.dateFrom || state.dateTo);

  // orderId/leadId come from a link on Order Detail / Customer 360 and stay in the URL but are not
  // shown as removable "filter chips" in this view - they identify where the visitor came from.
  const orderId = searchParams.get("orderId") ?? undefined;
  const leadId = searchParams.get("leadId") ?? undefined;

  const params: AuditListParams = {
    page: state.page,
    pageSize: PAGE_SIZE,
    search: state.search || undefined,
    type: state.type,
    source: state.source,
    orderId,
    leadId,
    dateFrom: dayBoundary(state.dateFrom, "00:00:00"),
    dateTo: dayBoundary(state.dateTo, "23:59:59.999"),
  };
  const { data, isLoading, isFetching, error, refetch } = useAudit(params, { enabled: !dateRangeInvalid });

  const totalPages = data?.pagination.totalPages ?? 0;
  const pastLastPage = Boolean(data) && data!.items.length === 0 && data!.pagination.totalItems > 0 && state.page > totalPages;
  useEffect(() => {
    if (pastLastPage) updateUrl({ page: totalPages > 1 ? String(totalPages) : undefined }, false);
  }, [pastLastPage, totalPages, updateUrl]);

  const goToPage = (page: number) => updateUrl({ page: page > 1 ? String(page) : undefined }, false);

  let content;
  if (dateRangeInvalid) {
    content = null;
  } else if (isLoading) {
    content = <AuditTableSkeleton />;
  } else if (error && !data) {
    content = (
      <div role="alert" className="flex flex-col items-center gap-3 py-12 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          Try again
        </Button>
      </div>
    );
  } else if (data && data.items.length === 0) {
    content = pastLastPage ? (
      <AuditTableSkeleton rows={3} />
    ) : (
      <div className="flex flex-col items-center gap-3 py-12 text-center">
        <div className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <ClipboardList className="size-5" />
        </div>
        {hasActiveFilters ? (
          <>
            <p className="text-sm font-medium">No events match your filters</p>
            <p className="text-sm text-muted-foreground">Try a different search or clear the filters.</p>
            <Button variant="outline" size="sm" onClick={handleClear}>
              Clear filters
            </Button>
          </>
        ) : (
          <>
            <p className="text-sm font-medium">No audit events yet</p>
            <p className="text-sm text-muted-foreground">Events appear here as orders, payments and shipments change.</p>
          </>
        )}
      </div>
    );
  } else if (data) {
    content = (
      <>
        {error ? (
          <p role="alert" className="pb-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <AuditTable items={data.items} isFetching={isFetching} onOpen={setSelected} />
        <OrdersPagination pagination={data.pagination} onPageChange={goToPage} disabled={isFetching} />
      </>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Audit Trail</h1>
        <p className="text-sm text-muted-foreground">
          {data ? `${data.pagination.totalItems} recorded events` : "Chronological history of order, payment, shipment and customer changes."}
        </p>
      </div>

      <AuditFiltersBar
        searchText={searchText}
        onSearchChange={handleSearchChange}
        filters={state}
        onFilterChange={(patch) =>
          updateUrl(
            Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, value || undefined])) as Record<
              string,
              string | undefined
            >,
          )
        }
        onClear={handleClear}
        hasActiveFilters={hasActiveFilters}
        dateRangeInvalid={dateRangeInvalid}
      />

      <Card>
        <CardContent>{content}</CardContent>
      </Card>

      <AuditDetailDialog entry={selected} onOpenChange={(open) => !open && setSelected(null)} />
    </div>
  );
}
