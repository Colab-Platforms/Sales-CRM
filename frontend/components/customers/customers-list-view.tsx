"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { OrdersPagination } from "@/components/orders/orders-pagination";
import { useCustomersList } from "@/hooks/useCustomers";
import { useOrderFilterOptions } from "@/hooks/useOrders";
import { useAuthStore } from "@/stores/auth-store";
import { CUSTOMER_SEGMENT_ORDER } from "@/lib/customer-segment";
import { NBA_ACTION_ORDER, NBA_PRIORITY_ORDER } from "@/lib/nba-status";
import { PAYMENT_STATUS_ORDER } from "@/lib/order-status";
import type { PaymentStatusFilter, ShipmentStatus } from "@/lib/api-client/types/orders.types";
import type { CustomersListParams, CustomerSegment, NbaAction, NbaPriority } from "@/lib/api-client/types/customers.types";
import { CustomersFiltersBar, type CustomersFilters } from "./customers-filters";
import { CustomersTable, CustomersTableSkeleton } from "./customers-table";

const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 350;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const PAYMENT_FILTER_VALUES: readonly string[] = [...PAYMENT_STATUS_ORDER, "NONE"];
const SHIPMENT_STATUS_VALUES: readonly string[] = ["SHIPPED", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED", "RETURNED"];

interface ParsedState extends CustomersFilters {
  page: number;
  search: string;
}

// Filters live in the URL so a refresh, or Back from a customer's page, returns to the same view.
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
  const ownerId = params.get("ownerId");
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  return {
    page: Number.isInteger(page) && page >= 1 ? page : 1,
    search: (params.get("search") ?? "").slice(0, 100),
    segment: oneOf<CustomerSegment>("segment", CUSTOMER_SEGMENT_ORDER),
    ownerId: ownerId && UUID_PATTERN.test(ownerId) ? ownerId : undefined,
    hasOrders: oneOf<"true" | "false">("hasOrders", ["true", "false"]),
    paymentStatus: oneOf<PaymentStatusFilter>("paymentStatus", PAYMENT_FILTER_VALUES),
    shipmentStatus: oneOf<ShipmentStatus>("shipmentStatus", SHIPMENT_STATUS_VALUES),
    nbaAction: oneOf<NbaAction>("nbaAction", NBA_ACTION_ORDER),
    nbaPriority: oneOf<NbaPriority>("nbaPriority", NBA_PRIORITY_ORDER),
    dateFrom: date("dateFrom"),
    dateTo: date("dateTo"),
  };
}

function dayBoundary(day: string | undefined, time: string): string | undefined {
  if (!day) return undefined;
  const date = new Date(`${day}T${time}`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function CustomersListView() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const role = useAuthStore((s) => s.user?.role);

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

  // Salespeople never filter by "owner" - it would only ever be themselves.
  const showOwner = role !== undefined && role !== "SALESPERSON";
  const { salespeople } = useOrderFilterOptions(showOwner);

  const dateRangeInvalid = Boolean(state.dateFrom && state.dateTo && state.dateFrom > state.dateTo);
  const hasActiveFilters = Boolean(
    state.search ||
      searchText.trim() ||
      state.segment ||
      state.ownerId ||
      state.hasOrders ||
      state.paymentStatus ||
      state.shipmentStatus ||
      state.nbaAction ||
      state.nbaPriority ||
      state.dateFrom ||
      state.dateTo,
  );

  const params: CustomersListParams = {
    page: state.page,
    pageSize: PAGE_SIZE,
    search: state.search || undefined,
    segment: state.segment,
    ownerId: state.ownerId,
    hasOrders: state.hasOrders === undefined ? undefined : state.hasOrders === "true",
    paymentStatus: state.paymentStatus,
    shipmentStatus: state.shipmentStatus,
    nbaAction: state.nbaAction,
    nbaPriority: state.nbaPriority,
    dateFrom: dayBoundary(state.dateFrom, "00:00:00"),
    dateTo: dayBoundary(state.dateTo, "23:59:59.999"),
  };
  const { data, isLoading, isFetching, error, refetch } = useCustomersList(params, { enabled: !dateRangeInvalid });

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
    content = <CustomersTableSkeleton />;
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
      <CustomersTableSkeleton rows={3} />
    ) : (
      <div className="flex flex-col items-center gap-3 py-12 text-center">
        <div className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Users className="size-5" />
        </div>
        {hasActiveFilters ? (
          <>
            <p className="text-sm font-medium">No customers match your filters</p>
            <p className="text-sm text-muted-foreground">Try a different search or clear the filters.</p>
            <Button variant="outline" size="sm" onClick={handleClear}>
              Clear filters
            </Button>
          </>
        ) : (
          <>
            <p className="text-sm font-medium">No customers yet</p>
            <p className="text-sm text-muted-foreground">Customers appear here once leads are created.</p>
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
        <CustomersTable items={data.items} isFetching={isFetching} />
        <OrdersPagination pagination={data.pagination} onPageChange={goToPage} disabled={isFetching} />
      </>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Customers</h1>
        <p className="text-sm text-muted-foreground">
          {data ? `${data.pagination.totalItems} customers` : "Customer segments and post-sale status, derived from real order and payment activity."}
        </p>
      </div>

      <CustomersFiltersBar
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
        owners={salespeople}
        showOwner={showOwner}
        dateRangeInvalid={dateRangeInvalid}
      />

      <Card>
        <CardContent>{content}</CardContent>
      </Card>
    </div>
  );
}
