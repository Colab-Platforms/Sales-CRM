"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ShoppingCart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useOrderFilterOptions, useOrders } from "@/hooks/useOrders";
import { useAuthStore } from "@/stores/auth-store";
import {
  ORDER_SOURCE_ORDER,
  ORDER_STATUS_ORDER,
  PAYMENT_STATUS_ORDER,
} from "@/lib/order-status";
import type {
  OrderSource,
  OrderStatus,
  OrdersListParams,
  PaymentStatusFilter,
} from "@/lib/api-client/types/orders.types";
import { OrdersFiltersBar, type OrdersFilters } from "./orders-filters";
import { OrdersPagination } from "./orders-pagination";
import { OrdersTable, OrdersTableSkeleton, orderDetailHref } from "./orders-table";

const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 350;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAYMENT_FILTER_VALUES: readonly string[] = [...PAYMENT_STATUS_ORDER, "NONE"];

interface ParsedState extends OrdersFilters {
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
  const salespersonId = params.get("salespersonId");

  return {
    page: Number.isInteger(page) && page >= 1 ? page : 1,
    search: (params.get("search") ?? "").slice(0, 100),
    status: oneOf<OrderStatus>("status", ORDER_STATUS_ORDER),
    paymentStatus: oneOf<PaymentStatusFilter>("paymentStatus", PAYMENT_FILTER_VALUES),
    source: oneOf<OrderSource>("source", ORDER_SOURCE_ORDER),
    salespersonId: salespersonId && UUID_PATTERN.test(salespersonId) ? salespersonId : undefined,
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

export function OrdersListView() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const role = useAuthStore((s) => s.user?.role);

  const state = parseState(new URLSearchParams(searchParams.toString()));
  const [searchText, setSearchText] = useState(state.search);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(searchTimer.current), []);

  // Reads the live URL so a pending debounced search can't overwrite a filter changed meanwhile.
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

  const showSalesperson = role !== undefined && role !== "SALESPERSON";
  const { salespeople } = useOrderFilterOptions(showSalesperson);

  const dateRangeInvalid = Boolean(state.dateFrom && state.dateTo && state.dateFrom > state.dateTo);
  const hasActiveFilters = Boolean(
    state.search ||
      searchText.trim() ||
      state.status ||
      state.paymentStatus ||
      state.source ||
      state.salespersonId ||
      state.dateFrom ||
      state.dateTo,
  );

  const params: OrdersListParams = {
    page: state.page,
    pageSize: PAGE_SIZE,
    search: state.search || undefined,
    status: state.status,
    paymentStatus: state.paymentStatus,
    source: state.source,
    salespersonId: state.salespersonId,
    dateFrom: dayBoundary(state.dateFrom, "00:00:00"),
    dateTo: dayBoundary(state.dateTo, "23:59:59.999"),
  };
  const { data, isLoading, isFetching, error, refetch } = useOrders(params, { enabled: !dateRangeInvalid });

  // Filters can shrink the results below the current page; step back to the last real page.
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
    content = <OrdersTableSkeleton />;
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
      <OrdersTableSkeleton rows={3} />
    ) : (
      <div className="flex flex-col items-center gap-3 py-12 text-center">
        <div className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <ShoppingCart className="size-5" />
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
            <p className="text-sm text-muted-foreground">Orders will appear here once they are created.</p>
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
        <OrdersTable items={data.items} isFetching={isFetching} onOpen={(id) => router.push(orderDetailHref(id))} />
        <OrdersPagination pagination={data.pagination} onPageChange={goToPage} disabled={isFetching} />
      </>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Orders</h1>
        <p className="text-sm text-muted-foreground">Track customer purchases, payments and order status.</p>
      </div>

      <OrdersFiltersBar
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
        salespeople={salespeople}
        showSalesperson={showSalesperson}
        dateRangeInvalid={dateRangeInvalid}
      />

      <Card>
        <CardContent>{content}</CardContent>
      </Card>
    </div>
  );
}
