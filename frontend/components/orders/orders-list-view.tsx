"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ShoppingCart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useLiveOrders, useOrderFilterOptions, useOrderTagOptions } from "@/hooks/useOrders";
import { useAuthStore } from "@/stores/auth-store";
import type { LiveOrdersListParams } from "@/lib/api-client/types/orders.types";
import { OrdersFiltersBar } from "./orders-filters";
import { OrdersCursorPagination } from "./orders-cursor-pagination";
import { OrdersTable, OrdersTableSkeleton, orderDetailHref } from "./orders-table";
import { FILTER_COLUMNS, filtersToApi, filtersToParams, hasActiveColumnFilters, isColumnActive, parseColumnFilters, type ColumnFilters } from "./orders-column-filters";
import { headerFilterNodes } from "./orders-header-filters";

// This page reads live from Shopify (GET /orders/live), not the CRM DB - see orders.live.service.ts.
// 25 is within the 25-50 initial-page-size range the live endpoint is meant to be used at.
const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 350;

// Search + every column filter live in the URL so a refresh, Back from an order, or a shared link returns to the same
// filtered view (see orders-column-filters.ts for the format). The cursor position itself is deliberately NOT persisted -
// Shopify's cursors are opaque; a refresh goes back to the first page. Filtering itself happens on the SERVER (the same
// GET /orders/live call), never by loading every order into the browser.

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

  const queryString = searchParams.toString();
  const filters: ColumnFilters = useMemo(() => parseColumnFilters(new URLSearchParams(queryString)), [queryString]);
  const search = (new URLSearchParams(queryString).get("search") ?? "").slice(0, 100);
  const [searchText, setSearchText] = useState(search);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(searchTimer.current), []);

  // Stack of Shopify "after" cursors used to reach each page past the first (page 1 has none).
  // Reset whenever the search text/filters change, since the cursor sequence belongs to that
  // specific query - a leftover cursor from a different query would page through the wrong result set.
  const [afterStack, setAfterStack] = useState<string[]>([]);
  const currentAfter = afterStack.length > 0 ? afterStack[afterStack.length - 1] : undefined;

  const updateUrl = useCallback(
    (patch: Record<string, string | undefined>) => {
      const next = new URLSearchParams(window.location.search);
      for (const [key, value] of Object.entries(patch)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      const query = next.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
      setAfterStack([]);
    },
    [router, pathname, setAfterStack],
  );

  const handleSearchChange = (text: string) => {
    setSearchText(text);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => updateUrl({ search: text.trim() || undefined }), SEARCH_DEBOUNCE_MS);
  };

  const handleClear = () => {
    clearTimeout(searchTimer.current);
    setSearchText("");
    setAfterStack([]);
    router.replace(pathname, { scroll: false });
  };

  const showSalesperson = role !== undefined && role !== "SALESPERSON";
  const { salespeople, leadSources } = useOrderFilterOptions(true);
  const tagOptions = useOrderTagOptions(true);

  const dateRangeInvalid = Boolean(filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo);
  const activeFilterCount = FILTER_COLUMNS.filter((c) => isColumnActive(filters, c)).length;
  const hasActiveFilters = Boolean(search || searchText.trim() || hasActiveColumnFilters(filters));

  const params: LiveOrdersListParams = {
    after: currentAfter,
    first: PAGE_SIZE,
    search: search || undefined,
    ...(filtersToApi(filters) as Partial<LiveOrdersListParams>),
    dateFrom: dayBoundary(filters.dateFrom, "00:00:00"),
    dateTo: dayBoundary(filters.dateTo, "23:59:59.999"),
  };
  const { data, isLoading, isFetching, error, refetch } = useLiveOrders(params, { enabled: !dateRangeInvalid });

  const handleNext = () => {
    if (data?.pageInfo.endCursor) setAfterStack((stack) => [...stack, data.pageInfo.endCursor!]);
  };
  const handlePrevious = () => setAfterStack((stack) => stack.slice(0, -1));

  const headerFilters = headerFilterNodes({ filters, onChange: (patch) => updateUrl(filtersToParams(patch)), salespeople, leadSources, showSalesperson, tagOptions: { tags: tagOptions.tags, loading: tagOptions.isLoading, error: tagOptions.error } });

  // Shopify being unreachable is reported inside a successful response body (data.error), not a
  // thrown error - see orders.live.service.ts. Treat it the same as a hard fetch failure here.
  const loadError = error ?? data?.error ?? null;

  let content;
  if (dateRangeInvalid) {
    content = null;
  } else if (isLoading) {
    content = <OrdersTableSkeleton />;
  } else if (loadError && (!data || data.items.length === 0)) {
    content = (
      <div role="alert" className="flex flex-col items-center gap-3 py-12 text-center">
        <p className="text-sm text-destructive">{loadError}</p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          Try again
        </Button>
      </div>
    );
  } else if (data && data.items.length === 0) {
    // The table (with its header funnels) stays visible above the message, so a filter can be changed without clearing first.
    content = (
      <>
        {hasActiveFilters ? <OrdersTable items={[]} isFetching={isFetching} onOpen={() => undefined} headerFilters={headerFilters} /> : null}
        <div className="flex flex-col items-center gap-3 py-12 text-center">
          <div className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <ShoppingCart className="size-5" />
          </div>
          {hasActiveFilters ? (
            <>
              <p className="text-sm font-medium">No orders match your filters.</p>
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
      </>
    );
  } else if (data) {
    content = (
      <>
        {data.partialError ? (
          <p role="alert" className="pb-3 text-sm text-destructive">
            {data.partialError}
          </p>
        ) : null}
        <OrdersTable items={data.items} isFetching={isFetching} onOpen={(id) => router.push(orderDetailHref(id))} headerFilters={headerFilters} />
        <OrdersCursorPagination
          hasNextPage={data.pageInfo.hasNextPage}
          hasPreviousPage={afterStack.length > 0}
          onNext={handleNext}
          onPrevious={handlePrevious}
          disabled={isFetching}
        />
      </>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Orders</h1>
        <p className="text-sm text-muted-foreground">Live from Shopify - track customer purchases, payments and order status.</p>
      </div>

      <OrdersFiltersBar
        searchText={searchText}
        onSearchChange={handleSearchChange}
        onClear={handleClear}
        hasActiveFilters={hasActiveFilters}
        activeFilterCount={activeFilterCount}
        dateRangeInvalid={dateRangeInvalid}
      />

      <Card>
        <CardContent>{content}</CardContent>
      </Card>
    </div>
  );
}
