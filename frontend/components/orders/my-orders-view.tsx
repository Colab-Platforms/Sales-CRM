"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ClipboardList } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { useMyOrders } from "@/hooks/useOrders";
import { NO_PAYMENT_LABEL, ORDER_STATUS_LABELS, ORDER_STATUS_ORDER, PAYMENT_STATUS_LABELS, PAYMENT_STATUS_ORDER } from "@/lib/order-status";
import type { OrderListResult, OrderStatus, OrdersListParams, PaymentStatusFilter } from "@/lib/api-client/types/orders.types";
import { OrdersTable, OrdersTableSkeleton, orderDetailHref } from "./orders-table";
import { OrdersPagination } from "./orders-pagination";

// "My Orders": the orders THIS user created. The list comes from GET /orders/mine, which the server scopes to the signed-in user (Order.createdById) - nothing in this page
// can ask for anyone else's orders. The broad Orders page is a separate screen and is not changed by this one.
const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 350;

export interface MyOrdersContentProps {
  data: OrderListResult | null;
  isLoading: boolean;
  isFetching: boolean;
  error: string | null;
  /** A search or filter is applied: an empty result then means "no match", not "you have created nothing". */
  filtered: boolean;
  onRetry: () => void;
  onClear: () => void;
  onOpen: (id: string) => void;
  onPageChange: (page: number) => void;
}

/** The list area of the page, as a pure view so every state (loading, error, never created one, no match, rows) can be rendered and tested on its own. */
export function MyOrdersContent({ data, isLoading, isFetching, error, filtered, onRetry, onClear, onOpen, onPageChange }: MyOrdersContentProps) {
  if (isLoading) return <OrdersTableSkeleton />;
  if (error && (!data || data.items.length === 0)) {
    return (
      <div role="alert" className="flex flex-col items-center gap-3 py-12 text-center" data-testid="my-orders-error">
        <p className="text-sm text-destructive">{error}</p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }
  if (data && data.items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-12 text-center" data-testid="my-orders-empty">
        <div className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <ClipboardList className="size-5" />
        </div>
        {filtered ? (
          <>
            <p className="text-sm font-medium">No orders match your search or filters.</p>
            <p className="text-sm text-muted-foreground">Try a different search, or clear the filters.</p>
            <Button variant="outline" size="sm" onClick={onClear}>
              Clear filters
            </Button>
          </>
        ) : (
          <>
            <p className="text-sm font-medium">You haven&apos;t created any orders yet.</p>
            <p className="text-sm text-muted-foreground">Orders you create from a lead or a WhatsApp chat will appear here.</p>
          </>
        )}
      </div>
    );
  }
  if (!data) return null;
  return (
    <>
      <OrdersTable items={data.items} isFetching={isFetching} onOpen={onOpen} />
      <OrdersPagination pagination={data.pagination} onPageChange={onPageChange} disabled={isFetching} />
    </>
  );
}

export function MyOrdersView() {
  const router = useRouter();
  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<OrderStatus | "">("");
  const [paymentStatus, setPaymentStatus] = useState<PaymentStatusFilter | "">("");
  const [page, setPage] = useState(1);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const onSearch = (text: string) => {
    setSearchText(text);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setSearch(text.trim());
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
  };
  const clear = () => {
    clearTimeout(timer.current);
    setSearchText("");
    setSearch("");
    setStatus("");
    setPaymentStatus("");
    setPage(1);
  };

  const params: OrdersListParams = { page, pageSize: PAGE_SIZE, ...(search ? { search } : {}), ...(status ? { status } : {}), ...(paymentStatus ? { paymentStatus } : {}) };
  const { data, isLoading, isFetching, error, refetch } = useMyOrders(params);
  const filtered = Boolean(search || searchText.trim() || status || paymentStatus);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">My Orders</h1>
        <p className="text-sm text-muted-foreground">Orders you created. Everyone&apos;s orders are on the Orders page.</p>
      </div>

      <div className="flex flex-wrap items-center gap-3" data-testid="my-orders-filters">
        <Input
          aria-label="Search my orders"
          placeholder="Search by order number, customer or phone"
          className="max-w-sm"
          value={searchText}
          onChange={(e) => onSearch(e.target.value)}
        />
        <NativeSelect aria-label="Order status" value={status} onChange={(e) => { setStatus(e.target.value as OrderStatus | ""); setPage(1); }} className="w-44">
          <option value="">All statuses</option>
          {ORDER_STATUS_ORDER.map((s) => (
            <option key={s} value={s}>
              {ORDER_STATUS_LABELS[s]}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect aria-label="Payment status" value={paymentStatus} onChange={(e) => { setPaymentStatus(e.target.value as PaymentStatusFilter | ""); setPage(1); }} className="w-48">
          <option value="">All payments</option>
          {PAYMENT_STATUS_ORDER.map((s) => (
            <option key={s} value={s}>
              {PAYMENT_STATUS_LABELS[s]}
            </option>
          ))}
          <option value="NONE">{NO_PAYMENT_LABEL}</option>
        </NativeSelect>
        {filtered ? (
          <Button variant="ghost" size="sm" onClick={clear}>
            Clear
          </Button>
        ) : null}
      </div>

      <Card>
        <CardContent>
          <MyOrdersContent
            data={data}
            isLoading={isLoading}
            isFetching={isFetching}
            error={error}
            filtered={filtered}
            onRetry={() => void refetch()}
            onClear={clear}
            onOpen={(id) => router.push(orderDetailHref(id))}
            onPageChange={setPage}
          />
        </CardContent>
      </Card>
    </div>
  );
}
