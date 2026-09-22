"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Truck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { OrdersPagination } from "@/components/orders/orders-pagination";
import { integrationStatusQueryOptions } from "@/lib/api-client/queries/integrations.queries";
import { useShiprocketFilterOptions, useShiprocketShipments } from "@/hooks/useShiprocketShipments";
import { useAuthStore } from "@/stores/auth-store";
import type { PaymentMode, ShipmentStatus } from "@/lib/api-client/types/orders.types";
import type { ListShipmentsParams } from "@/lib/api-client/types/shiprocket.types";
import { ShiprocketDetailSheet } from "./shiprocket-detail-sheet";
import { ShiprocketFiltersBar, SHIPMENT_STATUS_FILTER_ORDER, type ShiprocketFilters } from "./shiprocket-filters";
import { ShiprocketSummaryCards } from "./shiprocket-summary-cards";
import { ShiprocketTable, ShiprocketTableSkeleton } from "./shiprocket-table";

const DEFAULT_PAGE_SIZE = 25;
const PAGE_SIZE_OPTIONS = [25, 50, 100];
const SEARCH_DEBOUNCE_MS = 350;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const PAYMENT_MODE_VALUES: readonly string[] = ["COD", "PREPAID"];

interface ParsedState extends ShiprocketFilters {
  page: number;
  pageSize: number;
  search: string;
}

// Filters live in the URL so a refresh, or Back from a shipment, returns to the same view - same convention as
// orders-list-view.tsx and reconciliation-view.tsx. Anything unrecognised is ignored rather than sent to the API.
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
  const pageSize = Number(params.get("pageSize"));

  return {
    page: Number.isInteger(page) && page >= 1 ? page : 1,
    pageSize: PAGE_SIZE_OPTIONS.includes(pageSize) ? pageSize : DEFAULT_PAGE_SIZE,
    search: (params.get("search") ?? "").slice(0, 100),
    status: oneOf<ShipmentStatus>("status", SHIPMENT_STATUS_FILTER_ORDER),
    courier: params.get("courier")?.slice(0, 150) || undefined,
    paymentMode: oneOf<PaymentMode>("paymentMode", PAYMENT_MODE_VALUES),
    dateFrom: date("dateFrom"),
    dateTo: date("dateTo"),
  };
}

// The API takes full date-times, so a chosen day covers the viewer's whole local day - same helper as orders-list-view.tsx.
function dayBoundary(day: string | undefined, time: string): string | undefined {
  if (!day) return undefined;
  const date = new Date(`${day}T${time}`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function ShiprocketListView() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const token = useAuthStore((s) => s.token);
  const [openShipmentId, setOpenShipmentId] = useState<string | null>(null);

  const status = useQuery({ ...integrationStatusQueryOptions(), enabled: Boolean(token) });

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

  const { couriers } = useShiprocketFilterOptions();

  const dateRangeInvalid = Boolean(state.dateFrom && state.dateTo && state.dateFrom > state.dateTo);
  const hasActiveFilters = Boolean(state.search || searchText.trim() || state.status || state.courier || state.paymentMode || state.dateFrom || state.dateTo);

  const params: ListShipmentsParams = {
    page: state.page,
    pageSize: state.pageSize,
    search: state.search || undefined,
    status: state.status,
    courier: state.courier,
    paymentMode: state.paymentMode,
    dateFrom: dayBoundary(state.dateFrom, "00:00:00"),
    dateTo: dayBoundary(state.dateTo, "23:59:59.999"),
  };
  const notConfigured = status.data ? !status.data.shiprocket.enabled || !status.data.shiprocket.configured : false;
  const { data, isLoading, isFetching, error, refetch } = useShiprocketShipments(params, { enabled: !dateRangeInvalid && !notConfigured });

  // Filters can shrink the results below the current page; step back to the last real page.
  const totalPages = data?.pagination.totalPages ?? 0;
  const pastLastPage = Boolean(data) && data!.items.length === 0 && data!.pagination.totalItems > 0 && state.page > totalPages;
  useEffect(() => {
    if (pastLastPage) updateUrl({ page: totalPages > 1 ? String(totalPages) : undefined }, false);
  }, [pastLastPage, totalPages, updateUrl]);

  const goToPage = (page: number) => updateUrl({ page: page > 1 ? String(page) : undefined }, false);

  let content;
  if (status.isPending) {
    content = <ShiprocketTableSkeleton />;
  } else if (notConfigured) {
    content = (
      <div className="flex flex-col items-center gap-2 py-12 text-center">
        <div className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Truck className="size-5" />
        </div>
        <p className="text-sm font-medium">Shiprocket is not configured</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          An admin needs to finish setting up Shiprocket on the server before shipments can be created or tracked here.
        </p>
        {/* This status is cached for 5 minutes (see integrations.queries.ts) and shared with the order detail page, so
            fixing the server-side configuration does not update this page on its own until that cache expires or a
            manual check is made. */}
        <Button variant="outline" size="sm" onClick={() => status.refetch()} disabled={status.isFetching}>
          {status.isFetching ? "Checking…" : "Check again"}
        </Button>
      </div>
    );
  } else if (dateRangeInvalid) {
    content = null;
  } else if (isLoading) {
    content = <ShiprocketTableSkeleton />;
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
      <ShiprocketTableSkeleton rows={3} />
    ) : (
      <div className="flex flex-col items-center gap-3 py-12 text-center">
        <div className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Truck className="size-5" />
        </div>
        {hasActiveFilters ? (
          <>
            <p className="text-sm font-medium">No shipments match your filters</p>
            <p className="text-sm text-muted-foreground">Try a different search or clear the filters.</p>
            <Button variant="outline" size="sm" onClick={handleClear}>
              Clear filters
            </Button>
          </>
        ) : (
          <>
            <p className="text-sm font-medium">No Shiprocket shipments yet.</p>
            <p className="text-sm text-muted-foreground">Create a shipment from an eligible order to see it here.</p>
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
        <ShiprocketTable items={data.items} isFetching={isFetching} onOpenDetail={setOpenShipmentId} />
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <OrdersPagination pagination={data.pagination} onPageChange={goToPage} disabled={isFetching} />
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            Rows per page
            <NativeSelect wrapperClassName="w-auto" size="sm" value={String(state.pageSize)} onChange={(e) => updateUrl({ pageSize: e.target.value })}>
              {PAGE_SIZE_OPTIONS.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </NativeSelect>
          </label>
        </div>
      </>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Shiprocket</h1>
        <p className="text-sm text-muted-foreground">Manage shipments, courier assignments and tracking from one place.</p>
      </div>

      {data && !notConfigured ? <ShiprocketSummaryCards summary={data.summary} /> : null}

      {!notConfigured ? (
        <ShiprocketFiltersBar
          searchText={searchText}
          onSearchChange={handleSearchChange}
          filters={state}
          onFilterChange={(patch) => updateUrl(Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, value || undefined])) as Record<string, string | undefined>)}
          onClear={handleClear}
          hasActiveFilters={hasActiveFilters}
          couriers={couriers}
          dateRangeInvalid={dateRangeInvalid}
        />
      ) : null}

      <Card>
        <CardContent>{content}</CardContent>
      </Card>

      <ShiprocketDetailSheet shipmentId={openShipmentId} onOpenChange={setOpenShipmentId} />
    </div>
  );
}
