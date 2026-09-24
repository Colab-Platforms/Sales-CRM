"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { OrdersPagination } from "@/components/orders/orders-pagination";
import { useReconciliation } from "@/hooks/useReconciliation";
import { PAYMENT_STATUS_ORDER } from "@/lib/order-status";
import { RECONCILIATION_STATUS_ORDER } from "@/lib/reconciliation-status";
import type { PaymentMode, PaymentStatusFilter } from "@/lib/api-client/types/orders.types";
import type { ReconciliationListParams, ReconciliationStatus } from "@/lib/api-client/types/reconciliation.types";
import { ReconciliationFiltersBar, type ReconciliationFilters } from "./reconciliation-filters";
import { ReconciliationSummaryCards } from "./reconciliation-summary-cards";
import { ReconciliationTable, ReconciliationTableSkeleton } from "./reconciliation-table";

const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 350;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const PAYMENT_FILTER_VALUES: readonly string[] = [...PAYMENT_STATUS_ORDER, "NONE"];
const PAYMENT_MODE_VALUES: readonly string[] = ["COD", "PREPAID"];

interface ParsedState extends ReconciliationFilters {
  page: number;
  search: string;
}

// Filters live in the URL so a refresh, or Back from an order, returns to the same view.
// Anything unrecognised is ignored rather than sent to the API.
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
    paymentStatus: oneOf<PaymentStatusFilter>("paymentStatus", PAYMENT_FILTER_VALUES),
    paymentMode: oneOf<PaymentMode>("paymentMode", PAYMENT_MODE_VALUES),
    reconciliationStatus: oneOf<ReconciliationStatus>("reconciliationStatus", RECONCILIATION_STATUS_ORDER),
    provider: params.get("provider")?.slice(0, 100) || undefined,
    dateFrom: date("dateFrom"),
    dateTo: date("dateTo"),
  };
}

// The API takes full date-times, so a chosen day covers the viewer's whole local day.
function dayBoundary(day: string | undefined, time: string): string | undefined {
  if (!day) return undefined;
  const date = new Date(`${day}T${time}`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function ReconciliationView() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const state = parseState(new URLSearchParams(searchParams.toString()));
  const [searchText, setSearchText] = useState(state.search);
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
  const hasActiveFilters = Boolean(
    state.search ||
      searchText.trim() ||
      state.paymentStatus ||
      state.paymentMode ||
      state.reconciliationStatus ||
      state.provider ||
      state.dateFrom ||
      state.dateTo,
  );

  const params: ReconciliationListParams = {
    page: state.page,
    pageSize: PAGE_SIZE,
    search: state.search || undefined,
    paymentStatus: state.paymentStatus,
    paymentMode: state.paymentMode,
    reconciliationStatus: state.reconciliationStatus,
    provider: state.provider,
    dateFrom: dayBoundary(state.dateFrom, "00:00:00"),
    dateTo: dayBoundary(state.dateTo, "23:59:59.999"),
  };
  const { data, isLoading, isFetching, error, refetch } = useReconciliation(params, { enabled: !dateRangeInvalid });

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
    content = <ReconciliationTableSkeleton />;
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
      <ReconciliationTableSkeleton rows={3} />
    ) : (
      <div className="flex flex-col items-center gap-3 py-12 text-center">
        <div className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Wallet className="size-5" />
        </div>
        {hasActiveFilters ? (
          <>
            <p className="text-sm font-medium">No orders match your filters</p>
            <p className="text-sm text-muted-foreground">Try a different search or clear the filters.</p>
            <Button variant="outline" size="sm" onClick={handleClear}>
              Clear filters
            </Button>
          </>
        ) : (
          <>
            <p className="text-sm font-medium">No orders yet</p>
            <p className="text-sm text-muted-foreground">Reconciliation data will appear here once orders are created.</p>
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
        <ReconciliationTable items={data.items} isFetching={isFetching} />
        <OrdersPagination pagination={data.pagination} onPageChange={goToPage} disabled={isFetching} />
      </>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Revenue & Payment Reconciliation</h1>
        <p className="text-sm text-muted-foreground">
          Track gross revenue, payments received, refunds and outstanding balances across every order.
        </p>
      </div>

      {data ? <ReconciliationSummaryCards summary={data.summary} /> : null}

      <ReconciliationFiltersBar
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
    </div>
  );
}
