"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ShoppingCart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useLiveOrders } from "@/hooks/useOrders";
import type { LiveOrdersListParams } from "@/lib/api-client/types/orders.types";
import { LiveOrdersFiltersBar, type LiveOrdersFilters } from "./orders-live-filters";
import { OrdersCursorPagination } from "./orders-cursor-pagination";
import { OrdersTable, OrdersTableSkeleton, orderDetailHref } from "./orders-table";

// This page reads live from Shopify (GET /orders/live), not the CRM DB - see orders.live.service.ts.
// 25 is within the 25-50 initial-page-size range the live endpoint is meant to be used at.
const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 350;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

interface ParsedState extends LiveOrdersFilters {
  search: string;
}

// Filters live in the URL so a refresh, or Back from an order, returns to the same view. The
// cursor position itself is deliberately NOT persisted to the URL - Shopify's cursors are opaque
// and not meant to be bookmarked; a refresh goes back to the first page, same as opening the
// page fresh. Anything unrecognised in the URL is ignored rather than sent to the API.
function parseState(params: URLSearchParams): ParsedState {
  const date = (key: string) => {
    const value = params.get(key);
    return value && DATE_PATTERN.test(value) ? value : undefined;
  };

  return {
    search: (params.get("search") ?? "").slice(0, 100),
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

  const state = parseState(new URLSearchParams(searchParams.toString()));
  const [searchText, setSearchText] = useState(state.search);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(searchTimer.current), []);

  // Stack of Shopify "after" cursors used to reach each page past the first (page 1 has none).
  // Reset whenever the search text or date range changes, since the cursor sequence belongs to
  // that specific query - a leftover cursor from a different search would page through the wrong result set.
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

  const dateRangeInvalid = Boolean(state.dateFrom && state.dateTo && state.dateFrom > state.dateTo);
  const hasActiveFilters = Boolean(state.search || searchText.trim() || state.dateFrom || state.dateTo);

  const params: LiveOrdersListParams = {
    after: currentAfter,
    first: PAGE_SIZE,
    search: state.search || undefined,
    dateFrom: dayBoundary(state.dateFrom, "00:00:00"),
    dateTo: dayBoundary(state.dateTo, "23:59:59.999"),
  };
  const { data, isLoading, isFetching, error, refetch } = useLiveOrders(params, { enabled: !dateRangeInvalid });

  const handleNext = () => {
    if (data?.pageInfo.endCursor) setAfterStack((stack) => [...stack, data.pageInfo.endCursor!]);
  };
  const handlePrevious = () => setAfterStack((stack) => stack.slice(0, -1));

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
    content = (
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
        {data.partialError ? (
          <p role="alert" className="pb-3 text-sm text-destructive">
            {data.partialError}
          </p>
        ) : null}
        <OrdersTable items={data.items} isFetching={isFetching} onOpen={(id) => router.push(orderDetailHref(id))} />
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

      <LiveOrdersFiltersBar
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
